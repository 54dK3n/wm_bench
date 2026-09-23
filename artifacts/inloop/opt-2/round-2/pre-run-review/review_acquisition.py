#!/usr/bin/env python3
"""Execute selected real bridge functions transformed with ALL full-program names.

Offline review only: public navigation/event access is replaced by explicit test
adapters; the WM, calibration, bridge, target-ID and expiry logic are real code.
No robot controller, navigation runner or simulation is loaded.
"""
import argparse
import ast
import asyncio
import contextlib
import hashlib
import io
import json
import math
from pathlib import Path
import sys

OUT=Path(__file__).resolve().parent
ROOT=OUT.parents[4]
sys.path.insert(0,str(ROOT/'vendor/wm_kit_opt2'))
from world_model import WorldModel
from world_model.association import associate
from world_model.decay import DecayConfig, FovConfig
from world_model.providers.guangyang import guangyang_static_association_config, observation_to_detection
from world_model.types import Detection,ObjectState,RobotPose


def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()

def check(program):
    source=program.read_text();tree=ast.parse(source)
    funcs={n.name:n for n in tree.body if isinstance(n,ast.FunctionDef)}
    names={n.name for n in ast.walk(tree) if isinstance(n,ast.FunctionDef)}
    need={'_is_target','calibrate_reading','calibrated_detection','_update_wm','_pose_log','_demo_detection_excluded','_wm_target','_demo_reset_ball','_demo_lock_target','run_target_flow','patrol_until_target_seen'}|{n for n in names if n.startswith('_opt2_') and ('selection' in n or 'observations' in n or 'planning_evidence' in n or 'confirmation_should' in n or 'has_red' in n)}
    required={'_opt2_has_red','_opt2_clear_lost_selection','_opt2_update_observations','_opt2_planning_evidence_expired','_opt2_confirmation_should_abort'}
    assert required <= need <= funcs.keys(), 'Complete new production build is required'
    worker=Path('/Users/ken/Desktop/robot_competition-main/projects/car-python/python-worker.js')
    text=worker.read_text();loader={'ast':ast}
    exec(text[text.index('class AsyncRobotTransformer('):text.index('student_run_target =')],loader)
    selected=ast.Module(body=[funcs[n] for n in sorted(need)],type_ignores=[])
    transformed=loader['AsyncRobotTransformer'](names).visit(selected);ast.fix_missing_locations(transformed)
    no_async_generators=not any(isinstance(n,ast.GeneratorExp) and any(isinstance(x,ast.Await) for x in ast.walk(n)) for n in ast.walk(transformed))
    compiled=compile(transformed,'<real-transformed-acquisition>','exec')
    config={}
    for n in tree.body:
        if isinstance(n,ast.Assign):
            for target in n.targets:
                if isinstance(target,ast.Name) and target.id in ('RANGE_CAL','CONFIRM_MIN_CM','CONFIRM_MAX_CM','DEMO_REQUIRED_TARGETS','MAX_OBSERVES','PATROL_OBSERVE_BUDGET'):
                    config[target.id]=ast.literal_eval(n.value)
    checks=[];captured=io.StringIO()
    def verify(name,condition,**details):
        checks.append({'name':name,'pass':bool(condition),**details})
        assert condition, name
    def namespace():
        wm=WorldModel(assoc_cfg=guangyang_static_association_config(),decay_cfg=DecayConfig(),fov_cfg=FovConfig(max_range_m=.9))
        pose=RobotPose(0,0,0)
        wm.update([Detection(class_name='target',x=0,z=.65,confidence=.9,timestamp=0)],pose,now=0)
        obj=wm.get_scene()[0]
        events=[]
        state={'confirmation_track_id':obj.obj_id,'accepted_hits':[{'track_id':obj.obj_id}], 'frame_track_ids':{},'observe_count':12,'approach_calls':1}
        vp={'roads':{'retained':1},'intervals':{'retained':2},'local_blocks':{'retained':3}}
        async def nav():return {'tick':266,'rightCm':0,'forwardCm':0,'headingDeg':0}
        async def event(name,**kw):events.append({'event':name,**kw})
        # Ranking is outside this bounded bridge test. Select the only remaining
        # memory object when the actual _wm_target calls the memory adapter.
        async def memory():return next(iter(wm.get_scene()),None)
        async def lock(target):state['confirmation_track_id']=target.obj_id;return target
        ns={'wm':wm,'math':math,'json':json,'ObjectState':ObjectState,'associate':associate,
            'observation_to_detection':observation_to_detection,'STATE':state,'VP_STATE':vp,
            'DEMO_STATE':{'deliveries':[],'delivered_track_ids':set(),'collected_track_ids':set(),'ball_index':2,'selection_snapshot':{},'ball_start_track_ids':set(),'target_source':'new_observations'},
            'DELIVERY_LOG':{'on':False},'nav_odometry':nav,'_demo_event':event,'_demo_memory_target':memory,'_demo_lock_target':lock,**config}
        exec(compiled,ns)
        return ns,pose,obj,events
    async def exercise():
        verify('no_await_in_generators',no_async_generators)
        for distance in (29,93,100):
            ns,pose,obj,events=namespace()
            red=[{'category':'target','distanceCm':distance,'bearingDeg':.69,'confidence':.83}]
            await ns['_opt2_update_observations'](red,pose,25)
            verify(f'raw_{distance}_positive_red_not_miss',obj.confidence==.9 and obj.state==ObjectState.TENTATIVE and ns['STATE']['confirmation_track_id']==obj.obj_id)
        ns,pose,obj,events=namespace()
        await ns['_opt2_update_observations']([],pose,5.32)
        verify('real_empty_archives_and_unlocks',obj.state==ObjectState.LOST and ns['STATE']['confirmation_track_id'] is None and not ns['STATE']['accepted_hits'])
        verify('history_and_non_target_state_preserved',ns['wm'].get_object(obj.obj_id) is obj and obj.hit_count==1 and ns['STATE']['observe_count']==12 and ns['STATE']['approach_calls']==1 and ns['VP_STATE']['roads']=={'retained':1} and ns['VP_STATE']['intervals']=={'retained':2} and ns['VP_STATE']['local_blocks']=={'retained':3})
        verify('old_goal_expires',await ns['_opt2_planning_evidence_expired']({'source':'world_model','track_id':obj.obj_id},[]))
        verify('abandon_return_does_not_abort_patrol',not await ns['_opt2_confirmation_should_abort']())
        ns,pose,old,events=namespace()
        red=[{'category':'target','distanceCm':64,'bearingDeg':35.45,'confidence':.90}]
        await ns['_opt2_update_observations'](red,pose,5.32)
        new=[o for o in ns['wm'].get_scene() if o.obj_id!=old.obj_id]
        verify('same_frame_old_lost_new_track_retained',old.state==ObjectState.LOST and len(new)==1 and ns['STATE']['frame_track_ids'].get(id(red[0]))==new[0].obj_id and ns['STATE']['confirmation_track_id'] is None)
        verify('old_goal_lost_even_with_new_red',await ns['_opt2_planning_evidence_expired']({'source':'world_model','track_id':old.obj_id},red))
        verify('new_track_not_immediately_called_confirmation_failure',not await ns['_opt2_confirmation_should_abort']())
        verify('new_memory_remains_selectable',await ns['_wm_target']() is new[0])
        verify('capped_ray_positive_kept',not await ns['_opt2_planning_evidence_expired']({'source':'capped_bearing_only'},[{'category':'target','distanceCm':100}]))
        verify('capped_ray_new_empty_expires',await ns['_opt2_planning_evidence_expired']({'source':'capped_bearing_only'},[]))
        # Exercise the actual patrol loop: expired confirmation returns none,
        # the abort hook consumes the reason, then patrol observes and chooses
        # the next track. Public movement is an explicit adapter, not physics.
        ns,pose,old,events=namespace()
        trace=[]; phase={'observes':0}
        async def patrol_pose():return pose,{'onRoad':True,'exits':[{'roadId':'offline-public-road'}]}
        async def can_observe():return True,{}
        async def observe(*args,**kwargs):
            phase['observes']+=1;ns['STATE']['observe_count']+=1
            return [] if phase['observes']==1 else [{'category':'target','distanceCm':64,'bearingDeg':0,'confidence':.9}]
        async def first_expires_then_confirms(p,observations):
            if phase['observes']==1:
                assert await ns['_opt2_planning_evidence_expired']({'source':'world_model','track_id':old.obj_id},observations)
                return None
            return await ns['_wm_target']()
        async def enter(road):trace.append(('enter',road));return True
        async def follow(distance,speed):trace.append(('follow',distance,speed));return {'stoppedBy':'max_distance'}
        ns.update(_vp_remember=patrol_pose,_observe_motion=can_observe,counted_observe=observe,
                  _try_enter_range_and_confirm=first_expires_then_confirms,
                  _opt2_patrol_enter=enter,_opt2_patrol_follow=follow)
        chosen=await ns['patrol_until_target_seen']()
        verify('actual_patrol_lost_goal_continues_to_new_track',chosen is not None and chosen.obj_id=='target_002' and phase['observes']==2 and len(trace)==2)
        verify('actual_patrol_preserves_global_observe_count',ns['STATE']['observe_count']==14)
        # Execute the actual orchestration around an expired remembered target.
        # Only the motion/confirmation subtask and post-confirmation grasp outcome
        # are explicit adapters, as documented; this is not a physical capture test.
        ns,pose,old,events=namespace()
        calls=[]
        async def remember():return pose,{'onRoad':True}
        async def stale_confirmation(current_pose,observations):
            calls.append('remembered_confirmation')
            await ns['_opt2_update_observations']([],current_pose,5.32)
            assert await ns['_opt2_planning_evidence_expired']({'source':'world_model','track_id':old.obj_id},[])
            return None
        async def patrol(max_obs):
            calls.append(('patrol',max_obs))
            ns['wm'].update([Detection(class_name='target',x=.8,z=.2,confidence=.9,timestamp=5.32)],pose,now=5.32)
            new=ns['wm'].get_scene()[0]
            await ns['_demo_lock_target'](new)
            return new
        async def stop_grasp(target):calls.append(('grasp_identity',target.obj_id));return False
        async def failed(stage,reason):calls.append(('stopped',stage,reason))
        ns.update(_vp_remember=remember,_try_enter_range_and_confirm=stale_confirmation,
                  patrol_until_target_seen=patrol,approach_target_with_world_model=stop_grasp,_demo_fail=failed)
        await ns['run_target_flow']()
        verify('memory_expiry_reenters_patrol_in_actual_flow',sum(isinstance(c,tuple) and c[0]=='patrol' for c in calls)==1 and any(e['event']=='memory_search_resumed' for e in events))
        verify('memory_fallback_consumes_abandon_flag',not ns['STATE'].get('planning_goal_abandoned',False))
        verify('flow_reaches_new_identity_after_fallback',('grasp_identity','target_002') in calls and old.state==ObjectState.LOST)
        verify('new_after_ball_start_has_new_observations_source',ns['DEMO_STATE']['target_source']=='new_observations' and ns['STATE']['confirmation_track_id']=='target_002')
        # A track already present at ball start keeps the memory source label.
        ns['DEMO_STATE']['ball_start_track_ids'].add('target_002')
        await ns['_demo_lock_target'](ns['wm'].get_object('target_002'))
        verify('retained_identity_has_memory_source',ns['DEMO_STATE']['target_source']=='memory')
    with contextlib.redirect_stdout(captured):asyncio.run(exercise())
    # Inspect actual integrated source, not the helper-only builder function.
    patrol=funcs['patrol_until_target_seen']
    verify('two_patrol_abort_hooks_integrated',sum(isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='_opt2_confirmation_should_abort' for n in ast.walk(patrol))==2)
    verify('three_real_observe_update_hooks',sum(isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='_opt2_update_observations' for n in ast.walk(tree))==3)
    verify('no_expiry_in_geometry_only_planning_goal',not any(isinstance(n,ast.Name) and n.id=='_opt2_planning_evidence_expired' for n in ast.walk(funcs['_planning_goal'])))
    previous=ROOT/'artifacts/inloop/opt-2/round-1/program.py'
    oldtree=ast.parse(previous.read_text());oldfuncs={n.name:n for n in oldtree.body if isinstance(n,ast.FunctionDef)}
    freshfuncs={n.name:n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef)}
    protected=['_update_wm','calibrate_reading','calibrated_detection','_record_hit','_record_candidate_sample','_in_range_candidates','_confirmation_result','counted_observe','_planning_goal','_demo_filter_observations','_demo_observation_eligible','_demo_detection_excluded','detection_filter_update']
    verify('13_original_perception_confirmation_functions_unchanged',all(ast.dump(oldfuncs[n],include_attributes=False)==ast.dump(freshfuncs[n],include_attributes=False) for n in protected),functions=protected)
    def constants(t):
        return {target.id:ast.dump(n.value,include_attributes=False) for n in t.body if isinstance(n,ast.Assign) for target in n.targets if isinstance(target,ast.Name) and (target.id.startswith('CONFIRM_') or target.id=='_WM_ZIP_BYTES')}
    verify('confirmation_constants_and_WM_embedding_unchanged',constants(oldtree)==constants(ast.parse(source)))
    return {'scope':__doc__,'program':str(program),'program_sha256':sha(program),'worker_sha256':sha(worker),'full_program_function_names_count':len(names),'checks':checks,'all_pass':all(c['pass'] for c in checks),'stdout':captured.getvalue(),'test_adapters':['public nav_odometry','event logger','single-object memory ranking; actual lock/source function executes','memory confirmation task invokes real empty bridge then returns none','patrol task supplies new identity; actual flow/source executes','post-confirmation grasp returns false to stop before delivery','patrol public road/observe/movement and confirmation outcome adapters; actual patrol/bridge/WM executes']}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('program',type=Path);args=parser.parse_args()
    result=check(args.program.resolve())
    (OUT/'acquisition_review.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    lines=['# Acquisition独立预运行审查','',f"实际完整程序SHA256：`{result['program_sha256']}`。完整函数名集合{result['full_program_function_names_count']}个，实际平台AsyncRobotTransformer转换后执行，{len(result['checks'])}项全部通过。没有启动仿真。", '',
      '执行覆盖真实_update_wm/标定/WorldModel、无红帧桥接、窗外29/93/100cm保护、同帧旧轨迹LOST且新轨迹保留、LOST目标退出、实际patrol继续导航并选择新轨迹、记忆分支在失效后回巡逻，以及每球起始已知ID对应memory/new_observations来源。', '',
      '测试边界：道路查询、observe和运动为明确的离线适配器；记忆分支的确认任务只负责制造目标过期、后续确认成功和抓取停止点，不模拟物理或声明新局成功。真实WM/原标定/桥接/身份锁/巡逻及主流程均实际执行。完整适配器清单见JSON。', '',
      '曾发现的两个阻断已修复：any(_is_target(...) for ...)被显式循环替代，避免异步生成器；旧轨迹失效返回None后，patrol两处已消费abandoned标记，防止立刻重选新轨迹并误报整球确认失败。memory分支也进入巡逻。', '',
      '原始感知/校准/过滤/确认等13个函数AST与round1相同；CONFIRM_*常量及WM嵌入包AST相同。原每帧原始红蓝日志及过滤决策保留；新增empty更新只发生在实际新observe已执行且经过原过滤/交付排除后没有任何红时。窗外/封顶红不会被range clipping伪装成miss。', '',
      '|检查|结果|','|---|---|']
    lines += [f"|{c['name']}|{'PASS' if c['pass'] else 'FAIL'}|" for c in result['checks']]
    lines += ['', '固定轨迹回放证据见[EMPTY_UPDATE_REPLAY.md](/Users/ken/Desktop/wm_bench/artifacts/inloop/opt-2/round-1/selection-diagnosis/EMPTY_UPDATE_REPLAY.md)：20局67个原快照零差异，受保护empty模式保留20/20原确认。此结果不能替代新策略在线轨迹检验，成功05的射线失联提前返回可能改变路径。', '',
      '复算：`PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/round-2/pre-run-review/review_acquisition.py programs/world_model_opt2.py`。全部脚本与产物仅位于新增审查目录，原程序及共享工具未修改。','']
    (OUT/'ACQUISITION_REVIEW.md').write_text('\n'.join(lines))
    print(json.dumps({'all_pass':result['all_pass'],'checks':len(result['checks']),'program_sha256':result['program_sha256']}))
