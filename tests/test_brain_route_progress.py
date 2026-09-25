"""Sensor-only route progress regressions; no simulator or live API is used.

The two reported loop poses are explicit fixture values. These tests never read
run artifacts, layouts, evaluator state, credentials, or the platform.
"""

import copy
import math
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.navigation import distance, heading_to, position, wrap


class SensorRuntime:
    """Only the public observation, odometry and actuator surface actions use."""

    def __init__(self, *, goal, pose=(0, 0, 0), exits=(), route=(), actuator=None,
                 confirmed=True):
        self.target = {"id": "zone-1", "category": "storage-zone",
                       "state": "CONFIRMED" if confirmed else "TENTATIVE",
                       "position_m": {"x": goal[0], "z": goal[1]}}
        self.snapshot = {
            "observation_index": 1, "observation": {"frameId": 1},
            "odometry": {"tick": 1}, "holding": {"holding": False},
            "perception": {"detections": []},
        }
        self.set_pose(*pose, exits=exits)
        self.detection = None
        self.round = 1
        self.motions, self.selected_exits, self.motion_records = [], [], []
        self.selected_headings = []
        self.route_calls = []
        self._route, self._actuator = route, actuator
        self.perception = SimpleNamespace(
            confirmed=lambda oid: self.target if confirmed and oid == "zone-1" else None,
            get_object=lambda oid: self.target if oid == "zone-1" else None,
            visible=lambda oid: self.detection if oid == "zone-1" else None,
        )
        def chosen(odo, angle, *, observation_index=None):
            self.selected_exits.append(angle)
            self.selected_headings.append(wrap(odo["headingDeg"] + angle))
        self.roads = SimpleNamespace(route_to=self.route_to, chosen=chosen)
        self.bridge = SimpleNamespace(seconds=0, max_seconds=1200, call=self.call)
        self.motion_log = SimpleNamespace(write=self.motion_records.append)

    def set_pose(self, x, z, heading, *, exits=()):
        self.snapshot["odometry"].update(rightCm=x * 100, forwardCm=z * 100, headingDeg=heading)
        self.snapshot["road"] = {"onRoad": True, "atNode": bool(exits),
                                 "headingErrorDeg": 0, "leftClearanceCm": 20, "rightClearanceCm": 20,
                                 "exits": [{"angleDeg": a} for a in exits],
                                 "frontClearanceCm": 200}

    def route_to(self, odo, goal):
        self.route_calls.append((copy.deepcopy(odo), goal))
        return list(self._route(self) if callable(self._route) else self._route)

    def call(self, method, params):
        self.motions.append((method, copy.deepcopy(params)))
        if method == "turn":
            odo = self.snapshot["odometry"]
            odo["headingDeg"] = wrap(odo["headingDeg"] + params["angleDeg"])
            for entry in self.snapshot["road"]["exits"]:
                entry["angleDeg"] = wrap(entry["angleDeg"] - params["angleDeg"])
            return {"accepted": True, "completed": True}
        if self._actuator:
            return self._actuator(self, method, params)
        return {"accepted": True, "distanceCm": 0, "stoppedBy": "front_clearance"}

    def observe(self, *, motion=None):
        self.snapshot["observation_index"] += 1
        self.snapshot["observation"]["frameId"] += 1
        self.snapshot["odometry"]["tick"] += 1

    def show_target(self):
        odo = self.snapshot["odometry"]
        goal = (self.target["position_m"]["x"], self.target["position_m"]["z"])
        self.detection = {"category": "storage-zone", "distance_cm": distance(position(odo), goal) * 100,
                          "bearing_deg": -wrap(heading_to(position(odo), goal) - odo["headingDeg"])}


def test_intermediate_junction_keeps_the_unfinished_next_waypoint():
    # Run06 sensor poses A (obs125) -> C (obs126). The remembered next
    # waypoint B is still 21.4cm ahead of C, outside the existing 15cm gate.
    a, b, c = (-1.177, .498), (-1.090, .121), (-1.086, .335)

    def actuator(runtime, method, params):
        assert method == "take_exit"
        if len(runtime.selected_exits) == 1:
            runtime.set_pose(*c, -156.6, exits=(171.6, 66.6, -25.7))
            return {"accepted": True, "distanceCm": 31.3, "stoppedBy": "junction"}
        # Stop after the second decision so a wrong selected exit is exposed
        # without modeling additional road movement.
        return {"accepted": True, "distanceCm": 0, "stoppedBy": "front_clearance"}

    runtime = SensorRuntime(goal=(1.477, -.307), pose=(*a, 30.5),
                            exits=(59.5, -41.8, -180), route=(a, b), actuator=actuator)
    Actions(runtime).go_to("zone-1")
    assert runtime.selected_headings == pytest.approx([-149.5, 177.7]), (
        "The second exit must continue toward B; 171.6 degrees returns to A")
    assert runtime.selected_exits == pytest.approx([0, 0])


@pytest.mark.parametrize("route", [(), ((0, 0),)], ids=["no-known-route", "only-start-vertex"])
def test_exhausted_known_route_requires_exploration_without_goal_vector_motion(route):
    # Run06 obs179 has only a return exit. The target is about 1.5m away;
    # the singleton route says nothing about how to reach it from this point.
    runtime = SensorRuntime(goal=(1.477, -.307), pose=(0, .024, -179.2),
                            exits=(179.2,), route=route)
    result = Actions(runtime).go_to("zone-1")
    assert runtime.motions == [], "Route exhaustion must not invent a new leg toward the object"
    assert result["success"] is False
    assert "needs_exploration" in result["reason"]


