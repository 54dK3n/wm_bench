#!/usr/bin/env python3
"""P3.1 saved public-control calibration audit. Never starts a simulator.

Primary sample policy is fixed by API kind, success reason, requested speed and
exact public odometry boundaries; no sample is selected by fit residual.
Only the public subset of record.inputs is projected for analysis. samples,
startState, mission objects and scene coordinates never enter the model.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / 'artifacts/inloop/opt-2/calibration'
POLICY = {
    'version':'public-controls-fixed-eligibility-v1',
    'primary_controls':{'follow_road':'accepted true; stoppedBy=max_distance', 'take_exit':'accepted true; stoppedBy=entered_road'},
    'odometry':'finite forwardCm/rightCm/headingDeg/distanceCm/tick at exact control start and end ticks; no intervening control',
    'distance':'public navigation result.distanceCm, with public odometry delta reported as consistency evidence',
    'turn':'absolute shortest difference of public odometry heading; requested exit turn comes from exact-start public road_state.exits',
    'speed':'all requested speed + obeySpeedLimit settings reported separately; no pooling different settings',
    'fit':'all eligible observations in each fixed speed stratum: elapsedTicks = a*distanceCm+b*abs(turnDeg), no intercept; k=b/a',
    'residual':'abs(predictedTicks-observedTicks)/observedTicks; <=10% required for every eligible observation, plus RMS/P90 report',
    'required_repeats':'100cm single follow_road control three times; public exit groups 90deg and 180deg three times; >=3 distinct nonzero exit-angle groups with >=3 observations reported conservatively',
    'no_substitution':'ten 10cm steps are not one 100cm control; pure turn_angle is auxiliary only, never road calibration',
    'no_residual_exclusion':True,
    'net_turn_limitation':'boundary odometry measures shortest net rotation, not accumulated steering through a curved road',
}


def read(path):
    return json.loads(Path(path).read_text())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def finite(value):
    return type(value) in (int,float) and math.isfinite(value)


def turn_delta(before,after):
    return abs((after-before+180.)%360.-180.)


def public_inputs(record):
    """Preserve source indices but whitelist public API data, excluding startState."""
    out=[]
    for index,item in enumerate(record.get('inputs',[])):
        typ,method=item.get('type'),item.get('method')
        base={k:item.get(k) for k in ('seq','tick','type','method')}
        base['input_index']=index
        if typ=='navigation_control' and method in ('follow_road','take_exit'):
            base.update(args=item.get('args',{}),result=item.get('result',{}));out.append(base)
        elif typ=='navigation_query' and method in ('odometry','road_state'):
            allowed=('forwardCm','rightCm','headingDeg','distanceCm','tick') if method=='odometry' else ('exits','tick','onRoad','atNode')
            base['result']={k:item.get('result',{}).get(k) for k in allowed};out.append(base)
        elif typ=='control':
            c=item.get('command',{})
            base['command']={k:c.get(k) for k in ('kind','direction','durationTicks','angleDegrees','speedPercent')}
            out.append(base)
        elif typ=='vision_query' and method in ('approach','approach_step'):
            # Only a marker, to reject a mixed-control odometry bracket.
            out.append(base)
    return out


def is_motion(item):
    return item.get('type') in ('navigation_control','control') or item.get('method') in ('approach','approach_step')


def exact_query(items,pos,tick,method,before):
    span=range(pos-1,-1,-1) if before else range(pos+1,len(items))
    for j in span:
        item=items[j]
        if is_motion(item):return None
        if item.get('method')==method and item.get('tick')==tick and item.get('result',{}).get('tick')==tick:
            return item
    return None


def extract(items,source):
    primary,excluded,aux=[],[],[]
    odo_keys=('forwardCm','rightCm','headingDeg','distanceCm','tick')
    for pos,item in enumerate(items):
        method=item.get('method');kind=(item.get('command') or {}).get('kind')
        if method not in ('follow_road','take_exit') and kind!='turn_angle':continue
        pure=kind=='turn_angle'
        result=item.get('result',{});args=item.get('args',{});cmd=item.get('command',{})
        elapsed=cmd.get('durationTicks') if pure else result.get('elapsedTicks')
        start=item.get('tick');why=[]
        if not finite(start) or not finite(elapsed) or elapsed<=0:why.append('missing_or_nonpositive_elapsed_ticks')
        end=start+elapsed if finite(start) and finite(elapsed) else None
        before=exact_query(items,pos,start,'odometry',True)
        after=exact_query(items,pos,end,'odometry',False)
        complete=lambda q:bool(q) and all(finite(q['result'].get(k)) for k in odo_keys)
        if not complete(before):why.append('missing_exact_start_public_odometry')
        if not complete(after):why.append('missing_exact_end_public_odometry')
        if not pure:
            expected='max_distance' if method=='follow_road' else 'entered_road'
            if result.get('accepted') is not True:why.append('not_accepted')
            if result.get('stoppedBy')!=expected:why.append('incomplete_control_stop_'+str(result.get('stoppedBy')))
            if not finite(result.get('distanceCm')) or result['distanceCm']<0:why.append('invalid_public_distance')
            if not finite(args.get('speed')) or type(args.get('obeySpeedLimit')) is not bool:why.append('missing_public_speed_setting')
        sample={'source':source,'input_index':item['input_index'],'input_seq':item['seq'],'method':'turn_angle' if pure else method,
                'start_tick':start,'end_tick':end,'elapsed_ticks':elapsed,'args':args if not pure else cmd,
                'result':result,'eligibility_reasons':why}
        if complete(before) and complete(after):
            a,b=before['result'],after['result']
            delta=b['distanceCm']-a['distanceCm']
            sample.update(public_start_odometry=a,public_end_odometry=b,
                          odometry_input_indices=[before['input_index'],after['input_index']],
                          distance_cm=delta if pure else result.get('distanceCm'),odometry_distance_delta_cm=delta,
                          distance_reporting_difference_cm=None if pure or not finite(result.get('distanceCm')) else result['distanceCm']-delta,
                          turn_deg=turn_delta(a['headingDeg'],b['headingDeg']))
            if delta<0:why.append('odometry_distance_decreased')
        if not pure:
            state=exact_query(items,pos,start,'road_state',True)
            selected=[e for e in (state or {}).get('result',{}).get('exits',[]) if e.get('roadId')==args.get('roadId')]
            sample['requested_exit_turn_deg']=abs(selected[0]['turnDeg']) if len(selected)==1 and finite(selected[0].get('turnDeg')) else None
            sample['road_state_input_index']=state['input_index'] if state else None
            sample['speed_stratum']=f"speed={args.get('speed')};obey={args.get('obeySpeedLimit')}"
        if why:excluded.append(sample)
        elif pure:aux.append(sample)
        else:primary.append(sample)
    return primary,excluded,aux


def fit_all(samples):
    if not samples:return {'status':'no_eligible_samples','samples':0,'k':None}
    dd=sum(s['distance_cm']**2 for s in samples);dt=sum(s['distance_cm']*s['turn_deg'] for s in samples)
    tt=sum(s['turn_deg']**2 for s in samples);dy=sum(s['distance_cm']*s['elapsed_ticks'] for s in samples)
    ty=sum(s['turn_deg']*s['elapsed_ticks'] for s in samples);det=dd*tt-dt*dt
    if abs(det)<1e-12:return {'status':'rank_deficient','samples':len(samples),'k':None}
    a,b=(dy*tt-dt*ty)/det,(dd*ty-dt*dy)/det
    residuals=[]
    for s in samples:
        pred=a*s['distance_cm']+b*s['turn_deg'];err=abs(pred-s['elapsed_ticks'])/s['elapsed_ticks']
        residuals.append({'source':s['source'],'input_index':s['input_index'],'input_seq':s['input_seq'],
                          'observed_ticks':s['elapsed_ticks'],'predicted_ticks':pred,'relative_error':err})
    errors=sorted(r['relative_error'] for r in residuals)
    p=(len(errors)-1)*.9;lo=int(p);hi=math.ceil(p);p90=errors[lo]+(errors[hi]-errors[lo])*(p-lo)
    return {'status':'diagnostic_fit_only','samples':len(samples),'a_ticks_per_cm':a,'b_ticks_per_deg':b,'k':b/a if a else None,
            'nonnegative_coefficients':a>0 and b>=0,'max_relative_residual':max(errors),'p90_relative_residual':p90,
            'rms_relative_residual':math.sqrt(statistics.mean(e*e for e in errors)),
            'residuals_at_most_10pct':all(e<=.1+1e-12 for e in errors),
            'over_10pct':sum(e>.1+1e-12 for e in errors),'residuals':residuals}


def residual_feasibility(samples):
    """Can ANY nonnegative scalar k achieve the fixed 10% per-row bound?

    For fixed k, a must satisfy .9*T/(D+k*A)<=a<=1.1*T/(D+k*A).
    Comparing every lower/upper pair gives linear interval constraints on k.
    This checks the whole fixed sample set, without removing outliers.
    """
    lower,upper=0.,math.inf
    lower_pair=upper_pair=None
    impossible=[]
    for i,left in enumerate(samples):
        for j,right in enumerate(samples):
            coefficient=.9*left['elapsed_ticks']*right['turn_deg']-1.1*right['elapsed_ticks']*left['turn_deg']
            bound=1.1*right['elapsed_ticks']*left['distance_cm']-.9*left['elapsed_ticks']*right['distance_cm']
            if abs(coefficient)<1e-12:
                if bound < -1e-12:impossible.append([i,j])
            elif coefficient>0 and bound/coefficient<upper:
                upper=bound/coefficient;upper_pair=[i,j]
            elif coefficient<0 and bound/coefficient>lower:
                lower=bound/coefficient;lower_pair=[i,j]
    groups=defaultdict(list)
    for s in samples:groups[(s['distance_cm'],s['turn_deg'])].append(s)
    contradictions=[]
    for (distance,angle),group in groups.items():
        fast=min(group,key=lambda s:s['elapsed_ticks']);slow=max(group,key=lambda s:s['elapsed_ticks'])
        bound=(slow['elapsed_ticks']-fast['elapsed_ticks'])/(slow['elapsed_ticks']+fast['elapsed_ticks'])
        if bound>.1+1e-12:
            contradictions.append({'distance_cm':distance,'turn_deg':angle,
                                   'minimum_possible_max_relative_residual':bound,'fast':fast,'slow':slow})
    return {'any_nonnegative_k_can_satisfy_10pct':not impossible and lower<=upper+1e-12,
            'required_k_lower_bound':lower,'required_k_upper_bound':upper if math.isfinite(upper) else None,
            'lower_bound_sample_pair':lower_pair,'upper_bound_sample_pair':upper_pair,
            'impossible_parallel_constraints':impossible,
            'identical_feature_contradictions':sorted(contradictions,key=lambda x:-x['minimum_possible_max_relative_residual'])}


def repeats(samples):
    groups=defaultdict(list)
    for s in samples:
        if s['method']=='take_exit' and s['requested_exit_turn_deg'] is not None:
            groups[str(s['requested_exit_turn_deg'])].append(s)
    # Exact public arguments, not rounding to convenient test angles.
    straight=[s for s in samples if s['method']=='follow_road' and s['args'].get('maxCm')==100 and s['turn_deg']==0]
    compact=lambda s:{'source':s['source'],'input_index':s['input_index'],'input_seq':s['input_seq'],
                      'distance_cm':s['distance_cm'],'turn_deg':s['turn_deg'],'elapsed_ticks':s['elapsed_ticks']}
    ninety=[s for key,value in groups.items() if float(key)==90 for s in value]
    one_eighty=[s for key,value in groups.items() if float(key)==180 for s in value]
    return {'single_100cm_straight_count':len(straight),'single_100cm_straight_examples':[compact(s) for s in straight],
            'exit_90_count':len(ninety),'exit_180_count':len(one_eighty),
            'nonzero_angle_groups_with_3_repeats':sum(float(k)>0 and len(v)>=3 for k,v in groups.items()),
            'all_exit_angle_groups':{k:{'count':len(v),'examples':[compact(s) for s in v[:3]]} for k,v in sorted(groups.items(),key=lambda kv:float(kv[0]))},
            'required_coverage':len(straight)>=3 and len(ninety)>=3 and len(one_eighty)>=3 and sum(float(k)>0 and len(v)>=3 for k,v in groups.items())>=3}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--out',type=Path,default=DEFAULT_OUT);args=parser.parse_args()
    args.out.mkdir(parents=True,exist_ok=True)
    inventory=[];all_samples=[];all_excluded=[];all_aux=[];public_records=[]
    # Full records exist only for these genuine completed runs; rejected/skipped attempts have none.
    paths=sorted((ROOT/'artifacts/inloop').rglob('*.record.json'))
    seen=set()
    for path in paths:
        record=read(path);run_id=record.get('runId')
        if run_id in seen:continue
        seen.add(run_id)
        items=public_inputs(record)
        source={'record_file':str(path),'run_id':run_id}
        samples,excluded,aux=extract(items,source)
        inventory.append({'record_file':str(path),'sha256':sha(path),'run_id':run_id,
                          'public_input_count':len(items),'eligible_primary':len(samples),'excluded':len(excluded),'auxiliary_turns':len(aux),
                          'follow_100_requests':sum(x.get('method')=='follow_road' and x.get('args',{}).get('maxCm')==100 for x in items)})
        all_samples+=samples;all_excluded+=excluded;all_aux+=aux;public_records.append({'source':source,'inputs':items})
    scopes={'opt1_round2':[s for s in all_samples if '/opt-1/round-2/' in s['source']['record_file']],
            'opt1_round1':[s for s in all_samples if '/opt-1/round-1/' in s['source']['record_file']],
            'all_saved_full_records':all_samples}
    reports={}
    for scope,samples in scopes.items():
        strata=defaultdict(list)
        for sample in samples:strata[sample['speed_stratum']].append(sample)
        reports[scope]={key:{'eligibility':repeats(rows),'fit':fit_all(rows),'feasibility_10pct':residual_feasibility(rows),
                            'take_exit_only':{'samples':len([s for s in rows if s['method']=='take_exit']),
                                              'fit':fit_all([s for s in rows if s['method']=='take_exit']),
                                              'feasibility_10pct':residual_feasibility([s for s in rows if s['method']=='take_exit'])},
                            'sample_order_for_constraint_pairs':[{'source':s['source'],'input_index':s['input_index']} for s in rows]}
                        for key,rows in sorted(strata.items())}
    # Required protocol groups are defined by requested public exit angle,
    # independent of residual and layout. Keep EVERY matching complete row.
    protocol_samples=[s for s in scopes['opt1_round2'] if s['speed_stratum']=='speed=30;obey=True'
                      and ((s['method']=='take_exit' and s['requested_exit_turn_deg'] in (45,90,180))
                           or (s['method']=='follow_road' and s['args'].get('maxCm')==100 and s['turn_deg']==0))]
    protocol={'selection':'r2; speed30; obeySpeedLimit=true; all fixed-eligible take_exit requested45/90/180 and single follow100 straight; no residual/layout selection',
              'requested_angle_is_not_measured_net_angle':True,'samples':protocol_samples,'eligibility':repeats(protocol_samples),
              'fit':fit_all(protocol_samples),'feasibility_10pct':residual_feasibility(protocol_samples)}
    missing=[]
    for folder in [*(ROOT/'artifacts/inloop').glob('calib_runs*'),*(ROOT/'artifacts/inloop/stage-1').glob('round-*')]:
        for path in sorted(folder.glob('*.json')):
            if (path.stem.startswith('map-') and len(path.stem)==6) or (folder.name.startswith('calib_runs') and '.' not in path.stem):
                raw=read(path)
                if not isinstance(raw,dict) or 'lines' not in raw:continue
                if not raw.get('fullRecordFile') and not (raw.get('record') or {}).get('inputs'):
                    missing.append({'raw_file':str(path),'reason':'only trimmed record/logs retained; no complete navigation inputs/elapsedTicks; no truth-sample timing substitution'})
    blocks=[]
    any100=any(i['follow_100_requests'] for i in inventory)
    if not any100:blocks.append('No saved full record contains even one follow_road(maxCm=100) request; >=3 complete 100cm straight controls required.')
    else:blocks.append('Requested 100cm controls must additionally satisfy complete stop and exact public odometry qualification; see per-stratum coverage.')
    formal=any(s['eligibility']['required_coverage'] and s['fit'].get('nonnegative_coefficients') and s['fit'].get('residuals_at_most_10pct') for s in reports['all_saved_full_records'].values())
    if not formal:blocks.append('No speed stratum meets both all required repeat groups and <=10% residual for all fixed eligible samples; no runtime k is authorized.')
    report={'schema':'p3-public-turn-calibration/v1','status':'PASS' if formal else 'BLOCKED','formal_runtime_k':None,
            'policy':POLICY,'scope':'all opt1 r2/r1 full records and historical saved full records; older calibration/stage1 availability audited',
            'inventory':inventory,'missing_historical_inputs':missing,'stratified_reports':reports,
            'required_protocol_subset':protocol,
            'eligible_samples':all_samples,'excluded_samples':all_excluded,
            'exclusion_reasons':dict(Counter(reason for s in all_excluded for reason in s['eligibility_reasons'])),
            'auxiliary_turn_angle_samples':all_aux,'auxiliary_turns_cannot_replace_road_controls':True,
            'blocking_evidence':blocks,
            'code_review':{'existing_fit_file':'/Users/ken/wm_kit/selection/calibration.py','existing_fit_sha256':sha(Path('/Users/ken/wm_kit/selection/calibration.py')),
                           'existing_fit_contract':'elapsedTicks=a*distance_cm+b*abs(turn_deg), k=b/a; caller responsible for measurement qualification; this extractor supplies nonnegative abs turns',
                           'acceptance_source':str(ROOT/'artifacts/inloop/stage-1/ACCEPTANCE.md')},
            'truth_not_used':['record.samples','record.startState','control.startState','mission.objects','scene target positions','vision renderTruth'],
            'minimum_missing_protocol':['Use one frozen public road-control speed/obeySpeedLimit setting throughout each stratum.',
                'Locate an available straight segment using public graph/road_state only, with more than 100cm before the next node and sufficient clearance; issue one follow_road(100,speed,obey) per repeat, three accepted max_distance completions.',
                'At legal nodes choose exits using public road_state.exits. For prescribed 45/90/180deg groups, log and perform a preparation rotation equal to current public exit turnDeg minus desired turnDeg; refetch road_state to verify the public requested turn before take_exit. Perform three repetitions per group, with entered_road and exact public odometry before/after.',
                'Mark preparation vs measured controls before execution; preserve every preparation command and every failed measurement in the logs. Pure alignment turns are not measured take_exit repetitions. Do not regroup or drop any eligible measurement after looking at residuals.',
                'Record complete inputs, start/end public odometry, selected public exit turnDeg, elapsedTicks, distanceCm, speed and stoppedBy. Preserve all fixed-eligible controls including poor residuals.',
                'Fit all prequalified controls; if per-observation residual still exceeds10%, report model failure rather than adopt a scalar k. No experiment was started by this tool.']}
    (args.out/'calibration.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    (args.out/'public_control_inputs.json').write_text(json.dumps({'records':public_records},ensure_ascii=False,indent=2)+'\n')
    lines=['# P3.1 转向成本标定：'+report['status'],'','**不发布可运行 k。** 仅使用已保存公开控制 inputs；不使用场景真值，不启动仿真。','',
           f"已审查 {len(inventory)} 份完整真实运行记录；合格道路控制 {len(all_samples)} 条，排除 {len(all_excluded)} 条，原地turn_angle辅助 {len(all_aux)} 条。历史 {len(missing)} 份raw没有完整inputs，不能据samples补造控制时序。",'',
           '|范围/请求速度|合格样本|100cm完整直行|90°道路出口|180°道路出口|≥3重复非零转角组|诊断k(cm/°)|最大残差|>10%数|','|---|---:|---:|---:|---:|---:|---:|---:|---:|']
    for scope,strata in reports.items():
        for speed,item in strata.items():
            e,f=item['eligibility'],item['fit'];k=f.get('k');mx=f.get('max_relative_residual')
            lines.append(f"|{scope} / {speed}|{f['samples']}|{e['single_100cm_straight_count']}|{e['exit_90_count']}|{e['exit_180_count']}|{e['nonzero_angle_groups_with_3_repeats']}|{k:.6f}|{mx:.2%}|{f['over_10pct']}|" if k is not None else f"|{scope} / {speed}|{f['samples']}|{e['single_100cm_straight_count']}|{e['exit_90_count']}|{e['exit_180_count']}|{e['nonzero_angle_groups_with_3_repeats']}|unknown|unknown|unknown|")
    lines+=['','表中 k 全为诊断拟合，不能作为正式标定值。所有符合固定资格的样本均进入对应速度层，无按残差删除。误差定义为 |预测ticks−实测ticks|/实测ticks；原要求≤10%没有放宽。','']+['- '+b for b in blocks]+['','资格预先由类型、速度、stopreason和精确公开里程计决定：follow仅max_distance、take_exit仅entered_road，动作起止tick精确绑定，排除混入其它控制。转角使用公开heading最短角差，角度分组仅用原公开exits.turnDeg，不将87.7°四舍五入成90°。速度30和100分层，不择优选层通过。','','100cm缺失不能由十次10cm控制或纯turn_angle补足。净heading角只反映端点姿态，不声称获得曲线内总转角。道路限速和控制器开销可能使单k不足，残差照实报告。','','最小补采方案（仅提案，本工具未运行）：']+['- '+p for p in report['minimum_missing_protocol']]+['','全部实测样本行索引/seq、公开里程计起止、逐样本残差见 calibration.json；严格公开字段投影见 public_control_inputs.json。','', '复跑：`PYTHONDONTWRITEBYTECODE=1 python3 tools/p3_turn_calibration.py`','']
    lines+=['','任何非负k能否同时达到10%的可行性审查：']
    for speed,item in reports['opt1_round2'].items():
        feasible=item['feasibility_10pct']
        lines.append(f"- r2 {speed}: {feasible['any_nonnegative_k_can_satisfy_10pct']}；必要k区间[{feasible['required_k_lower_bound']}, {feasible['required_k_upper_bound']}]。这是全样本约束，不只检查最小二乘解。")
        for witness in feasible['identical_feature_contradictions'][:1]:
            fast,slow=witness['fast'],witness['slow']
            lines.append(f"  同一distance={witness['distance_cm']}cm、turn={witness['turn_deg']:.1f}°：{fast['elapsed_ticks']}ticks（{Path(fast['source']['record_file']).name} inputs[{fast['input_index']}], seq{fast['input_seq']}）与{slow['elapsed_ticks']}ticks（{Path(slow['source']['record_file']).name} inputs[{slow['input_index']}], seq{slow['input_seq']}）。任何只用这两特征的预测至少有{witness['minimum_possible_max_relative_residual']:.2%}最大相对残差。")
    pf=protocol['fit']
    lines+=['','必需协议子集（r2 speed30，全部公开请求45/90/180°完整出口控制，不按误差删样本）：',
            f"共{pf['samples']}条；OLS k={pf['k']:.8f}仅作诊断，最大残差{pf['max_relative_residual']:.3%}，{pf['over_10pct']}条超过10%。协议子集存在可满足10%的非负参数区间，不应据全角域失败声称它也数学不可行；但本次固定OLS解未达门，且缺100cm×3，不发布k。",
            '', '|公开请求角|实际净角|实测距离cm|elapsedTicks|源inputs索引/seq|', '|---:|---:|---:|---:|---|']
    for sample in sorted(protocol_samples,key=lambda s:(s.get('requested_exit_turn_deg') or 0,s['source']['record_file'],s['input_index'])):
        lines.append(f"|{sample.get('requested_exit_turn_deg')}|{sample['turn_deg']:.1f}|{sample['distance_cm']}|{sample['elapsed_ticks']}|{Path(sample['source']['record_file']).name} inputs[{sample['input_index']}], seq{sample['input_seq']}|")
    lines+=['','名义出口90°的实际净角均90.8°；180°名义组实际149.4–172.9°。由公开里程计如实报告，不将道路控制内弯道变向误记成纯90/180原地转向。']
    protocol_text='''# P3.1 最小公开 API 标定协议（未执行）

冻结后使用请求 speed=30、obeySpeedLimit=True。测量批次为独立的12个完整控制：follow_road(100)三次；take_exit 的公开请求出口角45/90/180°各三次。全部准备移动和失败尝试也进入完整record.inputs，不能作为未登记试跑。采集轮次/预算归属先由根任务明确。

1. 只用公开 map_graph、road_state、odometry 判断合法道路、单行限制、剩余长度和净空。选足够长的道路，在道路内稳定起步；单次调用follow_road(100,30,True)。记录精确起止odometry和返回elapsedTicks/distanceCm/stoppedBy。需accepted=True、max_distance结束及实际完整100cm；遇节点/净空提前停止必须保留为不合格实验，不能用十段10cm替代。
2. 在合法节点选择公开exits中的出口，以该项turnDeg减所需45/90/180°得到准备朝向旋转量。准备旋转后重新读取road_state确认出口仍合法和其公开转角；准备转向本身不当作take_exit标定。完整记录旋转和重定位，不读取目标锚点或真值坐标。
3. 在测量动作前写明phase=measurement、组角、repeat编号、speed/obey；随后调用take_exit。起止都读取公开odometry；要求accepted=True且stoppedBy=entered_road。拟合用实际distanceCm与实际最短heading差，同时另列请求出口角；不能把名义180°直接填成实测180°。每组全部三个重复均列出。
4. 重复间所有返回节点/道路与调整朝向均标记phase=preparation并留档；不得因看到残差再把某次measurement改成preparation。规定测量资格只看控制、速度、stopreason、精确公开里程计；失败尝试保留原因。新采集结束前不改程序。
5. 按预定模型elapsedTicks=a*distance_cm+b*abs(turn_deg)一次拟合全部合格测量，k=b/a。逐条相对残差=abs(predicted-observed)/observed，门限10%；不按残差排除。若仍不满足，明确单k模型/适用域受阻，不能引用软件内速度常数充作实测，也不自动增加隐藏轮次。

本文件是采集方案，不含可执行生产程序；本次没有发出任何机器人命令。
'''
    (args.out/'CALIBRATION_PROTOCOL.md').write_text(protocol_text)
    (args.out/'CALIBRATION.md').write_text('\n'.join(lines))
    print(json.dumps({'status':report['status'],'records':len(inventory),'eligible':len(all_samples),'formal_runtime_k':None,'out':str(args.out)},ensure_ascii=False))


if __name__=='__main__':main()
