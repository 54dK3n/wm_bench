"""Initial supported approach recovery, without inventing a prior empty grab.

Public r28 source/forward samples retain their original fields. Only the
counterfactual inverse/readback is synthetic; this is a component replay, not
a new competition, shape calibration, or physical identity claim.
"""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.navigation import RoadMemory, position
from autonomous_brain.perception import Perception
from autonomous_brain.run import compact_action_result
from test_brain_grab_authorization import actual_grabs
from test_brain_pick_pixel_recovery import ClippedRetryRuntime, commands
from test_brain_route_contract import normalize


FIXTURE = Path(__file__).parent / "fixtures/run_20261013T102849_blocked_pick_public.json"


def initial_runtime(*, remaining=23.38166633498621, clip_gap=1, recovery_fault=None):
    r = ClippedRetryRuntime(clip_gap=100, grab_results=(True,))
    r.actions.move("backward", {"distanceCm": remaining - 21, "speed": 30})
    r.recovery_fault = recovery_fault
    r.entry = copy.deepcopy(r.snapshot["odometry"])
    r.clip_after = r.forward + clip_gap
    r.command_start = len(r.bridge_records)
    assert r.perception.check_grasp_identity(r.object_id, r.snapshot)["authorized"]
    return r


def public_initial_runtime(*, unknown=False):
    fixture = json.loads(FIXTURE.read_text())
    perception = Perception(fixture["camera_parameters"])
    roads = RoadMemory()
    rows = {row["observation_index"]: row for row in fixture["observations"]}
    motions_by_after = {m["after_observation"]: m for m in fixture["motions"]}
    for original in fixture["observations"]:
        if original["observation_index"] > 115:
            break
        row = copy.deepcopy(original)
        motion = motions_by_after.get(row["observation_index"])
        converted = perception.update(row["observation"], row["odometry"],
            simulation_time_s=row["simulation_seconds"], round_index=row["round"],
            observation_index=row["observation_index"])
        roads.update(row["odometry"], row["road"], row["observation_index"])
        roads.observe_traversal(row, motion)
        if motion and motion.get("passage_failure"):
            roads.remember_passage_failure(rows[motion["before_observation"]], row, motion)
    row["perception"] = converted
    row["objects"] = perception.objects()
    calls, motions = [], []
    pending = []
    runtime = SimpleNamespace(snapshot=row, round=28, perception=perception, roads=roads,
        bridge=SimpleNamespace(seconds=row["simulation_seconds"], max_seconds=1200),
        motion_log=SimpleNamespace(write=motions.append), pending_grasp=None, held_object_id=None)

    def call(method, params):
        params = normalize(method, params)
        calls.append((method, copy.deepcopy(params)))
        if len(calls) == 1:
            assert method == "forward"
            assert params["distanceCm"] == pytest.approx(1.38166633498621)
            # The original completed 115→116 public response and observation.
            pending.append(copy.deepcopy(rows[116]))
            if unknown:
                raise ConnectionError("synthetic_initial_forward_ack_unknown")
            return copy.deepcopy(motions_by_after[116]["actuator_result"])
        assert len(calls) == 2 and method == "backward"
        assert params["distanceCm"] == pytest.approx(1.4)
        restored = copy.deepcopy(rows[115])
        restored["odometry"]["distanceCm"] = row["odometry"]["distanceCm"] + params["distanceCm"]
        pending.append(restored)
        return {"completed": True}

    def observe(*, motion=None):
        original_forward = bool(pending and len(calls) == 1)
        selected = pending.pop(0) if pending else copy.deepcopy(row)
        if not original_forward:
            # Deliberately separate synthetic future frames from all originals.
            index = max(100000, row["observation_index"] + 1)
            tick = row["odometry"]["tick"] + 1
            selected.update(observation_index=index, simulation_seconds=runtime.bridge.seconds + .02)
            selected["odometry"]["tick"] = selected["road"]["tick"] = tick
            selected["observation"].update(frameId=index, tick=tick)
            for item in selected["observation"]["detections"]:
                if "pixelQuality" in item:
                    item["pixelQuality"]["frameId"] = index
        runtime.bridge.seconds = selected["simulation_seconds"]
        converted = perception.update(selected["observation"], selected["odometry"],
            simulation_time_s=selected["simulation_seconds"], round_index=28,
            observation_index=selected["observation_index"])
        row.clear()
        row.update(selected, perception=converted, objects=perception.objects())
        roads.update(row["odometry"], row["road"], row["observation_index"])
        roads.observe_traversal(row, motion)

    runtime.bridge.call = call
    runtime.observe = observe
    runtime.actions = Actions(runtime)
    return runtime, fixture, calls, motions


