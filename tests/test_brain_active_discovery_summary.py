"""Bounded guidance selects evidence; it never changes discovery/WM obligations."""
import copy

from test_brain_perception import ball
from test_brain_recovery_discovery import runtime, publish, deliver
from autonomous_brain.perception import VERSION


def test_new_guidance_contract_has_a_distinct_perception_version():
    assert VERSION == 'autonomous-brain-perception/v12'


def test_current_reobserved_old_hypothesis_is_not_hidden_by_dict_insertion_order():
    r = runtime()
    publish(r, 25)
    original = r.perception.discovery_evidence()['records'][0]
    for index in range(1, 9):
        publish(r, 25, right=index * 100)
    publish(r, 25)
    summary = r.state()['discovery']
    assert summary['pending'][0]['hypothesis_id'] == original['hypothesis_id']
    assert summary['pending_count'] == 9
    assert summary['pending_record_count'] == 10
    assert len(summary['pending']) == 6


def test_old_source_query_follows_explicit_active_track_without_ledger_merge():
    r = runtime()
    publish(r, 80)
    first = r.perception.discovery_evidence()['records'][0]
    for _ in range(3):
        publish(r, 80)
    before = copy.deepcopy(r.perception.discovery_evidence())
    target = r.perception.discovery_target(first['id'])
    assert target['current_detection']['track_id'] == first['initial_object_id']
    assert target['current_record']['frame_id'] == '4'
    assert target['source'] == first
    assert target['confirmation']['missing_hit_count'] == 2
    assert target['confirmation']['accepted_hit_count'] == 1
    assert target['progress']['independent_view_count'] == 1
    assert target['progress']['new_independent_evidence'] is False
    assert r.perception.discovery_evidence() == before
    summary = r.state()['discovery']
    assert summary['pending_count'] == 0
    assert summary['candidate_count'] == 1
    assert summary['pending'][0]['hypothesis_id'] == first['hypothesis_id']


def test_new_frame_and_stationary_repeat_do_not_claim_sampling_progress():
    r = runtime()
    publish(r, 95)
    source = r.perception.discovery_evidence()['records'][0]
    initial = r.perception.discovery_target(source['id'])
    for _ in range(7):
        publish(r, 95)
    current = r.perception.discovery_target(source['id'])
    assert current['latest_discovery_id'] != initial['latest_discovery_id']
    assert current['progress']['last_progress_observation_index'] == 1
    assert current['progress']['independent_view_count'] == 1
    assert current['progress']['new_independent_evidence'] is False
    summary = r.perception.discovery_summary(current_discovery_id=source['id'])
    assert summary['pending'][0]['priority']['selected_with_new_evidence'] is False


def test_two_actual_separated_hits_show_remaining_confirmation_gap():
    r = runtime()
    publish(r, 80)
    source = r.perception.discovery_evidence()['records'][0]
    publish(r, 64, forward=16)
    target = r.perception.discovery_target(source['id'])
    assert target['confirmation']['required_hit_count'] == 3
    assert target['confirmation']['accepted_hit_count'] == 2
    assert target['confirmation']['missing_hit_count'] == 1
    assert target['confirmation']['min_hit_pose_gap_m'] == .15
    assert target['progress']['new_independent_evidence'] is True
    summary = r.perception.discovery_summary(current_discovery_id=source['id'])
    assert summary['pending'][0]['priority']['selected_with_new_evidence'] is True
    assert target['sampling_allowed'] is True


def test_selected_stale_source_cannot_hide_current_unconfirmed_candidate():
    r = runtime()
    publish(r, 25)
    old_id = r.perception.discovery_evidence()['records'][0]['id']
    publish(r, 80, right=200)
    current_id = r.perception.discovery_evidence()['records'][-1]['id']
    summary = r.perception.discovery_summary(current_discovery_id=old_id)
    assert summary['pending'][0]['source_discovery_id'] == current_id
    stale = r.perception.discovery_target(old_id)
    assert stale['sampling_allowed'] is False
    assert stale['reason'] == 'needs_fresh_observation'


def test_two_same_frame_identical_boxes_cannot_supply_unique_sampling_target():
    r = runtime()
    publish(r, items=[ball(95), ball(95)])
    sources = r.perception.discovery_evidence()['records']
    assert len(sources) == 2
    for source in sources:
        target = r.perception.discovery_target(source['id'])
        assert target['sampling_allowed'] is False
        assert target['reason'] == 'current_detection_not_unique'
    summary = r.perception.discovery_summary()
    assert len({x['hypothesis_id'] for x in summary['pending']}) == 2
    assert summary['pending_record_count'] == 2


def test_summary_is_a_bounded_copy_and_does_not_modify_full_evidence():
    r = runtime()
    for i in range(9):
        publish(r, 25, right=100 * i)
    before = copy.deepcopy(r.perception.discovery_evidence())
    state = r.perception.discovery_summary(limit=3)
    assert state['pending_count'] == 9 and len(state['pending']) == 3
    assert state['candidate_count'] == 9
    state['pending'][0]['bbox']['x'] = -1
    assert r.perception.discovery_evidence() == before
    assert r.perception.discovery_target('unknown-discovery') is None


