"""Current unknown pixels are indeterminate negative evidence, never identity.

The original public prefix rebuilds the P22 state. Replacing only its final
update with P23 is a component counterfactual, not a new competition result.
Remaining cases explicitly use synthetic sensor inputs and competing tracks.
"""
import copy
import json
from pathlib import Path

import pytest

from test_brain_perception import CAMERA, Perception, ball
from world_model.types import ObjectState


FIXTURE = json.loads((Path(__file__).parent / 'fixtures/run_20261013T084755_r41_negative_visibility_public.json').read_text())
REASON = 'current_unknown_pixels_do_not_support_missed_sighting'


def update(p, row):
    return p.update(row['observation'], row['odometry'], simulation_time_s=row['simulation_seconds'],
                    round_index=row['round'], observation_index=row['observation_index'])


@pytest.fixture(scope='module')
def original_prefix():
    p = Perception(FIXTURE['camera'])
    # Disable exactly the new per-frame rule while replaying the old prefix.
    # The old never-confirmed visibility adapter and all WM behavior still run.
    p._unknown_pixel_candidates = lambda *args: {}
    motions = {m['after_observation']: m for m in FIXTURE['manipulation_motions']}
    for row in FIXTURE['observations'][:-1]:
        motion = motions.get(row['observation_index'])
        if motion:
            p.note_manipulation_boundary(dict(motion, outcome_unknown=True), None)
            p.note_manipulation_boundary(motion, row['observation_index'])
        update(p, row)
    original = FIXTURE['original_target_at_194']
    actual = p.get_object('target_032')
    for key in ('state', 'confidence', 'position_m', 'hit_count', 'last_seen_s', 'hit_poses'):
        assert actual[key] == original[key]
    del p._unknown_pixel_candidates
    return p


def test_public_r41_changes_only_negative_decay_and_unknown_stays_ungraspable(original_prefix):
    p, old = copy.deepcopy(original_prefix), copy.deepcopy(original_prefix)
    old._unknown_pixel_candidates = lambda *args: {}
    before = copy.deepcopy(vars(p.wm.get_object('target_032')))
    row = FIXTURE['observations'][-1]
    prior_evidence = update(old, row)
    evidence = update(p, row)
    target = p.wm.get_object('target_032')
    assert old.get_object('target_032')['confidence'] == FIXTURE['original_target_at_195']['confidence']
    assert old.get_object('target_032')['state'] == 'STALE'
    assert p.get_object('target_032')['state'] == 'CONFIRMED'
    dt = row['simulation_seconds'] - before['last_updated']
    assert target.confidence == pytest.approx(before['confidence'] * .5 ** (dt / 60))
    assert target.last_updated == row['simulation_seconds']
    for key in ('x', 'z', 'hit_count', 'last_seen', 'miss_count', 'last_bbox', 'last_frame_id'):
        assert getattr(target, key) == before[key]
    assert evidence['raw_observation'] == prior_evidence['raw_observation'] == row['observation']
    unknown = [d for d in evidence['detections'] if d['category'] == 'red-ball']
    assert len(unknown) == 1 and unknown[0]['pixel_quality']['status'] == 'unknown'
    assert unknown[0]['track_id'] is None and not unknown[0]['fed_to_world_model']
    assert not unknown[0].get('visibility_refresh_only')
    assert any(r['object_id'] == 'target_032' and r['reason'] == REASON
               and r['positive_visibility'] is False for r in evidence['visibility_expectation_unknown'])
    current = {**row, 'perception': evidence}
    check = p.check_grasp_identity('target_032', current)
    assert not check['authorized'] and check['reason'] == 'grab_identity_not_uniquely_visible'
    assert not p.authorize_grab('target_032', current, {'round': 41, 'before_observation': 195})['authorized']
    assert p._discovery_resolutions == old._discovery_resolutions


def sensor(frame, time, items, forward=32):
    return {'observation_index': frame, 'round': frame, 'simulation_seconds': time,
            'observation': {'frameId': frame, 'tick': frame, 'width': 640, 'height': 480,
                            'detections': copy.deepcopy(items)},
            'odometry': {'tick': frame, 'forwardCm': forward, 'rightCm': 0,
                         'headingDeg': 0, 'distanceCm': forward}, 'holding': {'holding': False}}


def confirmed():
    p = Perception(CAMERA)
    for frame, forward in enumerate((0, 16, 32), 1):
        update(p, sensor(frame, frame / 10, [ball(80 - forward)], forward))
    oid = p.wm.get_scene()[0].obj_id
    assert p.confirmed(oid)
    return p, oid


def unknown(frame, reading=48, bearing=0, reason='source_bbox_touches_boundary'):
    item = ball(reading, bearing=bearing)
    if reason == 'source_bbox_touches_boundary':
        item['bbox']['h'] = 480 - item['bbox']['y']
    item['pixelQuality'] = {'schema': 'red-component-quality/v1', 'frameId': frame,
        'componentPixels': 100, 'redSectorPixels': 90 if reason == 'source_bbox_touches_boundary' else 40,
        'status': 'unknown', 'reason': reason}
    return item


def mask(evidence):
    return [row for row in evidence['visibility_expectation_unknown'] if row['reason'] == REASON]


@pytest.mark.parametrize('kind', ['empty', 'far_red', 'blue', 'supported'])
def test_no_related_current_unknown_has_no_new_negative_mask(kind):
    p, oid = confirmed()
    before = copy.deepcopy(vars(p.wm.get_object(oid)))
    items = {'empty': [], 'far_red': [unknown(4, 100, 30)],
             'blue': [ball(48, category='blue-ball')], 'supported': [ball(48)]}[kind]
    e = update(p, sensor(4, 1.3, items))
    assert not mask(e)
    if kind != 'supported':
        t = p.wm.get_object(oid)
        assert t.confidence == pytest.approx(before['confidence'] * .5 ** (1 / 1.5))
        assert t.miss_count == before['miss_count'] + 1


