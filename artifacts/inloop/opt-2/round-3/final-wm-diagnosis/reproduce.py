#!/usr/bin/env python3
"""Independent saved-native/WM identity audit. No simulator or program executes."""
import collections
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import statistics
import sys

OUT=Path(__file__).resolve().parent
ROUND=OUT.parent
ROOT=OUT.parents[4]
sys.path.insert(0,str(ROOT/'tools'))
from batch_report import letter, POSITIONS
from p3_offline_choice import evaluate_first_choice
from demo_timeline import reconstruct
BASE_AUDIT=ROOT/'artifacts/inloop/opt-2/round-1/selection-diagnosis/reproduce.py'
spec=importlib.util.spec_from_file_location('saved_identity_analysis',BASE_AUDIT)
legacy=importlib.util.module_from_spec(spec);spec.loader.exec_module(legacy)

def load(p):return json.loads(Path(p).read_text())
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def row(i,e):return {'line':i,'event':e}

def association(track, observation, initial):
    if track is None or observation is None or not observation['exact_render']:
        return {'status':'unknown','reason':'no_WM_or_exact_bound_render','label':None}
    candidates=[]
    for p in observation['targets']:
        pos=legacy.to_odo(p,initial)
        candidates.append({'package_id':p['id'],'distance_cm':math.dist([track['x'],track['z']],pos)*100,
                           'scene_position':[p['x'],p['z']],'odometry_m':pos})
    matches=[r for r in candidates if r['distance_cm']<=30 or math.isclose(r['distance_cm'],30,abs_tol=1e-9,rel_tol=0)]
    result={'status':'pass' if len(matches)==1 else 'fail' if not matches else 'unknown',
            'label':None,'candidates':candidates,'matches':matches,'observe_line':observation['line'],
            'tick':observation['tick'],'frame_id':observation['frame_id'],'image':observation['image'],
            'image_exists':observation['image_exists'],'image_hash_matches':observation['image_hash_matches']}
    if len(matches)==1:
        result.update(matches[0]);result['label']=letter(*matches[0]['scene_position'])
    return result

