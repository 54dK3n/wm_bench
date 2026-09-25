"""Synthetic regression cases for near memory with farther fresh camera range.

Only the initial distance pairs come from Run08 sensor logs. The straight road,
camera response, and actuator outcomes below are synthetic; they do not model
the live map or establish that a subsequent live run will succeed.
"""
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions


RANGE_PAIRS = [(61.991369447611035, 70.96864831142133),
               (58.13136344830492, 74.02842535359996)]


def range_runtime(memory_cm, fresh_cm, *, actuator="progress", on_road=True):
    target = {"id": "red", "category": "red-ball", "state": "CONFIRMED",
              "position_m": {"x": 0, "z": memory_cm / 100}}
    detection = {"track_id": "red", "category": "red-ball", "frame_id": "1",
                 "distance_cm": fresh_cm, "bearing_deg": 0}
    snapshot = {
        "observation_index": 1, "observation": {"frameId": 1},
        "odometry": {"rightCm": 0, "forwardCm": 0, "headingDeg": 0, "tick": 0},
        "holding": {"holding": False},
        "road": {"onRoad": on_road, "atNode": False, "exits": [],
                 "headingErrorDeg": 0, "leftClearanceCm": 20,
                 "rightClearanceCm": 20, "frontClearanceCm": 100},
        "perception": {"detections": [detection]},
    }
    moves, routes, logs = [], [], []

    def route_to(odometry, goal):
        routes.append((dict(odometry), goal))
        return [(0, 0), (0, memory_cm / 100)]

    def observe(*, motion=None):
        snapshot["observation_index"] += 1
        snapshot["observation"]["frameId"] += 1
        snapshot["odometry"]["tick"] += 1
        detection["frame_id"] = str(snapshot["observation"]["frameId"])

    def call(method, params):
        moves.append((method, dict(params), detection["distance_cm"]))
        assert method in {"forward", "follow_road"}, "An aligned synthetic target needs no other primitive"
        assert .1 <= params["distanceCm"] <= (20 if method == "follow_road" else 10)
        if actuator == "blocked":
            return {"accepted": True, "completed": False, "stoppedBy": "front_clearance", "distanceCm": 0}
        if actuator == "stationary":
            return {"accepted": True, "completed": True, "stoppedBy": "junction", "distanceCm": 0}
        snapshot["odometry"]["forwardCm"] += params["distanceCm"]
        detection["distance_cm"] -= params["distanceCm"]
        return {"accepted": True, "completed": True, "distanceCm": params["distanceCm"]}

    runtime = SimpleNamespace(
        snapshot=snapshot, round=1,
        perception=SimpleNamespace(confirmed=lambda oid: target,
                                   get_object=lambda oid: target,
                                   visible=lambda oid: detection),
        roads=SimpleNamespace(route_to=route_to),
        bridge=SimpleNamespace(seconds=0, max_seconds=1200, call=call),
        motion_log=SimpleNamespace(write=logs.append), observe=observe,
    )
    return runtime, moves, routes, logs, detection


@pytest.mark.parametrize("memory_cm,fresh_cm", RANGE_PAIRS)
def test_far_fresh_view_allows_bounded_road_progress_before_visual_success(memory_cm, fresh_cm):
    runtime, moves, routes, logs, detection = range_runtime(memory_cm, fresh_cm)
    result = Actions(runtime).go_to("red")

    assert moves, "Fresh range above 65 cm must not preempt the available bounded road approach"
    assert moves[0][0] == "forward" and moves[0][2] > 65
    assert len(routes) == 1
    assert 1 <= len(moves) <= 9
    assert all(.1 <= params["distanceCm"] <= 10 for _, params, _ in moves)
    assert len(logs) == len(moves)
    assert all(row["after_observation"] == row["before_observation"] + 1 for row in logs)
    assert result["success"] is True
    assert 25 <= detection["distance_cm"] <= 40 and abs(detection["bearing_deg"]) <= 10
    assert str(result["evidence"]["frame_id"]) == detection["frame_id"]


def test_far_fresh_view_does_not_ignore_a_blocked_road_or_claim_success():
    runtime, moves, routes, _, detection = range_runtime(*RANGE_PAIRS[0], actuator="blocked")
    result = Actions(runtime).go_to("red")

    assert result["success"] is False
    assert result["reason"] == "route_blocked"
    assert len(moves) == 1 and len(routes) == 1
    assert detection["distance_cm"] > 65
    assert runtime.snapshot["odometry"]["forwardCm"] == 0


def test_far_fresh_view_stops_after_one_road_command_with_no_pose_progress():
    runtime, moves, routes, _, detection = range_runtime(*RANGE_PAIRS[0], actuator="stationary")
    result = Actions(runtime).go_to("red")

    assert result["success"] is False
    assert result["reason"] == "route_no_progress"
    assert len(moves) == 1 and len(routes) == 1
    assert detection["distance_cm"] > 65


@pytest.mark.parametrize("memory_cm,fresh_cm", RANGE_PAIRS)
def test_visual_servo_itself_keeps_the_original_65_cm_range_gate(memory_cm, fresh_cm):
    runtime, moves, routes, _, _ = range_runtime(memory_cm, fresh_cm)
    result = Actions(runtime).visual_standoff("red")

    assert result["success"] is False
    assert result["reason"] == "visual_standoff_range_not_supported"
    assert moves == [] and routes == []


def test_far_fresh_view_never_moves_when_current_road_observation_is_off_road():
    runtime, moves, routes, _, _ = range_runtime(*RANGE_PAIRS[0], on_road=False)
    result = Actions(runtime).go_to("red")

    assert result["success"] is False
    assert result["reason"] == "not_on_observed_road"
    assert moves == [] and routes == []


def test_exact_supported_visual_boundary_still_requires_fresh_standoff_evidence():
    runtime, moves, routes, _, detection = range_runtime(62, 65)
    result = Actions(runtime).go_to("red")

    assert result["success"] is True
    assert 1 <= len(moves) <= 8 and routes == []
    assert 25 <= detection["distance_cm"] <= 40 and abs(detection["bearing_deg"]) <= 10
    assert str(result["evidence"]["frame_id"]) == detection["frame_id"]


def test_fresh_supported_view_enters_visual_control_when_memory_is_slightly_farther():
    runtime, moves, routes, _, detection = range_runtime(66, 50)
    result = Actions(runtime).go_to("red")

    assert routes == [], "A same-identity current-frame 50 cm view should enter existing visual control directly"
    assert result["success"] is True
    assert moves and all(method == "forward" and .1 <= params["distanceCm"] <= 10
                         for method, params, _ in moves)
    assert 25 <= detection["distance_cm"] <= 40 and abs(detection["bearing_deg"]) <= 10
    assert str(result["evidence"]["frame_id"]) == detection["frame_id"]
