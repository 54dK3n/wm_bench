"""Run10 exit regressions using recorded sensor poses and synthetic responses.

No simulator, truth layout, evaluation capture, or model request is consumed.
Post-turn sensor frames are published by observe(), never by the actuator call.
"""
import copy
import math
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.navigation import position, wrap


def exit_runtime(*, start_pose=(93.6, .4, -145.2), selected_angle=-147.2,
                 turn_residual=.1, fresh_exit_mode="same", fresh_on_road=True,
                 fresh_at_node=True, blocked_result=None, initial_at_node=True):
    x, z, heading = start_pose
    absolute_exit = wrap(heading + selected_angle)
    direction = math.radians(absolute_exit)
    waypoint = (x / 100 - math.sin(direction) * .4,
                z / 100 + math.cos(direction) * .4)
    target = {"id": "red-confirmed", "category": "red-ball", "state": "CONFIRMED",
              "position_m": {"x": x / 100 - math.sin(direction) * 2,
                             "z": z / 100 + math.cos(direction) * 2}}
    snapshot = {
        "observation_index": 242, "observation": {"frameId": 242},
        "odometry": {"rightCm": x, "forwardCm": z, "headingDeg": heading,
                     "distanceCm": 1552.1, "tick": 10537},
        "road": {"onRoad": True, "atNode": initial_at_node, "atJunction": False,
                 "headingErrorDeg": .2, "frontClearanceCm": .1,
                 "leftClearanceCm": 9.2, "rightClearanceCm": 9.2,
                 "exits": [{"angleDeg": selected_angle}] if initial_at_node else []},
        "holding": {"holding": False}, "perception": {"detections": []},
    }
    events, calls, logs, pending, chosen = [], [], [], [], []

    def exits(odo, road):
        return [{"angle_deg": row["angleDeg"],
                 "heading_deg": wrap(odo["headingDeg"] + row["angleDeg"]),
                 "blocked": False, "completed": False, "visits": 0}
                for row in road["exits"]]

    runtime = SimpleNamespace(snapshot=snapshot, round=44,
        perception=SimpleNamespace(objects=lambda: [target],
            confirmed=lambda oid: target, get_object=lambda oid: target,
            visible=lambda oid: next(iter(snapshot["perception"]["detections"]), None)),
        roads=SimpleNamespace(exits=exits, blocked=[], mark_blocked=lambda: None,
            chosen=lambda odo, angle, *, observation_index=None: chosen.append((dict(odo), angle)),
            route_to=lambda odo, goal: [position(odo), waypoint]),
        bridge=SimpleNamespace(seconds=210.74, max_seconds=1200),
        motion_log=SimpleNamespace(write=logs.append))

    def call(method, params):
        assert not pending, "Every actuator result must be observed before the next command"
        events.append(method)
        calls.append({"method": method, "params": copy.deepcopy(params),
                      "observation_index": snapshot["observation_index"],
                      "heading_deg": snapshot["odometry"]["headingDeg"],
                      "road": copy.deepcopy(snapshot["road"])})
        if method == "turn":
            new_heading = wrap(snapshot["odometry"]["headingDeg"] + params["angleDeg"] - turn_residual)
            new_angle = wrap(absolute_exit - new_heading)
            angles = {"same": [new_angle], "missing": [],
                      "ambiguous": [new_angle - 1, new_angle + 1],
                      "outside_gate": [new_angle + 6]}[fresh_exit_mode]
            pending.append({"heading": new_heading, "road": {
                "onRoad": fresh_on_road, "atNode": fresh_at_node,
                "exits": [{"angleDeg": value} for value in angles],
                "frontClearanceCm": 100, "headingErrorDeg": turn_residual}})
            return {"completed": True}
        assert method in {"take_exit", "follow_road"}, method
        if blocked_result is not None:
            result = copy.deepcopy(blocked_result)
        elif snapshot["road"]["frontClearanceCm"] <= .1:
            result = {"accepted": True, "stoppedBy": "front_clearance",
                      "distanceCm": 0, "elapsedTicks": 0}
        else:
            result = {"accepted": True, "stoppedBy": "junction",
                      "distanceCm": 40, "elapsedTicks": 70}
        cm = result["distanceCm"]
        if cm:
            if blocked_result is not None:
                # Actual r43 endpoint after its 8.7cm curved actuator path.
                pose = {"rightCm": 93.6, "forwardCm": .4, "headingDeg": -145.2}
            else:
                pose = {"rightCm": waypoint[0] * 100, "forwardCm": waypoint[1] * 100}
        else:
            pose = {}
        pending.append({"pose": pose, "distance_cm": cm,
                        "road": {"atNode": True}, "show_target": not blocked_result and cm > 0})
        return result

    def observe(*, motion=None):
        events.append("observe")
        update = pending.pop(0) if pending else {}
        if "heading" in update:
            snapshot["odometry"]["headingDeg"] = update["heading"]
        snapshot["odometry"].update(update.get("pose", {}))
        snapshot["odometry"]["distanceCm"] += update.get("distance_cm", 0)
        snapshot["road"].update(update.get("road", {}))
        snapshot["observation_index"] += 1
        snapshot["observation"]["frameId"] += 1
        snapshot["odometry"]["tick"] += 1
        if update.get("show_target"):
            snapshot["perception"]["detections"] = [{"category": "red-ball", "track_id": target["id"],
                "frame_id": str(snapshot["observation"]["frameId"]), "distance_cm": 32,
                "bearing_deg": 0}]

    runtime.observe, runtime.bridge.call = observe, call
    return runtime, calls, events, logs


