"""Synthetic public-region sensors, real motion memory and actual command contract.

No layout, evaluator, model or simulator input. Region flags are computed from
poses, not toggled to make an action pass. Geometry below is a test renderer.
"""
import copy
import math
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from autonomous_brain.navigation import RoadMemory, distance, heading_to, position, wrap
from test_brain_navigation_reposition import sensor
from test_brain_route_contract import normalize


class RegionRuntime:
    def __init__(self, *, endpoint_node=True, unknown_node=False, terminal_exits=(0,180)):
        self.snapshot=sensor(1,(0,0))
        self.round=1;self.roads=RoadMemory();self.calls=[];self.motions=[];self.observations=[]
        self.endpoint_node=endpoint_node;self.unknown_node=unknown_node;self.terminal_exits=terminal_exits
        self.partial=1.;self.heading_drift=0.;self.blocked=False
        self.target={'id':'red','category':'red-ball','state':'CONFIRMED','position_m':{'x':-.32,'z':0}}
        self.camera={}
        self.perception=SimpleNamespace(objects=lambda:[self.target],get_object=lambda _:self.target,
            confirmed=lambda _:self.target,visible=lambda _:self.camera)
        self.bridge=SimpleNamespace(seconds=0,max_seconds=1200,call=self.call)
        self.motion_log=SimpleNamespace(write=lambda row:self.motions.append(copy.deepcopy(row)))
        self.actions=Actions(self)
        self.refresh();self.register()

    def refresh(self):
        odo=self.snapshot['odometry'];p=position(odo);h=odo['headingDeg']
        # A 15 cm sensor region around the original endpoint. This is not an
        # instruction to merge map nodes or an execution endpoint tolerance.
        terminal=self.endpoint_node and math.hypot(p[0],p[1])<=.15
        unexpected=self.unknown_node and abs(p[1]-.45)<.06
        exits=self.terminal_exits if terminal else (0,90,180) if unexpected else ()
        self.snapshot['road'].update(onRoad=True,atNode=bool(exits),
            exits=[{'angleDeg':wrap(a-h)} for a in exits],
            headingErrorDeg=wrap((0 if abs(wrap(h))<90 else -180)-h),
            frontClearanceCm=.1 if self.blocked else 100,leftClearanceCm=20,rightClearanceCm=20)
        goal=(self.target['position_m']['x'],self.target['position_m']['z'])
        self.camera.update(category='red-ball',track_id='red',frame_id=self.snapshot['observation']['frameId'],
            distance_cm=distance(p,goal)*100,bearing_deg=-wrap(heading_to(p,goal)-h))
        self.snapshot['perception']['detections']=[copy.deepcopy(self.camera)]

    def register(self,motion=None):
        s=self.snapshot
        self.roads.update(s['odometry'],s['road'],s['observation_index'])
        self.roads.observe_traversal(copy.deepcopy(s),dict(motion,after_observation=s['observation_index']) if motion else None)
        self.observations.append(copy.deepcopy(s))

    def observe(self,*,motion=None):
        s=self.snapshot;s['observation_index']+=1
        s['observation']={'frameId':str(s['observation_index']),'tick':s['odometry']['tick']}
        self.refresh();self.register(motion)

    def call(self,method,params):
        params=normalize(method,params);self.calls.append((method,copy.deepcopy(params)))
        odo=self.snapshot['odometry'];odo['tick']+=1
        if method=='turn':odo['headingDeg']=wrap(odo['headingDeg']+params['angleDeg'])
        else:
            assert method in {'forward','backward','follow_road'}
            if method=='follow_road':
                # Follow the sensed road tangent in the chosen half-plane,
                # not a straight ray at a possibly oblique body heading.
                odo['headingDeg']=0 if abs(wrap(odo['headingDeg']))<90 else -180
            sign=-1 if method=='backward' else 1
            length=params['distanceCm']*self.partial;theta=math.radians(odo['headingDeg'])
            odo['rightCm']-=sign*length*math.sin(theta)
            odo['forwardCm']+=sign*length*math.cos(theta)
            odo['distanceCm']+=length;odo['headingDeg']=wrap(odo['headingDeg']+self.heading_drift)
            # Match the public odometry's 0.1 cm quantization; tiny sin(pi)
            # residue must not manufacture a new exact-position anchor.
            odo['rightCm']=round(odo['rightCm'],1);odo['forwardCm']=round(odo['forwardCm'],1)
        return {'accepted':True,'completed':True,'stoppedBy':'max_distance'}

    def history(self, *, basic=True, length=28.5):
        self.actions.move('follow_road',{'distanceCm':length,'speed':50})
        if basic:
            self.actions.move('turn',{'angleDeg':30,'speed':50})
            self.actions.move('forward',{'distanceCm':20,'speed':30})
        self.calls.clear();self.motions.clear()
        return self.roads.approach_candidates(self.snapshot['odometry'],(-.32,0))[0]


