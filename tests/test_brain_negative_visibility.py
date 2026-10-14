"""Negative observation quality through real Perception and vendored WM."""
import copy
import json
import math
from pathlib import Path

import pytest
from test_brain_perception import CAMERA, Perception, ball, observe

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/negative_visibility_public.json').read_text())


def update(p, row):
    return p.update(row['observation'], row['odometry'],
                    simulation_time_s=row['simulation_seconds'],
                    observation_index=row['observation_index'])


def conflicting_track():
    p = Perception(FIXTURE['camera'])
    for row in FIXTURE['frames'][:2]:
        evidence = update(p, row)
    oid = next(d['track_id'] for d in evidence['detections'] if d['category'] == 'red-ball')
    return p, oid


def test_public_conflict_uses_time_decay_then_native_independent_confirmation():
    p, oid = conflicting_track()
    track = p.wm.get_object(oid)
    before = copy.deepcopy(vars(track))
    assert track.hit_count == 2
    assert p.get_object(oid)['position_evidence']['mutual_reprojection_failed_pairs'] == [['22', '29']]
    for row in FIXTURE['frames'][2:4]:
        evidence = update(p, row)
        assert [r['object_id'] for r in evidence['visibility_expectation_unknown']] == [oid]
        assert not evidence['visibility_expectation_unknown'][0]['positive_visibility']
        assert track.confidence == pytest.approx(before['confidence'] * .5 **
            ((row['simulation_seconds'] - before['last_updated']) / 60))
        for key in ['x', 'z', 'hit_count', 'last_seen', 'miss_count', 'state']:
            assert getattr(track, key) == before[key]
        assert track.last_updated == row['simulation_seconds']
        assert p.wm.get_archived(oid) is None
        assert p.confirmed(oid) is None
    evidence = update(p, FIXTURE['frames'][4])
    red = [d for d in evidence['detections'] if d['category'] == 'red-ball']
    assert red[0]['track_id'] == oid
    assert red[0]['fed_to_world_model']
    assert track.hit_count == 3
    assert p.confirmed(oid) is not None
    assert len([o for o in p.objects() if o['category'] == 'red-ball']) == 1
    assert [r['frame_id'] for r in p._discovery_records] == ['22', '29', '40']
    assert not p._discovery_resolutions  # No invented geometry or identity binding.


@pytest.mark.parametrize('kind', ['consistent', 'single_source', 'missing_source'])
def test_unsupported_or_consistent_histories_keep_normal_missed_decay(kind):
    if kind == 'missing_source':
        p, oid = conflicting_track()
        p._discovery_records.pop(0)
    else:
        p = Perception(CAMERA)
        observe(p, 1)
        if kind == 'consistent':
            observe(p, 2, 16)
        oid = p.wm.get_scene()[0].obj_id
    track = p.wm.get_object(oid)
    before = copy.deepcopy(vars(track))
    # Look directly at the same approximate point within the original FOV.
    now = before['last_updated'] + 1
    bearing = math.degrees(math.atan2(track.x - p.pose.x, track.z - p.pose.z))
    e = observe(p, 900, p.pose.z * 100, right=p.pose.x * 100,
                heading=-bearing, time=now, items=[])
    assert e['visibility_expectation_unknown'] == []
    assert track.confidence == pytest.approx(before['confidence'] * .5 ** (1 / 1.5))
    assert track.miss_count == before['miss_count'] + 1
    assert track.last_seen == before['last_seen']


def test_unknown_visibility_still_expires_without_reviving_archives():
    p, oid = conflicting_track()
    records = copy.deepcopy(p._discovery_records)
    last_seen = p.wm.get_object(oid).last_seen
    observe(p, 900, time=300, items=[])
    archived = p.wm.get_archived(oid)
    assert archived is not None
    assert archived.last_seen == last_seen
    before = copy.deepcopy(vars(archived))
    observe(p, 901, time=301, items=[ball(20)])
    assert vars(archived) == before
    assert p.wm.get_archived(oid) is archived
    assert p._discovery_records[:len(records)] == records


