"""Completion obligations from real public-observation histories, offline only."""

import copy
from types import SimpleNamespace

import pytest

from test_brain_perception import CAMERA, ball, observe
from autonomous_brain import actions as action_module
from autonomous_brain.actions import Actions
from autonomous_brain.perception import Perception


def runtime_for(perception, *, holding=False, nodes=True, unexplored=0):
    current = perception.last_evidence
    return SimpleNamespace(
        perception=perception,
        snapshot={"observation_index": current["round"],
                  "observation": copy.deepcopy(current["raw_observation"]),
                  "odometry": copy.deepcopy(current["odometry"]),
                  "holding": {"holding": holding}},
        roads=SimpleNamespace(nodes=[{}] if nodes else [], unexplored=lambda: unexplored),
    )


def done(perception, **kwargs):
    return Actions(runtime_for(perception, **kwargs)).done()


def retired_hypothesis():
    perception = Perception(CAMERA)
    initial = observe(perception, 1, items=[ball(80)])
    object_id = initial["detections"][0]["track_id"]
    observe(perception, 2, time=20, items=[])
    assert perception.get_object(object_id)["state"] == "LOST"
    assert perception.wm.get_archived(object_id) is not None
    assert perception.wm.get_scene() == []
    return perception, object_id, initial


def confirmed_red():
    perception = Perception(CAMERA)
    for frame, forward in enumerate((0, 16, 32), 1):
        observe(perception, frame, forward)
    object_id = perception.objects()[0]["id"]
    assert perception.confirmed(object_id) is not None
    return perception, object_id


def expected_retirement(perception, object_id):
    archived = perception.wm.get_archived(object_id)
    return {"reason": "archived_without_confirmation",
            "first_seen_s": .1, "last_seen_s": .1, "last_updated_s": 20,
            "first_seen_frame_id": "1", "last_frame_id": "1",
            "hit_count": 1, "confidence": archived.confidence,
            "confirmed_s": None, "archived": True}


def raw_state(perception):
    """Audit raw tracking/lifecycle storage, not just annotated query output."""
    return copy.deepcopy({
        "history": perception._history,
        "times": perception._times,
        "lifecycle": perception._lifecycle,
        "accepted_poses": perception._accepted_poses,
        "delivered_positions": perception._delivered_positions,
        "delivery_aliases": perception._delivery_aliases,
        "action_evidence": perception.action_evidence(),
        "last_evidence": perception.last_evidence,
        "active_tracks": [vars(track) for track in perception.wm.get_scene()],
        "archived_tracks": {row["object_id"]: vars(track)
                            for row in perception.timeline()
                            if (track := perception.wm.get_archived(row["object_id"])) is not None},
        "wm_last_update_time": perception.wm.last_update_time,
    })


def test_never_confirmed_archived_hypothesis_retires_without_erasing_history():
    perception, object_id, original_observation = retired_hypothesis()
    before = raw_state(perception)
    row = perception.get_object(object_id)
    retirement = expected_retirement(perception, object_id)
    assert row["state"] == "LOST"
    assert row["ever_confirmed"] is False
    assert row["completion_classification"] == "retired_unconfirmed_hypothesis"
    assert row["retirement_evidence"] == retirement
    assert object_id in {item["id"] for item in perception.objects()}
    timeline = next(item for item in perception.timeline() if item["object_id"] == object_id)
    assert timeline["first_seen_s"] == .1
    assert timeline["confirmed_s"] is None
    assert timeline["accepted_hit_poses"][0]["frame_id"] == "1"
    assert original_observation["raw_observation"]["detections"] == [ball(80)]
    outcome = done(perception)
    assert outcome["success"] is True, outcome
    assert outcome["evidence"]["pending_objects"] == []
    assert outcome["evidence"]["retired_unconfirmed_hypotheses"] == [
        {"object_id": object_id, **retirement}]
    assert raw_state(perception) == before


@pytest.mark.parametrize("state, ever_confirmed", [
    ("TENTATIVE", False), ("STALE", False), ("CONFIRMED", True), ("STALE", True),
], ids=["tentative", "unconfirmed_stale", "confirmed", "previously_confirmed_stale"])
def test_every_active_red_identity_remains_a_completion_obligation(state, ever_confirmed):
    if ever_confirmed:
        perception, object_id = confirmed_red()
        next_frame, elapsed = 4, 2.3
    else:
        perception = Perception(CAMERA)
        observe(perception, 1)
        object_id = perception.objects()[0]["id"]
        next_frame, elapsed = 2, 2.1
    if state == "STALE":
        observe(perception, next_frame, items=[], time=elapsed)
    row = perception.get_object(object_id)
    assert row["state"] == state
    assert object_id in {track.obj_id for track in perception.wm.get_scene()}
    assert row["ever_confirmed"] is ever_confirmed
    assert row["completion_classification"] == "pending"
    assert "retirement_evidence" not in row
    outcome = done(perception)
    assert outcome["success"] is False
    assert outcome["evidence"]["pending_objects"] == [object_id]
    assert outcome["evidence"]["retired_unconfirmed_hypotheses"] == []


