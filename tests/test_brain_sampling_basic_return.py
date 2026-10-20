"""Public second-run suffix; dispatch and mutated feedback are synthetic.

This exercises the real RoadMemory/Actions chain, not a competition run. The
original rounded public endpoint is distinct from the projected endpoint.
"""
import copy
import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from autonomous_brain import confirmation_sampling as sampling
from autonomous_brain.navigation import RoadMemory, position, wrap
from test_brain_route_contract import normalize


FIXTURE = json.loads((Path(__file__).parent /
    'fixtures/run_20261018T114147Z_straight_return_public.json').read_text())


def runtime_fixture():
    data = copy.deepcopy(FIXTURE)
    roads = RoadMemory()
    by_after = {m['after_observation']: m for m in data['window']['motions']}
    for frame in data['window']['observations']:
        roads.update(frame['odometry'], frame['road'], frame['observation_index'])
        roads.observe_traversal(frame, by_after.get(frame['observation_index']))
    roads.blocked = copy.deepcopy(data['retained_passage_constraints'])
    current = copy.deepcopy(data['window']['observations'][-1])
    calls, motions, observations = [], [], []
    controls = {'feedback': 'projected', 'unknown': False}
    runtime = SimpleNamespace(snapshot=current, round=35, roads=roads,
        held_object_id=None, pending_grasp=None,
        perception=SimpleNamespace(objects=lambda: []),
        bridge=SimpleNamespace(seconds=100., max_seconds=1200, sequence=1000),
        motion_log=SimpleNamespace(write=lambda row: motions.append(copy.deepcopy(row))))

    def call(method, params):
        params = normalize(method, params)
        assert method == 'backward'
        calls.append((method, copy.deepcopy(params)))
        runtime.bridge.sequence += 1
        amount = params['distanceCm']
        theta = math.radians(current['odometry']['headingDeg'])
        current['odometry']['rightCm'] += amount * math.sin(theta)
        current['odometry']['forwardCm'] -= amount * math.cos(theta)
        current['odometry']['distanceCm'] += amount
        if controls['feedback'] == 'exact':
            old = data['window']['observations'][0]['odometry']
            current['odometry'].update(rightCm=old['rightCm'], forwardCm=old['forwardCm'])
        elif controls['feedback'] == 'zero':
            old = data['window']['observations'][-1]['odometry']
            current['odometry'].update(rightCm=old['rightCm'], forwardCm=old['forwardCm'])
        if controls['unknown']:
            raise TimeoutError('synthetic dispatched retreat receipt unknown')
        return {'completed': True}

    def observe(*, motion=None):
        observations.append(copy.deepcopy(motion))
        current['observation_index'] += 1
        current['odometry']['tick'] += 1
        current['road']['tick'] = current['odometry']['tick']
        current['observation'].update(frameId=current['observation_index'],
                                      tick=current['odometry']['tick'])
        runtime.bridge.seconds += .02
        roads.update(current['odometry'], current['road'], current['observation_index'])
        roads.observe_traversal(current, dict(motion, after_observation=current['observation_index'])
                               if motion is not None else None)
        return current

    runtime.bridge.call, runtime.observe = call, observe
    return runtime, Actions(runtime), calls, motions, observations, controls


def known_unsent_rejection():
    return ObservedMotionFailure('directed_passage_still_blocked', {'motion_not_sent': True})


def test_public_suffix_uses_all_actual_microsegments_and_old_endpoint():
    runtime, actions, calls, motions, _, _ = runtime_fixture()
    old_edges = copy.deepcopy(runtime.roads._approach_edges)
    old_stops = copy.deepcopy(runtime.roads.blocked)
    assert runtime.roads.observed_road_return_support(runtime.snapshot) is None
    proof = sampling.observed_basic_return_support(actions)
    assert proof is not None
    assert proof['target_observation'] == 123
    assert proof['current_observation'] == 171
    assert proof['params'] == {'distanceCm': pytest.approx(4.700870937487642), 'speed': 30}
    assert proof['target_position_m'] == list(position(FIXTURE['window']['observations'][0]['odometry']))
    assert proof['predicted_endpoint_gap_cm'] == pytest.approx(.0425726330403807)
    assert proof['graph_connection_predicted'] is False
    assert proof['blocked_passages_resolved'] is False
    support = proof['straight_suffix']
    assert len(support['segments']) == 22
    assert len(support['observation_refs']) == 49
    assert len(support['motion_refs']) == 30
    assert any(s['travelled_cm'] == .09999999999990905 for s in support['segments'])
    assert calls == motions == []
    assert runtime.roads._approach_edges == old_edges
    assert runtime.roads.blocked == old_stops
    # Microsegments may support a larger witnessed suffix, but a new return
    # request still uses the existing 0.2 cm minimum.
    assert sampling._recorded_translation_support(actions, .1, 'backward') is None


