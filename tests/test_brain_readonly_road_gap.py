"""Public r184 road legs separated by read-only frames; synthetic negative controls."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from autonomous_brain.navigation import RoadMemory, position, wrap

FIXTURE=json.loads((Path(__file__).parent/'fixtures/run_20261018T153637Z_readonly_road_gap_public.json').read_text())


def memory_fixture(index=936):
    memory=RoadMemory()
    motions={m['after_observation']:m for m in FIXTURE['motions']}
    current=None
    for original in FIXTURE['observations']:
        if original['observation_index']>index:break
        current=copy.deepcopy(original)
        memory.update(current['odometry'],current['road'],current['observation_index'])
        memory.observe_traversal(current,copy.deepcopy(motions.get(current['observation_index'])))
    return memory,copy.deepcopy(current)


@pytest.mark.parametrize('index,turn_count',[(935,0),(936,0),(937,0),(945,8)])
def test_recorded_readonly_gap_preserves_exact_measured_road_legs(index,turn_count):
    memory,current=memory_fixture(index)
    before=copy.deepcopy((memory._road_segments,memory._approach_edges,memory.road_evidence(),memory.blocked))
    proof=memory.observed_road_return_support(current)
    assert proof is not None
    assert proof['before_observation']==929 and proof['after_observation']==935
    assert proof['current_observation']==index and proof['max_travel_cm']==pytest.approx(45)
    assert [s['segment_id']for s in proof['observed_segments']]==['road-segment-929-930','road-segment-934-935']
    assert proof['target_anchor']['observation_index']==929
    assert proof['target_anchor']['position_m']==pytest.approx([-.865,1.819])
    assert len(proof['stationary_turn_tail'])==turn_count
    gap=proof['stationary_readonly_gaps']
    assert len(gap)==1 and gap[0]['first_observation']==930 and gap[0]['last_observation']==934
    assert gap[0]['readonly_intervals']==4
    assert proof['observed_segments'][1]['measured_cm']<proof['observed_segments'][1]['travelled_cm']
    assert (memory._road_segments,memory._approach_edges,memory.road_evidence(),memory.blocked)==before


@pytest.mark.parametrize('fault',[
    'right','forward','heading','odometer','nan','holding','holding_unknown','holding_extra',
    'offroad','node','junction','front','left','right_clearance','heading_error','exits','road_extra',
    'road_missing','missing_frame','reused_frame','nonadjacent_frame','back_tick','road_tick','sensor_tick',
    'bool_tick','missing_odometry','invalid_index','missing_record',
])
def test_gap_does_not_hide_motion_sensor_load_or_road_change(fault):
    memory,current=memory_fixture()
    row=memory._semantic.frames[932]
    if fault in {'right','forward','heading','odometer','nan'}:
        key={'right':'rightCm','forward':'forwardCm','heading':'headingDeg','odometer':'distanceCm','nan':'rightCm'}[fault]
        row['odometry'][key]=float('nan')if fault=='nan'else row['odometry'][key]+.000001
    elif fault=='holding':row['holding']['holding']=True
    elif fault=='holding_unknown':row['holding']['holding']=None
    elif fault=='holding_extra':row['holding']['unverified']=True
    elif fault=='offroad':row['road']['onRoad']=False
    elif fault=='node':row['road']['atNode']=True
    elif fault=='junction':row['road']['atJunction']=True
    elif fault in {'front','left','right_clearance','heading_error'}:
        key={'front':'frontClearanceCm','left':'leftClearanceCm','right_clearance':'rightClearanceCm','heading_error':'headingErrorDeg'}[fault]
        row['road'][key]+=.000001
    elif fault=='exits':row['road']['exits']=[{'angleDeg':0}]
    elif fault=='road_extra':row['road']['unverified']=True
    elif fault=='road_missing':row['road'].pop('frontClearanceCm')
    elif fault=='missing_frame':row['observation'].pop('frameId')
    elif fault=='reused_frame':row['observation']['frameId']=931
    elif fault=='nonadjacent_frame':row['observation']['frameId']=930
    elif fault=='back_tick':
        for part in ('odometry','road','observation'):row[part]['tick']-=1
    elif fault=='road_tick':row['road']['tick']+=1
    elif fault=='sensor_tick':row['observation']['tick']+=1
    elif fault=='bool_tick':
        for part in ('odometry','road','observation'):row[part]['tick']=True
    elif fault=='missing_odometry':row['odometry'].pop('distanceCm')
    elif fault=='invalid_index':memory._invalid_indices.add(932)
    elif fault=='missing_record':del memory._semantic.frames[932]
    assert memory._registered_readonly_road_gap(930,934) is None
    assert memory.observed_road_return_support(current) is None


@pytest.mark.parametrize('fault',['duplicate','out_of_order','extra','missing_motion_list','malformed_row'])
def test_gap_closed_window_requires_exact_registered_sequence(fault):
    memory,current=memory_fixture()
    original=memory.observation_records
    def records(first,last):
        window=original(first,last)
        if first==930 and last==934:
            if fault=='duplicate':window['observations'].insert(2,copy.deepcopy(window['observations'][1]))
            elif fault=='out_of_order':window['observations'][1:3]=reversed(window['observations'][1:3])
            elif fault=='extra':window['observations'].append(copy.deepcopy(memory._semantic.frames[935]))
            elif fault=='missing_motion_list':window.pop('motions')
            elif fault=='malformed_row':window['observations'][2]=None
        return window
    memory.observation_records=records
    assert memory._registered_readonly_road_gap(930,934) is None
    assert memory.observed_road_return_support(current) is None


@pytest.mark.parametrize('pair',[(930,931),(931,932),(931,934),(929,932),(933,935),(928,932)])
@pytest.mark.parametrize('method,unknown',[('turn',False),('forward',False),('grab',False),('turn',True)])
def test_any_command_touching_or_crossing_gap_is_not_readonly(pair,method,unknown):
    memory,current=memory_fixture()
    memory._semantic.motions[pair]={'before_observation':pair[0],'after_observation':pair[1],
        'method':method,'params':{'angleDeg':0}if method=='turn'else {'distanceCm':.1}if method=='forward'else {},
        'bridge_request_id':'synthetic-gap-command','actuator_result':{'completed':True},'outcome_unknown':unknown}
    assert memory._registered_readonly_road_gap(930,934) is None
    assert memory.observed_road_return_support(current) is None


@pytest.mark.parametrize('key,packet',[((931,932),(1,2)),((1,2),(931,932))])
def test_mismatched_registered_motion_interval_cannot_hide_gap_command(key,packet):
    memory,current=memory_fixture()
    memory._semantic.motions[key]={'before_observation':packet[0],'after_observation':packet[1],
        'method':'turn','params':{'angleDeg':0},'bridge_request_id':'synthetic-conflicting-index',
        'actuator_result':{'completed':True}}
    assert memory._registered_readonly_road_gap(930,934) is None
    assert memory.observed_road_return_support(current) is None


def test_complete_readonly_frames_can_advance_time_without_motion():
    memory,current=memory_fixture()
    for i in range(931,935):
        row=memory._semantic.frames[i]
        for part in ('odometry','road','observation'):row[part]['tick']+=i-930
    # Shift the following actuator tick/duration consistently; no travelled
    # distance or source road evidence is created by read-only time passing.
    second=memory._road_segments['road-segment-934-935']
    second['motion']['actuator_result']['elapsedTicks']-=4
    memory._semantic.motions[(934,935)]['actuator_result']['elapsedTicks']-=4
    assert memory._registered_readonly_road_gap(930,934) is not None
    assert memory.observed_road_return_support(current) is not None


@pytest.mark.parametrize('fault',['source_unknown','source_unsent','source_rejected','source_collision',
    'source_request_missing','source_distance','source_elapsed','source_reverse_missing','source_version',
    'current_pose','current_heading','current_holding','current_offroad','current_tick','current_frame',
    'ambiguous_predecessor','current_reverse_blocker'])
def test_gap_rule_keeps_original_source_reverse_and_current_permissions(fault):
    memory,current=memory_fixture()
    first=memory._road_segments['road-segment-929-930']
    if fault=='source_unknown':first['motion']['outcome_unknown']=True
    elif fault=='source_unsent':first['motion']['motion_not_sent']=True
    elif fault=='source_rejected':first['motion']['actuator_result']['accepted']=False
    elif fault=='source_collision':first['motion']['actuator_result']['stoppedBy']='collision'
    elif fault=='source_request_missing':first['motion'].pop('bridge_request_id')
    elif fault=='source_distance':first['motion']['actuator_result']['distanceCm']+=1
    elif fault=='source_elapsed':first['motion']['actuator_result']['elapsedTicks']+=1
    elif fault=='source_reverse_missing':memory._approach_edges[tuple(first['arrival']['position_m'])].pop(tuple(first['departure']['position_m']))
    elif fault=='source_version':memory._approach_edges[tuple(first['arrival']['position_m'])][tuple(first['departure']['position_m'])]['segment_version']='different'
    elif fault=='current_pose':current['odometry']['rightCm']+=.000001
    elif fault=='current_heading':current['odometry']['headingDeg']+=.1
    elif fault=='current_holding':current['holding']['holding']=True
    elif fault=='current_offroad':current['road']['onRoad']=False
    elif fault=='current_tick':current['road']['tick']+=1
    elif fault=='current_frame':current['observation']['frameId']='unregistered-current'
    elif fault=='ambiguous_predecessor':memory._road_segments['synthetic-duplicate']=copy.deepcopy(first)
    elif fault=='current_reverse_blocker':
        before=copy.deepcopy(current);before['odometry']['headingDeg']=wrap(before['odometry']['headingDeg']+180)
        after=copy.deepcopy(before);after['observation_index']+=1
        memory.remember_passage_failure(before,after,{'method':'follow_road','actuator_result':{'accepted':True,'stoppedBy':'front_clearance','distanceCm':0}})
    assert memory.observed_road_return_support(current) is None


def runtime_fixture(*,unknown=None,after_turn=None):
    memory,current=memory_fixture()
    current['perception']={'detections':[]}
    calls,motions,observations=[],[],[]
    runtime=SimpleNamespace(snapshot=current,roads=memory,round=184,held_object_id=None,pending_grasp=None,
        perception=SimpleNamespace(objects=lambda:[]),bridge=SimpleNamespace(seconds=745,max_seconds=1200,sequence=4308),
        motion_log=SimpleNamespace(write=lambda row:motions.append(copy.deepcopy(row))))
    error=TimeoutError('synthetic readonly-gap return receipt unknown')
    def call(method,params):
        calls.append((method,copy.deepcopy(params)));runtime.bridge.sequence+=1
        if method=='turn':
            current['odometry']['headingDeg']=wrap(current['odometry']['headingDeg']+params['angleDeg'])
            result={'completed':True}
        else:
            assert method=='follow_road'
            current['odometry']['rightCm']-=9.4
            current['odometry']['distanceCm']+=9.4
            current['road'].update(atNode=True,atJunction=True,exits=[{'angleDeg':a}for a in (0,90,-90)])
            result={'accepted':True,'stoppedBy':'junction','distanceCm':9.4}
        if method==unknown:raise error
        return result
    def observe(*,motion=None):
        observations.append(copy.deepcopy(motion))
        current['observation_index']+=1;current['odometry']['tick']+=1
        current['road'].update(tick=current['odometry']['tick'],headingErrorDeg=0,frontClearanceCm=100)
        current['observation'].update(frameId=current['observation_index'],tick=current['odometry']['tick'])
        runtime.bridge.seconds+=.02
        if motion and motion['method']=='turn':
            if after_turn=='holding':current['holding']['holding']=True
            elif after_turn=='offroad':current['road']['onRoad']=False
            elif after_turn=='front':current['road']['frontClearanceCm']=.1
            elif after_turn=='side':current['road']['leftClearanceCm']=.1
            elif after_turn=='heading':current['road']['headingErrorDeg']=20
            elif after_turn=='old_frame':current['observation']['frameId']=936
            elif after_turn=='sensor_tick':current['observation']['tick']+=1
            elif after_turn=='position':current['odometry']['rightCm']+=.1
        memory.update(current['odometry'],current['road'],current['observation_index'])
        memory.observe_traversal(current,dict(motion,after_observation=current['observation_index'])if motion else None)
        return current
    runtime.bridge.call,runtime.observe=call,observe
    return runtime,Actions(runtime),calls,motions,observations,error


def rejection():return ObservedMotionFailure('directed_passage_still_blocked',{'motion_not_sent':True})


def test_real_actions_dispatch_turn_then_bounded_follow_using_readonly_gap_support():
    runtime,actions,calls,motions,_,_=runtime_fixture()
    result=actions.return_after_known_road_rejection(rejection())
    assert result['reason']=='road_blocked_returned_to_junction'
    assert [method for method,_ in calls]==['turn','follow_road']
    assert calls[1][1]=={'distanceCm':20,'speed':30}
    assert result['evidence']['recorded_road_return']['max_travel_cm']==45
    assert result['evidence']['recorded_road_return']['actual_travel_cm']==pytest.approx(9.4)
    assert result['evidence']['recorded_road_return']['stationary_readonly_gaps'][0]['readonly_intervals']==4
    assert all(not m.get('outcome_unknown')for m in motions)
    # The actually observed first node ends recovery; it is not declared to be
    # the old departure endpoint nor treated as two-ball success.
    assert position(runtime.snapshot['odometry'])!=(-.865,1.819)


@pytest.mark.parametrize('method',['turn','follow_road'])
def test_unknown_return_command_is_not_retried_or_hidden_by_prior_known_rejection(method):
    _,actions,calls,motions,observations,error=runtime_fixture(unknown=method)
    with pytest.raises(TimeoutError)as caught:actions.return_after_known_road_rejection(rejection())
    assert caught.value is error
    assert [m for m,_ in calls].count(method)==1
    assert [m for m,_ in calls]==(['turn']if method=='turn'else ['turn','follow_road'])
    assert observations[-1] is None and sum(o is None for o in observations)==1
    assert motions[-1]['outcome_unknown'] is True
    assert error.action_evidence['outcome_unknown'] is True
    assert error.action_evidence['uncertain_motion']['method']==method
    assert error.action_evidence['pre_motion_rejection']['evidence']['motion_not_sent'] is True


@pytest.mark.parametrize('fault',['holding','offroad','front','side','heading','old_frame','sensor_tick','position'])
def test_post_turn_current_safety_is_rechecked_before_any_return_translation(fault):
    _,actions,calls,_,_,_=runtime_fixture(after_turn=fault)
    try:result=actions.return_after_known_road_rejection(rejection())
    except ObservedMotionFailure:result=None
    assert [method for method,_ in calls]==['turn']
    assert result is None or result['reason']!='road_blocked_returned_to_junction'
