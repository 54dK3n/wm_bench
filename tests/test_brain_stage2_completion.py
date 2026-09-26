"""Unknown quantity completion keeps explicit exploration/discovery obligations."""
import copy
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.task import completion_progress, parse_task
from test_brain_task_scope import ledger
from test_brain_completion_hypotheses import retired_hypothesis


def explored():
    return {"schema": "brain-road-exploration/v1", "complete": True,
            "pending_exit_count": 0, "unresolved_node_count": 0,
            "unresolved_connection_count": 0,
            "state_counts": {"unexplored": 0, "exploring": 0, "verified": 4,
                             "blocked": 0, "unresolved": 0}}


def progress(*, status=None, detections=None, extra_objects=()):
    rows, events = ledger()
    return completion_progress(rows + list(extra_objects), events,
        parse_task("把地图上的红球都送到绿色存放区"), holding=False, nodes=3, unexplored=0,
        exploration=explored() if status is None else status,
        observed_detections=[] if detections is None else detections,
        discovery_evidence={"schema": "brain-discovery-evidence/v1", "unresolved": []})


def test_unknown_quantity_can_complete_only_with_explicit_resolved_exploration():
    result = progress()
    assert result["ready_for_done"] and result["required_count"] is None
    assert result["delivered_count"] == 2


@pytest.mark.parametrize("state", ["unexplored", "exploring", "blocked", "unresolved"])
def test_old_zero_unexplored_counter_cannot_hide_pending_exit_state(state):
    status = explored()
    status["state_counts"][state] = 1
    # A forged old complete flag and zero aggregate cannot override the state.
    result = progress(status=status)
    assert not result["ready_for_done"]
    assert "road_exploration_incomplete" in result["unmet_conditions"]


@pytest.mark.parametrize("field", ["pending_exit_count", "unresolved_node_count", "unresolved_connection_count"])
def test_unresolved_graph_counts_block_done_even_if_complete_flag_is_true(field):
    status = explored()
    status[field] = 1
    assert not progress(status=status)["ready_for_done"]


@pytest.mark.parametrize("status", [{}, {"complete": True}, dict(explored(), schema="legacy"),
                                   dict(explored(), complete=False), dict(explored(), pending_exit_count=False)])
def test_missing_or_inconsistent_exploration_proof_is_not_completion(status):
    assert not progress(status=status)["ready_for_done"]


def test_unknown_keeps_archived_never_confirmed_discovery_unresolved():
    perception, oid, _ = retired_hypothesis()
    result = progress(extra_objects=perception.objects())
    assert oid in result["unresolved_discovery_ids"]
    assert "unconfirmed_discoveries_unresolved" in result["unmet_conditions"]
    # Known quantity still discharges its exact distinct delivery obligation.
    rows, events = ledger()
    known = completion_progress(rows + perception.objects(), events,
        parse_task("把两个红球送到绿色存放区"), holding=False)
    assert known["ready_for_done"]


def test_current_untracked_ambiguous_red_detection_prevents_unknown_done():
    detection = {"category": "red-ball", "frame_id": 9, "track_id": None,
                 "identity_ambiguity": {"candidate_ids": ["old", "released"]}}
    result = progress(detections=[detection])
    assert not result["ready_for_done"]
    assert "current_target_identity_ambiguity" in result["unmet_conditions"]
    assert result["current_target_ambiguities"][0]["track_id"] is None
    # Only fresh unresolved evidence blocks this check; it is not a permanent ban.
    assert progress(detections=[])['ready_for_done']


def test_persistent_untracked_discovery_is_not_erased_by_an_empty_current_view():
    rows, events = ledger()
    result = completion_progress(rows, events,
        parse_task("把地图上的红球都送到绿色存放区"), holding=False,
        nodes=3, unexplored=0, exploration=explored(), observed_detections=[],
        discovery_evidence={"schema": "brain-discovery-evidence/v1",
                            "unresolved": [{"id": "discovery-1", "frame_id": 4}]})
    assert not result["ready_for_done"]
    assert result["untracked_discovery_ids"] == ["discovery-1"]
    assert "untracked_target_discoveries_unresolved" in result["unmet_conditions"]


def test_done_rechecks_new_blocked_exit_in_fresh_post_action_state():
    rows, events = ledger()
    status = explored()
    runtime = SimpleNamespace(task_spec=parse_task("把地图上的红球都送到绿色存放区"),
        perception=SimpleNamespace(objects=lambda: rows, action_evidence=lambda: events,
            discovery_evidence=lambda: {"schema": "brain-discovery-evidence/v1", "unresolved": []}),
        roads=SimpleNamespace(nodes=[{}, {}, {}], unexplored=lambda: status["pending_exit_count"],
                              exploration_status=lambda: copy.deepcopy(status)),
        held_object_id=None, pending_grasp=None,
        snapshot={"observation_index": 1, "observation": {"frameId": 1},
                  "odometry": {"tick": 1}, "holding": {"holding": False},
                  "perception": {"detections": []}})
    assert Actions(runtime).done()["success"]
    def observe():
        runtime.snapshot.update(observation_index=2, observation={"frameId": 2})
        status.update(complete=False, pending_exit_count=1)
        status["state_counts"]["blocked"] = 1
    runtime.observe = observe
    result = Actions(runtime).execute({"action": "done", "params": {}})
    assert not result["success"]
    assert result["evidence"]["after_observation"] == 2
    assert result["evidence"]["exploration"]["state_counts"]["blocked"] == 1
