"""Road-graph approach using runtime geometry only; embedded by the main program."""


def _mag_candidates(pose, state, target, tried):
    candidates = []
    for point in _vp_points(pose, state).values():
        if point["key"] in tried:
            continue
        distance = math.hypot(point["x"] - target.x, point["z"] - target.z)
        if distance > APPROACH_FINE_DISTANCE_M:
            continue
        plan = _vp_path(state, point["roadId"], point["progressCm"])
        if plan is not None:
            candidates.append(dict(point, plan=plan, path_cm=plan["cost_cm"], wm_distance_m=distance))
    return sorted(candidates, key=lambda point: (point["path_cm"], point["key"]))


def _mag_node_bounds(target, points):
    """Triangle-inequality lower bounds to the existing capture disk, in cm.

    At a measured point p, h(p)=max(0, |p-target|-fine_radius). An endpoint
    at road-arc distance d has h(node)>=h(p)-d. Propagating that inequality
    through graph lengths gives bounds without inventing endpoint coordinates.
    Directional blocks do not remove the geometric inequality of a real road.
    """
    bounds = {}
    adjacency = {}
    for road_id, edge in edge_by_road.items():
        a, b, length = edge["fromNodeId"], edge["toNodeId"], float(edge["lengthCm"])
        bounds.setdefault(a, 0.0)
        bounds.setdefault(b, 0.0)
        adjacency.setdefault(a, []).append((b, length))
        adjacency.setdefault(b, []).append((a, length))
    for point in points.values():
        edge = edge_by_road[point["roadId"]]
        center = point
        if point.get("geometry") == "current_pose":
            samples = VP_STATE["roads"].get(point["roadId"], [])
            center = next((item for item in samples if round(item["s"] - point["progressCm"], 1) == 0), None)
            if center is None:
                continue
        bound = max(0.0, (math.hypot(center["x"] - target.x, center["z"] - target.z)
                          - APPROACH_FINE_DISTANCE_M) * 100.0)
        for node, distance in ((edge["fromNodeId"], point["progressCm"]),
                               (edge["toNodeId"], float(edge["lengthCm"]) - point["progressCm"])):
            bounds[node] = max(bounds[node], bound - distance)
    remaining = set(bounds)
    while remaining:
        node = max(remaining, key=lambda item: bounds[item])
        remaining.remove(node)
        for neighbor, length in adjacency[node]:
            if neighbor in remaining:
                bounds[neighbor] = max(bounds[neighbor], bounds[node] - length)
    return bounds


