"""Small deterministic actions whose results depend on fresh observations."""
from __future__ import annotations

import math
import re

from .bridge import SimulationLimit
from .navigation import distance, heading_to, position, wrap

VERSION = "autonomous-brain-actions/v12"


def road_translation_limit(road, method, requested_cm):
    """Bound a straight move using the current local tangent and clearances.

    Sensors round centimetres and degrees to one decimal. Reserve 0.1 cm
    and include the angular rounding bound; this is a motion constraint,
    not an alteration of any perception or success threshold.
    """
    names = ("headingErrorDeg", "leftClearanceCm", "rightClearanceCm")
    if not road.get("onRoad") or not all(
            type(road.get(k)) in (int, float) and math.isfinite(road[k]) for k in names):
        return 0, {"reason": "local_road_geometry_unavailable"}
    error = road["headingErrorDeg"]
    direction = 1 if method == "forward" else -1
    lateral = direction * math.sin(math.radians(error))
    side = "rightClearanceCm" if lateral >= 0 else "leftClearanceCm"
    angular_bound = max(abs(math.sin(math.radians(error + d))) for d in (-.05, .05))
    limit = max(0, road[side] - .1) / angular_bound if angular_bound > 1e-9 else math.inf
    front = road.get("frontClearanceCm")
    if method == "forward":
        if type(front) not in (int, float) or not math.isfinite(front):
            return 0, {"reason": "front_clearance_unavailable"}
        limit = min(limit, max(0, front - .1))
    permitted = min(requested_cm, limit)
    return permitted, {"requested_cm": requested_cm, "permitted_cm": permitted,
                       "heading_error_deg": error, "side": side,
                       "side_clearance_cm": road[side], "front_clearance_cm": front,
                       "predicted_lateral_cm": lateral * permitted}


def ball_inside_region(ball, region):
    """Conservative pixel witness, requiring complete observed region bounds.

    The ball's ground contact pixel must be in the inner ellipse of the visible
    green region. Bounding-box overlap alone is not evidence of placement.
    This does not use the platform's region centre, radius, or release preview.
    """
    x, y, w, h = (region[k] for k in ("x", "y", "w", "h"))
    if x <= 0 or y <= 0 or x + w >= 640 or y + h >= 480 or w < 3 or h < 3:
        return False
    bx, by = ball["x"] + ball["w"] / 2, ball["y"] + ball["h"]
    return ((bx - x - w / 2) / (w / 2)) ** 2 + ((by - y - h / 2) / (h / 2)) ** 2 <= 0.64


