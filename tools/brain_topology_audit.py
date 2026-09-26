"""Stage-two topology evaluation. Truth stays exclusively in this module.

Brain node labels and completed booleans are claims, not evidence. Public log
joins and full motion windows are checked independently of RoadMemory; the
entire native endpoint graph is then checked for omissions and false merges.
"""
from __future__ import annotations

from collections import Counter, defaultdict
import math
from urllib.parse import quote

from tools.brain_evidence_audit import number, unique_index, frame

SCHEMA = "brain-topology-audit/v1"
ROAD_SCHEMA = "brain-road-evidence/v1"
EXPLORATION_SCHEMA = "brain-road-exploration/v1"
STATES = ("unexplored", "exploring", "verified", "blocked", "unresolved")
EPS = 1e-9  # Frozen platform geometry epsilon, not an acceptance slack.
# Exact capture pose avoids widening road boundaries for rounded record samples.
ANGLE_QUANTIZATION_DEG = .05 + EPS
DEFINITION = {
    "numerator": "all canonical semantic endpoint-node identities, including unresolved; excludes proved aliases and breadcrumbs",
    "denominator": "all ruleDefinition.roads start/end endpoint groups using JS six-decimal rounding, including degrees 1/2/3+ and zero-outgoing terminals",
    "maximum_node_ratio": 1.2,
    "coverage": "all native nodes and all legal directed road exits; no reachable-subset substitution",
    "alias_rule": "public continuous-node or completed-path structural-revisit evidence, corroborated against native endpoint identity",
    "reverse_rule": "a fresh reverse exit is availability only; completion needs its own outward traversal",
    "native_pose_precision": {"coordinate_decimals": 6, "heading_radian_decimals": 4},
    "public_angle_quantization_bound_deg": ANGLE_QUANTIZATION_DEG,
}


def wrap(deg):
    return (deg + 180) % 360 - 180


def js_round(value, digits=6):
    scale = 10 ** digits
    return math.floor(value * scale + .5) / scale


def endpoint_key(point):
    return tuple(js_round(value, 6) for value in point)


def heading(vector):
    return math.degrees(math.atan2(-vector[0], -vector[1]))


def projection(point, points):
    best, cumulative = None, 0.
    for index, (a, b) in enumerate(zip(points, points[1:])):
        dx, dz = b[0] - a[0], b[1] - a[1]
        length_sq = dx * dx + dz * dz
        length = math.sqrt(length_sq)
        t = 0. if length_sq <= EPS else min(1., max(0., ((point[0]-a[0])*dx + (point[1]-a[1])*dz) / length_sq))
        closest = (a[0] + t * dx, a[1] + t * dz)
        candidate = {"distance": math.dist(point, closest), "progress": cumulative + t * length,
            "segment": index, "tangent": (dx / length, dz / length) if length_sq > EPS else (0., 0.)}
        if best is None or candidate["distance"] < best["distance"]:
            best = candidate
        cumulative += length
    return best


def truth_graph(native):
    rules, definition = native.get("ruleDefinition", {}), native.get("navigationDefinition", {})
    if (definition.get("schemaVersion") != "chenlong.navigation/v6"
            or definition.get("roadTopology", {}).get("endpointSnapDigits") != 6):
        raise ValueError("unsupported_native_navigation_definition")
    scale = rules.get("unitsPerMeter")
    if not number(scale) or scale <= 0:
        raise ValueError("native_units_per_meter_unavailable")
    roads = rules.get("roads")
    if not isinstance(roads, list) or not roads:
        raise ValueError("native_endpoint_roads_unavailable")
    radius_cm = rules.get("navigationJunctionRadiusCm", definition["roadTopology"].get("junctionRadiusCm"))
    if not number(radius_cm) or radius_cm <= 0 or not number(rules.get("vehicleRadius", 0)):
        raise ValueError("native_road_radius_unavailable")
    edges, groups = {}, defaultdict(list)
    for road in roads:
        rid, points = road.get("id"), road.get("points")
        if (not isinstance(rid, str) or not rid or rid in edges or not isinstance(points, list) or len(points) < 2
                or any(not isinstance(p, list) or len(p) != 2 or not all(number(v) for v in p) for p in points)
                or not number(road.get("width")) or road["width"] <= 0):
            raise ValueError("native_road_geometry_invalid")
        ends = [endpoint_key(points[0]), endpoint_key(points[-1])]
        length = sum(math.dist(a, b) for a, b in zip(points, points[1:]))
        if ends[0] == ends[1] or length <= EPS:
            raise ValueError("native_snapped_self_loop_or_zero_road")
        tangents = []
        for ordered in (points, list(reversed(points))):
            p = ordered[0]
            q = next(q for q in ordered[1:] if math.dist(p, q) > EPS)
            tangents.append(((q[0]-p[0])/math.dist(p,q), (q[1]-p[1])/math.dist(p,q)))
        edges[rid] = {"id": rid, "points": points, "ends": ends, "tangents": tangents,
            "length": length, "clearance": road["width"] / 2 - max(0, rules.get("vehicleRadius", 0)),
            "one_way": bool(road.get("oneWay", False))}
        for side in (0, 1):
            groups[ends[side]].append((rid, side, points[0 if side == 0 else -1]))
    node_ids = {key: "truth-node-" + str(i + 1) for i, key in enumerate(sorted(groups))}
    nodes = {}
    for key, endpoints in groups.items():
        outgoing = [(rid, side) for rid, side, _ in endpoints if side == 0 or not edges[rid]["one_way"]]
        first = min(endpoints, key=lambda row: (row[0], "start" if row[1] == 0 else "end"))
        nodes[node_ids[key]] = {"key": key, "point": tuple(sum(p[axis] for _, _, p in endpoints)/len(endpoints) for axis in (0,1)),
            "endpoints": [(rid, side) for rid, side, _ in endpoints], "outgoing": outgoing,
            "platform_order_key": "node:" + quote(first[0], safe="~()*!.'-") + (":start" if first[1] == 0 else ":end")}
    for edge in edges.values():
        edge["nodes"] = [node_ids[key] for key in edge["ends"]]
    return {"nodes": nodes, "edges": edges, "scale": scale, "radius": radius_cm * scale / 100}


