"""Synthetic public-sensor regressions for unobserved junction recovery.

Actuator responses never publish sensor state. Only observe() releases the
scripted road/odometry frame; no simulator, logs, truth, or model is accessed.
"""
import copy
import math
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.navigation import RoadMemory, wrap


JUNCTION_STOP = {"accepted": True, "stoppedBy": "junction", "distanceCm": 0, "elapsedTicks": 0}
RUN19_ROAD = {"onRoad": True, "atNode": False, "atJunction": False, "exits": [],
              "headingErrorDeg": -47.6, "leftClearanceCm": .1,
              "rightClearanceCm": 18.3, "frontClearanceCm": 28.4}
NODE = {"atNode": True, "atJunction": True, "exits": [{"angleDeg": 0}]}


def response(method, **kwargs):
    return {"method": method, **kwargs}


def junction_runtime(steps, *, road=None):
    snapshot = {"observation_index": 100, "observation": {"frameId": 100, "tick": 0},
                "odometry": {"rightCm": 0., "forwardCm": 0., "headingDeg": 0., "tick": 0},
                "road": {**RUN19_ROAD, **(road or {})}, "holding": {"holding": False},
                "perception": {"detections": []}}
    pending, remaining = [], copy.deepcopy(steps)
    calls, events, logs, marked = [], [], [], []
    roads = RoadMemory()
    # Retain a real outstanding exit, so a recovery cannot silently hide work
    # by marking it blocked or complete after an actuator-only junction label.
    roads.update(snapshot["odometry"], {**snapshot["road"], **NODE})
    roads.chosen(snapshot["odometry"], 0)
    roads.update(snapshot["odometry"], snapshot["road"])
    original_mark = roads.mark_blocked

    def mark_blocked():
        marked.append(snapshot["observation_index"])
        original_mark()

    roads.mark_blocked = mark_blocked

    def call(method, params):
        assert not pending, "the previous actuator result must be observed first"
        assert remaining, f"unexpected extra motion: {method} {params}"
        step = remaining.pop(0)
        assert method == step["method"]
        calls.append({"method": method, "params": copy.deepcopy(params),
                      "observation_index": snapshot["observation_index"],
                      "frame_id": snapshot["observation"]["frameId"],
                      "road": copy.deepcopy(snapshot["road"])})
        events.append(method)
        pending.append((step, copy.deepcopy(params)))
        default = JUNCTION_STOP if method in {"follow_road", "take_exit"} else {"completed": True}
        return copy.deepcopy(step.get("result", default))

    def observe(*, motion=None):
        events.append("observe")
        assert pending, "this fixture expects one fresh observation per primitive"
        step, params = pending.pop(0)
        method, odo = step["method"], snapshot["odometry"]
        if method == "turn":
            angle = step.get("actual_angle", params["angleDeg"])
            odo["headingDeg"] = wrap(odo["headingDeg"] + angle)
            error = snapshot["road"].get("headingErrorDeg")
            if type(error) in (int, float) and math.isfinite(error):
                snapshot["road"]["headingErrorDeg"] = wrap(error - angle)
        else:
            requested = params.get("distanceCm", 0) if method == "forward" else 0
            cm = step.get("actual_cm", requested * step.get("fraction", 1))
            theta = math.radians(odo["headingDeg"])
            across = step.get("across_cm", 0)
            odo["rightCm"] += -math.sin(theta) * cm + math.cos(theta) * across
            odo["forwardCm"] += math.cos(theta) * cm + math.sin(theta) * across
        odo["rightCm"] += step.get("shift_right_cm", 0)
        odo["forwardCm"] += step.get("shift_forward_cm", 0)
        odo["headingDeg"] = wrap(odo["headingDeg"] + step.get("heading_delta", 0))
        odo.update(step.get("odometry", {}))
        snapshot["road"].update(step.get("road", {}))
        for name in step.get("remove_road", []):
            snapshot["road"].pop(name, None)
        if not step.get("stale_index"):
            snapshot["observation_index"] += 1
        if not step.get("stale_frame"):
            snapshot["observation"]["frameId"] += 1
        odo["tick"] += 0 if method in {"follow_road", "take_exit"} else 1
        snapshot["observation"]["tick"] = odo["tick"]
        roads.update(odo, snapshot["road"])

    runtime = SimpleNamespace(snapshot=snapshot, round=70, roads=roads,
        perception=SimpleNamespace(objects=lambda: []),
        bridge=SimpleNamespace(seconds=0, max_seconds=1200, call=call), observe=observe,
        motion_log=SimpleNamespace(write=logs.append))
    return SimpleNamespace(runtime=runtime, actions=Actions(runtime), calls=calls, events=events,
                           logs=logs, remaining=remaining, marked=marked)


