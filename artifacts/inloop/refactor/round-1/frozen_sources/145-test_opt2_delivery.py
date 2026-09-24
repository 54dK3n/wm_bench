"""Offline delivery regressions using synthetic public road states only."""
import ast
import heapq
import json
import math
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from test_viewpoint_planner import edge


ROOT = Path(__file__).resolve().parents[2]
FROZEN = ROOT / "artifacts/inloop/opt-1/round-2/program.py"
FRAGMENT = ROOT / "programs/src/opt2_delivery_fragment.py"


class PublicRobot:
    def __init__(self, progress=50.0, roads=None):
        self.edges = roads or [edge("a", "n0", "n1")]
        self.road = "a"
        self.progress = float(progress)
        self.heading = 0.0
        self.distance = 0.0
        self.calls = []
        self.stops = {}
        self.junction_stop = False
        self._holding = "目标物"
        self.completed = 0

    def item(self):
        return next(item for item in self.edges if item["roadId"] == self.road)

    def odometry(self):
        offset = 0 if self.road == "a" else 100
        return {"rightCm": 0, "forwardCm": offset + self.progress,
                "headingDeg": self.heading, "distanceCm": self.distance, "tick": len(self.calls)}

    def road_state(self):
        edge_now = self.item()
        node = (edge_now["toNodeId"] if self.progress == edge_now["lengthCm"] or self.junction_stop
                else edge_now["fromNodeId"] if self.progress == 0 else None)
        exits = []
        for item in self.edges:
            if node in (item["fromNodeId"], item["toNodeId"]):
                desired_yaw = 0 if node == item["fromNodeId"] else 180
                turn = (-self.heading - desired_yaw + 180) % 360 - 180
                exits.append({"roadId": item["roadId"], "turnDeg": turn})
        return {"onRoad": 0 <= self.progress <= edge_now["lengthCm"], "roadId": self.road,
                "roadProgressCm": self.progress, "headingErrorDeg": 0.0,
                "lateralOffsetCm": 0.0, "atNode": node is not None,
                "nodeId": node, "exits": exits, "frontClearanceCm": None}

    def align(self):
        self.heading = 0.0 if math.cos(math.radians(self.heading)) >= 0 else 180.0

    def left_angle(self, degrees):
        assert 1 <= degrees <= 360
        self.calls.append(("left_angle", degrees))
        self.heading = (self.heading + degrees) % 360

    def right_angle(self, degrees):
        assert 1 <= degrees <= 360
        self.calls.append(("right_angle", degrees))
        self.heading = (self.heading - degrees) % 360

    def move(self, amount):
        sign = 1 if math.cos(math.radians(self.heading)) >= 0 else -1
        if self.junction_stop:
            return 0.0, "junction"
        before = self.progress
        wanted = min(float(self.item()["lengthCm"]), max(0.0, before + sign * amount))
        stop = self.stops.get((self.road, sign))
        blocked = stop is not None and sign * (wanted - stop) >= 0 and sign * (stop - before) >= 0
        self.progress = stop if blocked else wanted
        moved = abs(self.progress - before)
        self.distance += moved
        return moved, "front_clearance" if blocked else "max_distance" if moved == amount else "junction"

    def forward(self, amount):
        self.calls.append(("forward", amount))
        self.move(amount)

    def follow_road(self, amount, speed, obey_limit):
        assert 10 <= amount <= 500
        self.calls.append(("follow_road", amount, speed, obey_limit))
        if self.item()["oneWay"] and math.cos(math.radians(self.heading)) < 0:
            return {"accepted": False, "distanceCm": 0.0, "stoppedBy": "wrong_way"}
        moved, reason = self.move(amount)
        return {"accepted": True, "distanceCm": moved, "stoppedBy": reason}

    def take_exit(self, road_id, speed, obey_limit):
        node = self.road_state()["nodeId"]
        target = next(item for item in self.edges if item["roadId"] == road_id)
        assert node in (target["fromNodeId"], target["toNodeId"])
        self.calls.append(("take_exit", road_id, speed, obey_limit))
        self.road = road_id
        self.progress = 25.0 if node == target["fromNodeId"] else target["lengthCm"] - 25.0
        self.heading = 0.0 if node == target["fromNodeId"] else 180.0
        self.junction_stop = False
        self.distance += 25
        return {"accepted": True, "distanceCm": 25, "stoppedBy": "entered_road"}

    def holding(self):
        return self._holding

    def release(self):
        self.calls.append(("release",))
        self._holding = None
        self.completed += 1


