#!/usr/bin/env python3
"""Replay saved bridge inputs only. No controller or simulator is loaded."""
import ast
import hashlib
import json
import math
from pathlib import Path
import sys

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[4]
sys.path.insert(0, str(ROOT / 'vendor/wm_kit_opt2'))
from world_model.core import WorldModel
from world_model.decay import DecayConfig, FovConfig, is_in_fov
from world_model.providers.guangyang import guangyang_static_association_config, observation_to_detection, odometry_to_pose

def load(p): return json.loads(Path(p).read_text())
def snapshot(wm):
    return [{'id':o.obj_id,'state':o.state.value,'hit':o.hit_count,'conf':round(o.confidence,3),'x':round(o.x,3),'z':round(o.z,3)} for o in wm.get_scene() if o.name=='target']
def detail(o):
    return None if o is None else {'id':o.obj_id,'x':o.x,'z':o.z,'state':o.state.value,'confidence':o.confidence,'hit':o.hit_count,'miss':o.miss_count,'last_seen':o.last_seen,'last_updated':o.last_updated}
def api():
    tree=ast.parse((OUT.parent/'program.py').read_text())
    chosen=[]
    for n in tree.body:
        if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='RANGE_CAL' for t in n.targets): chosen.append(n)
        if isinstance(n,ast.FunctionDef) and n.name in ('calibrate_reading','calibrated_detection'):chosen.append(n)
    scope={'math':math,'observation_to_detection':observation_to_detection}
    exec(compile(ast.Module(body=chosen,type_ignores=[]),'<frozen_bridge_functions>','exec'),scope)
    return scope['calibrated_detection']
CAL=api()

