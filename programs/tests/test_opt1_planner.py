"""Opt1 regressions on synthetic roads; no simulator or competition coordinates."""
import ast
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from test_memory_approach import memory
from test_viewpoint_planner import StraightRoadRobot, edge, seed_local_direction


ROOT = Path(__file__).resolve().parents[2]
PROGRAM = ROOT / "artifacts/inloop/opt-1/round-2/program.py"
FROZEN = ROOT / "artifacts/inloop/stage-1/round-3/program.py"
TREE = ast.parse(PROGRAM.read_text())
FUNCTIONS = {
    "_road_progress_limit", "_road_progress_blocked", "_vp_block_revision", "dijkstra",
    "_vp_path", "_vp_block_current_direction", "_vp_travel", "_vp_explore",
    "_mag_frontiers", "_approach_graph_navigation", "_turn_around_and_block",
}


def opt1(progress=25, edges=None):
    ns, robot, target = memory(StraightRoadRobot(progress), edges)
    ns.update(nav_odometry=robot.odometry, nav_road_state=robot.road_state,
              motion_left_angle=robot.left_angle, motion_forward=robot.forward,
              motion_follow_road=robot.follow_road, motion_take_exit=Mock())
    nodes = [node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS]
    assert len(nodes) == len(FUNCTIONS)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(PROGRAM), "exec"), ns)
    seed_local_direction(ns, 0, 100)
    return ns, robot, target


def local_stop(ns, progress, direction, road="a"):
    ns["VP_STATE"].setdefault("local_blocks", {})[(road, direction, round(progress, 1))] = progress


def test_two_sided_local_obstacle_keeps_each_reachable_road_prefix():
    ns, robot, _ = opt1()
    local_stop(ns, 25, 1)
    local_stop(ns, 75, -1)
    back = ns["_vp_path"](robot.road_state(), "a", 0)
    assert back["direct"] and back["cost_cm"] == 25
    assert ns["_vp_path"](robot.road_state(), "a", 50) is None
    robot.progress = 75
    ahead = ns["_vp_path"](robot.road_state(), "a", 100)
    assert ahead["direct"] and ahead["cost_cm"] == 25
    assert ns["_vp_path"](robot.road_state(), "a", 50) is None
    assert ns["blocked_directions"] == set()


def test_local_barrier_blocks_full_edge_but_keeps_alternative_exit():
    ns, robot, _ = opt1(edges=[edge("a", "n0", "n1"), edge("b", "n0", "n2")])
    local_stop(ns, 25, 1)
    local_stop(ns, 75, -1)
    assert ns["dijkstra"]("n0", "n1") is None
    assert ns["dijkstra"]("n1", "n0") is None
    plan = ns["_vp_path"](robot.road_state(), "b", 30)
    assert plan["direction"] == -1 and plan["route"] == ["b"]
    assert plan["cost_cm"] == 55


def test_clearance_boundary_allows_stopping_there_but_not_crossing():
    ns, robot, _ = opt1(20)
    local_stop(ns, 25, 1)
    assert ns["_vp_path"](robot.road_state(), "a", 25)["cost_cm"] == 5
    assert ns["_vp_path"](robot.road_state(), "a", 30) is None
    robot.progress = 25
    assert ns["_road_progress_limit"]("a", 25, 35) == 25
    assert ns["_road_progress_limit"]("a", 25, 15) == 15


def test_actual_reverse_heading_is_not_guessed_from_half_road_position():
    ns, robot, _ = opt1(20)
    robot.heading = 180
    before = robot.road_state()
    assert ns["_vp_block_current_direction"](before)
    assert ns["VP_STATE"]["local_blocks"] == {("a", -1, 20.0): 20.0}
    assert ns["blocked_directions"] == set()
    assert not ns["_vp_block_current_direction"](before)


def test_delivery_turnaround_uses_the_same_local_boundary_semantics():
    ns, robot, _ = opt1(20)
    robot.heading = 180
    ns["_turn_around_and_block"]("a")
    assert ns["VP_STATE"]["local_blocks"] == {("a", -1, 20.0): 20.0}
    assert ns["blocked_directions"] == set()
    assert robot.calls == [("left_angle", 180)]


def test_local_block_keeps_reachable_five_cm_unknown_prefix():
    ns, robot, target = opt1(20)
    seed_local_direction(ns, 0, 20)
    local_stop(ns, 25, 1)
    pose, state = ns["_vp_remember"]()
    fronts = ns["_mag_frontiers"](pose, state, target, set())
    front = next(point for point in fronts if point["progressCm"] == 20 and point["direction"] == 1)
    assert front["endCm"] == 25
    robot.progress = 25
    seed_local_direction(ns, 0, 25)
    pose, state = ns["_vp_remember"]()
    assert not any(point["progressCm"] == 25 and point["direction"] == 1
                   for point in ns["_mag_frontiers"](pose, state, target, set()))


def test_unknown_gateway_cannot_take_cheap_opposite_endpoint_loop():
    ns, robot, _ = opt1(75)
    plan = ns["_vp_path"](robot.road_state(), "a", 0, enter_only=True)
    assert plan["direct"] and plan["cost_cm"] == 75
    assert plan["direction"] == -1