def _mag_frontiers(pose, state, target, failed):
    """Plan to measured boundaries of unknown intervals, including unseen graph edges."""
    candidates = []
    points = _vp_points(pose, state)
    node_bounds = _mag_node_bounds(target, points)
    for road_id, edge in edge_by_road.items():
        if road_id in blocked_roads:
            continue
        length = float(edge["lengthCm"])
        covered = list(VP_STATE["intervals"].get(road_id, []))
        covered.extend((item["s"], item["s"]) for item in VP_STATE["roads"].get(road_id, []))
        merged = []
        for left, right in sorted(covered):
            left, right = max(0.0, float(left)), min(length, float(right))
            if merged and left <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], right))
            else:
                merged.append((left, right))
        cursor = 0.0
        gaps = []
        for left, right in merged:
            if round(left - cursor, 1) > 0:
                gaps.append((cursor, left))
            cursor = max(cursor, right)
        if round(length - cursor, 1) > 0:
            gaps.append((cursor, length))
        for left, right in gaps:
            for progress, end, direction in ((left, right, 1), (right, left, -1)):
                if edge["oneWay"] and direction < 0:
                    continue
                end = _road_progress_limit(road_id, progress, end)
                if round(direction * (end - progress), 1) <= 0:
                    continue
                frontier_key = (road_id, direction, round(end, 1))
                if frontier_key in failed:
                    continue
                key = road_id + "@" + str(round(progress, 1))
                point = points.get(key)
                enter_only = point is None and progress in (0.0, length)
                plan = _vp_path(state, road_id, progress, enter_only)
                if plan is None:
                    continue
                # Unknown boundaries get graph-propagated distance bounds, not coordinates.
                distance = (math.hypot(point["x"] - target.x, point["z"] - target.z)
                            if point is not None else None)
                evaluation_progress = (plan["landing_progress_cm"]
                                       if enter_only and not plan["direct"] else progress)
                if (enter_only and not plan["direct"]
                        and any(round(evaluation_progress - left, 1) >= 0
                                and round(right - evaluation_progress, 1) >= 0 for left, right in merged)):
                    # An unknown endpoint cannot be explored by re-entering at
                    # the same known landing. The measured landing instead has
                    # its own directed frontier into each still-unknown gap.
                    _approach_event("approach_frontier_rejected", key=key,
                                    reason="gateway_landing_already_measured",
                                    landingProgressCm=evaluation_progress)
                    continue
                remaining_bound = (max(0.0, (distance - APPROACH_FINE_DISTANCE_M) * 100.0)
                                   if distance is not None else
                                   max(0.0, node_bounds[edge["fromNodeId"]] - evaluation_progress,
                                       node_bounds[edge["toNodeId"]] - (length - evaluation_progress)))
                unit = _vp_canonical_unit(road_id, progress)
                toward = 0.0
                if point is not None and unit is not None:
                    toward = direction * (unit[0] * (target.x - point["x"])
                                          + unit[1] * (target.z - point["z"]))
                candidates.append({"key": key, "roadId": road_id, "progressCm": progress,
                                   "endCm": end, "direction": direction, "frontier_key": frontier_key,
                                   "plan": plan, "path_cm": plan["cost_cm"],
                                   "enter_only": enter_only, "remaining_bound_cm": remaining_bound,
                                   "score_cm": plan["cost_cm"] + remaining_bound,
                                   "boundary_distance_m": distance, "toward": toward})
    return sorted(candidates, key=lambda point: (point["score_cm"], point["path_cm"],
                                                -point["toward"], point["key"], point["direction"]))


def _mag_frontier_step(frontier, state):
    """Extend one selected unknown interval without reacting to target bearing."""
    road_id = frontier["roadId"]
    if (state.get("roadId") != road_id
            or round(float(state["roadProgressCm"]) - frontier["progressCm"], 1) != 0):
        return _vp_travel(frontier)
    direction = frontier["direction"]
    if not _vp_face_progress(direction, state):
        _approach_event("approach_frontier_failed", roadId=road_id,
                        reason="canonical_direction_unknown_or_road_changed")
        return "unreachable"
    _, aligned = _vp_remember()
    before = float(aligned.get("roadProgressCm") or 0.0)
    remaining = direction * (frontier["endCm"] - before)
    if round(remaining, 1) <= 0:
        return "replan"
    result = _vp_follow(min(float(APPROACH_FOLLOW_STEP_CM), remaining), SLOW_SPEED)
    _, after = _vp_remember()
    _approach_event("approach_frontier_step", roadId=road_id, direction=direction,
                    beforeProgressCm=before, afterProgressCm=after.get("roadProgressCm"),
                    distanceCm=result.get("distanceCm"), stoppedBy=result.get("stoppedBy"))
    if not after.get("onRoad"):
        return "off_road"
    if result.get("stoppedBy") == "front_clearance" and _vp_block_current_direction(state, direction):
        return "replan"
    if after.get("roadId") != road_id:
        return "replan" if result.get("distanceCm", 0) > 0 else "unreachable"
    if result.get("stoppedBy") in ("junction", "road_end"):
        # Even a positive 7cm junction stop needs an exit decision. Do not reverse
        # toward the local Euclidean minimum or repeatedly nudge the same endpoint.
        _vp_prepare_node()
        return "unreachable"
    moved = direction * (float(after.get("roadProgressCm") or 0.0) - before)
    if moved <= 0 or not result.get("accepted", True):
        return "unreachable"
    if result.get("stoppedBy") != "max_distance":
        return "unreachable"
    return "replan"


