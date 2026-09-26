"""Stage 2 adversarial traces made only of public sensor/motion inputs.

The fixtures provide no scene topology, platform identifiers, target count or
truth to RoadMemory. Test-side descriptions explain the intended ambiguity;
all map identifiers and connections must be inferred by the implementation.
"""
import copy

import pytest

from autonomous_brain.navigation import RoadMemory, wrap
from autonomous_brain.task import completion_progress, parse_task
from test_brain_perception import CAMERA, Perception, ball, observe, grasp_evidence, placement_evidence


class SensorTrace:
    def __init__(self):
        self.roads = RoadMemory()
        self.current = None
        self.events = []

    def publish(self, x_cm, z_cm, *, heading=0, travelled=0, absolute_exits=(),
                method=None, params=None, result=None, index=None, frame=None,
                tick=None, camera=True, camera_tick=None, at_node=None, heading_error=0):
        previous = self.current
        i = index if index is not None else (previous['observation_index'] + 1 if previous else 1)
        t = tick if tick is not None else (i * 10 if method or previous is None
                                         else previous['odometry']['tick'])
        odo = {'rightCm':x_cm, 'forwardCm':z_cm, 'headingDeg':heading,
               'distanceCm':travelled, 'tick':t}
        road = {'onRoad':True, 'atNode':bool(absolute_exits) if at_node is None else at_node,
                'atJunction':len(absolute_exits)>2, 'tick':t,
                'headingErrorDeg':heading_error, 'frontClearanceCm':100,
                'leftClearanceCm':20, 'rightClearanceCm':20,
                'exits':[{'angleDeg':wrap(angle-heading)} for angle in absolute_exits]}
        row = {'observation_index':i, 'odometry':odo, 'road':road,
               'holding':{'holding':False}, 'perception':{'detections':[]}}
        if camera:
            row['observation']={'frameId':str(i if frame is None else frame),
                'tick':t if camera_tick is None else camera_tick,
                'width':640,'height':480,'detections':[]}
        motion = None
        if method:
            assert previous is not None
            motion = {'method':method,'params':copy.deepcopy(params or {}),
                'before_observation':previous['observation_index'],'after_observation':i,
                'actuator_result':copy.deepcopy(result if result is not None else
                    {'completed':True} if method in {'turn','forward','backward'} else {'accepted':True})}
        self.roads.update(odo,road,observation_index=i)
        self.events.extend(self.roads.observe_traversal(row,motion))
        self.current = copy.deepcopy(row)
        return row

    def select(self, absolute_heading):
        odo = self.current['odometry']
        angle = wrap(absolute_heading-odo['headingDeg'])
        self.roads.chosen(odo,angle,observation_index=self.current['observation_index'])
        return {'angleDeg':angle,'distanceCm':100,'speed':50}

    def evidence(self):
        evidence = self.roads.road_evidence()
        assert evidence['schema']=='brain-road-evidence/v1'
        return evidence


def anchor(evidence, index):
    return next(a for a in evidence['anchors'] if a['observation_index']==index)


def canonical(evidence, index):
    node_id = anchor(evidence,index).get('node_id')
    if node_id is None:
        return None
    row = next(n for n in evidence['nodes'] if n['id']==node_id)
    return row['canonical_id']


def exit_at(evidence, index, heading):
    node = canonical(evidence,index)
    rows = [e for e in evidence['exits'] if e['node_id']==node
            and abs(wrap(e['heading_deg']-heading))<1]
    assert len(rows)==1
    return rows[0]


def start_to_second_node():
    trace = SensorTrace()
    trace.publish(0,0,absolute_exits=(0,))
    params = trace.select(0)
    trace.publish(0,20,travelled=20,method='take_exit',params=params)
    trace.publish(0,40,travelled=40,absolute_exits=(180,),method='follow_road',
                  params={'distanceCm':20,'speed':50})
    return trace


