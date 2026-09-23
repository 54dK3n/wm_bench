"""Driver-only P3.4 oracle: true packages/road geometry never enter the program.

Enumerate both true candidates, all nearest-road ties and both legal partial
edge endpoints. All-pairs shortest paths are computed independently of the
runtime selector. Costs use the public lengthCm graph and the same measured k.
"""
import math

UNITS_PER_METRE = 8.0  # Platform simulation/navigation conversion, not a layout coordinate.


def _shortest_turn(current, target):
    angle = math.fmod(target - current, 360.0)
    if angle <= -180:
        angle += 360
    elif angle > 180:
        angle -= 360
    return angle


def _to_odometry(package, initial):
    dx, dz = package["x"] - initial["x"], package["z"] - initial["z"]
    sin, cos = math.sin(initial["heading"]), math.cos(initial["heading"])
    return ((dx * cos - dz * sin) / UNITS_PER_METRE,
            (-dx * sin - dz * cos) / UNITS_PER_METRE)


def _projections(package, roads, edges):
    results = []
    for road in roads:
        rid = road.get("id")
        if rid not in edges:
            continue
        points = road.get("points", [])
        lengths = [math.dist(a, b) for a, b in zip(points, points[1:])]
        total = sum(lengths)
        progress = 0.0
        if total <= 0:
            continue
        for a, b, length in zip(points, points[1:], lengths):
            if length <= 0:
                continue
            fraction = max(0.0, min(1.0, ((package["x"] - a[0]) * (b[0] - a[0]) +
                                         (package["z"] - a[1]) * (b[1] - a[1])) / length ** 2))
            x, z = a[0] + fraction * (b[0] - a[0]), a[1] + fraction * (b[1] - a[1])
            results.append({"roadId": rid, "progress_cm": (progress + fraction * length) / total * edges[rid]["lengthCm"],
                            "off_road_cm": math.hypot(package["x"] - x, package["z"] - z) / UNITS_PER_METRE * 100})
            progress += length
    if not results:
        return []
    minimum = min(item["off_road_cm"] for item in results)
    return [item for item in results if math.isclose(item["off_road_cm"], minimum, abs_tol=1e-9, rel_tol=0)]


def _all_pairs(edges):
    nodes = sorted({item[key] for item in edges.values() for key in ("fromNodeId", "toNodeId")})
    costs = {(a, b): 0.0 if a == b else math.inf for a in nodes for b in nodes}
    for item in edges.values():
        a, b, length = item["fromNodeId"], item["toNodeId"], item["lengthCm"]
        costs[a, b] = min(costs[a, b], length)
        if not item.get("oneWay", False):
            costs[b, a] = min(costs[b, a], length)
    for middle in nodes:
        for a in nodes:
            for b in nodes:
                costs[a, b] = min(costs[a, b], costs[a, middle] + costs[middle, b])
    return costs


def _enumerate_routes(state, projection, edges, costs):
    current, target = edges[state["roadId"]], edges[projection["roadId"]]
    start_s, goal_s = state["roadProgressCm"], projection["progress_cm"]
    starts = [(current["toNodeId"], current["lengthCm"] - start_s)]
    if not current.get("oneWay", False) or start_s == 0:
        starts.append((current["fromNodeId"], start_s))
    ends = [(target["fromNodeId"], goal_s)]
    if not target.get("oneWay", False) or goal_s == target["lengthCm"]:
        ends.append((target["toNodeId"], target["lengthCm"] - goal_s))
    options = [{"entry_node": a, "exit_node": b, "distance_cm": left + costs[a, b] + right}
               for a, left in starts for b, right in ends if math.isfinite(costs[a, b])]
    if current["roadId"] == target["roadId"] and (not current.get("oneWay", False) or goal_s >= start_s):
        options.append({"entry_node": None, "exit_node": None, "distance_cm": abs(goal_s - start_s)})
    return options


