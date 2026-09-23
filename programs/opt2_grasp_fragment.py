"""Bounded in-place recovery AFTER an empty first grab, before the next forward step.

Embedded top-level functions use existing runtime globals/wrappers. No observe,
approach, translation, truth or layout access. The caller keeps its original
first grab, 6cm advance/42cm cap and success metric. See GRASP_DESIGN.md.
"""
import math

# Public interaction defaults in competition-core.js; 8 world units = 1 metre.
OPT2_GRASP_MIN_FORWARD_CM = 4.75
OPT2_GRASP_MAX_FORWARD_CM = 16.875
OPT2_GRASP_MAX_SIDE_CM = 4.75
_OPT2_GRASP_NUMERIC_EPS = 1e-9  # Arithmetic comparison only; no fitted tolerance.


def opt2_grasp_shortest_turn(current_deg, target_deg):
    delta = (target_deg - current_deg + 180.0) % 360.0 - 180.0
    return 180.0 if delta == -180.0 else delta


def opt2_grasp_scan_offsets():
    """Four extra headings; spacing derived solely from the public rectangle."""
    step = 2.0 * math.degrees(math.atan2(OPT2_GRASP_MAX_SIDE_CM,
                                      OPT2_GRASP_MAX_FORWARD_CM))
    return [step, 2.0 * step, -step, -2.0 * step]


def opt2_grasp_components(x_m, z_m, odometry):
    """Return predicted forward/right cm under public left-positive heading."""
    angle = math.radians(float(odometry["headingDeg"]))
    dx = 100.0 * x_m - float(odometry["rightCm"])
    dz = 100.0 * z_m - float(odometry["forwardCm"])
    return (dz * math.cos(angle) - dx * math.sin(angle),
            dx * math.cos(angle) + dz * math.sin(angle))


def opt2_grasp_scan_decision(x_m, z_m, odometry, step_cm, advance_available):
    """Decide from WM geometry only; this is not a bound on true WM error.

    Rotation preserves radius. Outside the public rectangle's corner radius,
    no heading reaches the predicted point. Keep the original forward lattice
    only when its next predicted pose stays ahead of the minimum grasp plane
    and within the lateral window. No remaining step means no scan is skipped.
    """
    forward, side = opt2_grasp_components(x_m, z_m, odometry)
    radius = math.hypot(forward, side)
    corner_radius = math.hypot(OPT2_GRASP_MAX_FORWARD_CM, OPT2_GRASP_MAX_SIDE_CM)
    next_forward = forward - float(step_cm)
    conditions = {"advance_available": bool(advance_available),
                  "outside_predicted_rotation_reach": radius > corner_radius,
                  "next_predicted_forward_at_least_min": next_forward >= OPT2_GRASP_MIN_FORWARD_CM,
                  "predicted_side_within_window": abs(side) <= OPT2_GRASP_MAX_SIDE_CM}
    return {"skip_scan": all(conditions.values()), "conditions": conditions,
            "wm_forward_cm": forward, "wm_right_cm": side, "wm_radius_cm": radius,
            "public_corner_radius_cm": corner_radius, "original_step_cm": float(step_cm),
            "next_predicted_forward_cm": next_forward,
            "public_min_forward_cm": OPT2_GRASP_MIN_FORWARD_CM,
            "public_max_side_cm": OPT2_GRASP_MAX_SIDE_CM,
            "basis": "estimated_WM_geometry_not_true_distance_bound"}


def _opt2_grasp_check(locked_track_id, anchor, odometry, road_state):
    if not road_state.get("onRoad"):
        return "off_road"
    for field in ("rightCm", "forwardCm", "headingDeg"):
        if not isinstance(odometry.get(field), (int, float)) or not math.isfinite(odometry[field]):
            return "odometry_unavailable"
    if (abs(odometry["rightCm"] - anchor["rightCm"]) > _OPT2_GRASP_NUMERIC_EPS
            or abs(odometry["forwardCm"] - anchor["forwardCm"]) > _OPT2_GRASP_NUMERIC_EPS):
        return "unexpected_translation_during_in_place_scan"
    target = _wm_target()
    if (target is None or target.obj_id != locked_track_id
            or STATE.get("confirmation_track_id") != locked_track_id):
        return "confirmed_track_changed"
    if getattr(target.state, "value", target.state) != "confirmed":
        return "target_not_confirmed"
    if not math.isfinite(target.x) or not math.isfinite(target.z):
        return "target_position_unavailable"
    return None


