#!/usr/bin/env python3
"""Read-only runtime data-flow audit. Replays recorded arrays; never runs a robot."""
import ast
import collections
import datetime
import hashlib
import itertools
import json
import math
from pathlib import Path
import re
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools'))
from demo_report import static_checks
from stage_report import compare

OUT = Path(__file__).resolve().parent
COLORS = ('target', 'distractor')
FIELDS = ('category', 'distanceCm', 'bearingDeg', 'confidence')


def read(p):
    return json.loads(Path(p).read_text())


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def projected(rows):
    return [{k: d.get(k) for k in FIELDS} for d in rows if d.get('category') in COLORS]


def source_audit(folder, lines):
    path = folder / 'program.py'
    source = path.read_text()
    tree = ast.parse(source)
    functions = {n.name:n for n in tree.body if isinstance(n, ast.FunctionDef)}
    names = {'CONFIDENCE_FLOORS', 'FILTER_VERSION', 'DETECTION_FILTER_SHA256', 'CONFIRM_MIN_CM', 'CONFIRM_MAX_CM'}
    constants = {t.id:ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                 for t in n.targets if isinstance(t, ast.Name) and t.id in names}
    namespace = {'math':math, **constants}
    exec(compile(ast.Module(body=[functions['detection_filter_update']], type_ignores=[]), str(path), 'exec'), namespace)
    wm_calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == '_update_wm']
    memory_true = all(any(k.arg == 'memory_phase' and isinstance(k.value, ast.Constant) and k.value.value is True for k in n.keywords) for n in wm_calls)
    wm_updates = [n.lineno for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                  and isinstance(n.func.value, ast.Name) and n.func.value.id == 'wm' and n.func.attr == 'update']
    mission_reads = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Subscript) and isinstance(n.value, ast.Name) and n.value.id == 'mission':
            mission_reads.append({'line':n.lineno, 'expression':ast.unparse(n)})
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name) and n.func.value.id == 'mission':
            mission_reads.append({'line':n.lineno, 'expression':ast.unparse(n)})
    suspicious_map_constants = [{'line':n.lineno, 'value':n.value} for n in ast.walk(tree)
                                if isinstance(n, ast.Constant) and isinstance(n.value, str)
                                and re.fullmatch(r'map-\d\d', n.value)]
    def no_calibration(*args, **kwargs):
        raise AssertionError('capped planning attempted point calibration')
    goal_ns = {'_wm_target':lambda:None, '_is_target':lambda d:d.get('category')=='target',
               'calibrated_detection':no_calibration, 'math':math}
    exec(compile(ast.Module(body=[functions['_planning_goal']], type_ignores=[]), str(path), 'exec'), goal_ns)
    goal = goal_ns['_planning_goal'](SimpleNamespace(x=0., z=0., yaw_rad=0.), [{'category':'target','distanceCm':100,'bearingDeg':25}])
    capped_ray = goal['source']=='capped_bearing_only' and 'x' not in goal and 'z' not in goal and set(goal)=={'ray_x','ray_z','ux','uz','source'}
    checks = static_checks(path, lines)
    excerpts = {name:{'line':functions[name].lineno,'end_line':functions[name].end_lineno,
                       'source':ast.get_source_segment(source, functions[name])}
                for name in ('counted_observe','_update_wm','_in_range_candidates','_planning_goal','_vp_goal_unit','_vp_candidates')}
    output = {'program_file':str(path), 'program_sha256':sha(path), 'constants':constants,
              'static_checks':checks, 'mission_reads':mission_reads, 'map_id_literal_branches':suspicious_map_constants,
              'wm_call_lines':[n.lineno for n in wm_calls], 'all_wm_calls_memory_phase_true':memory_true,
              'wm_update_lines':wm_updates, 'single_WM_update_entrance':len(wm_updates)==1,
              'capped_planning_is_ray_without_calibration':capped_ray, 'capped_mock_result':goal,
              'source_excerpts':excerpts,
              'manual_review':{'target_anchor_flow':'mission.objects -> role==obstacle whitelist -> obstacle road/progress only; mission.storage is delivery destination',
                               'layout_branch_flow':'road IDs used as dynamic public graph keys; no fixed map identifier dispatch or target-position lookup found',
                               'uncapped_outside_window':'raw<100 may create uncapped_planning_only goal without WM insertion; 100+ only bearing ray when no existing WM goal',
                               'latent_non_memory_mode':'_update_wm(memory_phase=False) would accept <40, but all three executable call sites pass True',
                               'comments':'_update_wm docstring still says 40–95; executed guards use CONFIRM_MAX_CM=90'}}
    return output, namespace['detection_filter_update']


