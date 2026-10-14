"""Synthetic public loss/readback with real Perception, Actions and grab audit.

The sensor removes the ball only after a measured close probe. This is a
visibility recovery test, not a geometry calibration or competition result.
"""
import copy
import math

import pytest

from test_brain_grab_authorization import actual_grabs
from test_brain_pick_pixel_recovery import ClippedRetryRuntime, commands


class MissingRetryRuntime(ClippedRetryRuntime):
    def __init__(self, **kwargs):
        self.replacement_ball = None
        self.unknown_after_return = False
        self.road_entry_forward = None
        super().__init__(**kwargs)

    def observe(self, *, motion=None):
        original = self.perception.update

        def public_sensor(raw, odo, **kwargs):
            if not self.holding and self.forward > self.clip_after:
                raw["detections"] = [d for d in raw["detections"] if d["category"] != "red-ball"]
                if self.replacement_ball is not None:
                    raw["detections"].append(copy.deepcopy(self.replacement_ball))
            elif self.unknown_after_return and (motion or {}).get("method") == "backward":
                for item in raw["detections"]:
                    if item["category"] == "red-ball":
                        item["pixelQuality"].update(status="unknown", reason="red_sector_not_majority",
                                                    redSectorPixels=10)
            return original(raw, odo, **kwargs)

        self.perception.update = public_sensor
        try:
            return super().observe(motion=motion)
        finally:
            self.perception.update = original

    def log_call(self, method, params, result):
        # A public road sensor with a finite manipulation excursion. The real
        # Actions return path must undo its own measured approach to this entry.
        if method == "local_road" and self.road_entry_forward is not None:
            result["onRoad"] = self.forward <= self.road_entry_forward + 1e-7
        return super().log_call(method, params, result)


def probe_forwards(runtime):
    return [p["distanceCm"] for p in commands(runtime, "forward") if p["speed"] == 20]


def test_missing_after_completed_empty_grab_restores_and_next_model_pick_uses_bound():
    r = MissingRetryRuntime(grab_results=(False, False, False, True))
    assert r.perception.visible(r.object_id)["fed_to_world_model"] is False
    for expected in (3., 1.5):
        result = r.pick()
        assert not result["success"]
        assert result["reason"] == "grab_identity_not_uniquely_visible"
        recovery = result["evidence"]["authorization_recovery"]
        probe = result["evidence"]["retry_probe"]
        assert recovery["success"]
        assert probe["limit_cm"] == pytest.approx(expected)
        assert "missing_observation" in probe and "clipped_observation" not in probe
        missing = next(o for o in r.observations if o["observation_index"] == probe["missing_observation"])
        assert missing["observation"]["detections"] == []
        assert missing["perception"]["detections"] == []
        assert r.forward == pytest.approx(r.entry["forwardCm"])
        assert r.pending_grasp is None and r.held_object_id is None
        assert not r.perception.action_evidence()
    result = r.pick()
    assert result["success"] and result["reason"] == "grasp_observed"
    assert probe_forwards(r) == pytest.approx([6., 3., 1.5])
    assert len(actual_grabs(r)) == 4
    attempts = [a for row in r.rounds for a in row["result"]["evidence"].get("attempts", [])]
    assert len({a["grab_ref"]["bridge_request_id"] for a in attempts}) == 4
    for attempt in attempts:
        proof = attempt["grab_ref"]["authorization"]
        assert proof["observation_index"] == attempt["before_observation"]
        selected = proof["detections"][proof["detection_index"]]
        assert selected["pixel_quality"]["status"] == "supported"
        source = next(o for o in r.observations if o["observation_index"] == attempt["before_observation"])
        assert source["observation"]["detections"]
    assert r.audit()["failures"] == []


@pytest.mark.parametrize("fault", ["partial", "unknown", "forward-unknown"])
def test_missing_probe_failed_or_unknown_motion_does_not_learn_or_repeat(fault):
    r = MissingRetryRuntime(recovery_fault=fault)
    if fault == "partial":
        result = r.pick()
        assert not result["success"]
        assert not result["evidence"]["authorization_recovery"]["success"]
    else:
        with pytest.raises(ConnectionError):
            r.pick()
    assert r.actions._pick_probe_limits == {}
    assert len(actual_grabs(r)) == 1
    assert r.inverse_attempts == (0 if fault == "forward-unknown" else 1)
    assert not r.perception.action_evidence()


@pytest.mark.parametrize("fault", ["competition", "unknown_pixels"])
def test_inverse_pose_without_fresh_full_positive_identity_cannot_learn(fault):
    r = MissingRetryRuntime()
    r.rival_after_return = fault == "competition"
    r.unknown_after_return = fault == "unknown_pixels"
    result = r.pick()
    assert not result["success"]
    assert result["evidence"]["authorization_recovery"]["success"]
    assert "retry_probe" not in result["evidence"]
    assert r.actions._pick_probe_limits == {}
    assert len(actual_grabs(r)) == 1


