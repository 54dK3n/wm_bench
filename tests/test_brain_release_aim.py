"""Release aiming from current public pixels, calibration, and odometry only."""
import copy
import math
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from test_brain_place_path_recovery import place_runtime


def region(**changes):
    return {"category": "storage-zone", "track_id": "green", "frame_id": "17",
            "bbox": {"x": 200., "y": 200., "w": 200., "h": 100., **changes},
            "distance_cm": 18., "bearing_deg": 0.}


def occupied(x=238., y=235., w=24., h=24., *, category="red-ball", delivered=True):
    row = {"category": category, "frame_id": "17",
           "bbox": {"x": x, "y": y, "w": w, "h": h}}
    if delivered:
        row["known_delivered_object_id"] = "old"
    return row


def aim_runtime(detections, *, projection=(.04, .18), heading=0, right=0, forward=0):
    calls = []

    def project(u, v):
        calls.append((u, v))
        if isinstance(projection, Exception):
            raise projection
        return projection

    # Deliberately no WM rows, map, pose object, or platform metadata. Aiming
    # must be computable from these three public inputs alone.
    runtime = SimpleNamespace(snapshot={
        "observation_index": 17, "observation": {"frameId": 17, "width": 640, "height": 480},
        "odometry": {"rightCm": right, "forwardCm": forward, "headingDeg": heading},
        "holding": {"holding": True}, "perception": {"detections": copy.deepcopy(detections)},
    }, perception=SimpleNamespace(ground_camera=SimpleNamespace(project_pixel_to_ground=project)))
    return runtime, calls


@pytest.mark.parametrize("old_x,expected_u", [(238, 350), (338, 250)])
def test_occupied_left_and_right_pixels_choose_mirrored_free_quarters(old_x, expected_u):
    runtime, calls = aim_runtime([region(), occupied(x=old_x)])
    result = Actions(runtime).choose_release_aim()
    assert not result.get("error")
    assert calls == [(expected_u, 250)]
    assert result["position_m"] == pytest.approx({"x": .04, "z": .18})
    assert str(result["source_frame"]) == "17"
    assert result["source_region"]["bbox"] == region()["bbox"]
    assert result["occupied_boxes"]


def test_symmetric_free_quarters_choose_left_deterministically():
    runtime, calls = aim_runtime([region(), occupied(x=295, y=245, w=10, h=10)])
    assert not Actions(runtime).choose_release_aim().get("error")
    assert calls == [(250, 250)]


def test_both_free_quarters_choose_the_one_farther_from_observed_occupancy():
    runtime, calls = aim_runtime([region(), occupied(x=270, y=245, w=10, h=10)])
    assert not Actions(runtime).choose_release_aim().get("error")
    assert calls == [(350, 250)]


@pytest.mark.parametrize("category", ["blue-ball", "obstacle"])
def test_other_public_occupants_can_block_the_other_quarter(category):
    runtime, calls = aim_runtime([region(), occupied(),
                                 occupied(x=338, category=category, delivered=False)])
    result = Actions(runtime).choose_release_aim()
    assert result.get("error")
    assert calls == []


def test_half_size_expansion_blocks_candidates_on_occupied_margin_boundaries():
    runtime, calls = aim_runtime([region(), occupied(x=260, y=240, w=20, h=20),
        occupied(x=360, y=240, w=20, h=20, category="blue-ball", delivered=False)])
    assert Actions(runtime).choose_release_aim().get("error")
    assert calls == []


def test_only_unique_largest_complete_green_component_is_used():
    small = region(x=420, y=310, w=2, h=1)
    runtime, calls = aim_runtime([small, occupied(), region()])
    result = Actions(runtime).choose_release_aim()
    assert not result.get("error")
    assert calls == [(350, 250)]
    assert result["source_region"]["bbox"] == region()["bbox"]


@pytest.mark.parametrize("regions", [[], [region(x=0)], [region(y=0)],
    [region(x=440)], [region(y=380)], [region(), region(x=410)]])