def test_ever_confirmed_lost_red_remains_pending_after_real_archive_decay():
    perception, object_id = confirmed_red()
    observe(perception, 4, items=[], time=20)
    row = perception.get_object(object_id)
    assert row["state"] == "LOST"
    assert perception.wm.get_archived(object_id) is not None
    assert row["ever_confirmed"] is True
    assert row["completion_classification"] == "pending"
    assert "retirement_evidence" not in row
    outcome = done(perception)
    assert outcome["success"] is False
    assert outcome["evidence"]["pending_objects"] == [object_id]
    assert outcome["evidence"]["retired_unconfirmed_hypotheses"] == []


@pytest.mark.parametrize("unverified_release", [False, True], ids=["held", "released_unverified"])
def test_manipulated_but_not_delivered_identity_stays_pending(unverified_release):
    perception, object_id = confirmed_red()
    observe(perception, 4, items=[], time=.4)
    assert perception.mark_picked(object_id, holding=True, original_position_absent=True,
        simulation_time_s=.4, evidence={"holding": True, "post_observation": 4})
    if unverified_release:
        observe(perception, 5, items=[], time=.5)
        assert perception.mark_release_unverified(object_id, simulation_time_s=.5,
            evidence={"holding": False, "post_observation": 5})
    row = perception.get_object(object_id)
    assert row["state"] == ("RELEASED_UNVERIFIED" if unverified_release else "HELD")
    assert perception.wm.get_archived(object_id) is not None
    assert row["ever_confirmed"] is True
    assert row["completion_classification"] == "pending"
    # Even an empty-gripper snapshot cannot erase a retained HELD obligation.
    outcome = done(perception, holding=False)
    assert outcome["success"] is False
    assert outcome["evidence"]["pending_objects"] == [object_id]
    assert outcome["evidence"]["retired_unconfirmed_hypotheses"] == []


@pytest.mark.parametrize("bearing", [0, 5], ids=["same_observed_position", "nearby_observed_position"])
def test_new_observation_near_retired_hypothesis_creates_active_pending_identity(bearing):
    perception, old_id, _ = retired_hypothesis()
    old_track = copy.deepcopy(vars(perception.wm.get_archived(old_id)))
    evidence = observe(perception, 3, time=20.1, items=[ball(80, bearing=bearing)])
    detection = evidence["detections"][0]
    new_id = detection["track_id"]
    assert detection["fed_to_world_model"] is True
    assert not detection.get("known_delivered_object_id")
    assert new_id is not None and new_id != old_id
    assert vars(perception.wm.get_archived(old_id)) == old_track
    rows = {row["id"]: row for row in perception.objects()}
    assert set(rows) == {old_id, new_id}
    assert rows[old_id]["state"] == "LOST"
    assert rows[old_id]["completion_classification"] == "retired_unconfirmed_hypothesis"
    assert rows[new_id]["state"] == "TENTATIVE"
    assert rows[new_id]["completion_classification"] == "pending"
    assert rows[new_id]["ever_confirmed"] is False
    outcome = done(perception)
    assert outcome["success"] is False
    assert outcome["evidence"]["pending_objects"] == [new_id]
    assert [entry["object_id"] for entry in outcome["evidence"]["retired_unconfirmed_hypotheses"]] == [old_id]


