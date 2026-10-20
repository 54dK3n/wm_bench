"""Decimal minimum-motion evidence in the registered sampling window.

Synthetic public sensor and receipt inputs only; no motion is dispatched.
"""
import copy
from types import SimpleNamespace

import pytest

from autonomous_brain import confirmation_sampling as sampling
from autonomous_brain.road_evidence import RoadEvidence
from test_brain_navigation_reposition import sensor


def micro_window():
    before = sensor(1, (0, 1.), travelled=512.2)
    after = sensor(2, (0, 100.1 / 100), travelled=512.3)
    for frame in (before, after):
        frame['road']['tick'] = frame['odometry']['tick']
    motion = {'method': 'forward', 'params': {'distanceCm': .1, 'speed': 30},
              'before_observation': 1, 'after_observation': 2,
              'bridge_request_id': 'synthetic-known-minimum-step',
              'actuator_result': {'accepted': True, 'completed': True}}
    return {'observations': [before, after], 'motions': [motion],
            'invalid_observation_indices': []}


def observed_window(data):
    actions = SimpleNamespace(r=SimpleNamespace(roads=SimpleNamespace(
        observation_records=lambda first, last: copy.deepcopy(data))))
    return sampling._observed_motion_window(actions, 1, data['observations'][-1])


def test_exact_public_minimum_roundoff_gets_strict_basic_window_evidence():
    data = micro_window()
    before, after = data['observations']
    assert after['odometry']['distanceCm'] - before['odometry']['distanceCm'] == .09999999999990905
    # The generic topology validator remains unchanged. Sampling can recognize
    # this representation-only case using the stricter basic-motion proof.
    assert not RoadEvidence.step_valid(before, after, data['motions'][0])
    result = observed_window(data)
    assert result is not None
    assert result[0] == data['observations']
    assert result[1][1, 2] == data['motions'][0]


@pytest.mark.parametrize('fault', [
    'unknown', 'unsent', 'missing_request_id', 'missing_receipt',
    'ack_incomplete', 'ack_rejected', 'ack_error', 'stopped',
    'zero_pose', 'reverse_pose', 'sideways_pose', 'heading_drift',
    'holding_changed', 'holding_unknown', 'offroad', 'old_frame',
    'same_tick', 'sensor_tick', 'road_tick', 'nonconsecutive',
    'missing_motion', 'duplicate_motion', 'invalid_observation',
])
def test_roundoff_exception_never_licenses_unknown_or_unverified_motion(fault):
    data = micro_window()
    before, after = data['observations']
    motion = data['motions'][0]
    if fault == 'unknown': motion['outcome_unknown'] = True
    elif fault == 'unsent': motion['motion_not_sent'] = True
    elif fault == 'missing_request_id': del motion['bridge_request_id']
    elif fault == 'missing_receipt': del motion['actuator_result']
    elif fault == 'ack_incomplete': motion['actuator_result']['completed'] = False
    elif fault == 'ack_rejected': motion['actuator_result']['accepted'] = False
    elif fault == 'ack_error': motion['actuator_result']['error'] = 'synthetic unknown receipt'
    elif fault == 'stopped': motion['actuator_result']['stoppedBy'] = 'front_clearance'
    elif fault == 'zero_pose': after['odometry']['forwardCm'] = 100.
    elif fault == 'reverse_pose': after['odometry']['forwardCm'] = 99.9
    elif fault == 'sideways_pose': after['odometry'].update(forwardCm=100., rightCm=.1)
    elif fault == 'heading_drift': after['odometry']['headingDeg'] = 1.
    elif fault == 'holding_changed': after['holding']['holding'] = True
    elif fault == 'holding_unknown': after['holding']['holding'] = None
    elif fault == 'offroad': after['road']['onRoad'] = False
    elif fault == 'old_frame': after['observation']['frameId'] = before['observation']['frameId']
    elif fault == 'same_tick':
        after['odometry']['tick'] = after['observation']['tick'] = after['road']['tick'] = before['odometry']['tick']
    elif fault == 'sensor_tick': after['observation']['tick'] -= 1
    elif fault == 'road_tick': after['road']['tick'] -= 1
    elif fault == 'nonconsecutive': after['observation_index'] = 3
    elif fault == 'missing_motion': data['motions'].clear()
    elif fault == 'duplicate_motion': data['motions'].append(copy.deepcopy(motion))
    elif fault == 'invalid_observation': data['invalid_observation_indices'] = [2]
    else: raise AssertionError(fault)
    assert observed_window(data) is None


@pytest.mark.parametrize('amount', [0., .001, .05, .099, .099999])
def test_actual_subminimum_public_motion_is_not_numeric_roundoff(amount):
    data = micro_window()
    before, after = data['observations']
    after['odometry'].update(forwardCm=100. + amount, distanceCm=512.2 + amount)
    assert observed_window(data) is None