def replay(path):
    raw=load(path); lines=raw['lines']
    models={name:WorldModel(assoc_cfg=guangyang_static_association_config(),decay_cfg=DecayConfig(),fov_cfg=FovConfig(max_range_m=.9)) for name in ('baseline','every_bridge_frame','empty_only_when_no_raw_red','empty_only_when_no_eligible_red')}
    pending=None; frames=[]; confirmations=[]; mismatches=[]; lost=[]; last_tick=0
    for i,e in enumerate(lines):
        kind=e.get('event')
        if kind=='observe':
            pending={'line':i,'entry':e};last_tick=e['tick']
        elif kind=='target_observations':
            assert pending is not None
            ob=pending['entry'];now=ob['tick']*.02
            assert 'odo' in ob, (path,i,'missing public odometry')
            pose=odometry_to_pose(dict(zip(('rightCm','forwardCm','headingDeg'),ob['odo'])))
            detections=[]
            for item in e['items']:
                matches=[r for r in ob['raw'] if r['category']=='target' and r['distanceCm']==item['distanceCm'] and r['bearingDeg']==item['bearingDeg']]
                assert len(matches)==1,(path,i,matches)
                detections.append(CAL(matches[0],pose,now))
            fr={'observe_line':pending['line'],'bridge_line':i,'tick':ob['tick'],'seconds':now,'odo':ob['odo'],'raw_red':[r for r in ob['raw'] if r['category']=='target'],'fed':len(detections),'outside_window':e['outside_window'],'models':{}}
            for mode,wm in models.items():
                before={o.obj_id:detail(o) for o in wm.get_scene()}
                visible={o.obj_id:is_in_fov(o.x,o.z,pose,wm.fov_cfg) for o in wm.get_scene()}
                called=bool(detections) or mode=='every_bridge_frame' or (mode=='empty_only_when_no_raw_red' and not fr['raw_red']) or (mode=='empty_only_when_no_eligible_red' and e['seen']==0)
                if called:wm.update(detections,pose,now=now)
                after={key:detail(wm.get_object(key)) for key in before}
                fr['models'][mode]={'called':called,'before':before,'after':after,'in_body_fov_before':visible,'active':snapshot(wm)}
                for key,value in after.items():
                    if before[key]['state']!='lost' and value['state']=='lost':lost.append({'mode':mode,'observe_line':pending['line'],'bridge_line':i,'tick':ob['tick'],'track_id':key,'before':before[key],'after':value,'body_fov':visible[key],'raw_red':fr['raw_red']})
            frames.append(fr)
        elif kind=='wm_targets':
            actual=snapshot(models['baseline'])
            if actual!=e['tracks']:mismatches.append({'line':i,'logged':e['tracks'],'replayed':actual})
        elif kind=='wm_action_removed':
            for wm in models.values():wm.mark_removed(e['track_id'],e['tick']*.02)
        elif kind=='memory_confirmed':
            results={name:detail(wm.get_object(e['track_id'])) for name,wm in models.items()}
            confirmations.append({'line':i,'tick':last_tick,'track_id':e['track_id'],'models':results,'every_frame_retained_confirmation':bool(results['every_bridge_frame'] and results['every_bridge_frame']['state']=='confirmed' and results['every_bridge_frame']['hit']>=3)})
    return {'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'snapshot_mismatches':mismatches,'logged_snapshot_count':sum(e.get('event')=='wm_targets' for e in lines),'frames':frames,'confirmations':confirmations,'lost_transitions':lost}

def main():
    runs=[replay(p) for folder in (ROOT/'artifacts/inloop/opt-2/round-1',ROOT/'artifacts/inloop/opt-1/round-2') for p in sorted(folder.glob('map-??.json'))]
    summary={'runs':len(runs),'baseline_snapshots_checked':sum(r['logged_snapshot_count'] for r in runs),'baseline_snapshot_mismatches':sum(len(r['snapshot_mismatches']) for r in runs),'original_confirmations':sum(len(r['confirmations']) for r in runs),'retained_confirmations_every_frame':sum(c['every_frame_retained_confirmation'] for r in runs for c in r['confirmations']), 'retained_confirmations_no_eligible_red':sum(bool(c['models']['empty_only_when_no_eligible_red'] and c['models']['empty_only_when_no_eligible_red']['state']=='confirmed' and c['models']['empty_only_when_no_eligible_red']['hit']>=3) for r in runs for c in r['confirmations'])}
    result={'scope':'fixed saved trajectory replay; not a claim about changed online trajectories','summary':summary,'runs':runs,'visibility':{'horizontal_fov_deg':75.2,'body_min_m':.15,'body_max_m':.9,'in_fov_half_life_s':1.5,'out_of_fov_half_life_s':60,'raw_window':[40,90],'note':'existing body FOV is not equivalent to calibrated camera raw window; red excluded/outside must not automatically count as miss'}}
    result['source_sha256']={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in
        [OUT.parent/'program.py',Path(__file__),*sorted((ROOT/'vendor/wm_kit_opt2/world_model').rglob('*.py'))]}
    text=['# 空观测桥接的保存轨迹回放','',
      '范围：只重放公开observe原始数据、odo、timestamp、target_observations中实际fed选择及已验证holding后的mark_removed；没有加载控制器、场景或真值。调用冻结程序原有标定函数和提交326a5f8892b9da11996b5f3d3d0fc56341aca6e4的WM实现。源SHA和每帧前后对象都在JSON。', '',
      f"opt2-r1及opt1-r2共{summary['runs']}局，原桥接重现{summary['baseline_snapshots_checked']}个WM快照，逐值差异{summary['baseline_snapshot_mismatches']}。原{summary['original_confirmations']}次确认，所有bridge帧无条件更新仅保留{summary['retained_confirmations_every_frame']}次；仅无eligible red的帧补空更新保留{summary['retained_confirmations_no_eligible_red']}次。", '',
      'eligible red以真实target_observations.seen为准：此时置信过滤、调用方类别过滤及成功送达区域排除已经执行；窗外和封顶的未排除红仍计seen。只在原_update_wm调用点补更新，不额外创造observe、不改非空检测融合。', '',
      '|批次/布局|原确认日志L/tick|无条件更新|无eligible red才空更新|', '|---|---|---|---|']
    for r in runs:
        for c in r['confirmations']:
            guarded=c['models']['empty_only_when_no_eligible_red']
            text.append(f"|{Path(r['path']).parent.parent.name}/{Path(r['path']).parent.name}/{Path(r['path']).stem}|L{c['line']}/t{c['tick']}|{c['every_frame_retained_confirmation']}|{guarded['state']}, hit={guarded['hit']}, conf={guarded['confidence']:.6f}|")
    text+=['', '实际回归反例：opt2 01/03 L230 tick2056 raw=93cm/0.69°/.83，WM已2hit且confidence .903，上次更新tick857；旧body FOV判断visible，若误喂empty，在23.98秒间隔按1.5秒半衰期降到1.3906618888768367e-5并归档。opt1-r2 01/03对应L227。opt1-r2 09 L359 tick3680为100cm/−9.83°/.85，若把此封顶方位当miss则confidence .10921255139620113/LOST。窗外红保护必要，不能仅以fed==0补空更新。', '',
      '保护模式仍按既有DecayConfig/FovConfig计算，不新增常数：body范围.15–.9m、水平75.2°，可见漏检半衰1.5秒，视野外60秒。该body域与M5反算raw 40–90cm不等同；不能把窗外观测宣称没有看见。原生WM在非空帧仍对未关联轨迹执行同一衰减，未改动。', '',
      '|批次/布局|保护模式新增/重现的LOST|此前→之后confidence|该次raw红|', '|---|---|---|---|']
    for r in runs:
        for e in r['lost_transitions']:
            if e['mode']!='empty_only_when_no_eligible_red':continue
            text.append(f"|{Path(r['path']).parent.parent.name}/{Path(r['path']).parent.name}/{Path(r['path']).stem}|L{e['observe_line']}/t{e['tick']} {e['track_id']}|{e['before']['confidence']:.9f}→{e['after']['confidence']:.9f}|{json.dumps(e['raw_red'],ensure_ascii=False)}|")
    text += ['', '04/06 target002的LOST原本就在另一个tentative target003入库时发生；单加空更新不会修复旧ID锁死。需要只在锁定对象真正LOST时解除当前确认ID/accepted_hits，保留归档历史与已测道路几何。target003在原桥接此后无fed更新而保留；保护模式在04 t9825、06 t10697归档。07的未确认false target001在t13712归档。', '',
      '已送达红排除之后对其他对象的漏检评估：这轮26条排除中23条严格对应已送达球、0条对应剩余球；因此当前记录没有把真剩余球误当missing的证据。独立几何对应见diagnosis.json。不能据此泛化为任意释放半径/遮挡均可靠，也不建议扩大排除半径。', '',
      '固定轨迹局限：保留20次确认仅说明相同公开输入序列下，保护桥接未打断其WM三命中。返回巡逻、清锁及释放ray会改变后续动作和输入；并未离线“证明下一局成功”。尤其成功05曾空红后继续capped ray，提前退出会改变其第二球路径，须按既定轮次整局验证。', '',
      '复算：`PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/round-1/selection-diagnosis/replay_empty_updates.py`。L均为raw.lines零基索引。', '']
    (OUT/'EMPTY_UPDATE_REPLAY.md').write_text('\n'.join(text))
    (OUT/'empty_update_replay.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(summary))
    for r in runs:
        print(Path(r['path']).parts[-2],Path(r['path']).stem,'confirm',[(c['line'],c['tick'],c['every_frame_retained_confirmation']) for c in r['confirmations']], 'new-lost',[(e['observe_line'],e['tick'],e['track_id'],e['body_fov'],e['after']['confidence']) for e in r['lost_transitions'] if e['mode']=='empty_only_when_no_eligible_red'])
if __name__=='__main__':main()
