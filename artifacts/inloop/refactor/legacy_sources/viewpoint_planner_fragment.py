"""Runtime-only road geometry and viewpoint planning; embedded by the main program."""

VP_STATE = {"roads": {}, "intervals": {}, "explored": set(), "failed": set(), "nudged": set(), "canonical_hints": {}, "travel_attempts": set()}

# Public API contract: competition-core.js controller.exitEntryCm (line 117),
# take_exit landing construction (lines 3896-3910); not a scene-derived distance.
VP_EXIT_ENTRY_CM = 25.0


def _vp_event(event, **fields):
    print("GY " + json.dumps(dict(event=event, **fields), ensure_ascii=False))


def _vp_remember():
    odo = robot.odometry() or {}
    pose = odometry_to_pose(odo)
    state = robot.road_state() or {}
    road_id, progress = state.get("roadId"), state.get("roadProgressCm")
    if state.get("onRoad") and road_id in edge_by_road and progress is not None:
        yaw = pose.yaw_rad - math.radians(float(state.get("headingErrorDeg") or 0.0))
        offset = float(state.get("lateralOffsetCm") or 0.0) / 100.0
        sample = {"s": float(progress), "x": pose.x - offset * math.cos(yaw),
                  "z": pose.z + offset * math.sin(yaw), "yaw": yaw}
        samples = VP_STATE["roads"].setdefault(road_id, [])
        samples[:] = [item for item in samples if round(item["s"], 1) != round(sample["s"], 1)]
        samples.append(sample)
        samples.sort(key=lambda item: item["s"])
    return pose, state


def _vp_goal_unit(goal, pose):
    if "x" in goal:
        dx, dz = float(goal["x"]) - pose.x, float(goal["z"]) - pose.z
    else:
        dx, dz = float(goal["ux"]), float(goal["uz"])
    length = math.hypot(dx, dz)
    return (dx / length, dz / length) if length else (0.0, 0.0)


def _vp_canonical_unit(road_id, progress):
    samples = VP_STATE["roads"].get(road_id, [])
    pairs = [(a, b) for a, b in zip(samples, samples[1:])
             if b["s"] > a["s"] and any(start <= a["s"] and end >= b["s"]
                                        for start, end in VP_STATE["intervals"].get(road_id, []))]
    if not pairs:
        return VP_STATE.get("canonical_hints", {}).get(road_id)
    a, b = min(pairs, key=lambda pair: abs(progress - (pair[0]["s"] + pair[1]["s"]) / 2))
    dx, dz = b["x"] - a["x"], b["z"] - a["z"]
    length = math.hypot(dx, dz)
    return (dx / length, dz / length) if length else None


def _vp_path(state, road_id, progress, enter_only=False):
    current = edge_by_road.get(state.get("roadId"))
    target = edge_by_road.get(road_id)
    if current is None or target is None or state.get("roadProgressCm") is None:
        return None
    if road_id in blocked_roads:
        return None
    start_s = float(state["roadProgressCm"])
    plans = []
    if current["roadId"] == road_id and (not current["oneWay"] or progress >= start_s):
        direction = 1 if progress >= start_s else -1
        a, b = ((current["fromNodeId"], current["toNodeId"]) if direction > 0
                else (current["toNodeId"], current["fromNodeId"]))
        if progress == start_s or (a, b, road_id) not in blocked_directions:
            plans.append({"cost_cm": abs(progress - start_s), "direct": True,
                          "direction": direction, "route": []})
    starts = [(current["toNodeId"], float(current["lengthCm"]) - start_s, 1)]
    if not current["oneWay"]:
        starts.append((current["fromNodeId"], start_s, -1))
    ends = [(target["fromNodeId"], progress)]
    if not target["oneWay"]:
        ends.append((target["toNodeId"], float(target["lengthCm"]) - progress))
    for node, initial_cm, direction in starts:
        from_node = current["fromNodeId"] if direction > 0 else current["toNodeId"]
        if initial_cm > 0 and (from_node, node, current["roadId"]) in blocked_directions:
            continue
        for end_node, final_cm in ends:
            entry_cm = min(float(target["lengthCm"]), VP_EXIT_ENTRY_CM)
            if enter_only:
                # An unknown frontier at the endpoint is a gateway, not a demand
                # to stop before the public take_exit landing position.
                final_cost_cm = entry_cm
            elif target["oneWay"] and final_cm < entry_cm:
                continue
            else:
                final_cost_cm = entry_cm + abs(final_cm - entry_cm)
            destination_node = target["toNodeId"] if end_node == target["fromNodeId"] else target["fromNodeId"]
            if (end_node, destination_node, road_id) in blocked_directions:
                continue
            if (not enter_only and final_cm < entry_cm
                    and (destination_node, end_node, road_id) in blocked_directions):
                continue
            route = dijkstra(node, end_node)
            if route is not None:
                plans.append({"cost_cm": initial_cm + route[1] + final_cost_cm, "direct": False,
                              "direction": direction, "entry_node": node,
                              "target_entry_node": end_node,
                              "landing_progress_cm": (entry_cm if end_node == target["fromNodeId"]
                                                       else float(target["lengthCm"]) - entry_cm),
                              "route": list(route[0]) + [road_id]})
    return min(plans, key=lambda plan: plan["cost_cm"]) if plans else None


