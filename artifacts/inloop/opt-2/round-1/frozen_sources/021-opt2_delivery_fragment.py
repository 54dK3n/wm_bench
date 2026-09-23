"""Public-road storage search, embedded after the r2 VP and demo-flow helpers.

Integration: override release_target_at_storage plus _vp_enter/_vp_travel below.
The latter two are the frozen opt1-r2 implementations with only the speed
argument routed through _opt2_travel_speed(). Confirmation still uses SLOW_SPEED.
Requires the base program's math/json, nav_*/motion_*, VP_STATE, road graph,
mission.storage and _demo_release_active_target. No observation is requested.
State persists only for one delivery search; NAV, WM, geometry and local road
restrictions are never reset. Release bookkeeping remains in the demo helper.
"""


def _opt2_travel_speed():
    return CRUISE_SPEED if DELIVERY_LOG.get("on") else SLOW_SPEED


def _opt2_storage_roads(storage):
    edge = edge_by_road.get(storage.get("roadId"))
    if edge is None:
        return set()
    nodes = {edge["fromNodeId"], edge["toNodeId"]}
    return {road_id for road_id, item in edge_by_road.items()
            if item["fromNodeId"] in nodes or item["toNodeId"] in nodes}


def _opt2_storage_distance(storage, road_id, progress):
    """Road distance to the public anchor, only for ordering release samples."""
    anchor = edge_by_road[storage["roadId"]]
    anchor_s = float(storage["progressCm"])
    if road_id == storage["roadId"]:
        return abs(progress - anchor_s)
    edge = edge_by_road[road_id]
    distances = []
    for node, anchor_part in ((anchor["fromNodeId"], anchor_s),
                              (anchor["toNodeId"], float(anchor["lengthCm"]) - anchor_s)):
        if edge["fromNodeId"] == node:
            distances.append(anchor_part + progress)
        if edge["toNodeId"] == node:
            distances.append(anchor_part + float(edge["lengthCm"]) - progress)
    return min(distances) if distances else float("inf")


def _opt2_storage_candidates(storage, tried, reported):
    """Public progress grid on storage road; measured points on adjacent roads.

    A progress destination needs no invented world coordinate. The VP controller
    obtains real geometry during travel and replans after each road transition.
    The anchor is a nearest-road projection, never the actual storage centre.
    """
    pose, state = _vp_remember()
    road_id = storage["roadId"]
    edge = edge_by_road[road_id]
    length = float(edge["lengthCm"])
    grid = float(VIEW_GRID_CM)
    progress_values = {float(storage["progressCm"]), 0.0, length}
    progress_values.update(index * grid for index in range(math.floor(length / grid) + 1))
    points = {}
    for progress in progress_values:
        key = "storage:" + road_id + "@" + str(round(progress, 1))
        points[key] = {"key": key, "roadId": road_id, "progressCm": progress,
                       "geometry": "public_storage_road_progress"}
    adjacent = _opt2_storage_roads(storage)
    for point in _vp_points(pose, state).values():
        if point["roadId"] in adjacent:
            point = dict(point)
            point["key"] = "storage:" + point["key"]
            points[point["key"]] = point
    choices = []
    for key, point in points.items():
        reason = "already_tried" if key in tried else None
        plan = None if reason else _vp_path(state, point["roadId"], point["progressCm"])
        if reason is None and plan is None:
            reason = "no_legal_road_path"
        if reason:
            report_key = (key, reason, _vp_block_revision())
            if report_key not in reported:
                reported.add(report_key)
                _delivery_event("delivery_candidate_rejected", key=key, reason=reason)
            continue
        point["plan"] = plan
        point["path_cm"] = plan["cost_cm"]
        point["anchor_path_cm"] = _opt2_storage_distance(storage, point["roadId"], point["progressCm"])
        choices.append(point)
    choices.sort(key=lambda item: (item["anchor_path_cm"], item["path_cm"], item["key"]))
    return choices


def _opt2_reach(candidate):
    """Keep one VP travel chain; reject a repeated physical/planning state."""
    visited = set()
    while True:
        _, state = _vp_remember()
        if not state.get("onRoad"):
            _delivery_event("delivery_candidate_unreachable", key=candidate["key"], reason="off_road")
            return False
        plan = _vp_path(state, candidate["roadId"], candidate["progressCm"], candidate.get("enter_only", False))
        if plan is None:
            _delivery_event("delivery_candidate_unreachable", key=candidate["key"], reason="no_legal_road_path")
            return False
        operation = (state.get("roadId"), round(float(state.get("roadProgressCm") or 0.0), 1),
                     plan["direction"], plan.get("entry_node"), tuple(plan["route"]), _vp_block_revision())
        if operation in visited:
            _delivery_event("delivery_candidate_unreachable", key=candidate["key"], reason="repeated_travel_state")
            return False
        visited.add(operation)
        result = _vp_travel(candidate)
        _, after = _vp_remember()
        _delivery_event("delivery_candidate_travel", key=candidate["key"], result=result,
                        plannedRoads=plan["route"], plannedDistanceCm=plan["cost_cm"])
        if not after.get("onRoad"):
            return False
        if result == "arrived":
            return (after.get("roadId") == candidate["roadId"] and
                    round(float(after.get("roadProgressCm") or 0.0) - candidate["progressCm"], 1) == 0)
        if result != "replan":
            return False


