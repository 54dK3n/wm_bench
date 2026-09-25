"""Offline postcondition regression against copied frozen source, no live I/O.

Expected baseline: three failing postconditions and two passing evidence checks.
This is deliberately outside the default test suite.
"""
import copy
import importlib
import json
import math
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
package = types.ModuleType("_junction_frozen")
package.__path__ = [str(HERE / "baseline_source" / "autonomous_brain")]
sys.modules[package.__name__] = package
actions_module = importlib.import_module("_junction_frozen.actions")
navigation = importlib.import_module("_junction_frozen.navigation")


def reproduce(before, after, motion):
    runtime = types.SimpleNamespace(snapshot=copy.deepcopy(before), round=motion["round"],
                                    roads=navigation.RoadMemory())
    runtime.roads.update(before["odometry"], before["road"])
    calls, recorded = [], []

    def call(method, params):
        assert not calls, "only one saved actuator response is available"
        assert method == motion["method"] and params == motion["params"]
        calls.append({"method": method, "params": copy.deepcopy(params)})
        return copy.deepcopy(motion["actuator_result"])

    def observe():
        assert len(calls) == 1
        runtime.snapshot = copy.deepcopy(after)
        runtime.roads.update(after["odometry"], after["road"])

    runtime.observe = observe
    runtime.bridge = types.SimpleNamespace(seconds=before["simulation_seconds"], max_seconds=1200, call=call)
    runtime.perception = types.SimpleNamespace(objects=lambda: runtime.snapshot["objects"])
    runtime.motion_log = types.SimpleNamespace(write=lambda item: recorded.append(copy.deepcopy(item)))
    result = actions_module.Actions(runtime).explore()
    return result, calls, recorded, runtime


def main():
    data = json.loads((HERE / "public-excerpts.json").read_text())
    observations = {o["observation_index"]: o for o in data["observations"]}
    rounds = {r["round"]: r for r in data["rounds"]}
    checks, cases = [], []
    for motion in data["motions"]:
        before = observations[motion["before_observation"]]
        after = observations[motion["after_observation"]]
        result, calls, recorded, runtime = reproduce(before, after, motion)
        original = rounds[motion["round"]]["result"]
        # Runtime wrapper alone adds these two fields after Actions.explore().
        expected = copy.deepcopy(original)
        expected["evidence"].pop("before_observation")
        expected["evidence"].pop("final_observation")
        assert result == expected, "offline replay diverged from the saved action result"
        assert recorded == [motion], "the saved public actuator call was not reproduced exactly"
        assert not runtime.roads.blocked and not runtime.roads.nodes
        check = {"name": f"r{motion['round']}_no_success_without_observed_node",
                 "passed": result["success"] is False,
                 "expected_success": False, "actual_success": result["success"],
                 "actual_reason": result["reason"]}
        checks.append(check)
        cases.append({"round": motion["round"], "before_observation": before["observation_index"],
                      "after_observation": after["observation_index"], "action_result": result,
                      "calls": calls, "exact_saved_motion_reproduced": True,
                      "road": after["road"], "odometry": after["odometry"]})
    unchanged = all(observations[m["before_observation"]][key] == observations[m["after_observation"]][key]
                    for m in data["motions"] for key in ("odometry", "road", "simulation_seconds"))
    absent = all(not o["road"]["atNode"] and not o["road"]["atJunction"] and not o["road"]["exits"]
                 for o in data["observations"])
    zero = all(m["actuator_result"]["distanceCm"] == 0 and m["actuator_result"]["elapsedTicks"] == 0
               for m in data["motions"])
    checks.append({"name": "three_actual_observation_pairs_have_no_motion_or_node",
                   "passed": unchanged and absent and zero})
    budgets = [actions_module.road_translation_limit(o["road"], "forward", 2)[0]
               for o in data["observations"]]
    checks.append({"name": "existing_road_budget_forbids_unaligned_forward",
                   "passed": all(value == 0 for value in budgets), "permitted_cm": budgets})
    failed = sum(not check["passed"] for check in checks)
    print(json.dumps({"source_version": actions_module.VERSION,
                      "network_or_robot_calls": 0,
                      "checks": checks, "cases": cases,
                      "passed": len(checks) - failed, "failed": failed,
                      "interpretation": "Expected baseline failures demonstrate a false-positive action postcondition; no fix is applied."},
                     ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