def _vp_points(pose, state):
    """Measured road samples and five-centimetre interpolation, without task filters."""
    points = {}
    grid = float(VIEW_GRID_CM)
    for road_id, samples in VP_STATE["roads"].items():
        for sample in samples:
            key = road_id + "@" + str(round(sample["s"], 1))
            points[key] = {"key": key, "roadId": road_id, "progressCm": sample["s"],
                           "x": sample["x"], "z": sample["z"], "geometry": "measured"}
        for left, right in zip(samples, samples[1:]):
            span = right["s"] - left["s"]
            traversed = any(start <= left["s"] and end >= right["s"]
                            for start, end in VP_STATE["intervals"].get(road_id, []))
            if span <= 0 or not traversed:
                continue
            for index in range(math.ceil(left["s"] / grid), math.floor(right["s"] / grid) + 1):
                progress = index * grid
                fraction = (progress - left["s"]) / span
                key = road_id + "@" + str(round(progress, 1))
                if key not in points:
                    points[key] = {"key": key, "roadId": road_id, "progressCm": progress,
                                   "x": left["x"] + fraction * (right["x"] - left["x"]),
                                   "z": left["z"] + fraction * (right["z"] - left["z"]),
                                   "geometry": "interpolated_measured_interval"}
    if state.get("roadId") and state.get("roadProgressCm") is not None:
        key = state["roadId"] + "@" + str(round(float(state["roadProgressCm"]), 1))
        points[key] = {"key": key, "roadId": state["roadId"], "progressCm": float(state["roadProgressCm"]),
                       "x": pose.x, "z": pose.z, "geometry": "current_pose"}
    return points


def _vp_candidates(goal, final_sample, tried):
    pose, state = _vp_remember()
    points = _vp_points(pose, state)
    candidates = []
    for key, point in points.items():
        reason = None
        if key in tried or key in VP_STATE["failed"]:
            reason = "already_tried"
        elif any(math.hypot(point["x"] - hit["pose_x"], point["z"] - hit["pose_z"]) < CONFIRM_MIN_GAP_M
                 for hit in STATE["accepted_hits"]):
            reason = "near_previous_hit"
        elif "x" in goal:
            distance = math.hypot(point["x"] - goal["x"], point["z"] - goal["z"])
            point["predicted_raw_cm"] = uncalibrate_reading(distance * 100.0, 0.0)
            if not CONFIRM_PREDICT_MIN_CM <= point["predicted_raw_cm"] <= CONFIRM_PREDICT_MAX_CM:
                reason = "predicted_raw_outside_window"
            elif final_sample and distance < CONFIRM_LAST_MIN_DIST_M:
                reason = "final_sample_too_close"
        elif ((point["x"] - goal["ray_x"]) * goal["ux"]
              + (point["z"] - goal["ray_z"]) * goal["uz"]) < 0:
            reason = "behind_bearing_ray"
        plan = None if reason else _vp_path(state, point["roadId"], point["progressCm"])
        if not reason and plan is None:
            reason = "no_legal_road_path"
        if reason:
            _vp_event("viewpoint_candidate_rejected", key=key, reason=reason,
                      predicted_raw_cm=point.get("predicted_raw_cm"))
            continue
        point["plan"] = plan
        point["path_cm"] = plan["cost_cm"]
        point["predicted_bearing_after_turn_deg"] = 0.0
        candidates.append(point)
    candidates.sort(key=lambda point: (point["path_cm"], point["key"]))
    _vp_event("viewpoint_candidates", count=len(candidates),
              chosen=candidates[0]["key"] if candidates else None)
    return candidates