def _opt2_preview_candidate(storage, candidate):
    """Finite heading grid; release_preview is the sole storage acceptance test."""
    pose, state = _vp_remember()
    if not state.get("onRoad"):
        return "off_road"
    step = float(OBS_MIN_TURN_DEG)
    base = pose.yaw_rad
    # Prefer facing the measured anchor projection when it is a different point.
    anchor_key = storage["roadId"] + "@" + str(round(float(storage["progressCm"]), 1))
    anchor = _vp_points(pose, state).get(anchor_key)
    if anchor is not None and (anchor["x"] != pose.x or anchor["z"] != pose.z):
        bearing = _wrap_deg(math.degrees(math.atan2(anchor["x"] - pose.x, anchor["z"] - pose.z) - base))
        base += math.radians(round(bearing / step) * step)
    for index in range(math.ceil(360.0 / step)):
        pose, state = _vp_remember()
        if not state.get("onRoad"):
            return "off_road"
        desired = base + math.radians(index * step)
        turn = round(_wrap_deg(math.degrees(desired - pose.yaw_rad)), 1)
        if turn > 0:
            motion_right_angle(turn)
        elif turn < 0:
            motion_left_angle(-turn)
        _vp_remember()
        preview = nav_release_preview()
        _delivery_event("delivery_release_preview", key=candidate["key"], heading_index=index,
                        preview=preview, reason="public_preview_only")
        if preview.get("holding") != "target":
            return "not_holding_target"
        if preview.get("releaseAccepted") and preview.get("wouldCompleteDelivery"):
            return "released" if _demo_release_active_target(preview) else "release_unverified"
    return "preview_grid_exhausted"


def _opt2_leave_release():
    """Move one legal grid step away; at a stopped junction take a legal exit.

    The previous release pose plus the public gripper projection is runtime
    memory. It orders departure directions; it is not a hidden target anchor.
    """
    deliveries = DEMO_STATE.get("deliveries", [])
    if not deliveries:
        return False
    released = deliveries[-1]
    start, state = _vp_remember()
    if not state.get("onRoad"):
        return False
    start_distance = math.hypot(start.x - released["x"], start.z - released["z"])
    road_id = state.get("roadId")
    edge = edge_by_road.get(road_id)
    unit = _vp_canonical_unit(road_id, float(state.get("roadProgressCm") or 0.0))
    choices = []
    if edge is not None and unit is not None:
        progress = float(state["roadProgressCm"])
        for sign in (1, -1):
            if edge["oneWay"] and sign < 0:
                continue
            away = sign * ((start.x - released["x"]) * unit[0] + (start.z - released["z"]) * unit[1])
            end = min(float(edge["lengthCm"]), max(0.0, progress + sign * VIEW_GRID_CM))
            if away < 0 or end == progress or _road_progress_blocked(road_id, progress, end):
                continue
            choices.append((-away, sign, end))
    for _, _sign, end in sorted(choices):
        candidate = {"key": "leave:" + str(road_id) + "@" + str(round(end, 1)),
                     "roadId": road_id, "progressCm": end}
        if _opt2_reach(candidate):
            after, state = _vp_remember()
            if (state.get("onRoad") and math.hypot(after.x - start.x, after.z - start.z) > 0
                    and math.hypot(after.x - released["x"], after.z - released["z"]) > start_distance):
                _delivery_event("delivery_leave_complete", key=candidate["key"], reason="moved_away_on_road")
                return True
    # follow_road/forward may legitimately report zero at a junction; the next
    # action is an explicit take_exit, never another follow at the same node.
    pose, state = _vp_prepare_node()
    exits = []
    for item in state.get("exits", []):
        exit_road = item.get("roadId")
        edge = edge_by_road.get(exit_road)
        if edge is None or exit_road in blocked_roads:
            continue
        node = state.get("nodeId")
        if node not in (edge["fromNodeId"], edge["toNodeId"]):
            continue
        if edge["oneWay"] and node != edge["fromNodeId"]:
            continue
        entry = 0.0 if node == edge["fromNodeId"] else float(edge["lengthCm"])
        if _road_progress_limit(exit_road, entry, float(edge["lengthCm"]) - entry) == entry:
            continue
        yaw = pose.yaw_rad - math.radians(float(item.get("turnDeg") or 0.0))
        away = (pose.x - released["x"]) * math.sin(yaw) + (pose.z - released["z"]) * math.cos(yaw)
        if away >= 0:
            exits.append((-away, exit_road))
    for _, exit_road in sorted(exits):
        if _vp_enter(exit_road):
            after, state = _vp_remember()
            if (state.get("onRoad") and math.hypot(after.x - start.x, after.z - start.z) > 0
                    and math.hypot(after.x - released["x"], after.z - released["z"]) > start_distance):
                _delivery_event("delivery_leave_complete", roadId=exit_road, reason="take_exit_away_on_road")
                return True
        _delivery_event("delivery_leave_candidate_rejected", roadId=exit_road, reason="no_departure_away_from_release")
    _delivery_event("delivery_leave_failed", reason="no_legal_departure_with_progress")
    return False