def test_sensor_verified_delivery_allows_done_with_only_archived_unconfirmed_hypothesis():
    perception, retired_id, _ = retired_hypothesis()
    archived_before = copy.deepcopy(vars(perception.wm.get_archived(retired_id)))
    for frame, forward in enumerate((0, 16, 32), 3):
        observed = observe(perception, frame, forward, right=200,
                           time=20 + (frame - 2) / 10)
    object_id = observed["detections"][0]["track_id"]
    assert object_id != retired_id and perception.confirmed(object_id) is not None
    observe(perception, 6, 32, right=200, time=20.4, items=[])
    assert perception.mark_picked(object_id, holding=True, original_position_absent=True,
        simulation_time_s=20.4, evidence={"holding": True, "post_observation": 6})
    preexisting = [row["id"] for row in perception.objects()
                   if row["category"] == "red-ball" and row["id"] != object_id]
    zone = {"category": "storage-zone", "source": "storage-ground-pixels", "confidence": 1,
            "bbox": {"x": 240, "y": 230, "w": 160, "h": 100}}
    released = observe(perception, 7, right=200, time=21, items=[ball(60), zone])
    witness, storage = released["detections"]
    assert witness["track_id"] not in {retired_id, object_id}
    evidence = {"holding": False, "candidate_witnesses": 1,
        "release_observation": {"frame_id": "7", "simulation_time_s": 21,
                                "preexisting_ball_ids": preexisting},
        "placement": {"ball_track_id": witness["track_id"], "ball_category": "red-ball",
                      "ball_position_m": copy.deepcopy(witness["position_m"]), "frame_id": "7",
                      "ball_bbox": copy.deepcopy(witness["bbox"]),
                      "storage_bbox": copy.deepcopy(storage["bbox"])}}
    assert perception.mark_delivered(object_id, holding=False, ball_in_storage=True,
        simulation_time_s=21, evidence=evidence)
    rows = {row["id"]: row for row in perception.objects() if row["category"] == "red-ball"}
    assert set(rows) == {retired_id, object_id}
    assert rows[object_id]["state"] == "DELIVERED"
    assert rows[object_id]["completion_classification"] == "delivered"
    assert rows[object_id]["ever_confirmed"] is True
    assert rows[retired_id]["state"] == "LOST"
    assert vars(perception.wm.get_archived(retired_id)) == archived_before
    outcome = done(perception)
    assert outcome["success"] is True, outcome
    assert outcome["evidence"]["pending_objects"] == []
    assert [row["object_id"] for row in outcome["evidence"]["retired_unconfirmed_hypotheses"]] == [retired_id]
    assert {retired_id, object_id, witness["track_id"]}.issubset(
        {row["object_id"] for row in perception.timeline()})


def test_completion_queries_are_repeatable_read_only_and_return_detached_evidence():
    perception, object_id, _ = retired_hypothesis()
    before = raw_state(perception)
    expected = action_module.completion_evidence(perception.objects())
    for _ in range(3):
        rows = perception.objects()
        assert action_module.completion_evidence(rows) == expected
        assert done(perception)["success"] is True
        assert raw_state(perception) == before
    rows[0]["retirement_evidence"]["last_seen_s"] = -1
    copied = action_module.completion_evidence(perception.objects())
    copied["retired_unconfirmed_hypotheses"][0]["reason"] = "caller modified"
    assert action_module.completion_evidence(perception.objects()) == expected
    assert perception.get_object(object_id)["retirement_evidence"]["last_seen_s"] == .1
    assert raw_state(perception) == before


def test_rows_without_confirmation_metadata_remain_conservatively_pending():
    rows = [{"id": "legacy-lost", "category": "red-ball", "state": "LOST"},
            {"id": "legacy-blue", "category": "blue-ball", "state": "LOST"}]
    original = copy.deepcopy(rows)
    result = action_module.completion_evidence(rows)
    assert result["pending_objects"] == ["legacy-lost"]
    assert result["retired_unconfirmed_hypotheses"] == []
    assert rows == original


@pytest.mark.parametrize("missing_frame", ["absent", None, ""], ids=["missing_key", "null", "empty"])
def test_archived_hypothesis_without_first_frame_basis_stays_pending(missing_frame):
    perception, object_id, _ = retired_hypothesis()
    if missing_frame == "absent":
        perception._times[object_id].pop("first_seen_frame_id")
    else:
        perception._times[object_id]["first_seen_frame_id"] = missing_frame
    before = raw_state(perception)
    row = perception.get_object(object_id)
    assert row["state"] == "LOST" and row["ever_confirmed"] is False
    assert row["completion_classification"] == "pending"
    assert "retirement_evidence" not in row
    outcome = done(perception)
    assert outcome["success"] is False
    assert outcome["evidence"]["pending_objects"] == [object_id]
    assert outcome["evidence"]["retired_unconfirmed_hypotheses"] == []
    assert raw_state(perception) == before


@pytest.mark.parametrize("gate", ["holding", "missing_roads", "unexplored_exit"])
def test_retired_hypothesis_does_not_bypass_gripper_or_exploration_gates(gate):
    perception, object_id, _ = retired_hypothesis()
    outcome = done(perception, holding=gate == "holding", nodes=gate != "missing_roads",
                   unexplored=1 if gate == "unexplored_exit" else 0)
    assert outcome["success"] is False
    assert outcome["evidence"]["pending_objects"] == []
    assert [row["object_id"] for row in outcome["evidence"]["retired_unconfirmed_hypotheses"]] == [object_id]