def test_public_full115_known_forward116_clips_and_only_measured_inverse_learns():
    r, fixture, calls, motions = public_initial_runtime()
    oid = fixture["target"]["id"]
    assert r.snapshot["observation_index"] == 115
    assert r.perception.check_grasp_identity(oid, r.snapshot)["authorized"]
    assert r.perception.visible(oid)["pixel_quality"]["status"] == "supported"
    old = fixture["clipped_pick_result"]
    assert old["evidence"]["attempts"] == [] and "retry_probe" not in old["evidence"]
    source_pose = position(r.snapshot["odometry"])
    outcome = r.actions.execute({"action": "pick", "params": {"object_id": oid}})
    assert not outcome["success"] and outcome["reason"] == "grab_identity_not_uniquely_visible"
    evidence = outcome["evidence"]
    assert evidence["attempts"] == []
    assert [method for method, _ in calls] == ["forward", "backward"]
    assert all(m["motion_verification"]["motion_verified"] for m in motions)
    assert evidence["grab_authorization"]["authorized"] is False
    assert evidence["grab_authorization"]["observation_index"] == 116
    assert evidence["authorization_recovery"]["success"]
    probe = evidence["retry_probe"]
    assert probe["probe_kind"] == "fresh_supported_approach"
    assert probe["source_observation"] == 115 and probe["clipped_observation"] == 116
    assert probe["restored_observation"] >= 100000
    assert probe["limit_cm"] == pytest.approx(1.38166633498621 / 2)
    assert position(r.snapshot["odometry"]) == source_pose
    assert r.perception.check_grasp_identity(oid, r.snapshot)["authorized"]
    assert r.held_object_id is None and r.pending_grasp is None
    assert not r.perception.action_evidence() and not r.perception._grab_authorizations
    assert not r.actions.current_pick_ready(oid)  # Still 23.38cm away.
    compact = compact_action_result(28, {"action": "pick", "params": {"object_id": oid}},
                                    outcome, r.snapshot["observation_index"])
    assert compact["reason"] == "supported_approach_probe_refined"
    assert compact["original_reason"] == "grab_identity_not_uniquely_visible"
    assert compact["success"] is False and compact["evidence"]["attempts"] == []
    assert compact["evidence"]["pick_retry"]["next_probe_limit_cm"] == probe["limit_cm"]
    assert compact["evidence"]["pick_retry"]["requires_fresh_authorization"] is True


def test_normal_approach_consumes_smaller_bound_on_next_model_pick():
    r = initial_runtime()
    first = r.pick()
    assert not first["success"] and first["evidence"]["attempts"] == []
    bound = first["evidence"]["retry_probe"]["limit_cm"]
    assert bound == pytest.approx(1.38166633498621 / 2)
    assert not r.actions.current_pick_ready(r.object_id)
    before = len(commands(r, "forward"))
    second = r.pick()
    assert second["reason"] != "action_repeat_without_new_evidence"
    assert not second["success"] and second["evidence"]["attempts"] == []
    steps = commands(r, "forward")[before:]
    assert steps and all(p["distanceCm"] <= bound for p in steps)
    assert second["evidence"]["retry_probe"]["limit_cm"] == pytest.approx(bound / 2)
    assert not actual_grabs(r) and not r.perception._grab_authorizations


