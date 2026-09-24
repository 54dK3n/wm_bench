"""Offline public-API regression checks for the runtime viewpoint planner."""

import ast
import json
import math
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest


PROGRAMS = Path(__file__).resolve().parents[1]
FRAGMENT = PROGRAMS.parent / "artifacts/inloop/refactor/legacy_sources/viewpoint_planner_fragment.py"


def edge(name, start, end, length=100.0, one_way=False):
    return {"roadId": name, "fromNodeId": start, "toNodeId": end,
            "lengthCm": length, "oneWay": one_way}


class StraightRoadRobot:
    """Synthetic centimetre road; no competition layout or truth data."""

    def __init__(self, progress=0.0):
        self.progress = float(progress)
        self.heading = 0.0
        self.distance = 0.0
        self.lateral = 0.0
        self.blocked_signs = set()
        self.calls = []

    def odometry(self):
        return {"rightCm": self.lateral, "forwardCm": self.progress,
                "headingDeg": self.heading, "distanceCm": self.distance, "tick": len(self.calls)}

    def road_state(self):
        return {"onRoad": 0 <= self.progress <= 100, "roadId": "a", "roadIds": ["a"],
                "roadProgressCm": self.progress, "headingErrorDeg": 0.0,
                "lateralOffsetCm": self.lateral, "atNode": False, "exits": [],
                "fromNodeId": "n0", "toNodeId": "n1", "frontClearanceCm": None}

    def left_angle(self, degrees):
        assert 1 <= degrees <= 360
        self.heading = (self.heading + degrees) % 360
        self.calls.append(("left_angle", degrees))

    def align(self):
        self.heading = 0.0 if math.cos(math.radians(self.heading)) >= 0 else 180.0

    def _move(self, distance):
        sign = 1 if math.cos(math.radians(self.heading)) >= 0 else -1
        if sign in self.blocked_signs:
            return 0.0, "front_clearance"
        self.progress += sign * distance
        self.distance += distance
        return distance, "max_distance"

    def follow_road(self, distance, speed, obey_limit):
        assert 10 <= distance <= 500, "follow_road must never receive a 5cm grid step"
        self.calls.append(("follow_road", distance, self.heading))
        moved, reason = self._move(distance)
        return {"accepted": True, "distanceCm": moved, "stoppedBy": reason, "roadId": "a"}

    def forward(self, distance):
        assert 0.1 <= distance <= 500
        self.calls.append(("forward", distance, self.heading))
        self._move(distance)


def planner(robot=None, edges=None):
    robot = robot or StraightRoadRobot()
    edges = edges or [edge("a", "n0", "n1")]
    adjacency = {}
    for item in edges:
        adjacency.setdefault(item["fromNodeId"], []).append((item["toNodeId"], item["roadId"], item["lengthCm"]))
        adjacency.setdefault(item["toNodeId"], [])
        if not item["oneWay"]:
            adjacency[item["toNodeId"]].append((item["fromNodeId"], item["roadId"], item["lengthCm"]))
    ns = {
        "math": math, "json": json, "robot": robot,
        "odometry_to_pose": lambda odo: SimpleNamespace(
            x=odo["rightCm"] / 100, z=odo["forwardCm"] / 100,
            yaw_rad=-math.radians(odo["headingDeg"])),
        "align_to_current_road": robot.align,
        "_wrap_deg": lambda angle: (angle + 180) % 360 - 180,
        "uncalibrate_reading": lambda distance, _bearing: (distance - 6.7796) / 1.0187,
        "edge_by_road": {item["roadId"]: item for item in edges}, "adj": adjacency,
        "blocked_roads": set(), "blocked_directions": set(),
        "STATE": {"accepted_hits": []}, "VIEW_GRID_CM": 5.0,
        "CONFIRM_MIN_GAP_M": 0.15, "CONFIRM_LAST_MIN_DIST_M": 0.5,
        "CONFIRM_PREDICT_MIN_CM": 45.0, "CONFIRM_PREDICT_MAX_CM": 85.0,
        "APPROACH_FOLLOW_STEP_CM": 10.0, "NODE_NUDGE_CM": 2.0, "SLOW_SPEED": 30,
    }
    tree = ast.parse((PROGRAMS.parent / "artifacts/inloop/stage-1/round-3/program.py").read_text())
    dijkstra = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "dijkstra")
    exec(compile(ast.Module(body=[dijkstra], type_ignores=[]), "dijkstra", "exec"), ns)
    exec(compile(FRAGMENT.read_text(), str(FRAGMENT), "exec"), ns)
    ns["_vp_event"] = Mock()
    return ns, robot