def analyse(path):
    data=legacy.run(path);raw=load(path);lines=raw['lines'];record=load(raw['fullRecordFile'])
    baseline_path=ROOT/'artifacts/inloop/opt-1/round-2'/path.name
    baseline=load(baseline_path)
    data['source_sha256'].update({str(p):sha(p) for p in (baseline_path,Path(baseline['fullRecordFile']))})
    initial=record['simulationDefinition']['initialPose']
    observations=data['observations']
    def previous_observation(i):return next((o for o in reversed(observations) if o['line']<=i),None)
    def ball_at(i):return sum(e['event']=='ball_start' for e in lines[:i+1])
    first_confirmed=[];seen=set()
    for item in data['wm_action_removals']:
        item['explicit_action_invalidation']=item['event']['confidence']==0 and item['event']['state']=='lost' and item['event']['removed'] is True
    for i,e in enumerate(lines):
        if e.get('event')!='wm_targets':continue
        for t in e['tracks']:
            if t['state']=='confirmed' and t['id'] not in seen:
                seen.add(t['id']);first_confirmed.append({'line':i,'ball_index':ball_at(i),'track':t,'association':association(t,previous_observation(i),initial)})
    for selection in data['selections']:
        selection['driver_association']=association(selection['track'],previous_observation(selection['line']),initial)
    repeat=[];consecutive=[]
    rawobs=[(i,e) for i,e in enumerate(lines) if e.get('event')=='observe']
    for (i,a),(j,b) in zip(rawobs,rawobs[1:]):
        shift=math.dist(a['odo'][:2],b['odo'][:2]);turn=abs((a['odo'][2]-b['odo'][2]+180)%360-180)
        proof={'prior_line':i,'line':j,'ticks':[a['tick'],b['tick']],'translation_cm':shift,'turn_deg':turn}
        consecutive.append(proof)
        if a['tick']==b['tick'] or (shift<5 and turn<10):repeat.append(proof)
    for ball in data['balls']:
        start=ball['start_line'];end=next((b['start_line'] for b in data['balls'] if b['start_line']>start),len(lines))
        local=list(enumerate(lines[start:end],start))
        confirm=next(((i,e) for i,e in local if e.get('event')=='memory_confirmed'),None)
        if confirm:
            trackid=confirm[1]['track_id']
            track=next((t for i,e in reversed(local) if i<confirm[0] and e.get('event')=='wm_targets' for t in e['tracks'] if t['id']==trackid),None)
            ball['confirmation_association']=association(track,previous_observation(confirm[0]),initial)
            hits=confirm[1]['hits']
            gaps=[math.dist([a['pose_x'],a['pose_z']],[b['pose_x'],b['pose_z']]) for j,a in enumerate(hits) for b in hits[j+1:]]
            ball['confirmation_rule_evidence']={'line':confirm[0],'same_track_id':all(h['track_id']==trackid for h in hits),
                'hit_count':len(hits),'raw_distances_cm':[h['distanceCm'] for h in hits],
                'all_pairwise_distances_m':gaps,'min_pose_distance_m':min(gaps) if gaps else None,
                'last_sample_wm_distance_m':confirm[1]['last_sample_wm_distance_m'],
                'pass':len(hits)>=3 and all(h['track_id']==trackid and 40<=h['distanceCm']<90 for h in hits)
                    and bool(gaps) and min(gaps)>=.15-1e-12 and confirm[1]['last_sample_wm_distance_m']>=.5}
        else:ball['confirmation_association']={'status':'unknown','label':None,'reason':'not_confirmed'}
        ball['diagnostic_selected_tracks']=[s for s in data['selections'] if start<=s['line']<end]
        ball['acquisition_events']=[row(i,e) for i,e in local if e.get('event') in ('range_entry_abandoned','target_search_abandoned','wm_empty_frame_update','confirmation_failed','confirmation_aborted','patrol_failed','observe_motion_violation')]
        obs=[(i,e) for i,e in local if e.get('event')=='observe']
        ball['last_observe']=row(*obs[-1]) if obs else None
        ball['raw_empty_frames']=sum(not e['raw'] for i,e in obs)
        ball['no_raw_red_frames']=sum(not any(r['category']=='target' for r in e['raw']) for i,e in obs)
        ball['no_eligible_red_frames']=sum(e.get('event')=='target_observations' and e['seen']==0 for i,e in local)
        ball['window_fed_detection_count']=sum(e['count'] for i,e in local if e.get('event')=='target_observations')
        ball['end_reason_events']=[row(i,e) for i,e in local if e.get('event') in ('ball_end','flow_end','navigation_budget_exhausted')]
        ball['last_memory_motion']=[row(i,e) for i,e in local if e.get('event') in ('approach_graph_selected','approach_frontier_step','approach_failed','memory_drive')][-5:]
        bstart=lines[start]['tick'];bend=lines[end]['tick'] if end<len(lines) else math.inf
        ball['native_grabs']=[e for e in data['native_grabs'] if bstart<=e['tick_from_native_t']<bend]
        ball['native_deliveries']=[e for e in data['native_deliveries'] if bstart<=e['tick_from_native_t']<bend]
        ball['approach_calls']=[row(i,e) for i,e in local if e.get('event')=='approach_call']
    data.update(first_confirmed_tracks=first_confirmed,phantom_confirmed=[c for c in first_confirmed if c['association']['status']=='fail'],
                confirmed_association_unknown=[c for c in first_confirmed if c['association']['status']=='unknown'],
                repeated_observes=repeat,consecutive_observe_motion=consecutive,
                observe_motion_violations=[row(i,e) for i,e in enumerate(lines) if e.get('event')=='observe_motion_violation'],
                native_program_errors=[{'event_index':i,**e} for i,e in enumerate(record['events']) if e.get('type')=='program_error'],
                native_grab_attempt_count=sum(e.get('interactionType')=='package_grab' for e in record['events']))
    return data

