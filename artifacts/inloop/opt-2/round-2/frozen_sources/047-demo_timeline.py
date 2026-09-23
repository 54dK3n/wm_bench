#!/usr/bin/env python3
"""Offline first-visibility reconstruction from exact native render evidence.

python3 tools/demo_timeline.py <raw.json> [--out timeline.json]
Does not modify the robot, frozen report tools, raw evidence, or simulator.
Raw 100cm readings supply bearing candidates only, never range evidence.
"""
import argparse
import ast
from collections import Counter
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BEARING_TOLERANCE_DEG = 3.0
RESIDUAL_TOLERANCE_CM = 30.0


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def location(base, value):
    path = Path(value)
    return path if path.is_absolute() else base.parent / path


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def calibration(path):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    values = [ast.literal_eval(node.value) for node in ast.walk(tree)
              if isinstance(node, ast.Assign) and any(isinstance(name, ast.Name) and name.id == "RANGE_CAL" for name in node.targets)]
    if len(values) != 1 or any(not finite(values[0].get(key)) for key in ("L_cm", "a_cm", "k", "p")):
        raise ValueError("One literal frozen RANGE_CAL model is required")
    return values[0]


def geometry(detection, truth, units_per_meter, model):
    """All actual red-package candidates; no nearest-only attribution."""
    distance, bearing = detection.get("distanceCm"), detection.get("bearingDeg")
    if not finite(distance) or not finite(bearing):
        return {"status": "unknown", "reason": "missing_raw_distance_or_bearing", "candidates": []}
    capped = distance >= 100
    beta = math.radians(bearing)
    if distance < 0 or math.cos(beta) <= 0:
        return {"status": "unknown", "reason": "invalid_forward_camera_measurement", "candidates": []}
    # Native exact camera position / orientation determine the bearing test.
    # Frozen M5 projects the uncapped measurement from the vehicle centre.
    camera, vehicle = truth["camera"], truth["vehicle"]
    camera_forward = [camera["forward"][0], camera["forward"][2]]
    camera_right = [camera["right"][0], camera["right"][2]]
    f_norm, r_norm = math.hypot(*camera_forward), math.hypot(*camera_right)
    camera_forward = [x / f_norm for x in camera_forward]
    camera_right = [x / r_norm for x in camera_right]
    predicted = None
    if not capped:
        rho = model["a_cm"] + model["k"] * distance / math.cos(beta) ** model["p"]
        forward, right = model["L_cm"] + rho * math.cos(beta), rho * math.sin(beta)
        heading = vehicle["heading"]
        predicted = [vehicle["x"] + units_per_meter / 100 * (-forward * math.sin(heading) + right * math.cos(heading)),
                     vehicle["z"] + units_per_meter / 100 * (-forward * math.cos(heading) - right * math.sin(heading))]
    targets, candidates = [], []
    for package in truth["objectState"]["packages"]:
        if package.get("role") != "target" or package.get("id") == truth["objectState"].get("holding"):
            continue
        delta = [package["x"] - camera["world"][0], package["z"] - camera["world"][2]]
        forward = sum(a * b for a, b in zip(delta, camera_forward))
        right = sum(a * b for a, b in zip(delta, camera_right))
        truth_bearing = math.degrees(math.atan2(right, forward))
        error = abs((bearing - truth_bearing + 180) % 360 - 180)
        residual = math.dist(predicted, [package["x"], package["z"]]) * 100 / units_per_meter if predicted is not None else None
        match = forward > 0 and error <= BEARING_TOLERANCE_DEG and (capped or residual <= RESIDUAL_TOLERANCE_CM)
        row = {"package_id": package["id"], "truth_position": [package["x"], package["z"]],
               "camera_truth_bearing_deg": truth_bearing, "bearing_error_deg": error,
               "m5_residual_cm": residual, "bearing_pass": forward > 0 and error <= BEARING_TOLERANCE_DEG,
               "range_used": not capped, "candidate": match}
        targets.append(row)
        if match:
            candidates.append(row)
    return {"status": "candidate" if candidates else "no_geometry_match", "capped_100cm": capped,
            "range_evidence": "none:100cm_clipped_bearing_only" if capped else "frozen_M5_point_residual",
            "m5_predicted_position": predicted, "m5_calibrated_domain": not capped and 40 <= distance <= 95 and abs(bearing) <= 35,
            "candidates": candidates, "all_target_geometry": targets}


