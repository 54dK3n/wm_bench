"""Keep the failed identity observation across recovery and the final observe.

Synthetic sensors exercise real Perception/WM/Actions. Comparator-only cases
below model changes in evidence, not successful physical grabs.
"""
import copy

import pytest

from autonomous_brain.navigation_progress import grasp_identity_change
from test_brain_approach_identity import confirmed_scene
from test_brain_recovery_discovery import publish


def failed_then_hidden():
    r, oid, old = confirmed_scene(old_x=8, old_count=14)
    action = {'action': 'pick', 'params': {'object_id': oid}}
    original = copy.deepcopy(r.actions._manipulation_failure_context(action)[1])
    failed_observation = r.snapshot['observation_index']

    def recovery(_trajectory):
        # A recovery view loses the target; Perception really sees no pixels.
        publish(r, forward=32)
        return {'success': True, 'reason': 'synthetic_recovery_view', 'motions': []}

    r.actions.return_place_path = recovery
    outcome = r.actions.execute(action)
    assert outcome['reason'] == 'grab_identity_competition'
    assert not outcome['success'] and not r.perception._grab_authorizations
    assert r.perception.grasp_identity_context(oid)['candidate_ids_by_detection'] == []
    stored = next(iter(r.navigation_progress.action_failures.values()))[-1]
    return r, oid, old, action, original, failed_observation, outcome, stored


def test_failure_boundary_keeps_full_competitors_after_recovery_and_final_observe():
    r, oid, old, action, original, index, result, stored = failed_then_hidden()
    assert stored['context']['grasp_identity'] == original['grasp_identity']
    assert len(stored['context']['grasp_identity']['related_object_ids']) == 15
    assert stored['context']['observation_ref']['observation_index'] == index
    assert all(pose['frame_id'] for poses in
        stored['context']['grasp_identity']['accepted_independent_hit_poses'].values() for pose in poses)
    assert stored['recovery_context']['grasp_identity']['candidate_ids_by_detection'] == []
    assert stored['recovery_context']['observation_ref']['observation_index'] > index
    # Mutating the returned report cannot mutate the internal failure lock.
    result['evidence']['identity_failure_context']['context']['grasp_identity']['related_object_ids'].clear()
    assert set(stored['context']['grasp_identity']['related_object_ids']) == set(old + [oid])
    compact = r.actions.navigation_state()[0]['manipulation_failures'][0]['last_failure']
    assert 'recovery_context' not in compact
    assert len(stored['context']['grasp_identity']['related_object_ids']) == 15


def new_view(before, oid):
    after = copy.deepcopy(before)
    after['grasp_identity_authorized'] = True
    after['grasp_identity']['candidate_ids_by_detection'] = [[oid]]
    after['grasp_identity']['target_detection_indices'] = [0]
    after['grasp_identity']['accepted_independent_hit_poses'][oid].append({'x_m': .16, 'z_m': .32})
    return after


def test_only_target_new_hit_cannot_unlock_original_hidden_competitors():
    r, oid, old, action, before, _, _, stored = failed_then_hidden()
    after = new_view(before, oid)
    assert grasp_identity_change(before, after) is None
    key = next(iter(r.navigation_progress.action_failures))
    r.actions._manipulation_failure_context = lambda _: (key, after)
    assert r.actions.action_failure_guard(action)['reason'] == 'action_repeat_without_new_evidence'


@pytest.mark.parametrize('missing', ['empty_matrix', 'identity_context', 'single_target'])
def test_missing_original_competition_never_unlocks_from_one_targets_hit(missing):
    r, oid, _ = confirmed_scene(old_x=8)
    action = {'action': 'pick', 'params': {'object_id': oid}}
    key, before = r.actions._manipulation_failure_context(action)
    after = new_view(before, oid)
    if missing == 'identity_context':
        before.pop('grasp_identity')
    else:
        before['grasp_identity']['candidate_ids_by_detection'] = [] if missing == 'empty_matrix' else [[oid]]
        before['grasp_identity']['target_detection_indices'] = [] if missing == 'empty_matrix' else [0]
    after['heading_deg'] = before['heading_deg'] + 90
    r.navigation_progress.action_failures[key] = [{'reason': 'grab_identity_competition', 'context': before}]
    r.actions._manipulation_failure_context = lambda _: (key, after)
    assert grasp_identity_change(before, after) is None
    assert r.actions.action_failure_guard(action)['reason'] == 'action_repeat_without_new_evidence'


def test_separate_competitors_need_new_independent_unique_views_for_every_object():
    r, oid, old = confirmed_scene(old_x=8)
    _, before = r.actions._manipulation_failure_context({'action': 'pick', 'params': {'object_id': oid}})
    after = new_view(before, oid)
    other = old[0]
    after['grasp_identity']['candidate_ids_by_detection'].append([other])
    after['relevant_object_states'] = [(oid, 'CONFIRMED'), (other, 'CONFIRMED')]
    assert grasp_identity_change(before, after) is None
    after['grasp_identity']['accepted_independent_hit_poses'][other].append({'x_m': .16, 'z_m': .32})
    assert grasp_identity_change(before, after) == 'new_independent_unique_views_of_competing_objects'


def test_unstamped_failure_is_conservative_instead_of_using_recovery_identity():
    r, oid, _ = confirmed_scene(old_x=8)
    action = {'action': 'pick', 'params': {'object_id': oid}}
    r.actions.remember_action_result(action, {'success': False, 'reason': 'grab_identity_competition', 'evidence': {}})
    failure = next(iter(r.navigation_progress.action_failures.values()))[-1]
    assert failure['context'].get('identity_failure_context_missing') is True
    assert failure['recovery_context']['grasp_identity']['related_object_ids']


def test_canonical_failure_key_change_during_recovery_does_not_discard_origin():
    r, oid, _, action, before, _, result, stored = failed_then_hidden()
    key, endpoint = r.actions._manipulation_failure_context(action)
    # A verified association may merge the navigation record under an older
    # canonical key. Its original failed target and full context still belong
    # to this same action, even though the failure bucket has a new key.
    merged_key = ('pick', 'older-canonical-record')
    r.actions._manipulation_failure_context = lambda _: (merged_key, endpoint)
    original = copy.deepcopy(before)
    result['evidence']['identity_failure_context'] = {'action_key': list(key), 'context': original}
    r.actions.remember_action_result(action, result)
    retained = r.navigation_progress.action_failures[merged_key][-1]['context']
    assert retained == original
