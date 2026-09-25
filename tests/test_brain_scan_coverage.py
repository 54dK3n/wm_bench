"""Offline angular coverage and unchanged independent-position confirmation."""
import copy
import math
from types import SimpleNamespace

import pytest

from autonomous_brain.actions import Actions
from autonomous_brain.navigation import wrap
from autonomous_brain.perception import Perception
from test_brain_perception import CAMERA, ball


def scan_runtime(initial_heading=0, target_heading=None):
    """A stationary robot with synthetic public pixel detections and odometry."""
    perception = Perception(CAMERA)
    headings, motions = [], []
    runtime = SimpleNamespace(perception=perception, round=1, config={"task": "观察环境"},
        bridge=SimpleNamespace(seconds=0, max_seconds=1200),
        motion_log=SimpleNamespace(write=lambda row: None))
    odometry = {"tick": 0, "forwardCm": 0, "rightCm": 0, "headingDeg": initial_heading,
                "distanceCm": 0}
    half_fov = math.degrees(math.atan(CAMERA["width"] / 2 / CAMERA["fx"]))

    def observe():
        odometry["tick"] += 1
        runtime.bridge.seconds = odometry["tick"] * .02
        bearing = wrap(odometry["headingDeg"] - target_heading) if target_heading is not None else None
        detections = [ball(80, bearing=bearing)] if bearing is not None and abs(bearing) <= half_fov else []
        observation = {"frameId": str(odometry["tick"]), "tick": odometry["tick"],
                       "width": CAMERA["width"], "height": CAMERA["height"], "detections": detections}
        evidence = perception.update(observation, odometry,
            simulation_time_s=runtime.bridge.seconds, round_index=runtime.round)
        runtime.snapshot = {"observation_index": odometry["tick"], "odometry": copy.deepcopy(odometry),
            "observation": observation, "holding": {"holding": False}, "perception": evidence,
            "objects": perception.objects(),
            "road": {"onRoad": True, "headingErrorDeg": 0, "frontClearanceCm": 100}}
        headings.append(odometry["headingDeg"])

    def call(method, params):
        assert method == "turn", "stationary scan must never translate"
        motions.append((method, copy.deepcopy(params)))
        odometry["headingDeg"] = wrap(odometry["headingDeg"] + params["angleDeg"])
        return {"completed": True}

    runtime.observe, runtime.bridge.call = observe, call
    observe()
    return runtime, headings, motions


@pytest.mark.parametrize("initial", [0, 17.3, 158.2, -179.9])
def test_observed_endpoints_cover_the_whole_admitted_circle_and_preserve_cardinals(initial):
    runtime, headings, motions = scan_runtime(initial)
    outcome = Actions(runtime).look_around()
    endpoints = sorted((heading - initial) % 360 for heading in headings[1:])
    gaps = [right - left for left, right in zip(endpoints, endpoints[1:] + [endpoints[0] + 360])]
    horizontal_fov = math.degrees(2 * math.atan(CAMERA["width"] / 2 / CAMERA["fx"]))
    admitted_width = min(horizontal_fov, 2 * 35)
    # This maximum circular-gap bound covers every angle, not merely a sampled grid.
    assert max(gaps) <= admitted_width
    for previously_missed in (35.1, 40, 45, 50, 54.9, 125.1, 135, 144.9,
                              215.1, 225, 234.9, 305.1, 315, 324.9):
        assert min(abs(wrap(endpoint - previously_missed)) for endpoint in endpoints) <= 35
    assert len(endpoints) == len(motions) == 8
    assert gaps == pytest.approx([45] * 8)
    for cardinal in (0, 90, 180, 270):
        assert min(abs(wrap(endpoint - cardinal)) for endpoint in endpoints) < 1e-8
    assert wrap(headings[-1] - initial) == pytest.approx(0, abs=1e-8)
    assert runtime.snapshot["observation_index"] == 9
    assert outcome["success"] is True and outcome["reason"] == "full_circle_views_observed"
    assert outcome["evidence"]["reobservation_candidate"] is None
    assert all(params["speed"] == 50 for _, params in motions)


@pytest.mark.parametrize("target_heading", [35.1, 45, 54.9])
def test_diagonal_public_detections_enter_memory_without_extra_confirmation(target_heading):
    runtime, headings, _ = scan_runtime(target_heading=target_heading)
    assert runtime.perception.objects() == []
    outcome = Actions(runtime).look_around()
    rows = runtime.perception.objects()
    assert len(rows) == 1, "a detection between old cardinal views must receive an admitted view"
    assert rows[0]["id"] in outcome["evidence"]["new_object_ids"]
    assert rows[0]["category"] == "red-ball" and rows[0]["state"] == "TENTATIVE"
    assert rows[0]["hit_count"] == 1
    assert len(rows[0]["hit_poses"]) == 1
    assert wrap(headings[-1]) == pytest.approx(0)


def test_repeated_stationary_complete_scans_cannot_replace_three_distinct_positions():
    runtime, _, _ = scan_runtime(target_heading=0)
    object_id = runtime.perception.objects()[0]["id"]
    for _ in range(3):
        Actions(runtime).look_around()
        row = runtime.perception.get_object(object_id)
        assert row["state"] == "TENTATIVE" and row["hit_count"] == 1
        assert len(row["hit_poses"]) == 1
        assert runtime.perception.confirmed(object_id) is None
    assert runtime.perception.wm.assoc_cfg.min_hit_pose_gap_m == .15
    assert runtime.perception.wm.decay_cfg.confirm_hits == 3
    assert runtime.perception.timeline()[0]["confirmed_s"] is None
