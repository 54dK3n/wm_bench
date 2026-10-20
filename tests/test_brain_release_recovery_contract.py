"""Public release metadata and synthetic native contracts, not platform runs."""
import copy
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from autonomous_brain import chatgpt_transport as transport
from autonomous_brain.llm import CHATGPT_VERSION, LLMClient, RELEASE_RECOVERY_PROMPT
from autonomous_brain.run import compact_action_result, compact_release_recovery_options
from test_brain_pick_entry_native_contract import synthetic_reply


def options():
    return {'schema':'brain-release-recovery-options/v1',
        'requires_fresh_recheck':True,'not_delivery_authorization':True,
        'pending':[{'object_id':'second','category':'red-ball','available':True,
            'current_verification_available':False,
            'reason':'untried_road_view_available',
            'missing_evidence':['previously_delivered_objects_not_reobserved'],
            'required_delivered_ids':['first'],'observed_delivered_ids':[],
            'release_observation':{'frame_id':'release-10','simulation_time_s':1.,
                'preexisting_ball_ids':['first'],'command_ref':{
                    'method':'release','object_id':'second','round':3,
                    'before_observation':9,'after_observation':10,
                    'bridge_sequence':5,'bridge_request_id':'brain-000005',
                    'grasp_request_id':'brain-000003','private':'discard'}},
            'identity_anchor_m':{'x':1.,'z':2.},
            'budget':{'max_viewpoints':2,'max_distance_cm':32,
                'attempted_viewpoints':0,'travelled_cm':0,
                'remaining_viewpoints':2,'remaining_distance_cm':32,'private':'discard'},
            'next_intent':{'view_key':'observed-a','direction_heading_deg':30,
                'max_distance_cm':16,'aim_position_m':{'x':1.,'z':2.},'private':'discard'},
            'attempted_views':[{'view_key':'prior-view','status':'viewpoint_clearance_insufficient',
                'before_observation':11,'after_observation':12,'raw_image':'discard'}],
            'raw_image':'discard'}]}


def test_compaction_keeps_original_boundary_missing_evidence_and_budget_without_raw_payloads():
    raw=options(); before=copy.deepcopy(raw)
    compact=compact_release_recovery_options(raw)
    assert raw==before
    row=compact['pending'][0]
    assert row['required_delivered_ids']==['first']
    assert row['missing_evidence']==['previously_delivered_objects_not_reobserved']
    assert row['release_observation']['command_ref']['bridge_request_id']=='brain-000005'
    assert row['release_observation']['frame_id']=='release-10'
    assert row['budget']['remaining_viewpoints']==2
    assert row['next_intent']['view_key']=='observed-a'
    assert row['attempted_views'][0]['status']=='viewpoint_clearance_insufficient'
    assert 'discard' not in json.dumps(compact)
    assert 'identity_anchor_m' not in row and 'aim_position_m' not in row['next_intent']
    result=compact_action_result(4,{'action':'place','params':{}},
        {'success':False,'reason':'release_observation_incomplete','evidence':{
            'release_recovery':[{'object_id':'second','resolved':False,
                'reason':'previously_delivered_objects_not_reobserved','private':'discard'}],
            'release_recovery_options':raw}},12)
    assert result['evidence']['release_recovery_options']==compact
    assert result['evidence']['release_recovery'][0]['reason']==row['missing_evidence'][0]
    assert 'discard' not in json.dumps(result)


@pytest.mark.parametrize('action',[{'action':'place','params':{}},
    {'action':'look_around','params':{}},{'action':'explore','params':{}}])
def test_native_release_option_preserves_actual_model_action_choice(monkeypatch,tmp_path,action):
    monkeypatch.setenv('LLM_TRANSPORT',transport.TRANSPORT)
    monkeypatch.setenv('LLM_MODEL',transport.MODEL)
    state={'task':'two red balls','objects':[],'robot':{'holding':False},
        'junction_history':[],'recent_actions':[],
        'release_recovery':compact_release_recovery_options(options()),
        'completion':{'ready_for_done':False,'delivered_count':1}}
    before=copy.deepcopy(state);sent=[]
    def invoke(request,timeout):
        sent.append(copy.deepcopy(request));return synthetic_reply(request,action)
    path=tmp_path/'native.jsonl'
    with patch.object(transport,'invoke',side_effect=invoke):
        with LLMClient(path) as client:assert client.decide(state)==action
    assert len(sent)==1 and state==before
    assert RELEASE_RECOVERY_PROMPT in sent[0]['messages'][0]['content']
    received=json.loads(sent[0]['messages'][1]['content'])
    assert received['release_recovery']==state['release_recovery']
    assert sent[0]['model']==transport.MODEL and sent[0]['thinking']=={'type':'low'}
    record=json.loads(path.read_text())
    assert record['version']==CHATGPT_VERSION=='autonomous-brain-llm/v27'
    assert record['action']==action


def test_frozen_v26_synthetic_replay_preserves_old_prompt_and_request_exactly(tmp_path):
    path=Path(__file__).parent/'fixtures/synthetic_native_v26_release_contract.jsonl'
    record=json.loads(path.read_text());meta=json.loads(path.with_suffix('.meta.json').read_text())
    assert record['version']=='autonomous-brain-llm/v26'
    assert RELEASE_RECOVERY_PROMPT not in record['request']['messages'][0]['content']
    out=tmp_path/'replay.jsonl'
    with patch.object(transport,'invoke',side_effect=AssertionError('no real call in replay')):
        with LLMClient(out,replay_path=path) as client:
            assert client.decide(meta['state'])==meta['action'];client.assert_replay_consumed()
    replay=json.loads(out.read_text())
    for key in ['request','request_sha256','version','action']:
        assert replay[key]==record[key]


def test_runtime23_keeps_the_same_strict_delivery_capability_and_rejects_future_version():
    from tools.brain_evidence_audit import RUNTIME_EVIDENCE_CAPABILITIES,runtime_evidence_capability
    old=RUNTIME_EVIDENCE_CAPABILITIES['autonomous-brain-runtime/v22']
    assert RUNTIME_EVIDENCE_CAPABILITIES['autonomous-brain-runtime/v23'] is old
    assert runtime_evidence_capability({'runtime_version':'autonomous-brain-runtime/v23'})==(old,None)
    assert runtime_evidence_capability({'runtime_version':'autonomous-brain-runtime/v24'})==(None,'runtime_evidence_version_unsupported')
