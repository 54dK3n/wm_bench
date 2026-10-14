"""Original public r25/r27 road windows; synthetic dispatch feedback only.

No scene state, object truth or unexecuted observation is treated as a real
competition result. Mutated records below are explicit negative fixtures.
"""
import copy
import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from autonomous_brain.navigation import RoadMemory
from autonomous_brain import confirmation_sampling as sampling


FIXTURE = json.loads((Path(__file__).parent / "fixtures/run_20261013T075743_sampling_reverse_prefix_public.json").read_text())
PARAMS = {"distanceCm": 10., "speed": 30}


def runtime_fixture(index=130):
    data = copy.deepcopy(FIXTURE)
    frames = {o["observation_index"]: o for o in data["observations"]}
    by_after = {m["after_observation"]: m for m in data["motions"]}
    roads = RoadMemory()
    for i, frame in frames.items():
        if i > index:
            break
        roads.update(frame["odometry"], frame["road"], i)
        logged = by_after.get(i)
        runtime_motion = copy.deepcopy(logged)
        if runtime_motion:
            # Runtime records the window before post-observation verification.
            runtime_motion.pop("motion_verification", None)
            runtime_motion.pop("passage_failure", None)
        roads.observe_traversal(frame, runtime_motion)
        if logged:
            roads.remember_passage_failure(frames[logged["before_observation"]], frame, logged)
    current = copy.deepcopy(frames[index])
    calls, motions = [], []
    controls = {"unknown": False, "observation_failure": False, "fraction": 1.}
    r = SimpleNamespace(snapshot=current, roads=roads, round=25,
        held_object_id=None, pending_grasp=None,
        perception=SimpleNamespace(objects=lambda: []),
        bridge=SimpleNamespace(seconds=current["simulation_seconds"], max_seconds=1200, sequence=900),
        motion_log=SimpleNamespace(write=lambda row: motions.append(copy.deepcopy(row))))

    def call(method, params):
        assert method == "backward"
        calls.append((method, copy.deepcopy(params)))
        r.bridge.sequence += 1
        amount = params["distanceCm"] * controls["fraction"]
        theta = math.radians(current["odometry"]["headingDeg"])
        current["odometry"]["rightCm"] += amount * math.sin(theta)
        current["odometry"]["forwardCm"] -= amount * math.cos(theta)
        current["odometry"]["distanceCm"] += amount
        if controls["unknown"]:
            raise ConnectionError("synthetic dispatched reverse outcome unknown")
        return {"completed": True}

    def observe(*, motion=None):
        if motion is not None and controls["observation_failure"]:
            raise ConnectionError("synthetic post-motion observation missing")
        current["observation_index"] += 1
        current["odometry"]["tick"] += 1
        current["road"]["tick"] = current["odometry"]["tick"]
        current["observation"].update(frameId=current["observation_index"], tick=current["odometry"]["tick"])
        r.bridge.seconds += .02
        current["simulation_seconds"] = r.bridge.seconds
        roads.update(current["odometry"], current["road"], current["observation_index"])
        roads.observe_traversal(current, dict(motion, after_observation=current["observation_index"])
                                if motion is not None else None)
        return current

    r.bridge.call, r.observe = call, observe
    return r, Actions(r), calls, motions, controls


@pytest.mark.parametrize("index", [130, 136])
def test_original_public_window_has_bounded_proof_but_default_stays_blocked(index):
    r, actions, calls, motions, _ = runtime_fixture(index)
    old = copy.deepcopy(r.roads.blocked)
    proof = actions.sampling_reverse_clearance_prefix(PARAMS)
    assert proof["observation_index"] == index
    assert proof["old_passages_resolved"] is False
    assert len(proof["stop_boundaries"]) == 1
    boundary = proof["stop_boundaries"][0]
    assert boundary["stop_observation"] == 124
    assert boundary["normal_heading_deg"] == -90  # body points the other way
    assert boundary["start_gap_cm"] == pytest.approx(16.4)
    assert boundary["end_gap_cm"] == pytest.approx(6.4)
    assert proof["reverse_path_support"]["planned_position_m"] == pytest.approx([-.639, .865])
    assert r.roads.blocked == old
    with pytest.raises(ObservedMotionFailure) as failure:
        actions.move("backward", PARAMS)
    assert failure.value.reason == "directed_passage_still_blocked"
    assert failure.value.evidence["motion_not_sent"] is True
    assert calls == motions == []


def test_explicit_sampling_reverse_dispatches_once_and_preserves_all_stops():
    r, actions, calls, motions, _ = runtime_fixture()
    old = copy.deepcopy(r.roads.blocked)
    assert actions.move("backward", PARAMS, sampling_reverse_prefix=True) == {"completed": True}
    assert calls == [("backward", PARAMS)]
    assert len(motions) == 1 and motions[0]["motion_verification"]["motion_verified"]
    assert motions[0]["motion_verification"]["measured_cm"] == pytest.approx(10)
    assert motions[0]["recorded_reverse_before_stop"]["stop_boundaries"][0]["end_gap_cm"] == pytest.approx(6.4)
    assert r.roads.blocked == old


