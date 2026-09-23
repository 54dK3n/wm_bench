"""P3 target scoring from public WM, road topology and measured road geometry.

All helpers are top-level functions: the platform turns them into async functions
and awaits direct Name calls when this file is embedded. No robot API is called.
Candidate/geometry x,z are WM-frame metres; public progress/length are cm.
The caller must supply the measured k (cm/degree); no default or inferred k.
"""
import heapq
import math

TARGET_SELECTION_VERSION = "public-road-initial-turn-v1"
_TS_EPS = 1e-9  # Arithmetic equality only, not a geometry/calibration threshold.


def _ts_finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def selection_shortest_turn(current_deg, target_deg):
    """Signed shortest target-current angle in (-180,180]; left positive."""
    if not _ts_finite(current_deg) or not _ts_finite(target_deg):
        raise ValueError("turn headings must be finite numbers")
    delta = (target_deg - current_deg + 180.0) % 360.0 - 180.0
    return 180.0 if delta == -180.0 else 0.0 if delta == 0.0 else delta


def _ts_graph(graph):
    edges, adjacency, errors = {}, {}, []
    for edge in graph.get("edges", []):
        road = edge.get("roadId")
        start, end, length = edge.get("fromNodeId"), edge.get("toNodeId"), edge.get("lengthCm")
        if (not isinstance(road, str) or not road or not isinstance(start, str)
                or not isinstance(end, str) or not _ts_finite(length) or length < 0
                or type(edge.get("oneWay", False)) is not bool or road in edges):
            errors.append("invalid_or_duplicate_public_edge")
            continue
        item = {"roadId": road, "fromNodeId": start, "toNodeId": end,
                "lengthCm": float(length), "oneWay": edge.get("oneWay", False)}
        edges[road] = item
        adjacency.setdefault(start, []).append((end, float(length), road, 1))
        adjacency.setdefault(end, [])
        if not item["oneWay"]:
            adjacency[end].append((start, float(length), road, -1))
    return edges, adjacency, errors


def _ts_leg(road, begin, end, kind):
    return {"roadId": road, "from_progress_cm": begin, "to_progress_cm": end,
            "distance_cm": abs(end - begin), "direction": 1 if end >= begin else -1,
            "kind": kind}


def _ts_route(edges, adjacency, current_road, current_s, goal_road, goal_s):
    """Multi-source Dijkstra with start and goal edge fractions, including oneWay."""
    current, goal = edges[current_road], edges[goal_road]
    distance, paths, queue, plans = {}, {}, [], []
    starts = [(current["toNodeId"], current["lengthCm"], current["lengthCm"] - current_s)]
    if not current["oneWay"] or current_s == 0:
        starts.append((current["fromNodeId"], 0.0, current_s))
    for node, endpoint, initial in starts:
        if initial < distance.get(node, math.inf):
            distance[node] = initial
            paths[node] = [] if initial == 0 else [_ts_leg(current_road, current_s, endpoint, "current_partial")]
            heapq.heappush(queue, (initial, node))
    while queue:
        value, node = heapq.heappop(queue)
        if value != distance[node]:
            continue
        for neighbor, length, road, direction in sorted(adjacency.get(node, [])):
            proposed = value + length
            if proposed < distance.get(neighbor, math.inf):
                distance[neighbor] = proposed
                begin, end = (0.0, length) if direction > 0 else (length, 0.0)
                paths[neighbor] = paths[node] + [_ts_leg(road, begin, end, "full_road")]
                heapq.heappush(queue, (proposed, neighbor))
    if current_road == goal_road and (not current["oneWay"] or goal_s >= current_s):
        plans.append({"distance_cm": abs(goal_s - current_s), "segments":
                      [] if goal_s == current_s else [_ts_leg(current_road, current_s, goal_s, "same_road_partial")]})
    ends = [(goal["fromNodeId"], 0.0, goal_s)]
    if not goal["oneWay"] or goal_s == goal["lengthCm"]:
        ends.append((goal["toNodeId"], goal["lengthCm"], goal["lengthCm"] - goal_s))
    for node, endpoint, final in ends:
        if node in distance:
            tail = [] if final == 0 else [_ts_leg(goal_road, endpoint, goal_s, "target_partial")]
            plans.append({"distance_cm": distance[node] + final, "segments": paths[node] + tail})
    if not plans:
        return None
    # Stable input order and node/road IDs resolve equal-length routes.
    return min(plans, key=lambda item: item["distance_cm"])


