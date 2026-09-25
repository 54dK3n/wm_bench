#!/usr/bin/env python3
"""Recompute Run17 aiming drift from public camera/odometry records only."""
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "vendor/wm_kit_opt2"))
from autonomous_brain.navigation import heading_to, wrap
from autonomous_brain.perception import Perception


def main():
    brain = ROOT / "artifacts/autonomous-brain/map05-run-17/map-05-run-1/brain"
    observations = brain / "observations.jsonl"
    bridge = brain / "bridge-calls.jsonl"
    with bridge.open() as handle:
        camera_record = next(json.loads(line) for line in handle
                             if json.loads(line)["request"]["method"] == "camera_parameters")
    camera = camera_record["terminal"]["result"]
    calibration = Perception(camera).ground_camera
    frames = {}
    with observations.open() as handle:
        for line in handle:
            row = json.loads(line)
            if 211 <= row["observation_index"] <= 226:
                frames[row["observation_index"]] = row
    selected = lambda row: min((d for d in row["perception"]["detections"]
                               if d["category"] == "storage-zone" and "distance_cm" in d),
                              key=lambda d: d["distance_cm"])
    first = selected(frames[211])
    box = first["bbox"]
    u, v = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    local_x, local_z = calibration.project_pixel_to_ground(u, v)
    odo = frames[211]["odometry"]
    theta = math.radians(odo["headingDeg"])
    frozen = (odo["rightCm"] / 100 + math.cos(theta) * local_x - math.sin(theta) * local_z,
              odo["forwardCm"] / 100 + math.sin(theta) * local_x + math.cos(theta) * local_z)
    assert math.dist(frozen, (first["position_m"]["x"], first["position_m"]["z"])) < 1e-12
    rows = []
    for index, row in frames.items():
        d = selected(row)
        box, odo = d["bbox"], row["odometry"]
        p = (odo["rightCm"] / 100, odo["forwardCm"] / 100)
        dynamic = (d["position_m"]["x"], d["position_m"]["z"])
        rows.append({"observation_index": index, "odometry": odo, "selected_bbox": box,
                     "selected_bbox_track_id": d["track_id"],
                     "complete_bbox": (box["x"] > 0 and box["y"] > 0
                         and box["x"] + box["w"] < 640 and box["y"] + box["h"] < 480),
                     "dynamic_position_m": d["position_m"],
                     "dynamic_distance_cm": d["distance_cm"], "dynamic_bearing_deg": d["bearing_deg"],
                     "dynamic_target_drift_cm": math.dist(frozen, dynamic) * 100,
                     "frozen_distance_at_actual_pose_cm": math.dist(frozen, p) * 100,
                     "frozen_bearing_at_actual_pose_deg": wrap(odo["headingDeg"] - heading_to(p, frozen))})
    detection = next(d for d in frames[226]["perception"]["detections"] if d["category"] == "red-ball")
    zone = selected(frames[226])
    ball, box = detection["bbox"], zone["bbox"]
    bx, by = ball["x"] + ball["w"] / 2, ball["y"] + ball["h"]
    ellipse = ((bx - box["x"] - box["w"] / 2) / (box["w"] / 2)) ** 2 + (
        (by - box["y"] - box["h"] / 2) / (box["h"] / 2)) ** 2
    print(json.dumps({"scope": "public_sensor_aim_drift_only", "camera_parameters": camera,
        "source_sha256": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in (observations, bridge)},
        "initial_pixel": {"u": u, "v": v}, "frozen_position_m": {"x": frozen[0], "z": frozen[1]},
        "rows": rows, "postrelease_observation": 226, "ball_bottom_center": {"u": bx, "v": by},
        "postrelease_ellipse_value": ellipse, "unchanged_ellipse_limit": .64,
        "original_witness_passes": ellipse <= .64, "counterfactual_simulation_performed": False,
        "physical_containment_claimed": False}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
