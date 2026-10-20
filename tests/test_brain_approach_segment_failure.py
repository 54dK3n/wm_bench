"""Actual public reverse failure windows plus synthetic execution negative controls.

The fixture contains only public observations and registered motions. Replaying
it and simulating the two dispatch receipts is component validation, not a new
platform run. Existing road facts and viewpoint-attempt history stay intact.
"""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.navigation import RoadMemory, position


FIXTURE = Path(__file__).parent / "fixtures/run_20261018T133944Z_segment_failure_public.json"
START, END = (0.05, 1.758), (-0.132, 1.506)


def source_data():
    return json.loads(FIXTURE.read_text())


def rebuild(data, through=634):
    memory = RoadMemory()
    by_after = {m["after_observation"]: m for m in data["motions"]}
    for frame in data["frames"]:
        i = frame["observation_index"]
        if i > through:
            break
        memory.update(frame["odometry"], frame["road"], i)
        memory.observe_traversal(frame, by_after.get(i))
    return memory


@pytest.fixture(scope="module")
def recorded_base():
    data = source_data()
    return data, rebuild(data)


def setup_recorded(recorded_base):
    data, memory = copy.deepcopy(recorded_base)
    frames = {f["observation_index"]: f for f in data["frames"]}
    segment = copy.deepcopy(memory._approach_edges[START][END])
    assert segment["segment_id"] == "road-segment-537-538"
    return memory, segment, frames[634]


def candidate(segment):
    return {"path": [list(START), list(END)], "position_m": list(END),
            "segments": [copy.deepcopy(segment)]}


def contains_failed_edge(path):
    return (START, END) in list(zip(map(tuple, path), map(tuple, path[1:])))


def test_real_prefix_failure_excludes_old_reverse_without_deleting_edges(recorded_base):
    memory, segment, current = setup_recorded(recorded_base)
    old_edges = copy.deepcopy(memory._approach_edges)
    old_semantics = memory.road_evidence()
    # Baseline lacks the new recorder; still exercise its actual route planner
    # so the baseline failure is the original retained-edge permission.
    remember = getattr(memory, "remember_approach_segment_failure", None)
    failure = remember(segment, current) if remember else None
    route = memory.route_to({"rightCm": START[0]*100, "forwardCm": START[1]*100}, END)
    assert not contains_failed_edge(route), "Previously failed reverse segment is offered again"
    assert failure and failure["before_observation"] == 633 and failure["after_observation"] == 634
    assert failure["bridge_request_id"] == "brain-002931"
    assert failure["actual_travel_cm"] == pytest.approx(9.4)
    assert failure["remaining_arc_cm"] == pytest.approx(29.7)
    assert failure["new_observed_prefix_segment_id"] == "road-segment-633-634"
    assert memory._approach_edges == old_edges
    assert memory.road_evidence() == old_semantics
    assert memory._approach_edges[START][position(current["odometry"])]["direction"] == "forward"
    failure["holding"] = True
    assert memory.approach_segment_failure(segment)["holding"] is False


def test_failure_record_is_idempotent_and_detached(recorded_base):
    memory, segment, current = setup_recorded(recorded_base)
    first = memory.remember_approach_segment_failure(segment, current)
    second = memory.remember_approach_segment_failure(segment, current)
    assert first == second and len(memory._approach_segment_failures) == 1
    second["actual_position_m"][0] = 123
    assert memory._approach_segment_failures[0] == first


def test_same_semantic_version_with_new_source_id_still_cannot_repeat(recorded_base):
    memory, segment, current = setup_recorded(recorded_base)
    assert memory.remember_approach_segment_failure(segment, current)
    segment["segment_id"] = "road-segment-new-source-same-geometry"
    segment["before_observation"] += 1000
    segment["after_observation"] += 1000
    assert memory.approach_segment_failure(segment)


def test_candidate_generator_cannot_restore_failed_edge_via_new_candidate(recorded_base):
    memory, segment, current = setup_recorded(recorded_base)
    assert memory.remember_approach_segment_failure(segment, current)
    odo = copy.deepcopy(current["odometry"])
    odo.update(rightCm=START[0]*100, forwardCm=START[1]*100, headingDeg=164.4)
    rows = memory.approach_candidates(odo, (END[0]-.32, END[1]))
    assert all(not contains_failed_edge(row["path"]) for row in rows)
    assert all(not any(s["segment_version"] == segment["segment_version"]
                       and s["direction"] == segment["direction"] for s in row["segments"]) for row in rows)


