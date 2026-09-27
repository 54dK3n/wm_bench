#!/usr/bin/env python3
"""Count completed demo logs and cite existing verdicts; no model, robot or rescoring.

Run after every selected driver has exited and its independent evaluation exists.
The output is create-only. Account data and credential configuration are not read.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--round-dir', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    root = args.round_dir.resolve()
    output = args.out or root / 'METRICS.json'
    if output.exists():
        raise SystemExit('Refusing to overwrite metrics')
    inputs = {}

    def read(path, lines=False):
        data = path.read_bytes()
        inputs[path.relative_to(root).as_posix()] = {
            'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        return ([json.loads(line) for line in data.splitlines() if line.strip()]
                if lines else json.loads(data))

    runs = []
    folders = sorted(p for pattern in ('smoke-*', 'stage1-*')
                     for p in (root / 'raw').glob(pattern)
                     if p.is_dir() and (p / 'manifest.json').is_file())
    for folder in folders:
        manifest = read(folder / 'manifest.json')
        driver = read(folder / 'summary.json')
        if driver.get('status') == 'running':
            raise SystemExit('Refusing an active run: ' + folder.name)
        run = folder / 'map-05-run-1'
        summary = read(run / 'brain/summary.json')
        rows = {name: read(run / 'brain' / (name + '.jsonl'), lines=True)
                for name in ('rounds', 'llm', 'llm.lifecycle', 'bridge-calls', 'observations', 'motions')}
        lifecycle = rows['llm.lifecycle']
        started = [row for row in lifecycle if row['event'] == 'started']
        finished = [row for row in lifecycle if row['event'] == 'finished']
        verdict = read(root / 'raw' / (folder.name + '-evaluation') / 'evaluation.json')
        platform = read(run / 'evaluation.json')
        envelope = read(run / 'envelope.json')
        stop_path = run / 'development-stop-request.json'
        stop = read(stop_path) if stop_path.exists() else None
        requests = Counter(row['request']['method'] for row in rows['bridge-calls'])
        public = set(manifest['publicMethods'])
        motion_methods = {'forward', 'backward', 'turn', 'follow_road', 'take_exit'}
        issued = [row for row in rows['llm'] if isinstance(row.get('action'), dict)]
        completed = [row for row in rows['rounds'] if isinstance(row.get('action'), dict)
                     and isinstance(row.get('result'), dict) and not row['result'].get('error_type')]
        actions = Counter(row['action']['action'] for row in completed)
        traces = [row['orchestration'] for row in rows['rounds'] if row.get('orchestration')]
        observed = verdict.get('task_scope', {}).get('observed_evidence', {})
        delivery = verdict['delivery']
        replay = verdict.get('strict_transcript_replay', {})
        scopes = verdict.get('task_scope', {}).get('done_evidence', {})
        runs.append({
            'name': folder.name, 'task': summary['task'], 'stage': verdict['stage'],
            'result': 'PASS' if verdict['success'] else 'FAIL',
            'source_commit': manifest['brainRevision'],
            'octos_robots_commit': manifest['orchestrator']['revision'],
            'executor_max_retries': manifest['orchestrator']['maxRetries'],
            'external_octos_runtime': manifest['orchestrator']['externalOctosRuntime'],
            'sources_unchanged': driver['sourcesUnchanged'],
            'platform_run_id': envelope['management']['runId'],
            'orchestration_run_ids': sorted({row['run_id'] for row in traces}),
            'model': manifest['modelConfiguration']['model'],
            'temperature': manifest['modelConfiguration']['temperature'],
            'thinking': manifest['modelConfiguration']['thinking'],
            'round_records': len(rows['rounds']), 'completed_rounds': len(completed),
            'llm_calls': len(rows['llm']), 'llm_records_complete': len(rows['llm']),
            'llm_started': len(started), 'llm_finished': len(finished),
            'real_api_calls': sum(row.get('mode') == 'live' for row in started),
            'real_api_finished': sum(row.get('mode') == 'live' for row in finished),
            'unfinished_call_indices': sorted({row['call_index'] for row in started}
                                               - {row['call_index'] for row in finished}),
            'issued_llm_actions': len(issued),
            'completed_actions_by_name': dict(sorted(actions.items())),
            'last_issued_decision_index': max((r['decision_index'] for r in issued), default=None),
            'last_completed_round': max((r['round'] for r in completed), default=None),
            'executor_dispatch_records': sum('dispatch' in row for row in traces),
            'executor_judge_records': sum('judge' in row for row in traces),
            'world_model_observations': len(rows['observations']),
            'bridge_observe_requests': requests['observe'],
            'bridge_calls': len(rows['bridge-calls']),
            'bridge_calls_by_method': dict(sorted(requests.items())),
            'bridge_motion_requests': sum(requests[name] for name in motion_methods),
            'motion_records': len(rows['motions']),
            'motions_after_last_completed_round': sum(row['round'] > max(
                (r['round'] for r in completed), default=0) for row in rows['motions']),
            'grab_requests': requests['grab'], 'release_requests': requests['release'],
            'foreign_requests': sum(count for name, count in requests.items() if name not in public),
            'brain_delivered_objects': sum(row.get('state') == 'DELIVERED'
                                           for row in summary['final_objects']),
            'independent_observation_delivery_chains': len(observed.get('deliveries', [])),
            'platform_deliveries': len(delivery['delivered_target_ids']),
            'qualified_physical_deliveries': len(delivery['qualifying_delivered_target_ids']),
            'model_done_actions': sum(row['action']['action'] == 'done' for row in issued),
            'model_done_verified': scopes.get('raw_model_output_verified'),
            'post_action_completion_verified': scopes.get('post_action_completion_verified'),
            'terminal_done_verified': delivery['terminal_done']['verified'],
            'simulation_seconds': summary['simulation_seconds'],
            'last_observed_holding': rows['observations'][-1]['holding']['holding'] if rows['observations'] else None,
            'original_brain_status': summary['status'], 'original_brain_reason': summary['reason'],
            'development_stop': ({key: stop.get(key) for key in
                ('scope', 'reason', 'signal', 'completed_rounds_at_request')} if stop else None),
            'platform_export_complete': platform['evidenceExport']['complete'],
            'driver_fixed_two_ball_success': platform['success'],
            'independent_verdict_failures': verdict['failures'],
            'global_judge_counts': verdict['judge'].get('counts', {}),
            'prefix_judge_counts': verdict['action_identity_audit']['prefix_judge']['counts'],
            'strict_replay': {key: replay.get(key) for key in ('allPass', 'recorded_calls',
                'replayed_calls', 'recorded_rounds', 'replayed_rounds', 'failures', 'replay_error')},
            'verdict_source': (root / 'raw' / (folder.name + '-evaluation') / 'evaluation.json').relative_to(root).as_posix(),
        })
    def outcome(stage):
        selected = [row for row in runs if row['stage'] == stage]
        return ('PASS' if any(row['result'] == 'PASS' for row in selected)
                else 'FAIL' if selected else 'NOT_RUN')
    if not runs:
        raise SystemExit('No completed driver and independent evaluation found')
    script = Path(__file__).resolve()
    result = {'scope': 'Counts from immutable logs; existing independent verdicts cited without rescoring.',
        'one_ball_demo': outcome('one-ball-smoke'), 'two_ball_stage1': outcome('stage-1'),
        'runs': runs,
        'definitions': {
            'completed_rounds': 'Recorded action/result rows without exception error_type; interrupted tail is not completed.',
            'real_api_calls': 'Live lifecycle started events, including unfinished attempts; start does not assert a completed response.',
            'llm_calls': 'Complete rows in llm.jsonl; llm_started/finished separately retain interrupted request attempts.',
            'issued_llm_actions': 'Valid action dictionaries in the original LLM transcript, including an interrupted last round.',
            'bridge_calls': 'Original bridge request log rows, including sensors; method counts do not assert physical success.',
            'motion_records': 'Original motions.jsonl rows; may include a round without a completed round record.',
            'qualified_physical_deliveries': 'Existing independent evaluation qualifying_delivered_target_ids count.',
            'independent_observation_delivery_chains': 'Existing independent task_scope.observed_evidence.deliveries count.',
            'driver_fixed_two_ball_success': 'Unchanged two-ball driver verdict; not the one-ball smoke acceptance result.',
            'original_brain_reason': 'Copied unchanged from the original brain summary.'},
        'script_sha256': hashlib.sha256(script.read_bytes()).hexdigest(), 'inputs': inputs}
    # Refuse to mix snapshots if any input changed while it was being read.
    for name, metadata in inputs.items():
        current = (root / name).read_bytes()
        if len(current) != metadata['bytes'] or hashlib.sha256(current).hexdigest() != metadata['sha256']:
            raise SystemExit('Input changed during count: ' + name)
    with output.open('x') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')
    print(json.dumps({'output': str(output), 'runs_counted': len(runs),
        'one_ball_demo': result['one_ball_demo'], 'two_ball_stage1': result['two_ball_stage1']}))


if __name__ == '__main__':
    main()
