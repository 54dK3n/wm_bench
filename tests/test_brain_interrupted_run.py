"""Stop-controller wiring only: no robot or model service is started."""
import json
import signal
from types import SimpleNamespace

import pytest

from autonomous_brain import run


@pytest.mark.parametrize("mode", ["sigint_action", "sigint_decision", "keyboard_action",
                                  "sigterm_action", "second_sigint_action"])
def test_interruption_exports_stop_position_without_resubmitting(mode, tmp_path, monkeypatch):
    calls, runtimes, clients, closed = [], [], [], []
    prior_handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}

    class Client:
        def __init__(self, **_):
            self.call_count = 0
            self.total_elapsed_s = 0
            self.last_record = None
            clients.append(self)

        def validate_formal_configuration(self):
            return {"mode": "stop_fixture"}

        def decide(self, state):
            self.call_count += 1
            if mode == "sigint_decision":
                signal.raise_signal(signal.SIGINT)
            return {"action": "pick", "params": {"object_id": "target-stop"}}

        def close(self):
            closed.append("llm")

    class Runtime:
        def __init__(self, config, out):
            self.round = self.observation_count = 0
            self.snapshot = None
            self.held_object_id = self.pending_grasp = None
            self.recent = []
            self.bridge = SimpleNamespace(seconds=0, max_seconds=1200, sequence=0,
                                          log=SimpleNamespace(close=lambda: closed.append("bridge")))
            self.observation_log = SimpleNamespace(close=lambda: closed.append("observations"))
            self.motion_log = SimpleNamespace(close=lambda: closed.append("motions"))
            self.perception = SimpleNamespace(timeline=lambda: [], objects=lambda: [], action_evidence=lambda: [])
            self.roads = SimpleNamespace(summary=lambda: [])
            self.actions = SimpleNamespace(execute=self.execute, grab_attempts={})
            runtimes.append(self)

        def observe(self):
            self.observation_count += 1
            self.snapshot = {"observation_index": self.observation_count,
                "odometry": {"rightCm": 1, "forwardCm": 2, "headingDeg": 3, "tick": 4},
                "holding": {"holding": False}}

        def state(self):
            return {"fixture_observation": self.observation_count}

        def execute(self, action):
            calls.append(action)
            self.bridge.sequence = 1
            self.pending_grasp = {"object_id": "target-stop",
                                  "grab_ref": {"bridge_request_id": "brain-000001"}}
            if mode == "keyboard_action":
                raise KeyboardInterrupt
            signal.raise_signal(signal.SIGTERM if mode == "sigterm_action" else signal.SIGINT)
            if mode == "second_sigint_action":
                signal.raise_signal(signal.SIGINT)
            # First SIGINT did not interrupt the already issued action/readback.
            self.observe()
            self.pending_grasp = None
            return {"success": True, "reason": "observed_action_finished", "evidence": {}}

    monkeypatch.setattr(run, "LLMClient", Client)
    monkeypatch.setattr(run, "Runtime", Runtime)
    monkeypatch.setattr(run, "capture_world_model_provenance", lambda _: {"fixture": True})
    monkeypatch.setattr(run, "read_config", lambda: {"task": "把一个红球送到绿色存放区", "max_rounds": 2})
    out = tmp_path / mode
    assert run.main(["--out", str(out)]) == 1
    summary = json.loads((out / "summary.json").read_text())
    rounds = [json.loads(line) for line in (out / "rounds.jsonl").read_text().splitlines()]
    stop = summary["interruption"]
    safe = mode == "sigint_action"
    assert summary["status"] == ("aborted" if mode == "sigterm_action" else "interrupted")
    assert "not_started" not in summary["reason"]
    assert summary["rounds"] == summary["llm_calls"] == len(rounds) == 1
    assert stop["completed_rounds"] == int(safe)
    assert stop["active_round"] == 1 and stop["safe_action_boundary"] is safe
    assert stop["last_observation"] == (2 if safe else 1)
    assert stop["odometry"] == {"rightCm": 1, "forwardCm": 2, "headingDeg": 3, "tick": 4}
    assert len(calls) == (0 if mode == "sigint_decision" else 1)
    assert rounds[0]["result"]["success"] is safe
    unknown = not safe and mode != "sigint_decision"
    assert stop["action_outcome_unknown"] is unknown
    if unknown:
        assert summary["pending_grasp"]["grab_ref"]["bridge_request_id"] == "brain-000001"
        assert rounds[0]["result"]["evidence"]["outcome_unknown"] is True
    assert sorted(closed) == ["bridge", "llm", "motions", "observations"]
    assert {sig: signal.getsignal(sig) for sig in prior_handlers} == prior_handlers