def _vp_follow(max_cm, speed):
    """Follow in existing 10cm control steps; record geometry after every step."""
    remaining = float(max_cm)
    total = 0.0
    result = {"accepted": True, "distanceCm": 0.0, "stoppedBy": "max_distance"}
    _vp_remember()
    while round(remaining, 1) > 0:
        _, road_before = _vp_remember()
        before = robot.odometry() or {}
        if remaining < APPROACH_FOLLOW_STEP_CM:
            # The public drive API permits small final grid corrections; follow_road does not.
            state = robot.road_state() or {}
            if not state.get("onRoad"):
                return {"accepted": False, "distanceCm": total, "stoppedBy": "off_road"}
            align_to_current_road()
            robot.forward(round(remaining, 1))
            after = robot.odometry() or {}
            moved = max(0.0, float(after.get("distanceCm") or 0.0) - float(before.get("distanceCm") or 0.0))
            _, state = _vp_remember()
            result = {"accepted": bool(state.get("onRoad")), "distanceCm": moved,
                      "stoppedBy": "max_distance" if state.get("onRoad") else "off_road"}
        else:
            requested = min(remaining, float(APPROACH_FOLLOW_STEP_CM))
            result = robot.follow_road(requested, speed, True)
            _vp_remember()
            moved = float(result.get("distanceCm") or 0.0)
        _, road_after = _vp_remember()
        if (road_before.get("roadId") == road_after.get("roadId")
                and road_before.get("roadProgressCm") is not None
                and road_after.get("roadProgressCm") is not None):
            start, end = sorted((float(road_before["roadProgressCm"]), float(road_after["roadProgressCm"])))
            if start < end:
                intervals = VP_STATE["intervals"].setdefault(road_after["roadId"], [])
                intervals.append((start, end))
                merged = []
                for left, right in sorted(intervals):
                    if merged and left <= merged[-1][1]:
                        merged[-1] = (merged[-1][0], max(merged[-1][1], right))
                    else:
                        merged.append((left, right))
                intervals[:] = merged
        total += moved
        remaining -= moved
        if moved <= 0 or result.get("stoppedBy") != "max_distance" or not result.get("accepted", True):
            break
        if remaining > 0 and moved < float(APPROACH_FOLLOW_STEP_CM) and round(remaining, 1) > 0:
            break
    return dict(result, distanceCm=total)


def _vp_face_progress(direction, state):
    road_id = state.get("roadId")
    unit = _vp_canonical_unit(road_id, float(state.get("roadProgressCm") or 0.0))
    if unit is None:
        return False
    pose, state = _vp_remember()
    yaw = pose.yaw_rad - math.radians(float(state.get("headingErrorDeg") or 0.0))
    ahead = math.sin(yaw) * unit[0] + math.cos(yaw) * unit[1]
    align_to_current_road()
    if (ahead >= 0) != (direction > 0):
        robot.left_angle(180)
    _, now = _vp_remember()
    return bool(now.get("onRoad") and now.get("roadId") == road_id)


