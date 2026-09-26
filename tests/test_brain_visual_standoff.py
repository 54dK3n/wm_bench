"""Visual standoff corrections from explicit, synthetic sensor feedback."""
import math
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions


def visual_runtime(range_cm, bearing=0, *, blocked=False, lose_on_turn=False):
    target = {"id": "zone", "category": "storage-zone", "state": "CONFIRMED",
              "position_m": {"x": 0, "z": .32}}
    camera = {"distance_cm": range_cm, "bearing_deg": bearing, "frame_id": "1",
              "track_id": "zone", "category": "storage-zone"}
    snapshot = {"observation_index": 1, "observation": {"frameId": 1},
                "odometry": {"rightCm": 0, "forwardCm": 0, "headingDeg": 0, "tick": 0},
                "holding": {"holding": True},
                "road": {"onRoad": True, "atNode": False, "exits": [],
                         "headingErrorDeg": 0, "leftClearanceCm": 20,
                         "rightClearanceCm": 20, "frontClearanceCm": 100},
                "perception": {"detections": [camera]}}
    moves = []
    runtime = SimpleNamespace(snapshot=snapshot, round=1,
        perception=SimpleNamespace(confirmed=lambda oid: target, get_object=lambda oid: target,
                                   visible=lambda oid: camera if snapshot["perception"]["detections"] else None),
        roads=SimpleNamespace(route_to=lambda odo, goal: [(0, 0)]),
        bridge=SimpleNamespace(seconds=0, max_seconds=1200),
        motion_log=SimpleNamespace(write=lambda row: None))

    def observe(*, motion=None):
        snapshot["observation_index"] += 1
        snapshot["observation"]["frameId"] += 1
        snapshot["odometry"]["tick"] += 1
        camera["frame_id"] = str(snapshot["observation"]["frameId"])

    def call(method, params):
        moves.append((method, params))
        if method == "turn":
            camera["bearing_deg"] += params["angleDeg"]
            snapshot["odometry"]["headingDeg"] += params["angleDeg"]
            if lose_on_turn:
                snapshot["perception"]["detections"] = []
        elif method in {"forward", "backward"}:
            if blocked:
                return {"stoppedBy": "front_clearance", "distanceCm": 0}
            signed = params["distanceCm"] * (1 if method == "forward" else -1)
            camera["distance_cm"] -= signed
            theta = math.radians(snapshot["odometry"]["headingDeg"])
            snapshot["odometry"]["rightCm"] -= math.sin(theta) * signed
            snapshot["odometry"]["forwardCm"] += math.cos(theta) * signed
        else:
            raise AssertionError("Visual standoff must not select another road")
        return {"accepted": True, "completed": True}

    runtime.observe, runtime.bridge.call = observe, call
    return runtime, moves, camera


@pytest.mark.parametrize("range_cm", [24.481849625163253, 45])
def test_memory_standoff_is_corrected_until_current_camera_verifies_it(range_cm):
    runtime, moves, camera = visual_runtime(range_cm, 1.4101447726265872)
    result = Actions(runtime).execute({"action": "go_to", "params": {"object_id": "zone"}})
    assert result["success"] is True
    translations = [(method, params) for method, params in moves if method != "turn"]
    assert translations and translations[0][0] == ("backward" if range_cm < 25 else "forward")
    assert all(.1 <= params["distanceCm"] <= 10 for _, params in translations)
    assert 25 <= camera["distance_cm"] <= 40 and abs(camera["bearing_deg"]) <= 10
    assert result["evidence"]["frame_id"] == runtime.snapshot["observation"]["frameId"]
    assert runtime.perception.get_object("zone")["position_m"] == {"x": 0, "z": .32}


def test_visual_reverse_stops_on_observed_blockage():
    runtime, moves, camera = visual_runtime(24.481849625163253, blocked=True)
    result = Actions(runtime).go_to("zone")
    assert result["success"] is False
    assert [method for method, _ in moves] == ["backward"]
    assert result["evidence"]["actuator_result"]["stoppedBy"] == "front_clearance"


def test_turn_then_target_disappears_does_not_translate_blindly():
    runtime, moves, _ = visual_runtime(32, 24, lose_on_turn=True)
    result = Actions(runtime).go_to("zone")
    assert result["success"] is False
    assert [method for method, _ in moves] == ["turn"]


def test_camera_already_in_window_requires_no_standoff_motion():
    runtime, moves, _ = visual_runtime(32, 2)
    result = Actions(runtime).execute({"action": "go_to", "params": {"object_id": "zone"}})
    assert result["success"] is True
    assert moves == []
