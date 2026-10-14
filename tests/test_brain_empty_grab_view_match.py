"""A failed grab is not a failed spatial region or a changed pixel view.

The public window is a component replay, not a new competition. Synthetic
operation tests use real Actions/Perception/WM and retain fresh authorization.
"""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from test_brain_grab_authorization import actual_grabs
from test_brain_pick_pixel_recovery import ClippedRetryRuntime, commands


def fixture():
    return json.loads((Path(__file__).parent / "fixtures" /
        "run_20261013T092236_r32_empty_view_public.json").read_text())


def public_actions(data):
    snapshots = {r["observation_index"]: r for r in data["observations"]}
    runtime = SimpleNamespace(snapshot=snapshots[134], pending_grasp=None, held_object_id=None)
    runtime.perception = SimpleNamespace(visible=lambda oid: next((d for d in
        runtime.snapshot["perception"]["detections"] if d.get("track_id") == oid), None),
        get_object=lambda oid: None)
    return runtime, Actions(runtime), snapshots


def test_public_133_to_138_changed_bbox_cancels_the_real_old_navigation_skip():
    data = fixture()
    runtime, actions, snapshots = public_actions(data)
    ref = data["grab_ref"]
    oid = ref["object_id"]
    selected = ref["authorization"]["detections"][ref["authorization"]["detection_index"]]
    actions.remember_empty_grab_navigation(oid, ref, data["grab_motion"], data["grab_receipt"])
    memory = actions.empty_grab_navigation_hint(oid)
    assert memory is not None and memory["bbox"] == selected["bbox"]
    assert memory["bbox"] == {"x": 208, "y": 270, "w": 212, "h": 204}
    runtime.snapshot = snapshots[138]
    current = runtime.perception.visible(oid)
    assert current["pixel_quality"]["status"] == "supported"
    assert current["bbox"] == {"x": 206, "y": 270, "w": 214, "h": 206}
    assert actions._empty_grab_pose_equal(memory["odometry"], runtime.snapshot["odometry"])
    old = data["old_navigation_probe"]
    assert old["source_observation"] == 138 and old["requested_cm"] == .1
    assert old["navigation_memory"]["bridge_request_id"] == ref["bridge_request_id"]
    assert actions.empty_grab_navigation_hint(oid) is None
    # Clipped follow-up remains unsupported; cancelling a hint grants no ID.
    runtime.snapshot = snapshots[139]
    assert actions.empty_grab_navigation_hint(oid) is None
    assert actions._empty_grab_navigation[oid][0]["bbox"] == selected["bbox"]


@pytest.mark.parametrize("key", ["forwardCm", "rightCm", "headingDeg"])
def test_a_sub_two_mm_or_small_heading_change_is_not_a_known_empty_pose(key):
    data = fixture()
    runtime, actions, _ = public_actions(data)
    oid = data["grab_ref"]["object_id"]
    actions.remember_empty_grab_navigation(oid, data["grab_ref"], data["grab_motion"], data["grab_receipt"])
    assert actions.empty_grab_navigation_hint(oid) is not None
    runtime.snapshot["odometry"][key] += .1
    assert actions.empty_grab_navigation_hint(oid) is None


def test_current_frame_tick_and_total_travel_are_not_spatial_cache_keys():
    r = ClippedRetryRuntime()
    r.pick()
    original = r.actions.empty_grab_navigation_hint(r.object_id)
    assert original is not None
    r.observe()
    r.snapshot["odometry"]["distanceCm"] += 10
    r.snapshot["odometry"]["tick"] += 100
    assert r.actions.empty_grab_navigation_hint(r.object_id) == original


