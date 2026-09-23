"""在环层评估（测试侧）：布局识别、位姿换算、1.2/1.3 方位角、2.1 定位误差。

只使用平台公开返回（observe/odometry）与测试侧真值。被测 WorldModel 通过
tests.acceptance.harness 的公开 API 路径回放。
"""
from __future__ import annotations

import json
import math
import os
import statistics
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

def _default_world_model_root() -> Path:
    package_root = Path(__file__).resolve().parents[1]
    if (package_root / "world_model").is_dir():
        return package_root
    return Path.home() / "wm_kit"


WM_KIT = Path(os.environ.get("WORLD_MODEL_ROOT", str(_default_world_model_root())))
if str(WM_KIT) not in sys.path:
    sys.path.insert(0, str(WM_KIT))

from tests.acceptance import truth as truth_mod  # noqa: E402
from tests.acceptance.truth import Layout, TruthObject, PHYSICAL_RADIUS_M, world_to_wm  # noqa: E402

HALF_FOV_DEG = 37.6
from metrics import summarize_localization  # noqa: E402
PHYSICAL_WIDTH_M = {"target": 0.44, "distractor": 0.44, "obstacle": 0.46, "storage-zone": 0.38}


# ---------------------------------------------------------------- 布局识别 / 构造

def layout_from_map_config(task_id: str, config_body: dict) -> Tuple[Layout, Optional[str]]:
    """由队伍获配的 map-config 布局构造真值 Layout；同时识别它对应地图池中的哪一套（无则 None）。"""
    layout = config_body["layout"]
    ref = truth_mod.load_layout(task_id, truth_mod.list_map_ids(task_id)[0])
    start, units = ref.start, ref.units_per_meter
    objects: List[TruthObject] = []
    counters: Dict[str, int] = {}

    def push(cls: str, p: Sequence[float]) -> None:
        x, z = world_to_wm(start, units, p)
        idx = counters.get(cls, 0)
        counters[cls] = idx + 1
        objects.append(TruthObject(cls=cls, x=x, z=z, radius_m=PHYSICAL_RADIUS_M[cls], physical_width_m=PHYSICAL_WIDTH_M[cls],
                                   world=(float(p[0]), float(p[1])), index=idx))

    for p in layout.get("targets", []):
        push("target", p)
    for p in layout.get("distractors", []):
        push("distractor", p)
    for p in layout.get("obstacles", []):
        push("obstacle", p)
    if layout.get("storage"):
        push("storage-zone", layout["storage"])
    checkpoints = tuple(world_to_wm(start, units, p) for p in layout.get("checkpoints", []))
    matched = None
    for map_id in truth_mod.list_map_ids(task_id):
        cand = truth_mod.load_layout(task_id, map_id)
        same = len(cand.objects) == len(objects) and all(
            any(abs(a.world[0] - b.world[0]) < 1e-3 and abs(a.world[1] - b.world[1]) < 1e-3 and a.cls == b.cls for b in cand.objects)
            for a in objects)
        if same:
            matched = map_id
            break
    return Layout(task_id=task_id, map_id=matched or "unmatched", start=dict(start), units_per_meter=units,
                  objects=tuple(objects), checkpoints=checkpoints), matched


def pose_from_odometry(odom: dict) -> Tuple[float, float, float]:
    """平台 odometry -> 起点帧 (x 右, z 前, theta 右转为正)。经探针实测：headingDeg 左转为正，rightCm 右为正。"""
    return float(odom["rightCm"]) / 100.0, float(odom["forwardCm"]) / 100.0, -math.radians(float(odom["headingDeg"]))


def predicted_bearing_distance(pose: Tuple[float, float, float], obj: TruthObject, camera_forward_m: float = 0.0) -> Tuple[float, float]:
    x, z, theta = pose
    fx, fz = math.sin(theta), math.cos(theta)
    rx, rz = math.cos(theta), -math.sin(theta)
    cx, cz = x + fx * camera_forward_m, z + fz * camera_forward_m
    ox, oz = obj.x - cx, obj.z - cz
    fwd = ox * fx + oz * fz
    right = ox * rx + oz * rz
    return math.degrees(math.atan2(right, fwd)), math.hypot(fwd, right)


