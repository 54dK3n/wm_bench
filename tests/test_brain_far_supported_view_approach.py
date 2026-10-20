"""A53 bounded approach components; public replay is not a platform result.

The actual-window adapter retains the public WM object snapshot and executes
the original Perception identity matrix. Its later feedback is explicitly
synthetic. A separate case runs Perception.update and the real vendored WM.
"""
import copy
import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from autonomous_brain.navigation import RoadMemory, wrap
from autonomous_brain.perception import Perception
from autonomous_brain.task import parse_task
from test_brain_pick_entry_affordance import PublicPerception as SnapshotPerception
from test_brain_release_recovery_integration import ReleaseRecoveryRuntime


FIXTURE = json.loads((Path(__file__).parent /
    "fixtures/run_20261020T104225Z_far_handoff_public.json").read_text())
OBJECT = FIXTURE["object_id"]
GO_TO = {"action": "go_to", "params": {"object_id": OBJECT}}


class PublicPerception(SnapshotPerception):
    """Frozen public WM snapshot; all identity/entry checks are production."""

    def __init__(self, frame):
        super().__init__(frame)
        self.camera = copy.deepcopy(FIXTURE["camera_parameters"])
        self._unverified_releases = {}
        self._discovery_records = []
        self._discovery_resolutions = {}
        self._discovery_associations = []
        self._identity_ambiguities = {}


def install(runtime, frame, motion=None):
    runtime.snapshot = frame
    runtime.perception = PublicPerception(frame)
    runtime.bridge.seconds = frame["simulation_seconds"]
    runtime.roads.update(frame["odometry"], frame["road"], frame["observation_index"])
    runtime.roads.observe_traversal(frame, copy.deepcopy(motion))


def current_runtime(index=190, *, register=True):
    """Actual public turn, retained handoff, readonly current frame, and stops."""
    calls = []
    runtime = SimpleNamespace(roads=RoadMemory(), round=46, held_object_id=None,
        pending_grasp=None, config={"task": "把两个红球送到绿色存放区"}, recent=[],
        task_spec=parse_task("把两个红球送到绿色存放区"),
        bridge=SimpleNamespace(seconds=0., max_seconds=1200, sequence=10000))
    runtime.bridge.call = lambda method, params: calls.append((method, params))
    runtime.actions = actions = Actions(runtime)
    for motion in FIXTURE["stop_motions"]:
        before = copy.deepcopy(FIXTURE["frames"][str(motion["before_observation"])])
        after = copy.deepcopy(FIXTURE["frames"][str(motion["after_observation"])])
        install(runtime, before)
        install(runtime, after, motion)
        assert runtime.roads.remember_passage_failure(before, after, motion)
    handoff = copy.deepcopy(FIXTURE["handoffs"][{156: "38", 184: "44", 190: "46"}[index]])
    source = handoff["before_observation"]
    turn = next(m for m in FIXTURE["handoff_motions"] if m["before_observation"] == source)
    actions._pick_probe_limits[OBJECT] = copy.deepcopy(FIXTURE["bound"])
    actions._historical_views = {OBJECT: []}
    actions._empty_grab_navigation = {OBJECT: [{"prior_failed_probe": "preserve"}]}
    for i in range(source, index + 1):
        install(runtime, copy.deepcopy(FIXTURE["frames"][str(i)]),
                turn if i == turn["after_observation"] else None)
        if i == handoff["post_observation"] and register:
            actions._register_far_supported_view(handoff)
    record = actions._navigation_record(OBJECT)
    record["approach_attempts"] = [{"candidate_id": "prior-A", "outcome": "failed"}]
    return runtime, actions, calls


def frozen_history(actions):
    return copy.deepcopy({"bound": actions._pick_probe_limits,
        "views": actions._historical_views, "empty": actions._empty_grab_navigation,
        "attempts": actions._navigation_record(OBJECT)["approach_attempts"]})


def refresh(runtime):
    runtime.perception = PublicPerception(runtime.snapshot)


def sync(frame):
    frame["perception"].update(frame_id=str(frame["observation"]["frameId"]),
        tick=frame["odometry"]["tick"], simulation_time_s=frame["simulation_seconds"],
        odometry=copy.deepcopy(frame["odometry"]),
        raw_observation=copy.deepcopy(frame["observation"]))


