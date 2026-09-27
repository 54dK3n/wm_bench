"""Sampling inverses from real motion records and synthetic public sensors.

Perception/WM, Runtime and the frozen platform normalizeCommand are real.
Scene coordinates only render public camera boxes; no confirmation is injected.
"""
import copy
import math

import pytest

from autonomous_brain.confirmation_sampling import _reverse_support, _restore_plan
from test_brain_confirmation_sampling import discovery_id, sample, sampling_runtime
from test_brain_sampling_viewpoint_comparison import comparison_runtime


def straight_history(lengths):
    runtime = sampling_runtime(target=(0, 150))
    for length in lengths:
        runtime.actions.move('forward', {'distanceCm': length, 'speed': 30})
    return runtime


@pytest.mark.parametrize('lengths', [(20,), (10, 10), (5, 5, 5, 5)])
def test_equal_measured_collinear_paths_authorize_the_same_inverse(lengths):
    runtime = straight_history(lengths)
    proof = _reverse_support(runtime.actions, 20)
    assert proof is not None, 'splitting actual motion must not remove supported coverage'
    assert proof['planned_position_m'] == pytest.approx([0, 0])
    records = runtime.roads.road_segment_records()
    assert proof['segments'] == records
    assert proof['segment_ids'] == [s['segment_id'] for s in records]
    assert [o['observation_index'] for o in proof['observation_refs']] == list(range(1, len(lengths) + 2))
    assert _reverse_support(runtime.actions, 20.3) is None


@pytest.mark.parametrize('broken', ['unrecorded_gap', 'parallel_lane', 'curve', 'interior_node'])
def test_segments_cannot_be_summed_across_missing_or_incompatible_evidence(broken):
    runtime = straight_history([10])
    if broken == 'unrecorded_gap':
        runtime.bridge.z += 1
        runtime.observe()
    elif broken == 'parallel_lane':
        runtime.bridge.x += 1
        runtime.observe()
    elif broken == 'curve':
        runtime.actions.move('turn', {'angleDeg': 8, 'speed': 50})
    else:
        runtime.bridge.at_node = True
        runtime.observe()
    runtime.actions.move('forward', {'distanceCm': 10, 'speed': 30})
    assert _reverse_support(runtime.actions, 20) is None


def test_fresh_pose_in_old_segment_without_observed_return_is_not_a_terminal():
    runtime = straight_history([40])
    runtime.bridge.z = 30
    runtime.observe()
    assert _reverse_support(runtime.actions, 15.5) is None


def test_backward_has_a_conditional_actual_forward_inverse_to_its_old_view():
    runtime = comparison_runtime(41, history_cm=34, side_clearance=20)
    target = runtime.perception.discovery_target(discovery_id(runtime))
    before = copy.deepcopy(runtime.snapshot)
    runtime.actions.move('backward', {'distanceCm': 15.5, 'speed': 30})
    entry = {'method': 'backward', 'params': {'distanceCm': 15.5, 'speed': 30},
             'before_observation': before['observation_index'],
             'after_observation': runtime.snapshot['observation_index']}
    plan, reason = _restore_plan(runtime.actions, before, target, entry, 104.5)
    assert plan is not None, reason
    assert plan['method'] == 'forward'
    runtime.actions.move(plan['method'], plan['params'])
    assert runtime.bridge.z == pytest.approx(34)


def backward_loss_runtime(*, persist=False):
    runtime = comparison_runtime(41, history_cm=34, side_clearance=20)
    initial_calls = len(runtime.bridge.calls)
    pixels = runtime.bridge.pixels

    def current_pixels():
        if len(runtime.bridge.calls) > initial_calls and (persist or len(runtime.bridge.calls) == initial_calls + 1):
            return []
        return pixels()

    runtime.bridge.pixels = current_pixels
    return runtime, initial_calls