# ---------------------------------------------------------------- 1.2 / 1.3

def evaluate_bearing(result: dict, layout: Layout, camera_forward_m: float = 0.0) -> dict:
    """1.2：对每个 (帧, 视野内真值物体) 取同类检测中方位最接近的一个，误差 = |测量 - 真值|。
    平台会把一个实体拆成多个区域（障碍物条纹），因此按检测逐条匹配会把拆分区域的偏差算进来；
    per_detection 字段保留逐检测统计供参考。1.3：对全部检测检查 direction 与 bearing 的一致性。"""
    samples, missed, per_detection = [], [], []
    for line in result["lines"]:
        if "odometry" not in line:
            continue
        pose = pose_from_odometry(line["odometry"])
        for obj in layout.objects:
            b, d = predicted_bearing_distance(pose, obj, camera_forward_m)
            if d > 3.0 or abs(b) > HALF_FOV_DEG - 4.0:
                continue
            # 候选：同类、距离比在 [0.5, 2.0]、方位差 ≤ 12°（更远的不是同一实体，计为漏检/纹理伪检测）
            cands = [o for o in line["observe"] if o["category"] == obj.cls and 0.5 <= (o["distanceCm"] / 100.0) / d <= 2.0
                     and abs(o["bearingDeg"] - b) <= 12.0]
            if not cands:
                missed.append({"step": line.get("step"), "truth": obj.oid, "truth_bearing": round(b, 2), "truth_m": round(d, 2)})
                continue
            best = min(cands, key=lambda o: abs(o["bearingDeg"] - b))
            samples.append({"step": line.get("step"), "truth": obj.oid, "measured": best["bearingDeg"], "truth_bearing": round(b, 3),
                            "error": round(abs(best["bearingDeg"] - b), 3), "distance_cm": best["distanceCm"], "truth_m": round(d, 3),
                            "direction": best["direction"], "n_candidates": len(cands)})
        for o in line["observe"]:
            best = None
            for obj in layout.of(o["category"]):
                b, d = predicted_bearing_distance(pose, obj, camera_forward_m)
                if d > 8.5 or abs(b) > HALF_FOV_DEG + 10:
                    continue
                err = abs(b - o["bearingDeg"])
                if best is None or err < best:
                    best = err
            per_detection.append({"step": line.get("step"), "cls": o["category"], "measured": o["bearingDeg"], "distance_cm": o["distanceCm"],
                                  "nearest_truth_error": round(best, 2) if best is not None else None})
    errors = [s["error"] for s in samples]
    consistency = []
    for line in result["lines"]:
        for obs in line.get("observe", []):
            b = obs["bearingDeg"]
            expected = "中间" if abs(b) <= 7.0 else ("左" if b < 0 else "右")
            consistency.append({"bearing": b, "direction": obs["direction"], "ok": obs["direction"] == expected})
    unmatched = [d for d in per_detection if d["nearest_truth_error"] is None or d["nearest_truth_error"] > 12]
    return {
        "camera_forward_m": camera_forward_m,
        "samples": samples, "missed": missed, "per_detection": per_detection, "unmatched": unmatched,
        "n_samples": len(samples), "max_error_deg": max(errors) if errors else None,
        "median_error_deg": statistics.median(errors) if errors else None,
        "n_over_1_5": sum(1 for e in errors if e > 1.5),
        "consistency": consistency,
        "n_center": sum(1 for c in consistency if abs(c["bearing"]) <= 7.0),
        "consistency_conflicts": [c for c in consistency if not c["ok"]],
    }


# ---------------------------------------------------------------- 2.1 定位误差（回放）

