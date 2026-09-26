"""Reliability review counterexamples from declared sensor inputs only."""
import copy
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from test_brain_perception import CAMERA, Perception, ball, observe, grasp_evidence, placement_evidence


def scan_runtime(*, angle_fraction=1., repeated_frame=False, drop=False, missing_heading=False, fail_call=None):
    snap = {'observation_index': 1, 'observation': {'frameId': 1, 'width':640, 'height':480,'detections':[]},
            'odometry': {'rightCm':0., 'forwardCm':0., 'headingDeg':0., 'tick':1},
            'road': {'onRoad':True, 'atNode':False, 'headingErrorDeg':0., 'frontClearanceCm':100},
            'holding':{'holding':drop}, 'perception':{'detections':[]}}
    logs, calls = [], []
    r=SimpleNamespace(snapshot=snap,round=1,config={'task':'把两个红球送到绿色存放区'},
        pending_grasp=None,held_object_id='held' if drop else None,
        motion_log=SimpleNamespace(write=logs.append),
        bridge=SimpleNamespace(seconds=0,max_seconds=1200),
        perception=SimpleNamespace(camera=CAMERA,objects=lambda:[],mark_release_unverified=lambda *a,**k:True))
    def call(method,params):
        calls.append((method,params))
        assert method=='turn'
        snap['odometry']['headingDeg']=(snap['odometry']['headingDeg']+params['angleDeg']*angle_fraction+180)%360-180
        if drop:snap['holding']['holding']=False
        if fail_call==len(calls):raise ConnectionError('lost acknowledgement after execution')
        return {'completed':True}
    def observation(*,motion=None):
        snap['observation_index']+=1;snap['odometry']['tick']+=1
        if not repeated_frame:snap['observation']['frameId']+=1
        if missing_heading:snap['odometry'].pop('headingDeg',None)
    r.bridge.call,r.observe=call,observation
    return r,calls,logs


@pytest.mark.parametrize('fraction',[0.,.5])
def test_r1_incomplete_actual_turn_cannot_report_full_circle(fraction):
    r,calls,logs=scan_runtime(angle_fraction=fraction)
    outcome=Actions(r).execute({'action':'look_around','params':{}})
    assert outcome['success'] is False
    assert len(calls)==1, 'A failed observation check must stop further turn commands'
    assert logs[0]['motion_verification']['motion_verified'] is False


def test_r1_actual_full_circle_has_measured_valid_frame_coverage():
    r,calls,logs=scan_runtime()
    outcome=Actions(r).execute({'action':'look_around','params':{}})
    assert outcome['success'] is True
    coverage=outcome['evidence']['view_coverage']
    assert coverage['covered_degrees']==pytest.approx(360)
    assert coverage['uncovered_degrees']==pytest.approx(0)
    assert len(calls)==8 and len(set(v['frame_id']for v in coverage['views']))==len(coverage['views'])


@pytest.mark.parametrize('fault',['repeated_frame','missing_heading','drop'])
def test_r1_invalid_frame_or_sensor_or_holding_stops_scan(fault):
    r,calls,logs=scan_runtime(**{fault:True})
    result=Actions(r).execute({'action':'look_around','params':{}})
    assert result['success'] is False and len(calls)==1
    if fault=='drop':assert r.held_object_id is None


def test_r1_exception_keeps_executed_motion_log_without_retry():
    r,calls,logs=scan_runtime(fail_call=1)
    with pytest.raises(ConnectionError):Actions(r).execute({'action':'look_around','params':{}})
    assert len(calls)==len(logs)==1 and logs[0]['outcome_unknown'] is True
    assert r.snapshot['odometry']['headingDeg']==45


