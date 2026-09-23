#!/usr/bin/env python3
"""Offline truth diagnostics for task-2 observe frames; never imported by a task.

python3 tools/vision_diagnostics.py artifacts/inloop/v29_batch \
    --reference-batch artifacts/inloop/v28r1_batch

Uses native query evidenceId/frameId bindings, original PNG hashes, and recorder
samples. Geometry is planar range/bearing from the camera, 5.375 cm ahead of the
vehicle centre. Flags are requests for image inspection, not proof of visibility
through terrain/occlusion. No trial or camera query is executed by this tool.
"""
import argparse
import hashlib
import html
import json
import math
from pathlib import Path
import re

CM_PER_UNIT = 12.5
CAMERA_FORWARD_CM = 5.375
TASK_ID = "R2-GYI-MVP-02"


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def angular_gap(a, b):
    return abs((a - b + 180) % 360 - 180)


def sample_at(samples, tick, seq=None):
    # A later sample can already include the turn commanded *after* observe.
    # Never use numerical tick proximity to cross that causal boundary.
    before = [s for s in samples if s["tick"] <= tick
              and (seq is None or s["seq"] <= seq)]
    if before:
        sample = max(before, key=lambda s: (s["tick"], s["seq"]))
        match = "exact_tick_before_frame" if sample["tick"] == tick else f"preceding_tick:{sample['tick'] - tick:+d}"
        return sample, match
    exact = [s for s in samples if s["tick"] == tick]
    if exact:
        return min(exact, key=lambda s: s["seq"]), "exact_tick_after_frame"
    sample = min(samples, key=lambda s: (abs(s["tick"] - tick), s["tick"] > tick, -s["seq"]))
    return sample, f"nearest_tick:{sample['tick'] - tick:+d}"


def camera_truth(sample, render_camera=None):
    heading = sample["heading"]
    fx, fz, rx, rz = -math.sin(heading), -math.cos(heading), math.cos(heading), -math.sin(heading)
    offset = CAMERA_FORWARD_CM / CM_PER_UNIT
    cx, cz = sample["x"] + offset * fx, sample["z"] + offset * fz
    if render_camera:
        cx, _, cz = render_camera["world"]
        camera_forward, camera_right = render_camera["forward"], render_camera["right"]
        forward_norm = math.hypot(camera_forward[0], camera_forward[2])
        right_norm = math.hypot(camera_right[0], camera_right[2])
        fx, fz = camera_forward[0] / forward_norm, camera_forward[2] / forward_norm
        rx, rz = camera_right[0] / right_norm, camera_right[2] / right_norm
        heading = math.atan2(-fx, -fz)
    targets = []
    for target in sample.get("packages", []):
        if target.get("role") != "target" or target.get("id") == sample.get("holding"):
            continue
        dx, dz = target["x"] - cx, target["z"] - cz
        forward, right = (dx * fx + dz * fz) * CM_PER_UNIT, (dx * rx + dz * rz) * CM_PER_UNIT
        targets.append({"id": target["id"], "world": [target["x"], target["z"]],
                        "camera_range_cm": math.hypot(forward, right),
                        "camera_bearing_deg": math.degrees(math.atan2(right, forward)),
                        "camera_forward_cm": forward, "camera_right_cm": right})
    return {"world": [cx, cz], "heading_rad": heading, "forward_offset_cm": CAMERA_FORWARD_CM,
            "origin_source": "native_render_matrixWorld" if render_camera else "recorder_sample_plus_mount_offset",
            **({"render_camera": render_camera} if render_camera else {})}, targets


def raw_reds(raw):
    return [d for d in raw if d.get("category") == "target"]


def red_blue_fields(raw):
    return [{key: item.get(key) for key in ("category", "distanceCm", "bearingDeg", "confidence")}
            for item in raw if item.get("category") in ("target", "distractor")]


def classify(raw, targets):
    reds = raw_reds(raw)
    should_be_visible = [t for t in targets if 30 <= t["camera_range_cm"] <= 85
                         and abs(t["camera_bearing_deg"]) <= 30]
    false_reds = []
    for detection in reds:
        bearing = detection.get("bearingDeg")
        if bearing is None:
            continue
        gaps = [angular_gap(float(bearing), t["camera_bearing_deg"]) for t in targets]
        if not gaps or min(gaps) > 3.0:
            false_reds.append({"detection": detection, "nearest_true_red_bearing_gap_deg": min(gaps) if gaps else None})
    return {"expected_but_missing": bool(should_be_visible and not reds),
            "expected_targets": should_be_visible, "false_red_candidates": false_reds}


