"""Compare legal viewpoints through real public sensors, WM and command normalization."""
import math

import pytest

from autonomous_brain.confirmation_sampling import _plan, _reading, _reverse_support
from autonomous_brain.navigation import wrap
from autonomous_brain.perception import calibrate_reading
from test_brain_confirmation_sampling import discovery_id, sample, sampling_runtime


def comparison_runtime(raw=75, bearing=0, *, road_heading=0, at_node=False,
                       history_cm=0, side_clearance=10, mode=None):
    radius, beta = calibrate_reading(raw, bearing)
    target = (radius * math.sin(math.radians(beta)),
              history_cm + radius * math.cos(math.radians(beta)))
    r = sampling_runtime(target=target, at_node=at_node, mode=mode)
    original = r.bridge.call

    def public_road(method, params=None):
        result = original(method, params)
        if method == 'local_road':
            error = wrap(road_heading - r.bridge.heading)
            result.update(headingErrorDeg=error, leftClearanceCm=side_clearance,
                          rightClearanceCm=side_clearance,
                          exits=[{'angleDeg': error}] if at_node else [])
        return result

    r.bridge.call = public_road
    if history_cm:
        r.actions.move('forward', {'distanceCm': history_cm, 'speed': 30})
    r.observe()
    return r


def test_near_window_uses_observed_reverse_before_destructive_road_alignment():
    r = comparison_runtime(41, road_heading=20, history_cm=34, side_clearance=20)
    selected = discovery_id(r)
    target = r.perception.discovery_target(selected)
    assert target['associated_object']['hit_count'] == 2
    assert target['current_detection']['raw_distance_cm'] == 41
    assert _reverse_support(r.actions, 15.5) is not None
    rejected_turn = _reading(target['current_detection']['position_m'],
                             (r.bridge.x / 100, r.bridge.z / 100), 20)
    assert rejected_turn[0] < 40  # The former bearing-only turn gate misses this.
    prior_calls = len(r.bridge.calls)
    result = sample(r, selected)
    assert result['success'], result
    assert r.bridge.calls[prior_calls][0] == 'backward'
    assert not any(method == 'turn' for method, _ in r.bridge.calls[prior_calls:])
    assert r.perception.objects()[0]['hit_count'] == 3


def test_turn_at_far_raw_boundary_cannot_leave_window_even_when_bearing_improves():
    r = comparison_runtime(87, -25, road_heading=20, at_node=True)
    target = r.perception.discovery_target(discovery_id(r))
    predicted = _reading(target['current_detection']['position_m'], (0, 0), 20)
    assert predicted[0] > 90 and abs(predicted[1]) < 33
    result = sample(r)
    assert not result['success']
    assert result['reason'] == 'confirmation_no_safe_independent_viewpoint'
    assert r.bridge.calls == []


def test_turn_is_useful_when_raw_window_and_next_independent_view_both_survive():
    r = comparison_runtime(75, -20, road_heading=20, at_node=True)
    result = sample(r)
    assert result['success'], result
    assert r.bridge.calls[0][0] == 'turn'
    assert r.perception.objects()[0]['hit_count'] >= 3
    first = result['evidence']['confirmation_sampling']['steps'][0]
    assert 42 <= first['predicted_raw_distance_cm'] <= 87
    assert first['next_independent_viewpoint']['independent_pose_predicted']


def test_current_safe_forward_is_compared_before_unnecessary_alignment():
    r = comparison_runtime(75, road_heading=8)
    target = r.perception.discovery_target(discovery_id(r))
    rejected = {}
    plan = _plan(r.actions, target, 120, rejected)
    assert plan['method'] == 'forward'
    assert plan['independent_pose_predicted']
    result = sample(r)
    assert result['success'], result
    assert r.bridge.calls[0][0] == 'forward'


def test_turn_without_any_next_safe_translation_is_not_progress():
    r = comparison_runtime(41, road_heading=20)
    result = sample(r)
    assert not result['success']
    assert result['reason'] == 'confirmation_no_safe_independent_viewpoint'
    assert r.bridge.calls == []


def test_projected_turn_cannot_reuse_reverse_history_from_original_heading():
    r = comparison_runtime(41, road_heading=20, history_cm=34, side_clearance=20)
    assert _reverse_support(r.actions, 15.5) is not None
    # Actual public rotation changes the heading while preserving the position.
    r.actions.move('turn', {'angleDeg': 20, 'speed': 50})
    assert _reverse_support(r.actions, 15.5) is None