@pytest.mark.parametrize('sensor',['road','odometry','holding','observation'])
def test_r1_missing_sensor_container_still_writes_rejection_evidence(sensor):
    from autonomous_brain.actions import ObservedMotionFailure
    r,calls,logs=scan_runtime();original=r.observe
    def missing(*,motion=None):
        original(motion=motion)
        r.snapshot.pop(sensor,None)
    r.observe=missing
    with pytest.raises(ObservedMotionFailure):
        Actions(r).move('turn',{'angleDeg':45,'speed':50})
    assert len(calls)==len(logs)==1
    assert logs[0]['motion_verification']['reasons']==['motion_state_unknown']


def test_r1_actual_turns_with_camera_gaps_cannot_claim_full_coverage():
    r,calls,logs=scan_runtime()
    r.perception.camera=dict(CAMERA,fx=2000)
    outcome=Actions(r).execute({'action':'look_around','params':{}})
    assert not outcome['success'] and len(calls)==8
    assert outcome['evidence']['view_coverage']['uncovered_degrees']>0


def test_r1_missing_camera_calibration_stops_before_turning():
    r,calls,logs=scan_runtime();r.perception.camera={}
    outcome=Actions(r).execute({'action':'look_around','params':{}})
    assert not outcome['success'] and calls==logs==[]


def test_r1_missing_raw_camera_detection_payload_is_not_a_valid_scan_view():
    r,calls,logs=scan_runtime();r.snapshot['observation'].pop('detections')
    outcome=Actions(r).execute({'action':'look_around','params':{}})
    assert not outcome['success'] and calls==logs==[]


def test_r1_exit_alignment_rejects_two_degree_unexecuted_residual():
    from test_brain_exit_alignment import exit_runtime
    r,calls,events,logs=exit_runtime(turn_residual=2)
    outcome=Actions(r).execute({'action':'explore','params':{'exit_angle':-147.2}})
    assert not outcome['success']
    assert [row['method'] for row in calls]==['turn']
    assert logs[0]['motion_verification']['reasons']==['rotation_not_verified']


def delivered_perception():
    p=Perception(CAMERA)
    for frame,forward in enumerate((0,16,32),1):observe(p,frame,forward)
    oid=p.objects()[0]['id']
    assert p.mark_picked(oid,holding=True,original_position_absent=True,simulation_time_s=1,
        evidence=grasp_evidence(p,oid,time=1))
    assert p.mark_delivered(oid,holding=False,ball_in_storage=True,simulation_time_s=2,
        evidence=placement_evidence(p,oid))
    return p,oid


def test_r3_two_nearby_detections_are_not_greedily_assigned_old_identity():
    p,oid=delivered_perception()
    observed=observe(p,5,time=3,items=[ball(60,bearing=-3),ball(60,bearing=3)])
    reds=observed['detections']
    assert not any(d.get('known_delivered_object_id')for d in reds)
    assert all(oid in d['identity_ambiguity']['candidate_ids']for d in reds)


def test_r3_single_isolated_delivered_ball_still_has_unique_identity():
    p,oid=delivered_perception()
    observed=observe(p,5,time=3,items=[ball(60)])
    assert observed['detections'][0]['known_delivered_object_id']==oid


def second_held(p):
    for frame,forward in enumerate((100,116,132),5):
        observed=observe(p,frame,forward,items=[ball(180-forward)],time=3+(frame-5)/10)
    oid=observed['detections'][0]['track_id']
    assert p.confirmed(oid)
    observe(p,8,132,items=[],time=3.3)
    assert p.mark_picked(oid,holding=True,original_position_absent=True,
        simulation_time_s=3.3,evidence=grasp_evidence(p,oid))
    return oid


def test_r3_release_intent_competes_before_first_post_release_frame():
    p,old=delivered_perception();new=second_held(p)
    anchor=copy.deepcopy(p.get_object(old)['position_m'])
    assert p.begin_release(new,anchor)
    observed=observe(p,9,items=[ball(60)],time=3.4)
    d=observed['detections'][0]
    assert 'known_delivered_object_id' not in d
    assert set(d['identity_ambiguity']['candidate_ids'])=={old,new}
    assert d['identity_ambiguity']['candidate_kinds'][new]=='release_in_progress'
    assert d['fed_to_world_model'] is True


