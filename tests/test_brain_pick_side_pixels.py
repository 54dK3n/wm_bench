"""Recorded r39 pixels; synthetic actuators exercise the production inverse.

Other-category pixels remain in raw observations and identity candidate lists.
This tests navigation recovery, not a calibrated shape or competition success.
"""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.perception import Perception
from test_brain_grab_authorization import actual_grabs
from test_brain_pick_pixel_recovery import ClippedRetryRuntime, commands


PUBLIC = json.loads((Path(__file__).parent /
    "fixtures/run_20261013T084755_r39_bottom_clip_public.json").read_text())
SIDE_BLUE = PUBLIC["observations"][-1]["observation"]["detections"][1]


class SidePixelsRuntime(ClippedRetryRuntime):
    def __init__(self, **kwargs):
        self.side_kind = "blue"
        self.bad_receipt_method = None
        super().__init__(**kwargs)

    def observe(self, *, motion=None):
        original = self.perception.update
        def public_sensor(raw, odo, **kwargs):
            if not self.holding and self.forward > self.clip_after:
                peer = copy.deepcopy(SIDE_BLUE)
                red = next(d for d in raw["detections"] if d["category"] == "red-ball")
                if self.side_kind == "overlap":
                    peer["bbox"] = copy.deepcopy(red["bbox"])
                elif self.side_kind == "same_category":
                    peer["category"] = "red-ball"
                elif self.side_kind == "full_blue":
                    peer["bbox"]["x"] = 600
                raw["detections"].append(peer)
            return original(raw, odo, **kwargs)
        self.perception.update = public_sensor
        try:
            return super().observe(motion=motion)
        finally:
            self.perception.update = original

    def call(self, method, params):
        result = super().call(method, params)
        return {} if method == self.bad_receipt_method else result


def public_actions():
    row = copy.deepcopy(PUBLIC["observations"][-1])
    return Actions(SimpleNamespace(snapshot=row)), row


def test_original_r39_window_changes_only_inverse_eligibility_without_mutating_records():
    actions, row = public_actions()
    before = copy.deepcopy(row)
    assert PUBLIC["original_authorization_recovery"]["reason"] == "no_recorded_confirmed_view"
    assert [d["category"] for d in row["perception"]["detections"]] == ["red-ball", "blue-ball"]
    assert row["perception"]["detections"][0]["track_id"] is None
    assert row["perception"]["detections"][0]["pixel_quality"]["status"] == "unknown"
    assert actions._bottom_clip_inverse_candidate("red-ball")
    assert row == before
    source = PUBLIC["observations"][1]
    assert source["observation_index"] == 183 and row["observation_index"] == 184
    assert source["perception"]["detections"][0]["pixel_quality"]["status"] == "supported"
    grab, forward = PUBLIC["motions"]
    assert grab["actuator_result"]["completed"] is True
    assert forward["actuator_result"]["completed"] is True
    assert forward["before_observation"] == 183 and forward["after_observation"] == 184
    assert forward["motion_verification"]["motion_verified"] is True
    assert forward["motion_verification"]["measured_cm"] == pytest.approx(5.968249324550724)
    assert forward["motion_verification"]["before_holding"] is False
    assert forward["motion_verification"]["after_holding"] is False
    # Independently convert the same raw current observation. No historical ID
    # is imported or invented to make its clipped red pixels acceptable.
    perception = Perception(PUBLIC["camera"])
    row["perception"] = perception.update(row["observation"], row["odometry"],
        simulation_time_s=row["simulation_seconds"], round_index=row["round"],
        observation_index=row["observation_index"])
    assert actions._bottom_clip_inverse_candidate("red-ball")
    red = row["perception"]["detections"][0]
    assert red["track_id"] is None and red["fed_to_world_model"] is False
    assert row["observation"] == before["observation"]


@pytest.mark.parametrize("fault", ["same_category", "overlap", "touch", "zero_width", "nan",
    "missing_bbox", "outside", "unknown_category", "raw_extra_target", "converted_extra_target",
    "dropped_raw_peer", "different_bbox", "wrong_frame", "wrong_quality_frame", "quality_mismatch",
    "top_clip", "side_clip", "full_frame"])
