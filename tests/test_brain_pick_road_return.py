"""Pick regressions from Run09 sensor geometry and synthetic actuator outcomes.

The initial pose, remembered point, and camera point come from observation 375.
The local straight road corridor and all grab/return outcomes are synthetic.
No simulator, truth map, model call, or live artifact is consumed by these tests.
"""
import copy
import math
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.navigation import heading_to, position, wrap


def pick_runtime(*, grab_results=(True,), old_position_present=False,
                 initially_offroad=False, front_clearance=100,
                 block_approach=False, zero_approach=False,
                 zero_withdraw=False, block_return=False):
    target = {"id": "target_098", "category": "red-ball", "state": "CONFIRMED",
              "position_m": {"x": -.3041089060227532, "z": 1.5663508826616208}}
    camera_point = (-.4057547339627307, 1.4973201812753427)
    snapshot = {
        "observation_index": 375, "observation": {"frameId": 375},
        "odometry": {"rightCm": -6.9, "forwardCm": 163.8,
                     "headingDeg": 106.9, "tick": 17254},
        "holding": {"holding": False}, "road": {},
        "perception": {"detections": []},
    }
    calls, motion_log, pick_evidence = [], [], []
    controls = {"grabs": 0, "forward_attempts": 0, "withdrawn_cm": 0.,
                "blocked_return_commands": 0}
    runtime = SimpleNamespace(snapshot=snapshot, round=73, pending_grasp=None,
                              held_object_id=None)

    def update_sensors():
        odo = snapshot["odometry"]
        # A local tangent inferred from the two reported headings, not a map:
        # 112.7° vehicle heading + 53.8° road error = 166.5° tangent.
        tangent = math.radians(166.5)
        across = (math.cos(tangent) * (odo["rightCm"] + 6.9)
                  + math.sin(tangent) * (odo["forwardCm"] - 163.8))
        lateral = (11.3 if initially_offroad else 8.6) + across
        left, right = 9.2 + lateral, 9.2 - lateral
        snapshot["road"].update(onRoad=left >= 0 and right >= 0,
            headingErrorDeg=wrap(166.5 - odo["headingDeg"]),
            leftClearanceCm=left, rightClearanceCm=right,
            frontClearanceCm=front_clearance, atNode=False, exits=[])
        if snapshot["holding"]["holding"]:
            detections = ([{"category": "red-ball", "track_id": "old-position-view",
                            "position_m": copy.deepcopy(target["position_m"])}]
                          if old_position_present else [])
        else:
            p = position(odo)
            detections = [{"category": "red-ball", "track_id": target["id"],
                           "distance_cm": math.dist(p, camera_point) * 100,
                           "bearing_deg": -wrap(heading_to(p, camera_point) - odo["headingDeg"]),
                           "position_m": {"x": camera_point[0], "z": camera_point[1]},
                           "bbox": {"x": 222, "y": 216, "w": 98, "h": 78}}]
        for detection in detections:
            detection["frame_id"] = str(snapshot["observation"]["frameId"])
        snapshot["perception"]["detections"] = detections

    def observe(*, motion=None):
        snapshot["observation_index"] += 1
        snapshot["observation"]["frameId"] += 1
        snapshot["odometry"]["tick"] += 1
        update_sensors()

    def call(method, params):
        calls.append({"method": method, "params": dict(params),
                      "before_observation": snapshot["observation_index"],
                      "before_odometry": dict(snapshot["odometry"]),
                      "before_on_road": snapshot["road"]["onRoad"]})
        odo = snapshot["odometry"]
        if method == "turn":
            odo["headingDeg"] = round(wrap(odo["headingDeg"] + params["angleDeg"]), 1)
        elif method == "grab":
            index = controls["grabs"]
            controls["grabs"] += 1
            snapshot["holding"]["holding"] = bool(grab_results[index]) if index < len(grab_results) else False
        else:
            assert method in {"forward", "backward"}
            cm = params["distanceCm"]
            assert cm >= .1
            if method == "forward":
                controls["forward_attempts"] += 1
                if block_return and controls["withdrawn_cm"] >= 29.9:
                    controls["blocked_return_commands"] += 1
                    return {"stoppedBy": "front_clearance", "distanceCm": 0}
                if zero_approach and controls["forward_attempts"] == 1:
                    return {"completed": True}
                if block_approach and controls["forward_attempts"] == 1:
                    cm = min(1.3, cm)
            elif snapshot["holding"]["holding"]:
                if zero_withdraw and controls["withdrawn_cm"] == 0:
                    return {"completed": True}
                controls["withdrawn_cm"] += cm
            signed = cm if method == "forward" else -cm
            theta = math.radians(odo["headingDeg"])
            odo["rightCm"] = round(odo["rightCm"] - math.sin(theta) * signed, 1)
            odo["forwardCm"] = round(odo["forwardCm"] + math.cos(theta) * signed, 1)
            if block_approach and method == "forward" and controls["forward_attempts"] == 1:
                return {"stoppedBy": "front_clearance", "distanceCm": cm}
        return {"completed": True}

    def mark_picked(oid, *, holding, original_position_absent, **kwargs):
        pick_evidence.append({"object_id": oid, "holding": holding,
                              "original_position_absent": original_position_absent,
                              "withdrawn_cm": controls["withdrawn_cm"],
                              "evidence": copy.deepcopy(kwargs["evidence"])})
        if holding and original_position_absent:
            target["state"] = "HELD"
            return True
        return False

    update_sensors()
    runtime.observe = observe
    runtime.bridge = SimpleNamespace(seconds=0, max_seconds=1200, call=call)
    runtime.motion_log = SimpleNamespace(write=motion_log.append)
    runtime.perception = SimpleNamespace(
        confirmed=lambda oid: target if target["state"] == "CONFIRMED" else None,
        get_object=lambda oid: target, objects=lambda: [target], mark_picked=mark_picked,
        visible=lambda oid: next((d for d in snapshot["perception"]["detections"]
                                  if d.get("track_id") == oid), None))
    return runtime, calls, motion_log, pick_evidence, controls, target


