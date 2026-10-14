"""Real Actions/Perception with public synthetic clipping and actuator faults."""
import copy

import pytest

from test_brain_grab_authorization import AuthorizationRuntime, actual_grabs


class ClippedRetryRuntime(AuthorizationRuntime):
    def __init__(self, *, grab_results=(False,), clip_gap=2.5, recovery_fault=None):
        self.clip_after = float("inf")
        self.recovery_fault = recovery_fault
        self.inverse_attempts = 0
        self.rival_after_return = False
        super().__init__(grab_results=grab_results)
        target = self.perception.confirmed(self.object_id)
        advance = target["position_m"]["z"] * 100 - self.forward - 21
        self.actions.move("forward", {"distanceCm": advance, "speed": 30})
        self.entry = copy.deepcopy(self.snapshot["odometry"])
        self.clip_after = self.forward + clip_gap
        self.command_start = len(self.bridge_records)

    def observe(self, *, motion=None):
        original = self.perception.update
        def public_sensor(raw, odo, **kwargs):
            for item in raw["detections"]:
                if item["category"] != "red-ball":
                    continue
                clipped = not self.holding and self.forward > self.clip_after
                if clipped:
                    item["bbox"]["y"] = 480 - item["bbox"]["h"]
                item["pixelQuality"] = {"schema": "red-component-quality/v1", "frameId": int(raw["frameId"]),
                    "componentPixels": 100, "redSectorPixels": 95,
                    "status": "unknown" if clipped else "supported",
                    "reason": "source_bbox_touches_boundary" if clipped else "red_sector_majority"}
            if self.rival_after_return and (motion or {}).get("method") == "backward":
                red = next((d for d in raw["detections"] if d["category"] == "red-ball"), None)
                if red:
                    raw["detections"].append(copy.deepcopy(red))
            return original(raw, odo, **kwargs)
        self.perception.update = public_sensor
        try:
            return super().observe(motion=motion)
        finally:
            self.perception.update = original

    def call(self, method, params):
        before = (self.right, self.forward, self.travelled)
        result = super().call(method, params)
        if method == "backward" and not self.holding:
            self.inverse_attempts += 1
            if self.recovery_fault == "partial":
                self.right = before[0] + (self.right - before[0]) / 2
                self.forward = before[1] + (self.forward - before[1]) / 2
                self.travelled = before[2] + (self.travelled - before[2]) / 2
            elif self.recovery_fault == "unknown":
                self.bridge_records[-1].update(terminal=None, submission={"status": 202, "body": {"status": "queued"}})
                raise ConnectionError("synthetic_inverse_ack_unknown")
        if self.recovery_fault == "forward-unknown" and method == "forward" and self.grab_count:
            self.bridge_records[-1].update(terminal=None, submission={"status": 202, "body": {"status": "queued"}})
            raise ConnectionError("synthetic_forward_ack_unknown")
        return result


def commands(r, method):
    return [c["request"]["params"] for c in r.bridge_records[r.command_start:] if c["request"]["method"] == method]


def test_clipped_empty_grab_probe_restores_supported_near_view_and_halves_next_model_pick():
    r = ClippedRetryRuntime(grab_results=(False, False, False, True))
    initial = r.perception.confirmed(r.object_id)
    assert r.perception.visible(r.object_id)["fed_to_world_model"] is False
    for expected in (3., 1.5):
        result = r.pick()
        assert not result["success"] and result["reason"] == "grab_identity_not_uniquely_visible"
        assert result["evidence"]["authorization_recovery"]["success"]
        assert result["evidence"]["retry_probe"]["limit_cm"] == pytest.approx(expected)
        assert r.forward == pytest.approx(r.entry["forwardCm"])
        assert r.perception.confirmed(r.object_id)["hit_count"] == initial["hit_count"]
        assert r.held_object_id is None and r.pending_grasp is None
        assert not r.perception.action_evidence()
    # The normal execute failure guard must consume the new bound, not block
    # it merely because the camera returned to the same supported view.
    result = r.pick()
    assert result["success"] and result["reason"] == "grasp_observed"
    assert [p["distanceCm"] for p in commands(r, "forward")] == pytest.approx([6., 3., 1.5])
    assert len(actual_grabs(r)) == 4
    assert len(result["evidence"]["attempts"]) == 2
    assert r.held_object_id == r.object_id
    # Every executed grab, including empty ones, got a distinct fresh proof.
    attempts = [a for row in r.rounds for a in row["result"]["evidence"].get("attempts", [])]
    refs = [a["grab_ref"]["authorization"]["command_ref"]["bridge_request_id"] for a in attempts]
    assert len(set(refs)) == 4
    for attempt in attempts:
        proof = attempt["grab_ref"]["authorization"]
        assert proof["observation_index"] == attempt["before_observation"]
        assert proof["detections"][proof["detection_index"]]["pixel_quality"]["status"] == "supported"
    assert r.audit()["failures"] == []


@pytest.mark.parametrize("fault", ["partial", "unknown", "forward-unknown"])
def test_failed_or_unknown_path_never_updates_limit_or_reissues_inverse(fault):
    r = ClippedRetryRuntime(recovery_fault=fault)
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


def test_restored_pose_without_fresh_unique_identity_does_not_learn_probe():
    r = ClippedRetryRuntime()
    r.rival_after_return = True
    result = r.pick()
    assert not result["success"]
    assert result["evidence"]["authorization_recovery"]["success"]
    assert "retry_probe" not in result["evidence"]
    assert r.actions._pick_probe_limits == {}
    assert len(actual_grabs(r)) == 1


def test_same_frame_competition_never_borrows_supported_near_anchor():
    r = ClippedRetryRuntime()
    r.clip_after = float("inf")
    r.fault = "competition"
    result = r.pick()
    assert not result["success"] and result["reason"] == "grab_identity_competition"
    assert r.actions._pick_probe_limits == {}
    assert "retry_probe" not in result["evidence"]
    assert len(actual_grabs(r)) == 1


def test_minimum_clipped_probe_blocks_same_view_then_new_independent_supported_view_resets():
    r = ClippedRetryRuntime(clip_gap=.01)
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
    total = len(actual_grabs(r))
    forward_count = len(commands(r, "forward"))
    for _ in range(2):
        result = r.pick()
        assert not result["success"]
        assert result["reason"] in {"pick_requires_new_supported_view", "action_repeat_without_new_evidence"}
    assert len(actual_grabs(r)) == total and len(commands(r, "forward")) == forward_count
    assert min(p["distanceCm"] for p in commands(r, "forward")) >= .1
    # Motion and a new supported observation, not a frame-id reset. Permit a
    # successful synthetic actuator to test independent re-evaluation end to end.
    r.clip_after = float("inf")
    r.actions.move("backward", {"distanceCm": 16, "speed": 30})
    r.grab_results = (True,)
    result = r.pick()
    assert result["success"], result
    assert result["evidence"]["retry_probe_reset"]["reason"] == "independent_supported_view"
    assert result["evidence"]["retry_probe_reset"]["min_hit_pose_gap_m"] == r.perception.wm.assoc_cfg.min_hit_pose_gap_m
    assert r.actions._pick_probe_limits[r.object_id]["limit_cm"] == 6
    assert len(actual_grabs(r)) == total + 1


def test_known_empty_grabs_still_have_three_attempt_limit():
    r = ClippedRetryRuntime(clip_gap=100)
    result = r.pick()
    assert not result["success"] and result["reason"] == "three_grab_attempts_failed"
    assert len(actual_grabs(r)) == len(result["evidence"]["attempts"]) == 3
    assert len(commands(r, "forward")) == 2
