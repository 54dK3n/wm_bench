"""Read frozen round-2 JSON only; regenerate numbers_audit.json, never run a simulator.

Run from any directory: python3 /absolute/path/to/round-2/audit_numbers.py
L indices refer to raw.lines; E indices refer to raw.record.events (both zero based).
Metric truth/PNG attribution remains the sealed opt_report's audit, not a new label rule.
"""
import hashlib
import json
import math
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent


def read(path):
    return json.loads(Path(path).read_text())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def selected(rows, name, key='event'):
    return [{'index': i, 'record': row} for i, row in enumerate(rows)
            if isinstance(row, dict) and row.get(key) == name]


def main():
    report = read(HERE / 'opt_report.json')
    progress = read(HERE / 'progress.json')
    index = read(HERE / 'frozen_sources/INDEX.json')
    manifest = read(HERE / 'code_manifest.json')
    identity = read(HERE / 'preflight.json')['identity']
    checks = {}
    output = {
        'schema': 'opt1-round1-offline-number-audit/v1',
        'scope': 'Only completed round-2 and frozen R3 map-04 delivery comparison; no simulation, tests, labels or source edits.',
        'indices': 'L = zero-based raw.lines; E = zero-based raw.record.events; never physical text line numbers.',
        'inputs_sha256': {str(HERE / name): sha(HERE / name) for name in
                          ['opt_report.json', 'progress.json', 'code_manifest.json',
                           'preflight.json', 'freeze_verification.json', 'pre_run_review.json']},
        'checks': checks, 'runs': [], 'fixed_rule_extrema': {},
        'per_ball_missing_critical_numeric_fields': [],
    }
    archives = {source: sha(HERE / item['archive']) == item['sha256'] == manifest[source]
                for source, item in index['files'].items()}
    output['archive_sha256_matches_manifest'] = archives
    checks['all_22_frozen_sources_archived_exactly'] = len(archives) == 22 and all(archives.values())
    checks['completed_ten_maps_once'] = set(progress['completed']) == {
        f'map-{i:02}' for i in range(1, 11)} and Counter(
            x['map'] for x in progress['attempts'] if x.get('classification') == 'executed'
        ) == Counter({f'map-{i:02}': 1 for i in range(1, 11)})
    output['attempt_classification_counts'] = dict(Counter(x.get('classification') for x in progress['attempts']))
    essential = ['first_seen_seconds', 'confirmed_seconds', 'grabbed_seconds',
                 'confirm_to_grab_road_cm', 'confirm_to_grab_straight_cm',
                 'road_straight_ratio', 'grab_truth_forward_cm',
                 'grab_truth_right_cm', 'sight_vs_approach_deg']
    for run in report['runs']:
        name = run['map']
        raw_path = HERE / run['file']
        raw = read(raw_path)
        lines = raw['lines']
        events = raw['record']['events']
        output['inputs_sha256'][str(raw_path)] = sha(raw_path)
        obs = selected(lines, 'observe')
        versions = selected(lines, 'program_version')
        first_confirmed = {}
        for line_index, row in enumerate(lines):
            if row.get('event') == 'wm_targets':
                for track in row.get('tracks', []):
                    if track.get('state', '').lower() == 'confirmed':
                        first_confirmed.setdefault(track['id'], {'line_index': line_index, 'track': track})
        phantom = report['per_ball_diagnostics'][name]
        detail = {
            'map': name, 'raw_file': str(raw_path), 'raw_sha256': sha(raw_path),
            'observe_line_indices': [x['index'] for x in obs],
            'observe_count': len(obs), 'first_WM_confirmed_tracks': first_confirmed,
            'phantom_confirmations': phantom['phantom_confirmations'],
            'phantom_unknown': phantom['phantom_unknown'],
            'raw_events': {event: selected(lines, event) for event in [
                'program_version', 'memory_confirmed', 'approach_call', 'grab_geometry',
                'grab_step', 'delivery_phase_start', 'flow_end']},
            'platform_events': {event: selected(events, event, 'type') for event in [
                'run_started', 'program_error', 'package_grabbed', 'package_delivered', 'run_finished']},
            'fixed_rule_audit': run['fixed_rule_audit'],
            'ball': run['ball'], 'wm_final_err_cm': run['wm_final_err_cm'],
            'grabs': run['grabs'], 'mission': run['mission'],
            'native_vision_bytes': run['vision_bytes'],
            'combined_visual_bytes': report['combined_visual_bytes'][name],
            'per_ball_metrics': phantom['balls'],
        }
        output['runs'].append(detail)
        checks[name + '_identity_matches'] = len(versions) == 1 and all(
            versions[0]['record'].get(k) == v for k, v in identity.items())
        checks[name + '_raw_hash_matches_executed_attempt'] = sha(raw_path) == progress['completed'][name]['raw_sha256']
        checks[name + '_observe_count_matches_report'] = len(obs) == run['observes']
        checks[name + '_raw_observe_unfiltered_and_complete'] = all(
            x['record'].get('query') is None and x['record'].get('confidence') == 0
            and x['record'].get('tick') is not None and all(
                {'distanceCm', 'bearingDeg', 'confidence', 'category'} <= set(d)
                for d in x['record'].get('raw', [])) for x in obs)
        checks[name + '_platform_error_count_matches_report'] = len(
            detail['platform_events']['program_error']) == run['platform_program_error_count']
        for ball in phantom['balls']:
            missing = [key for key in essential if not isinstance(ball.get(key), (float, int))
                       or not math.isfinite(ball[key])]
            if missing:
                output['per_ball_missing_critical_numeric_fields'].append({'map': name, 'fields': missing})
            grab = events[ball['grab_event_index']]
            checks[name + '_grab_seconds_exact_event'] = grab['type'] == 'package_grabbed' and grab['t'] / 1000 == ball['grabbed_seconds']
            if ball['delivery_event_index'] is not None:
                delivery = events[ball['delivery_event_index']]
                checks[name + '_delivery_seconds_exact_event'] = delivery['type'] == 'package_delivered' and delivery['t'] / 1000 == ball['delivered_seconds']
            else:
                checks[name + '_no_delivery_is_not_zero_time'] = ball['delivered_seconds'] is None and not detail['platform_events']['package_delivered']
            observe = lines[phantom['last_confirmation_observe_line']]
            checks[name + '_confirmation_seconds_exact_tick'] = observe['tick'] * .02 == ball['confirmed_seconds']
            a, b = ball['odometer_boundaries']
            checks[name + '_road_distance_is_odometer_delta'] = math.isclose(b['value_cm'] - a['value_cm'], ball['confirm_to_grab_road_cm'], abs_tol=1e-9)
            checks[name + '_no_moving_time_interpolation'] = all(x['basis'] in {
                'exact_tick', 'identical_cumulative_distance_brackets'} for x in [a, b]) and ball['grab_truth_exact_tick']
        for rule, rule_audit in run['fixed_rule_audit'].items():
            if isinstance(rule_audit.get('evidence'), list):
                for evidence in rule_audit['evidence']:
                    if isinstance(evidence.get('value'), (int, float)):
                        output['fixed_rule_extrema'].setdefault(rule, []).append({'map': name, **evidence})
    for rule, values in output['fixed_rule_extrema'].items():
        output['fixed_rule_extrema'][rule] = {'min': min(values, key=lambda x: x['value']),
                                            'max': max(values, key=lambda x: x['value'])}
    old_path = HERE.parents[1] / 'stage-1/round-3/map-04.json'
    old = read(old_path)
    output['inputs_sha256'][str(old_path)] = sha(old_path)
    current = next(x for x in output['runs'] if x['map'] == 'map-04')
    new = read(HERE / 'map-04.json')
    output['map04_delivery_regression'] = {
        'scope': 'Delivery only, not an opt1 capture-gate regression.',
        'old_raw': str(old_path), 'old_events': {event: selected(old['record']['events'], event, 'type') for event in ['package_grabbed', 'package_delivered', 'run_finished']},
        'old_flow_end': selected(old['lines'], 'flow_end'),
        'new_events': current['platform_events'], 'new_flow_end': current['raw_events']['flow_end'],
        'new_repeating_delivery_end_segment': [{'index': i, 'record': new['lines'][i]} for i in range(600, 624)],
    }
    output['summary_counts'] = {
        'runs': len(output['runs']), 'observes': sum(x['observe_count'] for x in output['runs']),
        'first_confirmed_target_tracks': sum(len(x['first_WM_confirmed_tracks']) for x in output['runs']),
        'platform_target_grab_events': sum(len(x['platform_events']['package_grabbed']) for x in output['runs']),
        'platform_target_delivered_events': sum(len(x['platform_events']['package_delivered']) for x in output['runs']),
        'platform_program_errors': sum(len(x['platform_events']['program_error']) for x in output['runs']),
        'stationary_repeats': sum(x['stationary_repeat_count'] for x in report['runs']),
        'observe_motion_violations': sum(x['observe_motion_violation_count'] for x in report['runs']),
        'phantom_confirmations': sum(len(x['phantom_confirmations']) for x in output['runs']),
        'phantom_unknown': sum(len(x['phantom_unknown']) for x in output['runs']),
        'per_ball_metrics_rows': sum(len(x['per_ball_metrics']) for x in output['runs']),
    }
    checks['no_missing_captured_ball_numeric_fields'] = not output['per_ball_missing_critical_numeric_fields']
    output['all_arithmetic_and_consistency_checks_pass'] = all(checks.values())
    (HERE / 'numbers_audit.json').write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'all_pass': output['all_arithmetic_and_consistency_checks_pass'],
                      'false_checks': [k for k, v in checks.items() if not v],
                      'counts': output['summary_counts']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
