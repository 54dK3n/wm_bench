"""The final allowed decision must retain its actual observed outcome."""
import io
import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from autonomous_brain import run
from autonomous_brain.actions import Actions


class MemoryLog:
    def write(self, value):
        pass

    def close(self):
        pass


def run_fixture(tmp_path, max_rounds, done_round, *, unexplored=0, holding=False):
    runtimes, clients = [], []

    class SensorRuntime:
        def __init__(self, config, out):
            self.round = self.observation_count = 0
            self.recent = []
            self.held_object_id = self.pending_grasp = None
            self.bridge = SimpleNamespace(seconds=0, max_seconds=1200, log=MemoryLog())
            self.observation_log = self.motion_log = MemoryLog()
            self.perception = SimpleNamespace(objects=lambda: [], timeline=lambda: [],
                                             action_evidence=lambda: [])
            self.roads = SimpleNamespace(nodes=[{}], unexplored=lambda: unexplored,
                                         summary=lambda: [])
            self.real_actions = Actions(self)
            self.actions = SimpleNamespace(execute=self.execute, grab_attempts={})
            runtimes.append(self)

        def observe(self):
            self.observation_count += 1
            self.snapshot = {"observation_index": self.observation_count,
                "observation": {"frameId": self.observation_count},
                "odometry": {"tick": 0}, "holding": {"holding": holding}}

        def state(self):
            return {"round": self.round}

        def execute(self, action):
            if action["action"] == "done":
                return self.real_actions.execute(action)
            self.observe()
            return self.real_actions.result(True, "nonterminal_fixture")

    class RecordedClient:
        def __init__(self, **kwargs):
            self.call_count = self.total_elapsed_s = 0
            self.last_record = {}
            clients.append(self)

        def decide(self, state):
            self.call_count += 1
            return {"action": "done" if state["round"] == done_round else "look_around",
                    "params": {}}

        def close(self):
            pass

    out = tmp_path / "brain"
    with patch.object(run, "read_config", return_value={
            "task": "completion boundary fixture", "max_rounds": max_rounds}), \
            patch.object(run, "Runtime", SensorRuntime), \
            patch.object(run, "LLMClient", RecordedClient), \
            patch("sys.stdout", new_callable=io.StringIO):
        code = run.main(["--out", str(out)])
    summary = json.loads((out / "summary.json").read_text())
    rounds = [json.loads(line) for line in (out / "rounds.jsonl").read_text().splitlines()]
    assert clients[0].call_count == summary["rounds"] == len(rounds)
    return code, summary, rounds, runtimes[0]


@pytest.mark.parametrize("maximum,done_round", [(1, 1), (2, 1), (200, 199), (200, 200)])
def test_observed_done_is_accepted_through_the_last_allowed_round(tmp_path, maximum, done_round):
    code, summary, rounds, runtime = run_fixture(tmp_path, maximum, done_round)
    assert rounds[-1]["result"]["success"] is True
    assert rounds[-1]["result"]["reason"] == "explored_roads_and_observed_targets_completed"
    assert code == 0
    assert summary["status"] == "done"
    assert summary["reason"] == "observation_completion"
    assert summary["rounds"] == done_round
    # Actual Actions.execute(done) obtains fresh evidence before its Judge.
    evidence = rounds[-1]["result"]["evidence"]
    assert evidence["after_observation"] > evidence["before_observation"]
    assert runtime.observation_count == evidence["after_observation"]


@pytest.mark.parametrize("condition", [{"unexplored": 1}, {"holding": True}])
def test_last_round_done_still_requires_observational_gates(tmp_path, condition):
    code, summary, rounds, _ = run_fixture(tmp_path, 200, 200, **condition)
    assert rounds[-1]["result"]["success"] is False
    assert code == 1
    assert summary["status"] == "failed"
    assert summary["reason"] == "round_limit"
    assert summary["rounds"] == 200


def test_nonterminal_action_at_limit_does_not_get_an_extra_decision(tmp_path):
    code, summary, rounds, _ = run_fixture(tmp_path, 200, 201)
    assert rounds[-1]["result"]["success"] is True
    assert rounds[-1]["action"]["action"] == "look_around"
    assert code == 1
    assert summary["reason"] == "round_limit"
    assert summary["rounds"] == 200
