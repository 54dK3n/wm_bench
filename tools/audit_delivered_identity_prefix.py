#!/usr/bin/env python3
"""Replay a fixed public sensor prefix and legitimate historical action boundaries.

No simulator, model or evaluator input is consumed. Rejection of a historical
witness is reported as divergence in this fixed-input diagnostic, not a new
closed-loop result or a revision of the historical result.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(os.environ.get('WORLD_MODEL_ROOT', ROOT/'vendor/wm_kit_opt2'))))
from autonomous_brain.perception import Perception


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit(brain_directory):
    paths = {name: brain_directory/name for name in
             ('summary.json', 'observations.jsonl', 'bridge-calls.jsonl', 'rounds.jsonl')}
    summary = json.loads(paths['summary.json'].read_text())
    observations = [json.loads(line) for line in paths['observations.jsonl'].read_text().splitlines()]
    calls = [json.loads(line) for line in paths['bridge-calls.jsonl'].read_text().splitlines()]
    camera = next(c['terminal']['result'] for c in calls
                  if c['request']['method'] == 'camera_parameters')
    bridge_observations = {str(c['terminal']['result']['frameId']): c['terminal']['result']
                          for c in calls if c['request']['method'] == 'observe'}
    if len(bridge_observations) != sum(c['request']['method'] == 'observe' for c in calls):
        raise ValueError('Duplicate bridge camera frame')
    events = {}
    for event in summary['action_evidence']:
        if event['action'] in {'pick', 'release_unverified', 'place'}:
            events.setdefault(event['evidence']['post_observation'], []).append(event)
    p = Perception(camera)
    outcomes, release_views, conflicts = [], [], []
    for row in observations:
        index, raw = row['observation_index'], row['observation']
        if bridge_observations[str(raw['frameId'])] != raw:
            raise ValueError('Original bridge observation differs from prefix frame')
        current_events = events.get(index, [])
        for event in current_events:
            if event['action'] == 'release_unverified':
                p.begin_release(event['object_id'], event['evidence'].get('release_aim_position_m'))
        current = p.update(raw, row['odometry'], simulation_time_s=row['simulation_seconds'],
                           round_index=row['round'], observation_index=index)
        if current_events:
            release_views.append({'observation_index': index, 'round': row['round'],
                'event_types': [e['action'] for e in current_events],
                'red_detections': [{k:d.get(k) for k in
                    ('bbox', 'track_id', 'known_delivered_object_id', 'identity_ambiguity',
                     'fed_to_world_model', 'reason', 'raw_distance_cm')}
                    for d in current['detections'] if d['category']=='red-ball']})
        for event in current_events:
            oid, kind = event['object_id'], event['action']
            evidence = copy.deepcopy(event['evidence'])
            if kind == 'pick':
                old = p.get_object(oid)
                if old is None:
                    accepted = False
                else:
                    point = old['position_m']
                    view = p.original_position_evidence((point['x'],point['z']), old['category'])
                    evidence['original_position_observation'] = view
                    accepted = p.mark_picked(oid, holding=row['holding']['holding'],
                        original_position_absent=view['valid'] and not view['matches'],
                        simulation_time_s=row['simulation_seconds'], evidence=evidence)
            elif kind == 'release_unverified':
                accepted = p.mark_release_unverified(oid, simulation_time_s=row['simulation_seconds'],
                                                     evidence=evidence)
            else:
                accepted = p.mark_delivered(oid, holding=row['holding']['holding'],
                    ball_in_storage=True, simulation_time_s=row['simulation_seconds'], evidence=evidence)
            outcome = {'observation_index':index,'round':row['round'],'object_id':oid,
                       'action':kind,'accepted_by_current_sensor_rules':accepted}
            outcomes.append(outcome)
            if not accepted:
                conflicts.append(outcome)
    return {'schema':'delivered-identity-fixed-prefix/v1',
        'mode':'fixed_public_sensor_prefix_not_closed_loop',
        'scope':'All original camera and odometry frames are replayed; only historical observed pick/release/place boundaries are applied. No truth or evaluator files are read. Historical reports are unchanged.',
        'inputs':{name:{'path':str(path),'sha256':digest(path)}for name,path in paths.items()},
        'implementation':{'perception.py':digest(ROOT/'autonomous_brain/perception.py'),
                          'diagnostic.py':digest(Path(__file__))},
        'sensor_frames_replayed':len(observations),'action_boundaries':outcomes,
        'discovery_evidence':p.discovery_evidence(),
        'action_frame_red_identity_evidence':release_views,'historical_witnesses_rejected':conflicts,
        'unverified_releases':[{'object_id':e['object_id'],'release_observation':e.get('release_observation')}
                              for e in p.unverified_releases()]}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--brain-dir',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if args.output.exists():
        parser.error('--output must be new; fixed-input diagnostics never overwrite evidence')
    result=audit(args.brain_dir)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
    print(json.dumps({'sensor_frames_replayed':result['sensor_frames_replayed'],
        'historical_witnesses_rejected':result['historical_witnesses_rejected'],
        'output':str(args.output)},ensure_ascii=False))


if __name__=='__main__':
    main()