def synthetic_next(frame, distance_cm=0., *, fault=None):
    """Declared synthetic future feedback; never substitute for actual frames."""
    result = copy.deepcopy(frame)
    result["observation_index"] += 1
    result["simulation_seconds"] += .1 if distance_cm else .02
    odo = result["odometry"]
    theta = math.radians(odo["headingDeg"])
    odo["tick"] += 5 if distance_cm else 0
    odo["rightCm"] -= math.sin(theta) * distance_cm
    odo["forwardCm"] += math.cos(theta) * distance_cm
    odo["distanceCm"] += abs(distance_cm)
    result["road"]["tick"] = odo["tick"]
    result["observation"].update(frameId=result["observation_index"], tick=odo["tick"])
    for raw, detected in zip(result["observation"]["detections"], result["perception"]["detections"]):
        detected["frame_id"] = str(result["observation_index"])
        for item, key in ((detected, "pixel_quality"), (raw, "pixelQuality")):
            if isinstance(item.get(key), dict):
                item[key]["frameId"] = result["observation_index"]
        point = detected.get("position_m")
        if distance_cm and isinstance(point, dict):
            dx, dz = point["x"] * 100 - odo["rightCm"], point["z"] * 100 - odo["forwardCm"]
            detected["distance_cm"] = math.hypot(dx, dz)
            detected["bearing_deg"] = wrap(math.degrees(math.atan2(dx, dz)) + odo["headingDeg"])
    for obj in result["objects"]:
        point = obj.get("position_m")
        if isinstance(point, dict):
            dx, dz = point["x"] * 100 - odo["rightCm"], point["z"] * 100 - odo["forwardCm"]
            obj["distance_cm"] = math.hypot(dx, dz)
            obj["bearing_deg"] = wrap(math.degrees(math.atan2(dx, dz)) + odo["headingDeg"])
    if fault:
        fault(result, frame)
    sync(result)
    return result


def dispatch_runtime(index=190, *, unknown=False, movement_fault=None, final_fault=None):
    runtime, actions, calls = current_runtime(index)
    motions, observations = [], []
    error = TimeoutError("synthetic A53 forward receipt unknown")
    runtime.motion_log = SimpleNamespace(write=lambda row: motions.append(copy.deepcopy(row)))
    pending = [0.]
    def call(method, params):
        calls.append((method, copy.deepcopy(params)))
        runtime.bridge.sequence += 1
        assert method == "forward", "far approach must not fall back to a route or manipulation"
        if unknown:
            raise error
        pending[0] = params["distanceCm"]
        return {"completed": True}
    def observe(*, motion=None):
        observations.append(copy.deepcopy(motion))
        frame = synthetic_next(runtime.snapshot, pending[0] if motion else 0.,
            fault=movement_fault if motion else final_fault)
        pending[0] = 0.
        registered = dict(motion, after_observation=frame["observation_index"]) if motion else None
        install(runtime, frame, registered)
        return frame
    runtime.bridge.call, runtime.observe = call, observe
    return runtime, actions, calls, motions, observations, error


@pytest.mark.parametrize("index", [156, 190])
def test_actual_aligned_retained_handoff_offers_only_a_bounded_road_step(index):
    runtime, actions, calls = current_runtime(index)
    before = frozen_history(actions)
    assert runtime.perception.check_grasp_identity(OBJECT, runtime.snapshot)["authorized"]
    assert actions.pick_probe_view_status(OBJECT)["independent_supported_view"]
    option = actions.far_supported_view_approach(OBJECT)
    assert option["available"] and option["step_cm"] == 4
    assert option["memory_distance_cm"] > 65 and option["current_visual_distance_cm"] > 65
    readiness = actions.navigation_readiness(OBJECT)
    assert not readiness["current_pick_ready"] and not readiness["operation_ready"]
    assert not readiness["pick_approach_entry"]["available"]
    assert readiness["far_supported_view_approach"] == option
    assert frozen_history(actions) == before and not calls
    assert len(runtime.roads.blocked) == 2


