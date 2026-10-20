"""Real Actions/Perception/vendored-WM release recovery; public synthetic sensors.

The bridge below is deterministic component feedback, not a platform or model.
No lifecycle/identity/containment/done function is mocked. Raw bounding boxes,
odometry, holding and command receipts pass through the production functions.
"""
import copy
import json
import math
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from autonomous_brain.actions import Actions, ObservedMotionFailure
from autonomous_brain.navigation import RoadMemory, wrap
from autonomous_brain.perception import Perception, RANGE_CAL
from autonomous_brain.task import parse_task
from test_brain_delivery_identity import storage_bbox
from test_brain_perception import CAMERA, ball
from test_brain_pixel_quality import quality
from tools.brain_evidence_audit import audit_observed_ledger


class ReleaseRecoveryRuntime:
    """Two public sensor-defined objects; real manipulation and identity ledger."""

    def __init__(self):
        self.perception = Perception(CAMERA)
        self.roads = RoadMemory()
        self.round = self.frame = self.tick = 0
        self.right, self.forward, self.heading, self.travelled = -20., 0., 0., 0.
        self.holding = False
        self.held_object_id = self.pending_grasp = None
        self.config = {"task": "把两个红球送到绿色存放区"}
        self.task_spec = parse_task(self.config["task"])
        self.bridge = SimpleNamespace(sequence=0, seconds=0., max_seconds=1200, call=self.call)
        self.motion_log = SimpleNamespace(write=lambda row: self.motions.append(copy.deepcopy(row)))
        self.motions, self.calls, self.observations, self.rounds = [], [], [], []
        self.log_call("camera_parameters", {}, CAMERA)
        self.points = {"old": {"x": -.20, "z": .90}}
        self.focus = "old"
        self.released = set()
        self.retreat_complete = False
        self.witness_mode = "both"
        self.recovery_road_available = False
        self.on_road = True
        self.front_clearance_cm = 100.
        self.unknown_method = None
        self.unknown_error = None
        self.second_release_right = None
        self.observe_motions = []
        self.actions = Actions(self)
        self._confirm_current_target()
        self.old_id = self._nearest_object(self.points["old"])

    def log_call(self, method, params, result, *, completed=True):
        self.bridge.sequence += 1
        request_id = f"brain-{self.bridge.sequence:06d}"
        self.calls.append({"request": {"requestId": request_id, "method": method,
            "params": copy.deepcopy(params)}, "terminal": {"requestId": request_id,
            "status": "completed", "result": copy.deepcopy(result)} if completed else None})

    def _nearest_object(self, point):
        return min((row for row in self.perception.objects() if row["category"] == "red-ball"
                    and row["state"] not in {"DELIVERED", "DELIVERY_ALIAS"}),
                   key=lambda row: math.hypot(row["position_m"]["x"] - point["x"],
                                             row["position_m"]["z"] - point["z"]))["id"]

    def _confirm_current_target(self):
        # Declared setup observations; recovery itself never teleports or uses
        # this helper. Their three separated public poses use the original WM.
        for forward in (0., 16., 32.):
            self.travelled += abs(self.forward - forward)
            self.forward = forward
            self.observe()

    def raw_ball(self, point, *, unknown=False):
        dx, dz = point["x"] * 100 - self.right, point["z"] * 100 - self.forward
        theta = math.radians(self.heading)
        local_right = dx * math.cos(theta) + dz * math.sin(theta)
        local_forward = -dx * math.sin(theta) + dz * math.cos(theta)
        if local_forward <= RANGE_CAL["L_cm"]:
            return None
        bearing = math.degrees(math.atan2(local_right, local_forward - RANGE_CAL["L_cm"]))
        reading = (local_forward - RANGE_CAL["L_cm"]
                   - RANGE_CAL["a_cm"] * math.cos(math.radians(bearing))) / RANGE_CAL["k"]
        if reading <= 6 or abs(bearing) >= 35:
            return None
        item = ball(reading, bearing=bearing)
        box = item["bbox"]
        box["y"] = min(box["y"], 475. - box["h"])
        if box["x"] <= 0 or box["x"] + box["w"] >= 640 or box["y"] + box["h"] >= 480:
            return None
        item["pixelQuality"] = quality(self.frame, supported=not unknown)
        return item

    def public_detections(self):
        items = []
        for name, point in self.points.items():
            if self.holding and name == self.focus:
                continue
            if self.focus == "new" and "new" in self.released:
                if name == "old" and self.witness_mode in {"new_only", "none"}:
                    continue
                # Declared public occlusion: a lateral view is needed to see
                # the old ball after the second release. Identity resolution
                # still uses the real calibrated pixels and unchanged gates.
                if (name == "old" and self.second_release_right is not None
                        and abs(self.right - self.second_release_right) < 1.):
                    continue
                if name == "new" and self.witness_mode in {"old_only", "none"}:
                    continue
            item = self.raw_ball(point, unknown=(name == "new" and self.witness_mode == "unknown_new"))
            if item is not None:
                items.append(item)
                if name == "new" and self.focus == "new" and "new" in self.released:
                    if self.witness_mode == "two_new":
                        other = copy.deepcopy(point)
                        other["x"] += .12
                        second = self.raw_ball(other)
                        if second is not None:
                            items.append(second)
        if self.holding:
            items.append(storage_bbox(close=True))
        elif self.released:
            # Complete broad public green component; its observed pixels alone
            # decide containment. This is not an evaluator region or map point.
            items.append({"category": "storage-zone", "source": "storage-ground-pixels",
                "confidence": 1., "bbox": {"x": 10., "y": 220., "w": 620., "h": 180.}})
        return items

    def call(self, method, params):
        assert method in {"grab", "release", "forward", "backward", "turn"}, method
        self.bridge.sequence += 1
        self.bridge.seconds += .1
        self.tick += 5
        request_id = f"brain-{self.bridge.sequence:06d}"
        request = {"requestId": request_id, "method": method, "params": copy.deepcopy(params)}
        if method == "grab":
            self.holding = True
        elif method == "release":
            assert self.focus not in self.released, "one physical release per object"
            self.holding = False
            theta = math.radians(self.heading)
            self.points[self.focus] = {"x": (self.right - math.sin(theta) * 18) / 100,
                                       "z": (self.forward + math.cos(theta) * 18) / 100}
            self.released.add(self.focus)
            if self.focus == "new":
                self.second_release_right = self.right
            self.retreat_complete = False
        elif method == "turn":
            self.heading = wrap(self.heading + params["angleDeg"])
        else:
            amount = params["distanceCm"] * (1 if method == "forward" else -1)
            theta = math.radians(self.heading)
            self.right -= math.sin(theta) * amount
            self.forward += math.cos(theta) * amount
            self.travelled += abs(amount)
            if method == "backward" and self.focus in self.released:
                self.retreat_complete = True
        result = {"completed": True}
        terminal = {"requestId": request_id, "status": "completed", "result": copy.deepcopy(result)}
        if method == self.unknown_method:
            self.unknown_method = None
            terminal = None
        self.calls.append({"request": request, "terminal": terminal})
        if terminal is None:
            if self.unknown_error is not None:
                raise self.unknown_error
            raise TimeoutError("synthetic recovery receipt unknown")
        return result

    def observe(self, *, motion=None):
        self.observe_motions.append(copy.deepcopy(motion))
        self.frame += 1
        self.bridge.seconds += .02
        if motion is not None:
            self.perception.note_manipulation_boundary(motion, self.frame)
        raw = {"frameId": self.frame, "tick": self.tick, "width": 640, "height": 480,
               "detections": self.public_detections()}
        odo = {"tick": self.tick, "rightCm": self.right, "forwardCm": self.forward,
               "headingDeg": self.heading, "distanceCm": self.travelled}
        available = self.recovery_road_available or self.focus not in self.released
        road = {"tick": self.tick, "onRoad": self.on_road, "atNode": False, "atJunction": False,
                "exits": [], "frontClearanceCm": self.front_clearance_cm, "leftClearanceCm": 100.,
                "rightClearanceCm": 100.,
                "headingErrorDeg": wrap(-90 - self.heading) if available and self.focus in self.released
                    else (0. if available else None)}
        converted = self.perception.update(raw, odo, simulation_time_s=self.bridge.seconds,
            round_index=self.round, observation_index=self.frame)
        self.snapshot = {"observation_index": self.frame, "round": self.round,
            "simulation_seconds": self.bridge.seconds, "observation": raw, "odometry": odo,
            "road": road, "holding": {"holding": self.holding}, "perception": converted,
            "objects": self.perception.objects(), "discovery_evidence": self.perception.discovery_evidence()}
        for method, key in (("odometry", "odometry"), ("local_road", "road"),
                            ("holding", "holding"), ("observe", "observation")):
            self.log_call(method, {}, self.snapshot[key])
        self.roads.update(odo, road, observation_index=self.frame)
        self.actions.observe_pending_grasp(self.snapshot)
        self.roads.observe_traversal(self.snapshot,
            dict(motion, after_observation=self.frame) if motion is not None else None)
        self.actions.note_historical_view(self.snapshot,
            dict(motion, after_observation=self.frame) if motion is not None else None)
        self.observations.append(copy.deepcopy(self.snapshot))
        return self.snapshot

    def execute(self, action, params=None):
        self.round += 1
        instruction = {"action": action, "params": params or {}}
        before_held = self.held_object_id
        result = self.actions.execute(instruction)
        self.rounds.append({"round": self.round, "action": instruction,
            "state": {"robot": {"held_object_id": before_held}},
            "result": copy.deepcopy(result)})
        return result

    def audit(self):
        return audit_observed_ledger({"action_evidence": self.perception.action_evidence(),
            "runtime_version": "autonomous-brain-runtime/v23",
            "final_objects": self.perception.objects()}, self.observations, self.rounds,
            self.calls, self.motions)

    def seed_second_release(self):
        assert self.execute("pick", {"object_id": self.old_id})["success"]
        first = self.execute("place")
        assert first["success"], first
        assert self.perception.get_object(self.old_id)["state"] == "DELIVERED"
        self.focus = "new"
        self.points["new"] = {"x": .20, "z": .90}
        self.right, self.forward, self.heading = 20., 0., 0.
        self._confirm_current_target()
        self.new_id = self._nearest_object(self.points["new"])
        assert self.new_id != self.old_id and self.perception.confirmed(self.new_id)
        assert self.execute("pick", {"object_id": self.new_id})["success"]
        # A54 requires a current independent old witness before selecting the
        # second aim. This declared setup pose supplies real calibrated pixels
        # and leaves about 40cm between the old anchor and close-green aim.
        self.right, self.forward, self.heading = -20., 0., 0.
        self.observe()
        self.witness_mode = "new_only"
        result = self.execute("place")
        assert result["success"] is False
        assert self.perception.get_object(self.new_id)["state"] == "RELEASED_UNVERIFIED"
        return result


