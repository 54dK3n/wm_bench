"""Bounded place budgets and odometry-only recovery from synthetic observations."""
import math
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions


def place_runtime(views, *, road=lambda odo: True, block_return=False, actual_first_cm=None,
                  approach_step_cm=None, turn_fraction=1):
    """Observe a fixed initial ground point after actual synthetic motions.

    The first view supplies its initial polar coordinates. Subsequent entries
    control visibility only; they cannot teleport the target during approach.
    Partial responses affect approach primitives, while recovery follows the
    measured segments with the default actuator response.
    """
    objects = {"held": {"id": "held", "category": "red-ball", "state": "HELD",
                         "position_m": {"x": 0, "z": .18}}}
    views = list(views)
    initial_distance, initial_bearing = views[0]
    target = (initial_distance * math.sin(math.radians(initial_bearing)) / 100,
              initial_distance * math.cos(math.radians(initial_bearing)) / 100)
    snapshot = {"observation_index": 1, "observation": {"frameId": 1},
                "odometry": {"rightCm": 0., "forwardCm": 0., "headingDeg": 0., "tick": 0},
                "road": {"onRoad": True, "frontClearanceCm": 100}, "holding": {"holding": True},
                "perception": {"detections": []}}
    motions, logs, delivery_evidence = [], [], []
    released = False

    def set_view(view):
        odo = snapshot["odometry"]
        dx, dz = target[0] * 100 - odo["rightCm"], target[1] * 100 - odo["forwardCm"]
        bearing = (odo["headingDeg"] + math.degrees(math.atan2(dx, dz)) + 180) % 360 - 180
        snapshot["perception"]["detections"] = [] if view is None else [{
            "category": "storage-zone", "distance_cm": math.hypot(dx, dz), "bearing_deg": bearing,
            "bbox": {"x": 100, "y": 200, "w": 100, "h": 60}}]

    set_view(views.pop(0))
    snapshot["road"]["onRoad"] = road(snapshot["odometry"])

    def project(u, v):
        assert (u, v) == (150, 230)
        odo = snapshot["odometry"]
        dx, dz = target[0] - odo["rightCm"] / 100, target[1] - odo["forwardCm"] / 100
        theta = math.radians(odo["headingDeg"])
        return math.cos(theta) * dx + math.sin(theta) * dz, -math.sin(theta) * dx + math.cos(theta) * dz

    def observe():
        snapshot["observation_index"] += 1
        snapshot["observation"]["frameId"] += 1
        snapshot["odometry"]["tick"] += 1
        snapshot["road"]["onRoad"] = road(snapshot["odometry"])
        for d in snapshot["perception"]["detections"]:
            d["frame_id"] = str(snapshot["observation"]["frameId"])

    def mark_delivered(oid, *, holding, ball_in_storage, **kwargs):
        delivery_evidence.append(kwargs["evidence"])
        if holding or not ball_in_storage:
            return False
        objects[oid]["state"] = "DELIVERED"
        return True

    def mark_unverified(oid, **kwargs):
        objects[oid]["state"] = "RELEASED_UNVERIFIED"

    def call(method, params):
        nonlocal released
        motions.append((method, dict(params)))
        if block_return and ((released and method == "forward") or
                             (not snapshot["perception"]["detections"] and method == "backward")):
            return {"stoppedBy": "front_clearance", "distanceCm": 0}
        odo = snapshot["odometry"]
        if method == "release":
            released = True
            snapshot["holding"]["holding"] = False
        elif method == "turn":
            fraction = turn_fraction if not released and snapshot["perception"]["detections"] else 1
            odo["headingDeg"] = (odo["headingDeg"] + params["angleDeg"] * fraction + 180) % 360 - 180
        else:
            assert method in {"forward", "backward"}
            cm = actual_first_cm if actual_first_cm is not None and len(motions) == 1 else params["distanceCm"]
            if method == "forward" and params["speed"] == 30 and approach_step_cm is not None:
                cm = min(cm, approach_step_cm)
            signed = cm if method == "forward" else -cm
            theta = math.radians(odo["headingDeg"])
            odo["rightCm"] -= math.sin(theta) * signed
            odo["forwardCm"] += math.cos(theta) * signed
        if not released:
            view = views.pop(0) if views else True if snapshot["perception"]["detections"] else None
            set_view(view)
        elif released and method == "backward":
            snapshot["perception"]["detections"] = [
                {"category": "storage-zone", "distance_cm": 40, "bearing_deg": 0,
                 "bbox": {"x": 100, "y": 200, "w": 100, "h": 60}},
                {"category": "red-ball", "track_id": "fresh-release", "position_m": {"x": 0, "z": .18},
                 "bbox": {"x": 145, "y": 210, "w": 10, "h": 20}},
            ]
        return {"accepted": True, "completed": True}

    runtime = SimpleNamespace(snapshot=snapshot, round=1, pending_grasp=None, held_object_id="held",
        bridge=SimpleNamespace(seconds=0, max_seconds=1200, call=call), observe=observe,
        motion_log=SimpleNamespace(write=logs.append),
        perception=SimpleNamespace(objects=lambda: list(objects.values()),
            get_object=objects.get, mark_delivered=mark_delivered, mark_release_unverified=mark_unverified,
            ground_camera=SimpleNamespace(project_pixel_to_ground=project)))
    return runtime, motions, logs, objects, delivery_evidence


