"""Bounded short node departures; synthetic sensors, real Actions/RoadMemory.

The r106 fixture is original public evidence, not a successful retry. Future
readings use the existing RegionRuntime renderer and actual command contract.
No model, simulator connection, task truth, or identity restoration is involved.
"""
import copy
import json
from pathlib import Path

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from autonomous_brain.navigation import RoadMemory, distance, evidence_version, position
from test_brain_executable_recovery import RegionRuntime
from test_brain_navigation_reposition import sensor


PUBLIC = json.loads((Path(__file__).parent / 'fixtures' /
    'run_20261015T112325_r106_short_node_departure_public.json').read_text())


def short_node_runtime(*, aligned=True):
    r = RegionRuntime()
    # The original public synthetic leg starts outside the existing node region
    # and terminates inside it. Its 20 cm road request observes an 8.2 cm leg.
    r.snapshot = sensor(1, (0, .20), heading=-180)
    r.roads = RoadMemory()
    r.calls.clear(); r.motions.clear(); r.observations.clear()
    r.actions = Actions(r)
    r.refresh(); r.register()
    r.partial = .41
    r.actions.move('follow_road', {'distanceCm': 20, 'speed': 50})
    r.partial = 1.
    assert r.snapshot['road']['atNode'] is True
    if aligned:
        r.actions.move('turn', {'angleDeg': -180, 'speed': 50})
    # Historical-view navigation uses the exact recorded route, not the
    # separate operation-standoff candidate filter (which excludes near poses).
    route = r.roads.route_to(r.snapshot['odometry'], (0, .20))
    assert route and route[-1] == (0, .20)
    segments = [copy.deepcopy(r.roads._approach_edges[a][b]) for a, b in zip(route, route[1:])]
    candidate = {'position_m': list(route[-1]), 'path': [list(p) for p in route],
        'segments': segments, 'source': 'observed_on_road_motion_endpoints',
        'route_version': evidence_version([[s['segment_version'], s['direction']] for s in segments])}
    assert len(candidate['segments']) == 1
    segment = candidate['segments'][0]
    assert segment['direction'] == 'reverse_attempt'
    assert segment['travelled_cm'] == pytest.approx(8.2)
    assert segment['departure']['at_node'] is True
    assert segment['arrival']['at_node'] is False
    r.calls.clear(); r.motions.clear()
    return r, candidate


def test_original_r106_take_exit_travel_exceeded_its_short_recorded_leg():
    rows = {row['observation_index']: row for row in PUBLIC['observations']}
    source, turn, exit_motion = PUBLIC['motions']
    assert (source['before_observation'], source['after_observation']) == (516, 517)
    arc = rows[517]['odometry']['distanceCm'] - rows[516]['odometry']['distanceCm']
    chord = distance(position(rows[516]['odometry']), position(rows[517]['odometry'])) * 100
    assert arc == pytest.approx(8.2) and chord == pytest.approx(8.300602387778873)
    assert abs(arc-chord) <= .2
    assert rows[516]['road']['atNode'] is False and rows[517]['road']['atNode'] is True
    assert position(rows[568]['odometry']) == position(rows[517]['odometry'])
    assert turn['method'] == 'turn' and turn['actuator_result']['completed'] is True
    assert exit_motion['method'] == 'take_exit'
    assert rows[570]['odometry']['distanceCm'] - rows[569]['odometry']['distanceCm'] == pytest.approx(40.6)
    assert exit_motion['actuator_result']['accepted'] is True
    # An accepted primitive is not evidence that this short arc was retraced.
    assert rows[570]['odometry']['distanceCm'] - rows[569]['odometry']['distanceCm'] > arc + .2


@pytest.mark.parametrize('holding', [False, True])
def test_short_recorded_node_departure_uses_exact_forward_and_fresh_endpoint(holding):
    r, candidate = short_node_runtime()
    r.snapshot['holding']['holding'] = holding
    before = r.snapshot['observation_index']
    reached, reason, steps = r.actions._follow_approach_path(candidate, [5])
    assert reached, reason
    assert r.calls == [('forward', {'distanceCm': pytest.approx(8.2), 'speed': 30})]
    assert r.snapshot['observation_index'] > before
    assert distance(position(r.snapshot['odometry']), candidate['position_m']) <= .002
    assert abs(r.snapshot['odometry']['headingDeg']) <= .2
    assert r.snapshot['road']['atNode'] is False
    assert r.snapshot['holding']['holding'] is holding
    assert steps[-1]['completed_segment_ids'] == [candidate['segments'][0]['segment_id']]
    assert steps[-1]['historical_arc_retraced'] is True
    assert r.motions[-1]['motion_verification']['motion_verified'] is True


@pytest.mark.parametrize('fault', ['curved-arc', 'changed-tangent', 'duplicate-exit',
    'changed-node', 'start-jump', 'unknown-source'])