def test_oblique_basic_reverse_uses_inverse_primitive_not_road_tangent():
    r=RegionRuntime();candidate=r.history()
    candidate['path']=candidate['path'][:2];candidate['segments']=candidate['segments'][:1]
    candidate['position_m']=candidate['path'][-1]
    budget=[45]
    reached,reason,steps=r.actions._follow_approach_path(candidate,budget)
    assert reached,reason
    assert r.calls==[('backward',{'distanceCm':20,'speed':30})]
    assert distance(position(r.snapshot['odometry']),(0,.285))*100<=.2
    assert r.snapshot['odometry']['headingDeg']==30
    assert steps[-1]['completed_segment_ids']==[candidate['segments'][0]['segment_id']]
    assert budget==[44]


def test_recorded_road_reverse_finishes_expected_node_region_without_early_consumption():
    r=RegionRuntime();candidate=r.history(basic=False)
    reached,reason,steps=r.actions._follow_approach_path(candidate,[45])
    assert reached,reason
    assert [m for m,_ in r.calls]==['turn','follow_road','forward']
    assert [p['distanceCm'] for m,p in r.calls if m!='turn']==pytest.approx([20,8.5])
    assert 'completed_segment_ids' not in steps[0]
    assert r.observations[-2]['road']['atNode'] and r.observations[-2]['odometry']['forwardCm']==pytest.approx(8.5)
    assert steps[-1]['completed_segment_ids']==[candidate['segments'][0]['segment_id']]
    assert position(r.snapshot['odometry'])==pytest.approx((0,0),abs=.002)


def test_component_motion_record_reverse_candidate_region_then_fresh_visual_standoff():
    r=RegionRuntime();candidate=r.history();before=r.snapshot['observation_index']
    assert candidate['segments'][0]['method']=='forward'
    assert candidate['segments'][0]['direction']=='reverse_attempt'
    assert candidate['segments'][1]['method']=='follow_road'
    result=r.actions._road_reposition('red',r.actions.result(False,'requires_reposition'),[45])
    assert result['success'],result
    attempt=result['evidence']['road_reposition']['attempts'][0]
    assert attempt['reached'] and len(result['evidence']['road_reposition']['attempts'])==1
    assert [m for m,_ in r.calls if m!='turn']==['backward','follow_road','forward']
    assert sum(p['distanceCm'] for m,p in r.calls if m!='turn')==pytest.approx(48.5)
    assert attempt['approach_observation']>attempt['steps'][-1]['after_observation']>before
    assert result['evidence']['detection']['distance_cm']==pytest.approx(32)
    assert result['evidence']['road_reposition']['status']=='reposition_and_visual_standoff_verified'
    assert all(m['motion_verification']['motion_verified'] for m in r.motions
               if m['motion_verification']['applicable'])


def test_unknown_node_inside_road_segment_stops_without_picking_an_exit():
    r=RegionRuntime(endpoint_node=False);candidate=r.history(basic=False,length=60)
    r.unknown_node=True
    reached,reason,steps=r.actions._follow_approach_path(candidate,[45])
    assert not reached and reason=='reposition_unrecorded_junction_inside_segment'
    assert [m for m,_ in r.calls]==['turn','follow_road']
    assert all(not s.get('completed_segment_ids') for s in steps)


