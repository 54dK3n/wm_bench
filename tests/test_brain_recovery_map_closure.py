"""Real Actions/RoadMemory linkage using public synthetic sensor responses."""
import copy
import math
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from autonomous_brain.navigation import RoadMemory, wrap
from test_brain_navigation_reposition import sensor
from test_brain_stage2_adversarial import SensorTrace, canonical
from test_brain_route_contract import normalize


def recovery_runtime():
    current = sensor(1, (0, 0))
    current["road"].update(atNode=True, exits=[{"angleDeg": -180}], tick=1)
    roads, calls, logs = RoadMemory(), [], []
    roads.update(current["odometry"], current["road"], 1)
    roads.observe_traversal(current)
    controls = {"fraction": 1, "blocked": False, "unknown": False, "lose_holding": False}
    runtime = SimpleNamespace(snapshot=current, roads=roads, round=1, pending_grasp=None,
        held_object_id=None, perception=SimpleNamespace(objects=lambda: []),
        motion_log=SimpleNamespace(write=logs.append))
    def call(method, params):
        normalize(method, params)
        calls.append((method, copy.deepcopy(params)))
        if controls["unknown"]:
            raise ConnectionError("synthetic_unknown_actuation")
        if controls["blocked"]:
            return {"completed": False, "stoppedBy": "front_clearance"}
        odo = current["odometry"]
        if method == "turn":
            odo["headingDeg"] += params["angleDeg"] * controls["fraction"]
        else:
            assert method in {"forward", "backward"}
            amount = params["distanceCm"] * controls["fraction"]
            theta = math.radians(odo["headingDeg"])
            signed = amount if method == "forward" else -amount
            odo["rightCm"] -= math.sin(theta) * signed
            odo["forwardCm"] += math.cos(theta) * signed
            odo["distanceCm"] += amount
        if controls["lose_holding"]:
            current["holding"]["holding"] = not current["holding"]["holding"]
        return {"completed": True}
    def observe(*, motion=None):
        current["observation_index"] += 1
        current["odometry"]["tick"] += 1
        current["observation"] = {"frameId": str(current["observation_index"]),
                                  "tick": current["odometry"]["tick"]}
        on_road = current["odometry"]["forwardCm"] <= 0
        current["road"].update(onRoad=on_road, atNode=on_road, tick=current["odometry"]["tick"],
            exits=[{"angleDeg": wrap(180-current["odometry"]["headingDeg"])}] if on_road else [])
        roads.update(current["odometry"], current["road"], current["observation_index"])
        roads.observe_traversal(current, dict(motion, after_observation=current["observation_index"])
                                if motion is not None else None)
    runtime.observe = observe
    runtime.bridge = SimpleNamespace(call=call, seconds=0, max_seconds=1200)
    return runtime, calls, controls


def leave_road(runtime, amount=6):
    trajectory = []
    Actions(runtime).manipulation_move("forward", {"distanceCm": amount, "speed": 20}, trajectory, "fixture")
    return trajectory


def test_exact_return_is_real_action_and_map_positive_control():
    runtime, calls, _ = recovery_runtime()
    trajectory = leave_road(runtime)
    result = Actions(runtime).return_place_path(trajectory)
    assert result["success"] and runtime.snapshot["road"]["onRoad"]
    assert calls[-1] == ("backward", {"distanceCm": 6, "speed": 20})
    assert runtime.roads.exploration_status()["unresolved_connection_count"] == 0


def test_crossed_entry_keeps_context_until_actions_finish_the_observed_one_cm_return():
    runtime, calls, _ = recovery_runtime()
    trajectory = leave_road(runtime)
    Actions(runtime).manipulation_move("backward", {"distanceCm": 7, "speed": 20}, trajectory, "fixture")
    assert runtime.snapshot["road"]["onRoad"] and runtime.snapshot["odometry"]["forwardCm"] == -1
    assert runtime.roads.exploration_status()["unresolved_connection_count"] > 0
    result = Actions(runtime).return_place_path(trajectory)
    assert result["success"] and runtime.snapshot["odometry"]["forwardCm"] == 0
    assert calls[-1] == ("forward", {"distanceCm": 1, "speed": 20})
    assert runtime.roads.exploration_status()["unresolved_connection_count"] == 0
    assert result["physical_on_road"] and result["map_reconnected"]