def _opt2_grasp_competitors(locked_track_id, odometry):
    """Block an actual-heading grab if another known ball could be grasped.

This protects against known WM ambiguity. holding() gives only a class: exact
package identity, unseen objects and WM error still require separate driver audit.
"""
    conflicts = []
    for obj in wm.get_scene():
        if (obj.obj_id == locked_track_id or getattr(obj.state, "value", obj.state) == "lost"
                or obj.name not in ("target", "distractor", "目标物", "干扰物")):
            continue
        if not math.isfinite(obj.x) or not math.isfinite(obj.z):
            conflicts.append({"track_id": obj.obj_id, "reason": "other_ball_position_unknown"})
            continue
        forward, side = opt2_grasp_components(obj.x, obj.z, odometry)
        if (OPT2_GRASP_MIN_FORWARD_CM - _OPT2_GRASP_NUMERIC_EPS <= forward
                <= OPT2_GRASP_MAX_FORWARD_CM + _OPT2_GRASP_NUMERIC_EPS
                and abs(side) <= OPT2_GRASP_MAX_SIDE_CM + _OPT2_GRASP_NUMERIC_EPS):
            conflicts.append({"track_id": obj.obj_id, "name": obj.name,
                              "forward_cm": forward, "right_cm": side,
                              "reason": "other_known_ball_in_grab_window"})
    return conflicts


def _opt2_grasp_turn(heading, odometry, road_state, locked_track_id, anchor):
    turn = opt2_grasp_shortest_turn(odometry["headingDeg"], heading)
    if abs(turn) > _OPT2_GRASP_NUMERIC_EPS:
        if turn > 0:
            motion_left_angle(turn)
        else:
            motion_right_angle(-turn)
        odometry, road_state = nav_odometry(), nav_road_state()
    reason = _opt2_grasp_check(locked_track_id, anchor, odometry, road_state)
    error = opt2_grasp_shortest_turn(odometry.get("headingDeg", heading), heading)
    if reason is None and abs(error) > GRAB_AIM_TOL_DEG:
        reason = "turn_did_not_reach_existing_aim_tolerance"
    return odometry, road_state, reason, error


