"""Independent log joins and pixel gates for task-aware offline evaluation.

No simulator/model access. Neither DELIVERED labels nor claimed candidate counts
are proofs: observations, command boundaries and model bytes are joined again.
"""
from __future__ import annotations

from collections import defaultdict
from contextlib import redirect_stdout
import hashlib
import io
import json
import math
from pathlib import Path
import tempfile

from autonomous_brain.actions import ball_inside_region
from autonomous_brain.llm import LLMClient, _strict_loads, validate_action


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def box_key(item):
    box = item.get("bbox", {})
    values = [box.get(key) for key in ("x", "y", "w", "h")]
    if not all(number(v) for v in values) or values[2] <= 0 or values[3] <= 0:
        return None
    return (item.get("category"), *values)


def unique_index(rows, key, failures, label):
    grouped = defaultdict(list)
    for row in rows:
        value = key(row)
        if value is None:
            failures.append(label + "_missing")
        else:
            grouped[value].append(row)
    if any(len(group) != 1 for group in grouped.values()):
        failures.append(label + "_duplicate_or_conflicting")
    return {key: group[0] for key, group in grouped.items() if len(group) == 1}


def frame(row):
    value = row.get("observation", {}).get("frameId")
    return str(value) if value is not None else None


def audit_observed_ledger(summary, observations, rounds, bridge, motions):
    failures, deliveries = [], []
    by_index = unique_index(observations, lambda r: r.get("observation_index"), failures, "observation_index")
    by_frame = unique_index(observations, frame, failures, "observation_frame")
    unique_index(rounds, lambda r: r.get("round"), failures, "decision_round")
    indexes = [r.get("observation_index") for r in observations]
    if any(type(index) is not int for index in indexes) or indexes != list(range(1, len(observations) + 1)):
        failures.append("observation_sequence_incomplete")
    ticks = [r.get("observation", {}).get("tick") for r in observations]
    if any(not number(t) for t in ticks) or (all(number(t) for t in ticks) and ticks != sorted(ticks)):
        failures.append("observation_tick_invalid_or_reversed")
    for row in observations:
        if row.get("odometry", {}).get("tick") != row.get("observation", {}).get("tick"):
            failures.append("observation_odometry_tick_mismatch")
    unique_index(summary.get("final_objects", []), lambda r: r.get("id"), failures, "final_object_identity")
    bridge = bridge or []
    unique_index(bridge, lambda r: r.get("request", {}).get("requestId"), failures, "bridge_request_id")
    observed_bridge, current_holding = [], None
    for index, call in enumerate(bridge):
        terminal = call.get("terminal", {})
        if terminal.get("status") != "completed":
            continue
        method = call.get("request", {}).get("method")
        if method == "holding":
            current_holding = terminal.get("result")
        if method == "observe":
            observed_bridge.append({"bridge_index": index, "sensor": terminal.get("result"),
                                    "holding": current_holding})
            current_holding = None  # A previous frame's gripper reading is not fresh evidence.
    bridge_frames = unique_index(observed_bridge,
        lambda r: str(r["sensor"].get("frameId")) if isinstance(r.get("sensor"), dict)
        and r["sensor"].get("frameId") is not None else None, failures, "bridge_observation_frame")
    if len(observed_bridge) != len(observations):
        failures.append("bridge_observation_count_mismatch")
    for row in observations:
        raw = bridge_frames.get(frame(row), {})
        if raw.get("sensor") != row.get("observation") or raw.get("holding") != row.get("holding"):
            failures.append("observation_not_corroborated_by_bridge")

    def corroborated_motion(motion, method):
        before, after = (by_index.get(motion.get(k), {}) for k in ("before_observation", "after_observation"))
        left, right = bridge_frames.get(frame(before), {}), bridge_frames.get(frame(after), {})
        if (motion.get("method") != method or not before or not after
                or not left or not right or before["observation_index"] >= after["observation_index"]):
            return False
        matching = [row for row in bridge[left["bridge_index"] + 1:right["bridge_index"]]
            if row.get("request", {}).get("method") == method
            and row.get("request", {}).get("params") == motion.get("params")
            and row.get("terminal", {}).get("status") == "completed"
            and row.get("terminal", {}).get("result") == motion.get("actuator_result")]
        return len(matching) == 1

    def action_window(index, action, oid):
        matches = []
        for row in rounds:
            result = row.get("result", {})
            basis = result.get("evidence", {})
            start, end = basis.get("before_observation"), basis.get("final_observation", basis.get("after_observation"))
            if type(start) is not int or type(end) is not int or not start <= index <= end:
                continue
            name = (row.get("action") or {}).get("action")
            direct = name == action and basis.get("object_id") == oid and result.get("success") is True
            recovered = action == "place" and any(r.get("object_id") == oid and r.get("resolved") is True
                and r.get("state") == "DELIVERED" for r in basis.get("release_recovery", []))
            if direct or recovered:
                matches.append(row)
        return matches

    def raw_detection_ok(row, item):
        key = box_key(item)
        return (key is not None and str(item.get("frame_id")) == frame(row)
            and sum(box_key(raw) == key for raw in row.get("observation", {}).get("detections", [])) == 1
            and sum(box_key(det) == key for det in row.get("perception", {}).get("detections", [])) == 1)

    seen_ids, seen_witnesses, successful_picks = set(), set(), {}
    events = summary.get("action_evidence", [])
    for event_index, event in enumerate(events):
        action, oid, basis = event.get("action"), event.get("object_id"), event.get("evidence") or {}
        if action == "pick":
            index = basis.get("post_observation", basis.get("after_observation"))
            observed = by_index.get(index, {})
            windows = action_window(index, "pick", oid) if type(index) is int else []
            valid = observed.get("holding", {}).get("holding") is True and len(windows) == 1
            if valid:
                window = windows[0]["result"]["evidence"]
                valid = window.get("post_observation", window.get("after_observation")) == index
                start = window.get("before_observation")
                valid = valid and any(start <= m.get("before_observation", -1) < m.get("after_observation", -1) <= index
                    and corroborated_motion(m, "grab") for m in (motions or []))
            if not valid:
                failures.append("pick_ledger_missing_holding_observation")
            else:
                successful_picks[oid] = index
            continue
        if action != "place":
            continue
        row_failures = []
        placement, release = basis.get("placement") or {}, basis.get("release_observation") or {}
        observed, boundary = by_frame.get(str(placement.get("frame_id")), {}), by_frame.get(str(release.get("frame_id")), {})
        index, boundary_index = observed.get("observation_index"), boundary.get("observation_index")
        detections = observed.get("perception", {}).get("detections", [])
        # Every relevant original box participates. A second ball cannot be
        # hidden by deleting only its converted entry or inventing an old label.
        for raw in observed.get("observation", {}).get("detections", []):
            if raw.get("category") in {"red-ball", "storage-zone"}:
                matching = [d for d in detections if box_key(d) == box_key(raw)]
                if len(matching) != 1:
                    row_failures.append("delivery_raw_detection_missing_or_duplicated_in_conversion")
        for det in detections:
            if det.get("category") == "red-ball":
                position = det.get("position_m")
                if not isinstance(position, dict) or not all(number(position.get(k)) for k in ("x", "z")):
                    row_failures.append("delivery_converted_geometry_unavailable")
            if (det.get("category") == "red-ball" and det.get("known_delivered_object_id")
                    and det["known_delivered_object_id"] not in seen_ids):
                row_failures.append("delivery_unknown_delivered_label")
        balls = [d for d in detections if d.get("category") == "red-ball" and d.get("bbox") == placement.get("ball_bbox")]
        zones = [d for d in detections if d.get("category") == "storage-zone" and d.get("bbox") == placement.get("storage_bbox")]
        if (len(balls) != 1 or len(zones) != 1 or observed.get("holding", {}).get("holding") is not False
                or not all(raw_detection_ok(observed, d) for d in balls + zones)):
            row_failures.append("delivery_ledger_missing_same_frame_observation")
        if (type(index) is not int or type(boundary_index) is not int or index <= boundary_index
                or basis.get("post_observation") != index
                or boundary.get("simulation_seconds") != release.get("simulation_time_s")
                or event.get("simulation_time_s") != observed.get("simulation_seconds")
                or boundary.get("holding", {}).get("holding") is not False):
            row_failures.append("delivery_release_boundary_invalid")
        preexisting = release.get("preexisting_ball_ids")
        expected_old = sorted(obj.get("id") for obj in boundary.get("objects", [])
                              if obj.get("category") == "red-ball" and obj.get("id") != oid)
        if not isinstance(preexisting, list) or sorted(preexisting) != expected_old:
            row_failures.append("delivery_preexisting_identities_mismatch")
            preexisting = expected_old
        pair_candidates = []
        for ball in detections:
            if (ball.get("category") != "red-ball" or "position_m" not in ball
                    or ball.get("known_delivered_object_id") or ball.get("track_id") in preexisting):
                continue
            for zone in detections:
                if (zone.get("category") == "storage-zone" and box_key(ball) is not None and box_key(zone) is not None
                        and ball_inside_region(ball["bbox"], zone["bbox"])):
                    pair_candidates.append((ball, zone))
        if (len(pair_candidates) != 1 or len(balls) != 1 or len(zones) != 1
                or pair_candidates[0] != (balls[0], zones[0])):
            row_failures.append("delivery_unique_geometric_witness_not_verified")
        if len(balls) == 1 and (placement.get("ball_track_id") != balls[0].get("track_id")
                or placement.get("ball_position_m") != balls[0].get("position_m")
                or placement.get("ball_category") != "red-ball"):
            row_failures.append("delivery_converted_witness_mismatch")
        if any(d.get("identity_ambiguity") for d in balls):
            row_failures.append("delivery_witness_identity_ambiguous")
        visible_old = {d.get("known_delivered_object_id") for d in detections if d.get("category") == "red-ball"}
        if not seen_ids <= visible_old:
            row_failures.append("delivery_prior_deliveries_not_distinguished")
        for old in seen_ids:
            old_boxes = [d for d in detections if d.get("known_delivered_object_id") == old]
            if len(old_boxes) != 1 or not raw_detection_ok(observed, old_boxes[0]):
                row_failures.append("delivery_prior_delivered_label_not_corroborated")
        windows = action_window(index, "place", oid) if type(index) is int else []
        if len(windows) != 1:
            row_failures.append("delivery_action_reference_missing_or_ambiguous")
        elif (windows[0].get("action", {}).get("action") == "place"
                and not windows[0]["result"]["evidence"].get("release_recovery")
                and any(windows[0]["result"]["evidence"].get(k) != basis.get(k)
                        for k in ("placement", "release_observation", "post_observation", "candidate_witnesses"))):
            row_failures.append("delivery_action_evidence_mismatch")
        release_motions = [m for m in (motions or []) if m.get("after_observation") == boundary_index
                           and corroborated_motion(m, "release")]
        if len(release_motions) != 1:
            row_failures.append("delivery_release_command_not_corroborated")
        else:
            before = by_index.get(release_motions[0].get("before_observation"), {})
            if (before.get("holding", {}).get("holding") is not True
                    or not any(o.get("id") == oid and o.get("state") == "HELD" for o in before.get("objects", []))):
                row_failures.append("delivery_released_identity_not_held")
        if oid not in successful_picks or (type(boundary_index) is int and successful_picks.get(oid, math.inf) >= boundary_index):
            row_failures.append("delivery_missing_prior_verified_pick")
        witness_key = canonical([placement.get("frame_id"), placement.get("ball_bbox")])
        if oid in seen_ids or witness_key in seen_witnesses:
            row_failures.append("delivery_duplicate_identity_or_witness")
        seen_ids.add(oid)
        seen_witnesses.add(witness_key)
        row_failures = list(dict.fromkeys(row_failures))
        deliveries.append({"event_index": event_index, "object_id": oid, "observation_index": index,
            "frame_id": placement.get("frame_id"), "release_observation_index": boundary_index,
            "geometric_candidates": len(pair_candidates), "action_round": windows[0].get("round") if len(windows) == 1 else None,
            "verified": not row_failures, "failures": row_failures})
        failures.extend(row_failures)
    return {"scope": "bridge_observation_action_and_delivery_evidence", "deliveries": deliveries,
            "failures": list(dict.fromkeys(failures))}