def test_backward_view_loss_restores_forward_then_gains_real_independent_confirmation():
    runtime, initial_calls = backward_loss_runtime()
    selected = discovery_id(runtime)
    initial = runtime.perception.discovery_target(selected)['associated_object']
    assert initial['state'] == 'TENTATIVE' and initial['hit_count'] == 2
    result = sample(runtime, selected)
    assert result['success'], result
    calls = runtime.bridge.calls[initial_calls:]
    assert [method for method, _ in calls[:2]] == ['backward', 'forward']
    trace = result['evidence']['confirmation_sampling']
    assert trace['recovery_attempt']['success']
    assert trace['steps'][1]['accepted_hit_poses_after'] == trace['steps'][0]['accepted_hit_poses_before']
    assert trace['final_hit_count'] == 3
    assert sum(step.get('phase') == 'restore_previous_view' for step in trace['steps']) == 1
    assert len(trace['steps']) <= 12 and trace['travelled_cm'] <= 120
    assert_real_hits(runtime)


def assert_real_hits(runtime):
    frames = {str(o['observation']['frameId']): o for o in runtime.trace}
    for obj in runtime.perception.objects():
        poses = obj['hit_poses']
        for pose in poses:
            observed = frames[pose['frame_id']]
            admitted = [d for d in observed['perception']['detections']
                        if d.get('track_id') == obj['id'] and d.get('fed_to_world_model')]
            assert len(admitted) == 1
            assert 40 <= admitted[0]['raw_distance_cm'] < 90
            assert abs(admitted[0]['raw_bearing_deg']) <= 35
            assert pose['x_m'] == pytest.approx(observed['odometry']['rightCm'] / 100)
            assert pose['z_m'] == pytest.approx(observed['odometry']['forwardCm'] / 100)
        assert all(math.hypot(a['x_m'] - b['x_m'], a['z_m'] - b['z_m']) >= .15
                   for i, a in enumerate(poses) for b in poses[:i])


def test_observation_window_is_a_copy_of_only_registered_public_records():
    runtime = straight_history([10, 10])
    runtime.roads._semantic.frames[2]['not_public_scene_state'] = {'sentinel': 1}
    original = runtime.roads.observation_records(1, 3)
    assert len(original['observations']) == 3 and len(original['motions']) == 2
    assert all(set(o) == {'observation_index', 'odometry', 'road', 'observation', 'holding'}
               for o in original['observations'])
    assert all(set(o['observation']) == {'frameId', 'tick'} for o in original['observations'])
    original['observations'][0]['odometry']['rightCm'] = 900
    original['motions'][0]['params']['distanceCm'] = 900
    restored = runtime.roads.observation_records(1, 3)
    assert restored['observations'][0]['odometry']['rightCm'] == 0
    assert restored['motions'][0]['params']['distanceCm'] == 10


def test_stationary_fresh_observations_between_segments_preserve_the_full_chain():
    runtime = straight_history([10])
    runtime.observe()
    runtime.actions.move('forward', {'distanceCm': 10, 'speed': 30})
    runtime.observe()
    proof = _reverse_support(runtime.actions, 20)
    assert proof is not None
    assert [x['observation_index'] for x in proof['observation_refs']] == [1, 2, 3, 4, 5]
    assert [(x['before_observation'], x['after_observation']) for x in proof['motion_refs']] == [(1, 2), (3, 4)]


@pytest.mark.parametrize('corrupt', ['missing_frame', 'repeated_frame', 'tick_rollback', 'unknown_motion', 'missing_motion'])
def test_missing_or_untrusted_public_window_cannot_join_valid_segment_endpoints(monkeypatch, corrupt):
    runtime = straight_history([10, 10])
    getter = runtime.roads.observation_records

    def incomplete(first, last):
        result = getter(first, last)
        if corrupt == 'missing_frame':
            result['observations'].pop(1)
        elif corrupt == 'repeated_frame':
            result['observations'][1]['observation']['frameId'] = result['observations'][0]['observation']['frameId']
        elif corrupt == 'tick_rollback':
            result['observations'][1]['odometry']['tick'] = -1
        elif corrupt == 'unknown_motion':
            result['motions'][0]['outcome_unknown'] = True
        else:
            result['motions'].pop(0)
        return result

    monkeypatch.setattr(runtime.roads, 'observation_records', incomplete)
    assert _reverse_support(runtime.actions, 20) is None


def test_backtracking_does_not_add_length_to_covered_extent():
    runtime = straight_history([20])
    runtime.actions.move('backward', {'distanceCm': 5, 'speed': 30})
    runtime.actions.move('forward', {'distanceCm': 5, 'speed': 30})
    proof = _reverse_support(runtime.actions, 20)
    assert proof is not None and len(proof['segments']) == 3
    assert _reverse_support(runtime.actions, 25) is None


