"""In-process bindings to the user's existing octos_robots Executor.

This is its framework-independent orchestrator, not an external Octos runtime.
It owns dispatch and EXECUTE/JUDGE transitions; run.py retains the only task
loop, Runtime, WorldModel and LLMClient. No mock skill script is used here.
"""
from __future__ import annotations

import copy
import hashlib
import importlib
import inspect
import json
from pathlib import Path
import subprocess
import sys
import uuid


ACTION_NAMES = ("explore", "look_around", "go_to", "pick", "place", "done")
REGISTRY = {"skills": [{"name": name,
    "description": f"Existing autonomous_brain.actions.Actions.{name}",
    "params": ({"object_id": {"type": "string", "required": True}}
               if name in {"go_to", "pick"} else {}),
    "impl": "autonomous_brain.actions.Actions.execute"} for name in ACTION_NAMES]}


def _sha(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _load_executor(root):
    root = Path(root).resolve()
    expected = root / "orchestrator" / "executor.py"
    if not expected.is_file():
        raise ValueError("octos_robots Executor source is missing")
    package = sys.modules.get("orchestrator")
    if package is not None and Path(package.__file__).resolve() != root / "orchestrator" / "__init__.py":
        raise ValueError("another orchestrator package is already loaded")
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    module = importlib.import_module("orchestrator.executor")
    if Path(module.__file__).resolve() != expected:
        raise ValueError("Executor import does not match configured octos_robots source")
    required = {"decision_provider", "skill_runner", "judge_callback"}
    if not required <= set(inspect.signature(module.Executor).parameters):
        raise ValueError("octos_robots Executor lacks live callback support; use the pinned integration revision")
    return module.Executor, expected


def orchestrator_provenance(root):
    executor, source = _load_executor(root)
    revision = subprocess.run(["git", "-C", str(Path(root).resolve()), "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True).stdout.strip()
    return {"kind": "octos_robots.Executor", "configured_root": str(Path(root).resolve()),
        "revision": revision, "executor_file": str(source),
        "executor_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "class": f"{executor.__module__}.{executor.__name__}", "entry": "run_next",
        "max_retries": 0, "external_octos_runtime": False,
        "decision_provider": "autonomous_brain.llm.LLMClient.decide",
        "skill_runner": "autonomous_brain.actions.Actions.execute",
        "judge_callback": "autonomous_brain.orchestration.LiveOrchestration._judge",
        "registered_skills": list(ACTION_NAMES)}


class LiveOrchestration:
    """Thin callbacks around one persistent runtime; no independent task loop."""

    def __init__(self, runtime, llm, root):
        executor, _ = _load_executor(root)
        self.runtime, self.llm = runtime, llm
        self.provenance = orchestrator_provenance(root)
        self.run_id = uuid.uuid4().hex
        self.last_action = None
        self.last_trace = None
        self._raw_result = None
        self.executor = executor(REGISTRY, max_retries=0, verbose=False,
            decision_provider=self._decide, skill_runner=self._execute,
            judge_callback=self._judge)

    def _decide(self, state):
        action = self.llm.decide(state)
        self.last_action = copy.deepcopy(action)
        self.last_trace["model"] = {"first_call": self._before_calls + 1,
            "last_call": self.llm.call_count,
            "record": {key: (self.llm.last_record or {}).get(key) for key in
                ("call_index", "decision_index", "request_sha256", "response_model")},
            "source": "replay" if (self.llm.last_record or {}).get("mode") == "replay" else "live_api"}
        return {"skill": action["action"], "args": copy.deepcopy(action["params"])}

    def _execute(self, name, args, attempt):
        if attempt != 1:
            raise RuntimeError("live platform skills must never be implicitly retried")
        self.last_trace["dispatch"] = {"class": self.provenance["class"],
            "entry": "Executor.run_next -> run_step -> _dispatch -> _execute",
            "skill": name, "args": copy.deepcopy(args), "attempt": attempt,
            "runner": self.provenance["skill_runner"]}
        self._raw_result = self.runtime.actions.execute({"action": name, "params": args})
        return self._raw_result

    def _judge(self, step, result):
        r, trace = self.runtime, self.last_trace
        snapshot = r.snapshot
        after = snapshot["observation_index"]
        evidence = result.get("evidence", {})
        action = step["skill"]
        # Actions.execute already acquires the fresh sensor snapshot. Requiring
        # its exact boundary prevents a skill report alone from passing JUDGE.
        fresh = (after > trace["before_observation"]
            and evidence.get("before_observation") == trace["before_observation"]
            and evidence.get("final_observation", evidence.get("after_observation")) == after)
        supported, basis = fresh and result.get("success") is True, "existing_actions_postcondition"
        holding = snapshot["holding"]["holding"]
        objects = r.perception.objects()
        ledger = r.perception.action_evidence()
        ledger_refs = []
        if action in {"pick", "place"}:
            object_id = (step["args"].get("object_id") if action == "pick"
                         else evidence.get("object_id"))
            state = "HELD" if action == "pick" else "DELIVERED"
            ledger_refs = [index for index, event in enumerate(ledger, 1)
                if index > trace["before_ledger_count"] and event.get("action") == action
                and event.get("object_id") == object_id]
            supported = (supported and bool(ledger_refs)
                and any(row["id"] == object_id and row["state"] == state for row in objects)
                and holding is (action == "pick")
                and r.pending_grasp is None
                and r.held_object_id == (object_id if action == "pick" else None))
            basis = "same_perception_lifecycle_and_manipulation_evidence"
        elif action == "done":
            # Reuse the existing quantity/identity/exploration completion gate
            # against the fresh post-action snapshot, never a skill success bit.
            supported = supported and r.actions.done()["success"] is True
            basis = "existing_actions_done_on_post_action_world_model"
        trace["judge"] = {"success": bool(supported), "basis": basis,
            "fresh_post_action_observation": fresh, "after_observation": after,
            "holding": holding, "ledger_event_indices": ledger_refs,
            "world_model_after_sha256": _sha(objects)}
        return {"success": bool(supported),
            "detail": result["reason"] if bool(supported) == bool(result.get("success"))
                else "orchestrator_post_observation_does_not_verify_skill",
            "evidence": copy.deepcopy(trace["judge"])}

    def run_next(self, number, state):
        r = self.runtime
        self.last_action, self._raw_result = None, None
        self._before_calls = self.llm.call_count
        before_sequence = r.bridge.sequence
        self.last_trace = {"run_id": self.run_id, "step_id": f"{self.run_id}:{number}",
            "round": number, "before_observation": r.snapshot["observation_index"],
            "world_model_state_sha256": _sha(state),
            "state_ref": {"file": "rounds.jsonl", "round": number, "field": "state"},
            "before_ledger_count": len(r.perception.action_evidence())}
        try:
            dispatched = self.executor.run_next(number, state)
            verdict = dispatched["verdict"]
            result = copy.deepcopy(self._raw_result) if self._raw_result is not None else {
                "success": False, "reason": verdict["detail"], "evidence": {}}
            if result["success"] != verdict["success"]:
                result["evidence"]["actions_report_before_orchestrator_judge"] = {
                    "success": result["success"], "reason": result["reason"]}
                result.update(success=verdict["success"], reason=verdict["detail"])
            return copy.deepcopy(self.last_action), result
        finally:
            self.last_trace["bridge_commands"] = {
                "file": "bridge-calls.jsonl", "first_sequence": before_sequence + 1,
                "last_sequence": r.bridge.sequence,
                "count": r.bridge.sequence - before_sequence}
            self.last_trace["after_observation"] = r.snapshot["observation_index"]
            self.last_trace["llm_calls"] = self.llm.call_count - self._before_calls
