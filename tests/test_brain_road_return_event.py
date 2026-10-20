"""Public r15/r172 fixtures; local receipt replay is a component test only."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from autonomous_brain.navigation import RoadMemory
from test_brain_route_contract import normalize
from test_brain_sampling_reverse_prefix import runtime_fixture as reverse_runtime_fixture


FIXTURE = json.loads((Path(__file__).parent / 'fixtures/run_20261018T123822Z_return_marker_public.json').read_text())
PARAMS = {'distanceCm': 10., 'speed': 30}


def packet(motion):
    return {k: copy.deepcopy(v) for k, v in motion.items()
            if k not in {'motion_verification', 'passage_failure'}}


def register(roads, frame, motion=None):
    roads.update(frame['odometry'], frame['road'], frame['observation_index'])
    roads.observe_traversal(frame, packet(motion) if motion else None)


def producer_fixture():
    data = copy.deepcopy(FIXTURE['producer_source'])
    frames = {f['observation_index']: f for f in data['observations']}
    source = data['motions'][0]
    roads = RoadMemory()
    register(roads, frames[56])
    register(roads, frames[57], source)
    failure = next(copy.deepcopy(r) for r in FIXTURE['directional_failures']
                   if r['motion']['bridge_request_id'] == source['bridge_request_id'])
    roads.blocked[:] = [failure]
    calls, motions, reads = [], [], []
    controls = {'unknown': None}
    queue = list(data['motions'][1:])
    pending = {}
    runtime = SimpleNamespace(snapshot=copy.deepcopy(frames[57]), roads=roads, round=15,
        held_object_id=None, pending_grasp=None, perception=SimpleNamespace(objects=lambda: []),
        bridge=SimpleNamespace(seconds=38.3, max_seconds=1200, sequence=257),
        motion_log=SimpleNamespace(write=lambda m: motions.append(copy.deepcopy(m))))

    def call(method, params):
        params = normalize(method, params)
        expected = queue.pop(0)
        assert (method, params) == (expected['method'], expected['params'])
        calls.append((method, params))
        runtime.bridge.sequence += 1
        pending['frame'] = copy.deepcopy(frames[expected['after_observation']])
        if controls['unknown'] == method:
            raise TimeoutError('synthetic unknown return receipt')
        return copy.deepcopy(expected['actuator_result'])

    def observe(*, motion=None):
        reads.append('motion' if motion else 'readonly')
        runtime.snapshot = pending.pop('frame')
        runtime.bridge.sequence += 4
        runtime.bridge.seconds = runtime.snapshot['odometry']['tick'] * .02
        registered = dict(motion, after_observation=runtime.snapshot['observation_index']) if motion else None
        register(roads, runtime.snapshot, registered)
        return runtime.snapshot

    runtime.bridge.call, runtime.observe = call, observe
    return runtime, Actions(runtime), source, calls, motions, reads, controls


def reverse_fixture(blocked):
    roads = RoadMemory()
    frames = copy.deepcopy(FIXTURE['observations'])
    by_after = {m['after_observation']: m for m in FIXTURE['motions']}
    for frame in frames:
        register(roads, frame, by_after.get(frame['observation_index']))
    roads.blocked[:] = copy.deepcopy(blocked)
    runtime = SimpleNamespace(snapshot=copy.deepcopy(frames[-1]), roads=roads,
                              held_object_id=None, pending_grasp=None)
    return runtime, Actions(runtime)


def known_unsent(actions, failure):
    return {'reason': 'directed_passage_still_blocked', 'evidence': {
        'motion_not_sent': True, 'passage_failure': actions.passage_summary(failure)}}


@pytest.mark.parametrize('kind', ['actual_stop', 'known_unsent'])
def test_registered_return_retains_constraint_without_poisoning_later_reverse(kind):
    runtime, actions, source, calls, motions, reads, _ = producer_fixture()
    old = copy.deepcopy(runtime.roads.blocked)
    if kind == 'actual_stop':
        result = actions.return_from_blocked_road(source['actuator_result'])
    else:
        rejected = known_unsent(actions, old[0])
        result = actions.return_from_blocked_road(None, pre_motion_rejection=rejected)
    assert result['reason'] == 'road_blocked_returned_to_junction'
    assert result['success'] is False
    assert [method for method, _ in calls] == ['turn', 'follow_road', 'follow_road']
    assert len(motions) == 3 and reads == ['motion'] * 3
    assert runtime.roads.blocked == old
    event = result['evidence']['road_return_event']
    assert event['legacy_blocker_recorded'] is False
    assert event['retained_passage_constraint'] == {
        'passage_id': old[0]['passage_id'], 'before_observation': 56,
        'after_observation': 57, 'bridge_request_id': 'brain-000253'}
    assert event['observation_index'] == 57
    all_stops = copy.deepcopy(FIXTURE['directional_failures'])
    all_stops[0] = copy.deepcopy(runtime.roads.blocked[0])
    reverse, checking = reverse_fixture(all_stops)
    proof = checking.sampling_reverse_clearance_prefix(PARAMS)
    assert proof and proof['old_passages_resolved'] is False
    assert proof['reverse_path_support']['segment_ids'] == ['road-segment-768-769', 'road-segment-769-770']
    assert reverse.roads.blocked == all_stops
    assert all(row['resolved_by'] is None for row in all_stops)


def test_old_legacy_marker_remains_fail_closed_without_rewriting_history():
    rows = copy.deepcopy(FIXTURE['directional_failures'])
    rows.insert(1, copy.deepcopy(FIXTURE['legacy_marker']))
    runtime, actions = reverse_fixture(rows)
    assert actions.sampling_reverse_clearance_prefix(PARAMS) is None
    assert runtime.roads.blocked == rows


@pytest.mark.parametrize('fault', ['no_schema', 'missing_id', 'resolved', 'unknown_motion',
    'unsent_motion', 'missing_ack', 'ack_error', 'ack_rejected', 'ack_reason', 'ack_elapsed',
    'ack_distance', 'missing_request', 'wrong_request', 'wrong_heading', 'wrong_entry',
    'wrong_stop', 'stop_holding', 'wrong_current_frame', 'wrong_current_tick', 'unknown_holding',
    'wrong_current_position', 'source_missing_frame', 'source_duplicate_frame', 'source_missing_motion',
    'source_duplicate_motion', 'source_unknown_motion', 'source_old_frame', 'source_zero_tick',
    'source_zero_travel', 'source_holding_change', 'source_off_road',
    'current_missing_frame', 'current_duplicate_frame', 'current_extra_motion', 'current_invalid_frame',
    'current_window_none', 'current_window_list', 'current_frames_none', 'current_frame_none'])
def test_incomplete_or_unregistered_stop_cannot_replace_legacy_blocker(fault):
    runtime, actions, source, _, _, _, _ = producer_fixture()
    row = runtime.roads.blocked[0]
    receipt = copy.deepcopy(source['actuator_result'])
    if fault == 'no_schema': row.pop('schema')
    elif fault == 'missing_id': row.pop('passage_id')
    elif fault == 'resolved': row['resolved_by'] = {'synthetic': True}
    elif fault == 'unknown_motion': row['motion']['outcome_unknown'] = True
    elif fault == 'unsent_motion': row['motion']['motion_not_sent'] = True
    elif fault == 'missing_ack': row['motion'].pop('actuator_result')
    elif fault == 'ack_error': row['motion']['actuator_result']['error'] = 'synthetic failure'
    elif fault == 'ack_rejected': row['motion']['actuator_result']['accepted'] = False
    elif fault == 'ack_reason': row['motion']['actuator_result']['stoppedBy'] = 'collision'
    elif fault == 'ack_elapsed': row['motion']['actuator_result']['elapsedTicks'] += 1
    elif fault == 'ack_distance': row['motion']['actuator_result']['distanceCm'] += 1
    elif fault == 'missing_request': row['motion'].pop('bridge_request_id')
    elif fault == 'wrong_request': row['motion']['bridge_request_id'] = 'unregistered-command'
    elif fault == 'wrong_heading': row['direction_heading_deg'] += 1
    elif fault == 'wrong_entry': row['entry']['position_m'][0] += .001
    elif fault == 'wrong_stop': row['stop']['frame_id'] = 'unregistered-stop-frame'
    elif fault == 'stop_holding': row['stop']['holding'] = True
    elif fault == 'wrong_current_frame': runtime.snapshot['observation']['frameId'] = 'different-frame'
    elif fault == 'wrong_current_tick': runtime.snapshot['road']['tick'] += 1
    elif fault == 'unknown_holding': runtime.snapshot['holding']['holding'] = None
    elif fault == 'wrong_current_position': runtime.snapshot['odometry']['rightCm'] += .1
    elif fault.startswith('source_'):
        original = runtime.roads.observation_records
        def changed(first, last):
            window = copy.deepcopy(original(first, last))
            if (first, last) != (56, 57):
                return window
            frames, motions = window['observations'], window['motions']
            if fault == 'source_missing_frame': frames.pop(0)
            elif fault == 'source_duplicate_frame': frames.insert(0, copy.deepcopy(frames[0]))
            elif fault == 'source_missing_motion': motions.clear()
            elif fault == 'source_duplicate_motion': motions.append(copy.deepcopy(motions[0]))
            elif fault == 'source_unknown_motion': motions[0]['outcome_unknown'] = True
            elif fault == 'source_old_frame': frames[-1]['observation']['frameId'] = frames[0]['observation']['frameId']
            elif fault == 'source_zero_tick': frames[-1]['odometry']['tick'] = frames[0]['odometry']['tick']
            elif fault == 'source_zero_travel': frames[-1]['odometry']['distanceCm'] = frames[0]['odometry']['distanceCm']
            elif fault == 'source_holding_change': frames[-1]['holding']['holding'] = True
            elif fault == 'source_off_road': frames[-1]['road']['onRoad'] = False
            return window
        runtime.roads.observation_records = changed
    elif fault.startswith('current_'):
        original = runtime.roads.observation_records
        def changed_current(first, last):
            window = copy.deepcopy(original(first, last))
            if (first, last) == (57, 57):
                if fault == 'current_missing_frame': window['observations'].clear()
                elif fault == 'current_duplicate_frame': window['observations'].append(copy.deepcopy(window['observations'][0]))
                elif fault == 'current_extra_motion': window['motions'].append(packet(source))
                elif fault == 'current_invalid_frame': window['invalid_observation_indices'] = [57]
                elif fault == 'current_window_none': return None
                elif fault == 'current_window_list': return []
                elif fault == 'current_frames_none': window['observations'] = None
                elif fault == 'current_frame_none': window['observations'] = [None]
            return window
        runtime.roads.observation_records = changed_current
    assert actions._road_return_constraint(receipt, None) is None


@pytest.mark.parametrize('fault', ['wrong_reason', 'sent', 'unknown', 'wrong_passage',
    'wrong_entry', 'wrong_stop', 'stale_before_observation', 'future_stop', 'unrelated_position',
    'wrong_direction', 'different_holding'])
def test_known_unsent_must_still_reference_the_current_directional_constraint(fault):
    runtime, actions, _, _, _, _, _ = producer_fixture()
    rejected = known_unsent(actions, runtime.roads.blocked[0])
    evidence = rejected['evidence']
    if fault == 'wrong_reason': rejected['reason'] = 'basic_motion_not_verified'
    elif fault == 'sent': evidence['motion_not_sent'] = False
    elif fault == 'unknown': evidence['outcome_unknown'] = True
    elif fault == 'wrong_passage': evidence['passage_failure']['passage_id'] = 'unrelated-passage'
    elif fault == 'wrong_entry': evidence['passage_failure']['entry']['position_m'][0] += 1
    elif fault == 'wrong_stop': evidence['passage_failure']['stop']['frame_id'] = 'wrong-stop'
    elif fault == 'stale_before_observation': evidence['before_observation'] = 56
    elif fault == 'future_stop': runtime.snapshot['observation_index'] = 55
    elif fault == 'unrelated_position': runtime.snapshot['odometry']['rightCm'] += 100
    elif fault == 'wrong_direction': runtime.snapshot['odometry']['headingDeg'] += 180
    elif fault == 'different_holding': runtime.snapshot['holding']['holding'] = True
    assert actions._road_return_constraint(None, rejected) is None


@pytest.mark.parametrize('key', ['odometry', 'road', 'observation', 'holding'])
@pytest.mark.parametrize('value', [None, []])
def test_malformed_current_sensor_container_does_not_claim_registered_source(key, value):
    runtime, actions, source, _, _, _, _ = producer_fixture()
    runtime.snapshot[key] = copy.deepcopy(value)
    assert actions._road_return_constraint(source['actuator_result'], None) is None


@pytest.mark.parametrize('fault', ['zero_speed', 'low_speed', 'high_speed', 'boolean_speed',
                                  'string_speed', 'extra_parameter', 'too_large_distance',
                                  'nonfinite_distance', 'missing_distance'])
def test_registered_illegal_source_command_remains_incomplete_even_if_packets_match(fault):
    runtime, actions, source, _, _, _, _ = producer_fixture()
    params = runtime.roads.blocked[0]['motion']['params']
    if fault == 'extra_parameter': params['unregistered_option'] = True
    elif fault == 'too_large_distance': params['distanceCm'] = 501
    elif fault == 'nonfinite_distance': params['distanceCm'] = float('nan')
    elif fault == 'missing_distance': params.pop('distanceCm')
    else:
        params['speed'] = {'zero_speed': 0, 'low_speed': 9, 'high_speed': 101,
                           'boolean_speed': True, 'string_speed': '30'}[fault]
    original = runtime.roads.observation_records
    def consistent_but_illegal(first, last):
        window = copy.deepcopy(original(first, last))
        if (first, last) == (56, 57):
            window['motions'][0]['params'] = copy.deepcopy(params)
        return window
    runtime.roads.observation_records = consistent_but_illegal
    assert actions._road_return_constraint(source['actuator_result'], None) is None


@pytest.mark.parametrize('fault', ['missing_registration', 'unmatched_ack', 'unknown_source'])
def test_unmatched_return_still_appends_legacy_and_blocks_later_reverse(fault):
    runtime, actions, source, calls, _, _, _ = producer_fixture()
    receipt = copy.deepcopy(source['actuator_result'])
    if fault == 'missing_registration':
        original = runtime.roads.observation_records
        def no_motion(first, last):
            result = original(first, last)
            result['motions'] = []
            return result
        runtime.roads.observation_records = no_motion
    elif fault == 'unmatched_ack': receipt['distanceCm'] += 1
    else: runtime.roads.blocked[0]['motion']['outcome_unknown'] = True
    result = actions.return_from_blocked_road(receipt)
    assert len(calls) == 3  # Existing return behavior remains; classification grants no motion.
    event = result['evidence']['road_return_event']
    assert event['legacy_blocker_recorded'] is True
    assert event['retained_passage_constraint'] is None
    marker = runtime.roads.blocked[-1]
    assert set(marker) == {'position_m', 'tick', 'reason'}
    _, checking = reverse_fixture(copy.deepcopy(FIXTURE['directional_failures']) + [marker])
    assert checking.sampling_reverse_clearance_prefix(PARAMS) is None


@pytest.mark.parametrize('unknown_method', ['turn', 'follow_road'])
def test_unknown_return_is_sent_once_and_never_suppressed_by_known_stop(unknown_method):
    runtime, actions, source, calls, motions, reads, controls = producer_fixture()
    old = copy.deepcopy(runtime.roads.blocked)
    controls['unknown'] = unknown_method
    with pytest.raises(TimeoutError) as failure:
        actions.return_from_blocked_road(source['actuator_result'])
    assert [method for method, _ in calls].count(unknown_method) == 1
    assert reads[-1] == 'readonly' and reads.count('readonly') == 1
    assert motions[-1]['outcome_unknown'] is True
    assert failure.value.action_evidence['outcome_unknown'] is True
    assert failure.value.action_evidence['uncertain_motion']['method'] == unknown_method
    event = failure.value.action_evidence['road_return_event']
    assert event['legacy_blocker_recorded'] is False
    assert event['retained_passage_constraint']['bridge_request_id'] == 'brain-000253'
    assert runtime.roads.blocked == old


def test_known_observed_return_failure_retains_its_event_and_original_evidence():
    runtime, actions, source, calls, _, _, _ = producer_fixture()
    observe = runtime.observe
    def changed_holding(*, motion=None):
        result = observe(motion=motion)
        if motion and motion['method'] == 'turn':
            runtime.snapshot['holding']['holding'] = True
        return result
    runtime.observe = changed_holding
    with pytest.raises(ObservedMotionFailure) as failure:
        actions.return_from_blocked_road(source['actuator_result'])
    assert failure.value.reason == 'holding_changed_during_motion'
    assert failure.value.evidence['holding_changed'] is True
    assert failure.value.evidence['road_return_event']['legacy_blocker_recorded'] is False
    assert [method for method, _ in calls] == ['turn']


@pytest.mark.parametrize('old_evidence', [None, ['malformed prior diagnostic']])
def test_nonmapping_exception_diagnostic_does_not_mask_original_error(old_evidence, monkeypatch):
    runtime, actions, source, calls, motions, reads, _ = producer_fixture()
    original = RuntimeError('original synthetic return failure')
    original.action_evidence = copy.deepcopy(old_evidence)
    def stopped(*args, **kwargs):
        raise original
    monkeypatch.setattr(actions, '_return_from_blocked_road', stopped)
    with pytest.raises(RuntimeError) as caught:
        actions.return_from_blocked_road(source['actuator_result'])
    assert caught.value is original
    assert original.action_evidence['road_return_event']['legacy_blocker_recorded'] is False
    assert calls == motions == reads == []
    assert len(runtime.roads.blocked) == 1


def test_retained_second_stop_still_blocks_even_when_a_return_event_is_classified():
    producer, actions, source, _, _, _, _ = producer_fixture()
    result = actions.return_from_blocked_road(source['actuator_result'])
    assert result['evidence']['road_return_event']['legacy_blocker_recorded'] is False
    runtime, reverse, calls, motions, _ = reverse_runtime_fixture()
    second = copy.deepcopy(runtime.roads.blocked[-1])
    second.update(passage_id='synthetic second stop', reason='collision')
    second['entry']['position_m'] = [-.490, .865]
    second['stop']['position_m'] = [-.489, .865]
    runtime.roads.blocked.insert(0, second)
    runtime.roads.blocked.extend(copy.deepcopy(producer.roads.blocked))
    old = copy.deepcopy(runtime.roads.blocked)
    assert reverse.sampling_reverse_clearance_prefix(PARAMS) is None
    with pytest.raises(ObservedMotionFailure) as refused:
        reverse.move('backward', PARAMS, sampling_reverse_prefix=True)
    assert refused.value.evidence['motion_not_sent'] is True
    assert calls == motions == []
    assert runtime.roads.blocked == old
