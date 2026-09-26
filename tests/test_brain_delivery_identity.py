"""Delivery identity regressions using real Perception and public bbox fixtures.

Only explicit synthetic observations drive the fake actuator. There is no
simulator, scene file, live-run artifact, model request or hidden geometry.
"""

import copy
from types import SimpleNamespace

import pytest

from test_brain_perception import CAMERA, ball, observe, grasp_evidence
from autonomous_brain.actions import Actions
from autonomous_brain.perception import Perception


def storage_bbox(*, close):
    return {"category": "storage-zone", "source": "storage-ground-pixels", "confidence": 1,
            "bbox": {"x": 260, "y": 390, "w": 120, "h": 80} if close else
                    {"x": 240, "y": 260, "w": 160, "h": 90}}


class DeliveryRuntime:
    """Real perception/action integration with a declared release/retreat trace."""

    def __init__(self, *, nearby_reds=False):
        self.perception = Perception(CAMERA)
        for frame, forward in enumerate((0, 16, 32), 1):
            observe(self.perception, frame, forward)
        self.original_id = self.perception.objects()[0]["id"]
        assert self.perception.confirmed(self.original_id) is not None
        assert self.perception.mark_picked(self.original_id, holding=True,
            original_position_absent=True, simulation_time_s=.35,
            evidence=grasp_evidence(self.perception, self.original_id, time=.35))
        self.frame, self.nearby_reds = 3, nearby_reds
        self.preexisting_ids = set()
        if nearby_reds:
            self.frame += 1
            converted = observe(self.perception, self.frame, 125,
                                items=[ball(45, bearing=-7), ball(45, bearing=7)])
            self.preexisting_ids = {d["track_id"] for d in converted["detections"]}
            assert len(self.preexisting_ids) == 2
        self.forward, self.phase, self.holding = 150, "before_release", True
        self.round, self.pending_grasp, self.held_object_id = 1, None, self.original_id
        self.bridge = SimpleNamespace(seconds=(self.frame + 1) / 10, max_seconds=1200, call=self.call)
        self.roads = SimpleNamespace(nodes=[{"sensor_fixture": True}], unexplored=lambda: 0)
        self.motions, self.records = [], []
        self.motion_log = SimpleNamespace(write=self.records.append)
        self.observe()

    def public_detections(self):
        if self.phase == "before_release":
            return [storage_bbox(close=True)]
        if self.phase == "released":
            # This raw 20cm view is below the unchanged WM admission window.
            return [ball(20), storage_bbox(close=True)]
        items = [ball(45), storage_bbox(close=False)]
        if self.nearby_reds:
            items.extend([ball(45, bearing=-7), ball(45, bearing=7)])
        return items

    def call(self, method, params):
        self.motions.append((method, copy.deepcopy(params)))
        self.bridge.seconds += .1
        if method == "release":
            self.holding, self.phase = False, "released"
            return {"completed": True}
        assert method == "backward" and params == {"distanceCm": 25, "speed": 30}
        self.forward -= 25
        self.phase = "after_retreat"
        return {"accepted": True, "stoppedBy": "max_distance", "distanceCm": 25}

    def observe(self, *, motion=None):
        self.frame += 1
        converted = observe(self.perception, self.frame, self.forward,
                            items=self.public_detections(), time=self.bridge.seconds)
        self.snapshot = {"observation_index": self.frame,
                         "observation": converted["raw_observation"],
                         "odometry": converted["odometry"],
                         "road": {"onRoad": True}, "holding": {"holding": self.holding},
                         "perception": converted}
        return self.snapshot

    def release_observations_without_delivery_mark(self):
        self.call("release", {})
        self.observe()
        release_frame = self.snapshot["observation"]["frameId"]
        self.release_observation_time = self.bridge.seconds
        self.call("backward", {"distanceCm": 25, "speed": 30})
        self.observe()
        return release_frame

    def current_release_witness(self):
        return next(d for d in self.snapshot["perception"]["detections"]
                    if d["category"] == "red-ball" and d["track_id"] not in self.preexisting_ids)


def red_rows(runtime):
    return [row for row in runtime.perception.objects() if row["category"] == "red-ball"]


def current_delivery_evidence(runtime, release_frame, witness=None):
    witness = witness or runtime.current_release_witness()
    zone = next(d for d in runtime.snapshot["perception"]["detections"] if d["category"] == "storage-zone")
    return {"holding": False, "candidate_witnesses": 1, "post_observation": runtime.frame,
            "release_observation": {"frame_id": release_frame,
                                    "simulation_time_s": runtime.release_observation_time,
                                    "preexisting_ball_ids": sorted(runtime.preexisting_ids)},
            "placement": {"ball_track_id": witness["track_id"], "ball_category": witness["category"],
                          "ball_position_m": copy.deepcopy(witness["position_m"]),
                          "ball_bbox": copy.deepcopy(witness["bbox"]),
                          "storage_bbox": copy.deepcopy(zone["bbox"]),
                          "frame_id": runtime.snapshot["observation"]["frameId"]}}