def test_r3_active_confirmed_neighbour_competes_with_delivered_memory():
    p,old=delivered_perception()
    # A separate confirmed identity was seen beyond the delivered gate.
    for frame,forward in enumerate((0,16,32),5):
        observed=observe(p,frame,forward,right=35,items=[ball(80-forward)],time=3+frame/10)
    current=observed['detections'][0]['track_id']
    assert p.confirmed(current)
    observed=observe(p,8,right=13,items=[ball(60)],time=4)
    d=observed['detections'][0]
    assert 'known_delivered_object_id' not in d
    assert {old,current}<=set(d['identity_ambiguity']['candidate_ids'])
    assert p.confirmed(current) is None, 'Current ambiguous measurements cannot authorize pick'
    repeated=observe(p,9,right=13,items=[ball(60)],time=4.1)['detections'][0]
    assert {old,current}<=set(repeated['identity_ambiguity']['candidate_ids'])
    assert not repeated.get('known_delivered_object_id')


def test_r3_disappearing_competing_detection_does_not_prove_old_identity():
    p,old=delivered_perception()
    observe(p,5,time=3,items=[ball(60,bearing=-3),ball(60,bearing=3)])
    repeated=observe(p,6,time=3.1,items=[ball(60,bearing=3)])['detections'][0]
    assert old in repeated['identity_ambiguity']['candidate_ids']
    assert not repeated.get('known_delivered_object_id')


def test_r3_later_separated_observations_legally_resolve_identity_competition():
    p,old=delivered_perception();new=second_held(p)
    # Same frame in the overlapping .15m/.30m gates remains ambiguous.
    release_anchor={'x':.32,'z':p.get_object(old)['position_m']['z']}
    assert p.begin_release(new,release_anchor)
    observed=observe(p,9,right=10,items=[ball(60)],time=3.4)
    assert observed['detections'][0].get('identity_ambiguity')
    # Both objects are then independently seen outside the competing gates.
    # This is additional geometry, not a changed frame number or nearest tie-break.
    observed=observe(p,10,items=[ball(60),ball(60,bearing=30)],time=3.5)
    old_view,new_view=observed['detections']
    assert old_view.get('known_delivered_object_id')==old
    assert not new_view.get('known_delivered_object_id')
    assert not new_view.get('identity_ambiguity')


def test_r3_release_recovery_needs_fresh_geometric_separation_and_same_frame_old_ball():
    p,old=delivered_perception();new=second_held(p)
    anchor={'x':.32,'z':p.get_object(old)['position_m']['z']}
    preexisting=[o['id'] for o in p.objects() if o['category']=='red-ball' and o['id']!=new]
    zone={'category':'storage-zone','source':'storage-ground-pixels','confidence':1,
          'bbox':{'x':220,'y':230,'w':410,'h':100}}
    assert p.begin_release(new,anchor)
    observe(p,9,right=10,items=[ball(60),zone],time=3.4)
    release={'frame_id':'9','simulation_time_s':3.4,'preexisting_ball_ids':preexisting}
    assert p.mark_release_unverified(new,simulation_time_s=3.4,
        evidence={'holding':False,'release_observation':release,'required_delivered_ids':[old]})
    def witness_evidence(current):
        witness=next(d for d in current['detections']
                     if d['category']=='red-ball' and not d.get('known_delivered_object_id'))
        storage=next(d for d in current['detections'] if d['category']=='storage-zone')
        return {'holding':False,'candidate_witnesses':1,'release_observation':release,
                'placement':{'ball_track_id':witness.get('track_id'),'ball_category':'red-ball',
                    'ball_position_m':witness['position_m'],'ball_bbox':witness['bbox'],
                    'storage_bbox':storage['bbox'],'frame_id':current['frame_id']}}
    same=observe(p,10,right=10,items=[ball(60),zone],time=3.5)
    assert not p.recover_release(new,holding=False,simulation_time_s=3.5,
                                evidence=witness_evidence(same))['resolved']
    separated=observe(p,11,items=[ball(60),ball(60,bearing=30),zone],time=3.6)
    assert separated['detections'][0]['known_delivered_object_id']==old
    result=p.recover_release(new,holding=False,simulation_time_s=3.6,
                             evidence=witness_evidence(separated))
    assert result['resolved'] is True and p.get_object(new)['state']=='DELIVERED'
    assert p.action_evidence()[-1]['evidence']['release_observation']==release
    assert not p.unverified_releases()


