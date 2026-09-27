#!/usr/bin/env python3
"""Export a synthetic public-sensor executable recovery component; no simulator/model.

Uses the selected repository's actual tests/Runtime/Perception/WorldModel,
RoadMemory/Actions and frozen normalizeCommand. Never replaces confirmation.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path
import sys


def fingerprints(repo):
    selected={'autonomous_brain/navigation.py':{'_record_approach_segment','approach_candidates','_approach_execution_unavailable'},
        'autonomous_brain/actions.py':{'_approach_node_connection','_approach_basic_plan','_align_approach_body','_follow_approach_path','_road_reposition'},
        'tests/test_brain_executable_recovery.py':{'real_perception_component'},
        'tests/test_brain_confirmation_sampling.py':set(),
        'tests/test_brain_route_contract.py':{'normalize'},
        'autonomous_brain/perception.py':set(),'autonomous_brain/run.py':set(),
        'workspaces/guangyang-platform/projects/car-python/robot-bridge-contract.js':set()}
    for pattern in ('autonomous_brain/*.py','vendor/wm_kit_opt2/world_model/**/*.py'):
        for path in repo.glob(pattern):selected.setdefault(str(path.relative_to(repo)),set())
    for name in ('tools/diagnose_executable_recovery.py','tools/diagnose_confirmation_sampling.py','tests/test_brain_perception.py'):
        selected.setdefault(name,set())
    result={}
    for name,methods in selected.items():
        raw=(repo/name).read_bytes()
        row={'sha256':hashlib.sha256(raw).hexdigest(),'functions':{}}
        if methods:
            for node in ast.walk(ast.parse(raw)):
                if isinstance(node,ast.FunctionDef) and node.name in methods:
                    row['functions'][node.name]={'ast_sha256':hashlib.sha256(
                        ast.dump(node,include_attributes=False).encode()).hexdigest(),
                        'first_line':node.lineno,'last_line':node.end_lineno}
            if set(row['functions'])!=methods:raise ValueError('Missing selected function: '+name)
        result[name]=row
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output',required=True,type=Path,help='New file; never overwrites')
    parser.add_argument('--expect-fingerprints',type=Path,
        help='Optional prior artifact containing source_before; verify exact file/AST hashes before execution')
    args=parser.parse_args();repo=args.repo.resolve()
    if args.output.exists():parser.error('Choose a new output path')
    before=fingerprints(repo)
    if args.expect_fingerprints:
        expected=json.loads(args.expect_fingerprints.read_text())['source_before']
        if before!=expected:parser.error('Selected source/AST fingerprints differ from requested artifact')
    sys.path[:0]=[str(repo),str(repo/'tools'),str(repo/'tests'),str(repo/'vendor/wm_kit_opt2')]
    from test_brain_executable_recovery import real_perception_component
    from diagnose_confirmation_sampling import hit_checks
    runtime,diagnostic=real_perception_component()
    after=fingerprints(repo)
    result=diagnostic['result'];attempt=result.get('evidence',{}).get('road_reposition',{}).get('attempts',[{}])[0]
    hits=hit_checks(runtime)
    calls=runtime.bridge.calls[diagnostic['call_start']:]
    checks={'sources_unchanged':before==after,'result_success':result['success'] is True,
        'true_confirmed_identity':runtime.perception.get_object(diagnostic['confirmed_id'])['state']=='CONFIRMED',
        'all_hits_independently_join_public_pixels':all(x['every_hit_has_public_frame'] and x['separated'] and x['has_required_hits'] for x in hits),
        'inverse_road_connection_sequence':[m for m,_ in calls if m!='turn']==['backward','follow_road','forward'],
        'no_premature_node_region_completion':bool(attempt.get('steps')) and 'completed_segment_ids' not in attempt['steps'][1],
        'fresh_visual_observation_after_route':attempt.get('approach_observation',0)>attempt.get('steps',[{}])[-1].get('after_observation',0),
        'original_standoff_gate':25<=result.get('evidence',{}).get('detection',{}).get('distance_cm',-1)<=40,
        'budget_not_extended':0<=diagnostic['remaining_budget']<=45,
        'candidate_attempts_bounded':len(result.get('evidence',{}).get('road_reposition',{}).get('attempts',[]))<=3}
    artifact={'schema':'synthetic-executable-recovery-component/v1',
        'scope':{'synthetic':True,'formal_result':False,'simulator_calls':False,'model_calls':False,
                 'real_perception_world_model_runtime_actions':True,'region_sensor_computed_from_pose':True,
                 'node_identity_merge_claim':False},
        'selected_repository':str(repo),'source_before':before,'source_after':after,
        'observations':runtime.trace,'motions':runtime.motions,'normalized_motor_calls':runtime.bridge.calls,
        'component':diagnostic,'independent_hit_checks':hits,'checks':checks,
        'diagnostic_checks_satisfied':all(checks.values())}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with args.output.open('x') as stream:json.dump(artifact,stream,ensure_ascii=False,indent=2,allow_nan=False);stream.write('\n')
    print(json.dumps({'output':str(args.output),'checks':checks,'synthetic':True},ensure_ascii=False))
    return 0 if all(checks.values()) else 1


if __name__=='__main__':raise SystemExit(main())
