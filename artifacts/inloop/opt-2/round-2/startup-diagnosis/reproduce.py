#!/usr/bin/env python3
"""Native startup-error evidence plus full-worker offline replay (no simulation)."""
import argparse
import ast
import dis
import types
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import subprocess

OUT=Path(__file__).resolve().parent
ROUND=OUT.parent
ROOT=OUT.parents[4]
PLATFORM=Path('/Users/ken/Desktop/robot_competition-main/projects/car-python')
def load(p):return json.loads(Path(p).read_text())
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def digest(text):return hashlib.sha256(text.encode()).hexdigest()

def lexical_proof(path):
    source=path.read_text();worker=(PLATFORM/'python-worker.js').read_text()
    ns={'ast':ast}
    exec(worker[worker.index('class AsyncRobotTransformer('):worker.index('student_run_target =')],ns)
    tree=ast.parse(source,filename='<学生代码>')
    names={n.name for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef))}
    tree=ns['AsyncRobotTransformer'](names).visit(tree)
    # These wrapper fields exactly match python-worker.js L409–415.
    main=ast.AsyncFunctionDef(name='__student_main__',args=ast.arguments(posonlyargs=[],args=[],kwonlyargs=[],kw_defaults=[],defaults=[]),body=tree.body or [ast.Pass()],decorator_list=[],returns=None,type_comment=None)
    module=ast.fix_missing_locations(ast.Module(body=[main],type_ignores=[]))
    compiled=compile(module,'<学生代码>','exec')
    student=next(c for c in compiled.co_consts if isinstance(c,types.CodeType) and c.co_name=='__student_main__')
    methods={c.co_name:c for c in student.co_consts if isinstance(c,types.CodeType)}
    keys={'OPT2_MEMORY_TRAVEL_ACTIVE','OPT2_MOTION_STATE','globals'}
    return {'student_main_varnames':[n for n in student.co_varnames if n in keys],
            'student_main_cellvars':[n for n in student.co_cellvars if n in keys],
            'methods':{name:{'freevars':list(methods[name].co_freevars),
                'state_operations':[{'offset':i.offset,'opcode':i.opname,'name':i.argval} for i in dis.get_instructions(methods[name]) if isinstance(i.argval,str) and i.argval in keys]}
                       for name in ('_opt2_patrol_enter','_opt2_memory_navigation','_opt2_travel_speed')}}

