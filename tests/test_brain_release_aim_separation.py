"""A54 components: actual public frame replay and real dynamic perception.

The actual-frame adapter freezes its public object rows. The separate scripted
runtime runs original Perception.update, vendored WM, Actions and ledger audit.
Neither constitutes a new platform run.
"""
import copy
import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.navigation import RoadMemory
from autonomous_brain.perception import Perception
from autonomous_brain.task import parse_task
from test_brain_release_recovery_integration import (
    ReleaseRecoveryRuntime, motion_calls, pending_runtime, prepare_legal_view, release_calls,
)


FIXTURE = json.loads((Path(__file__).parent /
    "fixtures/run_20261020T112801Z_release_aim_public.json").read_text())


class PublicReleasePerception(Perception):
    """Actual public object snapshot; production projection and gate methods."""

    def __init__(self, frame):
        super().__init__(FIXTURE["camera_parameters"])
        self._public_rows = copy.deepcopy(frame["objects"])
        self.last_evidence = frame["perception"]
        self._last_frame = str(frame["observation"]["frameId"])
        self._last_timestamp = frame["simulation_seconds"]
        self._delivered_positions = {
            FIXTURE["old_object_id"]: {
                "category": "red-ball",
                "position_m": copy.deepcopy(FIXTURE["old_placement"]["ball_position_m"]),
                "frame_id": str(FIXTURE["old_placement"]["frame_id"]),
            }}

    def objects(self):
        return copy.deepcopy(self._public_rows)

    def get_object(self, object_id):
        return next((copy.deepcopy(row) for row in self._public_rows
                     if row["id"] == object_id), None)


def actual_runtime():
    frame = copy.deepcopy(FIXTURE["frame"])
    calls = []

    def forbidden_call(method, params):
        calls.append((method, copy.deepcopy(params)))
        raise AssertionError("unsafe actual frame must not dispatch")

    runtime = SimpleNamespace(snapshot=frame, perception=PublicReleasePerception(frame),
        roads=RoadMemory(), round=104, held_object_id=FIXTURE["held_object_id"],
        pending_grasp=None, task_spec=parse_task("把两个红球送到绿色存放区"),
        bridge=SimpleNamespace(seconds=frame["simulation_seconds"], max_seconds=1200,
                               sequence=0, call=forbidden_call))
    runtime.roads.update(frame["odometry"], frame["road"], frame["observation_index"])
    runtime.roads.observe_traversal(frame)
    runtime.actions = Actions(runtime)
    return runtime, calls


def held_runtime():
    """Real old delivery and a second real grasp, then declared setup pose."""
    runtime = ReleaseRecoveryRuntime()
    assert runtime.execute("pick", {"object_id": runtime.old_id})["success"]
    assert runtime.execute("place")["success"]
    runtime.focus = "new"
    runtime.points["new"] = {"x": .2, "z": .9}
    runtime.right, runtime.forward, runtime.heading = 20., 0., 0.
    runtime._confirm_current_target()
    runtime.new_id = runtime._nearest_object(runtime.points["new"])
    assert runtime.execute("pick", {"object_id": runtime.new_id})["success"]
    runtime.right, runtime.forward, runtime.heading = -20., 0., 0.
    runtime.observe()
    return runtime


def old_detection(runtime):
    return next(row for row in runtime.snapshot["perception"]["detections"]
                if row.get("known_delivered_object_id") ==
                   (getattr(runtime, "old_id", None) or FIXTURE["old_object_id"]))