def test_verified_place_leaves_one_canonical_identity_for_its_release_witness():
    runtime = DeliveryRuntime()
    outcome = Actions(runtime).place()
    assert outcome["success"] is True
    assert runtime.motions == [("release", {}), ("backward", {"distanceCm": 25, "speed": 30})]
    witness = runtime.current_release_witness()
    assert witness["fed_to_world_model"] is True
    assert witness["track_id"] != runtime.original_id, "The post-release sensor frame created a new identity"
    assert runtime.perception.get_object(runtime.original_id)["state"] == "DELIVERED"
    history_ids = {row["object_id"] for row in runtime.perception.timeline()}
    assert {runtime.original_id, witness["track_id"]}.issubset(history_ids), (
        "Resolving the release identity must preserve both raw observation timelines")
    pending = [row["id"] for row in red_rows(runtime) if row["state"] != "DELIVERED"]
    assert pending == [], "A verified release witness must not remain a separate undelivered task object"


@pytest.mark.parametrize("later_time", [1, 100], ids=["next_observation", "after_decay"])
def test_reobserving_delivered_ball_cannot_leave_a_duplicate_blocking_done(later_time):
    runtime = DeliveryRuntime()
    assert Actions(runtime).place()["success"] is True
    runtime.bridge.seconds = later_time
    runtime.observe()
    witness = runtime.current_release_witness()
    assert witness["known_delivered_object_id"] == runtime.original_id
    assert witness["fed_to_world_model"] is False
    outcome = Actions(runtime).done()
    assert outcome["success"] is True, outcome


def test_delivery_does_not_consume_two_nearby_preexisting_red_identities():
    runtime = DeliveryRuntime(nearby_reds=True)
    before = {oid: runtime.perception.get_object(oid) for oid in runtime.preexisting_ids}
    assert Actions(runtime).place()["success"] is True
    witness = runtime.current_release_witness()
    assert witness["track_id"] not in runtime.preexisting_ids
    for oid, previous in before.items():
        current = runtime.perception.get_object(oid)
        assert current is not None
        assert current["state"] != "DELIVERED"
        assert current["position_m"] == previous["position_m"]
        # Both legitimate objects are within the existing delivery exclusion
        # radius; proximity must not make them aliases of the held identity.
        p, q = current["position_m"], witness["position_m"]
        assert 0 < ((p["x"] - q["x"]) ** 2 + (p["z"] - q["z"]) ** 2) ** .5 < .15
    assert set(runtime.preexisting_ids).issubset(Actions(runtime).done()["evidence"]["pending_objects"])


def test_stale_release_frame_cannot_authorize_delivery_of_a_new_witness_track():
    runtime = DeliveryRuntime()
    release_frame = runtime.release_observations_without_delivery_mark()
    witness = runtime.current_release_witness()
    assert release_frame != runtime.snapshot["observation"]["frameId"]
    assert runtime.perception.get_object(witness["track_id"])["state"] == "TENTATIVE"
    evidence = current_delivery_evidence(runtime, release_frame)
    evidence["placement"]["frame_id"] = release_frame
    marked = runtime.perception.mark_delivered(runtime.original_id, holding=False, ball_in_storage=True,
        simulation_time_s=runtime.bridge.seconds, evidence=evidence)
    assert marked is False, "A witness from the retreat frame cannot be attributed to the earlier release frame"
    assert runtime.perception.get_object(runtime.original_id)["state"] == "HELD"


@pytest.mark.parametrize("mismatch", ["track_id", "category", "position", "bbox", "preexisting_id", "release_time"])
def test_delivery_binding_rejects_mismatched_identity_evidence_without_mutation(mismatch):
    runtime = DeliveryRuntime()
    release_frame = runtime.release_observations_without_delivery_mark()
    evidence = current_delivery_evidence(runtime, release_frame)
    if mismatch == "track_id":
        evidence["placement"]["ball_track_id"] = "not-an-observed-track"
    elif mismatch == "category":
        evidence["placement"]["ball_category"] = "blue-ball"
    elif mismatch == "position":
        evidence["placement"]["ball_position_m"]["x"] += .01
    elif mismatch == "bbox":
        evidence["placement"]["ball_bbox"]["x"] += 1
    elif mismatch == "preexisting_id":
        evidence["release_observation"]["preexisting_ball_ids"] = [evidence["placement"]["ball_track_id"]]
    else:
        evidence["release_observation"]["simulation_time_s"] += .1
    before = copy.deepcopy(runtime.perception.timeline())
    assert runtime.perception.mark_delivered(runtime.original_id, holding=False, ball_in_storage=True,
        simulation_time_s=runtime.bridge.seconds, evidence=evidence) is False
    assert runtime.perception.timeline() == before
    assert runtime.perception.get_object(runtime.original_id)["state"] == "HELD"