@pytest.mark.parametrize("change", ["direction", "version", "holding"])
def test_failure_scope_does_not_ban_other_direction_version_or_load(recorded_base, change):
    memory, segment, current = setup_recorded(recorded_base)
    assert memory.remember_approach_segment_failure(segment, current)
    original = copy.deepcopy(memory._approach_segment_failures)
    if change == "direction":
        segment["direction"] = "forward"
    elif change == "version":
        segment["segment_version"] += "-new"
    else:
        memory._latest_public_observation["holding"]["holding"] = True
    assert memory.approach_segment_failure(segment) is None
    assert memory._approach_segment_failures == original


@pytest.mark.parametrize("fault", ["unknown", "not-sent", "missing-id", "empty-id", "ack-none",
    "unaccepted", "incomplete", "ack-error", "ack-wrong-stop", "ack-zero-distance", "ack-wrong-distance",
    "ack-zero-ticks", "ack-wrong-ticks", "speed-zero", "speed-bool", "extra-param", "short-command",
    "bad-before", "bad-after", "missing-motion", "duplicate-motion", "missing-frame", "duplicate-frame",
    "old-frame", "zero-tick", "sensor-tick", "holding-change", "holding-unknown", "offroad",
    "no-new-node", "already-at-node", "wrong-start", "wrong-heading", "zero-displacement", "zero-odometry"])
def test_unknown_or_incomplete_failure_evidence_never_creates_exclusion(recorded_base, fault):
    memory, segment, current = setup_recorded(recorded_base)
    original_getter = memory.observation_records

    def altered(first, last):
        window = copy.deepcopy(original_getter(first, last))
        if (first, last) != (633, 634):
            return window
        frames, motions = window["observations"], window["motions"]
        a, b, motion = frames[0], frames[1], motions[0]
        receipt = motion["actuator_result"]
        if fault == "unknown": motion["outcome_unknown"] = True
        elif fault == "not-sent": motion["motion_not_sent"] = True
        elif fault == "missing-id": motion.pop("bridge_request_id")
        elif fault == "empty-id": motion["bridge_request_id"] = ""
        elif fault == "ack-none": motion["actuator_result"] = None
        elif fault == "unaccepted": receipt["accepted"] = False
        elif fault == "incomplete": receipt["completed"] = False
        elif fault == "ack-error": receipt["error"] = "synthetic"
        elif fault == "ack-wrong-stop": receipt["stoppedBy"] = "max_distance"
        elif fault == "ack-zero-distance": receipt["distanceCm"] = 0
        elif fault == "ack-wrong-distance": receipt["distanceCm"] += 1
        elif fault == "ack-zero-ticks": receipt["elapsedTicks"] = 0
        elif fault == "ack-wrong-ticks": receipt["elapsedTicks"] += 1
        elif fault == "speed-zero": motion["params"]["speed"] = 0
        elif fault == "speed-bool": motion["params"]["speed"] = True
        elif fault == "extra-param": motion["params"]["unknown"] = 1
        elif fault == "short-command": motion["params"]["distanceCm"] = 9.9
        elif fault == "bad-before": motion["before_observation"] = 632
        elif fault == "bad-after": motion["after_observation"] = 635
        elif fault == "missing-motion": motions.clear()
        elif fault == "duplicate-motion": motions.append(copy.deepcopy(motion))
        elif fault == "missing-frame": frames.pop()
        elif fault == "duplicate-frame": frames.insert(0, copy.deepcopy(a))
        elif fault == "old-frame": b["observation"]["frameId"] = a["observation"]["frameId"]
        elif fault == "zero-tick": b["odometry"]["tick"] = a["odometry"]["tick"]
        elif fault == "sensor-tick": b["observation"]["tick"] -= 1
        elif fault == "holding-change": b["holding"]["holding"] = True
        elif fault == "holding-unknown": a["holding"]["holding"] = None
        elif fault == "offroad": b["road"]["onRoad"] = False
        elif fault == "no-new-node": b["road"]["atNode"] = False
        elif fault == "already-at-node": a["road"]["atNode"] = True
        elif fault == "wrong-start": a["odometry"]["rightCm"] += .1
        elif fault == "wrong-heading": a["odometry"]["headingDeg"] += 1
        elif fault == "zero-displacement":
            b["odometry"].update({k:a["odometry"][k] for k in ("rightCm", "forwardCm")})
        elif fault == "zero-odometry": b["odometry"]["distanceCm"] = a["odometry"]["distanceCm"]
        return window

    memory.observation_records = altered
    assert memory.remember_approach_segment_failure(segment, current) is None
    assert memory._approach_segment_failures == []


