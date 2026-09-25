"""Small deterministic actions whose results depend on fresh observations."""
from __future__ import annotations

import math

from .bridge import SimulationLimit
from .navigation import distance, heading_to, position, wrap

VERSION = "autonomous-brain-actions/v4"


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

    def look_around(self):
        before = {o["id"] for o in self.r.perception.objects()}
        for _ in range(4):
            self.turn(90)
        new = [o["id"] for o in self.r.perception.objects() if o["id"] not in before]
        return self.result(True, "four_views_observed", new_object_ids=new)

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
            result = self.move("follow_road", {"distanceCm": 20, "speed": 50})
            if not self.s["road"]["onRoad"] or result.get("stoppedBy") == "off_road":
                return self.return_from_blocked_road(result)
            # A nearby junction can be less than one step away, or the road
            # follower can report it without moving. Neither is an obstacle.
            if self.s["road"].get("atNode") or result.get("stoppedBy") == "junction":
                return self.result(True, "next_junction_observed")
            moved = distance(before, position(self.s["odometry"])) * 100
            if moved < 0.2 or result.get("stoppedBy") in {"collision", "front_clearance", "wrong_way"}:
                return self.return_from_blocked_road(result)
        return self.result(True, "bounded_road_segment_observed", distance_cm=distance(start, position(self.s["odometry"])) * 100)

    def go_to(self, object_id):
        target = self.r.perception.confirmed(object_id)
        if target is None:
            return self.result(False, "object_not_confirmed")
        goal = (target["position_m"]["x"], target["position_m"]["z"])
        for step in range(45):
            current = self.r.perception.get_object(object_id) or target
            remaining, bearing = self.object_geometry(current)
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
                self.move("backward", {"distanceCm": max(0.1, 32 - remaining), "speed": 30})
                continue
            road, odo = self.s["road"], self.s["odometry"]
            if not road["onRoad"]:
                return self.result(False, "not_on_observed_road")
            route = self.r.roads.route_to(odo, goal)
            waypoints = [p for p in route if distance(position(odo), p) > 0.15]
            waypoint = waypoints[min(1, len(waypoints) - 1)] if waypoints else goal
            desired = heading_to(position(odo), waypoint)
            relative = wrap(desired - odo["headingDeg"])
            if road.get("atNode") and road["exits"] and remaining > 60:
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
                result = self.move("forward", {"distanceCm": step_cm, "speed": 30})
            else:
                if abs(relative) > 95:
                    self.turn(180)
                result = self.move("follow_road", {"distanceCm": min(20, max(10, remaining - 33)), "speed": 50})
            if result.get("stoppedBy") in {"collision", "front_clearance", "off_road", "wrong_way"}:
                return self.result(False, "route_blocked", actuator_result=result)
        return self.result(False, "remembered_route_did_not_reach_target")

    def pick(self, object_id):
        target = self.r.perception.confirmed(object_id)
        if target is None:
            return self.result(False, "object_not_confirmed")
        if target["category"] not in {"red-ball", "blue-ball"}:
            return self.result(False, "object_is_not_a_ball")
        if self.s["holding"]["holding"]:
            return self.result(False, "gripper_already_holding")
        remaining, _ = self.object_geometry(target)
        if remaining > 65:
            return self.result(False, "target_too_far_for_pick", distance_cm=remaining)
        original = (target["position_m"]["x"], target["position_m"]["z"])
        attempts = []
        for attempt in range(1, 4):
            # M5 is calibrated at 40–90 cm raw sensor range. Near-field
            # pixels still guide bearing, but extrapolated range must not drive
            # the car until a clipped ball fills almost the complete frame.
            # Use the confirmed world point plus odometry for a bounded final
            # approach, starting at the demo's 22 cm remembered standoff.
            for _ in range(10):
                remaining, memory_bearing = self.object_geometry(target)
                observed = self.visible(object_id)
                if observed is None and remaining > 30:
                    self.turn(-memory_bearing)
                    observed = self.visible(object_id)
                    if observed is None:
                        return self.result(False, "target_lost_before_close_approach", attempts=attempts)
                bearing = observed["bearing_deg"] if observed is not None else memory_bearing
                if abs(bearing) > 3:
                    self.turn(-bearing)
                    continue
                # The public actuator's smallest accepted distance is 0.1 cm.
                # A smaller remainder is already inside the existing final
                # alignment tolerance; do not submit an invalid command.
                if remaining - 22 < 0.1:
                    break
                result = self.move("forward", {"distanceCm": min(6, remaining - 22), "speed": 30})
                if result.get("stoppedBy") in {"collision", "front_clearance", "off_road", "wrong_way"}:
                    return self.result(False, "pick_approach_blocked", attempts=attempts, actuator_result=result)
            remaining, memory_bearing = self.object_geometry(target)
            observed = self.visible(object_id)
            bearing = observed["bearing_deg"] if observed is not None else memory_bearing
            if remaining > 22.5 or abs(bearing) > 3 or not self.s["road"]["onRoad"]:
                return self.result(False, "visual_alignment_did_not_converge", attempts=attempts,
                                   detection=observed, remembered_distance_cm=remaining)
            before = self.s["observation_index"]
            self.grab_attempts[object_id] = self.grab_attempts.get(object_id, 0) + 1
            self.move("grab", {})
            attempts.append({"attempt": attempt, "before_observation": before,
                             "after_observation": self.s["observation_index"],
                             "holding": self.s["holding"]["holding"],
                             "alignment": {"mode": "camera_bearing+confirmed_position_odometry" if observed else "confirmed_position_odometry_near_field",
                                           "detection": observed, "remembered_distance_cm": remaining,
                                           "bearing_deg": bearing}})
            if self.s["holding"]["holding"]:
                # Separate the gripper from the former ground position so a
                # held ball remaining in view cannot masquerade as an old ball.
                self.move("backward", {"distanceCm": 30, "speed": 30})
                old_position_detections = [d for d in self.s["perception"]["detections"]
                    if d["category"] == target["category"] and "position_m" in d
                    and distance(original, (d["position_m"]["x"], d["position_m"]["z"])) < 0.15]
                absent = not old_position_detections
                marked = self.r.perception.mark_picked(object_id, holding=True,
                    original_position_absent=absent, simulation_time_s=self.r.bridge.seconds,
                    evidence={"holding": True, "post_observation": self.s["observation_index"],
                              "old_position_detections": old_position_detections, "attempts": attempts})
                if marked:
                    self.r.held_object_id = object_id
                    self.r.pending_grasp = None
                else:
                    self.r.pending_grasp = {"object_id": object_id, "original_position_m": original,
                                            "category": target["category"], "attempts": attempts}
                return self.result(marked, "grasp_observed" if marked else "holding_but_original_position_ambiguous",
                                   object_id=object_id, attempts=attempts)
            if attempt < 3:
                result = self.move("forward", {"distanceCm": 6, "speed": 20})
                if result.get("stoppedBy") in {"collision", "front_clearance", "off_road", "wrong_way"}:
                    return self.result(False, "pick_retry_blocked", attempts=attempts, actuator_result=result)
        return self.result(False, "three_grab_attempts_failed", object_id=object_id, attempts=attempts)

    def place(self):
        if self.r.pending_grasp and self.s["holding"]["holding"]:
            pending = self.r.pending_grasp
            self.move("backward", {"distanceCm": 16, "speed": 30})
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
            return self.result(False, "no_observation_confirmed_held_object")
        category = self.r.perception.get_object(object_id)["category"]
        for _ in range(8):
            regions = [d for d in self.s["perception"]["detections"] if d["category"] == "storage-zone" and "distance_cm" in d]
            if not regions:
                return self.result(False, "storage_region_not_observed")
            region = min(regions, key=lambda d: d["distance_cm"])
            if region["distance_cm"] > 65:
                return self.result(False, "storage_region_too_far", distance_cm=region["distance_cm"])
            if abs(region["bearing_deg"]) > 3:
                self.turn(-region["bearing_deg"])
                continue
            if region["distance_cm"] <= 19:
                break
            self.move("forward", {"distanceCm": min(7, region["distance_cm"] - 18), "speed": 30})
        else:
            return self.result(False, "storage_alignment_did_not_converge")
        self.move("release", {})
        if self.s["holding"]["holding"]:
            return self.result(False, "release_did_not_empty_gripper")
        # Move back to see the released ball and complete storage region.
        self.move("backward", {"distanceCm": 25, "speed": 30})
        detections = self.s["perception"]["detections"]
        witnesses = [(ball, zone) for ball in detections for zone in detections
            if ball["category"] == category and "position_m" in ball and zone["category"] == "storage-zone"
            and not ball.get("known_delivered_object_id")
            and ball_inside_region(ball["bbox"], zone["bbox"])]
        placement = None
        if len(witnesses) == 1:
            ball, zone = witnesses[0]
            placement = {"ball_position_m": ball["position_m"], "ball_bbox": ball["bbox"],
                         "storage_bbox": zone["bbox"], "frame_id": self.s["observation"]["frameId"]}
        evidence = {"holding": False, "post_observation": self.s["observation_index"],
                    "placement": placement, "candidate_witnesses": len(witnesses)}
        marked = self.r.perception.mark_delivered(object_id, holding=False, ball_in_storage=placement is not None,
                    simulation_time_s=self.r.bridge.seconds, evidence=evidence)
        if not marked:
            self.r.perception.mark_release_unverified(object_id, simulation_time_s=self.r.bridge.seconds, evidence=evidence)
        self.r.held_object_id = None
        return self.result(marked, "ball_observed_in_storage" if marked else "released_ball_not_verified_in_storage",
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
