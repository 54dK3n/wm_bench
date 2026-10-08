"""A public r7 planner regression and bounded synthetic sensor feedback.

The old pixels disprove the proposed self-blocking attribution for this window;
these tests neither merge those identities nor claim a new platform result.
"""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import road_translation_limit
from autonomous_brain.confirmation_sampling import _plan
from autonomous_brain.navigation import RoadMemory
from autonomous_brain.perception import Perception, discovery_pixel_match
from test_brain_confirmation_sampling import sampling_runtime, sample
from test_brain_route_contract import normalize

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/run_20261007T234008_identity_window.json').read_text())


def public_window():
    p = Perception(FIXTURE['camera'])
    for x in FIXTURE['r7_prefix']:
        p.update(x['observation'], x['odometry'], simulation_time_s=x['simulation_seconds'],
                 round_index=x['round'], observation_index=x['observation_index'])
    snapshot = copy.deepcopy(FIXTURE['r7_prefix'][-1])
    snapshot['perception'] = p.last_evidence
    actions = SimpleNamespace(s=snapshot, r=SimpleNamespace(roads=RoadMemory()))
    return p, actions, p.discovery_target('red-discovery-2')


def test_real_r7_has_a_legal_small_translation_without_an_independent_hit_claim():
    p, a, target = public_window()
    rejections = {}
    assert _plan(a, target, 120, rejections, allow_short_probe=False) is None
    assert rejections['insufficient_local_road_clearance'] == 5
    plan = _plan(a, target, 120, {})
    assert plan['method'] == 'forward' and plan['params'] == {'distanceCm': 4., 'speed': 30}
    assert plan['short_sampling_probe'] and not plan['confirmation_hit_expected']
    assert plan['independent_pose_predicted'] is False
    assert road_translation_limit(a.s['road'], 'forward', 4)[0] == 4
    assert normalize('forward', plan['params']) == {'distanceCm': 4, 'speed': 30}
    assert p.get_object('target_010')['hit_count'] == 1
    assert p.check_grasp_identity('target_010', a.s)['authorized'] is False


def test_real_retired_sources_have_no_current_original_pixel_support():
    rows = FIXTURE['r43_sources']
    current = [r for r in rows if r['initial_object_id'] == 'target_040']
    old = [r for r in rows if r['initial_object_id'] != 'target_040']
    assert len(old) == 18 and len(current) == 9
    assert not any(discovery_pixel_match(FIXTURE['camera'], s, v['position_m'])
                   for s in old for v in current)
    objects = {o['id']: o for o in FIXTURE['r43_objects']}
    assert all(objects[i]['state'] == 'LOST' and not objects[i]['ever_confirmed']
               for i in ('target_010', 'target_013', 'target_032'))
    assert objects['target_040']['state'] == 'CONFIRMED'


@pytest.mark.parametrize('condition', ['offroad', 'holding', 'front', 'side', 'exit', 'confirmed', 'competition', 'budget'])
def test_short_probe_keeps_safety_and_identity_refusals(condition):
    _, a, t = public_window()
    if condition == 'offroad': a.s['road']['onRoad'] = False
    if condition == 'holding': a.s['holding']['holding'] = True
    if condition == 'front': a.s['road']['frontClearanceCm'] = None
    if condition == 'side': a.s['road']['rightClearanceCm'] = .1
    if condition == 'exit': a.s['road']['exits'].append({'angleDeg': .2})
    if condition == 'confirmed': t['associated_object'].update(state='CONFIRMED', ever_confirmed=True)
    if condition == 'competition': t['identity_resolution_required'] = True
    remaining = 3 if condition == 'budget' else 120
    assert _plan(a, t, remaining, {}) is None


def narrow_feedback(*, stays_narrow=False, mode=None):
    r = sampling_runtime(target=(-20, 85), at_node=True, mode=mode)
    original = r.bridge.call
    def call(method, params=None):
        value = original(method, params)
        if method == 'local_road' and (stays_narrow or not r.bridge.calls):
            value.update(headingErrorDeg=75.1, leftClearanceCm=8.6, rightClearanceCm=8.6)
        return value
    r.bridge.call = call
    r.observe()
    return r


def test_short_probe_reobserves_before_independent_sampling_and_confirmation():
    r = narrow_feedback()
    result = sample(r)
    assert result['success'], result
    steps = result['evidence']['confirmation_sampling']['steps']
    assert steps[0]['short_sampling_probe'] and steps[0]['params']['distanceCm'] == 4
    assert len(steps[0]['accepted_hit_poses_before']) == len(steps[0]['accepted_hit_poses_after']) == 1
    assert steps[1]['before_observation'] >= steps[0]['after_observation']
    assert r.perception.objects()[0]['hit_count'] >= 3
    assert all(method not in {'take_exit', 'grab', 'release'} for method, _ in r.bridge.calls)
    # Confirmation still comes from the real WM's separated fresh hit frames.
    assert r.perception.objects()[0]['state'] == 'CONFIRMED'


def test_persistently_narrow_feedback_stops_after_three_probes_without_confirmation():
    r = narrow_feedback(stays_narrow=True)
    result = sample(r)
    assert not result['success']
    assert result['reason'] == 'confirmation_no_safe_independent_viewpoint'
    assert r.bridge.calls == [('forward', {'distanceCm': 4., 'speed': 30})] * 3
    assert r.perception.objects()[0]['hit_count'] == 1
    assert result['evidence']['confirmation_sampling']['confirmed_object_id'] is None


def test_unknown_probe_is_not_resent_or_counted_as_independent_evidence():
    r = narrow_feedback(mode='unknown')
    with pytest.raises(Exception): sample(r)
    assert len(r.bridge.calls) == 1
    assert r.perception.objects()[0]['hit_count'] == 1