def test_short_node_departure_rejects_unproved_source_without_take_exit_fallback(fault):
    r, candidate = short_node_runtime()
    segment = candidate['segments'][0]
    if fault == 'curved-arc': segment['travelled_cm'] += 1
    elif fault == 'changed-tangent': segment['arrival']['travel_heading_deg'] += 3
    elif fault == 'duplicate-exit':
        r.snapshot['road']['exits'].append(copy.deepcopy(r.snapshot['road']['exits'][0]))
    elif fault == 'changed-node':
        r.snapshot['road']['exits'].append({'angleDeg': 90})
    elif fault == 'start-jump': r.snapshot['odometry']['rightCm'] += 1
    else: segment['motion']['outcome_unknown'] = True
    reached, _, steps = r.actions._follow_approach_path(candidate, [5])
    assert not reached and r.calls == []
    assert all(not step.get('completed_segment_ids') for step in steps)


@pytest.mark.parametrize('fault', ['exits', 'node-flag', 'pose', 'front', 'side', 'holding', 'holding-unknown'])
def test_short_node_departure_rechecks_fresh_view_after_alignment_before_forward(fault):
    r, candidate = short_node_runtime(aligned=False)
    original = r.observe

    def changed(*, motion=None):
        original(motion=motion)
        if (motion or {}).get('method') == 'turn':
            if fault == 'exits': r.snapshot['road']['exits'].append({'angleDeg': 90})
            elif fault == 'node-flag': r.snapshot['road']['atNode'] = False
            elif fault == 'pose': r.snapshot['odometry']['rightCm'] += 1
            elif fault == 'front': r.snapshot['road']['frontClearanceCm'] = 8.2
            elif fault == 'side':
                r.snapshot['road'].update(leftClearanceCm=.1, rightClearanceCm=.1)
            else: r.snapshot['holding']['holding'] = True if fault == 'holding' else None

    r.observe = changed
    try:
        reached, _, steps = r.actions._follow_approach_path(candidate, [5])
    except ObservedMotionFailure:
        reached, steps = False, []
    assert not reached
    assert r.calls == [('turn', {'angleDeg': -180, 'speed': 50})]
    assert all(not step.get('completed_segment_ids') for step in steps)


def test_short_node_departure_unknown_forward_is_sent_once_and_not_completed():
    r, candidate = short_node_runtime()
    original = r.call

    def unknown(method, params):
        original(method, params)
        raise ConnectionError('synthetic_short_departure_ack_unknown')

    r.bridge.call = unknown
    with pytest.raises(ConnectionError, match='synthetic_short_departure_ack_unknown'):
        r.actions._follow_approach_path(candidate, [5])
    assert len(r.calls) == 1 and r.calls[0][0] == 'forward'
    assert len(r.motions) == 1 and r.motions[0]['outcome_unknown'] is True


@pytest.mark.parametrize('fault', ['partial', 'heading', 'holding'])
def test_short_node_departure_failed_forward_does_not_complete_old_segment(fault):
    r, candidate = short_node_runtime()
    if fault == 'partial': r.partial = .5
    elif fault == 'heading': r.heading_drift = .3
    else:
        original = r.call
        def changed(method, params):
            result = original(method, params)
            r.snapshot['holding']['holding'] = True
            return result
        r.bridge.call = changed
    try:
        reached, _, steps = r.actions._follow_approach_path(candidate, [5])
    except ObservedMotionFailure:
        reached, steps = False, []
    assert not reached and len(r.calls) == 1 and r.calls[0][0] == 'forward'
    assert all(not step.get('completed_segment_ids') for step in steps)


def test_short_node_departure_exact_endpoint_with_changed_node_flag_is_not_arrival():
    r, candidate = short_node_runtime()
    original = r.refresh

    def changed_endpoint():
        original()
        if distance(position(r.snapshot['odometry']), candidate['position_m']) <= .002:
            r.snapshot['road'].update(atNode=True, exits=[{'angleDeg': 0}, {'angleDeg': -180}])

    r.refresh = changed_endpoint
    reached, reason, steps = r.actions._follow_approach_path(candidate, [5])
    assert not reached and reason == 'reposition_arrival_node_context_changed'
    assert r.calls == [('forward', {'distanceCm': pytest.approx(8.2), 'speed': 30})]
    assert distance(position(r.snapshot['odometry']), candidate['position_m']) <= .002
    assert all(not step.get('completed_segment_ids') for step in steps)


def test_short_node_departure_zero_budget_cannot_align_or_translate():
    r, candidate = short_node_runtime(aligned=False)
    reached, reason, steps = r.actions._follow_approach_path(candidate, [0])
    assert not reached and reason == 'reposition_motion_budget_exhausted'
    assert r.calls == [] and steps == []
