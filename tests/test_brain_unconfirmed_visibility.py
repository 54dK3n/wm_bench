"""New-contract negative visibility through real Perception/WorldModel.

The 113-frame fixture is an unchanged public observation window. Synthetic
two-object and actuator-fault cases are explicitly separate; they do not
establish that sequential real detections describe one physical object.
"""
import copy
import json
import math
from pathlib import Path

import pytest

from test_brain_perception import CAMERA, Perception
from test_brain_pick_pixel_recovery import ClippedRetryRuntime, commands
from test_brain_grab_authorization import actual_grabs


FIXTURE = json.loads((Path(__file__).parent / "fixtures/run_20261011T080559_public_visibility_window.json").read_text())


def update(p, row):
    evidence = p.update(row["observation"], row["odometry"],
        simulation_time_s=row["simulation_seconds"], round_index=row["round"],
        observation_index=row["observation_index"])
    return {**copy.deepcopy(row), "perception": evidence}


def prefix(count=24):
    p = Perception(FIXTURE["camera"])
    for row in FIXTURE["frames"][:count]:
        snapshot = update(p, row)
    oid = next(oid for oid, history in p._times.items()
               if history["category"] == "red-ball" and history["first_seen_frame_id"] == "19")
    return p, oid, snapshot


def synthetic_row(p, frame, now, *, x=0, z=0, heading=0, points=()):
    """Explicit synthetic points rendered to public bboxes; no IDs to brain."""
    h = math.radians(heading)
    detections = []
    for px, pz in points:
        dx, dz = (px - x) * 100, (pz - z) * 100
        local_x = math.cos(h) * dx + math.sin(h) * dz
        local_z = -math.sin(h) * dx + math.cos(h) * dz - 5.1557
        beta = math.atan2(local_x, local_z)
        reading = (math.hypot(local_x, local_z) - 1.6239) * math.cos(beta) / 1.0187
        width = 5.5 * p.camera["fy"] / ((reading - 5.375) * math.cos(beta))
        center = p.camera["cx"] + p.camera["fx"] * math.tan(beta)
        detections.append({"category": "red-ball", "source": "virtual-cv", "confidence": .92,
            "bbox": {"x": center-width/2, "y": 245, "w": width, "h": width},
            "pixelQuality": {"schema": "red-component-quality/v1", "frameId": frame,
                "componentPixels": 100, "redSectorPixels": 95,
                "status": "supported", "reason": "red_sector_majority"}})
    return {"observation_index": frame, "round": frame, "simulation_seconds": now,
        "holding": {"holding": False},
        "observation": {"frameId": frame, "tick": frame, "width": 640, "height": 480,
                        "detections": detections},
        "odometry": {"tick": frame, "forwardCm": z*100, "rightCm": x*100,
                     "headingDeg": heading, "distanceCm": math.hypot(x, z)*100}}


def test_public_single_source_absence_only_time_decays_without_positive_refresh():
    p, oid, _ = prefix()
    track = p.wm.get_object(oid)
    before = copy.deepcopy(vars(track))
    records = copy.deepcopy(p._discovery_records)
    sources = p._new_quality_width_proxy_sources(track)
    assert [r["frame_id"] for r in sources] == ["19"]
    assert sources[0]["observation_method"] == "virtual-cv-published-width-formula+M5"
    snapshot = update(p, FIXTURE["frames"][24])
    evidence = snapshot["perception"]
    assert [r["object_id"] for r in evidence["visibility_expectation_unknown"]] == [oid]
    assert evidence["visibility_expectation_unknown"][0]["positive_visibility"] is False
    assert track.confidence == pytest.approx(before["confidence"] * .5 ** ((16.48-11.36)/60))
    for key in ("x", "z", "last_seen", "hit_count", "miss_count", "state", "last_frame_id", "last_bbox"):
        assert getattr(track, key) == before[key]
    assert track.last_updated == 16.48
    assert p.wm.get_archived(oid) is None
    assert p.confirmed(oid) is None
    assert p._discovery_records == records


