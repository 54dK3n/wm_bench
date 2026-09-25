#!/usr/bin/env python3
"""Read-only runner-order reproduction; all runtime I/O stays in memory."""
from contextlib import ExitStack
import hashlib
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from autonomous_brain import run
from autonomous_brain.actions import Actions


class MemoryLog:
    def __init__(self, *args):
        self.rows = []

    def write(self, row):
        self.rows.append(row)

    def close(self):
        pass


class SensorFixtureRuntime:
    """Supply an empty gripper, no pending red objects, and closed road memory."""
    def __init__(self, config, out):
        self.config, self.round, self.observation_count = config, 0, 0
        self.recent = []
        self.held_object_id = self.pending_grasp = None
        self.bridge = SimpleNamespace(seconds=0, max_seconds=1200, log=MemoryLog())
        self.observation_log, self.motion_log = MemoryLog(), MemoryLog()
        self.perception = SimpleNamespace(objects=lambda: [], timeline=lambda: [],
                                         action_evidence=lambda: [])
        self.roads = SimpleNamespace(nodes=[{"id": "synthetic-observed-node"}],
                                     unexplored=lambda: 0, summary=lambda: [])
        self.real_actions = Actions(self)
        self.actions = SimpleNamespace(execute=self.execute, grab_attempts={})

    def observe(self):
        self.observation_count += 1
        self.snapshot = {"observation_index": self.observation_count,
                         "observation": {"frameId": self.observation_count},
                         "odometry": {"tick": 0}, "holding": {"holding": False}}

    def state(self):
        return {"round": self.round}

    def execute(self, action):
        if action["action"] == "done":
            # Exercise the real fresh-observation path and actual done gates.
            return self.real_actions.execute(action)
        # Earlier rounds only advance the runner counter. No robot is created.
        self.observe()
        return self.real_actions.result(True, "synthetic_nonterminal_round")


def reproduce(max_rounds, done_round):
    captured, logs = [], []

    class Client:
        def __init__(self, **kwargs):
            self.call_count, self.total_elapsed_s, self.last_record = 0, 0, {}

        def decide(self, state):
            self.call_count += 1
            return {"action": "done" if state["round"] == done_round else "look_around",
                    "params": {}}

        def close(self):
            pass

    def memory_log(*args):
        log = MemoryLog()
        logs.append(log)
        return log

    with ExitStack() as stack:
        stack.enter_context(patch.object(run, "read_config", return_value={
            "task": "offline completion boundary fixture", "max_rounds": max_rounds}))
        stack.enter_context(patch.object(run, "Runtime", SensorFixtureRuntime))
        stack.enter_context(patch.object(run, "LLMClient", Client))
        stack.enter_context(patch.object(run, "JsonLog", side_effect=memory_log))
        stack.enter_context(patch.object(run, "dump", side_effect=lambda p, v: captured.append(v)))
        stack.enter_context(patch.object(Path, "exists", return_value=False))
        mkdir = stack.enter_context(patch.object(Path, "mkdir"))
        stack.enter_context(patch("sys.stdout", new_callable=io.StringIO))
        networks = [stack.enter_context(patch(name, side_effect=AssertionError("network forbidden")))
                    for name in ("urllib.request.urlopen", "urllib.request.OpenerDirector.open",
                                 "http.client.HTTPConnection.request", "socket.create_connection",
                                 "socket.socket.connect", "socket.socket.connect_ex",
                                 "socket.socket.sendto", "socket.getaddrinfo")]
        # This path is never created: mkdir, all logs, and summary writes are mocked.
        exit_code = run.main(["--out", str(ROOT / "unwritten-completion-fixture")])
        assert mkdir.call_count == 1
        assert not any(mock.call_count for mock in networks)
    final = logs[0].rows[-1]
    summary = captured[-1]
    assert final["round"] == done_round and final["action"]["action"] == "done"
    assert final["result"]["success"] is True
    return {"max_rounds": max_rounds, "done_round": done_round,
            "actual_done_success": final["result"]["success"],
            "actual_done_reason": final["result"]["reason"],
            "summary_status": summary["status"], "summary_reason": summary["reason"],
            "runner_exit_code": exit_code, "network_calls": 0, "robot_calls": 0}


def main():
    source_paths = sorted((ROOT / "autonomous_brain").glob("*.py"))
    hashes = lambda: {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                      for p in source_paths}
    before = hashes()
    cases = [reproduce(1, 1), reproduce(2, 1), reproduce(200, 199), reproduce(200, 200)]
    after = hashes()
    reproduced = all(
        row["actual_done_success"] and row["runner_exit_code"] == (1 if row["done_round"] == row["max_rounds"] else 0)
        and row["summary_reason"] == ("round_limit" if row["done_round"] == row["max_rounds"] else "observation_completion")
        for row in cases)
    result = {"scope": "offline_runner_termination_order", "runtime_version": run.RUNTIME_VERSION,
              "defect_reproduced": reproduced, "source_unchanged": before == after,
              "source_sha256_before": before, "source_sha256_after": after, "cases": cases,
              "real_model_called": False, "simulation_started": False,
              "historical_failure_causation_claimed": False}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    # Exit zero means this diagnostic reproduced the current defect, not a task pass.
    return 0 if reproduced and before == after else 1


if __name__ == "__main__":
    raise SystemExit(main())