def delivery(progress=50, roads=None):
    robot = PublicRobot(progress, roads)
    edges = {item["roadId"]: item for item in robot.edges}
    adjacency = {}
    for item in robot.edges:
        adjacency.setdefault(item["fromNodeId"], []).append((item["toNodeId"], item["roadId"], item["lengthCm"]))
        adjacency.setdefault(item["toNodeId"], [])
        if not item["oneWay"]:
            adjacency[item["toNodeId"]].append((item["fromNodeId"], item["roadId"], item["lengthCm"]))
    ns = dict(math=math, json=json, heapq=heapq, robot=robot, edge_by_road=edges, adj=adjacency,
              blocked_roads=set(), blocked_directions=set(), CRUISE_SPEED=100, SLOW_SPEED=30,
              VIEW_GRID_CM=5.0, OBS_MIN_TURN_DEG=10.0, APPROACH_FOLLOW_STEP_CM=10.0,
              NODE_NUDGE_CM=2.0, VP_EXIT_ENTRY_CM=25.0, DELIVERY_LOG={"on": True},
              OPT2_MOTION_STATE={"memory_travel_active": False},
              STATE={"confirmation_track_id": "track-1", "observe_count": 7},
              NAV_STATE={"queries": 111, "controls": 22},
              DEMO_STATE={"deliveries": [], "delivered_track_ids": set()}, DEMO_RELEASE_PROJECTION_CM=13.75,
              mission={"storage": {"roadId": "a", "progressCm": 50.0}},
              wm=SimpleNamespace(assoc_cfg=SimpleNamespace(gate_distance_m=.3)),
              VP_STATE={"roads": {}, "intervals": {}, "canonical_hints": {}, "failed": set(),
                        "nudged": set(), "travel_attempts": set(), "explored": set()},
              nav_odometry=robot.odometry, nav_road_state=robot.road_state,
              nav_task_state=lambda: {"completed": robot.completed},
              motion_left_angle=robot.left_angle, motion_right_angle=robot.right_angle,
              motion_forward=robot.forward, motion_follow_road=robot.follow_road,
              motion_take_exit=robot.take_exit, motion_release=robot.release,
              align_to_current_road=robot.align, _demo_event=Mock(), _delivery_event=Mock(),
              nav_release_preview=Mock(return_value={"holding": "target", "releaseAccepted": True,
                                                     "wouldCompleteDelivery": True}),
              counted_observe=Mock(side_effect=AssertionError("delivery must not observe")))
    ns["odometry_to_pose"] = lambda odo: SimpleNamespace(x=odo["rightCm"] / 100,
                    z=odo["forwardCm"] / 100, yaw_rad=-math.radians(odo["headingDeg"]))
    needed = {"_road_progress_limit", "_road_progress_blocked", "_vp_block_revision", "dijkstra", "_wrap_deg"}
    tree = ast.parse(FROZEN.read_text())
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef)
             and (node.name.startswith("_vp_") or node.name in needed)]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(FROZEN), "exec"), ns)
    tree = ast.parse((ROOT / "artifacts/inloop/refactor/legacy_sources/demo_flow_fragment.py").read_text())
    helper = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_demo_release_active_target")
    exec(compile(ast.Module(body=[helper], type_ignores=[]), "demo_release", "exec"), ns)
    exec(compile(FRAGMENT.read_text(), str(FRAGMENT), "exec"), ns)
    ns["_vp_event"] = Mock()
    ns["VP_STATE"]["canonical_hints"]["a"] = (0.0, 1.0)
    return ns, robot


def test_junction_zero_motion_transitions_with_take_exit_and_replans():
    ns, robot = delivery(90, [edge("a", "n0", "n1"), edge("b", "n1", "n2")])
    robot.junction_stop = True
    candidate = {"key": "storage:b@40.0", "roadId": "b", "progressCm": 40.0}
    assert ns["_opt2_reach"](candidate)
    assert robot.road == "b" and robot.progress == 40
    assert robot.calls[0][0] == "take_exit"
    assert ("take_exit", "b", 100, True) in robot.calls
    assert ns["VP_STATE"]["roads"]["b"]
    assert ns["VP_STATE"]["intervals"]["b"] == [(25.0, 40.0)]


def test_new_geometry_makes_actual_block_direction_known_without_whole_road_block():
    ns, robot = delivery(20)
    robot.stops[("a", 1)] = 35.0
    assert not ns["_opt2_reach"]({"key": "storage:a@60", "roadId": "a", "progressCm": 60})
    assert ns["VP_STATE"]["local_blocks"] == {("a", 1, 35.0): 35.0}
    assert ns["blocked_directions"] == set()
    assert ns["_opt2_reach"]({"key": "leave:a@20", "roadId": "a", "progressCm": 20})
    assert robot.progress == 20
    assert ns["VP_STATE"]["intervals"]["a"] == [(20.0, 35.0)]