def _ts_measured_segments(edges, geometry):
    segments, incomplete_roads, invalid_points = [], [], []
    roads, intervals = geometry.get("roads", {}), geometry.get("intervals", {})
    for road, edge in sorted(edges.items()):
        points = []
        for point in roads.get(road, []):
            s, x, z = point.get("s"), point.get("x"), point.get("z")
            if not all([_ts_finite(s), _ts_finite(x), _ts_finite(z)]) or not 0 <= s <= edge["lengthCm"]:
                invalid_points.append(road)
            else:
                points.append({"s": float(s), "x": float(x), "z": float(z)})
        points.sort(key=lambda item: item["s"])
        spans = []
        for span in intervals.get(road, []):
            if (isinstance(span, (list, tuple)) and len(span) == 2 and _ts_finite(span[0])
                    and _ts_finite(span[1]) and 0 <= span[0] <= span[1] <= edge["lengthCm"]):
                spans.append((span[0], span[1]))
        covered = []
        for left, right in zip(points, points[1:]):
            if right["s"] <= left["s"] or (right["x"] == left["x"] and right["z"] == left["z"]):
                continue
            # Samples must be joined by recorded traversal; two isolated fixes
            # do not establish the road between them.
            cursor = left["s"]
            for begin, end in sorted(spans):
                if begin <= cursor + _TS_EPS:
                    cursor = max(cursor, end)
            if cursor + _TS_EPS >= right["s"]:
                segments.append({"roadId": road, "left": left, "right": right,
                                 "length_cm": edge["lengthCm"]})
                covered.append((left["s"], right["s"]))
        cursor = 0.0
        for begin, end in covered:
            if begin <= cursor + _TS_EPS:
                cursor = max(cursor, end)
        if cursor + _TS_EPS < edge["lengthCm"] or not covered:
            incomplete_roads.append(road)
    return segments, {"incomplete_road_ids": incomplete_roads,
                      "invalid_point_road_ids": sorted(set(invalid_points)),
                      "global_nearest_road_status": "unknown" if incomplete_roads else "known_measured_polyline"}


def _ts_project(x, z, measured):
    candidates = []
    for segment in measured:
        a, b = segment["left"], segment["right"]
        dx, dz = b["x"] - a["x"], b["z"] - a["z"]
        fraction = ((x - a["x"]) * dx + (z - a["z"]) * dz) / (dx * dx + dz * dz)
        clamped = min(1.0, max(0.0, fraction))
        px, pz = a["x"] + clamped * dx, a["z"] + clamped * dz
        progress = a["s"] + clamped * (b["s"] - a["s"])
        unsupported = ((fraction < -_TS_EPS and a["s"] > _TS_EPS)
                       or (fraction > 1.0 + _TS_EPS and b["s"] < segment["length_cm"] - _TS_EPS))
        candidates.append({"roadId": segment["roadId"], "progress_cm": progress,
                           "x": px, "z": pz, "lateral_distance_cm": math.hypot(x - px, z - pz) * 100.0,
                           "sample_progress_cm": [a["s"], b["s"]], "fraction": fraction,
                           "supported": not unsupported,
                           "source": "orthogonal_projection_on_traversed_measured_segment"})
    if not candidates:
        return [], "no_measured_traversed_road_segment"
    nearest = min(item["lateral_distance_cm"] for item in candidates)
    nearest_items = [item for item in candidates if abs(item["lateral_distance_cm"] - nearest) <= _TS_EPS]
    supported = [item for item in nearest_items if item["supported"]]
    return supported, None if supported else "nearest_measured_boundary_requires_unseen_geometry"


