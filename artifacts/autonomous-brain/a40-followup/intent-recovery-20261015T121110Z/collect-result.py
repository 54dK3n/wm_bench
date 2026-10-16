#!/usr/bin/env python3
"""Summarize a finished run; never open record, samples, captures or truth maps.

Usage: python3 <this-script> artifacts/.../run-... [--output artifacts/.../result.json]
Exit 2 without an output unless final brain summary, both recorded exit codes,
and the existing independent evaluation are available. Delivery is copied from
that evaluation, never recomputed. All output paths are repository-relative.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[4]
WORK = Path(__file__).resolve().parent


def relative(path):
    return str(path.resolve().relative_to(ROOT))


def local_path(value):
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("a repository-relative path without '..' is required")
    resolved = (ROOT / path).resolve()
    resolved.relative_to(ROOT)
    return resolved


def read(path):
    return json.loads(path.read_text())


def rows(path):
    # Ended runs must have complete JSON records; do not silently drop a tail.
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fields(value, names):
    return {key: value[key] for key in names if key in value} if isinstance(value, dict) else None


def ref(value):
    return fields(value, ("observation_index", "round", "frame_id", "tick", "simulation_seconds",
                          "track_id", "event_index", "seq", "type", "package_id"))


def source_version(name, expected):
    # A version label is accepted only from content matching the run's hash.
    for path in (ROOT / "autonomous_brain" / name, WORK / (name + ".before")):
        if path.is_file() and sha(path) == expected:
            match = re.search(r'^VERSION\s*=\s*["\']([^"\']+)', path.read_text(), re.M)
            return {"value": match.group(1) if match else None, "verified_source": relative(path)}
    return {"value": None, "verified_source": None, "note": "No hash-matching source available; use recorded SHA."}


def collect(run):
    brain = run / "map-05-run-1" / "brain"
    summary_path = brain / "summary.json"
    exit_path = run.with_name(run.name + "-exit-codes.json")
    evaluation_path = run.with_name(run.name + "-evaluation") / "evaluation.json"
    gates = (summary_path, exit_path, evaluation_path)
    missing = [relative(path) for path in gates if not path.is_file()]
    if missing:
        raise ValueError("not ended: missing " + ", ".join(missing))
    # Validate both exit values before opening any evaluation or run log.
    exits = read(exit_path)
    if any(type(exits.get(key)) is not int for key in ("driver_exit", "evaluator_exit")):
        raise ValueError("not ended: both integer driver_exit and evaluator_exit are required")
    summary = read(summary_path)
    if not summary.get("status") or summary["status"] in ("running", "started", "initializing"):
        raise ValueError("not ended: brain summary is not terminal")
    evaluation = read(evaluation_path)
    if type(evaluation.get("success")) is not bool or evaluation.get("run_directory") != relative(brain.parent):
        raise ValueError("independent evaluation does not match this run")

    manifest_path = run / "manifest.json"
    manifest = read(manifest_path)
    files = {name: brain / (name + ".jsonl") for name in ("rounds", "observations", "bridge-calls", "llm", "llm.lifecycle")}
    rounds, observations, bridge, calls, lifecycle = (rows(files[name]) for name in files)
    completed = [r for r in rounds if isinstance(r.get("action"), dict) and isinstance(r.get("result", {}).get("success"), bool)]
    effective = [r for r in calls if isinstance(r.get("action"), dict) and not r.get("transport_error") and not r.get("validation_error")]
    native_completed, cli_versions = 0, Counter()
    for call in calls:
        if call.get("request", {}).get("transport") != "codex-app-server":
            continue
        rpc = [json.loads(line) for line in (call.get("response_body") or "").splitlines() if line.strip()]
        terminal = [r.get("params", {}).get("turn", {}) for r in rpc if r.get("method") == "turn/completed"]
        native_completed += len(terminal) == 1 and terminal[0].get("status") == "completed" and not terminal[0].get("error")
        for row in rpc:
            version = (row.get("result") or {}).get("thread", {}).get("cliVersion")
            if version:
                cli_versions[version] += 1

    manipulations = {}
    manipulation_indices = [i for i, row in enumerate(bridge) if row.get("request", {}).get("method") in ("grab", "release")]
    for method in ("grab", "release"):
        evidence = []
        for number, index in enumerate(manipulation_indices):
            command = bridge[index]
            if command["request"]["method"] != method:
                continue
            end = manipulation_indices[number + 1] if number + 1 < len(manipulation_indices) else len(bridge)
            sensor_index = next((i for i in range(index + 1, end) if bridge[i].get("request", {}).get("method") == "holding"), None)
            terminal = command.get("terminal") or {}
            sensor = bridge[sensor_index] if sensor_index is not None else {}
            sensor_terminal = sensor.get("terminal") or {}
            holding = (sensor_terminal.get("result") or {}).get("holding") if sensor_terminal.get("status") == "completed" else None
            evidence.append({"command_request_id": command["request"].get("requestId"), "command_source_line": index + 1,
                             "terminal_status": terminal.get("status"), "actuator_completed": (terminal.get("result") or {}).get("completed"),
                             "next_manipulation_request_id": bridge[end]["request"].get("requestId") if end < len(bridge) else None,
                             "first_post_call_holding_request_id": sensor.get("request", {}).get("requestId"),
                             "holding_source_line": sensor_index + 1 if sensor_index is not None else None,
                             "holding_terminal_status": sensor_terminal.get("status"),
                             "sensor_holding": holding if type(holding) is bool else None})
        manipulations[method] = {"calls": len(evidence),
            "terminal_completed": sum(r["terminal_status"] == "completed" for r in evidence),
            "actuator_completed_true": sum(r["actuator_completed"] is True for r in evidence),
            "terminal_status_counts": dict(Counter(str(r["terminal_status"]) for r in evidence)),
            "missing_or_nonterminal_receipts": sum(r["terminal_status"] not in ("completed", "failed") for r in evidence),
            "post_call_sensor_holding_true": sum(r["sensor_holding"] is True for r in evidence),
            "post_call_sensor_holding_false": sum(r["sensor_holding"] is False for r in evidence),
            "post_call_sensor_holding_unavailable": sum(r["sensor_holding"] is None for r in evidence),
            "sensor_rule": "First holding request strictly after this command and before the next grab/release in public bridge order; no fallback across that boundary.",
            "evidence_path": relative(files["bridge-calls"]), "evidence": evidence}
    state_ids = {state: sorted({o["id"] for r in observations for o in r.get("objects", [])
                               if o.get("state", o.get("status")) == state}) for state in ("HELD", "DELIVERED")}
    available, selected, view_catalog, alias_groups = [], [], {}, []
    seen_aliases = set()
    for row in rounds:
        objects = row.get("state", {}).get("objects", [])
        ids = [obj["id"] for obj in objects if (obj.get("historical_view_revisit") or {}).get("available") is True]
        if ids:
            view_refs = []
            for obj in objects:
                if obj["id"] not in ids:
                    continue
                view = obj["historical_view_revisit"]
                key = f"{obj['id']}:{view.get('source_observation')}:{view.get('frame_id')}"
                view_catalog[key] = {"object_id": obj["id"], **fields(view, ("source_observation", "frame_id", "position_m", "heading_deg", "goal_semantics"))}
                view_refs.append(key)
            available.append({"round": row["round"], "object_ids": ids, "view_refs": view_refs})
        action = row.get("action") or {}
        oid = action.get("params", {}).get("object_id")
        evidence = row.get("result", {}).get("evidence", {})
        if action.get("action") == "go_to" and (oid in ids or isinstance(evidence.get("historical_view_revisit"), dict)):
            view = evidence.get("historical_view_revisit") or next(obj["historical_view_revisit"] for obj in objects if obj["id"] == oid)
            selected.append({"round": row["round"], "object_id": oid, "capability_available": oid in ids,
                             "success": row["result"].get("success"), "reason": row["result"].get("reason"),
                             "view_basis": "action_result" if isinstance(evidence.get("historical_view_revisit"), dict) else "decision_capability_only",
                             "public_robot_view": fields(view, ("source_observation", "frame_id", "position_m", "heading_deg", "goal_semantics", "arrived", "after_observation"))})
        for nav in row.get("state", {}).get("navigation", []):
            members = tuple(sorted(nav.get("identity_ids", [])))
            key = (nav.get("canonical_object_id"), members)
            if len(members) > 1 and key not in seen_aliases:
                seen_aliases.add(key)
                alias_groups.append({"first_observed_round": row["round"], "canonical_object_id": key[0], "identity_ids": list(members),
                                     "selected_action": action.get("action"), "selected_object_id": oid})

    failed = [{"round": row.get("round"), "action": (row.get("action") or {}).get("action"),
               "object_id": (row.get("action") or {}).get("params", {}).get("object_id"),
               "failure_kind": row.get("failure_kind"), "reason": row.get("result", {}).get("reason"),
               "evidence": relative(files["rounds"]) + ":" + str(row.get("round"))}
              for row in evaluation.get("failed_actions", [])]
    timelines = []
    for ball in evaluation.get("perception", {}).get("timeline", []):
        item = fields(ball, ("truth_id", "wm_track_ids"))
        for key in ("first_raw_seen", "first_logged_wm_presence", "first_confirmed", "first_grabbed_truth_event",
                    "first_delivered_truth_event", "final_active_delivery_truth_event"):
            item[key] = ref(ball.get(key))
        item["delivery_revocations"] = [ref(row) for row in ball.get("delivery_revocations", [])]
        timelines.append(item)
    delivery = evaluation["delivery"]
    sources = {"manifest": manifest_path, "brain_summary": summary_path, "exit_codes": exit_path,
               "independent_evaluation": evaluation_path, **files}
    return {
        "schema": "ended-run-compact-result/v2", "run": relative(run),
        "scope": "Final artifacts only; original evaluator verdict copied without rerun. No record/samples/captures/maps read.",
        "versions": {"brain": summary.get("version"), "runtime": summary.get("runtime_version"),
                     "actions": source_version("actions.py", summary.get("source_sha256", {}).get("actions.py")),
                     "native_llm": sorted({r.get("version") for r in calls if r.get("version")}),
                     "native_cli": dict(cli_versions), "evaluator": evaluation.get("version"),
                     "brain_revision": manifest.get("brainRevision"), "platform_revision": manifest.get("platformRevision")},
        "source_hashes": {"brain": summary.get("source_sha256"), "world_model": manifest.get("worldModel", {}).get("source_tree_sha256"),
                          "orchestrator": manifest.get("orchestrator", {}).get("sources"), "platform": manifest.get("platform"),
                          "native_client": manifest.get("modelConfiguration", {}).get("client", {}).get("sha256"),
                          "driver": manifest.get("driver", {}).get("sha256"), "evaluator": evaluation.get("evaluator_sha256")},
        "source_proof": fields(evaluation.get("source_proof"), ("status", "failures", "recorded_before_after_equal", "driver_sources_unchanged",
                                "brain_summary_hashes_match", "actual_orchestrator_matches", "actual_world_model_matches")),
        "model_configuration": fields(manifest.get("modelConfiguration"), ("model", "thinking", "temperature", "stream", "formal_run", "transport")),
        "counts": {"model_started": sum(r.get("event") == "started" for r in lifecycle),
                   "model_finished": sum(r.get("event") == "finished" for r in lifecycle), "effective_model_action_records": len(effective),
                   "native_completed_turn_receipts": native_completed, "completed_action_turns": len(completed), "round_records": len(rounds),
                   "action_types": dict(Counter(r["action"]["action"] for r in completed)), "bridge_calls": len(bridge),
                   "observations": len(observations), "public_holding_true": sum(r.get("holding", {}).get("holding") is True for r in observations),
                   "public_holding_false": sum(r.get("holding", {}).get("holding") is False for r in observations),
                   "distinct_HELD": len(state_ids["HELD"]), "distinct_DELIVERED": len(state_ids["DELIVERED"]),
                   "done": sum(r["action"]["action"] == "done" for r in completed)},
        "manipulations": manipulations, "distinct_state_ids": state_ids,
        "state_count_semantics": "Distinct WM IDs, not distinct physical balls; evaluator owns physical identity/delivery counts.",
        "termination": {"status": summary.get("status"), "reason": summary.get("reason"), **exits,
                        "interruption": fields(summary.get("interruption"), ("signal", "requested_phase", "active_round", "completed_rounds", "action_outcome_unknown"))},
        "original_evaluation": {"success": evaluation["success"], "failures": evaluation.get("failures"), "metrics": evaluation.get("metrics"),
                                "delivery": fields(delivery, ("expected_target_ids", "required_delivery_count", "qualifying_delivered_target_ids", "delivered_target_ids", "failures", "terminal_done")),
                                "final_target_flags": [fields(row, ("truth_id", "active_delivery_event", "inside_storage", "held", "sample_tick")) for row in delivery.get("final_positions", [])],
                                "task_completion": fields(evaluation.get("task_scope", {}).get("completion"), ("required_count", "delivered_count", "ready_for_done", "unmet_conditions"))},
        "historical_view_revisit": {"available": available, "selected": selected, "public_view_catalog": view_catalog,
                                  "observed_navigation_identity_groups": alias_groups,
                                  "semantics": "Available capability is not a selected revisit. Navigation identity groups are observed aliases, not extra truth balls."},
        "per_ball_evaluator_timeline": timelines,
        "public_red_track_timeline": [fields(row, ("object_id", "first_seen_s", "first_seen_round", "first_seen_frame_id", "confirmed_s", "confirmed_round", "picked_s", "picked_round", "delivered_s", "delivered_round"))
                                      for row in summary.get("timeline", []) if row.get("category") == "red-ball"],
        "failed_actions": {"classification_counts": dict(Counter(r["failure_kind"] for r in failed)),
                           "reason_counts": dict(Counter(r["reason"] for r in failed)), "rows": failed},
        "evidence": {key: {"path": relative(path), "sha256": sha(path)} for key, path in sources.items()},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", help="repository-relative completed run directory")
    parser.add_argument("--output", help="repository-relative output path (default: beside this script)")
    args = parser.parse_args()
    try:
        run = local_path(args.run)
        result = collect(run)
        output = local_path(args.output) if args.output else WORK / (run.name + "-result.json")
        if output.exists():
            raise ValueError("output already exists: " + relative(output))
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print(relative(output))
    except (ValueError, OSError, KeyError, TypeError) as error:
        print("collect-result: " + str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
