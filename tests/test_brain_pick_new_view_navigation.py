"""A38: exhausted probes require independent evidence and usable road motion.

The public fixture reconstructs original RoadMemory without truth. Its execute
test uses synthetic completed actuator responses and reobserves the public
road endpoints; that component replay is not a new competition or identity
calibration. Independent identity checks below use production Perception/WM.
"""
import copy
import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.navigation import RoadMemory, distance, position, wrap
from test_brain_grab_authorization import actual_grabs
from test_brain_near_pick_navigation import near_runtime
from test_brain_pick_pixel_recovery import ClippedRetryRuntime, commands
from test_brain_route_contract import normalize
from test_brain_route_contract import straight_runtime
from test_brain_stage2_adversarial import SensorTrace


FIXTURE = Path(__file__).parent / "fixtures/run_20261013T095756_new_view_road_public.json"


def exhausted(r, *, return_offset_cm=0):
    anchor = copy.deepcopy(r.snapshot["odometry"])
    returned = dict(anchor, forwardCm=anchor["forwardCm"] - return_offset_cm)
    bound = {"limit_cm": .1, "requires_new_view": True,
             "anchor_odometry": anchor, "observed_return_odometry": returned}
    r.actions._pick_probe_limits[r.object_id] = copy.deepcopy(bound)
    return bound


@pytest.mark.parametrize("change", ["fresh-frame", "turn-in-place", "detector-jitter"])
def test_same_position_cannot_become_ready_or_reset_exhausted_probe(change):
    r = near_runtime()
    bound = exhausted(r)
    if change == "turn-in-place":
        r.actions.move("turn", {"angleDeg": 1, "speed": 30})
    elif change == "detector-jitter":
        r.override_items[0]["bbox"]["y"] += 2
        r.observe()
    else:
        r.observe()
    status = r.actions.pick_probe_view_status(r.object_id)
    assert status["blocked"] and not status["changed_view"]
    assert not status["independent_supported_view"]
    assert not r.actions.current_pick_ready(r.object_id)
    assert not r.actions.navigation_readiness(r.object_id)["operation_ready"]
    result = r.actions.visual_standoff(r.object_id)
    assert not result["success"] and result["reason"] == "pick_requires_new_supported_view"
    assert r.actions._pick_probe_limits[r.object_id] == bound
    assert not actual_grabs(r) and not r.perception._grab_authorizations
    assert not commands(r, "forward") and not commands(r, "backward")


def test_independent_position_must_be_far_enough_from_both_observed_anchors():
    r = ClippedRetryRuntime(clip_gap=100, grab_results=(True,))
    bound = exhausted(r, return_offset_cm=10)
    r.actions.move("backward", {"distanceCm": 16, "speed": 30})
    first = r.actions.pick_probe_view_status(r.object_id)
    assert first["blocked"] and not first["changed_view"]
    r.actions.move("backward", {"distanceCm": 10, "speed": 30})
    second = r.actions.pick_probe_view_status(r.object_id)
    assert second["changed_view"] and second["independent_supported_view"]
    assert not second["blocked"]
    assert second["min_hit_pose_gap_m"] == r.perception.wm.assoc_cfg.min_hit_pose_gap_m
    # Read-only readiness does not reset the bound or issue a grasp proof.
    assert r.actions._pick_probe_limits[r.object_id] == bound
    assert not r.perception._grab_authorizations and not actual_grabs(r)
    result = r.pick()
    assert result["success"], result
    assert result["evidence"]["retry_probe_reset"]["limit_cm"] == 6
    attempt = result["evidence"]["attempts"][0]
    proof = attempt["grab_ref"]["authorization"]
    assert proof["observation_index"] == attempt["before_observation"]
    assert proof["command_ref"]["bridge_request_id"] == actual_grabs(r)[0]["request"]["requestId"]
    assert r.audit()["failures"] == []


@pytest.mark.parametrize("fault", ["unknown", "rival", "pending", "holding", "held-id", "old-frame"])
def test_new_position_without_current_full_identity_does_not_unlock(fault):
    r = ClippedRetryRuntime(clip_gap=100)
    bound = exhausted(r)
    r.actions.move("backward", {"distanceCm": 16, "speed": 30})
    assert r.actions.pick_probe_view_status(r.object_id)["independent_supported_view"]
    if fault == "unknown":
        r.clip_after = r.forward - 1
        r.observe()
    elif fault == "rival":
        r.override_items = copy.deepcopy(r.snapshot["observation"]["detections"])
        r.override_items.append(copy.deepcopy(r.override_items[0]))
        r.observe()
    elif fault == "pending":
        r.pending_grasp = {"object_id": r.object_id}
    elif fault == "holding":
        r.snapshot["holding"]["holding"] = True
    elif fault == "held-id":
        r.held_object_id = r.object_id
    else:
        r.snapshot["observation"]["frameId"] = "not-the-converted-frame"
    state = r.actions.pick_probe_view_status(r.object_id)
    assert state["changed_view"] and state["blocked"]
    assert not state["independent_supported_view"]
    assert not r.actions.current_pick_ready(r.object_id)
    assert not r.actions.navigation_readiness(r.object_id)["operation_ready"]
    assert r.actions._pick_probe_limits[r.object_id] == bound
    assert not actual_grabs(r) and not r.perception._grab_authorizations


