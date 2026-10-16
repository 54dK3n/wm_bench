"""Same-frame red side pixels may permit undoing a known approach, never a grab.

The 205/206 source window is original public evidence. Actuators and future
readings in SameCategoryReturnRuntime are synthetic component inputs, not a
competition or a model run. Original observations and peer records stay intact.
"""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.observation_quality import pixel_quality
from autonomous_brain.perception import Perception
from test_brain_grab_authorization import actual_grabs
from test_brain_pick_pixel_recovery import ClippedRetryRuntime, commands


PUBLIC = json.loads((Path(__file__).parent / 'fixtures' /
    'run_20261015T110439_r45_same_red_bottom_clip_public.json').read_text())


def public_actions():
    row = copy.deepcopy(PUBLIC['observations'][-1])
    return Actions(SimpleNamespace(snapshot=row)), row


class SameCategoryReturnRuntime(ClippedRetryRuntime):
    def __init__(self, **kwargs):
        self.bad_receipt_method = None
        super().__init__(**kwargs)

    def observe(self, *, motion=None):
        original = self.perception.update

        def public_sensor(raw, odo, **kwargs):
            if not self.holding and self.forward > self.clip_after:
                peer = {'category': 'red-ball', 'source': 'virtual-cv', 'confidence': .92,
                    'bbox': {'x': 176, 'y': 40, 'w': 12, 'h': 14},
                    'pixelQuality': {'schema': 'red-component-quality/v1',
                        'frameId': int(raw['frameId']), 'componentPixels': 35,
                        'redSectorPixels': 34, 'status': 'supported',
                        'reason': 'red_sector_majority'}}
                assert pixel_quality(peer, raw['frameId']) == peer['pixelQuality']
                raw['detections'].append(peer)
            return original(raw, odo, **kwargs)

        self.perception.update = public_sensor
        try:
            return super().observe(motion=motion)
        finally:
            self.perception.update = original

    def call(self, method, params):
        result = super().call(method, params)
        return {} if method == self.bad_receipt_method else result


def test_public_same_red_layout_permits_only_inverse_and_keeps_both_original_records():
    actions, row = public_actions()
    original = copy.deepcopy(row)
    source, clipped = PUBLIC['observations']
    motion, = PUBLIC['motions']
    assert (source['observation_index'], clipped['observation_index']) == (205, 206)
    assert motion['method'] == 'forward' and motion['actuator_result']['completed'] is True
    assert motion['motion_verification']['motion_verified'] is True
    assert motion['motion_verification']['before_holding'] is False
    assert motion['motion_verification']['after_holding'] is False
    assert motion['motion_verification']['measured_cm'] == pytest.approx(6.000833275471005)
    assert actions._bottom_clip_inverse_candidate('red-ball')
    assert row == original
    # A new Perception/WM consumes only the original public camera and raw frame.
    # It must not use the clipped source as a positive identity or discard a peer.
    perception = Perception(PUBLIC['camera'])
    row['perception'] = perception.update(row['observation'], row['odometry'],
        simulation_time_s=row['simulation_seconds'], round_index=row['round'],
        observation_index=row['observation_index'])
    assert actions._bottom_clip_inverse_candidate('red-ball')
    assert row['observation'] == original['observation']
    assert [item['category'] for item in row['perception']['detections']] == [
        item['category'] for item in original['observation']['detections']]
    converted = [item for item in row['perception']['detections'] if item['category'] == 'red-ball']
    assert [item['category'] for item in converted] == ['red-ball', 'red-ball']
    assert [item['pixel_quality']['status'] for item in converted] == ['unknown', 'supported']
    assert all(item['track_id'] is None and item['fed_to_world_model'] is False for item in converted)
    assert not any(obj['category'] == 'red-ball' for obj in perception.objects())
    assert not perception._grab_authorizations


@pytest.mark.parametrize('fault', ['missing-quality', 'unknown-quality', 'old-quality-frame',
    'raw-quality-mismatch', 'invalid-counts', 'wrong-schema', 'side-clip', 'top-clip',
    'touch', 'overlap', 'second-bottom-clip'])
def test_same_red_peer_must_be_complete_strictly_supported_bound_and_separate(fault):
    actions, row = public_actions()
    raw = row['observation']['detections'][1]
    item = row['perception']['detections'][1]
    if fault == 'missing-quality':
        raw.pop('pixelQuality'); item.pop('pixel_quality')
    elif fault == 'raw-quality-mismatch':
        raw['pixelQuality']['redSectorPixels'] -= 1
    elif fault in {'unknown-quality', 'old-quality-frame', 'invalid-counts', 'wrong-schema'}:
        quality = copy.deepcopy(raw['pixelQuality'])
        if fault == 'unknown-quality':
            quality.update(status='unknown', reason='red_sector_not_majority', redSectorPixels=0)
        elif fault == 'old-quality-frame':
            quality['frameId'] -= 1
        elif fault == 'invalid-counts':
            quality['redSectorPixels'] = quality['componentPixels'] + 1
        else:
            quality['schema'] = 'unrecognized-quality/v1'
        raw['pixelQuality'] = quality
        item['pixel_quality'] = copy.deepcopy(quality)
    else:
        box = copy.deepcopy(raw['bbox'])
        if fault == 'side-clip': box['x'] = 0
        elif fault == 'top-clip': box['y'] = 0
        elif fault == 'touch': box['y'] = 316 - box['h']
        elif fault == 'overlap': box['y'] = 310
        else:
            box.update(x=10, y=470, w=12, h=10)
            raw['pixelQuality'].update(status='unknown', reason='source_bbox_touches_boundary')
            item['pixel_quality'] = copy.deepcopy(raw['pixelQuality'])
        raw['bbox'] = box
        item['bbox'] = copy.deepcopy(box)
    original = copy.deepcopy(row)
    assert not actions._bottom_clip_inverse_candidate('red-ball')
    assert row == original


