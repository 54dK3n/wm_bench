"""Reduced public r152/r166/r167 sensors; controller fixture, not a task run."""
import copy
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from autonomous_brain.navigation import RoadMemory, wrap
from test_brain_navigation_reposition import sensor
from test_brain_route_contract import normalize


def public_frame(index, point, heading, travelled, *, node=False, front=.8):
    row = sensor(index, point, heading=heading, travelled=travelled)
    row['road'].update(tick=index, atNode=node, frontClearanceCm=front,
        leftClearanceCm=9.2, rightClearanceCm=9.2,
        exits=[{'angleDeg': a} for a in (167.4, 90, 0, -90)] if node else [])
    return row


def runtime_fixture():
    roads = RoadMemory()
    # r152's front stop, retained as a directional obligation.
    entry = public_frame(10, (1.127, 1.114), 7.6, 6772.4)
    stop = public_frame(11, (1.127, 1.120), 7.6, 6773, front=.1)
    roads.remember_passage_failure(entry, stop, {'method': 'follow_road',
        'params': normalize('follow_road', {'distanceCm': 20, 'speed': 50}),
        'before_observation': 10, 'after_observation': 11,
        'bridge_request_id': 'original-front-stop',
        'actuator_result': {'accepted': True, 'stoppedBy': 'front_clearance', 'distanceCm': .6}})
    # r166's complete take_exit brings the robot to the same r152 entry pose.
    start = public_frame(20, (1.110, .712), 0, 7361.9, node=True, front=40)
    current = public_frame(21, (1.127, 1.114), 7.6, 7402.5)
    def register(row, motion=None):
        roads.update(row['odometry'], row['road'], row['observation_index'])
        roads.observe_traversal(row, motion)
    register(start)
    register(current, {'method': 'take_exit',
        'params': normalize('take_exit', {'angleDeg': 0, 'speed': 50}),
        'before_observation': 20, 'after_observation': 21,
        'bridge_request_id': 'completed-incoming-exit',
        'actuator_result': {'accepted': True, 'stoppedBy': 'entered_road', 'distanceCm': 40.6}})
    for i in (22, 23):
        current = copy.deepcopy(current)
        current['observation_index'] = i
        current['observation']['frameId'] = str(i)
        register(current)
    calls, motions = [], []
    # Production snapshots contain pixels/detections; RoadMemory keeps only
    # frame identity and tick, so support must compare those fields only.
    current['observation'].update(width=640, height=480, detections=[])
    runtime = SimpleNamespace(snapshot=current, round=167, roads=roads,
        bridge=SimpleNamespace(seconds=988.54, max_seconds=1200, sequence=3906),
        perception=SimpleNamespace(objects=lambda: []), pending_grasp=None, held_object_id=None,
        motion_log=SimpleNamespace(write=motions.append))
    pending = {}
    def call(method, params):
        params = normalize(method, params)
        calls.append((method, params))
        runtime.bridge.sequence += 1
        if method == 'turn':
            current['odometry']['headingDeg'] = wrap(current['odometry']['headingDeg']+params['angleDeg'])
            pending.update(front=162)
            return {'completed': True}
        assert method == 'follow_road'
        # Region trigger, not a jump to the historical start anchor.
        current['odometry'].update(rightCm=113.9, forwardCm=102.1, headingDeg=-180,
            distanceCm=current['odometry']['distanceCm']+9.4)
        pending.update(front=150.6, node=True)
        return {'accepted': True, 'stoppedBy': 'junction', 'distanceCm': 9.4}
    def observe(*, motion=None):
        current['observation_index'] += 1
        if motion is not None:
            current['odometry']['tick'] += 1
            runtime.bridge.seconds += .02
        current['observation'] = {'frameId': str(current['observation_index']),
                                  'tick': current['odometry']['tick']}
        current['road'].update(tick=current['odometry']['tick'], headingErrorDeg=0,
            frontClearanceCm=pending.pop('front', current['road']['frontClearanceCm']))
        if pending.pop('node', False):
            current['road'].update(atNode=True, exits=[{'angleDeg': a} for a in (90, -12.5, -90, -180)])
        register(current, dict(motion, after_observation=current['observation_index']) if motion else None)
    runtime.bridge.call, runtime.observe = call, observe
    return runtime, calls, motions