def run_action(runtime, caller):
    actions = Actions(runtime)
    return actions.explore(-147.2) if caller == "explore" else actions.go_to("red-confirmed")


@pytest.mark.parametrize("caller", ["explore", "go_to"])
def test_run10_blocked_old_heading_turns_observes_then_uses_fresh_same_exit(caller):
    runtime, calls, events, logs = exit_runtime()
    result = run_action(runtime, caller)

    assert result["success"] is True
    assert [row["method"] for row in calls] == ["turn", "take_exit"]
    assert calls[0]["params"]["angleDeg"] == pytest.approx(-147.2)
    assert events == ["turn", "observe", "take_exit", "observe"]
    assert calls[1]["observation_index"] > calls[0]["observation_index"]
    assert calls[1]["params"]["angleDeg"] == pytest.approx(.1)
    assert wrap(calls[1]["heading_deg"] + calls[1]["params"]["angleDeg"]) == pytest.approx(67.6)
    assert calls[1]["road"]["frontClearanceCm"] == 100
    assert len(logs) == 2


@pytest.mark.parametrize("caller", ["explore", "go_to"])
@pytest.mark.parametrize("fresh_exit_mode", ["missing", "ambiguous", "outside_gate"])
def test_fresh_exit_must_uniquely_match_original_absolute_heading(caller, fresh_exit_mode):
    runtime, calls, events, _ = exit_runtime(fresh_exit_mode=fresh_exit_mode)
    result = run_action(runtime, caller)

    assert result["success"] is False
    assert [row["method"] for row in calls] == ["turn"]
    assert events == ["turn", "observe"]


@pytest.mark.parametrize("fresh_state", [{"fresh_on_road": False}, {"fresh_at_node": False}],
                         ids=["road_lost", "node_lost"])
def test_fresh_road_and_node_are_required_after_exit_alignment(fresh_state):
    runtime, calls, events, _ = exit_runtime(**fresh_state)
    result = Actions(runtime).explore(-147.2)

    assert result["success"] is False
    assert [row["method"] for row in calls] == ["turn"]
    assert events == ["turn", "observe"]


@pytest.mark.parametrize("stopped_by", ["front_clearance", "collision", "off_road", "wrong_way"])
def test_run10_short_blocked_exit_cannot_report_same_node_as_arrival(stopped_by):
    blocked = {"accepted": True, "stoppedBy": stopped_by,
               "distanceCm": 8.7, "elapsedTicks": 70}
    runtime, calls, _, _ = exit_runtime(start_pose=(99.8, 5.5, 169.6),
        selected_angle=-102, turn_residual=0, blocked_result=blocked)
    result = Actions(runtime).explore(-102)

    assert result["success"] is False
    assert result["reason"] != "next_junction_observed"
    assert result["evidence"]["actuator_result"] == blocked
    assert runtime.snapshot["road"]["atNode"] is True
    assert calls[-1]["method"] == "take_exit"


def test_zero_distance_blocked_exit_is_not_an_arrival():
    blocked = {"accepted": True, "stoppedBy": "front_clearance",
               "distanceCm": 0, "elapsedTicks": 0}
    runtime, _, _, _ = exit_runtime(blocked_result=blocked)
    result = Actions(runtime).explore(-147.2)

    assert result["success"] is False
    assert result["evidence"]["actuator_result"] == blocked


def test_blocked_follow_road_with_fresh_node_still_reports_blockage():
    blocked = {"accepted": True, "stoppedBy": "front_clearance",
               "distanceCm": 8.7, "elapsedTicks": 70}
    runtime, calls, _, _ = exit_runtime(initial_at_node=False, blocked_result=blocked)
    result = Actions(runtime).explore()

    assert result["success"] is False
    assert result["evidence"]["actuator_result"] == blocked
    assert [row["method"] for row in calls] == ["follow_road"]


def test_short_genuine_junction_remains_a_success():
    runtime, calls, _, _ = exit_runtime(initial_at_node=False,
        blocked_result={"accepted": True, "stoppedBy": "junction",
                        "distanceCm": 6.4, "elapsedTicks": 21})
    result = Actions(runtime).explore()

    assert result["success"] is True and result["reason"] == "next_junction_observed"
    assert [row["method"] for row in calls] == ["follow_road"]