@pytest.mark.parametrize('gap_cm', [.1, .2])
def test_even_sub_tolerance_unrecorded_gap_is_not_a_connection(gap_cm):
    runtime = straight_history([10])
    runtime.bridge.z += gap_cm
    runtime.observe()
    runtime.actions.move('forward', {'distanceCm': 10, 'speed': 30})
    assert _reverse_support(runtime.actions, 20) is None


def test_short_segment_lateral_tolerance_cannot_accumulate_into_a_parallel_path():
    runtime = sampling_runtime(target=(0, 150))
    original = runtime.bridge.call

    def small_actual_lateral_drift(method, params=None):
        result = original(method, params)
        if method == 'forward': runtime.bridge.x += .15
        return result

    runtime.bridge.call = small_actual_lateral_drift
    for _ in range(4): runtime.actions.move('forward', {'distanceCm': 5, 'speed': 30})
    assert len(runtime.roads.road_segment_records()) == 4
    assert _reverse_support(runtime.actions, 20) is None


def test_stationary_turn_receipt_cannot_hide_unaccounted_odometer_travel():
    runtime = straight_history([20])
    original = runtime.bridge.call

    def inconsistent_turn_odometer(method, params=None):
        result = original(method, params)
        if method == 'turn': runtime.bridge.travel += 10
        return result

    runtime.bridge.call = inconsistent_turn_odometer
    runtime.actions.move('turn', {'angleDeg': 2, 'speed': 50})
    runtime.actions.move('turn', {'angleDeg': -2, 'speed': 50})
    assert _reverse_support(runtime.actions, 20) is None


@pytest.mark.parametrize('obstruction', ['front', 'sides', 'off_road', 'wrong_heading', 'original_window', 'wrong_source_frame', 'travel_budget', 'step_budget'])
def test_backward_restore_rejects_unsafe_view_or_current_conditions(monkeypatch, obstruction):
    runtime, initial_calls = backward_loss_runtime()
    original = runtime.bridge.call

    def changed_road(method, params=None):
        result = original(method, params)
        if method == 'local_road' and len(runtime.bridge.calls) > initial_calls:
            if obstruction == 'front': result['frontClearanceCm'] = 1
            if obstruction == 'sides': result.update(leftClearanceCm=0, rightClearanceCm=0)
            if obstruction == 'off_road': result['onRoad'] = False
        return result

    runtime.bridge.call = changed_road
    if obstruction == 'step_budget':
        monkeypatch.setattr('autonomous_brain.confirmation_sampling.MAX_STEPS', 1)
    elif obstruction == 'travel_budget':
        monkeypatch.setattr('autonomous_brain.confirmation_sampling.MAX_TRAVEL_CM', 20)
    elif obstruction in {'wrong_heading', 'original_window', 'wrong_source_frame'}:
        target = runtime.perception.discovery_target(discovery_id(runtime))
        before = copy.deepcopy(runtime.snapshot)
        runtime.actions.move('backward', {'distanceCm': 15.5, 'speed': 30})
        if obstruction == 'wrong_heading':
            runtime.actions.move('turn', {'angleDeg': 2, 'speed': 50})
        elif obstruction == 'original_window': target['current_detection']['raw_distance_cm'] = 39
        else: target['current_detection']['frame_id'] = 'unrelated-source-frame'
        entry = {'method': 'backward', 'params': {'distanceCm': 15.5, 'speed': 30},
                 'before_observation': before['observation_index'],
                 'after_observation': runtime.snapshot['observation_index']}
        assert _restore_plan(runtime.actions, before, target, entry, 100)[0] is None
        return
    result = sample(runtime)
    assert not result['success']
    assert len(runtime.bridge.calls) == initial_calls + 1
    assert all(o['state'] != 'CONFIRMED' for o in runtime.perception.objects())


def test_target_not_reappearing_stops_after_one_forward_restore():
    runtime, initial_calls = backward_loss_runtime(persist=True)
    result = sample(runtime)
    assert not result['success']
    assert [m for m, _ in runtime.bridge.calls[initial_calls:]] == ['backward', 'forward']
    proof = result['evidence']['confirmation_sampling']
    assert proof['recovery_attempt']['observed_pose_restored']
    assert not proof['recovery_attempt']['success']
    assert_real_hits(runtime)