def pending_runtime():
    runtime = ReleaseRecoveryRuntime()
    initial = runtime.seed_second_release()
    pending = runtime.perception.unverified_releases()
    assert len(pending) == 1
    assert pending[0]["required_delivered_ids"] == [runtime.old_id]
    return runtime, initial, copy.deepcopy(pending[0])


def release_calls(runtime):
    return [row for row in runtime.calls if row["request"]["method"] == "release"]


def motion_calls(runtime):
    return [row for row in runtime.calls if row["request"]["method"]
            in {"turn", "forward", "backward", "grab", "release"}]


def recovery_option(runtime):
    return runtime.actions.release_recovery_options()["pending"][0]


def prepare_legal_view(runtime, mode="both"):
    runtime.recovery_road_available = True
    runtime.witness_mode = mode
    runtime.observe()


def test_real_unique_new_witness_without_old_remains_unverified_and_boundary_immutable():
    runtime, initial, saved = pending_runtime()
    assert initial["evidence"]["candidate_witnesses"] == 1
    assert initial["evidence"]["placement"] is not None
    before = copy.deepcopy(runtime.perception.action_evidence())
    for _ in range(2):
        result = runtime.execute("place")
        assert not result["success"]
        pending = runtime.perception.unverified_releases()[0]
        assert pending["release_observation"] == saved["release_observation"]
        assert pending["required_delivered_ids"] == saved["required_delivered_ids"]
        assert pending["identity_anchor_m"] == saved["identity_anchor_m"]
    assert runtime.perception.action_evidence() == before
    assert len(release_calls(runtime)) == 2  # one old release and one new release
    assert runtime.execute("done")["success"] is False


