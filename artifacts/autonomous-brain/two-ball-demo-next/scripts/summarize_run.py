#!/usr/bin/env python3
"""Count completed public brain logs; never run a model, platform or evaluator.

The create-only output retains input SHA256 and command/observation references.
Public holding/WM evidence does not replace independent physical evaluation.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', required=True, type=Path,
                        help='Completed map-05-run-1 directory containing brain/')
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    if args.out.exists():
        raise SystemExit('Refusing to overwrite output')
    brain = args.run_dir.resolve() / 'brain'
    inputs, original_bytes = {}, {}

    def read(name, lines=False):
        data = (brain / name).read_bytes()
        original_bytes[name] = data
        metadata = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        if lines:
            chunks = data.splitlines(keepends=True)
            complete = [line for line in chunks if line.endswith(b'\n') and line.strip()]
            metadata.update(complete_jsonl_lines=len(complete), incomplete_tail_bytes=(
                len(chunks[-1]) if chunks and not chunks[-1].endswith(b'\n') else 0))
            value = [json.loads(line) for line in complete]
        else:
            value = json.loads(data)
        inputs['brain/' + name] = metadata
        return value

    rows = {name: read(name + '.jsonl', True) for name in
            ('rounds', 'llm', 'llm.lifecycle', 'bridge-calls', 'motions', 'observations')}
    summary = read('summary.json')
    if summary.get('status') not in {'failed', 'done', 'interrupted', 'aborted'}:
        raise SystemExit('Refusing a run without a terminal brain summary')
    rounds, observations = rows['rounds'], rows['observations']
    if not rounds or not observations:
        raise SystemExit('No complete round/observation evidence')
    indexed = {row['observation_index']: row for row in observations}
    bridge = rows['bridge-calls']
    by_request = {row['request']['requestId']: row for row in bridge}
    counts = Counter(row['request']['method'] for row in bridge)
    started = [r for r in rows['llm.lifecycle'] if r['event'] == 'started']
    finished = [r for r in rows['llm.lifecycle'] if r['event'] == 'finished']
    traces = [row['orchestration'] for row in rounds if row.get('orchestration')]
    picks = [row for row in rounds if row['action']['action'] == 'pick']
    grabs, chains = [], []
    for motion in rows['motions']:
        if motion['method'] != 'grab':
            continue
        before, after = (indexed.get(motion[key]) for key in
                         ('before_observation', 'after_observation'))
        request_id = motion.get('bridge_request_id')
        wire = by_request.get(request_id) or {}
        grabs.append({'round': motion['round'], 'bridge_request_id': request_id,
            'before_observation': motion['before_observation'],
            'after_observation': motion['after_observation'],
            'before_holding': before['holding']['holding'] if before else None,
            'after_holding': after['holding']['holding'] if after else None,
            'bridge_submission_status': wire.get('submission', {}).get('status'),
            'bridge_terminal_status': (wire.get('terminal') or {}).get('status'),
            'outcome_unknown': motion.get('outcome_unknown', False)})
    for row in picks:
        evidence = row['result'].get('evidence', {})
        chain = evidence.get('grasp_confirmation')
        if not chain:
            continue
        grab, held = chain['grab'], chain['holding_observations']
        tail = [o for o in observations if o['observation_index'] >= grab['after_observation']]
        post = indexed[evidence['final_observation']]
        chains.append({'round': row['round'], 'object_id': chain['object_id'],
            'schema': chain['schema'], 'grab_request_id': grab['bridge_request_id'],
            'authorized_before_observation': grab['before_observation'],
            'authorization_observation_index': grab['authorization']['observation_index'],
            'authorization_object_state': grab['authorization']['object']['state'],
            'first_held_observation': grab['after_observation'],
            'confirmation_observation': chain['confirmation']['observation_index'],
            'recorded_holding_chain_refs': [o['observation_index'] for o in held],
            'raw_chain_sensor_true_all': all(indexed[o['observation_index']]['holding']['holding'] is True for o in held),
            'post_pick_observation': evidence['final_observation'],
            'post_pick_object_state': next(o['state'] for o in post['objects'] if o['id'] == chain['object_id']),
            'remaining_observations_all_holding_true': all(o['holding']['holding'] is True for o in tail),
            'remaining_observation_range': [tail[0]['observation_index'], tail[-1]['observation_index']],
            'remaining_observation_count': len(tail),
            'note': 'Public observation/command chain only; not independent truth-based physical validation.'})
    last, terminal = observations[-1], rounds[-1]
    trace = terminal.get('orchestration', {})
    first_sequence = trace.get('bridge_commands', {}).get('first_sequence', len(bridge) + 1)
    unknown = [m for m in rows['motions'] if m.get('outcome_unknown')]
    result = {
        'scope': 'Read-only public brain counts; no truth/record read, API, simulator or evaluator.',
        'reference_paths_relative_to': 'run-dir',
        'brain_status': summary['status'], 'brain_reason': summary['reason'], 'task': summary['task'],
        'model': {
            'names': dict(Counter(r.get('response_model') for r in rows['llm'])),
            'live_started_requests': sum(r.get('mode') == 'live' for r in started),
            'live_finished_events': sum(r.get('mode') == 'live' for r in finished),
            'started_events': len(started), 'finished_events': len(finished),
            'complete_llm_records': len(rows['llm']),
            'unique_call_indices': len({r['call_index'] for r in rows['llm']}),
            'unmatched_started_call_indices': sorted({r['call_index'] for r in started} - {r['call_index'] for r in finished}),
            'transport_error_records': sum(bool(r.get('transport_error')) for r in rows['llm']),
            'validation_error_records': sum(bool(r.get('validation_error')) for r in rows['llm']),
            'mode_counts': dict(Counter(r.get('mode') for r in rows['llm']))},
        'rounds': {
            'recorded': len(rounds),
            'returned_without_exception': sum(not r['result'].get('error_type') for r in rounds),
            'exception_rounds': [r['round'] for r in rounds if r['result'].get('error_type')],
            'actions_by_name': dict(Counter(r['action']['action'] for r in rounds)),
            'pick_count': len(picks), 'pick_result_success_count': sum(r['result']['success'] is True for r in picks),
            'model_done_count': sum(r['action']['action'] == 'done' for r in rounds)},
        'orchestration': {
            'run_ids': sorted({t['run_id'] for t in traces}),
            'dispatch_records': sum('dispatch' in t for t in traces),
            'judge_records': sum('judge' in t for t in traces),
            'unique_step_ids': len({t['step_id'] for t in traces}),
            'step_ids_match_round': all(t['step_id'] == t['run_id'] + ':' + str(t['round']) for t in traces),
            'first_step_id': traces[0]['step_id'], 'last_step_id': traces[-1]['step_id'],
            'last_round_has_judge': 'judge' in trace,
            'dispatch_classes': sorted({t['dispatch']['class'] for t in traces if 'dispatch' in t}),
            'model_sources': dict(Counter(t.get('model', {}).get('source') for t in traces))},
        'bridge': {
            'requests': len(bridge), 'requests_by_method': dict(sorted(counts.items())),
            'grab_requests': counts['grab'], 'release_requests': counts['release'],
            'submission_error_count': sum(r.get('submission', {}).get('status', 0) >= 400 for r in bridge),
            'grab_observed_false_to_true_count': sum(g['before_holding'] is False and g['after_holding'] is True for g in grabs),
            'grabs': grabs},
        'holding_chains': chains,
        'public_completion': {
            'wm_delivered_objects': sum(o.get('state') == 'DELIVERED' for o in summary['final_objects']),
            'wm_held_objects': sum(o.get('state') == 'HELD' for o in summary['final_objects']),
            'held_object_id': summary['held_object_id'], 'pending_grasp': summary['pending_grasp'],
            'final_observed_holding': last['holding']['holding'],
            'independent_physical_delivery_count': None,
            'independent_physical_evaluation_status': 'NOT_COMPUTED_BY_THIS_REVIEW'},
        'last_observation': {
            'observation_index': last['observation_index'], 'frame_id': last['observation']['frameId'],
            'tick': last['observation']['tick'], 'round': last['round'],
            'simulation_seconds': last['simulation_seconds'], 'holding': last['holding']['holding'],
            'on_road': last['road']['onRoad']},
        'terminal_failure': {
            'round': terminal['round'], 'action': terminal['action'], 'step_id': trace.get('step_id'),
            'result': terminal['result'], 'unknown_motion_records': unknown,
            'last_bridge_commands': [{'sequence': i, 'request': r['request'],
                'submission_status': r['submission']['status'],
                'submission_error': r['submission'].get('body', {}).get('error'),
                'terminal_status': (r.get('terminal') or {}).get('status'), 'error': r.get('error')}
                for i, r in enumerate(bridge, 1) if i >= first_sequence],
            'post_error_new_observation': (last['observation_index'] > unknown[-1]['before_observation'] if unknown else None)},
        'inputs': inputs,
        'definitions': {
            'pick_result_success_count': 'High-level result success; not physical delivery count.',
            'grab_observed_false_to_true_count': 'Grab followed by fresh public holding false-to-true observations.',
            'unknown_motion_records': 'Preserved execution uncertainty; do not assume the motion physically executed.',
            'input_scope': 'Only seven public brain files; no envelope, platform record or evaluator output.'}}
    for name, data in original_bytes.items():
        if (brain / name).read_bytes() != data:
            raise SystemExit('Input changed during count: ' + name)
    result['input_bytes_unchanged_during_count'] = True
    with args.out.open('x') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')
    print(json.dumps({'output': str(args.out), 'model_requests': len(started),
        'dispatch': result['orchestration']['dispatch_records'],
        'judge': result['orchestration']['judge_records'],
        'pick': len(picks), 'grab': counts['grab'], 'release': counts['release']}))


if __name__ == '__main__':
    main()