def test_observed_alignment_turns_do_not_spend_the_translation_budget():
    # Real partial turns and translations require more than eight primitives,
    # while every alignment still refers to the same initial ground point.
    runtime, motions, _, objects, evidence = place_runtime(
        [(30, 30)], approach_step_cm=1.5, turn_fraction=.7)
    result = Actions(runtime).place()
    assert result["success"] is True
    before_release = motions[:next(i for i, row in enumerate(motions) if row[0] == "release")]
    assert sum(method == "forward" for method, _ in before_release) == 8
    assert sum(method == "turn" for method, _ in before_release) >= 3
    assert all(params["distanceCm"] <= 7 for method, params in before_release if method == "forward")
    assert objects["held"]["state"] == "DELIVERED"
    assert evidence[0]["placement"]["ball_track_id"] == "fresh-release"
    assert "release_observation" in evidence[0]


def test_eighth_translation_gets_a_fresh_gate_check_before_failing():
    runtime, motions, _, _, _ = place_runtime([(30, 0)], approach_step_cm=1.5)
    result = Actions(runtime).place()
    assert result["success"] is True
    assert sum(method == "forward" for method, _ in motions) == 8
    assert result["evidence"]["release_aim"]["last_alignment"]["frame_id"] == 9
    assert result["evidence"]["release_aim"]["last_alignment"]["distance_cm"] == pytest.approx(18)


def test_translation_budget_stays_at_eight_when_fresh_range_does_not_converge():
    runtime, motions, _, objects, _ = place_runtime([(30, 0)], approach_step_cm=1)
    result = Actions(runtime).place()
    assert result["success"] is False and result["reason"] == "storage_alignment_did_not_converge"
    assert [method for method, _ in motions] == ["forward"] * 8
    assert result["evidence"]["detection"]["distance_cm"] == pytest.approx(22)
    assert result["evidence"]["detection"]["bearing_deg"] == 0
    assert str(result["evidence"]["detection"]["frame_id"]) == str(runtime.snapshot["observation"]["frameId"])
    assert runtime.snapshot["odometry"]["forwardCm"] == 8
    assert runtime.snapshot["holding"]["holding"] is True and objects["held"]["state"] == "HELD"


def test_alignment_stops_after_three_observed_turns_without_translation():
    runtime, motions, _, _, _ = place_runtime([(30, 10)], turn_fraction=.1)
    result = Actions(runtime).place()
    assert result["success"] is False and result["reason"] == "storage_alignment_did_not_converge"
    assert [method for method, _ in motions] == ["turn"] * 3
    assert runtime.snapshot["odometry"]["headingDeg"] == pytest.approx(-2.71)
    assert result["evidence"]["release_aim"]["last_alignment"]["bearing_deg"] == pytest.approx(7.29)
    assert runtime.snapshot["holding"]["holding"] is True