def _vp_prepare_node():
    pose, state = _vp_remember()
    if state.get("atNode") and state.get("exits"):
        return pose, state
    key = (state.get("roadId"), round(float(state.get("roadProgressCm") or 0.0), 1))
    if key not in VP_STATE["nudged"] and state.get("onRoad"):
        VP_STATE["nudged"].add(key)
        front = state.get("frontClearanceCm")
        if front is None or float(front) >= NODE_NUDGE_CM:
            robot.forward(NODE_NUDGE_CM)
            pose, state = _vp_remember()
            _vp_event("viewpoint_node_nudge", distanceCm=NODE_NUDGE_CM,
                      atNode=state.get("atNode"), nodeId=state.get("nodeId"))
    return pose, state



def _vp_block_current_direction(before_state, planned_direction=None):
    """Block the actual attempted road direction, never infer it from half-road position."""
    pose, state = _vp_remember()
    road_id = state.get("roadId")
    edge = edge_by_road.get(road_id)
    if edge is None or not state.get("onRoad"):
        return False
    direction = None
    if before_state.get("roadId") == road_id:
        delta = float(state.get("roadProgressCm") or 0.0) - float(before_state.get("roadProgressCm") or 0.0)
        if round(delta, 1) != 0:
            direction = 1 if delta > 0 else -1
    unit = _vp_canonical_unit(road_id, float(state.get("roadProgressCm") or 0.0))
    if direction is None and unit is not None:
        yaw = pose.yaw_rad - math.radians(float(state.get("headingErrorDeg") or 0.0))
        direction = 1 if math.sin(yaw) * unit[0] + math.cos(yaw) * unit[1] >= 0 else -1
    if direction is None and before_state.get("roadId") == road_id:
        direction = planned_direction
    if direction is None:
        return False
    from_node, to_node = ((edge["fromNodeId"], edge["toNodeId"]) if direction > 0
                          else (edge["toNodeId"], edge["fromNodeId"]))
    key = (from_node, to_node, road_id)
    changed = key not in blocked_directions
    blocked_directions.add(key)
    _vp_event("viewpoint_direction_blocked", roadId=road_id, fromNodeId=from_node,
              toNodeId=to_node, roadProgressCm=state.get("roadProgressCm"), changed=changed)
    return changed


def _vp_enter(road_id):
    before, state = _vp_prepare_node()
    if not state.get("onRoad") or not any(item.get("roadId") == road_id for item in state.get("exits", [])):
        return False
    result = robot.take_exit(road_id, SLOW_SPEED, True)
    after, now = _vp_remember()
    moved = math.hypot(after.x - before.x, after.z - before.z)
    edge = edge_by_road.get(road_id)
    if (edge is not None and now.get("roadId") == road_id and now.get("onRoad")
            and state.get("nodeId") in (edge["fromNodeId"], edge["toNodeId"]) and moved > 0):
        # The entry endpoint fixes canonical direction; this is a local tangent, not a road extrapolation.
        sign = 1 if state["nodeId"] == edge["fromNodeId"] else -1
        yaw = after.yaw_rad - math.radians(float(now.get("headingErrorDeg") or 0.0))
        VP_STATE.setdefault("canonical_hints", {})[road_id] = (sign * math.sin(yaw), sign * math.cos(yaw))
    if result.get("stoppedBy") == "front_clearance":
        _vp_block_current_direction(state)
    _vp_event("viewpoint_take_exit", roadId=road_id, distanceCm=result.get("distanceCm"),
              stoppedBy=result.get("stoppedBy"), actualRoadId=now.get("roadId"),
              actualProgressCm=now.get("roadProgressCm"))
    return bool(result.get("accepted") and now.get("onRoad") and moved > 0)


def _vp_finish_travel(result):
    VP_STATE["travel_attempts"] = set()
    VP_STATE["travel_active"] = None
    return result