def audit_done_bytes(last, calls, progress, observations):
    failures = []
    record = last.get("llm_output") or {}
    expected = {"action": "done", "params": {}}
    try:
        request = record["request"]
        if request.get("stream"):
            raw, model, done, error = LLMClient._decode_stream(record["response_body"], require_stop=True)
            if not done:
                raise ValueError("incomplete stream")
        else:
            raw, model, error = LLMClient._decode_response(record["response_body"], require_stop=True)
        parsed = validate_action(_strict_loads(raw), last.get("state", {}))
        if (error is not None or record.get("transport_error") is not None or record.get("validation_error") is not None
                or model != "deepseek-flash" or raw != record.get("raw_output") or parsed != expected
                or record.get("action") != expected or last.get("action") != expected
                or sum(call == record for call in calls) != 1
                or record.get("request_sha256") != hashlib.sha256(canonical(request).encode()).hexdigest()):
            raise ValueError("model bytes disagree")
    except (KeyError, TypeError, ValueError):
        failures.append("done_not_selected_in_recorded_llm_call")
    result, final = last.get("result", {}), observations[-1] if observations else {}
    basis = result.get("evidence", {})
    before, after = basis.get("before_observation"), basis.get("after_observation")
    completion_keys = ["ready_for_done", "delivered_count", "delivered_object_ids", "delivery_evidence", "unresolved_identity_ids", "unmet_conditions"]
    if progress.get("task_spec", {}).get("quantity_mode") == "unknown":
        completion_keys += ["exploration", "unresolved_discovery_ids", "current_target_ambiguities"]
    if (result.get("success") is not True or type(before) is not int or type(after) is not int or after <= before
            or after != final.get("observation_index") or basis.get("frame_id") != final.get("observation", {}).get("frameId")
            or basis.get("tick") != final.get("observation", {}).get("tick") or basis.get("holding") is not False
            or any(basis.get(key) != progress.get(key) for key in completion_keys)):
        failures.append("done_post_action_completion_not_corroborated")
    return {"raw_model_output_verified": "done_not_selected_in_recorded_llm_call" not in failures,
            "post_action_completion_verified": "done_post_action_completion_not_corroborated" not in failures,
            "failures": failures}


