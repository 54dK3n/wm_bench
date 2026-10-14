"""Original public stop/current views; synthetic actuator responses only.

The fixture is copied from082019 obs55/56/122 and its completed55->56 motion.
No scene coordinates, physical IDs, hidden state or task success is consulted.
Counterexamples mutate detached copies and are explicitly synthetic.
"""
import copy
import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from autonomous_brain.navigation import RoadMemory


FIXTURE = json.loads((Path(__file__).parent / "fixtures/run_20261011T082019_pick_clearance_prefix_public.json").read_text())
PARAMS = {"distanceCm": 6, "speed": 30}


def runtime_fixture():
    data = copy.deepcopy(FIXTURE)
    entry, stop, current = data["observations"]
    roads, calls, motions = RoadMemory(), [], []
    for row in (entry, stop, current):
        roads.update(row["odometry"], row["road"], row["observation_index"])
        roads.observe_traversal(row, data["motion"] if row is stop else None)
    roads.remember_passage_failure(entry, stop, data["motion"])
    controls = {"unknown": False, "observation_failure": False, "fraction": 1}
    runtime = SimpleNamespace(snapshot=current, roads=roads, round=29,
        pending_grasp=None, held_object_id=None,
        perception=SimpleNamespace(objects=lambda: []),
        bridge=SimpleNamespace(seconds=current["simulation_seconds"], max_seconds=1200, sequence=554),
        motion_log=SimpleNamespace(write=motions.append))
    def call(method, params):
        assert method == "forward"
        calls.append((method, copy.deepcopy(params)))
        runtime.bridge.sequence += 1
        theta = math.radians(current["odometry"]["headingDeg"])
        amount = params["distanceCm"] * controls["fraction"]
        current["odometry"]["rightCm"] -= math.sin(theta)*amount
        current["odometry"]["forwardCm"] += math.cos(theta)*amount
        current["odometry"]["distanceCm"] += amount
        current["road"]["frontClearanceCm"] -= amount
        if controls["unknown"]:
            raise ConnectionError("synthetic_dispatched_prefix_receipt_unknown")
        return {"completed": True}
    def observe(*, motion=None):
        if controls["observation_failure"] and motion is not None:
            raise ConnectionError("synthetic_prefix_post_observation_unavailable")
        current["observation_index"] += 1
        current["odometry"]["tick"] += 1
        current["road"]["tick"] = current["odometry"]["tick"]
        current["observation"].update(frameId=current["observation_index"], tick=current["odometry"]["tick"])
        runtime.bridge.seconds += .02
        current["simulation_seconds"] = runtime.bridge.seconds
        roads.update(current["odometry"], current["road"], current["observation_index"])
        roads.observe_traversal(current, dict(motion, after_observation=current["observation_index"])
                                if motion is not None else None)
        return current
    runtime.bridge.call, runtime.observe = call, observe
    return runtime, Actions(runtime), calls, motions, controls


def test_original_public_prefix_has_full_proof_but_default_move_stays_blocked():
    runtime, actions, calls, motions, _ = runtime_fixture()
    blocked = copy.deepcopy(runtime.roads.blocked)
    proof = actions.pick_clearance_prefix(PARAMS)
    assert proof and proof["observation_index"] == 122 and proof["requested_cm"] == 6
    assert proof["old_passages_resolved"] is False
    assert len(proof["stop_boundaries"]) == 1
    boundary = proof["stop_boundaries"][0]
    assert boundary["stop_observation"] == 56
    assert boundary["start_gap_cm"] > boundary["end_gap_cm"] > .2
    assert proof["clearance"]["permitted_cm"] == 6
    assert runtime.roads.blocked == blocked
    with pytest.raises(ObservedMotionFailure) as stopped:
        actions.move("forward", PARAMS)
    assert stopped.value.reason == "directed_passage_still_blocked"
    assert stopped.value.evidence["motion_not_sent"] is True
    assert calls == [] and motions == []