def frames_from_result(result: dict, heading_sign: float = 1.0):
    """heading_sign=-1 为诊断用：把平台 headingDeg 取反后再送入 provider（绕过 D1 航向符号缺陷）。"""
    from tests.acceptance.synth import Frame, Pose
    frames = []
    for i, line in enumerate(result["lines"]):
        if "odometry" not in line:
            continue
        # 用 tick 换算时间（20 ms/tick）
        t = float(line["odometry"].get("tick", i * 25)) * 0.02
        x, z, theta = pose_from_odometry(line["odometry"])
        odom = dict(line["odometry"])
        if heading_sign < 0:
            odom["headingDeg"] = -float(odom["headingDeg"])
        frames.append(Frame(index=i, t=t, observe=line["observe"], odometry=odom,
                            true_pose=Pose(x, z, theta), odom_pose=Pose(x, z, theta), events=[line.get("tag", "")]))
    return frames


def evaluate_localization(result: dict, layout: Layout, mutation: Optional[str] = None, heading_sign: float = 1.0,
                          artifact_filter=None, distance_scale_by_class=None) -> dict:
    from tests.acceptance import harness
    frames = frames_from_result(result, heading_sign)
    if not frames:
        return {"frames": 0, "duration_s": 0, "confirmed_tracks": 0, "errors_cm": [], "median_cm": None, "p90_cm": None,
                "matched_tracks": 0, "ghost_tracks": 0, "matched_median_cm": None, "matched_p90_cm": None,
                "active_counts": {}, "expected_counts": layout.counts(), "splits": 0, "merges": 0, "final_tracks": [],
                "invalid_sample": True, "confirmed_errors_cm": [], "matched_errors_cm": [],
                "d5_filtered_detections": 0, "error": "该局没有采到任何帧（程序未启动或运行失败）"}
    wm = harness.build_world_model(mutation=mutation)
    log = harness.run_wm(frames, wm, artifact_filter=artifact_filter, distance_scale_by_class=distance_scale_by_class)
    classify = harness.make_track_classifier(harness.probe_class_names(harness.build_world_model))
    confirmed_tracks = [t for t in log.frames[-1].tracks if t.state == harness.ObjectState.CONFIRMED]
    truth_to_tracks, track_to_truths = harness.truth_associations(log, layout, classify, harness.match_radius(layout))
    matched_ids = set(track_to_truths.keys())
    confirmed_errors = []
    matched_errors = []
    for track in confirmed_tracks:
        cls = classify(track)
        nearest = layout.nearest(cls, track.x, track.z) if cls else None
        if nearest is None:
            continue
        error_m = nearest.dist(track.x, track.z)
        if not math.isfinite(error_m):
            continue
        error_cm = error_m * 100.0
        confirmed_errors.append(error_cm)
        if str(track.obj_id) in matched_ids:
            matched_errors.append(error_cm)
    summary = summarize_localization(confirmed_errors, matched_errors)
    counts = harness.count_active_by_class(log, classify)
    return {
        "matched_tracks": summary["matched_tracks"],
        "ghost_tracks": len(confirmed_tracks) - summary["matched_tracks"],
        "matched_median_cm": round(summary["matched_median_cm"], 1) if summary["matched_median_cm"] is not None else None,
        "matched_p90_cm": round(summary["matched_p90_cm"], 1) if summary["matched_p90_cm"] is not None else None,
        "frames": len(frames), "duration_s": frames[-1].t if frames else 0,
        "confirmed_tracks": len(confirmed_tracks),
        "errors_cm": [round(v, 1) for v in confirmed_errors],
        "confirmed_errors_cm": [round(v, 1) for v in confirmed_errors],
        "matched_errors_cm": [round(v, 1) for v in matched_errors],
        "median_cm": round(summary["median_cm"], 1) if summary["median_cm"] is not None else None,
        "p90_cm": round(summary["p90_cm"], 1) if summary["p90_cm"] is not None else None,
        "active_counts": counts, "expected_counts": layout.counts(),
        "d5_filtered_detections": artifact_filter.filtered_total if artifact_filter is not None else 0,
        "splits": harness.split_count(truth_to_tracks), "merges": harness.merge_count(track_to_truths),
        "final_tracks": [{"id": t.obj_id, "cls": classify(t), "x": round(t.x, 2), "z": round(t.z, 2), "state": t.state.value, "conf": round(t.confidence, 2)} for t in log.frames[-1].tracks],
        "invalid_sample": len(confirmed_tracks) == 0,
    }
