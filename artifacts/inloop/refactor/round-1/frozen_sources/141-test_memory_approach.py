"""Memory approach regressions on synthetic public road geometry."""

import math
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from test_viewpoint_planner import StraightRoadRobot, edge, planner, seed_local_direction


FRAGMENT = Path(__file__).resolve().parents[2] / "artifacts/inloop/refactor/legacy_sources/memory_approach_fragment.py"


def memory(robot=None, edges=None, target=None):
    ns, robot = planner(robot, edges)
    target = target or SimpleNamespace(obj_id="track", x=0.0, z=0.8, state="CONFIRMED")
    ns.update(APPROACH_FINE_DISTANCE_M=0.30, ObjectState=SimpleNamespace(LOST="LOST"),
              _wm_target=lambda: target, _approach_event=Mock())
    robot.observe = Mock(side_effect=AssertionError("memory navigation must not observe"))
    exec(compile(FRAGMENT.read_text(), str(FRAGMENT), "exec"), ns)
    return ns, robot, target


def test_five_cm_candidates_use_fine_distance_not_confirmation_filters():
    ns, robot, target = memory(target=SimpleNamespace(obj_id="track", x=0.0, z=0.7, state="CONFIRMED"))
    ns["_vp_follow"](60, 30)
    ns["STATE"]["accepted_hits"] = [{"pose_x": 0, "pose_z": 0.6}]
    ns["uncalibrate_reading"] = Mock(side_effect=AssertionError("confirmation window does not apply"))
    pose, state = ns["_vp_remember"]()
    candidates = ns["_mag_candidates"](pose, state, target, set())
    assert 45 in {point["progressCm"] for point in candidates}
    assert candidates[0]["progressCm"] == 60
    assert all(point["wm_distance_m"] <= 0.30 for point in candidates)
    assert [point["path_cm"] for point in candidates] == sorted(point["path_cm"] for point in candidates)


def test_actual_current_pose_at_threshold_succeeds_without_motion_or_observe():
    ns, robot, target = memory(StraightRoadRobot(50))
    target.z = 0.799
    assert ns["_approach_graph_navigation"](target)
    assert robot.calls == []
    robot.observe.assert_not_called()


def test_same_road_shortest_candidate_stops_at_first_fine_grid_point():
    ns, robot, target = memory(StraightRoadRobot(10))
    seed_local_direction(ns, 0, 100)
    target.z = 0.799
    assert ns["_approach_graph_navigation"](target)
    assert robot.progress == pytest.approx(50)
    robot.observe.assert_not_called()


def test_unknown_gap_is_not_filled_with_invented_candidate_coordinates():
    ns, robot, target = memory(StraightRoadRobot(0))
    ns["_vp_remember"]()
    robot.progress = 100
    pose, state = ns["_vp_remember"]()
    target.x, target.z = 0.0, 0.5
    assert ns["_mag_candidates"](pose, state, target, set()) == []
    frontiers = ns["_mag_frontiers"](pose, state, target, set())
    assert {(point["progressCm"], point["direction"]) for point in frontiers} == {(0, 1), (100, -1)}


def test_frontier_continues_outward_from_known_interval_after_target_bearing_crosses_side():
    ns, robot, target = memory(StraightRoadRobot(60))
    seed_local_direction(ns, 0, 60)
    target.x, target.z = 0.5, 0.4  # Behind along this road, but its continuation is unknown.
    pose, state = ns["_vp_remember"]()
    chosen = ns["_mag_frontiers"](pose, state, target, set())[0]
    assert chosen["progressCm"] == 60 and chosen["direction"] == 1
    assert ns["_mag_frontier_step"](chosen, state) == "replan"
    assert robot.progress == 70
    assert not any(call[0] == "left_angle" for call in robot.calls)


def test_frontiers_respect_one_way_and_blocked_directions():
    ns, robot, target = memory(StraightRoadRobot(40), [edge("a", "n0", "n1", one_way=True)])
    ns["VP_STATE"]["canonical_hints"]["a"] = (0, 1)
    pose, state = ns["_vp_remember"]()
    frontiers = ns["_mag_frontiers"](pose, state, target, set())
    assert frontiers and all(point["direction"] == 1 for point in frontiers)
    ns["blocked_directions"].add(("n0", "n1", "a"))
    assert ns["_mag_frontiers"](pose, state, target, set()) == []


