def _planning_goal(pose, observations, previous=None):
    target = _wm_target()
    if target is not None:
        return {"x": target.x, "z": target.z, "source": "world_model", "track_id": target.obj_id}
    visible = [item for item in observations if _is_target(item) and item.get("distanceCm") is not None]
    if not visible:
        return previous
    item = min(visible, key=lambda value: float(value["distanceCm"]))
    if float(item["distanceCm"]) < 100.0:
        det = calibrated_detection(item, pose, float(nav_odometry().get("tick", 0)) * 0.02)
        return {"x": det.x, "z": det.z, "source": "uncapped_planning_only"}
    yaw = pose.yaw_rad + math.radians(float(item.get("bearingDeg") or 0.0))
    return {"ray_x": pose.x, "ray_z": pose.z, "ux": math.sin(yaw), "uz": math.cos(yaw),
            "source": "capped_bearing_only"}


def _aim_planning_goal(goal):
    pose, state = _vp_remember()
    if not state.get("onRoad"):
        raise MissionFailure("confirmation_off_road")
    ux, uz = _vp_goal_unit(goal, pose)
    bearing = _wrap_deg(math.degrees(math.atan2(ux, uz) - pose.yaw_rad))
    # The motion API accepts angles >= 1 degree. This is an API limit, not a fit.
    if abs(bearing) >= 1.0:
        if bearing > 0:
            motion_right_angle(abs(bearing))
        else:
            motion_left_angle(abs(bearing))
    pose, state = _vp_remember()
    ux, uz = _vp_goal_unit(goal, pose)
    final_bearing = _wrap_deg(math.degrees(math.atan2(ux, uz) - pose.yaw_rad))
    _vp_event("viewpoint_aim", beforeBearingDeg=bearing, afterBearingDeg=final_bearing,
              onRoad=state.get("onRoad"), pose=_pose_log(pose))
    if not state.get("onRoad"):
        raise MissionFailure("confirmation_off_road")
    return abs(final_bearing) <= CONFIRM_VIEW_MAX_BEARING_DEG


def _viewpoint_actual_constraints(goal, final_sample):
    pose, state = _vp_remember()
    if not state.get("onRoad"):
        raise MissionFailure("confirmation_off_road")
    gaps = [math.hypot(pose.x - hit["pose_x"], pose.z - hit["pose_z"])
            for hit in STATE["accepted_hits"]]
    if any(gap < CONFIRM_MIN_GAP_M for gap in gaps):
        return "actual_pose_near_previous_hit"
    if "x" in goal:
        distance = math.hypot(goal["x"] - pose.x, goal["z"] - pose.z)
        predicted = uncalibrate_reading(distance * 100.0, 0.0)
        if not CONFIRM_PREDICT_MIN_CM <= predicted <= CONFIRM_PREDICT_MAX_CM:
            return "actual_predicted_raw_outside_window"
        if final_sample and distance < CONFIRM_LAST_MIN_DIST_M:
            return "actual_final_sample_too_close"
    return None


def _confirmation_result(pose):
    target = _target_confirmed()
    if target is None:
        return _confirm_fail("confirmation_failed", reason="target_not_confirmed")
    hits = STATE["accepted_hits"]
    if len(hits) != 3 or any(hit["track_id"] != target.obj_id for hit in hits):
        return _confirm_fail("confirmation_failed", reason="three_hits_same_track_required")
    last_distance = _wm_distance_m(pose)
    if last_distance is None or last_distance < CONFIRM_LAST_MIN_DIST_M:
        return _confirm_fail("confirmation_failed", reason="last_sample_too_close", wm_distance_m=last_distance)
    if any(math.hypot(a["pose_x"] - b["pose_x"], a["pose_z"] - b["pose_z"]) < CONFIRM_MIN_GAP_M
           for index, a in enumerate(hits) for b in hits[index + 1:]):
        return _confirm_fail("confirmation_failed", reason="sample_gap_too_small")
    STATE["confirmation_distance_cm"] = hits[-1]["distanceCm"]
    _vp_event("memory_confirmed", hits=hits, track_id=target.obj_id,
              confirmation_distanceCm=STATE["confirmation_distance_cm"],
              last_sample_wm_distance_m=last_distance)
    return target