def test_turn_comparison_rechecks_inverse_path_even_when_immediate_window_is_safe():
    r = comparison_runtime(50, road_heading=20, history_cm=34, side_clearance=20)
    target = r.perception.discovery_target(discovery_id(r))
    plan = _plan(r.actions, target, 120, {})
    assert plan['method'] == 'backward'
    turn = plan['viewpoint_comparison']['turns'][0]
    assert 42 <= turn['predicted_raw_distance_cm'] <= 87
    assert turn['reverse_path_preserved'] is False
    assert turn['rejections']['reverse_path_not_continuously_observed'] > 0
    assert turn['rejections']['turn_has_no_safe_next_viewpoint'] == 1


def obscure_first_new_view(r, *, only_after_turn=False, persist=False):
    original = r.bridge.pixels

    def pixels():
        calls = r.bridge.calls
        if calls and (not only_after_turn or calls[0][0] == 'turn'):
            if persist or len(calls) == 1:
                return []
        return original()

    r.bridge.pixels = pixels
    return r


def test_one_lost_translation_can_restore_the_actual_straight_public_path():
    r = obscure_first_new_view(sampling_runtime())
    selected = discovery_id(r)
    result = sample(r, selected)
    assert result['success'], result
    trace = result['evidence']['confirmation_sampling']
    assert r.bridge.calls[:2] == [
        ('follow_road', {'distanceCm': 15.5, 'speed': 50}),
        ('backward', {'distanceCm': 15.5, 'speed': 30})]
    assert trace['steps'][0]['after_detection'] is None
    restores = [s for s in trace['steps'] if s.get('phase') == 'restore_previous_view']
    assert len(restores) == 1 and restores[0]['reverse_path_support']
    assert trace['recovery_attempt']['success']
    assert trace['travelled_cm'] <= 120 and len(trace['steps']) <= 12
    assert r.perception.objects()[0]['hit_count'] >= 3


def test_one_lost_turn_can_restore_heading_without_inventing_translation():
    r = obscure_first_new_view(comparison_runtime(75, -20, road_heading=20, at_node=True),
                               only_after_turn=True)
    result = sample(r)
    assert not result['success']  # Same failed turn cannot be issued repeatedly.
    trace = result['evidence']['confirmation_sampling']
    assert [m for m, _ in r.bridge.calls] == ['turn', 'turn']
    assert r.bridge.heading == pytest.approx(0)
    assert trace['recovery_attempt']['success']
    assert trace['travelled_cm'] == 0
    assert r.perception.objects()[0]['hit_count'] == 1


def test_persistent_occlusion_restores_once_then_refuses_without_more_motion():
    r = obscure_first_new_view(sampling_runtime(), persist=True)
    result = sample(r)
    assert not result['success']
    assert [m for m, _ in r.bridge.calls] == ['follow_road', 'backward']
    trace = result['evidence']['confirmation_sampling']
    assert trace['recovery_attempt']['success'] is False
    assert all(o['state'] != 'CONFIRMED' for o in r.perception.objects())


def test_second_length_losing_view_stops_after_one_restore_and_cannot_repeat_next_round():
    r = sampling_runtime()
    original = r.bridge.pixels

    def pixels():
        return [] if len(r.bridge.calls) in (1, 3) else original()

    r.bridge.pixels = pixels
    selected = discovery_id(r)
    result = sample(r, selected)
    assert not result['success']
    proof = result['evidence']['confirmation_sampling']
    assert len(proof['steps']) == 3
    assert proof['steps'][1]['phase'] == 'restore_previous_view'
    assert proof['steps'][1]['accepted_hit_poses_after'] == proof['steps'][0]['accepted_hit_poses_before']
    assert proof['steps'][2]['params']['distanceCm'] != proof['steps'][0]['params']['distanceCm']
    assert proof['steps'][2]['after_detection'] is None
    assert proof['final_hit_count'] == proof['initial_hit_count'] == 1
    assert sum(s.get('phase') == 'restore_previous_view' for s in proof['steps']) == 1
    r.round += 1
    r.observe()  # New frame ID, identical tick/pose and still no unique view.
    repeated = sample(r, selected)
    assert not repeated['success'] and len(r.bridge.calls) == 3


def test_lost_curved_translation_has_no_legal_straight_restore():
    r = obscure_first_new_view(sampling_runtime(mode='curve'))
    result = sample(r)
    assert not result['success']
    assert len(r.bridge.calls) == 1
    assert result['evidence']['confirmation_sampling']['recovery_attempt']['reason'] == \
        'reverse_path_not_continuously_observed'