def test_another_current_ball_is_not_missing_pixels_evidence():
    r = MissingRetryRuntime()
    r.replacement_ball = copy.deepcopy(r.snapshot["observation"]["detections"][0])
    r.replacement_ball["category"] = "blue-ball"
    r.replacement_ball.pop("pixelQuality", None)
    result = r.pick()
    assert not result["success"]
    assert "retry_probe" not in result["evidence"]
    assert r.actions._pick_probe_limits == {}
    assert len(actual_grabs(r)) == 1


def test_unknown_grab_readback_cannot_start_missing_probe():
    r = MissingRetryRuntime()
    r.fault = "unknown_receipt"
    with pytest.raises(ConnectionError):
        r.pick()
    assert len(actual_grabs(r)) == 1
    assert r.pending_grasp is not None
    assert r.pending_grasp["grab_ref"]["outcome_unknown"]
    assert probe_forwards(r) == []
    assert r.actions._pick_probe_limits == {}


def test_minimum_missing_probe_requires_new_view_without_automatic_repeat():
    r = MissingRetryRuntime(clip_gap=.01)
    limits = []
    for _ in range(8):
        result = r.pick()
        probe = result["evidence"].get("retry_probe")
        assert probe is not None, result
        limits.append(probe["limit_cm"])
        if probe["requires_new_view"]:
            break
    assert limits == pytest.approx([3., 1.5, .75, .375, .1875, .1, .1])
    assert result["reason"] == "pick_requires_new_supported_view"
    assert probe["reason"] == "minimum_probe_missing_requires_new_view"
    before = len(r.bridge_records)
    assert not r.pick()["success"]
    assert all(c["request"]["method"] in {"odometry", "local_road", "holding", "observe"}
               for c in r.bridge_records[before:])
    assert min(probe_forwards(r)) >= .1


def test_known_road_return_is_not_an_independent_view_reset_but_new_position_is():
    r = MissingRetryRuntime()
    r.actions.move("backward", {"distanceCm": 18, "speed": 30})
    r.road_entry_forward = r.forward
    r.observe()
    entry = copy.deepcopy(r.snapshot["odometry"])
    result = r.pick()
    assert not result["success"]
    assert result["evidence"]["road_return"]["success"]
    assert result["evidence"]["road_return"]["motions"]
    bound = r.actions._pick_probe_limits[r.object_id]
    assert bound["limit_cm"] == 3
    returned = next(o for o in r.observations if o["observation_index"] == bound["return_observation"])
    assert bound["observed_return_odometry"] == returned["odometry"]
    assert all(bound["observed_return_odometry"][key] == r.snapshot["odometry"][key]
               for key in ("rightCm", "forwardCm", "headingDeg", "distanceCm"))
    assert r.forward == pytest.approx(entry["forwardCm"])
    anchor = bound["anchor_odometry"]
    gap = r.perception.wm.assoc_cfg.min_hit_pose_gap_m
    assert math.hypot(anchor["rightCm"]-entry["rightCm"], anchor["forwardCm"]-entry["forwardCm"])/100 >= gap
    first_probes = len(probe_forwards(r))
    result = r.pick()
    assert not result["success"]
    assert "retry_probe_reset" not in result["evidence"]
    assert probe_forwards(r)[first_probes] == 3
    assert len(result["evidence"]["attempts"]) <= 3
    r.clip_after = float("inf")
    r.actions.move("backward", {"distanceCm": 16, "speed": 30})
    r.grab_results = (True,)
    result = r.pick()
    assert result["success"], result
    assert result["evidence"]["retry_probe_reset"]["min_hit_pose_gap_m"] == gap
    assert r.actions._pick_probe_limits[r.object_id]["limit_cm"] == 6
    assert "observed_return_odometry" not in r.actions._pick_probe_limits[r.object_id]


def test_unrelated_finish_does_not_add_return_scope_to_old_bound():
    r = MissingRetryRuntime(clip_gap=100)
    r.actions._pick_probe_limits[r.object_id] = {
        "limit_cm": 3., "requires_new_view": False,
        "anchor_odometry": copy.deepcopy(r.snapshot["odometry"])}
    result = r.pick()
    assert not result["success"] and result["reason"] == "three_grab_attempts_failed"
    assert len(result["evidence"]["attempts"]) == len(actual_grabs(r)) == 3
    assert "observed_return_odometry" not in r.actions._pick_probe_limits[r.object_id]
