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

@pytest.mark.parametrize('change,accepted',[
    ({},False),({'fromModel':'other'},False),({'toModel':t.MODEL},True),
    ({'threadId':'unrelated','turnId':'unrelated'},True),
    ({'turnId':'another-turn'},True),({'threadId':'conflicting-thread'},False),
    ({'turnId':None},False),({'threadId':None},False),({'toModel':None},False)])
def test_reroute_is_bound_to_model_thread_and_turn(change,accepted):
    rs=rows();tid=next(r['result']['thread']['id'] for r in rs if r.get('id')==3)
    turnid=next(r['result']['turn']['id'] for r in rs if r.get('id')==4)
    event={'method':'model/rerouted','params':{'threadId':tid,'turnId':turnid,
        'fromModel':t.MODEL,'toModel':'other','reason':'test'}}
    event['params'].update(change);rs.insert(-1,event)
    assert (t.decode('\n'.join(json.dumps(r) for r in rs),fixture()['request'])[2] is None)==accepted

@pytest.mark.parametrize('mode',['buffered','late_success','expired_before_send'])
def test_total_deadline_rejects_buffered_notifications_and_late_success(monkeypatch,mode):
    import io
    clock=[0.0];sent=io.StringIO();rs=rows()
    class Proc:
        stdin=sent;stdout=[]
        def terminate(self):pass
        def wait(self,timeout):return 0
    class Inbox:
        def __init__(self):self.index=0
        def put(self,line):pass
        def get(self,timeout):
            assert timeout>0
            if mode=='late_success':
                row=rs[self.index];self.index+=1
                if row.get('method')=='turn/completed':clock[0]=2.0
            else:
                row={'method':'warning','params':{'message':'queued'}};clock[0]+=0.2
            return json.dumps(row)+'\n'
    monkeypatch.setenv('LLM_CODEX_BINARY','synthetic-test-binary')
    monkeypatch.setattr(t.subprocess,'Popen',lambda *a,**k:Proc())
    monkeypatch.setattr(t.queue,'Queue',Inbox)
    def now():
        value=clock[0]
        if mode=='expired_before_send':clock[0]=2.0
        return value
    monkeypatch.setattr(t.time,'monotonic',now)
    with pytest.raises(t.TransportFailure) as caught:t.invoke(fixture()['request'],1.0)
    assert caught.value.kind=='TimeoutError'
    if mode=='expired_before_send':assert sent.getvalue()==''
    elif mode=='buffered':
        assert caught.value.body.count('queued')==5
        assert [json.loads(l)['method'] for l in sent.getvalue().splitlines()]==['initialize']
    else:assert 'turn/completed' in caught.value.body

@pytest.mark.parametrize('mode',['success','reroute','early_reroute','wrong_model'])
def test_invoke_real_subprocess_protocol_entry(tmp_path,monkeypatch,mode):
    # Synthetic protocol peer tests process I/O only; never a platform decision.
    import sys
    script=tmp_path/'protocol_peer';payload=rows()
    script.write_text('#!'+sys.executable+'\n'+
        'import json,sys\nrows='+repr(payload)+'\nmode='+repr(mode)+'\n'+'''
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r:continue
 reply=next(x for x in rows if x.get('id')==r['id'])
 if r['id']==3 and mode=='wrong_model':reply['result']['model']='other'
 if r['id']==4 and mode=='early_reroute':
  print(json.dumps({'method':'model/rerouted','params':{'threadId':next(x['result']['thread']['id'] for x in rows if x.get('id')==3),'turnId':reply['result']['turn']['id'],'fromModel':'gpt-6.1-sol','toModel':'other'}}),flush=True)
 print(json.dumps(reply),flush=True)
 if r['id']==4:
  for x in rows:
   if 'id' not in x and x.get('method') not in ('thread/started','turn/started'):
    if x.get('method')=='turn/completed' and mode=='reroute':
     print(json.dumps({'method':'model/rerouted','params':{'threadId':x['params']['threadId'],'turnId':x['params']['turn']['id'],'fromModel':'gpt-6.1-sol','toModel':'other'}}),flush=True)
    print(json.dumps(x),flush=True)
''')
    script.chmod(0o700);monkeypatch.setenv('LLM_CODEX_BINARY',str(script))
    if mode=='success':assert t.decode(t.invoke(fixture()['request'],5),fixture()['request'])[2] is None
    else:
        with pytest.raises(t.TransportFailure) as caught:t.invoke(fixture()['request'],5)
        assert caught.value.kind=='ValueError'
        if 'reroute' in mode:assert 'model/rerouted' in caught.value.body