def test_actual_off_tangent184_cannot_borrow_the_aligned_handoff_permission():
    _, actions, calls = current_runtime(184)
    assert actions.s["road"]["headingErrorDeg"] == pytest.approx(-77)
    assert not actions.far_supported_view_approach(OBJECT)["available"]
    assert not calls


def test_current_supported_pixels_without_an_actual_retained_handoff_do_not_register():
    _, actions, calls = current_runtime(register=False)
    assert actions.pick_probe_view_status(OBJECT)["independent_supported_view"]
    assert not actions.far_supported_view_approach(OBJECT)["available"]
    assert not calls


@pytest.mark.parametrize("fault", [
    "missing_motion", "unknown_motion", "unsent_motion", "missing_ack", "ack_incomplete",
    "ack_error", "missing_request_id", "illegal_turn", "old_turn_frame", "zero_turn_tick",
    "holding_changed", "missing_readonly_frame", "readonly_translation",
    "not_retained", "post_view_mismatch",
])
def test_handoff_registration_requires_the_complete_known_turn_and_readonly_chain(fault):
    runtime, actions, calls = current_runtime(register=False)
    opportunity = copy.deepcopy(FIXTURE["handoffs"]["46"])
    runtime.snapshot = copy.deepcopy(FIXTURE["frames"]["189"])
    refresh(runtime)
    registry = runtime.roads._semantic
    motion = registry.motions[(187, 188)]
    if fault == "missing_motion": registry.motions.pop((187, 188))
    elif fault == "unknown_motion": motion["outcome_unknown"] = True
    elif fault == "unsent_motion": motion["motion_not_sent"] = True
    elif fault == "missing_ack": motion.pop("actuator_result")
    elif fault == "ack_incomplete": motion["actuator_result"]["completed"] = False
    elif fault == "ack_error": motion["actuator_result"]["error"] = "synthetic rejection"
    elif fault == "missing_request_id": motion.pop("bridge_request_id")
    elif fault == "illegal_turn": motion["params"]["angleDeg"] = 181.
    elif fault == "old_turn_frame":
        registry.frames[188]["observation"]["frameId"] = registry.frames[187]["observation"]["frameId"]
    elif fault == "zero_turn_tick":
        for field in ("odometry", "road", "observation"):
            registry.frames[188][field]["tick"] = registry.frames[187][field]["tick"]
    elif fault == "holding_changed": registry.frames[187]["holding"]["holding"] = True
    elif fault == "missing_readonly_frame": registry.frames.pop(189)
    elif fault == "readonly_translation": registry.frames[189]["odometry"]["rightCm"] += .1
    elif fault == "not_retained": opportunity["post_observation_retained"] = False
    elif fault == "post_view_mismatch": opportunity["post_observation_view"]["heading_deg"] += 1
    actions._register_far_supported_view(opportunity)
    assert not actions._far_supported_view_progress and not actions._far_supported_view_active
    assert not calls


def test_execute_one_forward_four_cm_has_bound_ack_new_frame_and_preserved_history():
    runtime, actions, calls, motions, observations, _ = dispatch_runtime()
    before = frozen_history(actions)
    result = actions.execute(copy.deepcopy(GO_TO))
    assert result["success"] is False and result["reason"] == "far_supported_view_approach_progress"
    assert calls == [("forward", {"distanceCm": 4., "speed": 30})]
    assert len(motions) == 1 and motions[0]["bridge_request_id"] == "brain-010001"
    assert motions[0]["actuator_result"]["completed"] is True
    assert motions[0]["motion_verification"]["motion_verified"]
    assert motions[0]["before_observation"] == 190 and motions[0]["after_observation"] == 191
    assert len(observations) == 2 and observations[-1] is None
    assert runtime.snapshot["observation_index"] == 192
    assert frozen_history(actions) == before
    assert not runtime.perception._grab_authorizations


