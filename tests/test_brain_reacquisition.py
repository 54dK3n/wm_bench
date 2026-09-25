"""Offline identity-reacquisition regressions using public pixel observations.

No scene layout, physical identity labels, API calls, or live controller commands.
The baseline has no binding query; an empty binding list expresses that behavior
so positive regressions fail on the missing behavior rather than an AttributeError.
"""

import copy
import math

import pytest

from test_brain_perception import CAMERA, ball, observe
from autonomous_brain.actions import completion_evidence
from autonomous_brain.perception import Perception


def bindings(perception):
    query = getattr(perception, "reacquisition_bindings", None)
    return query() if query is not None else []


def pairs(perception):
    return {(row["historical_object_id"], row["current_object_id"])
            for row in bindings(perception)}


def pending(perception):
    return set(completion_evidence(perception.objects())["pending_objects"])


def confirm(perception, *, first_frame=1, first_time=.1, right=0,
            bearings=(0,), last_time=None):
    """Three fresh admitted detections at mutually separated public odometry."""
    latest = None
    for offset, forward in enumerate((0, 16, 32)):
        timestamp = first_time + offset / 10
        if offset == 2 and last_time is not None:
            timestamp = last_time
        latest = observe(perception, first_frame + offset, forward, right=right,
                         time=timestamp,
                         items=[ball(80 - forward, bearing=b) for b in bearings])
        assert all(d["fed_to_world_model"] for d in latest["detections"])
    ids = [d["track_id"] for d in latest["detections"]]
    for object_id in ids:
        row = perception.get_object(object_id)
        assert row["state"] == "CONFIRMED"
        assert row["hit_count"] == 3
        assert len(row["hit_poses"]) == 3
        for a in row["hit_poses"]:
            for b in row["hit_poses"]:
                if a is not b:
                    assert math.hypot(a["x_m"] - b["x_m"], a["z_m"] - b["z_m"]) >= .15
    return ids


def archived_confirmed(*, bearings=(0,)):
    perception = Perception(CAMERA)
    ids = confirm(perception, bearings=bearings)
    observe(perception, 4, 32, time=6, items=[])
    for object_id in ids:
        row = perception.get_object(object_id)
        assert row["state"] == "LOST" and row["ever_confirmed"] is True
        assert perception.wm.get_archived(object_id) is not None
    return perception, ids


def timeline(perception, object_id):
    return next(row for row in perception.timeline() if row["object_id"] == object_id)


def sensor_pick(perception, object_id, *, frame, timestamp):
    observed = observe(perception, frame, 32, time=timestamp, items=[])
    assert perception.mark_picked(object_id, holding=True, original_position_absent=True,
        simulation_time_s=timestamp,
        evidence={"holding": True, "original_position_absent": True,
                  "post_observation": frame, "frame_id": observed["frame_id"]})
    assert perception.get_object(object_id)["state"] == "HELD"


def sensor_deliver(perception, object_id, *, pickup_frame=8, pickup_time=6.4,
                   release_frame=9, release_time=7, release_forward=150):
    """Use empty old-position pixels, explicit holding, and a fresh pixel witness."""
    sensor_pick(perception, object_id, frame=pickup_frame, timestamp=pickup_time)
    preexisting = [r["id"] for r in perception.objects()
                   if r["category"] == "red-ball" and r["id"] != object_id]
    zone = {"category": "storage-zone", "source": "storage-ground-pixels", "confidence": 1,
            "bbox": {"x": 240, "y": 230, "w": 160, "h": 100}}
    observed = observe(perception, release_frame, release_forward, time=release_time,
                       items=[ball(60), zone])
    witness, storage = observed["detections"]
    assert witness["track_id"] not in preexisting and witness["track_id"] != object_id
    evidence = {"holding": False, "candidate_witnesses": 1,
        "release_observation": {"frame_id": str(release_frame), "simulation_time_s": release_time,
                                "preexisting_ball_ids": preexisting},
        "placement": {"ball_track_id": witness["track_id"], "ball_category": "red-ball",
                      "ball_position_m": copy.deepcopy(witness["position_m"]),
                      "ball_bbox": copy.deepcopy(witness["bbox"]),
                      "storage_bbox": copy.deepcopy(storage["bbox"]),
                      "frame_id": str(release_frame)}}
    assert perception.mark_delivered(object_id, holding=False, ball_in_storage=True,
                                    simulation_time_s=release_time, evidence=evidence)
    assert perception.get_object(object_id)["state"] == "DELIVERED"
    return witness["track_id"], evidence


