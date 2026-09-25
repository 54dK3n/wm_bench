"""Small deterministic actions whose results depend on fresh observations."""
from __future__ import annotations

import copy
import math
import re

from .bridge import SimulationLimit
from .navigation import distance, heading_to, position, wrap

VERSION = "autonomous-brain-actions/v19"

RETIREMENT_EVIDENCE_FIELDS = ("reason", "archived", "confirmed_s", "first_seen_s",
                              "last_seen_s", "last_updated_s", "first_seen_frame_id",
                              "last_frame_id", "hit_count", "confidence")
REACQUISITION_EVIDENCE_FIELDS = ("association", "frame_id", "simulation_time_s",
    "historical_position_m", "current_position_m", "distance_m", "gate_distance_m",
    "historical_confirmed_s", "current_confirmed_s", "current_hit_poses",
    "competing_identity_ids", "historical_candidates", "current_candidates")


def reacquisition_chains(objects):
    """Validate sensor binding chains without rewriting object state/history."""
    def number(value):
        return type(value) in (int, float) and math.isfinite(value)

    def identifier(value):
        return isinstance(value, str) and bool(value.strip())

    counts, rows = {}, {}
    for row in objects:
        oid = row.get("id")
        if identifier(oid):
            counts[oid] = counts.get(oid, 0) + 1
            rows[oid] = row
    rows = {oid: row for oid, row in rows.items() if counts[oid] == 1}
    bindings = {}
    for oid, row in rows.items():
        binding = row.get("reacquisition_binding")
        if (row.get("category") != "red-ball" or row.get("state") != "LOST"
                or row.get("ever_confirmed") is not True or not isinstance(binding, dict)
                or binding.get("version") != "world-model-reacquisition/v1"
                or binding.get("historical_object_id") != oid):
            continue
        successor = binding.get("current_object_id")
        if not identifier(successor) or successor == oid or successor not in rows:
            continue
        current = rows[successor]
        if (current.get("category") != row["category"] or current.get("ever_confirmed") is not True
                or current.get("state") not in {"CONFIRMED", "STALE", "LOST", "HELD",
                                                "RELEASED_UNVERIFIED", "DELIVERED"}):
            continue
        evidence = binding.get("evidence")
        if (not isinstance(evidence, dict)
                or any(key not in evidence for key in REACQUISITION_EVIDENCE_FIELDS)
                or evidence["association"] != "unchanged_world_model_gate_bidirectionally_unique"
                or not identifier(evidence["frame_id"])
                or evidence["historical_candidates"] != [successor]
                or evidence["current_candidates"] != [oid]):
            continue
        rivals = evidence["competing_identity_ids"]
        if (not isinstance(rivals, list) or not all(identifier(value) for value in rivals)
                or len(set(rivals)) != len(rivals) or not {oid, successor}.issubset(rivals)):
            continue
        times = [evidence[key] for key in ("historical_confirmed_s", "current_confirmed_s",
                                           "simulation_time_s")]
        if not all(number(value) and value >= 0 for value in times) or times != sorted(times):
            continue
        positions = [evidence[key] for key in ("historical_position_m", "current_position_m")]
        if not all(isinstance(p, dict) and all(number(p.get(k)) for k in ("x", "z"))
                   for p in positions):
            continue
        measured, gate = evidence["distance_m"], evidence["gate_distance_m"]
        if (not number(measured) or not number(gate) or gate != .30 or not 0 <= measured <= gate
                or not math.isclose(measured, distance(
                    (positions[0]["x"], positions[0]["z"]),
                    (positions[1]["x"], positions[1]["z"])), rel_tol=1e-9, abs_tol=1e-9)):
            continue
        poses = evidence["current_hit_poses"]
        if (not isinstance(poses, list) or len(poses) < 3
                or not all(isinstance(p, dict) and identifier(p.get("frame_id"))
                    and all(number(p.get(k)) for k in ("x_m", "z_m", "heading_deg", "simulation_time_s"))
                    and 0 <= p["simulation_time_s"] <= times[-1] for p in poses)):
            continue
        if (len({p["frame_id"] for p in poses}) != len(poses)
                or any(math.hypot(a["x_m"] - b["x_m"], a["z_m"] - b["z_m"]) < .15
                       for index, a in enumerate(poses) for b in poses[:index])):
            continue
        basis = copy.deepcopy({key: evidence[key] for key in REACQUISITION_EVIDENCE_FIELDS})
        for key in ("historical_position_m", "current_position_m"):
            basis[key] = {axis: evidence[key][axis] for axis in ("x", "z")}
        basis["current_hit_poses"] = [{key: p[key] for key in (
            "frame_id", "simulation_time_s", "x_m", "z_m", "heading_deg")} for p in poses]
        bindings[oid] = {"version": binding["version"], "historical_object_id": oid,
                         "current_object_id": successor,
                         "evidence": basis}
    # Contradictory claims from two historical identities cannot resolve either.
    incoming = {}
    for binding in bindings.values():
        target = binding["current_object_id"]
        incoming[target] = incoming.get(target, 0) + 1
    bindings = {oid: binding for oid, binding in bindings.items()
                if incoming[binding["current_object_id"]] == 1}
    chains = {}
    for oid in bindings:
        seen, chain, current = set(), [], oid
        while current not in seen:
            seen.add(current)
            row = rows[current]
            if "reacquisition_binding" not in row:
                chains[oid] = {"terminal": row, "binding_chain": chain,
                               "current_object_id": bindings[oid]["current_object_id"]}
                break
            binding = bindings.get(current)
            if binding is None:
                break
            if chain and (binding["evidence"]["historical_confirmed_s"]
                          != chain[-1]["evidence"]["current_confirmed_s"]
                          or binding["evidence"]["simulation_time_s"]
                          < chain[-1]["evidence"]["simulation_time_s"]):
                break
            chain.append(copy.deepcopy(binding))
            current = binding["current_object_id"]
    return chains