def _vp_travel(candidate):
    if VP_STATE.get("travel_active") != candidate["key"]:
        VP_STATE["travel_attempts"] = set()
        VP_STATE["travel_active"] = candidate["key"]
    pose, state = _vp_remember()
    plan = _vp_path(state, candidate["roadId"], candidate["progressCm"], candidate.get("enter_only", False))
    reason = None
    if plan is not None:
        key = (candidate["key"], state.get("roadId"), round(float(state.get("roadProgressCm") or 0.0), 1),
               plan["direction"], plan.get("entry_node"), tuple(plan["route"]), len(blocked_directions))
        attempted = VP_STATE.setdefault("travel_attempts", set())
        if key in attempted:
            _vp_event("viewpoint_unreachable", key=candidate["key"], reason="repeated_travel_state")
            return _vp_finish_travel("unreachable")
        attempted.add(key)
    if plan is None:
        reason = "no_legal_road_path"
    elif plan["direct"]:
        delta = candidate["progressCm"] - float(state["roadProgressCm"])
        if round(delta, 1) == 0:
            return _vp_finish_travel("arrived")
        if not _vp_face_progress(plan["direction"], state):
            reason = "canonical_direction_unknown_or_road_changed"
        else:
            result = _vp_follow(abs(delta), SLOW_SPEED)
            _, now = _vp_remember()
            if result.get("stoppedBy") == "front_clearance" and _vp_block_current_direction(state, plan["direction"]):
                return "replan"
            if now.get("roadId") != candidate["roadId"]:
                if result.get("distanceCm", 0) > 0:
                    return "replan"
                VP_STATE["failed"].add(candidate["key"])
                _vp_event("viewpoint_unreachable", key=candidate["key"], reason="road_changed_without_translation")
                return _vp_finish_travel("unreachable")
            if round(float(now.get("roadProgressCm") or 0.0) - candidate["progressCm"], 1) == 0:
                return _vp_finish_travel("arrived")
            if (result.get("stoppedBy") == "max_distance"
                    and round(float(now.get("roadProgressCm") or 0.0) - float(state["roadProgressCm"]), 1) != 0):
                _vp_event("viewpoint_progress_replan", key=candidate["key"],
                          actualProgressCm=now.get("roadProgressCm"), requestedProgressCm=candidate["progressCm"])
                return "replan"
            reason = "stopped_before_candidate:" + str(result.get("stoppedBy"))
    else:
        if not _vp_face_progress(plan["direction"], state):
            reason = "canonical_direction_unknown_or_road_changed"
        else:
            edge = edge_by_road[state["roadId"]]
            distance = (float(edge["lengthCm"]) - float(state["roadProgressCm"]) if plan["direction"] > 0
                        else float(state["roadProgressCm"]))
            if round(distance, 1) > 0:
                result = _vp_follow(distance, SLOW_SPEED)
                if result.get("stoppedBy") == "front_clearance" and _vp_block_current_direction(state, plan["direction"]):
                    return "replan"
                if result.get("stoppedBy") not in ("junction", "road_end", "max_distance"):
                    reason = "transition_approach:" + str(result.get("stoppedBy"))
            if reason is None:
                _, now = _vp_prepare_node()
                if now.get("nodeId") != plan["entry_node"]:
                    reason = "different_transition_node"
                else:
                    blocked_before = len(blocked_directions)
                    if _vp_enter(plan["route"][0]) or len(blocked_directions) > blocked_before:
                        return "replan"
                    reason = "planned_exit_unavailable_or_blocked"
    VP_STATE["failed"].add(candidate["key"])
    _vp_event("viewpoint_unreachable", key=candidate["key"], reason=reason)
    return _vp_finish_travel("unreachable")


def _vp_explore_unit(goal, pose):
    """Choose exploration travel direction; do not change target aiming semantics."""
    unit = _vp_goal_unit(goal, pose)
    if "x" in goal:
        distance_cm = math.hypot(goal["x"] - pose.x, goal["z"] - pose.z) * 100.0
        if uncalibrate_reading(distance_cm, 0.0) < CONFIRM_PREDICT_MIN_CM:
            return -unit[0], -unit[1]
    return unit


