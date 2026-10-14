"""Observed near grasp geometry survives navigation; probe bounds stay local."""
import copy

import pytest

from test_brain_grab_authorization import actual_grabs
from test_brain_perception import ball
from test_brain_pick_pixel_recovery import ClippedRetryRuntime, commands


def near_runtime():
    r = ClippedRetryRuntime(grab_results=(True,), clip_gap=100)
    near = ball(16)
    near["bbox"]["y"] = 100
    r.override_items = [near]
    r.observe()
    assert r.perception.visible(r.object_id)["distance_cm"] < 25
    assert r.actions.current_pick_ready(r.object_id)
    return r


@pytest.mark.parametrize("method", ["go_to", "visual_standoff"])
def test_near_current_pick_geometry_does_not_retreat_to_standoff(method):
    r = near_runtime()
    pose = copy.deepcopy(r.snapshot["odometry"])
    result = (r.execute({"action": "go_to", "params": {"object_id": r.object_id}}) if method == "go_to"
              else r.actions.visual_standoff(r.object_id))
    assert result["success"] and result["reason"] == "target_ready_for_pick"
    assert all(r.snapshot["odometry"][key] == pose[key] for key in ("rightCm", "forwardCm", "headingDeg", "distanceCm"))
    assert not any(commands(r, name) for name in ("forward", "backward", "turn", "grab"))
    readiness = r.actions.navigation_readiness(r.object_id)
    assert readiness["current_pick_ready"] and readiness["operation_ready"]
    assert readiness["standoff_ready"] is False
    assert r.perception._grab_authorizations == {}
    if method == "go_to":
        assert result["evidence"]["navigation_subgoal"]["standoff_ready"] is False
        assert r.actions._navigation_record(r.object_id)["subgoal"] is None
    # Navigation readiness did not create a command proof. A subsequent model
    # pick obtains a fresh source and actual request reference in the usual way.
    r.override_items = None
    r.observe()
    before = r.frame
    result = r.pick()
    assert result["success"] and len(actual_grabs(r)) == 1
    proof = result["evidence"]["attempts"][0]["grab_ref"]["authorization"]
    assert proof["observation_index"] == before
    assert proof["command_ref"]["bridge_request_id"] == actual_grabs(r)[0]["request"]["requestId"]
    assert r.audit()["failures"] == []


@pytest.mark.parametrize("fault", ["unknown", "rival", "pending", "holding", "holding-unknown", "off-road", "old-frame"])
def test_near_readiness_requires_full_current_identity_and_existing_operation_gates(fault):
    r = near_runtime()
    if fault == "unknown":
        r.clip_after = r.forward - 1
        r.observe()
    elif fault == "rival":
        r.override_items.append(copy.deepcopy(r.override_items[0]))
        r.observe()
    elif fault == "pending": r.pending_grasp = {"object_id": r.object_id}
    elif fault == "holding": r.snapshot["holding"]["holding"] = True
    elif fault == "holding-unknown": r.snapshot["holding"]["holding"] = None
    elif fault == "off-road": r.snapshot["road"]["onRoad"] = False
    else: r.snapshot["observation"]["frameId"] = "old-frame"
    assert not r.actions.current_pick_ready(r.object_id)
    assert not r.perception._grab_authorizations
    assert not actual_grabs(r)


@pytest.mark.parametrize("fault", ["unknown", "rival"])
def test_go_to_post_observation_must_recheck_the_same_near_readiness(fault):
    r = near_runtime()
    original = r.observe
    def changed_observation(**kwargs):
        if fault == "unknown": r.clip_after = r.forward - 1
        else: r.override_items.append(copy.deepcopy(r.override_items[0]))
        return original(**kwargs)
    r.observe = changed_observation
    result = r.execute({"action": "go_to", "params": {"object_id": r.object_id}})
    assert not result["success"] and result["reason"] == "fresh_detection_does_not_verify_pick_readiness"
    assert not result["evidence"]["navigation_subgoal"]["current_pick_ready"]
    assert not any(commands(r, name) for name in ("forward", "backward", "turn", "grab"))


@pytest.mark.parametrize("new_gap, expected_step", [(4, 3), (16, 6)])
def test_nonminimum_probe_bound_resets_only_from_an_independent_supported_position(new_gap, expected_step):
    r = ClippedRetryRuntime(grab_results=(False, False, True))
    first = r.pick()
    assert first["evidence"]["retry_probe"]["limit_cm"] == 3
    assert not first["evidence"]["retry_probe"]["requires_new_view"]
    r.clip_after = float("inf")
    r.actions.move("backward", {"distanceCm": new_gap, "speed": 30})
    start = len(commands(r, "forward"))
    result = r.pick()
    assert result["success"], result
    probes = [p["distanceCm"] for p in commands(r, "forward")[start:] if p["speed"] == 20]
    assert probes == [expected_step]
    if new_gap == 16:
        reset = result["evidence"]["retry_probe_reset"]
        assert reset["previous_limit_cm"] == 3 and reset["limit_cm"] == 6
        assert reset["min_hit_pose_gap_m"] == r.perception.wm.assoc_cfg.min_hit_pose_gap_m
    else:
        assert "retry_probe_reset" not in result["evidence"]
    assert r.audit()["failures"] == []


@pytest.mark.parametrize("fault", ["unknown", "rival"])
def test_independent_position_without_fresh_supported_identity_does_not_reset_probe(fault):
    r = ClippedRetryRuntime()
    assert r.pick()["evidence"]["retry_probe"]["limit_cm"] == 3
    r.actions.move("backward", {"distanceCm": 16, "speed": 30})
    if fault == "unknown": r.clip_after = r.forward - 1
    else:
        red = ball(40)
        red["bbox"]["y"] = 100
        r.override_items = [red, copy.deepcopy(red)]
    r.observe()
    result = r.pick()
    assert not result["success"]
    assert "retry_probe_reset" not in result["evidence"]
    assert r.actions._pick_probe_limits[r.object_id]["limit_cm"] == 3
    assert len(actual_grabs(r)) == 1
