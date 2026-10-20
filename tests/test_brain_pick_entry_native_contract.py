"""Synthetic native transport/replay checks; no real LLM request or platform."""
import copy
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from autonomous_brain import chatgpt_transport as transport
from autonomous_brain.llm import CHATGPT_VERSION,LLMClient,PICK_APPROACH_ENTRY_PROMPT
from autonomous_brain.run import compact_action_result
from test_brain_chatgpt_transport import rows as synthetic_native_rows
from test_brain_pick_entry_affordance import OBJECT,runtime_at


def synthetic_reply(request,action):
    rows=synthetic_native_rows()
    text=json.dumps(action,separators=(',',':'))
    for row in rows:
        item=(row.get('params')or{}).get('item')or{}
        if item.get('type')=='userMessage':
            item['content'][0]['text']=json.dumps(request['messages'][1:],ensure_ascii=False,separators=(',',':'))
        if item.get('type')=='agentMessage':item['text']=text
        if row.get('method')=='turn/completed':row['params']['turn']['items'][0]['text']=text
    return '\n'.join(json.dumps(row)for row in rows)+'\n'


@pytest.fixture(autouse=True)
def native_environment(monkeypatch):
    monkeypatch.setenv('LLM_TRANSPORT',transport.TRANSPORT)
    monkeypatch.setenv('LLM_MODEL',transport.MODEL)


@pytest.mark.parametrize('action',[{'action':'explore','params':{}},
    {'action':'pick','params':{'object_id':OBJECT}}])
def test_current_native_request_carries_current_entry_but_model_keeps_action_choice(tmp_path,action):
    runtime,actions,calls=runtime_at()
    actions._navigation_record(OBJECT)
    readiness=actions.navigation_readiness(OBJECT)
    compact=compact_action_result(23,{'action':'go_to','params':{'object_id':OBJECT}},
        {'success':True,'reason':'component','evidence':{'navigation_subgoal':readiness}},130)
    state={'task':'把两个红球送到绿色存放区',
        'objects':[dict(o,status=o['state'])for o in runtime.perception.objects()],
        'robot':{'holding':False},'junction_history':[],'recent_actions':[compact],
        'navigation':actions.navigation_state()}
    before=copy.deepcopy(state)
    sent=[]
    def invoke(request,timeout):
        sent.append(copy.deepcopy(request))
        return synthetic_reply(request,action)
    path=tmp_path/'current.jsonl'
    with patch.object(transport,'invoke',side_effect=invoke):
        with LLMClient(path)as client:assert client.decide(state)==action
    assert state==before and not calls and len(sent)==1
    assert sent[0]['model']=='gpt-6.1-sol' and sent[0]['thinking']=={'type':'low'}
    assert PICK_APPROACH_ENTRY_PROMPT in sent[0]['messages'][0]['content']
    received=json.loads(sent[0]['messages'][1]['content'])
    current=next(r for r in received['navigation']if OBJECT in r['identity_ids'])['current_subgoal']
    assert current['pick_approach_entry']['available'] is True
    assert current['pick_approach_entry']['not_grab_authorization'] is True
    assert current['operation_ready'] is False and current['current_pick_ready'] is False
    assert received['recent_actions'][0]['evidence']['navigation_subgoal']['pick_approach_entry']['object_id']==OBJECT
    record=json.loads(path.read_text())
    assert record['version']==CHATGPT_VERSION=='autonomous-brain-llm/v27'
    with patch.object(transport,'invoke',side_effect=AssertionError('replay cannot invoke a model')):
        with LLMClient(tmp_path/'replayed.jsonl',replay_path=path)as client:
            assert client.decide(state)==action
            client.assert_replay_consumed()
    replay=json.loads((tmp_path/'replayed.jsonl').read_text())
    assert replay['request']==record['request'] and replay['version']==record['version']


def test_record_from_original_frozen_v25_replays_exactly_without_injecting_new_entry_prompt(tmp_path):
    path=Path(__file__).parent/'fixtures/synthetic_native_v25_entry_contract.jsonl'
    meta=json.loads(path.with_suffix('.meta.json').read_text())
    record=json.loads(path.read_text())
    assert record['version']=='autonomous-brain-llm/v25'
    assert PICK_APPROACH_ENTRY_PROMPT not in record['request']['messages'][0]['content']
    with patch.object(transport,'invoke',side_effect=AssertionError('old replay cannot invoke a model')):
        with LLMClient(tmp_path/'legacy-replay.jsonl',replay_path=path)as client:
            assert client.decide(meta['state'])=={'action':'explore','params':{}}
            client.assert_replay_consumed()
    replay=json.loads((tmp_path/'legacy-replay.jsonl').read_text())
    assert replay['version']=='autonomous-brain-llm/v25'
    assert replay['request']==record['request']
    assert replay['action']==record['action'] and replay['request_sha256']==record['request_sha256']


def test_current_runtime22_uses_the_exact_existing_delivery_contract_and_future_stays_rejected():
    from tools.brain_evidence_audit import RUNTIME_EVIDENCE_CAPABILITIES,runtime_evidence_capability
    old=RUNTIME_EVIDENCE_CAPABILITIES['autonomous-brain-runtime/v21']
    assert RUNTIME_EVIDENCE_CAPABILITIES['autonomous-brain-runtime/v22'] is old
    assert runtime_evidence_capability({'runtime_version':'autonomous-brain-runtime/v22'})==(old,None)
    assert runtime_evidence_capability({'runtime_version':'autonomous-brain-runtime/v24'})==(None,'runtime_evidence_version_unsupported')