def assert_unobserved_failure(fixture, result):
    assert result["success"] is False
    assert result["reason"] not in {"next_junction_observed", "road_blocked_returned_to_junction"}
    assert fixture.marked == []
    assert fixture.runtime.roads.blocked == []
    assert not any(e["completed"] or e["blocked"] for n in fixture.runtime.roads.nodes for e in n["exits"])
    assert fixture.remaining == []


@pytest.mark.parametrize("old_front", [.1, 28.4])
def test_run19_turns_minus_47_6_then_uses_new_front_clearance(old_front):
    f = junction_runtime([
        response("follow_road"),
        response("turn", road={"frontClearanceCm": 2.1, "leftClearanceCm": 9, "rightClearanceCm": 9}),
        response("forward", road=NODE),
    ], road={"frontClearanceCm": old_front})
    result = f.actions.explore()
    assert result["success"] is True and result["reason"] == "next_junction_observed"
    assert [row["method"] for row in f.calls] == ["follow_road", "turn", "forward"]
    assert f.calls[0]["params"]["distanceCm"] == 20
    assert f.calls[1]["params"]["angleDeg"] == pytest.approx(-47.6)
    assert f.calls[2]["params"]["distanceCm"] == pytest.approx(2)
    assert f.calls[2]["road"]["frontClearanceCm"] == 2.1
    assert f.events == ["follow_road", "observe", "turn", "observe", "forward", "observe"]
    assert f.calls[2]["observation_index"] > f.calls[1]["observation_index"]
    assert f.runtime.snapshot["road"]["onRoad"] is True and f.runtime.snapshot["road"]["atNode"] is True
    assert f.marked == [] and f.runtime.roads.blocked == []
    diagnostic = result["evidence"]["junction_recovery"]
    assert diagnostic["actuator_result"] == JUNCTION_STOP
    assert diagnostic["requested_budget_cm"] == 20
    assert len(diagnostic["steps"]) == 2
    assert f.remaining == []


def test_post_turn_blocked_front_cannot_reuse_the_old_28_4_cm_clearance():
    f = junction_runtime([response("follow_road"), response("turn", road={"frontClearanceCm": .1})])
    result = f.actions.explore()
    assert_unobserved_failure(f, result)
    assert [row["method"] for row in f.calls] == ["follow_road", "turn"]


@pytest.mark.parametrize("invalid", [None, float("nan"), float("inf"), True])
def test_missing_or_nonfinite_initial_direction_cannot_authorize_a_turn(invalid):
    f = junction_runtime([response("follow_road")], road={"headingErrorDeg": invalid})
    result = f.actions.explore()
    assert_unobserved_failure(f, result)
    assert [row["method"] for row in f.calls] == ["follow_road"]


@pytest.mark.parametrize("field", ["headingErrorDeg", "frontClearanceCm", "leftClearanceCm", "rightClearanceCm"])
def test_missing_post_turn_geometry_cannot_authorize_translation(field):
    f = junction_runtime([response("follow_road"), response("turn", remove_road=[field])])
    result = f.actions.explore()
    assert_unobserved_failure(f, result)
    assert [row["method"] for row in f.calls] == ["follow_road", "turn"]


@pytest.mark.parametrize("fault", [
    {"actual_angle": 0}, {"actual_angle": 47.6}, {"actual_angle": -47.3},
    {"shift_right_cm": .3}, {"road": {"onRoad": False}},
    {"stale_index": True}, {"stale_frame": True},
], ids=["no_turn", "reverse_turn", "wrong_angle", "translated_while_turning", "left_road",
        "stale_observation_index", "stale_frame"])
def test_unverified_turn_stops_before_any_forward_command(fault):
    f = junction_runtime([response("follow_road"), response("turn", **fault)])
    result = f.actions.explore()
    assert_unobserved_failure(f, result)
    assert [row["method"] for row in f.calls] == ["follow_road", "turn"]


@pytest.mark.parametrize("fault", [
    {"actual_cm": 0}, {"actual_cm": -4}, {"across_cm": .3}, {"actual_cm": 4.3},
    {"heading_delta": .3}, {"road": {"onRoad": False}},
    {"stale_index": True}, {"stale_frame": True},
], ids=["zero_progress", "reverse_progress", "sideways", "exceeds_request_tolerance",
        "heading_changed", "left_road", "stale_observation_index", "stale_frame"])
