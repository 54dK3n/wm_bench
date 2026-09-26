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

from autonomous_brain.actions import ball_inside_region, reacquisition_chains
from autonomous_brain.llm import LLMClient, _strict_loads, validate_action
from world_model.calibration import CameraCalibration
from world_model.providers.guangyang import odometry_to_pose


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


def original_absence_verified(basis, grab, observed, bridge):
    """Reproject the original confirmed position into the fresh raw camera."""
    try:
        cameras=[c["terminal"]["result"] for c in bridge if c.get("request",{}).get("method")=="camera_parameters"
                 and (c.get("terminal") or {}).get("status")=="completed"]
        if not cameras or any(c!=cameras[0] for c in cameras):
            return False
        camera=cameras[0];mount=camera["mount"]
        cal=CameraCalibration(image_width=camera["width"],image_height=camera["height"],fx=camera["fx"],fy=camera["fy"],
            cx=camera["cx"],cy=camera["cy"],camera_height_m=mount["upCm"]/100,
            camera_x_m=mount["rightCm"]/100,camera_z_m=mount["forwardCm"]/100,
            pitch_rad=-math.radians(mount["pitchDeg"]),min_ground_range_m=0.,max_ground_range_m=20.)
        original=grab["original_position_m"]
        x,z=odometry_to_pose(observed["odometry"]).to_local(original["x"],original["z"])
        if not .15<=math.hypot(x,z)<=.9 or z<=0:
            return False
        u,v=cal.ground_point_to_pixel(x,z)
        size=.055*camera["fy"]/z
        projected={"x":u-size/2,"y":v-size,"w":size,"h":size}
        view=basis.get("original_position_observation",{})
        if (view.get("frame_id")!=frame(observed) or view.get("original_position_m")!=original
                or view.get("category")!=grab.get("category") or view.get("valid") is not True
                or view.get("matches")!=[] or view.get("occluders")!=[]
                or any(not number(view.get("projected_bbox",{}).get(k)) or abs(view["projected_bbox"][k]-v)>1e-8 for k,v in projected.items())
                or projected["x"]<=0 or projected["y"]<=0 or projected["x"]+size>=camera["width"] or projected["y"]+size>=camera["height"]):
            return False
        for raw in observed["observation"]["detections"]:
            if raw.get("category")=="storage-zone":
                continue
            b=raw["bbox"]
            if b["x"]<projected["x"]+size and b["x"]+b["w"]>projected["x"] and b["y"]<projected["y"]+size and b["y"]+b["h"]>projected["y"]:
                return False
        return True
    except (KeyError,TypeError,ValueError,ZeroDivisionError,OverflowError):
        return False