def test_known_forward_rejection_reuses_recorded_road_return_without_resending_forward():
    runtime, calls, motions = runtime_fixture()
    outcome = Actions(runtime).execute({'action': 'explore', 'params': {}})
    assert outcome['reason'] == 'road_blocked_returned_to_observed_node', outcome
    assert not outcome['success']  # Recovery does not complete the task or exploration.
    assert [m for m, _ in calls] == ['turn', 'follow_road']
    assert calls[0][1]['angleDeg'] == -180
    assert calls[1][1] == {'distanceCm': 20, 'speed': 30}
    assert runtime.snapshot['road']['atNode'] and not runtime.snapshot['holding']['holding']
    evidence = outcome['evidence']
    assert evidence['pre_motion_rejection']['reason'] == 'directed_passage_still_blocked'
    assert evidence['pre_motion_rejection']['evidence']['motion_not_sent']
    assert 'actuator_result' not in evidence  # There was no new rejected actuator request.
    assert evidence['recorded_road_return']['segment_id'] == 'road-segment-20-21'
    assert evidence['recorded_road_return']['motion_request_id'] == 'completed-incoming-exit'
    assert len(motions) == 2


@pytest.mark.parametrize('invalid', ['mixed_tick', 'different_frame_id', 'no_reverse_edge',
    'unknown_incoming', 'basic_incoming', 'missing_stationary_frame', 'pending_grasp',
    'holding_identity_mismatch'])
def test_pre_rejection_does_not_turn_without_verified_return_support(invalid):
    runtime, calls, _ = runtime_fixture()
    roads, current = runtime.roads, runtime.snapshot
    if invalid == 'mixed_tick':
        current['road']['tick'] += 1
    elif invalid == 'different_frame_id':
        current['observation']['frameId'] = 'unregistered-frame'
    elif invalid == 'no_reverse_edge':
        roads._approach_edges[(1.127, 1.114)].clear()
    elif invalid == 'unknown_incoming':
        roads._road_segments['road-segment-20-21']['motion']['outcome_unknown'] = True
    elif invalid == 'basic_incoming':
        roads._road_segments['road-segment-20-21']['execution']['kind'] = 'basic_translation'
    elif invalid == 'missing_stationary_frame':
        del roads._semantic.frames[22]
    elif invalid == 'pending_grasp':
        runtime.pending_grasp = {'object_id': 'unresolved-red'}
    elif invalid == 'holding_identity_mismatch':
        runtime.held_object_id = 'unresolved-red'
    outcome = Actions(runtime).execute({'action': 'explore', 'params': {}})
    assert outcome['reason'] == 'directed_passage_still_blocked'
    assert outcome['evidence']['recorded_road_return']['reason'] == 'no_verified_return_support'
    assert calls == []


def test_current_holding_unknown_does_not_initiate_recovery():
    runtime, calls, _ = runtime_fixture()
    actions = Actions(runtime)
    with pytest.raises(ObservedMotionFailure) as refused:
        actions.move('follow_road', normalize('follow_road', {'distanceCm': 20, 'speed': 50}))
    runtime.snapshot['holding']['holding'] = None
    outcome = actions.return_after_known_road_rejection(refused.value)
    assert outcome['reason'] == 'directed_passage_still_blocked'
    assert calls == []


def test_reverse_direction_with_its_own_failure_remains_blocked():
    runtime, calls, _ = runtime_fixture()
    entry = copy.deepcopy(runtime.snapshot)
    entry['odometry']['headingDeg'] = -172.4
    stopped = copy.deepcopy(entry)
    stopped['observation_index'] += 1
    stopped['odometry']['tick'] += 1
    stopped['observation'].update(frameId=str(stopped['observation_index']), tick=stopped['odometry']['tick'])
    runtime.roads.remember_passage_failure(entry, stopped, {'method': 'follow_road',
        'params': normalize('follow_road', {'distanceCm': 20, 'speed': 30}),
        'actuator_result': {'accepted': True, 'stoppedBy': 'front_clearance', 'distanceCm': 0}})
    outcome = Actions(runtime).execute({'action': 'explore', 'params': {}})
    assert outcome['reason'] == 'directed_passage_still_blocked'
    assert calls == []


def test_forward_failure_does_not_resolve_itself_or_block_valid_reverse():
    runtime, calls, _ = runtime_fixture()
    Actions(runtime).execute({'action': 'explore', 'params': {}})
    assert runtime.roads.blocked[0]['resolved_by'] is None
    assert [method for method, _ in calls] == ['turn', 'follow_road']