def test_execute_go_to_across_rounds_spends_one_global_five_step_twenty_cm_budget():
    runtime, actions, calls, _, _, _ = dispatch_runtime()
    bound = copy.deepcopy(actions._pick_probe_limits)
    commanded = 0.
    for step in range(5):
        runtime.round += 1
        commanded += actions.far_supported_view_approach(OBJECT)["step_cm"]
        result = actions.execute(copy.deepcopy(GO_TO))
        assert result["reason"] == "far_supported_view_approach_progress", (step, result["reason"])
        assert len(calls) == step + 1
        option = actions.far_supported_view_approach(OBJECT)
        assert option["steps_used"] == step + 1
        assert option["commanded_cm"] == pytest.approx(commanded)
        assert option["travelled_cm"] == pytest.approx(commanded)
        runtime.observe()
        assert actions.far_supported_view_approach(OBJECT)["steps_used"] == step + 1
    assert not option["available"] and option["remaining_steps"] == 0
    assert commanded <= 20 and option["remaining_distance_cm"] >= 0
    assert actions._pick_probe_limits == bound
    assert len(actions._far_supported_view_progress) == 1


def test_same_local_view_new_registered_turn_cannot_replenish_an_existing_budget():
    runtime, actions, calls, _, _, _ = dispatch_runtime()
    assert actions.execute(copy.deepcopy(GO_TO))["reason"] == "far_supported_view_approach_progress"
    old = copy.deepcopy(actions._far_supported_view_progress)
    first = runtime.snapshot["observation_index"]
    turned = synthetic_next(runtime.snapshot)
    turned["odometry"]["headingDeg"] = wrap(turned["odometry"]["headingDeg"] + 1.)
    turned["odometry"]["tick"] += 5
    turned["road"]["tick"] = turned["observation"]["tick"] = turned["odometry"]["tick"]
    sync(turned)
    motion = {"round": runtime.round + 1, "method": "turn", "params": {"angleDeg": 1., "speed": 50},
        "before_observation": first, "after_observation": first + 1,
        "bridge_request_id": "synthetic-rehandoff-1", "actuator_result": {"completed": True}}
    install(runtime, turned, motion)
    opportunity = next(row for row in actions._supported_pick_view_opportunities()
                       if row["object_id"] == OBJECT)
    opportunity["before_observation"] = first
    install(runtime, synthetic_next(runtime.snapshot))
    opportunity.update(post_observation_retained=True,
        post_observation=runtime.snapshot["observation_index"],
        post_observation_view=next(row for row in actions._supported_pick_view_opportunities()
                                  if row["object_id"] == OBJECT))
    actions._register_far_supported_view(opportunity)
    assert actions._far_supported_view_progress == old
    assert not actions.far_supported_view_approach(OBJECT)["available"]
    assert len(calls) == 1


@pytest.mark.parametrize("prior", [None, [], {"retained_diagnostic": True}])
def test_unknown_forward_aborts_once_without_route_fallback_or_budget_reset(prior):
    runtime, actions, calls, motions, observations, error = dispatch_runtime(unknown=True)
    error.action_evidence = copy.deepcopy(prior)
    with pytest.raises(TimeoutError) as raised:
        actions.execute(copy.deepcopy(GO_TO))
    assert raised.value is error
    assert len(calls) == 1 and calls[0][0] == "forward"
    assert observations == [None] and len(motions) == 1
    assert motions[0]["outcome_unknown"] is True
    assert error.action_evidence["outcome_unknown"] is True
    assert error.action_evidence["uncertain_motion"]["method"] == "forward"
    option = actions.far_supported_view_approach(OBJECT)
    assert not option["available"] and option["outcome_unknown"] and option["steps_used"] == 1
    with pytest.raises(RuntimeError):
        actions.execute(copy.deepcopy(GO_TO))
    assert len(calls) == 1


def test_lost_view_after_known_step_stops_without_entering_the_old_route():
    def lose(frame, before):
        frame["perception"]["detections"] = []
        frame["observation"]["detections"] = []
    runtime, actions, calls, _, _, _ = dispatch_runtime(movement_fault=lose)
    result = actions.execute(copy.deepcopy(GO_TO))
    assert result["reason"] == "supported_view_lost_after_step"
    assert len(calls) == 1
    runtime.observe()
    result = actions.execute(copy.deepcopy(GO_TO))
    assert result["success"] is False
    assert len(calls) == 1