def reconstruct(path):
    path = Path(path).resolve()
    raw = read(path)
    vision_path = location(path, raw["visionEvidenceFile"])
    vision = read(vision_path)
    program = location(path, raw["program"])
    model = calibration(program)
    truth_path = ROOT / "artifacts/truth" / raw["taskId"] / (raw["assignedMap"] + ".json")
    units = read(truth_path)["unitsPerMeter"]
    lines = raw.get("lines", [])
    events = raw.get("record", {}).get("events", [])
    expected_run = raw.get("record", {}).get("top", {}).get("runId")
    grabs = [{"event_index": i, **event} for i, event in enumerate(events)
             if event.get("type") == "package_grabbed" and event.get("accepted") is True and event.get("objectRole") == "target"]
    delivered = [{"event_index": i, **event} for i, event in enumerate(events)
                 if event.get("type") == "package_delivered" and event.get("objectRole") == "target"]
    packages = list(dict.fromkeys(event["packageId"] for event in grabs + delivered))
    query_by_tick, truth_by_frame, frame_by_id = {}, {}, {}
    for query in vision.get("queries", []):
        if query.get("method") == "observe":
            query_by_tick.setdefault(query.get("tick"), []).append(query)
    for frame in vision.get("renderTruth", {}).get("frames", []):
        truth_by_frame.setdefault(frame.get("frameId"), []).append(frame)
    for frame in vision.get("frames", []):
        frame_by_id.setdefault(frame.get("frameId"), []).append(frame)
    observations, problems = [], []
    for index, line in enumerate(lines):
        if line.get("event") != "observe":
            continue
        tick = line.get("tick")
        queries = query_by_tick.get(tick, [])
        base = {"line_index": index, "observe_count": line.get("observe_count"), "tick": tick,
                "seconds": tick * .02 if finite(tick) else None}
        if len(queries) != 1:
            problems.append({**base, "reason": "missing_or_ambiguous_native_observe_query", "query_count": len(queries)})
            continue
        query = queries[0]
        truths, frames = truth_by_frame.get(query.get("frameId"), []), frame_by_id.get(query.get("frameId"), [])
        if len(truths) != 1 or len(frames) != 1:
            problems.append({**base, "reason": "missing_or_ambiguous_native_render_frame"})
            continue
        truth, frame = truths[0], frames[0]
        image = location(vision_path, frame["image"])
        valid = (truth.get("exactRenderState") is True and truth.get("sameTickAndRevision") is True
                 and truth.get("runId") == expected_run and truth.get("captureTick") == tick
                 and truth.get("evidenceTick") == tick and frame.get("tick") == tick
                 and query.get("evidenceId") == truth.get("evidenceId") == frame.get("evidenceId")
                 and image.is_file() and sha(image) == frame.get("sha256") == truth.get("imageSha256"))
        if not valid:
            problems.append({**base, "reason": "exact_render_binding_or_image_identity_failed", "frame_id": frame.get("frameId"), "image": str(image)})
            continue
        base.update({"frame_id": frame["frameId"], "query_seq": query.get("seq"), "image": str(image), "image_sha256": sha(image),
                     "capture_tick": truth["captureTick"], "capture_state_revision": truth.get("captureStateRevision")})
        detections = []
        for raw_index, detection in enumerate(line.get("raw", [])):
            if detection.get("category") != "target":
                continue
            matches_native = [item for item in query.get("result", []) if all(item.get(k) == detection.get(k)
                              for k in ("category", "distanceCm", "bearingDeg", "confidence"))]
            if not matches_native:
                detections.append({"raw_index": raw_index, "raw": detection, "status": "unknown", "candidates": [],
                                   "reason": "logged_detection_not_in_native_query"})
                continue
            detections.append({"raw_index": raw_index, "raw": detection, **geometry(detection, truth, units, model)})
        counts = Counter(candidate["package_id"] for detection in detections for candidate in detection["candidates"])
        for detection in detections:
            candidates = detection["candidates"]
            unambiguous = len(candidates) == 1 and counts[candidates[0]["package_id"]] == 1
            detection["one_to_one_geometry_match"] = unambiguous
            detection["unambiguous_uncapped"] = unambiguous and detection.get("capped_100cm") is False
            detection["image_review_required"] = not detection["unambiguous_uncapped"] or not detection.get("m5_calibrated_domain")
            detection["ambiguity_reason"] = ("100cm_is_clipped_bearing_candidate_only" if detection.get("capped_100cm")
                else "multiple_raw_or_true_target_candidates" if candidates and not unambiguous else None)
        observations.append({**base, "detections": detections})
    # Directly recover actual WM increments, not confirmation bookkeeping hits.
    previous, latest_observe, associations, wm_hits = {}, None, [], []
    for index, line in enumerate(lines):
        if line.get("event") == "observe":
            latest_observe, associations = (index, line), []
        elif line.get("event") == "wm_associations":
            associations = line.get("items", [])
        elif line.get("event") == "wm_targets":
            for track in line.get("tracks", []):
                count, identity = track.get("hit"), track.get("id")
                if finite(count) and count > previous.get(identity, 0) and latest_observe:
                    wm_hits.append({"wm_line_index": index, "line_index": latest_observe[0], "tick": latest_observe[1].get("tick"),
                        "seconds": latest_observe[1]["tick"] * .02, "track_id": identity, "hit": count,
                        "increment": count - previous.get(identity, 0),
                        "readings": [item for item in associations if item.get("track_id") == identity]})
                if finite(count):
                    previous[identity] = count
    starts = [(i, line) for i, line in enumerate(lines) if line.get("event") == "ball_start"]
    package_tracks = {}
    for offset, (start, first) in enumerate(starts):
        end = starts[offset + 1][0] if offset + 1 < len(starts) else len(lines)
        end_tick = starts[offset + 1][1].get("tick") if offset + 1 < len(starts) else math.inf
        segment_grabs = [event for event in grabs if finite(first.get("tick")) and first["tick"] * 20 <= event["t"] < end_tick * 20]
        selected = [line.get("track_id") for line in lines[start:end] if line.get("event") == "ball_selection"]
        if len(set(selected)) == 1 and selected[0] and len({event["packageId"] for event in segment_grabs}) == 1:
            package_tracks[segment_grabs[0]["packageId"]] = selected[0]
    balls = []
    for package in packages:
        first_grab = next((event for event in grabs if event["packageId"] == package), None)
        cutoff = first_grab["t"] if first_grab else math.inf
        candidates = []
        for observe in observations:
            if observe["tick"] * 20 > cutoff:
                continue
            for detection in observe["detections"]:
                match = next((item for item in detection["candidates"] if item["package_id"] == package), None)
                if match:
                    candidates.append({**{k: v for k, v in observe.items() if k != "detections"}, **detection, "matched_package": match})
        first_candidate = candidates[0] if candidates else None
        first_unambiguous = next((item for item in candidates if item["unambiguous_uncapped"]), None)
        accepted = []
        for hit in wm_hits:
            same_track = package_tracks.get(package) == hit["track_id"]
            linked = next((item for item in candidates if item["line_index"] == hit["line_index"]
                           and item["unambiguous_uncapped"] and any(all(reading.get(k) == item["raw"].get(k)
                               for k in ("distanceCm", "bearingDeg")) for reading in hit["readings"])), None)
            if hit["tick"] * 20 <= cutoff and (same_track or linked):
                observe = next((item for item in observations if item["line_index"] == hit["line_index"]), None)
                accepted.append({**hit, "association_basis": "ball_locked_track_then_actual_package_grab" if same_track else "unambiguous_uncapped_exact_render_geometry",
                                 "image": observe.get("image") if observe else None})
        first_accepted = accepted[0] if accepted else None
        balls.append({"package_id": package, "track_id": package_tracks.get(package), "first_platform_grab": first_grab,
            "platform_deliveries": [event for event in delivered if event["packageId"] == package],
            "earliest_raw_candidate": first_candidate, "earliest_unambiguous_uncapped": first_unambiguous,
            "first_wm_accepted": first_accepted,
            "earliest_visibility_status": "geometry_unambiguous_uncapped" if first_candidate and first_candidate["unambiguous_uncapped"]
                else "candidate_requires_image_review" if first_candidate else "unknown",
            "unknown_reason": None if first_candidate else "no_raw_detection_satisfies_exact_render_geometry_or_binding_unavailable",
            "candidate_count": len(candidates), "all_raw_candidates": candidates})
    return {"schema": "wm-demo-first-visibility/v1", "map": raw.get("assignedMap"),
        "raw_file": str(path), "raw_sha256": sha(path), "vision_file": str(vision_path), "vision_sha256": sha(vision_path),
        "program_file": str(program), "program_sha256": sha(program), "frozen_M5": model,
        "units_per_meter": units, "units_source": str(truth_path), "units_source_sha256": sha(truth_path),
        "policy": {"bearing_tolerance_deg": BEARING_TOLERANCE_DEG, "M5_point_residual_cm": RESIDUAL_TOLERANCE_CM,
            "capped_readings": "distance>=100: bearing candidates only; no M5 point or distance residual computed",
            "unambiguous": "one raw detection to one true target under both gates; capped candidates never called uncapped identification",
            "limits": "geometric attribution is not visual verification; clipping, multiple candidates, model extrapolation require original PNG review",
            "time": "native deterministic tick * 0.02s; zero-based raw lines/event indices",
            "scope": "offline evidence only; no detector change, runtime truth use, or performance statistics"},
        "binding_problems": problems, "balls": balls, "observations": observations}


