#!/usr/bin/env python3
"""Run each requested deterministic layout once using a frozen program.

python3 tools/run_diagnostic_batch.py --program programs/world_model_target_delivery.py \
    --out artifacts/inloop/v28r1_batch

All attempts are preserved. Only layouts skipped before execution and positively
identified platform startup failures may be retried. Executed failed programs
consume their layout just like successful programs. progress.json is written
before/after every attempt; driver logs remain readable during an active attempt.
"""
import argparse
import ast
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, payload):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def program_identity(path):
    source = path.read_text(encoding="utf-8")
    constants = {}
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    constants[target.id] = node.value.value
    blob = re.search(r'b64decode\("([^\"]+)"\)', source)
    if not blob:
        raise ValueError("Frozen source has no embedded package")
    # The platform executes pythonEditor.value.trim(), so student_source hashes
    # the trimmed UTF-8 text. Preserve the raw file hash separately for immutability.
    executed_sha = hashlib.sha256(source.strip().encode("utf-8")).hexdigest()
    return {"version": constants["PROGRAM_VERSION"], "file_sha256": executed_sha,
            "wm_kit_commit": constants["WM_KIT_COMMIT"],
            "wm_embed_sha256": hashlib.sha256(base64.b64decode(blob.group(1))).hexdigest()}


def verify_identity(result, identity):
    versions = [line for line in result.get("lines", []) if line.get("event") == "program_version"]
    return len(versions) == 1 and all(versions[0].get(key) == value for key, value in identity.items())


def resume_progress(folder, frozen, identity, raw_sha):
    """Validate all frozen/executed evidence before updating only batch metadata."""
    progress = json.loads((folder / "progress.json").read_text(encoding="utf-8"))
    if progress.get("active"):
        raise ValueError("An attempt was active when stopped; determine its execution status before resuming")
    if Path(progress["frozen_program"]).resolve() != frozen:
        raise ValueError("Resume frozen program path differs from original batch")
    recorded_raw_sha = progress.get("source_file_sha256", progress["identity"]["file_sha256"])
    if raw_sha != recorded_raw_sha or (folder / "program.sha256").read_text().split()[0] != raw_sha:
        raise ValueError("Frozen raw source does not match its original recorded SHA256")
    for key in ("version", "wm_kit_commit", "wm_embed_sha256"):
        if progress["identity"].get(key) != identity[key]:
            raise ValueError(f"Frozen identity changed: {key}")
    if progress["identity"]["file_sha256"] not in (raw_sha, identity["file_sha256"]):
        raise ValueError("Recorded execution hash matches neither raw nor platform-trimmed source")
    actual_maps = {path.stem for path in folder.glob("map-*.json")
                   if re.fullmatch(r"map-\d\d", path.stem)}
    if actual_maps != set(progress["completed"]):
        raise ValueError("Completed-map metadata differs from preserved trial files")
    all_maps = {f"map-{i:02d}" for i in range(1, 11)}
    if set(progress["remaining"]) != all_maps - actual_maps:
        raise ValueError("Remaining layouts are inconsistent with completed trials")
    corrections = []
    for layout, entry in progress["completed"].items():
        final_path = folder / f"{layout}.json"
        final = json.loads(final_path.read_text(encoding="utf-8"))
        original = json.loads(Path(entry["json"]).read_text(encoding="utf-8"))
        if final.get("assignedMap") != layout or original.get("assignedMap") != layout:
            raise ValueError(f"Preserved layout evidence mismatch: {layout}")
        if not verify_identity(original, identity) or not verify_identity(final, identity):
            raise ValueError(f"Preserved trial identity still mismatches after platform trim: {layout}")
        corrections.append((final_path, final, entry))
    note = ("Platform app.js executes pythonEditor.value.trim(); file_sha256 verifies the trimmed student_source. "
            "source_file_sha256 verifies the unchanged raw frozen program. The original executed trial is retained without rerun.")
    progress.setdefault("resume_history", []).append({"at": now(), "previous_status": progress["status"],
        "previous_failure": progress.get("failure"), "previous_identity": progress["identity"], "explanation": note})
    for final_path, final, entry in corrections:
        final["batch_identity_verified"] = True
        final["batch_source_file_sha256"] = raw_sha
        final["batch_identity_verification_note"] = note
        save(final_path, final)
        entry["identity_verified"] = True
        entry["batch_identity_verification_note"] = note
        for attempt in progress["attempts"]:
            if attempt["attempt"] == entry["attempt"]:
                attempt["identity_verified"] = True
                attempt["batch_identity_verification_note"] = note
    progress.update({"status": "running", "identity": identity, "source_file_sha256": raw_sha})
    progress.pop("failure", None)
    progress.pop("finished_at", None)
    return progress


