"""Odometry breadcrumbs and junction observations; no preloaded road graph."""
from __future__ import annotations

import copy
import hashlib
import heapq
import json
import math

from .road_evidence import RoadEvidence

VERSION = "autonomous-brain-navigation/v8"


def evidence_version(value):
    """Version semantic route facts, excluding frame counters and timestamps."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def wrap(angle):
    return (angle + 180) % 360 - 180


def position(odo):
    return (odo["rightCm"] / 100, odo["forwardCm"] / 100)


def distance(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def heading_to(a, b):
    # Public odometry/turn: positive left; x right, z forward.
    return -math.degrees(math.atan2(b[0] - a[0], b[1] - a[1]))


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


class RoadMemory:
    def __init__(self):
        self.nodes = []
        self.blocked = []
        self.active_exit = None
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
        self._road_segments = {}
        self._semantic = RoadEvidence()
        self._unindexed_sequence = 0

    def _sync_semantic(self):
        self.nodes = self._semantic.node_views()
        for i, raw in self._semantic.anchors.items():
            self._frame_anchors[i] = copy.deepcopy(raw)
        self._exit_anchors = {}
        for anchor in self._frame_anchors.values():
            if anchor is None:
                continue
            node = next((n for n in self.nodes if n["id"] == anchor["node_id"]), None)
            if node is None:
                continue
            for binding in anchor.get("exit_bindings", []):
                matched = [i for i, e in enumerate(node["exits"]) if e["id"] == binding["exit_id"]]
                if len(matched) == 1:
                    self._exit_anchors.setdefault((node["id"], matched[0]), []).append(copy.deepcopy(anchor))

    def current_node(self, odo):
        anchor = self._frame_anchors.get(self._latest_index)
        if anchor is None or anchor.get("position_m") != list(position(odo)):
            return None
        return next((n for n in self.nodes if n["id"] == anchor["node_id"]), None)

    def exits(self, odo, road):
        node, result = self.current_node(odo), []
        for raw in road.get("exits", []):
            heading = wrap(odo["headingDeg"] + raw["angleDeg"])
            matches = [e for e in (node or {}).get("exits", []) if abs(wrap(e["heading_deg"] - heading)) <= 5]
            saved = matches[0] if len(matches) == 1 else {}
            state = saved.get("state", "unresolved")
            result.append({"angle_deg": raw["angleDeg"], "heading_deg": heading,
                "id": saved.get("id"), "state": state, "visits": saved.get("visits", 0),
                "completed": state == "verified", "blocked": state == "blocked"})
        return result

    def road_evidence(self):
        return self._semantic.evidence()

    def exploration_status(self):
        return self._semantic.status()

    def unexplored(self):
        return self.exploration_status()["pending_exit_count"]

    def summary(self):
        return [{"id": n["id"], "status": n["status"],
            "position_m": {"x": n["position"][0], "z": n["position"][1]},
            "exits": copy.deepcopy(n["exits"])} for n in self.nodes]

    def route_to(self, odo, target):
        """Use only actual registered motion endpoints, never proximity edges."""
        start = position(odo)
        if start not in self._approach_edges:
            return []
        queue, seen = [(0, start, [start])], set()
        best = None
        while queue:
            cost, p, path = heapq.heappop(queue)
            if p in seen:
                continue
            seen.add(p)
            key = (distance(p, target), cost)
            if best is None or key < best[0]:
                best = (key, path)
            for q, edge in self._approach_edges[p].items():
                if not {edge["before_observation"], edge["after_observation"]}.intersection(self._invalid_indices):
                    heapq.heappush(queue, (cost + edge["travelled_cm"], q, path + [q]))
        return best[1] if best else []

    def _segment_anchor(self, frame, travel_heading):
        odo, road = frame["odometry"], frame["road"]
        exits = sorted(wrap(odo["headingDeg"] + item["angleDeg"])
                       for item in road.get("exits", []) if number(item.get("angleDeg")))
        matches = [heading for heading in exits if abs(wrap(heading - travel_heading)) <= 5]
        return {"observation_index": frame["observation_index"], "position_m": list(position(odo)),
                "heading_deg": odo["headingDeg"], "travel_heading_deg": travel_heading,
                "at_node": road.get("atNode") is True, "fresh_exit_headings_deg": exits,
                "exit_heading_deg": matches[0] if len(matches) == 1 else None,
                "exit_correspondence": "unique_observed_exit" if len(matches) == 1
                    else "not_at_observed_node" if not road.get("atNode") else "unresolved",
                "registered_junction_anchor": self.observation_anchor(frame["observation_index"])}

    def road_segment_records(self):
        """Shared evidence API for routes and future junction/exploration logic.

        These are accepted sensor/motion windows, not inferred topological
        connections or complete exploration obligations. Reverse candidates
        remain distinct from motions actually observed in that direction.
        """
        return copy.deepcopy(list(self._road_segments.values()))

    def _record_approach_segment(self, observation, motion):
        """Keep exact measured endpoints; never connect nearby road branches.

        This small path memory is separate from junction identity/frontier
        bookkeeping. Repositioning follows the local road afresh at every step.
        """
        previous = self._approach_previous
        current = copy.deepcopy(observation)
        self._approach_previous = current
        if (current["observation_index"] in self._invalid_indices or previous is not None
                and previous["observation_index"] in self._invalid_indices):
            return
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
        if method == "take_exit":
            angle = motion.get("params", {}).get("angleDeg")
            if not number(angle):
                return
            departure_heading = wrap(old["headingDeg"] + angle)
        elif method == "follow_road":
            error = previous["road"].get("headingErrorDeg")
            if not number(error):
                return
            departure_heading = wrap(old["headingDeg"] + error)
        else:
            departure_heading = wrap(old["headingDeg"] + (180 if method == "backward" else 0))
        arrival_heading = wrap(odo["headingDeg"] + (180 if method == "backward" else 0))
        departure = self._segment_anchor(previous, departure_heading)
        arrival = self._segment_anchor(current, arrival_heading)
        if method == "take_exit" and departure["exit_correspondence"] != "unique_observed_exit":
            return
        edge = {"before_observation": previous["observation_index"],
            "after_observation": current["observation_index"], "method": method,
            "travelled_cm": travelled, "measured_cm": measured,
            "segment_id": f"road-segment-{previous['observation_index']}-{current['observation_index']}",
            "departure": departure, "arrival": arrival,
            "motion": copy.deepcopy(motion), "direction": "forward", "direction_status": "observed_forward"}
        semantic = {"from": list(a), "to": list(p), "method": method,
            "departure_heading": departure_heading, "arrival_heading": arrival_heading,
            "departure_exits": departure["fresh_exit_headings_deg"],
            "arrival_exits": arrival["fresh_exit_headings_deg"],
            "departure_at_node": departure["at_node"], "arrival_at_node": arrival["at_node"]}
        edge["segment_version"] = evidence_version(semantic)
        self._road_segments[edge["segment_id"]] = copy.deepcopy(edge)
        self._approach_edges[a][p] = copy.deepcopy(edge)
        reverse = copy.deepcopy(edge)
        reverse.update(direction="reverse_attempt", direction_status="reverse_not_yet_observed",
            departure=self._segment_anchor(current, wrap(arrival_heading + 180)),
            arrival=self._segment_anchor(previous, wrap(departure_heading + 180)))
        # A newly observed direction supersedes a merely proposed reverse edge.
        existing = self._approach_edges[p].get(a)
        if existing is None or existing.get("direction_status") != "observed_forward":
            self._approach_edges[p][a] = reverse

    def approach_candidates(self, odo, target, excluded=(), limit=3, alternative_routes=()):
        """Reachable viewpoints with directional, executable segment evidence.

        Legacy excluded positions are intentionally no longer exclusions: a
        location is not a failed route. Actions applies versioned failure records.
        """
        start = position(odo)
        if start not in self._approach_edges or self._latest_index in self._invalid_indices:
            return []
        def available(edge):
            return not {edge["before_observation"], edge["after_observation"]}.intersection(self._invalid_indices)
        costs, previous, queue = {start: 0}, {}, [(0, start)]
        while queue:
            cost, point = heapq.heappop(queue)
            if costs[point] != cost:
                continue
            for other, edge in self._approach_edges[point].items():
                if not available(edge):
                    continue
                updated = cost + edge["travelled_cm"]
                if updated < costs.get(other, math.inf):
                    costs[other], previous[other] = updated, point
                    heapq.heappush(queue, (updated, other))
        candidates = []
        def candidate(path, cost):
            point = path[-1]
            segments = [copy.deepcopy(self._approach_edges[a][b]) for a, b in zip(path, path[1:])]
            return {"position_m": list(point), "path": [list(p) for p in path], "segments": segments,
                "route_version": evidence_version([[s["segment_version"], s["direction"]] for s in segments]),
                "source": "observed_on_road_motion_endpoints", "travelled_cm": cost,
                "observation_index": self._approach_points[point]["observation_index"]}
        for point, cost in costs.items():
            if distance(start, point) < .15 or not .25 <= distance(point, target) <= .65:
                continue
            path, endpoint = [point], point
            while endpoint != start:
                endpoint = previous[endpoint]
                path.append(endpoint)
            path.reverse()
            candidates.append(candidate(path, cost))
        # A failed shortest route must not conceal a newly observed, longer
        # alternative to the same candidate. Search finite detours by excluding
        # one of that route's directed edges; no point/area is blacklisted.
        wanted = {tuple(row["position_m"]) for row in candidates}
        versions = {row["route_version"] for row in candidates}
        for failed in list(alternative_routes)[-3:]:
            endpoint = tuple(failed.get("candidate_position_m", ()))
            old_path = [tuple(p) for p in failed.get("route_path", [])]
            if endpoint not in wanted:
                continue
            for blocked_edge in zip(old_path, old_path[1:]):
                queue, seen = [(0., start, [start])], {}
                while queue:
                    cost, point, path = heapq.heappop(queue)
                    if cost >= seen.get(point, math.inf):
                        continue
                    seen[point] = cost
                    if point == endpoint:
                        row = candidate(path, cost)
                        if row["route_version"] not in versions:
                            candidates.append(row)
                            versions.add(row["route_version"])
                        break
                    for other, edge in self._approach_edges[point].items():
                        if (point, other) == blocked_edge or not available(edge) or other in path:
                            continue
                        heapq.heappush(queue, (cost + edge["travelled_cm"], other, path + [other]))
        return sorted(candidates, key=lambda row: (
            abs(distance(tuple(row["position_m"]), target) - .32), row["travelled_cm"],
            row["position_m"]))[:max(0, min(limit, 3))]

    def _anchor(self, frame):
        road, odo = frame["road"], frame["odometry"]
        if (road.get("onRoad") is not True or road.get("atNode") is not True
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
        # Unindexed legacy observations remain unresolved hypotheses. They can
        # never manufacture a completed exit or a road connection.
        if not index(observation_index):
            self._unindexed_sequence -= 1
            observation_index = self._unindexed_sequence
        self._latest_index = observation_index
        frame = snapshot({"observation_index": observation_index, "odometry": odo, "road": road})
        if observation_index in self._frames and self._frames[observation_index] != frame:
            self._invalid_indices.add(observation_index)
            self._semantic.problem("connection", "conflicting_observation_index", [observation_index])
            return
        if observation_index in self._frames:
            return
        self._frames[observation_index] = frame
        self._semantic.register(frame)
        self._frame_anchors[observation_index] = None
        self._sync_semantic()

    def chosen(self, odo, angle, blocked=False, observation_index=None):
        self._cancel_traversal("new_departure")
        self._semantic.choose(observation_index, angle, blocked)
        self._sync_semantic()
        frame = self._frames.get(observation_index)
        if (blocked or not index(observation_index) or observation_index in self._invalid_indices
                or self._latest_index != observation_index or frame is None or frame["odometry"] != odo):
            return
        anchor = self._frame_anchors.get(observation_index)
        if anchor is None or not number(angle):
            return
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

    def _cancel_traversal(self, reason):
        if self._pending_traversal is not None:
            self._semantic.cancel(reason, blocked=reason == "exit_marked_blocked")
            self._sync_semantic()
            observations = self._pending_traversal["observations"]
            self._traversal_events.append({"recorded": False, "status": "rejected", "reason": reason,
                "before_observation": observations[0]["observation_index"],
                "after_observation": observations[-1]["observation_index"]})
            self._pending_traversal = None

    def mark_blocked(self):
        self._semantic.cancel("exit_marked_blocked", blocked=True)
        self._sync_semantic()
        self._cancel_traversal("exit_marked_blocked")

    def observe_traversal(self, observation, motion=None):
        """Collect complete sensor windows, with raw actuator outcomes available.

        Runtime calls this after indexed update, on every observation (including
        round boundaries), and supplies a finalized motion only for an actuator
        call. Legacy completion flags are never used as traversal evidence.
        """
        current = snapshot(observation)
        sensor = observation.get("observation")
        if isinstance(sensor, dict):
            current["observation"] = {k: sensor[k] for k in ("frameId", "tick") if k in sensor}
        old_public = self._semantic.frames.get(current["observation_index"])
        if old_public is not None and old_public != current:
            self._invalid_indices.add(current["observation_index"])
        self._semantic.observe(current, motion)
        self._sync_semantic()
        self._record_approach_segment(observation, motion)
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
                    if not recorded["recorded"]:
                        self._semantic.cancel(recorded["reason"])
                        self._sync_semantic()
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
        for a, b in zip(observations, observations[1:]):
            if not RoadEvidence.step_valid(a, b, pairs.get((a["observation_index"], b["observation_index"]))):
                return reject("public_motion_window_not_verified")
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
        if self._semantic.nodes[end["node_id"]]["status"] == "unresolved" and end.get("candidate_ids"):
            return reject("arrival_node_identity_unresolved")
        if end["node_id"] == start["node_id"] and not left_origin:
            return reject("no_distinct_node_arrival")
        if end["node_id"] == start["node_id"]:
            # Driving out and reversing along the same unfinished branch is
            # not a complete self-loop. A loop arrives through another unique
            # sensed exit, with a recorded translation direction.
            arrival_direction = frames[-1]["odometry"]["headingDeg"]
            if motions[-1]["method"] == "backward":
                arrival_direction = wrap(arrival_direction + 180)
            incoming = [h for h in end["fresh_headings_deg"]
                        if abs(wrap(h - arrival_direction - 180)) <= 5]
            if len(incoming) != 1 or abs(wrap(incoming[0] - selection["departure_heading_deg"])) <= 5:
                return reject("self_loop_arrival_exit_not_distinct")
        travelled = end["odometer_cm"] - start["odometer_cm"]
        if travelled < .2 or (not left_origin and math.dist(start["position_m"], end["position_m"]) * 100 < .2):
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
        if not self._semantic.complete(trip):
            return reject("semantic_departure_binding_unresolved")
        self._trips.append(trip)
        self._sync_semantic()
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