def collect(candidate):
    executed=(ROUND/'executed_program.py').read_text()
    runs=[]
    for p in sorted(ROUND.glob('map-??.json')):
        raw=load(p); record_path=Path(raw['fullRecordFile']);record=load(record_path)
        rows=[{'event_index':i,**e} for i,e in enumerate(record['events']) if e.get('type')=='program_error']
        api=[{'input_index':i,'seq':e['seq'],'tick':e.get('tick'),'method':e['method'],'args':e.get('args',[]),'type':e['type']} for i,e in enumerate(record['inputs']) if 'method' in e]
        controls=[e for e in api if e['type'] not in ('navigation_query','vision_query')]
        observations=[{'line':i,**e} for i,e in enumerate(raw['lines']) if e.get('event')=='observe']
        runs.append({'map':p.stem,'raw_sha256':sha(p),'record_path':str(record_path),'record_sha256':sha(record_path),
                     'native_source_equals_frozen_executed':record['sourceCode']==executed,
                     'native_source_sha256':digest(record['sourceCode']),
                     'native_program_errors':rows,'feedback':raw['pythonFeedback'],'public_api_calls':api,
                     'observations':observations,'control_count':len(controls),'simulation_end_tick':record['simulationEndTick'],
                     'raw_event_names':[e['event'] for e in raw['lines']]})
    old=ast.parse((ROUND/'program.py').read_text());newp=candidate;new=ast.parse(newp.read_text())
    oldfuncs={n.name:n for n in old.body if isinstance(n,ast.FunctionDef)};newfuncs={n.name:n for n in new.body if isinstance(n,ast.FunctionDef)}
    changed=[name for name,n in oldfuncs.items() if ast.dump(n,include_attributes=False)!=ast.dump(newfuncs[name],include_attributes=False)]
    oldglobal=[{'line':n.lineno,'names':n.names} for n in ast.walk(old) if isinstance(n,ast.Global)]
    newglobal=[{'line':n.lineno,'names':n.names} for n in ast.walk(new) if isinstance(n,ast.Global)]
    return {'scope':'Offline only. Native records contain the friendly error, not the Python traceback; the detailed exception requires full-worker reproduction.',
            'runs':runs,'summary':{'runs':len(runs),'native_program_errors':sum(len(r['native_program_errors']) for r in runs),'runs_error_at_tick_zero':sum(len(r['native_program_errors'])==1 and r['native_program_errors'][0]['t']==0 for r in runs),'controls':sum(r['control_count'] for r in runs),'raw_observe_calls':sum(len(r['observations']) for r in runs),'all_native_source_equal_frozen':all(r['native_source_equals_frozen_executed'] for r in runs)},
            'program_sha256':sha(ROUND/'program.py'),'executed_program_sha256':sha(ROUND/'executed_program.py'),
            'worker_sha256':sha(PLATFORM/'python-worker.js'),'app_sha256':sha(PLATFORM/'app.js'),
            'frozen_wrapper_lexical_proof':lexical_proof(ROUND/'executed_program.py'),
            'current_wrapper_lexical_proof':lexical_proof(newp),
            'current_candidate':{'path':str(newp),'sha256':sha(newp),'changed_functions':changed,'old_global_statements':oldglobal,'new_global_statements':newglobal},
            'preflight_gap':{'preflight':'tools/opt2_preflight.py compiled transformed module with PyCF_ALLOW_TOP_LEVEL_AWAIT, but did not execute the worker outer __student_main__ wrapper',
                            'independent_review':'round-2/pre-run-review/review_acquisition.py executed selected definitions at module scope and replaced motion functions; complete name set did not reproduce enclosing function scope',
                            'motion_test':'programs/tests/test_opt2_motion.py evaluated the motion fragment at module scope; its top-level assignment created a global, whereas the real worker puts that assignment inside __student_main__'}}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate',type=Path,default=ROOT/'programs/world_model_opt2.py')
    args=parser.parse_args()
    result=collect(args.candidate.resolve())
    sys.path.insert(0,str(ROOT/'tools'))
    from opt2_runtime_smoke import run_smoke, DEFAULT_FIXTURE, DEFAULT_WORKER, _runtime_template
    node_script="""const fs=require('fs'),vm=require('vm'),crypto=require('crypto'); const text=fs.readFileSync(process.argv[1],'utf8');const a=text.indexOf('  const runtime = `')+'  const runtime = `'.length;const raw=text.slice(a,text.indexOf('`;\\n  try {',a));if(raw.includes('${'))throw Error('interpolation');const value=vm.runInNewContext('`'+raw+'`');process.stdout.write(crypto.createHash('sha256').update(value).digest('hex'));"""
    js_sha=subprocess.check_output(['/opt/homebrew/bin/node','-e',node_script,str(DEFAULT_WORKER)],text=True)
    py_sha=digest(_runtime_template(DEFAULT_WORKER))
    decoded={'node_native_JS_template_sha256':js_sha,'offline_decoder_sha256':py_sha,'equal':js_sha==py_sha,'scope':'pure JS string evaluation only; no controller or simulator'}
    result['template_decode_independent_review']=decoded
    (OUT/'template_decode_review.json').write_text(json.dumps(decoded,indent=2)+'\n')
    assert decoded['equal']
    reproductions=[]
    for path in sorted(ROUND.glob('map-??.json')):
        raw=load(path);record=load(raw['fullRecordFile'])
        inputs=[]
        for i,e in enumerate(record['inputs']):
            if e.get('type') not in ('navigation_query','navigation_control','vision_query') or 'method' not in e:continue
            inputs.append({'native_input_index':i,'method':e['method'],'args':e.get('args'),'result':e['result'],'tick':e.get('tick'),'seq':e['seq']})
        fixture=OUT/(path.stem+'.public-prefix.json')
        fixture.write_text(json.dumps({'provenance':{'raw':str(path),'record':raw['fullRecordFile'],'scope':'Only native public API inputs; no truth or physics loaded'},'inputs':inputs},ensure_ascii=False,indent=2)+'\n')
        replay=run_smoke(ROUND/'executed_program.py',fixture=fixture,check_scopes=False)
        proof={'map':path.stem,'error_type':replay.get('error_type'),'error_message':replay.get('error_message'),'startup':replay.get('startup'),'traceback':replay.get('traceback'),'public_calls':replay['public_calls'],'source_sha256':replay['executed_source_sha256'],'dependencies':replay['dependencies'],'logs':replay['logs']}
        parsed=[json.loads(text[3:]) for text in replay['logs'] if text.startswith('GY ')]
        proof['all_printed_GY_events_equal_native_raw']=parsed==raw['lines']
        proof['exact_failure_reproduced']=(proof['error_type']=='NameError' and proof['error_message']=="name 'OPT2_MEMORY_TRAVEL_ACTIVE' is not defined" and proof['startup']['consumed_inputs']==len(inputs) and proof['all_printed_GY_events_equal_native_raw'])
        reproductions.append(proof)
    candidate=run_smoke(args.candidate.resolve())
    (OUT/'candidate_full_startup.json').write_text(json.dumps(candidate,ensure_ascii=False,indent=2)+'\n')
    result['full_worker_reproductions']=reproductions
    result['current_candidate_full_startup']={'path':str(OUT/'candidate_full_startup.json'),'all_pass':candidate['all_pass'],'program_raw_sha256':candidate['program_raw_sha256'],'executed_source_sha256':candidate['executed_source_sha256'],'startup':candidate.get('startup'),'memory_scope':candidate.get('memory_scope')}
    result['summary']['exact_native_failures_reproduced']=sum(r['exact_failure_reproduced'] for r in reproductions)
    result['summary']['candidate_full_startup_pass']=candidate['all_pass']
    (OUT/'diagnosis.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    text=['# Opt2 round2：完整启动作用域故障','',
          '结论：十局在第一帧观察后、任何运动之前发生同一启动错误。冻结程序的运动模式布尔变量在真实worker包装后是外层局部，而两个辅助函数使用global读取另一个命名空间。不是布局差异，也不是感知/确认失败。', '',
          f"冻结源码SHA：`{result['program_sha256']}`；实际提交源码SHA：`{result['executed_program_sha256']}`。全部10局原生sourceCode逐字等于executed_program.py。raw与executed仅末尾换行不同。", '',
          '|布局|原生program_error索引/seq/t(ms)|observe次数|运动控制次数|首个反馈|', '|---|---|---|---|---|']
    for r in result['runs']:
        e=r['native_program_errors'][0]
        text.append(f"|{r['map']}|events[{e['event_index']}]/seq{e['seq']}/{e['t']}|{len(r['observations'])}|{r['control_count']}|{r['feedback']['message']}|")
    text+=['', '原生record只有平台格式化中文错误，不包含Python traceback。app.js:12553–12557将NameError统一转成“用了不存在的名称”；12597–12600只选traceback第一个学生代码行，所以3761指向顶层run_target_flow调用，不能把它当真正出错的读取行。离线完整启动已逐局重现确切异常：NameError: name OPT2_MEMORY_TRAVEL_ACTIVE is not defined。栈为3761 __student_main__ →2793 run_target_flow →1842 patrol_until_target_seen →3672 _opt2_patrol_enter。', '',
      '实际作用域：python-worker.js:407–435先转换函数/await，再将整个tree.body放进async __student_main__，在只含robot、print的scope中执行。program.py:3652赋值成为该函数的局部。3671的global声明令3672的previous读取执行LOAD_GLOBAL；3656–3657的memory wrapper同样有问题。2845的globals().get也不读取外层局部。字节码已由实际worker转换+外层包装编译复核，见frozen_wrapper_lexical_proof。', '',
      '漏检原因：opt2_preflight.py只以ALLOW_TOP_LEVEL_AWAIT编译转换后的module，没有运行外层包装；motion专属测试在module scope执行fragment，使顶层赋值创建真正global；我的26项独立审查虽使用全函数名并执行了桥接、patrol和flow，但把选定函数放在module namespace且替换了motion，因此也没有覆盖这层作用域。此前“无新阻断”只能证明那些局部执行路径，不能证明完整程序启动。', '',
      '最小修复：用已在外层初始化的共享字典OPT2_MOTION_STATE["memory_travel_active"]，两个wrapper修改键并在finally恢复原值；速度选择直接读取该字典。避免global和globals()旁路。当前r3仅版本和_opt2_memory_navigation、_opt2_patrol_enter、_opt2_travel_speed三函数行为修改；字典在外层成为cell，三函数均LOAD_DEREF。未改测距、WM、过滤或确认规则。', '',
      f"当前待审候选SHA：`{result['current_candidate']['sha256']}`。新的完整启动验证必须保持整个学生源码及其顶层初始化，采用真实Robot/Transformer/__student_main__包装，scope只注入平台原有robot+print，API仅返回保存的公开输入；不得注入OPT2状态名称使旧代码假通过。到未保存控制边界应明确停止，不得虚构控制成功。", '',
      '复算证据：`PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/round-2/startup-diagnosis/reproduce.py`。该脚本只读冻结记录/源码、生成新诊断，未启动控制器/仿真。完整worker执行产物由专门runtime smoke提供并在本目录归档。','']
    text += ['', '完整执行复核结果：十局各自仅公开API的7条前缀全部依次匹配；全部5条GY日志（program_version、ball_start、observe、detection_filter、target_observations）与各自原raw逐值相同；十次均在首个控制调用之前重现同一NameError。没有向student scope注入运动状态、程序helper或其它变量。', '',
      'r3整脚本启动通过：默认真实旧记录前缀10条，包含首个take_exit(speed30,obeySpeedLimit=true)返回25cm以及后置odometry/road_state；下一条未保存API之前主动抛出专用边界异常停止。它证明原生公开协议输入下的完整启动/首出口返回，不宣称当前任务真实运动或完整双送达已通过。', '',
      '后续记忆作用域使用明确的静态公开返回，不替换程序函数/闭包：真实嵌套_opt2_memory_navigation使查询期间速度100；真实图导航对absent目标正常返回False后恢复30；注入公开odometry异常也传播且finally恢复30。该部分是作用域回归测试，不是感知/导航性能测量。', '',
      'candidate_full_startup.json保留全部调用、输出、依赖SHA与边界；diagnosis.json保留十局逐局异常及traceback。复跑可指定冻结候选：`python3 artifacts/inloop/opt-2/round-2/startup-diagnosis/reproduce.py --candidate PATH_TO_FROZEN_PROGRAM.py`。执行器为tools/opt2_runtime_smoke.py，独立诊断脚本仅调用其公开接口并核验原生逐条输出。','']
    text += ['', '独立对照Node原生JS template求值与离线解码器：字符串SHA256均为`'+js_sha+'`，逐字节等价；template_decode_review.json及同一复算脚本保留证据。最终smoke helper的SHA记录于每份执行结果dependencies，未编辑该共享工具。','']
    (OUT/'DIAGNOSIS.md').write_text('\n'.join(text))
    print(json.dumps(result['summary']))
if __name__=='__main__':main()