def test_later_place_selects_one_legal_new_view_then_real_perception_can_deliver():
    runtime, _, saved = pending_runtime()
    runtime.recovery_road_available = True
    runtime.witness_mode = "both"
    runtime.observe()
    before = len(runtime.calls)
    outcome = runtime.execute("place")
    assert outcome["success"] is True, outcome
    assert any(row["request"]["method"] == "forward" for row in runtime.calls[before:])
    assert runtime.perception.get_object(runtime.new_id)["state"] == "DELIVERED"
    assert runtime.perception.unverified_releases() == []
    assert len(release_calls(runtime)) == 2
    placed = [event for event in runtime.perception.action_evidence()
              if event["action"] == "place" and event["object_id"] == runtime.new_id]
    assert len(placed) == 1
    assert placed[0]["evidence"]["release_observation"] == saved["release_observation"]
    witness_frame = next(row for row in runtime.observations
        if row["observation_index"] == placed[0]["evidence"]["post_observation"])
    red = [row for row in witness_frame["perception"]["detections"] if row["category"] == "red-ball"]
    old = [row for row in red if row.get("known_delivered_object_id") == runtime.old_id]
    new = [row for row in red if not row.get("known_delivered_object_id")]
    assert len(old) == len(new) == 1 and old[0]["bbox"] != new[0]["bbox"]
    assert all(row["pixel_quality"]["status"] == "supported" for row in old + new)
    assert runtime.execute("done")["success"] is True
    audit = runtime.audit()
    assert audit["failures"] == [], audit
    assert len(audit["picks"]) == len(audit["deliveries"]) == 2
    assert all(row["verified"] for row in audit["picks"] + audit["deliveries"])