def map02_visibility_supplement(run):
    """Extend only the saved-report coverage, preserving its exact geometry policy."""
    raw_path=ROUND/'map-02.json';raw=load(raw_path);lines=raw['lines']
    timeline=reconstruct(raw_path);package='guangyang-target-2';track_id='target_002'
    ball=next(b for b in run['balls'] if b['ball_index']==2)
    candidates=[]
    for ob in timeline['observations']:
        for detection in ob['detections']:
            match=next((c for c in detection['candidates'] if c['package_id']==package),None)
            if match:
                candidates.append({**{k:v for k,v in ob.items() if k!='detections'},
                                   **detection,'matched_package':match})
    first_unique=next(c for c in candidates if c['unambiguous_uncapped'])
    wm_first=next((i,t) for i,e in enumerate(lines) if e.get('event')=='wm_targets'
                  for t in e['tracks'] if t['id']==track_id and t['hit']>0)
    wm_ob=next(o for o in reversed(timeline['observations']) if o['line_index']<=wm_first[0])
    wm_association=next(row(i,e) for i,e in reversed(list(enumerate(lines[:wm_first[0]])))
                        if e.get('event')=='wm_associations' and any(a['track_id']==track_id for a in e['items']))
    report=load(ROUND/'opt2_report.json')
    machine_ball=next(b for r in report['runs'] if r['map']=='map-02' for b in r['balls'] if b['ball_index']==2)
    return {'map':'map-02','ball_index':2,'package_id':package,'track_id':track_id,
        'frozen_report_original':{k:machine_ball.get(k) for k in ('first_seen_seconds','first_seen_basis','first_WM_accepted','first_WM_accepted_seconds','confirmed_seconds')},
        'root_cause':'demo_timeline.reconstruct enumerates packages only from actual successful target grabs/deliveries; ungrabbed target-2 has no timeline.balls entry, so opt2_report fallback yields None despite valid observations',
        'timeline_package_ids':[b['package_id'] for b in timeline['balls']],
        'first_seen_seconds':first_unique['seconds'],'first_seen_line':first_unique['line_index'],
        'first_seen_tick':first_unique['tick'],'first_seen_basis':'exact_render_unique_uncapped_raw_global_scan_using_frozen_timeline_geometry',
        'first_seen_evidence':first_unique,
        'first_WM_accepted_seconds':wm_ob['seconds'],'first_WM_accepted_line':wm_first[0],
        'first_WM_accepted_observe_line':wm_ob['line_index'],'first_WM_accepted_tick':wm_ob['tick'],
        'first_WM_accepted_basis':'wm_associations exact track_id then actual hit 0-to-1; track uniquely within30cm of D; raw identity in this initial frame has capped/uncapped multiplicity under timeline one-to-one rule',
        'first_WM_accepted_evidence':{'association':wm_association,'snapshot':row(wm_first[0],lines[wm_first[0]]),
                                      'driver_association':ball['diagnostic_selected_tracks'][0]['driver_association'],
                                      'observe':wm_ob},
        'earliest_global_raw_candidate':candidates[0],
        'earliest_ball2_raw_candidate':next(c for c in candidates if c['line_index']>=ball['start_line']),
        'all_candidates':candidates,'binding_problems':timeline['binding_problems'],
        'scope_note':'capped candidates are bearing-only, never distance evidence; first seen is full-run earliest non-capped one-to-one match, not earliest physical visibility; frozen report is not modified'}