def run_audit(folder, name, entry, replay, filter_sha):
    path = folder / (name+'.json')
    raw = read(path)
    vision_path = Path(raw['visionEvidenceFile'])
    vision = read(vision_path)
    lines = raw['lines']
    obs = [(i,l) for i,l in enumerate(lines) if l.get('event')=='observe']
    queries = [q for q in vision['queries'] if q.get('method')=='observe']
    frames, errors = [], []
    def check(value, why, index=None):
        if not value:errors.append({'reason':why,'observe_line_index':index})
    check(len(obs)==len(queries), 'observe_query_count_mismatch')
    for num, ((index,line),query) in enumerate(zip(obs,queries)):
        end = obs[num+1][0] if num+1<len(obs) else len(lines)
        segment = list(enumerate(lines[index+1:end],index+1))
        filters = [(i,l) for i,l in segment if l.get('event')=='detection_filter']
        wms = [(i,l) for i,l in segment if l.get('event')=='target_observations']
        associations = [(i,l) for i,l in segment if l.get('event')=='wm_associations']
        check(query['tick']==line['tick'] and projected(query['result'])==line['raw'], 'raw_not_exact_native_query',index)
        check(query['args']==[None,0] and line['query'] is None and line['confidence']==0, 'API_prefilter_not_disabled',index)
        check(len(filters)==1,'filter_log_count',index)
        if len(filters)!=1:continue
        filter_index, logged = filters[0]
        result = replay(query['result'],tick=line['tick'])
        check(all(logged.get(k)==v for k,v in result.items()), 'filter_decision_replay_difference',index)
        check(logged.get('tick')==line['tick'] and logged.get('observe_count')==line['observe_count'] and logged.get('filter_sha256')==filter_sha,'filter_identity_tick_mismatch',index)
        indices = logged['kept_indices']+logged['rejected_indices']
        check(sorted(indices)==list(range(len(query['result']))) and len(logged['decisions'])==len(query['result']), 'filter_partition_loss_or_duplicate',index)
        native = [f for f in vision['frames'] if f.get('frameId')==query.get('frameId') and f.get('evidenceId')==query.get('evidenceId')]
        truths = [f for f in vision.get('renderTruth',{}).get('frames',[]) if f.get('frameId')==query.get('frameId') and f.get('evidenceId')==query.get('evidenceId')]
        bound = len(native)==len(truths)==1
        if bound:
            f,t=native[0],truths[0]
            bound = (t.get('exactRenderState') and t.get('sameTickAndRevision') is True and t.get('imageSha256')==f.get('sha256')
                     and t.get('evidenceSeq')==f.get('seq') and f['seq']<query['seq']
                     and t.get('evidenceTick')==t.get('captureTick')==f.get('tick')==query['tick']
                     and t.get('evidenceStateRevision')==t.get('captureStateRevision')==f.get('stateRevision')
                     and t.get('runId')==vision.get('runId'))
        check(bound,'native_render_binding_not_exact',index)
        kept = [query['result'][i] for i in logged['kept_indices']]
        confidence_kept = [d for d in kept if float(d.get('confidence') or 0)>=line['requested_confidence']]
        requested = line.get('requested_category')
        targets = [d for d in confidence_kept if d.get('category')=='target'] if requested is None else []
        expected = [d for d in targets if 40<=d['distanceCm']<90]
        outside = [d for d in targets if not 40<=d['distanceCm']<90]
        check(len(wms)==(1 if requested is None else 0),'WM_log_count_or_unexplained_missing',index)
        if wms:
            wm_index,wm=wms[0]
            as_pairs=lambda values:[(d.get('distanceCm'),d.get('bearingDeg')) for d in values]
            check(wm['count']==len(expected) and wm['seen']==len(targets),'WM_count_seen_mismatch',index)
            check(as_pairs(wm['items'])==as_pairs(expected) and all(d.get('fed') for d in wm['items']), 'WM_includes_rejected_or_outside_or_missing',index)
            check(as_pairs(wm['outside_window'])==as_pairs(outside),'outside_window_accounting_mismatch',index)
            check(len(associations)==(1 if expected else 0),'WM_association_count',index)
            if associations:check(as_pairs(associations[0][1]['items'])==as_pairs(expected),'WM_association_raw_mismatch',index)
        outside_redblue=[(i,d) for i,d in enumerate(query['result']) if d.get('category') in COLORS and not 40<=d['distanceCm']<90]
        outside_removed=[i for i,d in outside_redblue if i in logged['rejected_indices']]
        if logged['filter_version']=='confidence-floor-wm-window-v2':check(not outside_removed,'v2_removed_outside_window',index)
        frames.append({'observe_line_index':index,'filter_line_index':filter_index,'wm_line_indices':[i for i,l in wms],
                       'tick':line['tick'],'query_seq':query['seq'],'frame_id':query['frameId'],'evidence_id':query['evidenceId'],
                       'native_exact_binding':bool(bound),'image':str(vision_path.parent/native[0]['image']) if native else None,
                       'raw_redblue':line['raw'],'native_all_categories_count':len(query['result']),
                       'kept_indices':logged['kept_indices'],'rejected_indices':logged['rejected_indices'],'decisions':logged['decisions'],
                       'requested_category':requested,'requested_confidence':line['requested_confidence'],
                       'raw_redblue_count':len(line['raw']),'raw_outside_redblue_count':len(outside_redblue),
                       'raw_capped_redblue_count':sum(d['distanceCm']>=100 for d in line['raw']),
                       'outside_redblue_rejected_indices':outside_removed,'expected_WM_items':expected,
                       'target_observations':wms[0][1] if wms else None,
                       'capped_goal_events':[{'line_index':i,**l} for i,l in segment if l.get('event')=='viewpoint_selected' and l.get('goalSource')=='capped_bearing_only'],
                       'WM_skipped_reason':'storage-zone-only delivery observation' if requested is not None else None})
    check(sum(l.get('event')=='detection_filter' for l in lines)==len(obs),'orphan_filter_log')
    return {'map':name,'raw_file':str(path),'raw_sha256':sha(path),'matches_completed_raw_hash':sha(path)==entry['raw_sha256'],
            'vision_file':str(vision_path),'vision_sha256':sha(vision_path), 'counts':{
             'observe':len(obs),'native_observe_queries':len(queries),'raw_redblue':sum(f['raw_redblue_count'] for f in frames),
             'raw_outside_redblue':sum(f['raw_outside_redblue_count'] for f in frames),
             'raw_capped_redblue':sum(f['raw_capped_redblue_count'] for f in frames),
             'outside_redblue_filtered':sum(len(f['outside_redblue_rejected_indices']) for f in frames),
             'WM_items':sum(len(f['expected_WM_items']) for f in frames),
             'storage_only_observes':sum(f['requested_category'] is not None for f in frames)},
            'errors':errors,'passed':not errors,'frames':frames}


