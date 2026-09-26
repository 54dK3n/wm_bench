"""One optional explore intention, with literal historical contract replay."""
import copy
import hashlib
import io
import json
from unittest.mock import patch

import pytest

from autonomous_brain import llm
from test_brain_llm import config, records, response
from test_brain_llm_finish import canonical, literal_row


@pytest.fixture
def discovery_state():
    return {'task':'把两个红球送到绿色存放区','objects':[
        {'id':'candidate','category':'red-ball','status':'TENTATIVE'}],
        'robot':{'holding':False,'at_node':False,'exit_angles':[]},
        'junction_history':[],'recent_actions':[],
        'discovery':{'pending_count':1,'pending':[{'id':'stable-1','hypothesis_id':'stable-1',
            'source_discovery_id':'source-1','latest_discovery_id':'latest-7',
            'associated_object_id':'candidate','associated_object_state':'TENTATIVE',
            'hit_count':1,'missing_hit_count':2}]}}


@pytest.mark.parametrize('selected',['stable-1','source-1'])
def test_v18_accepts_current_stable_hypothesis_or_original_source_without_rewriting(discovery_state,selected):
    action={'action':'explore','params':{'discovery_id':selected}}
    before=copy.deepcopy(discovery_state)
    assert llm.validate_action(action,discovery_state)==action
    assert discovery_state==before


@pytest.mark.parametrize('params',[{'discovery_id':''},{'discovery_id':' '},{'discovery_id':None},
    {'discovery_id':True},{'discovery_id':['stable-1']},{'discovery_id':'x'*129},
    {'discovery_id':'unknown'},{'discovery_id':'latest-7'},
    {'discovery_id':'stable-1','exit_angle':0},{'discovery_id':'stable-1','route':[]}])
def test_v18_rejects_invalid_hidden_latest_or_conflicting_selections(discovery_state,params):
    with pytest.raises(llm.ActionValidationError):llm.validate_action({'action':'explore','params':params},discovery_state)


def test_v18_discovery_selection_must_identify_one_current_summary_row(discovery_state):
    discovery_state['discovery']['pending'].append(copy.deepcopy(discovery_state['discovery']['pending'][0]))
    with pytest.raises(llm.ActionValidationError):
        llm.validate_action({'action':'explore','params':{'discovery_id':'stable-1'}},discovery_state)


@pytest.mark.parametrize('state_name',['TENTATIVE','STALE','LOST'])
@pytest.mark.parametrize('action_name',['pick','go_to'])
def test_discovery_intent_never_relaxes_manipulation_confirmation(discovery_state,state_name,action_name):
    discovery_state['objects'][0]['status']=state_name
    with pytest.raises(llm.ActionValidationError,match='CONFIRMED'):
        llm.validate_action({'action':action_name,'params':{'object_id':'candidate'}},discovery_state)


@pytest.mark.parametrize('number',range(1,18))
def test_old_versions_keep_the_old_parameter_whitelist(discovery_state,number):
    with pytest.raises(llm.ActionValidationError,match='^explore only accepts exit_angle$'):
        llm.validate_action({'action':'explore','params':{'discovery_id':'stable-1'}},discovery_state,
                            transcript_version=f'autonomous-brain-llm/v{number}')


@pytest.mark.parametrize('number',range(1,18))
def test_literal_old_invalid_discovery_then_repair_replays_exactly(tmp_path,discovery_state,number):
    wrong={'action':'explore','params':{'discovery_id':'stable-1'}}
    selected={'action':'look_around','params':{}}
    raw=canonical(wrong)
    body=canonical({'model':'served-model','choices':[{'message':{'content':raw},'finish_reason':'stop'}]})
    first=literal_row(discovery_state,number,body,stream=False)
    first.update(raw_output=raw,action=None,validation_error='explore only accepts exit_angle')
    second=literal_row(discovery_state,number,canonical({'model':'served-model','choices':[
        {'message':{'content':canonical(selected)},'finish_reason':'stop'}]}),stream=False,index=2)
    second.update(decision_index=1,attempt=2)
    second['request']['messages']=copy.deepcopy(first['request']['messages'])+[
        {'role':'assistant','content':raw},{'role':'user','content':'上一个输出不合法：explore only accepts exit_angle。仅修复为一个合法动作 JSON；遵守给定状态及 action/params 契约。'}]
    second['request_sha256']=hashlib.sha256(canonical(second['request']).encode()).hexdigest()
    original=[first,second];source=tmp_path/'old.jsonl';source.write_text(''.join(canonical(r)+'\n' for r in original))
    with patch('autonomous_brain.llm.os.environ.get',side_effect=AssertionError('environment forbidden')), \
            patch('urllib.request.urlopen',side_effect=AssertionError('network forbidden')):
        with llm.LLMClient(tmp_path/'replay.jsonl',replay_path=source) as client:
            assert client.decide(discovery_state)==selected
            client.assert_replay_consumed()
    assert records(tmp_path/'replay.jsonl')==[dict(r,mode='replay') for r in original]