def failure_notes(runs):
    notes=['',
      '归因先区分确认与后续步骤：03/04/06/08均已送达第一球，第二球未确认；07是第一球未确认，根本没有第二球阶段。02是第二球确认后未到抓取。01/09是第一球抓取后未送达。', '']
    for r in runs:
        end=r['flow_end'];e=end['event'];b=r['balls'][-1];last=b['last_observe'];ob=last['event']
        base=f"{r['map']}：最终L{end['line']}/t{e.get('tick')} {e.get('stage')}/{e.get('reason') or 'success'}，Q/C={e.get('navigation_queries')}/{e.get('navigation_controls')}，本球observe {b['observe_count']}，全局{len(r['observations'])}/92。"
        if r['map'] in ('map-01','map-09'):
            g=b['native_grabs'][0]
            detail=f"原生event[{g['event_index']}]在{g['seconds']:.2f}s/t{g['tick_from_native_t']:g}已抓{g['packageId']}；退出仍holding={e.get('holding')}，无package_delivered；不能归为确认失败或第一球capture退步。预算证据L{end['line']-1}查询1000/1000，未启动第二球。"
        elif r['map']=='map-02':
            detail='球2 target_002唯一关联新真D，确认误差5.3316cm（L1562/t9835，三点50/50/55cm，最小间距15.0053cm，末点0.728643m）。后续未调用approach、未grab、未发生轨迹LOST。L3467再选north-west-main@72.5：path=0cm、remainingBound=219.4128156126cm；L3468推进before=after=72.5cm、distance=0、stoppedBy=junction；L3476改选@88.1，path15.6cm、remainingBound207.0190654299cm，最终L3477查询预算1000/1000。属于真实确认后的记忆导航预算失败。'
        elif r['map'] in ('map-04','map-06'):
            selections=b['diagnostic_selected_tracks'];events=b['acquisition_events']
            lost=[q for q in events if q['event']['event']=='target_search_abandoned']
            empty=[q for q in events if q['event']['event']=='wm_empty_frame_update']
            desc=[]
            for s in selections:
                nearest=min(s['driver_association']['candidates'],key=lambda c:c['distance_cm'])
                desc.append(f"{s['track']['obj_id']} L{s['line']}/t{s['tick']}距最近真球{nearest['distance_cm']:.4f}cm")
            final=empty[-1]
            detail='；'.join(desc)+'，均超过30cm、无A–G编号，均1hit从未CONFIRMED，也不能认作已送达球的准确WM位置。'
            detail+='清锁事件'+','.join(f"L{q['line']}/t{q['event']['tick']}:{q['event']['previous_track_id']}" for q in lost)+'；'
            detail+=f"末次空帧衰减L{final['line']}/t{final['event']['tick']}把target_003从.2334263124降至.1233679117并LOST，然后巡逻继续。"
            detail+=f"球2原始空帧{b['raw_empty_frames']}、无红{b['no_raw_red_frames']}、无eligible red{b['no_eligible_red_frames']}；实际仅2个伪窗口观测入库。"
            detail+='4条已送达区排除全部严格匹配已经送达的target-2，0条匹配剩余真球，不支持排除误杀剩余球。'
            detail+=f"末次观察L{last['line']}/t{ob['tick']} odo={ob['odo']}、raw={json.dumps(ob['raw'],ensure_ascii=False)}；没有观察预算耗尽事件。"
        elif r['map'] in ('map-03','map-08','map-07'):
            rays=[q for q in b['acquisition_events'] if q['event']['event']=='range_entry_abandoned']
            detail=f"本球WM窗口入库{b['window_fed_detection_count']}、没有新WM轨迹，原始空帧{b['raw_empty_frames']}、无红{b['no_raw_red_frames']}。"
            detail+='失联封顶射线正常退出'+','.join(f"L{q['line']}/t{q['event']['tick']}" for q in rays)+'，随后巡逻。'
            detail+=f"末次观察L{last['line']}/t{ob['tick']} odo={ob['odo']}、raw={json.dumps(ob['raw'],ensure_ascii=False)}；"
            if r['map']=='map-07':detail+='末段lower-east两位姿[-46.6,152.4,-101.3]与[-74.8,171.8,47]来回，位移34.228643cm/转角148.3°，所以是巡逻覆盖不足，不能误计原地重复observe。'
            else:detail+='末帧没有可入库红球，确认失败不是已确认球遗失。'
        else:
            ids=[g['packageId'] for ball in r['balls'] for g in ball['native_grabs']]
            ds=[f"event[{g['event_index']}] {g['packageId']}@{g['seconds']:.2f}s" for ball in r['balls'] for g in ball['native_deliveries']]
            detail=f"两次抓取为不同package {ids}；原生送达为{'；'.join(ds)}，第二球不是已送达球或原位幻影。"
        notes.append('- '+base+detail)
    notes+=['',
      '03/04/06/07/08的最终日志stage为confirmation、reason为WorldModel未通过确认，并未直接打印巡逻步号。结合冻结程序program.py:1817的24步循环、末端1864的return None、本球观察数未达传入上限，且没有patrol_failed/confirmation_aborted/异常/预算耗尽事件，可归因为有限巡逻结束仍未确认；“24步耗尽”是源码和排除分支所得推断，不冒充日志显式值。',
      '04/06同样的局部伪轨迹被归档、03/08射线失联后退出，证明本轮新增释放旧搜寻锁机制确实触发；它没有自动解决后续巡逻覆盖和道路循环。这里不据离线轨迹推断任何未运行修复会成功。']
    return notes

