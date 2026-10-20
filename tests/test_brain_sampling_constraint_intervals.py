"""Synthetic planner checks for intervals missed by discrete sampling lengths.

These use the actual planner, road limits and command normalizer. Predicted
poses do not provide confirmation hits or stand in for a platform run.
"""
import copy
import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.confirmation_sampling import _plan, _reading
from autonomous_brain.navigation import RoadMemory, distance, position
from autonomous_brain.perception import RANGE_CAL
from test_brain_route_contract import normalize


def interval_runtime(raw=53., behind_cm=4.8, *, heading=0., origin=(0., 0.)):
    theta = math.radians(heading)
    unit = (-math.sin(theta), math.cos(theta))

    def point(cm):
        return (origin[0] + unit[0] * cm / 100,
                origin[1] + unit[1] * cm / 100)

    target_xy = point(RANGE_CAL['L_cm'] + RANGE_CAL['a_cm'] + RANGE_CAL['k'] * raw)
    snapshot = {
        'observation_index': 1,
        'odometry': {'rightCm': origin[0] * 100, 'forwardCm': origin[1] * 100,
                     'headingDeg': heading, 'distanceCm': 100., 'tick': 1},
        'road': {'onRoad': True, 'atNode': True, 'headingErrorDeg': 0.,
                 'frontClearanceCm': 40.1, 'leftClearanceCm': 8.6,
                 'rightClearanceCm': 8.5, 'exits': [{'angleDeg': 0.}]},
        'holding': {'holding': False},
    }
    poses = [point(-behind_cm), point(-20.3)]
    target = {
        'current_detection': {'position_m': {'x': target_xy[0], 'z': target_xy[1]},
                              'raw_distance_cm': raw, 'raw_bearing_deg': 0.},
        'confirmation': {'min_hit_pose_gap_m': .15,
                         'accepted_hit_poses': [{'x_m': p[0], 'z_m': p[1]} for p in poses]},
        'associated_object': {'state': 'TENTATIVE', 'ever_confirmed': False},
    }
    actions = SimpleNamespace(s=snapshot, r=SimpleNamespace(roads=RoadMemory()))
    return actions, target


@pytest.mark.parametrize('raw,behind_cm', [(53., 4.8), (54., 3.), (56., 1.)])
@pytest.mark.parametrize('heading,origin', [(0., (0., 0.)), (89.8, (.116, 1.514)),
                                          (-37., (100., -20.))])
def test_narrow_interval_is_derived_from_range_and_every_accepted_pose(raw, behind_cm, heading, origin):
    actions, target = interval_runtime(raw, behind_cm, heading=heading, origin=origin)
    before = copy.deepcopy(target)
    plan = _plan(actions, target, 120, {})
    assert plan is not None and plan['method'] == 'forward'
    length = plan['params']['distanceCm']
    minimum = 15.2 - behind_cm
    maximum = (raw - 42) * RANGE_CAL['k']
    assert 10 <= minimum < length < maximum <= 20
    assert length not in (10., 15.5, 16., 17., 18., 20.)
    assert plan['distance_constraint_interval_cm'] == pytest.approx([minimum, maximum])
    assert length == pytest.approx((minimum + maximum) / 2)
    assert normalize(plan['method'], plan['params']) == plan['params']
    predicted = _reading(target['current_detection']['position_m'], plan['planned_position_m'], heading)
    assert 42 < predicted[0] < 87 and abs(predicted[1]) < 33
    assert all(distance(plan['planned_position_m'], (p['x_m'], p['z_m'])) > .152
               for p in target['confirmation']['accepted_hit_poses'])
    assert plan['road_clearance']['permitted_cm'] == length
    assert plan['independent_pose_predicted'] is True
    assert target == before  # A predicted endpoint is never a new real hit.


@pytest.mark.parametrize('case', ['offroad', 'missing_front', 'front_bound', 'side_bound',
                                 'ambiguous_exit', 'unaligned_exit', 'remaining_budget',
                                 'no_range_overlap', 'blocking_accepted_pose'])
