"""Navigation caching must work with the platform's actual async rewrite."""
import ast
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest


ROOT = Path(__file__).resolve().parents[1]


def load(robot, transformed=False):
    source = (ROOT / "navigation_cache_fragment.py").read_text()
    tree = ast.parse(source)
    ns = {"robot": robot, "json": json, "MissionFailure": type("MissionFailure", (Exception,), {})}
    if transformed:
        worker = Path("/Users/ken/Desktop/robot_competition-main/projects/car-python/python-worker.js").read_text()
        start = worker.index("class AsyncRobotTransformer(")
        end = worker.index("student_run_target =", start)
        transformers = {"ast": ast}
        exec(worker[start:end], transformers)
        names = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
        tree = transformers["AsyncRobotTransformer"](names).visit(tree)
        ast.fix_missing_locations(tree)
    exec(compile(tree, "navigation_cache_fragment.py", "exec"), ns)
    return ns


def test_unchanged_pose_queries_only_once_and_copy_cannot_corrupt_cache():
    odo, road = Mock(return_value={"tick": 0}), Mock(return_value={"onRoad": True})
    ns = load(SimpleNamespace(odometry=odo, road_state=road))
    ns["nav_odometry"]()["tick"] = 999
    assert ns["nav_odometry"]()["tick"] == 0
    assert ns["nav_road_state"]() == ns["nav_road_state"]()
    assert (odo.call_count, road.call_count, ns["NAV_STATE"]["queries"]) == (1, 1, 2)


@pytest.mark.parametrize("wrapper,method,args", [
    ("motion_forward", "forward", (5,)), ("motion_backward", "backward", (5,)),
    ("motion_left_angle", "left_angle", (10,)), ("motion_right_angle", "right_angle", (10,)),
    ("motion_follow_road", "follow_road", (10, 30, True)),
    ("motion_take_exit", "take_exit", ("road", 30, True)),
    ("motion_approach", "approach", ("target", 85, 1)),
    ("motion_grab", "grab", ()), ("motion_release", "release", ()),
    ("query_observe", "observe", (None, 0.0)),
])
def test_state_changing_calls_invalidate_both_sensors(wrapper, method, args):
    sensor = Mock(side_effect=[{"tick": 0}, {"tick": 10}])
    action = Mock(return_value={"accepted": True})
    ns = load(SimpleNamespace(odometry=sensor, **{method: action}))
    assert ns["nav_odometry"]()["tick"] == 0
    ns["NAV_STATE"]["cache"]["road_state"] = {"onRoad": True}
    ns[wrapper](*args)
    assert "road_state" not in ns["NAV_STATE"]["cache"]
    assert ns["nav_odometry"]()["tick"] == 10
    action.assert_called_once_with(*args)


@pytest.mark.parametrize("kind,limit,wrapper,args,method", [
    ("queries", 1000, "nav_odometry", (), "odometry"),
    ("controls", 300, "motion_follow_road", (10, 30, True), "follow_road"),
])
def test_api_budget_stops_before_an_illegal_extra_query(kind, limit, wrapper, args, method):
    api = Mock()
    ns = load(SimpleNamespace(**{method: api}))
    ns["NAV_STATE"][kind] = limit
    with pytest.raises(ns["MissionFailure"], match="budget_exhausted"):
        ns[wrapper](*args)
    api.assert_not_called()


def test_real_platform_transform_awaits_wrappers_and_sensor_results():
    async def run():
        robot = SimpleNamespace(odometry=AsyncMock(side_effect=[{"tick": 0}, {"tick": 25}]),
                                forward=AsyncMock(return_value=True))
        ns = load(robot, transformed=True)
        assert await ns["nav_odometry"]() == {"tick": 0}
        assert await ns["nav_odometry"]() == {"tick": 0}
        await ns["motion_forward"](5)
        assert await ns["nav_odometry"]() == {"tick": 25}
        assert robot.odometry.await_count == 2
        robot.forward.assert_awaited_once_with(5)
    asyncio.run(run())
