#!/usr/bin/env python3
"""Offline truth labels and filter metrics; never imported by the robot.

Default --dataset dev reads only calib_runs* and v28r1_batch. Test inputs are
opened only after an explicit --dataset test and a matching freeze manifest.
Runtime frames and truth labels are exported separately. Runtime filter plugins
receive observations, public logged odometry/road_state, and tick only.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import importlib.util
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEV_NAMES = ("calib_runs", "calib_runs_v2", "calib_runs_v4", "calib_runs_v5", "calib_runs_v6", "v28r1_batch")
TEST_ROOT = ROOT / "artifacts/inloop/stage-1/round-3"
M5 = {"L_cm": 5.1557, "a_cm": 1.6239, "k": 1.0187, "p": 1.0}
BEARING_TOLERANCE_DEG = 3.0
DISTANCE_TOLERANCE_CM = 30.0
CAMERA_FORWARD_CM = 5.375
UNITS_PER_METER = 8.0
COLORS = ("target", "distractor")
POLICY = {"bearing": "camera-frame wrapped absolute difference <=3 degrees",
          "distance": "absolute difference of M5 robot-centre horizontal range and true robot-centre horizontal range <=30cm; NOT 2D point error",
          "capped": "raw>=100 is mechanically evaluated by M5 for labels and marked capped; not a runtime localization point",
          "ambiguity": "two or more same-color packages satisfy both gates; excluded from performance denominators",
          "unknown": "missing/invalid exact truth or raw values; explicitly reported, never silently counted as false",
          "baseline": "per-observe requested confidence threshold only; category routing and WM 40<=raw<90 eligibility are separate",
          "dev_scope": "only raw calibration collections and v28r1; derived calibration selected-row tables are never used"}


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def m5_distance_cm(raw_cm, bearing_deg):
    beta = math.radians(bearing_deg)
    cosine = math.cos(beta)
    if not finite(raw_cm) or raw_cm < 0 or cosine <= 0:
        raise ValueError("invalid M5 forward measurement")
    rho = M5["a_cm"] + M5["k"] * raw_cm / cosine ** M5["p"]
    return math.hypot(M5["L_cm"] + rho * cosine, rho * math.sin(beta))


def label_detection(observation, truth):
    """Label every same-color candidate; no nearest-only association shortcut."""
    distance, bearing, category = (observation.get(k) for k in ("distanceCm", "bearingDeg", "category"))
    out = {"label": "unknown", "reason": None, "capped": finite(distance) and distance >= 100,
           "wrong_class": False, "same_color_matches": [], "other_color_matches": [], "geometry": []}
    if category not in COLORS or not finite(distance) or not finite(bearing):
        return {**out, "reason": "invalid_raw_measurement"}
    if not truth or not truth.get("exact_pose"):
        return {**out, "reason": (truth or {}).get("reason", "exact_pose_unavailable")}
    try:
        predicted_range = m5_distance_cm(distance, bearing)
    except ValueError:
        return {**out, "reason": "invalid_M5_measurement"}
    vehicle, camera = truth["vehicle"], truth["camera"]
    fwd, right = camera["forward"], camera["right"]
    f_norm, r_norm = math.hypot(fwd[0], fwd[2]), math.hypot(right[0], right[2])
    if not f_norm or not r_norm:
        return {**out, "reason": "invalid_camera_basis"}
    for package in truth["objectState"]["packages"]:
        if package.get("role") not in COLORS or package.get("id") == truth["objectState"].get("holding"):
            continue
        dx, dz = package["x"] - camera["world"][0], package["z"] - camera["world"][2]
        forward = (dx * fwd[0] + dz * fwd[2]) / f_norm
        lateral = (dx * right[0] + dz * right[2]) / r_norm
        truth_bearing = math.degrees(math.atan2(lateral, forward))
        bearing_error = abs((bearing - truth_bearing + 180) % 360 - 180)
        truth_range = math.hypot(package["x"] - vehicle["x"], package["z"] - vehicle["z"]) * 100 / UNITS_PER_METER
        residual = abs(predicted_range - truth_range)
        matched = forward > 0 and bearing_error <= BEARING_TOLERANCE_DEG + 1e-10 and residual <= DISTANCE_TOLERANCE_CM + 1e-10
        item = {"package_id": package["id"], "role": package["role"], "world": [package["x"], package["z"]],
                "truth_camera_bearing_deg": truth_bearing, "bearing_error_deg": bearing_error,
                "truth_robot_distance_cm": truth_range, "m5_robot_distance_cm": predicted_range,
                "distance_residual_cm": residual, "matches": matched}
        out["geometry"].append(item)
        if matched:
            out["same_color_matches" if package["role"] == category else "other_color_matches"].append(package["id"])
    count = len(out["same_color_matches"])
    out.update(label="ambiguity" if count > 1 else "true" if count == 1 else "false",
               reason="multiple_same_color_matches" if count > 1 else "unique_same_color_match" if count else "no_same_color_match",
               wrong_class=count == 0 and bool(out["other_color_matches"]), m5_robot_distance_cm=predicted_range)
    return out


def legacy_truth(line, samples):
    """Same-tick samples only, or unchanged bracketing samples for a logged static calibration frame."""
    tick = line.get("tick")
    if not samples:
        return {"exact_pose": False, "reason": "missing_driver_samples", "capture_tick": tick,
                "frame_id": None, "native_png_available": False}
    exact = [sample for sample in samples if sample.get("tick") == tick]
    def state(sample):
        return {k: sample.get(k) for k in ("x", "z", "heading", "holding", "packages")}
    mode = "legacy_same_tick_sample"
    used = exact
    if not exact and line.get("event") == "calib_obs" and line.get("tickAfter") == tick and line.get("odo") == line.get("odoAfter"):
        before = [s for s in samples if s.get("tick", math.inf) < tick]
        after = [s for s in samples if s.get("tick", -math.inf) > tick]
        if before and after and state(before[-1]) == state(after[0]):
            used = [before[-1], after[0]]
            mode = "legacy_static_calibration_bracket"
    if not used:
        return {"exact_pose": False, "reason": "missing_exact_tick_sample", "capture_tick": tick,
                "frame_id": None, "native_png_available": False}
    if any(state(sample) != state(used[0]) for sample in used):
        return {"exact_pose": False, "reason": "conflicting_states_at_same_tick", "capture_tick": tick}
    if line.get("event") == "calib_obs" and (line.get("tickAfter") != tick or line.get("odo") != line.get("odoAfter")):
        return {"exact_pose": False, "reason": "calibration_moved_during_observe", "capture_tick": tick}
    sample = used[0]
    heading = sample["heading"]
    forward, right = [-math.sin(heading), 0.0, -math.cos(heading)], [math.cos(heading), 0.0, -math.sin(heading)]
    offset = CAMERA_FORWARD_CM * UNITS_PER_METER / 100
    return {"exact_pose": True, "binding": mode, "capture_tick": tick,
            "sample_ticks": [s["tick"] for s in used], "sample_seqs": [s.get("seq") for s in used],
            "frame_id": None, "native_png_available": False,
            "precision_note": "legacy driver samples round heading/position; no PNG, frameId, or matrixWorld was preserved; fixed platform camera offset",
            "vehicle": {k: sample[k] for k in ("x", "z", "heading")},
            "camera": {"world": [sample["x"] + offset * forward[0], 0.0, sample["z"] + offset * forward[2]],
                       "forward": forward, "right": right},
            "objectState": {"holding": sample.get("holding"), "packages": sample.get("packages", [])}}


def native_truth(line, vision, consumed, expected_run_id):
    """Require query/raw/frame/evidence/hash/render tick binding; no sample fallback for tests."""
    fields = ("category", "distanceCm", "bearingDeg", "confidence")
    if not expected_run_id or vision.get("runId") != expected_run_id:
        return {"exact_pose": False, "reason": "native_vision_run_id_mismatch", "capture_tick": line.get("tick")}
    for q in vision.get("queries", []):
        if q.get("method") != "observe" or q.get("tick") != line.get("tick") or q["seq"] in consumed:
            continue
        projected = [{k: d.get(k) for k in fields} for d in q["result"] if d.get("category") in COLORS]
        if projected != line.get("raw", []):
            continue
        frames = [f for f in vision.get("frames", []) if f.get("evidenceId") == q.get("evidenceId") and f.get("frameId") == q.get("frameId")]
        truths = [t for t in vision.get("renderTruth", {}).get("frames", []) if t.get("evidenceId") == q.get("evidenceId") and t.get("frameId") == q.get("frameId")]
        if len(frames) != 1 or len(truths) != 1:
            continue
        frame, truth = frames[0], truths[0]
        if not (truth.get("exactRenderState") and truth.get("sameTickAndRevision") is True
                and truth.get("imageSha256") == frame.get("sha256")
                and truth.get("evidenceSeq") == frame.get("seq") and frame["seq"] < q["seq"]
                and truth.get("evidenceTick") == truth.get("captureTick") == frame.get("tick") == q.get("tick")
                and truth.get("evidenceStateRevision") == truth.get("captureStateRevision") == frame.get("stateRevision")
                and truth.get("runId") == vision.get("runId")):
            continue
        consumed.add(q["seq"])
        return {**truth, "exact_pose": True, "binding": "native_exact_render", "capture_tick": truth["captureTick"],
                "frame_id": frame["frameId"], "evidence_id": frame["evidenceId"], "query_seq": q["seq"],
                "native_png_available": True, "image": frame.get("image"), "image_sha256": frame["sha256"]}
    return {"exact_pose": False, "reason": "no_exact_native_query_frame_render_binding", "capture_tick": line.get("tick")}


def metric_counts(rows, rejected_ids):
    """Performance denominators exclude ambiguity/unknown; coverage always includes all raw rows."""
    rejected = set(rejected_ids)
    counter = collections.Counter(row["label"] for row in rows)
    counts = {name: sum(row["label"] == label and (row["row_id"] in rejected) == is_rejected for row in rows)
              for name, label, is_rejected in (("true_kept", "true", False), ("true_filtered", "true", True),
                                              ("false_kept", "false", False), ("false_filtered", "false", True))}
    true_n, false_n = counter["true"], counter["false"]
    filtered = counts["true_filtered"] + counts["false_filtered"]
    kept = counts["true_kept"] + counts["false_kept"]
    ratio = lambda a, b: a / b if b else None
    return {"raw_total": len(rows), "true_total": true_n, "false_total": false_n,
            "ambiguity_excluded": counter["ambiguity"], "unknown_excluded": counter["unknown"],
            "labeled_coverage": ratio(true_n + false_n + counter["ambiguity"], len(rows)),
            "evaluable_total": true_n + false_n, "wrong_class_total": sum(row.get("wrong_class", False) for row in rows),
            "unknown_reasons": dict(collections.Counter(row.get("reason") for row in rows if row["label"] == "unknown")),
            "all_raw_filtered": sum(row["row_id"] in rejected for row in rows), **counts,
            "false_kill_rate": ratio(counts["true_filtered"], true_n),
            "filter_precision": ratio(counts["false_filtered"], filtered),
            "false_prevalence": ratio(false_n, true_n + false_n),
            "residual_false_share_among_kept": ratio(counts["false_kept"], kept),
            "false_survival_rate": ratio(counts["false_kept"], false_n)}


def summarize(rows, rejected_ids):
    return {"all": metric_counts(rows, rejected_ids),
            "red": metric_counts([r for r in rows if r["category"] == "target"], rejected_ids),
            "blue": metric_counts([r for r in rows if r["category"] == "distractor"], rejected_ids)}


def self_checks(rows):
    retained, removed = summarize(rows, []), summarize(rows, [r["row_id"] for r in rows])
    return {color: {"keep_all_zero_false_kill": retained[color]["true_filtered"] == 0,
                    "reject_all_precision_equals_false_prevalence": removed[color]["filter_precision"] == removed[color]["false_prevalence"]}
            for color in ("all", "red", "blue")}


def performance_gates(metrics, exact_test_coverage, dataset_name):
    gates = {}
    for color in ("red", "blue"):
        values = metrics[color]
        gates[color + "_false_kill_at_most_2pct"] = (values["true_total"] > 0
            and values["false_kill_rate"] is not None and values["false_kill_rate"] <= .02)
        gates[color + "_filter_precision_at_least_95pct"] = (values["true_filtered"] + values["false_filtered"] > 0
            and values["filter_precision"] is not None and values["filter_precision"] >= .95)
    rates_pass = all(gates.values())
    gates["test_dataset"] = dataset_name == "test"
    gates["test_exact_full_coverage"] = bool(exact_test_coverage)
    return {"candidate_rates_pass": rates_pass, "gates": gates, "all_gates_pass": all(gates.values())}


def test_inventory_complete(inventory):
    """Pure metadata check; does not discover or read the held-out directory."""
    expected = {str(TEST_ROOT / f"map-{i:02d}.json") for i in range(1, 11)}
    actual = [entry["raw_file"] for entry in inventory]
    return (len(actual) == 10 and len(set(actual)) == 10 and set(actual) == expected
            and all(entry.get("map") == Path(entry["raw_file"]).stem for entry in inventory))


def dev_paths():
    paths = []
    for name in DEV_NAMES:
        folder = ROOT / "artifacts/inloop" / name
        pattern = "map-??.json" if name == "v28r1_batch" else "*.json"
        paths.extend(p for p in sorted(folder.glob(pattern)) if "." not in p.stem)
    return paths


def freeze_verified(manifest_path, filter_path):
    if not manifest_path or not filter_path:
        raise ValueError("Test data stays sealed without --freeze-manifest and --filter-file")
    data = read(manifest_path)
    files = data.get("files", data)
    required = {str(Path(__file__).resolve()), str(Path(filter_path).resolve())}
    actual = {str(Path(p).resolve()): expected for p, expected in files.items()}
    if not required.issubset(actual) or any(not Path(p).is_file() or sha(p) != expected for p, expected in actual.items()):
        raise ValueError("Frozen evaluator and runtime filter hashes must match before opening any test data")
    return actual


def dataset(paths, dataset_name):
    frames, labels, inventory, bindings = [], [], [], []
    for raw_path in paths:
        raw_path = Path(raw_path).resolve()
        if dataset_name == "dev" and raw_path.parent not in {ROOT / "artifacts/inloop" / name for name in DEV_NAMES}:
            raise ValueError("Dev loader refuses any input outside explicit development folders")
        raw = read(raw_path)
        lines = [(i, l) for i, l in enumerate(raw.get("lines", [])) if l.get("event") in ("observe", "calib_obs")]
        if not lines:
            continue
        if raw.get("taskId") != "R2-GYI-MVP-02":
            raise ValueError(f"Only mission 2 is permitted: {raw_path}")
        sample_path = raw_path.with_name(raw_path.stem + ".samples.json")
        samples = read(sample_path) if sample_path.is_file() else []
        run_id = raw.get("record", {}).get("top", {}).get("runId") or str(raw_path.relative_to(ROOT))
        vision_path = Path(raw["visionEvidenceFile"]) if raw.get("visionEvidenceFile") else None
        if vision_path and not vision_path.is_absolute():
            vision_path = raw_path.parent / vision_path
        vision = read(vision_path) if vision_path and vision_path.is_file() else None
        if vision:
            # Only the explicit native-data path reads PNGs. Default dev has no native manifests.
            bad_images = []
            for image_frame in vision.get("frames", []):
                image_path = vision_path.parent / image_frame["image"]
                if (not image_path.is_file() or sha(image_path) != image_frame["sha256"]
                        or image_path.stat().st_size != image_frame["byteLength"]):
                    bad_images.append(image_frame["evidenceId"])
            vision["_invalid_image_ids"] = bad_images
        consumed = set()
        inventory.append({"raw_file": str(raw_path), "sha256": sha(raw_path), "run_id": run_id,
                          "map": raw.get("assignedMap"), "observe_frames": len(lines),
                          "samples_file": str(sample_path) if samples else None,
                          "samples_sha256": sha(sample_path) if samples else None,
                          "native_vision_manifest": str(vision_path) if vision else None})
        for index, line in lines:
            observations = [dict(d) for d in line.get("raw", line.get("dets", [])) if d.get("category") in COLORS]
            frame_id = f"{run_id}:line-{index}"
            odo = line.get("odo")
            public_odo = {"rightCm": odo[0], "forwardCm": odo[1], "headingDeg": odo[2], "tick": line["tick"]} if odo and len(odo) == 3 else None
            frame = {"run_id": run_id, "frame_id": frame_id, "tick": line["tick"], "observations": observations,
                     "odometry": public_odo, "road_state": None,
                     "baseline_confidence": line.get("requested_confidence", 0.3 if line["event"] == "calib_obs" else 0.0)}
            frames.append(frame)
            expected_run_id = raw.get("record", {}).get("top", {}).get("runId")
            truth = native_truth(line, vision, consumed, expected_run_id) if vision else legacy_truth(line, samples) if dataset_name == "dev" else {
                "exact_pose": False, "reason": "test_requires_native_exact_render"}
            if truth.get("evidence_id") in (vision or {}).get("_invalid_image_ids", []):
                truth = {"exact_pose": False, "reason": "native_png_missing_or_hash_mismatch", "capture_tick": line["tick"]}
            bindings.append({"frame_id": frame_id, "raw_line_index": index, "source": str(raw_path), "truth_binding": truth})
            for position, detection in enumerate(observations):
                label = label_detection(detection, truth)
                labels.append({"row_id": f"{frame_id}:det-{position}", "frame_id": frame_id, "detection_index": position,
                               "run_id": run_id, "map": raw.get("assignedMap"), "source": str(raw_path),
                               "raw_line_index": index, "tick": line["tick"], "category": detection["category"],
                               "observation": detection, "truth_binding": truth, **label,
                               "baseline_rejected": float(detection.get("confidence") or 0) < frame["baseline_confidence"],
                               "wm_window_eligible": finite(detection.get("distanceCm")) and 40 <= detection["distanceCm"] < 90})
    return frames, labels, inventory, bindings


def replay_filter(frames, filter_path):
    spec = importlib.util.spec_from_file_location("runtime_detection_filter", filter_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    instances, rejected, decisions = {}, [], []
    for frame in frames:
        if frame["run_id"] not in instances:
            instances[frame["run_id"]] = module.DetectionFilter()
        instance = instances[frame["run_id"]]
        observations = json.loads(json.dumps(frame["observations"]))
        before = json.dumps(observations, sort_keys=True)
        result = instance.update(observations, odometry=frame["odometry"], road_state=frame["road_state"], tick=frame["tick"])
        if json.dumps(observations, sort_keys=True) != before:
            raise ValueError("Runtime filter mutated raw observations")
        kept, removed = result["kept_indices"], result["rejected_indices"]
        indices = kept + removed
        if any(type(i) is not int for i in indices) or sorted(indices) != list(range(len(observations))):
            raise ValueError("Runtime filter must return a complete, disjoint detection-index partition")
        rejected.extend(f"{frame['frame_id']}:det-{i}" for i in removed)
        decisions.append({"frame_id": frame["frame_id"], **result})
    return rejected, decisions


def run(args):
    frozen = freeze_verified(args.freeze_manifest, args.filter_file) if args.dataset == "test" else None
    paths = sorted(TEST_ROOT.glob("map-??.json")) if args.dataset == "test" else dev_paths()
    frames, rows, inventory, bindings = dataset(paths, args.dataset)
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    save(out / f"{args.dataset}_runtime_frames.json", {"schema": "wm-filter-runtime-frames/v1", "frames": frames})
    save(out / f"{args.dataset}_labels.json", {"schema": "wm-filter-truth-labels/v1", "policy": POLICY, "model": M5,
                                             "frame_bindings": bindings, "rows": rows})
    save(out / f"{args.dataset}_inventory.json", inventory)
    baseline_ids = [r["row_id"] for r in rows if r["baseline_rejected"]]
    report = {"schema": "wm-detection-filter-evaluation/v1", "dataset": args.dataset, "policy": POLICY, "model": M5,
              "source_inventory": inventory, "raw_frames": len(frames), "raw_detections": len(rows),
              "binding_counts": dict(collections.Counter(r["truth_binding"].get("binding", r["truth_binding"].get("reason")) for r in rows)),
              "frame_binding_counts": dict(collections.Counter(r["truth_binding"].get("binding", r["truth_binding"].get("reason")) for r in bindings)),
              "baseline": summarize(rows, baseline_ids), "self_checks": self_checks(rows),
              "wm_eligibility_separate": {"in_window": sum(r["wm_window_eligible"] for r in rows), "out_window": sum(not r["wm_window_eligible"] for r in rows)},
              "by_map_baseline": {m: summarize([r for r in rows if r["map"] == m], baseline_ids) for m in sorted({r["map"] for r in rows})},
              "frozen_files": frozen, "all_gates_pass": False}
    if args.filter_file:
        rejected, decisions = replay_filter(frames, args.filter_file)
        report["candidate_standalone"] = summarize(rows, rejected)
        report["candidate_plus_baseline"] = summarize(rows, set(rejected) | set(baseline_ids))
        report["filter_sha256"] = sha(args.filter_file)
        report["test_ten_layout_inventory_complete"] = args.dataset == "test" and test_inventory_complete(inventory)
        report["test_exact_full_coverage"] = (report["test_ten_layout_inventory_complete"] and bool(frames)
            and all(r["truth_binding"].get("binding") == "native_exact_render" for r in bindings)
            and all(r["label"] != "unknown" for r in rows))
        report.update(performance_gates(report["candidate_plus_baseline"], report["test_exact_full_coverage"], args.dataset))
        report["primary_comparison"] = "candidate_plus_baseline; existing confidence filter retained, WM window/category routing excluded"
        save(out / f"{args.dataset}_decisions.json", decisions)
    save(out / f"{args.dataset}_evaluation.json", report)
    print(json.dumps({"out": str(out), "frames": len(frames), "raw": len(rows), "baseline": report["baseline"], "self_checks": report["self_checks"]}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", choices=("dev", "test"), default="dev")
    parser.add_argument("--out", default=str(ROOT / "artifacts/inloop/opt-1/filter-development"))
    parser.add_argument("--filter-file")
    parser.add_argument("--freeze-manifest")
    run(parser.parse_args())


if __name__ == "__main__":
    main()
