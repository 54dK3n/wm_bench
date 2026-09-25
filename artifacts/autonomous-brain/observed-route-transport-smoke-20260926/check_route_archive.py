"""Offline integrity and public route checks for this diagnostic fixture only."""
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
import re


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
TRIAL = HERE / "map-05-run-1"


def sha(body):
    return hashlib.sha256(body).hexdigest()


def read(path):
    return json.loads(path.read_text())


def lines(name):
    return [json.loads(line) for line in (TRIAL / "brain" / name).read_text().splitlines() if line.strip()]


def main():
    observations, motions, rounds, llm = map(lines, (
        "observations.jsonl", "motions.jsonl", "rounds.jsonl", "llm.jsonl"))
    checks = []

    def check(name, passed, detail=None):
        checks.append({"check": name, "passed": bool(passed), "detail": detail})

    events = [(row["observation_index"], event) for row in observations
              for event in row.get("road_traversal_events", [])]
    recorded = [(i, e) for i, e in events if e.get("recorded")]
    check("exactly_one_completed_trip_at_observation_2", len(events) == len(recorded) == 1
          and recorded[0][0] == 2)
    trip = recorded[0][1]["trip"]
    first, second = observations[:2]
    check("trip_matches_original_motion_once", trip["motions"] == [motions[0]]
          and motions[0]["method"] == "take_exit"
          and sum(m["method"] == "take_exit" for m in motions) == 1)
    check("trip_endpoint_indices_and_sensor_ticks_bound", trip["departure"]["observation_index"] == 1
          and trip["arrival"]["observation_index"] == 2
          and trip["departure"]["tick"] == first["odometry"]["tick"] == first["road"]["tick"] == first["observation"]["tick"]
          and trip["arrival"]["tick"] == second["odometry"]["tick"] == second["road"]["tick"] == second["observation"]["tick"]
          and first["observation"]["frameId"] != second["observation"]["frameId"])
    check("distinct_observed_nodes_and_actual_25cm", trip["departure"]["node_id"] != trip["arrival"]["node_id"]
          and all(o["road"]["onRoad"] and o["road"]["atNode"] and o["road"]["exits"] for o in (first, second))
          and trip["travelled_cm"] == second["odometry"]["distanceCm"] - first["odometry"]["distanceCm"] == 25
          and trip["cost_basis"] == "public_odometry_distanceCm_difference")
    check("departure_heading_is_original_fresh_exit", trip["observed_departure_angle_deg"] == 0
          and trip["departure_heading_deg"] == 0
          and first["road"]["exits"] == [{"angleDeg": 0}])
    next_hints = rounds[1]["state"]["exploration_hints"]
    check("next_round_has_three_actual_fresh_hints", len(next_hints) == 3
          and [h["next_exit_angle_deg"] for h in next_hints] == [90, .8, -90]
          and all(h["kind"] == "current_fresh_unexplored" and h["target_node_id"] == trip["arrival"]["node_id"]
                  and h["next_exit_angle_deg"] in rounds[1]["state"]["robot"]["exit_angles"] for h in next_hints))
    check("all_llm_states_preserve_logged_hints", all(
        json.loads(row["request"]["messages"][1]["content"])["exploration_hints"]
        == rounds[row["decision_index"] - 1]["state"]["exploration_hints"] for row in llm))
    allowed_hint_fields = {"kind", "target_node_id", "target_exit_index", "target_heading_deg",
        "next_exit_angle_deg", "recorded_travelled_cm", "cost_basis", "traversal_ids",
        "target_anchor_gap_cm", "requires_fresh_arrival_and_exit_recheck"}
    check("hints_are_compact_and_do_not_mark_done", all(len(r["state"]["exploration_hints"]) <= 3
          and all(set(h) <= allowed_hint_fields for h in r["state"]["exploration_hints"]) for r in rounds)
          and all(r.get("action", {}).get("action") != "done" for r in rounds if r.get("action")))
    bridge = lines("bridge-calls.jsonl")
    bridge_observations = [row["terminal"]["result"] for row in bridge if row["request"]["method"] == "observe"]
    check("all_14_public_observations_match_bridge_results", len(observations) == len(bridge_observations) == 14
          and all(a["observation"] == b for a, b in zip(observations, bridge_observations)))
    categories = Counter(d["category"] for row in observations for d in row["observation"]["detections"])
    check("all_observations_nonempty", all(row["observation"]["detections"] for row in observations), dict(categories))
    summary = read(TRIAL / "brain/summary.json")
    fixture = read(HERE / "diagnostic-fixture.json")
    check("expected_diagnostic_failure_not_task_acceptance", fixture["diagnostic"] is True
          and fixture["real_model_used"] is False and fixture["task_acceptance"] is False
          and fixture["model"] == "diagnostic-stub" and summary["status"] == "failed"
          and summary["reason"].startswith("LLMOutputError:")
          and [r["action"]["action"] for r in rounds if r["action"]] == ["explore", "look_around"]
          and len(llm) == 4 and [r["attempt"] for r in llm] == [1, 1, 1, 2])
    exports = read(TRIAL / "export-status.json")
    check("all_export_datasets_complete", exports["complete"] is True
          and exports["failures"] == [] and exports["partial"] == {}
          and set(exports["completedDatasets"]) == {"record", "samples", "sensorAudit", "captures", "envelope"})
    for name, item in read(TRIAL / "evidence.json").items():
        raw = (TRIAL / item["file"]).read_bytes()
        expanded = gzip.decompress(raw) if item["compression"] == "gzip" else raw
        check(name + "_compressed_and_expanded_integrity", len(raw) == item["bytes"]
              and sha(raw) == item["sha256"] and len(expanded) == item["expandedBytes"]
              and sha(expanded) == item["expandedSha256"])
    original = read(HERE / "archive-original-sha256.json")
    check("all_original_files_unchanged", all(sha((HERE / f).read_bytes()) == h for f, h in original.items()), len(original))
    frozen = read(HERE / "manifest.json")["brain"]
    check("all_brain_sources_match_frozen_manifest", all(sha((ROOT / f).read_bytes()) == h for f, h in frozen.items()))
    replay = read(HERE / "route-integration-replay/replay-checks.json")
    check("offline_replay_complete_and_exact", replay["allPass"] and replay["all_records_consumed"]
          and replay["full_records_equal_except_mode"] and replay["replayed_calls"] == 4)

    scan = {"files": 0, "expanded_gzip_files": 0, "absolute_home_paths": [], "provider_key_patterns": [],
            "unexpected_sensitive_values": [], "diagnostic_or_redacted_values": 0, "over_100MiB": []}
    home = re.compile(rb"/(?:Users|home)/[^/\s\"'<>]+/")
    credential = re.compile(rb"\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b")
    sensitive = re.compile(r"^(?:api[_-]?key|authorization|client[_-]?token|secret|password)$", re.I)

    def walk(value, file):
        if isinstance(value, dict):
            for key, item in value.items():
                if sensitive.fullmatch(key) and isinstance(item, str) and item:
                    safe = item == "<not recorded>"
                    if safe:
                        scan["diagnostic_or_redacted_values"] += 1
                    else:
                        scan["unexpected_sensitive_values"].append({"file": file, "key": key})
                walk(item, file)
        elif isinstance(value, list):
            for item in value:
                walk(item, file)

    for path in HERE.rglob("*"):
        if not path.is_file():
            continue
        file = str(path.relative_to(HERE)); raw = path.read_bytes(); scan["files"] += 1
        if len(raw) > 100 * 1024 ** 2:
            scan["over_100MiB"].append(file)
        if path.suffix == ".gz":
            raw = gzip.decompress(raw); scan["expanded_gzip_files"] += 1
            if len(raw) > 100 * 1024 ** 2:
                scan["over_100MiB"].append(file + " (expanded)")
        if home.search(raw):
            scan["absolute_home_paths"].append(file)
        if credential.search(raw):
            scan["provider_key_patterns"].append(file)
        try:
            if path.suffix == ".jsonl":
                for line in raw.decode().splitlines():
                    if line.strip():
                        walk(json.loads(line), file)
            else:
                walk(json.loads(raw), file)
        except (UnicodeError, json.JSONDecodeError):
            pass
    check("archive_privacy_and_size_scan", not any(scan[k] for k in (
        "absolute_home_paths", "provider_key_patterns", "unexpected_sensitive_values", "over_100MiB")), scan)
    result = {"schema": "observed-route-diagnostic-archive/v1", "diagnostic": True,
              "task_acceptance": False, "real_model_used": False, "checks": checks,
              "allPass": all(c["passed"] for c in checks), "simulation_seconds": summary["simulation_seconds"],
              "completed_trips": len(recorded), "recorded_path_cm": trip["travelled_cm"],
              "next_round_hint_angles": [h["next_exit_angle_deg"] for h in next_hints],
              "coverage_limit": "Only fresh-frontier hints occur in this short fixture; recorded-route hints are covered by separate saved Run20 replay, not this smoke."}
    (HERE / "route-archive-checks.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"allPass": result["allPass"], "checks": len(checks),
                      "failed": [c for c in checks if not c["passed"]]}, ensure_ascii=False))
    return 0 if result["allPass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