@pytest.mark.parametrize("mode", ["old_only", "new_only", "none", "two_new", "unknown_new"])
def test_incomplete_or_competing_current_witness_never_marks_second_delivery(mode):
    runtime, _, saved = pending_runtime()
    prepare_legal_view(runtime, mode)
    result = runtime.execute("place")
    assert result["success"] is False
    assert runtime.perception.get_object(runtime.new_id)["state"] == "RELEASED_UNVERIFIED"
    assert runtime.perception.unverified_releases()[0]["release_observation"] == saved["release_observation"]
    assert len(release_calls(runtime)) == 2
    assert [event["object_id"] for event in runtime.perception.action_evidence()
            if event["action"] == "place"] == [runtime.old_id]
    assert runtime.execute("done")["success"] is False


def test_unknown_pixels_remain_competitors_and_are_not_positive_new_identity():
    runtime, _, saved = pending_runtime()
    prepare_legal_view(runtime, "unknown_new")
    result = runtime.execute("place")
    detections = runtime.snapshot["perception"]["detections"]
    candidates = [row for row in detections if row["category"] == "red-ball"
                  and not row.get("known_delivered_object_id")]
    unknown = [row for row in candidates if row["pixel_quality"]["status"] == "unknown"]
    assert len(unknown) == 1
    assert unknown[0]["fed_to_world_model"] is False
    assert unknown[0].get("known_delivered_object_id") is None
    assert result["success"] is False
    assert runtime.perception.unverified_releases()[0]["release_observation"] == saved["release_observation"]


def test_saved_original_release_cannot_be_replaced_by_current_frame():
    runtime, _, saved = pending_runtime()
    prepare_legal_view(runtime)
    # The real action obtains a view with both identities but is kept unable to
    # resolve only by a declared missing-old pixel frame.
    runtime.witness_mode = "new_only"
    runtime.execute("place")
    runtime.witness_mode = "both"
    runtime.observe()
    evidence = runtime.actions.placement_evidence("red-ball", saved["release_observation"])
    forged = copy.deepcopy(evidence)
    forged["release_observation"] = {
        **forged["release_observation"], "frame_id": runtime.snapshot["observation"]["frameId"],
        "simulation_time_s": runtime.snapshot["simulation_seconds"]}
    outcome = runtime.perception.recover_release(runtime.new_id, holding=False,
        simulation_time_s=runtime.bridge.seconds, evidence=forged)
    assert outcome["resolved"] is False
    assert runtime.perception.unverified_releases()[0]["release_observation"] == saved["release_observation"]
    assert not runtime.perception.mark_delivered(runtime.new_id, holding=False,
        ball_in_storage=True, simulation_time_s=runtime.bridge.seconds, evidence=forged)


def test_stale_placement_frame_cannot_authorize_delivery_even_with_both_boxes():
    runtime, _, saved = pending_runtime()
    prepare_legal_view(runtime, "new_only")
    runtime.execute("place")
    runtime.witness_mode = "both"
    runtime.observe()
    evidence = runtime.actions.placement_evidence("red-ball", saved["release_observation"])
    assert evidence["placement"] is not None
    runtime.observe()
    assert not runtime.perception.mark_delivered(runtime.new_id, holding=False,
        ball_in_storage=True, simulation_time_s=runtime.bridge.seconds, evidence=evidence)
    assert runtime.perception.get_object(runtime.new_id)["state"] == "RELEASED_UNVERIFIED"