def resolved_identity_trace(*, return_cm=1, extra_arc_cm=0, return_heading=-180):
    trace = SensorTrace()
    trace.publish(0, 0, absolute_exits=(0,))
    trace.publish(0, 1, travelled=1, absolute_exits=(0,), method="forward", params={"distanceCm": 1})
    trace.publish(0, 0, travelled=2, absolute_exits=(0,), method="backward", params={"distanceCm": 1})
    root = canonical(trace.evidence(), 1)
    provisional = canonical(trace.evidence(), 2)
    assert root != provisional and trace.roads.exploration_status()["unresolved_node_count"] == 1
    params = trace.select(0); params.pop("distanceCm")
    trace.publish(0, 20, travelled=22, method="take_exit", params=params)
    trace.publish(0, 40, travelled=42, absolute_exits=(180,), method="follow_road", params={"distanceCm": 20})
    trace.publish(0, 40, travelled=42, heading=-180, absolute_exits=(180,), method="turn", params={"angleDeg": -180})
    params = trace.select(180); params.pop("distanceCm")
    trace.publish(0, 20, travelled=62, heading=-180, method="take_exit", params=params)
    trace.publish(0, return_cm, travelled=82-return_cm+extra_arc_cm, heading=return_heading,
                  absolute_exits=(0,), method="follow_road", params={"distanceCm": 20-return_cm})
    return trace, root, provisional


def test_later_independent_route_resolves_old_provisional_root_and_all_current_references():
    trace, root, provisional = resolved_identity_trace()
    evidence = trace.evidence()
    old = next(n for n in evidence["nodes"] if n["id"] == provisional)
    assert old["status"] == "alias" and old["canonical_id"] == root
    assert canonical(evidence, 2) == canonical(evidence, 8) == root
    assert trace.roads.exploration_status()["unresolved_node_count"] == 0
    assert all(e["node_id"] != provisional for e in evidence["exits"])
    assert all(t[side]["node_id"] != provisional for t in evidence["traversals"] for side in ("departure", "arrival"))
    assert evidence["identity_resolutions"]
    assert all(item["resolved"] for item in evidence["unresolved"] if item["kind"] == "node")
    resolution = evidence["identity_resolutions"][0]
    assert resolution["before"]["nodes"][0]["status"] == "unresolved"
    assert resolution["proof"]["traversal_ids"] == ["traversal-1", "traversal-2"]
    retired_exits = set(resolution["exit_id_map"])
    assert not retired_exits.intersection(e["id"] for e in evidence["exits"])
    assert not retired_exits.intersection(b["exit_id"] for a in evidence["anchors"] for b in a["exit_bindings"])
    assert not retired_exits.intersection(t["departure"]["exit_id"] for t in evidence["traversals"])
    assert all(t[side]["node_id"] != provisional for t in trace.roads.traversal_records()
               for side in ("departure", "arrival"))
    for segment in trace.roads.road_segment_records():
        for side in ("departure", "arrival"):
            anchor = segment[side]["registered_junction_anchor"]
            assert anchor is None or anchor["node_id"] != provisional
    candidates = trace.roads.approach_candidates(trace.current["odometry"], (0, .7))
    assert candidates
    assert all(s[side]["registered_junction_anchor"] is None
        or s[side]["registered_junction_anchor"]["node_id"] != provisional
        for c in candidates for s in c["segments"] for side in ("departure", "arrival"))
    assert trace.roads.exploration_status()["complete"]