@pytest.mark.parametrize("reading,bearing", [(25, 0), (39, 0), (80, 35.5), (90, 0)])
def test_out_of_window_sighting_never_revives_or_binds_archive(reading, bearing):
    perception, (old,) = archived_confirmed()
    original = copy.deepcopy(vars(perception.wm.get_archived(old)))
    evidence = observe(perception, 5, 55, time=6.1,
                       items=[ball(reading, bearing=bearing)])
    assert evidence["detections"][0]["fed_to_world_model"] is False
    assert vars(perception.wm.get_archived(old)) == original
    assert perception.get_object(old)["state"] == "LOST"
    assert bindings(perception) == []
    assert pending(perception) == {old}


def test_only_new_third_independent_confirmation_can_bind_without_rewriting_history():
    perception, (old,) = archived_confirmed()
    old_track = copy.deepcopy(vars(perception.wm.get_archived(old)))
    old_timeline = timeline(perception, old)
    for frame, forward in ((5, 0), (6, 16)):
        observed = observe(perception, frame, forward, time=6 + (frame - 4) / 10)
        new = observed["detections"][0]["track_id"]
        assert new != old
        assert perception.get_object(new)["hit_count"] == frame - 4
        assert perception.get_object(new)["state"] == "TENTATIVE"
        assert bindings(perception) == []
        assert pending(perception) == {old, new}
    observe(perception, 7, 32, time=6.3)
    assert perception.get_object(new)["state"] == "CONFIRMED"
    assert pairs(perception) == {(old, new)}
    assert vars(perception.wm.get_archived(old)) == old_track
    assert perception.get_object(old)["state"] == "LOST"
    assert timeline(perception, old)["accepted_hit_poses"] == old_timeline["accepted_hit_poses"]
    assert timeline(perception, old)["confirmed_s"] == old_timeline["confirmed_s"]
    assert timeline(perception, old)["delivered_s"] is None
    assert timeline(perception, new)["delivered_s"] is None
    assert len(timeline(perception, new)["accepted_hit_poses"]) == 3
    assert pending(perception) == {old, new}
    assert perception.get_object(old)["reacquisition_binding"] == bindings(perception)[0]


def test_repeated_position_never_borrows_old_three_hits():
    perception, (old,) = archived_confirmed()
    for frame, heading in enumerate((0, 2, 4, 6), 5):
        observed = observe(perception, frame, 0, heading=heading,
                           time=6 + (frame - 4) / 10,
                           items=[ball(80, bearing=heading)])
    new = observed["detections"][0]["track_id"]
    assert new != old
    assert perception.get_object(new)["hit_count"] == 1
    assert perception.get_object(new)["state"] == "TENTATIVE"
    assert bindings(perception) == []
    assert pending(perception) == {old, new}


def test_never_confirmed_history_is_not_a_reacquisition_candidate():
    perception = Perception(CAMERA)
    old = observe(perception, 1, time=.1)["detections"][0]["track_id"]
    observe(perception, 2, time=6, items=[])
    assert perception.get_object(old)["ever_confirmed"] is False
    (new,) = confirm(perception, first_frame=3, first_time=6.1)
    assert new != old
    assert bindings(perception) == []
    assert pending(perception) == {new}


@pytest.mark.parametrize("right,expected", [(29, True), (30, True), (31, False)])
def test_reacquisition_keeps_original_thirty_cm_gate(right, expected):
    perception, (old,) = archived_confirmed()
    (new,) = confirm(perception, first_frame=5, first_time=6.1, right=right)
    assert pairs(perception) == ({(old, new)} if expected else set())
    assert pending(perception) == {old, new}


@pytest.mark.parametrize("bearings", [(-10, 10), (10, -10)])
def test_two_archived_candidates_are_rejected_independent_of_input_order(bearings):
    perception, old_ids = archived_confirmed(bearings=bearings)
    (new,) = confirm(perception, first_frame=5, first_time=6.1)
    for old in old_ids:
        a, b = perception.get_object(old)["position_m"], perception.get_object(new)["position_m"]
        assert math.hypot(a["x"] - b["x"], a["z"] - b["z"]) < .30
    assert bindings(perception) == []
    assert pending(perception) == set(old_ids) | {new}