class Actions:
    def __init__(self, runtime):
        self.r = runtime
        self.grab_attempts = {}

    @property
    def s(self):
        return self.r.snapshot

    def result(self, success, reason, **evidence):
        return {"success": bool(success), "reason": reason,
                "evidence": {"after_observation": self.s["observation_index"],
                             "frame_id": self.s["observation"]["frameId"],
                             "tick": self.s["odometry"]["tick"],
                             "holding": self.s["holding"]["holding"], **evidence}}

    def move(self, method, params):
        if self.r.bridge.seconds >= self.r.bridge.max_seconds:
            raise SimulationLimit("simulation_time_limit")
        before = self.s["observation_index"]
        result = self.r.bridge.call(method, params)
        self.r.observe()
        self.r.motion_log.write({"round": self.r.round, "method": method, "params": params,
                                 "actuator_result": result, "before_observation": before,
                                 "after_observation": self.s["observation_index"]})
        if self.r.bridge.seconds >= self.r.bridge.max_seconds:
            raise SimulationLimit("simulation_time_limit")
        return result

    def turn(self, angle):
        angle = wrap(angle)
        if abs(angle) >= 1:
            self.move("turn", {"angleDeg": angle, "speed": 50})

    def visible(self, object_id):
        direct = self.r.perception.visible(object_id)
        if direct is not None:
            return direct
        # Near servo frames are outside the demo's confirmation window. They
        # can still identify the already-selected object geometrically after
        # WM decay, without changing its state, hit count, or action eligibility.
        target = self.r.perception.get_object(object_id)
        if target is None or target["state"] in {"HELD", "DELIVERED"}:
            return None
        p = target["position_m"]
        matches = [d for d in self.s["perception"]["detections"]
                   if d["category"] == target["category"] and not d.get("known_delivered_object_id")
                   and "position_m" in d
                   and distance((p["x"], p["z"]), (d["position_m"]["x"], d["position_m"]["z"])) <= .30]
        return matches[0] if len(matches) == 1 else None

    def object_geometry(self, target):
        p = position(self.s["odometry"])
        goal = (target["position_m"]["x"], target["position_m"]["z"])
        return distance(p, goal) * 100, -wrap(heading_to(p, goal) - self.s["odometry"]["headingDeg"])

    def fresh_tentative_views(self):
        tentative = {o["id"] for o in self.r.perception.objects() if o["state"] == "TENTATIVE"}
        return [d for d in self.s["perception"]["detections"]
                if d["category"] in {"red-ball", "blue-ball", "storage-zone"}
                and d.get("fed_to_world_model") and d.get("track_id") in tentative
                and str(d.get("frame_id")) == str(self.s["observation"]["frameId"])]

    def newly_confirmed(self, before_confirmed):
        return [o["id"] for o in self.r.perception.objects()
                if o["state"] == "CONFIRMED" and o["id"] not in before_confirmed]

    def look_around(self):
        before = {o["id"] for o in self.r.perception.objects()}
        task = getattr(self.r, "config", {}).get("task", "")
        task_categories = {category for word, english, category in (
            ("红球", "red", "red-ball"), ("蓝球", "blue", "blue-ball"))
            if word in task or re.search(r"\b" + english + r"\b", task, re.IGNORECASE)}
        holding = self.s["holding"]["holding"]
        candidates = []
        for _ in range(4):
            self.turn(90)
            road = self.s["road"]
            heading_error, clearance = road.get("headingErrorDeg"), road.get("frontClearanceCm")
            # This chooses a useful final viewing direction, not confirmation
            # evidence. It must permit a subsequent short step along the road.
            if (not road["onRoad"] or not all(
                    isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
                    for value in (heading_error, clearance))
                    or abs(heading_error) > 10 or clearance < 16):
                continue
            for detection in self.fresh_tentative_views():
                category = detection["category"]
                if category not in task_categories and not (holding and category == "storage-zone"):
                    continue
                candidate = {"object_id": detection["track_id"], "category": category,
                             "observation_index": self.s["observation_index"],
                             "frame_id": self.s["observation"]["frameId"],
                             "heading_deg": self.s["odometry"]["headingDeg"],
                             "road_heading_error_deg": road["headingErrorDeg"],
                             "front_clearance_cm": road["frontClearanceCm"]}
                priority = 0 if holding and category == "storage-zone" else 1
                candidates.append((priority, abs(detection["bearing_deg"]), candidate))
        tentative = {o["id"] for o in self.r.perception.objects() if o["state"] == "TENTATIVE"}
        candidates = [c for c in candidates if c[2]["object_id"] in tentative]
        chosen = min(candidates, key=lambda c: (c[0], c[1], c[2]["observation_index"]))[2] if candidates else None
        if chosen is not None:
            # turn() observes again; the unchanged WM pose gate prevents this
            # same-position view from supplying an independent confirmation hit.
            self.turn(wrap(chosen["heading_deg"] - self.s["odometry"]["headingDeg"]))
        new = [o["id"] for o in self.r.perception.objects() if o["id"] not in before]
        return self.result(True, "four_views_observed", new_object_ids=new,
                           reobservation_candidate=chosen,
                           final_heading_deg=self.s["odometry"]["headingDeg"])

    def return_from_blocked_road(self, blocked_result):
        """Turn back and follow the observed road, including its bends."""
        self.r.roads.blocked.append({"position_m": position(self.s["odometry"]),
                                     "tick": self.s["odometry"]["tick"],
                                     "reason": blocked_result.get("stoppedBy")})
        self.r.roads.mark_blocked()
        if not self.s["road"]["onRoad"] or blocked_result.get("stoppedBy") == "off_road":
            return self.result(False, "not_on_observed_road", actuator_result=blocked_result)
        if self.s["road"].get("atNode"):
            return self.result(False, "road_blocked_at_junction", actuator_result=blocked_result)
        self.turn(180)
        for step in range(45):
            if not self.s["road"]["onRoad"]:
                return self.result(False, "blocked_road_return_left_road", actuator_result=blocked_result)
            if self.s["road"].get("atNode"):
                return self.result(False, "road_blocked_returned_to_junction",
                                   actuator_result=blocked_result, recovery_steps=step)
            before = position(self.s["odometry"])
            result = self.move("follow_road", {"distanceCm": 20, "speed": 30})
            if not self.s["road"]["onRoad"] or result.get("stoppedBy") == "off_road":
                return self.result(False, "blocked_road_return_left_road",
                                   actuator_result=blocked_result, recovery_result=result)
            if self.s["road"].get("atNode") or result.get("stoppedBy") == "junction":
                return self.result(False, "road_blocked_returned_to_junction",
                                   actuator_result=blocked_result, recovery_result=result,
                                   recovery_steps=step + 1)
            moved = distance(before, position(self.s["odometry"])) * 100
            if moved < 0.2 or result.get("stoppedBy") in {"collision", "front_clearance", "wrong_way"}:
                return self.result(False, "blocked_road_return_blocked",
                                   actuator_result=blocked_result, recovery_result=result)
        return self.result(False, "blocked_road_return_incomplete", actuator_result=blocked_result)

    def explore(self, exit_angle=None):
        before_ids = {o["id"] for o in self.r.perception.objects()}
        before_confirmed = {o["id"] for o in self.r.perception.objects() if o["state"] == "CONFIRMED"}
        start = position(self.s["odometry"])
        road, odo = self.s["road"], self.s["odometry"]
        if not road["onRoad"]:
            return self.result(False, "not_on_observed_road")
        if exit_angle is not None and not road.get("atNode"):
            return self.result(False, "exit_angle_requires_a_current_junction")
        if road.get("atNode") and road["exits"]:
            exits = self.r.roads.exits(odo, road)
            if exit_angle is None:
                chosen = min(exits, key=lambda e: (e["blocked"], e["completed"], e["visits"], abs(e["angle_deg"])))
            else:
                chosen = min(exits, key=lambda e: abs(wrap(e["angle_deg"] - exit_angle)))
                if abs(wrap(chosen["angle_deg"] - exit_angle)) > 5:
                    return self.result(False, "requested_exit_not_observed", available_exits=exits)
            self.r.roads.chosen(odo, chosen["angle_deg"])
            result = self.move("take_exit", {"angleDeg": chosen["angle_deg"], "speed": 50})
            if not self.s["road"]["onRoad"] or result.get("stoppedBy") == "off_road":
                return self.return_from_blocked_road(result)
            confirmed = self.newly_confirmed(before_confirmed)
            if confirmed:
                return self.result(True, "new_objects_confirmed", newly_confirmed_object_ids=confirmed)
            if result.get("stoppedBy") == "junction" or (
                    self.s["road"].get("atNode") and result.get("distanceCm", 0) >= 0.2):
                return self.result(True, "next_junction_observed")
            if result.get("distanceCm", 0) < 0.2:
                self.r.roads.mark_blocked()
                return self.result(False, "selected_exit_blocked", actuator_result=result)
            if result.get("stoppedBy") in {"collision", "front_clearance", "wrong_way"}:
                return self.return_from_blocked_road(result)
        for step in range(12):
            new = [o["id"] for o in self.r.perception.objects() if o["id"] not in before_ids]
            if new:
                return self.result(True, "new_objects_observed", new_object_ids=new)
            before = position(self.s["odometry"])
            step_cm = 16 if self.fresh_tentative_views() else 20
            result = self.move("follow_road", {"distanceCm": step_cm, "speed": 50})
            if not self.s["road"]["onRoad"] or result.get("stoppedBy") == "off_road":
                return self.return_from_blocked_road(result)
            confirmed = self.newly_confirmed(before_confirmed)
            if confirmed:
                return self.result(True, "new_objects_confirmed", newly_confirmed_object_ids=confirmed)
            # A nearby junction can be less than one step away, or the road
            # follower can report it without moving. Neither is an obstacle.
            if self.s["road"].get("atNode") or result.get("stoppedBy") == "junction":
                return self.result(True, "next_junction_observed")
            moved = distance(before, position(self.s["odometry"])) * 100
            if moved < 0.2 or result.get("stoppedBy") in {"collision", "front_clearance", "wrong_way"}:
                return self.return_from_blocked_road(result)
        return self.result(True, "bounded_road_segment_observed", distance_cm=distance(start, position(self.s["odometry"])) * 100)

    def visual_standoff(self, object_id):
        """Close the existing standoff gate using fresh, identified camera views.

        A region's visible centre can differ from its stored WM centre. Keep
        the memory unchanged and use bounded observed corrections at close range.
        """
        observed = None
        for step in range(9):
            observed = self.visible(object_id)
            if (observed is None
                    or str(observed.get("frame_id")) != str(self.s["observation"]["frameId"])):
                return self.result(False, "visual_standoff_target_not_observed", object_id=object_id,
                                   detection=observed)
            d, bearing = observed.get("distance_cm"), observed.get("bearing_deg")
            if not all(isinstance(value, (int, float)) and not isinstance(value, bool)
                       and math.isfinite(value) for value in (d, bearing)) or not 0 < d <= 65:
                return self.result(False, "visual_standoff_range_not_supported", object_id=object_id,
                                   detection=observed)
            if not self.s["road"]["onRoad"]:
                return self.result(False, "not_on_observed_road", object_id=object_id, detection=observed)
            if 25 <= d <= 40 and abs(bearing) <= 10:
                return self.result(True, "target_seen_at_standoff", object_id=object_id,
                                   distance_cm=d, detection=observed)
            if step == 8:
                break
            if abs(bearing) > 10:
                self.turn(-bearing)
                continue
            method = "backward" if d < 25 else "forward"
            length, clearance = road_translation_limit(self.s["road"], method, min(10, abs(d - 32)))
            if length < .1:
                return self.result(False, "visual_standoff_requires_road_reposition", object_id=object_id,
                                   detection=observed, road_clearance=clearance)
            before_odo = dict(self.s["odometry"])
            moved = self.move(method, {"distanceCm": length, "speed": 30})
            if not self.s["road"]["onRoad"]:
                recovery = self.reverse_last_straight_step(method, length, before_odo)
                return self.result(False, "visual_standoff_left_road", object_id=object_id,
                                   actuator_result=moved, detection=self.visible(object_id),
                                   road_clearance=clearance, recovery_result=recovery)
            if not self.s["road"]["onRoad"] or moved.get("stoppedBy") in {
                    "collision", "front_clearance", "off_road", "wrong_way"}:
                return self.result(False, "visual_standoff_blocked", object_id=object_id,
                                   actuator_result=moved, detection=self.visible(object_id))
        return self.result(False, "visual_standoff_did_not_converge", object_id=object_id,
                           detection=observed)

    def reverse_last_straight_step(self, method, commanded_cm, before_odo):
        """Undo only the immediately measured, bounded straight translation.

        Curved road recovery still uses follow_road. No assumed reverse route,
        earlier turn, or fixed-distance blind retreat is replayed here.
        """
        after = self.s["odometry"]
        start, end = position(before_odo), position(after)
        measured = distance(start, end) * 100
        expected = before_odo["headingDeg"] + (180 if method == "backward" else 0)
        if (not .1 <= measured <= min(10, commanded_cm) + .15
                or abs(wrap(after["headingDeg"] - before_odo["headingDeg"])) > .1
                or abs(wrap(heading_to(start, end) - expected)) > 2):
            return {"stoppedBy": "last_translation_not_reversible_from_odometry"}
        inverse = "backward" if method == "forward" else "forward"
        result = self.move(inverse, {"distanceCm": measured, "speed": 20})
        gap = distance(start, position(self.s["odometry"])) * 100
        return {"stoppedBy": "recovered_observed_road" if self.s["road"]["onRoad"] and gap <= .2
                else "road_recovery_not_verified", "return_error_cm": gap,
                "reversed_cm": measured, "actuator_result": result}

    def go_to(self, object_id):
        target = self.r.perception.confirmed(object_id)
        if target is None:
            return self.result(False, "object_not_confirmed")
        goal = (target["position_m"]["x"], target["position_m"]["z"])
        route, waypoint_index, previous_position = None, 0, None
        visited_states = set()
        reacquired_from = set()
        for step in range(45):
            if not self.s["road"]["onRoad"]:
                return self.result(False, "not_on_observed_road")
            current = self.r.perception.get_object(object_id) or target
            remaining, bearing = self.object_geometry(current)
            observed = self.visible(object_id)
            # A nearby remembered point can be behind the camera. Turning in
            # place is observable and does not require inventing a road edge.
            current_pose = position(self.s["odometry"])
            if remaining <= 65 and observed is None and abs(bearing) >= 1 and current_pose not in reacquired_from:
                reacquired_from.add(current_pose)
                self.turn(-bearing)
                continue
            if (observed is not None
                    and str(observed.get("frame_id")) == str(self.s["observation"]["frameId"])
                    and type(observed.get("distance_cm")) in (int, float)
                    and math.isfinite(observed["distance_cm"]) and 0 < observed["distance_cm"] <= 65):
                return self.visual_standoff(object_id)
            if 25 <= remaining <= 40:
                self.turn(-bearing)
                observed = self.visible(object_id)
                if observed is not None and 25 <= observed["distance_cm"] <= 40 and abs(observed["bearing_deg"]) <= 10:
                    return self.result(True, "target_seen_at_standoff", object_id=object_id,
                                       distance_cm=observed["distance_cm"], detection=observed)
                return self.result(False, "fresh_detection_does_not_verify_standoff", object_id=object_id,
                                   detection=observed)
            if remaining < 25:
                self.turn(-bearing)
                length, clearance = road_translation_limit(self.s["road"], "backward", min(10, 32 - remaining))
                if length < .1:
                    return self.result(False, "final_approach_requires_road_reposition", road_clearance=clearance)
                result = self.move("backward", {"distanceCm": length, "speed": 30})
                if not self.s["road"]["onRoad"] or result.get("stoppedBy") in {
                        "collision", "front_clearance", "off_road", "wrong_way"}:
                    return self.result(False, "route_blocked", actuator_result=result)
                continue
            road, odo = self.s["road"], self.s["odometry"]
            if not road["onRoad"]:
                return self.result(False, "not_on_observed_road")
            if route is None:
                # Keep the selected path through intermediate sensor junctions.
                # Replanning there can choose the old start as the nearest vertex.
                route = list(self.r.roads.route_to(odo, goal))
            p = position(odo)
            segment = ((p[0] - previous_position[0], p[1] - previous_position[1])
                       if previous_position is not None else (0, 0))
            segment_length_sq = segment[0] ** 2 + segment[1] ** 2
            last_projection = -math.inf
            while waypoint_index < len(route):
                waypoint = route[waypoint_index]
                projection = (((waypoint[0] - previous_position[0]) * segment[0]
                               + (waypoint[1] - previous_position[1]) * segment[1]) / segment_length_sq
                              if segment_length_sq else None)
                nearby = distance(p, waypoint) <= 0.15
                # A 25–40cm exit step can overshoot the current breadcrumb.
                # Use only the immediately preceding on-road movement and the
                # existing 15cm gate, in route order; never add graph edges.
                crossed = (projection is not None and last_projection <= projection <= 1
                           and projection >= 0 and distance(waypoint, (
                               previous_position[0] + projection * segment[0],
                               previous_position[1] + projection * segment[1])) <= 0.15)
                if not nearby and not crossed:
                    break
                if projection is not None and projection < last_projection:
                    break
                waypoint_index += 1
                if projection is not None:
                    last_projection = projection
            waypoint = route[waypoint_index] if waypoint_index < len(route) else None
            near_approach = remaining <= 65 and abs(bearing) <= 40
            if waypoint is None and not near_approach:
                return self.result(False, "known_route_exhausted_needs_exploration", object_id=object_id)
            state = (p, odo["headingDeg"], waypoint_index, waypoint)
            if state in visited_states:
                return self.result(False, "route_no_progress", object_id=object_id, waypoint=waypoint)
            visited_states.add(state)
            previous_position = p
            relative = wrap(heading_to(p, waypoint) - odo["headingDeg"]) if waypoint is not None else None
            if waypoint is not None and road.get("atNode") and road["exits"] and remaining > 60:
                candidates = road["exits"]
                chosen = min(candidates, key=lambda e: abs(wrap(e["angleDeg"] - relative)))
                self.r.roads.chosen(odo, chosen["angleDeg"])
                result = self.move("take_exit", {"angleDeg": chosen["angleDeg"], "speed": 50})
            elif remaining <= 65 and abs(bearing) <= 40:
                # Final short approach is bounded by the remembered standoff,
                # observed road clearance, and a new camera reading each step.
                self.turn(-bearing)
                if not self.s["road"]["onRoad"]:
                    return self.result(False, "final_approach_not_on_road")
                step_cm = min(10, remaining - 33)
                if step_cm <= 0:
                    return self.result(False, "standoff_geometry_inconsistent")
                step_cm, clearance = road_translation_limit(self.s["road"], "forward", step_cm)
                if step_cm < .1:
                    return self.result(False, "final_approach_requires_road_reposition", road_clearance=clearance)
                result = self.move("forward", {"distanceCm": step_cm, "speed": 30})
            else:
                if abs(relative) > 95:
                    self.turn(180)
                result = self.move("follow_road", {"distanceCm": min(20, max(10, remaining - 33)), "speed": 50})
            if result.get("stoppedBy") in {"collision", "front_clearance", "off_road", "wrong_way"}:
                return self.result(False, "route_blocked", actuator_result=result)
        return self.result(False, "remembered_route_did_not_reach_target")

    def pick(self, object_id):
        trajectory, attempts = [], []

        class ObservedMotionFailure(Exception):
            def __init__(self, reason, evidence):
                self.reason, self.evidence = reason, evidence

        def finish(success, reason, **evidence):
            # Fix the manipulation witness before road recovery changes the
            # camera frame. Grasp and return are independent outcomes.
            evidence.setdefault("post_observation", self.s["observation_index"])
            recovery = self.return_place_path(trajectory)
            return self.result(success, reason, object_id=object_id, attempts=attempts,
                               pick_trajectory=trajectory, road_return=recovery, **evidence)

        def pick_move(method, params):
            before = dict(self.s["odometry"])
            before_observation = self.s["observation_index"]
            before_on_road = self.s["road"]["onRoad"]
            if method == "forward":
                front = self.s["road"].get("frontClearanceCm")
                if (type(front) not in (int, float) or not math.isfinite(front)
                        or front < params["distanceCm"] + .1):
                    raise ObservedMotionFailure("pick_front_clearance_insufficient", {
                        "front_clearance_cm": front if type(front) in (int, float)
                        and math.isfinite(front) else None,
                        "requested_cm": params["distanceCm"]})
            result = self.move(method, params)
            after = dict(self.s["odometry"])
            trajectory.append({"method": method, "params": dict(params),
                               "before": before, "after": after,
                               "before_observation": before_observation,
                               "after_observation": self.s["observation_index"],
                               "before_on_road": before_on_road,
                               "after_on_road": self.s["road"]["onRoad"]})
            # Basic movement responses only acknowledge execution. Verify the
            # measured path, including blocked/partial motion, from odometry.
            measured = distance(position(before), position(after)) * 100
            change = wrap(after["headingDeg"] - before["headingDeg"])
            invalid = False
            if method in {"forward", "backward"}:
                theta = math.radians(before["headingDeg"])
                direction = 1 if method == "forward" else -1
                dx, dz = after["rightCm"] - before["rightCm"], after["forwardCm"] - before["forwardCm"]
                along = direction * (-math.sin(theta) * dx + math.cos(theta) * dz)
                across = math.cos(theta) * dx + math.sin(theta) * dz
                requested = params["distanceCm"]
                invalid = (abs(change) > .2 or abs(across) > .2 or along < -.1
                           or measured > requested + .2 or measured < requested - .2
                           or measured < min(.05, requested / 2))
            elif method == "turn":
                invalid = measured > .2 or abs(wrap(change - params["angleDeg"])) > .2
            else:
                invalid = measured > .2 or abs(change) > .2
            if invalid:
                raise ObservedMotionFailure("pick_motion_not_verified", {
                    "method": method, "actuator_result": result,
                    "before_observation": before_observation,
                    "motion_observation": self.s["observation_index"],
                    "measured_cm": measured, "heading_change_deg": change})
            if result.get("stoppedBy") in {"collision", "front_clearance", "off_road", "wrong_way"}:
                raise ObservedMotionFailure("pick_approach_blocked", {"actuator_result": result})
            return result

        def pick_turn(angle):
            angle = wrap(angle)
            if abs(angle) >= 1:
                pick_move("turn", {"angleDeg": angle, "speed": 50})

        target = self.r.perception.confirmed(object_id)
        if target is None:
            return finish(False, "object_not_confirmed")
        if target["category"] not in {"red-ball", "blue-ball"}:
            return finish(False, "object_is_not_a_ball")
        if self.s["holding"]["holding"]:
            return finish(False, "gripper_already_holding")
        if not self.s["road"]["onRoad"]:
            return finish(False, "pick_requires_observed_road_entry")
        remaining, _ = self.object_geometry(target)
        if remaining > 65:
            return finish(False, "target_too_far_for_pick", distance_cm=remaining)
        original = (target["position_m"]["x"], target["position_m"]["z"])
        try:
            for attempt in range(1, 4):
                # M5's near-field range is extrapolated. Keep the existing
                # confirmed-position/odometry standoff and fresh pixel bearing.
                for _ in range(10):
                    remaining, memory_bearing = self.object_geometry(target)
                    observed = self.visible(object_id)
                    if observed is None and remaining > 30:
                        pick_turn(-memory_bearing)
                        observed = self.visible(object_id)
                        if observed is None:
                            return finish(False, "target_lost_before_close_approach")
                    bearing = observed["bearing_deg"] if observed is not None else memory_bearing
                    if abs(bearing) > 3:
                        pick_turn(-bearing)
                        continue
                    if remaining - 22 < 0.1:
                        break
                    pick_move("forward", {"distanceCm": min(6, remaining - 22), "speed": 30})
                remaining, memory_bearing = self.object_geometry(target)
                observed = self.visible(object_id)
                bearing = observed["bearing_deg"] if observed is not None else memory_bearing
                # Like place, a pick may briefly leave the road within its
                # observed manipulation path. Road state is a return outcome,
                # not evidence that an otherwise aligned grasp failed.
                if remaining > 22.5 or abs(bearing) > 3:
                    return finish(False, "visual_alignment_did_not_converge",
                                  detection=observed, remembered_distance_cm=remaining)
                before = self.s["observation_index"]
                self.grab_attempts[object_id] = self.grab_attempts.get(object_id, 0) + 1
                try:
                    pick_move("grab", {})
                finally:
                    # A grab can already have taken effect when the following
                    # pose check fails. Preserve its fresh sensor outcome and
                    # pending identity without claiming a verified grasp.
                    if self.s["observation_index"] > before:
                        attempts.append({"attempt": attempt, "before_observation": before,
                                         "after_observation": self.s["observation_index"],
                                         "holding": self.s["holding"]["holding"],
                                         "alignment": {"mode": "camera_bearing+confirmed_position_odometry" if observed else "confirmed_position_odometry_near_field",
                                                       "detection": observed, "remembered_distance_cm": remaining,
                                                       "bearing_deg": bearing}})
                        if self.s["holding"]["holding"]:
                            self.r.pending_grasp = {"object_id": object_id, "original_position_m": original,
                                                    "category": target["category"], "attempts": attempts}
                if self.s["holding"]["holding"]:
                    # Keep identity pending until the full 30 cm separation
                    # and old-position camera witness have been observed.
                    for _ in range(5):
                        pick_move("backward", {"distanceCm": 6, "speed": 30})
                        if not self.s["holding"]["holding"]:
                            return finish(False, "holding_lost_during_pick_verification")
                    old_position_detections = [d for d in self.s["perception"]["detections"]
                        if d["category"] == target["category"] and "position_m" in d
                        and distance(original, (d["position_m"]["x"], d["position_m"]["z"])) < 0.15]
                    holding = self.s["holding"]["holding"]
                    marked = self.r.perception.mark_picked(object_id, holding=holding,
                        original_position_absent=not old_position_detections,
                        simulation_time_s=self.r.bridge.seconds,
                        evidence={"holding": holding, "post_observation": self.s["observation_index"],
                                  "old_position_detections": old_position_detections, "attempts": attempts})
                    if marked:
                        self.r.held_object_id = object_id
                        self.r.pending_grasp = None
                    return finish(marked, "grasp_observed" if marked else "holding_but_original_position_ambiguous",
                                  old_position_matches=len(old_position_detections))
                if attempt < 3:
                    pick_move("forward", {"distanceCm": 6, "speed": 20})
            return finish(False, "three_grab_attempts_failed")
        except ObservedMotionFailure as failure:
            return finish(False, failure.reason, **failure.evidence)

    def return_place_path(self, trajectory):
        """Undo measured manipulation motions until sensors reacquire the road.

        Both pick and place may leave the road. Only this call's observed straight
        segments and rotations can supply its return path, never a guessed
        fixed retreat or a line to a remembered map location.
        """
        returned = []
        anchors = [row["before_observation"] for row in trajectory if row["before_on_road"]]
        anchors += [row["after_observation"] for row in trajectory if row["after_on_road"]]

        def outcome(success, reason, **details):
            return {"success": success, "reason": reason,
                    "on_road": self.s["road"]["onRoad"],
                    "anchor_observation": max(anchors) if anchors else None,
                    "after_observation": self.s["observation_index"], "motions": returned, **details}

        if self.s["road"]["onRoad"]:
            return outcome(True, "already_on_observed_road")
        if not anchors:
            return outcome(False, "no_observed_road_entry")
        blocked = {"collision", "front_clearance", "off_road", "wrong_way"}
        for row in reversed(trajectory):
            before, after = row["before"], row["after"]
            current = self.s["odometry"]
            if (distance(position(current), position(after)) * 100 > .2
                    or abs(wrap(current["headingDeg"] - after["headingDeg"])) > .2):
                return outcome(False, "recorded_path_pose_mismatch")
            method, params = row["method"], row["params"]
            measured = distance(position(before), position(after)) * 100
            heading_change = wrap(after["headingDeg"] - before["headingDeg"])
            if method in {"forward", "backward"}:
                direction = 1 if method == "forward" else -1
                theta = math.radians(before["headingDeg"])
                dx = after["rightCm"] - before["rightCm"]
                dz = after["forwardCm"] - before["forwardCm"]
                along = direction * (-math.sin(theta) * dx + math.cos(theta) * dz)
                across = math.cos(theta) * dx + math.sin(theta) * dz
                if (abs(heading_change) > .2 or abs(across) > .2 or along < -.1
                        or measured > params["distanceCm"] + .2):
                    return outcome(False, "recorded_translation_not_reversible")
                inverse = "backward" if method == "forward" else "forward"
                # The recorded endpoint fixes a finite maximum number of
                # corrections even when the actuator makes partial progress.
                for _ in range(math.ceil(measured / 7) + 1):
                    gap = distance(position(self.s["odometry"]), position(before)) * 100
                    if gap <= .2:
                        break
                    requested = min(7, gap)
                    if inverse == "forward":
                        front = self.s["road"].get("frontClearanceCm")
                        if (type(front) not in (int, float) or not math.isfinite(front)
                                or front < requested + .1):
                            return outcome(False, "recorded_return_blocked",
                                           block_reason="current_front_clearance",
                                           front_clearance_cm=front if type(front) in (int, float)
                                           and math.isfinite(front) else None, requested_cm=requested)
                    old = dict(self.s["odometry"])
                    old_observation = self.s["observation_index"]
                    result = self.move(inverse, {"distanceCm": requested, "speed": 20})
                    returned.append({"method": inverse, "distance_cm": min(7, gap),
                                     "before_observation": old_observation,
                                     "after_observation": self.s["observation_index"],
                                     "actuator_result": result})
                    if result.get("stoppedBy") in blocked:
                        return outcome(False, "recorded_return_blocked")
                    now = self.s["odometry"]
                    new_gap = distance(position(now), position(before)) * 100
                    moved = distance(position(old), position(now)) * 100
                    lateral = (math.cos(theta) * (now["rightCm"] - before["rightCm"])
                               + math.sin(theta) * (now["forwardCm"] - before["forwardCm"]))
                    if (abs(wrap(now["headingDeg"] - old["headingDeg"])) > .2
                            or abs(lateral) > .25 or moved > min(7, gap) + .2
                            or new_gap >= gap - .01):
                        return outcome(False, "recorded_return_no_verified_progress")
                    if self.s["road"]["onRoad"]:
                        return outcome(True, "returned_to_observed_road")
                if distance(position(self.s["odometry"]), position(before)) * 100 > .2:
                    return outcome(False, "recorded_return_segment_incomplete")
            elif method == "turn":
                if measured > .2 or abs(heading_change) > abs(params["angleDeg"]) + .2:
                    return outcome(False, "recorded_rotation_not_reversible")
                if abs(heading_change) >= 1:
                    old_observation = self.s["observation_index"]
                    result = self.move("turn", {"angleDeg": -heading_change, "speed": 50})
                    returned.append({"method": "turn", "angle_deg": -heading_change,
                                     "before_observation": old_observation,
                                     "after_observation": self.s["observation_index"],
                                     "actuator_result": result})
                    if result.get("stoppedBy") in blocked:
                        return outcome(False, "recorded_return_blocked")
                    current = self.s["odometry"]
                    if (distance(position(current), position(before)) * 100 > .2
                            or abs(wrap(current["headingDeg"] - before["headingDeg"])) > .2):
                        return outcome(False, "recorded_return_rotation_incomplete")
                    if self.s["road"]["onRoad"]:
                        return outcome(True, "returned_to_observed_road")
            elif measured > .2 or abs(heading_change) > .2:
                return outcome(False, "unrecorded_place_displacement")
            if row["before_observation"] == max(anchors):
                return outcome(False, "recorded_entry_not_on_road")
        return outcome(False, "recorded_return_did_not_reach_road")

    def place(self):
        trajectory = []

        def place_move(method, params):
            before = dict(self.s["odometry"])
            before_observation = self.s["observation_index"]
            before_on_road = self.s["road"]["onRoad"]
            result = self.move(method, params)
            trajectory.append({"method": method, "params": dict(params),
                               "before": before, "after": dict(self.s["odometry"]),
                               "before_observation": before_observation,
                               "after_observation": self.s["observation_index"],
                               "before_on_road": before_on_road,
                               "after_on_road": self.s["road"]["onRoad"]})
            return result

        def finish(success, reason, **evidence):
            if not success:
                regions = [d for d in self.s["perception"]["detections"]
                           if d["category"] == "storage-zone" and "distance_cm" in d]
                if regions:
                    # Capture the failed gate's current camera reading before
                    # recovery changes pose, view, or the generic result frame.
                    region = dict(min(regions, key=lambda d: d["distance_cm"]))
                    region.setdefault("frame_id", str(self.s["observation"]["frameId"]))
                    evidence.setdefault("detection", region)
            # Placement evidence is decided before retracing. A blocked road
            # return cannot revoke an observed delivery or establish one.
            recovery = self.return_place_path(trajectory)
            return self.result(success, reason, place_trajectory=trajectory,
                               road_return=recovery, **evidence)
        if self.r.pending_grasp and self.s["holding"]["holding"]:
            pending = self.r.pending_grasp
            place_move("backward", {"distanceCm": 16, "speed": 30})
            matches = [d for d in self.s["perception"]["detections"]
                       if d["category"] == pending["category"] and "position_m" in d
                       and distance(pending["original_position_m"], (d["position_m"]["x"], d["position_m"]["z"])) < 0.15]
            if self.r.perception.mark_picked(pending["object_id"], holding=True, original_position_absent=not matches,
                    simulation_time_s=self.r.bridge.seconds,
                    evidence={"holding": True, "post_observation": self.s["observation_index"],
                              "recovered_pending_grasp": True, "old_position_detections": matches}):
                self.r.held_object_id = pending["object_id"]
                self.r.pending_grasp = None
        object_id = self.r.held_object_id
        if not self.s["holding"]["holding"] or object_id is None:
            return finish(False, "no_observation_confirmed_held_object")
        category = self.r.perception.get_object(object_id)["category"]
        blocked = {"collision", "front_clearance", "off_road", "wrong_way"}
        for translations in range(9):
            # Turning does not spend the eight-translation budget. Three
            # fresh alignment turns are allowed before each translation.
            for alignment in range(4):
                regions = [d for d in self.s["perception"]["detections"]
                           if d["category"] == "storage-zone" and "distance_cm" in d]
                if not regions:
                    return finish(False, "storage_region_not_observed")
                region = min(regions, key=lambda d: d["distance_cm"])
                if region["distance_cm"] > 65:
                    return finish(False, "storage_region_too_far", distance_cm=region["distance_cm"])
                if abs(region["bearing_deg"]) <= 3:
                    break
                if alignment == 3 or translations == 8:
                    return finish(False, "storage_alignment_did_not_converge")
                result = place_move("turn", {"angleDeg": wrap(-region["bearing_deg"]), "speed": 50})
                if result.get("stoppedBy") in blocked:
                    return finish(False, "storage_approach_blocked", actuator_result=result)
            if region["distance_cm"] <= 19:
                break
            if translations == 8:
                return finish(False, "storage_alignment_did_not_converge")
            result = place_move("forward", {"distanceCm": min(7, region["distance_cm"] - 18), "speed": 30})
            if result.get("stoppedBy") in blocked:
                return finish(False, "storage_approach_blocked", actuator_result=result)
        # Another previously known ball cannot witness this object's release.
        other_known_ball_ids = {row["id"] for row in self.r.perception.objects()
                                if row["category"] == category and row["id"] != object_id}
        place_move("release", {})
        if self.s["holding"]["holding"]:
            return finish(False, "release_did_not_empty_gripper")
        release_observation = {"frame_id": self.s["observation"]["frameId"],
                               "simulation_time_s": self.r.bridge.seconds,
                               "preexisting_ball_ids": sorted(other_known_ball_ids)}
        # Move back to see the released ball and complete storage region.
        place_move("backward", {"distanceCm": 25, "speed": 30})
        detections = self.s["perception"]["detections"]
        witnesses = [(ball, zone) for ball in detections for zone in detections
            if ball["category"] == category and "position_m" in ball and zone["category"] == "storage-zone"
            and not ball.get("known_delivered_object_id")
            and ball.get("track_id") not in other_known_ball_ids
            and ball_inside_region(ball["bbox"], zone["bbox"])]
        placement = None
        if len(witnesses) == 1:
            ball, zone = witnesses[0]
            placement = {"ball_track_id": ball.get("track_id"), "ball_category": ball["category"],
                         "ball_position_m": ball["position_m"], "ball_bbox": ball["bbox"],
                         "storage_bbox": zone["bbox"], "frame_id": self.s["observation"]["frameId"]}
        evidence = {"holding": False, "post_observation": self.s["observation_index"],
                    "release_observation": release_observation,
                    "placement": placement, "candidate_witnesses": len(witnesses)}
        marked = self.r.perception.mark_delivered(object_id, holding=False, ball_in_storage=placement is not None,
                    simulation_time_s=self.r.bridge.seconds, evidence=evidence)
        if not marked:
            self.r.perception.mark_release_unverified(object_id, simulation_time_s=self.r.bridge.seconds, evidence=evidence)
        self.r.held_object_id = None
        return finish(marked, "ball_observed_in_storage" if marked else "released_ball_not_verified_in_storage",
                           object_id=object_id, **evidence)

    def done(self):
        rows = self.r.perception.objects()
        pending = [o["id"] for o in rows if o["category"] == "red-ball" and o["state"] != "DELIVERED"]
        if self.s["holding"]["holding"] or pending or not self.r.roads.nodes or self.r.roads.unexplored():
            return self.result(False, "completion_not_supported_by_observations", pending_objects=pending,
                               unexplored_exits=self.r.roads.unexplored())
        return self.result(True, "explored_roads_and_observed_targets_completed")

    def execute(self, action):
        before = self.s["observation_index"]
        if action["action"] == "done":
            self.r.observe()
            outcome = self.done()
            outcome["evidence"]["before_observation"] = before
            return outcome
        outcome = getattr(self, action["action"])(**action["params"])
        # A result always includes a fresh post-action observation, including
        # precondition failures. Motion actuator 'completed' is never the judge.
        self.r.observe()
        if action["action"] == "go_to" and outcome["success"]:
            detected = self.visible(action["params"]["object_id"])
            outcome = self.result(detected is not None and 25 <= detected["distance_cm"] <= 40
                                  and abs(detected["bearing_deg"]) <= 10,
                                  "target_seen_at_standoff" if detected is not None and 25 <= detected["distance_cm"] <= 40
                                  and abs(detected["bearing_deg"]) <= 10 else "fresh_detection_does_not_verify_standoff",
                                  object_id=action["params"]["object_id"], detection=detected)
        outcome["evidence"].update(before_observation=before,
                                   final_observation=self.s["observation_index"])
        return outcome