def test_r1_release_then_bad_pose_keeps_unverified_lifecycle_and_evidence():
    from test_brain_delivery_identity import DeliveryRuntime
    r=DeliveryRuntime();original=r.call
    def changed_pose(method,params):
        result=original(method,params)
        if method=='release':r.forward+=1
        return result
    r.bridge.call=changed_pose
    result=Actions(r).place()
    assert result['success'] is False
    assert r.held_object_id is None
    assert r.perception.get_object(r.original_id)['state']=='RELEASED_UNVERIFIED'
    assert r.perception.unverified_releases()[0]['release_observation']['frame_id']
    assert result['evidence']['place_trajectory'][0]['motion_verification']['motion_verified'] is False
    assert [method for method,_ in r.motions]==['release']


def test_r1_release_executed_before_ack_loss_keeps_lifecycle_and_action_evidence():
    from test_brain_delivery_identity import DeliveryRuntime
    r=DeliveryRuntime();original=r.call
    def lost_ack(method,params):
        original(method,params)
        raise ConnectionError('release already executed')
    r.bridge.call=lost_ack
    with pytest.raises(ConnectionError) as caught:
        Actions(r).execute({'action':'place','params':{}})
    evidence=caught.value.action_evidence
    assert evidence['place_trajectory'][0]['outcome_unknown']
    assert evidence['holding'] is False and evidence['held_object_id'] is None
    assert r.perception.get_object(r.original_id)['state']=='RELEASED_UNVERIFIED'
    assert r.perception.unverified_releases()[0]['release_observation']['frame_id']==r.perception.last_evidence['frame_id']
    assert [method for method,_ in r.motions]==['release']
    assert r.records[0]['motion_verification']['frame_fresh']


def test_r1_held_object_drop_before_ack_loss_preserves_unverified_obligation():
    from test_brain_delivery_identity import DeliveryRuntime
    r=DeliveryRuntime();calls=[]
    def dropped(method,params):
        calls.append(method);r.holding=False
        raise ConnectionError('holding changed during command')
    r.bridge.call=dropped
    with pytest.raises(ConnectionError):Actions(r).move('turn',{'angleDeg':45,'speed':50})
    assert calls==['turn']
    assert r.perception.get_object(r.original_id)['state']=='RELEASED_UNVERIFIED'
    assert r.held_object_id is None
    assert r.records[0]['outcome_unknown']


def test_r1_grab_executed_before_ack_loss_keeps_pending_grasp_and_trajectory():
    from test_brain_pick_road_return import pick_runtime
    r,calls,logs,marks,_,target=pick_runtime();original=r.bridge.call
    r.roads=SimpleNamespace()
    def lost_ack(method,params):
        result=original(method,params)
        if method=='grab':raise ConnectionError('grab already executed')
        return result
    r.bridge.call=lost_ack
    with pytest.raises(ConnectionError) as caught:
        Actions(r).execute({'action':'pick','params':{'object_id':target['id']}})
    assert r.pending_grasp['object_id']==target['id'] and r.held_object_id is None
    assert caught.value.action_evidence['pick_trajectory'][-1]['outcome_unknown']
    assert caught.value.action_evidence['holding'] is True
    assert len([row for row in calls if row['method']=='grab'])==1 and marks==[]