def test_zero_translation_frontier_is_failed_and_not_retried():
    ns, robot, target = memory(StraightRoadRobot(40))
    seed_local_direction(ns, 0, 40)
    robot.blocked_signs.add(1)
    pose, state = ns["_vp_remember"]()
    chosen = ns["_mag_frontiers"](pose, state, target, set())[0]
    assert ns["_mag_frontier_step"](chosen, state) == "replan"
    remaining = ns["_mag_frontiers"](pose, state, target, set())
    assert all(point["frontier_key"] != chosen["frontier_key"] for point in remaining)
    assert robot.progress == 40


def test_fully_measured_road_outside_fine_range_fails_without_oscillation():
    ns, robot, target = memory(StraightRoadRobot(50))
    seed_local_direction(ns, 0, 100)
    target.x, target.z = 0.5, 0.5
    assert not ns["_approach_graph_navigation"](target)
    assert robot.calls == []
    assert ns["_approach_event"].call_args.kwargs["reason"] == "memory_graph_exhausted"


def test_cross_road_candidate_replans_and_validates_actual_pose():
    ns, robot, target = memory(StraightRoadRobot(10))
    point = {"key": "other@10.0", "roadId": "other", "progressCm": 10, "path_cm": 100}
    ns["_mag_candidates"] = Mock(return_value=[point])
    ns["_mag_frontiers"] = Mock(return_value=[])
    def travel(_point):
        robot.progress = 60
        return "replan"
    ns["_vp_travel"] = Mock(side_effect=travel)
    assert ns["_approach_graph_navigation"](target)
    ns["_vp_travel"].assert_called_once()
    robot.observe.assert_not_called()


def test_arrived_at_predicted_point_is_not_success_when_actual_distance_too_large():
    ns, _robot, target = memory(StraightRoadRobot(10))
    point = {"key": "a@50.0", "roadId": "a", "progressCm": 50, "path_cm": 40}
    ns["_mag_candidates"] = Mock(side_effect=[[point], []])
    ns["_mag_frontiers"] = Mock(return_value=[])
    ns["_vp_travel"] = Mock(return_value="arrived")
    assert not ns["_approach_graph_navigation"](target)
    assert any(call.kwargs.get("reason") == "actual_pose_outside_fine_range"
               for call in ns["_approach_event"].call_args_list)


def test_replan_without_translation_cannot_repeat_forever():
    ns, _robot, target = memory(StraightRoadRobot(10))
    point = {"key": "a@50.0", "roadId": "a", "progressCm": 50, "path_cm": 40}
    ns["_mag_candidates"] = lambda _pose, _state, _target, tried: [] if point["key"] in tried else [point]
    ns["_mag_frontiers"] = Mock(return_value=[])
    ns["_vp_travel"] = Mock(return_value="replan")
    assert not ns["_approach_graph_navigation"](target)
    ns["_vp_travel"].assert_called_once()


def test_new_blocked_route_at_same_pose_is_retried_with_alternative_plan():
    ns, robot, target = memory(StraightRoadRobot(10))
    point = {"key": "a@50.0", "roadId": "a", "progressCm": 50, "path_cm": 40,
             "plan": {"direction": 1, "entry_node": "n1", "route": ["short"]}}
    ns["_mag_candidates"] = Mock(return_value=[point])
    ns["_mag_frontiers"] = Mock(return_value=[])
    def travel(_point):
        if not ns["blocked_directions"]:
            ns["blocked_directions"].add(("n0", "n1", "a"))
            point["plan"] = {"direction": -1, "entry_node": "n0", "route": ["alternate"]}
        else:
            robot.progress = 60
        return "replan"
    ns["_vp_travel"] = Mock(side_effect=travel)
    assert ns["_approach_graph_navigation"](target)
    assert ns["_vp_travel"].call_count == 2


def test_new_measured_coverage_allows_legitimate_revisit_of_same_operation():
    ns, robot, target = memory(StraightRoadRobot(10))
    point = {"key": "a@50.0", "roadId": "a", "progressCm": 50, "path_cm": 40}
    ns["_mag_candidates"] = Mock(return_value=[point])
    def travel(_point):
        if not ns["VP_STATE"]["intervals"].get("a"):
            ns["VP_STATE"]["intervals"]["a"] = [(0, 10)]
        else:
            robot.progress = 60
        return "replan"
    ns["_vp_travel"] = Mock(side_effect=travel)
    assert ns["_approach_graph_navigation"](target)
    assert ns["_vp_travel"].call_count == 2