def _opt2_grasp_recover_after_miss(locked_track_id, odometry, road_state, previous_holding,
                                   advance_available=True):
    """Scan only after the caller's original grab returned None.

Return holding, actual extra grab count, latest public snapshots and an explicit
safe_to_advance flag. On capture the caller runs its UNCHANGED success metric;
on restored empty failure it may run its UNCHANGED bounded forward step.
No runtime result asserts a true package ID from the class-only holding API.
"""
    result = {"status": "not_run", "reason": None, "holding": previous_holding,
              "locked_track_id": locked_track_id, "extra_grab_attempts": 0,
              "safe_to_advance": False, "heading_restored": False,
              "observe_calls": 0, "approach_calls": 0,
              "identity_evidence": "confirmed_track_lock_and_holding_class_only",
              "odometry": odometry, "road_state": road_state, "trials": []}
    if previous_holding is not None:
        result["reason"] = "requires_failed_empty_grab"
        return result
    anchor = dict(odometry)
    reason = _opt2_grasp_check(locked_track_id, anchor, odometry, road_state)
    if reason is not None:
        result["reason"] = reason
        return result
    base_heading = float(odometry["headingDeg"])
    target = _wm_target()
    decision = opt2_grasp_scan_decision(target.x, target.z, odometry,
                                        GRAB_STEP_CM, advance_available)
    result["scan_decision"] = decision
    _approach_event("grab_lateral_recovery_decision", track_id=locked_track_id,
                    tick=odometry.get("tick"), **decision)
    if decision["skip_scan"]:
        result.update({"status": "empty_geometry_advance", "safe_to_advance": True,
                       "heading_restored": True})
        return result
    wm_side = decision["wm_right_cm"]
    preferred_sign = -1.0 if wm_side > 0 else 1.0
    offsets = [preferred_sign * angle for angle in opt2_grasp_scan_offsets()]
    _approach_event("grab_lateral_recovery_start", track_id=locked_track_id,
                    tick=odometry.get("tick"), base_heading_deg=base_heading,
                    offsets_deg=offsets, first_grab_holding=previous_holding,
                    public_window_cm=[OPT2_GRASP_MIN_FORWARD_CM,
                                      OPT2_GRASP_MAX_FORWARD_CM, OPT2_GRASP_MAX_SIDE_CM])
    for offset in offsets:
        odometry, road_state, reason, turn_error = _opt2_grasp_turn(
            base_heading + offset, odometry, road_state, locked_track_id, anchor)
        result.update({"odometry": odometry, "road_state": road_state})
        if reason is not None:
            result.update({"status": "failed", "reason": reason})
            _approach_event("grab_lateral_recovery_failed", reason=reason,
                            track_id=locked_track_id, tick=odometry.get("tick"))
            return result
        conflicts = _opt2_grasp_competitors(locked_track_id, odometry)
        trial = {"requested_offset_deg": offset, "actual_offset_deg": opt2_grasp_shortest_turn(
                 base_heading, odometry["headingDeg"]), "turn_error_deg": turn_error,
                 "tick_before_grab": odometry.get("tick"), "competitors": conflicts}
        if conflicts:
            trial["skipped"] = "known_other_ball_may_be_grabbed"
        else:
            motion_grab()
            holding = robot.holding()
            odometry, road_state = nav_odometry(), nav_road_state()
            result["extra_grab_attempts"] += 1
            result.update({"holding": holding, "odometry": odometry, "road_state": road_state})
            trial.update({"holding": holding, "tick_after_grab": odometry.get("tick")})
            reason = _opt2_grasp_check(locked_track_id, anchor, odometry, road_state)
            if reason is not None:
                result.update({"status": "failed", "reason": reason})
            elif holding == "目标物":
                result.update({"status": "holding_target", "reason": None})
            elif holding is not None:
                result.update({"status": "failed", "reason": "holding_wrong_class"})
        result["trials"].append(trial)
        _approach_event("grab_lateral_recovery_step", track_id=locked_track_id,
                        extra_grab_attempt=result["extra_grab_attempts"], onRoad=road_state.get("onRoad"),
                        pose_cm=[odometry.get("rightCm"), odometry.get("forwardCm"), odometry.get("headingDeg")],
                        **trial)
        if result["status"] in ("failed", "holding_target"):
            return result
    odometry, road_state, reason, turn_error = _opt2_grasp_turn(
        base_heading, odometry, road_state, locked_track_id, anchor)
    result.update({"odometry": odometry, "road_state": road_state,
                   "heading_restored": reason is None, "safe_to_advance": reason is None,
                   "status": "empty_restored" if reason is None else "failed", "reason": reason})
    _approach_event("grab_lateral_recovery_end", track_id=locked_track_id,
                    tick=odometry.get("tick"), extra_grab_attempts=result["extra_grab_attempts"],
                    safe_to_advance=result["safe_to_advance"], turn_error_deg=turn_error, reason=reason)
    return result


def _opt2_grasp_success_metric(odometry, road_state, attempts, advanced_cm):
    forward_cm = STATE["forward_after_last_observe_cm"]
    passed = forward_cm >= MEMORY_FORWARD_MIN_CM and bool(road_state.get("onRoad"))
    _approach_event("memory_navigation_metric", passed=bool(passed),
                    last_observe_distance_m=round(STATE["last_observe_distance_m"] or 0.0, 3),
                    last_observe_camera_distance_cm=STATE["last_observe_camera_distance_cm"],
                    forward_after_last_observe_cm=round(forward_cm, 1),
                    required_forward_cm=MEMORY_FORWARD_MIN_CM,
                    approach_calls=STATE["approach_calls"], grab_attempts=attempts,
                    grab_advanced_cm=round(advanced_cm, 1), observe_count=STATE["observe_count"],
                    onRoad=road_state.get("onRoad"), tick=odometry.get("tick"))
    return bool(passed)