@pytest.mark.parametrize("competitor_state", ["TENTATIVE", "STALE", "CONFIRMED"])
@pytest.mark.parametrize("reverse_order", [False, True])
def test_complete_competition_snapshot_blocks_active_neighbours(competitor_state, reverse_order):
    perception, (old,) = archived_confirmed()
    bearings = (10, 0) if reverse_order else (0, 10)
    first = observe(perception, 5, 0, time=6.1,
                    items=[ball(80, bearing=b) for b in bearings])
    new = next(d["track_id"] for d in first["detections"] if d["raw_bearing_deg"] == 0)
    competitor = next(d["track_id"] for d in first["detections"] if d["raw_bearing_deg"] != 0)
    for frame, forward in ((6, 16), (7, 32)):
        all_bearings = bearings if competitor_state == "CONFIRMED" else (0,)
        timestamp = 7.9 if frame == 7 and competitor_state == "STALE" else 6 + (frame - 4) / 10
        observe(perception, frame, forward, time=timestamp,
                items=[ball(80 - forward, bearing=b) for b in all_bearings])
    assert perception.get_object(new)["state"] == "CONFIRMED"
    assert perception.get_object(competitor)["state"] == competitor_state
    assert bindings(perception) == []
    assert pending(perception) == {old, new, competitor}


@pytest.mark.parametrize("unverified_release", [False, True])
def test_action_removed_identity_cannot_become_historical_reacquisition(unverified_release):
    perception = Perception(CAMERA)
    (old,) = confirm(perception)
    observe(perception, 4, 32, time=.4, items=[])
    assert perception.mark_picked(old, holding=True, original_position_absent=True,
                                  simulation_time_s=.4,
                                  evidence={"holding": True, "post_observation": 4})
    if unverified_release:
        assert perception.mark_release_unverified(old, simulation_time_s=.4,
                   evidence={"holding": False, "post_observation": 4})
    (new,) = confirm(perception, first_frame=5, first_time=.5)
    assert perception.wm.get_archived(old) is not None
    assert perception.get_object(old)["state"] == ("RELEASED_UNVERIFIED" if unverified_release else "HELD")
    assert new != old
    assert bindings(perception) == []
    assert pending(perception) == {old, new}


def test_binding_queries_are_detached_and_do_not_create_observation_evidence():
    perception, (old,) = archived_confirmed()
    (new,) = confirm(perception, first_frame=5, first_time=6.1)
    assert pairs(perception) == {(old, new)}
    before = copy.deepcopy((perception.objects(), perception.timeline(), perception.last_evidence))
    first = bindings(perception)
    assert first and isinstance(first[0]["evidence"], dict)
    first[0]["evidence"]["caller_mutation"] = True
    first[0]["current_object_id"] = "invented"
    assert pairs(perception) == {(old, new)}
    assert "caller_mutation" not in bindings(perception)[0]["evidence"]
    assert (perception.objects(), perception.timeline(), perception.last_evidence) == before


def test_only_verified_delivery_of_reconfirmed_successor_resolves_old_pending():
    perception, (old,) = archived_confirmed()
    old_track = copy.deepcopy(vars(perception.wm.get_archived(old)))
    old_timeline = timeline(perception, old)
    (new,) = confirm(perception, first_frame=5, first_time=6.1)
    assert pending(perception) == {old, new}
    sensor_deliver(perception, new)
    assert perception.get_object(new)["state"] == "DELIVERED"
    assert perception.get_object(old)["state"] == "LOST"
    assert vars(perception.wm.get_archived(old)) == old_track
    assert timeline(perception, old)["confirmed_s"] == old_timeline["confirmed_s"]
    assert timeline(perception, old)["accepted_hit_poses"] == old_timeline["accepted_hit_poses"]
    assert timeline(perception, old)["delivered_s"] is None
    assert timeline(perception, new)["picked_s"] == 6.4
    assert timeline(perception, new)["delivered_s"] == 7
    assert pending(perception) == set()
    assert completion_evidence(perception.objects())["resolved_reacquired_identities"]


def test_successor_held_or_unverified_release_never_resolves_old_pending():
    perception, (old,) = archived_confirmed()
    (new,) = confirm(perception, first_frame=5, first_time=6.1)
    sensor_pick(perception, new, frame=8, timestamp=6.4)
    assert pending(perception) == {old, new}
    observed = observe(perception, 9, 32, time=6.5, items=[])
    assert perception.mark_release_unverified(new, simulation_time_s=6.5,
        evidence={"holding": False, "post_observation": 9,
                  "frame_id": observed["frame_id"], "strict_pixel_inside": False})
    assert perception.get_object(new)["state"] == "RELEASED_UNVERIFIED"
    assert pending(perception) == {old, new}
    assert timeline(perception, old)["delivered_s"] is None


