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
                "subgoal": None, "tried_approach_positions": []}
        else:
            # A verified reacquisition may change the current tracker ID. Its
            # prior failures and attempted viewpoints still belong to this goal.
            row = self.records.pop(matches[0])
            for key in matches[1:]:
                old = self.records.pop(key)
                row["attempts"].extend(old["attempts"])
                row["tried_approach_positions"].extend(old["tried_approach_positions"])
                identities.update(old["identity_ids"])
            identities.update(row["identity_ids"])
            row.update(canonical_object_id=canonical_id, identity_ids=sorted(identities))
            self.records[canonical_id] = row
        for action, old_id in list(self.action_failures):
            if old_id in identities and old_id != canonical_id:
                self.action_failures.setdefault((action, canonical_id), []).extend(
                    self.action_failures.pop((action, old_id)))
        return self.records[canonical_id]

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
