"""Historical proximity cases require explicit anchor/continuity evidence.

The original coordinates, 15 cm boundaries and equal-distance permutations
remain counterexamples. Neither nearest position nor insertion order assigns a
semantic junction; positive controls supply complete public sensor/motion data.
"""
import copy

import pytest

from autonomous_brain.navigation import RoadMemory, distance, position, wrap
from test_brain_stage2_adversarial import SensorTrace, canonical


def odometry(right_cm=0, forward_cm=0, heading_deg=0):
    return {"rightCm": right_cm, "forwardCm": forward_cm, "headingDeg": heading_deg,
            "distanceCm": 0, "tick": 0}


def road(*angles, error=0):
    return {"onRoad": True, "atNode": True, "atJunction": True,
            "headingErrorDeg": error, "exits": [{"angleDeg": angle} for angle in angles]}


def node(memory, ident):
    return next(n for n in memory.nodes if n['id']==ident)


def exit_at(node, heading):
    matches = [e for e in node['exits'] if abs(wrap(e['heading_deg']-heading))<1e-6]
    assert len(matches)==1
    return matches[0]


def overlapping_run14_anchors():
    # Original observations133/145/161 coordinates and local angles. There is
    # no original motion window here, so the nearby identities stay unresolved.
    trace = SensorTrace()
    trace.publish(-209.3,116.8,heading=-96.9,absolute_exits=(60.5,-68.8,-149.1),
                  heading_error=-32.9)
    earlier_id = trace.roads.current_node(trace.current['odometry'])['id']
    params = trace.select(-68.8)
    trace.publish(-209.3,116.8,heading=-96.9,absolute_exits=(60.5,-68.8,-149.1),
                  heading_error=-32.9,method='take_exit',params=params,
                  result={'accepted':True,'stoppedBy':'front_clearance','distanceCm':0})
    trace.roads.mark_blocked()
    trace.publish(-187.7,109.3,heading=98.5,travelled=25,
                  absolute_exits=(-149.1,60.5,-68.8),tick=30)
    nearer_id = trace.roads.current_node(trace.current['odometry'])['id']
    trace.publish(-200.1,107.7,heading=-84.3,travelled=40,
                  absolute_exits=(60.5,-68.8,-149.1),heading_error=15.5,tick=40)
    current, observed = trace.current['odometry'], trace.current['road']
    memory = trace.roads
    assert len(memory.nodes)==3
    assert distance(position(current),node(memory,earlier_id)['position'])*100==pytest.approx(12.9402472939)
    assert distance(position(current),node(memory,nearer_id)['position'])*100==pytest.approx(12.5027996865)
    return trace,earlier_id,nearer_id,current,observed


def test_current_node_does_not_choose_nearer_run14_anchor_by_proximity():
    trace,earlier,nearer,_,_ = overlapping_run14_anchors()
    memory = trace.roads
    before = {i:copy.deepcopy(node(memory,i)) for i in (earlier,nearer)}
    # The extra public exit changes the current profile, never either nearby
    # historical node. A hypothesis may remain unresolved until actual revisit.
    trace.publish(-200.1,107.7,heading=-84.3,travelled=40,
                  absolute_exits=(60.5,-68.8,-149.1,0),heading_error=15.5)
    current = memory.current_node(trace.current['odometry'])
    assert current['id'] not in {earlier,nearer}
    assert exit_at(current,0)['visits']==0
    assert all(node(memory,i)==before[i] for i in before)
    assert not memory.exploration_status()['complete']


def test_current_exit_state_does_not_inherit_nearby_historical_block():
    trace,earlier,nearer,current,observed = overlapping_run14_anchors()
    memory = trace.roads
    assert exit_at(node(memory,earlier),-68.8)['blocked'] is True
    assert exit_at(node(memory,nearer),-68.8)['blocked'] is False
    fresh = memory.current_node(current)
    assert fresh['id'] not in {earlier,nearer}
    seen = next(e for e in memory.exits(current,observed) if abs(e['angle_deg']-15.5)<1e-6)
    assert seen['visits']==0 and seen['blocked'] is False and seen['completed'] is False


def test_chosen_after_run14_observed_alignment_uses_current_anchor_identity():
    trace,earlier,nearer,_,_ = overlapping_run14_anchors()
    memory = trace.roads
    current_id = memory.current_node(trace.current['odometry'])['id']
    before = {i:copy.deepcopy(node(memory,i)) for i in (earlier,nearer)}
    trace.publish(-200.1,107.7,heading=-68.8,travelled=40,
                  absolute_exits=(60.5,-68.8,-149.1),method='turn',params={'angleDeg':15.5})
    assert memory.current_node(trace.current['odometry'])['id']==current_id
    trace.select(-68.8)
    assert exit_at(node(memory,current_id),-68.8)['visits']==1
    assert exit_at(node(memory,current_id),-68.8)['completed'] is False
    assert all(node(memory,i)==before[i] for i in before)