def verify_report_consistency(runs):
    report=load(ROUND/'opt2_report.json');checks=[]
    for r in runs:
        frozen=next(x for x in report['runs'] if x['map']==r['map'])
        checks.append({'map':r['map'],'check':'started_ball_count',
                       'pass':len(r['balls'])==len([b for b in frozen['balls'] if b['started']])})
        for b in r['balls']:
            rb=next(x for x in frozen['balls'] if x['ball_index']==b['ball_index'])
            checks.append({'map':r['map'],'ball_index':b['ball_index'],'check':'observe_count',
                           'pass':rb['observes']==b['observe_count']})
            a=b['confirmation_association']
            if a['status']=='pass':
                truth=rb['WM_truth_association']['evidence']
                checks.append({'map':r['map'],'ball_index':b['ball_index'],'check':'WM_package_label_and_error',
                    'pass':a['package_id']==rb['package_id'] and a['label']==truth['position_label']
                           and abs(a['distance_cm']-truth['distance_cm'])<1e-9})
        checks.append({'map':r['map'],'check':'raw_native_vision_and_baseline_hashes_unchanged',
                       'pass':all(sha(p)==h for p,h in r['source_sha256'].items())})
    return {'all_pass':all(c['pass'] for c in checks),'count':len(checks),'checks':checks,
            'timeline_correction_is_explicit_not_a_consistency_failure':True}

