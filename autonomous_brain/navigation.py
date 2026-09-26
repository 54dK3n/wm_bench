"""Odometry breadcrumbs and junction observations; no preloaded road graph."""
from __future__ import annotations

import copy
import heapq
import math

VERSION = "autonomous-brain-navigation/v6"


def wrap(angle):
    return (angle + 180) % 360 - 180


def position(odo):
    return (odo["rightCm"] / 100, odo["forwardCm"] / 100)


def distance(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def heading_to(a, b):
    # Public odometry/turn: positive left; x right, z forward.
    return -math.degrees(math.atan2(b[0] - a[0], b[1] - a[1]))


class _BreadcrumbMemory:
    def __init__(self):
        self.nodes = []
        self.vertices = []
        self.edges = {}
        self.last_vertex = None
        self.last_position = None
        self.blocked = []
        self.active_exit = None

    def update(self, odo, road):
        p = position(odo)
        if self.active_exit:
            previous = self.active_exit["last_position"]
            if distance(p, previous) > 1e-6:
                # The chord of a curved motion is not its arrival tangent.
                # Public headingErrorDeg is road heading minus robot heading.
                # Use the local tangent only when the measured displacement
                # establishes which direction was travelled along that road.
                reverse = heading_to(p, previous)
                error = road.get("headingErrorDeg")
                self.active_exit["reverse_heading"] = None
                if (road["onRoad"] and isinstance(error, (int, float))
                        and not isinstance(error, bool) and math.isfinite(error)):
                    tangent = wrap(odo["headingDeg"] + error)
                    aligned = [angle for angle in (tangent, wrap(tangent + 180))
                               if abs(wrap(angle - reverse)) < 45]
                    if len(aligned) == 1:
                        self.active_exit["reverse_heading"] = aligned[0]
                # Stationary turns/repeated frames retain this arrival evidence.
                self.active_exit["last_position"] = p
        if road["onRoad"]:
            choices = [(distance(p, vertex), i) for i, vertex in enumerate(self.vertices)]
            closest = min(choices, default=(math.inf, None))
            if closest[0] < 0.08:
                current = closest[1]
            else:
                current = len(self.vertices)
                self.vertices.append(p)
                self.edges[current] = {}
            if self.last_vertex is not None and current != self.last_vertex:
                gap = distance(self.vertices[current], self.vertices[self.last_vertex])
                # Edges encode only an actually traversed consecutive segment.
                if self.last_position is not None and distance(p, self.last_position) <= 0.60:
                    self.edges[current][self.last_vertex] = gap
                    self.edges[self.last_vertex][current] = gap
            self.last_vertex = current
        else:
            self.last_vertex = None
        self.last_position = p
        if road.get("atNode") and road["exits"]:
            node = self.current_node(odo)
            if node is None:
                node = {"id": f"junction-{len(self.nodes)+1}", "position": p, "exits": []}
                self.nodes.append(node)
            for raw in road["exits"]:
                heading = wrap(odo["headingDeg"] + raw["angleDeg"])
                if not any(abs(wrap(e["heading_deg"] - heading)) < 15 for e in node["exits"]):
                    node["exits"].append({"heading_deg": heading, "visits": 0, "completed": False, "blocked": False})
            if self.active_exit:
                origin = self.active_exit["node"]
                # A sensor step can cross the whole segment without observing
                # atNode=False. Distinct odometry positions establish arrival.
                if distance(node["position"], origin["position"]) >= 0.15:
                    self.active_exit["exit"]["completed"] = True
                    # Mark only a uniquely observed current reverse exit. Old
                    # bearings retained at a merged node are not fresh evidence.
                    reverse = self.active_exit["reverse_heading"]
                    if reverse is not None and road["onRoad"]:
                        current = [wrap(odo["headingDeg"] + raw["angleDeg"])
                                   for raw in road["exits"]
                                   if abs(wrap(odo["headingDeg"] + raw["angleDeg"] - reverse)) < 45]
                        if len(current) == 1:
                            saved = [e for e in node["exits"]
                                     if abs(wrap(e["heading_deg"] - current[0])) < 15]
                            if len(saved) == 1:
                                saved[0]["completed"] = True
                    self.active_exit = None
                elif self.active_exit["departed"]:
                    self.active_exit = None
        elif self.active_exit:
            self.active_exit["departed"] = True

    def current_node(self, odo):
        p = position(odo)
        # min keeps the first inserted node when distances are exactly tied.
        node = min(self.nodes, key=lambda n: distance(p, n["position"]), default=None)
        return node if node is not None and distance(p, node["position"]) < 0.15 else None

    def exits(self, odo, road):
        node = self.current_node(odo)
        result = []
        for raw in road.get("exits", []):
            heading = wrap(odo["headingDeg"] + raw["angleDeg"])
            saved = next((e for e in (node or {}).get("exits", [])
                          if abs(wrap(e["heading_deg"] - heading)) < 15), None)
            result.append({"angle_deg": raw["angleDeg"], "heading_deg": heading,
                           "visits": saved["visits"] if saved else 0,
                           "completed": saved["completed"] if saved else False,
                           "blocked": saved["blocked"] if saved else False})
        return result

    def chosen(self, odo, angle, blocked=False):
        node = self.current_node(odo)
        if not node:
            return
        heading = wrap(odo["headingDeg"] + angle)
        for exit in node["exits"]:
            if abs(wrap(exit["heading_deg"] - heading)) < 15:
                exit["visits"] += 1
                exit["blocked"] |= blocked
                self.active_exit = {"node": node, "exit": exit, "departed": False,
                                    "last_position": position(odo), "reverse_heading": None}

    def mark_blocked(self):
        if self.active_exit:
            self.active_exit["exit"]["blocked"] = True
            self.active_exit = None

    def route_to(self, odo, target):
        """Shortest recorded path to the visited road point nearest target."""
        if not self.vertices:
            return []
        start = min(range(len(self.vertices)), key=lambda i: distance(position(odo), self.vertices[i]))
        if distance(position(odo), self.vertices[start]) >= .08:
            return []
        goal = min(range(len(self.vertices)), key=lambda i: distance(target, self.vertices[i]))
        costs, previous, queue = {start: 0}, {}, [(0, start)]
        while queue:
            cost, node = heapq.heappop(queue)
            if cost != costs[node]:
                continue
            if node == goal:
                path = [node]
                while node != start:
                    node = previous[node]
                    path.append(node)
                return [self.vertices[i] for i in reversed(path)]
            for other, length in self.edges[node].items():
                if cost + length < costs.get(other, math.inf):
                    costs[other] = cost + length
                    previous[other] = node
                    heapq.heappush(queue, (cost + length, other))
        return []

    def summary(self):
        return [{"id": n["id"], "position_m": {"x": round(n["position"][0], 3), "z": round(n["position"][1], 3)},
                 "exits": [dict(e, heading_deg=round(e["heading_deg"], 1)) for e in n["exits"]]}
                for n in self.nodes]

    def unexplored(self):
        return sum(not e["completed"] and not e["blocked"] for n in self.nodes for e in n["exits"])


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


class RoadMemory(_BreadcrumbMemory):
    def __init__(self):
        super().__init__()
        self._frames = {}
        self._frame_anchors = {}
        self._invalid_indices = set()
        self._latest_index = None
        self._exit_anchors = {}
        self._selections = {}
        self._trips = []
        self._latest_public_observation = None
        self._pending_traversal = None
        self._traversal_events = []
        self._approach_previous = None
        self._approach_points = {}
        self._approach_edges = {}

    def _record_approach_segment(self, observation, motion):
        """Keep exact measured endpoints; never connect nearby road branches.

        This small path memory is separate from junction identity/frontier
        bookkeeping. Repositioning follows the local road afresh at every step.
        """
        previous = self._approach_previous
        current = copy.deepcopy(observation)
        self._approach_previous = current
        odo, road = current["odometry"], current["road"]
        if (road.get("onRoad") is not True
                or not all(number(odo.get(k)) for k in (
                    "rightCm", "forwardCm", "headingDeg", "distanceCm", "tick"))):
            return
        p = position(odo)
        self._approach_points[p] = {"position_m": list(p),
            "observation_index": current["observation_index"],
            "heading_deg": odo["headingDeg"], "road": copy.deepcopy(road)}
        self._approach_edges.setdefault(p, {})
        if previous is None or motion is None:
            return
        old = previous["odometry"]
        result, method = motion.get("actuator_result", {}), motion.get("method")
        if (previous["road"].get("onRoad") is not True
                or not all(number(old.get(k)) for k in (
                    "rightCm", "forwardCm", "headingDeg", "distanceCm", "tick"))
                or current["observation_index"] != previous["observation_index"] + 1
                or motion.get("before_observation") != previous["observation_index"]
                or motion.get("after_observation") != current["observation_index"]
                or method not in {"take_exit", "follow_road", "forward", "backward"}
                or not isinstance(result, dict) or result.get("error")
                or result.get("accepted") is False
                or result.get("stoppedBy") in {"collision", "front_clearance", "off_road", "wrong_way"}
                or (result.get("completed") is not True if method in {"forward", "backward"}
                    else result.get("accepted") is not True)):
            return
        a = position(old)
        measured, travelled = distance(a, p) * 100, odo["distanceCm"] - old["distanceCm"]
        if (a not in self._approach_edges or not .1 <= measured <= 60
                or travelled < .1 or measured > travelled + .2 or odo["tick"] <= old["tick"]):
            return
        if method in {"forward", "backward"}:
            requested = motion.get("params", {}).get("distanceCm")
            theta = math.radians(old["headingDeg"])
            dx, dz = odo["rightCm"] - old["rightCm"], odo["forwardCm"] - old["forwardCm"]
            along = (-math.sin(theta) * dx + math.cos(theta) * dz) * (1 if method == "forward" else -1)
            across = math.cos(theta) * dx + math.sin(theta) * dz
            # Public odometry is rounded to 0.1 cm. A heading computed from a
            # tiny displacement has arbitrarily large angular error; retain the
            # existing 0.2 cm axis tolerances used for basic-motion verification.
            if (not number(requested) or abs(measured - requested) > .2
                    or abs(wrap(odo["headingDeg"] - old["headingDeg"])) > .2
                    or along <= 0 or abs(along - requested) > .2 or abs(across) > .2):
                return
        for frame in (previous, current):
            sensor = frame.get("observation", {})
            if sensor.get("tick") != frame["odometry"]["tick"] or "frameId" not in sensor:
                return
        if str(previous["observation"]["frameId"]) == str(current["observation"]["frameId"]):
            return
        edge = {"before_observation": previous["observation_index"],
            "after_observation": current["observation_index"], "method": method,
            "travelled_cm": travelled, "measured_cm": measured}
        self._approach_edges[a][p] = edge
        self._approach_edges[p][a] = edge

    def approach_candidates(self, odo, target, excluded=(), limit=3):
        """Reachable observed viewpoints in the unchanged visual-range window."""
        start = position(odo)
        if start not in self._approach_edges:
            return []
        costs, previous, queue = {start: 0}, {}, [(0, start)]
        while queue:
            cost, point = heapq.heappop(queue)
            if costs[point] != cost:
                continue
            for other, edge in self._approach_edges[point].items():
                updated = cost + edge["travelled_cm"]
                if updated < costs.get(other, math.inf):
                    costs[other], previous[other] = updated, point
                    heapq.heappush(queue, (updated, other))
        candidates = []
        for point, cost in costs.items():
            if (distance(start, point) < .15 or not .25 <= distance(point, target) <= .65
                    or any(distance(point, tuple(old)) < .15 for old in excluded)):
                continue
            path, endpoint = [point], point
            while endpoint != start:
                endpoint = previous[endpoint]
                path.append(endpoint)
            path.reverse()
            candidates.append({"position_m": list(point), "path": [list(p) for p in path],
                "segments": [copy.deepcopy(self._approach_edges[a][b]) for a, b in zip(path, path[1:])],
                "source": "observed_on_road_motion_endpoints", "travelled_cm": cost,
                "observation_index": self._approach_points[point]["observation_index"]})
        return sorted(candidates, key=lambda row: (
            abs(distance(tuple(row["position_m"]), target) - .32), row["travelled_cm"],
            row["position_m"]))[:max(0, min(limit, 3))]

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
        self._cancel_traversal("new_departure")
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
            current = self._latest_public_observation
            if current is not None and current["observation_index"] == observation_index:
                self._pending_traversal = {"observations": [copy.deepcopy(current)],
                                           "motions": [], "left_origin": False}
        return result

    def _cancel_traversal(self, reason):
        if self._pending_traversal is not None:
            observations = self._pending_traversal["observations"]
            self._traversal_events.append({"recorded": False, "status": "rejected", "reason": reason,
                "before_observation": observations[0]["observation_index"],
                "after_observation": observations[-1]["observation_index"]})
            self._pending_traversal = None

    def mark_blocked(self):
        super().mark_blocked()
        self._cancel_traversal("exit_marked_blocked")

    def observe_traversal(self, observation, motion=None):
        """Collect complete sensor windows, with raw actuator outcomes available.

        Runtime calls this after indexed update, on every observation (including
        round boundaries), and supplies a finalized motion only for an actuator
        call. Legacy completion flags are never used as traversal evidence.
        """
        self._record_approach_segment(observation, motion)
        current = snapshot(observation)
        sensor = observation.get("observation")
        if isinstance(sensor, dict):
            current["observation"] = {k: sensor[k] for k in ("frameId", "tick") if k in sensor}
        self._latest_public_observation = copy.deepcopy(current)
        window = self._pending_traversal
        if window is not None:
            previous = window["observations"][-1]
            window["observations"].append(copy.deepcopy(current))
            if motion is not None:
                window["motions"].append(copy.deepcopy(motion))
            reason = None
            if current["observation_index"] != previous["observation_index"] + 1:
                reason = "nonconsecutive_observation_window"
            elif current["road"].get("onRoad") is not True:
                reason = "road_continuity_not_observed"
            elif motion is not None:
                result, method = motion.get("actuator_result"), motion.get("method")
                if (motion.get("before_observation") != previous["observation_index"]
                        or motion.get("after_observation") != current["observation_index"]):
                    reason = "motion_observation_reference_mismatch"
                elif method not in {"take_exit", "follow_road", "forward", "backward", "turn"}:
                    reason = "non_navigation_actuator"
                elif (not isinstance(result, dict) or result.get("stoppedBy") in {
                        "collision", "front_clearance", "off_road", "wrong_way"}
                        or result.get("accepted") is False or result.get("error")
                        or (result.get("completed") is not True if method in {"turn", "forward", "backward"}
                            else result.get("accepted") is not True)):
                    reason = "motion_not_observed_accepted"
            elif any(previous["odometry"].get(k) != current["odometry"].get(k)
                     for k in ("rightCm", "forwardCm", "headingDeg", "distanceCm", "tick")):
                reason = "unaccounted_motion_between_observations"
            if reason is not None:
                self._cancel_traversal(reason)
            else:
                start = self.observation_anchor(window["observations"][0]["observation_index"])
                end = self.observation_anchor(current["observation_index"])
                if start is None:
                    self._cancel_traversal("departure_anchor_unavailable")
                elif end is None:
                    window["left_origin"] = True
                elif end["node_id"] != start["node_id"] or window["left_origin"]:
                    recorded = self.record_completed_traversal(window["observations"], window["motions"])
                    self._traversal_events.append(dict(recorded,
                        before_observation=window["observations"][0]["observation_index"],
                        after_observation=current["observation_index"]))
                    self._pending_traversal = None
                # A short exit step may still be at the origin. Keep its whole
                # window until a distinct node, return, or explicit failure.
        events, self._traversal_events = self._traversal_events, []
        return copy.deepcopy(events)

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
