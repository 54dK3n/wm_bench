#!/usr/bin/env python3
"""Independent offline bridge audit, using the actual platform AST transformer.

Public actions below are explicit software-test doubles, not native measurements
or task performance. No robot runner/driver/simulator is started.
"""
import ast
import asyncio
import contextlib
import hashlib
import io
import json
import math
from pathlib import Path
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(__file__).resolve().parent
PROGRAM = ROOT / "programs/world_model_opt2.py"
BASE = ROOT / "artifacts/inloop/opt-1/round-2/program.py"
WORKER = Path("/Users/ken/Desktop/robot_competition-main/projects/car-python/python-worker.js")
sys.path.insert(0, str(ROOT / "vendor/wm_kit_opt2"))
sys.path.insert(0, str(ROOT / "tools"))
from world_model import Detection, RobotPose, WorldModel
from world_model.types import ObjectState
from world_model.providers.guangyang import odometry_to_pose
from demo_report import static_checks


def functions(text):
    return {node.name: node for node in ast.parse(text).body
            if isinstance(node, ast.FunctionDef)}


def transformed_flow_test(transformer, names):
    """Execute real new selector+flow+WM API, abstract only physical actions."""
    model = WorldModel()
    for index in range(3):
        model.update([Detection(class_name="target", x=0., z=z, confidence=.9)
                      for z in (1., 1.6)], RobotPose(x=.2*index), now=float(index))
    originals = [obj.obj_id for obj in model.get_scene()]
    machine = {"holding": None, "completed": 0}
    odo = {"tick": 150, "rightCm": 0., "forwardCm": 0., "headingDeg": 0., "distanceCm": 0.}
    road = {"roadId": "synthetic", "roadProgressCm": 0., "onRoad": True}
    edge = {"roadId": "synthetic", "fromNodeId": "a", "toNodeId": "b", "lengthCm": 200., "oneWay": False}
    async def odometry(): return dict(odo)
    async def road_state(): return dict(road)
    async def remember(): return odometry_to_pose(odo), dict(road)
    async def task_state(): return {"completed": machine["completed"], "targetDelivered": machine["completed"] == 2}
    async def holding(): return machine["holding"]
    async def no_event(*args, **kwargs): return None
    async def approach(target): machine["holding"] = "目标物"; return True
    async def release(): machine["holding"] = None; machine["completed"] += 1; odo["tick"] += 1
    async def confirm(*args): return model.get_object(ns["STATE"]["confirmation_track_id"])
    async def deliver():
        return await ns["_demo_release_active_target"]({"holding": "target", "releaseAccepted": True,
                                                       "wouldCompleteDelivery": True})
    async def patrol(*args, **kwargs): raise AssertionError("both tracks already known")
    async def is_target(item): return item.get("category") == "target"
    async def calibrated(item, pose, now):
        position = ns["DEMO_STATE"]["deliveries"][0]
        return SimpleNamespace(x=position["x"], z=position["z"])
    ns = {"math": math, "json": json, "wm": model, "ObjectState": ObjectState,
          "odometry_to_pose": odometry_to_pose, "robot": SimpleNamespace(holding=holding),
          "NAV_STATE": {"queries": 0, "controls": 0, "cache": {"odometry": odo}},
          "NAVIGATION_QUERY_LIMIT": 1000, "TURN_COST_K": .060290462706043484,
          "MAX_OBSERVES": 92, "PATROL_OBSERVE_BUDGET": 92,
          "STATE": {"observe_count": 0, "approach_calls": 0}, "DELIVERY_LOG": {"on": False},
          "edge_by_road": {"synthetic": edge},
          "VP_STATE": {"roads": {"synthetic": [{"s": 0., "x": 0., "z": 0.},
                                                  {"s": 200., "x": 0., "z": 2.}]},
                       "intervals": {"synthetic": [[0., 200.]]}},
          "mission": {"storage": {"roadId": "synthetic", "progressCm": 0.}},
          "nav_odometry": odometry, "nav_road_state": road_state, "_vp_remember": remember,
          "nav_task_state": task_state, "motion_release": release, "_delivery_event": no_event,
          "approach_target_with_world_model": approach, "release_target_at_storage": deliver,
          "_try_enter_range_and_confirm": confirm, "patrol_until_target_seen": patrol,
          "_is_target": is_target, "calibrated_detection": calibrated}
    source = (ROOT / "programs/target_selection.py").read_text() + "\n" + (ROOT / "programs/opt2_flow_fragment.py").read_text()
    tree = transformer(names).visit(ast.parse(source))
    ast.fix_missing_locations(tree)
    exec(compile(tree, "<actual-transformed-selector-and-flow>", "exec"), ns)
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        asyncio.run(ns["run_target_flow"]())
        kept = asyncio.run(ns["_demo_filter_observations"]([
            {"category": "target", "distanceCm": 55.},
            {"category": "target", "distanceCm": 100.},
            {"category": "distractor", "distanceCm": 55.}], RobotPose()))
    events = [json.loads(line[3:]) for line in stdout.getvalue().splitlines() if line.startswith("GY ")]
    removals = [event for event in events if event["event"] == "wm_action_removed"]
    selections = [event for event in events if event["event"] == "target_selection"]
    ending = [event for event in events if event["event"] == "flow_end"][-1]
    assert len(removals) == len(selections) == 2
    assert all(event["removed"] and event["confidence"] == 0 and event["state"] == "lost" for event in removals)
    assert len({event["selected_track_id"] for event in selections}) == 2
    assert ending["success"] and ending["delivered_count"] == 2
    assert all(model.get_object(oid).confidence == 0 and model.get_object(oid).state == ObjectState.LOST for oid in originals)
    assert [item["category"] for item in kept] == ["target", "distractor"]
    assert kept[0]["distanceCm"] == 100
    return {"passed": True, "scope": "software doubles, not physical delivery evidence",
            "two_distinct_selection_ids": [item["selected_track_id"] for item in selections],
            "real_WM_action_api_transitions": removals,
            "async_exclusion_filter_preserves_capped_ray": True}