def audit_observed_ledger(summary, observations, rounds, bridge, motions):
    failures, deliveries, picks = [], [], []
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
        terminal = call.get("terminal") or {}
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
            and (row.get("terminal") or {}).get("status") == "completed"
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

    def continuous_holding(first,last):
        return (type(first) is int and type(last) is int and first<=last
            and all(i in by_index and by_index[i].get("holding",{}).get("holding") is True for i in range(first,last+1)))

    def grasp_chain_verified(chain,basis,oid,index):
        try:
            grab,confirmation=chain["grab"],chain["confirmation"]
            before,after=grab["before_observation"],grab["after_observation"]
            if (chain.get("schema")!="brain-grasp-chain/v1" or chain.get("object_id")!=oid or grab.get("object_id")!=oid
                    or type(before) is not int or type(after) is not int or not before<after<=index
                    or confirmation.get("observation_index")!=index or confirmation.get("frame_id")!=frame(by_index[index])
                    or confirmation.get("tick")!=by_index[index]["observation"]["tick"]
                    or by_index[before].get("holding",{}).get("holding") is not False
                    or not continuous_holding(after,index)):
                return False
            expected=[{"observation_index":i,"frame_id":frame(by_index[i]),"tick":by_index[i]["observation"]["tick"],
                       "holding":True} for i in range(after,index+1)]
            if chain.get("holding_observations")!=expected:
                return False
            original=[o for o in by_index[before].get("objects",[]) if o.get("id")==oid]
            if (len(original)!=1 or original[0].get("state")!="CONFIRMED" or original[0].get("identity_ambiguity")
                    or original[0].get("category")!=grab.get("category") or original[0].get("position_m")!=grab.get("original_position_m")):
                return False
            moves=[m for m in (motions or []) if m.get("method")=="grab" and m.get("before_observation")==before and m.get("after_observation")==after]
            if len(moves)!=1 or moves[0].get("round")!=grab.get("round"):
                return False
            command=[(i,c) for i,c in enumerate(bridge) if c.get("request",{}).get("requestId")==grab.get("bridge_request_id")]
            if len(command)!=1:
                return False
            ci,command=command[0]
            if (grab.get("bridge_sequence")!=ci+1 or command["request"].get("method")!="grab"
                    or command["request"].get("params")!=moves[0].get("params")
                    or not bridge_frames[frame(by_index[before])]["bridge_index"]<ci<bridge_frames[frame(by_index[after])]["bridge_index"]):
                return False
            if bool(grab.get("outcome_unknown"))!=bool(moves[0].get("outcome_unknown")):
                return False
            known=(command.get("terminal") or {}).get("status")=="completed" and command["terminal"].get("result")==moves[0].get("actuator_result")
            reconciled=(moves[0].get("outcome_unknown") is True and moves[0].get("recovery_observation")==after
                and (command.get("submission") or {}).get("status") in (200,202))
            if not (known or reconciled):
                return False
            grab_round=[r for r in rounds if r.get("round")==grab.get("round")]
            confirm_round=[r for r in rounds if r.get("round")==confirmation.get("round")]
            if len(grab_round)!=1 or len(confirm_round)!=1:
                return False
            g,c=grab_round[0],confirm_round[0];gb=g.get("result",{}).get("evidence",{});cb=c.get("result",{}).get("evidence",{})
            if (g.get("action")!={"action":"pick","params":{"object_id":oid}}
                    or not gb.get("before_observation",math.inf)<=before<after<=gb.get("final_observation",gb.get("after_observation",-1))
                    or c.get("action",{}).get("action")!=confirmation.get("action") or confirmation.get("action") not in {"pick","place"}
                    or cb.get("before_observation")!=confirmation.get("before_observation")
                    or not cb.get("before_observation",math.inf)<=index<=cb.get("final_observation",cb.get("after_observation",-1))
                    or cb.get("grasp_confirmation")!=chain):
                return False
            if confirmation["action"]=="place" and (basis.get("recovered_pending_grasp") is not True or g["round"]>=c["round"]):
                return False
            left=ci+1;right=bridge_frames[frame(by_index[index])]["bridge_index"]
            if any(row.get("request",{}).get("method") in {"grab","release"} for row in bridge[left:right]):
                return False
            return original_absence_verified(basis,grab,by_index[index],bridge)
        except (KeyError,TypeError,ValueError,AttributeError):
            return False

    seen_ids, seen_witnesses, successful_picks, claimed_grabs, pick_commands = set(), set(), {}, set(), {}
    events = summary.get("action_evidence", [])
    for event_index, event in enumerate(events):
        action, oid, basis = event.get("action"), event.get("object_id"), event.get("evidence") or {}
        if action == "pick":
            index = basis.get("post_observation", basis.get("after_observation"))
            observed = by_index.get(index, {})
            chain=basis.get("grasp_chain")
            if chain is not None:
                valid=isinstance(chain,dict) and type(index) is int and grasp_chain_verified(chain,basis,oid,index)
                command=chain.get("grab",{}).get("bridge_request_id") if isinstance(chain,dict) else None
                accepted=valid and command not in claimed_grabs
                if not accepted:
                    failures.append("pick_command_identity_confirmation_chain_invalid")
                else:
                    successful_picks[oid]=index
                    claimed_grabs.add(command)
                    pick_commands[oid]=command
                picks.append({"object_id":oid,"event_index":event_index,"verified":bool(accepted),
                    "confirmation_observation_index":index,"grab":chain.get("grab") if isinstance(chain,dict) else None,
                    "confirmation":chain.get("confirmation") if isinstance(chain,dict) else None})
                continue
            if summary.get("runtime_version") == "autonomous-brain-runtime/v15":
                failures.append("pick_command_identity_confirmation_chain_missing")
                continue
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
            picks.append({"object_id":oid,"event_index":event_index,"verified":valid,
                          "confirmation_observation_index":index,"legacy_same_action":True})
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
            if oid in successful_picks and not continuous_holding(successful_picks[oid],before.get("observation_index")):
                row_failures.append("delivery_holding_chain_interrupted_before_release")
            if oid in pick_commands:
                first=bridge_frames.get(frame(by_index[successful_picks[oid]]),{}).get("bridge_index")
                last=bridge_frames.get(frame(before),{}).get("bridge_index")
                if (type(first) is not int or type(last) is not int or any(
                    c.get("request",{}).get("method") in {"grab","release"} for c in bridge[first+1:last])):
                    row_failures.append("delivery_intervening_gripper_command")
            reference=release.get("command_ref")
            if reference is not None or summary.get("runtime_version")=="autonomous-brain-runtime/v15":
                commands=[(i,c) for i,c in enumerate(bridge) if isinstance(reference,dict)
                    and c.get("request",{}).get("requestId")==reference.get("bridge_request_id")]
                m=release_motions[0]
                if (not isinstance(reference,dict) or len(commands)!=1
                        or reference.get("object_id")!=oid or reference.get("method")!="release"
                        or reference.get("grasp_request_id")!=pick_commands.get(oid)
                        or any(reference.get(k)!=m.get(k) for k in ("round","before_observation","after_observation"))
                        or commands[0][0]+1!=reference.get("bridge_sequence")
                        or commands[0][1].get("request",{}).get("method")!="release"
                        or (commands[0][1].get("terminal") or {}).get("result")!=m.get("actuator_result")):
                    row_failures.append("delivery_release_command_reference_invalid")
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
            "pick_confirmation_observation_index":successful_picks.get(oid),"release_command_ref":release.get("command_ref"),
            "geometric_candidates": len(pair_candidates), "action_round": windows[0].get("round") if len(windows) == 1 else None,
            "verified": not row_failures, "failures": row_failures})
        failures.extend(row_failures)
    return {"scope": "bridge_observation_action_and_delivery_evidence", "picks":picks, "deliveries": deliveries,
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


def discovery_pixel_compatible(camera, source, position):
    """Evaluator copy of the frozen pixel/quantization rule, not the resolver."""
    x,z=odometry_to_pose(source["odometry"]).to_local(position["x"],position["z"])
    x,z=x*100,z*100-5.1557
    if z<=0:
        return False
    bearing=math.atan2(x,z)
    predicted_center=camera["cx"]+camera["fx"]*math.tan(bearing)
    predicted_range=(math.hypot(x,z)-1.6239)*math.cos(bearing)/1.0187
    box=source["bbox"];center=box["x"]+box["w"]/2
    beta=math.atan2(center-camera["cx"],camera["fx"])
    def reading(w):
        return 5.5*camera["fy"]/(max(1.,w)*max(.35,math.cos(beta)))+camera["mount"]["forwardCm"]
    value=reading(box["w"])
    return (abs(predicted_center-center)<=1.5+camera["fx"]*math.tan(math.radians(.005))
        and abs(predicted_range-value)<=.5+max(abs(reading(box["w"]+delta)-value) for delta in (-1,1)))


def audit_discovery_lifecycle(summary, observations, bridge, motions):
    """Reconstruct every source and validate explicit resolution proof prefixes."""
    failures, records, valid_resolutions, proof_history, previous_resolutions, previous_revocations = [], [], {}, {}, {}, []
    active_windows=[]
    camera_rows=[c["terminal"]["result"] for c in bridge if c.get("request",{}).get("method")=="camera_parameters"
        and (c.get("terminal") or {}).get("status")=="completed"]
    if not camera_rows or any(row!=camera_rows[0] for row in camera_rows):
        return {"evidence":{"schema":"brain-discovery-evidence/v2","records":[],"resolutions":[],"unresolved":[{"id":"missing-camera-proof"}]},
                "failures":["discovery_original_camera_parameters_missing_or_conflicting"]}
    camera=camera_rows[0]
    by_frame={frame(o):o for o in observations}
    events=summary.get("action_evidence",[])
    # Command intent is a boundary even when its response or motion-log row is
    # absent. Rebuild it directly from the original bridge order, so deleting
    # the brain's boundary ledger cannot restore a static-scene assumption.
    bridge_frames={i:by_frame.get(str((call.get("terminal") or {}).get("result",{}).get("frameId")),{})
        for i,call in enumerate(bridge) if call.get("request",{}).get("method")=="observe"
        and (call.get("terminal") or {}).get("status")=="completed"}
    bridge_windows=[]
    for index,call in enumerate(bridge):
        method=call.get("request",{}).get("method")
        if method not in {"grab","release"}:continue
        before=[o.get("observation_index") for i,o in bridge_frames.items() if i<index]
        after=[o.get("observation_index") for i,o in bridge_frames.items() if i>index]
        bridge_windows.append({"method":method,"before_observation":before[-1] if before else None,
            "after_observation":after[0] if after and (call.get("terminal") or {}).get("status")=="completed" else None})

    def canonicalizer(objects, timestamp, independently_verified=None):
        aliases={}
        for event in events:
            alias=event.get("delivery_alias")
            if isinstance(alias,dict) and event.get("simulation_time_s",math.inf)<=timestamp:
                aliases[alias.get("witness_id")]=event.get("object_id")
        for oid,binding in reacquisition_chains(objects).items():
            aliases[oid]=binding["terminal"]["id"]
        verified=independently_verified or {}
        for obj in objects:
            if obj.get("state")!="LOST" or obj.get("ever_confirmed") is not False:
                continue
            sources=[r for r in records if r.get("initial_object_id")==obj.get("id") and r["simulation_time_s"]<=timestamp]
            proofs=[verified.get(r["id"]) for r in sources]
            if sources and all(p is not None and p.get("resolved_simulation_time_s",math.inf)<=timestamp for p in proofs):
                targets={p.get("canonical_object_id") for p in proofs}
                if len(targets)==1:aliases[obj["id"]]=next(iter(targets))
        def root(oid):
            seen=set()
            while oid in aliases and oid not in seen:
                seen.add(oid);oid=aliases[oid]
            return oid
        return root

    def moved(oid,source,support,root):
        # Event timing is corroborated by the separate complete action audit.
        for event in events:
            if event.get("action") not in {"pick","place","release_unverified","release_recovery"}:
                continue
            evidence=event.get("evidence") or {}
            release=evidence.get("release_observation") or {}
            event_index=(evidence.get("grasp_chain") or {}).get("grab",{}).get("after_observation")
            if event_index is None:event_index=(release.get("command_ref") or {}).get("after_observation")
            fid=release.get("frame_id") or evidence.get("frame_id")
            if event_index is None:event_index=by_frame.get(str(fid),{}).get("observation_index")
            time=release.get("simulation_time_s",event.get("simulation_time_s"))
            if (source["observation_index"]<event_index<=support["observation_index"] if type(event_index) is int
                    else not number(time) or source["simulation_time_s"]<=time<=support["simulation_time_s"]):
                return True
        # A real grab before delayed identity confirmation is also a boundary.
        for motion in list(motions)+active_windows+bridge_windows:
            if motion.get("method") not in {"grab","release"}:
                continue
            after=motion.get("after_observation")
            before=motion.get("before_observation")
            if (source["observation_index"]<after<=support["observation_index"] if type(after) is int
                    else before is None or support["observation_index"]>before):
                return True
        return False

    def validate_ledger(ledger, observed, final=False):
        nonlocal valid_resolutions, previous_resolutions, previous_revocations, active_windows
        valid_resolutions={}
        if not isinstance(ledger,dict) or ledger.get("schema")!="brain-discovery-evidence/v2":
            failures.append("discovery_v2_ledger_missing");return []
        claimed=ledger.get("records")
        if not isinstance(claimed,list) or len(claimed)!=len(records):
            failures.append("discovery_v2_original_records_missing");return records
        indexed={}
        for raw,claimed_row in zip(records,claimed):
            if not isinstance(claimed_row,dict) or any(claimed_row.get(k)!=v for k,v in raw.items()):
                failures.append("discovery_v2_original_record_mismatch");continue
            indexed[claimed_row["id"]]=claimed_row
        objects=observed.get("objects",[]) if not final else summary.get("final_objects",[])
        root=canonicalizer(objects,observed.get("simulation_seconds",math.inf))
        object_by_id={root(o["id"]):o for o in objects}
        def pending(r):
            o=object_by_id.get(root(r.get("initial_object_id")))
            return o is None or o.get("state")=="LOST" and o.get("ever_confirmed") is False
        # Hypothesis association is only bookkeeping; it cannot discharge any
        # source. Still require its full same-frame competition matrix.
        for association in ledger.get("associations",[]):
            a=indexed.get(association.get("from_discovery_id"));b=indexed.get(association.get("to_discovery_id"))
            matrix=association.get("candidate_matrix",{})
            if (not a or not b or a["frame_id"]==b["frame_id"] or association.get("rule")!="mutually_unique_original_pixel_views/v1"
                    or b.get("hypothesis_id")!=association.get("hypothesis_id")
                    or matrix.get(b["id"])!=[association.get("hypothesis_id")]
                    or sum(association.get("hypothesis_id") in values for values in matrix.values())!=1
                    or not discovery_pixel_compatible(camera,a,b["position_m"])
                    or not discovery_pixel_compatible(camera,b,a["position_m"])):
                failures.append("discovery_hypothesis_association_invalid")
        resolutions=ledger.get("resolutions",[])
        active_windows=ledger.get("motion_boundaries",[])
        if not isinstance(active_windows,list) or any(not isinstance(w,dict) or w.get("method") not in {"grab","release"}
                or type(w.get("before_observation")) is not int or w["before_observation"]<1
                or w.get("after_observation") is not None and w["after_observation"]!=w["before_observation"]+1
                for w in active_windows):
            failures.append("discovery_manipulation_windows_invalid");active_windows=[]
        revocations=ledger.get("resolution_revocations",[])
        if not isinstance(revocations,list) or revocations[:len(previous_revocations)]!=previous_revocations:
            failures.append("discovery_revocation_history_missing");revocations=[]
        revoked={}
        for row in revocations:
            old=row.get("resolution",{});sid=old.get("discovery_id")
            source=indexed.get(sid);supports=[indexed.get(ref) for ref in old.get("support_refs",[])]
            if (row.get("reason")!="newly_observed_manipulation_boundary" or not row.get("motion_boundaries")
                    or proof_history.get(canonical(old))!=old or not source or not supports or not all(supports)
                    or not any(moved(old.get("canonical_object_id"),source,support,root) for support in supports)):
                failures.append("discovery_resolution_revocation_not_verified")
            else:revoked[sid]=old
        current={r.get("discovery_id"):r for r in resolutions}
        for sid,old in previous_resolutions.items():
            if current.get(sid)!=old and revoked.get(sid)!=old:
                failures.append("discovery_resolution_history_deleted")
        ids=[r.get("discovery_id") for r in resolutions]
        if len(ids)!=len(set(ids)):
            failures.append("discovery_resolution_duplicate")
        for resolution in resolutions:
            source=indexed.get(resolution.get("discovery_id"))
            key=canonical(resolution)
            proof_history[key]=resolution
            valid=bool(source) and resolution.get("rule")=="independent_views_original_pixels_unique_identity/v1"
            oid=resolution.get("canonical_object_id")
            resolved_observation=by_frame.get(str(resolution.get("resolved_frame_id")),{})
            resolved_index=resolved_observation.get("observation_index",-1)
            root=canonicalizer(resolved_observation.get("objects",[]),resolved_observation.get("simulation_seconds",-1),valid_resolutions)
            prefix=[r for r in records if r["observation_index"]<=resolved_index]
            same_frame=[r for r in prefix if source and r["frame_id"]==source["frame_id"]]
            matrix={r["id"]:[] for r in same_frame}
            identities={root(r.get("initial_object_id")) for r in prefix if r.get("initial_object_id") is not None}
            for r in same_frame:
                for candidate in sorted(identities):
                    later=[v for v in prefix if root(v.get("initial_object_id"))==candidate
                        and v["observation_index"]>r["observation_index"] and v["simulation_time_s"]>=r["simulation_time_s"]
                        and discovery_pixel_compatible(camera,r,v["position_m"]) and not moved(candidate,r,v,root)]
                    if later: matrix[r["id"]].append(candidate)
            supports=[indexed.get(ref) for ref in resolution.get("support_refs",[])]
            target=next((o for o in resolved_observation.get("objects",[]) if o.get("id")==oid),None)
            valid=valid and (resolution.get("source_ref")==source["id"] and resolution.get("previous_object_id")==source.get("initial_object_id")
                and matrix==resolution.get("candidate_matrix") and matrix.get(source["id"])==[oid]
                and sum(oid in values for values in matrix.values())==1
                and len(supports)==2 and all(supports) and supports[0]["frame_id"]!=supports[1]["frame_id"]
                and target is not None and target.get("state") in {"CONFIRMED","HELD","DELIVERED"} and not target.get("identity_ambiguity")
                and resolution.get("resolved_simulation_time_s")==resolved_observation.get("simulation_seconds")
                and resolved_index<=observed.get("observation_index",-1))
            if valid:
                a,b=supports
                valid=(all(root(v.get("initial_object_id"))==oid and source["observation_index"]<v["observation_index"]<=resolved_index
                    and discovery_pixel_compatible(camera,source,v["position_m"]) and not moved(oid,source,v,root) for v in supports)
                    and math.hypot(a["odometry"]["rightCm"]-b["odometry"]["rightCm"],a["odometry"]["forwardCm"]-b["odometry"]["forwardCm"])>=15
                    and discovery_pixel_compatible(camera,a,b["position_m"]) and discovery_pixel_compatible(camera,b,a["position_m"])
                    and resolution.get("motion_boundaries")==[]
                    and resolution.get("opposing_refs")==[r["id"] for r in same_frame if r["id"]!=source["id"]])
            confirmation=resolution.get("confirmation_evidence",{})
            hits=confirmation.get("hit_poses",[])
            confirmed=[o.get("simulation_seconds") for o in observations if o.get("observation_index",math.inf)<=resolved_index
                and any(root(obj.get("id"))==oid and obj.get("state")=="CONFIRMED" for obj in o.get("objects",[]))]
            valid=valid and confirmation.get("required_hit_count")==3 and confirmation.get("min_hit_pose_gap_m")==.15 and len(hits)>=3
            valid=valid and bool(confirmed) and confirmation.get("confirmed_s")==min(confirmed)
            for j,hit in enumerate(hits):
                o=by_frame.get(str(hit.get("frame_id")),{})
                matched=[d for d in o.get("perception",{}).get("detections",[]) if d.get("category")=="red-ball"
                    and root(d.get("track_id"))==oid and d.get("fed_to_world_model") is True and not d.get("identity_ambiguity")]
                pose=o.get("odometry",{})
                valid=valid and (len(matched)==1 and hit.get("x_m")==pose.get("rightCm",math.nan)/100
                    and hit.get("z_m")==pose.get("forwardCm",math.nan)/100 and hit.get("heading_deg")==pose.get("headingDeg")
                    and hit.get("simulation_time_s")==o.get("simulation_seconds") and o.get("observation_index",math.inf)<=resolved_index
                    and all(math.hypot(hit["x_m"]-old["x_m"],hit["z_m"]-old["z_m"])>=.15 for old in hits[:j]))
            opposing=[]
            if valid:
                for rival in {root(x) for x in source["candidate_ids"]}-{oid}:
                    for support in supports:
                        found=[r for r in prefix if r["frame_id"]==support["frame_id"] and root(r.get("initial_object_id"))==rival
                            and not discovery_pixel_compatible(camera,source,r["position_m"])]
                        if len(found)!=1:valid=False
                        else:opposing.append(found[0]["id"])
                valid=valid and opposing==resolution.get("opposing_identity_refs")
            if valid:
                valid_resolutions[source["id"]]=resolution
            else:
                failures.append("discovery_resolution_not_independently_verified")
        root=canonicalizer(objects,observed.get("simulation_seconds",math.inf),valid_resolutions)
        object_by_id={root(o["id"]):o for o in objects}
        unresolved=[r for r in claimed if pending(r) and r["id"] not in valid_resolutions]
        if ledger.get("unresolved")!=unresolved:
            failures.append("discovery_v2_unresolved_obligations_mismatch")
        previous_resolutions=current
        previous_revocations=revocations
        return unresolved

    unresolved=[]
    for observation in observations:
        raw=observation.get("observation",{})
        converted=observation.get("perception",{}).get("detections",[])
        for index,detection in enumerate(raw.get("detections",[])):
            if detection.get("category")!="red-ball":continue
            if index>=len(converted) or box_key(converted[index])!=box_key(detection):
                failures.append("discovery_raw_red_detection_not_corroborated");continue
            item=converted[index];ambiguity=item.get("identity_ambiguity") or {}
            box=detection["bbox"];beta=math.atan2(box["x"]+box["w"]/2-camera["cx"],camera["fx"])
            reading=math.floor(min(100.,max(.625,5.5*camera["fy"]/max(1.,box["w"])/max(.35,math.cos(beta))+camera["mount"]["forwardCm"]))+.5)
            beta=math.radians(float(f"{math.degrees(beta):.2f}"))
            rho=1.6239+1.0187*reading/math.cos(beta)
            x,z=odometry_to_pose(observation["odometry"]).to_world(rho*math.sin(beta)/100,(5.1557+rho*math.cos(beta))/100)
            if any(not number(item.get("position_m",{}).get(k)) or abs(item["position_m"][k]-v)>1e-8 for k,v in (("x",x),("z",z))):
                failures.append("discovery_original_pixel_conversion_mismatch")
            records.append({"id":"red-discovery-"+str(len(records)+1),"category":"red-ball","frame_id":str(raw.get("frameId")),
                "observation_index":observation.get("observation_index"),"perception_observation_index":observation.get("observation_index"),
                "tick":raw.get("tick"),"round":observation.get("round"),"simulation_time_s":observation.get("simulation_seconds"),
                "detection_index":index,"bbox":box,"odometry":observation.get("odometry"),"position_m":item.get("position_m"),
                "initial_object_id":item.get("track_id") if not ambiguity else None,"observed_track_id":item.get("track_id"),
                "identity_ambiguity":ambiguity,"candidate_ids":ambiguity.get("candidate_ids",[]),
                "reason":ambiguity.get("reason") or ("associated_observed_identity" if item.get("track_id") else "unassociated_target_detection"),
                "admission_reason":item.get("reason")})
        unresolved=validate_ledger(observation.get("discovery_evidence"),observation)
    final=observations[-1] if observations else {}
    unresolved=validate_ledger(summary.get("discovery_evidence"),final,True)
    if unresolved:failures.append("discovery_historical_obligations_unresolved")
    return {"scope":"all_original_red_frames_independent_pixel_competition_and_resolution_prefixes",
        "evidence":{"schema":"brain-discovery-evidence/v2","records":records,"resolutions":list(valid_resolutions.values()),
                    "unresolved":unresolved},"failures":list(dict.fromkeys(failures))}


def audit_unknown_discoveries(summary, observations, bridge=None, motions=None):
    """Dispatch the frozen v1 history or the independently checked v2 lifecycle.

    A v2 source requires original-pixel competition and separated views; empty
    later frames or delivered labels alone never resolve an obligation.
    """
    if (summary.get("discovery_evidence") or {}).get("schema")=="brain-discovery-evidence/v2":
        try:
            return audit_discovery_lifecycle(summary,observations,bridge or [],motions or [])
        except (KeyError,TypeError,ValueError,AttributeError,IndexError,OverflowError):
            return {"evidence":{"schema":"brain-discovery-evidence/v2","unresolved":[{"id":"malformed-discovery-proof"}]},
                    "failures":["discovery_lifecycle_evidence_malformed"]}
    failures, expected = [], []
    if summary.get("runtime_version")=="autonomous-brain-runtime/v15":
        failures.append("discovery_v2_ledger_missing")
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