def test_an_older_nearby_track_cannot_bind_even_if_preexisting_list_omits_it():
    runtime = DeliveryRuntime(nearby_reds=True)
    release_frame = runtime.release_observations_without_delivery_mark()
    witness = next(d for d in runtime.snapshot["perception"]["detections"]
                   if d["track_id"] in runtime.preexisting_ids)
    evidence = current_delivery_evidence(runtime, release_frame, witness)
    evidence["release_observation"]["preexisting_ball_ids"] = []
    assert runtime.perception.mark_delivered(runtime.original_id, holding=False, ball_in_storage=True,
        simulation_time_s=runtime.bridge.seconds, evidence=evidence) is False
    assert runtime.perception.get_object(runtime.original_id)["state"] == "HELD"
    assert all(runtime.perception.get_object(oid)["state"] != "DELIVERED" for oid in runtime.preexisting_ids)


def test_pre_release_track_at_the_same_clock_time_is_not_a_new_release_identity():
    runtime = DeliveryRuntime()
    runtime.phase, runtime.forward = "after_retreat", 125
    runtime.observe()
    older_id = runtime.current_release_witness()["track_id"]
    runtime.phase, runtime.forward = "before_release", 150
    runtime.observe()
    original_call = runtime.call

    def release_without_advancing_clock(method, params):
        previous_time = runtime.bridge.seconds
        result = original_call(method, params)
        if method == "release":
            runtime.bridge.seconds = previous_time
        return result

    runtime.call = release_without_advancing_clock
    release_frame = runtime.release_observations_without_delivery_mark()
    witness = runtime.current_release_witness()
    assert witness["track_id"] == older_id
    birth = next(row for row in runtime.perception.timeline() if row["object_id"] == older_id)
    assert birth["first_seen_s"] == runtime.release_observation_time
    evidence = current_delivery_evidence(runtime, release_frame)
    assert evidence["release_observation"]["preexisting_ball_ids"] == []
    assert runtime.perception.mark_delivered(runtime.original_id, holding=False, ball_in_storage=True,
        simulation_time_s=runtime.bridge.seconds, evidence=evidence) is False


def test_ambiguous_new_post_release_balls_cannot_authorize_identity_binding():
    runtime = DeliveryRuntime()
    # Three simultaneous new detections are public, but none has evidence
    # distinguishing it as the object just released from the gripper.
    runtime.nearby_reds = True
    outcome = Actions(runtime).place()
    assert outcome["success"] is False
    assert outcome["evidence"]["candidate_witnesses"] == 3
    assert runtime.perception.get_object(runtime.original_id)["state"] == "RELEASED_UNVERIFIED"
    assert not any(row["state"] == "DELIVERED" for row in red_rows(runtime))


def test_current_ambiguous_sensor_witnesses_override_a_claimed_unique_count():
    runtime = DeliveryRuntime()
    runtime.nearby_reds = True
    release_frame = runtime.release_observations_without_delivery_mark()
    evidence = current_delivery_evidence(runtime, release_frame)
    assert evidence["candidate_witnesses"] == 1
    assert runtime.perception.mark_delivered(runtime.original_id, holding=False, ball_in_storage=True,
        simulation_time_s=runtime.bridge.seconds, evidence=evidence) is False
    assert runtime.perception.get_object(runtime.original_id)["state"] == "HELD"


def test_alias_keeps_raw_timeline_and_cannot_be_bound_again():
    runtime = DeliveryRuntime()
    original_before = copy.deepcopy(runtime.perception.timeline()[0])
    outcome = Actions(runtime).place()
    assert outcome["success"] is True
    witness_id = outcome["evidence"]["placement"]["ball_track_id"]
    timeline = {row["object_id"]: row for row in runtime.perception.timeline()}
    assert timeline[witness_id]["alias_of"] == runtime.original_id
    assert timeline[witness_id]["first_seen_frame_id"] == outcome["evidence"]["placement"]["frame_id"]
    assert timeline[runtime.original_id]["accepted_hit_poses"] == original_before["accepted_hit_poses"]
    assert runtime.perception.get_object(witness_id)["alias_of"] == runtime.original_id
    assert witness_id not in {row["id"] for row in runtime.perception.objects()}
    recorded = copy.deepcopy(runtime.perception.action_evidence())
    assert recorded[-1]["delivery_alias"]["witness_id"] == witness_id
    assert runtime.perception.mark_delivered(runtime.original_id, holding=False, ball_in_storage=True,
        simulation_time_s=runtime.bridge.seconds, evidence=outcome["evidence"]) is False
    assert runtime.perception.action_evidence() == recorded