def select_target(candidates, graph, road_state, odometry, measured_geometry, k):
    """Return JSON-safe scores; caller logs the result and maps selected ID to WM.

    WM candidates are dictionaries with obj_id,x,z; optional name/state/confidence
    are diagnostics. Caller excludes delivered targets. Initial absolute target
    heading = -atan2(dx,dz), matching public odometry's left-positive heading.
    Cost = shortest public road distance to measured projection + k*abs(turn).
    This is not accumulated route steering, API execution time, nor a promised
    collision-free/grabbable trajectory. Unknown geometry/cost stays explicit.
    """
    result = {"version": TARGET_SELECTION_VERSION, "status": "unknown", "reason": None,
              "selected_candidate_id": None, "k_cm_per_deg": k if _ts_finite(k) else None,
              "turn_definition": "current_heading_to_target_absolute_bearing_initial_shortest",
              "projection_scope": "nearest_traversed_measured_geometry_only",
              "optimality_scope": "scorable_public_model_candidates_only", "candidates": []}
    if not _ts_finite(k) or k < 0:
        result["reason"] = "measured_turn_cost_k_unavailable_or_invalid"
        return result
    needed = [odometry.get("rightCm"), odometry.get("forwardCm"), odometry.get("headingDeg")]
    if not all([_ts_finite(needed[0]), _ts_finite(needed[1]), _ts_finite(needed[2])]):
        result["reason"] = "public_odometry_unavailable"
        return result
    edges, adjacency, graph_errors = _ts_graph(graph)
    current, start_s = road_state.get("roadId"), road_state.get("roadProgressCm")
    if (graph_errors or current not in edges or not _ts_finite(start_s)
            or not 0 <= start_s <= edges[current]["lengthCm"] or road_state.get("onRoad") is not True):
        result["reason"] = "public_graph_or_current_road_invalid"
        result["graph_errors"] = graph_errors
        return result
    measured, coverage = _ts_measured_segments(edges, measured_geometry)
    result["geometry_coverage"] = coverage
    x0, z0, heading = needed[0] / 100.0, needed[1] / 100.0, needed[2]
    seen_ids, scored = set(), []
    for candidate in candidates:
        cid, x, z = candidate.get("obj_id"), candidate.get("x"), candidate.get("z")
        item = {"candidate_id": cid, "status": "unknown", "reason": None, "cost_cm": None,
                "path_distance_cm": None, "turn_deg": None, "projection": None, "path": None}
        result["candidates"].append(item)
        if not isinstance(cid, str) or not cid or cid in seen_ids:
            result["reason"] = "invalid_or_duplicate_candidate_id"
            return result
        seen_ids.add(cid)
        if not _ts_finite(x) or not _ts_finite(z):
            item["reason"] = "wm_position_unavailable"
            continue
        if candidate.get("name", "target") != "target" or str(candidate.get("state", "")).lower() == "lost":
            item.update(status="excluded", reason="not_an_active_target")
            continue
        dx, dz = x - x0, z - z0
        euclidean = math.hypot(dx, dz) * 100.0
        absolute_heading = -math.degrees(math.atan2(dx, dz)) if euclidean else heading
        turn = selection_shortest_turn(heading, absolute_heading)
        item.update(wm_position_m=[x, z], euclidean_cm=euclidean, absolute_target_heading_deg=absolute_heading,
                    turn_deg=turn, turn_cost_cm=k * abs(turn), zero_range_turn_defined_as_zero=euclidean == 0)
        projections, why = _ts_project(x, z, measured)
        item["projection_options"] = projections
        if why:
            item["reason"] = why
            continue
        options = []
        for projection in projections:
            route = _ts_route(edges, adjacency, current, start_s, projection["roadId"], projection["progress_cm"])
            if route is not None:
                options.append({"projection": projection, "path": route["segments"],
                                "path_distance_cm": route["distance_cm"], "cost_cm": route["distance_cm"] + k * abs(turn)})
        if not options:
            item.update(status="unreachable", reason="no_directed_public_graph_path")
            continue
        best = min(options, key=lambda option: (option["cost_cm"], option["projection"]["roadId"], option["projection"]["progress_cm"]))
        item.update(best)
        item["status"] = "scored"
        item["known_geometry_estimate_only"] = bool(coverage["incomplete_road_ids"])
        scored.append(item)
    result["complete_candidate_costs"] = all(item["status"] in ("scored", "excluded", "unreachable") for item in result["candidates"])
    if scored:
        best = min(scored, key=lambda item: (item["cost_cm"], abs(item["turn_deg"]), item["candidate_id"]))
        result.update(status="selected", selected_candidate_id=best["candidate_id"],
                      selected_cost_cm=best["cost_cm"], selected_path_distance_cm=best["path_distance_cm"],
                      selected_turn_deg=best["turn_deg"])
    else:
        result["reason"] = "no_scorable_candidates" if candidates else "no_candidates"
    return result