def test_aligned_short_pick_may_leave_road_then_verify_grasp_and_return():
    runtime, calls, logs, marked, _, target = pick_runtime()
    result = Actions(runtime).pick("target_098")

    assert result["success"] is True, "Run09's aligned short manipulation must not fail solely because it left the road"
    grab = next(row for row in calls if row["method"] == "grab")
    assert grab["before_on_road"] is False
    assert grab["before_odometry"]["rightCm"] == pytest.approx(-9.3)
    assert grab["before_odometry"]["forwardCm"] == pytest.approx(162.8)
    assert target["state"] == "HELD" and runtime.held_object_id == target["id"]
    assert marked[0]["holding"] and marked[0]["original_position_absent"]
    assert marked[0]["withdrawn_cm"] == pytest.approx(30)
    witness_frame = marked[0]["evidence"]["post_observation"]
    assert result["evidence"]["post_observation"] == witness_frame
    recovery = result["evidence"]["road_return"]
    assert recovery["success"] is True and runtime.snapshot["road"]["onRoad"]
    assert recovery["after_observation"] > witness_frame
    verification_moves = [row for row in calls if row["method"] == "backward"
                          and row["before_observation"] < witness_frame]
    assert len(verification_moves) >= 5
    assert all(row["params"]["distanceCm"] <= 6 for row in verification_moves)
    assert len(logs) == len(calls)
    assert all(row["after_observation"] == row["before_observation"] + 1 for row in logs)


def test_three_failed_grabs_remain_failure_and_retrace_to_road():
    runtime, calls, _, marked, controls, target = pick_runtime(grab_results=(False, False, False))
    result = Actions(runtime).pick("target_098")

    assert result["success"] is False and result["reason"] == "three_grab_attempts_failed"
    assert controls["grabs"] == 3
    assert len(result["evidence"]["attempts"]) == 3
    assert marked == [] and target["state"] == "CONFIRMED"
    assert runtime.snapshot["holding"]["holding"] is False
    assert result["evidence"]["road_return"]["success"] is True
    assert runtime.snapshot["road"]["onRoad"] is True
    assert any(row["method"] == "backward" for row in calls)


def test_holding_alone_cannot_confirm_pick_when_original_position_remains_visible():
    runtime, _, _, marked, _, target = pick_runtime(old_position_present=True)
    result = Actions(runtime).pick("target_098")

    assert result["success"] is False
    assert marked and marked[0]["original_position_absent"] is False
    assert target["state"] == "CONFIRMED" and runtime.held_object_id is None
    assert result["evidence"]["old_position_matches"] == 1
    assert result["evidence"]["road_return"]["success"] is True


def test_verified_held_identity_survives_a_separately_failed_return():
    runtime, calls, _, marked, controls, target = pick_runtime(block_return=True)
    result = Actions(runtime).pick("target_098")

    assert result["success"] is True and target["state"] == "HELD"
    assert marked[0]["holding"] and marked[0]["original_position_absent"]
    assert result["evidence"]["road_return"]["success"] is False
    assert controls["blocked_return_commands"] == 1
    assert calls[-1]["method"] == "forward"
    assert runtime.snapshot["road"]["onRoad"] is False