def test_later_place_budget_is_shared_and_one_new_view_per_action():
    runtime, _, saved = pending_runtime()
    prepare_legal_view(runtime, "none")
    spent = 0.
    for expected in (1, 2):
        assert recovery_option(runtime)["available"] is True
        advertised = recovery_option(runtime)["next_intent"]["max_distance_cm"]
        assert 0 < advertised <= 16
        before = len(motion_calls(runtime))
        result = runtime.execute("place")
        assert not result["success"]
        assert len(result["evidence"]["reobservation"]["viewpoints"]) == 1
        option = recovery_option(runtime)
        assert option["budget"]["attempted_viewpoints"] == expected
        spent += advertised
        assert option["budget"]["travelled_cm"] == pytest.approx(spent)
        assert option["budget"]["commanded_distance_cm"] == pytest.approx(spent)
        assert option["budget"]["remaining_distance_cm"] == pytest.approx(32. - spent)
        assert len(motion_calls(runtime)) > before
    before = len(motion_calls(runtime))
    result = runtime.execute("place")
    assert not result["success"]
    assert len(motion_calls(runtime)) == before
    assert recovery_option(runtime)["reason"] == "release_reobservation_budget_exhausted"
    assert recovery_option(runtime)["budget"]["remaining_viewpoints"] == 0
    assert spent <= 32
    assert len(release_calls(runtime)) == 2
    assert runtime.perception.unverified_releases()[0]["release_observation"] == saved["release_observation"]


def test_failed_same_view_is_not_repeated_for_new_frame_and_other_direction_is_available():
    runtime, _, _ = pending_runtime()
    prepare_legal_view(runtime, "none")
    original = recovery_option(runtime)["next_intent"]
    runtime.front_clearance_cm = .1
    # The initial side turn is allowed; its fresh zero-clearance road reading
    # prevents any translation and must still consume that attempted view.
    result = runtime.execute("place")
    assert not result["success"]
    assert recovery_option(runtime)["budget"]["attempted_viewpoints"] == 1
    runtime.front_clearance_cm = 100.
    runtime.observe()
    option = recovery_option(runtime)
    assert option["available"] is True
    assert option["next_intent"]["view_key"] != original["view_key"]
    assert option["next_intent"]["direction_heading_deg"] != original["direction_heading_deg"]
    option_before = copy.deepcopy(option)
    runtime.observe()
    assert recovery_option(runtime)["next_intent"] == option_before["next_intent"]
    assert recovery_option(runtime)["budget"] == option_before["budget"]


@pytest.mark.parametrize("method", ["turn", "forward"])
def test_unknown_recovery_command_is_sent_once_then_latches_without_second_release(method):
    runtime, _, saved = pending_runtime()
    prepare_legal_view(runtime, "none")
    runtime.unknown_method = method
    before_calls, before_frames = len(runtime.calls), len(runtime.observations)
    with pytest.raises(TimeoutError) as caught:
        runtime.execute("place")
    sent = runtime.calls[before_calls:]
    assert sum(row["request"]["method"] == method for row in sent) == 1
    assert len([row for row in sent if row["terminal"] is None]) == 1
    assert caught.value.action_evidence["outcome_unknown"] is True
    assert runtime.motions[-1]["outcome_unknown"] is True
    assert runtime.motions[-1]["method"] == method
    # The unknown command receives one read-only reconciliation, never resend.
    unknown_pos = next(i for i, row in enumerate(sent) if row["terminal"] is None)
    assert [row["request"]["method"] for row in sent[unknown_pos + 1:]] == [
        "odometry", "local_road", "holding", "observe"]
    assert len(runtime.observations) > before_frames
    assert recovery_option(runtime)["available"] is False
    assert recovery_option(runtime)["reason"] == "release_recovery_execution_outcome_unknown"
    before_motions = len(motion_calls(runtime))
    for _ in range(2):
        runtime.observe()
        assert not runtime.execute("place")["success"]
    assert len(motion_calls(runtime)) == before_motions
    assert len(release_calls(runtime)) == 2
    assert runtime.perception.unverified_releases()[0]["release_observation"] == saved["release_observation"]


def test_no_observed_road_never_generates_recovery_or_sends_motion():
    runtime, _, _ = pending_runtime()
    prepare_legal_view(runtime)
    runtime.on_road = False
    runtime.observe()
    assert recovery_option(runtime)["available"] is False
    before = len(motion_calls(runtime))
    assert not runtime.execute("place")["success"]
    assert len(motion_calls(runtime)) == before