def render(j):
    summary=j['summary'];rows=j['runs']
    text=['# 最终轮WM、确认与目标身份审计','',
      '只读保存轨迹/原生记录；L是raw.lines零基索引，原生event_index亦为零基。坐标编号只在离线报告中使用，WM与同tick精确renderTruth真球距离≤30cm且唯一匹配才编号；没有WM或未确认仍标unknown，不用最近目标/原始检测强行补标签。', '',
      f"本轮{summary['first_choice_matches']}/10首选与独立真值代价oracle一致；仅{summary['first_choices_evaluated']}局有首选，map07未选择不能记作成功。9次首选全部仅1个WM候选，其中{summary['first_choice_unknown_cost']}次运行时代价unknown并用唯一候选fallback。因此不是9次两已知WM候选排名验证。第一球真实抓取{summary['first_ball_captured']}/10，对opt1-r2的capture退步{summary['first_ball_capture_regressions']}局。", '',
      f"全部首次CONFIRMED轨迹{summary['confirmed_tracks']}条，phantom={summary['phantom_confirmed']}、身份unknown={summary['confirmed_unknown']}；实际observe {summary['observe_calls']}次、原地重复{summary['repeated_observes']}、guard违规{summary['observe_guard_violations']}、原生program_error {summary['program_errors']}。本轮结束；阶段2失败停止，不启动阶段3。", '',
      '|布局/球|确认标签及WM误差cm|确认L/tick|实际抓取/送达（秒）|observe / WM入库条数|结果|', '|---|---|---|---|---|---|']
    for r in rows:
        for b in r['balls']:
            a=b['confirmation_association'];c=b['confirmed'][0] if b['confirmed'] else None
            confirm=f"L{c['line']}/t{a.get('tick')}" if c else '未确认'
            identity=f"{a['label']} / {a['distance_cm']:.4f}" if a['status']=='pass' else '无对应真球/未确认' if not c else a['status']
            grabs=','.join(f"{e['seconds']:.2f}" for e in b['native_grabs']) or '—';deliveries=','.join(f"{e['seconds']:.2f}" for e in b['native_deliveries']) or '—'
            outcome=b['end_reason_events'][-1] if b['end_reason_events'] else None
            reason=(f"L{outcome['line']}: {outcome['event'].get('stage')} / {outcome['event'].get('reason') or 'success'}" if outcome else 'unknown')
            text.append(f"|{r['map']}/{b['ball_index']}|{identity}|{confirm}|{grabs} / {deliveries}|{b['observe_count']} / {b['window_fed_detection_count']}|{reason}|")
    text+=['', '误差使用日志最后确认WM快照（坐标打印至.001m）与确认帧精确真值；原始精确命中坐标也保存在JSON，不能将打印精度当更高的测量精度。表中确认时刻是业务memory_confirmed，首次WM状态CONFIRMED另存JSON。', '',
      f"12次业务确认的同ID、3点、原始40≤d<90、所有两点间距≥15cm和末点≥0.5m全部通过；最小实际间距{summary['confirmation_min_gap_cm']:.6f}cm，末点最小{summary['confirmation_min_final_distance_m']:.9f}m。其他5个已启动球次没有确认，不把缺失当通过。", '',
      '|布局|first choice L/tick|唯一候选状态|所选package/真值最优|旧→新第一抓秒|旧→新抓取尝试|', '|---|---|---|---|---|---|']
    for r in rows:
        p=r['P3_first_choice'];sel=next((s for s in r['selections'] if s['ball_index']==1),None);reg=r['first_ball_regression'];old,new=reg['previous_first_grab'],reg['current_first_grab']
        text.append(f"|{r['map']}|{('L'+str(sel['line'])+'/t'+str(sel['tick'])) if sel else '无选择'}|{sel['status'] if sel else 'unknown'}|{p['selected_package_id']} / {p['match']}|{str(old['seconds'])+'→'+str(new['seconds']) if old and new else '均未抓取'}|{reg['old_grab_attempts']}→{reg['new_grab_attempts']}|")
    text+=['', '第一球capture无退步仅指原来抓到的9局仍抓到同一package；01/03慢3.62s、尝试3→7次，09慢6.58s、尝试4→12次，不能称全部性能无退步。抓取尝试指原生package_grab交互次数，不等于approach调用次数。']
    text+=['', 'E/G仅作为未见位置精度结果：', '', '|位置|n（确认的球次）|各次误差cm|均值cm|', '|---|---|---|---|']
    for name,values in j['unseen_accuracy'].items():
        text.append(f"|{name}|{len(values)}|"+'；'.join(f"{v['map']}/球{v['ball_index']} L{v['confirmation_line']}={v['error_cm']:.4f}" for v in values)+f"|{statistics.mean(v['error_cm'] for v in values):.4f}|" if values else f'|{name}|0|无确认样本|unknown|')
    text+=['', 'n为成功确认的球次，不能把未确认的E/G规划线索计作精度样本；E两次来自同一实际目标位置，也不是两个独立未知位置。A/B/C/D/F误差仅逐局描述，不据此推出泛化精度。', '', '失败归因与空帧/身份变化：']
    text+=j['case_notes']
    s=j['map02_ball2_visibility_supplement']
    text+=['', 'map-02球2时间补充（保留冻结机器报告原None）：', '',
      f"首次全局未封顶且一对一对应D为L{s['first_seen_line']}/t{s['first_seen_tick']}={s['first_seen_seconds']:.2f}s：50cm/-7.67°/.89，相机真bearing=-7.532367928°，误差.137632072°，M5二维残差.803854762cm。首次WM实际增量入库为观察L{s['first_WM_accepted_observe_line']}/t{s['first_WM_accepted_tick']}={s['first_WM_accepted_seconds']:.2f}s，association L1043、hit1快照L{s['first_WM_accepted_line']}。该时刻早于严格首次看到，是因为L1040的78cm/34.62°/.87与同帧100cm/32.52°/.83均可按方位对应D，严格timeline的一对一规则判歧义；runtime只有78cm入库，轨迹与D相距27.9518cm。", '',
      '全局最早封顶方位候选是球1期间L14/t1785=35.70s；球2分段最早候选L935/t8491=169.82s，均不是未封顶距离证据。冻结demo_timeline.py:111仅枚举实际抓取/送达package，未抓到的D没有timeline.balls条目，opt2_report.py:267/278查找得到空条目，于是首见与首WM时间为None；这不是D一直没有严格原始匹配。这里沿用冻结几何和一对一规则逐帧全局扫描，补充JSON含原图SHA及全部候选；不修改原机器报告。']
    text+=['', '全部逐条selection/CONFIRMED关联、三hit证据、原生抓取/送达索引、原地重复检查、WM空帧before/after与预算事件在diagnosis.json。真实抓取后wm_action_removed只撤销原位置：每次confidence=0/LOST且exact轨迹ID保留归档；不是额外感知衰减。', '',
      '复算：`PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/round-3/final-wm-diagnosis/reproduce.py`。依赖与全部输入SHA随JSON保存；脚本只读原始资料，未修改任何运行/评测代码，未运行仿真。','']
    return '\n'.join(text)