@pytest.mark.parametrize("fault", ["missing_frame", "missing_motion", "unknown_motion", "curved_arc",
    "lateral_gap", "tick", "holding", "pending", "side", "stale_snapshot"])
def test_complete_current_straight_window_is_recomputed_before_dispatch(fault):
    r, actions, calls, motions, _ = runtime_fixture()
    assert actions.sampling_reverse_clearance_prefix(PARAMS) is not None
    original = r.roads.observation_records
    def records(first, last):
        window = original(first, last)
        if fault == "missing_frame":
            window["observations"] = [o for o in window["observations"] if o["observation_index"] != 128]
        elif fault == "missing_motion":
            window["motions"] = [m for m in window["motions"] if m["before_observation"] != 125]
        elif fault == "unknown_motion":
            window["motions"][0]["outcome_unknown"] = True
        return window
    r.roads.observation_records = records
    if fault in {"curved_arc", "lateral_gap"}:
        segments = r.roads.road_segment_records
        def changed():
            rows = segments()
            for row in rows:
                if row["before_observation"] == 125:
                    if fault == "curved_arc": row["travelled_cm"] += 1
                    else: row["departure"]["position_m"][1] += .01
            return rows
        r.roads.road_segment_records = changed
    elif fault == "tick": r.snapshot["road"]["tick"] += 1
    elif fault == "holding": r.snapshot["holding"]["holding"] = True
    elif fault == "pending": r.pending_grasp = {"object_id": "synthetic unresolved"}
    elif fault == "side":
        r.snapshot["road"].update(headingErrorDeg=10, rightClearanceCm=.1, leftClearanceCm=.1)
    elif fault == "stale_snapshot": r.snapshot["odometry"]["rightCm"] += 1
    with pytest.raises(ObservedMotionFailure) as failure:
        actions.move("backward", PARAMS, sampling_reverse_prefix=True)
    assert failure.value.reason == "sampling_reverse_prefix_unverified"
    assert failure.value.evidence["motion_not_sent"] is True
    assert calls == motions == []


@pytest.mark.parametrize("fault", ["collision", "unknown", "missing_receipt", "receipt_list",
    "verification_list", "elapsed", "missing_command", "stop_frame", "stop_normal", "stop_heading", "stop_position"])
def test_uncertain_or_malformed_retained_stop_does_not_dispatch(fault):
    r, actions, calls, motions, _ = runtime_fixture()
    row = r.roads.blocked[-1]
    if fault == "collision": row["reason"] = "collision"
    elif fault == "unknown": row["motion"]["outcome_unknown"] = True
    elif fault == "missing_receipt": row["motion"].pop("actuator_result")
    elif fault == "receipt_list": row["motion"]["actuator_result"] = ["synthetic malformed"]
    elif fault == "verification_list": row["motion"]["motion_verification"] = ["synthetic malformed"]
    elif fault == "elapsed": row["motion"]["actuator_result"]["elapsedTicks"] += 1
    elif fault == "missing_command": row["motion"].pop("bridge_request_id")
    elif fault == "stop_frame": row["stop"]["frame_id"] = row["entry"]["frame_id"]
    elif fault == "stop_normal": row["direction_heading_deg"] = 90
    elif fault == "stop_heading": row["stop"]["body_heading_deg"] = 90
    else: row["stop"].pop("position_m")
    with pytest.raises(ObservedMotionFailure) as failure:
        actions.move("backward", PARAMS, sampling_reverse_prefix=True)
    assert failure.value.evidence["motion_not_sent"] is True
    assert calls == motions == []


def test_farther_second_stop_entered_at_endpoint_cannot_be_hidden_by_current_query():
    r, actions, calls, motions, _ = runtime_fixture()
    second = copy.deepcopy(r.roads.blocked[-1])
    second["passage_id"] = "synthetic second stop outside current radius"
    second["entry"]["position_m"] = [-.490, .865]
    second["stop"]["position_m"] = [-.489, .865]
    second["reason"] = "collision"
    r.roads.blocked.insert(0, second)
    current_matches = r.roads.passage_blockers(r.snapshot, -90)
    assert second["passage_id"] not in {v["passage_id"] for v in current_matches}
    # 24.9 cm from current, 14.9 cm from the planned endpoint: still applicable.
    with pytest.raises(ObservedMotionFailure):
        actions.move("backward", PARAMS, sampling_reverse_prefix=True)
    assert calls == motions == [] and second["resolved_by"] is None