def test_options_are_read_only_and_current_return_values_do_not_mutate_pending_state():
    runtime, _, _ = pending_runtime()
    prepare_legal_view(runtime)
    saved = copy.deepcopy(runtime.perception.unverified_releases())
    ledger = copy.deepcopy(runtime.perception.action_evidence())
    progress = copy.deepcopy(runtime.actions._release_recovery_progress)
    before = len(runtime.calls)
    for _ in range(3):
        option = recovery_option(runtime)
        assert option["available"] is True
        option["required_delivered_ids"].clear()
        option["release_observation"]["command_ref"].clear()
        option["budget"]["remaining_distance_cm"] = 1000
    assert runtime.perception.unverified_releases() == saved
    assert runtime.perception.action_evidence() == ledger
    assert runtime.actions._release_recovery_progress == progress
    assert len(runtime.calls) == before


@pytest.mark.parametrize("fault", [
    "holding_true", "holding_unknown", "held_identity", "pending_grasp", "offroad",
    "stale_index", "stale_frame", "detection_frame", "road_tick", "sensor_tick",
    "no_direction", "nonfinite_position",
])
def test_current_public_state_must_authorize_each_new_view(fault):
    runtime, _, saved = pending_runtime()
    prepare_legal_view(runtime)
    assert recovery_option(runtime)["available"]
    snapshot = runtime.snapshot
    if fault == "holding_true":
        snapshot["holding"]["holding"] = True
    elif fault == "holding_unknown":
        snapshot["holding"]["holding"] = None
    elif fault == "held_identity":
        runtime.held_object_id = runtime.new_id
    elif fault == "pending_grasp":
        runtime.pending_grasp = {"object_id": runtime.new_id}
    elif fault == "offroad":
        snapshot["road"]["onRoad"] = False
    elif fault == "stale_index":
        snapshot["observation_index"] = saved["release_observation"]["command_ref"]["after_observation"]
    elif fault == "stale_frame":
        snapshot["observation"]["frameId"] = saved["release_observation"]["frame_id"]
    elif fault == "detection_frame":
        snapshot["perception"]["detections"][0]["frame_id"] = "obsolete-frame"
    elif fault == "road_tick":
        snapshot["road"]["tick"] -= 1
    elif fault == "sensor_tick":
        snapshot["observation"]["tick"] -= 1
    elif fault == "no_direction":
        snapshot["road"]["headingErrorDeg"] = None
    elif fault == "nonfinite_position":
        snapshot["odometry"]["rightCm"] = float("nan")
    before = len(runtime.calls)
    assert not recovery_option(runtime)["available"]
    assert len(runtime.calls) == before
    assert runtime.perception.unverified_releases()[0]["release_observation"] == saved["release_observation"]


@pytest.mark.parametrize("fault", [
    "missing_frame", "duplicate_frame", "invalid_frame", "missing_motion", "duplicate_motion",
    "unknown", "unsent", "wrong_method", "wrong_params", "request_id", "receipt_missing",
    "receipt_incomplete", "receipt_error", "receipt_rejected", "receipt_stopped",
    "holding_before", "holding_after", "frame_reused", "release_frame_mismatch",
    "stale_tick", "tick_mismatch", "actuation_drift",
])
def test_original_release_requires_registered_complete_known_command(fault, monkeypatch):
    runtime, _, saved = pending_runtime()
    prepare_legal_view(runtime)
    getter = runtime.roads.observation_records
    ref = saved["release_observation"]["command_ref"]
    window = getter(ref["before_observation"], ref["after_observation"])
    assert runtime.actions._release_command_verified(saved)
    motion = window["motions"][0]
    if fault == "missing_frame":
        window["observations"].pop()
    elif fault == "duplicate_frame":
        window["observations"].append(copy.deepcopy(window["observations"][-1]))
    elif fault == "invalid_frame":
        window["invalid_observation_indices"] = [ref["after_observation"]]
    elif fault == "missing_motion":
        window["motions"].clear()
    elif fault == "duplicate_motion":
        window["motions"].append(copy.deepcopy(motion))
    elif fault == "unknown":
        motion["outcome_unknown"] = True
    elif fault == "unsent":
        motion["motion_not_sent"] = True
    elif fault == "wrong_method":
        motion["method"] = "grab"
    elif fault == "wrong_params":
        motion["params"] = {"distanceCm": 1}
    elif fault == "request_id":
        motion["bridge_request_id"] += "-different"
    elif fault == "receipt_missing":
        motion["actuator_result"] = None
    elif fault == "receipt_incomplete":
        motion["actuator_result"]["completed"] = False
    elif fault == "receipt_error":
        motion["actuator_result"]["error"] = "fault"
    elif fault == "receipt_rejected":
        motion["actuator_result"]["accepted"] = False
    elif fault == "receipt_stopped":
        motion["actuator_result"]["stoppedBy"] = "front_clearance"
    elif fault == "holding_before":
        window["observations"][0]["holding"]["holding"] = False
    elif fault == "holding_after":
        window["observations"][-1]["holding"]["holding"] = True
    elif fault == "frame_reused":
        window["observations"][0]["observation"]["frameId"] = window["observations"][-1]["observation"]["frameId"]
    elif fault == "release_frame_mismatch":
        window["observations"][-1]["observation"]["frameId"] = "different-release-frame"
    elif fault == "stale_tick":
        tick = window["observations"][0]["odometry"]["tick"]
        for key in ("observation", "odometry", "road"):
            window["observations"][-1][key]["tick"] = tick
    elif fault == "tick_mismatch":
        window["observations"][-1]["road"]["tick"] -= 1
    elif fault == "actuation_drift":
        window["observations"][-1]["odometry"]["forwardCm"] += 1.
    monkeypatch.setattr(runtime.roads, "observation_records",
                        lambda first, last: copy.deepcopy(window)
                        if (first, last) == (ref["before_observation"], ref["after_observation"])
                        else getter(first, last))
    before = len(runtime.calls)
    option = recovery_option(runtime)
    assert not option["available"]
    assert option["reason"] == "release_recovery_command_unverified"
    assert len(runtime.calls) == before
    assert runtime.perception.unverified_releases()[0]["release_observation"] == saved["release_observation"]