@pytest.mark.parametrize('fault', ['missing_frame', 'missing_motion', 'unknown_micro',
    'missing_micro_receipt', 'missing_micro_request_id', 'illegal_micro_command',
    'duplicate_motion', 'invalid_frame', 'turn_travel', 'turn_pose', 'turn_unknown',
    'interior_holding', 'interior_onroad', 'interior_node', 'old_frame', 'tick_gap',
    'extra_motion', 'current_unknown_holding', 'current_holding', 'pending_grasp',
    'held_id', 'current_heading', 'current_clearance', 'current_offroad',
    'different_current_frame', 'curved_segment', 'nonbasic_segment', 'subminimum_segment'])
def test_no_return_proof_from_incomplete_or_changed_suffix(fault):
    runtime, actions, calls, motions, _, _ = runtime_fixture()
    assert sampling.observed_basic_return_support(actions) is not None
    getter = runtime.roads.observation_records
    def records(first, last):
        window = getter(first, last)
        frames = {f['observation_index']: f for f in window['observations']}
        micro = next((m for m in window['motions'] if m['before_observation'] == 154), None)
        turn = next(m for m in window['motions'] if m['before_observation'] == 166)
        if fault == 'missing_frame':
            window['observations'] = [f for f in window['observations'] if f['observation_index'] != 170]
        elif fault == 'missing_motion': window['motions'].remove(turn)
        elif fault == 'unknown_micro' and micro: micro['outcome_unknown'] = True
        elif fault == 'missing_micro_receipt' and micro: del micro['actuator_result']
        elif fault == 'missing_micro_request_id' and micro: del micro['bridge_request_id']
        elif fault == 'illegal_micro_command' and micro: micro['params']['distanceCm'] = .0999999999999
        elif fault == 'duplicate_motion': window['motions'].append(copy.deepcopy(turn))
        elif fault == 'invalid_frame': window['invalid_observation_indices'] = [170]
        elif fault == 'turn_travel': frames[167]['odometry']['distanceCm'] += .1
        elif fault == 'turn_pose': frames[167]['odometry']['rightCm'] += .1
        elif fault == 'turn_unknown': turn['outcome_unknown'] = True
        elif fault == 'interior_holding': frames[170]['holding']['holding'] = True
        elif fault == 'interior_onroad': frames[170]['road']['onRoad'] = False
        elif fault == 'interior_node': frames[170]['road']['atNode'] = True
        elif fault == 'old_frame': frames[170]['observation']['frameId'] = frames[169]['observation']['frameId']
        elif fault == 'tick_gap': frames[170]['road']['tick'] += 1
        elif fault == 'extra_motion': window['motions'].append(dict(turn, before_observation=172, after_observation=173))
        return window
    runtime.roads.observation_records = records
    if fault == 'current_unknown_holding': runtime.snapshot['holding']['holding'] = None
    elif fault == 'current_holding': runtime.snapshot['holding']['holding'] = True
    elif fault == 'pending_grasp': runtime.pending_grasp = {'object_id': 'synthetic-unresolved'}
    elif fault == 'held_id': runtime.held_object_id = 'synthetic-unresolved'
    elif fault == 'current_heading': runtime.snapshot['odometry']['headingDeg'] += .3
    elif fault == 'current_clearance': runtime.snapshot['road']['leftClearanceCm'] = .1
    elif fault == 'current_offroad': runtime.snapshot['road']['onRoad'] = False
    elif fault == 'different_current_frame': runtime.snapshot['observation']['frameId'] = 'unregistered-current'
    elif fault in {'curved_segment', 'nonbasic_segment', 'subminimum_segment'}:
        segments = runtime.roads.road_segment_records
        def changed_segments():
            rows = segments()
            last = rows[-1]
            if fault == 'curved_segment': last['travelled_cm'] += 1
            elif fault == 'nonbasic_segment': last['method'] = 'follow_road'
            else: last['departure']['position_m'] = list(last['arrival']['position_m'])
            return rows
        runtime.roads.road_segment_records = changed_segments
    assert sampling.observed_basic_return_support(actions) is None
    assert calls == motions == []


