"""Official Codex app-server inference only; original RPC replies are evidence."""
import hashlib
from pathlib import Path
import json
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time

TRANSPORT = 'codex-app-server'
MODEL = 'gpt-6.1-sol'
EFFORT = 'low'

class TransportFailure(RuntimeError):
    def __init__(self, body, kind):
        super().__init__('ChatGPT inference did not complete')
        self.body=body
        self.kind=kind

def client_provenance():
    binary=Path(os.environ.get('LLM_CODEX_BINARY') or shutil.which('codex') or '').resolve()
    return {'binary':str(binary),'sha256':hashlib.sha256(binary.read_bytes()).hexdigest()}

def start_params(request, cwd):
    return {'model':request['model'], 'modelProvider':'openai', 'allowProviderModelFallback':False,
        'cwd':cwd, 'ephemeral':True, 'environments':[], 'dynamicTools':[],
        'approvalPolicy':'never', 'sandbox':'read-only',
        'baseInstructions':request['messages'][0]['content'],
        'developerInstructions':'Only return one action JSON. Do not use tools, files, network, or any facts outside the supplied robot state.',
        'config':{'model_reasoning_effort':EFFORT, 'features.shell_tool':False,
                  'features.apply_patch_freeform':False, 'features.multi_agent':False,
                  'features.apps':False, 'apps._default.enabled':False,
                  'mcp_servers.node_repl.enabled':False, 'mcp_servers.computer-use.enabled':False,
                  'web_search':'disabled'}}

def invoke(request, timeout_s):
    binary=os.environ.get('LLM_CODEX_BINARY') or shutil.which('codex')
    if not binary:raise OSError('Codex binary unavailable')
    rows=[]; deadline=time.monotonic()+timeout_s; inbox=queue.Queue()
    # No inherited provider credentials or repository access for the model.
    env={k:v for k,v in os.environ.items() if not k.startswith(('LLM_','OPENAI_','MOONSHOT_','DEEPSEEK_'))}
    with tempfile.TemporaryDirectory(prefix='wm-chatgpt-inference-') as cwd:
        proc=subprocess.Popen([binary,'app-server','--listen','stdio://'],stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env=env,cwd=cwd)
        def read():
            for line in proc.stdout:inbox.put(line)
            inbox.put(None)
        threading.Thread(target=read,daemon=True).start()
        def send(method,params=None,id=None):
            r={'method':method}
            if id is not None:r['id']=id
            if params is not None:r['params']=params
            proc.stdin.write(json.dumps(r,ensure_ascii=False)+'\n');proc.stdin.flush()
        def receive():
            try:line=inbox.get(timeout=max(0.001,deadline-time.monotonic()))
            except queue.Empty:raise TimeoutError('Codex inference timeout')
            if line is None:raise OSError('Codex app-server ended')
            r=json.loads(line);rows.append(line)
            if 'method' in r and 'id' in r:raise ValueError('Unexpected tool or approval request')
            item=(r.get('params') or {}).get('item') or {}
            if item and item.get('type') not in ('userMessage','agentMessage','reasoning'):
                raise ValueError('Non-inference item forbidden')
            return r
        def rpc(method,params,id):
            send(method,params,id)
            while True:
                r=receive()
                if r.get('id')==id:
                    if 'error' in r:raise ValueError('Codex RPC rejected')
                    return r['result']
        try:
            rpc('initialize',{'clientInfo':{'name':'wm_brain_inference','version':'1'},
                'capabilities':{'experimentalApi':True}},1);send('initialized')
            account=rpc('account/read',{'refreshToken':False},2)
            if (account.get('account') or {}).get('type')!='chatgpt':
                raise ValueError('ChatGPT account authentication required')
            started=rpc('thread/start',start_params(request,cwd),3)
            if started.get('model')!=request['model'] or started.get('modelProvider')!='openai':
                raise ValueError('Selected model/provider mismatch')
            tid=started['thread']['id']
            prompt=json.dumps(request['messages'][1:],ensure_ascii=False,separators=(',',':'))
            rpc('turn/start',{'threadId':tid,'model':request['model'],'effort':EFFORT,
                'input':[{'type':'text','text':prompt}], 'environments':[]},4)
            while True:
                r=receive()
                if r.get('method')=='turn/completed':break
            return ''.join(rows)
        except Exception as exc:
            raise TransportFailure(''.join(rows),type(exc).__name__) from None
        finally:
            proc.terminate()
            try:proc.wait(timeout=5)
            except subprocess.TimeoutExpired:proc.kill();proc.wait()


def decode(body, request):
    """Parse recorded native receipts, including terminal state and tool absence."""
    try:
        rows=[json.loads(x) for x in body.splitlines() if x.strip()]
        account=next(x['result']['account'] for x in rows if x.get('id')==2)
        start=next(x['result'] for x in rows if x.get('id')==3)
        turn_start=next(x['result']['turn'] for x in rows if x.get('id')==4)
        tid=start['thread']['id'];turnid=turn_start['id']; finals=[];terminals=[];inputs=[]
        if start.get('reasoningEffort')!=EFFORT or start['thread'].get('environments')!=[]:
            raise ValueError('inference configuration mismatch')
        if account.get('type')!='chatgpt' or start.get('model')!=request['model'] or start.get('modelProvider')!='openai' or start['thread'].get('model')!=request['model']:
            raise ValueError('account/model mismatch')
        for r in rows:
            if 'error' in r or ('method' in r and 'id' in r):raise ValueError('RPC/tool error')
            p=r.get('params') or {};item=p.get('item') or {}
            if item and item.get('type') not in ('userMessage','agentMessage','reasoning'):raise ValueError('tool used')
            if r.get('method') in ('item/completed','turn/completed'):
                if p.get('threadId')!=tid:raise ValueError('thread mismatch')
            if r.get('method')=='item/completed' and item.get('type')=='userMessage':
                if p.get('turnId')!=turnid:raise ValueError('input turn mismatch')
                inputs.append(item.get('content'))
            if r.get('method')=='item/completed' and item.get('type')=='agentMessage':
                if p.get('turnId')!=turnid:raise ValueError('turn mismatch')
                if item.get('phase')!='final_answer':raise ValueError('Not a final reply')
                finals.append(item['text'])
            if r.get('method')=='turn/completed':terminals.append(p['turn'])
        from autonomous_brain.llm import _strict_loads
        expected_input=request['messages'][1:]
        if len(inputs)!=1 or len(inputs[0])!=1 or inputs[0][0].get('type')!='text' or _strict_loads(inputs[0][0].get('text'))!=expected_input:
            raise ValueError('model input does not match recorded state')
        if len(finals)!=1 or len(terminals)!=1 or terminals[0].get('id')!=turnid or terminals[0].get('status')!='completed' or terminals[0].get('error'):
            raise ValueError('Incomplete or ambiguous completion')
        terminal_items=terminals[0].get('items') or []
        if any(i.get('type') not in ('agentMessage','reasoning') for i in terminal_items):raise ValueError('terminal tool item')
        messages=[i for i in terminal_items if i.get('type')=='agentMessage']
        if len(messages)!=1 or messages[0].get('text')!=finals[0]:raise ValueError('terminal reply mismatch')
        return finals[0],start['model'],None
    except (ValueError,KeyError,TypeError,StopIteration,json.JSONDecodeError):
        return None,None,'Native ChatGPT receipt must prove one completed tool-free model reply'