def native_context(graph, pose):
    """Independent reproduction of the frozen public road/node projection.

    Node candidates are constrained to the selected road, facing direction and
    native node radius; global nearest-node matching is never used.
    """
    point, forward = (pose["x"], pose["z"]), (-math.sin(pose["heading"]), -math.cos(pose["heading"]))
    matches = []
    for rid, edge in graph["edges"].items():
        hit = projection(point, edge["points"])
        tangent = hit["tangent"]
        if not edge["one_way"] and sum(a*b for a,b in zip(tangent,forward)) < 0:
            tangent = (-tangent[0], -tangent[1])
        hit.update(road_id=rid, on_road=hit["distance"] <= edge["clearance"] + EPS,
                   heading_error=wrap(heading(tangent) - math.degrees(pose["heading"])))
        matches.append(hit)
    eligible = [m for m in matches if m["on_road"]]
    if not eligible:
        return {"on_road": False, "node_id": None, "exits": []}
    selected = min(eligible, key=lambda m: (abs(m["heading_error"]), m["distance"], m["road_id"]))
    edge = graph["edges"][selected["road_id"]]
    candidates = []
    for side, nid in enumerate(edge["nodes"]):
        node = graph["nodes"][nid]
        gap = math.dist(point, node["point"])
        ahead = sum(a*b for a,b in zip(edge["tangents"][side],forward)) < -EPS
        if gap <= graph["radius"] + EPS:
            candidates.append((not ahead, gap, node["platform_order_key"], nid))
    nid = min(candidates)[3] if candidates else None
    exits = []
    if nid is not None:
        for rid, side in graph["nodes"][nid]["outgoing"]:
            exits.append({"key": (rid, side), "angle_deg": wrap(heading(graph["edges"][rid]["tangents"][side])
                        - math.degrees(pose["heading"]))})
    return {**selected, "node_id": nid, "exits": exits}


def audit_topology(summary, observations, motions, record, bridge, captures=None):
    """Malformed or unsupported evidence fails closed and remains reportable."""
    try:
        return _audit_topology(summary, observations, motions, record, bridge, captures)
    except (KeyError, TypeError, ValueError, AttributeError, IndexError, OverflowError) as exc:
        return {"schema": SCHEMA, "evaluation_only": True, "definition": DEFINITION,
                "supported": False, "complete": False,
                "failures": ["stage2_topology_evidence_malformed"],
                "issues": [{"reason": "stage2_topology_evidence_malformed", "detail": type(exc).__name__}]}