def _vp_explore(goal, tried):
    pose, state = _vp_remember()
    road_id = state.get("roadId")
    if not state.get("onRoad") or road_id not in edge_by_road or road_id in blocked_roads:
        return False
    if state.get("atNode") and state.get("exits"):
        unit = _vp_explore_unit(goal, pose)
        desired = math.atan2(unit[0], unit[1])
        choices = []
        for item in state["exits"]:
            exit_road = item.get("roadId")
            key = (state.get("nodeId"), exit_road)
            if exit_road not in edge_by_road or exit_road in blocked_roads or key in VP_STATE["explored"]:
                continue
            edge = edge_by_road[exit_road]
            if edge["oneWay"] and state.get("nodeId") != edge["fromNodeId"]:
                continue
            destination = edge["toNodeId"] if state.get("nodeId") == edge["fromNodeId"] else edge["fromNodeId"]
            if (state.get("nodeId"), destination, exit_road) in blocked_directions:
                continue
            yaw = pose.yaw_rad - math.radians(float(item.get("turnDeg") or 0.0))
            covered = sum(end - start for start, end in VP_STATE["intervals"].get(exit_road, []))
            choices.append((covered >= float(edge["lengthCm"]), abs(_wrap_deg(math.degrees(yaw - desired))), exit_road, key))
        for _, _, exit_road, key in sorted(choices):
            VP_STATE["explored"].add(key)
            if _vp_enter(exit_road):
                return True
        return False
    before = pose
    unit = _vp_explore_unit(goal, pose)
    yaw = pose.yaw_rad - math.radians(float(state.get("headingErrorDeg") or 0.0))
    edge = edge_by_road[road_id]
    toward = math.sin(yaw) * unit[0] + math.cos(yaw) * unit[1] >= 0
    directions = [False] if edge["oneWay"] else ([False, True] if toward else [True, False])
    canonical = _vp_canonical_unit(road_id, float(state.get("roadProgressCm") or 0.0))
    for going_back in directions:
        planned_yaw = yaw + (math.pi if going_back else 0.0)
        key = ("step", road_id, round(float(state.get("roadProgressCm") or 0.0), 1),
               round(_wrap_deg(math.degrees(planned_yaw)), 1))
        if key in VP_STATE["explored"]:
            continue
        if canonical is not None:
            positive = math.sin(planned_yaw) * canonical[0] + math.cos(planned_yaw) * canonical[1] >= 0
            from_node, to_node = ((edge["fromNodeId"], edge["toNodeId"]) if positive
                                  else (edge["toNodeId"], edge["fromNodeId"]))
            if (from_node, to_node, road_id) in blocked_directions or (edge["oneWay"] and not positive):
                continue
        elif any(item[2] == road_id for item in blocked_directions):
            # Do not guess canonical orientation when a directional restriction exists.
            continue
        VP_STATE["explored"].add(key)
        live_pose, live_state = _vp_remember()
        if live_state.get("roadId") != road_id:
            return False
        live_yaw = live_pose.yaw_rad - math.radians(float(live_state.get("headingErrorDeg") or 0.0))
        align_to_current_road()
        if math.cos(live_yaw - planned_yaw) < 0:
            robot.left_angle(180)
        _, aligned = _vp_remember()
        if aligned.get("roadId") != road_id or not aligned.get("onRoad"):
            return False
        result = _vp_follow(APPROACH_FOLLOW_STEP_CM, SLOW_SPEED)
        after, now = _vp_remember()
        if math.hypot(after.x - before.x, after.z - before.z) > 0:
            return True
        if result.get("stoppedBy") in ("junction", "road_end"):
            after, now = _vp_prepare_node()
            if math.hypot(after.x - before.x, after.z - before.z) > 0:
                return True
            if now.get("atNode") and now.get("exits") and _vp_explore(goal, tried):
                return True
        elif result.get("stoppedBy") in ("off_road", "wrong_way", "collision"):
            return False
        _vp_event("viewpoint_exploration_direction_failed", roadId=road_id,
                  roadProgressCm=state.get("roadProgressCm"), stoppedBy=result.get("stoppedBy"),
                  distanceCm=result.get("distanceCm"))
    _vp_event("viewpoint_exploration_exhausted", roadId=road_id,
              roadProgressCm=state.get("roadProgressCm"))
    return False