def ray():
    return {"ray_x": 0.0, "ray_z": -1.0, "ux": 0.0, "uz": 1.0}


def seed_local_direction(ns, low=40.0, high=50.0):
    ns["VP_STATE"]["roads"]["a"] = [
        {"s": s, "x": 0.0, "z": s / 100, "yaw": 0.0} for s in (low, high)
    ]
    ns["VP_STATE"]["intervals"]["a"] = [(low, high)]


def test_five_cm_grid_uses_traversed_intervals_and_legal_control_distances():
    ns, robot = planner()
    result = ns["_vp_follow"](25.0, 30)
    assert result["distanceCm"] == 25
    assert [call[1] for call in robot.calls if call[0] == "follow_road"] == [10, 10]
    assert [call[1] for call in robot.calls if call[0] == "forward"] == [5]
    candidates = ns["_vp_candidates"](ray(), False, set())
    assert {c["progressCm"] for c in candidates} == {0, 5, 10, 15, 20, 25}
    assert [c["path_cm"] for c in candidates] == sorted(c["path_cm"] for c in candidates)


def test_no_interpolation_or_tangent_inference_across_an_untraversed_gap():
    ns, robot = planner()
    ns["_vp_remember"]()
    robot.progress = 80
    ns["_vp_remember"]()
    candidates = ns["_vp_candidates"](ray(), False, set())
    assert {c["progressCm"] for c in candidates} == {0, 80}
    assert ns["_vp_canonical_unit"]("a", 40) is None


def test_current_pose_uses_vehicle_position_not_centerline_projection():
    ns, robot = planner(StraightRoadRobot(20))
    robot.lateral = 10
    candidates = ns["_vp_candidates"](ray(), False, set())
    current = next(c for c in candidates if c["geometry"] == "current_pose")
    assert current["x"] == pytest.approx(0.1)
    assert ns["VP_STATE"]["roads"]["a"][0]["x"] == pytest.approx(0.0)


def test_candidate_filters_every_prior_hit_and_previously_failed_points():
    ns, _robot = planner()
    ns["_vp_follow"](50, 30)
    ns["STATE"]["accepted_hits"] = [{"pose_x": 0.0, "pose_z": 0.0}, {"pose_x": 0.0, "pose_z": 0.5}]
    ns["VP_STATE"]["failed"].add("a@25.0")
    candidates = ns["_vp_candidates"](ray(), False, {"a@20.0"})
    assert candidates
    assert all(c["key"] not in {"a@25.0", "a@20.0"} for c in candidates)
    assert all(math.hypot(c["x"] - h["pose_x"], c["z"] - h["pose_z"]) >= 0.15
               for c in candidates for h in ns["STATE"]["accepted_hits"])


def test_bearing_only_goal_never_calls_range_inverse():
    ns, _robot = planner()
    ns["_vp_follow"](20, 30)
    ns["uncalibrate_reading"] = Mock(side_effect=AssertionError("capped observation has no range"))
    assert ns["_vp_candidates"](ray(), False, set())
    ns["uncalibrate_reading"].assert_not_called()


def test_finite_goal_filters_on_predicted_raw_reading():
    ns, _robot = planner()
    ns["_vp_follow"](50, 30)
    candidates = ns["_vp_candidates"]({"x": 0.0, "z": 1.0}, True, set())
    assert candidates
    assert all(45 <= c["predicted_raw_cm"] <= 85 for c in candidates)
    assert all(math.hypot(c["x"], c["z"] - 1.0) >= 0.5 for c in candidates)


def route_graph(one_way=False):
    return [edge("a", "n0", "n1", one_way=one_way), edge("b", "n1", "n2"),
            edge("shortcut", "n0", "n2", 10), edge("c", "n2", "n3")]


def test_shortest_path_includes_canonical_start_and_target_partial_edges():
    ns, robot = planner(StraightRoadRobot(20), route_graph())
    path = ns["_vp_path"](robot.road_state(), "c", 30)
    assert path["cost_cm"] == 60  # 20cm back, 10cm shortcut, 30cm target road.
    assert path["direction"] == -1
    assert path["route"] == ["shortcut", "c"]


def test_one_way_current_road_prevents_shorter_reverse_departure():
    ns, robot = planner(StraightRoadRobot(20), route_graph(one_way=True))
    path = ns["_vp_path"](robot.road_state(), "c", 30)
    assert path["cost_cm"] == 210
    assert path["direction"] == 1
    assert path["route"] == ["b", "c"]


