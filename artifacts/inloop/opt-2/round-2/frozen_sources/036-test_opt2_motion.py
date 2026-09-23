"""Memory/cruise scope must not leak into confirmation, including exceptions."""
import ast
import asyncio
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / "programs/opt2_motion_fragment.py").read_text()


def namespace():
    ns = {"CRUISE_SPEED": 100, "DEMO_STATE": {"ball_index": 1}}
    exec(SOURCE, ns)
    return ns


@pytest.mark.parametrize("fail", [False, True])
def test_memory_speed_scope_restored_even_on_failure(fail):
    ns = namespace()
    def travel(target):
        assert target == "remembered-object"
        assert ns["OPT2_MEMORY_TRAVEL_ACTIVE"] is True
        if fail:
            raise ValueError("road blocked")
        return True
    ns["_approach_graph_navigation"] = travel
    if fail:
        with pytest.raises(ValueError):
            ns["_opt2_memory_navigation"]("remembered-object")
    else:
        assert ns["_opt2_memory_navigation"]("remembered-object") is True
    assert ns["OPT2_MEMORY_TRAVEL_ACTIVE"] is False


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
        assert ns["OPT2_MEMORY_TRAVEL_ACTIVE"] == (ball > 1)
        return road
    ns["_vp_enter"] = enter
    assert ns["_opt2_patrol_enter"]("public-road") == "public-road"
    assert ns["OPT2_MEMORY_TRAVEL_ACTIVE"] is False


def test_actual_platform_async_wrapper_awaits_before_restoring_scope():
    platform = Path("/Users/ken/Desktop/robot_competition-main/projects/car-python/python-worker.js")
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
        assert ns["OPT2_MEMORY_TRAVEL_ACTIVE"] is True
        return target
    ns["_approach_graph_navigation"] = travel
    assert asyncio.run(ns["_opt2_memory_navigation"]("target")) == "target"
    assert ns["OPT2_MEMORY_TRAVEL_ACTIVE"] is False
