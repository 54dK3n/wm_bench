"""Action consumers distinguish possible competitors from positive pixels.

These sensor-shaped fixtures test consumption only. Perception separately
validates the pixel-count certificate and its original frame binding.
"""
import copy
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions


def ball(*, quality=None, quality_key="pixel_quality", x=310, track_id=None):
    item = {"category": "red-ball", "source": "virtual-cv", "confidence": .9,
            "bbox": {"x": x, "y": 280, "w": 20, "h": 20},
            "frame_id": "7", "track_id": track_id,
            "position_m": {"x": 0, "z": .5}, "fed_to_world_model": False}
    if quality is not None:
        item[quality_key] = {"schema": "red-component-quality/v1", "frameId": 7,
            "componentPixels": 100, "redSectorPixels": 80 if quality == "supported" else 20,
            "status": quality,
            "reason": "red_sector_majority" if quality == "supported" else "red_sector_not_majority"}
    return item


def actions_for(items, *, direct=None):
    target = {"id": "target-selected", "category": "red-ball", "state": "CONFIRMED",
              "position_m": {"x": 0, "z": .5}}
    perception = SimpleNamespace(visible=lambda oid: direct,
        get_object=lambda oid: target,
        objects=lambda: [dict(target, state="TENTATIVE")])
    runtime = SimpleNamespace(perception=perception,
        snapshot={"observation_index": 7, "observation": {"frameId": 7},
                  "holding": {"holding": False}, "perception": {"detections": items}})
    return Actions(runtime)


@pytest.mark.parametrize("quality_key", ["pixel_quality", "pixelQuality"])
def test_unknown_untracked_pixels_cannot_drive_near_visual_fallback(quality_key):
    unknown = ball(quality="unknown", quality_key=quality_key)
    actions = actions_for([unknown])
    before = copy.deepcopy(actions.s)
    assert actions.visible("target-selected") is None
    assert actions.s == before


@pytest.mark.parametrize("quality", [None, "supported"])
def test_legacy_and_supported_untracked_pixels_keep_near_visual_fallback(quality):
    observed = ball(quality=quality)
    assert actions_for([observed]).visible("target-selected") == observed


def test_unknown_competitor_is_not_filtered_to_make_visual_fallback_unique():
    good, unknown = ball(quality="supported"), ball(quality="unknown", x=330)
    assert actions_for([good, unknown]).visible("target-selected") is None


def test_direct_track_reference_cannot_override_unknown_pixel_quality():
    unknown = ball(quality="unknown", track_id="target-selected")
    assert actions_for([unknown], direct=unknown).visible("target-selected") is None


def placement(items):
    region = {"category": "storage-zone", "source": "storage-ground-pixels",
              "bbox": {"x": 240, "y": 250, "w": 160, "h": 100}}
    actions = actions_for([*items, region])
    release = {"frame_id": "6", "preexisting_ball_ids": []}
    return actions, actions.placement_evidence("red-ball", release)


@pytest.mark.parametrize("quality_key", ["pixel_quality", "pixelQuality"])
def test_unknown_untracked_inside_region_is_not_a_delivery_witness(quality_key):
    actions, result = placement([ball(quality="unknown", quality_key=quality_key)])
    assert result["candidate_witnesses"] == 1
    assert result["placement"] is None
    assert actions.s["perception"]["detections"][0]["track_id"] is None


@pytest.mark.parametrize("quality", [None, "supported"])
def test_positive_near_field_witness_still_may_have_no_track_id(quality):
    _, result = placement([ball(quality=quality)])
    assert result["candidate_witnesses"] == 1
    assert result["placement"]["ball_track_id"] is None


@pytest.mark.parametrize("ambiguous", [False, True])
def test_supported_and_unknown_inside_region_remain_two_competitors(ambiguous):
    unknown = ball(quality="unknown", x=325)
    if ambiguous:
        unknown["identity_ambiguity"] = {"candidate_ids": ["possible-other"]}
    _, result = placement([ball(quality="supported"), unknown])
    assert result["candidate_witnesses"] == 2
    assert result["placement"] is None


def test_unknown_pixels_still_occupy_the_observed_release_aim():
    unknown = ball(quality="unknown")
    unknown["bbox"]["y"] = 290
    actions, _ = placement([unknown])
    aim = actions.choose_release_aim()
    assert aim["error"] == "storage_center_point_occupied"
    assert aim["occupied_boxes"] == [unknown["bbox"]]


def test_unknown_cannot_be_a_positive_tentative_sampling_view():
    unknown = ball(quality="unknown", track_id="target-selected")
    unknown["fed_to_world_model"] = True  # A stale flag cannot override quality.
    actions = actions_for([unknown])
    assert actions.fresh_tentative_views() == []
    actions.r.task_spec = {"target_category": "red-ball"}
    actions.s["road"] = {"onRoad": True}
    actions.r.perception.discovery_target = lambda ident: pytest.fail("unknown must not request a positive sampling target")
    assert actions._sampling_opportunity({"perception": {"detections": []}}) is None


@pytest.mark.parametrize("delivered_count", [1, 2])
def test_known_quantity_preserves_unknown_record_without_changing_delivery_requirement(delivered_count):
    from autonomous_brain.task import completion_progress, parse_task
    from test_brain_task_scope import ledger

    rows, events = ledger(tuple(f"red-{i}" for i in range(delivered_count)))
    unknown = {**ball(quality="unknown"), "id": "red-discovery-unknown",
               "initial_object_id": None, "observed_track_id": None}
    discovery = {"schema": "brain-discovery-evidence/v2", "records": [unknown],
                 "unresolved": [unknown], "resolutions": []}
    before = copy.deepcopy(discovery)
    progress = completion_progress(rows, events, parse_task("把两个红球送到绿色存放区"),
        holding=False, nodes=0, unexplored=9, observed_detections=[unknown],
        discovery_evidence=discovery)
    assert progress["delivered_count"] == delivered_count
    assert progress["ready_for_done"] is (delivered_count == 2)
    assert discovery == before