def release_target_at_storage():
    """One target: reach, sample, verify release, depart; leave WM/NAV intact."""
    storage = mission.get("storage") or {}
    road_id = storage.get("roadId")
    edge = edge_by_road.get(road_id)
    progress = storage.get("progressCm")
    if (edge is None or not isinstance(progress, (int, float)) or not math.isfinite(progress)
            or not 0 <= progress <= float(edge["lengthCm"])):
        _delivery_event("delivery_search_failed", reason="invalid_public_storage_anchor")
        return False
    tried, reported, previewed = set(), set(), set()
    VP_STATE["travel_attempts"] = set()
    VP_STATE["travel_active"] = None
    while True:
        _, state = _vp_remember()
        if not state.get("onRoad"):
            _delivery_event("delivery_search_failed", reason="off_road")
            return False
        candidates = _opt2_storage_candidates(storage, tried, reported)
        if not candidates:
            _delivery_event("delivery_search_failed", reason="finite_storage_grid_exhausted", tried=len(tried))
            return False
        candidate = candidates[0]
        tried.add(candidate["key"])
        _delivery_event("delivery_candidate_selected", key=candidate["key"],
                        anchorPathCm=candidate["anchor_path_cm"], pathCm=candidate["path_cm"])
        if not _opt2_reach(candidate):
            continue
        pose, state = _vp_remember()
        position = (state.get("roadId"), round(float(state.get("roadProgressCm") or 0.0), 1))
        if position in previewed:
            _delivery_event("delivery_candidate_rejected", key=candidate["key"], reason="same_parking_point_already_previewed")
            continue
        previewed.add(position)
        result = _opt2_preview_candidate(storage, candidate)
        if result == "released":
            return _opt2_leave_release()
        _delivery_event("delivery_candidate_rejected", key=candidate["key"], reason=result)
        if result != "preview_grid_exhausted":
            return False


# Below: frozen opt1-r2 VP bodies; speed selection is the only change.


def _vp_enter(road_id):
    before, state = _vp_prepare_node()
    if not state.get("onRoad") or not any(item.get("roadId") == road_id for item in state.get("exits", [])):
        return False
    result = motion_take_exit(road_id, _opt2_travel_speed(), True)
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


def _vp_travel(candidate):
    if VP_STATE.get("travel_active") != candidate["key"]:
        VP_STATE["travel_attempts"] = set()
        VP_STATE["travel_active"] = candidate["key"]
    pose, state = _vp_remember()
    plan = _vp_path(state, candidate["roadId"], candidate["progressCm"], candidate.get("enter_only", False))
    reason = None
    if plan is not None:
        key = (candidate["key"], state.get("roadId"), round(float(state.get("roadProgressCm") or 0.0), 1),
               plan["direction"], plan.get("entry_node"), tuple(plan["route"]), _vp_block_revision())
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
            result = _vp_follow(abs(delta), _opt2_travel_speed())
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
                result = _vp_follow(distance, _opt2_travel_speed())
                if result.get("stoppedBy") == "front_clearance" and _vp_block_current_direction(state, plan["direction"]):
                    return "replan"
                if result.get("stoppedBy") not in ("junction", "road_end", "max_distance"):
                    reason = "transition_approach:" + str(result.get("stoppedBy"))
            if reason is None:
                _, now = _vp_prepare_node()
                if now.get("nodeId") != plan["entry_node"]:
                    reason = "different_transition_node"
                else:
                    blocked_before = _vp_block_revision()
                    if _vp_enter(plan["route"][0]) or _vp_block_revision() != blocked_before:
                        return "replan"
                    reason = "planned_exit_unavailable_or_blocked"
    VP_STATE["failed"].add(candidate["key"])
    _vp_event("viewpoint_unreachable", key=candidate["key"], reason=reason)
    return _vp_finish_travel("unreachable")