def test_blocked_road_replans_and_blocked_direction_can_remove_route():
    ns, robot = planner(StraightRoadRobot(20), route_graph())
    ns["blocked_roads"].add("shortcut")
    assert ns["_vp_path"](robot.road_state(), "c", 30)["cost_cm"] == 210
    ns["blocked_directions"].add(("n0", "n1", "a"))
    assert ns["_vp_path"](robot.road_state(), "c", 30) is None


def test_single_one_way_road_has_no_reverse_candidate_route():
    ns, robot = planner(StraightRoadRobot(70), [edge("a", "n0", "n1", one_way=True)])
    assert ns["_vp_path"](robot.road_state(), "a", 20) is None


def test_take_exit_entry_cost_accounts_for_backtracking_to_near_entrance_candidate():
    ns, robot = planner(StraightRoadRobot(100), [edge("a", "n0", "n1"), edge("b", "n1", "n2")])
    assert ns["_vp_path"](robot.road_state(), "b", 20)["cost_cm"] == 30
    assert ns["_vp_path"](robot.road_state(), "b", 25)["cost_cm"] == 25
    assert ns["_vp_path"](robot.road_state(), "b", 40)["cost_cm"] == 40


def test_one_way_entry_cannot_stop_before_public_landing_but_frontier_can_enter():
    ns, robot = planner(StraightRoadRobot(100), [edge("a", "n0", "n1"), edge("b", "n1", "n2", one_way=True)])
    assert ns["_vp_path"](robot.road_state(), "b", 20) is None
    gateway = ns["_vp_path"](robot.road_state(), "b", 0, enter_only=True)
    assert gateway["cost_cm"] == 25
    assert gateway["landing_progress_cm"] == 25


def test_short_road_entry_uses_road_length_instead_of_unconditional_twenty_five():
    ns, robot = planner(StraightRoadRobot(100), [edge("a", "n0", "n1"), edge("b", "n1", "n2", 10)])
    assert ns["_vp_path"](robot.road_state(), "b", 5)["cost_cm"] == 15
    assert ns["_vp_path"](robot.road_state(), "b", 10)["cost_cm"] == 10


def test_entry_overshoot_cannot_require_a_blocked_reverse_direction():
    ns, robot = planner(StraightRoadRobot(100), [edge("a", "n0", "n1"), edge("b", "n1", "n2")])
    ns["blocked_directions"].add(("n2", "n1", "b"))
    assert ns["_vp_path"](robot.road_state(), "b", 10) is None
    assert ns["_vp_path"](robot.road_state(), "b", 25)["cost_cm"] == 25


def test_already_at_endpoint_can_exit_without_retraversing_blocked_current_direction():
    ns, robot = planner(StraightRoadRobot(100), [edge("a", "n0", "n1"), edge("b", "n1", "n2")])
    ns["blocked_directions"].add(("n0", "n1", "a"))
    state = dict(robot.road_state(), nodeId="n1", atNode=True, exits=[{"roadId": "b"}])
    assert ns["_vp_path"](state, "b", 30)["cost_cm"] == 30
    assert ns["_vp_path"](state, "a", 100)["cost_cm"] == 0
    robot.progress = 99
    assert ns["_vp_path"](robot.road_state(), "b", 30) is None


def test_shared_blocked_transition_keeps_both_target_entrances_for_alternative_route():
    roads = [edge("a", "n0", "n1"), edge("short", "n1", "n2", 10),
             edge("target", "n2", "n3"), edge("alternate", "n0", "n3", 150)]
    ns, robot = planner(StraightRoadRobot(80), roads)
    seed_local_direction(ns, 70, 80)
    entrances = [{"key": "target@0.0", "roadId": "target", "progressCm": 0},
                 {"key": "target@100.0", "roadId": "target", "progressCm": 100}]
    assert all(ns["_vp_path"](robot.road_state(), "target", item["progressCm"])["direction"] == 1
               for item in entrances)
    robot.blocked_signs.add(1)
    assert ns["_vp_travel"](entrances[0]) == "replan"
    assert ns["blocked_directions"] == {("n0", "n1", "a")}
    assert ns["VP_STATE"]["failed"] == set()
    plans = [ns["_vp_path"](robot.road_state(), "target", item["progressCm"]) for item in entrances]
    assert all(plan is not None and plan["direction"] == -1 for plan in plans)
    assert plans[1]["route"] == ["alternate", "target"]
    state = dict(robot.road_state(), nodeId="n0", atNode=True, exits=[{"roadId": "alternate"}])
    ns["_vp_prepare_node"] = Mock(return_value=(SimpleNamespace(x=0, z=0), state))
    ns["_vp_enter"] = Mock(return_value=True)
    assert ns["_vp_travel"](entrances[1]) == "replan"
    ns["_vp_enter"].assert_called_once_with("alternate")
    assert not any(item["key"] in ns["VP_STATE"]["failed"] for item in entrances)