def _audit_topology(summary, observations, motions, record, bridge, captures):
    failures, issues = [], []
    def fail(reason, **detail):
        failures.append(reason)
        issues.append({"reason": reason, **detail})
    evidence = summary.get("road_evidence") or {}
    result = {"schema": SCHEMA, "evaluation_only": True, "definition": DEFINITION,
              "supported": False, "complete": False, "failures": failures, "issues": issues}
    if evidence.get("schema") != ROAD_SCHEMA:
        fail("stage2_road_evidence_missing_or_unsupported")
        return result
    try:
        graph = truth_graph(record.get("native", {}))
    except (KeyError, TypeError, ValueError, StopIteration) as exc:
        fail("stage2_truth_topology_unavailable", detail=str(exc))
        return result
    result["supported"] = True
    if not isinstance(captures,list) or not captures:
        fail("topology_exact_capture_poses_missing")
        return result
    capture_by_frame=unique_index(captures,lambda c: str(c["frameId"]) if c.get("frameId") is not None else None,
                                 failures,"topology_capture_frame")
    origins={tuple(c.get("odometryOrigin",{}).get(k) for k in ("x","z","heading")) for c in captures}
    if len(origins)!=1:
        fail("topology_capture_odometry_origin_inconsistent")
    by_index = unique_index(observations, lambda o: o.get("observation_index"), failures, "topology_observation_index")
    unique_index(observations, frame, failures, "topology_observation_frame")
    if [o.get("observation_index") for o in observations] != list(range(1, len(observations)+1)):
        fail("topology_observation_sequence_incomplete")
    nodes = unique_index(evidence.get("nodes", []), lambda n: n.get("id"), failures, "topology_node_id")
    anchors = unique_index(evidence.get("anchors", []), lambda a: a.get("observation_index"), failures, "topology_anchor_index")
    exits = unique_index(evidence.get("exits", []), lambda e: e.get("id"), failures, "topology_exit_id")
    trips = unique_index(evidence.get("traversals", []), lambda t: t.get("id"), failures, "topology_traversal_id")
    pairs = unique_index(motions, lambda m: (m.get("before_observation"), m.get("after_observation")), failures, "topology_motion_window")
    if any(type(a) is not int or type(b) is not int or b != a + 1 or a not in by_index or b not in by_index for a,b in pairs):
        fail("topology_motion_indices_invalid")
        return result
    observed_calls, sensors = {}, {}
    for i, call in enumerate(bridge):
        method, terminal = call.get("request", {}).get("method"), call.get("terminal", {})
        if terminal.get("status") != "completed":
            continue
        if method in {"odometry", "local_road", "holding"}:
            sensors[method] = terminal.get("result")
        elif method == "observe":
            raw = terminal.get("result") or {}
            fid = str(raw.get("frameId"))
            if fid in observed_calls:
                fail("topology_bridge_frame_duplicate", frame_id=fid)
            observed_calls[fid] = {"index": i, "observation": raw, **sensors}
            sensors = {}
    samples = defaultdict(list)
    for sample in record.get("native", {}).get("samples", []):
        samples[sample.get("tick")].append(sample)
    contexts, native_poses = {}, {}
    for index, observation in by_index.items():
        raw = observed_calls.get(frame(observation), {})
        if any(raw.get(a) != observation.get(b) for a,b in (("observation","observation"),
                ("odometry","odometry"),("local_road","road"),("holding","holding"))):
            fail("topology_public_snapshot_not_corroborated", observation_index=index)
        tick = observation.get("observation", {}).get("tick")
        capture=capture_by_frame.get(frame(observation),{})
        pose=capture.get("robotWorldPose",{})
        origin=capture.get("odometryOrigin",{})
        if (capture.get("tick")!=tick or not all(number(pose.get(k)) and number(origin.get(k)) for k in ("x","z","heading"))
                or capture.get("worldUnitsToMeters") != 1/graph["scale"]):
            fail("topology_exact_capture_pose_missing_or_conflicting", observation_index=index)
            continue
        for sample in samples[tick]:
            if any(not number(sample.get(k)) or abs(sample[k]-js_round(pose[k],4 if k=="heading" else 6))>EPS for k in ("x","z","heading")):
                fail("topology_native_sample_capture_pose_conflict",observation_index=index)
        dx,dz=pose["x"]-origin["x"],pose["z"]-origin["z"]
        initial=origin["heading"]
        expected_odo={"rightCm":js_round((dx*math.cos(initial)-dz*math.sin(initial))*100/graph["scale"],1),
            "forwardCm":js_round((-dx*math.sin(initial)-dz*math.cos(initial))*100/graph["scale"],1),
            "headingDeg":js_round(wrap(math.degrees(pose["heading"]-initial)),1)}
        if any(not number(observation.get("odometry",{}).get(k)) or abs(observation["odometry"][k]-v)>EPS for k,v in expected_odo.items()):
            fail("topology_capture_odometry_projection_mismatch",observation_index=index)
        native_poses[index] = pose
        context = native_context(graph, pose)
        contexts[index] = context
        road = observation.get("road", {})
        if (road.get("tick") != tick or observation.get("odometry", {}).get("tick") != tick
                or road.get("onRoad") is not context["on_road"]
                or road.get("atNode") is not (context["node_id"] is not None)):
            fail("topology_public_native_context_mismatch", observation_index=index)
        raw_exits = road.get("exits", [])
        matched = []
        for e in raw_exits:
            choices = [t["key"] for t in context["exits"] if number(e.get("angleDeg"))
                       and abs(wrap(e["angleDeg"] - t["angle_deg"])) <= ANGLE_QUANTIZATION_DEG]
            if len(choices) != 1:
                fail("topology_exit_truth_correspondence_unresolved", observation_index=index)
            matched.extend(choices if len(choices) == 1 else [])
        if len(matched) != len(context["exits"]) or len(set(matched)) != len(matched):
            fail("topology_observed_exit_set_mismatch", observation_index=index)
        context["raw_exit_keys"] = dict(zip((e.get("angleDeg") for e in raw_exits), matched)) if len(matched)==len(raw_exits) else {}
    expected_anchor_indices = {i for i,o in by_index.items() if o.get("road", {}).get("atNode") is True}
    if set(anchors) != expected_anchor_indices:
        fail("topology_anchor_coverage_incomplete", missing=sorted(expected_anchor_indices-set(anchors)), extra=sorted(set(anchors)-expected_anchor_indices))
    canonical = {}
    for nid, node in nodes.items():
        seen, current = set(), nid
        while current in nodes and current not in seen:
            seen.add(current)
            parent = nodes[current].get("canonical_id")
            if parent == current:
                canonical[nid] = current
                break
            current = parent
        if nid not in canonical:
            fail("topology_alias_cycle_or_missing_target", node_id=nid)
    node_truth, exit_truth, anchor_truth = defaultdict(set), defaultdict(set), {}
    for index, anchor in anchors.items():
        nid, o, context = anchor.get("node_id"), by_index.get(index, {}), contexts.get(index, {})
        if nid not in canonical or anchor.get("candidate_ids") or context.get("node_id") is None:
            fail("topology_anchor_identity_unresolved", observation_index=index)
            continue
        cid = canonical[nid]
        odo = o.get("odometry", {})
        if (anchor.get("position_m") != [odo.get("rightCm", float("nan"))/100, odo.get("forwardCm", float("nan"))/100]
                or anchor.get("heading_deg") != odo.get("headingDeg")):
            fail("topology_anchor_pose_not_corroborated", observation_index=index)
        node_truth[cid].add(context["node_id"])
        anchor_truth[index] = context["node_id"]
        bound = anchor.get("exit_bindings", [])
        if len(bound) != len(o["road"].get("exits", [])):
            fail("topology_anchor_exit_bindings_missing", observation_index=index)
        angles, bound_ids = [], []
        for binding in bound:
            eid, angle = binding.get("exit_id"), binding.get("raw_angle_deg")
            if (eid not in exits or canonical.get(exits[eid].get("node_id")) != cid
                    or angle not in context.get("raw_exit_keys", {})):
                fail("topology_anchor_exit_binding_invalid", observation_index=index)
                continue
            angles.append(angle); bound_ids.append(eid)
            exit_truth[eid].add(context["raw_exit_keys"][angle])
        if len(set(angles)) != len(angles) or len(set(bound_ids)) != len(bound_ids):
            fail("topology_anchor_exit_binding_not_bijective", observation_index=index)
    # One physical node may have several brain hypotheses, but one canonical
    # identity must never merge separate physical endpoints.
    false_merges = {nid: sorted(ids) for nid,ids in node_truth.items() if len(ids)>1}
    if false_merges:
        fail("topology_false_node_merge", nodes=sorted(false_merges))
    for eid, identities in exit_truth.items():
        if len(identities) != 1:
            fail("topology_false_exit_merge", exit_id=eid)

    def window_refs(first, last, refs, *, identity=False, nonroad=False):
        if type(first) is not int or type(last) is not int or first >= last or any(i not in by_index for i in range(first,last+1)):
            return False, "topology_motion_window_incomplete"
        expected = {(a,b) for a,b in pairs if first <= a < b <= last}
        keys = [(r.get("before_observation"), r.get("after_observation")) for r in refs]
        if len(keys)!=len(set(keys)) or set(keys)!=expected:
            return False, "topology_motion_references_mismatch"
        for index in range(first,last):
            left, right = by_index[index], by_index[index+1]
            if not nonroad and any(row.get("road", {}).get("onRoad") is not True for row in (left,right)):
                return False, "topology_traversal_off_road"
            a,b=left.get("odometry",{}),right.get("odometry",{})
            fields=("rightCm","forwardCm","headingDeg","distanceCm","tick")
            if not all(number(row.get(k)) for row in (a,b) for k in fields):
                return False,"topology_motion_sensor_missing"
            travel=b["distanceCm"]-a["distanceCm"]
            displacement=math.hypot(b["rightCm"]-a["rightCm"],b["forwardCm"]-a["forwardCm"])
            if travel < 0 or b["tick"]<a["tick"] or displacement>travel+.2:
                return False,"topology_motion_not_observed"
            motion=pairs.get((index,index+1))
            if motion is None:
                if any(a[k]!=b[k] for k in fields):
                    return False,"topology_unaccounted_motion"
                continue
            method, outcome=motion.get("method"),motion.get("actuator_result",{})
            stationary_manipulation = identity and method in {"grab", "release"}
            if (not stationary_manipulation and left.get("holding",{}).get("holding") is not right.get("holding",{}).get("holding")
                    or any(type(row.get("holding",{}).get("holding")) is not bool for row in (left,right))):
                return False,"topology_holding_changed_during_traversal"
            allowed = {"turn","forward","backward"} if nonroad else {"turn","forward","backward","take_exit","follow_road"}
            if identity: allowed |= {"grab", "release"}
            if (method not in allowed
                    or outcome.get("stoppedBy") in {"collision","front_clearance","off_road","wrong_way"}
                    or outcome.get("accepted") is False or outcome.get("error")
                    or (outcome.get("completed") is not True if method in {"turn","forward","backward"}
                        else not stationary_manipulation and outcome.get("accepted") is not True)):
                return False,"topology_actuator_outcome_invalid"
            if stationary_manipulation and (travel != 0 or displacement > .2 or abs(wrap(b["headingDeg"]-a["headingDeg"])) > .2):
                return False,"topology_manipulation_is_not_stationary"
            if method == "turn":
                angle = motion.get("params",{}).get("angleDeg")
                if (not number(angle) or abs(wrap(b["headingDeg"]-a["headingDeg"]-angle)) > .2 or displacement > .2
                        or abs(angle)>.2 and b["tick"]<=a["tick"]):
                    return False,"topology_turn_effect_not_observed"
            if method in {"forward", "backward"}:
                request = motion.get("params",{}).get("distanceCm")
                theta=math.radians(a["headingDeg"])
                dx,dz=b["rightCm"]-a["rightCm"],b["forwardCm"]-a["forwardCm"]
                along=(-math.sin(theta)*dx+math.cos(theta)*dz)*(1 if method=="forward" else -1)
                if (not number(request) or abs(along-request) > .2 or abs(math.cos(theta)*dx+math.sin(theta)*dz) > .2
                        or abs(wrap(b["headingDeg"]-a["headingDeg"])) > .2):
                    return False,"topology_basic_translation_effect_not_observed"
            if method in {"take_exit","follow_road","forward","backward"} and (travel<=0 or displacement<.2):
                return False,"topology_translation_not_observed"
            start_call,end_call=observed_calls.get(frame(left),{}),observed_calls.get(frame(right),{})
            if "index" not in start_call or "index" not in end_call:
                return False,"topology_bridge_motion_boundary_missing"
            matching=[c for c in bridge[start_call["index"]+1:end_call["index"]]
                if c.get("request",{}).get("method")==method and c["request"].get("params")==motion.get("params")
                and c.get("terminal",{}).get("status")=="completed" and c["terminal"].get("result")==outcome]
            if len(matching)!=1:
                return False,"topology_motion_not_corroborated_by_bridge"
        return True,None

    verified_trips, covered = {}, set()
    for tid, trip in trips.items():
        dep,arr=trip.get("departure",{}),trip.get("arrival",{})
        first,last=trip.get("first_observation"),trip.get("last_observation")
        good,reason=window_refs(first,last,trip.get("motion_refs",[]))
        if not good:
            fail(reason,traversal_id=tid); continue
        eid,angle=dep.get("exit_id"),dep.get("raw_angle")
        if (dep.get("observation_index")!=first or arr.get("observation_index")!=last
                or first not in anchors or last not in anchors or len(exit_truth.get(eid,set()))!=1
                or not any(b.get("exit_id")==eid and b.get("raw_angle_deg")==angle for b in anchors[first].get("exit_bindings",[]))
                or canonical.get(arr.get("node_id"))!=canonical.get(anchors[last].get("node_id"))):
            fail("topology_traversal_endpoint_reference_invalid",traversal_id=tid); continue
        selected=next(iter(exit_truth[eid])); edge=graph["edges"][selected[0]]; side=selected[1]
        if (anchor_truth.get(first)!=edge["nodes"][side] or anchor_truth.get(last)!=edge["nodes"][1-side]
                or trip.get("reverse_availability_only") is True):
            fail("topology_traversal_does_not_cover_selected_road",traversal_id=tid);continue
        moves=[pairs[(ref["before_observation"],ref["after_observation"])] for ref in trip.get("motion_refs",[])]
        if (not moves or moves[0].get("method")!="take_exit" or moves[0].get("before_observation")!=first
                or moves[0].get("params",{}).get("angleDeg")!=angle
                or any(m.get("method")=="take_exit" for m in moves[1:])):
            fail("topology_fresh_departure_selection_missing",traversal_id=tid);continue
        if any(anchor_truth.get(i) not in {None,anchor_truth.get(first)} for i in range(first+1,last)):
            fail("topology_earlier_node_arrival_not_split",traversal_id=tid);continue
        poses=[native_poses.get(i) for i in range(first,last+1)]
        first_tick=by_index[first]["observation"]["tick"]
        last_tick=by_index[last]["observation"]["tick"]
        native_window=[row for tick, rows in samples.items() if number(tick) and first_tick <= tick <= last_tick for row in rows]
        if (any(p is None or not all(number(p.get(k)) for k in ("x","z"))
                or projection((p["x"],p["z"]),edge["points"])["distance"]>edge["clearance"]+EPS for p in poses)
                or any(not all(number(p.get(k)) for k in ("x","z"))
                or projection((p["x"],p["z"]),edge["points"])["distance"]>edge["clearance"]+math.sqrt(2)*.0000005+EPS for p in native_window)):
            fail("topology_traversal_left_selected_native_road",traversal_id=tid);continue
        progresses=[projection((p["x"],p["z"]),edge["points"])["progress"] for p in poses]
        if (progresses[-1]-progresses[0])*(1 if side==0 else -1)<=EPS:
            fail("topology_traversal_progress_not_observed",traversal_id=tid);continue
        verified_trips[tid]=selected;covered.add(selected)

    # Re-evaluate each public proof independently; retained alias labels alone
    # can never shrink the node denominator or retire a road obligation.
    valid_nonroad_returns=[]
    def alias_proof_valid(proof,cid,anchor_indices=None):
        a,b=proof.get("from_observation"),proof.get("to_observation")
        first,last=proof.get("first_observation"),proof.get("last_observation")
        kind=proof.get("kind")
        valid=False
        if (a not in anchor_truth or b not in anchor_truth or anchor_truth[a]!=anchor_truth[b]
                or type(first) is not int or type(last) is not int or not a<b==last or first>=last
                or kind != "route_endpoint_revisit" and first>a or (anchor_indices is not None and b not in anchor_indices)
                or canonical.get(anchors[a].get("node_id"))!=cid or canonical.get(anchors[b].get("node_id"))!=cid):
            return False
        oa,ob=by_index[a]["odometry"],by_index[b]["odometry"]
        ha=[wrap(oa["headingDeg"]+e["angleDeg"]) for e in by_index[a]["road"].get("exits",[])]
        hb=[wrap(ob["headingDeg"]+e["angleDeg"]) for e in by_index[b]["road"].get("exits",[])]
        if (len(ha)!=len(hb) or any(sum(abs(wrap(x-y))<=5 for y in hb)!=1 for x in ha)
                or any(sum(abs(wrap(x-y))<=5 for x in ha)!=1 for y in hb)):
            return False
        good,_=window_refs(first,last,proof.get("motion_refs",[]),identity=True,nonroad=kind=="observed_nonroad_return")
        if not good: return False
        if kind=="continuous_node_episode":
            valid=all(anchor_truth.get(i)==anchor_truth[a] for i in range(first,last+1))
        elif kind=="structural_revisit":
            tids=proof.get("traversal_ids",[])
            valid=bool(tids) and all(t in verified_trips for t in tids)
            if valid:
                sequence=[trips[t] for t in tids]
                valid=(sequence[0]["first_observation"]>=first and sequence[-1]["last_observation"]<=last
                    and anchor_truth.get(sequence[0]["first_observation"])==anchor_truth[a]
                    and anchor_truth.get(sequence[-1]["last_observation"])==anchor_truth[b]
                    and len(tids)==len(set(tids))
                    and all(left["last_observation"]<=right["first_observation"]
                            and anchor_truth.get(left["last_observation"])==anchor_truth.get(right["first_observation"])
                            for left,right in zip(sequence,sequence[1:])))
        elif kind=="route_endpoint_revisit":
            current=[t for t in verified_trips if trips[t]["first_observation"]==first and trips[t]["last_observation"]==last]
            previous=proof.get("traversal_ids",[])
            valid=bool(current and previous) and all(t in verified_trips and trips[t]["last_observation"]<first for t in previous)
            if valid:
                current_key=verified_trips[current[0]]
                gap=math.hypot(oa["rightCm"]-ob["rightCm"],oa["forwardCm"]-ob["forwardCm"])
                valid=gap<15 and all(verified_trips[t][0]==current_key[0] for t in previous)
                start=by_index[first]["odometry"]
                for tid in previous:
                    old=trips[tid]
                    oldstart=old["first_observation"] if verified_trips[tid]==current_key else old["last_observation"]
                    oldend=old["last_observation"] if verified_trips[tid]==current_key else old["first_observation"]
                    old_odo=by_index[oldstart]["odometry"]
                    start_gap=math.hypot(start["rightCm"]-old_odo["rightCm"],start["forwardCm"]-old_odo["forwardCm"])
                    oldtravel=by_index[old["last_observation"]]["odometry"]["distanceCm"]-by_index[old["first_observation"]]["odometry"]["distanceCm"]
                    valid=valid and anchor_truth[oldend]==anchor_truth[a] and abs((ob["distanceCm"]-start["distanceCm"])-oldtravel)<=start_gap+gap+.2
        elif kind=="observed_anchor_return":
            valid=(first==a and oa["rightCm"]==ob["rightCm"] and oa["forwardCm"]==ob["forwardCm"]
                and ob["distanceCm"]>oa["distanceCm"] and not proof.get("traversal_ids")
                and all(pairs[(r["before_observation"],r["after_observation"])]["method"] in {"forward","backward","turn"}
                    for r in proof.get("motion_refs",[])))
        elif kind=="observed_nonroad_return":
            valid=(first==a and math.hypot(ob["rightCm"]-oa["rightCm"],ob["forwardCm"]-oa["forwardCm"])<=.2
                and abs(wrap(ob["headingDeg"]-oa["headingDeg"]))<=.2
                and any(by_index[i]["road"].get("onRoad") is False for i in range(first+1,last))
                and ob["distanceCm"]>oa["distanceCm"])
            if valid:
                valid_nonroad_returns.append(proof)
        return valid

    resolutions=unique_index(evidence.get("identity_resolutions",[]),lambda r:r.get("id"),failures,"topology_identity_resolution_id")
    exit_aliases=unique_index(evidence.get("exit_aliases",[]),lambda r:r.get("id"),failures,"topology_exit_alias_id")
    valid_resolutions=set()
    for rid,resolution in resolutions.items():
        old_id,cid=resolution.get("from_node_id"),resolution.get("canonical_node_id")
        proof=resolution.get("proof",{});before=resolution.get("before",{})
        old_nodes={n.get("id"):n for n in before.get("nodes",[])}
        old_anchors={a.get("observation_index"):a for a in before.get("anchors",[])}
        old_exits={e.get("id"):e for e in before.get("exits",[])}
        old_trips={t.get("id"):t for t in before.get("traversals",[])}
        indices=resolution.get("anchor_indices",[]);mapping=resolution.get("exit_id_map",{})
        first,last=proof.get("first_observation"),proof.get("last_observation")
        route=proof.get("route_revisit_proof",{})
        current=[t for t in verified_trips if trips[t]["first_observation"]==route.get("first_observation")
                 and trips[t]["last_observation"]==route.get("last_observation")]
        valid=(resolution.get("rule")=="completed_route_revisit_resolves_old_exact_anchor"
            and old_id in old_nodes and old_id in nodes and cid in nodes and cid!=old_id
            and canonical.get(old_id)==cid and canonical.get(cid)==cid and nodes[cid].get("status")=="confirmed"
            and old_nodes[old_id].get("status")=="unresolved" and old_nodes[old_id].get("canonical_id")==old_id
            and proof.get("kind")=="retrospective_route_identity_resolution" and proof.get("resolution_id")==rid
            and bool(indices) and len(indices)==len(set(indices)) and set(indices)==set(old_anchors)
            and set(indices)==set(old_nodes[old_id].get("anchor_indices",[]))
            and first==min(indices) and proof.get("from_observation")==first and proof.get("to_observation")==last
            and last in anchors and first<last and canonical.get(anchors[last]["node_id"])==cid
            and route.get("kind")=="route_endpoint_revisit" and route.get("last_observation")==last
            and alias_proof_valid(route,cid) and len(current)==1
            and proof.get("traversal_ids")==route.get("traversal_ids",[])+current
            and proof in nodes[old_id].get("merge_evidence_refs",[]) and proof in nodes[cid].get("merge_evidence_refs",[])
            and {"status":"unresolved","canonical_id":old_id,"resolution_id":rid} in nodes[old_id].get("identity_history",[])
            and all(n in nodes and canonical.get(n)==cid and original.get("canonical_id")==old_id for n,original in old_nodes.items()))
        if valid:
            valid=window_refs(first,last,proof.get("motion_refs",[]),identity=True)[0]
        if valid:
            valid=(any(cid in a.get("candidate_ids",[]) for a in old_anchors.values())
                and set(mapping)==set(old_exits) and len(set(mapping.values()))==len(mapping)
                and len(old_nodes)==len(before.get("nodes",[])) and len(old_exits)==len(before.get("exits",[]))
                and len(old_trips)==len(before.get("traversals",[])))
        for index,original in old_anchors.items():
            after=anchors.get(index,{})
            original_bindings=original.get("exit_bindings",[])
            remapped=[dict(binding,exit_id=mapping.get(binding.get("exit_id"),binding.get("exit_id"))) for binding in original_bindings]
            history={"node_id":original.get("node_id"),"candidate_ids":original.get("candidate_ids"),
                     "exit_bindings":original_bindings,"resolution_id":rid}
            valid=valid and (original.get("node_id") in old_nodes and original.get("valid") is True
                and original.get("position_m")==anchors[last].get("position_m")==after.get("position_m")
                and anchor_truth.get(index)==anchor_truth.get(last) and original.get("heading_deg")==after.get("heading_deg")
                and original.get("fresh_headings_deg")==after.get("fresh_headings_deg")
                and history in after.get("identity_history",[]) and remapped==after.get("exit_bindings"))
        for eid,original in old_exits.items():
            target=exits.get(mapping.get(eid),{})
            valid=valid and (eid not in exits and original.get("node_id") in old_nodes and target.get("node_id")==cid
                and abs(wrap(original.get("heading_deg",math.inf)-target.get("heading_deg",math.inf)))<=5
                and set(original.get("observation_refs",[]))=={i for i,a in old_anchors.items()
                    if any(b.get("exit_id")==eid for b in a.get("exit_bindings",[]))}
                and set(original.get("observation_refs",[]))<=set(target.get("observation_refs",[]))
                and set(original.get("completion_traversal_ids",[]))<=set(target.get("completion_traversal_ids",[]))
                and exit_aliases.get(eid)=={"id":eid,"canonical_exit_id":mapping[eid],"resolution_id":rid})
        affected={tid for tid,t in trips.items() if t["last_observation"]<=last and
                  any(t[side].get("observation_index") in old_anchors for side in ("departure","arrival"))}
        valid=valid and set(old_trips)==affected
        for tid,original in old_trips.items():
            expected={**original,"departure":dict(original.get("departure",{})),"arrival":dict(original.get("arrival",{}))}
            for side in ("departure","arrival"):
                if expected[side].get("node_id") in old_nodes:expected[side]["node_id"]=cid
            expected["departure"]["exit_id"]=mapping.get(expected["departure"].get("exit_id"),expected["departure"].get("exit_id"))
            valid=valid and (tid in verified_trips and expected==trips.get(tid)
                and {original.get("departure",{}).get("node_id"),original.get("arrival",{}).get("node_id")}!={old_id,cid})
        if valid:valid_resolutions.add(rid)
        else:fail("topology_retrospective_identity_resolution_invalid",resolution_id=rid)
    for eid,alias in exit_aliases.items():
        if alias.get("resolution_id") not in valid_resolutions:
            fail("topology_exit_alias_resolution_invalid",exit_id=eid)

    valid_aliases=set()
    for nid,node in nodes.items():
        cid=canonical.get(nid);anchor_indices=node.get("anchor_indices",[])
        if not anchor_indices or any(i not in anchors or canonical.get(anchors[i].get("node_id"))!=cid for i in anchor_indices):
            fail("topology_node_anchor_reference_invalid",node_id=nid)
        if cid==nid:
            if node.get("status")!="confirmed":fail("topology_node_unresolved",node_id=nid)
            continue
        valid=False
        for proof in node.get("merge_evidence_refs",[]):
            if proof.get("kind")=="retrospective_route_identity_resolution":
                rid=proof.get("resolution_id");resolution=resolutions.get(rid,{})
                valid=(rid in valid_resolutions and resolution.get("from_node_id")==nid and resolution.get("canonical_node_id")==cid
                    and resolution.get("proof")==proof)
            else:valid=alias_proof_valid(proof,cid,anchor_indices)
            if valid:break
        if node.get("status")!="alias" or not valid:fail("topology_alias_merge_evidence_invalid",node_id=nid)
        else:valid_aliases.add(nid)
    for cid,node in nodes.items():
        if canonical.get(cid)!=cid:
            continue
        actual={i for i,a in anchors.items() if canonical.get(a.get("node_id"))==cid}
        retained={i for nid in valid_aliases if canonical.get(nid)==cid for i in nodes[nid]["anchor_indices"]}
        if not actual or set(node.get("anchor_indices",[]))!=actual or (actual-{min(actual)} if actual else set())-retained:
            fail("topology_canonical_anchor_merge_evidence_incomplete",node_id=cid)
    numerator=len(nodes)-len(valid_aliases)
    denominator=len(graph["nodes"])
    ratio=numerator/denominator
    true_to_brain=defaultdict(list)
    for nid,ids in node_truth.items():
        if len(ids)==1: true_to_brain[next(iter(ids))].append(nid)
    missing_nodes=sorted(set(graph["nodes"])-set(true_to_brain))
    duplicate_nodes={nid: sorted(ids) for nid,ids in true_to_brain.items() if len(ids)>1}
    if missing_nodes: fail("topology_native_nodes_missing",nodes=missing_nodes)
    if ratio>1.2: fail("topology_node_ratio_exceeded")
    all_exits={key for n in graph["nodes"].values() for key in n["outgoing"]}
    missing_exits=sorted(all_exits-covered)
    if missing_exits: fail("topology_native_directed_exits_unexplored",exits=missing_exits)
    counts=Counter({state:0 for state in STATES})
    for eid,exit in exits.items():
        refs=exit.get("observation_refs",[])
        actual=[i for i,a in anchors.items() if any(b.get("exit_id")==eid for b in a.get("exit_bindings",[]))]
        if len(refs)!=len(set(refs)) or set(refs)!=set(actual) or not actual:
            fail("topology_exit_observation_references_invalid",exit_id=eid)
        references=exit.get("completion_traversal_ids",[])
        independently_verified=bool(references) and all(t in verified_trips and len(exit_truth.get(eid,set()))==1
            and verified_trips[t]==next(iter(exit_truth[eid])) and trips[t]["departure"].get("exit_id")==eid for t in references)
        declared=exit.get("state")
        if declared not in STATES:
            fail("topology_exit_state_invalid",exit_id=eid);declared="unresolved"
        if declared=="verified" and not independently_verified:
            fail("topology_exit_completion_not_verified",exit_id=eid)
        if independently_verified and declared!="verified":
            fail("topology_exit_state_contradicts_traversal",exit_id=eid)
        state="verified" if independently_verified and declared=="verified" else (declared if declared!="verified" else "unresolved")
        counts[state]+=1
        if state!="verified": fail("topology_exit_pending",exit_id=eid,state=state)
    for item in evidence.get("unresolved",[]):
        tid=item.get("resolution_traversal_id")
        resolved=item.get("resolved") is True and tid in verified_trips
        if resolved and item.get("kind")=="connection":
            resolved=trips[tid]["departure"]["exit_id"]==item.get("exit_id")
        elif resolved and item.get("kind")=="node":
            resolved=(canonical.get(item.get("node_id"))==canonical.get(trips[tid]["arrival"]["node_id"])
                and (not item.get("resolution_identity_id") or item["resolution_identity_id"] in valid_resolutions))
        elif item.get("resolved") is True and item.get("kind")=="connection" and isinstance(item.get("resolution"),dict):
            resolution=item["resolution"]
            resolved=any(all(resolution.get(k)==proof.get(k) for k in ("kind","first_observation","last_observation","motion_refs"))
                and all(proof["first_observation"]<=i<=proof["last_observation"] for i in item.get("observation_indices",[]))
                for proof in valid_nonroad_returns)
        else:
            resolved=False
        if not resolved:
            fail("topology_unresolved_claims_remain",unresolved_id=item.get("id"))
    unresolved_nodes=sum(node.get("status")!="confirmed" for nid,node in nodes.items() if nid not in valid_aliases)
    unresolved_connections=len({issue.get("traversal_id",issue.get("exit_id",issue["reason"])) for issue in issues
        if "traversal" in issue["reason"] or "exit" in issue["reason"] or "motion" in issue["reason"]})
    exploration={"schema":EXPLORATION_SCHEMA,"complete":not failures,"pending_exit_count":sum(counts[s] for s in STATES if s!="verified"),
        "state_counts":dict(counts),"unresolved_node_count":unresolved_nodes,"unresolved_connection_count":unresolved_connections}
    declared=summary.get("exploration_state")
    if not isinstance(declared,dict) or any(declared.get(k)!=v for k,v in exploration.items()):
        fail("topology_exploration_summary_mismatch")
        exploration["complete"]=False
    result.update(complete=not failures,brain_node_count=numerator,true_node_count=denominator,node_ratio=ratio,
        missing_nodes=missing_nodes,duplicate_nodes=duplicate_nodes,false_merges=false_merges,
        missing_directed_exits=missing_exits,verified_traversal_count=len(verified_trips),
        valid_alias_count=len(valid_aliases),verified_identity_resolution_ids=sorted(valid_resolutions),exploration=exploration,
        node_truth_bindings={k:sorted(v) for k,v in node_truth.items()},
        failures=list(dict.fromkeys(failures)))
    return result