def test_coincident_unqualified_track_keeps_default_visibility():
    p, oid = conflicting_track()
    track = p.wm.get_object(oid)
    rival = copy.deepcopy(track)
    rival.obj_id = 'synthetic-different-object'
    rival.name = 'distractor'
    p.wm._objects[rival.obj_id] = rival
    before, last_updated = rival.confidence, rival.last_updated
    e = update(p, FIXTURE['frames'][2])
    assert e['visibility_expectation_unknown'] == []
    # The unchanged static profile gives distractors a 1.5 class multiplier.
    assert rival.confidence == pytest.approx(before * .5 ** ((19.32 - last_updated) / (1.5 * 1.5)))
    assert rival.miss_count == 1


def test_confirmed_identity_retains_existing_negative_evidence_rules():
    p, oid = conflicting_track()
    update(p, FIXTURE['frames'][4])
    track = p.wm.get_object(oid)
    assert p.confirmed(oid) is not None
    assert p.get_object(oid)['position_evidence']['mutual_reprojection_failed_pairs']
    before, last_updated = track.confidence, track.last_updated
    e = observe(p, 901, p.pose.z * 100, right=p.pose.x * 100,
                heading=-math.degrees(math.atan2(track.x-p.pose.x, track.z-p.pose.z)),
                time=last_updated+1, items=[])
    assert e['visibility_expectation_unknown'] == []
    assert track.confidence == pytest.approx(before * .5 ** (1/1.5))
    assert track.miss_count == 1


def test_clipped_source_stays_an_unknown_obligation_not_an_identity_proof():
    p = Perception(CAMERA)
    clipped = {'category': 'red-ball', 'source': 'virtual-cv', 'confidence': .92,
               'bbox': {'x': 0, 'y': 220, 'w': 58, 'h': 40}}
    e = observe(p, 1, items=[clipped])
    oid = e['detections'][0]['track_id']
    observe(p, 2, 16, heading=40, items=[ball(60)])
    track = p.wm.get_object(oid)
    assert track.hit_count == 2
    records = copy.deepcopy(p._discovery_records)
    e = observe(p, 3, 16, heading=40, time=3, items=[])
    assert e['visibility_expectation_unknown']
    assert p._discovery_records == records
    assert p._discovery_records[0]['bbox'] == clipped['bbox']
    assert not p._discovery_resolutions
    assert p.confirmed(oid) is None


def test_same_frame_competing_red_detections_still_block_grasp_identity():
    p, oid = conflicting_track()
    row = copy.deepcopy(FIXTURE['frames'][4])
    first = next(d for d in row['observation']['detections'] if d['category'] == 'red-ball')
    # Synthetic second detection, not a claim about a physical object in the
    # source run. Both boxes compete inside the unchanged association gate.
    second = copy.deepcopy(first)
    second['bbox']['x'] += 20
    row['observation']['detections'].append(second)
    evidence = update(p, row)
    red_ids = {o['id'] for o in p.objects() if o['category'] == 'red-ball'}
    assert len(red_ids) == 2
    assert oid in red_ids
    assert p.confirmed(oid) is not None
    snapshot = {'observation_index': row['observation_index'],
        'observation': row['observation'], 'odometry': row['odometry'],
        'simulation_seconds': row['simulation_seconds'], 'perception': evidence,
        'holding': {'holding': False}}
    result = p.check_grasp_identity(oid, snapshot)
    assert result['authorized'] is False
    assert result['reason'] == 'grab_identity_competition'
    red_indices = [i for i, d in enumerate(evidence['detections']) if d['category'] == 'red-ball']
    assert len(red_indices) == 2
    assert all(set(result['candidate_ids_by_detection'][i]) == red_ids for i in red_indices)
    assert result['target_detection_indices'] == red_indices
    assert len(p._discovery_records) == 4
    assert p._discovery_records[-2]['bbox'] != p._discovery_records[-1]['bbox']
    assert not p._discovery_resolutions