def classify(result, log, partial):
    if result and result.get("skipped"):
        return "layout_skipped_before_execution"
    if result:
        lines = result.get("lines") or []
        record = result.get("record")
        # A version line is printed before mission actions; any program output,
        # events, or samples means this was an executed trial, regardless of error.
        if lines or (isinstance(record, dict) and (record.get("events") or record.get("sampleCount"))):
            return "executed"
        feedback = str(result.get("pythonFeedback", {})) + str(result.get("feedbackText", ""))
        if not record and "composite delivery" in feedback and "missing from the interaction definition" in feedback:
            return "platform_startup_error"
    # Driver failures before clicking Run are safe to retry. Once Run was clicked,
    # missing evidence is ambiguous and must stop the batch rather than retry.
    if "running program" not in log and not partial:
        return "driver_startup_error"
    return "execution_unknown"


def run(args):
    source = Path(args.program).resolve()
    folder = Path(args.out).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    progress_path = folder / "progress.json"
    frozen = folder / "program.py"
    maps = [f"map-{i:02d}" for i in range(1, 11)]
    resuming = bool(args.resume)
    if progress_path.exists() and not resuming:
        raise ValueError("Output already has progress.json; choose a fresh batch directory")
    if not resuming and any(folder.glob("map-*.json")):
        raise ValueError("Output already contains trials; choose a fresh batch directory")
    if not resuming and frozen.exists() and frozen.read_bytes() != source.read_bytes():
        raise ValueError("Existing frozen program differs from the requested program")
    if not resuming and source != frozen:
        shutil.copyfile(source, frozen)
    identity = program_identity(frozen)
    raw_sha = sha(frozen)
    if not resuming:
        (folder / "program.sha256").write_text(raw_sha + "  program.py\n", encoding="utf-8")
    attempts_dir = folder / "attempts"
    attempts_dir.mkdir(exist_ok=True)
    progress = (resume_progress(folder, frozen, identity, raw_sha) if resuming else
                {"status": "running", "started_at": now(), "frozen_program": str(frozen),
                 "identity": identity, "source_file_sha256": raw_sha,
                 "completed": {}, "remaining": maps, "attempts": [], "active": None})
    save(progress_path, progress)
    env = os.environ.copy()
    env["WM_TRUTH_DIR"] = str(ROOT / "artifacts" / "truth")
    try:
        preserved_numbers = [int(path.stem.split("-")[-1]) for path in attempts_dir.glob("attempt-*.json")
                             if re.fullmatch(r"attempt-\d+", path.stem)]
        first_attempt = max([entry["attempt"] for entry in progress["attempts"]] + preserved_numbers + [0]) + 1
        for attempt in range(first_attempt, args.max_attempts + 1):
            if not progress["remaining"]:
                break
            if sha(frozen) != raw_sha:
                raise RuntimeError("Frozen program changed during batch")
            stem = attempts_dir / f"attempt-{attempt:03d}"
            output, log_path = stem.with_suffix(".json"), stem.with_suffix(".log")
            command = [args.node, str(ROOT / "tools" / "inloop_driver.js"), "--mission", "guangyang2",
                       "--program", str(frozen), "--out", str(output), "--prefix", "GY",
                       "--want-maps", ",".join(progress["remaining"]), "--timeout-ms", str(args.timeout_ms)]
            entry = {"attempt": attempt, "started_at": now(), "json": str(output), "log": str(log_path),
                     "requested_maps": list(progress["remaining"])}
            progress["active"] = entry
            save(progress_path, progress)
            print(json.dumps({"event": "attempt_start", **entry}, ensure_ascii=False), flush=True)
            with log_path.open("w", encoding="utf-8") as logfile:
                result_code = subprocess.run(command, cwd=ROOT, env=env, stdout=logfile, stderr=subprocess.STDOUT,
                                             check=False).returncode
            log = log_path.read_text(encoding="utf-8")
            result = json.loads(output.read_text(encoding="utf-8")) if output.exists() else None
            partial_path = stem.with_suffix(".partial.txt")
            partial = partial_path.read_text(encoding="utf-8") if partial_path.exists() else ""
            status = classify(result, log, partial)
            entry.update({"finished_at": now(), "return_code": result_code, "status": status,
                          "map": result.get("assignedMap") if result else None})
            progress["attempts"].append(entry)
            progress["active"] = None
            if sha(frozen) != raw_sha:
                raise RuntimeError("Frozen program changed during batch")
            if status == "executed":
                layout = result.get("assignedMap")
                if layout not in progress["remaining"]:
                    raise RuntimeError(f"Executed unrequested or duplicate layout {layout}")
                verification = verify_identity(result, identity)
                entry["identity_verified"] = verification
                entry["platform_program_error_count"] = sum(e.get("type") == "program_error"
                    for e in (result.get("record") or {}).get("events", []))
                # Preserve the executed layout before verification: it must never
                # be repeated even if instrumentation was incomplete or incorrect.
                destination = folder / layout
                for suffix in (".log", ".partial.txt", ".samples.json", ".calib.json"):
                    existing = Path(str(stem) + suffix)
                    if existing.exists():
                        shutil.copyfile(existing, Path(str(destination) + suffix))
                final = dict(result)
                if Path(str(destination) + ".samples.json").exists():
                    final["samplesFile"] = str(destination) + ".samples.json"
                final["batch_identity_verified"] = verification
                final["batch_source_file_sha256"] = raw_sha
                final["batch_attempt"] = attempt
                save(destination.with_suffix(".json"), final)
                progress["completed"][layout] = {"file": str(destination) + ".json", **entry}
                progress["remaining"].remove(layout)
                save(progress_path, progress)
                if not verification:
                    raise RuntimeError(f"Program identity verification failed for {layout}; trial retained, no retry")
            elif status == "execution_unknown":
                raise RuntimeError("Cannot prove whether program executed; attempt retained and batch stopped, no retry")
            save(progress_path, progress)
            print(json.dumps({"event": "attempt_complete", **entry, "remaining": progress["remaining"]},
                             ensure_ascii=False), flush=True)
            if progress["remaining"]:
                time.sleep(args.start_interval)
        if progress["remaining"]:
            raise RuntimeError(f"Attempt limit reached; remaining: {progress['remaining']}")
        progress["status"] = "complete"
        progress["finished_at"] = now()
        save(progress_path, progress)
        print(json.dumps({"event": "batch_complete", "completed": list(progress["completed"]),
                          "identity": identity}, ensure_ascii=False), flush=True)
    except BaseException as exc:
        progress["status"] = "stopped"
        progress["failure"] = str(exc)
        progress["finished_at"] = now()
        save(progress_path, progress)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--program", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--resume", action="store_true", help="Continue a stopped batch without replaying completed layouts")
    parser.add_argument("--node", default=shutil.which("node") or "node")
    parser.add_argument("--start-interval", type=float, default=2.0)
    parser.add_argument("--timeout-ms", type=int, default=900000)
    parser.add_argument("--max-attempts", type=int, default=160)
    args = parser.parse_args()
    if args.start_interval < 0:
        parser.error("--start-interval must be nonnegative")
    run(args)


if __name__ == "__main__":
    main()