def real_perception_component():
    from autonomous_brain import run
    from autonomous_brain.perception import Perception
    from autonomous_brain.task import parse_task
    from test_brain_confirmation_sampling import SensorBridge
    from test_brain_perception import CAMERA

    class Bridge(SensorBridge):
        def __init__(self):
            super().__init__(target=(-32,0))
            self.x=48.;self.heading=90.
        def call(self,method,params=None):
            if method=='local_road':
                at_node=math.hypot(self.x,self.z)<=15
                tangent=90 if self.x>15 and abs(self.z)<.2 else 0
                tangent=min((tangent,wrap(tangent+180)),key=lambda h:abs(wrap(h-self.heading)))
                return {'tick':self.tick,'onRoad':True,'atNode':at_node,'atJunction':at_node,
                    'exits':[{'angleDeg':wrap(h-self.heading)} for h in (0,90,180)] if at_node else [],
                    'headingErrorDeg':wrap(tangent-self.heading),'frontClearanceCm':100,
                    'leftClearanceCm':20,'rightClearanceCm':20}
            if method=='follow_road':
                self.heading=0 if abs(wrap(self.heading))<90 else -180
            return super().call(method,params)

    r=run.Runtime.__new__(run.Runtime)
    r.config={'task':'把两个红球送到绿色存放区'};r.task_spec=parse_task(r.config['task'])
    r.round=1;r.observation_count=0;r.recent=[];r.held_object_id=r.pending_grasp=None
    r.perception=Perception(CAMERA);r.roads=RoadMemory();r.bridge=Bridge()
    r.trace=[];r.motions=[]
    r.observation_log=SimpleNamespace(write=lambda row:r.trace.append(copy.deepcopy(row)))
    r.motion_log=SimpleNamespace(write=lambda row:r.motions.append(copy.deepcopy(row)))
    r.actions=Actions(r);r.observe()
    for _ in range(2):r.actions.move('forward',{'distanceCm':16,'speed':30})
    target=r.perception.objects()[0]
    assert target['state']=='CONFIRMED' and target['hit_count']==3
    r.actions.move('forward',{'distanceCm':16,'speed':30})
    r.actions.move('turn',{'angleDeg':-90,'speed':50})
    r.actions.move('follow_road',{'distanceCm':28.5,'speed':50})
    r.actions.move('turn',{'angleDeg':30,'speed':50})
    r.actions.move('forward',{'distanceCm':20,'speed':30})
    before=r.snapshot['observation_index'];call_start=len(r.bridge.calls)
    candidates=r.roads.approach_candidates(r.snapshot['odometry'],
        (target['position_m']['x'],target['position_m']['z']))
    budget=[45]
    result=r.actions._road_reposition(target['id'],r.actions.result(False,'requires_reposition'),budget)
    return r,{'before_observation':before,'candidate_list':candidates,'call_start':call_start,
              'result':result,'remaining_budget':budget[0],'confirmed_id':target['id']}


def test_real_perception_complete_component_uses_inverse_then_region_then_visual_gate():
    r,diagnostic=real_perception_component();result=diagnostic['result']
    assert result['success'],result
    calls=r.bridge.calls[diagnostic['call_start']:]
    assert [m for m,_ in calls if m!='turn']==['backward','follow_road','forward']
    attempt=result['evidence']['road_reposition']['attempts'][0]
    assert attempt['reached'] and attempt['approach_observation']>attempt['steps'][-1]['after_observation']
    assert result['evidence']['detection']['track_id']==diagnostic['confirmed_id']
    assert 25<=result['evidence']['detection']['distance_cm']<=40
    assert abs(result['evidence']['detection']['bearing_deg'])<=5
    obj=r.perception.get_object(diagnostic['confirmed_id'])
    assert obj['hit_count']==3 and obj['state']=='CONFIRMED'
    assert len({p['frame_id'] for p in obj['hit_poses']})==3
    assert not r.bridge.calls[diagnostic['call_start']:]==[]


def test_backward_record_generates_forward_inverse_with_preserved_body_heading():
    r=RegionRuntime(endpoint_node=False)
    r.actions.move('turn',{'angleDeg':30,'speed':50})
    r.actions.move('backward',{'distanceCm':20,'speed':30});r.calls.clear()
    candidate=r.roads.approach_candidates(r.snapshot['odometry'],(-.32,0))[0]
    reached,reason,steps=r.actions._follow_approach_path(candidate,[45])
    assert reached,reason
    assert r.calls==[('forward',{'distanceCm':20,'speed':30})]
    assert r.snapshot['odometry']['headingDeg']==30
    assert distance(position(r.snapshot['odometry']),(0,0))*100<=.2