def main():
    runs=[analyse(p) for p in sorted(ROUND.glob('map-??.json'))]
    confirmed=[c for r in runs for c in r['first_confirmed_tracks']]
    first=[s for r in runs for s in r['selections'] if s['ball_index']==1]
    unseen={key:[] for key in ('E','G')}
    for r in runs:
        for b in r['balls']:
            a=b['confirmation_association']
            if a['status']=='pass' and a['label'] in unseen:
                unseen[a['label']].append({'map':r['map'],'ball_index':b['ball_index'],'error_cm':a['distance_cm'],'confirmation_line':b['confirmed'][0]['line'],'tick':a['tick'],'package_id':a['package_id']})
    summary={'first_choice_matches':sum(r['P3_first_choice']['match'] for r in runs),'first_choices_evaluated':sum(r['P3_first_choice']['evaluated'] for r in runs),'first_choice_unknown_cost':sum(s['status']=='unknown' for s in first),'first_choices_with_only_one_candidate':sum(s['candidate_count']==1 for s in first),
             'confirmed_tracks':len(confirmed),'phantom_confirmed':sum(len(r['phantom_confirmed']) for r in runs),'confirmed_unknown':sum(len(r['confirmed_association_unknown']) for r in runs),
             'first_ball_captured':sum(bool(r['first_ball_regression']['current_first_grab']) for r in runs),'first_ball_capture_regressions':sum(r['first_ball_regression']['capture_regression'] for r in runs),
             'observe_calls':sum(len(r['observations']) for r in runs),'repeated_observes':sum(len(r['repeated_observes']) for r in runs),'observe_guard_violations':sum(len(r['observe_motion_violations']) for r in runs),'program_errors':sum(len(r['native_program_errors']) for r in runs)}
    rules=[b['confirmation_rule_evidence'] for r in runs for b in r['balls'] if b.get('confirmation_rule_evidence')]
    excluded=[p for r in runs for e in r['exclusions'] for p in e['raw_proof']]
    summary.update(confirmation_rules_checked=len(rules),confirmation_rules_pass=sum(r['pass'] for r in rules),
        confirmation_min_gap_cm=min(r['min_pose_distance_m'] for r in rules)*100,
        confirmation_min_final_distance_m=min(r['last_sample_wm_distance_m'] for r in rules),
        exact_observe_binding_count=sum(bool(o['exact_render'] and o['image_exists'] and o['image_hash_matches']) for r in runs for o in r['observations']),
        captured_same_first_package_count=sum(r['first_ball_regression']['same_package_id'] for r in runs),
        exclusions_total=sum(len(r['exclusions']) for r in runs),
        excluded_delivered_true=sum(bool(p['matching_delivered_ids']) for p in excluded),
        excluded_remaining_true=sum(bool(p['matching_remaining_ids']) for p in excluded),
        action_invalidations_total=sum(len(r['wm_action_removals']) for r in runs),
        action_invalidations_exact_zero_lost=sum(e['explicit_action_invalidation'] for r in runs for e in r['wm_action_removals']))
    result={'scope':__doc__,'summary':summary,'runs':runs,'unseen_accuracy':unseen,'case_notes':failure_notes(runs),
            'map02_ball2_visibility_supplement':map02_visibility_supplement(next(r for r in runs if r['map']=='map-02')),
            'frozen_report_consistency':verify_report_consistency(runs),
            'dependency_sha256':{str(p):sha(p) for p in (Path(__file__),BASE_AUDIT,ROUND/'program.py',ROUND/'opt2_report.json',ROOT/'tools/detection_evaluation.py',ROOT/'tools/p3_offline_choice.py',ROOT/'tools/batch_report.py',ROOT/'tools/demo_timeline.py',ROOT/'tools/opt2_report.py')}}
    assert result['frozen_report_consistency']['all_pass'],result['frozen_report_consistency']
    (OUT/'diagnosis.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    (OUT/'REPORT.md').write_text(render(result))
    print(json.dumps(summary,ensure_ascii=False));print(json.dumps(unseen,ensure_ascii=False))
if __name__=='__main__':main()
