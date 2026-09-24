"""Memory/cruise scope must not leak into confirmation, including exceptions."""
import ast
import asyncio
from pathlib import Path

import pytest

from tools.platform_paths import platform_root, platform_worker

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / "programs/src/opt2_motion_fragment.py").read_text()


def namespace():
    ns = {"CRUISE_SPEED": 100, "DEMO_STATE": {"ball_index": 1}}
    exec(SOURCE, ns)
    return ns


@pytest.mark.parametrize("fail", [False, True])
def test_memory_speed_scope_restored_even_on_failure(fail):
    ns = namespace()
    def travel(target):
        assert target == "remembered-object"
        assert ns["OPT2_MOTION_STATE"]["memory_travel_active"] is True
        if fail:
            raise ValueError("road blocked")
        return True
    ns["_approach_graph_navigation"] = travel
    if fail:
        with pytest.raises(ValueError):
            ns["_opt2_memory_navigation"]("remembered-object")
    else:
        assert ns["_opt2_memory_navigation"]("remembered-object") is True
    assert ns["OPT2_MOTION_STATE"]["memory_travel_active"] is False


@pytest.mark.parametrize("ball,expected", [(1, 30), (2, 100)])
def test_first_patrol_unchanged_second_uses_existing_cruise(ball, expected):
    ns = namespace()
    ns["DEMO_STATE"]["ball_index"] = ball
    ns["_vp_follow"] = lambda distance, speed: (distance, speed)
    assert ns["_opt2_patrol_follow"](150, 30) == (150, expected)


@pytest.mark.parametrize("ball", [1, 2])
def test_exit_speed_scope_does_not_affect_subsequent_confirmation(ball):
    ns = namespace()
    ns["DEMO_STATE"]["ball_index"] = ball
    def enter(road):
        assert ns["OPT2_MOTION_STATE"]["memory_travel_active"] == (ball > 1)
        return road
    ns["_vp_enter"] = enter
    assert ns["_opt2_patrol_enter"]("public-road") == "public-road"
    assert ns["OPT2_MOTION_STATE"]["memory_travel_active"] is False


def test_actual_platform_async_wrapper_awaits_before_restoring_scope():
    platform = platform_worker()
    worker = platform.read_text()
    loader = {"ast": ast}
    exec(worker[worker.index("class AsyncRobotTransformer("):worker.index("student_run_target =")], loader)
    tree = ast.parse(SOURCE)
    names = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
    names.update({"_approach_graph_navigation", "_vp_follow", "_vp_enter"})
    tree = loader["AsyncRobotTransformer"](names).visit(tree)
    ast.fix_missing_locations(tree)
    ns = {"CRUISE_SPEED": 100, "DEMO_STATE": {"ball_index": 2}}
    exec(compile(tree, "motion", "exec"), ns)
    async def travel(target):
        await asyncio.sleep(0)
        assert ns["OPT2_MOTION_STATE"]["memory_travel_active"] is True
        return target
    ns["_approach_graph_navigation"] = travel
    assert asyncio.run(ns["_opt2_memory_navigation"]("target")) == "target"
    assert ns["OPT2_MOTION_STATE"]["memory_travel_active"] is False


@pytest.mark.parametrize("fail", [False, True])
def test_actual_outer_student_scope_reads_speed_and_restores_after_nested_calls(fail):
    """The worker nests source assignments and helpers, not module globals."""
    worker = platform_worker().read_text()
    loader = {"ast": ast}
    exec(worker[worker.index("class AsyncRobotTransformer("):worker.index("student_run_target =")], loader)
    delivery_tree = ast.parse((ROOT / "programs/src/opt2_delivery_fragment.py").read_text())
    speed_node = next(node for node in delivery_tree.body
                      if isinstance(node, ast.FunctionDef) and node.name == "_opt2_travel_speed")
    source = SOURCE + '\n' + ast.unparse(speed_node) + '''
CRUISE_SPEED = 100
SLOW_SPEED = 30
DELIVERY_LOG = {"on": False}
DEMO_STATE = {"ball_index": 1}
seen = []
def _vp_enter(road):
    seen.append(("enter", DEMO_STATE["ball_index"], _opt2_travel_speed()))
    if FAIL:
        raise ValueError("exit failure")
    return road
def _approach_graph_navigation(target):
    seen.append(("memory", _opt2_travel_speed()))
    if FAIL:
        raise ValueError("memory failure")
    return target
for ball in (1, 2):
    DEMO_STATE["ball_index"] = ball
    try:
        _opt2_patrol_enter("public-road")
    except ValueError:
        pass
    seen.append(("after_enter", _opt2_travel_speed()))
try:
    _opt2_memory_navigation("remembered")
except ValueError:
    pass
seen.append(("after_memory", _opt2_travel_speed()))
return seen
'''.replace("FAIL", repr(fail))
    tree = ast.parse(source)
    names = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
    transformed = loader["AsyncRobotTransformer"](names).visit(tree)
    outer = ast.AsyncFunctionDef(name="__student_main__", args=ast.arguments(
        posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]),
        body=transformed.body, decorator_list=[], returns=None, type_comment=None)
    module = ast.fix_missing_locations(ast.Module(body=[outer], type_ignores=[]))
    namespace = {}
    exec(compile(module, "<actual-outer-student-scope>", "exec"), namespace)
    assert asyncio.run(namespace["__student_main__"]()) == [
        ("enter", 1, 30), ("after_enter", 30),
        ("enter", 2, 100), ("after_enter", 30),
        ("memory", 100), ("after_memory", 30)]
    assert "OPT2_MOTION_STATE" not in namespace