def analyse(path):
    result = load(path)
    if result.get("taskId") != TASK_ID:
        raise ValueError(f"Only task 2 evidence is allowed: {path}")
    sample_path = path.with_suffix(".samples.json")
    if not sample_path.exists():
        sample_path = Path(result["samplesFile"])
    samples = load(sample_path)
    observes = [line for line in result.get("lines", []) if line.get("event") == "observe"]
    archive_path = Path(result.get("visionEvidenceFile") or path.with_suffix(".vision.json"))
    archive = load(archive_path) if archive_path.exists() else None
    queries = sorted([q for q in archive.get("queries", []) if q.get("method") == "observe"], key=lambda q: q["seq"]) if archive else []
    frames = {f["evidenceId"]: f for f in archive.get("frames", [])} if archive else {}
    render_truths = {t["evidenceId"]: t for t in ((archive or {}).get("renderTruth") or {}).get("frames", [])
                    if t["runId"] == archive.get("runId")}
    if archive and archive.get("taskId") != TASK_ID:
        raise ValueError(f"Vision archive is not task 2: {archive_path}")
    rows, problems = [], []
    frame_files = {}
    for evidence_id, frame in frames.items():
        image_path = archive_path.parent / frame["image"]
        payload = image_path.read_bytes() if image_path.exists() else None
        verified = payload is not None and hashlib.sha256(payload).hexdigest() == frame["sha256"]
        frame_files[evidence_id] = {"image": str(image_path.resolve()), "bytes": len(payload) if payload else 0,
                                    "verified": verified}
        if not verified:
            problems.append(f"evidence {evidence_id}: native PNG missing or SHA256 mismatch")
    native_summary = (result.get("record") or {}).get("vision") or {}
    exported_bytes = sum(item["bytes"] for item in frame_files.values())
    accounting = {"budget_bytes": 20 * 1024 * 1024,
                  "native_record_frame_count": native_summary.get("frameCount"),
                  "native_record_bytes": native_summary.get("frameBytes"),
                  "exported_png_count": len(frame_files), "exported_png_bytes": exported_bytes,
                  "all_png_hashes_verified": bool(archive) and all(item["verified"] for item in frame_files.values()),
                  "exported_count_matches_native": bool(archive) and len(frame_files) == native_summary.get("frameCount"),
                  "exported_bytes_match_native": bool(archive) and exported_bytes == native_summary.get("frameBytes"),
                  "native_bytes_within_budget": (native_summary["frameBytes"] <= 20 * 1024 * 1024
                                                 if isinstance(native_summary.get("frameBytes"), (int, float)) else None)}
    if archive and len(queries) != len(observes):
        problems.append(f"observe query/log counts differ: {len(queries)}/{len(observes)}")
    for index in range(max(len(queries), len(observes))):
        query = queries[index] if index < len(queries) else None
        observed = observes[index] if index < len(observes) else None
        frame = frames.get(query.get("evidenceId")) if query else None
        if query and frame and frame["frameId"] != query["frameId"]:
            raise ValueError(f"evidenceId/frameId mismatch: {path} observe {index + 1}")
        if query and frame and frame["seq"] >= query["seq"]:
            raise ValueError(f"Evidence was recorded after its query: {path} observe {index + 1}")
        tick = frame["tick"] if frame else query["tick"] if query else observed["tick"]
        sample, pose_match = sample_at(samples, tick, frame.get("seq") if frame else query.get("seq") if query else None)
        render_truth = render_truths.get(frame["evidenceId"]) if frame else None
        render_bound = bool(render_truth and render_truth.get("exactRenderState")
                            and render_truth["frameId"] == frame["frameId"]
                            and render_truth["evidenceSeq"] == frame["seq"]
                            and render_truth["imageSha256"] == frame["sha256"]
                            and render_truth["evidenceTick"] == frame["tick"]
                            and render_truth["evidenceStateRevision"] == frame["stateRevision"])
        if render_truth and not render_bound:
            problems.append(f"observe {index + 1}: render truth/evidence binding mismatch")
        if render_bound:
            sample = {**render_truth["vehicle"], **render_truth["objectState"],
                      "tick": render_truth["captureTick"], "seq": frame["seq"]}
            pose_match = "exact_native_camera_render"
        raw = query["result"] if query else observed.get("raw", [])
        if isinstance(raw, str):
            raw = json.loads(raw)
        raw_valid = isinstance(raw, list)
        if not raw_valid:
            problems.append(f"observe {index + 1} has non-array result: {raw}")
            raw = []
        log_match = bool(observed and (not query or (len(queries) == len(observes) and raw_valid
                         and query["tick"] == observed.get("tick")
                         and red_blue_fields(raw) == red_blue_fields(observed.get("raw", [])))))
        if query and observed and not log_match:
            problems.append(f"native observe ordinal {index + 1} does not match the program log tick/raw values; log binding withheld")
        camera, targets = camera_truth(sample, render_truth["camera"] if render_bound else None)
        row = {"map": result.get("assignedMap"), "observe": observed.get("observe_count") if log_match else None,
               "native_observe_ordinal": index + 1 if query else None, "log_query_binding_verified": bool(query and log_match),
               "logged_observe_count": observed.get("observe_count") if log_match else None,
               "logged_tick": observed.get("tick") if observed else None,
               "query_tick": query.get("tick") if query else None, "frame_tick": frame.get("tick") if frame else None,
               "diagnostic_tick": tick, "query_seq": query.get("seq") if query else None,
               "evidence_id": query.get("evidenceId") if query else None,
               "frame_id": frame.get("frameId") if frame else None,
               "sample_tick": sample["tick"], "sample_seq": sample["seq"], "pose_match": pose_match,
               "pose_exact_tick": sample["tick"] == tick, "pose_sample_age_ticks": tick - sample["tick"],
               "render_truth_binding_verified": render_bound,
               "capture_tick": render_truth["captureTick"] if render_bound else None,
               "capture_state_revision": render_truth["captureStateRevision"] if render_bound else None,
               "vehicle_pose": [sample["x"], sample["z"], sample["heading"]], "camera": camera,
               "true_reds": targets, "raw": raw, "raw_source": "native_query" if query else "program_log",
               "image": None, "image_sha256_verified": False, "raw_result_valid": raw_valid,
               **(classify(raw, targets) if raw_valid else {"expected_but_missing": False,
                                                          "expected_targets": [], "false_red_candidates": []})}
        if frame:
            row["image"] = frame_files[frame["evidenceId"]]["image"]
            row["image_sha256"] = frame["sha256"]
            row["image_sha256_verified"] = frame_files[frame["evidenceId"]]["verified"]
            if not row["image_sha256_verified"]:
                problems.append(f"observe {index + 1} image missing or SHA256 mismatch")
        else:
            problems.append(f"observe {index + 1} has no native image binding")
        rows.append(row)
    return {"map": result.get("assignedMap"), "result_file": str(path.resolve()),
            "vision_archive": str(archive_path.resolve()) if archive else None,
            "image_source": "native PNG evidence" if archive else "historical evidence not exported; no substitute image",
            "native_vision_summary": native_summary, "evidence_accounting": accounting,
            "problems": problems, "observes": rows}


