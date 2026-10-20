"""Fresh retry feedback reaches the model without authorizing another grab.

Actuators/pixels here are synthetic; Actions, Perception, compacting and the
native transcript consumer are production components. No competition is run.
"""
import copy
import json
from unittest.mock import patch

import pytest

from autonomous_brain import chatgpt_transport
from autonomous_brain.llm import LLMClient, CHATGPT_VERSION, PICK_PROBE_FEEDBACK_PROMPT
from autonomous_brain.run import compact_action_result
from test_brain_chatgpt_transport import fixture as native_fixture, rows as native_rows
from test_brain_grab_authorization import actual_grabs
from test_brain_pick_missing_pixels import MissingRetryRuntime
from test_brain_pick_pixel_recovery import ClippedRetryRuntime


def action(runtime):
    return {"action": "pick", "params": {"object_id": runtime.object_id}}


@pytest.mark.parametrize("kind", [ClippedRetryRuntime, MissingRetryRuntime])
def test_refined_probe_feedback_uses_final_frame_and_preserves_failed_source(kind):
    r = kind()
    result = r.pick()
    original = copy.deepcopy(result)
    assert result["success"] is False and result["reason"] == "grab_identity_not_uniquely_visible"
    retry = result["evidence"]["pick_retry"]
    assert retry["schema"] == "fresh-pick-probe-retry/v1"
    assert retry["classification"] == "completed_empty_grab_probe_refined"
    assert retry["observation_index"] == r.snapshot["observation_index"]
    assert retry["frame_id"] == str(r.snapshot["observation"]["frameId"])
    assert retry["observation_index"] > result["evidence"]["authorization_recovery"]["after_observation"]
    assert retry["next_probe_limit_cm"] == 3 and retry["previous_limit_cm"] == 6
    summary = compact_action_result(r.round, action(r), result, r.snapshot["observation_index"])
    assert summary["success"] is False
    assert summary["reason"] == "completed_empty_grab_probe_refined"
    assert summary["original_reason"] == result["reason"]
    assert summary["evidence"]["grab_authorization"]["authorized"] is False
    assert summary["evidence"]["grab_authorization"]["observation_index"] < retry["observation_index"]
    assert summary["evidence"]["pick_retry"] == retry
    assert result == original
    assert len(actual_grabs(r)) == 1 and r.pending_grasp is None and r.held_object_id is None
    # The next model-selected pick gets a new proof and the reduced bound.
    assert not r.pick()["success"]
    assert len(actual_grabs(r)) == 2
    proofs = [row["result"]["evidence"]["attempts"][0]["grab_ref"] for row in r.rounds]
    assert proofs[0]["bridge_request_id"] != proofs[1]["bridge_request_id"]
    assert proofs[0]["before_observation"] < proofs[1]["before_observation"]


@pytest.mark.parametrize("bad", ["schema", "classification", "wrong_frame", "wrong_object", "success"])
def test_compact_never_reclassifies_an_unbound_or_unrecognized_retry(bad):
    r = ClippedRetryRuntime()
    result = r.pick()
    retry = result["evidence"]["pick_retry"]
    if bad == "schema": retry["schema"] = "unrecognized"
    elif bad == "classification": retry["classification"] = "grasp_observed"
    elif bad == "wrong_frame": retry["observation_index"] -= 1
    elif bad == "wrong_object": retry["object_id"] = "another-object"
    else: result["success"] = True
    summary = compact_action_result(r.round, action(r), result, r.snapshot["observation_index"])
    assert summary["reason"] == result["reason"]
    assert "pick_retry" not in summary["evidence"]


@pytest.mark.parametrize("bad", ["unknown_motion", "unknown_grab", "road_return", "inverse_return",
    "exhausted", "no_reduction", "stale_bound", "holding", "pending", "held", "off_road",
    "clipped", "missing", "competition", "legacy_pixels", "same_recovery_frame"])