def _try_enter_range_and_confirm(pose, observations):
    """One graph planner handles range entry and all confirmation viewpoints."""
    goal = _planning_goal(pose, observations)
    if goal is None:
        return None
    tried, failures = set(), []
    timestamp = float(nav_odometry().get("tick", 0)) * 0.02
    first = _nearest_candidate(observations, pose, timestamp)
    if first is not None:
        _record_candidate_sample(pose, first)
    while len(STATE["accepted_hits"]) < 3:
        goal = _planning_goal(pose, [], goal)
        final_sample = len(STATE["accepted_hits"]) == 2
        candidates = _vp_candidates(goal, final_sample, tried)
        if not candidates:
            if _vp_explore(goal, tried):
                pose, _ = _vp_remember()
                continue
            return _confirm_fail("confirmation_failed", reason="all_viewpoints_tried_or_unreachable",
                                 hits=len(STATE["accepted_hits"]), failures=failures)
        selected = candidates[0]
        _vp_event("viewpoint_selected", key=selected["key"], roadId=selected["roadId"],
                  progressCm=selected["progressCm"], point=[selected["x"], selected["z"]],
                  pathCm=selected["path_cm"], predictedRawCm=selected.get("predicted_raw_cm"),
                  reason="shortest_legal_road_path", goalSource=goal["source"], candidates=len(candidates))
        result = _vp_travel(selected)
        if result == "replan":
            pose, _ = _vp_remember()
            continue
        tried.add(selected["key"])
        reason = "unreachable" if result != "arrived" else _viewpoint_actual_constraints(goal, final_sample)
        if reason is None and not _aim_planning_goal(goal):
            reason = "target_outside_bearing_window_after_turn"
        if reason is None and not _observe_motion()[0]:
            reason = "no_new_observation_motion"
        if reason is None:
            observations = counted_observe(None, 0.4, targets_only=True)
            pose, _ = _vp_remember()
            timestamp = float(nav_odometry().get("tick", 0)) * 0.02
            _opt2_update_observations(observations, pose, timestamp, memory_phase=True)
            if _opt2_planning_evidence_expired(goal, observations):
                return None
            goal = _planning_goal(pose, observations, goal)
            candidate = _nearest_candidate(observations, pose, timestamp)
            distance = _wm_distance_m(pose)
            if candidate is None:
                reason = "no_same_track_hit_in_window"
            elif final_sample and (distance is None or distance < CONFIRM_LAST_MIN_DIST_M):
                reason = "fused_final_sample_too_close"
            elif not _record_candidate_sample(pose, candidate):
                reason = "hit_rejected"
        if reason is not None:
            failures.append({"key": selected["key"], "reason": reason})
            _vp_event("viewpoint_failed", key=selected["key"], reason=reason)
    return _confirmation_result(pose)


def patrol_until_target_seen(max_obs=80):
    """Patrol public roads; only query after real movement or a sufficient turn."""
    visited = set()
    for _step in range(24):
        if STATE["observe_count"] >= max_obs:
            return None
        pose, state = _vp_remember()
        if not state.get("onRoad"):
            raise MissionFailure("patrol_off_road")
        if _observe_motion()[0]:
            observations = counted_observe(None, 0.4, targets_only=True)
            timestamp = float(nav_odometry().get("tick", 0)) * 0.02
            _opt2_update_observations(observations, pose, timestamp, memory_phase=True)
            target = _try_enter_range_and_confirm(pose, observations)
            if target is not None:
                return target
            if _opt2_confirmation_should_abort():
                return _confirm_fail("confirmation_aborted", reason="target_seen_but_confirmation_failed")
        _, state = _vp_remember()
        exits = [item for item in state.get("exits", []) if item.get("roadId")]
        choices = [item for item in exits if item["roadId"] not in visited] or exits
        if not choices:
            align_to_current_road()
            motion_left_angle(180)
            _opt2_patrol_follow(150, 30)
            _vp_prepare_node()
            continue
        chosen = choices[0]
        if not _opt2_patrol_enter(chosen["roadId"]):
            return _confirm_fail("patrol_failed", reason="exit_unavailable", roadId=chosen["roadId"])
        visited.add(chosen["roadId"])
        for _ in range(2):
            result = _opt2_patrol_follow(150, 30)
            if STATE["observe_count"] >= max_obs:
                return None
            pose, state = _vp_remember()
            if not state.get("onRoad"):
                raise MissionFailure("patrol_off_road")
            if _observe_motion()[0]:
                observations = counted_observe(None, 0.4, targets_only=True)
                timestamp = float(nav_odometry().get("tick", 0)) * 0.02
                _opt2_update_observations(observations, pose, timestamp, memory_phase=True)
                target = _try_enter_range_and_confirm(pose, observations)
                if target is not None:
                    return target
                if _opt2_confirmation_should_abort():
                    return _confirm_fail("confirmation_aborted", reason="target_seen_but_confirmation_failed")
            if result.get("stoppedBy") != "max_distance":
                _vp_prepare_node()
                break
    return None


def _approach_event(event, **fields):
    payload = {"event": event}
    payload.update(fields)
    print("GY " + json.dumps(payload, ensure_ascii=False))


def _approach_on_road(stage):
    state = nav_road_state()
    if not state.get("onRoad"):
        _approach_event("approach_on_road_violation", stage=stage,
                        roadId=state.get("roadId"), onRoad=False,
                        lateralOffsetCm=state.get("lateralOffsetCm"))
        return None
    return state


def _turn_toward_bearing(bearing):
    if bearing > 8.0:
        motion_right_angle(min(abs(bearing), 30.0))
    elif bearing < -8.0:
        motion_left_angle(min(abs(bearing), 30.0))
