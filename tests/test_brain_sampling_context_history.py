"""Equivalent exhausted views persist across turns and discovery aliases."""
import copy

from test_brain_perception import ball
from test_brain_recovery_discovery import runtime, publish
from test_brain_sampling_progress import source_id


def checked_context(r, snapshot=None):
    # Isolate the progress gate from the separate source-pixel compatibility
    # gate. Actual Perception/WM supplies identity and hits; this function-level
    # probe assumes view eligibility and never grants a motion or confirmation.
    target = r.perception.discovery_target(source_id(r))
    target['sampling_allowed'] = True
    context = r.perception._sampling_progress().context(target, snapshot or r.snapshot)
    return target, context


def ready(r, snapshot=None):
    return r.perception._sampling_progress().readiness(*checked_context(r, snapshot))


def failed(r):
    target, context = checked_context(r)
    r.perception._sampling_progress().record(target, context, context,
        {'success': False, 'reason': 'confirmation_no_safe_independent_viewpoint', 'evidence': {}})


def view(r, heading=0, *, forward=0):
    r.bridge.heading = heading
    publish(r, forward=forward, items=[ball(80-forward, bearing=heading)])
    return ready(r)


def test_zero_ten_zero_rejects_the_older_exhausted_view_with_real_wm():
    r = runtime(); view(r); failed(r)
    original = copy.deepcopy(r.perception.objects()[0]['hit_poses'])
    novel = view(r, 10)
    assert novel['executable']
    assert novel['progress']['new_evidence_reason'] == 'changed_observed_view_direction'
    failed(r)
    returned = view(r)
    assert r.perception.objects()[0]['hit_poses'] == original
    assert not returned['executable']
    assert returned['progress']['blocking_failure']['after_observation'] == 1
    latest_alias = r.perception.discovery_evidence()['records'][-1]['id']
    assert not r.perception.sampling_readiness(latest_alias)['executable']


def test_cycle_then_real_hit_unlocks_all_old_contexts_without_erasing_them():
    r = runtime(); view(r); failed(r); view(r, 10); failed(r)
    result = view(r, forward=16)
    assert result['executable']
    assert result['progress']['new_evidence_reason'] == 'new_accepted_hit'
    assert result['progress']['attempt_count'] == 2
    assert r.perception.objects()[0]['hit_count'] == 2


def test_cycle_then_new_relevant_clearance_unlocks_and_return_to_old_does_not():
    r = runtime(); view(r); failed(r); view(r, 10); failed(r); view(r)
    fresh = copy.deepcopy(r.snapshot)
    fresh['road']['frontClearanceCm'] = 120
    result = ready(r, fresh)
    assert result['executable']
    assert 'changed_observed_road_constraint' in result['progress']['new_evidence_reasons']
    assert not ready(r)['executable']


def test_same_tick_new_angle_is_not_evidence_against_any_failure():
    r = runtime(); view(r); failed(r)
    fresh = copy.deepcopy(r.snapshot)
    fresh['odometry']['headingDeg'] = 10
    fresh['observation']['frameId'] = 'jitter'
    assert not r.perception.sampling_readiness(source_id(r), fresh)['executable']


def test_alias_merger_retains_failures_from_each_previous_canonical_group():
    from autonomous_brain.navigation_progress import SamplingProgress
    r = runtime(); view(r); failed(r)
    progress = r.perception._sampling_progress()
    first = progress.records[0]
    second = copy.deepcopy(first)
    second.update(hypothesis_id='other', aliases=['other'], object_ids=['other-object'])
    second['attempts'][0]['after_context']['pose']['headingDeg'] = 10
    progress.records.append(second)
    target = r.perception.discovery_target(source_id(r))
    target['hypothesis_ids'] += ['other']
    row = progress.find(target)
    assert len(row['attempts']) == 2
    assert {'other', source_id(r)} <= set(row['aliases'])
    assert len(progress.records) == 1


def test_real_recorded_reverse_path_unlocks_at_same_pose_without_new_hit():
    from test_brain_confirmation_sampling import sampling_runtime, discovery_id
    from test_brain_sampling_progress import failed as record_real_failure
    r = sampling_runtime()
    selected = discovery_id(r)
    assert r.snapshot['sampling_path_support']['reverse_lengths_cm'] == []
    record_real_failure(r)
    original = copy.deepcopy(r.perception.objects()[0]['hit_poses'])
    r.actions.move('backward', {'distanceCm': 20, 'speed': 30})
    r.actions.move('forward', {'distanceCm': 20, 'speed': 30})
    assert r.bridge.x == r.bridge.z == 0
    assert r.perception.objects()[0]['hit_poses'] == original
    result = r.perception.sampling_readiness(selected)
    assert result['executable']
    assert result['progress']['new_evidence_reason'] == 'new_verified_reverse_path_option'
    record_real_failure(r)
    r.bridge.tick += 1
    r.observe()
    assert not r.perception.sampling_readiness(selected)['executable']