@pytest.mark.parametrize('fault',['partial','heading','blocked','body_subminimum_turn','start_jump'])
def test_basic_inverse_refuses_unverified_or_unsupported_execution(fault):
    r=RegionRuntime();candidate=r.history()
    candidate['path']=candidate['path'][:2];candidate['segments']=candidate['segments'][:1]
    candidate['position_m']=candidate['path'][-1]
    if fault=='partial':r.partial=.5
    if fault=='heading':r.heading_drift=.3
    if fault=='blocked':
        r.snapshot['road'].update(leftClearanceCm=.1,rightClearanceCm=.1)
    if fault=='body_subminimum_turn':r.snapshot['odometry']['headingDeg']+=.5
    if fault=='start_jump':r.snapshot['odometry']['rightCm']+=1
    if fault in {'partial','heading'}:
        with pytest.raises(ObservedMotionFailure):r.actions._follow_approach_path(candidate,[45])
        assert len(r.calls)==1
    else:
        reached,reason,steps=r.actions._follow_approach_path(candidate,[45])
        assert not reached and reason=='reposition_basic_primitive_not_safe_or_aligned'
        assert r.calls==[] and not steps


@pytest.mark.parametrize('fault',['different_exits','blocked_tail','budget','unknown_terminal'])
def test_expected_region_connection_needs_full_context_and_budget(fault):
    r=RegionRuntime();candidate=r.history(basic=False)
    original=r.call
    def altered(method,params):
        response=original(method,params)
        if method=='follow_road':
            if fault=='different_exits':r.terminal_exits=(0,90,180)
            if fault=='blocked_tail':r.blocked=True
            if fault=='unknown_terminal':candidate['segments'][0]['arrival']['at_node']=False
        return response
    r.bridge.call=altered
    reached,reason,steps=r.actions._follow_approach_path(candidate,[1 if fault=='budget' else 45])
    assert not reached
    assert [m for m,_ in r.calls]==['turn','follow_road']
    assert all(not s.get('completed_segment_ids') for s in steps)
    assert reason==('reposition_motion_budget_exhausted' if fault=='budget' else
        'reposition_terminal_connection_not_safe' if fault=='blocked_tail' else
        'reposition_unrecorded_junction_inside_segment')


def test_candidate_endpoint_cannot_hide_an_unexpected_node_flag():
    r=RegionRuntime(endpoint_node=False);candidate=r.history(basic=False,length=20)
    original=r.call
    def unexpected(method,params):
        response=original(method,params)
        if method=='follow_road':r.endpoint_node=True
        return response
    r.bridge.call=unexpected
    reached,reason,steps=r.actions._follow_approach_path(candidate,[45])
    assert not reached and reason=='reposition_arrival_node_context_changed'
    assert all(not s.get('completed_segment_ids') for s in steps)


def test_zero_budget_never_moves_even_for_executable_basic_inverse():
    r=RegionRuntime();candidate=r.history()
    reached,reason,steps=r.actions._follow_approach_path(candidate,[0])
    assert not reached and reason=='reposition_motion_budget_exhausted'
    assert r.calls==[] and steps==[]


def test_basic_heading_restore_is_logged_and_budgeted_before_translation():
    r=RegionRuntime();candidate=r.history()
    candidate['path']=candidate['path'][:2];candidate['segments']=candidate['segments'][:1]
    candidate['position_m']=candidate['path'][-1]
    r.actions.move('turn',{'angleDeg':30,'speed':50});r.calls.clear()
    budget=[1]
    reached,reason,steps=r.actions._follow_approach_path(candidate,budget)
    assert not reached and reason=='reposition_motion_budget_exhausted'
    assert r.calls==[('turn',{'angleDeg':-30,'speed':50})]
    assert budget==[0] and steps[0]['kind']=='recorded_basic_body_alignment'
    assert all(not s.get('completed_segment_ids') for s in steps)


