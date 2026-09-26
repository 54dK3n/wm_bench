"""Stage-one manipulation closure from synthetic permitted sensor observations."""
import copy
from types import SimpleNamespace

import pytest

from test_brain_perception import CAMERA, Perception, ball, observe, grasp_evidence
from test_brain_delivery_identity import DeliveryRuntime
from test_brain_place_path_recovery import place_runtime
from test_brain_pick_road_return import pick_runtime
from autonomous_brain.actions import Actions, basic_motion_evidence
from autonomous_brain.perception import DETECTOR_WIDTH_CM


def test_completed_place_command_with_zero_odometry_never_releases():
    runtime, motions, logs, objects, _ = place_runtime([(30, 0)], actual_first_cm=0)
    result = Actions(runtime).place()
    assert not result["success"] and result["reason"] == "place_motion_not_verified"
    assert [method for method, _ in motions] == ["forward"]
    assert objects["held"]["state"] == "HELD"
    assert "zero_displacement" in logs[0]["motion_verification"]["reasons"]
    assert "insufficient_displacement" in logs[0]["motion_verification"]["reasons"]


def test_pending_grasp_drop_during_retreat_never_writes_held():
    runtime, motions, _, objects, _ = place_runtime([(18, 0)])
    objects["held"]["state"] = "CONFIRMED"
    runtime.held_object_id = None
    runtime.pending_grasp = {"object_id": "held", "category": "red-ball",
                             "original_position_m": (0, .18)}
    marks = []
    runtime.perception.mark_picked = lambda *args, **kwargs: marks.append(kwargs)
    original_call = runtime.bridge.call
    def dropping(method, params):
        result = original_call(method, params)
        if method == "backward":
            runtime.snapshot["holding"]["holding"] = False
        return result
    runtime.bridge.call = dropping
    result = Actions(runtime).place()
    assert not result["success"] and result["reason"] == "place_holding_changed_during_motion"
    assert motions == [("backward", {"distanceCm": 16, "speed": 30})]
    assert marks == [] and objects["held"]["state"] == "CONFIRMED"
    assert runtime.held_object_id is None and runtime.pending_grasp is None


def test_pick_drop_during_retreat_clears_pending_identity():
    runtime, calls, _, marks, _, target = pick_runtime()
    original_call = runtime.bridge.call
    def dropping(method, params):
        result = original_call(method, params)
        if method == "backward":
            runtime.snapshot["holding"]["holding"] = False
        return result
    runtime.bridge.call = dropping
    result = Actions(runtime).pick(target["id"])
    assert not result["success"] and result["reason"] == "pick_holding_changed_during_motion"
    assert marks == [] and target["state"] == "CONFIRMED"
    assert runtime.pending_grasp is None and runtime.held_object_id is None
    assert len([row for row in calls if row["method"] == "grab"]) == 1


@pytest.mark.parametrize("fault", ["actuator", "observation"])
def test_uncertain_execution_only_reobserves_without_resending(fault):
    runtime, motions, logs, _, _ = place_runtime([(18, 0)])
    calls, observations = [], []
    original_call, original_observe = runtime.bridge.call, runtime.observe
    def call(method, params):
        calls.append(method)
        value = original_call(method, params)
        if fault == "actuator":
            raise ConnectionError("acknowledgement lost")
        return value
    def observe_once(*, motion=None):
        observations.append(motion)
        if fault == "observation" and len(observations) == 1:
            raise ConnectionError("sensor interrupted")
        return original_observe(motion=motion)
    runtime.bridge.call, runtime.observe = call, observe_once
    with pytest.raises(ConnectionError):
        Actions(runtime).place()
    assert calls == ["release"]
    assert logs[-1]["outcome_unknown"] is True
    assert runtime.snapshot["holding"]["holding"] is False
    assert observations[-1] is None


def confirmed_red():
    p = Perception(CAMERA)
    for frame, forward in enumerate((0, 16, 32), 1):
        observe(p, frame, forward)
    return p, p.objects()[0]["id"]


@pytest.mark.parametrize("case", ["behind_camera", "occluder", "stale_frame"])
def test_empty_detection_list_alone_is_not_original_position_absence(case):
    p, oid = confirmed_red()
    observe(p, 4, 32, items=[], time=.4)
    valid = grasp_evidence(p, oid)
    assert valid["original_position_observation"]["valid"] is True
    if case == "behind_camera":
        observe(p, 5, 32, heading=180, items=[], time=.5)
        evidence = grasp_evidence(p, oid)
    elif case == "occluder":
        box = valid["original_position_observation"]["projected_bbox"]
        obstacle = {"category": "obstacle", "source": "virtual-cv", "confidence": .95,
                    "bbox": copy.deepcopy(box)}
        observe(p, 5, 32, items=[obstacle], time=.5)
        evidence = grasp_evidence(p, oid)
    else:
        observe(p, 5, 32, items=[], time=.5)
        evidence = valid
    assert p.mark_picked(oid, holding=True, original_position_absent=True,
        simulation_time_s=.5, evidence=evidence) is False
    assert p.get_object(oid)["state"] != "HELD"


