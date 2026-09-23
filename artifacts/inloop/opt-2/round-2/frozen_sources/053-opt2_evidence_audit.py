"""Independent, read-only native archive/PNG audit for stage 2.

No simulator, controller, detector or truth-to-runtime interface. Unlike export
summary booleans, every check is recomputed from preserved files and native data.
"""
import base64
import hashlib
import json
from pathlib import Path

PNG = b"\x89PNG\r\n\x1a\n"


def _path(owner, value):
    if not isinstance(value, str) or not value:
        raise ValueError("missing evidence path")
    path = Path(value)
    return path if path.is_absolute() else Path(owner).parent / path


def _sha(payload):
    return hashlib.sha256(payload).hexdigest()


def audit_native_evidence(raw, record, raw_path):
    """Return all_pass/checks/mismatches; missing or inconsistent data cannot pass."""
    checks, mismatches, files, bindings = {}, [], {}, []
    def check(ok, name, **context):
        checks[name] = checks.get(name, True) and bool(ok)
        if not ok:
            mismatches.append({"check": name, **context})
        return bool(ok)
    def load(owner, value):
        path = _path(owner, value);payload = path.read_bytes()
        files[str(path.resolve())] = {"bytes": len(payload), "sha256": _sha(payload)}
        return path, payload, json.loads(payload)
    try:
        raw_path = Path(raw_path).resolve()
        _, _, raw_file = load(raw_path, str(raw_path))
        check(raw_file == raw, "raw_argument_matches_preserved_file")
        full_path, full_bytes, archived = load(raw_path, raw.get("fullRecordFile") or raw.get("recordFile"))
        check(archived == record, "record_argument_matches_preserved_file")
        vision_path, _, vision = load(raw_path, raw.get("visionEvidenceFile"))
        samples_path, _, samples = load(raw_path, raw.get("samplesFile"))
        top, export = raw.get("record", {}).get("top", {}), raw.get("fullRecordExport", {})
        run_id, task_id = record.get("runId"), record.get("taskId")
        check(isinstance(run_id, str) and bool(run_id)
              and run_id == top.get("runId") == vision.get("runId") == export.get("runId"), "run_identity")
        check(task_id == raw.get("taskId") == top.get("taskId") == vision.get("taskId")
              == export.get("taskId") == "R2-GYI-MVP-02", "mission2_identity")
        check(len(full_bytes) == export.get("bytes") and _sha(full_bytes) == export.get("sha256"),
              "complete_archive_hash_and_bytes")
        for key in ("events", "inputs", "samples", "visionFrames"):
            check(isinstance(record.get(key), list) and len(record[key]) == export.get(key),
                  "native_archive_inventory", field=key)
        check(record.get("events") == raw.get("record", {}).get("events"), "raw_events_exact")
        check(isinstance(samples, list) and samples == record.get("samples")
              and len(samples) == raw.get("record", {}).get("sampleCount"), "samples_exact")
        map_samples = raw_path.with_suffix(".samples.json")
        if map_samples.is_file() and map_samples != samples_path:
            _, _, copied_samples = load(map_samples, str(map_samples))
            check(copied_samples == samples, "layout_sample_copy_exact")
        program_path = _path(raw_path, raw.get("program"))
        program_bytes = program_path.read_bytes()
        files[str(program_path.resolve())] = {"bytes": len(program_bytes), "sha256": _sha(program_bytes)}
        source = record.get("sourceCode")
        versions = [line for line in raw.get("lines", []) if line.get("event") == "program_version"]
        source_sha = _sha(source.encode("utf-8")) if isinstance(source, str) else None
        check(isinstance(source, str) and source == program_bytes.decode("utf-8").strip(), "executed_source_exact")
        check(len(versions) == 1 and source_sha == versions[0].get("file_sha256"), "executed_source_logged_hash")
        full_frames, frames = record.get("visionFrames", []), vision.get("frames", [])
        truths = vision.get("renderTruth", {}).get("frames", [])
        inputs = record.get("inputs", [])
        queries = [item for item in inputs if item.get("type") == "vision_query"]
        check(queries == vision.get("queries"), "all_native_queries_exact")
        check(not vision.get("exportErrors") and not vision.get("renderTruth", {}).get("errors"), "no_export_or_truth_errors")
        native, exported, render = {}, {}, {}
        for group_name, rows, table in (("native", full_frames, native), ("exported", frames, exported), ("truth", truths, render)):
            seen_frame_ids = set()
            for frame in rows:
                eid, fid = frame.get("evidenceId"), frame.get("frameId")
                valid_id = isinstance(eid, str) and bool(eid) and type(fid) is int
                check(valid_id and eid not in table and fid not in seen_frame_ids,
                      "unique_frame_inventory", group=group_name, evidence_id=eid, frame_id=fid)
                table[eid] = frame;seen_frame_ids.add(fid)
        check(set(native) == set(exported) == set(render), "all_native_frames_and_truth_exported")
        byte_count = 0
        for eid, original in native.items():
            frame, truth = exported.get(eid), render.get(eid)
            if frame is None or truth is None:
                continue
            check(all(frame.get(key) == value for key, value in original.items() if key != "pngBase64"),
                  "native_frame_metadata_exact", evidence_id=eid)
            png_path = _path(vision_path, frame.get("image"));png = png_path.read_bytes();byte_count += len(png)
            files[str(png_path.resolve())] = {"bytes": len(png), "sha256": _sha(png)}
            encoded = original.get("pngBase64")
            decoded = base64.b64decode(encoded, validate=True) if isinstance(encoded, str) else None
            check(png.startswith(PNG) and png == decoded and _sha(png) == original.get("sha256")
                  == frame.get("sha256") == frame.get("exportedSha256") == truth.get("imageSha256")
                  and len(png) == original.get("byteLength") == frame.get("byteLength") == truth.get("nativeByteLength"),
                  "native_png_bytes_exact", evidence_id=eid, image=str(png_path))
            check(truth.get("exactRenderState") is True and truth.get("sameTickAndRevision") is True
                  and truth.get("runId") == run_id and truth.get("frameId") == frame.get("frameId")
                  and truth.get("evidenceId") == eid and truth.get("evidenceSeq") == frame.get("seq")
                  and truth.get("captureTick") == truth.get("evidenceTick") == frame.get("tick")
                  and truth.get("captureStateRevision") == truth.get("evidenceStateRevision") == frame.get("stateRevision"),
                  "exact_native_render_binding", evidence_id=eid)
            bindings.append({"evidence_id": eid, "frame_id": frame.get("frameId"), "tick": frame.get("tick"),
                             "state_revision": frame.get("stateRevision"), "bytes": len(png), "sha256": _sha(png)})
        summary = raw.get("record", {}).get("vision", {})
        check(len(full_frames) == len(frames) == len(truths) == vision.get("nativeFrameCount") == summary.get("frameCount"),
              "native_frame_count_reconciles")
        check(byte_count == sum(frame.get("byteLength", -1) for frame in full_frames)
              == vision.get("nativeFrameBytes") == summary.get("frameBytes"), "native_byte_total_reconciles")
        check(len(queries) == vision.get("nativeQueryCount") == summary.get("queryCount"), "native_query_count_reconciles")
        # New host-I/O drivers must prove their final checks. Historical archives
        # without hostIO keep the original contract; a present but incomplete
        # hostIO object is not a legacy archive and must fail explicitly.
        if "hostIO" in raw:
            host_io = raw.get("hostIO")
            check(isinstance(host_io, dict), "host_io_schema")
            host_io = host_io if isinstance(host_io, dict) else {}
            terminal = host_io.get("terminal")
            terminal = terminal if isinstance(terminal, dict) else {}
            final = terminal.get("finalVerification")
            final = final if isinstance(final, dict) else {}
            check(final.get("allPass") is True and final.get("finalFullReadAvailable") is True
                  and not raw.get("outputFromCache"), "host_io_terminal_final_verification",
                  final_verification=final, output_from_cache=raw.get("outputFromCache", False))
            terminal_path = raw_path.with_suffix(".partial.txt")
            try:
                terminal_bytes = terminal_path.read_bytes()
                terminal_sha = _sha(terminal_bytes)
                files[str(terminal_path)] = {"bytes": len(terminal_bytes), "sha256": terminal_sha}
                check(type(final.get("bytes")) is int and len(terminal_bytes) == final.get("bytes")
                      and terminal_sha == final.get("sha256"), "host_io_terminal_disk_bytes",
                      file=str(terminal_path), actual_bytes=len(terminal_bytes), actual_sha256=terminal_sha,
                      expected_bytes=final.get("bytes"), expected_sha256=final.get("sha256"))
            except OSError as error:
                check(False, "host_io_terminal_disk_bytes", file=str(terminal_path),
                      error=f"{type(error).__name__}: {error}")
            final_native = host_io.get("finalNativeVerification")
            final_native = final_native if isinstance(final_native, dict) else {}
            check(final_native.get("allPass") is True, "host_io_final_native_verification",
                  final_verification=final_native)
            check(final_native.get("frames") == len(full_frames)
                  and final_native.get("queries") == len(queries)
                  and final_native.get("pngBytes") == byte_count,
                  "host_io_final_native_inventory", expected_frames=len(full_frames),
                  expected_queries=len(queries), expected_png_bytes=byte_count,
                  final_verification=final_native)
        for query in queries:
            frame = native.get(query.get("evidenceId"), {})
            check(bool(frame) and query.get("frameId") == frame.get("frameId")
                  and query.get("tick") == frame.get("tick")
                  and isinstance(frame.get("seq"), int) and isinstance(query.get("seq"), int)
                  and frame["seq"] < query["seq"], "native_query_frame_binding", query_seq=query.get("seq"))
        observed = [(i, line) for i, line in enumerate(raw.get("lines", [])) if line.get("event") == "observe"]
        native_observed = [query for query in queries if query.get("method") == "observe"]
        check(len(observed) == len(native_observed), "every_logged_observe_has_native_query")
        fields = ("category", "distanceCm", "bearingDeg", "confidence")
        for (index, line), query in zip(observed, native_observed):
            logged = [{key: item.get(key) for key in fields} for item in line.get("raw", []) if item.get("category") in ("target", "distractor")]
            actual = [{key: item.get(key) for key in fields} for item in query.get("result", []) if item.get("category") in ("target", "distractor")]
            check(line.get("tick") == query.get("tick") and logged == actual,
                  "observe_tick_and_all_raw_red_blue_detections_exact", line=index, query_seq=query.get("seq"))
        return {"schema": "opt2-native-evidence-audit/v1", "all_pass": bool(checks) and all(checks.values()),
                "checks": checks, "mismatches": mismatches, "run_id": run_id, "source_sha256": source_sha,
                "native_frame_count": len(full_frames), "native_query_count": len(queries), "native_bytes": byte_count,
                "frame_bindings": bindings, "files": files}
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        check(False, "evidence_schema_readable", error=f"{type(error).__name__}: {error}")
        return {"schema": "opt2-native-evidence-audit/v1", "all_pass": False, "checks": checks,
                "mismatches": mismatches, "files": files, "frame_bindings": bindings}