def test_repeated_replan_without_physical_or_route_change_stops_once():
    ns, _ = delivery()
    ns["_vp_travel"] = Mock(return_value="replan")
    assert not ns["_opt2_reach"]({"key": "storage:a@60", "roadId": "a", "progressCm": 60})
    assert ns["_vp_travel"].call_count == 1
    assert ns["_delivery_event"].call_args.kwargs["reason"] == "repeated_travel_state"


def test_storage_candidates_are_public_five_cm_grid_and_only_measured_neighbors():
    ns, robot = delivery(50, [edge("a", "n0", "n1"), edge("b", "n1", "n2"), edge("c", "n2", "n3")])
    ns["mission"]["storage"]["progressCm"] = 52.0
    ns["VP_STATE"]["roads"]["b"] = [{"s": 25.0, "x": 0, "z": 1.25, "yaw": 0}]
    ns["VP_STATE"]["roads"]["c"] = [{"s": 25.0, "x": 0, "z": 2.25, "yaw": 0}]
    choices = ns["_opt2_storage_candidates"](ns["mission"]["storage"], set(), set())
    assert choices[0]["roadId"] == "a" and choices[0]["progressCm"] == 52
    assert {x["progressCm"] for x in choices if x["roadId"] == "a"} == set(range(0, 101, 5)) | {52}
    assert {x["progressCm"] for x in choices if x["roadId"] == "b"} == {25}
    assert not any(x["roadId"] == "c" for x in choices)
    assert robot.calls == []


def test_preview_full_heading_domain_is_finite_and_does_not_observe():
    ns, robot = delivery()
    ns["nav_release_preview"].return_value["wouldCompleteDelivery"] = False
    assert ns["_opt2_preview_candidate"](ns["mission"]["storage"], {"key": "p"}) == "preview_grid_exhausted"
    assert ns["nav_release_preview"].call_count == 36
    assert len(robot.calls) == 35
    assert all(call[1] == 10 for call in robot.calls)
    ns["counted_observe"].assert_not_called()


def test_failed_preview_moves_to_next_candidate_then_verifies_release_and_leaves():
    ns, robot = delivery()
    ns["nav_release_preview"] = Mock(side_effect=lambda: {"holding": "target", "releaseAccepted": True,
                                                         "wouldCompleteDelivery": robot.progress != 50})
    assert ns["release_target_at_storage"]()
    assert ns["nav_release_preview"].call_count > 36
    assert robot.completed == 1 and robot.holding() is None
    assert ns["DEMO_STATE"]["delivered_track_ids"] == {"track-1"}
    assert robot.progress != 50
    ns["counted_observe"].assert_not_called()


def test_verified_release_and_departure_allow_next_ball_without_resetting_global_budget():
    ns, robot = delivery()
    assert ns["release_target_at_storage"]()
    assert robot.progress == 45.0
    assert ns["STATE"]["observe_count"] == 7 and ns["NAV_STATE"] == {"queries": 111, "controls": 22}
    ns["STATE"]["confirmation_track_id"] = "track-2"
    robot._holding = "目标物"
    assert ns["release_target_at_storage"]()
    assert robot.completed == 2 and robot.holding() is None
    assert ns["DEMO_STATE"]["delivered_track_ids"] == {"track-1", "track-2"}
    assert len(ns["DEMO_STATE"]["deliveries"]) == 2


def test_unverified_release_aborts_without_marking_delivery_or_retrying_ball():
    ns, _ = delivery()
    ns["motion_release"] = Mock()
    assert not ns["release_target_at_storage"]()
    ns["motion_release"].assert_called_once()
    assert not ns["DEMO_STATE"]["deliveries"]


def test_not_holding_is_failure_without_release_or_more_previews():
    ns, robot = delivery()
    ns["nav_release_preview"].return_value["holding"] = None
    assert not ns["release_target_at_storage"]()
    assert ns["nav_release_preview"].call_count == 1
    assert not any(call[0] == "release" for call in robot.calls)


def test_departure_at_end_node_uses_exit_instead_of_accepting_zero_move():
    ns, robot = delivery(100, [edge("a", "n0", "n1"), edge("b", "n1", "n2")])
    ns["DEMO_STATE"]["deliveries"] = [{"x": 0, "z": .8}]
    assert ns["_opt2_leave_release"]()
    assert robot.road == "b" and robot.progress == 25
    assert any(call[0] == "take_exit" for call in robot.calls)