def test_missing_clipped_or_equal_largest_regions_cannot_choose_a_release_point(regions):
    runtime, calls = aim_runtime([*regions, occupied()])
    assert Actions(runtime).choose_release_aim().get("error")
    assert calls == []


@pytest.mark.parametrize("projection", [ValueError("above ground horizon"),
    (math.nan, .18), (.04, math.inf), (.04, -.18), (.04, 0)])
def test_invalid_ground_projection_is_a_failure_not_a_release_location(projection):
    runtime, calls = aim_runtime([region(), occupied()], projection=projection)
    assert Actions(runtime).choose_release_aim().get("error")
    assert calls == [(350, 250)]


@pytest.mark.parametrize("heading,expected", [
    (0, {"x": .34, "z": .58}), (90, {"x": .12, "z": .44}),
    (-90, {"x": .48, "z": .36}),
])
def test_local_projection_uses_left_positive_heading_and_public_odometry(heading, expected):
    runtime, calls = aim_runtime([region(), occupied()], right=30, forward=40, heading=heading)
    result = Actions(runtime).choose_release_aim()
    assert not result.get("error")
    assert result["position_m"] == pytest.approx(expected)
    assert calls == [(350, 250)]


@pytest.mark.parametrize("detections", [[], [region()],
    [region(), occupied(delivered=False)],
    [region(), occupied(category="blue-ball")]])
def test_no_current_delivered_red_leaves_original_place_aim_unchanged(detections):
    runtime, calls = aim_runtime(detections)
    assert Actions(runtime).choose_release_aim() is None
    assert calls == []


def test_aim_evidence_is_detached_from_later_sensor_mutation():
    runtime, _ = aim_runtime([region(), occupied()])
    result = Actions(runtime).choose_release_aim()
    before = copy.deepcopy(result)
    runtime.snapshot["perception"]["detections"][0]["bbox"]["x"] = 1
    runtime.snapshot["perception"]["detections"][1]["bbox"]["x"] = 2
    assert result == before


def aimed_place_runtime(*, projection=(.04, .30), lose_green=False, post_witness=True):
    runtime, motions, logs, objects, delivered = place_runtime([(18, 0)])
    snapshot = runtime.snapshot
    old = occupied()
    snapshot["perception"]["detections"] = [region(), old]
    calls, before_release = [], []

    def project(u, v):
        calls.append((u, v))
        if isinstance(projection, Exception):
            raise projection
        return projection

    runtime.perception.ground_camera = SimpleNamespace(project_pixel_to_ground=project)
    original_call, original_observe = runtime.bridge.call, runtime.observe

    def call(method, params):
        if method == "release":
            before_release.append(copy.deepcopy(snapshot["odometry"]))
        return original_call(method, params)

    def observe():
        original_observe()
        if snapshot["holding"]["holding"]:
            # This new green box is deliberately unrelated to the initial
            # quarter. Its distance/bearing would invite an immediate release.
            snapshot["perception"]["detections"] = ([] if lose_green else [
                {**region(x=410, y=310, w=60, h=40), "distance_cm": 18., "bearing_deg": 0.,
                 "frame_id": str(snapshot["observation"]["frameId"])}])
        elif not post_witness:
            snapshot["perception"]["detections"] = [region()]

    runtime.bridge.call, runtime.observe = call, observe
    return SimpleNamespace(runtime=runtime, motions=motions, logs=logs, objects=objects,
                           delivered=delivered, projections=calls, before_release=before_release)


