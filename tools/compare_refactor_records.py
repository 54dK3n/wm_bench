#!/usr/bin/env python3
"""Strict, offline C-refactor comparison against the final opt2r3 recordings.

No simulator is launched. Native inputs/events are compared recursively, in
original array order, with no dropped fields, time adjustment or tolerance.
Run IDs, wall timestamps and sourceCode are top-level archive metadata outside
these arrays; they are recorded as provenance, not normalized inside behavior.
Raw program logs and the full result are diagnostics, not additional C gates.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

from platform_paths import recorded_repository_path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASELINE = ROOT / "artifacts/inloop/opt-2/round-3"
MAPS = tuple(f"map-{index:02d}" for index in range(1, 11))
# Only these values, only in raw.lines program_version entries, are code
# identity metadata. wm_kit_commit is a Git commit SHA, not behavioral input.
# Calibration hashes, platform/rule/map versions and every native array field
# are deliberately NOT on this list.
PROGRAM_IDENTITY_FIELDS = (
    "version", "file_sha256", "wm_kit_commit", "wm_embed_sha256",
)
ERROR_EVENT_TYPES = {"program_error", "simulation_error", "runtime_error"}
MISSING = object()


def sha(payload):
    return hashlib.sha256(payload).hexdigest()


def repository_reference(path):
    path = Path(path).resolve()
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)  # Synthetic fixtures outside the repository.


def round_path(value):
    path = Path(value)
    return (path if path.is_absolute() else ROOT / path).resolve()


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def read_json(path):
    payload = Path(path).read_bytes()
    def invalid(value):
        raise ValueError("non-JSON numeric constant: " + value)
    return json.loads(payload, parse_constant=invalid), payload


def shown(value):
    return {"missing": True} if value is MISSING else value


def differences(before, after, path=""):
    """JSON-pointer leaf differences. Object-key order is not JSON semantics."""
    if before is MISSING or after is MISSING or type(before) is not type(after):
        return [{"path": path or "/", "baseline": shown(before), "candidate": shown(after)}]
    result = []
    if isinstance(before, dict):
        for key in sorted(before.keys() | after.keys()):
            escaped = key.replace("~", "~0").replace("/", "~1")
            result.extend(differences(before.get(key, MISSING), after.get(key, MISSING),
                                      path + "/" + escaped))
    elif isinstance(before, list):
        for index in range(max(len(before), len(after))):
            result.extend(differences(before[index] if index < len(before) else MISSING,
                                      after[index] if index < len(after) else MISSING,
                                      path + "/" + str(index)))
    elif before != after:
        result.append({"path": path or "/", "baseline": before, "candidate": after})
    return result


def compare_records(baseline, candidate):
    """Compare complete native arrays and authoritative total score, no masking."""
    result = {}
    for field in ("inputs", "events"):
        left, right = baseline.get(field, MISSING), candidate.get(field, MISSING)
        valid = (isinstance(left, list) and bool(left) and isinstance(right, list)
                 and bool(right) and all(isinstance(row, dict) for row in left + right))
        diff = differences(left, right, "/" + field)
        result[field] = {"equal": valid and not diff,
                         "baseline_count": len(left) if isinstance(left, list) else None,
                         "candidate_count": len(right) if isinstance(right, list) else None,
                         "differences": diff, "valid_nonempty_arrays": valid}
    left_result, right_result = baseline.get("result"), candidate.get("result")
    left = left_result.get("score", MISSING) if isinstance(left_result, dict) else MISSING
    right = right_result.get("score", MISSING) if isinstance(right_result, dict) else MISSING
    score_diff = differences(left, right, "/result/score")
    result["score"] = {"equal": number(left) and number(right) and not score_diff,
                       "baseline": shown(left), "candidate": shown(right),
                       "differences": score_diff}
    result["full_result_diagnostic"] = {
        "equal": not differences(left_result, right_result),
        "differences": differences(left_result, right_result, "/result"),
        "baseline": left_result, "candidate": right_result, "is_gate": False,
    }
    return result


def log_diagnostic(baseline, candidate):
    def strip_identity(lines):
        if not isinstance(lines, list):
            return lines
        return [({key: ("<code-identity>" if key in PROGRAM_IDENTITY_FIELDS else value)
                  for key, value in line.items()}
                 if isinstance(line, dict) and line.get("event") == "program_version" else line)
                for line in lines]
    left, right = baseline.get("lines", MISSING), candidate.get("lines", MISSING)
    diff = differences(strip_identity(left), strip_identity(right), "/lines")
    return {"equal_except_code_identity": isinstance(left, list) and isinstance(right, list) and not diff,
            "differences": diff, "is_gate": False,
            "identity": {side: [{field: line.get(field) for field in PROGRAM_IDENTITY_FIELDS}
                                for line in (raw.get("lines") if isinstance(raw.get("lines"), list) else [])
                                if isinstance(line, dict) and line.get("event") == "program_version"]
                         for side, raw in (("baseline", baseline), ("candidate", candidate))}}


def load_map(folder, map_name):
    """Load the requested layout's native archive; never substitute another run."""
    folder = round_path(folder)
    raw_path = folder / (map_name + ".json")
    raw, raw_bytes = read_json(raw_path)
    if not isinstance(raw, dict) or raw.get("assignedMap") != map_name:
        raise ValueError("raw assignedMap does not match requested layout")
    value = raw.get("fullRecordFile")
    if not isinstance(value, str) or not value:
        raise ValueError("missing fullRecordFile; summarized record is not a native archive")
    native_path = Path(value)
    if native_path.is_absolute():
        # A local synthetic fixture can live outside ROOT. Other historical
        # absolute paths are relocated only through the repository's artifacts
        # rule, followed by the same strict requested-round containment check.
        if not native_path.resolve().is_relative_to(folder):
            native_path = recorded_repository_path(native_path)
    elif native_path.parts and native_path.parts[0] == "artifacts":
        native_path = recorded_repository_path(native_path)
    else:
        native_path = folder / native_path
    native_path = native_path.resolve()
    # Reject accidental reuse of the baseline archive by a candidate raw export.
    # No filename guessing or cross-round fallback is permitted.
    try:
        native_path.relative_to(folder)
    except ValueError as error:
        raise ValueError("native archive lies outside the requested round") from error
    native, native_bytes = read_json(native_path)
    if not isinstance(native, dict):
        raise ValueError("native archive must be a JSON object")
    errors = []
    for field in ("inputs", "events"):
        rows = native.get(field)
        if not isinstance(rows, list) or not rows or not all(isinstance(row, dict) for row in rows):
            errors.append("invalid_or_empty_native_" + field)
    events = native.get("events") if isinstance(native.get("events"), list) else []
    events = [row for row in events if isinstance(row, dict)]
    program_errors = [dict(event_index=i, event=row) for i, row in enumerate(events)
                      if row.get("type") in ERROR_EVENT_TYPES]
    if program_errors:
        errors.append("native_program_or_simulation_error")
    if sum(row.get("type") == "run_started" for row in events) != 1:
        errors.append("missing_or_duplicated_run_started")
    if sum(row.get("type") == "run_finished" for row in events) != 1:
        errors.append("missing_or_duplicated_run_finished")
    if raw.get("timedOut") is not False or raw.get("stallReason"):
        errors.append("driver_timeout_stall_or_unknown_completion")
    result = native.get("result")
    if not isinstance(result, dict) or not number(result.get("score")):
        errors.append("missing_or_invalid_native_score")
    elif result.get("reason") in ERROR_EVENT_TYPES:
        errors.append("native_result_error")
    source = native.get("sourceCode")
    source_sha = sha(source.encode()) if isinstance(source, str) else None
    versions = [row for row in (raw.get("lines") if isinstance(raw.get("lines"), list) else [])
                if isinstance(row, dict) and row.get("event") == "program_version"]
    export = raw.get("fullRecordExport") if isinstance(raw.get("fullRecordExport"), dict) else {}
    raw_record = raw.get("record") if isinstance(raw.get("record"), dict) else {}
    binding = {"raw_native_events_equal": raw_record.get("events") == events,
               "export_sha256_matches": export.get("sha256") == sha(native_bytes),
               "export_bytes_match": export.get("bytes") == len(native_bytes),
               "executed_source_logged_hash_matches": len(versions) == 1 and source_sha is not None
                   and versions[0].get("file_sha256") == source_sha}
    return {"raw": raw, "native": native, "validation_errors": errors,
            "program_errors": program_errors, "binding_diagnostic": binding,
            "provenance": {"raw_file": repository_reference(raw_path), "raw_sha256": sha(raw_bytes),
                           "native_file": repository_reference(native_path), "native_sha256": sha(native_bytes),
                           "native_schema_version": native.get("schemaVersion"),
                           "run_id": native.get("runId"), "task_id": native.get("taskId"),
                           "executed_source_sha256": source_sha}}


