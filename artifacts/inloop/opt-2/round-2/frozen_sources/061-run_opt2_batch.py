#!/usr/bin/env python3
"""Run one frozen stage-2 round, ten mission-2 layouts once, retaining all evidence.

An executed failure consumes a layout. Ambiguous execution blocks resume. This
entry point never advances a round, chooses a demo layout, or retries an execution.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from demo_report import evidence_audit, resolve
from run_diagnostic_batch import classify, now, program_identity, save, sha, verify_identity

ROOT = Path(__file__).resolve().parents[1]
MAPS = [f"map-{i:02d}" for i in range(1, 11)]
DEPENDENCIES = (
    "tools/run_opt2_batch.py", "tools/opt2_report.py", "tools/opt2_preflight.py", "tools/build_opt2_program.py",
    "tools/p3_offline_choice.py", "tools/run_diagnostic_batch.py", "tools/inloop_driver.js",
    "tools/vision_truth_hook.js", "tools/demo_keyframes_hook.js", "tools/batch_report.py", "tools/stage_report.py",
    "tools/demo_report.py", "tools/demo_timeline.py", "tools/opt_report.py", "tools/wm_hit_audit.py",
    "tools/check_no_layout_constants.py", "tools/demo_preflight.py", "tools/embed_detection_filter.py",
    "tools/embed_world_model.py", "tools/p3_turn_calibration.py", "tools/test_detection_evaluation.py",
    "tools/opt2_evidence_audit.py", "tools/opt2_constant_evidence.py",
    "tools/detection_evaluation.py", "programs/detection_filter.py", "programs/target_selection.py",
    "tools/tests/test_inloop_host_io.js",
)


def freeze_paths(source, frozen, build):
    paths = [source, frozen, source.with_suffix(".build.json"), *[ROOT / name for name in DEPENDENCIES]]
    paths.extend(sorted((ROOT / "programs/tests").glob("*.py")))
    paths.extend(sorted((ROOT / "tools/tests").glob("*.py")))
    paths.extend([ROOT / "programs" / name for name in build.get("fragments", {})])
    paths.extend(Path(build[key]) for key in ("calibration", "base") if build.get(key))
    if build.get("wm_source"):
        paths.extend(sorted((Path(build["wm_source"]) / "world_model").rglob("*.py")))
        paths.extend(sorted((Path(build["wm_source"]) / "tests").glob("*.py")))
    for name in ("constant-evidence/constant_evidence.json", "constant-evidence/USAGE_DECISION.md",
                 "wm-kit-action-evidence/manifest.json", "wm-kit-action-evidence/world_model.zip"):
        paths.append(ROOT / "artifacts/inloop/opt-2" / name)
    calibration = json.loads(Path(build["calibration"]).read_text())
    calibration_dir = Path(build["calibration"]).parent
    for suffix in ("*.json", "*.py", "*.md"):
        paths.extend(sorted(calibration_dir.glob(suffix)))
    measurements = calibration_dir / "measurements.json"
    if measurements.exists():
        provenance = json.loads(measurements.read_text()).get("source", {})
        paths.extend(Path(value) for key, value in provenance.items()
                     if (key.endswith("File") or key.endswith("Record")) and isinstance(value, str))
    if calibration.get("historical_task_diagnosis_preserved"):
        paths.append(Path(calibration["historical_task_diagnosis_preserved"]))
    # Explicit measurement artifacts are dependencies, when the calibration
    # names them. No hidden inputs or mutable global truth tree is frozen here.
    for key in ("frozen_files", "dependencies"):
        declared = calibration.get(key, {})
        if isinstance(declared, dict):
            paths.extend(Path(name) for name in declared)
    return sorted({path.resolve() for path in paths})


def freeze_checks(folder):
    manifest = json.loads((folder / "code_manifest.json").read_text())
    return {path: Path(path).is_file() and sha(Path(path)) == expected for path, expected in manifest.items()}


def verify_freeze(folder):
    checks = freeze_checks(folder)
    if not checks or not all(checks.values()):
        raise RuntimeError("Frozen stage-2 files changed: " + str([path for path, ok in checks.items() if not ok]))
    return checks


def archive_sources(folder, paths):
    """Byte-exact review copies; never mutate frozen originals or runtime gates."""
    destination = folder / "frozen_sources"
    destination.mkdir(exist_ok=True)
    index = {}
    for number, source in enumerate(sorted(set(paths)), 1):
        payload = source.read_bytes()
        target = destination / f"{number:03d}-{source.name}"
        if target.exists() and target.read_bytes() != payload:
            raise ValueError("Pre-existing source archive differs: " + str(target))
        target.write_bytes(payload)
        index[str(source.resolve())] = {"archive": str(target.relative_to(folder)),
                                       "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload)}
    save(destination / "INDEX.json", index)
    return index


def retain_execution_evidence(raw_path, identity, folder):
    """Validate and archive executed source. Failure never permits a rerun."""
    raw = json.loads(raw_path.read_text())
    record_path = resolve(raw_path, raw.get("fullRecordFile"))
    if not record_path or not record_path.is_file():
        return {"evidence_all_pass": False, "evidence_errors": ["executed_native_record_missing"]}
    try:
        record = json.loads(record_path.read_text())
    except (OSError, ValueError) as error:
        return {"evidence_all_pass": False, "evidence_errors": ["unreadable_native_record: " + str(error)]}
    errors = []
    source = record.get("sourceCode")
    if isinstance(source, str) and hashlib.sha256(source.encode()).hexdigest() != identity["file_sha256"]:
        raise RuntimeError("Executed sourceCode SHA differs from identity")
    if not isinstance(source, str):
        errors.append("executed_sourceCode_missing")
    export = raw.get("fullRecordExport", {})
    if export.get("sha256") != sha(record_path) or export.get("bytes") != record_path.stat().st_size:
        errors.append("native_record_export_byte_or_hash_mismatch")
    if record.get("events") != raw.get("record", {}).get("events"):
        errors.append("native_record_events_differ_from_driver_export")
    snapshot = folder / "executed_program.py"
    if isinstance(source, str) and snapshot.exists() and snapshot.read_bytes() != source.encode():
        raise RuntimeError("Executed source differs across layouts")
    if isinstance(source, str) and not snapshot.exists():
        snapshot.write_bytes(source.encode())
        (folder / "executed_program.sha256").write_text(identity["file_sha256"] + "  executed_program.py\n")
    samples = raw_path.with_name(raw_path.stem + ".samples.json")
    checks = {}
    try:
        _files, checks = evidence_audit(raw_path, raw, samples)
    except (OSError, ValueError, KeyError, TypeError) as error:
        errors.append("evidence_audit_unavailable: " + str(error))
    required = ("full_raw_record_preserved", "samples_preserved", "native_png_evidence_complete")
    errors.extend(name for name in required if checks.get(name, {}).get("status") != "pass")
    has_success_events = any(event.get("objectRole") == "target" and (event.get("type") == "package_delivered"
        or event.get("type") == "package_grabbed" and event.get("accepted") is True) for event in record.get("events", []))
    if has_success_events and checks.get("driver_keyframes_preserved", {}).get("status") != "pass":
        errors.append("driver_keyframes_preserved")
    try:
        binding = native_evidence(raw, record, raw_path)
    except (OSError, ValueError, KeyError, TypeError) as error:
        binding = {"all_pass": False, "mismatches": ["evidence_binding_unavailable: " + str(error)]}
    if binding.get("all_pass") is not True:
        errors.append("native_evidence_binding_failed")
    return {"native_record_sha256": sha(record_path), "executed_source_sha256": identity["file_sha256"],
            "evidence_all_pass": not errors, "evidence_errors": errors, "native_evidence_binding": binding,
            "evidence_checks": {key: value["status"] for key, value in checks.items()}}


def native_evidence(raw, record, raw_path):
    from opt2_evidence_audit import audit_native_evidence
    return audit_native_evidence(raw, record, raw_path)


def run(args):
    folder, source = Path(args.out).resolve(), Path(args.program).resolve()
    if folder.name not in {"round-1", "round-2", "round-3"}:
        raise ValueError("Stage-2 rounds must be named round-1 through round-3")
    round_number = int(folder.name[-1])
    for earlier in range(1, round_number):
        previous = folder.parent / f"round-{earlier}" / "progress.json"
        if not previous.exists() or json.loads(previous.read_text()).get("status") != "complete":
            raise ValueError("Earlier rounds must finish all ten layouts first")
    folder.mkdir(parents=True, exist_ok=True)
    frozen, progress_path = folder / "program.py", folder / "progress.json"
    if progress_path.exists():
        if not args.resume:
            raise ValueError("Existing round; explicit --resume only for never-executed pending layouts")
        progress = json.loads(progress_path.read_text())
        if progress.get("active"):
            raise ValueError("An attempt may have executed; unresolved active attempt blocks replay")
        if source.read_bytes() != frozen.read_bytes():
            raise ValueError("Resume source differs from frozen program")
        verify_freeze(folder)
        actual = {path.stem for path in folder.glob("map-??.json")}
        if actual != set(progress["completed"]):
            raise ValueError("Preserved map files differ from completed execution ledger")
        for name, entry in progress["completed"].items():
            raw_path = folder / f"{name}.json"
            raw = json.loads(raw_path.read_text())
            if raw.get("assignedMap") != name or not verify_identity(raw, progress["identity"]) or sha(raw_path) != entry["raw_sha256"]:
                raise ValueError("Preserved trial identity/layout/hash mismatch: " + name)
            retain_execution_evidence(raw_path, progress["identity"], folder)
        if progress["status"] == "complete":
            return
    else:
        if args.resume:
            raise ValueError("No previous progress to resume")
        if any(folder.glob("map-??.json")):
            raise ValueError("Output already contains trials")
        preflight_command = [sys.executable, str(ROOT / "tools/opt2_preflight.py"), "--program", str(source), "--out", str(folder)]
        result = subprocess.run(preflight_command, cwd=ROOT, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"), check=False)
        preflight_path = folder / "preflight.json"
        preflight = json.loads(preflight_path.read_text()) if preflight_path.exists() else {}
        if result.returncode or not preflight.get("all_pass") or preflight.get("sha256") != sha(source):
            raise ValueError("Stage-2 preflight must pass for the current source before running")
        if frozen.exists() and frozen.read_bytes() != source.read_bytes():
            raise ValueError("Existing frozen source differs")
        if frozen != source:
            shutil.copyfile(source, frozen)
        build = json.loads(source.with_suffix(".build.json").read_text())
        shutil.copyfile(source.with_suffix(".build.json"), folder / "build.json")
        identity = program_identity(frozen)
        (folder / "PROGRAM_VERSION").write_text(identity["version"] + "\n")
        (folder / "program.sha256").write_text(sha(frozen) + "  program.py\n")
        (folder / "wm_kit_commit.txt").write_text(identity["wm_kit_commit"] + "\n")
        (folder / "embedded.sha256").write_text(identity["wm_embed_sha256"] + "\n")
        save(folder / "identity.json", identity)
        paths = freeze_paths(source, frozen, build) + [folder / "build.json", preflight_path]
        archive_sources(folder, paths)
        save(folder / "code_manifest.json", {str(path): sha(path) for path in paths})
        progress = {"schema": "wm-opt2-batch/v1", "status": "running", "started_at": now(), "round": round_number,
                    "frozen_program": str(frozen), "identity": identity, "source_file_sha256": sha(frozen),
                    "completed": {}, "attempts": [], "active": None}
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
            entry = {"attempt": number, "requested_maps": pending, "started_at": now(), "json": str(output), "log": str(log)}
            progress["active"] = entry
            save(progress_path, progress)
            print(json.dumps({"event": "attempt_start", **entry}, ensure_ascii=False), flush=True)
            command = [args.node, str(ROOT / "tools/inloop_driver.js"), "--mission", "guangyang2", "--program", str(frozen),
                       "--out", str(output), "--prefix", "GY", "--want-maps", ",".join(pending), "--demo-evidence", "1", "--timeout-ms", str(args.timeout_ms)]
            with log.open("w") as stream:
                code = subprocess.run(command, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT, check=False).returncode
            raw = json.loads(output.read_text()) if output.exists() else None
            partial = stem.with_suffix(".partial.txt")
            classification = classify(raw, log.read_text(), partial.read_text() if partial.exists() else "")
            entry.update({"finished_at": now(), "return_code": code, "classification": classification, "map": raw.get("assignedMap") if raw else None})
            progress["attempts"].append(entry)
            # Record execution first even if dependencies changed while it ran.
            if classification == "executed":
                name = raw.get("assignedMap")
                if name not in pending:
                    raise RuntimeError("Executed unrequested or duplicate layout")
                destination = folder / f"{name}.json"
                shutil.copyfile(output, destination)
                for suffix in (".log", ".samples.json", ".partial.txt"):
                    original = stem.with_suffix(suffix)
                    if original.exists():
                        shutil.copyfile(original, folder / f"{name}{suffix}")
                entry["raw_sha256"] = sha(destination)
                progress["completed"][name] = dict(entry)
                save(progress_path, progress)
                verify_freeze(folder)
                if not verify_identity(raw, progress["identity"]):
                    raise RuntimeError("Executed program identity differs from frozen program")
                evidence = retain_execution_evidence(destination, progress["identity"], folder)
                entry.update(evidence)
                progress["completed"][name] = dict(entry)
                progress["active"] = None
            elif classification in ("layout_skipped_before_execution", "platform_startup_error", "driver_startup_error"):
                verify_freeze(folder)
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
        save(folder / "freeze_verification.json", freeze_checks(folder))
    print(json.dumps({"status": progress["status"], "completed": list(progress["completed"])}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--program", default=str(ROOT / "programs/world_model_opt2.py"))
    parser.add_argument("--out", required=True)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--node", default=shutil.which("node") or "/opt/homebrew/bin/node")
    parser.add_argument("--timeout-ms", type=int, default=900000)
    parser.add_argument("--max-allocations", type=int, default=160)
    run(parser.parse_args())


if __name__ == "__main__":
    main()
