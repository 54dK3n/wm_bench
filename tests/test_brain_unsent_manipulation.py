"""Known pre-dispatch refusals versus uncertain execution in real Actions.

Public synthetic sensors drive the actual RoadMemory and manipulation wrapper.
These are controller regressions, not a competition or simulated delivery.
"""
import copy

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from test_brain_blocked_explore_return import runtime_fixture
from test_brain_recovery_map_closure import recovery_runtime


def test_known_passage_refusal_is_not_sent_and_adds_no_manipulation_trajectory():
    runtime, calls, motions = runtime_fixture()
    actions = Actions(runtime)
    before = copy.deepcopy(runtime.snapshot)
    sequence = runtime.bridge.sequence
    trajectory = []
    with pytest.raises(ObservedMotionFailure) as stopped:
        actions.manipulation_move("forward", {"distanceCm": 6, "speed": 30}, trajectory, "pick")
    failure = stopped.value
    assert failure.reason == "directed_passage_still_blocked"
    assert failure.evidence["motion_not_sent"] is True
    assert "actuator_result" not in failure.evidence
    assert failure.evidence["passage_failure"]["reason"] == "front_clearance"
    assert trajectory == []
    assert calls == [] and motions == []
    assert runtime.bridge.sequence == sequence and runtime.snapshot == before
    assert actions.return_place_path(trajectory)["reason"] == "already_on_observed_road"
    assert calls == []


def road_departure_runtime():
    runtime, calls, controls = recovery_runtime()
    # Start this synthetic trace at frame100, after the older public obstruction
    # used below. Re-register the current sensor boundary before any motion.
    row = runtime.snapshot
    row["observation_index"] = 100
    row["odometry"]["tick"] = row["road"]["tick"] = 100
    row["observation"].update(frameId="100", tick=100)
    runtime.roads.update(row["odometry"], row["road"], 100)
    runtime.roads.observe_traversal(row)
    motions = []
    runtime.motion_log.write = motions.append
    actions, trajectory = Actions(runtime), []
    actions.manipulation_move("forward", {"distanceCm": 6, "speed": 20}, trajectory, "pick")
    assert trajectory[0]["motion_verification"]["motion_verified"]
    assert not runtime.snapshot["road"]["onRoad"]
    return runtime, calls, controls, motions, actions, trajectory


def remember_older_forward_obstruction(runtime):
    entry = copy.deepcopy(runtime.snapshot)
    entry["observation_index"] = 10
    entry["odometry"]["tick"] = entry["road"]["tick"] = 10
    entry["observation"].update(frameId="10", tick=10)
    entry["road"]["frontClearanceCm"] = 1.1
    stop = copy.deepcopy(entry)
    stop["observation_index"] = 11
    stop["odometry"]["tick"] = stop["road"]["tick"] = 11
    stop["observation"].update(frameId="11", tick=11)
    stop["odometry"]["forwardCm"] += 1
    stop["odometry"]["distanceCm"] += 1
    stop["road"]["frontClearanceCm"] = .1
    runtime.roads.remember_passage_failure(entry, stop, {
        "method": "forward", "params": {"distanceCm": 6, "speed": 20},
        "before_observation": 10, "after_observation": 11,
        "bridge_request_id": "synthetic-earlier-clearance-stop",
        "actuator_result": {"completed": False, "stoppedBy": "front_clearance", "distanceCm": 1}})


def test_unsent_later_motion_preserves_verified_path_for_normal_return():
    runtime, calls, _, motions, actions, trajectory = road_departure_runtime()
    verified = copy.deepcopy(trajectory)
    remember_older_forward_obstruction(runtime)
    with pytest.raises(ObservedMotionFailure) as stopped:
        actions.manipulation_move("forward", {"distanceCm": 6, "speed": 20}, trajectory, "pick")
    assert stopped.value.reason == "directed_passage_still_blocked"
    assert stopped.value.evidence["motion_not_sent"] is True
    assert trajectory == verified
    assert [method for method, _ in calls] == ["forward"]
    assert len(motions) == 1
    result = actions.return_place_path(trajectory)
    assert result["success"] and result["reason"] == "returned_to_observed_road"
    assert result["physical_on_road"] and result["map_reconnected"]
    assert runtime.snapshot["odometry"]["forwardCm"] == pytest.approx(0)
    assert calls == [("forward", {"distanceCm": 6, "speed": 20}),
                     ("backward", {"distanceCm": 6, "speed": 20})]
    assert len(motions) == 2 and all(not m.get("outcome_unknown") for m in motions)


@pytest.mark.parametrize("fault", ["dispatch", "post_dispatch_observation"])
def test_actual_execution_uncertainty_still_stops_without_repeat_or_return(fault):
    runtime, calls, controls, motions, actions, trajectory = road_departure_runtime()
    if fault == "dispatch":
        controls["unknown"] = True
    else:
        observe = runtime.observe
        def fail_motion_observation(*, motion=None):
            if motion is not None:
                raise ConnectionError("synthetic_sensor_failure_after_dispatch")
            return observe()  # The one existing read-only recovery observation.
        runtime.observe = fail_motion_observation
    with pytest.raises(ConnectionError):
        actions.manipulation_move("forward", {"distanceCm": 6, "speed": 20}, trajectory, "pick")
    assert [method for method, _ in calls] == ["forward", "forward"]
    assert len(trajectory) == 2 and trajectory[0]["motion_verification"]["motion_verified"]
    assert trajectory[-1]["outcome_unknown"] is True
    assert motions[-1]["outcome_unknown"] is True
    assert not motions[-1].get("motion_not_sent")
    if fault == "post_dispatch_observation":
        assert motions[-1]["actuator_result"] == {"completed": True}
        assert runtime.snapshot["odometry"]["forwardCm"] == pytest.approx(12)
    call_count = len(calls)
    result = actions.return_place_path(trajectory)
    assert result["success"] is False and result["reason"] == "recovery_execution_state_unknown"
    assert len(calls) == call_count
    assert all(method != "backward" for method, _ in calls)
