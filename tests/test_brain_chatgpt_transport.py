import copy
import json
from pathlib import Path
from unittest.mock import patch
import pytest
from autonomous_brain import chatgpt_transport as t
from autonomous_brain.llm import LLMClient, formal_model_parameters

FIXTURE=Path(__file__).parent/'fixtures/chatgpt_native_reply.json'
def fixture():return json.loads(FIXTURE.read_text())
def rows():return [json.loads(x) for x in fixture()['response_body'].splitlines()]

def test_actual_native_reply_and_formal_parameters():
    f=fixture();assert t.decode(f['response_body'],f['request'])==('{"action":"explore","params":{}}','gpt-6.1-sol',None)
    assert formal_model_parameters('gpt-6.1-sol',None,'low',t.TRANSPORT)
    assert not formal_model_parameters('gpt-6.1-sol',0,'disabled')

@pytest.mark.parametrize('bad',['truncated','wrong_model','wrong_thread','wrong_turn','tool','rpc_error','failed','duplicate','wrong_input','wrong_effort','environment','apikey'])
def test_unproved_native_completion_rejected(bad):
    rs=rows()
    start=next(r['result'] for r in rs if r.get('id')==3)
    end=next(r for r in rs if r.get('method')=='turn/completed')
    msg=next(r for r in rs if r.get('method')=='item/completed' and r['params']['item']['type']=='agentMessage')
    if bad=='truncated':rs.remove(end)
    if bad=='wrong_model':start['model']='other'
    if bad=='wrong_thread':msg['params']['threadId']='other'
    if bad=='wrong_turn':msg['params']['turnId']='other'
    if bad=='tool':msg['params']['item']['type']='commandExecution'
    if bad=='rpc_error':rs.append({'id':9,'error':{'code':1}})
    if bad=='failed':end['params']['turn']['status']='failed'
    if bad=='duplicate':rs.append(copy.deepcopy(msg))
    if bad=='wrong_input':next(r for r in rs if r.get('method')=='item/completed' and r['params']['item']['type']=='userMessage')['params']['item']['content'][0]['text']='different state'
    if bad=='wrong_effort':start['reasoningEffort']='high'
    if bad=='environment':start['thread']['environments']=[{'id':'local'}]
    if bad=='apikey':next(r for r in rs if r.get('id')==2)['result']['account']['type']='apiKey'
    assert t.decode('\n'.join(json.dumps(x) for x in rs),fixture()['request'])[2] is not None

def test_live_native_record_and_network_free_exact_replay(tmp_path,monkeypatch):
    monkeypatch.setenv('LLM_TRANSPORT',t.TRANSPORT);monkeypatch.setenv('LLM_MODEL',t.MODEL)
    f=fixture();state=json.loads(f['request']['messages'][1]['content'])
    with patch.object(t,'invoke',return_value=f['response_body']) as invoke:
        with LLMClient(tmp_path/'live.jsonl') as client:assert client.decide(state)=={'action':'explore','params':{}}
        assert invoke.call_count==1
    with patch.object(t,'invoke',side_effect=AssertionError('Replay must not call model')):
        with LLMClient(tmp_path/'replay.jsonl',replay_path=tmp_path/'live.jsonl') as client:
            assert client.decide(state)=={'action':'explore','params':{}};client.assert_replay_consumed()
    live=json.loads((tmp_path/'live.jsonl').read_text());replay=json.loads((tmp_path/'replay.jsonl').read_text());live['mode']='replay';assert live==replay

def test_chatgpt_frozen_client_and_profile_match(formal_proof):
    from test_brain_stage1_source_proof import verdict
    profile={'model':t.MODEL,'temperature':None,'thinking':t.EFFORT,'transport':t.TRANSPORT,
        'client':{'binary':'/official/codex','sha256':'a'*64}}
    for manifest in [formal_proof['source_manifest'],formal_proof['driver_summary']['sourceManifestAfterRun']]:
        manifest['modelConfiguration'].update(copy.deepcopy(profile))
    formal_proof['summary']['formal_configuration'].update(copy.deepcopy(profile))
    assert verdict(formal_proof)['status']=='verified'
    formal_proof['summary']['formal_configuration']['client']['sha256']='b'*64
    assert 'source_proof_formal_configuration_mismatch' in verdict(formal_proof)['failures']

def test_chatgpt_done_native_bytes_keep_independent_delivery_requirement():
    import hashlib
    from brain_evidence_fixtures import task_fixture
    from tools.evaluate_autonomous_brain import evaluate_task_scope
    summary,obs,rounds,calls,bridge,motions=task_fixture();call=calls[0]
    call['request'].update(model=t.MODEL,temperature=None,thinking={'type':t.EFFORT},transport=t.TRANSPORT)
    request=call['request'];request['messages']=copy.deepcopy(fixture()['request']['messages']);rs=rows()
    for r in rs:
        item=(r.get('params') or {}).get('item') or {}
        if item.get('type')=='userMessage':item['content'][0]['text']=json.dumps(request['messages'][1:],ensure_ascii=False,separators=(',',':'))
        if item.get('type')=='agentMessage':item['text']='{"action":"done","params":{}}'
        if r.get('method')=='turn/completed':
            r['params']['turn']['items'][0]['text']='{"action":"done","params":{}}'
    call['response_body']='\n'.join(json.dumps(x) for x in rs)+'\n';call['response_model']=t.MODEL
    call['raw_output']='{"action":"done","params":{}}'
    call['request_sha256']=hashlib.sha256(json.dumps(request,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    summary['formal_configuration']={'model':t.MODEL,'temperature':None,'transport':t.TRANSPORT}
    assert evaluate_task_scope(summary,obs,rounds,calls,bridge,motions)['failures']==[]
    summary['action_evidence'].pop()
    assert 'task_completion:required_delivery_count_not_met' in evaluate_task_scope(summary,obs,rounds,calls,bridge,motions)['failures']

from test_brain_stage1_source_proof import formal_proof
from test_brain_evaluation import fixture_data