def test_unknown_other_road_gateway_binds_the_named_endpoint():
    ns, robot, _ = opt1(100, [edge("a", "n0", "n1"), edge("b", "n1", "n2")])
    plan = ns["_vp_path"](robot.road_state(), "b", 100, enter_only=True)
    assert plan["target_entry_node"] == "n2"
    assert plan["landing_progress_cm"] == 75
    assert plan["cost_cm"] == 125


def test_known_gateway_landing_is_not_selected_again_as_unknown():
    ns, _robot, target = opt1(100, [edge("a", "n0", "n1"), edge("b", "n1", "n2")])
    ns["VP_STATE"]["roads"]["b"] = [{"s": 25, "x": 0, "z": 1.25, "yaw": 0}]
    pose, state = ns["_vp_remember"]()
    fronts = ns["_mag_frontiers"](pose, state, target, set())
    assert not any(point["roadId"] == "b" and point["enter_only"] and point["progressCm"] == 0 for point in fronts)
    assert any(point["roadId"] == "b" and point["progressCm"] == 25 and point["direction"] == 1 for point in fronts)
    assert any(call.kwargs.get("reason") == "gateway_landing_already_measured"
               for call in ns["_approach_event"].call_args_list)


def test_first_unknown_gateway_still_costs_public_entry_distance():
    ns, _robot, target = opt1(100, [edge("a", "n0", "n1"), edge("b", "n1", "n2", one_way=True)])
    pose, state = ns["_vp_remember"]()
    front = next(point for point in ns["_mag_frontiers"](pose, state, target, set()) if point["roadId"] == "b")
    assert front["enter_only"] and front["path_cm"] == 25
    assert front["plan"]["landing_progress_cm"] == 25
    assert front["plan"]["target_entry_node"] == "n1"


def test_known_clearance_entry_can_reach_a_candidate_before_obstacle():
    ns, robot, _ = opt1(100, [edge("a", "n0", "n1"), edge("b", "n1", "n2")])
    local_stop(ns, 20, 1, "b")
    plan = ns["_vp_path"](robot.road_state(), "b", 10)
    assert plan["landing_progress_cm"] == 20
    assert plan["cost_cm"] == 30
    assert ns["_vp_path"](robot.road_state(), "b", 30) is None


def test_repeated_travel_without_motion_still_stops():
    ns, _robot, target = opt1(10)
    point = {"key": "a@50.0", "roadId": "a", "progressCm": 50, "path_cm": 40}
    ns["_mag_candidates"] = lambda _pose, _state, _target, tried: [] if point["key"] in tried else [point]
    ns["_mag_frontiers"] = Mock(return_value=[])
    ns["_vp_travel"] = Mock(return_value="replan")
    assert not ns["_approach_graph_navigation"](target)
    ns["_vp_travel"].assert_called_once()


def test_new_local_barrier_revision_allows_changed_route_at_same_pose():
    ns, robot, target = opt1(10)
    point = {"key": "a@50.0", "roadId": "a", "progressCm": 50, "path_cm": 40}
    ns["_mag_candidates"] = Mock(return_value=[point])
    def travel(_point):
        if not ns["VP_STATE"].get("local_blocks"):
            local_stop(ns, 25, 1)
        else:
            robot.progress = 60
        return "replan"
    ns["_vp_travel"] = Mock(side_effect=travel)
    assert ns["_approach_graph_navigation"](target)
    assert ns["_vp_travel"].call_count == 2


def test_measurement_confirmation_and_grab_functions_remain_frozen():
    old = ast.parse(FROZEN.read_text())
    names = {"calibrate_reading", "calibrated_detection", "_update_wm", "_record_hit",
             "_confirmation_result", "_try_enter_range_and_confirm", "approach_target_with_world_model"}
    def functions(tree):
        return {node.name: ast.dump(node, include_attributes=False) for node in tree.body
                if isinstance(node, ast.FunctionDef) and node.name in names}
    assert functions(TREE) == functions(old)
    assert len(functions(TREE)) == len(names)


def test_target_mission_anchor_fields_cannot_be_read_during_initialization():
    class ProtectedTarget(dict):
        def __getitem__(self, key):
            if key in ("roadId", "progressCm"):
                raise AssertionError("target anchor read")
            return super().__getitem__(key)
        def get(self, key, default=None):
            if key in ("roadId", "progressCm"):
                raise AssertionError("target anchor read")
            return super().get(key, default)
    node = next(node for node in TREE.body if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == "obstacle_anchors" for target in node.targets))
    ns = {"mission": {"objects": [ProtectedTarget(role="target"), {"role": "obstacle", "roadId": "blocked"}]}}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(PROGRAM), "exec"), ns)
    assert ns["obstacle_anchors"] == [{"role": "obstacle", "roadId": "blocked"}]
    assert not any(isinstance(node, ast.Name) and node.id in ("target_anchors", "mission_objects") for node in ast.walk(TREE))