def _approach_graph_navigation(target):
    """Reach an actual on-road pose within the existing fine-approach distance."""
    tried, failed_frontiers, attempted = set(), set(), set()
    track_id = target.obj_id
    while True:
        pose, state = _vp_remember()
        live_target = _wm_target()
        if live_target is None or live_target.obj_id != track_id or live_target.state == ObjectState.LOST:
            _approach_event("approach_failed", reason="memory_graph_target_lost_or_changed", track_id=track_id)
            return False
        target = live_target
        if not state.get("onRoad") or state.get("roadId") not in edge_by_road:
            _approach_event("approach_failed", reason="memory_graph_off_road", roadId=state.get("roadId"))
            return False
        distance = math.hypot(target.x - pose.x, target.z - pose.z)
        if distance <= APPROACH_FINE_DISTANCE_M:
            _approach_event("approach_memory_stop", reason="graph_fine_phase", track_id=track_id,
                            wm_distance_m=round(distance, 3), roadId=state.get("roadId"), onRoad=True)
            return True
        candidates = _mag_candidates(pose, state, target, tried)
        kind = "candidate" if candidates else "frontier"
        options = candidates or _mag_frontiers(pose, state, target, failed_frontiers)
        if not options:
            _approach_event("approach_min_distance_failed", reason="memory_graph_exhausted",
                            current_wm_distance_m=round(distance, 3), required_m=APPROACH_FINE_DISTANCE_M,
                            roadId=state.get("roadId"), onRoad=True)
            return False
        chosen = options[0]
        plan = chosen.get("plan", {})
        coverage = tuple((road_id, tuple((round(left, 1), round(right, 1)) for left, right
                                         in VP_STATE["intervals"].get(road_id, [])))
                         for road_id in sorted(VP_STATE["roads"]))
        operation_key = (kind, chosen["key"], chosen.get("direction"), state.get("roadId"),
                         round(float(state.get("roadProgressCm") or 0.0), 1),
                         plan.get("direction"), plan.get("entry_node"), tuple(plan.get("route", [])),
                         _vp_block_revision(), coverage)
        if operation_key in attempted:
            if kind == "candidate":
                tried.add(chosen["key"])
            else:
                failed_frontiers.add(chosen["frontier_key"])
            _approach_event("approach_graph_rejected", kind=kind, key=chosen["key"],
                            reason="repeated_road_state_without_new_route_progress")
            continue
        attempted.add(operation_key)
        _approach_event("approach_graph_selected", kind=kind, key=chosen["key"],
                        pathCm=chosen["path_cm"], wm_distance_m=chosen.get("wm_distance_m"),
                        direction=chosen.get("direction"), remainingBoundCm=chosen.get("remaining_bound_cm"),
                        scoreCm=chosen.get("score_cm"),
                        reason="shortest_legal_road_path" if kind == "candidate" else "path_plus_capture_distance_bound")
        result = _vp_travel(chosen) if kind == "candidate" else _mag_frontier_step(chosen, state)
        actual_pose, actual_state = _vp_remember()
        if not actual_state.get("onRoad") or result == "off_road":
            _approach_event("approach_failed", reason="memory_graph_off_road_after_move")
            return False
        if kind == "candidate" and result != "replan":
            tried.add(chosen["key"])
            actual_distance = math.hypot(target.x - actual_pose.x, target.z - actual_pose.z)
            if actual_distance > APPROACH_FINE_DISTANCE_M:
                _approach_event("approach_graph_rejected", kind=kind, key=chosen["key"],
                                reason="actual_pose_outside_fine_range" if result == "arrived" else result,
                                wm_distance_m=round(actual_distance, 3))
        elif kind == "frontier" and result == "unreachable":
            failed_frontiers.add(chosen["frontier_key"])
