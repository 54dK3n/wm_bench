#!/usr/bin/env python3
"""Extract indexed numeric evidence from a completed round; never run simulation.

Usage: python3 tools/extract_round_diagnostics.py artifacts/inloop/stage-1/round-2
Consumes existing batch/stage reports, checks them against raw trials and writes
numeric_diagnostics.json. Missing evidence is recorded as unknown, never as pass.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract(folder):
    stage = read(folder / "stage_report.json")
    batch = {row["map"]: row for row in read(folder / "batch_report.json")}
    progress = read(folder / "progress.json")
    expected = {f"map-{index:02d}" for index in range(1, 11)}
    checks = {"all_ten_raw_trials": {p.stem for p in folder.glob("map-??.json")} == expected,
              "all_ten_stage_rows": {row["map"] for row in stage["runs"]} == expected,
              "all_ten_batch_rows": set(batch) == expected,
              "progress_complete": progress.get("status") == "complete"}
    unknown = []
    hashes = {}
    for path_text, expected_sha in stage["input_sha256"].items():
        path = Path(path_text)
        if path.is_file():
            hashes[path_text] = sha(path)
            checks[f"stage_input_hash:{path_text}"] = hashes[path_text] == expected_sha
        else:
            unknown.append(f"stage_input_missing:{path_text}")
    evidence_events = {
        "confirmation_sample", "memory_confirmed", "confirmation_failed", "confirmation_aborted",
        "approach_graph_rejected", "approach_memory_stop", "approach_min_distance_failed",
        "approach_graph_memory_distance", "approach_call", "approach_fine_stop",
        "memory_navigation_metric", "navigation_budget_exhausted", "observe_motion_violation", "flow_end",
    }
    rows = []
    for row in stage["runs"]:
        name = row["map"]
        raw = read(folder / f"{name}.json")
        lines = raw.get("lines", [])
        events = raw.get("record", {}).get("events", [])
        platform = raw.get("record", {}).get("top", {}).get("result", {})
        indexed = [{"line_index": i, **line} for i, line in enumerate(lines)]
        counts = Counter(line.get("event") for line in lines)
        flow = next((line for line in reversed(lines) if line.get("event") == "flow_end"), None)
        program = next((line for line in lines if line.get("event") == "program_version"), None)
        program_errors = [event for event in events if event.get("type") == "program_error"]
        byte_count = raw.get("record", {}).get("vision", {}).get("frameBytes")
        checks[f"{name}:observe_count"] = counts["observe"] == row["observes"]
        checks[f"{name}:vision_bytes"] = byte_count == row["vision_bytes"]
        checks[f"{name}:program_error_count"] = len(program_errors) == row["platform_program_error_count"]
        checks[f"{name}:flow_end"] = flow == row["flow_end"]
        checks[f"{name}:program_version"] = program == row["program_version"]
        checks[f"{name}:batch_matches_stage"] = all(row.get(key) == value for key, value in batch[name].items())
        checks[f"{name}:frozen_identity"] = bool(program) and all(
            program.get(key) == value for key, value in progress["identity"].items())
        attempt_info = progress["completed"][name]
        attempt = folder / "attempts" / Path(attempt_info["json"]).name
        if attempt.exists():
            original = read(attempt)
            for key in ("lines", "record"):
                checks[f"{name}:attempt_{key}_unchanged"] = raw[key] == original[key]
            sample_path = folder / f"{name}.samples.json"
            attempt_samples = attempt.with_suffix(".samples.json")
            if sample_path.exists() and attempt_samples.exists():
                checks[f"{name}:attempt_samples_unchanged"] = read(sample_path) == read(attempt_samples)
            else:
                unknown.append(f"{name}:attempt_samples_unavailable")
        else:
            unknown.append(f"{name}:original_attempt_unavailable")
        reasons = Counter((line.get("event"), line.get("reason")) for line in lines if line.get("reason"))
        fixed = row["fixed_rule_audit"]
        queries = (flow or {}).get("navigation_queries")
        controls = (flow or {}).get("navigation_controls")
        # Exact API entry progress, preserved as offline provenance evidence.
        entry_25cm = [line for line in indexed if line.get("event") == "viewpoint_take_exit"
                      and line.get("actualProgressCm") == 25]
        rows.append({
            **{key: row.get(key) for key in (
                "map", "ball", "calibration", "confirmation", "confirmed_and_grabbed", "mission",
                "wm_final_err_cm", "wm_nearest_truth_distance_cm", "wm_final_hits", "wm_final_track_id",
                "wm_first_err_cm", "wm_final_association", "grabs", "grab_attempts", "approach_calls",
                "stationary_repeat_count", "observe_motion_violation_count", "fixed_rule_audit_status")},
            "observes": counts["observe"], "vision_bytes": byte_count,
            "vision_mib": byte_count / 1024 ** 2 if isinstance(byte_count, (int, float)) else None,
            "program_version": program, "program_errors": program_errors, "platform_result": platform,
            "flow_end": flow,
            "navigation_queries_remaining": 1000 - queries if isinstance(queries, (int, float)) else None,
            "navigation_controls_remaining": 300 - controls if isinstance(controls, (int, float)) else None,
            "event_counts": dict(sorted(counts.items())),
            "api_entry_progress_25cm": {"count": len(entry_25cm), "events": entry_25cm},
            "reason_counts": [{"event": event, "reason": reason, "count": count}
                              for (event, reason), count in sorted(reasons.items())],
            "critical_events": [line for line in indexed if line.get("event") in evidence_events],
            "last_observe": next((line for line in reversed(indexed) if line.get("event") == "observe"), None),
            "wm_frames": [line for line in indexed if line.get("event") == "wm_targets"],
            "tail_events": indexed[-12:], "fixed_rule_audit": fixed,
            "unknown_fixed_rules": [name for name, audit in fixed.items() if audit["status"] == "unknown"],
        })
    checks["frozen_program_source_hash"] = sha(folder / "program.py") == progress["source_file_sha256"]
    checks["frozen_executed_trim_hash"] = hashlib.sha256(
        (folder / "program.py").read_text().strip().encode()).hexdigest() == progress["identity"]["file_sha256"]
    input_files = [folder / "stage_report.json", folder / "batch_report.json", folder / "progress.json",
                   folder / "program.py", *folder.glob("map-??.json"), *folder.glob("map-??.samples.json")]
    return {
        "folder": str(folder), "line_index_convention": "zero-based index in raw map JSON lines array",
        "source_sha256": {str(path): sha(path) for path in sorted(input_files)},
        "checks": checks, "checks_pass": all(checks.values()), "unknown_integrity_evidence": unknown,
        "gates": stage["gates"], "all_gates_pass": stage["all_gates_pass"],
        "independent_success": stage["independent_success"],
        "baseline_conservative_success": stage["baseline_conservative_success"],
        "scenarios": stage["scenarios"],
        "baseline_current_pair_evidence": [pair for group in stage["baseline_scenarios"]
                                           for pair in group["current_pair_evidence"]],
        "trace_fingerprints": {name: {"length": len(trace["trace"]), "sha256": trace["sha256"]}
                               for name, trace in stage["current_target_traces"].items()},
        "unseen_accuracy": stage["unseen_accuracy"],
        "totals": {"observes": sum(row["observes"] for row in rows),
                   "vision_bytes": (sum(row["vision_bytes"] for row in rows)
                                    if all(isinstance(row["vision_bytes"], (int, float)) for row in rows) else None),
                   "confirmed_and_grabbed_layouts": sum(row["confirmed_and_grabbed"] for row in rows),
                   "successful_flow_end_layouts": sum(bool((row["flow_end"] or {}).get("success")) for row in rows),
                   "program_errors": sum(len(row["program_errors"]) for row in rows)},
        "runs": rows,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    args = parser.parse_args()
    folder = args.folder.resolve()
    report = extract(folder)
    output = folder / "numeric_diagnostics.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "checks_pass": report["checks_pass"],
                      "check_count": len(report["checks"]), "unknown": report["unknown_integrity_evidence"],
                      "totals": report["totals"]}, ensure_ascii=False))
    raise SystemExit(0 if report["checks_pass"] else 1)


if __name__ == "__main__":
    main()
