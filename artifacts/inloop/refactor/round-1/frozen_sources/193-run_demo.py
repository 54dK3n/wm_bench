#!/usr/bin/env python3
"""Try mission-2 layouts in demo order, stopping at the first fully verified dual delivery.

No statistical batch is run. A failed executed layout is retained and never retried.
Layout allocation is driver-only; unrequested allocations are skipped before Run.
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
DEFAULT_ORDER = [f"map-{i:02d}" for i in (3, 4, 5, 8, 1, 2, 6, 7, 9, 10)]
MANIFEST_FILES = (
    "tools/run_demo.py", "tools/demo_report.py", "tools/inloop_driver.js",
    "tools/vision_truth_hook.js", "tools/demo_keyframes_hook.js",
    "tools/run_diagnostic_batch.py", "tools/check_no_layout_constants.py",
    "tools/demo_preflight.py", "tools/test_demo_keyframes_hook.js",
    "programs/demo_flow_fragment.py", "tests/test_demo_flow.py",
    "tests/test_demo_runner.py",
    "tools/tests/test_demo_report.py",
)


def verify_freeze(folder):
    manifest = json.loads((folder / "code_manifest.json").read_text())
    checks = {path: sha(Path(path)) == digest for path, digest in manifest.items()}
    if not all(checks.values()):
        raise RuntimeError("Frozen demo files changed: " + str([p for p, ok in checks.items() if not ok]))
    return checks


def run(args):
    from demo_report import analyse_demo

    source, folder = Path(args.program).resolve(), Path(args.out).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    frozen = folder / "program.py"
    progress_path = folder / "progress.json"
    order = [args.map] if args.map else DEFAULT_ORDER
    if progress_path.exists():
        if not args.resume:
            raise ValueError("Existing demo: use --resume to continue untouched pending layouts or choose a fresh --out")
        progress = json.loads(progress_path.read_text())
        if progress.get("active"):
            raise ValueError("An attempt may have executed; preserve evidence and resolve it before resuming")
        if progress["order"] != order or source.read_bytes() != frozen.read_bytes():
            raise ValueError("Resume program or layout order differs")
        verify_freeze(folder)
        if progress["status"] in ("success", "exhausted"):
            print(json.dumps({"status": progress["status"], "out": str(folder)}, ensure_ascii=False))
            return
    else:
        if args.resume:
            raise ValueError("No previous demo progress to resume")
        if frozen.exists() and frozen.read_bytes() != source.read_bytes():
            raise ValueError("Existing frozen demo program differs")
        if source != frozen:
            shutil.copyfile(source, frozen)
        identity = program_identity(frozen)
        (folder / "PROGRAM_VERSION").write_text(identity["version"] + "\n")
        (folder / "program.sha256").write_text(sha(frozen) + "  program.py\n")
        save(folder / "identity.json", identity)
        paths = [frozen, source, *[ROOT / name for name in MANIFEST_FILES]]
        save(folder / "code_manifest.json", {str(path): sha(path) for path in paths})
        progress = {"status": "running", "started_at": now(), "order": order,
                    "identity": identity, "source_file_sha256": sha(frozen),
                    "completed": {}, "attempts": [], "active": None,
                    "discipline": "demo only; no statistics; first verified success stops; each executed layout tried once"}
    progress["status"] = "running"
    save(progress_path, progress)
    attempts = folder / "attempts"
    attempts.mkdir(exist_ok=True)
    env = os.environ.copy()
    env["WM_TRUTH_DIR"] = str(ROOT / "artifacts/truth")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    try:
        for number in range(len(progress["attempts"]) + 1, args.max_allocations + 1):
            pending = [layout for layout in order if layout not in progress["completed"]]
            if not pending:
                progress["status"] = "exhausted"
                break
            wanted = pending[0]
            verify_freeze(folder)
            stem = attempts / f"attempt-{number:03d}"
            out, log = stem.with_suffix(".json"), stem.with_suffix(".log")
            command = [args.node, str(ROOT / "tools/inloop_driver.js"), "--mission", "guangyang2",
                       "--program", str(frozen), "--out", str(out), "--prefix", "GY",
                       "--want-maps", wanted, "--demo-evidence", "1", "--timeout-ms", str(args.timeout_ms)]
            entry = {"attempt": number, "requested_map": wanted, "started_at": now(),
                     "json": str(out), "log": str(log)}
            progress["active"] = entry
            save(progress_path, progress)
            print(json.dumps({"event": "demo_attempt_start", **entry}, ensure_ascii=False), flush=True)
            with log.open("w") as stream:
                code = subprocess.run(command, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT,
                                      check=False).returncode
            raw = json.loads(out.read_text()) if out.exists() else None
            partial = stem.with_suffix(".partial.txt")
            classification = classify(raw, log.read_text(), partial.read_text() if partial.exists() else "")
            entry.update({"finished_at": now(), "return_code": code, "classification": classification,
                          "assigned_map": raw.get("assignedMap") if raw else None})
            progress["attempts"].append(entry)
            verify_freeze(folder)
            if classification == "executed":
                if raw.get("assignedMap") != wanted or wanted in progress["completed"]:
                    raise RuntimeError("Executed an unrequested or already attempted layout")
                # Preserve every actual failure before evaluating it; never substitute another attempt.
                final = folder / f"{wanted}.json"
                shutil.copyfile(out, final)
                shutil.copyfile(log, folder / f"{wanted}.log")
                samples = stem.with_suffix(".samples.json")
                if samples.exists():
                    shutil.copyfile(samples, folder / f"{wanted}.samples.json")
                if partial.exists():
                    shutil.copyfile(partial, folder / f"{wanted}.partial.txt")
                progress["completed"][wanted] = dict(entry)
                save(progress_path, progress)
                if not verify_identity(raw, progress["identity"]):
                    raise RuntimeError("Executed program identity differs from frozen demo")
                evaluation = analyse_demo(final)
                save(folder / f"{wanted}.demo_eval.json", evaluation)
                entry["all_gates_pass"] = evaluation["all_gates_pass"]
                progress["completed"][wanted] = dict(entry)
                progress["active"] = None
                print(json.dumps({"event": "demo_trial_finished", "map": wanted,
                                  "all_gates_pass": evaluation["all_gates_pass"],
                                  "gates": evaluation["gates"]}, ensure_ascii=False), flush=True)
                if evaluation["all_gates_pass"]:
                    progress["status"] = "success"
                    progress["success_map"] = wanted
                    break
            elif classification not in ("layout_skipped_before_execution", "platform_startup_error", "driver_startup_error"):
                raise RuntimeError("Uncertain execution state; stop without retry")
            else:
                progress["active"] = None
            save(progress_path, progress)
        else:
            progress["status"] = "allocation_limit"
        if all(layout in progress["completed"] for layout in order) and progress["status"] == "running":
            progress["status"] = "exhausted"
    except BaseException as error:
        progress["status"] = "stopped"
        progress["failure"] = str(error)
        raise
    finally:
        progress["finished_at"] = now()
        save(progress_path, progress)
        save(folder / "freeze_verification.json", verify_freeze(folder))
        if progress["completed"]:
            subprocess.run([sys.executable, str(ROOT / "tools/demo_report.py"), str(folder)],
                           cwd=ROOT, env=env, check=False)
    print(json.dumps({"status": progress["status"], "success_map": progress.get("success_map"),
                      "out": str(folder)}, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--program", default=str(ROOT / "programs/world_model_two_target_demo.py"))
    parser.add_argument("--out", default=str(ROOT / "artifacts/inloop/demo"))
    parser.add_argument("--map", choices=[f"map-{i:02d}" for i in range(1, 11)])
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--node", default=shutil.which("node") or "/opt/homebrew/bin/node")
    parser.add_argument("--timeout-ms", type=int, default=900000)
    parser.add_argument("--max-allocations", type=int, default=200)
    run(parser.parse_args())


if __name__ == "__main__":
    main()