def _opt2_grab_loop():
    """Drop-in replacement for the final grab-only loop, after unchanged approach.

No new approach/observe and no target switching. Empty scans restore the original
station heading before the old bounded forward step; a capture immediately exits.
"""
    locked_id = STATE.get("confirmation_track_id")
    odometry, road_state = nav_odometry(), nav_road_state()
    reason = _opt2_grasp_check(locked_id, odometry, odometry, road_state)
    if reason is not None:
        _approach_event("grab_loop_failed", reason=reason, track_id=locked_id)
        return False
    before_holding = robot.holding()
    if before_holding is not None:
        _approach_event("grab_loop_failed", reason="unexpected_preexisting_holding", holding=before_holding)
        return False
    advanced_cm, attempts = 0.0, 0
    station_count = int(GRAB_MAX_ADVANCE_CM // GRAB_STEP_CM) + 1
    for station in range(1, station_count + 1):
        reason = _opt2_grasp_check(locked_id, odometry, odometry, road_state)
        conflicts = _opt2_grasp_competitors(locked_id, odometry)
        if reason is not None or conflicts:
            _approach_event("grab_loop_failed", reason=reason or "known_other_ball_may_be_grabbed",
                            competitors=conflicts, track_id=locked_id)
            return False
        anchor = dict(odometry)
        # The original first action at every station remains an unturned grab.
        motion_grab()
        holding = robot.holding()
        odometry, road_state = nav_odometry(), nav_road_state()
        attempts += 1
        target = _wm_target()
        distance = (math.hypot(target.x - odometry["rightCm"] / 100.0,
                               target.z - odometry["forwardCm"] / 100.0) if target else None)
        _approach_event("grab_step", step=station, grab_attempt=attempts,
                        advanced_cm=round(advanced_cm, 1), holding=holding,
                        tick=odometry.get("tick"), wm_distance_m=distance,
                        onRoad=road_state.get("onRoad"),
                        pose=[odometry["rightCm"] / 100.0, odometry["forwardCm"] / 100.0,
                              odometry["headingDeg"]])
        reason = _opt2_grasp_check(locked_id, anchor, odometry, road_state)
        if reason is not None or holding not in (None, "目标物"):
            _approach_event("grab_loop_failed", reason=reason or "holding_wrong_object", holding=holding)
            return False
        if holding == "目标物":
            return _opt2_grasp_success_metric(odometry, road_state, attempts, advanced_cm)
        recovery = _opt2_grasp_recover_after_miss(locked_id, odometry, road_state, holding,
                                                  station < station_count)
        attempts += recovery["extra_grab_attempts"]
        odometry, road_state = recovery["odometry"], recovery["road_state"]
        if recovery["status"] == "holding_target":
            return _opt2_grasp_success_metric(odometry, road_state, attempts, advanced_cm)
        if not recovery["safe_to_advance"]:
            _approach_event("grab_loop_failed", reason=recovery["reason"] or "lateral_recovery_unsafe",
                            grabs=attempts, advanced_cm=advanced_cm)
            return False
        if station == station_count:
            break
        before_distance = float(odometry.get("distanceCm") or 0.0)
        motion_forward(GRAB_STEP_CM)
        odometry, road_state = nav_odometry(), nav_road_state()
        moved = max(0.0, float(odometry.get("distanceCm") or 0.0) - before_distance)
        advanced_cm += moved
        STATE["forward_after_last_observe_cm"] += moved
        if not road_state.get("onRoad"):
            _approach_event("grab_loop_failed", reason="off_road", step=station,
                            advanced_cm=advanced_cm, lateralOffsetCm=road_state.get("lateralOffsetCm"))
            return False
        if moved < GRAB_STEP_CM * 0.5:
            _approach_event("grab_step_blocked", step=station, movedCm=moved, advanced_cm=advanced_cm)
    _approach_event("grab_loop_failed", reason="max_advance_reached", grabs=attempts,
                    advanced_cm=advanced_cm, max_advance_cm=GRAB_MAX_ADVANCE_CM,
                    approach_calls=STATE["approach_calls"])
    return False
