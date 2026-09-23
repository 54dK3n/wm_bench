#!/usr/bin/env python3
"""Final offline motion/delivery facts. Writes only diagnosis.json beside itself."""
import ast
from collections import Counter
import hashlib
import json
import math
from pathlib import Path

OUT=Path(__file__).resolve().parent
ROUND=OUT.parent
PREVIOUS=ROUND.parent/'round-1'
UNITS_PER_METER=8.0  # Existing platform scene/public conversion; driver-only.

def read(path):return json.loads(path.read_text())
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def rows(lines,names,start=0,end=None):
    return [dict(line_index=i,**e) for i,e in enumerate(lines) if start<=i<(len(lines) if end is None else end) and e.get('event') in names]
def count(items,key):return dict(Counter(str(e.get(key)) for e in items))
def native_event(e,index,step):return dict(event_index=index,tick=e.get('t',0)/step,**e)
def exact_pose(record,tick):
    found=[(i,e) for i,e in enumerate(record['inputs']) if e.get('tick')==tick and e.get('startState',{}).get('tick')==tick and e['startState'].get('pose')]
    if not found or any(e['startState']['pose']!=found[0][1]['startState']['pose'] for i,e in found):return None
    return {'pose':found[0][1]['startState']['pose'],'input_indices':[i for i,e in found],'input_seq':[e['seq'] for i,e in found]}
def control_slice(inputs,start_tick,end_tick):
    items=[dict(input_index=i,**e) for i,e in enumerate(inputs) if e.get('type')=='navigation_control' and e['tick']>=start_tick and e['tick']+e['result'].get('elapsedTicks',0)<=end_tick]
    return {'count':len(items),'distance_cm':sum(e['result'].get('distanceCm',0) for e in items),'stops':count([e['result'] for e in items],'stoppedBy'),'inputs':items}