def test_frozen_ground_aim_ignores_later_bbox_drift_and_keeps_original_release_gate():
    f = aimed_place_runtime()
    result = Actions(f.runtime).place()
    assert result["success"] is True
    assert len(f.projections) == 1
    assert len(f.before_release) == 1
    pose = f.before_release[0]
    dx, dz = .04 - pose["rightCm"] / 100, .30 - pose["forwardCm"] / 100
    gap_cm = math.hypot(dx, dz) * 100
    wanted_heading = math.degrees(math.atan2(-dx, dz))
    error = (wanted_heading - pose["headingDeg"] + 180) % 360 - 180
    assert gap_cm <= 19 + 1e-8
    assert abs(error) <= 3
    before_release = f.motions[:next(i for i, m in enumerate(f.motions) if m[0] == "release")]
    assert any(method == "turn" for method, _ in before_release)
    assert 1 <= sum(method == "forward" for method, _ in before_release) <= 8
    assert all(params["distanceCm"] <= 7 for method, params in before_release if method == "forward")
    assert f.objects["held"]["state"] == "DELIVERED"


def test_losing_current_green_during_aim_approach_keeps_ball_held():
    f = aimed_place_runtime(lose_green=True)
    result = Actions(f.runtime).place()
    assert result["success"] is False
    assert f.runtime.snapshot["holding"]["holding"] is True
    assert not f.before_release
    assert f.delivered == []


def test_invalid_projection_fails_before_any_motion_or_release():
    f = aimed_place_runtime(projection=ValueError("no observed ground"))
    result = Actions(f.runtime).place()
    assert result["success"] is False
    assert f.motions == []
    assert f.runtime.snapshot["holding"]["holding"] is True


@pytest.mark.parametrize("failure", ["clipped", "tied", "occupied"])
def test_no_safe_initial_pixel_aim_keeps_the_ball_held_without_motion(failure):
    f = aimed_place_runtime()
    detections = f.runtime.snapshot["perception"]["detections"]
    if failure == "clipped":
        detections[0]["bbox"]["x"] = 0
    elif failure == "tied":
        detections.append(region(x=410))
    else:
        detections.append(occupied(x=338, category="blue-ball", delivered=False))
    result = Actions(f.runtime).place()
    assert result["success"] is False
    assert f.motions == []
    assert f.projections == []
    assert f.runtime.snapshot["holding"]["holding"] is True
    assert f.objects["held"]["state"] == "HELD"


def test_fixed_aim_that_cannot_be_reached_in_eight_steps_does_not_release():
    f = aimed_place_runtime(projection=(.04, .60))
    original_call = f.runtime.bridge.call

    def partial_translation(method, params):
        before = copy.deepcopy(f.runtime.snapshot["odometry"])
        result = original_call(method, params)
        if method == "forward":
            # The actuator claims completion but the observed displacement is
            # just 1 cm. Requested distance cannot consume the remaining gap.
            theta = math.radians(before["headingDeg"])
            f.runtime.snapshot["odometry"].update(
                rightCm=before["rightCm"] - math.sin(theta),
                forwardCm=before["forwardCm"] + math.cos(theta))
        return result

    f.runtime.bridge.call = partial_translation
    result = Actions(f.runtime).place()
    assert result["success"] is False
    assert f.before_release == []
    forwards = [params for method, params in f.motions if method == "forward"]
    assert len(forwards) == 8
    assert all(0 < params["distanceCm"] <= 7 for params in forwards)
    assert sum(params["distanceCm"] for params in forwards) <= 56
    assert f.runtime.snapshot["holding"]["holding"] is True
    assert len(f.projections) == 1


def test_free_release_aim_does_not_replace_the_original_postrelease_pixel_witness():
    f = aimed_place_runtime(post_witness=False)
    result = Actions(f.runtime).place()
    assert len(f.before_release) == 1
    assert result["success"] is False
    assert result["evidence"]["candidate_witnesses"] == 0
    assert result["evidence"]["placement"] is None
    assert f.objects["held"]["state"] == "RELEASED_UNVERIFIED"


def test_no_delivered_pixels_retains_original_place_motion_sequence():
    runtime, motions, _, _, evidence = place_runtime([(18, 0)])
    runtime.perception.ground_camera = SimpleNamespace(
        project_pixel_to_ground=lambda *_: pytest.fail("no calibration needed for the original path"))
    result = Actions(runtime).place()
    assert result["success"] is True
    assert [method for method, _ in motions] == ["release", "backward"]
    assert evidence[0]["post_observation"] == 3
