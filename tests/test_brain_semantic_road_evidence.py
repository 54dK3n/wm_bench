"""Sensor-only identity resolution and explicit non-road recovery evidence."""
from autonomous_brain.navigation import RoadMemory
from autonomous_brain.road_evidence import RoadEvidence
from test_brain_navigation_reposition import sensor
from test_brain_stage2_adversarial import SensorTrace, canonical, start_to_second_node


def test_known_reverse_route_supports_revisit_at_a_different_stopping_position():
    trace = start_to_second_node()
    trace.publish(0, 40, heading=-180, travelled=40, absolute_exits=(180,),
                  method="turn", params={"angleDeg": -180})
    params = trace.select(180)
    trace.publish(0, 20, heading=-180, travelled=60, method="take_exit", params=params)
    trace.publish(0, 4, heading=-180, travelled=76, absolute_exits=(0,),
                  method="follow_road", params={"distanceCm": 16})
    evidence = trace.evidence()
    assert canonical(evidence, 1) == canonical(evidence, 6)
    node = next(n for n in evidence["nodes"] if n["id"] == canonical(evidence, 1))
    proof = node["merge_evidence_refs"][-1]
    assert proof["kind"] == "route_endpoint_revisit"
    assert proof["traversal_ids"] == ["traversal-1"]
    assert proof["first_observation"] == 4 and proof["last_observation"] == 6
    assert len(evidence["traversals"]) == 2
    assert trace.roads.exploration_status()["complete"]


def feed(memory, frame, previous=None, method=None, params=None):
    motion = None if method is None else {"before_observation": previous["observation_index"],
        "after_observation": frame["observation_index"], "method": method,
        "params": params, "actuator_result": {"completed": True}}
    memory.update(frame["odometry"], frame["road"], frame["observation_index"])
    memory.observe_traversal(frame, motion)


def excursion(return_motion=True):
    memory = RoadMemory()
    frames = [sensor(1, (0, 0)), sensor(2, (0, .05), travelled=5, on_road=False),
              sensor(3, (0, 0), travelled=10)]
    for frame in (frames[0], frames[-1]):
        frame["road"].update(atNode=True, exits=[{"angleDeg": 0}])
    feed(memory, frames[0])
    feed(memory, frames[1], frames[0], "forward", {"distanceCm": 5})
    feed(memory, frames[2], frames[1], "backward" if return_motion else None, {"distanceCm": 5})
    return memory


def test_actual_nonroad_return_resolves_only_excursion_gap_without_inventing_road_connection():
    memory = excursion()
    evidence = memory.road_evidence()
    assert canonical(evidence, 1) == canonical(evidence, 3)
    assert evidence["traversals"] == [] and memory.road_segment_records() == []
    assert len([n for n in evidence["nodes"] if n["canonical_id"] == n["id"]]) == 1
    assert all(item["resolved"] for item in evidence["unresolved"])
    proof = evidence["unresolved"][0]["resolution"]
    assert proof["kind"] == "observed_nonroad_return"
    assert proof["motion_refs"] == [{"before_observation": 1, "after_observation": 2},
                                    {"before_observation": 2, "after_observation": 3}]
    status = memory.exploration_status()
    assert status["pending_exit_count"] == 1 and status["unresolved_connection_count"] == 0


def test_unaccounted_nonroad_return_does_not_resolve_the_gap_or_merge_identity():
    memory = excursion(return_motion=False)
    evidence = memory.road_evidence()
    assert canonical(evidence, 1) != canonical(evidence, 3)
    assert any(not item["resolved"] for item in evidence["unresolved"])
    assert memory.exploration_status()["unresolved_connection_count"] > 0


def test_evidence_and_status_are_read_only_copies():
    memory = excursion()
    before = memory.road_evidence()
    changed = memory.road_evidence()
    changed["nodes"].clear()
    changed["exits"][0]["state"] = "verified"
    status = memory.exploration_status()
    status["state_counts"]["verified"] = 100
    assert memory.road_evidence() == before
    assert memory.exploration_status()["state_counts"]["verified"] == 0


def test_turn_with_changed_heading_but_unchanged_tick_cannot_prove_motion():
    before, after = sensor(1, (0, 0)), sensor(2, (0, 0), heading=90)
    after["odometry"]["tick"] = after["observation"]["tick"] = 1
    motion = {"before_observation": 1, "after_observation": 2, "method": "turn",
              "params": {"angleDeg": 90}, "actuator_result": {"completed": True}}
    assert not RoadEvidence.step_valid(before, after, motion)
    assert not RoadEvidence.manipulation_step_valid(before, after, motion)


def test_out_and_back_on_same_unfinished_branch_is_not_a_completed_self_loop():
    trace = SensorTrace()
    trace.publish(0, 0, absolute_exits=(0, 90))
    params = trace.select(0)
    trace.publish(0, 30, travelled=30, method="take_exit", params=params)
    trace.publish(0, 30, travelled=30, heading=-180, method="turn", params={"angleDeg": -180})
    trace.publish(0, 0, travelled=60, heading=-180, absolute_exits=(0, 90),
                  method="follow_road", params={"distanceCm": 30})
    assert not trace.evidence()["traversals"]
    assert trace.events[-1]["reason"] == "self_loop_arrival_exit_not_distinct"
    assert trace.roads.exploration_status()["pending_exit_count"] == 2


def test_unassociated_later_block_does_not_rewrite_an_already_completed_exit():
    trace = start_to_second_node()
    before = trace.evidence()["exits"]
    trace.roads.mark_blocked()
    assert trace.evidence()["exits"] == before
