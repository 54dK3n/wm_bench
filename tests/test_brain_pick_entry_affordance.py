"""Current public approach entry; component fixtures, never platform success."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.navigation import RoadMemory
from autonomous_brain.perception import Perception, PUBLIC_TO_WM
from world_model.aliases import AliasTable
from world_model.providers.guangyang import guangyang_static_association_config

FIXTURE=json.loads((Path(__file__).parent/'fixtures/run_20261018T164639Z_pick_entry_public.json').read_text())
OBJECT='target_018'


class PublicPerception(Perception):
    """Run the original identity gate against actual public frame contents."""
    def __init__(self,frame):
        self.snapshot=frame
        self.camera=copy.deepcopy(FIXTURE['camera_parameters'])
        self.last_evidence=copy.deepcopy(frame['perception'])
        self._last_timestamp=frame['simulation_seconds']
        self._last_frame=frame['perception']['frame_id']
        self._history={o['id']:copy.deepcopy(o)for o in frame['objects']}
        self._delivery_aliases={}
        tracks={o['id']:SimpleNamespace(obj_id=o['id'],name=PUBLIC_TO_WM[o['category']],
            x=(o.get('position_m')or{}).get('x'),z=(o.get('position_m')or{}).get('z'),
            last_seen=o.get('last_seen_s',0))for o in frame['objects']}
        self.wm=SimpleNamespace(get_object=lambda oid,include_lost=False:tracks.get(oid),
            get_scene=lambda:list(tracks.values()),aliases=AliasTable(),
            assoc_cfg=guangyang_static_association_config(),decay_cfg=SimpleNamespace(confirm_hits=3))
        self._discovery_observation_index=frame['observation_index']
        self._observed_frames={str(i):{'index':i-1}for i in range(1,frame['observation_index']+1)}
        self._discovery_motion_windows=copy.deepcopy(frame['discovery_evidence']['motion_boundaries'])
        self._action_evidence=[]
        self._grab_authorizations={}
    def _discovery_canonical(self,oid):return oid
    def objects(self):return copy.deepcopy(list(self._history.values()))
    def get_object(self,oid):return copy.deepcopy(self._history.get(oid))
    def discovery_evidence(self):return copy.deepcopy(self.snapshot['discovery_evidence'])
    def authorize_grab(self,*args,**kwargs):raise AssertionError('entry metadata cannot authorize grab')


def runtime_at(index=130):
    frame=copy.deepcopy(FIXTURE['frames'][str(index)])
    roads=RoadMemory()
    roads.update(frame['odometry'],frame['road'],frame['observation_index'])
    roads.observe_traversal(frame)
    calls=[]
    def forbidden_call(method,params):
        calls.append((method,params))
        raise AssertionError('entry metadata cannot dispatch an action')
    runtime=SimpleNamespace(snapshot=frame,perception=PublicPerception(frame),roads=roads,
        round=23,held_object_id=None,pending_grasp=None,task_spec={'target_category':'red-ball'},
        bridge=SimpleNamespace(call=forbidden_call,seconds=frame['simulation_seconds'],max_seconds=1200,sequence=0))
    actions=Actions(runtime)
    actions._pick_probe_limits={OBJECT:copy.deepcopy(FIXTURE['bound'])}
    actions._historical_views={OBJECT:{'attempted':['existing-A'],'preserved':True}}
    actions._empty_grab_navigation={OBJECT:[{'prior_failed_probe':'preserve'}]}
    runtime.actions=actions
    return runtime,actions,calls


def state(actions):
    return copy.deepcopy({'probe_limits':actions._pick_probe_limits,
        'historical_views':actions._historical_views,
        'empty_grab_navigation':actions._empty_grab_navigation,
        'grab_attempts':actions.grab_attempts,
        'blocked':actions.r.roads.blocked})


def refresh_perception(runtime):
    runtime.perception=PublicPerception(runtime.snapshot)


def test_actual130_exposes_current_approach_entry_without_claiming_grab_readiness():
    runtime,actions,calls=runtime_at()
    assert runtime.perception.check_grasp_identity(OBJECT,runtime.snapshot)['authorized']
    assert actions.pick_probe_view_status(OBJECT)['independent_supported_view']
    before=state(actions)
    result=actions.pick_approach_entry(OBJECT)
    assert result['available'] is True and result['action']=='pick'
    assert result['schema']=='brain-pick-approach-entry/v1' and result['object_id']==OBJECT
    assert result['requires_fresh_authorization'] is True
    assert result['not_grab_authorization'] is True
    assert result['memory_distance_cm']==pytest.approx(36.7363561944833)
    assert 22.5<result['memory_distance_cm']<=65
    readiness=actions.navigation_readiness(OBJECT)
    assert readiness['pick_approach_entry']==result
    assert readiness['operation_ready'] is False and readiness['current_pick_ready'] is False
    assert state(actions)==before and not calls
    assert not runtime.perception._grab_authorizations


@pytest.mark.parametrize('index',[183,193])
def test_actual_far_memory_standoff_views_cannot_borrow_the_nearer_visual_range(index):
    runtime,actions,calls=runtime_at(index)
    before=state(actions)
    observed=actions.visible(OBJECT)
    remaining,_=actions.object_geometry(runtime.perception.get_object(OBJECT))
    assert observed and remaining>65
    assert actions.pick_approach_entry(OBJECT)['available'] is False
    assert state(actions)==before and not calls


@pytest.mark.parametrize('index',[104,105,106,107,127])
def test_original_anchor_unknown_pixels_and_absent_view_do_not_offer_entry(index):
    _,actions,calls=runtime_at(index)
    assert actions.pick_approach_entry(OBJECT)['available'] is False
    assert not calls


@pytest.mark.parametrize('fault',[
    'wrong_task','missing_task','nonball_task','no_budget','budget_not_required','bound_none',
    'missing_anchor','same_anchor','same_return','same_budget_return','within_15cm_anchor',
    'holding','unknown_holding','held_object','pending','pending_empty',
    'offroad','unknown_onroad','road_tick','sensor_tick','unknown_tick','bool_tick',
    'unknown_heading','unknown_position','missing_frame',
    'target_lost','target_tentative','target_held','target_delivered','target_alias',
    'target_wrong_category','missing_target','position_missing','position_none','position_nan','position_inf',
    'unknown_pixels','missing_pixel_quality','stale_detection','duplicate_target','identity_ambiguity',
    'unpositioned_competitor','perception_not_current','bbox_clipped','bbox_nonfinite','bearing_nonfinite',
])
def test_entry_keeps_original_task_identity_view_road_and_load_requirements(fault):
    runtime,actions,calls=runtime_at()
    frame=runtime.snapshot
    target=next(o for o in frame['objects']if o['id']==OBJECT)
    detected=next(o for o in frame['perception']['detections']if o.get('track_id')==OBJECT)
    if fault=='wrong_task':runtime.task_spec={'target_category':'blue-ball'}
    elif fault=='missing_task':runtime.task_spec={}
    elif fault=='nonball_task':runtime.task_spec={'target_category':'storage-zone'}
    elif fault=='no_budget':actions._pick_probe_limits={}
    elif fault=='budget_not_required':actions._pick_probe_limits[OBJECT]['requires_new_view']=False
    elif fault=='bound_none':actions._pick_probe_limits[OBJECT]=None
    elif fault=='missing_anchor':del actions._pick_probe_limits[OBJECT]['anchor_odometry']
    elif fault in {'same_anchor','same_return','same_budget_return','within_15cm_anchor'}:
        key={'same_anchor':'anchor_odometry','same_return':'observed_return_odometry',
            'same_budget_return':'budget_return_odometry','within_15cm_anchor':'anchor_odometry'}[fault]
        actions._pick_probe_limits[OBJECT][key]=copy.deepcopy(frame['odometry'])
        if fault=='within_15cm_anchor':actions._pick_probe_limits[OBJECT][key]['rightCm']+=14.99
    elif fault=='holding':frame['holding']['holding']=True
    elif fault=='unknown_holding':frame['holding']['holding']=None
    elif fault=='held_object':runtime.held_object_id='other'
    elif fault=='pending':runtime.pending_grasp={'object_id':OBJECT,'outcome_unknown':True}
    elif fault=='pending_empty':runtime.pending_grasp={}
    elif fault=='offroad':frame['road']['onRoad']=False
    elif fault=='unknown_onroad':frame['road']['onRoad']=None
    elif fault=='road_tick':frame['road']['tick']+=1
    elif fault=='sensor_tick':frame['observation']['tick']+=1
    elif fault=='unknown_tick':frame['odometry']['tick']=None
    elif fault=='bool_tick':frame['odometry']['tick']=True
    elif fault=='unknown_heading':frame['odometry']['headingDeg']=float('nan')
    elif fault=='unknown_position':frame['odometry']['rightCm']=float('nan')
    elif fault=='missing_frame':frame['observation']['frameId']=None
    elif fault.startswith('target_'):
        if fault=='target_alias':target['alias_of']='other'
        elif fault=='target_wrong_category':target['category']='blue-ball'
        else:target['state']=fault.removeprefix('target_').upper()
    elif fault=='missing_target':frame['objects']=[o for o in frame['objects']if o['id']!=OBJECT]
    elif fault=='position_missing':target.pop('position_m')
    elif fault=='position_none':target['position_m']=None
    elif fault=='position_nan':target['position_m']['x']=float('nan')
    elif fault=='position_inf':target['position_m']['z']=float('inf')
    elif fault=='unknown_pixels':detected['pixel_quality']['status']='unknown'
    elif fault=='missing_pixel_quality':detected.pop('pixel_quality')
    elif fault=='stale_detection':detected['frame_id']='129'
    elif fault=='duplicate_target':frame['perception']['detections'].append(copy.deepcopy(detected))
    elif fault=='identity_ambiguity':detected['identity_ambiguity']=True
    elif fault=='unpositioned_competitor':
        competitor=copy.deepcopy(detected);competitor.pop('position_m');competitor['track_id']=None
        frame['perception']['detections'].append(competitor)
    elif fault=='perception_not_current':frame['perception']['simulation_time_s']-=1
    elif fault=='bbox_clipped':detected['bbox']['x']=0
    elif fault=='bbox_nonfinite':detected['bbox']['w']=float('nan')
    elif fault=='bearing_nonfinite':detected['bearing_deg']=float('nan')
    refresh_perception(runtime)
    before=state(actions)
    assert actions.pick_approach_entry(OBJECT)['available'] is False
    assert state(actions)==before and not calls
    assert not runtime.perception._grab_authorizations


@pytest.mark.parametrize('field',['odometry','road','observation','holding'])
@pytest.mark.parametrize('malformed',[None,[]])
def test_malformed_current_snapshot_cannot_offer_entry(field,malformed):
    runtime,actions,calls=runtime_at()
    runtime.snapshot[field]=copy.deepcopy(malformed)
    before=state(actions)
    assert actions.pick_approach_entry(OBJECT)['available'] is False
    assert state(actions)==before and not calls


@pytest.mark.parametrize('field',['task_spec','bound'])
@pytest.mark.parametrize('malformed',[None,[]])
def test_malformed_task_or_probe_bound_fails_closed_without_side_effects(field,malformed):
    runtime,actions,calls=runtime_at()
    if field=='task_spec':runtime.task_spec=copy.deepcopy(malformed)
    else:actions._pick_probe_limits[OBJECT]=copy.deepcopy(malformed)
    before=state(actions)
    assert actions.pick_approach_entry(OBJECT)['available'] is False
    assert state(actions)==before and not calls


def test_previous_handoff_result_does_not_make_a_later_absent_frame_available():
    runtime,actions,calls=runtime_at()
    assert actions.pick_approach_entry(OBJECT)['available']
    runtime.snapshot=copy.deepcopy(FIXTURE['frames']['127'])
    refresh_perception(runtime)
    before=state(actions)
    assert actions.pick_approach_entry(OBJECT)['available'] is False
    assert state(actions)==before and not calls


def test_compact_navigation_subgoal_carries_current_entry_without_nested_private_data():
    from autonomous_brain.run import compact_action_result
    _,actions,calls=runtime_at()
    readiness=actions.navigation_readiness(OBJECT)
    readiness['pick_approach_entry']['unexpected_private_blob']={'raw':'must not leak'}
    result={'success':True,'reason':'public_component','evidence':{'navigation_subgoal':readiness}}
    compact=compact_action_result(23,{'action':'go_to','params':{'object_id':OBJECT}},result,130)
    exposed=compact['evidence']['navigation_subgoal']
    assert exposed['operation_ready'] is False
    entry=exposed['pick_approach_entry']
    assert entry['available'] and entry['action']=='pick' and entry['object_id']==OBJECT
    assert entry['requires_fresh_authorization'] and entry['not_grab_authorization']
    assert 'unexpected_private_blob' not in entry and not calls


def test_current_navigation_state_recomputes_entry_and_preserves_attempted_history():
    _,actions,calls=runtime_at()
    record=actions._navigation_record(OBJECT)
    record['approach_attempts']=[{'candidate_id':'prior-A','result':'failed'}]
    before=state(actions)
    row=next(r for r in actions.navigation_state()if OBJECT in r['identity_ids'])
    assert row['current_subgoal']['pick_approach_entry']['available'] is True
    assert row['current_subgoal']['operation_ready'] is False
    assert actions._navigation_record(OBJECT)['approach_attempts']==record['approach_attempts']
    assert state(actions)==before and not calls


def unknown_dispatch_runtime(prior_evidence):
    runtime,actions,calls=runtime_at()
    observations,motions=[],[]
    failure=TimeoutError('synthetic first approach turn ACK is unknown')
    failure.action_evidence=copy.deepcopy(prior_evidence)
    def call(method,params):
        calls.append((method,copy.deepcopy(params)))
        runtime.bridge.sequence+=1
        raise failure
    def observe(*,motion=None):
        observations.append(copy.deepcopy(motion))
        assert motion is None
        frame=copy.deepcopy(runtime.snapshot)
        frame['observation_index']+=1
        frame['observation']['frameId']=frame['observation_index']
        frame['perception']['frame_id']=str(frame['observation_index'])
        frame['perception']['raw_observation']=copy.deepcopy(frame['observation'])
        for detected in frame['perception']['detections']:
            detected['frame_id']=str(frame['observation_index'])
            if isinstance(detected.get('pixel_quality'),dict):
                detected['pixel_quality']['frameId']=frame['observation_index']
        runtime.snapshot=frame
        refresh_perception(runtime)
        runtime.roads.update(frame['odometry'],frame['road'],frame['observation_index'])
        runtime.roads.observe_traversal(frame)
        return frame
    runtime.bridge.call=call
    runtime.observe=observe
    runtime.motion_log=SimpleNamespace(write=lambda row:motions.append(copy.deepcopy(row)))
    return runtime,actions,calls,observations,motions,failure


@pytest.mark.parametrize('prior_evidence',[None,[],{'existing_diagnostic':True}])
def test_original_pick_actual130_reaches_one_alignment_turn_and_unknown_is_never_resent(prior_evidence):
    runtime,actions,calls,observations,motions,failure=unknown_dispatch_runtime(prior_evidence)
    expected_bearing=actions.visible(OBJECT)['bearing_deg']
    assert actions.navigation_readiness(OBJECT)['operation_ready'] is False
    with pytest.raises(TimeoutError)as raised:
        actions.pick(OBJECT)
    assert raised.value is failure
    assert calls==[('turn',{'angleDeg':pytest.approx(-expected_bearing),'speed':50})]
    assert observations==[None] and len(motions)==1
    assert motions[0]['outcome_unknown'] is True
    assert motions[0]['bridge_request_id']=='brain-000001'
    assert failure.action_evidence['outcome_unknown'] is True
    assert failure.action_evidence['uncertain_motion']['method']=='turn'
    assert failure.action_evidence['road_return']['reason']=='execution_outcome_unknown'
    if isinstance(prior_evidence,dict):assert failure.action_evidence['existing_diagnostic'] is True
    assert not runtime.perception._grab_authorizations


@pytest.mark.parametrize('fault',['pixels','holding','offroad','pending','identity','same_anchor','far183','far193'])
def test_cached_entry_never_overrides_the_original_pick_execution_gates(fault):
    runtime,actions,calls=runtime_at()
    old_entry=actions.pick_approach_entry(OBJECT)
    assert old_entry['available']
    if fault=='pixels':runtime.snapshot['perception']['detections']=[]
    elif fault=='holding':runtime.snapshot['holding']['holding']=True
    elif fault=='offroad':runtime.snapshot['road']['onRoad']=False
    elif fault=='pending':runtime.pending_grasp={'object_id':OBJECT,'outcome_unknown':True}
    elif fault=='identity':
        detected=next(o for o in runtime.snapshot['perception']['detections']if o.get('track_id')==OBJECT)
        runtime.snapshot['perception']['detections'].append(copy.deepcopy(detected))
    elif fault=='same_anchor':actions._pick_probe_limits[OBJECT]['anchor_odometry']=copy.deepcopy(runtime.snapshot['odometry'])
    elif fault in {'far183','far193'}:runtime.snapshot=copy.deepcopy(FIXTURE['frames'][fault.removeprefix('far')])
    refresh_perception(runtime)
    result=actions.pick(OBJECT)
    assert result['success'] is False and not calls
    assert not runtime.perception._grab_authorizations