def test_departure_with_no_legal_progress_is_failure_but_keeps_delivery_record():
    ns, robot = delivery(50, [edge("a", "n0", "n1", one_way=True)])
    ns["DEMO_STATE"]["deliveries"] = [{"track_id": "done", "x": 0, "z": .6375}]
    assert not ns["_opt2_leave_release"]()
    assert ns["DEMO_STATE"]["deliveries"][0]["track_id"] == "done"
    assert not any(call[0] == "release" for call in robot.calls)


@pytest.mark.parametrize("delivery_on,speed", [(False, 30), (True, 100)])
def test_vp_speed_override_preserves_confirmation_default(delivery_on, speed):
    ns, robot = delivery(20)
    ns["DELIVERY_LOG"]["on"] = delivery_on
    assert ns["_vp_travel"]({"key": "p", "roadId": "a", "progressCm": 40}) == "arrived"
    assert all(call[2] == speed for call in robot.calls if call[0] == "follow_road")


def test_entry_body_only_changes_speed_from_frozen_r2():
    base = ast.parse(FROZEN.read_text())
    updated = ast.parse(FRAGMENT.read_text())
    class RestoreSpeed(ast.NodeTransformer):
        def visit_Call(self, node):
            if isinstance(node.func, ast.Name) and node.func.id == "_opt2_travel_speed":
                return ast.copy_location(ast.Name(id="SLOW_SPEED", ctx=ast.Load()), node)
            return self.generic_visit(node)
    before = next(node for node in base.body if isinstance(node, ast.FunctionDef) and node.name == "_vp_enter")
    after = next(node for node in updated.body if isinstance(node, ast.FunctionDef) and node.name == "_vp_enter")
    assert ast.dump(before, include_attributes=False) == ast.dump(RestoreSpeed().visit(after), include_attributes=False)


@pytest.mark.parametrize("delivery_on,memory_on,speed", [(False, False, 30), (False, True, 100), (True, False, 100)])
def test_missing_canonical_is_measured_then_replanned_at_phase_speed(delivery_on, memory_on, speed):
    ns, robot = delivery(20)
    ns["DELIVERY_LOG"]["on"] = delivery_on
    ns["OPT2_MOTION_STATE"]["memory_travel_active"] = memory_on
    ns["VP_STATE"]["canonical_hints"].clear()
    candidate = {"key": "p", "roadId": "a", "progressCm": 40}
    assert ns["_vp_travel"](candidate) == "replan"
    assert robot.progress == 30
    assert ns["_vp_canonical_unit"]("a", 30) == (0.0, 1.0)
    assert "p" not in ns["VP_STATE"]["failed"]
    assert ns["_vp_travel"](candidate) == "arrived"
    assert all(call[2] == speed for call in robot.calls if call[0] == "follow_road")
    ns["counted_observe"].assert_not_called()


def test_unknown_canonical_at_reached_junction_uses_exit_without_learning_step():
    ns, robot = delivery(100, [edge("a", "n0", "n1"), edge("b", "n1", "n2")])
    ns["VP_STATE"]["canonical_hints"].clear()
    assert ns["_vp_travel"]({"key": "b40", "roadId": "b", "progressCm": 40}) == "replan"
    assert robot.calls == [("take_exit", "b", 100, True)]
    assert ns["_vp_canonical_unit"]("b", 25) == (0, 1)


def test_unknown_direction_blocked_ahead_learns_reverse_and_preserves_retreat():
    ns, robot = delivery(20)
    ns["VP_STATE"]["canonical_hints"].clear()
    robot.stops[("a", 1)] = 20
    assert ns["_vp_travel"]({"key": "p", "roadId": "a", "progressCm": 5}) == "replan"
    assert robot.progress == 10
    assert ns["_vp_canonical_unit"]("a", 10) == (0, 1)
    assert len([call for call in robot.calls if call[0] == "follow_road"]) == 2
    assert not ns["blocked_directions"]


def test_no_motion_cannot_fabricate_direction_or_loop():
    ns, robot = delivery(20)
    ns["VP_STATE"]["canonical_hints"].clear()
    robot.stops[("a", 1)] = 20
    robot.stops[("a", -1)] = 20
    assert ns["_vp_travel"]({"key": "p", "roadId": "a", "progressCm": 40}) == "unreachable"
    assert robot.progress == 20
    assert ns["_vp_canonical_unit"]("a", 20) is None
    assert "p" not in ns["VP_STATE"]["failed"]
    assert len([call for call in robot.calls if call[0] == "follow_road"]) == 2