def test_unverified_forward_stops_without_closing_or_blocking_an_exit(fault):
    f = junction_runtime([response("follow_road"), response("forward", **fault)],
                         road={"headingErrorDeg": 0, "leftClearanceCm": 9})
    result = f.actions.explore()
    assert_unobserved_failure(f, result)
    assert [row["method"] for row in f.calls] == ["follow_road", "forward"]


@pytest.mark.parametrize("stopped_by", ["collision", "front_clearance", "off_road", "wrong_way"])
def test_blocked_recovery_translation_does_not_become_arrival_even_with_a_node_flag(stopped_by):
    # The same-position node flag below cannot override the primitive's failure.
    f = junction_runtime([response("follow_road"), response("forward", road=NODE,
        result={"accepted": True, "stoppedBy": stopped_by})],
        road={"headingErrorDeg": 0, "leftClearanceCm": 9})
    result = f.actions.explore()
    assert_unobserved_failure(f, result)


@pytest.mark.parametrize("fraction", [1, .5])
def test_five_probes_without_a_node_exhaust_the_request_budget_without_marking_blocked(fraction):
    f = junction_runtime([response("follow_road")] + [response("forward", fraction=fraction) for _ in range(5)],
                         road={"headingErrorDeg": 0, "leftClearanceCm": 9})
    result = f.actions.explore()
    assert_unobserved_failure(f, result)
    probes = [row for row in f.calls if row["method"] == "forward"]
    assert len(probes) == 5
    assert all(row["params"]["distanceCm"] <= 4 for row in probes)
    assert sum(row["params"]["distanceCm"] for row in probes) == 20
    assert f.runtime.snapshot["odometry"]["forwardCm"] == pytest.approx(20 * fraction)
    assert result["evidence"]["junction_recovery"]["requested_budget_cm"] == 20


@pytest.mark.parametrize("stopped_by", ["junction", "max_distance"])
def test_a_fresh_real_node_remains_success_without_a_recovery_probe(stopped_by):
    f = junction_runtime([response("follow_road", actual_cm=6.4, road=NODE,
        result={"accepted": True, "stoppedBy": stopped_by, "distanceCm": 6.4})])
    result = f.actions.explore()
    assert result["success"] is True and result["reason"] == "next_junction_observed"
    assert [row["method"] for row in f.calls] == ["follow_road"]
    assert "junction_recovery" not in result["evidence"]
    assert f.marked == [] and f.remaining == []


def test_take_exit_zero_motion_at_the_same_node_is_not_new_arrival():
    f = junction_runtime([response("take_exit")], road={**NODE, "headingErrorDeg": 0})
    result = f.actions.explore(0)
    assert result["success"] is False
    assert result["reason"] != "next_junction_observed"
    assert [row["method"] for row in f.calls] == ["take_exit"]
    assert not any(e["completed"] for n in f.runtime.roads.nodes for e in n["exits"])
    assert f.remaining == []


def test_take_exit_unobserved_junction_uses_the_same_sensor_recovery():
    f = junction_runtime([response("take_exit", road={"atNode": False, "atJunction": False, "exits": []}),
                          response("forward", road=NODE)],
                         road={**NODE, "headingErrorDeg": 0, "leftClearanceCm": 9})
    result = f.actions.explore(0)
    assert result["success"] is True and result["reason"] == "next_junction_observed"
    assert [row["method"] for row in f.calls] == ["take_exit", "forward"]
    assert "junction_recovery" in result["evidence"]
    assert f.marked == [] and f.remaining == []


@pytest.mark.parametrize("arrives", [False, True])
def test_blocked_return_cannot_claim_an_unobserved_junction_or_mark_a_second_block(arrives):
    final = {"road": NODE} if arrives else {"actual_cm": 0}
    f = junction_runtime([
        response("turn"),
        response("follow_road", road={"headingErrorDeg": -47.6}),
        response("turn", road={"leftClearanceCm": 9, "rightClearanceCm": 9}),
        response("forward", **final),
    ])
    result = f.actions.return_from_blocked_road({"stoppedBy": "front_clearance"})
    assert result["success"] is False, "returning to a node cannot undo the original blockage"
    assert (result["reason"] == "road_blocked_returned_to_junction") is arrives
    assert f.runtime.snapshot["road"]["atNode"] is arrives
    assert [row["method"] for row in f.calls] == ["turn", "follow_road", "turn", "forward"]
    assert f.calls[2]["params"]["angleDeg"] == pytest.approx(-47.6)
    assert len(f.marked) == len(f.runtime.roads.blocked) == 1
    assert "junction_recovery" in result["evidence"]
    assert f.remaining == []