@pytest.mark.parametrize("fault", ["zero_motion", "old_frame", "lateral_drift", "holding", "no_visual_progress"])
def test_nonverified_or_nonprogressing_feedback_never_sends_a_second_step(fault):
    def change(frame, before):
        if fault == "zero_motion":
            for key in ("rightCm", "forwardCm", "distanceCm"):
                frame["odometry"][key] = before["odometry"][key]
        elif fault == "old_frame":
            frame["observation"]["frameId"] = before["observation"]["frameId"]
        elif fault == "lateral_drift":
            frame["odometry"]["rightCm"] += 2.
        elif fault == "holding":
            frame["holding"]["holding"] = True
        else:
            detected = next(d for d in frame["perception"]["detections"] if d.get("track_id") == OBJECT)
            detected["distance_cm"] = next(d["distance_cm"] for d in before["perception"]["detections"]
                                          if d.get("track_id") == OBJECT)
    runtime, actions, calls, _, _, _ = dispatch_runtime(movement_fault=change)
    result = actions.execute(copy.deepcopy(GO_TO))
    assert result["success"] is False
    assert not actions.far_supported_view_approach(OBJECT)["available"]
    assert len(calls) == 1
    result = actions.execute(copy.deepcopy(GO_TO))
    assert result["success"] is False and len(calls) == 1


def test_unknown_final_readonly_observation_latches_the_same_short_step():
    runtime, actions, calls, motions, _, _ = dispatch_runtime()
    original = runtime.observe
    failure = TimeoutError("synthetic final observation unknown")
    def observe(*, motion=None):
        if motion is None:
            raise failure
        return original(motion=motion)
    runtime.observe = observe
    with pytest.raises(TimeoutError) as raised:
        actions.execute(copy.deepcopy(GO_TO))
    assert raised.value is failure
    assert len(calls) == 1 and len(motions) == 1
    assert motions[0]["actuator_result"]["completed"] is True
    assert failure.action_evidence["outcome_unknown"] is True
    assert actions.far_supported_view_approach(OBJECT)["outcome_unknown"] is True
    with pytest.raises(RuntimeError):
        actions.execute(copy.deepcopy(GO_TO))
    assert len(calls) == 1


def test_explicit_observed_unknown_does_not_enter_the_known_failure_route():
    runtime, actions, calls, motions, observations, _ = dispatch_runtime()
    failure = ObservedMotionFailure("synthetic unknown completion", {"outcome_unknown": True})
    def call(method, params):
        calls.append((method, copy.deepcopy(params)))
        runtime.bridge.sequence += 1
        raise failure
    runtime.bridge.call = call
    with pytest.raises(RuntimeError):
        actions.execute(copy.deepcopy(GO_TO))
    assert len(calls) == 1 and calls[0][0] == "forward"
    assert len(motions) == 1 and motions[0]["outcome_unknown"]
    assert observations == [None]
    assert actions.far_supported_view_approach(OBJECT)["outcome_unknown"]


def test_final_view_loss_still_prevents_the_next_round_from_falling_back_to_route():
    def lose(frame, before):
        frame["perception"]["detections"] = []
        frame["observation"]["detections"] = []
    _, actions, calls, _, _, _ = dispatch_runtime(final_fault=lose)
    assert actions.execute(copy.deepcopy(GO_TO))["success"] is False
    assert not actions.far_supported_view_approach(OBJECT)["available"]
    assert actions.execute(copy.deepcopy(GO_TO))["success"] is False
    assert len(calls) == 1