def test_unknown_endpoint_bounds_use_measured_points_and_road_arcs_without_coordinates():
    roads = [edge("a", "n0", "n1", 100), edge("b", "n1", "n2", 100)]
    ns, _robot, target = memory(StraightRoadRobot(0), roads)
    target.x, target.z = 0, 2.0
    points = {"a@0.0": {"roadId": "a", "progressCm": 0, "x": 0, "z": 0}}
    bounds = ns["_mag_node_bounds"](target, points)
    assert bounds == pytest.approx({"n0": 170, "n1": 70, "n2": 0})
    assert "b" not in ns["VP_STATE"]["roads"]


def test_current_body_offset_is_not_used_as_centerline_endpoint_bound():
    ns, robot, target = memory(StraightRoadRobot(0))
    target.x, target.z = 0.0, 1.0
    robot.lateral = 5
    pose, state = ns["_vp_remember"]()
    points = ns["_vp_points"](pose, state)
    assert points["a@0.0"]["x"] == 0.05
    bounds = ns["_mag_node_bounds"](target, points)
    assert bounds["n0"] == pytest.approx(70)
    assert bounds["n1"] == 0


def test_unknown_one_way_road_keeps_gateway_frontier_without_stop_before_entry():
    roads = [edge("a", "n0", "n1"), edge("b", "n1", "n2", one_way=True)]
    ns, _robot, target = memory(StraightRoadRobot(100), roads)
    seed_local_direction(ns, 0, 100)
    pose, state = ns["_vp_remember"]()
    frontiers = ns["_mag_frontiers"](pose, state, target, set())
    gate = next(point for point in frontiers if point["roadId"] == "b")
    assert gate["enter_only"] and gate["progressCm"] == 0
    assert gate["path_cm"] == 25 and gate["plan"]["landing_progress_cm"] == 25


def test_frontier_score_prefers_capture_region_over_cheapest_boundary_alone():
    ns, _robot, target = memory(StraightRoadRobot(50), [edge("a", "n0", "n1"), edge("b", "n1", "n2")])
    target.x, target.z = 0.0, 1.4
    seed_local_direction(ns, 0, 50)
    ns["VP_STATE"]["roads"]["b"] = [{"s": 20, "x": 0, "z": 1.2, "yaw": 0}]
    def route(_state, road_id, _progress, enter_only=False):
        cost = 0 if road_id == "a" else 10
        return {"cost_cm": cost, "direct": True, "direction": 1, "route": []}
    ns["_vp_path"] = route
    pose, state = ns["_vp_remember"]()
    options = ns["_mag_frontiers"](pose, state, target, {("a", -1, 50.0)})
    assert options[0]["roadId"] == "b"
    assert options[0]["path_cm"] == 10
    assert next(point for point in options if point["roadId"] == "a")["path_cm"] == 0
    assert [point["score_cm"] for point in options] == sorted(point["score_cm"] for point in options)


def test_gateway_lower_bound_is_evaluated_at_api_landing_not_unknown_endpoint():
    ns, _robot, target = memory(StraightRoadRobot(100), [edge("a", "n0", "n1"), edge("b", "n1", "n2")])
    target.x, target.z = 0.0, 2.0
    seed_local_direction(ns, 0, 100)
    pose, state = ns["_vp_remember"]()
    gate = next(point for point in ns["_mag_frontiers"](pose, state, target, set())
                if point["roadId"] == "b" and point["progressCm"] == 0)
    assert gate["remaining_bound_cm"] == pytest.approx(45)  # 170 - 100 - 25.
    assert gate["score_cm"] == pytest.approx(70)


@pytest.mark.parametrize("changed", [None, SimpleNamespace(obj_id="other", state="CONFIRMED"),
                                     SimpleNamespace(obj_id="track", state="LOST")])
def test_lost_or_different_locked_track_fails_before_motion(changed):
    ns, robot, target = memory()
    ns["_wm_target"] = lambda: changed
    assert not ns["_approach_graph_navigation"](target)
    assert robot.calls == []