@pytest.mark.parametrize('reason', ['source_bbox_touches_boundary', 'red_sector_not_majority'])
def test_mask_is_per_frame_and_never_refreshes_positive_metadata(reason):
    p, oid = confirmed()
    before = copy.deepcopy(vars(p.wm.get_object(oid)))
    e = update(p, sensor(4, 1.3, [unknown(4, reason=reason)]))
    assert [r['object_id'] for r in mask(e)] == [oid]
    t = p.wm.get_object(oid)
    assert t.confidence == pytest.approx(before['confidence'] * .5 ** (1 / 60))
    for key in ('x', 'z', 'hit_count', 'last_seen', 'miss_count', 'state', 'last_bbox', 'last_frame_id'):
        assert getattr(t, key) == before[key]
    slow = t.confidence
    e = update(p, sensor(5, 2.3, []))
    assert not mask(e) and not p._visibility.unknown_positions
    assert t.confidence == pytest.approx(slow * .5 ** (1 / 1.5))
    assert t.miss_count == before['miss_count'] + 1


def test_multiple_candidates_are_all_retained_unknown_not_assigned():
    p, oid = confirmed()
    rival = copy.deepcopy(p.wm.get_object(oid))
    rival.obj_id = 'synthetic-distinct-red'
    rival.x += .08
    p.wm._objects[rival.obj_id] = rival
    p._times[rival.obj_id] = copy.deepcopy(p._times[oid])
    before = {t.obj_id: copy.deepcopy(vars(t)) for t in p.wm.get_scene()}
    row = sensor(4, 1.3, [unknown(4), unknown(4, 48, 12)])
    e = update(p, row)
    assert {r['object_id'] for r in mask(e)} == {oid, rival.obj_id}
    assert all(d['track_id'] is None and not d['fed_to_world_model'] for d in e['detections'])
    for t in p.wm.get_scene():
        assert t.last_seen == before[t.obj_id]['last_seen'] and t.hit_count == before[t.obj_id]['hit_count']
    assert not p.check_grasp_identity(oid, {**row, 'perception': e})['authorized']
    row = sensor(5, 1.4, [ball(48)])
    e = update(p, row)
    assert not mask(e)
    check = p.check_grasp_identity(oid, {**row, 'perception': e})
    assert not check['authorized'] and check['reason'] == 'grab_identity_competition'
    assert set(check['candidate_ids_by_detection'][0]) == {oid, rival.obj_id}


def test_same_coordinates_do_not_expand_mask_to_different_category():
    p, oid = confirmed()
    rival = copy.deepcopy(p.wm.get_object(oid))
    rival.obj_id, rival.name = 'synthetic-distinct-blue', 'distractor'
    p.wm._objects[rival.obj_id] = rival
    before = p.wm.get_object(oid).confidence
    e = update(p, sensor(4, 1.3, [unknown(4)]))
    assert not mask(e) and not p._visibility.unknown_positions
    assert p.wm.get_object(oid).confidence == pytest.approx(before * .5 ** (1 / 1.5))
    assert rival.miss_count == 1


def test_archived_red_rival_remains_unchanged_and_blocks_later_full_view():
    p, oid = confirmed()
    rival = copy.deepcopy(p.wm.get_object(oid))
    rival.obj_id, rival.state, rival.confidence = 'synthetic-lost-red', ObjectState.LOST, .1
    rival.x += .08
    p.wm._lost[rival.obj_id] = rival
    # A real archived track was registered in Perception before WM archived it.
    p._history[rival.obj_id] = copy.deepcopy(p._history[oid])
    p._times[rival.obj_id] = copy.deepcopy(p._times[oid])
    before = copy.deepcopy(vars(rival))
    e = update(p, sensor(4, 1.3, [unknown(4)]))
    assert [r['object_id'] for r in mask(e)] == [oid]
    assert vars(rival) == before
    row = sensor(5, 1.4, [ball(48)])
    e = update(p, row)
    check = p.check_grasp_identity(oid, {**row, 'perception': e})
    assert not check['authorized'] and check['reason'] == 'grab_identity_competition'
    assert rival.obj_id in check['candidate_ids_by_detection'][0]
    assert vars(rival) == before


def test_unknown_time_decay_expires_and_does_not_revive_archive():
    p, oid = confirmed()
    t = p.wm.get_object(oid)
    last_seen = t.last_seen
    update(p, sensor(4, 300, [unknown(4)]))
    archived = p.wm.get_archived(oid)
    assert archived is not None and archived.last_seen == last_seen
    before = copy.deepcopy(vars(archived))
    e = update(p, sensor(5, 301, [unknown(5)]))
    assert not mask(e) and vars(archived) == before
    assert e['detections'][0]['track_id'] is None


@pytest.mark.parametrize('state', ['STALE', 'HELD', 'DELIVERED'])
def test_no_state_upgrade_or_lifecycle_replacement(state):
    p, oid = confirmed()
    track = p.wm.get_object(oid)
    if state == 'STALE':
        track.confidence, track.state = .4, ObjectState.STALE
    else:
        p._lifecycle[oid] = state
    e = update(p, sensor(4, 1.3, [unknown(4)]))
    assert p.get_object(oid)['state'] == state
    if state != 'STALE': assert not mask(e)


def test_invalid_frame_bound_quality_is_rejected_without_wm_change():
    p, oid = confirmed()
    before = copy.deepcopy(vars(p.wm.get_object(oid)))
    with pytest.raises(ValueError, match='bound'):
        update(p, sensor(4, 1.3, [unknown(99)]))
    assert vars(p.wm.get_object(oid)) == before