def test_derived_interval_still_requires_all_original_translation_guards(case):
    actions, target = interval_runtime()
    road = actions.s['road']
    remaining = 120.
    if case == 'offroad':
        road['onRoad'] = False
    elif case == 'missing_front':
        road['frontClearanceCm'] = None
    elif case == 'front_bound':
        road['frontClearanceCm'] = 10.4
    elif case == 'side_bound':
        road['rightClearanceCm'] = .1
    elif case == 'ambiguous_exit':
        road['exits'].append({'angleDeg': .2})
    elif case == 'unaligned_exit':
        road['exits'] = []
    elif case == 'remaining_budget':
        remaining = 10.4
    elif case == 'no_range_overlap':
        target['current_detection']['position_m']['z'] -= .02
    elif case == 'blocking_accepted_pose':
        target['confirmation']['accepted_hit_poses'].append({'x_m': 0., 'z_m': .108})
    assert _plan(actions, target, remaining, {}) is None


def test_derived_reverse_interval_cannot_invent_an_observed_return_path():
    actions, target = interval_runtime(raw=41.)
    target['confirmation']['accepted_hit_poses'] = [{'x_m': 0., 'z_m': 0.}]
    rejected = {}
    assert _plan(actions, target, 120, rejected) is None
    assert rejected['reverse_path_not_continuously_observed'] > 0


def test_same_derived_action_at_same_viewpoint_is_not_repeated():
    actions, target = interval_runtime()
    plan = _plan(actions, target, 120, {})
    failed = [{'position_m': list(position(actions.s['odometry'])), 'heading_deg': 0.,
               'method': plan['method'], 'params': copy.deepcopy(plan['params'])}]
    rejected = {}
    assert _plan(actions, target, 120, rejected, failed) is None
    assert rejected['same_action_viewpoint_already_lost'] == 1


def test_legal_existing_discrete_candidate_keeps_its_priority():
    actions, target = interval_runtime(raw=75., behind_cm=0.)
    plan = _plan(actions, target, 120, {})
    assert plan['params']['distanceCm'] == 15.5
    assert 'distance_constraint_interval_cm' not in plan


def test_offset_target_bearing_also_bounds_the_interior_candidate():
    actions, target = interval_runtime()
    forward = target['current_detection']['position_m']['z'] * 100 - RANGE_CAL['L_cm']
    target['current_detection']['position_m']['x'] = (forward - 11.2) * math.tan(math.radians(33)) / 100
    plan = _plan(actions, target, 120, {})
    assert plan['params']['distanceCm'] == pytest.approx(10.8)
    assert plan['distance_constraint_interval_cm'] == pytest.approx([10.4, 11.2])
    assert abs(plan['predicted_raw_bearing_deg']) < 33
    assert 42 < plan['predicted_raw_distance_cm'] < 87
    target['current_detection']['position_m']['x'] = (forward - 10.3) * math.tan(math.radians(33)) / 100
    assert _plan(actions, target, 120, {}) is None


def test_reverse_constraint_roots_are_candidates_only_until_path_is_verified():
    from autonomous_brain.confirmation_sampling import _constraint_interval_lengths
    actions, target = interval_runtime(raw=31.)
    # Moving backward enters the raw window after 11.2057 cm. A pose 4.8 cm
    # behind makes distances below 20 cm non-independent; a pose in front
    # instead gives a valid geometric interval without furnishing a road.
    target['confirmation']['accepted_hit_poses'] = [{'x_m': 0., 'z_m': .048}]
    lengths = _constraint_interval_lengths(target, actions.s, 120, 'backward')
    assert any(a == pytest.approx(11.2057) for _, (a, b) in lengths)
    assert any(11.2057 < length <= 20 for length, _ in lengths)
    rejected = {}
    assert _plan(actions, target, 120, rejected) is None
    assert rejected['reverse_path_not_continuously_observed'] > 0


@pytest.mark.parametrize('index', ['863', '868', '897'])
def test_original_public_window_has_an_internal_candidate_without_new_hit_claim(index):
    fixture = json.loads((Path(__file__).parent / 'fixtures' /
                          'run_20261018T104814Z_sampling_intervals_public.json').read_text())
    selected = fixture['selected'][index]
    current, target = selected['current'], selected['target']
    actions = SimpleNamespace(s=current, r=SimpleNamespace(roads=RoadMemory()))
    before = copy.deepcopy(target)
    plan = _plan(actions, target, 120, {})
    assert plan is not None and plan['method'] in {'forward', 'follow_road'}
    low, high = plan['distance_constraint_interval_cm']
    length = plan['params']['distanceCm']
    assert 10 <= low < length < high <= 20
    assert normalize(plan['method'], plan['params']) == plan['params']
    assert plan['independent_pose_predicted'] is True
    assert 42 < plan['predicted_raw_distance_cm'] < 87
    assert abs(plan['predicted_raw_bearing_deg']) < 33
    assert target == before