def test_failed_multiturn_approach_retraces_actual_segments_to_road():
    near_origin = lambda odo: math.hypot(odo["rightCm"], odo["forwardCm"]) < .01
    # A small initial angular error grows after translation, requiring a real
    # corrective turn before the next segment. The ground target never moves.
    runtime, motions, logs, _, _ = place_runtime([(30, 2.5), True, True, None], road=near_origin)
    result = Actions(runtime).place()
    assert result["success"] is False and result["reason"] == "storage_region_not_observed"
    assert [method for method, _ in motions] == ["forward", "turn", "forward", "backward", "turn", "backward"]
    assert motions[-2][1]["angleDeg"] == pytest.approx(-motions[1][1]["angleDeg"])
    assert result["evidence"]["road_return"]["success"] is True
    assert near_origin(runtime.snapshot["odometry"])
    assert runtime.snapshot["holding"]["holding"] is True
    assert len(logs) == len(motions)
    assert all(row["after_observation"] == row["before_observation"] + 1 for row in logs)


def test_return_uses_measured_partial_translation_instead_of_requested_distance():
    near_origin = lambda odo: abs(odo["forwardCm"]) < .01
    runtime, motions, _, _, _ = place_runtime([(30, 0), None], road=near_origin, actual_first_cm=3)
    result = Actions(runtime).place()
    assert result["evidence"]["road_return"]["success"] is True
    assert motions == [("forward", {"distanceCm": 7, "speed": 30}),
                       ("backward", {"distanceCm": 3, "speed": 20})]


def test_failed_approach_stops_at_first_blocked_return_command():
    near_origin = lambda odo: abs(odo["forwardCm"]) < .01
    runtime, motions, _, _, _ = place_runtime([(30, 0), None], road=near_origin, block_return=True)
    result = Actions(runtime).place()
    assert result["success"] is False
    assert result["evidence"]["road_return"]["reason"] == "recorded_return_blocked"
    assert [method for method, _ in motions] == ["forward", "backward"]
    assert runtime.snapshot["holding"]["holding"] is True


@pytest.mark.parametrize("block_return", [False, True])
def test_verified_delivery_is_separate_from_small_step_road_return(block_return):
    road = lambda odo: odo["forwardCm"] >= -11.01
    runtime, motions, _, objects, evidence = place_runtime([(18, 0)], road=road, block_return=block_return)
    result = Actions(runtime).place()
    assert result["success"] is True and objects["held"]["state"] == "DELIVERED"
    assert runtime.held_object_id is None
    assert evidence[0]["post_observation"] == 3
    assert evidence[0]["placement"]["frame_id"] == 3
    assert result["evidence"]["road_return"]["success"] is not block_return
    if block_return:
        assert [method for method, _ in motions] == ["release", "backward", "forward"]
        assert result["evidence"]["road_return"]["reason"] == "recorded_return_blocked"
    else:
        assert [method for method, _ in motions] == ["release", "backward", "forward", "forward"]
        assert runtime.snapshot["odometry"]["forwardCm"] == pytest.approx(-11)
        assert all(params["distanceCm"] <= 7 for method, params in motions[2:])


def test_offroad_entry_without_recorded_road_anchor_never_invents_a_return():
    runtime, motions, _, _, _ = place_runtime([(30, 0), None], road=lambda odo: False)
    result = Actions(runtime).place()
    assert result["success"] is False
    assert [method for method, _ in motions] == ["forward"]
    assert result["evidence"]["road_return"]["reason"] == "no_observed_road_entry"


def test_failed_gate_keeps_its_detection_frame_separate_from_return_observations():
    runtime, motions, _, _, _ = place_runtime([(30, 0)], road=lambda odo: abs(odo["forwardCm"]) < .01,
                                            approach_step_cm=1)
    result = Actions(runtime).place()
    assert result["success"] is False
    assert result["evidence"]["detection"]["frame_id"] == "9"
    assert result["evidence"]["detection"]["distance_cm"] == pytest.approx(22)
    assert result["evidence"]["frame_id"] > 9
    assert result["evidence"]["road_return"]["success"] is True
    assert len(motions) == 16


