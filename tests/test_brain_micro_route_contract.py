"""Synthetic public motion windows against checkout RoadMemory and Actions.

No copied production functions, map truth, or platform outcome is used. Every
sent command is checked by the frozen platform's real normalizeCommand.
"""
import copy
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from autonomous_brain.navigation import RoadMemory, position
from test_brain_navigation_reposition import sensor
from test_brain_route_contract import normalize


def record(roads, row, previous=None, *, length=None):
    roads.update(row["odometry"], row["road"], row["observation_index"])
    motion = None if previous is None else {
        "before_observation": previous["observation_index"],
        "after_observation": row["observation_index"],
        "method": "forward", "params": {"distanceCm": length, "speed": 30},
        "actuator_result": {"accepted": True, "completed": True}}
    roads.observe_traversal(row, motion)


def micro_route(step=.1, *, origin_cm=0, fault=None):
    roads = RoadMemory()
    rows = [sensor(1, (0, (origin_cm - 20) / 100), travelled=0),
            sensor(2, (0, origin_cm / 100), travelled=20),
            sensor(3, (0, (origin_cm + step) / 100), travelled=20 + step)]
    for i, row in enumerate(rows):
        record(roads, row, rows[i - 1] if i else None, length=20 if i == 1 else step)
    current, calls, motions = copy.deepcopy(rows[-1]), [], []
    runtime = SimpleNamespace(snapshot=current, roads=roads, round=1,
        bridge=SimpleNamespace(seconds=0, max_seconds=1200),
        motion_log=SimpleNamespace(write=motions.append),
        perception=SimpleNamespace(objects=lambda: []),
        pending_grasp=None, held_object_id=None)

    def call(method, params):
        checked = normalize(method, params)
        calls.append((method, copy.deepcopy(checked)))
        assert method == "backward", "A reverse basic edge must use its recorded primitive"
        odo = current["odometry"]
        amount = checked["distanceCm"]
        if fault != "zero":
            odo["forwardCm"] += amount if fault == "opposite-direction" else -amount
            odo["distanceCm"] += amount
        if fault == "side-drift":
            odo["rightCm"] += .3
        if fault == "heading-drift":
            odo["headingDeg"] += 1
        if fault == "unknown-ack":
            raise ConnectionError("synthetic_micro_route_ack_unknown")
        return {"accepted": True, "completed": fault != "incomplete-ack"}

    def observe(*, motion=None):
        current["observation_index"] += 1
        if fault != "stale-tick":
            current["odometry"]["tick"] += 1
        frame = (current["observation"]["frameId"] if fault == "old-frame"
                 else str(current["observation_index"]))
        current["observation"] = {"frameId": frame, "tick": current["odometry"]["tick"]}
        if fault == "offroad-after":
            current["road"]["onRoad"] = False
        if fault in {"holding-after", "holding-unknown-after"}:
            current["holding"]["holding"] = True if fault == "holding-after" else None
        roads.update(current["odometry"], current["road"], current["observation_index"])
        roads.observe_traversal(current, dict(motion, after_observation=current["observation_index"])
                                if motion else None)

    runtime.bridge.call, runtime.observe = call, observe
    candidates = roads.approach_candidates(current["odometry"], (0, (origin_cm - 20) / 100 + .32))
    return runtime, candidates, calls, motions, rows


@pytest.mark.parametrize("step", [.1, .1875, .2, .375, 20])
@pytest.mark.parametrize("origin_cm", [0, 100])
def test_record_generate_normalize_execute_and_verify_smallest_basic_edge(step, origin_cm):
    r, candidates, calls, motions, rows = micro_route(step, origin_cm=origin_cm)
    assert candidates, r.roads.approach_candidate_diagnostics()
    candidate = next(c for c in candidates if c["position_m"] == list(position(rows[0]["odometry"])))
    assert len(candidate["segments"]) == 2
    assert candidate["segments"][0]["travelled_cm"] == pytest.approx(step)
    assert candidate["segments"][0]["execution"]["kind"] == "basic_translation"
    reached, reason, steps = Actions(r)._follow_approach_path(candidate, [2])
    # This assertion is after the real primitive dispatch; proximity cannot
    # silently consume the micro edge or round it up beyond its known endpoint.
    assert reached, (reason, steps)
    assert [method for method, _ in calls] == ["backward", "backward"]
    assert [params["distanceCm"] for _, params in calls] == pytest.approx([step, 20])
    assert all(params["distanceCm"] >= .1 for _, params in calls)
    assert len(steps) == len(motions) == 2
    assert steps[0]["completed_segment_ids"] == [candidate["segments"][0]["segment_id"]]
    assert all(s["historical_arc_retraced"] for s in steps)
    assert all(m["motion_verification"]["motion_verified"] and not m.get("outcome_unknown") for m in motions)
    assert position(r.snapshot["odometry"]) == pytest.approx(position(rows[0]["odometry"]))


