#!/usr/bin/env python3
"""Recompute this stopped round's metrics from preserved local gate/preflight logs."""
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo', required=True, type=Path)
parser.add_argument('--evidence', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
r = args.evidence.resolve()
read = lambda name: json.loads((r/name).read_text())
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
gate, frozen, preflight = read('GATE.json'), read('FROZEN_INPUTS.json'), read('raw/preflight/live-once/RESULT.json')
assert preflight['request_count'] == 1 and preflight['transport_error'] == {'type': 'HTTPError', 'status': 402}
assert not preflight['robot_started'] and not preflight['formal_task']
assert not (r/'raw/formal-stage1').exists()
prior_path = args.repo/'artifacts/autonomous-brain/executable-recovery-20260927/METRICS.json'
prior = json.loads(prior_path.read_text())
old = prior['verification_layers']['formal_stage1']
history = dict(prior['historical_results_preserved'])
history[prior['source_commit']] = 'stage1_FAIL'
result = {'schema': 'grab-sampling-round-metrics/v1', 'source_commit': frozen['source_commit'],
    'reviewed_baseline': gate['reviewed_baseline'], 'historical_results_preserved': history,
    'verification_layers': {'function_regressions': {'python': gate['python'], 'node': gate['node']},
        'synthetic_components': gate['synthetic_components'], 'historical_v19_replay': gate['historical_replay'],
        'separate_live_service_preflight': preflight,
        'formal_stage1': {'status': 'NOT_RUN', 'runs': 0, 'reason': 'separate_preflight_HTTP402',
            'task': '把两个红球送到绿色存放区', 'map': 'map-05', 'rounds': 0, 'model_calls': 0,
            'physical_delivery': None, 'brain_DELIVERED': None, 'independent_verified_delivery_chains': None,
            'global_judge': None, 'prefix_judge': None, 'active_done': None,
            'limits': {'rounds': 200, 'simulation_seconds': 1200}},
        'stage2': {'status': 'NOT_RUN', 'runs': 0}, 'ten_layouts_and_hardware_started': False},
    'previous_a847a3c_unchanged': {'source_commit': prior['source_commit'], 'status': 'FAIL',
        'metrics': old['metrics'], 'deliveries': old['deliveries'], 'judge': old['judge'],
        'prefix_judge': old['prefix_judge'], 'done_actions': old['done_actions'],
        'repositioning': prior['repositioning'], 'metrics_file_sha256': sha(prior_path),
        'release': 'https://github.com/54dK3n/wm_bench/releases/tag/executable-recovery-20260927-a847a3c'},
    'stopped_after_preflight_failure': True, 'resumed_previous_run': False,
    'new_formal_run_after_failure': False, 'service_configuration_changed': False,
    'evidence_sha256': {name: sha(r/name) for name in ('GATE.json', 'FROZEN_INPUTS.json',
        'raw/preflight/live-once/RESULT.json', 'raw/preflight/live-once/llm.jsonl',
        'raw/gate/grab-frozen-candidate.json', 'raw/gate/sampling-frozen-candidate.json')}}
with args.output.open('x') as stream:
    json.dump(result, stream, ensure_ascii=False, indent=2); stream.write('\n')
print(json.dumps({'source_commit': frozen['source_commit'], 'preflight_HTTP_status': 402,
                  'formal_runs': 0, 'stage2_runs': 0, 'output': str(args.output)}))
