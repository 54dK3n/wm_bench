"""Persistent navigation obligations; frame churn is deliberately not progress."""
from __future__ import annotations

import copy
import math

from .navigation import distance, wrap


class SamplingProgress:
    """Sampling attempts are obligations, not identity or confirmation proofs."""
    SCHEMA = "brain-sampling-progress/v2"

    def __init__(self):
        self.records = []

    def find(self, target):
        aliases = set(target.get("record_ids", [])) | set(target.get("hypothesis_ids", []))
        oid = (target.get("associated_object") or {}).get("id")
        matches = [row for row in self.records if aliases.intersection(row["aliases"])
            or oid is not None and oid in row["object_ids"]]
        if not matches:
            return None
        row = matches[0]
        # A perception-verified alias join carries every prior obligation. It
        # must not select just the first group's failures and forget the rest.
        for other in matches[1:]:
            row["aliases"] = sorted(set(row["aliases"]) | set(other["aliases"]))
            row["object_ids"] = sorted(set(row["object_ids"]) | set(other["object_ids"]))
            row["attempts"].extend(other["attempts"])
            self.records.remove(other)
        row["attempts"].sort(key=lambda item: (item.get("after_observation") or 0,
                                              item.get("before_observation") or 0))
        return row

    @staticmethod
    def context(target, snapshot):
        current = target.get("current_detection") or {}
        observation, odo = snapshot.get("observation", {}), snapshot.get("odometry", {})
        frame = observation.get("frameId")
        tick = odo.get("tick")
        road = snapshot.get("road", {})
        fresh = (bool(current) and frame is not None and str(current.get("frame_id")) == str(frame)
            and observation.get("tick") == tick and ("tick" not in road or road["tick"] == tick))
        poses = target.get("confirmation", {}).get("accepted_hit_poses", [])
        return {"observation_index": snapshot.get("observation_index"), "frame_id": str(frame) if frame is not None else None,
            "tick": tick, "pose": {key: odo.get(key) for key in ("rightCm", "forwardCm", "headingDeg")},
            "odometer_cm": odo.get("distanceCm"), "visible_unique": bool(fresh and target.get("sampling_allowed")),
            "associated_object_id": (target.get("associated_object") or {}).get("id"),
            "accepted_hit_frames": [str(p["frame_id"]) for p in poses],
            "accepted_hit_count": len(poses), "min_hit_pose_gap_m": target.get("confirmation", {}).get("min_hit_pose_gap_m", .15),
            "last_effective_view": copy.deepcopy(target.get("last_effective_view")),
            "road": {key: copy.deepcopy(road.get(key)) for key in ("onRoad", "atNode", "headingErrorDeg",
                "leftClearanceCm", "rightClearanceCm", "frontClearanceCm", "exits")},
            "sampling_path_support": copy.deepcopy(snapshot.get("sampling_path_support") or {}),
            "holding": snapshot.get("holding", {}).get("holding")}

    @staticmethod
    def new_evidence(before, after):
        # Both an actual new frame and advanced simulation tick are necessary.
        # Same-tick detector jitter cannot reopen a failed physical action.
        if (not after.get("visible_unique") or before.get("frame_id") == after.get("frame_id")
                or type(before.get("tick")) not in (int, float)
                or type(after.get("tick")) not in (int, float) or after["tick"] <= before["tick"]):
            return None
        if set(after["accepted_hit_frames"]) - set(before["accepted_hit_frames"]):
            return "new_accepted_hit"
        old_paths = set(before.get("sampling_path_support", {}).get("reverse_lengths_cm", []))
        new_paths = set(after.get("sampling_path_support", {}).get("reverse_lengths_cm", []))
        if new_paths - old_paths:
            return "new_verified_reverse_path_option"
        if before.get("visible_unique") is not True:
            return "fresh_unique_visibility_reacquired"
        a, b = before["pose"], after["pose"]
        finite = lambda value: type(value) in (int, float) and math.isfinite(value)
        if all(finite(p.get(k)) for p in (a, b) for k in ("rightCm", "forwardCm")):
            if math.hypot(a["rightCm"]-b["rightCm"], a["forwardCm"]-b["forwardCm"]) >= after["min_hit_pose_gap_m"]*100:
                return "new_separated_visible_pose"
        if all(finite(p.get("headingDeg")) for p in (a, b)) and abs(wrap(a["headingDeg"]-b["headingDeg"])) >= 5:
            return "changed_observed_view_direction"
        for key, gate in (("leftClearanceCm", 1), ("rightClearanceCm", 1), ("frontClearanceCm", 1), ("headingErrorDeg", 5)):
            x, y = before["road"].get(key), after["road"].get(key)
            delta = abs(wrap(x-y)) if key == "headingErrorDeg" and finite(x) and finite(y) else abs(x-y) if finite(x) and finite(y) else 0
            if delta >= gate:
                return "changed_observed_road_constraint"
        for key in ("onRoad", "atNode"):
            if type(before["road"].get(key)) is bool and type(after["road"].get(key)) is bool and before["road"][key] != after["road"][key]:
                return "changed_observed_road_context"
        old, new = before["road"].get("exits"), after["road"].get("exits")
        if isinstance(old, list) and isinstance(new, list):
            old = sorted(e.get("angleDeg") for e in old if finite(e.get("angleDeg")))
            new = sorted(e.get("angleDeg") for e in new if finite(e.get("angleDeg")))
            if len(old) != len(new) or any(abs(wrap(x-y)) >= 5 for x, y in zip(old, new)):
                return "changed_observed_road_exits"
        return None

    def readiness(self, target, context):
        row = self.find(target)
        attempts = row["attempts"] if row else []
        failures = [item for item in attempts if not item["success"]]
        failure = failures[-1] if failures else None
        # Every previous failed endpoint is an exhausted sampling intent. A
        # turn cycle must differ substantively from *all* of them; frame/tick
        # changes alone cannot reset a formerly tried view. Reacquisition is
        # evaluated against each original missing-view context, so a later
        # visible-but-unproductive failure still remains binding.
        comparisons = [(item, self.new_evidence(item["after_context"], context))
                       for item in failures]
        blocking = next((item for item, change in reversed(comparisons) if change is None), None)
        blocked = blocking is not None
        reasons = list(dict.fromkeys(change for _, change in comparisons if change)) if not blocked else []
        reason = comparisons[-1][1] if comparisons and not blocked else None
        visible = context["visible_unique"]
        effective = target.get("last_effective_view") or (row or {}).get("last_effective_view")
        compact = lambda item: {key: copy.deepcopy(item[key]) for key in ("before_observation", "after_observation",
            "success", "reason", "outcome_unknown", "actual_travelled_cm", "independent_hits_added", "step_count")}
        progress = {"schema": self.SCHEMA, "attempt_count": len(attempts),
            "last_effective_view": copy.deepcopy(effective), "last_failure": compact(failure) if failure else None,
            "recent_attempts": [compact(item) for item in attempts[-3:]],
            "blocking_failure": compact(blocking) if blocking else None,
            "failed_context_count": len(failures),
            "independent_hits_added": sum(item["independent_hits_added"] for item in attempts),
            "retry_blocked": blocked, "new_evidence_reason": reason,
            "new_evidence_reasons": reasons,
            "no_blind_motion": not visible}
        return {"executable": bool(visible and not blocked),
            "reason": target["reason"] if not target.get("sampling_allowed") or not visible else
                "sampling_retry_without_relevant_new_evidence" if blocked else "fresh_sampling_candidate",
            "progress": progress}

    def record(self, target, before, after, outcome):
        row = self.find(target)
        if row is None:
            row = {"hypothesis_id": target["hypothesis_id"], "aliases": [], "object_ids": [], "attempts": [], "last_effective_view": None}
            self.records.append(row)
        row["aliases"] = sorted(set(row["aliases"]) | set(target.get("record_ids", [])) | set(target.get("hypothesis_ids", [])))
        oid = (target.get("associated_object") or {}).get("id")
        if oid is not None and oid not in row["object_ids"]:
            row["object_ids"].append(oid)
        evidence = outcome.get("evidence") or {}
        proof = evidence.get("confirmation_sampling") or {}
        if not proof and isinstance(evidence.get("prior_action_result"), dict):
            proof = evidence["prior_action_result"].get("evidence", {}).get("confirmation_sampling") or {}
        actual = (after["odometer_cm"]-before["odometer_cm"]
            if type(before.get("odometer_cm")) in (int, float) and type(after.get("odometer_cm")) in (int, float) else None)
        item = {"before_observation": before.get("observation_index"), "after_observation": after.get("observation_index"),
            "success": outcome.get("success") is True, "reason": str(outcome.get("reason", "missing_reason"))[:256],
            "outcome_unknown": evidence.get("outcome_unknown") is True,
            "actual_travelled_cm": actual, "independent_hits_added": len(set(after["accepted_hit_frames"])-set(before["accepted_hit_frames"])),
            "step_count": len(proof.get("steps", [])), "before_context": copy.deepcopy(before), "after_context": copy.deepcopy(after),
            "sampling_intent": {"action": "explore", "purpose": "confirm_discovery",
                "canonical_object_id": oid, "hypothesis_id": row["hypothesis_id"],
                "planned_views": [{key: copy.deepcopy(step[key]) for key in
                    ("method", "params", "predicted_raw_distance_cm", "predicted_raw_bearing_deg") if key in step}
                    for step in proof.get("steps", [])]},
            "sampling_evidence": copy.deepcopy(proof)}
        row["attempts"].append(item)
        row["last_effective_view"] = copy.deepcopy(after.get("last_effective_view") or before.get("last_effective_view"))
        return copy.deepcopy(item)

    def evidence(self):
        return copy.deepcopy({"schema": self.SCHEMA, "records": self.records})