def test_pick_prefix_dispatches_once_then_requires_fresh_measured_progress():
    runtime, actions, calls, motions, _ = runtime_fixture()
    blocked = copy.deepcopy(runtime.roads.blocked)
    trajectory = []
    result = actions.manipulation_move("forward", PARAMS, trajectory, "pick")
    assert result == {"completed": True}
    assert calls == [("forward", PARAMS)]
    assert len(trajectory) == len(motions) == 1
    assert trajectory[0]["before_observation"] == 122
    assert trajectory[0]["after_observation"] == 123
    assert trajectory[0]["motion_verification"]["motion_verified"] is True
    assert trajectory[0]["motion_verification"]["measured_cm"] == pytest.approx(6)
    assert motions[0]["current_clearance_before_stop"]["stop_boundaries"][0]["stop_observation"] == 56
    assert runtime.roads.blocked == blocked
    assert runtime.roads.passage_blocked(runtime.snapshot, runtime.snapshot["odometry"]["headingDeg"])


@pytest.mark.parametrize("context", ["place", "return", "fixture"])
def test_non_pick_context_keeps_original_passage_rejection(context):
    _, actions, calls, motions, _ = runtime_fixture()
    trajectory = []
    with pytest.raises(ObservedMotionFailure) as stopped:
        actions.manipulation_move("forward", PARAMS, trajectory, context)
    assert stopped.value.reason == "directed_passage_still_blocked"
    assert stopped.value.evidence["motion_not_sent"] is True
    assert calls == [] and motions == [] and trajectory == []


@pytest.mark.parametrize("distance", [0, .09, 6.01, float("nan"), True])
def test_step_outside_existing_small_action_bound_has_no_proof(distance):
    _, actions, calls, _, _ = runtime_fixture()
    assert actions.pick_clearance_prefix(dict(PARAMS, distanceCm=distance)) is None
    assert calls == []


@pytest.mark.parametrize("fault", ["front", "side", "heading_reverse", "heading_unaligned", "road_tick", "pixel_tick", "missing_frame", "offroad", "holding", "pending", "held_id"])
def test_current_unknown_or_insufficient_public_support_cannot_license_prefix(fault):
    runtime, actions, calls, _, _ = runtime_fixture()
    row = runtime.snapshot
    if fault == "front":
        row["road"]["frontClearanceCm"] = 6.09
    elif fault == "side":
        row["road"]["rightClearanceCm"] = .5
    elif fault == "heading_reverse":
        row["road"]["headingErrorDeg"] = 180
    elif fault == "heading_unaligned":
        row["road"]["headingErrorDeg"] = 10.1
    elif fault == "road_tick":
        row["road"]["tick"] += 1
    elif fault == "pixel_tick":
        row["observation"]["tick"] += 1
    elif fault == "missing_frame":
        row["observation"].pop("frameId")
    elif fault == "offroad":
        row["road"]["onRoad"] = False
    elif fault == "holding":
        row["holding"]["holding"] = True
    elif fault == "pending":
        runtime.pending_grasp = {"object_id": "synthetic-unresolved"}
    else:
        runtime.held_object_id = "synthetic-held"
    assert actions.pick_clearance_prefix(PARAMS) is None
    assert calls == []


@pytest.mark.parametrize("fault", ["collision", "unknown", "not_sent", "missing_receipt", "elapsed", "command_reference", "before_index", "frame", "unverified"])
def test_old_stop_without_complete_known_receipt_cannot_license_prefix(fault):
    runtime, actions, calls, _, _ = runtime_fixture()
    row = runtime.roads.blocked[0]
    motion = row["motion"]
    if fault == "collision":
        row["reason"] = motion["actuator_result"]["stoppedBy"] = "collision"
    elif fault == "unknown":
        motion["outcome_unknown"] = True
    elif fault == "not_sent":
        motion["motion_not_sent"] = True
    elif fault == "missing_receipt":
        motion.pop("actuator_result")
    elif fault == "elapsed":
        motion["actuator_result"]["elapsedTicks"] += 1
    elif fault == "command_reference":
        motion.pop("bridge_request_id")
    elif fault == "before_index":
        motion["before_observation"] += 1
    elif fault == "frame":
        row["stop"]["frame_id"] = row["entry"]["frame_id"]
    else:
        motion["motion_verification"].update(applicable=True, motion_verified=False)
    assert actions.pick_clearance_prefix(PARAMS) is None
    assert calls == []