def public_roads():
    fixture = json.loads(FIXTURE.read_text())
    roads = RoadMemory()
    observations = {o["observation_index"]: o for o in fixture["observations"]}
    motions = {m["after_observation"]: m for m in fixture["motions"]}
    for original in fixture["observations"]:
        row = copy.deepcopy(original)
        motion = copy.deepcopy(motions.get(row["observation_index"]))
        roads.update(row["odometry"], row["road"], row["observation_index"])
        roads.observe_traversal(row, motion)
        if motion and motion.get("passage_failure"):
            roads.remember_passage_failure(observations[motion["before_observation"]], row, motion)
    return fixture, roads


def public_endpoint_runtime(*, fault=None):
    """Synthetic actuator, original public road graph and endpoint geometry.

    New test frames/ticks are explicitly synthetic and never written back to
    the fixture. No identity authorization is supplied by this bridge replay.
    """
    fixture, roads = public_roads()
    row = copy.deepcopy(fixture["observations"][-1])
    row["perception"] = {"detections": []}
    target = copy.deepcopy(fixture["target"])
    calls, motions = [], []
    runtime = SimpleNamespace(snapshot=row, round=76, roads=roads,
        bridge=SimpleNamespace(seconds=0, max_seconds=1200),
        motion_log=SimpleNamespace(write=motions.append), held_object_id=None, pending_grasp=None,
        perception=SimpleNamespace(objects=lambda: [target], get_object=lambda _: target,
            confirmed=lambda _: target, visible=lambda _: None))
    current_sensor = [copy.deepcopy(row)]

    def call(method, params):
        normalized = normalize(method, params)
        calls.append((method, normalized))
        odo = row["odometry"]
        if method == "turn":
            odo["headingDeg"] = wrap(odo["headingDeg"] + normalized["angleDeg"])
        else:
            assert method in {"forward", "backward", "follow_road"}
            length = normalized["distanceCm"]
            direction = -1 if method == "backward" else 1
            theta = math.radians(odo["headingDeg"])
            predicted = ((odo["rightCm"] - direction * length * math.sin(theta)) / 100,
                         (odo["forwardCm"] + direction * length * math.cos(theta)) / 100)
            endpoint = min(fixture["observations"], key=lambda o: distance(position(o["odometry"]), predicted))
            assert distance(position(endpoint["odometry"]), predicted) < .002
            odo.update(rightCm=endpoint["odometry"]["rightCm"],
                       forwardCm=endpoint["odometry"]["forwardCm"],
                       distanceCm=odo["distanceCm"] + length)
            current_sensor[0] = copy.deepcopy(endpoint)
        if fault == "unknown":
            raise ConnectionError("synthetic_after_dispatch_ack_unknown")
        return {"accepted": True, "completed": True}

    def observe(*, motion=None):
        row["observation_index"] += 1
        row["odometry"]["tick"] += 1
        tick = row["odometry"]["tick"]
        row["observation"] = {"frameId": "synthetic-reobservation-" + str(row["observation_index"]),
            "tick": tick, "width": 640, "height": 480, "detections": []}
        row["road"] = copy.deepcopy(current_sensor[0]["road"])
        row["road"]["tick"] = tick
        if fault == "missing-junction" and motion is None and row["road"]["atNode"]:
            row["road"].update(atNode=False, exits=[])
        roads.update(row["odometry"], row["road"], row["observation_index"])
        roads.observe_traversal(row, motion)

    runtime.bridge.call = call
    runtime.observe = observe
    runtime.actions = Actions(runtime)
    runtime.actions._pick_probe_limits[target["id"]] = copy.deepcopy(fixture["probe_limit"])
    return runtime, fixture, calls, motions


def test_original_public_graph_has_no_final_view_but_known_intermediate_junctions():
    fixture, roads = public_roads()
    current = fixture["observations"][-1]
    point = fixture["target"]["position_m"]
    goal = point["x"], point["z"]
    assert roads.approach_candidates(current["odometry"], goal) == []
    candidates = roads.approach_candidates(current["odometry"], goal, purpose="observed_junction_return")
    assert 0 < len(candidates) <= 3
    by_index = {o["observation_index"]: o for o in fixture["observations"]}
    for candidate in candidates:
        source = by_index[candidate["observation_index"]]
        assert source["road"]["onRoad"] and source["road"]["atNode"] and source["road"]["exits"]
        assert candidate["position_m"] == list(position(source["odometry"]))
        assert distance(position(current["odometry"]), candidate["position_m"]) < .15
        assert all(roads.edge_passage_blocked(s) is None for s in candidate["segments"])
    assert candidates[0]["observation_index"] == 402
    assert candidates[0]["travelled_cm"] == pytest.approx(5.6)


