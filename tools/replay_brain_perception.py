#!/usr/bin/env python3
"""Reproduce a sensor-only WorldModel replay and native sensor-range comparison.

Historical inputs also contain evaluator truth. Only returned camera_parameters,
odometry and observe calls are selected for WorldModel. The native detector's
distance/bearing are used exclusively by the separate formula comparator.
Missing same-tick odometry is reported and never replaced by scene samples.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(os.environ.get("WORLD_MODEL_ROOT", ROOT / "vendor/wm_kit_opt2"))))
sys.path.insert(0, str(ROOT))
from autonomous_brain.perception import Perception, VERSION as PERCEPTION_VERSION

VERSION = "replay-brain-perception/v1"
CATEGORIES = ("red-ball", "blue-ball", "obstacle", "storage-zone")


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def relative(path):
    return str(path.resolve().relative_to(ROOT))


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n")


def replay(source, destination):
    destination.mkdir(parents=True, exist_ok=False)
    record_path, capture_path = source / "record.json", source / "captures.json"
    record = json.loads(record_path.read_text())
    # Deliberately do not read native.samples, taskDefinition, truthObjects,
    # cameraPose.matrixWorld, road truth or any layout coordinate.
    sensor_calls = [(call["method"], call["outcome"]["result"])
                    for call in record["calls"]
                    if call["method"] in {"camera_parameters", "odometry", "observe"}
                    and call["outcome"].get("status") == "returned"]
    step_ms = record["clock"]["stepMs"]
    camera = next(value for method, value in sensor_calls if method == "camera_parameters")
    odometry = {}
    for method, value in sensor_calls:
        if method != "odometry":
            continue
        tick = value["tick"]
        if tick in odometry and odometry[tick] != value:
            raise ValueError(f"Conflicting sensor odometry at tick {tick}")
        odometry[tick] = value
    observations = [value for method, value in sensor_calls if method == "observe"]
    captures = json.loads(capture_path.read_text())
    native_by_frame = {str(capture["frameId"]): capture["rawDetections"] for capture in captures}
    # Discard the source objects, which contain evaluator-only data.
    del record, captures

    converter = Perception(camera)
    comparisons = []
    for observation in observations:
        raw = native_by_frame[str(observation["frameId"])]
        available = list(enumerate(raw))
        for item in observation["detections"]:
            if item["category"] not in {"red-ball", "blue-ball"}:
                continue
            native_category = "target" if item["category"] == "red-ball" else "distractor"
            matched = None
            for index, candidate in available:
                if candidate.get("category") != native_category or candidate.get("source") != item["source"]:
                    continue
                box = candidate["box"]
                x, y = max(0, box["x"]), max(0, box["y"] - 80)
                expected = {"x": x, "y": y,
                            "w": min(640, box["x"] + box["width"]) - x,
                            "h": min(480, box["y"] + box["height"] - 80) - y}
                if expected == item["bbox"] and candidate["confidence"] == item["confidence"]:
                    matched = (index, candidate)
                    break
            if matched is None:
                raise ValueError(f"No matching native detector rectangle at frame {observation['frameId']}")
            index, native = matched
            available = [(i, value) for i, value in available if i != index]
            # Pure local pixel conversion; no native range or world pose is
            # passed to the converter or to the replay WorldModel.
            _, estimate = converter._convert(item, str(observation["frameId"]), 0)
            native_distance = math.floor(native["distance"] * 12.5 + 0.5)
            native_bearing = native["bearingDeg"]
            comparisons.append({"frame_id": observation["frameId"], "tick": observation["tick"],
                "category": item["category"], "source": item["source"], "bbox": item["bbox"],
                "native_distance_cm": native_distance, "native_bearing_deg": native_bearing,
                "reconstructed_distance_cm": estimate["raw_distance_cm"],
                "reconstructed_bearing_deg": estimate["raw_bearing_deg"],
                "distance_identical": native_distance == estimate["raw_distance_cm"],
                "bearing_identical": native_bearing == estimate["raw_bearing_deg"]})

    model = Perception(camera)
    missing, frames = [], []
    seen_counts, fed_counts = Counter(), Counter()
    sensor_path = destination / "sensor-inputs.jsonl"
    output_path = destination / "world-model-frames.jsonl"
    with sensor_path.open("w") as sensor_log, output_path.open("w") as output_log:
        sensor_log.write(json.dumps({"camera_parameters": camera, "step_ms": step_ms}) + "\n")
        for frame_index, observation in enumerate(observations):
            if observation["tick"] not in odometry:
                missing.append({"frame_id": observation["frameId"], "tick": observation["tick"],
                                "reason": "same_tick_odometry_not_recorded"})
                continue
            payload = {"observation": observation, "odometry": odometry[observation["tick"]],
                       "simulation_time_s": observation["tick"] * step_ms / 1000,
                       "round_index": frame_index + 1}
            sensor_log.write(json.dumps(payload, ensure_ascii=False, allow_nan=False) + "\n")
            evidence = model.update(**payload)
            output_log.write(json.dumps({"evidence": evidence, "objects": model.objects()},
                                        ensure_ascii=False, allow_nan=False) + "\n")
            for detection in evidence["detections"]:
                seen_counts[detection["category"]] += 1
                fed_counts[detection["category"]] += bool(detection["fed_to_world_model"])
            frames.append(observation["frameId"])

    timeline, objects = model.timeline(), {row["id"]: row for row in model.objects()}
    categories = {}
    for category in CATEGORIES:
        selected = [row for row in timeline if row["category"] == category]
        first = min(selected, key=lambda row: row["first_seen_s"], default=None)
        comparisons_for_class = [row for row in comparisons if row["category"] == category]
        categories[category] = {
            "detections_in_replayed_frames": seen_counts[category],
            "detections_fed_to_world_model": fed_counts[category],
            "tracks_created": len(selected),
            "ever_confirmed_tracks": sum(row["confirmed_s"] is not None for row in selected),
            "first_world_model_entry": None if first is None else {
                "object_id": first["object_id"], "simulation_time_s": first["first_seen_s"],
                "frame_id": first["accepted_hit_poses"][0]["frame_id"]},
            "range_comparison_samples": len(comparisons_for_class),
            "range_comparison_mismatches": sum(not row["distance_identical"] or not row["bearing_identical"]
                                               for row in comparisons_for_class),
        }
    red_tracks = []
    for row in timeline:
        if row["category"] != "red-ball":
            continue
        poses = row["accepted_hit_poses"]
        gaps = [math.hypot(a["x_m"] - b["x_m"], a["z_m"] - b["z_m"])
                for i, a in enumerate(poses) for b in poses[i + 1:]]
        red_tracks.append(dict(row, hit_count=len(poses), final_state=objects[row["object_id"]]["state"],
            spatial_span_m=max(gaps, default=0), minimum_pairwise_gap_m=min(gaps, default=None),
            temporal_span_s=poses[-1]["simulation_time_s"] - poses[0]["simulation_time_s"],
            three_independent_views=len(poses) >= 3 and min(gaps, default=0) >= .15))
    summary = {"version": VERSION, "perception_version": PERCEPTION_VERSION,
        "source_directory": relative(source), "world_model_main_commit": "fef0ba9b754ce9652836fdb720d1162dcadbc5ef",
        "input_sha256": {relative(path): sha(path) for path in (record_path, capture_path)},
        "implementation_sha256": {relative(path): sha(path) for path in (
            ROOT / "tools/replay_brain_perception.py", ROOT / "autonomous_brain/perception.py")},
        "observations_total": len(observations), "observations_replayed": len(frames),
        "observations_missing_same_tick_odometry": len(missing), "missing_odometry": missing,
        "scope": "Partial sensor-only replay; missing odometry is never replaced with truth or inferred motion.",
        "world_model_inputs": ["camera_parameters", "observe", "same-tick odometry", "simulation tick step"],
        "native_range_use": "Evaluation comparison only; never passed to Perception.update.",
        "categories": categories, "red_tracks": red_tracks,
        "range_comparison_count": len(comparisons),
        "range_comparison_mismatches": sum(not row["distance_identical"] or not row["bearing_identical"]
                                          for row in comparisons),
        "range_comparison_complete": all(row["distance_identical"] and row["bearing_identical"] for row in comparisons),
        "artifacts": {path.name: sha(path) for path in (sensor_path, output_path)}}
    dump(destination / "range-comparison.json", comparisons)
    dump(destination / "summary.json", summary)
    lines = [f"# 感知离线复放（{PERCEPTION_VERSION}）", "",
        f"输入：`{relative(source)}`。WorldModel 仅接收桥相机检测、相机参数、同 tick 里程计和仿真时间。", "",
        f"共 {len(observations)} 帧；可复放 {len(frames)} 帧，{len(missing)} 帧缺少同 tick 里程计。缺失帧清单见 `summary.json`，没有用 samples 真值补齐。", "",
        "| 类别 | 首次入库帧 / 仿真秒 | 建轨数 | 曾 CONFIRMED |", "|---|---:|---:|---:|"]
    for category, value in categories.items():
        first = value["first_world_model_entry"]
        label = "无" if first is None else f"{first['frame_id']} / {first['simulation_time_s']:.2f}"
        lines.append(f"| {category} | {label} | {value['tracks_created']} | {value['ever_confirmed_tracks']} |")
    lines += ["", f"红蓝测距对照覆盖全部 {len(observations)} 帧中的 {len(comparisons)} 条检测；距离/方位不一致 {summary['range_comparison_mismatches']} 条。对照原生检测器读数只用于评测，未喂给 WorldModel。", "",
              "| 红球轨迹 | 命中数 | 位姿最小间距 m | 空间跨度 m | 时间跨度 s | 确认时间 s |", "|---|---:|---:|---:|---:|---:|"]
    for row in red_tracks:
        gap = "—" if row["minimum_pairwise_gap_m"] is None else f"{row['minimum_pairwise_gap_m']:.6f}"
        confirmed = "未确认" if row["confirmed_s"] is None else f"{row['confirmed_s']:.2f}"
        lines.append(f"| {row['object_id']} | {row['hit_count']} | {gap} | {row['spatial_span_m']:.6f} | {row['temporal_span_s']:.2f} | {confirmed} |")
    lines += ["", "这里的首次入库不是摄像头首次看到。轨迹可能随后衰减；曾确认数量不代表当前仍确认，也不保证轨迹等于独立实体。", "",
              f"复现：`python3 tools/replay_brain_perception.py --input {relative(source)} --out artifacts/autonomous-brain/perception-replay/new-run`。", "",
              "`sensor-inputs.jsonl` 是剥离评测数据后的唯一复放输入；`world-model-frames.jsonl` 保存逐帧证据和模型状态；`range-comparison.json` 保存所有原生/复原读数，`summary.json` 保存计数、红球命中位姿和 SHA256。"]
    (destination / "REPORT.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({key: summary[key] for key in ("perception_version", "observations_total", "observations_replayed",
        "observations_missing_same_tick_odometry", "categories", "range_comparison_count", "range_comparison_mismatches")}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "artifacts/inloop/v4/stage-1/restore-20260925/acceptance-02/map-05-run-1")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    replay(args.input.resolve(), args.out.resolve())


if __name__ == "__main__":
    main()