def grasp_identity_change(before, after):
    """Reopen an identity failure only with evidence about its old competitors.

    Turning away can shrink today's detection matrix. It cannot erase the
    identities which competed at the failed attempt.
    """
    old, new = before.get("grasp_identity"), after.get("grasp_identity")
    if not old or not new or after.get("grasp_identity_authorized") is not True:
        return None
    matrix = old.get("candidate_ids_by_detection") or []
    indices = {index for index in old.get("target_detection_indices", [])
               if type(index) is int and 0 <= index < len(matrix)}
    competing = {oid for index in indices for oid in matrix[index]}
    # Empty/reduced recovery context is not an original competition. Preserve
    # legitimate multi-detection ambiguity, but never invent a singleton duty
    # whose "all other competitors" test would pass vacuously.
    if (old.get("canonical_object_id") not in competing
            or not (len(competing) > 1 or len(indices) > 1)):
        return None
    competing.add(old.get("canonical_object_id"))
    competing.discard(None)
    canonical = new.get("canonical_object_id")
    mappings = {row["object_id"]: row["canonical_object_id"]
                for row in new.get("canonical_mappings", [])}
    if not competing or canonical is None:
        return None
    # These mappings come only from Perception's verified all-source resolver.
    if (len(competing) > 1 and all(mappings.get(oid, oid) == canonical for oid in competing)
            and any(mappings.get(oid, oid) != oid for oid in competing)):
        return "perception_verified_competing_identities_resolved"
    def new_hit(oid):
        poses = lambda context: {(p["x_m"], p["z_m"]) for p in
            context.get("accepted_independent_hit_poses", {}).get(oid, [])}
        return bool(poses(new) - poses(old))
    if not new_hit(canonical):
        return None
    current = new.get("candidate_ids_by_detection") or []
    states = dict(after.get("relevant_object_states", []))
    others = {mappings.get(oid, oid) for oid in competing} - {canonical}
    if all(states.get(oid) == "CONFIRMED" and new_hit(oid)
           and current.count([oid]) == 1
           and sum(oid in row for row in current) == 1 for oid in others):
        return "new_independent_unique_views_of_competing_objects"
    return None