def test_already_delivered_identity_cannot_count_again_across_later_place_and_done():
    runtime, _, _ = pending_runtime()
    prepare_legal_view(runtime)
    assert runtime.execute("place")["success"]
    before = copy.deepcopy(runtime.perception.action_evidence())
    runtime.witness_mode = "old_only"
    for _ in range(3):
        runtime.observe()
        assert not runtime.execute("place")["success"]
    assert runtime.perception.action_evidence() == before
    assert len(release_calls(runtime)) == 2
    deliveries = [event["object_id"] for event in before if event["action"] == "place"]
    assert deliveries == [runtime.old_id, runtime.new_id]
    # A genuine completed task remains complete; repeating an old witness did
    # not increase its count. Strict done also refuses a nonempty gripper.
    runtime.holding = True
    assert runtime.execute("done")["success"] is False
    runtime.holding = False
    assert runtime.execute("done")["success"] is True


def test_explicit_unknown_observed_failure_also_stops_without_recovery_motion():
    runtime, _, saved = pending_runtime()
    prepare_legal_view(runtime, "none")
    runtime.unknown_method = "turn"
    runtime.unknown_error = ObservedMotionFailure("synthetic_unknown_motion", {"outcome_unknown": True})
    before = len(motion_calls(runtime))
    with pytest.raises(RuntimeError) as caught:
        runtime.execute("place")
    assert caught.value.__cause__ is runtime.unknown_error
    assert caught.value.action_evidence["outcome_unknown"] is True
    assert len(motion_calls(runtime)) == before + 1
    assert runtime.actions._release_recovery_progress[runtime.new_id]["outcome_unknown"]
    assert not recovery_option(runtime)["available"]
    assert len(release_calls(runtime)) == 2
    assert runtime.perception.unverified_releases()[0]["release_observation"] == saved["release_observation"]