def test_basic_inverse_needs_completed_receipt_as_well_as_actual_displacement():
    r=RegionRuntime();candidate=r.history()
    candidate['path']=candidate['path'][:2];candidate['segments']=candidate['segments'][:1]
    candidate['position_m']=candidate['path'][-1]
    original=r.call
    def declined(method,params):
        receipt=original(method,params);receipt['completed']=False
        return receipt
    r.bridge.call=declined
    reached,reason,steps=r.actions._follow_approach_path(candidate,[45])
    assert not reached and reason=='reposition_motion_not_verified'
    assert len(r.calls)==1 and all(not s.get('completed_segment_ids') for s in steps)


def test_region_flag_cannot_authorize_short_straight_cut_across_a_recorded_curve():
    r=RegionRuntime();candidate=r.history(basic=False)
    candidate['segments'][0]['travelled_cm']+=1  # More arc than the chord.
    reached,reason,steps=r.actions._follow_approach_path(candidate,[45])
    assert not reached and reason=='reposition_unrecorded_junction_inside_segment'
    assert [m for m,_ in r.calls]==['turn','follow_road']
    assert all(not s.get('completed_segment_ids') for s in steps)


def test_known_distinct_same_profile_node_is_not_reinterpreted_as_terminal_region():
    r=RegionRuntime();r.history(basic=False)
    # Public earlier visit establishes a second stopping node. Returning to its
    # exact anchor later must respect that existing identity, even with the same
    # exits as the candidate terminal. No private node IDs are injected.
    r.actions.move('backward',{'distanceCm':20,'speed':30})
    near=r.roads.observation_anchor(r.snapshot['observation_index'])
    r.actions.move('forward',{'distanceCm':20,'speed':30})
    candidate=r.roads.approach_candidates(r.snapshot['odometry'],(-.32,0))[0]
    assert candidate['position_m']==[0,0]
    terminal=r.roads.observation_anchor(candidate['segments'][-1]['arrival']['observation_index'])
    assert near['node_id']!=terminal['node_id']
    r.calls.clear()
    reached,reason,steps=r.actions._follow_approach_path(candidate,[45])
    assert not reached and reason=='reposition_unrecorded_junction_inside_segment'
    assert [m for m,_ in r.calls]==['turn','follow_road']
    assert all(not s.get('completed_segment_ids') for s in steps)


def test_basic_body_alignment_then_translation_has_separate_fresh_motion_refs():
    r=RegionRuntime();candidate=r.history()
    r.actions.move('turn',{'angleDeg':30,'speed':50});r.calls.clear()
    reached,reason,steps=r.actions._follow_approach_path(candidate,[45])
    assert reached,reason
    assert [m for m,_ in r.calls][:2]==['turn','backward']
    assert steps[0]['kind']=='recorded_basic_body_alignment'
    assert steps[1]['before_observation']==steps[0]['after_observation']
    assert steps[1]['execution_plan']['body_heading_deg']==30
    assert steps[1]['after_observation']>steps[1]['before_observation']


def test_region_with_different_entry_direction_cannot_turn_into_recorded_connection():
    r=RegionRuntime();candidate=r.history(basic=False);r.heading_drift=20
    reached,reason,steps=r.actions._follow_approach_path(candidate,[45])
    assert not reached and reason=='reposition_unrecorded_junction_inside_segment'
    assert [m for m,_ in r.calls]==['turn','follow_road']
    assert all(not s.get('completed_segment_ids') for s in steps)


def test_known_unexecutable_alignment_filters_before_cap_and_recomputes_for_new_heading():
    r=RegionRuntime();r.history()
    odo=copy.deepcopy(r.snapshot['odometry']);odo['headingDeg']+=.5
    assert r.roads.approach_candidates(odo,(-.32,0))==[]
    diagnostic=r.roads.approach_candidate_diagnostics()
    assert diagnostic['generated_count']>=1 and diagnostic['returned_count']==0
    assert {x['reason'] for x in diagnostic['filtered_candidates']}=={'basic_alignment_below_legal_turn_minimum'}
    # Same observed route becomes executable when the actual heading supports a
    # legal >=1 degree restoration. No location or frame-based reset is used.
    r.actions.move('turn',{'angleDeg':1,'speed':50})
    assert r.roads.approach_candidates(r.snapshot['odometry'],(-.32,0))
    assert r.roads.approach_candidate_diagnostics()['returned_count']<=3
