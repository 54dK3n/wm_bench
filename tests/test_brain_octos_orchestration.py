"""Small wiring checks; synthetic sensors/providers are not the live demo."""
import copy
from pathlib import Path

import pytest

from autonomous_brain.orchestration import LiveOrchestration, _load_executor
from test_brain_grab_authorization import AuthorizationRuntime


OCTOS = Path(__file__).resolve().parents[1] / "workspaces/octos_robots"


class Decisions:
    def __init__(self, actions):
        self.actions = iter(actions)
        self.call_count = 0
        self.last_record = None
        self.states = []

    def decide(self, state):
        self.call_count += 1
        self.states.append(copy.deepcopy(state))
        self.last_record = {"mode": "replay", "call_index": self.call_count}
        return next(self.actions)


def advance(r, adapter, number):
    r.round = number
    state = {"objects": r.perception.objects(), "holding": r.snapshot["holding"]["holding"]}
    before_held = r.held_object_id
    action, result = adapter.run_next(number, state)
    r.rounds.append({"round": number, "state": {"robot": {"held_object_id": before_held}},
        "action": action, "result": copy.deepcopy(result)})
    return result


def test_existing_executor_dispatches_real_actions_same_wm_and_observed_pick_release():
    r = AuthorizationRuntime()
    perception, wm = r.perception, r.perception.wm
    llm = Decisions([{"action": "pick", "params": {"object_id": r.object_id}},
                     {"action": "place", "params": {}}])
    adapter = LiveOrchestration(r, llm, OCTOS)
    assert adapter.executor.__class__.__module__ == "orchestrator.executor"
    assert adapter.executor.max_retries == 0
    assert advance(r, adapter, 1)["success"]
    first_trace = copy.deepcopy(adapter.last_trace)
    assert advance(r, adapter, 2)["success"]
    assert r.perception is perception and r.perception.wm is wm
    assert llm.states[1]["holding"] is True
    assert r.perception.get_object(r.object_id)["state"] == "DELIVERED"
    assert r.audit()["failures"] == []
    assert first_trace["run_id"] == adapter.last_trace["run_id"]
    assert first_trace["step_id"] != adapter.last_trace["step_id"]
    assert adapter.last_trace["judge"]["fresh_post_action_observation"]
    assert adapter.last_trace["bridge_commands"]["count"] > 0
    assert len(adapter.executor.log) == 2


def test_failed_actual_action_returns_once_without_executor_retry():
    r = AuthorizationRuntime()
    r.become_stale()
    llm = Decisions([{"action": "pick", "params": {"object_id": r.object_id}}])
    adapter = LiveOrchestration(r, llm, OCTOS)
    result = advance(r, adapter, 1)
    assert not result["success"]
    assert llm.call_count == len(adapter.executor.log) == 1
    assert r.grab_count == 0
    assert adapter.last_trace["judge"]["fresh_post_action_observation"]


def test_unknown_grab_receipt_propagates_without_resend():
    r = AuthorizationRuntime(fault="unknown_receipt")
    llm = Decisions([{"action": "pick", "params": {"object_id": r.object_id}}])
    adapter = LiveOrchestration(r, llm, OCTOS)
    r.round = 1
    with pytest.raises(ConnectionError, match="synthetic_grab_ack_loss"):
        adapter.run_next(1, {"objects": r.perception.objects()})
    assert r.grab_count == llm.call_count == 1
    assert r.pending_grasp is not None
    assert adapter.last_trace["bridge_commands"]["count"] > 0


def test_skill_success_without_post_observation_or_wm_evidence_is_rejected(monkeypatch):
    r = AuthorizationRuntime()
    llm = Decisions([{"action": "pick", "params": {"object_id": r.object_id}}])
    adapter = LiveOrchestration(r, llm, OCTOS)
    monkeypatch.setattr(r.actions, "execute", lambda action: {
        "success": True, "reason": "fake_completed", "evidence": {}})
    assert not advance(r, adapter, 1)["success"]
    assert adapter.last_trace["judge"]["fresh_post_action_observation"] is False


def test_done_uses_existing_completion_gate_after_observation():
    r = AuthorizationRuntime()
    llm = Decisions([{"action": "done", "params": {}}])
    adapter = LiveOrchestration(r, llm, OCTOS)
    assert not advance(r, adapter, 1)["success"]
    assert adapter.last_trace["judge"]["fresh_post_action_observation"]


def test_executor_requires_observation_judge_with_in_process_skills():
    executor, _ = _load_executor(OCTOS)
    with pytest.raises(ValueError, match="supplied together"):
        executor({"skills": []}, skill_runner=lambda *args: {"success": True})
