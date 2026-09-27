#!/usr/bin/env python3
"""Create-only synthetic public-sensor evidence; no simulator/model/scene files."""
import argparse
import ast
import hashlib
import json
import math
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    repo = args.repo.resolve()
    if args.output.exists():
        parser.error('output exists; choose a new path')
    sys.path[:0] = [str(repo), str(repo / 'tests'), str(repo / 'vendor/wm_kit_opt2')]
    from autonomous_brain import confirmation_sampling as module
    import test_brain_sampling_viewpoint_comparison as fixtures
    from test_brain_confirmation_sampling import discovery_id, sampling_runtime, sample
    assert Path(module.__file__).resolve() == repo / 'autonomous_brain/confirmation_sampling.py'
    assert Path(fixtures.__file__).resolve() == repo / 'tests/test_brain_sampling_viewpoint_comparison.py'
    relative = ['autonomous_brain/confirmation_sampling.py', 'autonomous_brain/perception.py',
                'autonomous_brain/run.py', 'autonomous_brain/actions.py', 'autonomous_brain/navigation.py',
                'tests/test_brain_confirmation_sampling.py', 'tests/test_brain_sampling_viewpoint_comparison.py',
                'tests/test_brain_perception.py', 'tests/test_brain_route_contract.py']
    hashes = {p: hashlib.sha256((repo / p).read_bytes()).hexdigest() for p in relative}
    tree = ast.parse(Path(module.__file__).read_bytes())
    cases = []
    specifications = [
        ('near41_current_reverse', {'raw': 41, 'road_heading': 20, 'history_cm': 34, 'side_clearance': 20}, None, True),
        ('far87_turn_crosses_window', {'raw': 87, 'bearing': -25, 'road_heading': 20, 'at_node': True}, None, False),
        ('safe_node_turn', {'raw': 75, 'bearing': -20, 'road_heading': 20, 'at_node': True}, None, True),
        ('current_safe_forward', {'raw': 75, 'road_heading': 8}, None, True),
        ('near41_no_safe_plan', {'raw': 41, 'road_heading': 20}, None, False),
        ('lost_straight_view_restored', {}, 'transient', True),
        ('lost_turn_view_restored_not_repeated', {'raw': 75, 'bearing': -20, 'road_heading': 20, 'at_node': True}, 'turn', False),
        ('persistent_occlusion_only_one_restore', {}, 'persistent', False),
        ('lost_curve_not_straight_reversible', {'mode': 'curve'}, 'transient', False),
        ('invisible_before_action_no_motion', {}, 'initial_invisible', False),
    ]
    for name, options, occlusion, expected in specifications:
        runtime = (fixtures.comparison_runtime(**options) if options and 'mode' not in options
                   else sampling_runtime(**options))
        selected = discovery_id(runtime)
        setup_calls = len(runtime.bridge.calls)
        if occlusion == 'initial_invisible':
            runtime.bridge.pixels = lambda: []
            runtime.observe()
        elif occlusion:
            fixtures.obscure_first_new_view(runtime, only_after_turn=occlusion == 'turn', persist=occlusion == 'persistent')
        result = sample(runtime, selected)
        frames = {r['perception']['frame_id']: r for r in runtime.trace}
        checks = []
        for obj in runtime.perception.objects():
            if obj['category'] != 'red-ball':
                continue
            poses = obj['hit_poses']
            matches = []
            for pose in poses:
                observation = frames[pose['frame_id']]
                detections = [d for d in observation['perception']['detections']
                              if d.get('track_id') == obj['id'] and d.get('fed_to_world_model')]
                odo = observation['odometry']
                matches.append(len(detections) == 1 and 40 <= detections[0]['raw_distance_cm'] < 90
                    and abs(detections[0]['raw_bearing_deg']) <= 35
                    and abs(odo['rightCm'] / 100 - pose['x_m']) < 1e-9
                    and abs(odo['forwardCm'] / 100 - pose['z_m']) < 1e-9)
            separated = all(math.hypot(a['x_m'] - b['x_m'], a['z_m'] - b['z_m']) >= .15
                            for i, a in enumerate(poses) for b in poses[:i])
            checks.append({'object_id': obj['id'], 'state': obj['state'], 'hit_count': obj['hit_count'],
                           'hit_poses': poses, 'every_hit_has_admitted_public_frame': all(matches),
                           'pairwise_separated': separated})
        trace = result['evidence']['confirmation_sampling']
        verified = (result['success'] == expected and all(c['every_hit_has_admitted_public_frame']
            and c['pairwise_separated'] for c in checks)
            and len(trace['steps']) <= 12 and trace['travelled_cm'] <= 120
            and sum(s.get('phase') == 'restore_previous_view' for s in trace['steps']) <= 1
            and (not expected or any(c['state'] == 'CONFIRMED' and c['hit_count'] >= 3 for c in checks)))
        cases.append({'name': name, 'synthetic_render_inputs': options, 'occlusion_fixture': occlusion,
            'expected_success': expected, 'source_discovery_id': selected, 'setup_motor_call_count': setup_calls,
            'observations': runtime.trace, 'motions': runtime.motions, 'normalized_motor_calls': runtime.bridge.calls,
            'result': result, 'independent_public_hit_checks': checks, 'checks_satisfied': verified})
    unchanged = all(hashlib.sha256((repo / p).read_bytes()).hexdigest() == sha for p, sha in hashes.items())
    output = {'schema': 'synthetic-viewpoint-comparison-probe/v1',
        'scope': {'synthetic': True, 'formal_result': False, 'model_calls': False, 'simulator_calls': False,
                  'real_perception_world_model_runtime_actions': True, 'frozen_normalizeCommand': True},
        'repo_argument': str(repo), 'imported_module': str(Path(module.__file__).resolve()),
        'ast_sha256': hashlib.sha256(ast.dump(tree, include_attributes=False).encode()).hexdigest(),
        'source_sha256': hashes, 'sources_unchanged_during_export': unchanged,
        'cases': cases, 'checks_satisfied': unchanged and all(c['checks_satisfied'] for c in cases)}
    with args.output.open('x') as stream:
        json.dump(output, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')
    print(json.dumps({'output': str(args.output), 'cases': len(cases),
                      'checks_satisfied': output['checks_satisfied'], 'synthetic': True, 'formal_result': False}))
    return 0 if output['checks_satisfied'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
