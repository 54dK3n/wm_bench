"""Read-only post-round archive diagnosis; writes only beside this script."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
ROUND = HERE.parent
ROOT = ROUND.parents[3]
sys.path.insert(0, str(ROOT / "tools"))
from opt2_evidence_audit import audit_native_evidence


def digest(path):
    data = path.read_bytes()
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def main():
    audits, endings, inputs = {}, [], {}
    for raw_path in sorted(ROUND.glob("map-??.json")):
        raw = json.loads(raw_path.read_text())
        full_path = Path(raw["fullRecordFile"])
        record = json.loads(full_path.read_text())
        audit = audit_native_evidence(raw, record, raw_path)
        audits[raw_path.stem] = audit
        inputs.update(audit["files"])
        vision = json.loads(Path(raw["visionEvidenceFile"]).read_text())
        flow = [row for row in raw["lines"] if row.get("event") == "flow_end"]
        finish = [row for row in record["events"] if row.get("type") == "run_finished"]
        timelines = raw.get("timeline", [])
        gaps = [{"previous": a, "next": b,
                 "wall_delta_seconds": b["wallSeconds"] - a["wallSeconds"],
                 "simulation_delta_seconds": ((b["tick"] - a["tick"]) * .02)
                 if a.get("tick") is not None and b.get("tick") is not None else None}
                for a, b in zip(timelines, timelines[1:])]
        result = record["result"]
        endings.append({"layout": raw_path.stem, "raw_file": str(raw_path),
                        "native_run_id": record["runId"], "timed_out": raw.get("timedOut"),
                        "stall_reason": raw.get("stallReason"), "run_state": raw.get("runState"),
                        "wall_seconds": raw.get("wallSeconds"), "started_at": raw.get("startedAt"),
                        "finished_at": raw.get("finishedAt"), "simulation_end_tick": record.get("simulationEndTick"),
                        "native_result": result, "native_run_finished": finish,
                        "flow_end": flow, "exported_at": vision.get("exportedAt"),
                        "vision_export_errors": vision.get("exportErrors", []),
                        "render_truth_errors": vision.get("renderTruth", {}).get("errors", []),
                        "demo_summary": raw.get("demoEvidence"),
                        "native_frames": audit.get("native_frame_count"),
                        "observe_queries": sum(q.get("method") == "observe" for q in vision["queries"]),
                        "native_queries": audit.get("native_query_count"),
                        "native_bytes": audit.get("native_bytes"),
                        "all_pass": audit["all_pass"], "mismatches": audit["mismatches"],
                        "largest_timeline_gap": max(gaps, key=lambda row: row["wall_delta_seconds"]) if gaps else None,
                        "final_output_utf16_characters": timelines[-1].get("outputLength") if timelines else None})
    for relative in ("tools/opt2_evidence_audit.py", "tools/inloop_driver.js", "tools/run_opt2_batch.py"):
        path = ROOT / relative
        inputs[str(path)] = digest(path)
    for name in ("code_manifest.json", "freeze_verification.json", "program.py", "executed_program.py"):
        path = ROUND / name
        inputs[str(path)] = digest(path)
    unchanged = {path: digest(Path(path)) == before for path, before in inputs.items()}
    output = {"schema": "opt2-round1-evidence-diagnosis/v1",
              "created_at": datetime.now(timezone.utc).isoformat(),
              "readonly": True, "simulation_runs_started": 0,
              "input_hashes": inputs, "all_inputs_unchanged_after_audit": all(unchanged.values()),
              "changed_inputs": [p for p, same in unchanged.items() if not same],
              "frozen_gate_pass_layouts": sum(row["all_pass"] for row in endings),
              "timed_out_layouts": [row["layout"] for row in endings if row["timed_out"]],
              "stalled_layouts": [row["layout"] for row in endings if row["stall_reason"]],
              "endings": endings,
              "map08_conclusion": {
                  "failed_frozen_check": "no_export_or_truth_errors",
                  "error_kind": "historical host CDP incremental-export read timeout",
                  "missing_native_frames_or_queries_or_png_bytes_or_exact_truth": False,
                  "reexport_or_rerun_needed_for_data_completeness": False,
                  "historical_error_can_be_erased_or_frozen_gate_reclassified": False,
                  "driver_deadline_caused_ending": False,
                  "wall_slowdown_precise_cause_profiled": False},
              "audits": audits}
    (HERE / "evidence_diagnosis.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: output[key] for key in ("frozen_gate_pass_layouts", "timed_out_layouts", "stalled_layouts", "all_inputs_unchanged_after_audit")}, ensure_ascii=False))
    print(json.dumps({"map08_mismatches": audits["map-08"]["mismatches"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