def main():
    report=read(ROUND/'opt2_report.json'); bymap={r['map']:r for r in report['runs']}
    group={m:g['scenario'] for g in report['scenarios'] for m in g['members']}
    runs=[]; total_grabs=Counter(); terminal=Counter()
    for path in sorted(ROUND.glob('map-??.json')):
        raw=read(path); native_path=Path(raw['fullRecordFile']); native=read(native_path); lines=raw['lines']; inputs=native['inputs']; step=native['simulationDefinition']['stepMs']
        final=rows(lines,{'flow_end'})[-1]
        events=[native_event(e,i,step) for i,e in enumerate(native['events']) if e.get('interactionType')=='package_grab' or e.get('type')=='package_delivered']
        attempts=[e for e in events if e.get('interactionType')=='package_grab']; total_grabs.update(e.get('reason') for e in attempts)
        for e in attempts:
            pose=exact_pose(native,e['tick']);e['exact_pose_evidence']=pose
            if pose and e.get('position'):
                p=pose['pose'];dx,dz=e['position'][0]-p['x'],e['position'][1]-p['z'];h=p['heading']
                e['truth_forward_cm']=(dx*-math.sin(h)-dz*math.cos(h))*100/UNITS_PER_METER
                e['truth_right_cm']=(dx*math.cos(h)-dz*math.sin(h))*100/UNITS_PER_METER
        grab_count=sum(e.get('accepted') is True for e in attempts)
        deliveries=[e for e in events if e.get('type')=='package_delivered']
        if len(deliveries)==2:category='two_delivered'
        elif final['reason']=='navigation_queries_budget_exhausted':category='delivery_query_budget' if final.get('holding') else 'second_memory_query_budget'
        else:category='first_confirmation_failed' if final['ball_index']==1 else 'second_confirmation_failed'
        terminal[category]+=1
        phases=[]
        for start in rows(lines,{'delivery_phase_start'}):
            finish=next((i for i in range(start['line_index']+1,len(lines)) if lines[i].get('event')=='ball_start'),len(lines))
            grab=rows(lines,{'ball_grabbed'},end=start['line_index'])[-1];start_tick=grab['tick'];end_tick=lines[finish]['tick'] if finish<len(lines) else native['simulationEndTick']
            preview=rows(lines,{'delivery_release_preview'},start['line_index'],finish)
            grouped=[]
            for key in dict.fromkeys(e['key'] for e in preview):
                matches=[e for e in preview if e['key']==key]
                grouped.append({'key':key,'count':len(matches),'first_line':matches[0]['line_index'],'last_line':matches[-1]['line_index'],
                                'first_tick':matches[0]['preview']['tick'],'last_tick':matches[-1]['preview']['tick'],
                                'wouldCompleteDelivery_true':sum(e['preview'].get('wouldCompleteDelivery') is True for e in matches)})
            rejects=rows(lines,{'delivery_candidate_rejected'},start['line_index'],finish)
            selected=rows(lines,{'delivery_candidate_selected'},start['line_index'],finish)
            queries=[dict(input_index=i,**e) for i,e in enumerate(inputs) if e.get('type')=='navigation_query' and start_tick<e['tick']<=end_tick]
            phase={'ball_index':grab['ball_index'],'start_line':start['line_index'],'end_line_exclusive':finish,'start_tick':start_tick,'end_tick':end_tick,
                'preview_count':len(preview),'preview_groups':grouped,'selected_count':len(selected),'selected':selected,'rejections':rejects,'rejection_counts':count(rejects,'reason'),
                'public_queries_strict_start_count':len(queries),'public_queries_by_method':count(queries,'method'),
                'movement_events':rows(lines,{'viewpoint_direction_measurement','viewpoint_take_exit','viewpoint_unreachable','viewpoint_local_clearance_blocked',
                    'delivery_gateway_explored','delivery_gateway_travel','delivery_candidate_unreachable','delivery_candidate_travel'},start['line_index'],finish),
                'native_controls':control_slice(inputs,start_tick,end_tick),
                'end_events':rows(lines,{'ball_delivered','delivery_leave_complete','delivery_leave_failed','delivery_search_failed','ball_end','flow_end'},start['line_index'],finish)}
            phases.append(phase)
        metric_keys=['ball_index','track_id','package_id','first_WM_confirmed_seconds','confirmed_seconds','grabbed_seconds','delivered_seconds','confirmation_line','last_confirmation_observe_line','grab_event_index','delivery_event_index','grab_attempts','approach_calls',
            'confirm_to_grab_total_odometer_cm','odometer_boundaries','confirm_to_grab_road_controls_cm','road_control_evidence','confirm_to_grab_straight_cm','road_controls_straight_ratio','total_odometer_straight_ratio','actual_grab_sight_vs_approach_deg','pre_approach_sight_angle_deg','grab_truth_exact_tick','grab_truth_forward_cm','grab_truth_right_cm']
        balls=[{k:b.get(k) for k in metric_keys} for b in bymap[path.stem]['balls']]
        checks=[]
        for b in balls:
            if b['grab_event_index'] is not None:
                start=round(b['confirmed_seconds']*1000/step);end=native['events'][b['grab_event_index']]['t']/step
                road=control_slice(inputs,start,end)
                checks.append({'ball_index':b['ball_index'],'road_control_cm':road['distance_cm'],'report_road_cm':b['confirm_to_grab_road_controls_cm'],
                               'matches':math.isclose(road['distance_cm'],b['confirm_to_grab_road_controls_cm'],abs_tol=1e-9)})
        unresolved=[]
        for b in balls:
            if b['confirmed_seconds'] is None or b['grabbed_seconds'] is not None:continue
            tick=round(b['confirmed_seconds']*1000/step)
            odos=[dict(input_index=i,**e) for i,e in enumerate(inputs) if e.get('method')=='odometry' and e['tick']>=tick]
            start_odo=next(e for e in odos if e['tick']==tick)
            tracks=rows(lines,{'wm_targets'},end=b['confirmation_line'])[-1]['tracks']
            target=next(e for e in tracks if e['id']==b['track_id'])
            distances=[(math.hypot(e['result']['rightCm']/100-target['x'],e['result']['forwardCm']/100-target['z']),e) for e in odos]
            closest=min(distances,key=lambda pair:pair[0]);selected=rows(lines,{'approach_graph_selected'},b['confirmation_line'])
            controls=control_slice(inputs,tick,native['simulationEndTick'])
            queries=[e for e in inputs if e.get('type')=='navigation_query' and e['tick']>tick]
            unresolved.append({'ball_index':b['ball_index'],'confirmation_tick':tick,'end_tick':native['simulationEndTick'],
                'start_odometry':start_odo,'last_odometry':odos[-1],'total_odometer_cm':odos[-1]['result']['distanceCm']-start_odo['result']['distanceCm'],
                'elapsed_seconds':(native['simulationEndTick']-tick)*step/1000,'road_controls':controls,
                'query_count_strict_after':len(queries),'query_methods':count(queries,'method'),
                'post_confirm_observe_count':len(rows(lines,{'observe'},b['confirmation_line'])),
                'wm_target':target,'minimum_public_odometry_WM_distance_m':closest[0],'closest_odometry':closest[1],
                'final_public_odometry_WM_distance_m':distances[-1][0],
                'selected_count':len(selected),'selected_kind_counts':count(selected,'kind'),
                'selected_roads':dict(Counter(e['key'].split('@')[0] for e in selected)),
                'last_selected':selected[-1],
                'frontier_failure_counts':count(rows(lines,{'approach_frontier_failed','approach_graph_rejected','approach_frontier_rejected'},b['confirmation_line']),'reason')})
        old=read(PREVIOUS/path.name);oldnativepath=Path(old['fullRecordFile']);oldnative=read(oldnativepath)
        previous={'raw_path':str(PREVIOUS/path.name),'raw_sha256':sha(PREVIOUS/path.name),'native_sha256':sha(oldnativepath),
                  'graph_memory_distance_lines':rows(old['lines'],{'approach_graph_memory_distance'}),
                  'native_deliveries':[native_event(e,i,oldnative['simulationDefinition']['stepMs']) for i,e in enumerate(oldnative['events']) if e.get('type')=='package_delivered'],
                  'simulationEndTick':oldnative['simulationEndTick']}
        runs.append({'map':path.stem,'scenario':group[path.stem],'hashes':{'raw':sha(path),'native':sha(native_path)},'native_path':str(native_path),
             'native_program_errors':sum(e.get('type')=='program_error' for e in native['events']),
             'native_navigation_queries':sum(e.get('type')=='navigation_query' for e in inputs),
             'native_navigation_controls':sum(e.get('type')=='navigation_control' for e in inputs),
             'simulationEndTick':native['simulationEndTick'],'simulation_seconds':native['simulationEndTick']*step/1000,'flow_end':final,'terminal_category':category,
             'ball_start_lines':rows(lines,{'ball_start'}),'phase_lines':rows(lines,{'ball_confirmed','ball_grabbed','ball_delivered','ball_end'}),'last_observe':rows(lines,{'observe'})[-1],
             'grab_count':grab_count,'delivery_count':len(deliveries),'grab_reason_counts':count(attempts,'reason'),'grab_attempts_exact_geometry':attempts,
             'native_deliveries':deliveries,'delivery_phases':phases,'ball_motion_metrics':balls,'road_metric_independent_checks':checks,
             'uncompleted_memory':unresolved,'lateral_recovery':rows(lines,{'grab_lateral_recovery_start','grab_lateral_recovery_step','grab_lateral_recovery_end'}),
             'previous_round1':previous})
    funcs={n.name:{'line':n.lineno,'end_line':n.end_lineno} for n in ast.parse((ROUND/'program.py').read_text()).body if isinstance(n,ast.FunctionDef)}
    payload={'schema':'opt2-r3-final-motion-diagnosis/v1','scope':'completed immutable records only; no simulation or production edits; no causal speculation',
         'index_convention':'raw lines and native inputs/events zero-based; source one-based; native event tick=t_ms/stepMs',
         'report_dependency_sha256':sha(ROUND/'opt2_report.json'),'program_sha256':sha(ROUND/'program.py'),
         'terminal_counts':dict(terminal),'all_native_grab_reason_counts':dict(total_grabs),'functions':funcs,'runs':runs}
    (OUT/'diagnosis.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'terminal_counts':dict(terminal),'grab_reasons':dict(total_grabs),'all_road_checks_match':all(c['matches'] for r in runs for c in r['road_metric_independent_checks'])}))

if __name__=='__main__':main()