def test_delivered_identity_and_delivery_witness_alias_are_not_reacquisition_candidates():
    perception = Perception(CAMERA)
    (delivered,) = confirm(perception)
    witness, _ = sensor_deliver(perception, delivered, pickup_frame=4, pickup_time=.4,
                                release_frame=5, release_time=.5, release_forward=0)
    assert perception.get_object(witness)["state"] == "DELIVERY_ALIAS"
    (new,) = confirm(perception, first_frame=6, first_time=.6)
    # The new measurements are >15cm from the delivered witness, so they are
    # not suppressed as a verified placement, yet remain inside the 30cm gate.
    a = perception.get_object(delivered)["position_m"]
    b = perception.get_object(new)["position_m"]
    assert .15 < math.hypot(a["x"] - b["x"], a["z"] - b["z"]) < .30
    assert bindings(perception) == []
    assert pending(perception) == {new}


def test_reacquisition_chain_keeps_every_old_state_and_waits_for_terminal_delivery():
    perception, (first,) = archived_confirmed()
    (second,) = confirm(perception, first_frame=5, first_time=6.1)
    observe(perception, 8, 32, time=12, items=[])
    assert perception.get_object(second)["state"] == "LOST"
    (third,) = confirm(perception, first_frame=9, first_time=12.1)
    assert pairs(perception) == {(first, second), (second, third)}
    assert pending(perception) == {first, second, third}
    sensor_deliver(perception, third, pickup_frame=12, pickup_time=12.4,
                   release_frame=13, release_time=13)
    assert pending(perception) == set()
    for old in (first, second):
        assert perception.get_object(old)["state"] == "LOST"
        assert timeline(perception, old)["delivered_s"] is None
    assert perception.get_object(third)["state"] == "DELIVERED"


@pytest.mark.parametrize("corruption", ["missing_successor", "self_cycle", "duplicate_historical_row"])
def test_incomplete_or_ambiguous_binding_graph_cannot_clear_pending(corruption):
    perception, (old,) = archived_confirmed()
    (new,) = confirm(perception, first_frame=5, first_time=6.1)
    sensor_deliver(perception, new)
    rows = copy.deepcopy(perception.objects())
    old_row = next(row for row in rows if row["id"] == old)
    if corruption == "missing_successor":
        rows = [row for row in rows if row["id"] != new]
    elif corruption == "self_cycle":
        # On the pre-fix baseline there is no binding; its existing pending
        # behavior is still the correct negative result.
        binding = old_row.setdefault("reacquisition_binding", {
            "historical_object_id": old, "current_object_id": new, "evidence": {}})
        binding["current_object_id"] = old
    else:
        duplicate = copy.deepcopy(old_row)
        duplicate.pop("reacquisition_binding", None)
        rows.append(duplicate)
    result = completion_evidence(rows)
    assert old in result["pending_objects"]
    assert result.get("resolved_reacquired_identities", []) == []


@pytest.mark.parametrize("corruption", [
    "missing_evidence", "nonfinite_distance", "two_positions", "repeated_position",
    "repeated_frame", "nonfinite_position", "ambiguous_old_candidates",
    "ambiguous_new_candidates", "duplicate_competing_identity", "wrong_category",
])
def test_malformed_binding_evidence_cannot_turn_history_into_completed_work(corruption):
    perception, (old,) = archived_confirmed()
    (new,) = confirm(perception, first_frame=5, first_time=6.1)
    sensor_deliver(perception, new)
    rows = copy.deepcopy(perception.objects())
    old_row = next(row for row in rows if row["id"] == old)
    new_row = next(row for row in rows if row["id"] == new)
    binding = old_row.get("reacquisition_binding")
    if binding is not None:
        evidence = binding["evidence"]
        if corruption == "missing_evidence":
            binding.pop("evidence")
        elif corruption == "nonfinite_distance":
            evidence["distance_m"] = float("nan")
        elif corruption == "two_positions":
            evidence["current_hit_poses"] = evidence["current_hit_poses"][:2]
        elif corruption == "repeated_position":
            for key in ("x_m", "z_m"):
                evidence["current_hit_poses"][1][key] = evidence["current_hit_poses"][0][key]
        elif corruption == "repeated_frame":
            evidence["current_hit_poses"][1]["frame_id"] = evidence["current_hit_poses"][0]["frame_id"]
        elif corruption == "nonfinite_position":
            evidence["current_hit_poses"][0]["x_m"] = float("inf")
        elif corruption == "ambiguous_old_candidates":
            evidence["historical_candidates"].append("another_red_identity")
        elif corruption == "ambiguous_new_candidates":
            evidence["current_candidates"].append("another_red_identity")
        elif corruption == "duplicate_competing_identity":
            evidence["competing_identity_ids"].append(old)
        elif corruption == "wrong_category":
            new_row["category"] = "blue-ball"
    result = completion_evidence(rows)
    assert old in result["pending_objects"]
    assert result.get("resolved_reacquired_identities", []) == []
