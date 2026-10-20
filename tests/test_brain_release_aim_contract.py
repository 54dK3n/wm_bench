"""Release planning diagnostics; fake transport is not a real model run."""
import copy
import json
from unittest.mock import patch

from autonomous_brain import chatgpt_transport as transport
from autonomous_brain.llm import LLMClient
from autonomous_brain.run import compact_action_result
from test_brain_pick_entry_native_contract import synthetic_reply


def failed_place():
    return {"success": False, "reason": "storage_release_identity_separation_unavailable",
        "evidence": {"holding": True, "release_aim": {
            "mode": "observed_free_ground_point", "source_frame": 588,
            "error": "storage_release_identity_separation_unavailable",
            "source_region": {"unbounded_snapshot": "excluded"},
            "identity_separation": {
                "schema": "brain-release-aim-identity-separation/v1",
                "required_distance_cm": 30., "preferred_distance_cm": 45.,
                "old_delivered_gate_cm": 15., "new_release_gate_cm": 30.,
                "delivered_object_ids": ["old"], "current_observed_delivered_ids": ["old"],
                "missing_delivered_ids": [], "candidate_count": 13,
                "eligible_candidate_count": 0, "best_candidate_separation_cm": 20.,
                "selected_minimum_separation_cm": None,
                "anchor_observation_refs": [{"internal": "excluded"}],
                "current_delivered_projections": [{"internal": "excluded"}],
                "rejected_counts": {"identity_gate_overlap": 3, "pixel_occupied": 10},
            }}}}


def test_compact_failed_aim_preserves_missing_permission_and_holding_without_raw_geometry():
    raw = failed_place()
    original = copy.deepcopy(raw)
    compact = compact_action_result(104, {"action": "place", "params": {}}, raw, 589)
    assert raw == original
    assert compact["success"] is False and compact["evidence"]["holding"] is True
    aim = compact["evidence"]["release_aim"]
    assert aim["error"] == raw["reason"]
    assert aim["identity_separation"]["eligible_candidate_count"] == 0
    assert aim["identity_separation"]["required_distance_cm"] == 30.
    assert aim["identity_separation"]["delivered_object_ids"] == ["old"]
    assert "excluded" not in json.dumps(compact)
    assert "不能release" in aim["recovery_guidance"]


def test_native_request_carries_failed_aim_and_retains_the_models_navigation_choice(monkeypatch, tmp_path):
    monkeypatch.setenv("LLM_TRANSPORT", transport.TRANSPORT)
    monkeypatch.setenv("LLM_MODEL", transport.MODEL)
    recent = compact_action_result(104, {"action": "place", "params": {}}, failed_place(), 589)
    state = {"task": "把两个红球送到绿色存放区",
        "objects": [{"id": "held", "status": "HELD", "category": "red-ball"},
                    {"id": "green", "status": "CONFIRMED", "category": "storage-zone"}],
        "robot": {"holding": True, "held_object_id": "held"},
        "completion": {"ready_for_done": False, "delivered_count": 1},
        "junction_history": [], "recent_actions": [recent]}
    action = {"action": "go_to", "params": {"object_id": "green"}}
    sent = []
    def invoke(request, timeout):
        sent.append(copy.deepcopy(request))
        return synthetic_reply(request, action)
    with patch.object(transport, "invoke", side_effect=invoke):
        with LLMClient(tmp_path / "native.jsonl") as client:
            assert client.decide(state) == action
    assert len(sent) == 1
    received = json.loads(sent[0]["messages"][1]["content"])
    assert received["recent_actions"] == [recent]
    assert received["robot"]["holding"] is True
    assert received["completion"]["delivered_count"] == 1
    assert sent[0]["model"] == transport.MODEL
    assert sent[0]["thinking"] == {"type": "low"}
