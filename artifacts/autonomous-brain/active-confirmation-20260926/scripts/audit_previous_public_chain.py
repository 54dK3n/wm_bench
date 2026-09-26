"""Read only the prior run's public brain logs; no simulator or brain execution."""
import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--brain-dir', type=Path, default=Path(
    'artifacts/autonomous-brain/recovery-closure-20260926/raw/formal-stage1/map-05-run-1/brain'))
parser.add_argument('--output', type=Path, default=Path(
    'artifacts/autonomous-brain/active-confirmation-20260926/raw/discovery/previous-public-chain.json'))
args = parser.parse_args()
sources = []


def rows(name):
    path = args.brain_dir / name
    sha, count, size = hashlib.sha256(), 0, 0
    with path.open('rb') as stream:
        for line in stream:
            assert line.endswith(b'\n'), 'incomplete public log line'
            sha.update(line)
            count += 1
            size += len(line)
            yield json.loads(line)
    sources.append(dict(path=str(path), sha256=sha.hexdigest(), rows=count, bytes=size))


decisions = {}
for r in rows('rounds.jsonl'):
    state, result = r['state'], r['result']
    decisions[result['evidence']['before_observation']] = dict(round=r['round'],
        simulation_seconds=state['simulation_seconds'], discovery=state.get('discovery', {}),
        action=r['action'])

chain, old_summary_omissions, insertion_order_mismatches, active_candidate_omissions = [], [], [], []
final = None
for o in rows('observations.jsonl'):
    final = o
    by_id = {r['id']: r for r in o['objects'] if r['category'] == 'red-ball'}
    ledger = o['discovery_evidence']
    records = {r['id']: r for r in ledger['records']}
    for d in o['perception']['detections']:
        if d['category'] != 'red-ball':
            continue
        source = records[d['discovery_id']]
        obj = by_id.get(d.get('track_id'), {})
        pose = next((p for p in obj.get('hit_poses', []) if p['frame_id'] == d['frame_id']), None)
        chain.append(dict(round=o['round'], observation_index=o['observation_index'],
            frame_id=d['frame_id'], tick=o['observation']['tick'],
            discovery_id=source['id'], hypothesis_id=source['hypothesis_id'],
            bbox=source['bbox'], odometry=o['odometry'],
            raw_distance_cm=d.get('raw_distance_cm'), raw_bearing_deg=d.get('raw_bearing_deg'),
            associated_track_id=d.get('track_id'), admission_reason=d.get('reason'),
            fed_to_world_model=d['fed_to_world_model'], accepted_independent_hit=pose is not None,
            accepted_hit_pose=pose, track_state=obj.get('state'), track_hit_count=obj.get('hit_count'),
            identity_ambiguity=d.get('identity_ambiguity'),
            known_delivered_object_id=d.get('known_delivered_object_id')))
    if o['observation_index'] not in decisions:
        continue
    decision = decisions[o['observation_index']]
    assert decision['simulation_seconds'] == o['simulation_seconds']
    shown = decision['discovery'].get('pending', [])
    shown_hypotheses = {r['hypothesis_id'] for r in shown}
    latest = {}
    for record in ledger['unresolved']:
        latest[record['hypothesis_id']] = record
    historical_choice = list(latest.values())[-6:]
    assert [r['id'] for r in historical_choice] == [r['id'] for r in shown]
    newest = sorted(latest.values(), key=lambda r: r['perception_observation_index'], reverse=True)[:6]
    omitted = [r for r in newest if r['hypothesis_id'] not in shown_hypotheses]
    if omitted:
        insertion_order_mismatches.append(dict(round=decision['round'], observation_index=o['observation_index'],
            selected=[r['id'] for r in shown], newer_omitted=[dict(id=r['id'], hypothesis_id=r['hypothesis_id'],
                observation_index=r['observation_index']) for r in omitted]))
    current_omitted = [r for r in latest.values() if r['frame_id'] == o['perception']['frame_id']
                       and r['hypothesis_id'] not in shown_hypotheses]
    if current_omitted:
        old_summary_omissions.append(dict(round=decision['round'], observation_index=o['observation_index'],
            omitted=[r['id'] for r in current_omitted]))
    active = [d for d in o['perception']['detections'] if d['category'] == 'red-ball'
              and by_id.get(d.get('track_id'), {}).get('state') in {'TENTATIVE', 'STALE'}
              and records[d['discovery_id']]['hypothesis_id'] not in shown_hypotheses]
    if active:
        active_candidate_omissions.append(dict(round=decision['round'], observation_index=o['observation_index'],
            omitted=[dict(discovery_id=d['discovery_id'], track_id=d['track_id'],
                state=by_id[d['track_id']]['state'], hit_count=by_id[d['track_id']]['hit_count'],
                raw_distance_cm=d['raw_distance_cm'], raw_bearing_deg=d['raw_bearing_deg']) for d in active]))

assert final is not None
final_red = [r for r in final['objects'] if r['category'] == 'red-ball']
by_track = {}
for obj in final_red:
    entries = [r for r in chain if r['associated_track_id'] == obj['id']]
    by_track[obj['id']] = dict(final_state=obj['state'], ever_confirmed=obj['ever_confirmed'],
        final_hit_count=obj['hit_count'], fed_count=sum(r['fed_to_world_model'] for r in entries),
        accepted_hit_observations=[r['observation_index'] for r in entries if r['accepted_independent_hit']],
        accepted_hit_poses=obj['hit_poses'])
output = dict(schema='public-discovery-association-admission-hit-audit/v1',
    scope={'public_brain_logs_only': True, 'truth_read': False, 'model_or_simulator_calls': False,
           'replay_kind': 'raw-log joins only; no production perception rerun'},
    sources=sources, counts=dict(rounds=len(decisions), observations=final['observation_index'],
        red_detections=len(chain), wm_admitted=sum(r['fed_to_world_model'] for r in chain),
        accepted_independent_hits=sum(r['accepted_independent_hit'] for r in chain),
        active_unconfirmed_summary_omission_rounds=len(active_candidate_omissions),
        insertion_order_vs_latest_record_mismatch_rounds=len(insertion_order_mismatches),
        current_unresolved_summary_omission_rounds=len(old_summary_omissions)),
    per_track=by_track, red_detection_chain=chain,
    historical_discovery_associations=final['discovery_evidence']['associations'],
    insertion_order_vs_latest_record_mismatches=insertion_order_mismatches,
    current_unresolved_summary_omissions=old_summary_omissions,
    active_unconfirmed_summary_omissions=active_candidate_omissions,
    limitations=['Record recency is not independent evidence progress.',
                 'Association/hypothesis IDs are not physical truth identities.',
                 'The audit does not claim that a different summary would guarantee delivery.'])
with args.output.open('x') as stream:
    json.dump(output, stream, ensure_ascii=False, indent=2)
    stream.write('\n')
print(json.dumps({'counts': output['counts'], 'per_track': by_track,
                  'insertion_order_examples': insertion_order_mismatches[:3],
                  'active_omission_examples': active_candidate_omissions[:4]}, ensure_ascii=False, indent=2))