def test_changed_full_view_issues_a_new_authorized_grab_before_a_navigation_probe():
    r = ClippedRetryRuntime()
    first = r.pick()
    old = first["evidence"]["attempts"][0]["grab_ref"]
    r.override_items = copy.deepcopy(r.snapshot["observation"]["detections"])
    r.override_items[0]["bbox"]["h"] -= 2
    r.observe()
    assert r.perception.check_grasp_identity(r.object_id, r.snapshot)["authorized"]
    assert r.actions.empty_grab_navigation_hint(r.object_id) is None
    before = len(actual_grabs(r))
    second = r.pick()
    assert len(actual_grabs(r)) == before + 1
    assert second["evidence"]["pick_trajectory"][0]["method"] == "grab"
    new = second["evidence"]["attempts"][0]["grab_ref"]
    assert new["bridge_request_id"] != old["bridge_request_id"]
    assert new["authorization"]["observation_index"] == new["before_observation"]
    selected = new["authorization"]["detections"][new["authorization"]["detection_index"]]
    assert selected["pixel_quality"]["status"] == "supported"
    assert selected["bbox"] != old["authorization"]["detections"][0]["bbox"]
    assert r.audit()["failures"] == []


def test_same_pose_and_bbox_still_skip_only_navigation_not_a_grab_authorization():
    r = ClippedRetryRuntime()
    r.pick()
    second = r.pick()
    assert second["evidence"]["attempts"] == [] and len(actual_grabs(r)) == 1
    assert [m["method"] for m in second["evidence"]["pick_trajectory"]] == ["forward", "backward"]
    assert r.pending_grasp is None and r.held_object_id is None


def test_authorized_bbox_is_copied_and_changed_boxes_at_same_pose_are_not_deduplicated():
    data = fixture()
    runtime, actions, _ = public_actions(data)
    ref = data["grab_ref"]
    oid = ref["object_id"]
    actions.remember_empty_grab_navigation(oid, ref, data["grab_motion"], data["grab_receipt"])
    ref["authorization"]["detections"][0]["bbox"]["h"] -= 2
    assert actions._empty_grab_navigation[oid][0]["bbox"]["h"] == 204
    actions.remember_empty_grab_navigation(oid, ref, data["grab_motion"], data["grab_receipt"])
    assert [row["bbox"]["h"] for row in actions._empty_grab_navigation[oid]] == [204, 202]


@pytest.mark.parametrize("bad", ["unknown", "frame", "selection", "observation", "bbox"])
def test_missing_or_unbound_authorized_pixels_do_not_seed_navigation_cache(bad):
    data = fixture()
    _, actions, _ = public_actions(data)
    ref = data["grab_ref"]
    auth = ref["authorization"]
    if bad == "unknown": auth["detections"][0]["pixel_quality"]["status"] = "unknown"
    elif bad == "frame": auth["detections"][0]["frame_id"] = "other"
    elif bad == "selection": auth["detection_index"] = -1
    elif bad == "observation": auth["observation_index"] -= 1
    else: auth["detections"][0]["bbox"]["h"] = float("nan")
    actions.remember_empty_grab_navigation(ref["object_id"], ref, data["grab_motion"], data["grab_receipt"])
    assert actions._empty_grab_navigation == {}


def test_changed_bbox_with_current_competition_does_not_issue_grab_or_probe():
    r = ClippedRetryRuntime()
    r.pick()
    r.override_items = copy.deepcopy(r.snapshot["observation"]["detections"])
    r.override_items[0]["bbox"]["h"] -= 2
    r.extra_items = copy.deepcopy(r.override_items)
    r.observe()
    before_grab, before_forward = len(actual_grabs(r)), len(commands(r, "forward"))
    result = r.pick()
    assert not result["success"]
    assert len(actual_grabs(r)) == before_grab and len(commands(r, "forward")) == before_forward


def test_unknown_navigation_command_clears_old_hint_without_retry_or_new_grab():
    r = ClippedRetryRuntime()
    r.pick()
    r.recovery_fault = "forward-unknown"
    before_grabs, before_forward = len(actual_grabs(r)), len(commands(r, "forward"))
    with pytest.raises(ConnectionError): r.pick()
    assert len(actual_grabs(r)) == before_grabs
    assert len(commands(r, "forward")) == before_forward + 1
    assert r.actions._empty_grab_navigation == {}
