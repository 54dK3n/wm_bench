"""Isolated, opt-in metadata/query candidate; never drives or changes v4 rules.

Only the adjacent frozen baseline is loaded. Completed trips require an explicit
public motion window; legacy update/chosen calls alone never create a trip.
"""
import copy
import heapq
import importlib.util
import math
from pathlib import Path

_spec = importlib.util.spec_from_file_location("route_candidate_baseline", Path(__file__).with_name("baseline_navigation.py"))
_base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_base)
VERSION = _base.VERSION
CANDIDATE_VERSION = "observed-directed-route-candidate/v1"
wrap, position, distance = _base.wrap, _base.position, _base.distance


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def index(value):
    return type(value) is int and value > 0


def snapshot(row):
    return {key: copy.deepcopy(row[key]) for key in ("observation_index", "odometry", "road")}


def same_context(a, b, *, exact_position=True):
    """No implied bridge between distinct positions or mixed node contexts.

    Exact position is required to concatenate trips. Frontier metadata may use
    the existing 15 cm locality gate, but explicitly reports its endpoint gap.
    Neither condition establishes physical junction identity.
    """
    if a["node_id"] != b["node_id"]:
        return False
    gap = math.dist(a["position_m"], b["position_m"])
    if (gap != 0 if exact_position else gap >= .15):
        return False
    left, right = a["fresh_headings_deg"], b["fresh_headings_deg"]
    return (len(left) == len(right) and bool(left)
            and all(sum(abs(wrap(x - y)) <= 5 for y in right) == 1 for x in left)
            and all(sum(abs(wrap(x - y)) <= 5 for x in left) == 1 for y in right))