def reference_cases(runs, folder):
    cases = []
    for layout in ("map-04", "map-05", "map-08"):
        path = folder / f"{layout}.json"
        if not path.exists():
            continue
        reference = analyse(path)
        historic = [row for row in reference["observes"] if row["diagnostic_tick"] == 1929]
        candidates = [row for run in runs if run["map"] == layout for row in run["observes"] if row["image_sha256_verified"]]
        for old in historic:
            def differences(new):
                pose_gap = math.dist(old["vehicle_pose"][:2], new["vehicle_pose"][:2]) * CM_PER_UNIT
                heading_gap = angular_gap(math.degrees(old["vehicle_pose"][2]), math.degrees(new["vehicle_pose"][2]))
                return pose_gap, heading_gap
            best = min(candidates, key=lambda row: sum(differences(row))) if candidates else None
            gaps = differences(best) if best else None
            equivalent = bool(gaps and gaps[0] <= 1.0 and gaps[1] <= 1.0)
            cases.append({"map": layout, "reference_tick": 1929, "reference": old,
                          "new_frame": best, "pose_gap_cm": gaps[0] if gaps else None,
                          "heading_gap_deg": gaps[1] if gaps else None,
                          "equivalent_geometry": equivalent,
                          "interpretation": "New batch native frame within 1 cm / 1 degree of old geometry; not the original image."
                          if equivalent else "No equivalent native frame was observed in this batch; no old image can be reconstructed."})
    return cases