@pytest.mark.parametrize('reverse_insertion',[False,True])
def test_equal_distance_tie_cannot_assign_identity_by_insertion_order(reverse_insertion):
    trace = SensorTrace()
    points = [0,20]
    if reverse_insertion:
        points.reverse()
    trace.publish(points[0],0,absolute_exits=(0,))
    trace.publish(points[1],0,travelled=20,absolute_exits=(0,),tick=20)
    earlier = {n['id']:copy.deepcopy(n) for n in trace.roads.nodes}
    trace.publish(10,0,travelled=30,absolute_exits=(0,90),tick=30)
    current = trace.roads.current_node(trace.current['odometry'])
    assert current['id'] not in earlier and len(trace.roads.nodes)==3
    trace.select(90)
    current = trace.roads.current_node(trace.current['odometry'])
    assert exit_at(current,90)['visits']==1
    assert all(node(trace.roads,i)==saved for i,saved in earlier.items())
    assert trace.evidence()['traversals']==[]
    assert not trace.roads.exploration_status()['complete']


@pytest.mark.parametrize('right_cm',[15,15.0001])
def test_original_fifteen_centimetre_boundary_does_not_merge_nodes(right_cm):
    trace = SensorTrace()
    trace.publish(0,0,absolute_exits=(0,))
    earlier = copy.deepcopy(trace.roads.nodes[0])
    current = odometry(right_cm)
    assert trace.roads.current_node(current) is None
    trace.publish(right_cm,0,travelled=right_cm,absolute_exits=(90,),tick=20)
    assert len(trace.roads.nodes)==2
    assert trace.roads.current_node(trace.current['odometry'])['id']!=earlier['id']
    assert node(trace.roads,earlier['id'])==earlier
    assert trace.evidence()['traversals']==[]


def test_position_just_inside_original_boundary_does_not_establish_identity():
    trace = SensorTrace()
    trace.publish(0,0,absolute_exits=(0,))
    earlier = copy.deepcopy(trace.roads.nodes[0])
    trace.publish(14.9999,0,travelled=14.9999,absolute_exits=(90,),tick=20)
    assert trace.roads.current_node(trace.current['odometry'])['id']!=earlier['id']
    assert len(trace.roads.nodes)==2
    assert node(trace.roads,earlier['id'])==earlier
    assert trace.evidence()['traversals']==[]


@pytest.mark.parametrize('has_distant_node',[False,True])
def test_no_near_node_returns_none_and_cannot_mutate_another_node(has_distant_node):
    trace = SensorTrace()
    memory = trace.roads
    if has_distant_node:
        trace.publish(0,0,absolute_exits=(0,))
    before = copy.deepcopy(memory.nodes)
    elsewhere = odometry(100,100)
    assert memory.current_node(elsewhere) is None
    memory.chosen(elsewhere,0)
    assert memory.active_exit is None and memory.nodes==before
    observed = memory.exits(elsewhere,road(0))
    assert len(observed)==1
    assert observed[0]['angle_deg']==0 and observed[0]['heading_deg']==0
    assert observed[0]['id'] is None and observed[0]['state']=='unresolved'
    assert not observed[0]['completed'] and not observed[0]['blocked']


def test_direct_node_updates_without_motion_do_not_complete_either_direction():
    memory = RoadMemory()
    start = odometry()
    memory.update(start,road(0))
    memory.chosen(start,0)
    arrival = odometry(forward_cm=25)
    memory.update(arrival,road(180,90))
    assert len(memory.nodes)==2
    assert memory.current_node(arrival)['id']==memory.nodes[1]['id']
    assert [e['completed'] for e in memory.exits(arrival,road(180,90))]==[False,False]
    assert memory.traversal_records()==[] and not memory.exploration_status()['complete']


def test_complete_public_direct_trip_binds_current_selection_to_arrival_anchor():
    trace = SensorTrace()
    trace.publish(0,0,absolute_exits=(0,))
    params = trace.select(0)
    trace.publish(0,25,travelled=25,absolute_exits=(180,90),method='take_exit',params=params)
    current = trace.roads.current_node(trace.current['odometry'])
    assert current['id']==canonical(trace.evidence(),2)
    assert len(trace.evidence()['traversals'])==1
    trace.select(90)
    current = trace.roads.current_node(trace.current['odometry'])
    assert exit_at(current,90)['state']=='exploring'
    assert exit_at(current,180)['state']!='verified'
