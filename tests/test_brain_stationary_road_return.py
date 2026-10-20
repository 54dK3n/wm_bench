"""Recorded r111-r117 turn suffix; synthetic mutations and return feedback."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from autonomous_brain.navigation import RoadMemory, position, wrap
from test_brain_route_contract import normalize

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/run_20261018T120426Z_stationary_return_public.json').read_text())


def memory_fixture(index=687, holding=False):
    data=copy.deepcopy(FIXTURE)
    motions={m['after_observation']:m for m in data['motions']}
    roads=RoadMemory()
    current=None
    for frame in data['observations']:
        if frame['observation_index']>index: break
        frame['holding']['holding']=holding
        roads.update(frame['odometry'],frame['road'],frame['observation_index'])
        roads.observe_traversal(frame,motions.get(frame['observation_index']))
        current=copy.deepcopy(frame)
    return roads,current


def runtime_fixture(index=687):
    roads,current=memory_fixture(index)
    current['perception']={'detections':[]}
    calls,motions,observations=[],[],[]
    controls={'unknown_method':None,'after_turn_change':None}
    r=SimpleNamespace(snapshot=current,round=117,roads=roads,held_object_id=None,pending_grasp=None,
        perception=SimpleNamespace(objects=lambda:[]),
        bridge=SimpleNamespace(seconds=546.24,max_seconds=1200,sequence=3200),
        motion_log=SimpleNamespace(write=lambda row:motions.append(copy.deepcopy(row))))
    def call(method,params):
        params=normalize(method,params)
        calls.append((method,params))
        r.bridge.sequence+=1
        if method=='turn':
            current['odometry']['headingDeg']=wrap(current['odometry']['headingDeg']+params['angleDeg'])
            result={'completed':True}
        else:
            assert method=='follow_road'
            current['odometry']['rightCm']+=9.4
            current['odometry']['distanceCm']+=9.4
            current['road'].update(atNode=True,atJunction=True,exits=[{'angleDeg':a}for a in (0,90,-90,180)])
            result={'accepted':True,'stoppedBy':'junction','distanceCm':9.4}
        if controls['unknown_method']==method:
            raise TimeoutError('synthetic dispatched return receipt unknown')
        return result
    def observe(*,motion=None):
        observations.append(copy.deepcopy(motion))
        current['observation_index']+=1
        current['odometry']['tick']+=1
        current['road'].update(tick=current['odometry']['tick'],headingErrorDeg=0,frontClearanceCm=200)
        current['observation'].update(frameId=current['observation_index'],tick=current['odometry']['tick'])
        r.bridge.seconds+=.02
        if motion and motion['method']=='turn':
            fault=controls['after_turn_change']
            if fault=='holding':current['holding']['holding']=True
            elif fault=='offroad':current['road']['onRoad']=False
            elif fault=='clearance':current['road']['frontClearanceCm']=.1
            elif fault=='old_frame':current['observation']['frameId']=index
            elif fault=='tick':current['road']['tick']+=1
        roads.update(current['odometry'],current['road'],current['observation_index'])
        roads.observe_traversal(current,dict(motion,after_observation=current['observation_index'])if motion else None)
        return current
    r.bridge.call,r.observe=call,observe
    return r,Actions(r),calls,motions,observations,controls


def rejection():
    return ObservedMotionFailure('directed_passage_still_blocked',{'motion_not_sent':True})


@pytest.mark.parametrize('index,turn_count',[(652,0),(653,0),(663,8),(665,8),(675,16),(687,24)])
def test_real_complete_stationary_scan_preserves_original_road_return(index,turn_count):
    roads,current=memory_fixture(index)
    original_edges=copy.deepcopy(roads._approach_edges)
    proof=roads.observed_road_return_support(current)
    assert proof is not None
    assert proof['before_observation']==650 and proof['after_observation']==651
    assert proof['current_observation']==index
    assert proof['segment_id']=='road-segment-650-651'
    assert proof['execution_kind']=='road_following'
    assert proof['max_travel_cm']==pytest.approx(40.6)
    assert proof['target_anchor']['position_m']==pytest.approx([.026,1.667])
    assert len(proof['stationary_turn_tail'])==turn_count
    assert roads._approach_edges==original_edges


def test_known_holding_is_preserved_without_changing_original_operation_permissions():
    roads,current=memory_fixture(holding=True)
    proof=roads.observed_road_return_support(current)
    assert proof is not None and proof['holding'] is True
    assert len(proof['stationary_turn_tail'])==24


@pytest.mark.parametrize('fault',[
    'unknown','unsent','missing_request_id','missing_receipt','incomplete','rejected','error','stopped',
    'ack_nonzero_distance','wrong_ack_tick','wrong_ack_elapsed','unknown_method','translation','grab',
    'wrong_angle','zero_angle','large_angle','low_speed','high_speed','unknown_param','bool_angle',
    'old_frame','zero_tick','road_tick','sensor_tick','missing_frame','duplicate_frame','invalid_frame',
    'missing_motion','duplicate_motion','outside_motion','unregistered_turn','pose_drift','odometer_drift',
    'micro_translation','heading_not_restored','holding_changed','holding_unknown','offroad','node',
])
def test_stationary_tail_rejects_any_incomplete_changed_or_nonstationary_evidence(fault):
    roads,current=memory_fixture()
    original=roads.observation_records
    def records(first,last):
        window=original(first,last)
        frames={f['observation_index']:f for f in window['observations']}
        motion=next(m for m in window['motions']if m['before_observation']==653)
        a,b=frames[653],frames[654]
        if fault=='unknown':motion['outcome_unknown']=True
        elif fault=='unsent':motion['motion_not_sent']=True
        elif fault=='missing_request_id':del motion['bridge_request_id']
        elif fault=='missing_receipt':del motion['actuator_result']
        elif fault=='incomplete':motion['actuator_result']['completed']=False
        elif fault=='rejected':motion['actuator_result']['accepted']=False
        elif fault=='error':motion['actuator_result']['error']='synthetic'
        elif fault=='stopped':motion['actuator_result']['stoppedBy']='front_clearance'
        elif fault=='ack_nonzero_distance':motion['actuator_result']['distanceCm']=.1
        elif fault=='wrong_ack_tick':motion['actuator_result']['tick']=b['odometry']['tick']+1
        elif fault=='wrong_ack_elapsed':motion['actuator_result']['elapsedTicks']=1
        elif fault=='unknown_method':motion['method']='unknown'
        elif fault=='translation':motion.update(method='forward',params={'distanceCm':.1,'speed':30})
        elif fault=='grab':motion.update(method='grab',params={})
        elif fault=='wrong_angle':motion['params']['angleDeg']+=1
        elif fault=='zero_angle':motion['params']['angleDeg']=0
        elif fault=='large_angle':motion['params']['angleDeg']=181
        elif fault=='low_speed':motion['params']['speed']=9
        elif fault=='high_speed':motion['params']['speed']=101
        elif fault=='unknown_param':motion['params']['other']=1
        elif fault=='bool_angle':motion['params']['angleDeg']=True
        elif fault=='old_frame':b['observation']['frameId']=a['observation']['frameId']
        elif fault=='zero_tick':b['odometry']['tick']=b['observation']['tick']=b['road']['tick']=a['odometry']['tick']
        elif fault=='road_tick':b['road']['tick']+=1
        elif fault=='sensor_tick':b['observation']['tick']+=1
        elif fault=='missing_frame':window['observations'].remove(b)
        elif fault=='duplicate_frame':window['observations'].append(copy.deepcopy(b))
        elif fault=='invalid_frame':window['invalid_observation_indices']=[654]
        elif fault=='missing_motion':window['motions'].remove(motion)
        elif fault=='duplicate_motion':window['motions'].append(copy.deepcopy(motion))
        elif fault=='outside_motion':window['motions'].append(dict(motion,before_observation=688,after_observation=689))
        elif fault=='unregistered_turn':frames[652]['odometry']['headingDeg']+=1
        elif fault=='pose_drift':b['odometry']['rightCm']+=.001
        elif fault=='odometer_drift':b['odometry']['distanceCm']+=.001
        elif fault=='micro_translation':
            b['odometry']['rightCm']+=.1
            b['odometry']['distanceCm']+=.1
        elif fault=='heading_not_restored':
            for i in (685,686,687):frames[i]['odometry']['headingDeg']+=.1
            current['odometry']['headingDeg']+=.1
            window['motions'][-1]['params']['angleDeg']+=.1
        elif fault=='holding_changed':b['holding']['holding']=True
        elif fault=='holding_unknown':b['holding']['holding']=None
        elif fault=='offroad':b['road']['onRoad']=False
        elif fault=='node':b['road']['atNode']=True
        return window
    roads.observation_records=records
    assert roads.observed_road_return_support(current) is None


@pytest.mark.parametrize('receipt_distance',[-.1,None,False,True,float('nan')])
def test_turn_receipt_cannot_contradict_exact_zero_stationary_distance(receipt_distance):
    roads,current=memory_fixture()
    original=roads.observation_records
    def records(first,last):
        window=original(first,last)
        motion=next(m for m in window['motions']if m['before_observation']==653)
        motion['actuator_result']['distanceCm']=receipt_distance
        return window
    roads.observation_records=records
    assert roads.observed_road_return_support(current) is None


def test_explicit_zero_turn_receipt_distance_remains_legal():
    roads,current=memory_fixture()
    original=roads.observation_records
    def records(first,last):
        window=original(first,last)
        for motion in window['motions']:
            if motion['method']=='turn':motion['actuator_result']['distanceCm']=0
        return window
    roads.observation_records=records
    assert len(roads.observed_road_return_support(current)['stationary_turn_tail'])==24


@pytest.mark.parametrize('fault',['current_pose','current_heading','current_frame','current_road_tick',
    'current_holding','current_unknown_holding','current_offroad','current_node','missing_reverse',
    'source_unknown','source_unsent','source_basic','current_reverse_blocker'])
def test_new_tail_rule_keeps_source_reverse_and_current_snapshot_gates(fault):
    roads,current=memory_fixture()
    assert roads.observed_road_return_support(current) is not None
    source=roads._road_segments['road-segment-650-651']
    if fault=='current_pose':current['odometry']['rightCm']+=.1
    elif fault=='current_heading':current['odometry']['headingDeg']+=.1
    elif fault=='current_frame':current['observation']['frameId']='unregistered-current'
    elif fault=='current_road_tick':current['road']['tick']+=1
    elif fault=='current_holding':current['holding']['holding']=True
    elif fault=='current_unknown_holding':current['holding']['holding']=None
    elif fault=='current_offroad':current['road']['onRoad']=False
    elif fault=='current_node':current['road']['atNode']=True
    elif fault=='missing_reverse':roads._approach_edges[position(current['odometry'])].clear()
    elif fault=='source_unknown':source['motion']['outcome_unknown']=True
    elif fault=='source_unsent':source['motion']['motion_not_sent']=True
    elif fault=='source_basic':source['execution']['kind']='basic_translation'
    elif fault=='current_reverse_blocker':
        entry=copy.deepcopy(current);entry['odometry']['headingDeg']=wrap(entry['odometry']['headingDeg']+180)
        stop=copy.deepcopy(entry);stop['observation_index']+=1
        stop['odometry']['tick']+=1;stop['observation'].update(frameId='new-stop',tick=stop['odometry']['tick'])
        stop['road']['tick']=stop['odometry']['tick']
        roads.remember_passage_failure(entry,stop,{'method':'follow_road','params':{'distanceCm':20,'speed':30},
            'actuator_result':{'accepted':True,'stoppedBy':'front_clearance','distanceCm':0}})
    assert roads.observed_road_return_support(current) is None


def test_tail_preserving_return_uses_existing_turn_and_follow_with_fresh_node_observation():
    r,actions,calls,motions,observations,_=runtime_fixture()
    outcome=actions.return_after_known_road_rejection(rejection())
    assert outcome['reason']=='road_blocked_returned_to_junction'
    assert outcome['success'] is False
    assert [method for method,_ in calls]==['turn','follow_road']
    assert calls[1][1]=={'distanceCm':20,'speed':30}
    assert len(motions)==len(observations)==2
    assert r.snapshot['road']['atNode'] is True
    assert len(outcome['evidence']['recorded_road_return']['stationary_turn_tail'])==24
    assert outcome['evidence']['pre_motion_rejection']['evidence']['motion_not_sent'] is True


@pytest.mark.parametrize('method',['turn','follow_road'])
def test_new_unknown_return_motion_is_logged_and_sent_once(method):
    r,actions,calls,motions,observations,controls=runtime_fixture()
    controls['unknown_method']=method
    with pytest.raises(TimeoutError) as caught:
        actions.return_after_known_road_rejection(rejection())
    assert [m for m,_ in calls].count(method)==1
    assert observations[-1] is None
    assert motions[-1]['outcome_unknown'] is True
    assert caught.value.action_evidence['outcome_unknown'] is True
    assert caught.value.action_evidence['uncertain_motion']['method']==method
    assert caught.value.action_evidence['pre_motion_rejection']['evidence']['motion_not_sent'] is True


@pytest.mark.parametrize('fault',['holding','offroad','clearance','old_frame','tick'])
def test_recovery_turn_must_reobserve_current_safety_before_following(fault):
    _,actions,calls,_,_,controls=runtime_fixture()
    controls['after_turn_change']=fault
    try:
        outcome=actions.return_after_known_road_rejection(rejection())
    except ObservedMotionFailure as error:
        outcome={'success':False,'reason':error.reason}
    assert not outcome['success']
    assert [method for method,_ in calls]==['turn']