def write_gallery(path, report):
    chunks = ['<!doctype html><meta charset="utf-8"><title>Task 2 vision diagnostics</title>',
              '<style>body{font:16px system-ui;max-width:1000px;margin:32px auto;background:#fafafa;color:#222}article{background:white;padding:20px;margin:24px 0;border:1px solid #ddd}img{max-width:100%;height:auto}pre{white-space:pre-wrap;font-size:13px}h2{font-size:20px}</style>',
              '<h1>赛题2：同帧视觉诊断</h1><p>保留原始 PNG。标记只依据约定的真值几何规则；遮挡、画面内容和分类原因需要看图确认。优先使用原生渲染时 camera matrixWorld 和对象快照；历史记录回退至帧前真值采样并标注时差。距离为相机平面中心距。</p>']
    for run in report["runs"]:
        for row in run["observes"]:
            if not row["expected_but_missing"] and not row["false_red_candidates"]:
                continue
            tags = (["应见未见：30–85cm，|方位|≤30°"] if row["expected_but_missing"] else [])
            if row["false_red_candidates"]:
                tags.append("伪红候选：检测方位±3°无真红球")
            label = row["observe"] if row["observe"] is not None else f'native query #{row["native_observe_ordinal"]}; unmatched log'
            chunks.append(f'<article><h2>{html.escape(row["map"])} · observe {label} · tick {row["diagnostic_tick"]}</h2><p>{html.escape(" / ".join(tags))}</p>')
            if row["image_sha256_verified"]:
                uri = Path(row["image"]).as_uri()
                chunks.append(f'<a href="{html.escape(uri)}"><img src="{html.escape(uri)}" alt="Unmodified native camera frame"></a>')
            else:
                chunks.append('<p>原始帧未保存；不提供替代图。</p>')
            compact = {key: row[key] for key in ("evidence_id", "frame_id", "query_seq", "pose_match", "image_sha256_verified", "true_reds", "raw")}
            chunks.append('<pre>' + html.escape(json.dumps(compact, ensure_ascii=False, indent=2)) + '</pre></article>')
    chunks.append('<h2>旧 map-04/05/08 tick 1929 的对应证据</h2>')
    for case in report["reference_cases"]:
        compact = {key: case[key] for key in ("map", "reference_tick", "equivalent_geometry", "pose_gap_cm", "heading_gap_deg", "interpretation")}
        chunks.append('<pre>' + html.escape(json.dumps(compact, ensure_ascii=False, indent=2)) + '</pre>')
        if case["equivalent_geometry"]:
            chunks.append(f'<img src="{html.escape(Path(case["new_frame"]["image"]).as_uri())}" alt="New frame at equivalent geometry, not the historical image">')
    path.write_text("\n".join(chunks), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--reference-batch", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    paths = sorted(path for path in args.input.glob("map-*.json") if re.fullmatch(r"map-\d\d", path.stem)) if args.input.is_dir() else [args.input]
    runs = [analyse(path) for path in paths]
    report = {"schema": "wm-vision-diagnostics/v1", "task_id": TASK_ID, "camera_forward_cm": CAMERA_FORWARD_CM,
              "rules": {"expected_missing": "true red camera range 30–85 cm, |bearing| <= 30 degrees, zero raw red detections",
                        "false_red": "raw red has no true red within +/-3 degrees of its camera bearing"},
              "runs": runs, "reference_cases": reference_cases(runs, args.reference_batch) if args.reference_batch else []}
    rows = [row for run in runs for row in run["observes"]]
    report["counts"] = {"observes": len(rows), "verified_images": sum(row["image_sha256_verified"] for row in rows),
                        "verified_log_query_bindings": sum(row["log_query_binding_verified"] for row in rows),
                        "verified_exact_render_truth": sum(row["render_truth_binding_verified"] for row in rows),
                        "expected_missing_frames": sum(row["expected_but_missing"] for row in rows),
                        "false_red_candidate_frames": sum(bool(row["false_red_candidates"]) for row in rows)}
    output = args.out or (args.input if args.input.is_dir() else args.input.parent) / "vision_diagnostics.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    write_gallery(output.with_suffix(".html"), report)
    print(json.dumps({"output": str(output.resolve()), **report["counts"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