@pytest.mark.parametrize("fault", ["unknown", "not-sent", "missing-id", "unaccepted", "missing",
    "duplicate", "changed-packet", "holding-mismatch"])
def test_original_recorded_segment_requires_registered_known_source(recorded_base, fault):
    memory, segment, current = setup_recorded(recorded_base)
    original_getter = memory.observation_records

    def altered(first, last):
        window = copy.deepcopy(original_getter(first, last))
        if (first, last) == (537, 538):
            motion = window["motions"][0]
            if fault == "unknown": motion["outcome_unknown"] = True
            elif fault == "not-sent": motion["motion_not_sent"] = True
            elif fault == "missing-id": motion.pop("bridge_request_id")
            elif fault == "unaccepted": motion["actuator_result"]["accepted"] = False
            elif fault == "missing": window["motions"].clear()
            elif fault == "duplicate": window["motions"].append(copy.deepcopy(motion))
            elif fault == "changed-packet": motion["bridge_request_id"] += "-different"
            elif fault == "holding-mismatch":
                for f in window["observations"]: f["holding"]["holding"] = True
        return window

    memory.observation_records = altered
    assert memory.remember_approach_segment_failure(segment, current) is None
    assert memory._approach_segment_failures == []


@pytest.mark.parametrize("field,value", [("odometry", None), ("road", None), ("holding", None),
    ("observation", None), ("observation_index", 633)])
def test_current_frame_must_remain_registered(recorded_base, field, value):
    memory, segment, current = setup_recorded(recorded_base)
    current[field] = value
    assert memory.remember_approach_segment_failure(segment, current) is None
    assert memory._approach_segment_failures == []


def append_observed_motion(memory, template, method, params, receipt, *, unknown=False):
    previous = memory._latest_public_observation
    frame = copy.deepcopy(template)
    i = previous["observation_index"] + 1
    frame["observation_index"] = i
    tick = previous["odometry"]["tick"] + receipt.get("elapsedTicks", 1)
    frame["odometry"].update(tick=tick,
        distanceCm=previous["odometry"]["distanceCm"] + receipt.get("distanceCm", 0))
    frame["observation"] = {"frameId": str(i), "tick": tick}
    frame["road"]["tick"] = tick
    motion = {"round": 119, "method": method, "params": params,
        "bridge_request_id": f"synthetic-new-observed-{i}",
        "before_observation": i-1, "after_observation": i, "actuator_result": receipt}
    if unknown:
        motion["outcome_unknown"] = True
    memory.update(frame["odometry"], frame["road"], i)
    memory.observe_traversal(frame, motion)
    return frame


@pytest.mark.parametrize("last_outcome", ["known-full", "unknown-full", "known-partial"])
def test_only_new_observed_complete_direction_replaces_failed_assumption(recorded_base, last_outcome):
    memory, segment, current = setup_recorded(recorded_base)
    assert memory.remember_approach_segment_failure(segment, current)
    ledger = copy.deepcopy(memory._approach_segment_failures)
    data = source_data()
    frames = {f["observation_index"]: f for f in data["frames"]}
    # Explicit synthetic registered travel returns to the old departure. These
    # commands are test inputs, never commands to the competition controller.
    turned = copy.deepcopy(current)
    turned["odometry"]["headingDeg"] = -15.6
    append_observed_motion(memory, turned, "turn", {"angleDeg":177.9,"speed":50}, {"completed":True})
    at_start = copy.deepcopy(frames[632])
    append_observed_motion(memory, at_start, "follow_road", {"distanceCm":10,"speed":50},
        {"accepted":True,"stoppedBy":"max_distance","distanceCm":9.4,"elapsedTicks":32})
    aligned = copy.deepcopy(frames[633])
    append_observed_motion(memory, aligned, "turn", {"angleDeg":-180,"speed":50}, {"completed":True})
    assert memory.approach_segment_failure(segment)
    target = copy.deepcopy(frames[537] if last_outcome != "known-partial" else frames[634])
    target["odometry"]["headingDeg"] = 172.8 if last_outcome != "known-partial" else 166.5
    amount = 39.1 if last_outcome != "known-partial" else 9.4
    append_observed_motion(memory, target, "follow_road", {"distanceCm":40,"speed":50},
        {"accepted":True,"stoppedBy":"junction","distanceCm":amount,"elapsedTicks":100},
        unknown=last_outcome == "unknown-full")
    retained = memory._approach_edges[START][END]
    if last_outcome == "known-full":
        assert retained["direction"] == "forward" and retained["direction_status"] == "observed_forward"
        assert retained["segment_id"] != segment["segment_id"]
        assert memory.approach_segment_failure(retained) is None
        assert contains_failed_edge(memory.route_to({"rightCm":5,"forwardCm":175.8}, END))
    else:
        assert retained["segment_id"] == segment["segment_id"]
        assert memory.approach_segment_failure(retained)
        assert not contains_failed_edge(memory.route_to({"rightCm":5,"forwardCm":175.8}, END))
    assert memory._approach_segment_failures == ledger
    assert memory._road_segments[segment["segment_id"]]["direction"] == "forward"