class RoadMemory(_base.RoadMemory):
    def __init__(self):
        super().__init__()
        self._frames = {}
        self._frame_anchors = {}
        self._invalid_indices = set()
        self._latest_index = None
        self._exit_anchors = {}
        self._selections = {}
        self._trips = []

    def _anchor(self, frame):
        road, odo = frame["road"], frame["odometry"]
        if (road.get("onRoad") is not True or road.get("atNode") is not True
                or not road.get("exits")
                or not all(number(odo.get(k)) for k in ("rightCm", "forwardCm", "headingDeg", "distanceCm", "tick"))
                or not all(number(e.get("angleDeg")) for e in road["exits"])):
            return None
        node = self.current_node(odo)
        if node is None:
            return None
        return {"observation_index": frame["observation_index"], "tick": odo["tick"],
                "node_id": node["id"], "position_m": list(position(odo)),
                "heading_deg": odo["headingDeg"], "odometer_cm": odo["distanceCm"],
                "fresh_relative_exits_deg": [e["angleDeg"] for e in road["exits"]],
                "fresh_headings_deg": [wrap(odo["headingDeg"] + e["angleDeg"]) for e in road["exits"]]}

    def update(self, odo, road, observation_index=None):
        result = super().update(odo, road)
        self._latest_index = observation_index if index(observation_index) else None
        if not index(observation_index):
            return result
        frame = snapshot({"observation_index": observation_index, "odometry": odo, "road": road})
        if observation_index in self._frames and self._frames[observation_index] != frame:
            self._invalid_indices.add(observation_index)
            return result
        if observation_index in self._frames:
            return result
        self._frames[observation_index] = frame
        anchor = self._anchor(frame)
        self._frame_anchors[observation_index] = copy.deepcopy(anchor)
        if anchor is not None:
            node = self.current_node(odo)
            for heading in anchor["fresh_headings_deg"]:
                matched = [i for i, e in enumerate(node["exits"]) if abs(wrap(e["heading_deg"] - heading)) < 15]
                if len(matched) == 1:
                    self._exit_anchors.setdefault((node["id"], matched[0]), []).append(
                        {**copy.deepcopy(anchor), "observed_exit_heading_deg": heading})
        return result

    def chosen(self, odo, angle, blocked=False, observation_index=None):
        result = super().chosen(odo, angle, blocked)
        frame = self._frames.get(observation_index)
        if (blocked or not index(observation_index) or observation_index in self._invalid_indices
                or self._latest_index != observation_index or frame is None or frame["odometry"] != odo):
            return result
        anchor = self._frame_anchors.get(observation_index)
        if anchor is None or not number(angle):
            return result
        fresh = [a for a in anchor["fresh_relative_exits_deg"] if abs(wrap(a - angle)) <= 5]
        node = self.current_node(odo)
        matched = [i for i, e in enumerate(node["exits"])
                   if abs(wrap(e["heading_deg"] - wrap(odo["headingDeg"] + angle))) < 15]
        if len(fresh) == len(matched) == 1:
            self._selections[observation_index] = {"anchor": anchor, "exit_index": matched[0],
                "requested_angle_deg": angle, "fresh_angle_deg": fresh[0],
                "departure_heading_deg": wrap(odo["headingDeg"] + fresh[0])}
        return result

    def record_completed_traversal(self, observations, motions):
        """Validate a caller-supplied completed window; never execute or close U.

        Required order: indexed update(start), indexed chosen(start), each real
        motion followed by indexed update(post), then submit the entire window
        and raw public motion results. Observation-only gaps must be stationary.
        Missing/invalid windows are rejected; valid windows not at a node remain
        pending. The caller must cancel windows on observed blocking outcomes.
        """
        def reject(reason, status="rejected"):
            return {"recorded": False, "status": status, "reason": reason}

        try:
            frames = [snapshot(o) for o in observations]
        except (KeyError, TypeError):
            return reject("missing_snapshot_fields")
        if len(frames) < 2:
            return reject("incomplete_observation_window", "pending")
        indices = [o["observation_index"] for o in frames]
        if (not all(index(i) for i in indices) or any(b != a + 1 for a, b in zip(indices, indices[1:]))
                or any(i in self._invalid_indices or self._frames.get(i) != o for i, o in zip(indices, frames))):
            return reject("unregistered_or_nonconsecutive_observations")
        if any(o["road"].get("onRoad") is not True for o in frames):
            return reject("road_continuity_not_observed")
        for frame in frames:
            odo, road = frame["odometry"], frame["road"]
            if (not all(number(odo.get(k)) for k in ("rightCm", "forwardCm", "headingDeg", "distanceCm", "tick"))
                    or odo["distanceCm"] < 0 or road.get("tick", odo["tick"]) != odo["tick"]):
                return reject("odometry_or_tick_unavailable")
        for a, b in zip(frames, frames[1:]):
            if (b["odometry"]["distanceCm"] < a["odometry"]["distanceCm"]
                    or b["odometry"]["tick"] < a["odometry"]["tick"]):
                return reject("odometer_or_tick_decreased")
            if (distance(position(a["odometry"]), position(b["odometry"])) * 100
                    > b["odometry"]["distanceCm"] - a["odometry"]["distanceCm"] + .2):
                return reject("pose_displacement_exceeds_public_odometer")
        sensor_frames = [o.get("observation") for o in observations]
        if any(s is not None for s in sensor_frames):
            if (not all(isinstance(s, dict) and "frameId" in s and s.get("tick") == f["odometry"]["tick"]
                        for s, f in zip(sensor_frames, frames))
                    or len({str(s["frameId"]) for s in sensor_frames}) != len(sensor_frames)):
                return reject("sensor_frames_not_fresh_or_bound")
        if not motions or motions[0].get("method") != "take_exit" or motions[0].get("before_observation") != indices[0]:
            return reject("missing_departure_motion")
        selection = self._selections.get(indices[0])
        if (selection is None or motions[0].get("params", {}).get("angleDeg") != selection["requested_angle_deg"]):
            return reject("missing_unique_fresh_departure_selection")
        pairs = {}
        blocked = {"collision", "front_clearance", "off_road", "wrong_way"}
        allowed = {"take_exit", "follow_road", "forward", "backward", "turn"}
        for m in motions:
            key = (m.get("before_observation"), m.get("after_observation"))
            result, method = m.get("actuator_result", {}), m.get("method")
            if (key not in list(zip(indices, indices[1:])) or key in pairs or method not in allowed
                    or (method == "take_exit" and m is not motions[0])):
                return reject("motion_window_or_method_invalid")
            if (not isinstance(result, dict) or result.get("stoppedBy") in blocked
                    or result.get("accepted") is False or result.get("error")
                    or (result.get("completed") is not True if method in {"turn", "forward", "backward"}
                        else result.get("accepted") is not True)):
                return reject("motion_not_observed_accepted")
            pairs[key] = m
        if list(pairs) != sorted(pairs):
            return reject("motions_not_in_observation_order")
        for a, b in zip(frames, frames[1:]):
            key = (a["observation_index"], b["observation_index"])
            if key not in pairs and any(a["odometry"][k] != b["odometry"][k]
                                      for k in ("rightCm", "forwardCm", "headingDeg", "distanceCm", "tick")):
                return reject("unaccounted_motion_between_observations")
        start = selection["anchor"]
        left_origin = False
        for f in frames[1:-1]:
            a = self._frame_anchors.get(f["observation_index"])
            if a is not None and (a["node_id"] != start["node_id"] or left_origin):
                return reject("earlier_node_arrival_requires_separate_window")
            if a is None:
                left_origin = True
        end = self._frame_anchors.get(indices[-1])
        if end is None:
            return reject("arrival_node_not_observed", "pending")
        if end["node_id"] == start["node_id"]:
            return reject("no_distinct_node_arrival")
        travelled = end["odometer_cm"] - start["odometer_cm"]
        if travelled < .2 or math.dist(start["position_m"], end["position_m"]) * 100 < .2:
            return reject("no_observed_translation")
        identity = (indices[0], indices[-1])
        if any((t["departure"]["observation_index"], t["arrival"]["observation_index"]) == identity for t in self._trips):
            return reject("window_already_recorded")
        trip = {"trip_id": f"traversal-{len(self._trips) + 1}", "departure": copy.deepcopy(start),
                "arrival": end, "departure_exit_index": selection["exit_index"],
                "departure_heading_deg": selection["departure_heading_deg"],
                "observed_departure_angle_deg": selection["fresh_angle_deg"],
                "travelled_cm": travelled, "cost_basis": "public_odometry_distanceCm_difference",
                "observed_path": [{"observation_index": f["observation_index"],
                    "tick": f["odometry"]["tick"], "position_m": list(position(f["odometry"])),
                    "odometer_cm": f["odometry"]["distanceCm"]} for f in frames],
                "motions": copy.deepcopy(motions)}
        self._trips.append(trip)
        return {"recorded": True, "status": "completed", "trip": copy.deepcopy(trip)}

    def traversal_records(self):
        return copy.deepcopy(self._trips)

    def observation_anchor(self, observation_index):
        """Read-only anchor captured at update time, never remapped later."""
        if observation_index in self._invalid_indices:
            return None
        return copy.deepcopy(self._frame_anchors.get(observation_index))

    def exit_observation_anchors(self):
        return copy.deepcopy(self._exit_anchors)

    def frontier_hints(self, odo, road, observation_index=None, limit=3):
        """Read-only next-exit hints, never physical identity or completion proof."""
        if type(limit) is not int or limit < 1:
            return []
        limit = min(limit, 3)
        frame = self._frames.get(observation_index)
        if (not index(observation_index) or observation_index != self._latest_index
                or observation_index in self._invalid_indices
                or frame != {"observation_index": observation_index, "odometry": odo, "road": road}):
            return []
        start = self._frame_anchors.get(observation_index)
        if start is None or not same_context(start, start):
            return []
        nodes = {n["id"]: n for n in self.nodes}
        current = nodes[start["node_id"]]
        fresh = []
        for relative, heading in zip(start["fresh_relative_exits_deg"], start["fresh_headings_deg"]):
            matched = [i for i, e in enumerate(current["exits"]) if abs(wrap(e["heading_deg"] - heading)) < 15]
            if len(matched) != 1:
                return []
            fresh.append((matched[0], relative, heading))
        direct = [{"kind": "current_fresh_unexplored", "target_node_id": current["id"],
                   "target_exit_index": i, "target_heading_deg": h, "next_exit_angle_deg": angle,
                   "target_observation_anchor": copy.deepcopy(start), "arrival_anchor": copy.deepcopy(start),
                   "target_anchor_gap_cm": 0, "recorded_travelled_cm": 0, "traversal_ids": []}
                  for i, angle, h in fresh if not current["exits"][i]["completed"] and not current["exits"][i]["blocked"]]
        if direct:
            return copy.deepcopy(direct[:limit])
        queue, serial, visited, found = [(0, 0, start, [], None)], 0, {}, {}
        while queue:
            cost, _, endpoint, path, first_angle = heapq.heappop(queue)
            if path:
                node = nodes[endpoint["node_id"]]
                for i, e in enumerate(node["exits"]):
                    if e["completed"] or e["blocked"]:
                        continue
                    anchors = [a for a in self._exit_anchors.get((node["id"], i), [])
                               if a["observation_index"] not in self._invalid_indices
                               and same_context(endpoint, a, exact_position=False)]
                    if not anchors:
                        continue
                    anchor = max(anchors, key=lambda a: a["observation_index"])
                    key = (node["id"], i)
                    if key not in found:
                        found[key] = {"kind": "recorded_directed_route", "target_node_id": node["id"],
                            "target_exit_index": i, "target_heading_deg": e["heading_deg"],
                            "next_exit_angle_deg": first_angle, "traversal_ids": [t["trip_id"] for t in path],
                            "recorded_travelled_cm": cost, "cost_basis": "sum_public_odometry_distanceCm_differences",
                            "target_observation_anchor": copy.deepcopy(anchor), "arrival_anchor": copy.deepcopy(endpoint),
                            "target_anchor_gap_cm": math.dist(anchor["position_m"], endpoint["position_m"]) * 100,
                            "requires_fresh_arrival_and_exit_recheck": True}
            for trip in self._trips:
                if not same_context(endpoint, trip["departure"]):
                    continue
                source = nodes[trip["departure"]["node_id"]]
                if source["exits"][trip["departure_exit_index"]]["blocked"]:
                    continue
                angle = first_angle
                if not path:
                    matches = [relative for _, relative, h in fresh if abs(wrap(h - trip["departure_heading_deg"])) <= 5]
                    if len(matches) != 1:
                        continue
                    angle = matches[0]
                new_cost = cost + trip["travelled_cm"]
                if new_cost >= visited.get(trip["trip_id"], math.inf):
                    continue
                visited[trip["trip_id"]] = new_cost
                serial += 1
                heapq.heappush(queue, (new_cost, serial, trip["arrival"], path + [trip], angle))
        return copy.deepcopy(sorted(found.values(), key=lambda r: (r["recorded_travelled_cm"],
                             r["target_node_id"], r["target_exit_index"]))[:limit])