def audit_unknown_discoveries(summary, observations):
    """Rebuild persistent unfed ambiguous red detections from every raw frame.

    This version has no general resolution rule. Empty later views, a DELIVERED
    candidate label, or a changed summary cannot retire an original conflict.
    """
    failures, expected = [], []
    def same_ledger(ledger):
        if not isinstance(ledger, dict) or ledger.get("schema") != "brain-discovery-evidence/v1":
            return False
        rows=ledger.get("unresolved")
        if not isinstance(rows,list) or len(rows)!=len(expected) or any(not isinstance(row,dict) for row in rows):
            return False
        actual=unique_index(rows,lambda r:(str(r.get("frame_id")),r.get("detection_index")),failures,"discovery_key")
        return all((row["frame_id"],row["detection_index"]) in actual and all(
            actual[(row["frame_id"],row["detection_index"])].get(k)==v for k,v in row.items() if k!="id") for row in expected)
    for observation in observations:
        raw=observation.get("observation",{})
        converted=observation.get("perception",{}).get("detections",[])
        for index,det in enumerate(raw.get("detections",[])):
            if det.get("category")!="red-ball":
                continue
            if index>=len(converted) or box_key(converted[index])!=box_key(det):
                failures.append("discovery_raw_red_detection_not_corroborated")
                continue
            item=converted[index]
            ambiguity=item.get("identity_ambiguity")
            if not (isinstance(ambiguity,dict) and ambiguity and (item.get("fed_to_world_model") is False or item.get("track_id") is None)):
                continue
            expected.append({"id":"untracked-red-discovery-"+str(len(expected)+1),"category":"red-ball",
                "frame_id":str(raw.get("frameId")),"detection_index":index,
                "observation_index":observation.get("observation_index"),"tick":raw.get("tick"),
                "round":observation.get("round"),"simulation_time_s":observation.get("simulation_seconds"),
                "bbox":det.get("bbox"),"candidate_ids":ambiguity.get("candidate_ids",[]),
                "identity_ambiguity":ambiguity,"reason":ambiguity.get("reason"),"admission_reason":item.get("reason")})
        if not same_ledger(observation.get("discovery_evidence")):
            failures.append("discovery_observation_ledger_mismatch")
    if not same_ledger(summary.get("discovery_evidence")):
        failures.append("discovery_final_ledger_mismatch")
    if expected:
        failures.append("discovery_historical_ambiguities_unresolved")
    return {"scope":"all_raw_frames_and_conversion_unfed_red_conflicts_no_automatic_resolution",
            "evidence":{"schema":"brain-discovery-evidence/v1","unresolved":expected},
            "failures":list(dict.fromkeys(failures))}


def strict_transcript_replay(directory):
    """Reuse the strict tool, in temporary outputs; original evidence is read only."""
    from tools.replay_brain_llm import main
    try:
        with tempfile.TemporaryDirectory(prefix="wm-evaluation-replay-") as temporary:
            output = Path(temporary) / "replay"
            with redirect_stdout(io.StringIO()):
                code = main(["--input", str(directory), "--out", str(output)])
            result = json.loads((output / "replay-checks.json").read_text())
            keys = ("allPass", "recorded_rounds", "replayed_rounds", "recorded_calls", "replayed_calls",
                    "all_records_consumed", "full_records_equal_except_mode", "mismatched_record_indexes",
                    "replay_error", "network_calls", "environment_access_attempts", "source_evidence_unchanged",
                    "source_sha256")
            return {**{key: result[key] for key in keys},
                    "failures": [] if code == 0 and result["allPass"] else ["strict_model_transcript_replay_failed"]}
    except Exception as exc:
        return {"allPass": False, "error_type": type(exc).__name__, "failures": ["strict_model_transcript_replay_failed"]}