def test_inverse_candidate_rejects_ambiguous_incomplete_or_unbound_public_pixels(fault):
    actions, row = public_actions()
    raw, detections = row["observation"]["detections"], row["perception"]["detections"]
    if fault == "same_category": raw[1]["category"] = detections[1]["category"] = "red-ball"
    elif fault == "overlap": raw[1]["bbox"] = detections[1]["bbox"] = copy.deepcopy(raw[0]["bbox"])
    elif fault == "touch":
        raw[1]["bbox"] = detections[1]["bbox"] = {"x":488,"y":300,"w":16,"h":12}
    elif fault in {"zero_width", "nan", "outside"}:
        key, value = {"zero_width":("w",0), "nan":("w",float("nan")), "outside":("x",625)}[fault]
        raw[1]["bbox"][key] = detections[1]["bbox"][key] = value
    elif fault == "missing_bbox": raw[1].pop("bbox"); detections[1].pop("bbox")
    elif fault == "unknown_category": raw[1]["category"] = detections[1]["category"] = "unknown-ball"
    elif fault == "raw_extra_target": raw.append(copy.deepcopy(raw[0]))
    elif fault == "converted_extra_target": detections.append(copy.deepcopy(detections[0]))
    elif fault == "dropped_raw_peer": raw.pop()
    elif fault == "different_bbox": detections[0]["bbox"]["w"] -= 1
    elif fault == "wrong_frame": detections[0]["frame_id"] = "183"
    elif fault == "wrong_quality_frame":
        raw[0]["pixelQuality"]["frameId"] = detections[0]["pixel_quality"]["frameId"] = 183
    elif fault == "quality_mismatch": raw[0]["pixelQuality"]["status"] = "supported"
    elif fault in {"top_clip", "side_clip", "full_frame"}:
        box = {"top_clip":{"x":216,"y":0,"w":272,"h":190},
               "side_clip":{"x":0,"y":290,"w":272,"h":190},
               "full_frame":{"x":216,"y":290,"w":272,"h":180}}[fault]
        raw[0]["bbox"] = detections[0]["bbox"] = box
    assert not actions._bottom_clip_inverse_candidate("red-ball")


@pytest.mark.parametrize("side_kind", ["blue", "full_blue"])
def test_side_blue_pixels_allow_measured_inverse_then_fresh_learning_not_a_clipped_grab(side_kind):
    r = SidePixelsRuntime(grab_results=(False, True))
    r.side_kind = side_kind
    result = r.pick()
    assert not result["success"] and result["reason"] == "grab_identity_not_uniquely_visible"
    assert result["evidence"]["authorization_recovery"]["success"]
    probe = result["evidence"]["retry_probe"]
    assert probe["limit_cm"] == 3
    clipped = next(o for o in r.observations if o["observation_index"] == probe["clipped_observation"])
    assert [d["category"] for d in clipped["observation"]["detections"]] == ["red-ball", "blue-ball"]
    assert [d["category"] for d in clipped["perception"]["detections"]] == ["red-ball", "blue-ball"]
    assert clipped["perception"]["detections"][0]["track_id"] is None
    assert clipped["perception"]["detections"][0]["fed_to_world_model"] is False
    assert len(actual_grabs(r)) == 1 and len(commands(r, "backward")) == 1
    assert commands(r, "backward")[0]["distanceCm"] == pytest.approx(6)
    assert r.forward == pytest.approx(r.entry["forwardCm"])
    assert r.pending_grasp is None and r.held_object_id is None
    assert not r.perception.action_evidence()
    # A later model pick can use the smaller bound, with no repeated old grab.
    second = r.pick()
    assert not second["success"] and second["evidence"]["attempts"] == []
    assert second["evidence"]["retry_probe"]["limit_cm"] == 1.5
    assert second["evidence"]["pick_retry"]["classification"] == "supported_approach_probe_refined"
    assert len(actual_grabs(r)) == 1
    third = r.pick()
    assert third["success"] and len(actual_grabs(r)) == 2
    assert third["evidence"]["attempts"][0]["grab_ref"]["authorization"]["observation_index"] > probe["restored_observation"]
    assert r.audit()["failures"] == []


@pytest.mark.parametrize("side_kind", ["overlap", "same_category"])
def test_current_peer_competition_does_not_borrow_near_anchor(side_kind):
    r = SidePixelsRuntime()
    r.side_kind = side_kind
    result = r.pick()
    assert not result["success"]
    assert not result["evidence"]["authorization_recovery"]["success"]
    assert "retry_probe" not in result["evidence"]
    assert r.actions._pick_probe_limits == {}
    assert len(actual_grabs(r)) == 1 and not commands(r, "backward")


@pytest.mark.parametrize("method", ["grab", "forward"])
def test_missing_completed_receipt_cannot_license_inverse_or_learning(method):
    r = SidePixelsRuntime()
    r.bad_receipt_method = method
    result = r.pick()
    assert not result["success"] and "retry_probe" not in result["evidence"]
    assert not commands(r, "backward") and r.actions._pick_probe_limits == {}
    assert len(actual_grabs(r)) == 1


@pytest.mark.parametrize("fault", ["forward-unknown", "unknown", "partial"])
def test_side_pixels_do_not_resend_unknown_or_accept_partial_inverse(fault):
    r = SidePixelsRuntime(recovery_fault=fault)
    if fault == "partial":
        result = r.pick()
        assert not result["success"]
        assert not result["evidence"]["authorization_recovery"]["success"]
    else:
        with pytest.raises(ConnectionError): r.pick()
    assert r.actions._pick_probe_limits == {} and not r.perception.action_evidence()
    assert r.inverse_attempts == (0 if fault == "forward-unknown" else 1)
    assert len(actual_grabs(r)) == 1


def test_successful_inverse_with_restored_red_competition_cannot_learn_or_offer_retry():
    r = SidePixelsRuntime()
    r.rival_after_return = True
    result = r.pick()
    assert not result["success"] and result["evidence"]["authorization_recovery"]["success"]
    assert "retry_probe" not in result["evidence"] and "pick_retry" not in result["evidence"]
    assert r.actions._pick_probe_limits == {} and len(actual_grabs(r)) == 1