def test_public_following_raw_views_get_native_hits_then_confirmed_fast_decay_returns():
    p, oid, _ = prefix()
    for row in FIXTURE["frames"][24:94]:
        snapshot = update(p, row)
        if row["observation"]["frameId"] == 35:
            red = [d for d in snapshot["perception"]["detections"] if d["category"] == "red-ball"]
            assert len(red) == 1 and red[0]["track_id"] == oid and red[0]["fed_to_world_model"]
            assert p.wm.get_object(oid).hit_count == 2
            assert len([o for o in p.objects() if o["category"] == "red-ball"]) == 1
    track = p.wm.get_object(oid)
    assert p.confirmed(oid) is not None and track.hit_count == 3
    poses = p._accepted_poses[oid]
    assert [r["frame_id"] for r in poses] == ["19", "35", "94"]
    assert all(math.hypot(a["x_m"]-b["x_m"], a["z_m"]-b["z_m"]) >= p.wm.assoc_cfg.min_hit_pose_gap_m
               for i, a in enumerate(poses) for b in poses[:i])
    assert p.get_object(oid)["position_evidence"]["mutual_reprojection_failed_pairs"]
    assert not p._reacquisitions  # No LOST revival or manufactured identity binding.
    before = copy.deepcopy(vars(track))
    snapshot = update(p, FIXTURE["frames"][94])
    assert oid not in {r["object_id"] for r in snapshot["perception"]["visibility_expectation_unknown"]}
    assert p._new_quality_width_proxy_sources(track) == []
    assert track.confidence == pytest.approx(before["confidence"] * .5 ** ((70.2-69.62)/1.5))
    assert track.miss_count == before["miss_count"] + 1
    assert track.last_seen == before["last_seen"]


@pytest.mark.parametrize("fault", ["legacy", "missing_source", "unknown", "non_M5", "missing_method", "other_semantics"])
def test_ineligible_source_does_not_acquire_new_negative_evidence_rule(fault):
    p, oid, _ = prefix()
    source = next(r for r in p._discovery_records if r["frame_id"] == "19")
    # Explicit synthetic source-integrity faults. Original fixture is untouched.
    if fault == "legacy":
        source.pop("pixel_quality")
        source.pop("observation_method")
    elif fault == "missing_source":
        p._discovery_records.remove(source)
    elif fault == "unknown":
        source["pixel_quality"].update(status="unknown", reason="red_sector_not_majority", redSectorPixels=1)
    elif fault == "non_M5":
        source["observation_method"] = "independently_calibrated_test_source"
    elif fault == "missing_method":
        source.pop("observation_method")
    else:
        source["position_semantics"] = "different_model"
    track = p.wm.get_object(oid)
    assert p._new_quality_width_proxy_sources(track) == []
    before = copy.deepcopy(vars(track))
    snapshot = update(p, FIXTURE["frames"][24])
    assert snapshot["perception"]["visibility_expectation_unknown"] == []
    assert p.wm.get_archived(oid) is track
    assert track.confidence == pytest.approx(before["confidence"] * .5 ** ((16.48-11.36)/1.5))
    assert track.miss_count == before["miss_count"] + 1


def test_coincident_blue_object_prevents_masking_shared_visibility_coordinate():
    p, oid, _ = prefix()
    track = p.wm.get_object(oid)
    blue = copy.deepcopy(track)
    blue.obj_id, blue.name = "synthetic-different-blue", "distractor"
    p.wm._objects[blue.obj_id] = blue
    before = copy.deepcopy(vars(blue))
    snapshot = update(p, FIXTURE["frames"][24])
    assert snapshot["perception"]["visibility_expectation_unknown"] == []
    assert blue.confidence == pytest.approx(before["confidence"] * .5 ** ((16.48-11.36)/(1.5*1.5)))
    assert blue.miss_count == before["miss_count"] + 1
    assert p.wm.get_archived(oid) is track