def test_matching_node_views_after_translation_retain_unresolved_parking_identity():
    trace = SensorTrace()
    trace.publish(0,0,absolute_exits=(0,90,-90))
    trace.publish(0,18,travelled=18,absolute_exits=(0,90,-90),method='forward',
                  params={'distanceCm':18,'speed':20})
    trace.publish(0,18,heading=90,travelled=18,absolute_exits=(0,90,-90),
                  method='turn',params={'angleDeg':90,'speed':50})
    e = trace.evidence()
    # Endpoints alone cannot distinguish within-node parking from a short
    # adjacent-node road. The stationary turn then preserves that hypothesis,
    # without resolving the earlier translated anchor into the old node.
    assert canonical(e,1)!=canonical(e,2)==canonical(e,3)
    assert canonical(e,1) in anchor(e,2)['candidate_ids']
    node = next(n for n in e['nodes'] if n['id']==canonical(e,2))
    assert {2,3}<=set(node['anchor_indices']) and node['status']=='unresolved'
    assert node['merge_evidence_refs'], 'The stationary-turn binding needs its public motion basis'
    assert e['traversals']==[], 'Within-junction stopping changes do not complete an exit'
    assert not trace.roads.exploration_status()['complete']


def test_stationary_fresh_camera_frame_with_decreased_tick_cannot_merge_nodes():
    trace = SensorTrace()
    trace.publish(0,0,absolute_exits=(0,))
    trace.publish(0,0,absolute_exits=(0,),tick=0)
    e = trace.evidence()
    assert canonical(e,1)!=canonical(e,2)
    assert trace.roads.exploration_status()['unresolved_connection_count']>0
    assert trace.roads.exploration_status()['complete'] is False


def test_observed_node_without_exit_structure_is_an_unresolved_obligation():
    trace = SensorTrace()
    trace.publish(0,0,at_node=True)
    e = trace.evidence()
    assert anchor(e,1), 'Missing exits must not erase the observed node anchor'
    status = trace.roads.exploration_status()
    assert status['complete'] is False
    assert status['unresolved_node_count']+status['unresolved_connection_count']>0


@pytest.mark.parametrize('gap_cm',[6,12,18])
def test_near_identical_junctions_separated_by_observed_road_are_distinct(gap_cm):
    trace = SensorTrace()
    trace.publish(0,0,absolute_exits=(0,180,90))
    params = trace.select(0)
    trace.publish(0,gap_cm/2,travelled=gap_cm/2,method='take_exit',params=params)
    trace.publish(0,gap_cm,travelled=gap_cm,absolute_exits=(0,180,90),
                  method='follow_road',params={'distanceCm':gap_cm/2,'speed':20})
    e = trace.evidence()
    assert canonical(e,1) is not None and canonical(e,3) is not None
    assert canonical(e,1)!=canonical(e,3)
    assert len(e['traversals'])==1


@pytest.mark.parametrize('gap_cm',[6,12,18])
def test_near_identical_disconnected_observations_do_not_invent_identity_or_connection(gap_cm):
    trace = SensorTrace()
    trace.publish(0,0,absolute_exits=(0,180,90))
    # No command/motion record accounts for arriving on this nearby branch.
    trace.publish(gap_cm,0,travelled=gap_cm,absolute_exits=(0,180,90),tick=20)
    e = trace.evidence()
    assert canonical(e,2) is None or canonical(e,2)!=canonical(e,1)
    assert e['traversals']==[] and trace.roads.road_segment_records()==[]
    assert not trace.roads.exploration_status()['complete']
    assert (trace.roads.exploration_status()['unresolved_node_count']
            +trace.roads.exploration_status()['unresolved_connection_count'])>0


@pytest.mark.parametrize('gap_cm',[6,18,30])
def test_coarse_follow_road_between_matching_node_views_cannot_prove_same_junction(gap_cm):
    trace = SensorTrace()
    trace.publish(0,0,absolute_exits=(0,180,90))
    # A road actuator may cross the corridor between its two endpoint frames.
    # Equal local structure at those endpoints is not a within-junction view.
    trace.publish(0,gap_cm,travelled=gap_cm,absolute_exits=(0,180,90),
        method='follow_road',params={'distanceCm':gap_cm,'speed':50},
        result={'accepted':True,'stoppedBy':'junction','distanceCm':gap_cm})
    e = trace.evidence()
    assert canonical(e,2) is None or canonical(e,2)!=canonical(e,1)
    assert not e['traversals'], 'No observed departure selection authorized a complete exit'
    assert trace.roads.exploration_status()['complete'] is False