def test_stop_neighbourhood_intersecting_only_path_interior_is_checked():
    r, actions, _, _, _ = runtime_fixture()
    # Use a 20 cm synthetic supported path solely to exercise segment geometry.
    original = sampling._recorded_translation_support
    support = original(actions, 10, "backward")
    support["planned_position_m"] = [-.539, .865]
    row = copy.deepcopy(r.roads.blocked[-1])
    row["entry"]["position_m"] = row["stop"]["position_m"] = [-.639, 1.014]
    row["passage_id"] = "synthetic interior-only collision"
    row["reason"] = "collision"
    r.roads.blocked[:] = [row]
    # Each endpoint is over 15 cm away, but the closest interior point is 14.9.
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(sampling, "_recorded_translation_support", lambda *args: support)
        assert actions.sampling_reverse_clearance_prefix(dict(PARAMS, distanceCm=20)) is None


def test_same_direction_stop_completely_away_from_finite_path_does_not_expand_guard():
    r, actions, _, _, _ = runtime_fixture()
    unrelated = copy.deepcopy(r.roads.blocked[-1])
    unrelated["passage_id"] = "synthetic far same-direction stop"
    unrelated["entry"]["position_m"] = [-2., .865]
    unrelated["stop"]["position_m"] = [-1.99, .865]
    r.roads.blocked.insert(0, unrelated)
    proof = actions.sampling_reverse_clearance_prefix(PARAMS)
    assert proof and [v["stop_observation"] for v in proof["stop_boundaries"]] == [124]


@pytest.mark.parametrize("gap_cm", [10.2, 10, 9.9])
def test_stop_plane_reserve_cannot_be_spent(gap_cm):
    r, actions, _, _, _ = runtime_fixture()
    r.roads.blocked[-1]["stop"]["position_m"] = [(-73.9 + gap_cm) / 100, .865]
    assert actions.sampling_reverse_clearance_prefix(PARAMS) is None


@pytest.mark.parametrize("fault", ["unknown", "observation_failure"])
def test_dispatched_uncertainty_is_not_repeated_or_automatically_reversed(fault):
    _, actions, calls, motions, controls = runtime_fixture()
    controls[fault] = True
    with pytest.raises(ConnectionError):
        actions.move("backward", PARAMS, sampling_reverse_prefix=True)
    assert calls == [("backward", PARAMS)]
    assert len(motions) == 1 and motions[0]["outcome_unknown"] is True


def test_receipt_without_measured_translation_does_not_verify_motion():
    _, actions, calls, motions, controls = runtime_fixture()
    controls["fraction"] = 0
    with pytest.raises(ObservedMotionFailure) as failure:
        actions.move("backward", PARAMS, sampling_reverse_prefix=True)
    assert failure.value.reason == "basic_motion_not_verified"
    assert len(calls) == len(motions) == 1
    assert motions[0]["motion_verification"]["motion_verified"] is False


def test_actual_sampler_opts_in_then_requires_new_observation_without_inventing_hit(monkeypatch):
    r, actions, calls, motions, _ = runtime_fixture()
    target = {"hypothesis_id": "synthetic sampler control", "source_discovery_id": "synthetic source",
        "associated_object": {"id": "synthetic target", "hit_count": 1, "state": "TENTATIVE"},
        "reason": "ready_for_sampling", "sampling_allowed": True,
        "current_detection": {"raw_distance_cm": 72, "raw_bearing_deg": 17.87},
        "confirmation": {"accepted_hit_poses": []}}
    def discovery(_):
        row = copy.deepcopy(target)
        if r.snapshot["observation_index"] > 130:
            row.update(reason="current_identity_ambiguous", sampling_allowed=False)
        return row
    r.perception.discovery_target = discovery
    proof = actions.sampling_reverse_clearance_prefix(PARAMS)
    monkeypatch.setattr(sampling, "_plan", lambda *args, **kwargs: {
        "method": "backward", "params": PARAMS,
        "reverse_path_support": proof["reverse_path_support"]})
    result = sampling.sample_discovery(actions, "synthetic sampler control")
    assert calls == [("backward", PARAMS)]
    assert "recorded_reverse_before_stop" in motions[0]
    assert result["success"] is False
    assert result["reason"] == "confirmation_current_identity_ambiguous"
    trace = result["evidence"]["confirmation_sampling"]
    assert trace["independent_hits_added"] == 0 and trace["confirmed_object_id"] is None
    assert trace["steps"][0]["after_observation"] == 131


def test_restore_plan_does_not_opt_in(monkeypatch):
    r, actions, calls, _, _ = runtime_fixture()
    target = {"hypothesis_id": "synthetic restore", "source_discovery_id": "synthetic source",
        "associated_object": {"id": "synthetic target", "hit_count": 1, "state": "TENTATIVE"},
        "reason": "ready_for_sampling", "sampling_allowed": True,
        "current_detection": {}, "confirmation": {"accepted_hit_poses": []}}
    r.perception.discovery_target = lambda _: copy.deepcopy(target)
    monkeypatch.setattr(sampling, "_plan", lambda *args, **kwargs: {
        "method": "backward", "params": PARAMS, "phase": "restore_previous_view",
        "reverse_path_support": {"synthetic": "not authority"}})
    result = sampling.sample_discovery(actions, "synthetic restore")
    assert result["reason"] == "confirmation_directed_passage_still_blocked"
    assert not calls