def test_block_direction_uses_actual_heading_at_far_half_not_progress_guess():
    ns, robot = planner(StraightRoadRobot(80))
    seed_local_direction(ns, 70, 80)
    robot.heading = 180
    state = robot.road_state()
    assert ns["_vp_block_current_direction"](state, 1)
    assert ns["blocked_directions"] == {("n1", "n0", "a")}


def test_max_distance_with_progress_replans_residual_then_arrives():
    ns, robot = planner(StraightRoadRobot(50))
    seed_local_direction(ns, 40, 50)
    calls = []
    def partial(distance, _speed):
        calls.append(distance)
        moved = distance - 0.3 if len(calls) == 1 else distance
        robot.progress += moved
        robot.distance += moved
        return {"accepted": True, "distanceCm": distance, "stoppedBy": "max_distance"}
    ns["_vp_follow"] = partial
    candidate = {"key": "a@60.0", "roadId": "a", "progressCm": 60}
    assert ns["_vp_travel"](candidate) == "replan"
    assert robot.progress == pytest.approx(59.7)
    assert candidate["key"] not in ns["VP_STATE"]["failed"]
    assert ns["_vp_travel"](candidate) == "arrived"
    assert calls == pytest.approx([10, 0.3])


def test_max_distance_without_progress_is_unreachable_not_infinite_replan():
    ns, robot = planner(StraightRoadRobot(50))
    seed_local_direction(ns, 40, 50)
    ns["_vp_follow"] = Mock(return_value={"accepted": True, "distanceCm": 10, "stoppedBy": "max_distance"})
    candidate = {"key": "a@60.0", "roadId": "a", "progressCm": 60}
    assert ns["_vp_travel"](candidate) == "unreachable"
    assert candidate["key"] in ns["VP_STATE"]["failed"]


def test_residual_oscillation_stops_when_same_route_and_pose_repeat():
    ns, robot = planner(StraightRoadRobot(50))
    seed_local_direction(ns, 40, 50)
    def oscillate(_distance, _speed):
        robot.progress = 59.7 if robot.progress in (50, 60.1) else 60.1
        return {"accepted": True, "distanceCm": 1, "stoppedBy": "max_distance"}
    ns["_vp_follow"] = Mock(side_effect=oscillate)
    candidate = {"key": "a@60.0", "roadId": "a", "progressCm": 60}
    assert [ns["_vp_travel"](candidate) for _ in range(4)] == ["replan", "replan", "replan", "unreachable"]
    assert ns["_vp_follow"].call_count == 3


def test_successful_travel_can_be_legitimately_revisited_after_other_movement():
    ns, robot = planner(StraightRoadRobot(20))
    seed_local_direction(ns, 10, 20)
    candidate = {"key": "a@40.0", "roadId": "a", "progressCm": 40}
    assert ns["_vp_travel"](candidate) == "arrived"
    robot.left_angle(180)
    robot.forward(20)
    assert ns["_vp_travel"](candidate) == "arrived"
    assert robot.progress == 40


def test_reverse_grid_travel_arrives_using_ten_cm_follow_then_five_cm_drive():
    ns, robot = planner()
    ns["_vp_follow"](30, 30)
    candidates = ns["_vp_candidates"](ray(), False, set())
    target = next(c for c in candidates if c["progressCm"] == 15)
    assert ns["_vp_travel"](target) == "arrived"
    assert robot.progress == 15
    assert robot.calls[-1][0:2] == ("forward", 5)


def test_zero_move_cannot_reach_a_different_grid_point():
    ns, robot = planner(StraightRoadRobot(50))
    seed_local_direction(ns)
    robot.blocked_signs.add(1)
    candidate = {"key": "a@60.0", "roadId": "a", "progressCm": 60, "x": 0, "z": 0.6}
    assert ns["_vp_travel"](candidate) == "replan"
    assert robot.progress == 50
    assert ("n0", "n1", "a") in ns["blocked_directions"]
    assert candidate["key"] not in ns["VP_STATE"]["failed"]
    commands = len(robot.calls)
    assert ns["_vp_travel"](candidate) == "unreachable"
    assert len(robot.calls) == commands
    assert candidate["key"] in ns["VP_STATE"]["failed"]