class ActualWindowRuntime:
    """Real public return frames replayed behind synthetic command callbacks."""
    def __init__(self, *, unknown=None):
        data = source_data()
        self.rows = {f["observation_index"]: f for f in data["frames"]}
        self.queued = {m["after_observation"]: m for m in data["motions"]}
        self.roads = rebuild(data, through=632)
        self.snapshot = copy.deepcopy(self.rows[632])
        self.round = 118
        self.calls, self.motions, self.readonly = [], [], 0
        self.pending_grasp = self.held_object_id = None
        self.perception = SimpleNamespace(objects=lambda: [])
        self.motion_log = SimpleNamespace(write=lambda row:self.motions.append(copy.deepcopy(row)))
        self.bridge = SimpleNamespace(call=self.call, seconds=0, max_seconds=1200, sequence=9000)
        self.unknown = unknown
        self.actions = Actions(self)

    def call(self, method, params):
        self.calls.append((method, copy.deepcopy(params)))
        self.bridge.sequence += 1
        expected = self.queued[self.snapshot["observation_index"] + 1]
        assert method == expected["method"] and params == expected["params"]
        if method == self.unknown:
            raise ConnectionError("synthetic_unknown_segment_attempt")
        return copy.deepcopy(expected["actuator_result"])

    def observe(self, *, motion=None):
        if motion is None:
            self.readonly += 1
            return
        i = self.snapshot["observation_index"] + 1
        self.snapshot = copy.deepcopy(self.rows[i])
        self.roads.update(self.snapshot["odometry"], self.snapshot["road"], i)
        self.roads.observe_traversal(self.snapshot, dict(motion, after_observation=i))


def test_actual_actions_record_first_failure_then_reject_new_whole_route_before_send():
    runtime = ActualWindowRuntime()
    runtime.actions._historical_views = {"target_A": [
        {"schema":"historical-view-revisit/v1", "position_m":[-.127,1.505],
         "heading_deg":87.5, "source_observation":537}], "target_B": [
        {"schema":"historical-view-revisit/v1", "position_m":[-.156,1.514],
         "heading_deg":-90, "source_observation":527}]}
    original_views = copy.deepcopy(runtime.actions._historical_views)
    segment = copy.deepcopy(runtime.roads._approach_edges[START][END])
    route = candidate(segment)
    reached, reason, steps = runtime.actions._follow_approach_path(route, [10])
    assert not reached and reason == "reposition_unrecorded_junction_inside_segment"
    assert [m for m, _ in runtime.calls] == ["turn", "follow_road"]
    assert len(runtime.motions) == 2 and not any(m.get("outcome_unknown") for m in runtime.motions)
    assert steps[-1]["route_segment_failure"]["before_observation"] == 633
    assert runtime.actions._historical_views == original_views
    count = len(runtime.calls)
    route["route_version"] = "different-full-route"
    route["position_m"] = [-.127, 1.505]
    reached, reason, steps = runtime.actions._follow_approach_path(route, [10])
    assert not reached and reason == "reposition_segment_failure_unchanged"
    assert len(runtime.calls) == count
    assert steps[-1]["route_segment_failure"]["segment_id"] == segment["segment_id"]
    assert runtime.actions._historical_views == original_views


@pytest.mark.parametrize("method", ["turn", "follow_road"])
def test_unknown_dispatch_sends_once_and_never_creates_known_segment_failure(method):
    runtime = ActualWindowRuntime(unknown=method)
    segment = copy.deepcopy(runtime.roads._approach_edges[START][END])
    with pytest.raises(ConnectionError) as caught:
        runtime.actions._follow_approach_path(candidate(segment), [10])
    assert [m for m, _ in runtime.calls].count(method) == 1
    assert len(runtime.calls) == (1 if method == "turn" else 2)
    assert runtime.readonly == 1
    assert runtime.motions[-1]["outcome_unknown"] is True
    assert caught.value.action_evidence["outcome_unknown"] is True
    assert caught.value.action_evidence["uncertain_motion"]["method"] == method
    assert runtime.roads._approach_segment_failures == []
