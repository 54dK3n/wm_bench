"""Known empty receipts influence navigation, never identity or authorization.

Synthetic public sensors/actuator; real Actions, Perception and ledger audit.
Historical A31/A33 grab-count expectations remain unchanged in their files.
"""
import copy
import json
from unittest.mock import patch

import pytest

from autonomous_brain.actions import ObservedMotionFailure
from autonomous_brain.llm import LLMClient, CHATGPT_VERSION
from autonomous_brain import chatgpt_transport
from autonomous_brain.run import compact_action_result
from test_brain_chatgpt_transport import rows as native_rows
from test_brain_grab_authorization import actual_grabs
from test_brain_pick_pixel_recovery import ClippedRetryRuntime, commands
from test_brain_pick_missing_pixels import MissingRetryRuntime


@pytest.mark.parametrize("kind", [ClippedRetryRuntime, MissingRetryRuntime])
def test_revisited_empty_pose_uses_new_probe_before_fresh_grab(kind):
    r = kind(grab_results=(False, True))
    first = r.pick()
    assert not first["success"] and len(actual_grabs(r)) == 1
    assert first["evidence"]["retry_probe"]["limit_cm"] == 3
    second = r.pick()
    assert not second["success"] and len(actual_grabs(r)) == 1
    assert second["evidence"]["attempts"] == []
    assert [m["method"] for m in second["evidence"]["pick_trajectory"]] == ["forward", "backward"]
    assert second["evidence"]["authorization_recovery"]["success"]
    assert second["evidence"]["retry_probe"]["limit_cm"] == 1.5
    assert second["evidence"]["pick_retry"]["classification"] == "supported_approach_probe_refined"
    assert r.pending_grasp is None and r.held_object_id is None
    assert not r.perception.action_evidence()
    third = r.pick()
    assert third["success"] and third["reason"] == "grasp_observed"
    assert len(actual_grabs(r)) == 2 and len(third["evidence"]["attempts"]) == 1
    assert [p["distanceCm"] for p in commands(r, "forward")] == [6, 3, 1.5]
    old_ref = first["evidence"]["attempts"][0]["grab_ref"]
    new_ref = third["evidence"]["attempts"][0]["grab_ref"]
    assert old_ref["bridge_request_id"] != new_ref["bridge_request_id"]
    assert new_ref["authorization"]["observation_index"] == new_ref["before_observation"]
    assert new_ref["authorization"]["odometry"]["forwardCm"] > old_ref["authorization"]["odometry"]["forwardCm"] + .2
    assert r.audit()["failures"] == []


def test_three_grab_budget_is_spent_on_new_operation_poses_after_reentry():
    r = ClippedRetryRuntime(clip_gap=100)
    r.actions._pick_probe_limits[r.object_id] = {"limit_cm": 3, "requires_new_view": False}
    first = r.pick()
    assert first["reason"] == "three_grab_attempts_failed"
    old_positions = [a["grab_ref"]["authorization"]["odometry"]["forwardCm"] for a in first["evidence"]["attempts"]]
    assert len(old_positions) == 3
    r.actions.move("backward", {"distanceCm": 6, "speed": 20})
    second = r.pick()
    assert second["reason"] == "three_grab_attempts_failed"
    new_positions = [a["grab_ref"]["authorization"]["odometry"]["forwardCm"] for a in second["evidence"]["attempts"]]
    assert len(new_positions) == 3 and len(actual_grabs(r)) == 6
    assert all(min(abs(x-y) for y in old_positions) > .2 for x in new_positions)
    assert len(second["evidence"]["empty_grab_navigation"]) == 3
    assert len(r.actions._empty_grab_navigation[r.object_id]) == 3


def test_navigation_match_is_object_scoped_not_bbox_identity():
    r = ClippedRetryRuntime()
    r.pick()
    assert r.actions.empty_grab_navigation_hint(r.object_id) is not None
    assert r.actions.empty_grab_navigation_hint("different-object-at-same-pose") is None
    item = next(d for d in r.snapshot["perception"]["detections"] if d["category"] == "red-ball")
    item["bbox"]["h"] -= 2
    assert r.actions.empty_grab_navigation_hint(r.object_id) is not None
    r.snapshot["odometry"]["headingDeg"] += .21
    assert r.actions.empty_grab_navigation_hint(r.object_id) is None
    r.snapshot["odometry"]["headingDeg"] -= .21
    r.snapshot["odometry"]["rightCm"] += .21
    assert r.actions.empty_grab_navigation_hint(r.object_id) is None