def evaluate_first_choice(raw, record):
    result = {"evaluated": False, "match": False, "selected_package_id": None,
              "optimal_package_ids": [], "reason": None, "candidates": [], "tick": None,
              "support": {"source": "native record interactionDefinition.packages + taskDefinition.placementGeometry.roads",
                          "algorithm": "independent Floyd-Warshall; enumerate 2 candidates/nearest projections/legal endpoints",
                          "selection_time": "first actual ball-1 target_selection; not grab or mission start"}}
    selections = [(index, line) for index, line in enumerate(raw.get("lines", []))
                  if line.get("event") == "target_selection" and line.get("ball_index") == 1]
    if not selections:
        result["reason"] = "no_first_target_selection"
        return result
    index, snapshot = selections[0]
    result.update(tick=snapshot.get("tick"), selection_line=index)
    try:
        initial = record["simulationDefinition"]["initialPose"]
        packages = [item for item in record["interactionDefinition"]["packages"] if item.get("role") == "target"]
        roads = record["taskDefinition"]["placementGeometry"]["roads"]
        edges = {item["roadId"]: item for item in snapshot["graph"]["edges"]}
        state, odo = snapshot["road_state"], snapshot["odometry"]
        k = snapshot["selection"]["k_cm_per_deg"]
        selected = next(item for item in snapshot["wm_candidates"] if item["obj_id"] == snapshot["selected_track_id"])
        if len(packages) != 2 or type(k) not in (float, int) or not math.isfinite(k) or k < 0:
            raise ValueError("requires exactly two true targets and a valid measured k")
        if state["roadId"] not in edges or state.get("onRoad") is not True:
            raise ValueError("invalid public selection state")
    except (KeyError, StopIteration, TypeError, ValueError) as error:
        result["reason"] = "incomplete_selection_or_native_truth:" + str(error)
        return result
    # A reported choice must correspond to the public snapshot at that exact tick.
    bound = [item for item in record.get("inputs", []) if item.get("type") == "navigation_query"
             and item.get("method") == "odometry" and item.get("tick") == snapshot.get("tick")
             and item.get("result") == odo]
    if not bound:
        result["reason"] = "selection_odometry_not_bound_to_exact_native_query"
        return result
    if not any(item.get("type") == "navigation_query" and item.get("method") == "road_state"
               and item.get("tick") == snapshot.get("tick") and item.get("result") == state
               for item in record.get("inputs", [])):
        result["reason"] = "selection_road_state_not_bound_to_exact_native_query"
        return result
    graphs = [item.get("result", {}) for item in record.get("inputs", [])
              if item.get("type") == "navigation_query" and item.get("method") == "map_graph"
              and item.get("tick", 0) <= snapshot.get("tick", 0)]
    logged_edges = snapshot["graph"]["edges"]
    if (len(edges) != len(logged_edges) or not any(
            len(graph.get("edges", [])) == len(edges)
            and {item["roadId"]: item for item in graph.get("edges", [])} == edges for graph in graphs)):
        result["reason"] = "selection_graph_not_bound_to_complete_native_query"
        return result
    road_by_id = {road.get("id"): road for road in roads}
    if not set(edges) <= set(road_by_id):
        result["reason"] = "native_truth_geometry_missing_public_edges"
        return result
    # Public lengths are rounded to 0.1cm by the platform. Check the fixed world
    # conversion against every actual native polyline, not a single assumed road.
    conversion_checks = []
    for rid, edge in edges.items():
        points = road_by_id[rid].get("points", [])
        true_length_cm = sum(math.dist(a, b) for a, b in zip(points, points[1:])) * 100 / UNITS_PER_METRE
        error = abs(true_length_cm - edge["lengthCm"])
        conversion_checks.append({"roadId": rid, "native_geometry_length_cm": true_length_cm,
                                  "public_length_cm": edge["lengthCm"], "rounding_difference_cm": error})
        if len(points) < 2 or error > .05 + 1e-9:
            result["reason"] = "native_geometry_and_public_length_units_disagree"
            return result
    result["support"]["units_verified_on_all_public_roads"] = conversion_checks
    costs = _all_pairs(edges)
    association = []
    for package in packages:
        x, z = _to_odometry(package, initial)
        association.append((math.hypot(selected["x"] - x, selected["z"] - z) * 100, package["id"]))
        heading = -math.degrees(math.atan2(x - odo["rightCm"] / 100, z - odo["forwardCm"] / 100))
        turn = _shortest_turn(odo["headingDeg"], heading)
        projections = _projections(package, roads, edges)
        options = []
        for projection in projections:
            for route in _enumerate_routes(state, projection, edges, costs):
                options.append({"projection": projection, **route, "cost_cm": route["distance_cm"] + k * abs(turn)})
        best = min(options, key=lambda item: item["cost_cm"]) if options else None
        result["candidates"].append({"package_id": package["id"], "true_position_odometry_m": [x, z],
                                     "true_initial_turn_deg": turn, "options": options, "best": best})
    result["wm_truth_distances_cm"] = [{"distance_cm": distance, "package_id": pid} for distance, pid in sorted(association)]
    matches = [pid for distance, pid in association if distance <= 30 or math.isclose(distance, 30, abs_tol=1e-9, rel_tol=0)]
    if not all(item["best"] for item in result["candidates"]):
        result["reason"] = "true_candidate_has_no_legal_public_graph_route"
        return result
    minimum = min(item["best"]["cost_cm"] for item in result["candidates"])
    result["optimal_package_ids"] = [item["package_id"] for item in result["candidates"]
                                      if math.isclose(item["best"]["cost_cm"], minimum, abs_tol=1e-9, rel_tol=0)]
    result["evaluated"] = True
    if len(matches) != 1:
        result["reason"] = "selected_track_unmatched_over_30cm" if not matches else "selected_track_ambiguous_within_30cm"
        return result
    result["selected_package_id"] = matches[0]
    result["match"] = matches[0] in result["optimal_package_ids"]
    result["reason"] = "matches_offline_minimum" if result["match"] else "selected_true_target_cost_exceeds_offline_minimum"
    return result