def markdown(report):
    text = ["# 首次看到的离线回溯", "", f"布局 {report['map']}。100cm 封顶只形成方位候选，不提供距离证据。", "",
            "| 平台目标 | 最早原始候选 | 最早无歧义未封顶 | 首次 WM 增量命中 |", "|---|---|---|---|"]
    def item(value):
        if value is None:
            return "unknown"
        raw = value.get("raw", {})
        suffix = f"，{raw.get('distanceCm')}cm/{raw.get('bearingDeg')}°" if raw else ""
        label = f"{value['seconds']:.2f}s / tick {value['tick']} / lines[{value['line_index']}]" + suffix
        return f"[{label}]({value['image']})" if value.get("image") else label
    for ball in report["balls"]:
        text.append(f"| {ball['package_id']} | {item(ball['earliest_raw_candidate'])} | {item(ball['earliest_unambiguous_uncapped'])} | {item(ball['first_wm_accepted'])} |")
        candidate = ball["earliest_raw_candidate"]
        if candidate and candidate["image_review_required"]:
            text += ["", f"{ball['package_id']}：最早候选需原图复核，原因 `{candidate.get('ambiguity_reason') or 'M5_model_extrapolation'}`；不能把它表述为已确定首次看到。"]
        elif not candidate:
            text += ["", f"{ball['package_id']}：unknown，{ball['unknown_reason']}。"]
    text += ["", f"精确渲染绑定问题：{len(report['binding_problems'])}；详情与全部候选见同名 JSON。", "",
             f"复跑：`python3 tools/demo_timeline.py {report['raw_file']}`", ""]
    return "\n".join(text)