@pytest.mark.parametrize('feedback,reason', [
    ('exact', 'road_blocked_returned_to_observed_endpoint'),
    ('projected', 'recorded_basic_return_endpoint_not_reobserved')])
def test_return_dispatches_once_and_only_actual_exact_endpoint_can_reconnect(feedback, reason):
    runtime, actions, calls, motions, observations, controls = runtime_fixture()
    controls['feedback'] = feedback
    target = tuple(position(FIXTURE['window']['observations'][0]['odometry']))
    start = position(runtime.snapshot['odometry'])
    stops = copy.deepcopy(runtime.roads.blocked)
    previous_segments = set(runtime.roads._road_segments)
    outcome = actions.return_after_known_road_rejection(known_unsent_rejection())
    assert outcome['reason'] == reason
    assert outcome['success'] is False
    assert calls == [('backward', {'distanceCm': pytest.approx(4.700870937487642), 'speed': 30})]
    assert len(motions) == len(observations) == 1
    assert motions[0]['bridge_request_id'] == 'brain-001001'
    proof = outcome['evidence']['recorded_basic_return']
    assert proof['motion_verified'] is True
    assert proof['exact_observed_endpoint'] is (feedback == 'exact')
    assert set(runtime.roads._road_segments) - previous_segments == {'road-segment-171-172'}
    actual = position(runtime.snapshot['odometry'])
    assert runtime.roads._road_segments['road-segment-171-172']['arrival']['position_m'] == list(actual)
    assert (target in runtime.roads._approach_edges[start]) is (feedback == 'exact')
    assert runtime.roads.blocked == stops


def test_unknown_return_receipt_is_single_send_and_one_read_only_recovery():
    runtime, actions, calls, motions, observations, controls = runtime_fixture()
    controls['unknown'] = True
    segments = copy.deepcopy(runtime.roads._road_segments)
    with pytest.raises(TimeoutError) as caught:
        actions.return_after_known_road_rejection(known_unsent_rejection())
    assert len(calls) == 1 and calls[0][0] == 'backward'
    assert observations == [None]
    assert len(motions) == 1 and motions[0]['outcome_unknown'] is True
    assert 'actuator_result' not in motions[0]
    assert caught.value.action_evidence['outcome_unknown'] is True
    assert caught.value.action_evidence['uncertain_motion']['method'] == 'backward'
    assert caught.value.action_evidence['pre_motion_rejection']['evidence']['motion_not_sent'] is True
    assert runtime.roads._road_segments == segments


def test_execute_keeps_new_unknown_return_distinct_from_original_unsent_forward():
    runtime, actions, calls, motions, observations, controls = runtime_fixture()
    runtime.snapshot['perception'] = {'detections': []}
    controls['unknown'] = True
    segments = copy.deepcopy(runtime.roads._road_segments)
    with pytest.raises(TimeoutError) as caught:
        actions.execute({'action': 'explore', 'params': {}})
    assert [method for method, _ in calls] == ['backward']
    assert observations == [None]
    assert len(motions) == 1 and motions[0]['outcome_unknown'] is True
    evidence = caught.value.action_evidence
    assert evidence['outcome_unknown'] is True
    assert evidence['recorded_basic_return']['method'] == 'backward'
    assert evidence['pre_motion_rejection']['reason'] == 'directed_passage_still_blocked'
    assert evidence['pre_motion_rejection']['evidence']['motion_not_sent'] is True
    assert runtime.roads._road_segments == segments


def test_zero_displacement_return_cannot_report_endpoint_or_install_edge():
    runtime, actions, calls, motions, _, controls = runtime_fixture()
    controls['feedback'] = 'zero'
    segments = copy.deepcopy(runtime.roads._road_segments)
    with pytest.raises(ObservedMotionFailure) as caught:
        actions.return_after_known_road_rejection(known_unsent_rejection())
    assert caught.value.reason == 'basic_motion_not_verified'
    assert len(calls) == len(motions) == 1
    assert runtime.roads._road_segments == segments


