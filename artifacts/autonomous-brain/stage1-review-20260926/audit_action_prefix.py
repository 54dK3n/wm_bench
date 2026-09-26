#!/usr/bin/env python3
"""Post-run supplementary audit; never changes the frozen evaluator or its result.

Bindings are recomputed from EVERY observation through the selected action's
before_observation (inclusive). Outcomes use the original full action window.
No truth identity, successful frame, or action is manually selected.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import sys


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def load(path, lines=False):
    if path.suffix == '.gz':
        with gzip.open(path, 'rt') as stream:
            return json.load(stream)
    with path.open() as stream:
        return [json.loads(line) for line in stream if line.strip()] if lines else json.load(stream)


def reference(row):
    return {key: row.get(key) for key in ('observation_index', 'round', 'frame_id', 'tick', 'simulation_seconds')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--evaluation', type=Path, required=True)
    parser.add_argument('--evaluator', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True, help='Detailed diagnostic JSON; keep under raw/')
    parser.add_argument('--summary-out', type=Path, help='Optional small shareable summary without per-frame boxes')
    args = parser.parse_args()
    run, evaluator = args.run_dir.resolve(), args.evaluator.resolve()
    report = load(args.evaluation)
    assert digest(evaluator) == report['evaluator_sha256'], 'Evaluator is not the frozen original used for the report'
    paths = {'record.json': run / 'record.json.gz', 'captures.json': run / 'captures.json.gz',
             'brain/summary.json': run / 'brain/summary.json',
             'brain/rounds.jsonl': run / 'brain/rounds.jsonl',
             'brain/observations.jsonl': run / 'brain/observations.jsonl',
             'brain/motions.jsonl': run / 'brain/motions.jsonl'}
    source_hashes = {}
    for name, path in paths.items():
        actual = digest(path)
        assert actual == report['inputs'][name]['sha256'], 'Raw input differs from formal evaluation: ' + name
        source_hashes[name] = {'file': str(path.relative_to(run)), 'sha256': actual, 'bytes': path.stat().st_size}
    sys.path.insert(0, str(evaluator.parents[1]))
    spec = importlib.util.spec_from_file_location('frozen_prefix_evaluator', evaluator)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    record, captures = load(paths['record.json']), load(paths['captures.json'])
    summary = load(paths['brain/summary.json'])
    rounds, observations, motions = (load(paths[name], lines=True) for name in (
        'brain/rounds.jsonl', 'brain/observations.jsonl', 'brain/motions.jsonl'))
    expected = sorted({identity for item in record['native']['taskDefinition']['deliveries']
        if item.get('objectRole') == 'target' and item.get('destinationRole') == 'storage'
        for identity in item['requiredPackageIds']})
    global_perception = module.evaluate_perception(observations, captures, record, summary, expected)
    global_judge = module.evaluate_judge(record, rounds, observations, motions,
                                         global_perception['track_truth_bindings'])
    assert global_judge == report['judge'], 'Unmodified global judge did not reproduce'
    assert global_perception['ambiguous_track_ids'] == report['perception']['ambiguous_track_ids']
    assert global_perception['binding_evidence'] == report['perception']['binding_evidence']
    indices = [row['observation_index'] for row in observations]
    assert indices == list(range(1, len(observations) + 1)), 'Observation prefix is incomplete or unordered'
    actions = []
    for row in rounds:
        action = row.get('action') or {}
        if action.get('action') not in {'pick', 'place'}:
            continue
        before = row['result']['evidence']['before_observation']
        assert type(before) is int and indices.count(before) == 1
        cutoff = indices.index(before)
        prefix = observations[:cutoff + 1]
        assert prefix[-1]['round'] == row['round']
        bound = module.evaluate_perception(prefix, captures, record, summary, expected)
        result = module.evaluate_judge(record, [row], observations, motions, bound['track_truth_bindings'])['rows'][0]
        selected = (action.get('params', {}).get('object_id') if action['action'] == 'pick'
                    else row.get('state', {}).get('robot', {}).get('held_object_id'))
        object_id = row['result']['evidence'].get('object_id', selected)
        evidence = [item for item in bound['binding_evidence'] if item['track_id'] == object_id]
        associated_events = []
        for i, event in enumerate(record['native']['events']):
            if (event.get('packageId') == result.get('truth_id') and result.get('before_tick', float('inf')) < event.get('tick', -1)
                    <= result.get('final_tick', -1)
                    and event.get('type') in {'package_grabbed', 'package_delivered', 'package_delivery_revoked'}):
                associated_events.append(module.event_reference(i, event, record['clock']['stepMs']))
        actions.append({'round': row['round'], 'action': action['action'], 'object_id': object_id,
            'prefix_rule': 'all observation rows through before_observation inclusive; no frame or outcome selection',
            'prefix_observation_count': len(prefix), 'prefix_final_observation': before,
            'prefix_final_frame': prefix[-1]['observation']['frameId'],
            'binding_status': 'unique' if object_id in bound['track_truth_bindings'] else 'ambiguous_or_absent',
            'binding_evidence_count': len(evidence),
            'binding_evidence_references': [{**reference(item), 'truth_id': item['truth_id']} for item in evidence],
            'original_global_judge': next(item for item in global_judge['rows'] if item['round'] == row['round']),
            'prefix_judge': result, 'corresponding_native_event_references': associated_events})
    ambiguity = []
    for track, identities in global_perception['ambiguous_track_ids'].items():
        evidence = [item for item in global_perception['binding_evidence'] if item['track_id'] == track]
        identities_by_frame = defaultdict(list)
        for item in evidence:
            identities_by_frame[item['truth_id']].append(item)
        first_identity = evidence[0]['truth_id']
        conflicts = [item for item in evidence if item['truth_id'] != first_identity]
        window_indices = {index for item in conflicts for index in range(max(1, item['observation_index'] - 2),
            min(len(observations), item['observation_index'] + 2) + 1)}
        windows = []
        for obs in observations:
            if obs['observation_index'] not in window_indices:
                continue
            sensor = obs['observation']
            # Only pixel boxes, source/lifecycle labels and raw log references;
            # never copy layout/truth coordinates into this compact artifact.
            windows.append({'observation_index': obs['observation_index'], 'round': obs['round'],
                'frame_id': sensor['frameId'], 'tick': sensor['tick'], 'holding': obs['holding']['holding'],
                'red_detections': [{key: det.get(key) for key in ('track_id', 'bbox', 'source',
                    'fed_to_world_model', 'reason', 'known_delivered_object_id')}
                    for det in obs.get('perception', {}).get('detections', []) if det.get('category') == 'red-ball'],
                'red_lifecycles': [{key: obj.get(key) for key in ('id', 'state', 'completion_classification')}
                    for obj in obs.get('objects', []) if obj.get('category') == 'red-ball'
                    and obj.get('state') in {'HELD', 'DELIVERED', 'RELEASED_UNVERIFIED'}]})
        ambiguity.append({'track_id': track, 'global_identities': identities,
            'identity_support': [{'truth_id': identity, 'count': len(rows),
                'first': reference(rows[0]), 'last': reference(rows[-1])} for identity, rows in sorted(identities_by_frame.items())],
            'first_observed_binding_conflicts': [{**reference(item), 'truth_id': item['truth_id']} for item in conflicts],
            'diagnostic_observation_windows': windows})
    manifest_path = run.parent / 'manifest.json'
    manifest = load(manifest_path)
    actions_source = evaluator.parents[1] / 'autonomous_brain/actions.py'
    assert digest(actions_source) == manifest['brain']['autonomous_brain/actions.py'], 'Action gate differs from frozen source'
    from autonomous_brain.actions import Actions, ball_inside_region
    place_witnesses = []
    capture_by_frame = defaultdict(list)
    observation_by_frame = defaultdict(list)
    for item in captures:
        capture_by_frame[str(item['frameId'])].append(item)
    for item in observations:
        observation_by_frame[str(item['observation']['frameId'])].append(item)
    for action_audit in actions:
        if action_audit['action'] != 'place':
            continue
        row = next(item for item in rounds if item['round'] == action_audit['round'])
        original_basis = row['result']['evidence']
        placement = original_basis.get('placement') or {}
        frame = str(placement.get('frame_id'))
        candidates = observation_by_frame[frame]
        frame_captures = capture_by_frame[frame]
        assert len(candidates) == len(frame_captures) == 1, 'Placement frame is absent or ambiguous'
        observation, capture = candidates[0], frame_captures[0]
        assert observation['observation']['tick'] == capture['tick']
        recomputed = Actions(SimpleNamespace(snapshot=observation)).placement_evidence(
            placement['ball_category'], original_basis['release_observation'])
        raw = observation['observation']['detections']
        matches = module.match_pixels(raw, capture)
        prefix = observations[:action_audit['prefix_observation_count']]
        bound = module.evaluate_perception(prefix, captures, record, summary, expected)['track_truth_bindings']
        red_rows = []
        for match in matches:
            if match.get('category') != 'red-ball':
                continue
            detection = raw[match['detection_index']]
            converted = [item for item in observation['perception']['detections']
                if module.box_key(item) == module.box_key(detection)]
            assert len(converted) == 1
            item = converted[0]
            known = item.get('known_delivered_object_id')
            is_witness = item.get('bbox') == placement['ball_bbox']
            zone = placement['storage_bbox']
            bx, by = item['bbox']['x'] + item['bbox']['w'] / 2, item['bbox']['y'] + item['bbox']['h']
            value = ((bx - zone['x'] - zone['w'] / 2) / (zone['w'] / 2)) ** 2 + ((by - zone['y'] - zone['h'] / 2) / (zone['h'] / 2)) ** 2
            red_rows.append({'raw_detection_index': match['detection_index'], 'pixel_match_status': match['status'],
                'truth_id': match.get('truth_id'), 'track_id': item.get('track_id'),
                'known_delivered_object_id': known, 'is_selected_delivery_witness': is_witness,
                'frozen_inner_ellipse_gate_pass': ball_inside_region(item['bbox'], zone),
                'inner_ellipse_value': value, 'unchanged_inner_ellipse_limit': 0.64,
                'known_identity_matches_pre_action_binding': (known is None or bound.get(known) == match.get('truth_id')),
                'bbox': item['bbox']})
        selected = [item for item in red_rows if item['is_selected_delivery_witness']]
        selected_identity_matches = (len(selected) == 1 and selected[0]['pixel_match_status'] == 'unique'
            and selected[0]['truth_id'] == action_audit['prefix_judge'].get('truth_id'))
        unique_inside = [item['truth_id'] for item in red_rows
            if item['pixel_match_status'] == 'unique' and item['frozen_inner_ellipse_gate_pass']]
        same_frame_check = {'round': row['round'], 'object_id': action_audit['object_id'],
            'observation_index': observation['observation_index'], 'frame_id': frame,
            'tick': observation['observation']['tick'], 'holding': observation['holding']['holding'],
            'release_frame_id': str(original_basis['release_observation']['frame_id']),
            'original_candidate_count': original_basis.get('candidate_witnesses'),
            'recomputed_candidate_count': recomputed['candidate_witnesses'],
            'recomputed_placement_exactly_matches_original': recomputed['placement'] == placement,
            'selected_witness_truth_matches_pre_action_identity': selected_identity_matches,
            'known_delivered_labels_match_pre_action_bindings': all(item['known_identity_matches_pre_action_binding'] for item in red_rows),
            'distinct_same_frame_red_truth_ids_inside_frozen_gate': sorted(set(unique_inside)),
            'same_frame_red_detections': red_rows}
        same_frame_check['verified'] = (same_frame_check['holding'] is False
            and recomputed['candidate_witnesses'] == original_basis.get('candidate_witnesses') == 1
            and same_frame_check['recomputed_placement_exactly_matches_original']
            and selected_identity_matches and selected[0]['frozen_inner_ellipse_gate_pass']
            and same_frame_check['known_delivered_labels_match_pre_action_bindings'])
        place_witnesses.append(same_frame_check)
    selected_identities = [item['truth_id'] for placement in place_witnesses
        for item in placement['same_frame_red_detections'] if item['is_selected_delivery_witness']]
    prefix_counts = dict(Counter(row['prefix_judge']['status'] for row in actions))
    result = {'schema': 'post-run-action-prefix-audit/v1', 'evaluation_only': True,
        'supplementary_diagnostic_not_replacement_of_formal_evaluation': True,
        'script_sha256': digest(Path(__file__).resolve()), 'evaluator_sha256': digest(evaluator),
        'formal_evaluation_sha256': digest(args.evaluation), 'source_files': source_hashes,
        'formal_success_unchanged': report['success'], 'global_judge_reproduced_exactly': True,
        'original_global_judge_counts': global_judge['counts'], 'prefix_binding_judge_counts': prefix_counts,
        'every_pick_place_action_included': len(actions) == global_judge['counts']['eligible_actions'],
        'all_action_prefix_judgments_match': bool(actions) and all(row['prefix_judge']['status'] == 'match' for row in actions),
        'actions': actions, 'global_binding_ambiguities': ambiguity,
        'same_frame_place_witness_audit': place_witnesses,
        'all_same_frame_place_witnesses_verified': bool(place_witnesses) and all(item['verified'] for item in place_witnesses),
        'selected_delivery_witnesses_are_distinct_truth_objects': len(selected_identities) == len(set(selected_identities)),
        'frozen_action_source_sha256': digest(actions_source), 'frozen_manifest_sha256': digest(manifest_path),
        'limitations': ['The original global binding remains ambiguous; its counts are not overwritten.',
            'Temporal binding tests historical action identity using all evidence available before that action.',
            'Geometric pixel matching retains the original evaluator occlusion limitation.',
            'Later transient delivered-object labeling errors are diagnosed, not repaired or omitted from raw evidence.']}
    with args.out.open('x') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')
    if args.summary_out is not None:
        compact = {key: result[key] for key in ('schema', 'evaluation_only',
            'supplementary_diagnostic_not_replacement_of_formal_evaluation', 'script_sha256',
            'evaluator_sha256', 'formal_evaluation_sha256', 'source_files',
            'formal_success_unchanged', 'global_judge_reproduced_exactly', 'original_global_judge_counts',
            'prefix_binding_judge_counts', 'every_pick_place_action_included',
            'all_action_prefix_judgments_match', 'all_same_frame_place_witnesses_verified',
            'selected_delivery_witnesses_are_distinct_truth_objects', 'frozen_action_source_sha256',
            'frozen_manifest_sha256', 'limitations')}
        compact['schema'] = 'post-run-action-prefix-audit-summary/v1'
        compact['detailed_audit'] = {'path': str(args.out), 'sha256': digest(args.out), 'bytes': args.out.stat().st_size}
        compact['actions'] = [{key: item[key] for key in ('round', 'action', 'object_id',
            'prefix_observation_count', 'binding_status', 'binding_evidence_count', 'prefix_judge')}
            for item in actions]
        compact['place_witness_checks'] = [{key: item[key] for key in ('round', 'frame_id',
            'holding', 'release_frame_id', 'original_candidate_count', 'recomputed_candidate_count',
            'recomputed_placement_exactly_matches_original', 'selected_witness_truth_matches_pre_action_identity',
            'known_delivered_labels_match_pre_action_bindings', 'distinct_same_frame_red_truth_ids_inside_frozen_gate',
            'verified')} for item in place_witnesses]
        compact['ambiguity_summary'] = [{key: item[key] for key in ('track_id', 'global_identities',
            'identity_support', 'first_observed_binding_conflicts')} for item in ambiguity]
        with args.summary_out.open('x') as stream:
            json.dump(compact, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write('\n')
    print(json.dumps({key: result[key] for key in ('original_global_judge_counts',
        'prefix_binding_judge_counts', 'all_action_prefix_judgments_match', 'global_judge_reproduced_exactly',
        'all_same_frame_place_witnesses_verified', 'selected_delivery_witnesses_are_distinct_truth_objects')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