def test_off_road_fails_even_when_target_is_within_fine_range():
    ns, robot, target = memory(StraightRoadRobot(110))
    target.z = 1.1
    assert not ns["_approach_graph_navigation"](target)
    assert robot.calls == []


def test_positive_short_junction_stop_uses_node_handling_instead_of_reversal():
    ns, robot, target = memory(StraightRoadRobot(60))
    seed_local_direction(ns, 0, 60)
    pose, state = ns["_vp_remember"]()
    frontier = ns["_mag_frontiers"](pose, state, target, set())[0]
    def stop(_distance, _speed):
        robot.progress += 7
        return {"accepted": True, "distanceCm": 7, "stoppedBy": "junction"}
    ns["_vp_follow"] = stop
    ns["_vp_prepare_node"] = Mock()
    assert ns["_mag_frontier_step"](frontier, state) == "unreachable"
    ns["_vp_prepare_node"].assert_called_once()
    assert not any(call[0] == "left_angle" for call in robot.calls)


class BentRoadRobot(StraightRoadRobot):
    """A U-shaped public road whose target requires passing its first local minimum."""

    def _geometry(self):
        if self.progress <= 80:
            return 0.0, self.progress, 0.0
        if self.progress <= 130:
            return self.progress - 80, 80.0, -90.0
        return 50.0, 210.0 - self.progress, 180.0

    def odometry(self):
        x, z, _heading = self._geometry()
        return {"rightCm": x, "forwardCm": z, "headingDeg": self.heading,
                "distanceCm": self.distance}

    def align(self):
        _x, _z, tangent = self._geometry()
        self.heading = tangent if math.cos(math.radians(self.heading - tangent)) >= 0 else tangent + 180

    def _move(self, distance):
        _x, _z, tangent = self._geometry()
        sign = 1 if math.cos(math.radians(self.heading - tangent)) >= 0 else -1
        self.progress += sign * distance
        self.distance += distance
        self.heading = self._geometry()[2] + (180 if sign < 0 else 0)
        return distance, "max_distance"

    def road_state(self):
        result = super().road_state()
        result["onRoad"] = 0 <= self.progress <= 210
        return result


def test_unknown_bent_road_reaches_fine_range_without_bearing_flip_or_observations():
    robot = BentRoadRobot(10)
    target = SimpleNamespace(obj_id="track", x=0.5, z=0.4, state="CONFIRMED")
    ns, robot, target = memory(robot, [edge("a", "n0", "n1", 210)], target)
    seed_local_direction(ns, 0, 10)
    assert ns["_approach_graph_navigation"](target)
    assert robot.progress >= 140
    assert not any(call[0] == "left_angle" for call in robot.calls)
    robot.observe.assert_not_called()


def test_entry_endpoint_hint_supplies_direction_without_inventing_road_geometry():
    ns, robot, _target = memory(StraightRoadRobot(25))
    ns["VP_STATE"]["canonical_hints"]["a"] = (0, 1)
    ns["_vp_remember"]()
    assert ns["_vp_canonical_unit"]("a", 25) == (0, 1)
    assert len(ns["_vp_points"](*ns["_vp_remember"]())) == 1
    assert ns["_vp_face_progress"](1, robot.road_state())


@pytest.mark.parametrize("entry_node, sign", [("n0", 1), ("n1", -1)])
def test_successful_exit_records_canonical_hint_from_public_entry_node(entry_node, sign):
    ns, robot, _target = memory(StraightRoadRobot(25))
    before = SimpleNamespace(x=0.0, z=0.0, yaw_rad=0.0)
    after = SimpleNamespace(x=0.0, z=0.25, yaw_rad=0.0)
    state = {"onRoad": True, "nodeId": entry_node, "exits": [{"roadId": "a"}]}
    ns["_vp_prepare_node"] = Mock(return_value=(before, state))
    ns["_vp_remember"] = Mock(return_value=(after, robot.road_state()))
    robot.take_exit = Mock(return_value={"accepted": True, "distanceCm": 25, "stoppedBy": "entered_road"})
    assert ns["_vp_enter"]("a")
    assert ns["VP_STATE"]["canonical_hints"]["a"] == (0.0, sign)
    assert ns["VP_STATE"]["roads"] == {}