def resolved_identity_with_existing_trip():
    """U→B is retained while independent B→A and A→B establish A's route."""
    trace = SensorTrace()
    trace.publish(0, 0, absolute_exits=(0,))
    trace.publish(0, 1, travelled=1, absolute_exits=(0,), method="forward", params={"distanceCm": 1})
    provisional = canonical(trace.evidence(), 2)
    for start, end, heading, travelled in [(1, 40, 0, 1), (40, 0, -180, 40),
                                         (0, 40, 0, 80), (40, 1, -180, 120)]:
        if trace.current["odometry"]["headingDeg"] != heading:
            trace.publish(0, start, travelled=travelled, heading=heading,
                absolute_exits=(180 if start == 40 else 0,), method="turn", params={"angleDeg": -180})
        params = trace.select(heading); params.pop("distanceCm")
        middle_travel = travelled + abs(start - 20)
        trace.publish(0, 20, travelled=middle_travel, heading=heading, method="take_exit", params=params)
        trace.publish(0, end, travelled=middle_travel + abs(end - 20), heading=heading,
            absolute_exits=(180 if end == 40 else 0,), method="follow_road", params={"distanceCm": abs(end - 20)})
        if end == 0:
            assert next(n for n in trace.evidence()["nodes"] if n["id"] == provisional)["status"] == "unresolved"
    return trace, provisional


def test_resolution_migrates_preexisting_traversal_and_its_completion_without_losing_raw_evidence():
    trace, provisional = resolved_identity_with_existing_trip()
    evidence = trace.evidence()
    resolution = evidence["identity_resolutions"][0]
    before_trip = resolution["before"]["traversals"][0]
    after_trip = next(t for t in evidence["traversals"] if t["id"] == before_trip["id"])
    assert before_trip["departure"]["node_id"] == provisional
    assert after_trip["departure"]["node_id"] == canonical(evidence, 1)
    assert after_trip["departure"]["exit_id"] == resolution["exit_id_map"][before_trip["departure"]["exit_id"]]
    assert before_trip["motion_refs"] == after_trip["motion_refs"]
    assert before_trip["observation_indices"] == after_trip["observation_indices"]
    assert before_trip["travelled_cm"] == after_trip["travelled_cm"]
    exit_row = next(e for e in evidence["exits"] if e["id"] == after_trip["departure"]["exit_id"])
    assert "traversal-1" in exit_row["completion_traversal_ids"]
    assert set(exit_row["completion_traversal_ids"]) == {"traversal-1", "traversal-3"}
    assert all(t[side]["node_id"] != provisional for t in trace.roads.traversal_records()
               for side in ("departure", "arrival"))
    assert trace.roads.exploration_status()["complete"]


@pytest.mark.parametrize("changes", [{"return_cm": 2}, {"extra_arc_cm": 5}, {"return_heading": -170}])
def test_nearby_or_inconsistent_revisit_cannot_resolve_the_old_root(changes):
    trace, _, provisional = resolved_identity_trace(**changes)
    node = next(n for n in trace.evidence()["nodes"] if n["id"] == provisional)
    assert node["status"] == "unresolved"
    assert not trace.evidence()["identity_resolutions"]
    assert not trace.roads.exploration_status()["complete"]


def test_one_cm_out_and_back_alone_does_not_discharge_a_provisional_node():
    trace = SensorTrace()
    trace.publish(0, 0, absolute_exits=(0,))
    trace.publish(0, 1, travelled=1, absolute_exits=(0,), method="forward", params={"distanceCm": 1})
    provisional = canonical(trace.evidence(), 2)
    trace.publish(0, 0, travelled=2, absolute_exits=(0,), method="backward", params={"distanceCm": 1})
    assert next(n for n in trace.evidence()["nodes"] if n["id"] == provisional)["status"] == "unresolved"
    assert not trace.evidence()["identity_resolutions"]


def test_two_near_nodes_separated_by_observed_road_remain_distinct():
    trace = SensorTrace()
    trace.publish(0, 0, absolute_exits=(0, 180))
    params = trace.select(0); params.pop("distanceCm")
    trace.publish(0, 4, travelled=4, method="take_exit", params=params)
    trace.publish(0, 8, travelled=8, absolute_exits=(0, 180), method="forward", params={"distanceCm": 4})
    assert canonical(trace.evidence(), 1) != canonical(trace.evidence(), 3)
    assert not trace.evidence()["identity_resolutions"]


