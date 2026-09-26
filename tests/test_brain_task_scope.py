"""Task counts come from instructions; completion requires a distinct ledger."""
import copy
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.task import parse_task, completion_progress


def ledger(ids=("red-a", "red-b")):
    rows, events = [], []
    for index, oid in enumerate(ids):
        rows.append({"id": oid, "category": "red-ball", "state": "DELIVERED",
                     "ever_confirmed": True})
        events.extend([
            {"action": "pick", "object_id": oid, "holding": True,
             "original_position_absent": True,
             "evidence": {"holding": True, "post_observation": 10 + index}},
            {"action": "place", "object_id": oid, "holding": False,
             "ball_in_storage": True, "simulation_time_s": 20 + index,
             "delivery_alias": {"witness_id": "alias-" + oid},
             "evidence": {"holding": False, "candidate_witnesses": 1,
                "release_observation": {"frame_id": str(20 + index),
                    "preexisting_ball_ids": list(ids[:index])},
                "placement": {"frame_id": str(30 + index), "ball_category": "red-ball",
                    "ball_bbox": {"x": 10 + index, "y": 10, "w": 5, "h": 5},
                    "storage_bbox": {"x": 5, "y": 5, "w": 50, "h": 50}}}}])
    return rows, events


def progress(rows, events, **kwargs):
    options = dict(holding=False, nodes=1, unexplored=7)
    options.update(kwargs)
    return completion_progress(rows, events, parse_task("把两个红球送到绿色存放区"), **options)


def test_count_and_scope_only_from_instruction():
    assert parse_task("把两个红球送到绿色存放区")["required_count"] == 2
    assert parse_task("把3颗红球送到绿色存放区")["required_count"] == 3
    assert parse_task("把地图上的红球都送到绿色存放区")["required_count"] is None
    with pytest.raises(ValueError):
        parse_task("把零个红球送到绿色存放区".replace("零", "0"))


def test_two_distinct_deliveries_allow_done_without_exploring_map():
    rows, events = ledger()
    rows.append({"id": "uncertain-history", "category": "red-ball", "state": "LOST",
                 "ever_confirmed": False})
    result = progress(rows, events, nodes=0)
    assert result["ready_for_done"] is True
    assert result["delivered_count"] == 2 and result["unexplored_exits"] == 7


def test_insufficient_quantity_rejects_even_when_roads_complete():
    result = progress(*ledger(("red-a",)), unexplored=0)
    assert result["ready_for_done"] is False
    assert "required_delivery_count_not_met" in result["unmet_conditions"]


def test_duplicate_events_rows_and_aliases_do_not_count_twice():
    rows, events = ledger(("red-a",))
    rows.extend([copy.deepcopy(rows[0]), dict(rows[0], id="alias-red-a", alias_of="red-a")])
    events.extend(copy.deepcopy(events))
    result = progress(rows, events)
    assert result["delivered_count"] == 1 and not result["ready_for_done"]


def test_one_pixel_witness_cannot_discharge_two_identities():
    rows, events = ledger()
    events[3]["evidence"]["placement"] = copy.deepcopy(events[1]["evidence"]["placement"])
    result = progress(rows, events)
    assert not result["ready_for_done"]
    assert set(result["unresolved_identity_ids"]) == {"red-a", "red-b"}


def test_actuator_success_and_delivered_labels_are_insufficient():
    rows, _ = ledger()
    result = progress(rows, [{"action": "release", "completed": True}])
    assert result["delivered_count"] == 0 and not result["ready_for_done"]


def test_verified_outside_release_recovery_carries_one_canonical_obligation():
    rows, events = ledger()
    rows.append({"id": "old-a", "category": "red-ball", "state": "LOST", "ever_confirmed": True})
    events.insert(0, {"action": "release_recovery", "object_id": "old-a",
                      "recovered_object_id": "red-a", "outside_storage": True})
    result = progress(rows, events)
    assert result["ready_for_done"] and result["delivered_count"] == 2
    assert result["resolved_release_recovery_identities"] == ["old-a"]


@pytest.mark.parametrize("state", ["HELD", "RELEASED_UNVERIFIED"])
def test_unresolved_manipulation_blocks_known_quantity_completion(state):
    rows, events = ledger()
    rows.append({"id": "unresolved", "category": "red-ball", "state": state})
    assert not progress(rows, events)["ready_for_done"]


def test_unknown_quantity_keeps_exploration_obligation():
    rows, events = ledger()
    result = completion_progress(rows, events,
        parse_task("把地图上的红球都送到绿色存放区"), holding=False, nodes=1, unexplored=1)
    assert not result["ready_for_done"]
    assert "road_exploration_incomplete" in result["unmet_conditions"]


def test_done_rechecks_fresh_holding_instead_of_stale_ready_flag():
    rows, events = ledger()
    runtime = SimpleNamespace(task_spec=parse_task("把两个红球送到绿色存放区"),
        perception=SimpleNamespace(objects=lambda: rows, action_evidence=lambda: events),
        roads=SimpleNamespace(nodes=[], unexplored=lambda: 20),
        held_object_id=None, pending_grasp=None,
        snapshot={"observation_index": 1, "observation": {"frameId": "1"},
                  "odometry": {"tick": 1}, "holding": {"holding": False}})
    def observe():
        runtime.snapshot.update(observation_index=2, holding={"holding": True})
    runtime.observe = observe
    assert Actions(runtime).done()["success"]
    result = Actions(runtime).execute({"action": "done", "params": {}})
    assert result["success"] is False
    assert result["evidence"]["after_observation"] == 2


def test_repeat_rejection_reason_and_recovery_options_reach_next_model_state():
    from autonomous_brain.run import compact_action_result
    result = {"success": False, "reason": "action_repeat_without_new_evidence",
              "evidence": {"canonical_object_id": "red-a", "previous_failure": "place_motion_not_verified",
                           "recovery_options": ["look_around_for_changed_target_or_road_evidence"]}}
    compact = compact_action_result(3, {"action": "place", "params": {}}, result, 15)
    assert compact["evidence"] == result["evidence"]
