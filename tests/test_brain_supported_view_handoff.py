"""Actual public r48 view; isolated mutations/feedback, no platform execution."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from autonomous_brain.navigation import RoadMemory
from autonomous_brain.perception import Perception, PUBLIC_TO_WM
from world_model.aliases import AliasTable
from world_model.providers.guangyang import guangyang_static_association_config

FIXTURE=json.loads((Path(__file__).parent/'fixtures/run_20261018T144948Z_supported_turn_view_public.json').read_text())
OBJECT='target_010'


class PublicPerception(Perception):
    """Original identity gates over the public WM/object snapshot, no grants."""
    def __init__(self, frame):
        self.snapshot=frame
        self.camera=copy.deepcopy(FIXTURE['camera_parameters'])
        self.last_evidence=copy.deepcopy(frame['perception'])
        self._last_timestamp=frame['simulation_seconds']
        self._last_frame=frame['perception']['frame_id']
        self._history={o['id']:copy.deepcopy(o) for o in frame['objects']}
        self._delivery_aliases={}
        tracks={o['id']:SimpleNamespace(obj_id=o['id'],name=PUBLIC_TO_WM[o['category']],
            x=o['position_m']['x'],z=o['position_m']['z'],last_seen=o.get('last_seen_s',0))
            for o in frame['objects']}
        self.wm=SimpleNamespace(get_object=lambda oid,include_lost=False:tracks.get(oid),
            get_scene=lambda:list(tracks.values()),aliases=AliasTable(),
            assoc_cfg=guangyang_static_association_config(),decay_cfg=SimpleNamespace(confirm_hits=3))
        self._discovery_observation_index=frame['observation_index']
        self._observed_frames={str(i):{'index':i-1}for i in range(1,frame['observation_index']+1)}
        self._discovery_motion_windows=copy.deepcopy(frame['discovery_evidence']['motion_boundaries'])
        self._action_evidence=[]
        self._grab_authorizations={}
    def _discovery_canonical(self, oid):return oid
    def objects(self):return copy.deepcopy(list(self._history.values()))
    def get_object(self, oid):return copy.deepcopy(self._history.get(oid))
    def discovery_evidence(self):return copy.deepcopy(self.snapshot['discovery_evidence'])
    def authorize_grab(self,*args,**kwargs):raise AssertionError('handoff cannot authorize grab')


def current_runtime(index=235):
    frame=copy.deepcopy(FIXTURE['frames'][str(index)])
    roads=RoadMemory()
    roads.update(frame['odometry'],frame['road'],frame['observation_index'])
    roads.observe_traversal(frame)
    runtime=SimpleNamespace(snapshot=frame,perception=PublicPerception(frame),roads=roads,
        round=48,held_object_id=None,pending_grasp=None,task_spec={'target_category':'red-ball'})
    actions=Actions(runtime)
    actions._pick_probe_limits={OBJECT:copy.deepcopy(FIXTURE['retry_bound'])}
    actions._historical_views={OBJECT:{'attempted':['existing-A'],'preserved':True}}
    runtime.actions=actions
    return runtime,actions


def sync_public_frame(frame):
    """Only make a synthetic current-frame control internally consistent."""
    evidence=frame['perception']
    evidence.update(frame_id=str(frame['observation']['frameId']),tick=frame['odometry']['tick'],
        simulation_time_s=frame['simulation_seconds'],odometry=copy.deepcopy(frame['odometry']),
        raw_observation=copy.deepcopy(frame['observation']))


def fresh_same_view(frame):
    result=copy.deepcopy(frame)
    result['observation_index']+=1
    result['simulation_seconds']+=.02
    result['odometry']['tick']+=1
    result['road']['tick']=result['odometry']['tick']
    result['observation'].update(frameId=result['observation_index'],tick=result['odometry']['tick'])
    for detected in result['perception']['detections']:
        detected['frame_id']=str(result['observation_index'])
        if isinstance(detected.get('pixel_quality'),dict):
            detected['pixel_quality']['frameId']=result['observation_index']
    sync_public_frame(result)
    return result


def dispatch_runtime(*,initial=234,unknown=False,turn_fault=None,final_fault=None):
    runtime,actions=current_runtime(initial)
    calls,motions,observations=[],[],[]
    runtime.bridge=SimpleNamespace(seconds=runtime.snapshot['simulation_seconds'],max_seconds=1200,sequence=1076)
    runtime.motion_log=SimpleNamespace(write=lambda row:motions.append(copy.deepcopy(row)))
    error=TimeoutError('synthetic turn receipt unknown')
    def call(method,params):
        calls.append((method,copy.deepcopy(params)))
        runtime.bridge.sequence+=1
        if unknown and method=='turn':raise error
        assert method in {'turn','take_exit'}
        source=next(m for m in FIXTURE['motions']if m['method']==method)
        return copy.deepcopy(source['actuator_result'])
    def observe(*,motion=None):
        observations.append(copy.deepcopy(motion))
        if motion:
            index=235 if motion['method']=='turn' else 236
            frame=copy.deepcopy(FIXTURE['frames'][str(index)])
            if motion['method']=='turn' and turn_fault:
                turn_fault(frame)
        else:
            frame=fresh_same_view(runtime.snapshot)
            if final_fault:final_fault(frame)
        runtime.snapshot=frame
        runtime.perception=PublicPerception(frame)
        runtime.bridge.seconds=frame['simulation_seconds']
        runtime.roads.update(frame['odometry'],frame['road'],frame['observation_index'])
        runtime.roads.observe_traversal(frame,dict(motion,after_observation=frame['observation_index'])if motion else None)
        return frame
    runtime.bridge.call,runtime.observe=call,observe
    return runtime,actions,calls,motions,observations,error


def assert_no_grant_or_history_reset(runtime,actions,bound,history):
    assert actions._pick_probe_limits==bound
    assert actions._historical_views==history
    assert actions.grab_attempts=={}
    assert runtime.perception._grab_authorizations=={}
    assert runtime.pending_grasp is None and runtime.held_object_id is None


def test_actual_turn_view_keeps_original_identity_probe_gates_without_pick_readiness():
    runtime,actions=current_runtime()
    assert runtime.perception.check_grasp_identity(OBJECT,runtime.snapshot)['authorized']
    assert actions.pick_probe_view_status(OBJECT)['independent_supported_view']
    assert not actions.current_pick_ready(OBJECT)
    assert actions._sampling_opportunity(FIXTURE['frames']['234']) is None
    bound,history=copy.deepcopy(actions._pick_probe_limits),copy.deepcopy(actions._historical_views)
    rows=actions._supported_pick_view_opportunities()
    assert len(rows)==1 and rows[0]['object_id']==OBJECT
    assert rows[0]['observation_index']==235 and rows[0]['requires_fresh_authorization'] is True
    assert rows[0]['pick_probe_view']['blocked'] is False
    assert_no_grant_or_history_reset(runtime,actions,bound,history)


@pytest.mark.parametrize('index',[234,236])
def test_actual_absent_pixels_before_and_after_passage_do_not_yield(index):
    _,actions=current_runtime(index)
    assert actions._supported_pick_view_opportunities()==[]


@pytest.mark.parametrize('fault',[
    'wrong_task','missing_task','nonball_task','no_budget','budget_not_required','bound_not_dict',
    'missing_anchor','same_anchor','same_return','same_budget_return','holding','unknown_holding',
    'held_object','pending','offroad','road_tick','sensor_tick','unknown_tick','unknown_heading',
    'target_lost','target_tentative','target_delivered','target_alias','target_wrong_category',
    'missing_target','unknown_pixels','stale_detection','duplicate_target','identity_ambiguity',
    'unpositioned_competitor','perception_not_current',
])
def test_supported_view_handoff_retains_task_budget_pixels_identity_and_current_safety(fault):
    runtime,actions=current_runtime()
    frame=runtime.snapshot
    if fault=='wrong_task':runtime.task_spec={'target_category':'blue-ball'}
    elif fault=='missing_task':runtime.task_spec={}
    elif fault=='nonball_task':runtime.task_spec={'target_category':'storage-zone'}
    elif fault=='no_budget':actions._pick_probe_limits={}
    elif fault=='budget_not_required':actions._pick_probe_limits[OBJECT]['requires_new_view']=False
    elif fault=='bound_not_dict':actions._pick_probe_limits[OBJECT]=None
    elif fault=='missing_anchor':del actions._pick_probe_limits[OBJECT]['anchor_odometry']
    elif fault in {'same_anchor','same_return','same_budget_return'}:
        key={'same_anchor':'anchor_odometry','same_return':'observed_return_odometry','same_budget_return':'budget_return_odometry'}[fault]
        actions._pick_probe_limits[OBJECT][key]=copy.deepcopy(frame['odometry'])
    elif fault=='holding':frame['holding']['holding']=True
    elif fault=='unknown_holding':frame['holding']['holding']=None
    elif fault=='held_object':runtime.held_object_id='other'
    elif fault=='pending':runtime.pending_grasp={'object_id':OBJECT}
    elif fault=='offroad':frame['road']['onRoad']=False
    elif fault=='road_tick':frame['road']['tick']+=1
    elif fault=='sensor_tick':frame['observation']['tick']+=1
    elif fault=='unknown_tick':frame['odometry']['tick']=None
    elif fault=='unknown_heading':frame['odometry']['headingDeg']=float('nan')
    elif fault.startswith('target_'):
        target=next(o for o in frame['objects']if o['id']==OBJECT)
        if fault=='target_alias':target['alias_of']='other'
        elif fault=='target_wrong_category':target['category']='blue-ball'
        else:target['state']=fault.removeprefix('target_').upper()
    elif fault=='missing_target':frame['objects']=[o for o in frame['objects']if o['id']!=OBJECT]
    elif fault=='unknown_pixels':frame['perception']['detections'][0]['pixel_quality']['status']='unknown'
    elif fault=='stale_detection':frame['perception']['detections'][0]['frame_id']='234'
    elif fault=='duplicate_target':frame['perception']['detections'].append(copy.deepcopy(frame['perception']['detections'][0]))
    elif fault=='identity_ambiguity':frame['perception']['detections'][0]['identity_ambiguity']=True
    elif fault=='unpositioned_competitor':
        competitor=copy.deepcopy(frame['perception']['detections'][0]);competitor.pop('position_m');competitor['track_id']=None
        frame['perception']['detections'].append(competitor)
    elif fault=='perception_not_current':frame['perception']['simulation_time_s']-=1
    runtime.perception=PublicPerception(frame)
    bound,history=copy.deepcopy(actions._pick_probe_limits),copy.deepcopy(actions._historical_views)
    assert actions._supported_pick_view_opportunities()==[]
    assert actions._pick_probe_limits==bound and actions._historical_views==history
    assert not runtime.perception._grab_authorizations


def test_actual_explore_turn_returns_control_before_take_exit_without_pick_or_history_reset():
    runtime,actions,calls,motions,observations,_=dispatch_runtime()
    bound,history=copy.deepcopy(actions._pick_probe_limits),copy.deepcopy(actions._historical_views)
    result=actions.explore(52.1)
    assert result['success'] and result['reason']=='pick_view_opportunity_observed'
    assert [method for method,_ in calls]==['turn']
    assert len(motions)==len(observations)==1
    assert motions[0]['motion_verification']['motion_verified']
    assert result['evidence']['pick_view_opportunity']['before_observation']==234
    assert_no_grant_or_history_reset(runtime,actions,bound,history)


def test_non_explore_exit_keeps_original_take_exit_behavior():
    _,actions,calls,_,_,_=dispatch_runtime()
    result=actions.take_observed_exit(52.1)
    assert 'pick_view_opportunity' not in result
    assert [method for method,_ in calls]==['turn','take_exit']


def test_view_already_available_before_selection_is_not_a_new_handoff():
    _,actions,calls,_,_,_=dispatch_runtime(initial=235)
    result=actions.take_observed_exit(0,yield_for_discovery=True)
    assert 'pick_view_opportunity' not in result
    assert [method for method,_ in calls]==['take_exit']


def test_execute_rechecks_fresh_same_pose_and_identity_without_caching_pick_permission():
    runtime,actions,calls,_,observations,_=dispatch_runtime()
    bound,history=copy.deepcopy(actions._pick_probe_limits),copy.deepcopy(actions._historical_views)
    result=actions.execute({'action':'explore','params':{'exit_angle':52.1}})
    assert result['success'] and result['reason']=='pick_view_opportunity_observed'
    proof=result['evidence']['pick_view_opportunity']
    assert proof['post_observation_retained'] and proof['post_observation']==236
    assert proof['post_observation_view']['observation_index']==236
    assert [method for method,_ in calls]==['turn'] and observations[-1] is None
    assert_no_grant_or_history_reset(runtime,actions,bound,history)


@pytest.mark.parametrize('fault',['pixels','holding','offroad','heading','position','old_frame','old_index','tick','identity'])
def test_final_changed_view_is_reported_without_departure_or_pick(fault):
    def change(frame):
        if fault=='pixels':frame['perception']['detections']=[]
        elif fault=='holding':frame['holding']['holding']=True
        elif fault=='offroad':frame['road']['onRoad']=False
        elif fault=='heading':frame['odometry']['headingDeg']+=.1;sync_public_frame(frame)
        elif fault=='position':frame['odometry']['rightCm']+=.1;sync_public_frame(frame)
        elif fault=='old_frame':frame['observation']['frameId']=235;sync_public_frame(frame)
        elif fault=='old_index':frame['observation_index']=235
        elif fault=='tick':frame['road']['tick']+=1
        elif fault=='identity':frame['perception']['detections'].append(copy.deepcopy(frame['perception']['detections'][0]))
    _,actions,calls,_,_,_=dispatch_runtime(final_fault=change)
    bound,history=copy.deepcopy(actions._pick_probe_limits),copy.deepcopy(actions._historical_views)
    result=actions.execute({'action':'explore','params':{'exit_angle':52.1}})
    assert not result['success'] and result['reason']=='pick_view_opportunity_no_longer_supported'
    assert not result['evidence']['pick_view_opportunity']['post_observation_retained']
    assert [method for method,_ in calls]==['turn']
    assert actions._pick_probe_limits==bound and actions._historical_views==history


def test_unknown_turn_is_single_send_and_one_read_only_recovery_without_handoff():
    runtime,actions,calls,motions,observations,error=dispatch_runtime(unknown=True)
    bound=copy.deepcopy(actions._pick_probe_limits)
    with pytest.raises(TimeoutError)as caught:
        actions.execute({'action':'explore','params':{'exit_angle':52.1}})
    assert caught.value is error
    assert [method for method,_ in calls]==['turn'] and observations==[None]
    assert len(motions)==1 and motions[0]['outcome_unknown'] is True
    assert error.action_evidence['outcome_unknown'] is True
    assert error.action_evidence['uncertain_motion']['method']=='turn'
    assert actions._pick_probe_limits==bound and not runtime.perception._grab_authorizations


@pytest.mark.parametrize('fault',['old_frame','drift','holding'])
def test_unverified_turn_cannot_yield_supported_view(fault):
    def change(frame):
        if fault=='old_frame':frame['observation']['frameId']=234
        elif fault=='drift':frame['odometry']['rightCm']+=1
        elif fault=='holding':frame['holding']['holding']=True
    _,actions,calls,motions,_,_=dispatch_runtime(turn_fault=change)
    with pytest.raises(ObservedMotionFailure):
        actions.take_observed_exit(52.1,yield_for_discovery=True)
    assert [method for method,_ in calls]==['turn'] and len(motions)==1


def test_same_tick_turn_cannot_create_a_new_supported_view_handoff():
    def change(frame):
        tick=FIXTURE['frames']['234']['odometry']['tick']
        frame['odometry']['tick']=frame['road']['tick']=frame['observation']['tick']=tick
        sync_public_frame(frame)
    _,actions,calls,_,_,_=dispatch_runtime(turn_fault=change)
    result=actions.take_observed_exit(52.1,yield_for_discovery=True)
    assert 'pick_view_opportunity' not in result
    assert [method for method,_ in calls]==['turn','take_exit']


def test_actual_turn_selection_yields_before_original_take_exit_dispatch():
    _,actions,calls,motions,_,_=dispatch_runtime()
    result=actions.take_observed_exit(52.1,yield_for_discovery=True)
    assert result.get('pick_view_opportunity',{}).get('object_id')==OBJECT
    assert [method for method,_ in calls]==['turn'] and len(motions)==1


def test_new_read_only_frame_may_retain_view_at_same_tick_without_new_motion():
    def change(frame):
        tick=FIXTURE['frames']['235']['odometry']['tick']
        frame['odometry']['tick']=frame['road']['tick']=frame['observation']['tick']=tick
        sync_public_frame(frame)
    _,actions,calls,_,_,_=dispatch_runtime(final_fault=change)
    result=actions.execute({'action':'explore','params':{'exit_angle':52.1}})
    assert result['success'] and result['evidence']['pick_view_opportunity']['post_observation_retained']
    assert [method for method,_ in calls]==['turn']


def test_read_only_post_frame_with_regressed_tick_cannot_retain_view():
    def change(frame):
        tick=FIXTURE['frames']['235']['odometry']['tick']-1
        frame['odometry']['tick']=frame['road']['tick']=frame['observation']['tick']=tick
        sync_public_frame(frame)
    _,actions,calls,_,_,_=dispatch_runtime(final_fault=change)
    result=actions.execute({'action':'explore','params':{'exit_angle':52.1}})
    assert not result['success'] and result['reason']=='pick_view_opportunity_no_longer_supported'
    assert not result['evidence']['pick_view_opportunity']['post_observation_retained']
    assert [method for method,_ in calls]==['turn']


def test_existing_sampling_opportunity_keeps_precedence_over_new_pick_view_handoff():
    _,actions,calls,_,_,_=dispatch_runtime()
    original=actions._sampling_opportunity
    marker={'discovery_id':'synthetic-existing-sampling-path','object_id':OBJECT}
    checked=[]
    def prior_sampling(before):
        # Only the already-existing sampling branch is controlled here; the
        # original current identity/probe predicates remain active.
        assert actions._supported_pick_view_opportunities()
        checked.append(before['observation_index'])
        assert original(before) is None
        return copy.deepcopy(marker)
    actions._sampling_opportunity=prior_sampling
    result=actions.take_observed_exit(52.1,yield_for_discovery=True)
    assert result=={'sampling_opportunity':marker} and checked==[234]
    assert [method for method,_ in calls]==['turn']


def test_nonadvancing_observation_index_cannot_create_new_handoff():
    def change(frame):frame['observation_index']=234
    _,actions,calls,_,_,_=dispatch_runtime(turn_fault=change)
    with pytest.raises(ObservedMotionFailure):
        actions.take_observed_exit(52.1,yield_for_discovery=True)
    assert [method for method,_ in calls]==['turn']


def test_existing_model_context_exposes_target_and_supported_view_without_pick_authority():
    from autonomous_brain.run import compact_action_result
    runtime,actions,calls,_,_,_=dispatch_runtime()
    actions._navigation_record(OBJECT)
    result=actions.execute({'action':'explore','params':{'exit_angle':52.1}})
    compact=compact_action_result(48,{'action':'explore','params':{'exit_angle':52.1}},
                                  result,runtime.snapshot['observation_index'])
    assert compact['reason']=='pick_view_opportunity_observed'
    assert compact['evidence']['object_id']==OBJECT
    assert compact['evidence']['final_observation']==236
    current=next(row for row in actions.navigation_state()if OBJECT in row['identity_ids'])['current_subgoal']
    assert current['object_id']==OBJECT and current['identity_ready'] is True
    assert current['pick_probe_view']['requires_new_view'] is True
    assert current['pick_probe_view']['independent_supported_view'] is True
    assert current['pick_probe_view']['blocked'] is False
    assert current['current_pick_ready'] is False and current['operation_ready'] is False
    assert [method for method,_ in calls]==['turn']
    assert actions._pick_probe_limits[OBJECT]==FIXTURE['retry_bound']
    assert not runtime.perception._grab_authorizations