def test_actual_execute_consumes_public_return_path_without_claiming_new_pick_view():
    r, fixture, calls, motions = public_endpoint_runtime()
    oid = fixture["target"]["id"]
    bound = copy.deepcopy(r.actions._pick_probe_limits[oid])
    blocked_before = copy.deepcopy(r.roads.blocked)
    result = r.actions.execute({"action": "go_to", "params": {"object_id": oid}})
    assert not result["success"], result
    assert result["reason"] == "pick_new_view_returned_to_observed_junction", result
    attempt = result["evidence"]["road_reposition"]["attempts"][0]
    assert attempt["reached"] and attempt["candidate"]["purpose"] == "observed_junction_return"
    assert attempt["steps"] and all(s["historical_arc_retraced"] for s in attempt["steps"])
    assert calls and all(method == "backward" for method, _ in calls)
    assert sum(params["distanceCm"] for _, params in calls) == pytest.approx(5.6)
    assert all(m["motion_verification"]["motion_verified"] for m in motions)
    assert r.snapshot["road"]["atNode"] and r.snapshot["road"]["exits"]
    assert r.actions.pick_probe_view_status(oid)["blocked"]
    assert not result["evidence"]["navigation_subgoal"]["operation_ready"]
    assert r.actions._pick_probe_limits[oid] == bound
    assert r.roads.blocked == blocked_before
    assert r.pending_grasp is None and r.held_object_id is None


def test_return_arrival_requires_fresh_junction_exits_not_just_old_endpoint():
    r, fixture, calls, _ = public_endpoint_runtime(fault="missing-junction")
    oid = fixture["target"]["id"]
    result = r.actions.execute({"action": "go_to", "params": {"object_id": oid}})
    assert calls and not result["success"]
    assert result["reason"] == "pick_new_view_return_junction_not_observed", result
    assert r.actions.pick_probe_view_status(oid)["blocked"]
    assert r.actions._pick_probe_limits[oid] == fixture["probe_limit"]


def test_unknown_return_motion_is_dispatched_once_and_never_retried():
    r, fixture, calls, motions = public_endpoint_runtime(fault="unknown")
    oid = fixture["target"]["id"]
    with pytest.raises(ConnectionError, match="synthetic_after_dispatch_ack_unknown"):
        r.actions.execute({"action": "go_to", "params": {"object_id": oid}})
    assert len(calls) == 1 and calls[0][0] == "backward"
    assert len(motions) == 1 and motions[0]["outcome_unknown"]
    assert r.actions._pick_probe_limits[oid] == fixture["probe_limit"]
    assert r.pending_grasp is None and r.held_object_id is None


def test_intermediate_return_cannot_override_existing_directed_passage_block():
    fixture, roads = public_roads()
    current = fixture["observations"][-1]
    p = fixture["target"]["position_m"]
    goal = p["x"], p["z"]
    candidates = roads.approach_candidates(current["odometry"], goal, purpose="observed_junction_return")
    segment = candidates[0]["segments"][0]
    # Synthetic negative: a subsequent known stop in this return direction.
    stopped = copy.deepcopy(current)
    stopped["observation_index"] += 1
    stopped["observation"]["frameId"] = "synthetic-stop"
    stopped["odometry"]["tick"] += 1
    roads.remember_passage_failure(current, stopped, {"method": "backward", "params": {"distanceCm": 1},
        "before_observation": current["observation_index"], "after_observation": stopped["observation_index"],
        "actuator_result": {"accepted": True, "stoppedBy": "front_clearance"}})
    assert roads.edge_passage_blocked(segment) is not None
    assert roads.approach_candidates(current["odometry"], goal, purpose="observed_junction_return") == []


def test_both_anchor_filters_apply_before_real_road_candidate_cap():
    trace = SensorTrace()
    trace.publish(0, 0)
    travelled = 0
    previous = 0
    for end in [58, 100, 116, 117, 118, 117, 116, 100, 58, 0]:
        length = abs(end - previous)
        method = "forward" if end > previous else "backward"
        travelled += length
        trace.publish(0, end, travelled=travelled, method=method,
                      params={"distanceCm": length, "speed": 30})
        previous = end
    r, _, calls, _ = straight_runtime([58, 42])
    r.roads = trace.roads
    r.perception.get_object("red")["position_m"]["z"] = 1.5
    r.actions = Actions(r)
    r.object_id = "red"
    exhausted(r, return_offset_cm=-117)
    original = r.roads.approach_candidates(r.snapshot["odometry"], (0, 1.5))
    assert [c["position_m"] for c in original] == [[0, 1.18], [0, 1.17], [0, 1.16]]
    # Zero motion budget isolates actual Actions candidate consumption. The
    # public execute test above separately exercises nonzero route execution.
    outcome = r.actions._road_reposition("red", r.actions.result(False, "pick_requires_new_supported_view"),
                                        [0], require_new_pick_view=True)
    attempt = outcome["evidence"]["road_reposition"]["attempts"][0]
    assert attempt["candidate"]["position_m"] == [0, 1.0]
    assert not attempt["reached"] and attempt["reason"] == "reposition_motion_budget_exhausted"
    assert not outcome["success"] and calls == []
