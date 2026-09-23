#!/usr/bin/env python3
"""Run one frozen optimization round, all ten mission-2 layouts exactly once.

Executed failures consume their layout. Unknown execution retains active state
and blocks resume. This command never runs mission 1 or advances another round.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from run_diagnostic_batch import classify, now, program_identity, save, sha, verify_identity

ROOT = Path(__file__).resolve().parents[1]
MAPS = [f"map-{i:02d}" for i in range(1, 11)]
DEPENDENCIES = (
    "tools/run_opt_batch.py", "tools/run_diagnostic_batch.py", "tools/inloop_driver.js",
    "tools/vision_truth_hook.js", "tools/demo_keyframes_hook.js",
    "tools/batch_report.py", "tools/stage_report.py", "tools/wm_hit_audit.py",
    "tools/demo_timeline.py", "tools/opt_report.py", "tools/opt_preflight.py",
    "tools/check_no_layout_constants.py", "programs/detection_filter.py",
    "tools/detection_evaluation.py",
    "tools/test_detection_evaluation.py", "tools/tests/test_opt_reporting.py",
    "programs/tests/test_opt1_planner.py",
    "tools/embed_detection_filter.py",
    "tools/tests/test_opt_runner_controls.py", "tools/tests/test_opt_filter_platform.py",
)


def verify_freeze(folder):
    manifest = json.loads((folder / "code_manifest.json").read_text())
    checks = {path: Path(path).is_file() and sha(Path(path)) == expected for path, expected in manifest.items()}
    if not all(checks.values()):
        raise RuntimeError("Frozen optimization files changed: " + str([p for p, ok in checks.items() if not ok]))
    return checks


def run(args):
    folder, source = Path(args.out).resolve(), Path(args.program).resolve()
    if folder.name not in {"round-1", "round-2", "round-3"}:
        raise ValueError("Optimization rounds must be named round-1 through round-3")
    round_number = int(folder.name[-1])
    for earlier in range(1, round_number):
        previous = folder.parent / f"round-{earlier}" / "progress.json"
        if not previous.exists() or json.loads(previous.read_text()).get("status") != "complete":
            raise ValueError("Earlier optimization rounds must finish all ten layouts first")
    folder.mkdir(parents=True, exist_ok=True)
    frozen, progress_path = folder / "program.py", folder / "progress.json"
    if progress_path.exists():
        if not args.resume:
            raise ValueError("Existing round; use --resume only for pending, never executed layouts")
        progress = json.loads(progress_path.read_text())
        if progress.get("active"):
            raise ValueError("An attempt may have executed; preserve and resolve it before resuming")
        if source.read_bytes() != frozen.read_bytes():
            raise ValueError("Resume source differs from frozen program")
        verify_freeze(folder)
        if progress["status"] == "complete":
            return
        for name, entry in progress["completed"].items():
            raw = json.loads((folder / f"{name}.json").read_text())
            if raw.get("assignedMap") != name or not verify_identity(raw, progress["identity"]):
                raise ValueError("Preserved trial identity/layout mismatch: " + name)
            if sha(folder / f"{name}.json") != entry["raw_sha256"]:
                raise ValueError("Preserved raw trial changed: " + name)
    else:
        if args.resume:
            raise ValueError("No previous progress to resume")
        preflight = json.loads((folder / "preflight.json").read_text())
        if not preflight.get("all_pass") or preflight.get("sha256") != sha(source):
            raise ValueError("Current program needs a passing preflight before running")
        if any(folder.glob("map-??.json")):
            raise ValueError("Output already contains trials")
        if frozen.exists() and frozen.read_bytes() != source.read_bytes():
            raise ValueError("Existing frozen source differs")
        if source != frozen:
            shutil.copyfile(source, frozen)
        identity = program_identity(frozen)
        (folder / "PROGRAM_VERSION").write_text(identity["version"] + "\n")
        (folder / "program.sha256").write_text(sha(frozen) + "  program.py\n")
        (folder / "wm_kit_commit.txt").write_text(identity["wm_kit_commit"] + "\n")
        (folder / "embedded.sha256").write_text(identity["wm_embed_sha256"] + "\n")
        save(folder / "identity.json", identity)
        paths = [frozen, source, *[ROOT / item for item in DEPENDENCIES]]
        save(folder / "code_manifest.json", {str(path): sha(path) for path in paths})
        progress = {"status": "running", "started_at": now(), "round": round_number,
                    "frozen_program": str(frozen), "identity": identity,
                    "source_file_sha256": sha(frozen), "completed": {}, "attempts": [], "active": None}
    progress["status"] = "running"
    save(progress_path, progress)
    attempts = folder / "attempts"
    attempts.mkdir(exist_ok=True)
    env = dict(os.environ, WM_TRUTH_DIR=str(ROOT / "artifacts/truth"), PYTHONDONTWRITEBYTECODE="1")
    try:
        for number in range(len(progress["attempts"]) + 1, args.max_allocations + 1):
            pending = [name for name in MAPS if name not in progress["completed"]]
            if not pending:
                progress["status"] = "complete"
                break
            verify_freeze(folder)
            stem = attempts / f"attempt-{number:03d}"
            output, log = stem.with_suffix(".json"), stem.with_suffix(".log")
            entry = {"attempt": number, "requested_maps": pending, "started_at": now(),
                     "json": str(output), "log": str(log)}
            progress["active"] = entry
            save(progress_path, progress)
            print(json.dumps({"event": "attempt_start", **entry}, ensure_ascii=False), flush=True)
            command = [args.node, str(ROOT / "tools/inloop_driver.js"), "--mission", "guangyang2",
                       "--program", str(frozen), "--out", str(output), "--prefix", "GY",
                       "--want-maps", ",".join(pending), "--demo-evidence", "1", "--timeout-ms", str(args.timeout_ms)]
            with log.open("w") as stream:
                code = subprocess.run(command, cwd=ROOT, env=env, stdout=stream,
                                      stderr=subprocess.STDOUT, check=False).returncode
            raw = json.loads(output.read_text()) if output.exists() else None
            partial = stem.with_suffix(".partial.txt")
            classification = classify(raw, log.read_text(), partial.read_text() if partial.exists() else "")
            entry.update({"finished_at": now(), "return_code": code, "classification": classification,
                          "map": raw.get("assignedMap") if raw else None})
            progress["attempts"].append(entry)
            verify_freeze(folder)
            if classification == "executed":
                name = raw.get("assignedMap")
                if name not in pending:
                    raise RuntimeError("Executed unrequested or duplicate layout")
                # Retain actual execution before any validation; a failure never authorizes replay.
                destination = folder / f"{name}.json"
                shutil.copyfile(output, destination)
                for suffix in (".log", ".samples.json", ".partial.txt"):
                    original = stem.with_suffix(suffix)
                    if original.exists():
                        shutil.copyfile(original, folder / f"{name}{suffix}")
                entry["raw_sha256"] = sha(destination)
                progress["completed"][name] = dict(entry)
                save(progress_path, progress)
                if not verify_identity(raw, progress["identity"]):
                    raise RuntimeError("Executed program identity differs from frozen program")
                progress["active"] = None
            elif classification in ("layout_skipped_before_execution", "platform_startup_error", "driver_startup_error"):
                progress["active"] = None
            else:
                raise RuntimeError("Unknown execution state; retained active attempt blocks replay")
            save(progress_path, progress)
            print(json.dumps({"event": "attempt_finished", **entry}, ensure_ascii=False), flush=True)
        else:
            progress["status"] = "allocation_limit"
        if set(progress["completed"]) == set(MAPS):
            progress["status"] = "complete"
    except BaseException as error:
        progress.update(status="stopped", failure=str(error))
        raise
    finally:
        progress["finished_at"] = now()
        save(progress_path, progress)
        save(folder / "freeze_verification.json", verify_freeze(folder))
    print(json.dumps({"status": progress["status"], "completed": list(progress["completed"])}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--program", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--node", default=shutil.which("node") or "/opt/homebrew/bin/node")
    parser.add_argument("--timeout-ms", type=int, default=900000)
    parser.add_argument("--max-allocations", type=int, default=160)
    run(parser.parse_args())


if __name__ == "__main__":
    main()