def released_runtime():
    r = DeliveryRuntime()
    r.call("release", {})
    r.observe()
    release = {"frame_id": r.snapshot["observation"]["frameId"],
               "simulation_time_s": r.bridge.seconds, "preexisting_ball_ids": []}
    evidence = Actions(r).placement_evidence("red-ball", release)
    assert r.perception.mark_release_unverified(r.original_id,
        simulation_time_s=r.bridge.seconds, evidence=evidence)
    r.held_object_id = None
    return r, release


def test_later_place_observation_resolves_saved_release_without_second_release():
    r, release = released_runtime()
    assert r.perception.get_object(r.original_id)["state"] == "RELEASED_UNVERIFIED"
    r.call("backward", {"distanceCm": 25, "speed": 30})
    r.observe()
    before = copy.deepcopy(r.motions)
    outcome = Actions(r).place()
    assert outcome["success"] is True and r.motions == before
    assert r.perception.get_object(r.original_id)["state"] == "DELIVERED"
    assert r.perception.unverified_releases() == []
    placement = r.perception.action_evidence()[-1]
    assert placement["action"] == "place" and placement["holding"] is False
    assert placement["evidence"]["release_observation"] == release


@pytest.mark.parametrize("fault", ["no_view", "two_candidates", "far_identity", "old_delivered_missing"])
def test_insufficient_later_release_evidence_remains_unresolved(fault):
    r, _ = released_runtime()
    saved = r.perception._unverified_releases[r.original_id]
    if fault == "no_view":
        r.public_detections = lambda: []
    elif fault == "two_candidates":
        r.public_detections = lambda: [ball(45, bearing=-8), ball(45, bearing=8)]
    elif fault == "far_identity":
        r.forward = 300
    else:
        saved["required_delivered_ids"] = ["old-delivered-missing"]
    r.bridge.seconds += 1
    r.observe()
    result = Actions(r).recover_released_objects()
    assert result and result[0]["resolved"] is False
    assert r.perception.get_object(r.original_id)["state"] == "RELEASED_UNVERIFIED"
    assert r.perception.unverified_releases()


def test_confirmed_unique_release_outside_complete_zone_becomes_pickable():
    r, release = released_runtime()
    zone = {"category": "storage-zone", "source": "storage-ground-pixels", "confidence": 1,
            "bbox": {"x": 50, "y": 300, "w": 80, "h": 70}}
    # New track sees the same physical sensor location from three independent poses.
    for frame, forward in enumerate((90, 106, 122), 20):
        r.frame = frame
        r.forward = forward
        r.bridge.seconds += .1
        r.public_detections = lambda: [ball(170 - r.forward), zone]
        r.observe()
    result = Actions(r).recover_released_objects()[0]
    assert result["resolved"] is True and result["state"] == "CONFIRMED"
    assert r.perception.confirmed(result["recovered_object_id"]) is not None
    assert r.perception.get_object(r.original_id)["alias_of"] == result["recovered_object_id"]
    assert r.perception.unverified_releases() == []
    assert r.perception.action_evidence()[-1]["evidence"]["release_observation"] == release


@pytest.mark.parametrize("category,width", [("red-ball", 5.5), ("blue-ball", 5.5), ("obstacle", 5.75)])
def test_detector_width_is_physical_diameter_and_wm_radius_is_half(category, width):
    p = Perception(CAMERA)
    raw = ball(60, category)
    evidence = observe(p, 1, items=[raw])
    assert DETECTOR_WIDTH_CM[category] == pytest.approx(width)
    assert evidence["detections"][0]["physical_size"]["radius_cm"] == pytest.approx(width / 2)
    track = p.wm.get_scene()[0]
    assert track.radius_cm == pytest.approx(width / 2)
    assert p.objects()[0]["radius_cm"] == pytest.approx(width / 2)
    assert track.size_trusted is True
    assert p.wm.assoc_cfg.max_gate_distance_m == .3


@pytest.mark.parametrize("fault", ["old_object_missing", "wrong_release_anchor"])
def test_direct_delivery_mark_cannot_bypass_saved_release_identity_obligations(fault):
    r, release = released_runtime()
    r.call("backward", {"distanceCm": 25, "speed": 30})
    r.observe()
    saved = r.perception._unverified_releases[r.original_id]
    if fault == "old_object_missing":
        saved["required_delivered_ids"] = ["old-object-no-longer-visible"]
    else:
        saved["identity_anchor_m"] = {"x": 100, "z": 100}
    evidence = Actions(r).placement_evidence("red-ball", release)
    assert evidence["candidate_witnesses"] == 1
    assert r.perception.mark_delivered(r.original_id, holding=False, ball_in_storage=True,
        simulation_time_s=r.bridge.seconds, evidence=evidence) is False
    assert r.perception.get_object(r.original_id)["state"] == "RELEASED_UNVERIFIED"