def test_exact_same_pose_and_waypoint_returns_without_45_duplicate_commands():
    runtime = SensorRuntime(goal=(0, 2), route=((0, 0), (0, 1)),
                            actuator=lambda *_: {"accepted": True, "distanceCm": 0,
                                                 "stoppedBy": "junction"})
    result = Actions(runtime).go_to("zone-1")
    assert result["success"] is False
    assert result["reason"] == "route_no_progress"
    assert runtime.motions == [("follow_road", {"distanceCm": 20, "speed": 50})]


def test_near_angled_junction_reacquires_then_stops_after_one_no_motion_step():
    # Run06 round44 reported 49.13cm / 42.60deg: neither the >60cm exit
    # branch nor the <=40deg final-approach branch applies. The junction
    # After reacquiring by turning, a no-motion actuator result must still
    # stop instead of issuing the previous 45 identical movement requests.
    goal = (.4913 * math.sin(math.radians(42.6)), .4913 * math.cos(math.radians(42.6)))
    runtime = SensorRuntime(goal=goal, exits=(-90, 0, 90), route=((0, 0), (0, 1)),
                            actuator=lambda *_: {"accepted": True, "distanceCm": 0,
                                                 "stoppedBy": "junction"})
    result = Actions(runtime).go_to("zone-1")
    assert result["success"] is False
    assert result["reason"] == "route_no_progress"
    assert [method for method, _ in runtime.motions] == ["turn", "forward"]


def test_take_exit_can_overshoot_a_waypoint_and_continue_to_fresh_standoff():
    def actuator(runtime, method, params):
        assert method == "take_exit"
        if params["angleDeg"] != 0:
            return {"accepted": True, "distanceCm": 0, "stoppedBy": "front_clearance"}
        z = .40 if len(runtime.motions) == 1 else .75
        runtime.set_pose(0, z, 0, exits=(0, -180))
        if z == .75:
            runtime.show_target()
        return {"accepted": True, "distanceCm": 40 if z == .40 else 35,
                "stoppedBy": "junction"}

    # A 40cm sensor step crosses the 18cm waypoint and ends 22cm beyond it.
    # Keeping that crossed waypoint indefinitely would select the reverse exit.
    runtime = SensorRuntime(goal=(0, 1.07), exits=(0, -180),
                            route=((0, 0), (0, .18), (0, .75)), actuator=actuator)
    result = Actions(runtime).go_to("zone-1")
    assert result["success"] is True
    assert result["reason"] == "target_seen_at_standoff"
    assert runtime.selected_exits == [0, 0]
    assert result["evidence"]["distance_cm"] == pytest.approx(32)


def test_one_motion_cannot_consume_overshot_waypoints_in_reverse_route_order():
    def actuator(runtime, method, params):
        assert method == "take_exit"
        if len(runtime.motions) == 1:
            runtime.set_pose(0, .4, 0, exits=(0, -90, -180))
            return {"accepted": True, "distanceCm": 40, "stoppedBy": "junction"}
        return {"accepted": True, "distanceCm": 0, "stoppedBy": "front_clearance"}

    # The next recorded leg doubles back to .05 before going right. Crossing
    # .18 while going forward does not also traverse that return leg.
    runtime = SensorRuntime(goal=(1, 1), exits=(0, -180),
                            route=((0, 0), (0, .18), (0, .05), (1, .05)), actuator=actuator)
    Actions(runtime).go_to("zone-1")
    assert runtime.selected_headings == [0, -180]
    assert runtime.selected_exits == [0, 0]


def test_normal_route_progress_still_reaches_a_fresh_visual_standoff():
    def actuator(runtime, method, params):
        assert method == "take_exit"
        assert params["angleDeg"] == 0
        z = .4 if len(runtime.motions) == 1 else .8
        runtime.set_pose(0, z, 0, exits=(0, -180))
        if z == .8:
            runtime.show_target()
        return {"accepted": True, "distanceCm": 40, "stoppedBy": "junction"}

    def route(runtime):
        return ((0, 0), (0, .4), (0, .8)) if position(runtime.snapshot["odometry"])[1] == 0 else ((0, .4), (0, .8))

    runtime = SensorRuntime(goal=(0, 1.12), exits=(0, -180), route=route, actuator=actuator)
    result = Actions(runtime).go_to("zone-1")
    assert result["success"] is True
    assert runtime.selected_exits == [0, 0]
    assert result["evidence"]["distance_cm"] == pytest.approx(32)


@pytest.mark.parametrize("distance_m", [.45, .62])
def test_empty_route_preserves_legal_close_approach(distance_m):
    def actuator(runtime, method, params):
        assert method == "forward", "Close approach must remain a bounded forward step"
        assert 0 < params["distanceCm"] <= 10
        odo = runtime.snapshot["odometry"]
        runtime.set_pose(0, odo["forwardCm"] / 100 + params["distanceCm"] / 100, 0)
        runtime.show_target()
        return {"accepted": True, "distanceCm": params["distanceCm"], "completed": True}

    runtime = SensorRuntime(goal=(0, distance_m), route=(), actuator=actuator)
    result = Actions(runtime).go_to("zone-1")
    assert result["success"] is True
    assert result["reason"] == "target_seen_at_standoff"
    assert 25 <= result["evidence"]["distance_cm"] <= 40


def test_a_route_does_not_bypass_confirmed_target_requirement():
    runtime = SensorRuntime(goal=(0, 1), route=((0, 0), (0, .7)), confirmed=False)
    result = Actions(runtime).go_to("zone-1")
    assert result["reason"] == "object_not_confirmed"
    assert result["success"] is False
    assert runtime.motions == []
    assert runtime.route_calls == []