def main():
    report={'schema':'wm-runtime-filter-dataflow-audit/v1','generated_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'scope':'snapshot of r1 and r2 completed runs only; no simulation, optimization or stage-2 assessment', 'rounds':{}}
    before={}
    for n in (1,2):
        folder=OUT/f'round-{n}'
        progress=read(folder/'progress.json')
        manifest=read(folder/'code_manifest.json')
        before.update({p:sha(p) for p in manifest if Path(p).is_file()})
        completed=progress['completed']
        first=read(folder/(sorted(completed)[0]+'.json')) if completed else {'lines':[]}
        source,replay=source_audit(folder,first['lines'])
        runs=[run_audit(folder,m,e,replay,source['constants']['DETECTION_FILTER_SHA256']) for m,e in sorted(completed.items())]
        report['rounds'][str(n)]={'progress_status_at_snapshot':progress['status'],'progress_sha256_at_snapshot':sha(folder/'progress.json'),
                                 'completed_layouts_at_snapshot':sorted(completed),'source_audit':source,'runs':runs}
    comparison=read(OUT/'round-1/opt_report.json')
    maps=['map-01','map-02','map-09']
    examples=[]
    for m in maps:
        run=next(r for r in report['rounds']['1']['runs'] if r['map']==m)
        frame=next(f for f in run['frames'] if f['expected_WM_items'])
        scenario=next(g['scenario'] for g in comparison['scenarios'] if m in g['members'])
        examples.append({'map':m,'scenario':scenario,'raw_file':run['raw_file'],**frame})
    pairs=[{'maps':[a,b],**compare(comparison['current_target_traces'][a]['trace'],comparison['current_target_traces'][b]['trace'])} for a,b in itertools.combinations(maps,2)]
    report['three_independent_exact_raw_examples']={'examples':examples,'trace_pair_comparisons':pairs,
        'passed':all(e['native_exact_binding'] for e in examples) and all(not p['equivalent'] for p in pairs)}
    report['manifest_files_unchanged_by_audit']={p:sha(p)==h for p,h in before.items()}
    report['r2_manifest_matches_current_files']={p:sha(p)==h for p,h in read(OUT/'round-2/code_manifest.json').items()}
    report['source_checks_pass']={n: (all(v['status']=='pass' for v in rd['source_audit']['static_checks'].values()) and rd['source_audit']['all_wm_calls_memory_phase_true'] and rd['source_audit']['single_WM_update_entrance'] and rd['source_audit']['capped_planning_is_ray_without_calibration'] and not rd['source_audit']['map_id_literal_branches']) for n,rd in report['rounds'].items()}
    report['all_audit_checks_pass']=all(report['source_checks_pass'].values()) and all(run['passed'] and run['matches_completed_raw_hash'] for rd in report['rounds'].values() for run in rd['runs']) and all(report['manifest_files_unchanged_by_audit'].values()) and all(report['r2_manifest_matches_current_files'].values()) and report['three_independent_exact_raw_examples']['passed']
    report['limits']=['r2 is a completed-run snapshot while the batch is running; missing future layouts are unexamined, not passed.',
                      'v1 intentionally used confidence floors outside the WM window; v2 retains those detections. This historical difference is reported, not disguised as an audit pass of v1 abstention.',
                      'No generic filtered-return event exists: intermediate returned arrays are exactly reconstructed from native full query results, recorded decisions and public caller parameters, then compared with actual target_observations/association logs.',
                      '100cm safety combines source control-flow review and isolated pure-function execution; if prior WM exists the planner uses that prior WM instead of the current capped ray.',
                      'No global claim that retained outside detections are true. Missing labels and filter test contamination remain unchanged.']
    (OUT/'runtime_filter_audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    text=['# 运行时检测链路只读审计','',f"审计快照：{report['generated_at_utc']}。全部审计检查：{'PASS' if report['all_audit_checks_pass'] else 'FAIL'}。只覆盖 progress.completed 已完成局；未运行仿真、未改 program/tools/code_manifest、未做阶段2优化或评测。",'',
          '|轮次|已完成局|observe / native查询|原始红蓝|窗外红蓝|100cm+红蓝|窗外被过滤|WM输入|链路异常|','|---|---|---:|---:|---:|---:|---:|---:|---:|']
    for n,rd in report['rounds'].items():
        for run in rd['runs']:
            c=run['counts'];text.append(f"|r{n}|{run['map']}|{c['observe']} / {c['native_observe_queries']}|{c['raw_redblue']}|{c['raw_outside_redblue']}|{c['raw_capped_redblue']}|{c['outside_redblue_filtered']}|{c['WM_items']}|{len(run['errors'])}|")
    text+=['','原始红蓝日志与每条原生 observe 查询的四字段投影逐项相等，query参数均为None/0；过滤索引按完整原生返回数组（含其它类别）复放，完整且不重复。requested confidence/category 后的返回数组由记录重建，与真实 WM items、seen、outside_window 及 associations 对齐。存放点专用查询不调用 WM，这是预期用途，不是检测丢失。','','r1 的 v1 会过滤部分窗外低置信度检测；r2 的 v2 对窗外弃权保留。两轮实际 WM 输入均限制在40≤d<90；三个调用点都显式memory_phase=True。`_update_wm` 的旧注释“40–95”与实际90上限不符，但本轮未修改源码。','','100cm+且无旧WM时 `_planning_goal` 只产生ray_x/ray_z/ux/uz；点坐标与M5调用只在<100分支。射线候选只检查方向，不以100cm生成目标点。有旧WM则使用其先前合法观测位置。孤立纯函数回放也验证100不会调用标定。','','源码检查未发现固定布局ID分支、目标位置查表或target anchors读取。mission.objects仅在role==obstacle白名单后用于避障，mission.storage用于送货。坐标扫描包含主程序及嵌入14个Python模块；详见JSON中的static_checks与源码片段。','','三条独立r1 exact raw示例：']
    for e in examples:
        text.append(f"- {e['map']} / {e['scenario']}: raw lines[{e['observe_line_index']}], filter lines[{e['filter_line_index']}], WM lines{e['wm_line_indices']}, tick {e['tick']}; 原生query seq {e['query_seq']}, frameId {e['frame_id']}, exactRender绑定通过。WM距离/方位="+str([(d['distanceCm'],d['bearingDeg']) for d in e['expected_WM_items']])+'.')
    text+=['','三组完整目标相关轨迹按既有容差逐对不等价；没有以三个布局名称代替独立性。所有原始数组、decision、原图路径、行索引、逐对差异以及审计前后manifest文件SHA检查保存在 runtime_filter_audit.json。','','复跑：`PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-1/reproduce_runtime_filter_audit.py`。复跑将审查届时已完成局并更新快照。','']
    if not report['all_audit_checks_pass']:text+=['异常明细：',json.dumps({n:[{'map':r['map'],'errors':r['errors']} for r in d['runs'] if r['errors']] for n,d in report['rounds'].items()},ensure_ascii=False)]
    (OUT/'runtime_filter_audit.md').write_text('\n'.join(text))
    print(json.dumps({'passed':report['all_audit_checks_pass'],'rounds':{n:{'maps':d['completed_layouts_at_snapshot'],'errors':sum(len(r['errors']) for r in d['runs'])} for n,d in report['rounds'].items()}},ensure_ascii=False))


if __name__=='__main__':main()