def test_completely_invisible_discovery_without_an_action_local_view_does_not_move():
    r = sampling_runtime()
    selected = discovery_id(r)
    r.bridge.pixels = lambda: []
    r.observe()
    result = sample(r, selected)
    assert not result['success']
    assert r.bridge.calls == []


@pytest.mark.parametrize('blocked', ['narrow_road', 'step_budget', 'travel_budget'])
def test_restore_requires_current_clearance_and_same_action_remaining_budget(monkeypatch, blocked):
    r = obscure_first_new_view(sampling_runtime())
    if blocked == 'step_budget':
        monkeypatch.setattr('autonomous_brain.confirmation_sampling.MAX_STEPS', 1)
    elif blocked == 'travel_budget':
        monkeypatch.setattr('autonomous_brain.confirmation_sampling.MAX_TRAVEL_CM', 20)
    else:
        original = r.bridge.call

        def narrow_after_motion(method, params=None):
            value = original(method, params)
            if method == 'local_road' and r.bridge.calls:
                value.update(leftClearanceCm=.1, rightClearanceCm=.1)
            return value

        r.bridge.call = narrow_after_motion
    result = sample(r)
    assert not result['success']
    assert len(r.bridge.calls) == 1
    assert not result['evidence']['confirmation_sampling']['recovery_attempt']['success']


def test_partial_restore_receipt_cannot_claim_return_to_previous_view():
    r = obscure_first_new_view(sampling_runtime())
    original = r.bridge.call

    def partial_backward(method, params=None):
        if method == 'backward':
            # A legal, nonzero but partial command cannot prove the old pose.
            params = {**params, 'distanceCm': params['distanceCm'] * .8}
        return original(method, params)

    r.bridge.call = partial_backward
    result = sample(r)
    assert not result['success']
    attempt = result['evidence']['confirmation_sampling']['recovery_attempt']
    assert not attempt['success'] and not attempt['observed_pose_restored']
    assert len(r.bridge.calls) == 2


def test_unknown_restore_outcome_is_logged_and_never_resent():
    r = obscure_first_new_view(sampling_runtime())
    original = r.bridge.call

    def unknown_backward(method, params=None):
        value = original(method, params)
        if method == 'backward':
            raise ConnectionError('synthetic restore response missing')
        return value

    r.bridge.call = unknown_backward
    with pytest.raises(ConnectionError) as error:
        sample(r)
    proof = error.value.action_evidence['confirmation_sampling']
    assert proof['reason'] == 'confirmation_motion_outcome_unknown'
    assert proof['steps'][0]['after_detection'] is None
    assert proof['steps'][1]['phase'] == 'restore_previous_view'
    assert len(r.bridge.calls) == 2
    assert not proof['recovery_attempt']['success']


@pytest.mark.parametrize('observed_turn', [.85, .99, 1., 1.1])
def test_restore_turn_obeys_frozen_minimum_without_clamping(observed_turn):
    from test_brain_route_contract import normalize
    r = obscure_first_new_view(comparison_runtime(75, -20, road_heading=1, at_node=True),
                               only_after_turn=True)
    original = r.bridge.call

    def rounded_turn_observation(method, params=None):
        result = original(method, params)
        if method == 'turn' and len(r.bridge.calls) == 1:
            # The requested 1 degree passes the real normalizer; the public
            # odometry differs by <.2 degree and passes existing motion checks.
            r.bridge.heading = observed_turn
        return result

    r.bridge.call = rounded_turn_observation
    inverse = {'angleDeg': -observed_turn, 'speed': 50}
    if observed_turn < 1:
        with pytest.raises(AssertionError, match='normalizeCommand rejected'):
            normalize('turn', inverse)
    else:
        assert normalize('turn', inverse) == inverse
    result = sample(r)
    assert not result['success']
    proof = result['evidence']['confirmation_sampling']
    assert proof['initial_hit_count'] == proof['final_hit_count'] == 1
    assert r.perception.objects()[0]['completion_classification'] == 'pending'
    if observed_turn < 1:
        assert proof['recovery_attempt']['reason'] == 'restore_turn_below_legal_minimum'
        assert proof['recovery_attempt']['success'] is False
        assert len(r.bridge.calls) == 1
    else:
        assert proof['recovery_attempt']['success']
        assert len(r.bridge.calls) == 2
        assert r.bridge.calls[1][0] == 'turn'
        assert r.bridge.calls[1][1]['angleDeg'] == pytest.approx(-observed_turn)