def self_test():
    """Small synthetic counterexamples; no files or simulator are accessed."""
    model = {"L_cm": 5.1557, "a_cm": 1.6239, "k": 1.0187, "p": 1.0}
    units = 8
    forward = model["L_cm"] + model["a_cm"] + model["k"] * 60
    truth = {"camera": {"world": [0, 0, -.43], "forward": [0, 0, -1], "right": [1, 0, 0]},
             "vehicle": {"x": 0, "z": 0, "heading": 0},
             "objectState": {"holding": None, "packages": [{"id": "near", "role": "target", "x": 0, "z": -forward * .08},
                                                           {"id": "far", "role": "target", "x": 0, "z": -80}]}}
    uncapped = geometry({"distanceCm": 60, "bearingDeg": 0}, truth, units, model)
    assert [item["package_id"] for item in uncapped["candidates"]] == ["near"]
    assert uncapped["candidates"][0]["m5_residual_cm"] == 0
    capped = geometry({"distanceCm": 100, "bearingDeg": 0}, truth, units, model)
    assert len(capped["candidates"]) == 2 and capped["m5_predicted_position"] is None
    assert all(item["m5_residual_cm"] is None and item["range_used"] is False for item in capped["all_target_geometry"])
    assert not geometry({"distanceCm": 60, "bearingDeg": 4}, truth, units, model)["candidates"]
    assert geometry({"distanceCm": 60}, truth, units, model)["status"] == "unknown"
    assert geometry({"distanceCm": -1, "bearingDeg": 0}, truth, units, model)["status"] == "unknown"
    print(json.dumps({"self_test": "pass", "checks": 7, "scope": "synthetic geometry only; no simulator"}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("raw", type=Path, nargs="?")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if args.raw is None:
        parser.error("raw is required unless --self-test is used")
    report = reconstruct(args.raw)
    out = args.out or args.raw.with_name(args.raw.stem + ".timeline.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    out.with_suffix(".md").write_text(markdown(report), encoding="utf-8")
    print(json.dumps({"output": str(out), "balls": len(report["balls"]), "binding_problems": len(report["binding_problems"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