def test_residual_parking_and_cross_road_alias_do_not_repeat_heading_grid():
    ns, _ = delivery(40, [edge("a", "n0", "n1"), edge("b", "n1", "n2")])
    previewed = [{"roadId": "a", "progressCm": 40, "x": 0, "z": .4}]
    ns["VP_STATE"]["roads"]["a"] = [{"s": 39.9, "x": 0, "z": .399, "yaw": 0}]
    ns["VP_STATE"]["roads"]["b"] = [{"s": 25, "x": 0, "z": .4, "yaw": 0}]
    points = ns["_opt2_storage_candidates"](ns["mission"]["storage"], set(), set(), previewed)
    assert not any(point["progressCm"] in (39.9, 40) and point["roadId"] == "a" for point in points)
    assert not any(point["roadId"] == "b" for point in points)
    assert any(point["progressCm"] == 45 and point["roadId"] == "a" for point in points)


def test_local_stop_explores_public_node_exit_without_deleting_boundary():
    ns, robot = delivery(90, [edge("a", "n0", "n1"), edge("b", "n1", "n2")])
    robot.junction_stop = True
    ns["mission"]["storage"] = {"roadId": "a", "progressCm": 20}
    ns["VP_STATE"]["local_blocks"] = {("a", -1, 90): 90}
    assert ns["_vp_path"](robot.road_state(), "a", 20) is None
    explored, reported = set(), set()
    assert ns["_opt2_explore_storage"](ns["mission"]["storage"], explored, reported)
    assert any(call[0] == "take_exit" for call in robot.calls)
    assert ns["VP_STATE"]["local_blocks"] == {("a", -1, 90): 90}
    assert ns["_vp_path"](robot.road_state(), "a", 20) is not None


def test_failed_public_exits_are_finite_and_oneway_blocked_roads_are_filtered():
    ns, robot = delivery(100, [edge("a", "n0", "n1"), edge("b", "n1", "n2"),
                               edge("c", "n2", "n1", one_way=True)])
    ns["blocked_roads"].add("b")
    ns["_vp_enter"] = Mock(return_value=False)
    ns["_vp_travel"] = Mock(return_value="unreachable")
    explored, reported = set(), set()
    assert not ns["_opt2_explore_storage"](ns["mission"]["storage"], explored, reported)
    assert ns["_vp_enter"].call_args_list == [(("a",),)]
    count = ns["_vp_travel"].call_count
    assert not ns["_opt2_explore_storage"](ns["mission"]["storage"], explored, reported)
    assert ns["_vp_enter"].call_count == 1
    assert ns["_vp_travel"].call_count == count


def test_release_after_fine_road_change_can_bootstrap_missing_geometry():
    ns, robot = delivery(20)
    ns["VP_STATE"]["canonical_hints"].clear()
    assert ns["release_target_at_storage"]()
    assert robot.completed == 1
    assert any(call[0] == "follow_road" for call in robot.calls)
    ns["counted_observe"].assert_not_called()


def test_unknown_oneway_heading_uses_controller_rejection_then_legal_direction():
    ns, robot = delivery(20, [edge("a", "n0", "n1", one_way=True)])
    ns["DELIVERY_LOG"]["on"] = False
    ns["VP_STATE"]["canonical_hints"].clear()
    robot.heading = 180
    assert ns["_vp_travel"]({"key": "p", "roadId": "a", "progressCm": 40}) == "replan"
    assert robot.progress == 30
    calls = [call for call in robot.calls if call[0] == "follow_road"]
    assert len(calls) == 2 and all(call[2] == 30 for call in calls)
    measurements = [call.kwargs for call in ns["_vp_event"].call_args_list
                    if call.args[0] == "viewpoint_direction_measurement"]
    assert measurements[0]["stoppedBy"] == "wrong_way" and not measurements[0]["moved"]
    assert measurements[1]["moved"]


def test_failed_storage_exit_does_not_trigger_another_full_scan_at_same_progress():
    ns, robot = delivery(50)
    ns["nav_release_preview"].return_value["wouldCompleteDelivery"] = False
    ns["_opt2_storage_candidates"] = Mock(side_effect=[[
        {"key": "a50", "roadId": "a", "progressCm": 50, "anchor_path_cm": 0, "path_cm": 0}], [
        {"key": "a49.9", "roadId": "a", "progressCm": 49.9, "anchor_path_cm": .1, "path_cm": .1}], []])
    ns["_opt2_explore_storage"] = Mock(return_value=False)
    assert not ns["release_target_at_storage"]()
    assert ns["nav_release_preview"].call_count == 36
    assert any(call.kwargs.get("reason") == "same_parking_point_already_previewed"
               for call in ns["_delivery_event"].call_args_list)
    assert robot.holding() == "目标物"
