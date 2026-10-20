"""Public far-view step metadata; synthetic model transport, never a platform run."""
import copy
import json
from unittest.mock import patch

import pytest

from autonomous_brain import chatgpt_transport as transport
from autonomous_brain.llm import LLMClient
from autonomous_brain.run import compact_action_result
from test_brain_pick_entry_native_contract import synthetic_reply


def option():
    return {
        "schema": "brain-far-supported-view-approach/v1", "action": "go_to",
        "object_id": "target", "available": True, "reason": "observed_road_short_step_available",
        "handoff_observation": 10, "handoff_frame_id": "frame-10",
        "before_observation": 11, "after_observation": 12, "step_cm": 4.,
        "memory_distance_cm": 78., "current_visual_distance_cm": 70.,
        "steps_used": 1, "remaining_steps": 4, "travelled_cm": 4.,
        "commanded_cm": 4., "remaining_distance_cm": 16., "outcome_unknown": False,
    }


def test_compact_progress_preserves_budget_without_claiming_arrival_or_exposing_internal_state():
    raw = option()
    raw["internal_snapshot"] = {"private": "discard"}
    before = copy.deepcopy(raw)
    result = compact_action_result(3, {"action": "go_to", "params": {"object_id": "target"}},
        {"success": False, "reason": "far_supported_view_approach_progress",
         "evidence": {"far_supported_view_approach": raw,
                      "navigation_subgoal": {"object_id": "target", "operation_ready": False,
                          "standoff_ready": False, "far_supported_view_approach": raw}}}, 12)
    assert raw == before
    assert result["success"] is False
    assert result["reason"] == "far_supported_view_approach_progress"
    assert result["evidence"]["far_supported_view_approach"] == option()
    assert result["evidence"]["navigation_subgoal"]["far_supported_view_approach"] == option()
    assert result["evidence"]["navigation_subgoal"]["operation_ready"] is False
    assert "discard" not in json.dumps(result)


@pytest.mark.parametrize("choice", ["go_to", "explore"])
def test_native_transport_keeps_model_choice_when_bounded_road_step_is_available(
        choice, monkeypatch, tmp_path):
    monkeypatch.setenv("LLM_TRANSPORT", transport.TRANSPORT)
    monkeypatch.setenv("LLM_MODEL", transport.MODEL)
    state = {"task": "two red balls",
        "objects": [{"id": "target", "status": "CONFIRMED", "category": "red-ball"}],
        "robot": {"holding": False},
        "junction_history": [], "recent_actions": [],
        "navigation": [{"canonical_object_id": "target", "current_subgoal": {
            "object_id": "target", "operation_ready": False,
            "far_supported_view_approach": option()}}],
        "completion": {"ready_for_done": False, "delivered_count": 0}}
    action = {"action": choice, "params": {"object_id": "target"} if choice == "go_to" else {}}
    sent = []
    original = copy.deepcopy(state)
    def invoke(request, timeout):
        sent.append(copy.deepcopy(request))
        return synthetic_reply(request, action)
    with patch.object(transport, "invoke", side_effect=invoke):
        with LLMClient(tmp_path / "native.jsonl") as client:
            assert client.decide(state) == action
    assert len(sent) == 1 and state == original
    received = json.loads(sent[0]["messages"][1]["content"])
    assert received["navigation"] == state["navigation"]
    assert sent[0]["model"] == transport.MODEL
    assert sent[0]["thinking"] == {"type": "low"}