def test_confirmed_target_is_reported_without_bypassing_existing_action_gate():
    r = runtime()
    publish(r, 80)
    source = r.perception.discovery_evidence()['records'][0]
    publish(r, 64, forward=16)
    publish(r, 48, forward=32)
    target = r.perception.discovery_target(source['id'])
    assert target['associated_object']['state'] == 'CONFIRMED'
    assert target['reason'] == 'target_confirmed'
    assert target['sampling_allowed'] is False
    assert r.perception.confirmed(target['associated_object']['id'])
    assert target['current_confirmation_corroborated'] is True


def test_proved_resolution_of_clipped_original_source_can_report_confirmation():
    r = runtime()
    publish(r, 140)
    source = r.perception.discovery_evidence()['records'][0]
    for forward in (56, 72, 88):
        publish(r, 140-forward, forward=forward)
    ledger = r.perception.discovery_evidence()
    assert source['id'] in {proof['discovery_id'] for proof in ledger['resolutions']}
    target = r.perception.discovery_target(source['id'])
    assert target['associated_object']['state'] == 'CONFIRMED'
    assert target['reason'] == 'target_confirmed'
    assert target['sampling_allowed'] is False
    assert target['current_confirmation_corroborated'] is True
    assert target['current_confirmation_evidence']['source_resolution_ref'] == source['id']


def test_delivery_and_manipulation_do_not_turn_historical_source_into_sampling_permission():
    r = runtime()
    for forward in (0, 16, 32):
        publish(r, 80-forward, forward=forward)
    source = r.perception.discovery_evidence()['records'][0]
    oid = r.perception.objects()[0]['id']
    deliver(r, oid)
    target = r.perception.discovery_target(source['id'])
    assert target['associated_object']['state'] == 'DELIVERED'
    assert target['sampling_allowed'] is False
    assert target['reason'] == 'already_delivered'


def test_unknown_manipulation_boundary_preserves_obligation_and_blocks_static_sampling_link():
    r = runtime()
    publish(r, 95)
    source = r.perception.discovery_evidence()['records'][0]
    r.perception.note_manipulation_boundary({'method': 'grab', 'before_observation': 1})
    publish(r, 95)
    target = r.perception.discovery_target(source['id'])
    assert target['sampling_allowed'] is False
    assert target['reason'] == 'manipulation_boundary_unresolved'
    assert len(r.perception.discovery_evidence()['unresolved']) == 2


def test_association_alone_does_not_override_incompatible_original_pixels():
    r = runtime()
    publish(r, 80)
    source = r.perception.discovery_evidence()['records'][0]
    # Same pixels after a translation describe a different static position.
    # A broad WM association may retain the track; it is not source pixel proof.
    publish(r, 80, right=5)
    target = r.perception.discovery_target(source['id'])
    assert target['current_detection']['track_id'] == source['initial_object_id']
    assert target['sampling_allowed'] is False
    assert target['reason'] == 'source_pixels_not_compatible'


def test_clipped_repeated_frames_do_not_become_progress_or_merge_obligations():
    r = runtime()
    for _ in range(3):
        publish(r, 140)
    ledger = r.perception.discovery_evidence()
    assert len({row['hypothesis_id'] for row in ledger['unresolved']}) == 3
    last = ledger['records'][-1]
    target = r.perception.discovery_target(last['id'])
    assert target['source']['position_is_range_clipped'] is True
    assert target['progress']['last_progress_observation_index'] == 1
    assert target['progress']['new_independent_evidence'] is False
    assert r.perception.discovery_summary()['pending_count'] == 3


def test_distinct_same_frame_sources_remain_distinct_summary_choices():
    r = runtime()
    publish(r, items=[ball(80, bearing=-20), ball(80, bearing=20)])
    summary = r.perception.discovery_summary()
    assert summary['candidate_count'] == 2
    assert len({row['hypothesis_id'] for row in summary['pending']}) == 2
    assert all(row['sampling_allowed'] for row in summary['pending'])
    assert len({row['associated_object_id'] for row in summary['pending']}) == 2


def test_confirmed_but_newly_occluded_is_not_a_fresh_confirmation_witness():
    r = runtime()
    for forward in (0, 16, 32):
        publish(r, 80-forward, forward=forward)
    source = r.perception.discovery_evidence()['records'][0]
    publish(r, forward=32)
    target = r.perception.discovery_target(source['id'])
    assert target['associated_object']['state'] == 'CONFIRMED'
    assert target['reason'] == 'target_confirmed'
    assert target['current_detection'] is None
    assert target['current_confirmation_corroborated'] is False


def test_confirmed_but_current_duplicate_boxes_are_not_unique_corroboration():
    r = runtime()
    for forward in (0, 16, 32):
        publish(r, 80-forward, forward=forward)
    source = r.perception.discovery_evidence()['records'][0]
    publish(r, forward=32, items=[ball(48), ball(48)])
    target = r.perception.discovery_target(source['id'])
    assert target['associated_object']['state'] == 'CONFIRMED'
    assert target['current_confirmation_corroborated'] is False


def test_confirmed_near_refresh_does_not_corroborate_confirmation_window():
    r = runtime()
    for forward in (0, 16, 32):
        publish(r, 80-forward, forward=forward)
    source = r.perception.discovery_evidence()['records'][0]
    publish(r, 30, forward=50)
    target = r.perception.discovery_target(source['id'])
    assert target['associated_object']['state'] == 'CONFIRMED'
    assert target['current_detection']['visibility_refresh_only'] is True
    assert target['current_confirmation_corroborated'] is False