def changed(before, after):
    """Only changes relevant to a failed approach permit another attempt."""
    if distance(before["position_m"], after["position_m"]) >= .02:
        return True
    if abs(wrap(before["heading_deg"] - after["heading_deg"])) >= 5:
        return True
    for key in ("on_road", "at_node", "holding", "target_state", "visible", "known_paths"):
        if before[key] != after[key]:
            return True
    for key in ("manipulation_state", "relevant_object_states"):
        if before.get(key) != after.get(key):
            return True
    a, b = before.get("manipulation_views", []), after.get("manipulation_views", [])
    if len(a) != len(b):
        return True
    for left, right in zip(a, b):
        if left["identity"] != right["identity"]:
            return True
        for key, gate in (("distance_cm", 2), ("bearing_deg", 5)):
            lvalue, rvalue = left[key], right[key]
            if (lvalue is None) != (rvalue is None) or (lvalue is not None and abs(lvalue - rvalue) >= gate):
                return True
        lb, rb = left["bbox"], right["bbox"]
        if (lb is None) != (rb is None) or (lb is not None and any(abs(x - y) >= 2 for x, y in zip(lb, rb))):
            return True
    for key, gate in (("target_position_m", .05),):
        left, right = before[key], after[key]
        if (left is None) != (right is None) or (left is not None and distance(left, right) >= gate):
            return True
    for key, gate in (("distance_cm", 2), ("bearing_deg", 5),
                      ("heading_error_deg", 5), ("left_clearance_cm", 1),
                      ("right_clearance_cm", 1), ("front_clearance_cm", 1)):
        left, right = before[key], after[key]
        if (left is None) != (right is None) or (left is not None and abs(left - right) >= gate):
            return True
    a, b = before["exit_headings_deg"], after["exit_headings_deg"]
    return len(a) != len(b) or any(not any(abs(wrap(x - y)) < 5 for y in b) for x in a)