def test_same_red_peer_allows_measured_inverse_then_fresh_identity_before_smaller_probe():
    r = SameCategoryReturnRuntime(grab_results=(False, True))
    result = r.pick()
    assert not result['success'] and result['reason'] == 'grab_identity_not_uniquely_visible'
    assert result['evidence']['authorization_recovery']['success']
    probe = result['evidence']['retry_probe']
    assert probe['limit_cm'] == 3
    clipped = next(o for o in r.observations if o['observation_index'] == probe['clipped_observation'])
    assert [d['category'] for d in clipped['observation']['detections']] == ['red-ball', 'red-ball']
    assert [d['category'] for d in clipped['perception']['detections']] == ['red-ball', 'red-ball']
    assert [d['pixel_quality']['status'] for d in clipped['perception']['detections']] == ['unknown', 'supported']
    assert clipped['perception']['detections'][0]['track_id'] is None
    assert clipped['perception']['detections'][0]['fed_to_world_model'] is False
    assert commands(r, 'backward') == [{'distanceCm': pytest.approx(6), 'speed': 20}]
    assert r.forward == pytest.approx(r.entry['forwardCm'])
    assert probe['restored_observation'] > probe['clipped_observation']
    assert r.perception.check_grasp_identity(r.object_id, r.snapshot)['authorized']
    assert r.pending_grasp is None and r.held_object_id is None
    assert len(actual_grabs(r)) == 1 and not r.perception.action_evidence()
    # A separate decision consumes the smaller bound without reusing the old
    # empty grab. It remains failed while its new view is clipped.
    second = r.pick()
    assert not second['success'] and second['evidence']['attempts'] == []
    assert second['evidence']['retry_probe']['limit_cm'] == 1.5
    assert len(actual_grabs(r)) == 1


@pytest.mark.parametrize('fault', ['forward-unknown', 'unknown', 'partial'])
def test_same_red_peer_never_retries_unknown_motion_or_learns_from_partial_inverse(fault):
    r = SameCategoryReturnRuntime(recovery_fault=fault)
    if fault == 'partial':
        result = r.pick()
        assert not result['success']
        assert not result['evidence']['authorization_recovery']['success']
    else:
        with pytest.raises(ConnectionError):
            r.pick()
    assert r.inverse_attempts == (0 if fault == 'forward-unknown' else 1)
    assert r.actions._pick_probe_limits == {} and not r.perception.action_evidence()
    assert len(actual_grabs(r)) == 1


@pytest.mark.parametrize('method', ['grab', 'forward'])
def test_same_red_peer_cannot_replace_a_completed_source_command_receipt(method):
    r = SameCategoryReturnRuntime()
    r.bad_receipt_method = method
    result = r.pick()
    assert not result['success'] and 'retry_probe' not in result['evidence']
    assert not commands(r, 'backward') and r.actions._pick_probe_limits == {}
    assert len(actual_grabs(r)) == 1


def test_same_red_inverse_returning_to_competition_cannot_learn_or_offer_a_grab():
    r = SameCategoryReturnRuntime()
    r.rival_after_return = True
    checks = []
    original = r.perception.check_grasp_identity

    def record_identity_check(object_id, snapshot):
        result = original(object_id, snapshot)
        checks.append({'observation_index': snapshot['observation_index'],
            'red_count': sum(item['category'] == 'red-ball'
                             for item in snapshot['observation']['detections']),
            'result': copy.deepcopy(result)})
        return result

    r.perception.check_grasp_identity = record_identity_check
    result = r.pick()
    assert not result['success'] and result['evidence']['authorization_recovery']['success']
    assert r.inverse_attempts == 1
    assert 'retry_probe' not in result['evidence'] and 'pick_retry' not in result['evidence']
    assert r.actions._pick_probe_limits == {} and not r.perception.action_evidence()
    assert len(actual_grabs(r)) == 1
    # The fixture inserts the rival only in the inverse readback. Actions then
    # observes once more when finishing; assert the original check at the
    # actual learning boundary, without substituting that later camera frame.
    restored_index = result['evidence']['authorization_recovery']['after_observation']
    restored_checks = [check for check in checks if check['observation_index'] == restored_index]
    assert restored_checks
    assert all(check['red_count'] == 2 and check['result']['authorized'] is False
               and check['result']['reason'] == 'grab_identity_competition'
               for check in restored_checks)
