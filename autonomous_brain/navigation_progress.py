"""Persistent navigation obligations; frame churn is deliberately not progress."""
from __future__ import annotations

import copy

from .navigation import distance, wrap


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