def test_different_real_detection_at_restored_view_does_not_confirm_the_old_identity():
    runtime, initial_calls = backward_loss_runtime()
    original = runtime.bridge.call
    old_id = runtime.perception.objects()[0]['id']

    def different_ball_on_return(method, params=None):
        result = original(method, params)
        if method == 'forward' and len(runtime.bridge.calls) > initial_calls:
            runtime.bridge.target = (0, runtime.bridge.target[1] + 40)
        return result

    runtime.bridge.call = different_ball_on_return
    result = sample(runtime)
    assert not result['success']
    assert len(runtime.bridge.calls) == initial_calls + 2
    assert runtime.perception.get_object(old_id)['state'] != 'CONFIRMED'
    assert len(runtime.perception.objects()) >= 2
    assert_real_hits(runtime)


@pytest.mark.parametrize('uncertain', ['first_backward', 'inverse_forward'])
def test_unknown_primitive_outcome_never_sends_or_repeats_a_restore(uncertain):
    runtime, initial_calls = backward_loss_runtime()
    original = runtime.bridge.call

    def unknown(method, params=None):
        result = original(method, params)
        if (method == 'backward' and uncertain == 'first_backward'
                or method == 'forward' and uncertain == 'inverse_forward'):
            raise ConnectionError('synthetic sampling receipt lost after actual movement')
        return result

    runtime.bridge.call = unknown
    with pytest.raises(ConnectionError) as error:
        sample(runtime)
    proof = error.value.action_evidence['confirmation_sampling']
    assert proof['reason'] == 'confirmation_motion_outcome_unknown'
    assert len(runtime.bridge.calls) == initial_calls + (1 if uncertain == 'first_backward' else 2)
    assert not proof.get('recovery_attempt', {}).get('success')


@pytest.mark.parametrize('method,params,inverse', [
    ('forward', {'distanceCm': 15.5, 'speed': 30}, 'backward'),
    ('backward', {'distanceCm': 15.5, 'speed': 30}, 'forward'),
    ('turn', {'angleDeg': 20, 'speed': 50}, 'turn')])
def test_forward_backward_turn_restore_use_recorded_inverse_and_actual_normalizer(method, params, inverse):
    runtime = comparison_runtime(75, -20, road_heading=20, at_node=True)
    target = runtime.perception.discovery_target(discovery_id(runtime))
    before = copy.deepcopy(runtime.snapshot)
    runtime.actions.move(method, params)
    entry = {'method': method, 'params': params, 'before_observation': before['observation_index'],
             'after_observation': runtime.snapshot['observation_index']}
    plan, reason = _restore_plan(runtime.actions, before, target, entry, 104.5)
    assert plan is not None, reason
    assert plan['method'] == inverse
    runtime.actions.move(plan['method'], plan['params'])
    assert runtime.bridge.x == pytest.approx(before['odometry']['rightCm'])
    assert runtime.bridge.z == pytest.approx(before['odometry']['forwardCm'])
    assert runtime.bridge.heading == pytest.approx(before['odometry']['headingDeg'])


@pytest.mark.parametrize('bad_result', ['partial', 'heading_change'])
def test_forward_restore_must_reach_the_original_pose_with_verified_motion(bad_result):
    runtime, initial_calls = backward_loss_runtime()
    original = runtime.bridge.call

    def faulty_forward(method, params=None):
        restoring = method == 'forward' and len(runtime.bridge.calls) >= initial_calls + 1
        actual_params = {**params, 'distanceCm': params['distanceCm'] * .8} if restoring and bad_result == 'partial' else params
        result = original(method, actual_params)
        if restoring and bad_result == 'heading_change':
            runtime.bridge.heading += .3
        return result

    runtime.bridge.call = faulty_forward
    result = sample(runtime)
    assert not result['success']
    assert len(runtime.bridge.calls) == initial_calls + 2
    trace = result['evidence']['confirmation_sampling']
    assert not trace['recovery_attempt']['success']
    assert not trace['recovery_attempt']['observed_pose_restored']


