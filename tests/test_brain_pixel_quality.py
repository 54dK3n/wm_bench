"""Quality affects real Perception/WM admission, never edits original pixels."""
import copy

import pytest

from autonomous_brain.observation_quality import pixel_quality
from test_brain_perception import CAMERA, Perception, ball, observe


def quality(frame, *, supported=False, reason=None):
    return {"schema": "red-component-quality/v1", "frameId": frame,
            "componentPixels": 186, "redSectorPixels": 180 if supported else 12,
            "status": "supported" if supported else "unknown",
            "reason": reason or ("red_sector_majority" if supported else "red_sector_not_majority")}


def detection(frame, reading=80, *, supported=False):
    d = ball(reading)
    d["pixelQuality"] = quality(frame, supported=supported)
    return d


def snapshot(e):
    return {"observation_index": int(e["frame_id"]), "observation": e["raw_observation"],
            "odometry": e["odometry"], "simulation_seconds": e["simulation_time_s"],
            "perception": e, "holding": {"holding": False}}


def test_unknown_component_keeps_raw_and_navigation_but_never_births_or_resolves_identity():
    p = Perception(CAMERA)
    original = detection(1)
    e = observe(p, 1, items=[original])
    item = e["detections"][0]
    assert e["raw_observation"]["detections"] == [original]
    assert item["bbox"] == original["bbox"] and item["confidence"] == original["confidence"]
    assert item["position_m"] and item["raw_distance_cm"] == 80
    assert item["fed_to_world_model"] is False and item["track_id"] is None
    assert p.objects() == []
    saved = copy.deepcopy(p.discovery_evidence()["records"])
    target = p.discovery_target(item["discovery_id"])
    assert target["sampling_allowed"] is False
    assert target["reason"] == "pixel_geometry_support_unknown"
    assert target["last_effective_view"] is None
    for frame, forward in ((2, 0), (3, 16), (4, 32)):
        observe(p, frame, forward, items=[detection(frame, 80-forward, supported=True)])
    assert len(p.objects()) == 1
    assert p.objects()[0]["hit_count"] == 3 and p.objects()[0]["state"] == "CONFIRMED"
    ledger = p.discovery_evidence()
    assert ledger["records"][:1] == saved
    assert ledger["unresolved"] == saved
    assert not ledger["resolutions"]


@pytest.mark.parametrize("reading,forward", [(20, 60), (95, -15)])
def test_unknown_near_and_unfed_frames_cannot_refresh_existing_track(reading, forward):
    p = Perception(CAMERA)
    observe(p, 1)
    track = p.wm.get_scene()[0]
    before = (track.x, track.z, track.hit_count, track.last_seen)
    e = observe(p, 2, forward, items=[detection(2, reading)])
    assert e["detections"][0]["track_id"] is None
    assert "visibility_refresh_only" not in e["detections"][0]
    assert (track.x, track.z, track.hit_count, track.last_seen) == before


def test_same_frame_unknown_remains_a_competitor_and_blocks_all_positive_red_admission():
    p = Perception(CAMERA)
    for frame, forward in ((1, 0), (2, 16), (3, 32)):
        observe(p, frame, forward)
    track = p.wm.get_scene()[0]
    good, unknown = detection(4, 20, supported=True), detection(4, 22)
    unknown["bbox"]["x"] += 30
    before = (track.hit_count, track.last_seen)
    e = observe(p, 4, 60, items=[good, unknown])
    assert len(e["detections"]) == 2
    assert all(d["track_id"] is None and not d["fed_to_world_model"] for d in e["detections"])
    assert (track.hit_count, track.last_seen) == before
    assert p._grasp_identity_candidates(e["detections"]) is None
    assert not p.check_grasp_identity(track.obj_id, snapshot(e))["authorized"]
    assert len(p.discovery_evidence()["records"]) == 5


def test_unknown_observation_does_not_revive_or_remove_a_lost_competitor():
    p = Perception(CAMERA)
    observe(p, 1)
    oid = p.objects()[0]["id"]
    observe(p, 2, time=20, items=[])
    archived = p.wm.get_archived(oid)
    assert archived is not None
    before = copy.deepcopy(vars(archived))
    observe(p, 3, time=21, items=[detection(3)])
    assert vars(archived) == before
    assert p.get_object(oid)["state"] == "LOST"
    assert len(p.objects()) == 1


def test_unknown_box_cannot_manufacture_original_position_absence():
    p = Perception(CAMERA)
    observe(p, 1)
    point = p.objects()[0]["position_m"]
    # Construct an actual pixel overlap with the independently projected old
    # position; the generic ball fixture's arbitrary y=245 need not overlap.
    projected = p.original_position_evidence((point["x"], point["z"]), "red-ball")["projected_bbox"]
    unknown = detection(2)
    unknown["bbox"]["y"] = projected["y"]
    e = observe(p, 2, items=[unknown])
    absence = p.original_position_evidence((point["x"], point["z"]), "red-ball")
    assert absence["matches"] == e["detections"]
    assert absence["occluders"]
    assert not absence["valid"]


@pytest.mark.parametrize("fault", ["other-frame", "claimed-majority", "unknown-schema", "bool-count", "extra-truth"])
def test_malformed_quality_does_not_fall_back_to_legacy_admission(fault):
    d = detection(1)
    q = d["pixelQuality"]
    if fault == "other-frame": q["frameId"] = 2
    if fault == "claimed-majority": q.update(status="supported", reason="red_sector_majority")
    if fault == "unknown-schema": q["schema"] = "future/v99"
    if fault == "bool-count": q["redSectorPixels"] = True
    if fault == "extra-truth": q["physicalId"] = "forbidden"
    with pytest.raises(ValueError):
        pixel_quality(d, "1")