@pytest.mark.parametrize("choice", ["place", "look_around"])
def test_real_runtime_state_exposes_pending_view_budget_to_native_without_choosing_action(
        choice, monkeypatch, tmp_path):
    from autonomous_brain import chatgpt_transport as transport
    from autonomous_brain.llm import LLMClient, RELEASE_RECOVERY_PROMPT
    from autonomous_brain.run import Runtime, compact_action_result
    from test_brain_pick_entry_native_contract import synthetic_reply

    runtime, _, saved = pending_runtime()
    prepare_legal_view(runtime, "new_only")
    assert not runtime.execute("place")["success"]
    runtime.recent = [compact_action_result(row["round"], row["action"], row["result"],
        row["result"]["evidence"]["final_observation"]) for row in runtime.rounds]
    before_pending = copy.deepcopy(runtime.perception.unverified_releases())
    state = Runtime.state(runtime)
    current = state["release_recovery"]["pending"][0]
    assert current["object_id"] == runtime.new_id
    assert current["available"] is True and current["current_verification_available"] is False
    assert "previously_delivered_objects_not_reobserved" in current["missing_evidence"]
    assert current["missing_delivered_ids"] == [runtime.old_id]
    assert current["release_observation"] == {
        key: saved["release_observation"][key]
        for key in ("frame_id", "simulation_time_s", "command_ref")}
    assert current["budget"]["attempted_viewpoints"] == 1
    assert current["budget"]["remaining_viewpoints"] == 1
    assert current["budget"]["remaining_distance_cm"] == pytest.approx(16)
    assert len(current["attempted_views"]) == 1
    assert current["attempted_views"][0]["status"] == "bounded_viewpoints_without_unique_witness"
    assert state["completion"]["ready_for_done"] is False
    assert state["robot"]["holding"] is False
    action = {"action": choice, "params": {}}
    sent = []
    before_calls = len(runtime.calls)
    original_state = copy.deepcopy(state)
    monkeypatch.setenv("LLM_TRANSPORT", transport.TRANSPORT)
    monkeypatch.setenv("LLM_MODEL", transport.MODEL)

    def invoke(request, timeout):
        sent.append(copy.deepcopy(request))
        return synthetic_reply(request, action)

    with patch.object(transport, "invoke", side_effect=invoke):
        with LLMClient(tmp_path / "native.jsonl") as client:
            assert client.decide(state) == action
    assert len(sent) == 1 and len(runtime.calls) == before_calls
    assert state == original_state
    assert runtime.perception.unverified_releases() == before_pending
    assert RELEASE_RECOVERY_PROMPT in sent[0]["messages"][0]["content"]
    published = json.loads(sent[0]["messages"][1]["content"])
    assert published["release_recovery"] == state["release_recovery"]
    assert sent[0]["model"] == transport.MODEL and sent[0]["thinking"] == {"type": "low"}


def leave_road_then_return(runtime, *, unknown=False):
    """Public feedback: first four-centimetre probe leaves the observed road."""
    original = runtime.call
    departed = False

    def call(method, params):
        nonlocal departed
        if method == "forward" and not departed:
            departed = True
            runtime.on_road = False
        elif method == "backward":
            runtime.on_road = True
            if unknown:
                runtime.unknown_method = "backward"
        return original(method, params)

    runtime.bridge.call = call


def test_unknown_return_after_offroad_probe_latches_and_never_sends_another_motion():
    runtime, _, saved = pending_runtime()
    prepare_legal_view(runtime, "none")
    leave_road_then_return(runtime, unknown=True)
    before = len(motion_calls(runtime))
    with pytest.raises((RuntimeError, TimeoutError)) as caught:
        runtime.execute("place")
    sent = motion_calls(runtime)[before:]
    assert [row["request"]["method"] for row in sent] == ["turn", "forward", "backward"]
    assert sent[-1]["terminal"] is None
    assert caught.value.action_evidence["outcome_unknown"] is True
    assert runtime.actions._release_recovery_progress[runtime.new_id]["outcome_unknown"] is True
    option = recovery_option(runtime)
    assert option["available"] is False
    assert option["budget"]["commanded_distance_cm"] == pytest.approx(8)
    assert option["budget"]["travelled_cm"] == pytest.approx(8)
    count = len(motion_calls(runtime))
    runtime.observe()
    assert not runtime.execute("place")["success"]
    assert len(motion_calls(runtime)) == count
    assert len(release_calls(runtime)) == 2
    assert runtime.perception.unverified_releases()[0]["release_observation"] == saved["release_observation"]


def test_known_return_distance_is_charged_to_the_same_cross_round_budget():
    runtime, _, saved = pending_runtime()
    prepare_legal_view(runtime, "none")
    leave_road_then_return(runtime)
    before = len(motion_calls(runtime))
    result = runtime.execute("place")
    assert not result["success"]
    sent = motion_calls(runtime)[before:]
    assert [row["request"]["method"] for row in sent] == ["turn", "forward", "backward"]
    option = recovery_option(runtime)
    assert option["available"] is True
    assert option["budget"]["commanded_distance_cm"] == pytest.approx(8)
    assert option["budget"]["travelled_cm"] == pytest.approx(8)
    assert option["budget"]["remaining_distance_cm"] == pytest.approx(24)
    advertised = option["next_intent"]["max_distance_cm"]
    assert 0 < advertised <= 16
    assert not runtime.execute("place")["success"]
    option = recovery_option(runtime)
    assert option["budget"]["attempted_viewpoints"] == 2
    assert option["budget"]["commanded_distance_cm"] == pytest.approx(8 + advertised)
    assert option["budget"]["travelled_cm"] == pytest.approx(8 + advertised)
    assert option["budget"]["travelled_cm"] <= 32
    assert option["available"] is False
    assert len(release_calls(runtime)) == 2
    assert runtime.perception.unverified_releases()[0]["release_observation"] == saved["release_observation"]