@pytest.mark.parametrize('fault', ['heading', 'onroad', 'node', 'clearance', 'holding',
    'unknown_holding', 'pending', 'held_id', 'pose', 'observation', 'road_tick'])
def test_current_state_is_rechecked_after_return_proof_before_any_send(fault):
    runtime, actions, calls, motions, _, _ = runtime_fixture()
    proof = sampling.observed_basic_return_support(actions)
    assert proof is not None
    if fault == 'heading': runtime.snapshot['odometry']['headingDeg'] += .3
    elif fault == 'onroad': runtime.snapshot['road']['onRoad'] = False
    elif fault == 'node': runtime.snapshot['road']['atNode'] = True
    elif fault == 'clearance': runtime.snapshot['road']['leftClearanceCm'] = .1
    elif fault == 'holding': runtime.snapshot['holding']['holding'] = True
    elif fault == 'unknown_holding': runtime.snapshot['holding']['holding'] = None
    elif fault == 'pending': runtime.pending_grasp = {'object_id': 'synthetic-unresolved'}
    elif fault == 'held_id': runtime.held_object_id = 'synthetic-unresolved'
    elif fault == 'pose': runtime.snapshot['odometry']['rightCm'] += .1
    elif fault == 'observation': runtime.snapshot['observation_index'] += 1
    elif fault == 'road_tick': runtime.snapshot['road']['tick'] += 1
    outcome = actions.return_along_observed_basic_suffix({}, proof)
    assert outcome['reason'] == 'recorded_basic_return_current_state_changed'
    assert calls == motions == []


@pytest.mark.parametrize('fault', ['unknown_history', 'missing_history', 'changed_request',
    'changed_target', 'changed_method', 'changed_limit'])
def test_proof_and_registered_history_are_rechecked_before_any_send(fault):
    runtime, actions, calls, motions, _, _ = runtime_fixture()
    proof = sampling.observed_basic_return_support(actions)
    assert proof is not None
    if fault in {'unknown_history', 'missing_history'}:
        getter = runtime.roads.observation_records
        def changed(first, last):
            window = getter(first, last)
            if fault == 'missing_history':
                window['observations'] = [f for f in window['observations'] if f['observation_index'] != 170]
            else:
                window['motions'][-1]['outcome_unknown'] = True
            return window
        runtime.roads.observation_records = changed
    elif fault == 'changed_request': proof['params']['distanceCm'] += .1
    elif fault == 'changed_target': proof['target_position_m'][0] += .001
    elif fault == 'changed_method': proof['method'] = 'forward'
    elif fault == 'changed_limit': proof['max_travel_cm'] += .1
    outcome = actions.return_along_observed_basic_suffix({}, proof)
    assert outcome['reason'] == 'recorded_basic_return_current_state_changed'
    assert calls == motions == []


def test_old_endpoint_backward_constraint_is_respected_even_when_current_pose_is_clear():
    runtime, actions, calls, motions, _, _ = runtime_fixture()
    proof = sampling.observed_basic_return_support(actions)
    endpoint = tuple(proof['target_position_m'])
    heading = wrap(runtime.snapshot['odometry']['headingDeg'] + 180)
    theta = math.radians(runtime.snapshot['odometry']['headingDeg'])
    # A synthetic retained failure is within the existing 15 cm endpoint
    # neighborhood but outside the current pose's neighborhood.
    anchor = [endpoint[0] + .149 * math.sin(theta), endpoint[1] - .149 * math.cos(theta)]
    reverse_stop = copy.deepcopy(runtime.roads.blocked[0])
    reverse_stop.update(passage_id='synthetic-old-endpoint-backward-stop', direction_heading_deg=heading)
    for key in ('entry', 'stop'):
        reverse_stop[key].update(position_m=anchor, body_heading_deg=heading)
    runtime.roads.blocked.append(reverse_stop)
    assert runtime.roads.passage_blocked(runtime.snapshot, heading) is None
    assert runtime.roads._blocked_passage_at(endpoint, heading, False) is not None
    alternative = sampling.observed_basic_return_support(actions)
    assert alternative is None or alternative['target_position_m'] != list(endpoint)
    outcome = actions.return_along_observed_basic_suffix({}, proof)
    assert outcome['reason'] == 'recorded_basic_return_current_state_changed'
    assert calls == motions == []