@pytest.mark.parametrize('fault',['gap_index','repeat_frame','missing_camera','unbound_tick','unaccounted_motion'])
def test_missing_or_unbound_public_window_cannot_complete_or_connect_exit(fault):
    trace = SensorTrace()
    trace.publish(0,0,absolute_exits=(0,))
    params = trace.select(0)
    changed = {'index':3} if fault=='gap_index' else {'frame':'1'} if fault=='repeat_frame' else (
        {'camera':False} if fault=='missing_camera' else {'camera_tick':999} if fault=='unbound_tick'
        else {'method':None,'tick':20})
    kwargs = {'method':'take_exit','params':params,**changed}
    trace.publish(0,30,travelled=30,absolute_exits=(180,),**kwargs)
    e = trace.evidence()
    assert e['traversals']==[]
    assert trace.roads.road_segment_records()==[]
    assert exit_at(e,1,0)['state']!='verified'
    assert not trace.roads.exploration_status()['complete']


def test_loop_back_to_departure_is_real_traversal_without_inventing_reverse():
    trace = SensorTrace()
    trace.publish(0,0,absolute_exits=(0,-90))
    params = trace.select(0)
    trace.publish(0,30,travelled=30,method='take_exit',params=params)
    trace.publish(30,30,heading=-90,travelled=77.1,method='follow_road',
                  params={'distanceCm':47.1,'speed':30})
    trace.publish(30,0,heading=-180,travelled=124.2,method='follow_road',
                  params={'distanceCm':47.1,'speed':30})
    trace.publish(0,0,heading=90,travelled=171.3,absolute_exits=(0,-90),
                  method='follow_road',params={'distanceCm':47.1,'speed':30})
    e = trace.evidence()
    assert canonical(e,1)==canonical(e,5)
    assert len(e['traversals'])==1
    assert exit_at(e,1,0)['state']=='verified'
    assert exit_at(e,5,-90)['state']!='verified'
    assert trace.roads.exploration_status()['pending_exit_count']>=1


@pytest.mark.parametrize('stopped_by',['collision','front_clearance','off_road','wrong_way'])
def test_blocked_exit_stays_pending_even_when_legacy_block_flag_is_set(stopped_by):
    trace = SensorTrace()
    trace.publish(0,0,absolute_exits=(0,))
    params = trace.select(0)
    trace.publish(0,0,absolute_exits=(0,),method='take_exit',params=params,
                  result={'accepted':True,'stoppedBy':stopped_by,'distanceCm':0})
    trace.roads.mark_blocked()
    e = trace.evidence()
    assert exit_at(e,1,0)['state']=='blocked'
    assert not exit_at(e,1,0)['completion_traversal_ids']
    status = trace.roads.exploration_status()
    assert status['pending_exit_count']==1 and status['state_counts']['blocked']==1
    assert status['complete'] is False


def test_blocked_can_recover_only_after_new_complete_accepted_sensor_window():
    trace = SensorTrace()
    trace.publish(0,0,absolute_exits=(0,))
    params = trace.select(0)
    trace.publish(0,0,absolute_exits=(0,),method='take_exit',params=params,
                  result={'accepted':True,'stoppedBy':'front_clearance','distanceCm':0})
    trace.roads.mark_blocked()
    params = trace.select(0)
    assert exit_at(trace.evidence(),2,0)['state']!='verified'
    trace.publish(0,20,travelled=20,method='take_exit',params=params)
    assert exit_at(trace.evidence(),2,0)['state']!='verified'
    trace.publish(0,40,travelled=40,absolute_exits=(180,),method='follow_road',
                  params={'distanceCm':20,'speed':50})
    assert exit_at(trace.evidence(),1,0)['state']=='verified'
    assert trace.roads.exploration_status()['pending_exit_count']==1


