"""Sensor-only regression of run07 and bounded recovery, without scene data."""
import math

import pytest

from autonomous_brain import actions as module
from test_brain_visual_standoff import visual_runtime


def test_run07_visual_step_does_not_cross_observed_left_margin():
    runtime, moves, camera = visual_runtime(40.653087623, 0)
    road = runtime.snapshot["road"]
    road.update(headingErrorDeg=-44.9, leftClearanceCm=4, rightClearanceCm=14.4)
    runtime.snapshot["odometry"]["headingDeg"] = -173.8
    original = runtime.bridge.call

    def call(method, params):
        if method == "forward":
            assert params["distanceCm"] * abs(math.sin(math.radians(44.9))) < 4
        return original(method, params)

    runtime.bridge.call = call
    outcome = module.Actions(runtime).go_to("zone")
    assert outcome["success"]
    assert 25 <= camera["distance_cm"] <= 40
    assert len(moves) == 1
    assert runtime.perception.get_object("zone")["position_m"] == {"x": 0, "z": .32}


@pytest.mark.parametrize("method,error,side", [
    ("forward", -45, "leftClearanceCm"), ("forward", 45, "rightClearanceCm"),
    ("backward", -45, "rightClearanceCm"), ("backward", 45, "leftClearanceCm")])
def test_translation_uses_correct_side_in_both_directions(method, error, side):
    road = {"onRoad": True, "headingErrorDeg": error, "leftClearanceCm": 20,
            "rightClearanceCm": 20, "frontClearanceCm": 100, side: 2}
    length, evidence = module.road_translation_limit(road, method, 10)
    assert evidence["side"] == side
    assert 0 < length * abs(math.sin(math.radians(error))) < 2


@pytest.mark.parametrize("missing", ["headingErrorDeg", "leftClearanceCm", "rightClearanceCm", "frontClearanceCm"])
def test_missing_road_geometry_cannot_authorize_straight_approach(missing):
    runtime, moves, _ = visual_runtime(45)
    runtime.snapshot["road"].pop(missing)
    result = module.Actions(runtime).go_to("zone")
    assert not result["success"]
    assert result["reason"] == "visual_standoff_requires_road_reposition"
    assert not moves


def test_front_clearance_also_bounds_translation():
    runtime, _, _ = visual_runtime(45)
    runtime.snapshot["road"]["frontClearanceCm"] = 2
    length, _ = module.road_translation_limit(runtime.snapshot["road"], "forward", 10)
    assert 0 < length < 2


def test_near_target_behind_camera_is_reacquired_before_route_exhaustion():
    runtime, moves, camera = visual_runtime(55, 139.6)
    target = runtime.perception.get_object("zone")
    angle = math.radians(139.6)
    target["position_m"] = {"x": .55 * math.sin(angle), "z": .55 * math.cos(angle)}
    runtime.snapshot["perception"]["detections"] = []
    original = runtime.bridge.call

    def call(method, params):
        result = original(method, params)
        if method == "turn":
            runtime.snapshot["perception"]["detections"] = [camera]
        return result

    runtime.bridge.call = call
    result = module.Actions(runtime).go_to("zone")
    assert result["success"]
    assert moves[0][0] == "turn"
    assert moves[0][1]["angleDeg"] == pytest.approx(-139.6)
    assert 25 <= camera["distance_cm"] <= 40


def test_curvature_departure_reverses_only_last_measured_short_step():
    runtime, moves, camera = visual_runtime(45)
    original = runtime.bridge.call

    def call(method, params):
        result = original(method, params)
        if method == "forward":
            runtime.snapshot["road"]["onRoad"] = False
        elif method == "backward":
            runtime.snapshot["road"]["onRoad"] = True
        return result

    runtime.bridge.call = call
    result = module.Actions(runtime).go_to("zone")
    assert not result["success"]
    assert result["reason"] == "visual_standoff_left_road"
    assert [m for m, _ in moves] == ["forward", "backward"]
    assert moves[1][1]["distanceCm"] == pytest.approx(moves[0][1]["distanceCm"])
    assert runtime.snapshot["road"]["onRoad"]
    assert result["evidence"]["recovery_result"]["stoppedBy"] == "recovered_observed_road"


def test_recovery_rejects_unrecorded_turn_or_lateral_motion():
    for after in ({"headingDeg": 20, "forwardCm": 5}, {"rightCm": 5}):
        runtime, moves, _ = visual_runtime(45)
        before = dict(runtime.snapshot["odometry"])
        runtime.snapshot["odometry"].update(after)
        result = module.Actions(runtime).reverse_last_straight_step("forward", 10, before)
        assert result["stoppedBy"] == "last_translation_not_reversible_from_odometry"
        assert not moves