@pytest.mark.parametrize("remaining, expected_forward", [(22.49, []), (22.51, [.51])])
def test_existing_22_5_grab_gate_is_also_the_approach_stop_boundary(remaining, expected_forward):
    r = initial_runtime(remaining=remaining, clip_gap=100)
    outcome = r.pick()
    assert outcome["success"], outcome
    assert [p["distanceCm"] for p in commands(r, "forward")] == pytest.approx(expected_forward)
    assert len(actual_grabs(r)) == 1
    attempt = outcome["evidence"]["attempts"][0]
    assert attempt["alignment"]["remembered_distance_cm"] <= 22.5
    proof = attempt["grab_ref"]["authorization"]
    assert proof["observation_index"] == attempt["before_observation"]
    assert proof["command_ref"]["bridge_request_id"] == actual_grabs(r)[0]["request"]["requestId"]
    assert r.audit()["failures"] == []


@pytest.mark.parametrize("fault", ["unknown-pixels", "competition", "pending", "holding"])
def test_initial_probe_needs_current_supported_identity_empty_and_no_pending(fault):
    r = initial_runtime()
    if fault == "unknown-pixels":
        r.clip_after = r.forward - 1
        r.observe()
    elif fault == "competition":
        r.override_items = copy.deepcopy(r.snapshot["observation"]["detections"])
        r.override_items.append(copy.deepcopy(r.override_items[0]))
        r.observe()
    elif fault == "pending":
        r.pending_grasp = {"object_id": r.object_id}
    else:
        r.holding = True
        r.snapshot["holding"]["holding"] = True
    outcome = r.pick()
    assert not outcome["success"]
    assert not commands(r, "forward") and not actual_grabs(r)
    assert r.actions._pick_probe_limits == {}


@pytest.mark.parametrize("fault", ["partial", "unknown"])
def test_initial_inverse_partial_or_unknown_never_learns_or_repeats(fault):
    r = initial_runtime(recovery_fault=fault)
    if fault == "unknown":
        with pytest.raises(ConnectionError):
            r.pick()
    else:
        outcome = r.pick()
        assert not outcome["success"]
        assert not outcome["evidence"]["authorization_recovery"]["success"]
    assert len(commands(r, "forward")) == 1 and len(commands(r, "backward")) == 1
    assert r.actions._pick_probe_limits == {}
    assert not actual_grabs(r)


def test_public_initial_forward_unknown_never_inverts_or_learns():
    r, fixture, calls, motions = public_initial_runtime(unknown=True)
    with pytest.raises(ConnectionError, match="synthetic_initial_forward_ack_unknown"):
        r.actions.execute({"action": "pick", "params": {"object_id": fixture["target"]["id"]}})
    assert len(calls) == 1 and calls[0][0] == "forward"
    assert len(motions) == 1 and motions[0]["outcome_unknown"]
    assert r.actions._pick_probe_limits == {} and r.pending_grasp is None


@pytest.mark.parametrize("receipt", [{}, {"completed": False}, {"completed": True, "accepted": False}])
def test_incomplete_initial_forward_receipt_cannot_license_inverse_or_bound(receipt):
    r = initial_runtime()
    original = r.bridge.call
    def incomplete(method, params):
        result = original(method, params)
        if method == "forward":
            r.bridge_records[-1]["terminal"]["result"] = copy.deepcopy(receipt)
            return copy.deepcopy(receipt)
        return result
    r.bridge.call = incomplete
    outcome = r.pick()
    assert not outcome["success"] and outcome["reason"] == "pick_probe_receipt_not_completed"
    assert len(commands(r, "forward")) == 1 and not commands(r, "backward")
    assert not actual_grabs(r) and r.actions._pick_probe_limits == {}


def test_returned_pose_with_same_frame_competition_cannot_learn_initial_bound():
    r = initial_runtime()
    r.rival_after_return = True
    outcome = r.pick()
    assert not outcome["success"] and outcome["evidence"]["authorization_recovery"]["success"]
    assert "retry_probe" not in outcome["evidence"]
    assert r.actions._pick_probe_limits == {} and not actual_grabs(r)