def test_v18_live_selection_prompt_and_exact_offline_replay(tmp_path,discovery_state):
    selected={'action':'explore','params':{'discovery_id':'stable-1'}}
    source=tmp_path/'live.jsonl'
    with patch('urllib.request.urlopen',return_value=response(canonical(selected))):
        with llm.LLMClient(source) as client:assert client.decide(discovery_state)==selected
    row,=records(source)
    assert row['version']=='autonomous-brain-llm/v18'
    prompt=row['request']['messages'][0]['content']
    for phrase in ['discovery_id','source_discovery_id','互斥','只取得确认','不抓取','CONFIRMED']:
        assert phrase in prompt
    with patch('autonomous_brain.llm.os.environ.get',side_effect=AssertionError('environment forbidden')), \
            patch('urllib.request.urlopen',side_effect=AssertionError('network forbidden')):
        with llm.LLMClient(tmp_path/'replay.jsonl',replay_path=source) as client:
            assert client.decide(discovery_state)==selected
            client.assert_replay_consumed()
    assert records(tmp_path/'replay.jsonl')==[dict(row,mode='replay')]


def test_sampling_recent_result_retains_intent_and_bounded_progress_without_raw_steps():
    from autonomous_brain.run import compact_action_result
    action={'action':'explore','params':{'discovery_id':'stable-1'}}
    progress={'schema':'brain-confirmation-sampling/v1','discovery_id':'stable-1',
        'initial_object_id':'candidate','confirmed_object_id':None,'initial_hit_count':1,'final_hit_count':2,
        'reason':'sampling_view_occluded','travelled_cm':16.0,'independent_hits_added':1,'max_steps':6,
        'steps':[{'raw':'large-frame'}]*100,'secret':'must-not-enter-recent'}
    original=copy.deepcopy(progress)
    compact=compact_action_result(3,action,{'success':False,'reason':'sampling_incomplete',
        'evidence':{'confirmation_sampling':progress}},9)
    assert compact['action']==action
    assert compact['evidence']['confirmation_sampling']=={k:v for k,v in progress.items() if k not in {'steps','secret'}}
    compact['action']['params']['discovery_id']='changed'
    compact['evidence']['confirmation_sampling']['reason']='changed'
    assert progress==original and action['params']['discovery_id']=='stable-1'
    progress['reason']='x'*1000
    assert len(compact_action_result(3,action,{'success':False,'reason':'failed',
        'evidence':{'confirmation_sampling':progress}},9)['evidence']['confirmation_sampling']['reason'])==256


def test_recent_road_and_target_progress_preserve_bounded_semantic_evidence():
    from autonomous_brain.run import compact_action_result
    road={'schema':'brain-explore-road-progress/v1','status':'same_junction_progress_observed',
        'before_observation':1,'after_observation':9,'start_node_id':'node-A','end_node_id':'node-A',
        'start_anchor_observation':1,'end_anchor_observation':9,'different_node_verified':False,
        'on_road':True,'at_node':True,'net_displacement_cm':.1,'odometer_travel_cm':24,
        'new_traversal_ids':['trip-'+str(i) for i in range(100)],'arrival_traversal_ids':['trip-0'],
        'raw_observations':[{}]*1000}
    target={'schema':'brain-explore-target-progress/v1','target_category':'red-ball',
        'new_target_object_ids':['target-'+str(i) for i in range(100)],'newly_confirmed_target_ids':[],
        'new_other_object_ids':['blue-1'],'newly_confirmed_other_object_ids':[],'other_raw':'not-exposed'}
    out=compact_action_result(4,{'action':'explore','params':{}},{'success':True,'reason':'same_junction_progress_observed',
        'evidence':{'road_progress':road,'target_progress':target}},9)['evidence']
    assert out['road_progress']['different_node_verified'] is False
    assert out['road_progress']['new_traversal_ids']==road['new_traversal_ids'][:12]
    assert out['target_progress']['new_target_object_ids']==target['new_target_object_ids'][:12]
    assert out['target_progress']['new_other_object_ids']==['blue-1']
    assert 'raw_observations' not in out['road_progress'] and 'other_raw' not in out['target_progress']


def test_recent_sampling_viewpoint_constraints_are_bounded_and_copied():
    from autonomous_brain.run import compact_action_result
    constraints=['range_window_unavailable', 'x'*1000, None, {'raw':'not-allowed'},
                 'no_reverse_support', 'pose_not_independent', 'beyond-limit']
    source={'schema':'brain-confirmation-sampling/v1','viewpoint_constraints':constraints}
    out=compact_action_result(1,{'action':'explore','params':{'discovery_id':'stable'}},
        {'success':False,'reason':'confirmation_no_safe_independent_viewpoint',
         'evidence':{'confirmation_sampling':source}},2)['evidence']['confirmation_sampling']
    assert out['viewpoint_constraints']==['range_window_unavailable','x'*128,
                                        'no_reverse_support','pose_not_independent']
    out['viewpoint_constraints'][0]='changed'
    assert constraints[0]=='range_window_unavailable'