def test_crossing_into_adjacent_road_returns_replan_instead_of_claiming_arrival():
    ns, _robot = planner(StraightRoadRobot(100), [edge("a", "n0", "n1"), edge("b", "n1", "n2")])
    pose = SimpleNamespace(x=0, z=1, yaw_rad=0)
    state = {"onRoad": True, "roadId": "a", "roadProgressCm": 100, "nodeId": "n1", "atNode": True}
    ns["_vp_remember"] = Mock(return_value=(pose, state))
    ns["_vp_face_progress"] = Mock(return_value=True)
    ns["_vp_prepare_node"] = Mock(return_value=(pose, state))
    ns["_vp_enter"] = Mock(return_value=True)
    ns["_vp_follow"] = Mock()
    result = ns["_vp_travel"]({"key": "b@60.0", "roadId": "b", "progressCm": 60})
    assert result == "replan"
    ns["_vp_enter"].assert_called_once_with("b")
    ns["_vp_follow"].assert_not_called()


def test_take_exit_accepted_with_zero_translation_is_not_success():
    ns, robot = planner()
    pose = SimpleNamespace(x=0, z=0, yaw_rad=0)
    state = {"onRoad": True, "roadId": "a", "roadProgressCm": 0, "exits": [{"roadId": "b"}]}
    ns["_vp_prepare_node"] = Mock(return_value=(pose, state))
    ns["_vp_remember"] = Mock(return_value=(pose, state))
    robot.take_exit = Mock(return_value={"accepted": True, "distanceCm": 0, "stoppedBy": "front_clearance"})
    assert ns["_vp_enter"]("b") is False


def test_near_target_explores_outward_without_changing_aim_unit():
    ns, robot = planner(StraightRoadRobot(50))
    seed_local_direction(ns)
    goal = {"x": 0.0, "z": 0.7}
    pose, _state = ns["_vp_remember"]()
    assert ns["_vp_goal_unit"](goal, pose) == (0.0, 1.0)
    assert ns["_vp_explore"](goal, set()) is True
    assert robot.progress == 40


def test_blocked_first_exploration_direction_tries_other_direction_in_same_call():
    ns, robot = planner(StraightRoadRobot(50))
    seed_local_direction(ns)
    robot.blocked_signs.add(1)
    assert ns["_vp_explore"]({"x": 0, "z": 2}, set()) is True
    assert robot.progress == 40
    assert len([c for c in robot.calls if c[0] == "follow_road"]) == 2


def test_exhausted_directions_stop_without_repeating_commands():
    ns, robot = planner(StraightRoadRobot(50))
    seed_local_direction(ns)
    robot.blocked_signs.update({1, -1})
    assert ns["_vp_explore"]({"x": 0, "z": 2}, set()) is False
    count = len(robot.calls)
    assert ns["_vp_explore"]({"x": 0, "z": 2}, set()) is False
    assert len(robot.calls) == count


def test_midroad_exploration_obeys_directional_block():
    ns, robot = planner(StraightRoadRobot(50))
    seed_local_direction(ns)
    ns["blocked_directions"].add(("n0", "n1", "a"))
    assert ns["_vp_explore"]({"x": 0, "z": 2}, set()) is True
    assert robot.progress == 40
    assert len([c for c in robot.calls if c[0] == "follow_road"]) == 1


def test_midroad_exploration_does_not_enter_blocked_road():
    ns, robot = planner(StraightRoadRobot(50))
    ns["blocked_roads"].add("a")
    assert ns["_vp_explore"]({"x": 0, "z": 2}, set()) is False
    assert not robot.calls


def test_one_way_exploration_cannot_try_reverse_when_forward_blocked():
    ns, robot = planner(StraightRoadRobot(50), [edge("a", "n0", "n1", one_way=True)])
    seed_local_direction(ns)
    robot.blocked_signs.add(1)
    assert ns["_vp_explore"]({"x": 0, "z": 2}, set()) is False
    assert len([c for c in robot.calls if c[0] == "follow_road"]) == 1
    assert not any(c[0] == "left_angle" for c in robot.calls)


def test_node_exploration_uses_available_neighbor_after_first_exit_is_blocked():
    edges = [edge("a", "n0", "n1"), edge("b", "n1", "n2"), edge("c", "n1", "n3")]
    ns, _robot = planner(edges=edges)
    pose = SimpleNamespace(x=0, z=1, yaw_rad=0)
    state = {"onRoad": True, "roadId": "a", "roadProgressCm": 100, "nodeId": "n1", "atNode": True,
             "exits": [{"roadId": "b", "turnDeg": 0}, {"roadId": "c", "turnDeg": 90}]}
    ns["_vp_remember"] = Mock(return_value=(pose, state))
    ns["_vp_enter"] = Mock(side_effect=[False, True])
    assert ns["_vp_explore"]({"x": 0, "z": 2}, set()) is True
    assert [call.args[0] for call in ns["_vp_enter"].call_args_list] == ["b", "c"]