def test_actual588_original_aim_contained_old_identity_disk_and_new_selector_refuses():
    runtime, calls = actual_runtime()
    old = FIXTURE["old_placement"]["ball_position_m"]
    new = FIXTURE["actual_release_aim"]["position_m"]
    gap = math.hypot(old["x"] - new["x"], old["z"] - new["z"]) * 100
    assert gap == pytest.approx(10.216193791408182)
    assert gap + 15 < 30
    before = copy.deepcopy(runtime.perception._delivered_positions)
    aim = runtime.actions.choose_release_aim()
    assert aim["error"] == "storage_release_identity_separation_unavailable"
    proof = aim["identity_separation"]
    assert proof["current_observed_delivered_ids"] == [FIXTURE["old_object_id"]]
    assert proof["candidate_count"] == 13 and proof["eligible_candidate_count"] == 0
    assert proof["best_candidate_separation_cm"] < 30
    outcome = runtime.actions.place()
    assert outcome["success"] is False
    assert outcome["reason"] == aim["error"]
    assert calls == []
    assert runtime.snapshot["holding"]["holding"] is True
    assert runtime.held_object_id == FIXTURE["held_object_id"]
    assert runtime.perception._delivered_positions == before


def test_real_current40cm_arrangement_is_allowed_then_original_joint_verifier_delivers():
    runtime = held_runtime()
    aim = runtime.actions.choose_release_aim()
    assert "error" not in aim
    proof = aim["identity_separation"]
    assert 30 < proof["selected_minimum_separation_cm"] < 45
    assert proof["eligible_candidate_count"] > 0
    assert proof["required_distance_cm"] == 30 and proof["preferred_distance_cm"] == 45
    saved_anchor = copy.deepcopy(runtime.perception._delivered_positions[runtime.old_id])
    runtime.witness_mode = "new_only"
    before_releases = len(release_calls(runtime))
    result = runtime.execute("place")
    assert not result["success"]
    assert len(release_calls(runtime)) == before_releases + 1
    pending = copy.deepcopy(runtime.perception.unverified_releases()[0])
    assert pending["required_delivered_ids"] == [runtime.old_id]
    assert runtime.perception.get_object(runtime.new_id)["state"] == "RELEASED_UNVERIFIED"
    assert runtime.perception._delivered_positions[runtime.old_id] == saved_anchor
    prepare_legal_view(runtime)
    assert runtime.execute("place")["success"]
    assert len(release_calls(runtime)) == before_releases + 1
    events = [row for row in runtime.perception.action_evidence()
              if row["action"] == "place"]
    assert {row["object_id"] for row in events} == {runtime.old_id, runtime.new_id}
    assert events[-1]["evidence"]["release_observation"] == pending["release_observation"]
    audit = runtime.audit()
    assert audit["failures"] == []
    assert len(audit["deliveries"]) == 2 and all(row["verified"] for row in audit["deliveries"])
    assert runtime.execute("done")["success"]


@pytest.mark.parametrize("fault", [
    "missing_old", "unknown_pixels", "ambiguous_old", "wrong_frame", "stale_perception",
    "stale_tick", "duplicate_old", "wrong_index", "rival_id", "clipped_old",
    "missing_anchor", "anchor_nan", "anchor_row_mismatch", "match_distance",
])
def test_second_release_requires_current_original_independent_old_witness(fault):
    runtime = held_runtime()
    assert "error" not in runtime.actions.choose_release_aim()
    item = old_detection(runtime)
    detections = runtime.snapshot["perception"]["detections"]
    if fault == "missing_old":
        detections.remove(item)
    elif fault == "unknown_pixels":
        item["pixel_quality"]["status"] = "unknown"
    elif fault == "ambiguous_old":
        item["identity_ambiguity"] = {"competitors": ["rival"]}
    elif fault == "wrong_frame":
        item["frame_id"] = "old-frame"
    elif fault == "stale_perception":
        runtime.snapshot["perception"]["frame_id"] = "old-frame"
    elif fault == "stale_tick":
        runtime.snapshot["road"]["tick"] -= 1
    elif fault == "duplicate_old":
        detections.append(copy.deepcopy(item))
    elif fault == "wrong_index":
        item["delivered_identity_evidence"]["candidate_detection_indices"] = [100]
    elif fault == "rival_id":
        item["delivered_identity_evidence"]["candidate_ids"].append("rival")
    elif fault == "clipped_old":
        item["bbox"]["x"] = 0.
    elif fault == "missing_anchor":
        runtime.perception._delivered_positions.clear()
    elif fault == "anchor_nan":
        runtime.perception._delivered_positions[runtime.old_id]["position_m"]["x"] = float("nan")
    elif fault == "anchor_row_mismatch":
        runtime.perception._delivered_positions[runtime.old_id]["position_m"]["x"] += .2
    elif fault == "match_distance":
        item["delivered_match_distance_m"] += .01
    before = len(motion_calls(runtime))
    outcome = runtime.actions.place()
    assert outcome["success"] is False
    assert outcome["reason"] in {
        "release_aim_delivered_anchor_unavailable",
        "release_aim_previous_delivered_not_independently_observed"}
    assert len(motion_calls(runtime)) == before
    assert runtime.holding is True and runtime.held_object_id == runtime.new_id
    assert len(release_calls(runtime)) == 1


