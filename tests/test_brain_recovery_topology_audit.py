"""Production RoadMemory outputs checked by independent evaluation-only truth.

These fixed synthetic logs are not simulator runs. The native line definition
is constructed after the brain trace and is never passed into RoadMemory.
"""
import copy
import math

import pytest

from autonomous_brain.actions import Actions
from test_brain_recovery_map_closure import (resolved_identity_trace, resolved_identity_with_existing_trip,
    recovery_runtime, leave_road)
from test_brain_stage2_adversarial import SensorTrace
from tools.brain_topology_audit import audit_topology


def identity_audit_fixture(*, existing_trip=False):
    trace = (resolved_identity_with_existing_trip() if existing_trip else resolved_identity_trace())[0]
    return audit_fixture(trace.roads, [[0, 0], [0, -.4]], .2)


def audit_fixture(memory, points, width):
    observations = copy.deepcopy(list(memory._semantic.frames.values()))
    motions = copy.deepcopy(list(memory._semantic.motions.values()))
    by_after = {m["after_observation"]: m for m in motions}
    bridge, captures, samples = [], [], []
    for row in observations:
        index, odo = row["observation_index"], row["odometry"]
        motion = by_after.get(index)
        if motion:
            bridge.append({"request": {"method": motion["method"], "params": copy.deepcopy(motion["params"])},
                "terminal": {"status": "completed", "result": copy.deepcopy(motion["actuator_result"])}})
        for method, key in (("odometry", "odometry"), ("local_road", "road"),
                            ("holding", "holding"), ("observe", "observation")):
            bridge.append({"request": {"method": method, "params": {}},
                "terminal": {"status": "completed", "result": copy.deepcopy(row[key])}})
        pose = {"x": odo["rightCm"] / 100, "z": -odo["forwardCm"] / 100,
                "heading": math.radians(odo["headingDeg"])}
        samples.append({"tick": odo["tick"], **{k: round(v, 4 if k == "heading" else 6) for k, v in pose.items()}})
        captures.append({"frameId": row["observation"]["frameId"], "tick": odo["tick"],
            "robotWorldPose": pose, "odometryOrigin": {"x": 0, "z": 0, "heading": 0}, "worldUnitsToMeters": 1})
    summary = {"road_evidence": memory.road_evidence(), "exploration_state": memory.exploration_status()}
    record = {"native": {"ruleDefinition": {"unitsPerMeter": 1, "vehicleRadius": 0,
        "navigationJunctionRadiusCm": 10, "roads": [{"id": "synthetic-line", "points": points,
        "width": width, "oneWay": False}]}, "navigationDefinition": {"schemaVersion": "chenlong.navigation/v6",
        "roadTopology": {"endpointSnapDigits": 6}}, "samples": samples}}
    return summary, observations, motions, record, bridge, captures


@pytest.mark.parametrize("existing_trip", [False, True])
def test_retrospective_identity_resolution_has_identical_brain_and_independent_counts(existing_trip):
    data = identity_audit_fixture(existing_trip=existing_trip)
    result = audit_topology(*data)
    assert result["complete"], result
    assert (result["brain_node_count"], result["true_node_count"], result["node_ratio"]) == (2, 2, 1)
    assert result["verified_traversal_count"] == (4 if existing_trip else 2)
    assert result["exploration"] == data[0]["exploration_state"]


@pytest.mark.parametrize("tamper", ["exit_map", "missing_old_completion", "missing_old_trip_history", "missing_route_support"])
def test_resolution_cannot_hide_or_rebind_historical_obligations(tamper):
    data = identity_audit_fixture(existing_trip=True)
    evidence = data[0]["road_evidence"]
    resolution = evidence["identity_resolutions"][0]
    if tamper == "exit_map":
        original = next(iter(resolution["exit_id_map"]))
        resolution["exit_id_map"][original] = next(e["id"] for e in evidence["exits"]
            if e["node_id"] != resolution["canonical_node_id"])
    elif tamper == "missing_old_completion":
        old_trip = resolution["before"]["traversals"][0]["id"]
        for exit_row in evidence["exits"]:
            exit_row["completion_traversal_ids"] = [t for t in exit_row["completion_traversal_ids"] if t != old_trip]
    elif tamper == "missing_old_trip_history":
        resolution["before"]["traversals"] = []
    else:
        resolution["proof"]["route_revisit_proof"]["traversal_ids"] = []
    result = audit_topology(*data)
    assert not result["complete"], (tamper, result)
    assert "topology_retrospective_identity_resolution_invalid" in result["failures"], result


def test_observed_anchor_return_does_not_discharge_the_unresolved_one_cm_stopping_point():
    trace = SensorTrace()
    trace.publish(0, 0, absolute_exits=(0,))
    trace.publish(0, 1, travelled=1, absolute_exits=(0,), method="forward", params={"distanceCm": 1})
    trace.publish(0, 0, travelled=2, absolute_exits=(0,), method="backward", params={"distanceCm": 1})
    data = audit_fixture(trace.roads, [[0, 0], [0, -.4]], .2)
    result = audit_topology(*data)
    assert not result["complete"]
    assert "topology_alias_merge_evidence_invalid" not in result["failures"], result
    assert trace.roads.exploration_status()["unresolved_node_count"] == 1
    assert not data[0]["road_evidence"]["identity_resolutions"]


def return_audit_fixture():
    runtime, _, _ = recovery_runtime()
    trajectory = leave_road(runtime)
    Actions(runtime).manipulation_move("backward", {"distanceCm": 7, "speed": 20}, trajectory, "fixture")
    outcome = Actions(runtime).return_place_path(trajectory)
    assert outcome["success"] and outcome["physical_on_road"] and outcome["map_reconnected"]
    return audit_fixture(runtime.roads, [[0, 0], [0, .4]], .02)


def test_delayed_precise_return_proof_is_valid_without_erasing_other_exploration_obligations():
    data = return_audit_fixture()
    result = audit_topology(*data)
    assert not result["complete"]  # The rest of the line was never explored.
    assert "topology_public_native_context_mismatch" not in result["failures"], result
    assert "topology_alias_merge_evidence_invalid" not in result["failures"], result
    connections = {r["id"] for r in data[0]["road_evidence"]["unresolved"] if r["kind"] == "connection"}
    assert connections
    assert not any(issue.get("unresolved_id") in connections for issue in result["issues"]), result
    assert data[0]["road_evidence"]["road_reconnections"][0]["attempts"][0]["map_reconnected"] is False


def test_first_physical_road_contact_cannot_replace_the_final_anchor_proof():
    data = return_audit_fixture()
    evidence = data[0]["road_evidence"]
    for node in evidence["nodes"]:
        for proof in node["merge_evidence_refs"]:
            if proof["kind"] == "observed_nonroad_return":
                proof.update(to_observation=3, last_observation=3)
                proof["motion_refs"] = [r for r in proof["motion_refs"] if r["after_observation"] <= 3]
    result = audit_topology(*data)
    assert "topology_alias_merge_evidence_invalid" in result["failures"], result
    assert not result["complete"]
