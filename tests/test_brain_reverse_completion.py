"""Historical reverse-gate coordinates never replace an actual reverse trip."""
import math

import pytest

from autonomous_brain.navigation import RoadMemory
from test_brain_stage2_adversarial import SensorTrace, exit_at


def odo(x_cm=0, z_cm=0, heading=0):
    return {"rightCm": x_cm, "forwardCm": z_cm, "headingDeg": heading,
            "distanceCm": 0, "tick": 0}


def road(*relative, at_node=True, error=0):
    return {"onRoad": True, "atNode": at_node, "headingErrorDeg": error,
            "exits": [{"angleDeg": value} for value in relative]}


def completed_headings(node):
    return {round(entry["heading_deg"], 6) for entry in node["exits"] if entry["completed"]}


def start():
    memory = RoadMemory()
    memory.update(odo(), road(0))
    memory.chosen(odo(), 0)
    return memory


def test_run11_r76_never_completes_the_historical_exit_absent_from_current_sensor():
    # Preserve round76's coordinates/headings, but do not inject node IDs or
    # pre-marked completion flags. Only original public sensor values enter.
    trace = SensorTrace()
    trace.publish(-107.9,75.6,absolute_exits=(8.9,-90,169.2))
    trace.publish(-89.4,86.5,heading=169.2,travelled=30,
                  absolute_exits=(169.2,9,-90),tick=20)
    params = trace.select(169.2)
    trace.publish(-116.9,65.4,heading=135,travelled=70,
                  absolute_exits=(-149.5,90,-11.3),method='take_exit',params=params)
    destination = trace.roads.nodes[0]
    assert completed_headings(destination)==set()
    assert -90 not in completed_headings(destination)
    assert not trace.roads.exploration_status()['complete']


def test_arrival_tangent_selects_current_exit_instead_of_curved_motion_chord():
    memory = start()
    # A forward road-following arc ends heading right. Its endpoint chord
    # points diagonally; the fresh local tangent identifies the arrival side.
    arrival = odo(30, 20, -90)
    memory.update(arrival, road(180, -120))  # absolute +90 and +150
    assert completed_headings(memory.nodes[-1]) == set()
    assert memory.traversal_records() == []


def test_stationary_turn_does_not_replace_the_observed_arrival_tangent():
    memory = start()
    memory.update(odo(30, 20, -90), road(at_node=False))
    memory.update(odo(30, 20, 0), road(at_node=False, error=-90))
    memory.update(odo(30, 20, 0), road(90, 150, error=-90))
    assert completed_headings(memory.nodes[-1]) == set()
    assert memory.traversal_records() == []


def test_multiple_current_exits_within_original_reverse_gate_remain_uncompleted():
    memory = start()
    memory.update(odo(0, 40), road(150, -150))
    assert completed_headings(memory.nodes[-1]) == set()
    assert completed_headings(memory.nodes[0]) == set()


@pytest.mark.parametrize("error", [None, float("nan"), float("inf"), True, "missing"])
def test_missing_or_invalid_arrival_tangent_does_not_establish_reverse_completion(error):
    memory = start()
    arrival_road = road(180, error=error)
    if error == "missing":
        arrival_road.pop("headingErrorDeg")
    memory.update(odo(0, 40), arrival_road)
    assert completed_headings(memory.nodes[-1]) == set()


def test_lateral_displacement_incompatible_with_local_tangent_remains_uncompleted():
    memory = start()
    memory.update(odo(40, 0), road(90, 180))
    assert completed_headings(memory.nodes[-1]) == set()


def test_reverse_gate_remains_strictly_less_than_45_degrees():
    memory = start()
    memory.update(odo(0, 40), road(135))
    assert completed_headings(memory.nodes[-1]) == set()


def test_ambiguous_fresh_to_remembered_exit_identity_remains_uncompleted():
    trace = SensorTrace()
    trace.publish(0,40,absolute_exits=(170,-170))
    trace.publish(0,40,absolute_exits=(180,))
    assert all(completed_headings(node)==set() for node in trace.roads.nodes)
    assert trace.evidence()['traversals']==[]
    assert not trace.roads.exploration_status()['complete']


def test_heading_error_is_added_to_robot_heading_to_recover_arrival_tangent():
    memory = start()
    memory.update(odo(-30, 20, 30), road(-150, -90, error=30))
    assert completed_headings(memory.nodes[-1]) == set()
    assert memory.traversal_records() == []


def test_backward_arrival_uses_the_actual_direction_of_translation():
    memory = start()
    memory.update(odo(0, -40), road(0, 180))
    assert completed_headings(memory.nodes[-1]) == set()
    assert memory.traversal_records() == []


def test_r75_seventeen_point_eight_cm_node_gap_is_not_merged_by_similar_exits():
    memory = RoadMemory()
    memory.update(odo(-106, 92.8, -90), road(0, -100.7, 99))
    memory.update(odo(-89.4, 86.5, 90), road(79.2, -81, -180))
    assert len(memory.nodes) == 2
    assert math.dist(memory.nodes[0]["position"], memory.nodes[1]["position"]) == pytest.approx(.17755280960999406)


def test_curved_forward_trip_needs_an_actual_fresh_reverse_trip_for_reverse_completion():
    trace = SensorTrace()
    trace.publish(0,0,absolute_exits=(0,))
    params = trace.select(0)
    trace.publish(30,20,heading=-90,travelled=47.1,absolute_exits=(90,150),
                  method='take_exit',params=params)
    assert exit_at(trace.evidence(),1,0)['state']=='verified'
    assert exit_at(trace.evidence(),2,90)['state']!='verified'
    trace.publish(30,20,heading=90,travelled=47.1,absolute_exits=(90,150),
                  method='turn',params={'angleDeg':-180})
    params = trace.select(90)
    trace.publish(0,0,heading=-180,travelled=94.2,absolute_exits=(0,),
                  method='take_exit',params=params)
    assert exit_at(trace.evidence(),2,90)['state']=='verified'
    assert exit_at(trace.evidence(),2,150)['state']!='verified'
    assert len(trace.evidence()['traversals'])==2