def compare_rounds(candidate, baseline=DEFAULT_BASELINE):
    rows = []
    for map_name in MAPS:
        loaded, load_errors = {}, []
        for side, folder in (("baseline", baseline), ("candidate", candidate)):
            try:
                loaded[side] = load_map(folder, map_name)
            except (OSError, ValueError, TypeError, KeyError) as error:
                load_errors.append({"side": side, "reason": str(error),
                                    "exception": type(error).__name__})
        row = {"map": map_name, "load_errors": load_errors,
               "provenance": {side: item["provenance"] for side, item in loaded.items()},
               "validation_errors": {side: item["validation_errors"] for side, item in loaded.items()},
               "program_errors": {side: item["program_errors"] for side, item in loaded.items()},
               "binding_diagnostic": {side: item["binding_diagnostic"] for side, item in loaded.items()}}
        if len(loaded) == 2:
            row.update(compare_records(loaded["baseline"]["native"], loaded["candidate"]["native"]))
            row["program_log_diagnostic"] = log_diagnostic(loaded["baseline"]["raw"], loaded["candidate"]["raw"])
            row["raw_score_diagnostic"] = {
                "equal": loaded["baseline"]["raw"].get("score") == loaded["candidate"]["raw"].get("score"),
                "baseline": loaded["baseline"]["raw"].get("score"),
                "candidate": loaded["candidate"]["raw"].get("score"), "is_gate": False}
        row["gates"] = {"both_native_records_complete": not load_errors and len(loaded) == 2,
                        "both_runs_valid_without_errors": len(loaded) == 2 and
                            all(not item["validation_errors"] for item in loaded.values()),
                        **{field + "_equal": row.get(field, {}).get("equal") is True
                           for field in ("inputs", "events", "score")}}
        row["all_pass"] = all(row["gates"].values())
        rows.append(row)
    gates = {name: all(row["gates"][name] for row in rows) for name in rows[0]["gates"]}
    return {"all_pass": all(gates.values()), "baseline": repository_reference(round_path(baseline)),
            "candidate": repository_reference(round_path(candidate)), "expected_layouts": list(MAPS),
            "layout_count": len(rows), "passing_layouts": sum(row["all_pass"] for row in rows),
            "gates": gates, "layouts": rows,
            "policy": {"native_inputs_and_events": "All fields, types and original array order; exact equality; no tolerance or normalization.",
                       "score": "Authoritative native result.score must be finite and exactly equal.",
                       "error_rule": "Missing native evidence, incomplete runs, driver timeout/stall, or native program/simulation errors fail.",
                       "program_log_identity_allowlist": list(PROGRAM_IDENTITY_FIELDS),
                       "identity_scope": "Only raw.lines entries whose event is program_version; wm_kit_commit is explicitly code-identity SHA. Keys must remain present. No other SHA/version fields are masked.",
                       "diagnostics_not_gates": ["raw.lines", "full native result", "raw.score", "archive export/source binding"],
                       "outside_behavior_arrays": ["top-level runId/serverSessionId/teamId/clientStartedAt/clientEndedAt", "sourceCode", "visionFrames", "samples", "platform definitions"],
                       "provenance": "Raw/native/source hashes are retained for both sides. Other archive fields are not discarded from source files or normalized into the arrays."}}