@pytest.mark.parametrize("receipt", [{}, {"completed": False}, {"completed": True, "accepted": False},
                                    {"completed": True, "error": "rejected"}])
def test_returned_but_not_completed_grab_receipt_cannot_create_memory(receipt):
    class BadReceipt(ClippedRetryRuntime):
        def call(self, method, params):
            result = super().call(method, params)
            return copy.deepcopy(receipt) if method == "grab" else result
    r = BadReceipt()
    result = r.pick()
    assert not result["success"] and len(actual_grabs(r)) == 1
    assert r.actions._empty_grab_navigation == {}
    assert "retry_probe" not in result["evidence"]


@pytest.mark.parametrize("bad", ["missing_auth", "wrong_command", "unknown", "missing_ref"])
def test_empty_memory_requires_completed_command_bound_source(bad):
    r = ClippedRetryRuntime()
    result = r.pick()
    a = result["evidence"]["attempts"][0]
    ref = copy.deepcopy(a["grab_ref"])
    motion = result["evidence"]["pick_trajectory"][0]
    r.actions._empty_grab_navigation.clear()
    if bad == "missing_auth": ref.pop("authorization")
    elif bad == "wrong_command": ref["authorization"]["command_ref"]["bridge_request_id"] = "other"
    elif bad == "unknown": ref["outcome_unknown"] = True
    else: ref.pop("bridge_request_id")
    r.actions.remember_empty_grab_navigation(r.object_id, ref, motion, {"completed": True})
    assert r.actions._empty_grab_navigation == {}


@pytest.mark.parametrize("fault", ["partial", "unknown", "forward-unknown"])
def test_no_grab_probe_cannot_cross_failed_or_unknown_motion(fault):
    r = MissingRetryRuntime()
    r.pick()
    r.recovery_fault = fault
    previous = r.actions._pick_probe_limits[r.object_id]["limit_cm"]
    before = len(actual_grabs(r))
    if fault == "partial":
        result = r.pick()
        assert not result["success"]
        assert "retry_probe" not in result["evidence"]
    else:
        with pytest.raises(ConnectionError): r.pick()
    assert len(actual_grabs(r)) == before
    assert r.actions._pick_probe_limits[r.object_id]["limit_cm"] == previous
    assert r.actions._empty_grab_navigation == {}


def test_zero_translation_receipt_does_not_authorize_inverse_or_refinement():
    class ZeroProbe(ClippedRetryRuntime):
        zero = False
        def call(self, method, params):
            old = (self.right, self.forward, self.travelled)
            result = super().call(method, params)
            if self.zero and method == "forward":
                self.right, self.forward, self.travelled = old
            return result
    r = ZeroProbe()
    r.pick()
    r.zero = True
    before_grabs, before_back = len(actual_grabs(r)), len(commands(r, "backward"))
    result = r.pick()
    assert not result["success"] and result["reason"] == "pick_motion_not_verified"
    assert result["evidence"]["attempts"] == []
    assert "retry_probe" not in result["evidence"]
    assert len(actual_grabs(r)) == before_grabs and len(commands(r, "backward")) == before_back
    assert r.actions._empty_grab_navigation == {}


@pytest.mark.parametrize("receipt", [{}, {"completed": False}])
def test_navigation_forward_without_completed_receipt_never_refines_or_grabs(receipt):
    class IncompleteProbe(ClippedRetryRuntime):
        incomplete = False
        def call(self, method, params):
            result = super().call(method, params)
            return copy.deepcopy(receipt) if self.incomplete and method == "forward" else result
    r = IncompleteProbe()
    r.pick()
    r.incomplete = True
    result = r.pick()
    assert result["reason"] == "pick_probe_receipt_not_completed" and not result["success"]
    assert result["evidence"]["attempts"] == [] and len(actual_grabs(r)) == 1
    assert "retry_probe" not in result["evidence"] and "pick_retry" not in result["evidence"]
    assert r.actions._empty_grab_navigation == {}


@pytest.mark.parametrize("bad", ["competition", "missing", "clearance", "holding", "pending"])
def test_current_gate_still_precedes_navigation_memory(bad):
    r = ClippedRetryRuntime()
    r.pick()
    if bad == "competition":
        r.extra_items = [copy.deepcopy(r.snapshot["observation"]["detections"][0])]
        r.observe()
    elif bad == "missing": r.override_items = []; r.observe()
    elif bad == "clearance": r.snapshot["road"]["frontClearanceCm"] = 0
    elif bad == "holding": r.snapshot["holding"]["holding"] = True
    else: r.pending_grasp = {"object_id": r.object_id}
    before_grabs, before_forward = len(actual_grabs(r)), len(commands(r, "forward"))
    result = r.pick()
    assert not result["success"]
    assert len(actual_grabs(r)) == before_grabs and len(commands(r, "forward")) == before_forward