def test_partly_blocked_short_approach_never_grabs_and_returns_by_measured_path():
    runtime, calls, _, marked, controls, _ = pick_runtime(block_approach=True)
    result = Actions(runtime).pick("target_098")

    assert result["success"] is False and controls["grabs"] == 0 and marked == []
    assert result["evidence"]["road_return"]["success"] is True
    reverse = [row for row in calls if row["method"] == "backward"]
    assert len(reverse) == 1
    assert reverse[0]["params"]["distanceCm"] == pytest.approx(1.3, abs=.1)
    assert runtime.snapshot["road"]["onRoad"] is True


@pytest.mark.parametrize("front_clearance", [2, None], ids=["insufficient", "missing"])
def test_insufficient_fresh_front_clearance_prevents_pick_translation_and_grab(front_clearance):
    runtime, calls, _, marked, controls, _ = pick_runtime(front_clearance=front_clearance)
    result = Actions(runtime).pick("target_098")

    assert result["success"] is False
    assert all(row["method"] == "turn" for row in calls)
    assert controls["grabs"] == 0 and marked == []
    assert runtime.snapshot["road"]["onRoad"] is True


def test_completed_true_without_actual_approach_progress_stops_after_one_attempt():
    runtime, _, _, marked, controls, _ = pick_runtime(zero_approach=True)
    result = Actions(runtime).pick("target_098")

    assert result["success"] is False
    assert controls["forward_attempts"] == 1
    assert controls["grabs"] == 0 and marked == []
    assert result["evidence"]["road_return"]["success"] is True


def test_incomplete_verification_retreat_cannot_establish_pick_success():
    runtime, _, _, marked, controls, target = pick_runtime(zero_withdraw=True)
    result = Actions(runtime).pick("target_098")

    assert controls["grabs"] == 1 and runtime.snapshot["holding"]["holding"] is True
    assert result["success"] is False
    assert marked == [] and target["state"] == "CONFIRMED" and runtime.held_object_id is None
    assert runtime.pending_grasp["object_id"] == target["id"]
    assert "road_return" in result["evidence"]


def test_initially_offroad_pick_without_a_path_anchor_never_moves_or_grabs():
    runtime, calls, _, marked, controls, _ = pick_runtime(initially_offroad=True)
    assert runtime.snapshot["road"]["onRoad"] is False
    result = Actions(runtime).pick("target_098")

    assert result["success"] is False
    assert calls == []
    assert controls["grabs"] == 0 and marked == []


def test_grab_with_unexpected_pose_drift_preserves_pending_identity_without_success():
    runtime, calls, _, marked, controls, target = pick_runtime()
    original_call = runtime.bridge.call

    def drifting_grab(method, params):
        result = original_call(method, params)
        if method == "grab":
            runtime.snapshot["odometry"]["rightCm"] += .3
        return result

    runtime.bridge.call = drifting_grab
    result = Actions(runtime).pick("target_098")

    assert controls["grabs"] == 1 and runtime.snapshot["holding"]["holding"] is True
    assert result["success"] is False and result["reason"] == "pick_motion_not_verified"
    assert marked == [] and target["state"] == "CONFIRMED" and runtime.held_object_id is None
    assert runtime.pending_grasp["object_id"] == target["id"]
    attempts = result["evidence"]["attempts"]
    assert len(attempts) == 1 and attempts[0]["holding"] is True
    assert attempts[0]["after_observation"] > attempts[0]["before_observation"]
    assert result["evidence"]["road_return"]["success"] is False
    assert calls[-1]["method"] == "grab", "Unknown grab displacement must not be treated as a reversible translation"


def test_lost_holding_at_verification_cannot_establish_pick_success():
    runtime, _, _, marked, controls, target = pick_runtime()
    original_observe = runtime.observe

    def observe_dropped_ball(*, motion=None):
        original_observe(motion=motion)
        if controls["withdrawn_cm"] >= 29.9:
            runtime.snapshot["holding"]["holding"] = False
            runtime.snapshot["perception"]["detections"] = []

    runtime.observe = observe_dropped_ball
    result = Actions(runtime).pick("target_098")

    assert runtime.snapshot["holding"]["holding"] is False
    assert result["success"] is False
    assert target["state"] == "CONFIRMED" and runtime.held_object_id is None
    assert all(row["holding"] is False for row in marked)
    assert "road_return" in result["evidence"]