def test_return_exit_requires_actual_reverse_traversal_not_heading_or_route_candidate():
    trace = start_to_second_node()
    e = trace.evidence()
    assert exit_at(e,1,0)['state']=='verified'
    assert exit_at(e,3,180)['state']!='verified'
    trace.publish(0,40,heading=-180,travelled=40,absolute_exits=(180,),method='turn',
                  params={'angleDeg':-180,'speed':50})
    before = trace.evidence()
    trace.roads.approach_candidates(trace.current['odometry'],(0,-.5))
    assert trace.evidence()==before
    assert exit_at(before,4,180)['state']!='verified'
    params = trace.select(180)
    trace.publish(0,20,heading=-180,travelled=60,method='take_exit',params=params)
    trace.publish(0,0,heading=-180,travelled=80,absolute_exits=(0,),method='follow_road',
                  params={'distanceCm':20,'speed':50})
    e = trace.evidence()
    assert canonical(e,1)==canonical(e,6)
    assert len(e['traversals'])==2
    assert exit_at(e,3,180)['state']=='verified'
    assert trace.roads.exploration_status()['complete'] is True


def test_current_near_field_identity_ambiguity_blocks_unknown_quantity_completion():
    p = Perception(CAMERA)
    for frame,forward in enumerate((0,16,32),1):
        observe(p,frame,forward)
    oid = p.objects()[0]['id']
    proof = grasp_evidence(p,oid,time=1)
    proof['post_observation'] = p.last_evidence['frame_id']
    assert p.mark_picked(oid,holding=True,original_position_absent=True,
                         simulation_time_s=1,evidence=proof)
    assert p.mark_delivered(oid,holding=False,ball_in_storage=True,simulation_time_s=2,
                            evidence=placement_evidence(p,oid))
    current = observe(p,5,forward=30,time=3,items=[ball(30,bearing=-3),ball(30,bearing=3)])
    assert all(d.get('identity_ambiguity') and d.get('track_id') is None
               for d in current['detections'])
    reds = [row for row in p.objects() if row['category']=='red-ball']
    assert len(reds)==1 and reds[0]['state']=='DELIVERED'
    trace = start_to_second_node()
    trace.publish(0,40,heading=-180,travelled=40,absolute_exits=(180,),method='turn',
                  params={'angleDeg':-180,'speed':50})
    params = trace.select(180)
    trace.publish(0,20,heading=-180,travelled=60,method='take_exit',params=params)
    trace.publish(0,0,heading=-180,travelled=80,absolute_exits=(0,),method='follow_road',
                  params={'distanceCm':20,'speed':50})
    exploration = trace.roads.exploration_status()
    assert exploration['complete']
    unknown = completion_progress(p.objects(),p.action_evidence(),
        parse_task('把地图上的红球都送到绿色存放区'),holding=False,nodes=len(trace.roads.nodes),unexplored=0,
        observed_detections=current['detections'],exploration=exploration,
        discovery_evidence=p.discovery_evidence())
    assert unknown['ready_for_done'] is False
    assert 'current_target_identity_ambiguity' in unknown['unmet_conditions']
    assert 'road_exploration_incomplete' not in unknown['unmet_conditions']
    known = completion_progress(p.objects(),p.action_evidence(),
        parse_task('把一个红球送到绿色存放区'),holding=False,nodes=len(trace.roads.nodes),unexplored=0,
        observed_detections=current['detections'],discovery_evidence=p.discovery_evidence())
    assert known['ready_for_done'] is True, 'Known-count scope must retain its stage 1 contract'
    # Looking away does not explain the earlier second box or erase its
    # source evidence, even though the current-frame ambiguity has disappeared.
    saved_discoveries = p.discovery_evidence()
    clear = observe(p,6,forward=30,time=3.1,items=[])
    fresh = completion_progress(p.objects(),p.action_evidence(),
        parse_task('把地图上的红球都送到绿色存放区'),holding=False,nodes=len(trace.roads.nodes),unexplored=0,
        observed_detections=clear['detections'],exploration=exploration,
        discovery_evidence=p.discovery_evidence())
    assert fresh['ready_for_done'] is False
    assert p.discovery_evidence()==saved_discoveries
    assert set(fresh['untracked_discovery_ids'])=={
        row['id'] for row in saved_discoveries['unresolved']}
    assert 'current_target_identity_ambiguity' not in fresh['unmet_conditions']