@pytest.mark.parametrize("fault", [
    "holding", "unknown_holding", "held_id", "pending", "offroad", "road_tick",
    "sensor_tick", "perception_tick", "stale_detection", "unknown_pixels",
    "duplicate_target", "unpositioned_competitor", "missing_target", "target_lost",
    "wrong_task", "bound_changed", "same_anchor", "tangent", "bearing", "front",
    "side", "missing_registered_current",
])
def test_current_state_is_rechecked_without_using_saved_handoff_authority(fault):
    runtime, actions, calls = current_runtime()
    f = runtime.snapshot
    d = next(d for d in f["perception"]["detections"] if d.get("track_id") == OBJECT)
    if fault == "holding": f["holding"]["holding"] = True
    elif fault == "unknown_holding": f["holding"]["holding"] = None
    elif fault == "held_id": runtime.held_object_id = "other"
    elif fault == "pending": runtime.pending_grasp = {}
    elif fault == "offroad": f["road"]["onRoad"] = False
    elif fault == "road_tick": f["road"]["tick"] += 1
    elif fault == "sensor_tick": f["observation"]["tick"] += 1
    elif fault == "perception_tick": f["perception"]["tick"] += 1
    elif fault == "stale_detection": d["frame_id"] = "189"
    elif fault == "unknown_pixels": d["pixel_quality"]["status"] = "unknown"
    elif fault == "duplicate_target": f["perception"]["detections"].append(copy.deepcopy(d))
    elif fault == "unpositioned_competitor":
        other = copy.deepcopy(d); other.pop("position_m"); other["track_id"] = None
        f["perception"]["detections"].append(other)
    elif fault == "missing_target": f["objects"] = [o for o in f["objects"] if o["id"] != OBJECT]
    elif fault == "target_lost":
        next(o for o in f["objects"] if o["id"] == OBJECT)["state"] = "LOST"
    elif fault == "wrong_task": runtime.task_spec = {"target_category": "blue-ball"}
    elif fault == "bound_changed": actions._pick_probe_limits[OBJECT]["limit_cm"] = .2
    elif fault == "same_anchor": actions._pick_probe_limits[OBJECT]["anchor_odometry"] = copy.deepcopy(f["odometry"])
    elif fault == "tangent": f["road"]["headingErrorDeg"] = 10.01
    elif fault == "bearing": d["bearing_deg"] = 40.01
    elif fault == "front": f["road"]["frontClearanceCm"] = .1
    elif fault == "side": f["road"]["leftClearanceCm"] = f["road"]["rightClearanceCm"] = .1
    elif fault == "missing_registered_current":
        runtime.roads._semantic.frames.pop(f["observation_index"])
    refresh(runtime)
    before = copy.deepcopy(actions._far_supported_view_progress)
    assert not actions.far_supported_view_approach(OBJECT)["available"]
    assert actions._far_supported_view_progress == before and not calls


def real_wm_runtime(*, setup_forward_cm=0., setup_right_cm=-20.):
    """Full production Perception.update + WM, synthetic sensor setup only."""
    runtime = ReleaseRecoveryRuntime()
    oid = runtime.old_id
    anchor = copy.deepcopy(runtime.snapshot["odometry"])
    runtime.forward, runtime.right, runtime.heading = setup_forward_cm, setup_right_cm, 60.
    runtime.observe()
    runtime.actions._pick_probe_limits[oid] = {"limit_cm": .1, "requires_new_view": True,
        "anchor_odometry": anchor, "observed_return_odometry": copy.deepcopy(anchor)}
    before = runtime.snapshot["observation_index"]
    runtime.actions.move("turn", {"angleDeg": -60., "speed": 50})
    opportunity = next(row for row in runtime.actions._supported_pick_view_opportunities()
                       if row["object_id"] == oid)
    opportunity["before_observation"] = before
    runtime.observe()
    current = next(row for row in runtime.actions._supported_pick_view_opportunities()
                   if row["object_id"] == oid)
    opportunity.update(post_observation_retained=True,
        post_observation=runtime.snapshot["observation_index"], post_observation_view=current)
    runtime.actions._register_far_supported_view(opportunity)
    return runtime, oid


def test_real_perception_update_vendored_wm_and_execute_keep_two_fresh_short_steps():
    runtime, oid = real_wm_runtime()
    assert isinstance(runtime.perception, Perception)
    assert type(runtime.perception.wm).__module__.startswith("world_model.")
    original_bound = copy.deepcopy(runtime.actions._pick_probe_limits)
    previous = runtime.perception.get_object(oid)["distance_cm"]
    before_motions = len(runtime.motions)
    for i in range(2):
        option = runtime.actions.far_supported_view_approach(oid)
        assert option["available"] and option["step_cm"] == 4
        result = runtime.execute("go_to", {"object_id": oid})
        assert result["reason"] == "far_supported_view_approach_progress"
        assert runtime.perception.check_grasp_identity(oid, runtime.snapshot)["authorized"]
        assert runtime.perception.get_object(oid)["distance_cm"] < previous
        previous = runtime.perception.get_object(oid)["distance_cm"]
        assert runtime.actions.far_supported_view_approach(oid)["steps_used"] == i + 1
    new_motions = runtime.motions[before_motions:]
    assert [row["method"] for row in new_motions] == ["forward", "forward"]
    assert all(row["motion_verification"]["motion_verified"] for row in new_motions)
    assert runtime.actions._pick_probe_limits == original_bound
    assert runtime.held_object_id is None and runtime.holding is False
    assert runtime.perception.action_evidence() == []