def completion_evidence(objects):
    """Classify current red obligations without changing tracking or history."""
    pending, retired, resolved = [], [], []
    chains = reacquisition_chains(objects)
    for row in objects:
        if row["category"] != "red-ball" or row["state"] == "DELIVERED":
            continue
        chain = chains.get(row["id"])
        if chain is not None and chain["terminal"]["state"] == "DELIVERED":
            resolved.append({"object_id": row["id"], "delivered_object_id": chain["terminal"]["id"],
                             "binding_chain": chain["binding_chain"]})
            continue
        basis = row.get("retirement_evidence")
        if (row["state"] == "LOST" and row.get("ever_confirmed") is False
                and row.get("completion_classification") == "retired_unconfirmed_hypothesis"
                and isinstance(basis, dict)
                and all(key in basis for key in RETIREMENT_EVIDENCE_FIELDS)
                and basis["reason"] == "archived_without_confirmation"
                and basis["archived"] is True and basis["confirmed_s"] is None):
            retired.append({"object_id": row["id"],
                            **{key: basis[key] for key in RETIREMENT_EVIDENCE_FIELDS}})
        else:
            # Legacy rows or incomplete history must never silently retire.
            pending.append(row["id"])
    return {"pending_objects": pending, "retired_unconfirmed_hypotheses": retired,
            "resolved_reacquired_identities": resolved}


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
        for _ in range(8):
            self.turn(45)
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
        return self.result(True, "full_circle_views_observed", new_object_ids=new,
                           reobservation_candidate=chosen,
                           final_heading_deg=self.s["odometry"]["headingDeg"])

    def observed_road_node(self):
        return self.s["road"].get("onRoad") is True and self.s["road"].get("atNode") is True

    def recover_unobserved_junction(self, actuator_result):
        """Resolve an actuator/sensor boundary disagreement using local sensing.

        An actuator endpoint label is not arrival evidence. Align to the
        observed tangent and probe at most one ordinary 20 cm road step, in
        the existing 4 cm increments. The actuator label never closes an edge;
        normal road memory updates still use each fresh node observation.
        """
        diagnostic = {"trigger_observation": self.s["observation_index"],
                      "actuator_result": copy.deepcopy(actuator_result),
                      "method": "observed_local_tangent_and_bounded_forward",
                      "requested_budget_cm": 20, "steps": []}

        def number(value):
            return type(value) in (int, float) and math.isfinite(value)

        def finish(success, reason):
            diagnostic["reason"] = reason
            diagnostic["after_observation"] = self.s["observation_index"]
            return self.result(success, "next_junction_observed" if success else reason,
                               junction_recovery=diagnostic)

        def move_checked(method, params):
            before = dict(self.s["odometry"])
            index = self.s["observation_index"]
            frame = self.s["observation"]["frameId"]
            if not all(number(before.get(k)) for k in ("rightCm", "forwardCm", "headingDeg")):
                return "junction_recovery_odometry_unavailable"
            result = self.move(method, params)
            after = dict(self.s["odometry"])
            entry = {"method": method, "params": dict(params), "before": before, "after": after,
                     "before_observation": index, "after_observation": self.s["observation_index"],
                     "actuator_result": result}
            diagnostic["steps"].append(entry)
            if (self.s["observation_index"] <= index
                    or str(self.s["observation"]["frameId"]) == str(frame)
                    or not all(number(after.get(k))
                    for k in ("rightCm", "forwardCm", "headingDeg"))):
                return "junction_recovery_observation_unverified"
            measured = distance(position(before), position(after)) * 100
            change = wrap(after["headingDeg"] - before["headingDeg"])
            entry.update(measured_cm=measured, heading_change_deg=change)
            if method == "turn":
                if measured > .2 or abs(wrap(change - params["angleDeg"])) > .2:
                    return "junction_recovery_turn_unverified"
            else:
                theta = math.radians(before["headingDeg"])
                dx, dz = after["rightCm"] - before["rightCm"], after["forwardCm"] - before["forwardCm"]
                along = -math.sin(theta) * dx + math.cos(theta) * dz
                across = math.cos(theta) * dx + math.sin(theta) * dz
                entry.update(along_cm=along, across_cm=across)
                if (abs(change) > .2 or abs(across) > .2 or along < .2
                        or measured > params["distanceCm"] + .2):
                    return "junction_recovery_translation_unverified"
            if not self.s["road"].get("onRoad"):
                return "junction_recovery_left_road"
            if result.get("stoppedBy") in {"collision", "front_clearance", "off_road", "wrong_way"}:
                return "junction_recovery_motion_blocked"
            return None

        if actuator_result.get("stoppedBy") != "junction":
            return finish(False, "junction_recovery_not_requested")
        for _ in range(5):
            road = self.s["road"]
            if not road.get("onRoad") or not number(road.get("headingErrorDeg")):
                return finish(False, "junction_recovery_road_direction_unavailable")
            if self.observed_road_node():
                return finish(True, "road_node_observed")
            angle = wrap(road["headingErrorDeg"])
            if abs(angle) >= 1:
                failure = move_checked("turn", {"angleDeg": angle, "speed": 50})
                if failure:
                    return finish(False, failure)
                if self.observed_road_node():
                    return finish(True, "road_node_observed")
            # Use the post-turn reading, including its new forward clearance.
            road = self.s["road"]
            if (not number(road.get("headingErrorDeg"))
                    or abs(wrap(road["headingErrorDeg"])) > 10):
                return finish(False, "junction_recovery_road_not_aligned")
            permitted, clearance = road_translation_limit(road, "forward", 4)
            diagnostic["road_clearance"] = clearance
            if permitted < .2:
                return finish(False, "junction_recovery_clearance_insufficient")
            failure = move_checked("forward", {"distanceCm": permitted, "speed": 30})
            if failure:
                return finish(False, failure)
            if self.observed_road_node():
                return finish(True, "road_node_observed")
        return finish(False, "junction_stop_not_observed_after_bounded_recovery")

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
            if self.observed_road_node():
                return self.result(False, "road_blocked_returned_to_junction",
                                   actuator_result=blocked_result, recovery_result=result,
                                   recovery_steps=step + 1)
            if result.get("stoppedBy") == "junction":
                recovery = self.recover_unobserved_junction(result)
                return self.result(False, "road_blocked_returned_to_junction" if recovery["success"]
                                   else "blocked_road_return_junction_not_observed",
                                   actuator_result=blocked_result, recovery_result=result,
                                   recovery_steps=step + 1,
                                   junction_recovery=recovery["evidence"]["junction_recovery"])
            moved = distance(before, position(self.s["odometry"])) * 100
            if moved < 0.2 or result.get("stoppedBy") in {"collision", "front_clearance", "wrong_way"}:
                return self.result(False, "blocked_road_return_blocked",
                                   actuator_result=blocked_result, recovery_result=result)
        return self.result(False, "blocked_road_return_incomplete", actuator_result=blocked_result)

    def take_observed_exit(self, angle):
        """Face a sensed exit, then reacquire that direction before driving.

        The road actuator can stop for clearance before changing heading.
        An obstruction in the old viewing direction must not prevent looking
        down the selected exit. All correspondence uses relative angles and
        odometry; no platform road identifiers enter this controller.
        """
        start_observation = self.s["observation_index"]
        wanted_heading = wrap(self.s["odometry"]["headingDeg"] + angle)
        self.turn(angle)
        road, odo = self.s["road"], self.s["odometry"]
        evidence = {"before_observation": start_observation,
                    "after_observation": self.s["observation_index"],
                    "wanted_heading_deg": wanted_heading}
        if not road["onRoad"] or not road.get("atNode"):
            return {"selection_error": "exit_junction_not_reobserved", **evidence}
        relative = wrap(wanted_heading - odo["headingDeg"])
        matches = [entry for entry in road.get("exits", [])
                   if abs(wrap(entry["angleDeg"] - relative)) <= 5]
        if len(matches) != 1:
            return {"selection_error": "selected_exit_not_uniquely_reobserved",
                    "observed_exit_angles": [entry["angleDeg"] for entry in road.get("exits", [])],
                    **evidence}
        fresh_angle = matches[0]["angleDeg"]
        self.r.roads.chosen(odo, fresh_angle)
        return self.move("take_exit", {"angleDeg": fresh_angle, "speed": 50})

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
            result = self.take_observed_exit(chosen["angle_deg"])
            if result.get("selection_error"):
                return self.result(False, result["selection_error"], exit_selection=result)
            if not self.s["road"]["onRoad"] or result.get("stoppedBy") == "off_road":
                return self.return_from_blocked_road(result)
            if result.get("stoppedBy") in {"collision", "front_clearance", "wrong_way"}:
                return self.return_from_blocked_road(result)
            confirmed = self.newly_confirmed(before_confirmed)
            if confirmed:
                return self.result(True, "new_objects_confirmed", newly_confirmed_object_ids=confirmed)
            moved = distance(start, position(self.s["odometry"])) * 100
            if self.observed_road_node() and moved >= .2:
                return self.result(True, "next_junction_observed")
            if result.get("stoppedBy") == "junction":
                if self.observed_road_node():
                    return self.result(False, "selected_exit_no_observed_progress", actuator_result=result)
                return self.recover_unobserved_junction(result)
            if result.get("distanceCm", 0) < 0.2:
                self.r.roads.mark_blocked()
                return self.result(False, "selected_exit_blocked", actuator_result=result)
        for step in range(12):
            new = [o["id"] for o in self.r.perception.objects() if o["id"] not in before_ids]
            if new:
                return self.result(True, "new_objects_observed", new_object_ids=new)
            before = position(self.s["odometry"])
            step_cm = 16 if self.fresh_tentative_views() else 20
            result = self.move("follow_road", {"distanceCm": step_cm, "speed": 50})
            if not self.s["road"]["onRoad"] or result.get("stoppedBy") == "off_road":
                return self.return_from_blocked_road(result)
            if result.get("stoppedBy") in {"collision", "front_clearance", "wrong_way"}:
                return self.return_from_blocked_road(result)
            confirmed = self.newly_confirmed(before_confirmed)
            if confirmed:
                return self.result(True, "new_objects_confirmed", newly_confirmed_object_ids=confirmed)
            if self.observed_road_node():
                return self.result(True, "next_junction_observed")
            if result.get("stoppedBy") == "junction":
                return self.recover_unobserved_junction(result)
            moved = distance(before, position(self.s["odometry"])) * 100
            if moved < 0.2:
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
                result = self.take_observed_exit(chosen["angleDeg"])
                if result.get("selection_error"):
                    return self.result(False, result["selection_error"], exit_selection=result)
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

    def placement_evidence(self, category, release_observation):
        """Build the unchanged unique, fresh pixel witness for this release."""
        detections = self.s["perception"]["detections"]
        preexisting = release_observation["preexisting_ball_ids"]
        witnesses = [(ball, zone) for ball in detections for zone in detections
            if ball["category"] == category and "position_m" in ball and zone["category"] == "storage-zone"
            and not ball.get("known_delivered_object_id")
            and ball.get("track_id") not in preexisting
            and ball_inside_region(ball["bbox"], zone["bbox"])]
        placement = None
        if len(witnesses) == 1:
            ball, zone = witnesses[0]
            placement = {"ball_track_id": ball.get("track_id"), "ball_category": ball["category"],
                         "ball_position_m": ball["position_m"], "ball_bbox": ball["bbox"],
                         "storage_bbox": zone["bbox"], "frame_id": self.s["observation"]["frameId"]}
        return {"holding": self.s["holding"]["holding"],
                "post_observation": self.s["observation_index"],
                "release_observation": release_observation,
                "placement": placement, "candidate_witnesses": len(witnesses)}

    def reobserve_placement(self, category, release_observation, region_position, required_delivered_ids):
        """Try two short road viewpoints, never infer a second ball from one box.

        The remembered green point is used only to aim the camera. Delivery
        still needs a fresh complete region and an independent unique ball.
        """
        trajectory, viewpoints = [], []
        diagnostic = {"trajectory": trajectory, "viewpoints": viewpoints,
                      "max_viewpoints": 2, "max_distance_cm": 32,
                      "required_delivered_ids": sorted(required_delivered_ids)}
        blocked = {"collision", "front_clearance", "off_road", "wrong_way"}

        def number(value):
            return type(value) in (int, float) and math.isfinite(value)

        def move(method, params):
            before = dict(self.s["odometry"])
            old_index, on_road = self.s["observation_index"], self.s["road"]["onRoad"]
            result = self.move(method, params)
            after = dict(self.s["odometry"])
            trajectory.append({"method": method, "params": dict(params), "before": before, "after": after,
                "before_observation": old_index, "after_observation": self.s["observation_index"],
                "before_on_road": on_road, "after_on_road": self.s["road"]["onRoad"]})
            moved = distance(position(before), position(after)) * 100
            change = wrap(after["headingDeg"] - before["headingDeg"])
            if result.get("stoppedBy") in blocked:
                return "viewpoint_motion_blocked"
            if not self.s["road"]["onRoad"]:
                return "viewpoint_left_observed_road"
            if method == "turn":
                if moved > .2 or abs(wrap(change - params["angleDeg"])) > .2:
                    return "viewpoint_rotation_incomplete"
            else:
                theta = math.radians(before["headingDeg"])
                dx, dz = after["rightCm"] - before["rightCm"], after["forwardCm"] - before["forwardCm"]
                along = -math.sin(theta) * dx + math.cos(theta) * dz
                across = math.cos(theta) * dx + math.sin(theta) * dz
                if (abs(change) > .2 or abs(across) > .2 or along < .2
                        or moved > params["distanceCm"] + .2):
                    return "viewpoint_translation_unverified"
            return None

        def finish(reason):
            diagnostic["reason"] = reason
            if not self.s["road"]["onRoad"]:
                diagnostic["road_return"] = self.return_place_path(trajectory)
            diagnostic["after_observation"] = self.s["observation_index"]
            observed = {d["known_delivered_object_id"] for d in self.s["perception"]["detections"]
                        if d["category"] == category and d.get("known_delivered_object_id")}
            diagnostic["observed_delivered_ids"] = sorted(observed)
            diagnostic["old_objects_reobserved"] = bool(required_delivered_ids) and set(required_delivered_ids) <= observed
            return self.placement_evidence(category, release_observation), diagnostic

        if (not isinstance(region_position, dict)
                or not all(number(region_position.get(key)) for key in ("x", "z"))):
            return finish("observed_region_position_unavailable")
        last_direction = None
        for view in range(2):
            road, odo = self.s["road"], self.s["odometry"]
            if not road["onRoad"] or not number(road.get("headingErrorDeg")):
                return finish("viewpoint_road_direction_unavailable")
            tangent = wrap(odo["headingDeg"] + road["headingErrorDeg"])
            directions = [tangent, wrap(tangent + 180)]
            if road.get("atNode"):
                exits = [wrap(odo["headingDeg"] + entry["angleDeg"])
                         for entry in road.get("exits", []) if number(entry.get("angleDeg"))]
                directions = [matches[0] for direction in directions
                              if len(matches := [angle for angle in exits
                                  if abs(wrap(angle - direction)) <= 5]) == 1]
            if last_direction is not None:
                directions = [angle for angle in directions if abs(wrap(angle - last_direction)) <= 10]
            if not directions:
                return finish("viewpoint_road_direction_not_observed")
            heading = min(directions, key=lambda angle: abs(wrap(angle - odo["headingDeg"])))
            angle = wrap(heading - odo["headingDeg"])
            if abs(angle) >= 1:
                failure = move("turn", {"angleDeg": angle, "speed": 50})
                if failure:
                    return finish(failure)
            if road.get("atNode"):
                fresh_road, fresh_odo = self.s["road"], self.s["odometry"]
                matches = [entry for entry in fresh_road.get("exits", [])
                           if number(entry.get("angleDeg"))
                           and abs(wrap(fresh_odo["headingDeg"] + entry["angleDeg"] - heading)) <= 5]
                if not fresh_road.get("atNode") or len(matches) != 1:
                    return finish("viewpoint_exit_not_uniquely_reobserved")
            # The turn's fresh reading, never its old forward clearance,
            # authorizes each subsequent small translation.
            moved_cm = 0.
            for _ in range(4):
                road = self.s["road"]
                error = road.get("headingErrorDeg")
                if (not number(error) or min(abs(wrap(error)), abs(wrap(error + 180))) > 10):
                    return finish("viewpoint_not_aligned_with_observed_road")
                requested, clearance = road_translation_limit(road, "forward", min(4, 16 - moved_cm))
                if requested < .2:
                    diagnostic["clearance"] = clearance
                    return finish("viewpoint_clearance_insufficient")
                before = position(self.s["odometry"])
                failure = move("forward", {"distanceCm": requested, "speed": 20})
                if failure:
                    return finish(failure)
                moved_cm += distance(before, position(self.s["odometry"])) * 100
            last_direction = self.s["odometry"]["headingDeg"]
            desired = heading_to(position(self.s["odometry"]), (region_position["x"], region_position["z"]))
            angle = wrap(desired - self.s["odometry"]["headingDeg"])
            if abs(angle) >= 1:
                failure = move("turn", {"angleDeg": angle, "speed": 50})
                if failure:
                    return finish(failure)
            evidence = self.placement_evidence(category, release_observation)
            observed = {d["known_delivered_object_id"] for d in self.s["perception"]["detections"]
                        if d["category"] == category and d.get("known_delivered_object_id")}
            old_seen = bool(required_delivered_ids) and set(required_delivered_ids) <= observed
            viewpoints.append({"viewpoint": view + 1, "distance_cm": moved_cm,
                               "observed_delivered_ids": sorted(observed), "old_objects_reobserved": old_seen,
                               "evidence": copy.deepcopy(evidence)})
            if evidence["placement"] is not None and not evidence["holding"] and old_seen:
                return finish("independent_ball_witness_observed")
        return finish("bounded_viewpoints_without_unique_witness")

    def choose_release_aim(self):
        """Freeze a ground aim from a complete currently observed green region.

        The first release uses its centre; visible delivered balls retain the
        free-quarter choice. This is a manipulation target, not a delivery
        witness, and stays fixed as the green box changes through occlusion.
        """
        detections = self.s["perception"]["detections"]
        old_visible = any(d["category"] == "red-ball" and d.get("known_delivered_object_id")
                          for d in detections)
        evidence = {"mode": "observed_free_ground_point" if old_visible else "observed_storage_center_ground_point",
                    "source_frame": self.s["observation"]["frameId"]}
        zones = [d for d in detections if d["category"] == "storage-zone"
                 and d["bbox"]["x"] > 0 and d["bbox"]["y"] > 0
                 and d["bbox"]["x"] + d["bbox"]["w"] < 640
                 and d["bbox"]["y"] + d["bbox"]["h"] < 480
                 and d["bbox"]["w"] >= 3 and d["bbox"]["h"] >= 3]
        zones.sort(key=lambda d: d["bbox"]["w"] * d["bbox"]["h"], reverse=True)
        if not zones or (len(zones) > 1 and zones[0]["bbox"]["w"] * zones[0]["bbox"]["h"]
                         == zones[1]["bbox"]["w"] * zones[1]["bbox"]["h"]):
            return dict(evidence, error="complete_storage_region_not_unique")
        zone = zones[0]
        evidence["source_region"] = copy.deepcopy(zone)
        occupied = [copy.deepcopy(d["bbox"]) for d in detections
                    if d["category"] in {"red-ball", "blue-ball", "obstacle"}]
        evidence["occupied_boxes"] = occupied
        box = zone["bbox"]

        def occupied_pixel(u, v):
            # Reserve another half observed box on each side, unchanged from
            # the observed free-quarter rule; no platform geometry is used.
            return any(b["x"] - b["w"] / 2 <= u <= b["x"] + 1.5 * b["w"]
                       and b["y"] - b["h"] / 2 <= v <= b["y"] + 1.5 * b["h"] for b in occupied)

        if old_visible:
            candidates = []
            for fraction in (.25, .75):
                u, v = box["x"] + box["w"] * fraction, box["y"] + box["h"] / 2
                if occupied_pixel(u, v):
                    continue
                score = min(math.hypot((u - b["x"] - b["w"] / 2) / b["w"],
                                       (v - b["y"] - b["h"] / 2) / b["h"]) for b in occupied)
                candidates.append((score, u, v))
            if not candidates:
                return dict(evidence, error="storage_free_point_not_observed")
            _, u, v = max(candidates, key=lambda candidate: (candidate[0], -candidate[1]))
        else:
            u, v = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
            if occupied_pixel(u, v):
                return dict(evidence, error="storage_center_point_occupied")
        evidence["pixel"] = {"u": u, "v": v}
        try:
            local_x, local_z = self.r.perception.ground_camera.project_pixel_to_ground(u, v)
            if (not all(type(value) in (int, float) and math.isfinite(value) for value in (local_x, local_z))
                    or local_z <= 0):
                raise ValueError("nonfinite ground projection")
            odo = self.s["odometry"]
            theta = math.radians(odo["headingDeg"])
            evidence["position_m"] = {"x": odo["rightCm"] / 100 + math.cos(theta) * local_x - math.sin(theta) * local_z,
                                      "z": odo["forwardCm"] / 100 + math.sin(theta) * local_x + math.cos(theta) * local_z}
        except (AttributeError, ValueError, TypeError, OverflowError):
            return dict(evidence, error="storage_free_point_projection_invalid")
        return evidence

    def place(self):
        trajectory = []
        recovery = None
        release_aim = None

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
            nonlocal recovery
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
            if recovery is None:
                recovery = self.return_place_path(trajectory)
            if release_aim is not None:
                evidence["release_aim"] = copy.deepcopy(release_aim)
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
        release_aim = self.choose_release_aim()
        if release_aim is not None and release_aim.get("error"):
            return finish(False, release_aim["error"])
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
                if release_aim is not None:
                    point = release_aim["position_m"]
                    target = (point["x"], point["z"])
                    region = dict(region, distance_cm=distance(position(self.s["odometry"]), target) * 100,
                                  bearing_deg=wrap(self.s["odometry"]["headingDeg"]
                                                   - heading_to(position(self.s["odometry"]), target)))
                    release_aim["last_alignment"] = {
                        "frame_id": self.s["observation"]["frameId"],
                        "distance_cm": region["distance_cm"], "bearing_deg": region["bearing_deg"],
                        "basis": "fixed_observed_ground_point_and_current_odometry"}
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
        evidence = self.placement_evidence(category, release_observation)
        balls = [d for d in detections if d["category"] == category]
        reobservation = None
        if (not evidence["holding"] and evidence["candidate_witnesses"] == 0 and balls
                and all(ball.get("known_delivered_object_id") for ball in balls)):
            # One old delivered blob is ambiguous, never proof of another
            # delivery. Keep this release open only during bounded reobservation.
            initial = copy.deepcopy(evidence)
            zones = [d for d in detections if d["category"] == "storage-zone"
                     and isinstance(d.get("position_m"), dict)
                     and all(type(d["position_m"].get(key)) in (int, float)
                             and math.isfinite(d["position_m"][key]) for key in ("x", "z"))
                     and d["bbox"]["x"] > 0 and d["bbox"]["y"] > 0
                     and d["bbox"]["x"] + d["bbox"]["w"] < 640
                     and d["bbox"]["y"] + d["bbox"]["h"] < 480]
            # Green may have several disconnected pixel components. Select
            # the unique largest complete one only for aiming, not judging.
            zones.sort(key=lambda d: d["bbox"]["w"] * d["bbox"]["h"], reverse=True)
            aiming_zone = zones[0] if zones and (len(zones) == 1
                or zones[0]["bbox"]["w"] * zones[0]["bbox"]["h"]
                > zones[1]["bbox"]["w"] * zones[1]["bbox"]["h"]) else None
            point = copy.deepcopy(aiming_zone["position_m"]) if aiming_zone else None
            recovery = self.return_place_path(trajectory)
            if recovery["success"] and self.s["road"]["onRoad"]:
                evidence, reobservation = self.reobserve_placement(category, release_observation, point,
                    {ball["known_delivered_object_id"] for ball in balls})
                reobservation["initial_verification"] = initial
                reobservation["aiming_region"] = copy.deepcopy(aiming_zone)
            else:
                reobservation = {"reason": "original_road_return_failed", "initial_verification": initial}
                evidence = self.placement_evidence(category, release_observation)
        marked = self.r.perception.mark_delivered(object_id, holding=evidence["holding"],
                    ball_in_storage=evidence["placement"] is not None
                        and (reobservation is None or reobservation.get("old_objects_reobserved") is True),
                    simulation_time_s=self.r.bridge.seconds, evidence=evidence)
        if not marked:
            self.r.perception.mark_release_unverified(object_id, simulation_time_s=self.r.bridge.seconds, evidence=evidence)
        self.r.held_object_id = None
        return finish(marked, "ball_observed_in_storage" if marked else "released_ball_not_verified_in_storage",
                      object_id=object_id, **({"reobservation": reobservation} if reobservation else {}), **evidence)

    def done(self):
        completion = completion_evidence(self.r.perception.objects())
        if (self.s["holding"]["holding"] or completion["pending_objects"]
                or not self.r.roads.nodes or self.r.roads.unexplored()):
            return self.result(False, "completion_not_supported_by_observations", **completion,
                               unexplored_exits=self.r.roads.unexplored())
        return self.result(True, "explored_roads_and_observed_targets_completed", **completion)

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