def test_fresh_retry_requires_both_known_path_and_current_supported_identity(bad):
    r = ClippedRetryRuntime()
    result = r.pick()
    result["evidence"].pop("pick_retry")
    e = result["evidence"]
    if bad == "unknown_motion": e["pick_trajectory"][-1]["outcome_unknown"] = True
    elif bad == "unknown_grab": e["attempts"][0]["grab_ref"]["outcome_unknown"] = True
    elif bad == "road_return": e["road_return"]["success"] = False
    elif bad == "inverse_return": e["authorization_recovery"]["success"] = False
    elif bad == "exhausted": e["retry_probe"]["requires_new_view"] = True
    elif bad == "no_reduction": e["retry_probe"]["previous_limit_cm"] = e["retry_probe"]["limit_cm"]
    elif bad == "stale_bound": r.actions._pick_probe_limits[r.object_id]["limit_cm"] = 6
    elif bad == "holding": r.snapshot["holding"]["holding"] = True
    elif bad == "pending": r.pending_grasp = {"object_id": r.object_id}
    elif bad == "held": r.held_object_id = r.object_id
    elif bad == "off_road": r.snapshot["road"]["onRoad"] = False
    elif bad == "same_recovery_frame": r.snapshot["observation_index"] = e["retry_probe"]["restored_observation"]
    else:
        detection = next(d for d in r.snapshot["perception"]["detections"] if d["category"] == "red-ball")
        if bad == "clipped": detection["bbox"]["y"] = 480-detection["bbox"]["h"]
        elif bad == "missing": r.snapshot["perception"]["detections"] = []
        elif bad == "competition": r.snapshot["perception"]["detections"].append(copy.deepcopy(detection))
        elif bad == "legacy_pixels": detection.pop("pixel_quality")
    count = len(r.bridge_records)
    r.actions.record_fresh_pick_retry(action(r), result)
    assert "pick_retry" not in result["evidence"]
    assert result["reason"] == "grab_identity_not_uniquely_visible"
    assert len(r.bridge_records) == count  # The helper is read-only, including no automatic observe/grab.


class FinalFrameLossRuntime(ClippedRetryRuntime):
    def observe(self, *, motion=None):
        # Only execute's final observation loses the target; the inverse frame
        # itself was supported and already learned a bound.
        if motion is None and self.inverse_attempts:
            self.override_items = []
        return super().observe(motion=motion)


def test_execute_does_not_use_restored_anchor_when_final_observation_loses_pixels():
    r = FinalFrameLossRuntime()
    result = r.pick()
    assert result["evidence"]["authorization_recovery"]["success"]
    assert result["evidence"]["retry_probe"]["limit_cm"] == 3
    assert "pick_retry" not in result["evidence"]
    assert not r.snapshot["perception"]["detections"]
    assert len(actual_grabs(r)) == 1


def test_actual_native_request_receives_new_bound_and_keeps_model_choice(tmp_path, monkeypatch):
    r = ClippedRetryRuntime()
    result = r.pick()
    summary = compact_action_result(r.round, action(r), result, r.snapshot["observation_index"])
    state = {"task": "把两个红球送到绿色存放区", "objects": [
        {"id": r.object_id, "category": "red-ball", "status": "CONFIRMED"}],
        "robot": {"holding": False}, "junction_history": [], "recent_actions": [summary]}
    monkeypatch.setenv("LLM_TRANSPORT", chatgpt_transport.TRANSPORT)
    monkeypatch.setenv("LLM_MODEL", chatgpt_transport.MODEL)
    sent = []

    def native_response(request, timeout_s):
        sent.append(copy.deepcopy(request))
        # A synthetic native reply bound to the actual request, selecting
        # explore proves feedback never forces the model to choose pick.
        rows = native_rows()
        for row in rows:
            item = (row.get("params") or {}).get("item") or {}
            if item.get("type") == "userMessage":
                item["content"][0]["text"] = json.dumps(request["messages"][1:], ensure_ascii=False, separators=(",", ":"))
        return "\n".join(json.dumps(row) for row in rows) + "\n"

    with patch.object(chatgpt_transport, "invoke", side_effect=native_response):
        with LLMClient(tmp_path/"calls.jsonl") as client:
            assert client.decide(state) == {"action": "explore", "params": {}}
    assert len(sent) == 1 and sent[0]["model"] == "gpt-6.1-sol"
    assert sent[0]["thinking"] == {"type": "low"}
    assert PICK_PROBE_FEEDBACK_PROMPT in sent[0]["messages"][0]["content"]
    received = json.loads(sent[0]["messages"][1]["content"])["recent_actions"][0]
    assert received["evidence"]["pick_retry"]["next_probe_limit_cm"] == 3
    assert received["reason"] == "completed_empty_grab_probe_refined"
    assert received["success"] is False and received["evidence"]["grab_authorization"]["authorized"] is False
    assert json.loads((tmp_path/"calls.jsonl").read_text())["version"] == CHATGPT_VERSION == "autonomous-brain-llm/v27"
    with patch.object(chatgpt_transport, "invoke", side_effect=AssertionError("no replay inference")):
        with LLMClient(tmp_path/"replay.jsonl", replay_path=tmp_path/"calls.jsonl") as client:
            assert client.decide(state) == {"action": "explore", "params": {}}
            client.assert_replay_consumed()
