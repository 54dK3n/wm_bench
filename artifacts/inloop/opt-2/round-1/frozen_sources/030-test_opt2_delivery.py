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
FRAGMENT = ROOT / "programs/opt2_delivery_fragment.py"


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
    tree = ast.parse((ROOT / "programs/demo_flow_fragment.py").read_text())
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
    assert ("follow_road", 10.0, 100, True) in robot.calls
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


def test_vp_overrides_have_only_speed_expression_change_from_frozen_r2():
    base = ast.parse(FROZEN.read_text())
    updated = ast.parse(FRAGMENT.read_text())
    class RestoreSpeed(ast.NodeTransformer):
        def visit_Call(self, node):
            if isinstance(node.func, ast.Name) and node.func.id == "_opt2_travel_speed":
                return ast.copy_location(ast.Name(id="SLOW_SPEED", ctx=ast.Load()), node)
            return self.generic_visit(node)
    for name in ("_vp_enter", "_vp_travel"):
        before = next(node for node in base.body if isinstance(node, ast.FunctionDef) and node.name == name)
        after = next(node for node in updated.body if isinstance(node, ast.FunctionDef) and node.name == name)
        after = RestoreSpeed().visit(after)
        assert ast.dump(before, include_attributes=False) == ast.dump(after, include_attributes=False)