@pytest.mark.parametrize("condition,reason", [
    ("partial", "return_motion_not_verified"), ("blocked", "return_motion_not_verified"),
    ("unknown", "recovery_execution_state_unknown"), ("holding", "return_holding_changed_during_motion")])
def test_incomplete_or_uncertain_return_keeps_map_pending_and_never_reissues(condition, reason):
    runtime, calls, controls = recovery_runtime()
    trajectory = leave_road(runtime)
    controls.update(fraction=.5 if condition == "partial" else 1, blocked=condition == "blocked",
                    unknown=condition == "unknown", lose_holding=condition == "holding")
    result = Actions(runtime).return_place_path(trajectory)
    assert not result["success"] and result["reason"] == reason
    assert result["map_reconnected"] is False
    assert runtime.roads.exploration_status()["unresolved_connection_count"] > 0
    assert len(calls) == 2
    if condition == "holding":
        assert result["physical_on_road"] is True


def test_physical_road_without_safe_recorded_correction_does_not_clear_connections():
    runtime, calls, _ = recovery_runtime()
    trajectory = leave_road(runtime)
    Actions(runtime).manipulation_move("backward", {"distanceCm": 7, "speed": 20}, trajectory, "fixture")
    runtime.snapshot["road"]["frontClearanceCm"] = .5
    result = Actions(runtime).return_place_path(trajectory)
    assert not result["success"] and result["reason"] == "recorded_return_blocked"
    assert result["physical_on_road"] and not result["map_reconnected"]
    assert len(calls) == 2
    assert result["map_reconnection"]["attempts"][-1]["position_error_cm"] == 1


def test_on_road_without_a_supplied_motion_path_does_not_guess_the_entry_correction():
    runtime, calls, _ = recovery_runtime()
    trajectory = leave_road(runtime)
    Actions(runtime).manipulation_move("backward", {"distanceCm": 7, "speed": 20}, trajectory, "fixture")
    result = Actions(runtime).return_place_path([])
    assert not result["success"] and result["reason"] == "no_observed_road_entry"
    assert result["physical_on_road"] and not result["map_reconnected"]
    assert len(calls) == 2


def test_reconnection_position_and_heading_tolerances_remain_point_two():
    runtime, _, controls = recovery_runtime()
    trajectory = leave_road(runtime)
    actions = Actions(runtime)
    actions.manipulation_move("backward", {"distanceCm": 6.21, "speed": 20}, trajectory, "fixture")
    assert not runtime.roads.reconnection_state()["map_reconnected"]
    controls["fraction"] = .21
    with pytest.raises(ObservedMotionFailure):
        actions.manipulation_move("turn", {"angleDeg": 1, "speed": 50}, trajectory, "fixture")
    assert not runtime.roads.reconnection_state()["map_reconnected"]


def test_partial_subdegree_rotation_remains_pending_without_an_illegal_inverse():
    runtime, calls, controls = recovery_runtime()
    trajectory = leave_road(runtime)
    controls["fraction"] = .5
    with pytest.raises(ObservedMotionFailure):
        Actions(runtime).manipulation_move("turn", {"angleDeg": 1, "speed": 50}, trajectory, "fixture")
    result = Actions(runtime).return_place_path(trajectory)
    assert not result["success"] and not result["map_reconnected"]
    assert result["reason"] == "road_reconnection_motion_evidence_unresolved"
    assert len(calls) == 2 and calls[-1] == ("turn", {"angleDeg": 1, "speed": 50})


def test_gripper_observation_with_regressed_clock_cannot_bridge_a_return_path():
    runtime, _, _ = recovery_runtime()
    leave_road(runtime)
    before = copy.deepcopy(runtime.snapshot)
    after = copy.deepcopy(before)
    after["observation_index"] += 1
    after["odometry"]["tick"] -= 1
    after["observation"].update(frameId="new-gripper-frame", tick=after["odometry"]["tick"])
    assert not runtime.roads._semantic.manipulation_step_valid(before, after, {
        "method": "grab", "before_observation": before["observation_index"],
        "after_observation": after["observation_index"], "actuator_result": {"completed": True}})
