#!/usr/bin/env python3
"""Read frozen R1 native controls and current R2 motion/build scope; no execution."""
import ast
from collections import Counter
import hashlib
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[4]
R1 = ROOT / 'artifacts/inloop/opt-2/round-1'
R2 = OUT.parent

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def functions(path):
    return {n.name:n for n in ast.parse(path.read_text()).body if isinstance(n, ast.FunctionDef)}

def digest(node):
    return ast.dump(node, include_attributes=False)

def control_summary(items, step_ms):
    return {'count':len(items), 'speeds':dict(Counter(str(e['args'].get('speed')) for e in items)),
            'distance_cm':round(sum(float(e['result'].get('distanceCm',0)) for e in items), 3),
            'control_seconds':round(sum(float(e['result'].get('elapsedTicks',0)) for e in items)*step_ms/1000,3),
            'stop_reasons':dict(Counter(e['result'].get('stoppedBy') for e in items)),
            'controls':items}

def run():
    report = json.loads((R1/'opt2_report.json').read_text())
    groups = {m:s['scenario'] for s in report['scenarios'] for m in s['members']}
    runs = []
    for rawpath in sorted(R1.glob('map-??.json')):
        raw = json.loads(rawpath.read_text()); nativepath=Path(raw['fullRecordFile']); record=json.loads(nativepath.read_text())
        lines=raw['lines']; step=record['simulationDefinition']['stepMs']
        inputs=[dict(input_index=i,**e) for i,e in enumerate(record['inputs'])]
        controls=[e for e in inputs if e.get('type')=='navigation_control']
        odos=[e for e in inputs if e.get('type')=='navigation_query' and e.get('method')=='odometry']
        phases=[]
        for line_index,confirmed in enumerate(lines):
            if confirmed.get('event')!='ball_confirmed': continue
            end_entry=next(((i,e) for i,e in enumerate(lines[line_index+1:],line_index+1)
                            if e.get('event')=='approach_graph_memory_distance'),None)
            if not end_entry: continue
            start_tick=confirmed['tick']; end_index,end=end_entry
            before=[e for e in odos if e['tick']<=start_tick][-1]
            target=round(before['result']['distanceCm']+end['movedCm'],1)
            after=next(e for e in odos if e['tick']>=start_tick and round(e['result']['distanceCm'],1)==target)
            selected=[e for e in controls if start_tick<=e['tick'] and e['tick']+e['result'].get('elapsedTicks',0)<=after['tick']
                      and e['input_index']>before['input_index'] and e['input_index']<after['input_index']]
            phases.append({'ball_index':confirmed['ball_index'],'confirmed_line':line_index,'end_line':end_index,
                           'start_tick':start_tick,'end_tick':after['tick'],'start_odometry_input':before['input_index'],
                           'end_odometry_input':after['input_index'],'memory_odometer_cm':end['movedCm'],
                           'memory_elapsed_seconds':(after['tick']-start_tick)*step/1000,
                           'road_controls':control_summary(selected,step)})
        previews=[]
        for i,e in enumerate(lines):
            if e.get('event')=='delivery_release_preview': previews.append(dict(line_index=i,**e))
        raw_storage=next(e['result']['storage'] for e in inputs if e.get('method')=='mission')
        selected=[dict(line_index=i,**e) for i,e in enumerate(lines) if e.get('event')=='delivery_candidate_selected']
        candidate_rejections=[dict(line_index=i,**e) for i,e in enumerate(lines)
                              if e.get('event')=='delivery_candidate_rejected' and e.get('reason')=='already_tried']
        preview_counts=Counter(e['key'] for e in previews)
        # The actual emitted points show sub-grid candidates. They are not claimed
        # to have all received a heading sweep; preview counts say exactly which did.
        candidate_events=[dict(line_index=i,**e) for i,e in enumerate(lines)
                          if e.get('event') in ('delivery_candidate_selected','delivery_candidate_rejected')]
        anchors=[]
        for progress in (raw_storage['progressCm'],5.0):
            key='storage:'+raw_storage['roadId']+'@'+str(round(progress,1))
            matching=[e for e in candidate_events if e.get('key')==key]
            anchors.append({'key':key,'progress_cm':progress,'preview_count':preview_counts[key],
                            'candidate_events':matching[:3]})
        speed_groups={str(speed):control_summary([e for e in controls if e['args'].get('speed')==speed],step)
                      for speed in sorted({e['args'].get('speed') for e in controls})}
        ball2=next((dict(line_index=i,**e) for i,e in enumerate(lines) if e.get('event')=='ball_start' and e.get('ball_index')==2),None)
        ball2_controls=[e for e in controls if ball2 is not None and e['tick']>=ball2['tick']]
        runs.append({'map':rawpath.stem,'scenario':groups[rawpath.stem], 'raw_path':str(rawpath), 'raw_sha256':sha(rawpath),
                     'native_path':str(nativepath),'native_sha256':sha(nativepath),'step_ms':step,'memory_phases':phases,
                     'all_road_controls_by_speed':speed_groups, 'ball2_start':ball2,
                     'all_ball2_road_controls':control_summary(ball2_controls,step),'storage_anchor':raw_storage,
                     'storage_anchor_and_adjacent_grid':anchors,'all_candidate_selected':selected,
                     'preview_counts':dict(preview_counts)})
    current=R2/'program.py'
    if not current.exists(): current=ROOT/'programs/world_model_opt2.py'
    old=R1/'program.py'; motion=ROOT/'programs/opt2_motion_fragment.py'
    build=ROOT/'tools/build_opt2_program.py'; newf=functions(current); oldf=functions(old)
    unchanged={name:digest(newf[name])==digest(oldf[name]) for name in
               ('_approach_graph_navigation','_mag_frontier_step','_record_hit','_confirmation_result','_demo_reset_ball','_demo_lock_target') if name in oldf}
    source_changes={}
    for name,field in (('_demo_reset_ball','ball_start_track_ids'),('_demo_lock_target','target_source')):
        normalized_flow=ast.parse(ast.unparse(newf[name])).body[0]
        normalized_flow.body=[n for n in normalized_flow.body if not (
            isinstance(n,ast.Assign) and any(isinstance(t,ast.Subscript) and
            isinstance(t.value,ast.Name) and t.value.id=='DEMO_STATE' and
            isinstance(t.slice,ast.Constant) and t.slice.value==field for t in n.targets))]
        source_changes[name+'_only_adds_'+field]=digest(normalized_flow)==digest(oldf[name])
    normalized=ast.parse(ast.unparse(newf['approach_target_with_world_model'])).body[0]
    class RestoreMemory(ast.NodeTransformer):
        def visit_Name(self,n):
            if n.id=='_opt2_memory_navigation': n.id='_approach_graph_navigation'
            return n
    unchanged['fine_function_except_memory_wrapper']=digest(RestoreMemory().visit(normalized))==digest(oldf['approach_target_with_world_model'])
    callsites=[]
    for name,fn in newf.items():
        for n in ast.walk(fn):
            if (isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id in
              ('_opt2_memory_navigation','_opt2_patrol_follow','_opt2_patrol_enter','_opt2_update_observations','_opt2_confirmation_should_abort')):
                callsites.append({'owner':name,'callee':n.func.id,'line':n.lineno,'arguments':[ast.unparse(a) for a in n.args]})
    result={'schema':'opt2-r2-motion-review/v1','mode':'read-only offline audit; no simulator or code edits',
            'inputs':{str(p):sha(p) for p in (current,old,motion,build)},'unchanged_ast_checks':unchanged,'expected_source_bookkeeping_diff_checks':source_changes,
            'callsites':callsites,'runs':runs,'index_convention':'raw lines/native inputs zero-based; source one-based'}
    (OUT/'motion-review.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'checks':unchanged,'runs':len(runs)},ensure_ascii=False))

if __name__=='__main__':run()