def summary(report):
    lines = ["# C 原生行为等价比较", "", "结果：" + ("PASS" if report["all_pass"] else "FAIL"), "",
             "最小门限：10 个布局原生记录齐全、无执行错误；每条 inputs/events 的所有字段及顺序完全相等；原生总得分完全相同。",
             "不归一化 seq、t、tick、evidenceId、真实输入、API 参数/返回或事件字段。日志和完整终局结果只作诊断，不新增门限。", "",
             "| 布局 | inputs 旧/新 | inputs | events 旧/新 | events | 得分 旧/新 | 结果 |",
             "|---|---:|---|---:|---|---:|---|"]
    def status(value):
        return "PASS" if value else "FAIL"
    for row in report["layouts"]:
        inp, evt, score = (row.get(name, {}) for name in ("inputs", "events", "score"))
        lines.append(f"| {row['map']} | {inp.get('baseline_count', '?')}/{inp.get('candidate_count', '?')} | "
                     f"{status(inp.get('equal'))} | {evt.get('baseline_count', '?')}/{evt.get('candidate_count', '?')} | "
                     f"{status(evt.get('equal'))} | {score.get('baseline', '?')}/{score.get('candidate', '?')} | {status(row['all_pass'])} |")
    lines.extend(["", "program_version 日志仅允许 version、file_sha256、wm_kit_commit、wm_embed_sha256 四个代码身份值不同；wm_kit_commit 明确视为代码提交身份。该日志比较属于诊断。",
                  "turn_cost_k、turn_calibration_sha256、log_conventions 及平台版本没有例外。完整字段差异、错误和文件哈希见同名 JSON。", ""])
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()
    out = args.out or round_path(args.candidate) / "behavior-equivalence.json"
    text = args.summary or out.with_suffix(".SUMMARY.md")
    report = compare_rounds(args.candidate, args.baseline)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n")
    text.parent.mkdir(parents=True, exist_ok=True)
    text.write_text(summary(report))
    print(json.dumps({"all_pass": report["all_pass"], "passing_layouts": report["passing_layouts"],
                      "gates": report["gates"], "json": str(out), "summary": str(text)}, ensure_ascii=False))
    return 0 if report["all_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