def test_real_runtime_state_exposes_current_far_step_and_budget_without_mutation():
    from autonomous_brain.run import Runtime
    runtime, oid = real_wm_runtime()
    runtime.actions._navigation_record(oid)
    runtime.recent = []
    before = copy.deepcopy(runtime.actions._far_supported_view_progress)
    state = Runtime.state(runtime)
    row = next(row for row in state["navigation"] if oid in row["identity_ids"])
    subgoal = row["current_subgoal"]
    assert subgoal["far_supported_view_approach"]["available"]
    assert subgoal["far_supported_view_approach"]["steps_used"] == 0
    assert not subgoal["operation_ready"] and not subgoal["pick_approach_entry"]["available"]
    assert runtime.actions._far_supported_view_progress == before


def test_real_execute_crosses_65cm_into_the_existing_visual_approach_without_reset():
    runtime, oid = real_wm_runtime(setup_forward_cm=20., setup_right_cm=-50.)
    for _ in range(3):
        assert runtime.execute("go_to", {"object_id": oid})["reason"] == "far_supported_view_approach_progress"
    option = runtime.actions.far_supported_view_approach(oid)
    assert option["reason"] == "within_existing_approach_range"
    assert option["current_visual_distance_cm"] <= 65
    assert option["memory_distance_cm"] > 65
    saved = copy.deepcopy(runtime.actions._far_supported_view_progress)
    before = len(runtime.motions)
    outcome = runtime.execute("go_to", {"object_id": oid})
    assert outcome["reason"] != "navigation_repeat_without_new_evidence"
    assert outcome["success"] is True
    assert len(runtime.motions) > before
    assert all(m["method"] in {"turn", "forward", "backward"} for m in runtime.motions[before:])
    after = copy.deepcopy(runtime.actions._far_supported_view_progress)
    for key, row in after.items():
        assert row.pop("visual_handoff_consumed") is True
        saved[key].pop("visual_handoff_consumed")
    assert after == saved
    assert runtime.perception.action_evidence() == []


@pytest.mark.parametrize("fault", ["identity", "stale", "no_clearance"])
def test_crossing_65cm_never_borrows_old_pixels_identity_or_road_clearance(fault):
    runtime, oid = real_wm_runtime(setup_forward_cm=20., setup_right_cm=-50.)
    for step in range(3):
        if fault == "no_clearance" and step == 2:
            # This sensor value first appears after the already legal third
            # move, so the next retained readonly window remains consistent.
            runtime.front_clearance_cm = .1
        assert runtime.execute("go_to", {"object_id": oid})["reason"] == "far_supported_view_approach_progress"
    assert runtime.actions.far_supported_view_approach(oid)["reason"] == "within_existing_approach_range"
    before = len(runtime.motions)
    if fault == "identity":
        runtime.perception.last_evidence["detections"].append(
            copy.deepcopy(runtime.perception.last_evidence["detections"][0]))
    elif fault == "stale":
        runtime.perception.last_evidence["frame_id"] = "stale"
    outcome = runtime.execute("go_to", {"object_id": oid})
    assert not outcome["success"]
    if fault == "no_clearance":
        assert all(row["method"] == "turn" for row in runtime.motions[before:])
        after = len(runtime.motions)
        assert not runtime.execute("go_to", {"object_id": oid})["success"]
        assert len(runtime.motions) == after
        assert next(iter(runtime.actions._far_supported_view_progress.values()))["visual_handoff_consumed"]
    else:
        assert len(runtime.motions) == before
    assert runtime.perception.action_evidence() == []