def test_approach_budget_exhaustion_never_falls_through_to_grab():
    r = ClippedRetryRuntime(clip_gap=100)
    r.actions._pick_probe_limits[r.object_id] = {"limit_cm": .39, "requires_new_view": False}
    first = r.pick()
    assert len(first["evidence"]["attempts"]) == 3
    r.actions.move("backward", {"distanceCm": .78, "speed": 20})
    r.actions._pick_probe_limits[r.object_id]["limit_cm"] = .1
    before = len(actual_grabs(r))
    # Call the component to isolate its internal ten-step bound: execute's
    # unchanged failure guard correctly rejects this manually reset old view.
    result = r.actions.pick(r.object_id)
    assert not result["success"] and result["reason"] == "pick_approach_view_budget_exhausted"
    assert result["evidence"]["attempts"] == []
    assert len(result["evidence"]["empty_grab_navigation"]) == 10
    assert len(actual_grabs(r)) == before


def test_existing_hint_is_cleared_by_incomplete_same_object_grab():
    class IncompleteLater(ClippedRetryRuntime):
        incomplete = False
        def call(self, method, params):
            result = super().call(method, params)
            return {} if self.incomplete and method == "grab" else result
    r = IncompleteLater()
    r.pick()
    assert r.actions._empty_grab_navigation
    r.incomplete = True
    r.clip_after = float("inf")
    result = r.pick()
    assert not result["success"]
    assert len(actual_grabs(r)) > 1
    assert r.actions._empty_grab_navigation == {}


def test_other_object_manipulation_and_release_clear_prior_navigation_hint():
    r = ClippedRetryRuntime()
    r.pick()
    original = copy.deepcopy(r.actions._empty_grab_navigation)
    r.pending_grasp = {"object_id": "another-object"}
    r.actions.move("grab", {})
    assert r.actions._empty_grab_navigation == {}
    r.pending_grasp = None
    r.actions._empty_grab_navigation = original
    r.actions.move("release", {})
    assert r.actions._empty_grab_navigation == {}


def test_no_grab_refinement_reaches_native_model_without_forcing_pick(tmp_path, monkeypatch):
    r = MissingRetryRuntime()
    r.pick(); result = r.pick()
    summary = compact_action_result(r.round, {"action": "pick", "params": {"object_id": r.object_id}},
                                    result, r.snapshot["observation_index"])
    assert summary["reason"] == "supported_approach_probe_refined" and summary["success"] is False
    assert summary["evidence"]["attempts"] == []
    state = {"task": "把两个红球送到绿色存放区", "objects": [{"id": r.object_id, "category": "red-ball", "status": "CONFIRMED"}],
             "robot": {"holding": False}, "junction_history": [], "recent_actions": [summary]}
    monkeypatch.setenv("LLM_TRANSPORT", chatgpt_transport.TRANSPORT)
    monkeypatch.setenv("LLM_MODEL", chatgpt_transport.MODEL)
    sent = []
    def response(request, timeout_s):
        sent.append(copy.deepcopy(request)); rows = native_rows()
        for row in rows:
            item = (row.get("params") or {}).get("item") or {}
            if item.get("type") == "userMessage":
                item["content"][0]["text"] = json.dumps(request["messages"][1:], ensure_ascii=False, separators=(",", ":"))
        return "\n".join(json.dumps(row) for row in rows)+"\n"
    with patch.object(chatgpt_transport, "invoke", side_effect=response):
        with LLMClient(tmp_path/"native.jsonl") as client:
            assert client.decide(state) == {"action": "explore", "params": {}}
    assert len(sent) == 1 and sent[0]["model"] == "gpt-6.1-sol"
    assert sent[0]["thinking"] == {"type": "low"}
    assert "没有抓取命令" in sent[0]["messages"][0]["content"]
    assert json.loads(sent[0]["messages"][1]["content"])["recent_actions"][0] == summary
    assert json.loads((tmp_path/"native.jsonl").read_text())["version"] == CHATGPT_VERSION == "autonomous-brain-llm/v22"