@pytest.mark.parametrize("remaining_cm", [6.1, 4, -.1])
def test_current_clearance_never_permits_reaching_or_crossing_retained_stop_plane(remaining_cm):
    runtime, actions, calls, _, _ = runtime_fixture()
    blocked = runtime.roads.blocked[0]
    heading = math.radians(blocked["direction_heading_deg"])
    axis = (-math.sin(heading), math.cos(heading))
    for key, point, unit in zip(("rightCm", "forwardCm"), blocked["stop"]["position_m"], axis):
        runtime.snapshot["odometry"][key] = point*100 - remaining_cm*unit
    # Synthetic optimistic present clearance must not erase the older bound.
    runtime.snapshot["road"]["frontClearanceCm"] = 100
    assert runtime.roads.passage_blockers(runtime.snapshot, runtime.snapshot["odometry"]["headingDeg"])
    assert actions.pick_clearance_prefix(PARAMS) is None
    assert blocked["resolved_by"] is None and calls == []


@pytest.mark.parametrize("older_kind", ["collision", "nearer_front_stop"])
def test_newest_front_stop_cannot_hide_another_matching_constraint(older_kind):
    runtime, actions, calls, _, _ = runtime_fixture()
    newer = copy.deepcopy(runtime.roads.blocked[0])
    older = copy.deepcopy(newer)
    newer["passage_id"] = "synthetic-newer-front"
    older["passage_id"] = "synthetic-older-conflict"
    if older_kind == "collision":
        older["reason"] = older["motion"]["actuator_result"]["stoppedBy"] = "collision"
    else:
        odo = runtime.snapshot["odometry"]
        theta = math.radians(older["direction_heading_deg"])
        older["stop"]["position_m"] = [odo["rightCm"]/100-math.sin(theta)*.04,
                                           odo["forwardCm"]/100+math.cos(theta)*.04]
    runtime.roads.blocked[:] = [older, newer]
    heading = runtime.snapshot["odometry"]["headingDeg"]
    blockers = runtime.roads.passage_blockers(runtime.snapshot, heading)
    assert [b["passage_id"] for b in blockers] == [newer["passage_id"], older["passage_id"]]
    assert runtime.roads.passage_blocked(runtime.snapshot, heading) == blockers[0]
    assert actions.pick_clearance_prefix(PARAMS) is None
    assert all(row["resolved_by"] is None for row in runtime.roads.blocked)
    assert calls == []


@pytest.mark.parametrize("fault", ["unknown", "observation_failure"])
def test_dispatched_prefix_uncertainty_is_never_retried_or_automatically_reversed(fault):
    runtime, actions, calls, motions, controls = runtime_fixture()
    controls[fault] = True
    trajectory = []
    with pytest.raises(ConnectionError):
        actions.manipulation_move("forward", PARAMS, trajectory, "pick")
    assert calls == [("forward", PARAMS)]
    assert motions[-1]["current_clearance_before_stop"]["old_passages_resolved"] is False
    assert motions[-1]["outcome_unknown"] is True
    assert trajectory[-1]["outcome_unknown"] is True
    result = actions.return_place_path(trajectory)
    assert not result["success"] and result["reason"] == "recovery_execution_state_unknown"
    assert calls == [("forward", PARAMS)]
    assert all(row["resolved_by"] is None for row in runtime.roads.blocked)


def test_completed_receipt_without_measured_progress_is_not_a_verified_prefix():
    _, actions, calls, motions, controls = runtime_fixture()
    controls["fraction"] = 0
    trajectory = []
    with pytest.raises(ObservedMotionFailure) as stopped:
        actions.manipulation_move("forward", PARAMS, trajectory, "pick")
    assert stopped.value.reason == "pick_motion_not_verified"
    assert "zero_displacement" in stopped.value.evidence["reasons"]
    assert len(calls) == len(motions) == len(trajectory) == 1
    assert trajectory[0]["motion_verification"]["motion_verified"] is False