def test_recorded_run08_rounded_trajectory_can_be_reversed_without_guessing_geometry():
    # Public odometry from observations 233–241; the inverse actuator below is
    # synthetic. This checks rounding tolerance, not live recovery success.
    poses = [(101, 29.1, -174.3), (101.7, 22.1, -174.3), (101.7, 22.1, -177.9),
             (101.9, 16.2, -177.9), (102, 13, -177.9), (102.1, 10.2, -177.9),
             (102.1, 10.2, 162.7), (102.1, 10.2, 155.8), (101.3, 8.5, 155.8)]
    primitives = [("forward", 7), ("turn", -3.5857494828805727),
                  ("forward", 5.898326965863912), ("forward", 3.294514605401428),
                  ("forward", 2.7190282433608637), ("turn", -19.327137708467546),
                  ("turn", -6.912663265784602), ("forward", 1.9293573454716224)]
    road = lambda odo: math.hypot(odo["rightCm"] - 101, odo["forwardCm"] - 29.1) < .11
    runtime, motions, _, _, _ = place_runtime([(20, 0)], road=road)
    runtime.snapshot["odometry"].update(rightCm=101.3, forwardCm=8.5, headingDeg=155.8)
    original_call = runtime.bridge.call

    def rounded_call(method, params):
        result = original_call(method, params)
        for key in ("rightCm", "forwardCm", "headingDeg"):
            runtime.snapshot["odometry"][key] = round(runtime.snapshot["odometry"][key], 1)
        return result

    runtime.bridge.call = rounded_call
    trace = []
    for i, (method, amount) in enumerate(primitives):
        pose = lambda j: dict(zip(("rightCm", "forwardCm", "headingDeg"), poses[j]))
        trace.append({"method": method, "params": {"angleDeg" if method == "turn" else "distanceCm": amount},
                      "before": pose(i), "after": pose(i + 1), "before_observation": 233 + i,
                      "after_observation": 234 + i, "before_on_road": i == 0, "after_on_road": False})
    result = Actions(runtime).return_place_path(trace)
    assert result["success"] is True
    assert result["anchor_observation"] == 233
    assert road(runtime.snapshot["odometry"])
    assert all(params["distanceCm"] <= 7 for method, params in motions if method != "turn")


def test_return_does_not_pass_the_latest_recorded_entry_if_road_sensor_disagrees():
    runtime, motions, _, _, _ = place_runtime([(30, 0)], road=lambda odo: False)
    runtime.snapshot["odometry"]["forwardCm"] = 14
    pose = lambda z: {"rightCm": 0, "forwardCm": z, "headingDeg": 0}
    trace = [{"method": "forward", "params": {"distanceCm": 7},
              "before": pose(z), "after": pose(z + 7), "before_observation": i + 1,
              "after_observation": i + 2, "before_on_road": True, "after_on_road": i == 0}
             for i, z in enumerate((0, 7))]
    result = Actions(runtime).return_place_path(trace)
    assert result["success"] is False and result["reason"] == "recorded_entry_not_on_road"
    assert len(motions) == 1 and runtime.snapshot["odometry"]["forwardCm"] == 7


def test_return_stops_when_inverse_actuator_reports_complete_without_motion():
    near_origin = lambda odo: abs(odo["forwardCm"]) < .01
    runtime, motions, _, _, _ = place_runtime([(30, 0), None], road=near_origin)
    original_call = runtime.bridge.call

    def no_progress(method, params):
        if method == "backward":
            motions.append((method, dict(params)))
            return {"completed": True}
        return original_call(method, params)

    runtime.bridge.call = no_progress
    result = Actions(runtime).place()
    assert result["success"] is False
    assert result["evidence"]["road_return"]["reason"] == "recorded_return_no_verified_progress"
    assert [method for method, _ in motions] == ["forward", "backward"]


@pytest.mark.parametrize("front", [4, 7, None, float("nan")])
def test_released_ball_or_unknown_front_clearance_blocks_forward_return_before_actuation(front):
    runtime, motions, _, objects, evidence = place_runtime([(18, 0)], road=lambda odo: odo["forwardCm"] >= -11.01)
    original_call = runtime.bridge.call

    def limited_front(method, params):
        result = original_call(method, params)
        if method == "backward":
            runtime.snapshot["road"]["frontClearanceCm"] = front
        return result

    runtime.bridge.call = limited_front
    result = Actions(runtime).place()
    assert result["success"] is True and objects["held"]["state"] == "DELIVERED"
    assert [method for method, _ in motions] == ["release", "backward"]
    recovery = result["evidence"]["road_return"]
    assert recovery["success"] is False and recovery["reason"] == "recorded_return_blocked"
    assert recovery["block_reason"] == "current_front_clearance"
    assert recovery["requested_cm"] == 7
    assert evidence[0]["post_observation"] == recovery["after_observation"] == 3