def test_second_backward_view_loss_cannot_trigger_a_second_restore():
    runtime, initial_calls = backward_loss_runtime()
    pixels = runtime.bridge.pixels
    runtime.bridge.pixels = lambda: [] if len(runtime.bridge.calls) == initial_calls + 3 else pixels()
    result = sample(runtime)
    assert not result['success']
    assert [m for m, _ in runtime.bridge.calls[initial_calls:]] == ['backward', 'forward', 'backward']
    trace = result['evidence']['confirmation_sampling']
    assert trace['recovery_attempt']['success']
    assert sum(s.get('phase') == 'restore_previous_view' for s in trace['steps']) == 1
    assert trace['final_hit_count'] == 2


def export_synthetic_inverse_cases(destination):
    """Create-only public evidence; no simulator/model/confirmation shortcuts."""
    import hashlib
    import json
    from pathlib import Path
    import autonomous_brain.confirmation_sampling as sampler
    import autonomous_brain.navigation as navigation
    import autonomous_brain.perception as perception

    destination = Path(destination)
    if destination.exists():
        raise ValueError('Choose a new output path; original evidence is never overwritten')
    repo = Path(__file__).resolve().parents[1]
    for module in (sampler, navigation, perception):
        if not Path(module.__file__).resolve().is_relative_to(repo):
            raise ValueError('Imported source is outside the selected fixture repository')
    sources = sorted(set([*repo.glob('autonomous_brain/*.py'),
        *repo.glob('vendor/wm_kit_opt2/world_model/**/*.py'),
        Path(__file__).resolve(), repo / 'tests/test_brain_confirmation_sampling.py',
        repo / 'tests/test_brain_sampling_viewpoint_comparison.py',
        repo / 'tests/test_brain_route_contract.py',
        repo / 'workspaces/guangyang-platform/projects/car-python/robot-bridge-contract.js']))

    def fingerprints():
        return {str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}

    before = fingerprints()
    cases = []
    for lengths in [(20,), (10, 10), (5, 5, 5, 5)]:
        runtime = straight_history(lengths)
        support = _reverse_support(runtime.actions, 20)
        assert support and support['planned_position_m'] == pytest.approx([0, 0])
        assert _reverse_support(runtime.actions, 20.3) is None
        cases.append({'name': 'same_20cm_path_' + '_'.join(map(str, lengths)),
            'support': support, 'unsupported_20_3cm_refused': True,
            'observations': runtime.trace, 'motions': runtime.motions,
            'normalized_motor_calls': runtime.bridge.calls,
            'road_segments': runtime.roads.road_segment_records(), 'checks_satisfied': True})
    for persist in (False, True):
        runtime, start = backward_loss_runtime(persist=persist)
        initial = copy.deepcopy(runtime.perception.objects())
        result = sample(runtime)
        assert result['success'] is (not persist)
        assert_real_hits(runtime)
        trace = result['evidence']['confirmation_sampling']
        assert [m for m, _ in runtime.bridge.calls[start:start + 2]] == ['backward', 'forward']
        assert sum(s.get('phase') == 'restore_previous_view' for s in trace['steps']) == 1
        assert len(trace['steps']) <= 12 and trace['travelled_cm'] <= 120
        cases.append({'name': 'backward_loss_' + ('persistent_refusal' if persist else 'forward_restore_then_confirm'),
            'initial_objects': initial, 'final_objects': runtime.perception.objects(),
            'observations': runtime.trace, 'motions': runtime.motions,
            'normalized_motor_calls': runtime.bridge.calls, 'sampling_calls_start': start,
            'result': result, 'road_segments': runtime.roads.road_segment_records(),
            'actual_public_hit_checks_satisfied': True, 'checks_satisfied': True})
    after = fingerprints()
    assert before == after
    artifact = {'schema': 'synthetic-sampling-inverse-chain/v1',
        'classification': 'synthetic_public_sensor_real_perception_wm_and_normalize_command',
        'formal_result': False, 'model_calls': 0, 'simulator_calls': 0,
        'sampler_version': sampler.VERSION, 'source_before': before, 'source_after': after,
        'sources_unchanged': True, 'cases': cases, 'checks_satisfied': True}
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open('x') as stream:
        json.dump(artifact, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')
    print(json.dumps({'output': str(destination), 'cases': len(cases), 'checks_satisfied': True,
                      'synthetic': True, 'formal_result': False}))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=export_synthetic_inverse_cases.__doc__)
    parser.add_argument('--output', required=True)
    export_synthetic_inverse_cases(parser.parse_args().output)