@pytest.mark.parametrize("key", ["rightCm", "forwardCm", "headingDeg"])
@pytest.mark.parametrize("value", [None, True, float("nan"), float("inf")])
def test_malformed_current_pose_cannot_project_a_safe_second_release(key, value):
    runtime = held_runtime()
    if value is None:
        del runtime.snapshot["odometry"][key]
    else:
        runtime.snapshot["odometry"][key] = value
    before = len(motion_calls(runtime))
    outcome = runtime.actions.place()
    assert outcome["success"] is False
    assert outcome["reason"] == "storage_free_point_projection_invalid"
    assert len(motion_calls(runtime)) == before
    assert runtime.holding and len(release_calls(runtime)) == 1


@pytest.mark.parametrize("distance_cm,allowed", [(29.999, False), (30., False), (30.001, True),
                                                (40., True)])
def test_strict30cm_boundary_includes_both_anchor_and_current_projection(distance_cm, allowed):
    runtime = held_runtime()
    anchor = runtime.perception._delivered_positions[runtime.old_id]["position_m"]
    projection = old_detection(runtime)["position_m"]
    # Declared projection-kernel boundary fixture only; the dynamic positive
    # above uses the real calibrated ground camera and real WM throughout.
    nearest_z = min(anchor["z"], projection["z"])
    runtime.perception.ground_camera = SimpleNamespace(
        project_pixel_to_ground=lambda u, v: (0., nearest_z - distance_cm / 100))
    outcome = runtime.actions.choose_release_aim()
    assert ("error" not in outcome) is allowed
    if allowed:
        assert outcome["identity_separation"]["selected_minimum_separation_cm"] > 30
    else:
        assert outcome["error"] == "storage_release_identity_separation_unavailable"


def test_new_aim_and_current_projection_are_not_delivery_authorization_or_mutable_anchor():
    runtime = held_runtime()
    before = copy.deepcopy(runtime.perception.action_evidence())
    anchors = copy.deepcopy(runtime.perception._delivered_positions)
    aim = runtime.actions.choose_release_aim()
    assert "error" not in aim
    aim["identity_separation"]["anchor_observation_refs"][0]["position_m"]["x"] = 999
    aim["position_m"]["x"] = 999
    assert runtime.perception._delivered_positions == anchors
    assert runtime.perception.action_evidence() == before
    assert runtime.perception.get_object(runtime.new_id)["state"] == "HELD"
    assert not runtime.execute("done")["success"]


def test_unknown_second_release_is_single_send_and_cannot_claim_delivery():
    runtime = held_runtime()
    runtime.unknown_method = "release"
    before = len(release_calls(runtime))
    with pytest.raises(TimeoutError):
        runtime.execute("place")
    assert len(release_calls(runtime)) == before + 1
    assert runtime.motions[-1]["method"] == "release"
    assert runtime.motions[-1]["outcome_unknown"] is True
    assert [row["object_id"] for row in runtime.perception.action_evidence()
            if row["action"] == "place"] == [runtime.old_id]
    assert not runtime.execute("done")["success"]