@pytest.mark.parametrize("origin_cm,odometer_cm", [(0, 0), (0, 10), (100, 0), (100, 10)])
def test_decimal_public_readings_record_both_directions_without_rounding_raw_evidence(origin_cm, odometer_cm):
    roads = RoadMemory()
    before = sensor(1, (0, origin_cm / 100), travelled=odometer_cm)
    after = sensor(2, (0, (origin_cm + .1) / 100), travelled=odometer_cm + .1)
    record(roads, before)
    record(roads, after, before, length=.1)
    a, b = position(before["odometry"]), position(after["odometry"])
    forward, reverse = roads._approach_edges[a][b], roads._approach_edges[b][a]
    assert forward["travelled_cm"] == after["odometry"]["distanceCm"] - before["odometry"]["distanceCm"]
    assert reverse["travelled_cm"] == forward["travelled_cm"]
    assert forward["execution"]["method"] == "forward"
    assert reverse["execution"]["method"] == "backward"
    assert RoadMemory._approach_execution_unavailable({"segments": [reverse]}, after["odometry"]) is None


@pytest.mark.parametrize("step", [0, .001, .05, .099, .099999])
def test_real_subminimum_displacement_never_becomes_recorded_basic_edge(step):
    roads = RoadMemory()
    before, after = sensor(1, (0, 1), travelled=10), sensor(2, (0, (100 + step) / 100), travelled=10 + step)
    record(roads, before)
    record(roads, after, before, length=.1)
    assert not any(roads._approach_edges.values())


@pytest.mark.parametrize("step", [0, .001, .05, .099, .099999])
def test_subminimum_recorded_length_is_neither_generated_nor_dispatched(step):
    r, candidates, calls, _, _ = micro_route(.2)
    segment = candidates[0]["segments"][0]
    segment["travelled_cm"] = step
    assert RoadMemory._approach_execution_unavailable(candidates[0], r.snapshot["odometry"])
    assert Actions(r)._approach_basic_plan(segment, step, False) is None
    assert calls == []


@pytest.mark.parametrize("fault", ["unknown-outcome", "holding-change", "holding-unknown",
    "offroad", "old-frame", "stale-tick", "incomplete-ack", "opposite-direction"])
def test_minimum_recording_still_requires_complete_known_continuous_motion(fault):
    roads = RoadMemory()
    before, after = sensor(1, (0, 0), travelled=10), sensor(2, (0, .001), travelled=10.1)
    motion = {"before_observation": 1, "after_observation": 2, "method": "forward",
              "params": {"distanceCm": .1, "speed": 30},
              "actuator_result": {"accepted": True, "completed": True}}
    if fault == "unknown-outcome":
        motion["outcome_unknown"] = True
    elif fault in {"holding-change", "holding-unknown"}:
        after["holding"]["holding"] = True if fault == "holding-change" else None
    elif fault == "offroad":
        after["road"]["onRoad"] = False
    elif fault == "old-frame":
        after["observation"]["frameId"] = before["observation"]["frameId"]
    elif fault == "stale-tick":
        after["odometry"]["tick"] = after["observation"]["tick"] = before["odometry"]["tick"]
    elif fault == "incomplete-ack":
        motion["actuator_result"]["completed"] = False
    else:
        after["odometry"]["forwardCm"] = -.1
    record(roads, before)
    roads.update(after["odometry"], after["road"], 2)
    roads.observe_traversal(after, motion)
    assert not any(roads._approach_edges.values())


@pytest.mark.parametrize("fault", ["offroad-before", "clearance-before"])
def test_saved_micro_route_requires_current_road_and_clearance_before_sending(fault):
    r, candidates, calls, _, _ = micro_route(.1)
    assert candidates
    if fault == "offroad-before":
        r.snapshot["road"]["onRoad"] = False
    else:
        r.snapshot["road"].update(leftClearanceCm=0, rightClearanceCm=0)
    reached, _, steps = Actions(r)._follow_approach_path(candidates[0], [2])
    assert not reached and calls == [] and steps == []


@pytest.mark.parametrize("fault", ["zero", "old-frame", "stale-tick", "offroad-after",
    "holding-after", "holding-unknown-after", "opposite-direction", "side-drift",
    "heading-drift", "incomplete-ack"])
def test_micro_route_cannot_complete_or_continue_after_unverified_first_primitive(fault):
    r, candidates, calls, motions, _ = micro_route(.1, fault=fault)
    assert candidates
    try:
        reached, _, steps = Actions(r)._follow_approach_path(candidates[0], [2])
    except ObservedMotionFailure:
        reached, steps = False, []
    assert not reached
    assert len(calls) == len(motions) == 1
    assert calls[0][0] == "backward" and calls[0][1]["distanceCm"] == pytest.approx(.1)
    assert not any(s.get("completed_segment_ids") for s in steps)


def test_unknown_micro_ack_is_sent_once_and_never_continues_or_replays():
    r, candidates, calls, motions, _ = micro_route(.1, fault="unknown-ack")
    assert candidates
    with pytest.raises(ConnectionError, match="synthetic_micro_route_ack_unknown"):
        Actions(r)._follow_approach_path(candidates[0], [2])
    assert len(calls) == len(motions) == 1
    assert calls[0][1]["distanceCm"] == pytest.approx(.1)
    assert motions[0]["outcome_unknown"] and "actuator_result" not in motions[0]
    assert motions[0]["recovery_observation"] > motions[0]["before_observation"]