def main():
    source, baseline = PROGRAM.read_text(), BASE.read_text()
    new, old = functions(source), functions(baseline)
    worker = WORKER.read_text()
    module = {"ast": ast}
    exec(worker[worker.index("class AsyncRobotTransformer("):worker.index("student_run_target =")], module)
    transformer = module["AsyncRobotTransformer"]
    tree = transformer(set(new)).visit(ast.parse(source)); ast.fix_missing_locations(tree)
    compile(tree, str(PROGRAM), "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    generator_awaits = [{"line": node.lineno, "expression": ast.unparse(node)} for node in ast.walk(tree)
                        if isinstance(node, (ast.GeneratorExp, ast.Lambda)) and
                        any(isinstance(child, ast.Await) for child in ast.walk(node))]
    protected_names = [name for name in old if name.startswith(("nav_", "motion_"))] + [
        "_observe_motion", "query_observe", "_record_hit", "_confirmation_result", "_try_enter_range_and_confirm",
        "_update_wm", "calibrate_reading", "calibrated_detection", "uncalibrate_reading", "_approach_graph_navigation"]
    protected = {name: ast.dump(new[name]) == ast.dump(old[name]) for name in protected_names}
    sha = hashlib.sha256(source.encode()).hexdigest()
    static = static_checks(PROGRAM, [])
    # No task ran: do not synthesize a runtime program_version event or claim
    # runtime identity verification from a self-authored event.
    static.pop("program_identity")
    bridge = transformed_flow_test(transformer, set(new))
    report = {"program": str(PROGRAM), "program_sha256": sha,
              "runtime_program_version_not_observed": True,
              "actual_platform_transform_compile": True, "await_in_generator_or_lambda": generator_awaits,
              "protected_function_AST_unchanged": protected, "static_checks": static,
              "transformed_new_flow_with_real_WM": bridge,
              "confirmed_blocking_findings": [],
              "limits": ["Native task has not run; synthetic actions do not prove delivery or target identity.",
                         "P3 nominal k usage decision belongs to root; historical task residual failures remain.",
                         "Offline P3 oracle and final report reviewed separately by audit_batch."]}
    report["all_pass"] = not generator_awaits and all(protected.values()) and bridge["passed"] and all(v["status"] == "pass" for v in static.values())
    (OUT / "review.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"all_pass": report["all_pass"], "program_sha256": sha, "generator_awaits": generator_awaits,
                      "protected_functions": len(protected), "static_checks": static}, ensure_ascii=False))
    return 0 if report["all_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