class NearFieldDeliveryRuntime(DeliveryRuntime):
    def public_detections(self):
        items = super().public_detections()
        if self.phase == "after_retreat":
            items[0] = ball(35)
        return items


@pytest.mark.parametrize("nearby_reds", [False, True], ids=["single_ball", "two_other_known_reds"])
def test_near_field_unique_pixel_witness_delivers_without_creating_an_alias(nearby_reds):
    runtime = NearFieldDeliveryRuntime(nearby_reds=nearby_reds)
    before = {oid: runtime.perception.get_object(oid) for oid in runtime.preexisting_ids}
    outcome = Actions(runtime).place()
    witness = runtime.current_release_witness()
    assert witness["raw_distance_cm"] == 35
    assert witness["fed_to_world_model"] is False
    assert witness["track_id"] is None
    assert outcome["evidence"]["candidate_witnesses"] == 1
    assert outcome["success"] is True, outcome
    assert runtime.perception.get_object(runtime.original_id)["state"] == "DELIVERED"
    assert {row["id"] for row in red_rows(runtime)} == {runtime.original_id, *runtime.preexisting_ids}
    assert all("alias_of" not in row for row in runtime.perception.timeline())
    assert runtime.perception.action_evidence()[-1].get("delivery_alias") is None
    for oid, previous in before.items():
        current = runtime.perception.get_object(oid)
        assert current["state"] != "DELIVERED"
        assert current["position_m"] == previous["position_m"]
        p, q = current["position_m"], witness["position_m"]
        assert 0 < ((p["x"] - q["x"]) ** 2 + (p["z"] - q["z"]) ** 2) ** .5 < .15
    done = Actions(runtime).done()
    assert done["success"] is not nearby_reds
    if nearby_reds:
        assert set(done["evidence"]["pending_objects"]) == runtime.preexisting_ids


@pytest.mark.parametrize("mismatch", ["frame", "release_time", "bbox", "position"])
def test_untracked_witness_still_requires_authentic_current_release_evidence(mismatch):
    runtime = NearFieldDeliveryRuntime()
    release_frame = runtime.release_observations_without_delivery_mark()
    evidence = current_delivery_evidence(runtime, release_frame)
    assert evidence["placement"]["ball_track_id"] is None
    if mismatch == "frame":
        evidence["placement"]["frame_id"] = release_frame
    elif mismatch == "release_time":
        evidence["release_observation"]["simulation_time_s"] += .1
    elif mismatch == "bbox":
        evidence["placement"]["ball_bbox"]["x"] += 1
    else:
        evidence["placement"]["ball_position_m"]["x"] += .01
    before = copy.deepcopy(runtime.perception.timeline())
    assert runtime.perception.mark_delivered(runtime.original_id, holding=False, ball_in_storage=True,
        simulation_time_s=runtime.bridge.seconds, evidence=evidence) is False
    assert runtime.perception.timeline() == before
    assert runtime.perception.get_object(runtime.original_id)["state"] == "HELD"


def test_tracked_witness_cannot_bypass_identity_checks_by_claiming_no_track():
    runtime = DeliveryRuntime()
    release_frame = runtime.release_observations_without_delivery_mark()
    evidence = current_delivery_evidence(runtime, release_frame)
    assert evidence["placement"]["ball_track_id"] is not None
    evidence["placement"]["ball_track_id"] = None
    assert runtime.perception.mark_delivered(runtime.original_id, holding=False, ball_in_storage=True,
        simulation_time_s=runtime.bridge.seconds, evidence=evidence) is False
    assert runtime.perception.get_object(runtime.original_id)["state"] == "HELD"


def test_two_untracked_near_field_witnesses_cannot_be_treated_as_one_none_identity():
    runtime = NearFieldDeliveryRuntime()
    release_frame = runtime.release_observations_without_delivery_mark()
    runtime.public_detections = lambda: [ball(35, bearing=-3), ball(35, bearing=3), storage_bbox(close=False)]
    runtime.observe()
    balls = [d for d in runtime.snapshot["perception"]["detections"] if d["category"] == "red-ball"]
    assert len(balls) == 2 and all(d["track_id"] is None for d in balls)
    evidence = current_delivery_evidence(runtime, release_frame, balls[0])
    assert runtime.perception.mark_delivered(runtime.original_id, holding=False, ball_in_storage=True,
        simulation_time_s=runtime.bridge.seconds, evidence=evidence) is False
    assert runtime.perception.get_object(runtime.original_id)["state"] == "HELD"