@pytest.mark.parametrize('condition', ['new_front_obstacle', 'narrow_side', 'road_heading_unknown'])
def test_turn_reobserves_new_safety_conditions_before_return_translation(condition):
    runtime, calls, _ = runtime_fixture()
    observe = runtime.observe
    def changed_view(*, motion=None):
        observe(motion=motion)
        if motion and motion['method'] == 'turn':
            if condition == 'new_front_obstacle':
                runtime.snapshot['road']['frontClearanceCm'] = .1
            elif condition == 'narrow_side':
                runtime.snapshot['road']['leftClearanceCm'] = .1
            else:
                runtime.snapshot['road']['headingErrorDeg'] = None
    runtime.observe = changed_view
    outcome = Actions(runtime).execute({'action': 'explore', 'params': {}})
    assert outcome['reason'] in {'blocked_road_return_no_safe_legal_step',
                                 'blocked_road_return_current_sensors_unverified'}
    assert [method for method, _ in calls] == ['turn']


def test_new_holding_change_after_turn_is_not_hidden_by_recovery():
    runtime, calls, _ = runtime_fixture()
    observe = runtime.observe
    def changed_view(*, motion=None):
        observe(motion=motion)
        if motion and motion['method'] == 'turn':
            runtime.snapshot['holding']['holding'] = True
    runtime.observe = changed_view
    outcome = Actions(runtime).execute({'action': 'explore', 'params': {}})
    assert outcome['reason'] == 'holding_changed_during_motion'
    assert outcome['evidence']['pre_motion_rejection']['evidence']['motion_not_sent']
    assert [method for method, _ in calls] == ['turn']


def test_reused_frame_after_follow_cannot_claim_fresh_node_recovery():
    runtime, calls, _ = runtime_fixture()
    observe = runtime.observe
    def stale_view(*, motion=None):
        previous_frame = runtime.snapshot['observation']['frameId']
        observe(motion=motion)
        if motion and motion['method'] == 'follow_road':
            runtime.snapshot['observation']['frameId'] = previous_frame
    runtime.observe = stale_view
    outcome = Actions(runtime).execute({'action': 'explore', 'params': {}})
    # Existing move verification already refuses a reused frame before the
    # return-specific node check; preserve that stricter failure reason.
    assert outcome['reason'] == 'basic_motion_not_verified'
    assert outcome['evidence']['pre_motion_rejection']['evidence']['motion_not_sent']
    assert [method for method, _ in calls] == ['turn', 'follow_road']


@pytest.mark.parametrize('unknown_method', ['turn', 'follow_road'])
def test_unknown_recovery_execution_is_logged_and_never_resent(unknown_method):
    runtime, calls, motions = runtime_fixture()
    call = runtime.bridge.call
    def unknown_receipt(method, params):
        result = call(method, params)
        if method == unknown_method:
            raise TimeoutError('synthetic unknown controller receipt')
        return result
    runtime.bridge.call = unknown_receipt
    with pytest.raises(TimeoutError) as stopped:
        Actions(runtime).execute({'action': 'explore', 'params': {}})
    assert [m for m, _ in calls].count(unknown_method) == 1
    assert motions[-1]['outcome_unknown'] is True
    assert stopped.value.action_evidence['outcome_unknown'] is True
    assert stopped.value.action_evidence['pre_motion_rejection']['evidence']['motion_not_sent']


@pytest.mark.parametrize('reason,sent', [('basic_motion_not_verified', True),
                                      ('directed_passage_still_blocked', False)])
def test_unrelated_or_non_pre_command_failures_never_start_return(reason, sent):
    runtime, calls, _ = runtime_fixture()
    failure = ObservedMotionFailure(reason, {'motion_not_sent': sent})
    with pytest.raises(ObservedMotionFailure) as stopped:
        Actions(runtime).return_after_known_road_rejection(failure)
    assert stopped.value is failure and calls == []


def test_insufficient_remaining_recorded_arc_is_not_clamped_to_legal_minimum():
    runtime, calls, _ = runtime_fixture()
    proof = runtime.roads.observed_road_return_support(runtime.snapshot)
    proof['max_travel_cm'] = 9
    outcome = Actions(runtime).return_from_blocked_road(None,
        pre_motion_rejection={'reason': 'directed_passage_still_blocked'}, return_support=proof)
    assert outcome['reason'] == 'blocked_road_return_no_safe_legal_step'
    assert [m for m, _ in calls] == ['turn']
