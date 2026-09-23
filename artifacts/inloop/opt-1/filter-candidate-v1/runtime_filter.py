"""Conservative red/blue confidence filter; runtime inputs only.

The two cutoffs were selected on the authorized development observations.
They preserve the lowest-confidence labelled true observation of each class.
See the offline development provenance for support and unknown-label coverage.

This module does not modify observations, query a robot, estimate range, alter
confirmation, or use coordinates, layouts, package identities, or truth labels.
Missing or non-finite confidence is retained as uncertain, not silently rejected.
"""
import math

FILTER_VERSION = "confidence-floor-dev-v1"
CONFIDENCE_FLOORS = {"target": 0.84, "distractor": 0.80}


def detection_filter_update(observations, odometry=None, road_state=None, tick=None):
    """Return an exact, ordered partition of the original detection indices.

    Odometry, road state and tick are accepted for interface compatibility;
    no rule depends on them. In particular, clipped distance readings are
    never treated as localization points. The caller retains all raw logs.
    The runtime calls this top-level name for platform async transformation.
    """
    kept, rejected, diagnostics = [], [], []
    for index, observation in enumerate(observations):
        category = str(observation.get("category") or "").strip().lower()
        floor = CONFIDENCE_FLOORS.get(category)
        confidence = observation.get("confidence")
        valid = type(confidence) in (int, float) and math.isfinite(confidence)
        reject = floor is not None and valid and confidence < floor
        if reject:
            rejected.append(index)
            reason = "confidence_below_class_floor"
        else:
            kept.append(index)
            reason = ("class_not_filtered" if floor is None else
                      "unknown_confidence_retained" if not valid else
                      "confidence_at_or_above_class_floor")
        diagnostics.append({"index": index, "keep": not reject, "reason": reason,
                            "category": category, "confidence": confidence,
                            "confidence_floor": floor})
    return {"kept_indices": kept, "rejected_indices": rejected,
            "decisions": diagnostics, "filter_version": FILTER_VERSION}


class DetectionFilter:
    """Offline adapter; the robot runtime uses the top-level function."""

    def update(self, observations, odometry=None, road_state=None, tick=None):
        return detection_filter_update(observations, odometry, road_state, tick)