class NavigationProgress:
    def __init__(self):
        self.records = {}
        self.action_failures = {}

    def record_for(self, canonical_id, identity_ids):
        identities = set(identity_ids)
        matches = [key for key, row in self.records.items()
                   if identities.intersection(row["identity_ids"])]
        if not matches:
            self.records[canonical_id] = {"canonical_object_id": canonical_id,
                "identity_ids": sorted(identities), "attempts": [], "last_result": None,
                "subgoal": None, "tried_approach_positions": [], "approach_attempts": []}
        else:
            # A verified reacquisition may change the current tracker ID. Its
            # prior failures and attempted viewpoints still belong to this goal.
            row = self.records.pop(matches[0])
            for key in matches[1:]:
                old = self.records.pop(key)
                row["attempts"].extend(old["attempts"])
                row["tried_approach_positions"].extend(old["tried_approach_positions"])
                row.setdefault("approach_attempts", []).extend(old.get("approach_attempts", []))
                identities.update(old["identity_ids"])
            identities.update(row["identity_ids"])
            row.update(canonical_object_id=canonical_id, identity_ids=sorted(identities))
            self.records[canonical_id] = row
        for action, old_id in list(self.action_failures):
            if old_id in identities and old_id != canonical_id:
                self.action_failures.setdefault((action, canonical_id), []).extend(
                    self.action_failures.pop((action, old_id)))
        return self.records[canonical_id]

    def approach_blocked(self, row, candidate, context):
        """The same failed route/conditions may not repeat; a place is not banned."""
        return next((attempt for attempt in reversed(row.get("approach_attempts", []))
            if attempt["candidate_position_m"] == candidate["position_m"]
            and attempt["route_version"] == candidate["route_version"]
            and (not changed(attempt["context"], context)
                 or not changed(attempt.get("failure_context", attempt["context"]), context))), None)

    def remember_approach(self, row, candidate, context, *, status, reason, reached,
                          before_observation, after_observation, arrival_evidence=None,
                          failure_context=None):
        attempt = {"canonical_object_id": row["canonical_object_id"],
            "candidate_position_m": copy.deepcopy(candidate["position_m"]),
            "route_version": candidate["route_version"], "status": status, "reason": reason,
            "candidate_reached": reached, "context": copy.deepcopy(context),
            "route_path": copy.deepcopy(candidate["path"]),
            "failure_context": copy.deepcopy(failure_context if failure_context is not None else context),
            "before_observation": before_observation, "after_observation": after_observation,
            "arrival_evidence": copy.deepcopy(arrival_evidence)}
        attempts = row.setdefault("approach_attempts", [])
        if (attempts and attempts[-1]["route_version"] == attempt["route_version"]
                and attempts[-1]["before_observation"] == before_observation
                and attempts[-1]["status"] == "candidate_reached_approach_not_verified"):
            attempt["stages"] = attempts[-1].get("stages", []) + [{
                "status": attempts[-1]["status"], "after_observation": attempts[-1]["after_observation"]}]
            attempts[-1] = attempt
        else:
            attempts.append(attempt)
        # Retain the old public field only as historical *arrivals*, never as a
        # route exclusion. Unreached candidates cannot appear completed here.
        if reached and candidate["position_m"] not in row["tried_approach_positions"]:
            row["tried_approach_positions"].append(copy.deepcopy(candidate["position_m"]))
        return copy.deepcopy(attempt)

    def blocked(self, row, context):
        # Check every failed endpoint, so turning away and back or completing a
        # short loop cannot erase an already exhausted approach.
        return next((attempt for attempt in reversed(row["attempts"])
                     if not attempt["success"] and not changed(attempt["context"], context)), None)

    def remember(self, row, context, outcome, readiness):
        result = {"success": outcome["success"], "reason": outcome["reason"],
                  "context": copy.deepcopy(context),
                  "after_observation": outcome["evidence"].get("after_observation"),
                  "route": copy.deepcopy(outcome["evidence"].get("road_reposition"))}
        row["last_result"] = result
        if outcome["reason"] not in {"navigation_repeat_without_new_evidence",
                                     "navigation_subgoal_already_satisfied"}:
            if not row["attempts"] or row["attempts"][-1] != result:
                row["attempts"].append(result)
        if readiness["standoff_ready"]:
            row["subgoal"] = copy.deepcopy(readiness)

    def summary(self):
        return copy.deepcopy(list(self.records.values()))
