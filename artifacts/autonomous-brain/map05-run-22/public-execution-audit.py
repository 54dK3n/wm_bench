#!/usr/bin/env python3
"""Recompute run22's public execution audit; never reads evaluator truth files.

Run from anywhere: python3 -B /absolute/path/to/public-execution-audit.py
The JSON report is printed to stdout. This script does not alter any input.
"""
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
BRAIN = HERE / "map-05-run-1" / "brain"
SENSORS = (("odometry", "odometry"), ("local_road", "road"),
           ("holding", "holding"), ("observe", "observation"))
ACTUATORS = {"grab", "release", "forward", "backward", "turn", "follow_road", "take_exit"}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode()


def main():
    issues, inputs, raw_inputs = [], {}, {}

    def check(ok, code, **context):
        if not ok:
            issues.append({"code": code, **context})
        return bool(ok)

    def read(name, jsonl=True):
        path = BRAIN / name
        raw = path.read_bytes()
        raw_inputs[name] = raw
        inputs[str(path.relative_to(HERE))] = {"sha256": sha(raw), "bytes": len(raw)}
        if not jsonl:
            return json.loads(raw)
        lines = raw.splitlines(keepends=True)
        complete = [line for line in lines if line.endswith(b"\n")]
        check(len(complete) == len(lines), "INCOMPLETE_JSONL_TAIL", file=name)
        rows = []
        for number, line in enumerate(complete, 1):
            try:
                rows.append(json.loads(line))
            except (ValueError, UnicodeError) as error:
                check(False, "INVALID_JSONL_LINE", file=name, line=number, error=type(error).__name__)
        inputs[str(path.relative_to(HERE))].update(complete_lines=len(complete), parsed_rows=len(rows))
        return rows

    rounds = read("rounds.jsonl")
    observations = read("observations.jsonl")
    motions = read("motions.jsonl")
    bridge = read("bridge-calls.jsonl")
    llm = read("llm.jsonl")
    summary = read("summary.json", False)
    obs = {row["observation_index"]: row for row in observations}
    round_obs, round_motions = defaultdict(list), defaultdict(list)
    for row in observations:
        round_obs[row["round"]].append(row)
    for number, row in enumerate(motions, 1):
        round_motions[row["round"]].append((number, row))

    check([row["round"] for row in rounds] == list(range(1, len(rounds) + 1)), "ROUND_SEQUENCE")
    check([row["observation_index"] for row in observations] == list(range(1, len(observations) + 1)), "OBSERVATION_SEQUENCE")
    frames = [row["observation"]["frameId"] for row in observations]
    check(len(set(frames)) == len(frames), "DUPLICATE_OBSERVATION_FRAME")
    tick_step = next((row["simulation_seconds"] / row["odometry"]["tick"] for row in observations if row["odometry"]["tick"]), None)
    sensor_checks = []
    previous_tick = -1
    for row in observations:
        number = row["observation_index"]
        ticks = {name: row[name]["tick"] for name in ("odometry", "road", "observation")}
        before_count = len(issues)
        check(len(set(ticks.values())) == 1, "SENSOR_TICK_MISMATCH", observation=number, ticks=ticks)
        check(ticks["odometry"] >= previous_tick, "TICK_REGRESSION", observation=number)
        check(tick_step is not None and math.isclose(row["simulation_seconds"], ticks["odometry"] * tick_step, abs_tol=1e-9), "SIMULATION_TIME_TICK_MISMATCH", observation=number)
        previous_tick = ticks["odometry"]
        sensor_checks.append({"observation": number, "frame_id": row["observation"]["frameId"], "ticks": ticks,
                              "pass": len(issues) == before_count})

    motion_checks = []
    for number, motion in enumerate(motions, 1):
        before_count = len(issues)
        before, after = motion["before_observation"], motion["after_observation"]
        valid = check(before in obs and after in obs, "MOTION_OBSERVATION_MISSING", motion=number)
        check(after == before + 1, "MOTION_NEW_OBSERVATION_NOT_IMMEDIATE", motion=number, before=before, after=after)
        if valid:
            pre, post = obs[before], obs[after]
            check(pre["round"] == post["round"] == motion["round"], "MOTION_ROUND_MISMATCH", motion=number)
            check(pre["observation"]["frameId"] != post["observation"]["frameId"], "MOTION_REUSED_FRAME", motion=number)
            dt = post["odometry"]["tick"] - pre["odometry"]["tick"]
            check(dt >= 0, "MOTION_TICK_REGRESSION", motion=number)
            if "elapsedTicks" in motion["actuator_result"]:
                check(dt == motion["actuator_result"]["elapsedTicks"], "MOTION_ELAPSED_TICKS_MISMATCH", motion=number)
        motion_checks.append({"motion": number, "round": motion["round"], "method": motion["method"],
                              "before_observation": before, "after_observation": after,
                              "pass": len(issues) == before_count})

    # Associate every public bridge call chronologically. Each observation is
    # exactly four sensor responses; every intervening actuator is a motion.
    bridge_bindings, cursor, observed, moved = [], 0, 0, 0
    for index, row in enumerate(bridge, 1):
        check(row.get("terminal", {}).get("status") == "completed" and "error" not in row,
              "BRIDGE_NOT_COMPLETED", bridge_line=index)
        check(row["request"]["requestId"] == f"brain-{index:06d}", "BRIDGE_REQUEST_SEQUENCE", bridge_line=index)
    if bridge:
        check(bridge[0]["request"]["method"] == "camera_parameters", "MISSING_INITIAL_CAMERA_PARAMETERS")
        cursor = 1
    while cursor < len(bridge):
        row = bridge[cursor]
        method = row["request"]["method"]
        before_count = len(issues)
        if method == "odometry":
            observed += 1
            group = bridge[cursor:cursor + 4]
            check([item["request"]["method"] for item in group] == [name for name, _ in SENSORS],
                  "SENSOR_BRIDGE_ORDER", observation=observed, bridge_line=cursor + 1)
            if observed in obs and len(group) == 4:
                for item, (sensor_method, field) in zip(group, SENSORS):
                    check(item.get("terminal", {}).get("result") == obs[observed][field],
                          "SENSOR_BRIDGE_RESULT_MISMATCH", observation=observed, sensor=sensor_method)
            else:
                check(False, "UNBOUND_SENSOR_BRIDGE_GROUP", observation=observed)
            bridge_bindings.append({"observation": observed, "bridge_lines": [cursor + 1, cursor + 4],
                                    "pass": len(issues) == before_count})
            cursor += 4
        elif method in ACTUATORS:
            moved += 1
            if moved <= len(motions):
                motion = motions[moved - 1]
                check(motion["method"] == method and motion["params"] == row["request"]["params"]
                      and motion["actuator_result"] == row.get("terminal", {}).get("result"),
                      "MOTION_BRIDGE_RESULT_MISMATCH", motion=moved, bridge_line=cursor + 1)
                check(motion["before_observation"] == observed and motion["after_observation"] == observed + 1,
                      "MOTION_BRIDGE_OBSERVATION_ORDER", motion=moved, bridge_line=cursor + 1)
                check(cursor + 1 < len(bridge) and bridge[cursor + 1]["request"]["method"] == "odometry",
                      "MOTION_WITHOUT_IMMEDIATE_SENSOR_GROUP", motion=moved, bridge_line=cursor + 1)
            else:
                check(False, "UNLOGGED_BRIDGE_ACTUATOR", bridge_line=cursor + 1)
            cursor += 1
        else:
            check(False, "UNEXPECTED_BRIDGE_METHOD", bridge_line=cursor + 1, method=method)
            cursor += 1
    check(observed == len(observations) and moved == len(motions), "BRIDGE_BINDING_COUNTS", observations_bound=observed, motions_bound=moved)

    actions, confirmed, failures, success_events = [], [], defaultdict(list), []
    llm_by_index = {row["call_index"]: row for row in llm}
    for row in rounds:
        number, action = row["round"], row["action"]
        before_count = len(issues)
        if not check(isinstance(action, dict), "ROUND_WITHOUT_ACTION", round=number):
            continue
        state, result = row["state"], row["result"]
        evidence = result.get("evidence", {})
        before, after, final = (evidence.get(key) for key in ("before_observation", "after_observation", "final_observation"))
        valid = check(all(index in obs for index in (before, after, final)), "ACTION_OBSERVATION_MISSING", round=number)
        if valid:
            pre, used, post = obs[before], obs[after], obs[final]
            check(before == round_obs[number][0]["observation_index"] and final == round_obs[number][-1]["observation_index"],
                  "ACTION_OBSERVATION_BOUNDARIES", round=number)
            check(before <= after <= final and final > before, "ACTION_WITHOUT_NEW_FINAL_OBSERVATION", round=number)
            check(pre["round"] == used["round"] == post["round"] == number, "ACTION_OBSERVATION_ROUND_MISMATCH", round=number)
            check(pre["observation"]["frameId"] != post["observation"]["frameId"], "ACTION_REUSED_FINAL_FRAME", round=number)
            expected_pose = {"right_cm": pre["odometry"]["rightCm"], "forward_cm": pre["odometry"]["forwardCm"], "heading_deg": pre["odometry"]["headingDeg"]}
            check(state["robot"]["pose"] == expected_pose and state["robot"]["holding"] == pre["holding"]["holding"], "ACTION_STATE_PREOBS_MISMATCH", round=number)
            check(state["simulation_seconds"] == pre["simulation_seconds"] and row["simulation_seconds"] == post["simulation_seconds"], "ACTION_TIME_BOUNDARY_MISMATCH", round=number)
            check(evidence.get("frame_id") == used["observation"]["frameId"]
                  and evidence.get("tick") == used["observation"]["tick"]
                  and evidence.get("holding") == used["holding"]["holding"], "ACTION_RESULT_OBSERVATION_BINDING", round=number)
        if action["action"] in {"go_to", "pick"}:
            oid = action["params"].get("object_id")
            matches = [item for item in state["objects"] if item["id"] == oid]
            observed_matches = [item for item in obs.get(before, {}).get("objects", []) if item["id"] == oid]
            passed = check(len(matches) == 1 and matches[0].get("status") == "CONFIRMED"
                           and len(observed_matches) == 1 and observed_matches[0].get("state") == "CONFIRMED",
                           "TARGET_NOT_CONFIRMED", round=number, object_id=oid)
            confirmed.append({"round": number, "action": action["action"], "object_id": oid,
                              "state_status": matches[0].get("status") if len(matches) == 1 else None,
                              "before_observation_status": observed_matches[0].get("state") if len(observed_matches) == 1 else None,
                              "pass": passed})
        record = row["llm_output"]
        check(record == llm_by_index.get(row["llm_call_count"]), "ROUND_LLM_RECORD_MISMATCH", round=number)
        check(record["action"] == action and json.loads(record["request"]["messages"][1]["content"]) == state,
              "EXECUTED_ACTION_REQUEST_MISMATCH", round=number)
        check(sha(canonical(record["request"])) == record["request_sha256"], "REQUEST_HASH_MISMATCH", round=number)
        if result["success"] is False:
            failures[(action["action"], result["reason"])].append(number)
        if action["action"] in {"pick", "place", "done"}:
            success_events.append({"round": number, "action": action, "success": result["success"],
                                   "reason": result["reason"], "object_id": evidence.get("object_id")})
        actions.append({"round": number, "action": action, "before_observation": before,
                        "result_observation": after, "final_observation": final,
                        "motion_count": len(round_motions[number]), "pass": len(issues) == before_count})

    # A repeat must immediately follow a successful standoff for the same ID,
    # issue no actuator call, and preserve odometry/tick/holding through both
    # the previous final observation and current before/final observations.
    repetitions, current = [], None
    for previous, row in zip(rounds, rounds[1:]):
        action, prior = row["action"], previous["action"]
        same = (isinstance(action, dict) and action == prior and action["action"] == "go_to"
                and all(item["result"]["success"] is True and item["result"]["reason"] == "target_seen_at_standoff"
                        for item in (previous, row)))
        repeated = False
        if same:
            p = obs.get(previous["result"]["evidence"].get("final_observation"))
            a = obs.get(row["result"]["evidence"].get("before_observation"))
            b = obs.get(row["result"]["evidence"].get("final_observation"))
            repeated = bool(p and a and b and not round_motions[row["round"]]
                            and p["odometry"] == a["odometry"] == b["odometry"]
                            and p["holding"] == a["holding"] == b["holding"])
        if repeated:
            if current is None:
                current = {"object_id": action["params"]["object_id"], "initial_standoff_round": previous["round"],
                           "initial_standoff_motion_count": len(round_motions[previous["round"]]),
                           "repeat_rounds": [], "tick": a["odometry"]["tick"],
                           "simulation_seconds": a["simulation_seconds"], "holding": a["holding"]["holding"]}
            current["repeat_rounds"].append(row["round"])
        elif current is not None:
            repetitions.append(current)
            current = None
    if current is not None:
        repetitions.append(current)
    for segment in repetitions:
        segment["repeat_count"] = len(segment["repeat_rounds"])
        segment["standoff_call_count_including_initial"] = segment["repeat_count"] + 1
        end = segment["repeat_rounds"][-1]
        following = next((row for row in rounds if row["round"] == end + 1), None)
        segment["following_action"] = ({"round": following["round"], "action": following["action"],
                                        "success": following["result"]["success"], "reason": following["result"]["reason"]}
                                       if following else None)

    for field, expected in (("rounds", len(rounds)), ("observations", len(observations)), ("llm_calls", len(llm))):
        check(summary.get(field) == expected, "SUMMARY_COUNT_MISMATCH", field=field, actual=expected, summary=summary.get(field))
    check(summary["simulation_seconds"] == observations[-1]["simulation_seconds"] == rounds[-1]["simulation_seconds"], "SUMMARY_FINAL_TIME_MISMATCH")
    check([row["call_index"] for row in llm] == list(range(1, len(llm) + 1)), "LLM_CALL_SEQUENCE")
    for name, raw in raw_inputs.items():
        check((BRAIN / name).read_bytes() == raw, "SOURCE_CHANGED_DURING_AUDIT", file=name)
    return {
        "schema": "run22-public-execution-audit/v1",
        "scope": "Complete public brain logs and brain summary only; no record/samples/captures/evaluation or physical truth verdicts.",
        "script_sha256": sha(Path(__file__).read_bytes()), "inputs": inputs,
        "summary": {key: summary[key] for key in ("status", "reason", "rounds", "observations", "llm_calls", "simulation_seconds", "held_object_id")},
        "counts": {"rounds": len(rounds), "executed_actions": len(actions), "complete_observations": len(observations),
                   "unique_observation_frames": len(set(frames)), "motions": len(motions), "bridge_calls": len(bridge), "llm_calls": len(llm),
                   "actions_with_verified_post_observation": sum(item["pass"] for item in actions),
                   "confirmed_preconditions": len(confirmed), "confirmed_preconditions_passed": sum(item["pass"] for item in confirmed)},
        "sensor_tick_scope": "Compares odometry.tick, road.tick and observation.tick. holding has no tick; its exact response is checked within the same chronological four-call sensor group.",
        "inferred_public_tick_duration_seconds": tick_step,
        "freshness_definition": "A new observation index and distinct frame ID obtained after the action/motion; stationary sensor calls need not advance simulation tick.",
        "action_observation_checks": actions, "motion_observation_checks": motion_checks,
        "sensor_tick_checks": sensor_checks, "bridge_observation_bindings": bridge_bindings,
        "confirmation_preconditions": confirmed,
        "action_counts": dict(Counter(row["action"]["action"] for row in rounds if row["action"])),
        "failed_action_count": sum(len(values) for values in failures.values()),
        "failure_groups": [{"action": action, "reason": reason, "count": len(numbers), "rounds": numbers}
                           for (action, reason), numbers in sorted(failures.items(), key=lambda item: (-len(item[1]), item[0]))],
        "public_pick_place_done_events": success_events,
        "stationary_repeat_definition": "Consecutive same-object successful go_to target_seen_at_standoff; the repeated round has no motions and previous final/current before/current final odometry, tick and holding are identical.",
        "stationary_standoff_repeat_segments": repetitions,
        "stationary_repeat_action_count": sum(segment["repeat_count"] for segment in repetitions),
        "llm_transport_error_counts": dict(Counter(row["transport_error"]["type"] for row in llm if row["transport_error"])),
        "llm_validation_error_counts": dict(Counter(row["validation_error"] for row in llm if row["validation_error"])),
        "issues": issues, "issue_count": len(issues), "allPass": not issues,
        "limitations": ["Public-log consistency does not establish physical delivery, complete map exploration, detection completeness, or overall task success.",
                       "Frame freshness is distinguished from simulation-time advancement; unchanged tick is valid for sensor-only actions."]}


if __name__ == "__main__":
    print(json.dumps(main(), ensure_ascii=False, indent=2))
