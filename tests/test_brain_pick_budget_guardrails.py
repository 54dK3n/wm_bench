"""Additional budget-transition boundaries; all actuators are synthetic.

The pre-existing test_brain_pick_budget_new_view.py is reused unchanged.
"""
import copy

import pytest

from autonomous_brain.llm import validate_action
from autonomous_brain.run import Runtime, compact_action_result
from test_brain_grab_authorization import actual_grabs
from test_brain_pick_budget_new_view import consume_budget, reduced_initial_probe
from test_brain_pick_pixel_recovery import commands


def test_approach_breaks_before_budget_without_requiring_another_view():
    r = reduced_initial_probe(shrinks=4)
    old = copy.deepcopy(r.actions._pick_probe_limits[r.object_id])
    r.actions.move("forward", {"distanceCm": 14.5, "speed": 30})
    assert not r.actions.pick_probe_view_status(r.object_id)["independent_supported_view"]
    start = len(commands(r, "forward"))
    result = r.pick()
    assert result["success"] and len(actual_grabs(r)) == 1
    assert 0 < len(commands(r, "forward")) - start < 10
    assert r.actions._pick_probe_limits[r.object_id] == old
    assert "retry_probe" not in result["evidence"]


@pytest.mark.parametrize("return_away", [False, True])
def test_tenth_step_ready_is_not_reclassified_by_later_road_return(return_away):
    r = reduced_initial_probe(shrinks=4)
    old = copy.deepcopy(r.actions._pick_probe_limits[r.object_id])
    r.actions.move("forward", {"distanceCm": 14, "speed": 30})
    assert not r.actions.pick_probe_view_status(r.object_id)["independent_supported_view"]
    original = r.actions.return_place_path
    readiness_at_return = []

    def observed_return(trajectory):
        readiness_at_return.append(r.actions.current_pick_ready(r.object_id))
        result = original(trajectory)
        if return_away:
            # A synthetic, measured inverse of part of this forward path.
            # It changes the final view without granting any grasp authority.
            r.actions.move("backward", {"distanceCm": 1, "speed": 30})
            result["after_observation"] = r.snapshot["observation_index"]
        return result

    r.actions.return_place_path = observed_return
    start = len(commands(r, "forward"))
    result = r.pick()
    assert not result["success"] and result["reason"] == "pick_approach_view_budget_exhausted"
    assert len(commands(r, "forward")) - start == 10
    assert readiness_at_return == [True]
    assert r.actions.current_pick_ready(r.object_id) is (not return_away)
    assert r.actions._pick_probe_limits[r.object_id] == old
    assert "retry_probe" not in result["evidence"] and not actual_grabs(r)


def test_failed_road_return_cannot_establish_budget_view_anchor():
    r = reduced_initial_probe()
    old = copy.deepcopy(r.actions._pick_probe_limits[r.object_id])
    r.actions.return_place_path = lambda trajectory: {
        "success": False, "reason": "synthetic_return_unverified",
        "after_observation": r.snapshot["observation_index"], "motions": []}
    result = r.pick()
    assert result["reason"] == "pick_approach_view_budget_exhausted"
    assert len(result["evidence"]["pick_trajectory"]) == 10
    assert r.actions._pick_probe_limits[r.object_id] == old
    assert "retry_probe" not in result["evidence"] and not actual_grabs(r)


def test_tenth_step_in_pick_range_off_road_is_not_reclassified_after_return():
    r = reduced_initial_probe(shrinks=4)
    old = copy.deepcopy(r.actions._pick_probe_limits[r.object_id])
    r.actions.move("forward", {"distanceCm": 14, "speed": 30})
    original_observe, original_return = r.observe, r.actions.return_place_path
    forwards, return_range = [], []

    def leave_road(*, motion=None):
        row = original_observe(motion=motion)
        if (motion or {}).get("method") == "forward":
            forwards.append(motion)
            if len(forwards) == 10:
                row["road"]["onRoad"] = False
        return row

    def return_from_ready_range(trajectory):
        assert r.snapshot["road"]["onRoad"] is False
        assert not r.actions.current_pick_ready(r.object_id)
        return_range.append(r.actions.object_geometry(r.perception.confirmed(r.object_id))[0])
        return original_return(trajectory)

    r.observe = leave_road
    r.actions.return_place_path = return_from_ready_range
    result = r.pick()
    assert result["reason"] == "pick_approach_view_budget_exhausted"
    assert len(forwards) == 10 and return_range[0] <= 22.5
    assert result["evidence"]["road_return"]["success"]
    assert r.actions.object_geometry(r.perception.confirmed(r.object_id))[0] > 22.5
    assert r.actions._pick_probe_limits[r.object_id] == old
    assert "retry_probe" not in result["evidence"] and not actual_grabs(r)


def test_tenth_incomplete_receipt_cannot_be_counted_as_completed_budget():
    r = reduced_initial_probe()
    old = copy.deepcopy(r.actions._pick_probe_limits[r.object_id])
    original, forwards = r.bridge.call, []

    def incomplete(method, params):
        result = original(method, params)
        if method == "forward":
            forwards.append(copy.deepcopy(params))
            if len(forwards) == 10:
                return {"accepted": True, "completed": False}
        return result

    r.bridge.call = incomplete
    result = r.pick()
    assert result["reason"] == "pick_probe_receipt_not_completed"
    assert len(forwards) == 10
    assert r.actions._pick_probe_limits[r.object_id] == old
    assert "retry_probe" not in result["evidence"] and not actual_grabs(r)


def test_budget_requirement_reaches_native_model_state_and_existing_road_action():
    r = reduced_initial_probe(shrinks=4, recorded_road=True)
    _, result = consume_budget(r)
    # Formal runs have this record from the go_to that precedes pick. The
    # fixture starts at pick; allocate the ordinary record without an outcome.
    r.actions._navigation_record(r.object_id)
    r.config = {"task": "把一个红球放到存放区"}
    r.recent = [compact_action_result(r.round,
        {"action": "pick", "params": {"object_id": r.object_id}}, result,
        r.snapshot["observation_index"])]
    r.snapshot["road"]["atJunction"] = False
    state = Runtime.state(r)
    subgoal = next(row["current_subgoal"] for row in state["navigation"]
                   if r.object_id in row["identity_ids"])
    assert subgoal["pick_probe_view"]["requires_new_view"]
    assert subgoal["pick_probe_view"]["blocked"] and not subgoal["operation_ready"]
    assert state["recent_actions"][-1]["reason"] == "pick_approach_view_budget_exhausted"
    action = validate_action({"action": "go_to", "params": {"object_id": r.object_id}},
                            state, transcript_version="autonomous-brain-llm/v25")
    next_result = r.actions.execute(action)
    attempt = next_result["evidence"]["road_reposition"]["attempts"][0]
    assert attempt["reached"] and attempt["steps"]
    assert all(step["historical_arc_retraced"] for step in attempt["steps"])
    assert not actual_grabs(r) and r.held_object_id is None and r.pending_grasp is None