def test_time_decay_expires_and_old_lost_still_competes_with_new_confirmation():
    p, oid, _ = prefix()
    original = p.wm.get_object(oid)
    point = (original.x, original.z)
    origin = (p.pose.x, p.pose.z)
    last_seen = original.last_seen
    update(p, synthetic_row(p, 900, 300, x=origin[0], z=origin[1]))
    assert p.wm.get_archived(oid) is original
    assert original.last_seen == last_seen
    saved = copy.deepcopy(vars(original))
    dx, dz = point[0]-origin[0], point[1]-origin[1]
    distance = math.hypot(dx, dz)
    heading = -math.degrees(math.atan2(dx, dz))
    for frame, step in enumerate((0, .16, .32), 901):
        snapshot = update(p, synthetic_row(p, frame, 300+(frame-900)*.1,
            x=origin[0]+dx/distance*step, z=origin[1]+dz/distance*step,
            heading=heading, points=[point]))
        assert vars(original) == saved
    current = next(o for o in p.objects() if o["category"] == "red-ball" and o["id"] != oid)
    assert current["state"] == "CONFIRMED"
    assert p._discovery_canonical(oid) == oid
    identity = p.check_grasp_identity(current["id"], snapshot)
    assert identity["authorized"] is False and identity["reason"] == "grab_identity_competition"
    assert {oid, current["id"]} <= set(identity["candidate_ids_by_detection"][0])


@pytest.mark.parametrize("half_gap, ambiguous", [(.36, False), (.10, True)])
def test_synthetic_different_objects_remain_distinct_and_same_frame_rivals_block(half_gap, ambiguous):
    p = Perception(CAMERA)
    # Two explicitly different synthetic fixed targets. This does not test or
    # certify a sequential observation switch already absorbed by one track.
    points = [(-half_gap, .9), (half_gap, .9)]
    for frame, z in enumerate((0, .16, .32), 1):
        snapshot = update(p, synthetic_row(p, frame, frame*.1, z=z, points=points))
    targets = [o for o in p.objects() if o["category"] == "red-ball"]
    assert len(targets) == 2 and all(o["state"] == "CONFIRMED" for o in targets)
    ids = {o["id"] for o in targets}
    assert not p._reacquisitions and not p._delivery_aliases
    for target in targets:
        identity = p.check_grasp_identity(target["id"], snapshot)
        if ambiguous:
            assert identity["authorized"] is False and identity["reason"] == "grab_identity_competition"
            assert all(set(group) == ids for group in identity["candidate_ids_by_detection"])
        else:
            assert identity["authorized"] is True
            proof = identity["evidence"]
            assert proof["candidate_ids_by_detection"][proof["detection_index"]] == [target["id"]]
    assert p._grab_authorizations == {}


def test_current_unknown_competitor_is_retained_and_blocks_positive_identity():
    p = Perception(CAMERA)
    points = [(-.36, .9), (.36, .9)]
    for frame, z in enumerate((0, .16, .32), 1):
        update(p, synthetic_row(p, frame, frame*.1, z=z, points=points))
    oid = p.objects()[0]["id"]
    row = synthetic_row(p, 4, .4, z=.32, points=points)
    row["observation"]["detections"][1]["pixelQuality"].update(
        status="unknown", reason="red_sector_not_majority", redSectorPixels=1)
    snapshot = update(p, row)
    unknown = snapshot["perception"]["detections"][1]
    assert unknown["track_id"] is None and unknown["fed_to_world_model"] is False
    assert p._discovery_records[-1]["pixel_quality"]["status"] == "unknown"
    identity = p.check_grasp_identity(oid, snapshot)
    assert identity["authorized"] is False
    # Unknown peers suppress positive association before the identity checker
    # reaches its matrix gate. Check that earlier rejection and the unavailable
    # complete matrix independently; no positive witness survives either gate.
    assert snapshot["perception"]["detections"][0]["track_id"] is None
    assert identity["reason"] == "grab_identity_not_uniquely_visible"
    assert p._grasp_identity_candidates(snapshot["perception"]["detections"]) is None
    assert p._grab_authorizations == {}


@pytest.mark.parametrize("fault", ["unknown", "forward-unknown"])
def test_new_quality_sources_do_not_repeat_unknown_physical_motion(fault):
    # Public synthetic sensors plus actual Actions/Perception, no real motion.
    r = ClippedRetryRuntime(recovery_fault=fault)
    sources = [d for d in r.perception._discovery_records if d.get("pixel_quality")]
    assert sources and all(d["observation_method"] == "virtual-cv-published-width-formula+M5" for d in sources)
    with pytest.raises(ConnectionError):
        r.pick()
    assert len(actual_grabs(r)) == 1
    assert len(commands(r, "forward")) == 1
    assert r.inverse_attempts == (1 if fault == "unknown" else 0)
    assert r.actions._pick_probe_limits == {}
    assert not r.perception.action_evidence()
