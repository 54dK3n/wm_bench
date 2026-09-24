#!/usr/bin/env python3
"""Reproduce confidence-filter development evidence; authorized dev inputs only.

python3 tools/detection_filter_development.py
Never reads the sealed evaluation trials or starts a simulator.
"""
import argparse
from collections import Counter
import hashlib
import itertools
import json
from pathlib import Path

from detection_evaluation import read, replay_filter, summarize
from stage_report import compare, POLICY

ROOT = Path(__file__).resolve().parents[1]
SUPPORT = {
    "target": [("calib_runs_v6/attempt-02.json", 91), ("calib_runs_v6/attempt-08.json", 77), ("v28r1_batch/map-09.json", 87)],
    "distractor": [("calib_runs/try-1.json", 17), ("calib_runs_v6/attempt-08.json", 20), ("calib_runs_v6/attempt-05.json", 56)],
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def category_trace(path, category):
    raw = read(path)
    frames = [(index, line) for index, line in enumerate(raw["lines"])
              if line.get("event") in ("observe", "calib_obs")]
    active = [index for index, (_source, frame) in enumerate(frames)
              if any(item.get("category") == category for item in frame.get("raw", frame.get("dets", [])))]
    start, end = active[0], active[-1]
    origin = frames[start][1]["tick"]
    trace, indices = [], []
    for index, frame in frames[start:end + 1]:
        detections = [{"category": item["category"], "distance_cm": item["distanceCm"],
                       "bearing_deg": item["bearingDeg"], "confidence": item["confidence"]}
                      for item in frame.get("raw", frame.get("dets", [])) if item.get("category") == category]
        trace.append({"event": "observe", "relative_tick": frame["tick"] - origin,
                      "detections": sorted(detections, key=lambda item: (item["bearing_deg"], item["distance_cm"], item["confidence"]))})
        indices.append(index)
    return {"source": str(path), "source_sha256": sha(path), "category": category,
            "source_line_indices": indices, "frame_count": len(trace), "detection_count": sum(len(frame["detections"]) for frame in trace),
            "duration_ticks": trace[-1]["relative_tick"], "trace": trace}


def generate(dev_dir, filter_path):
    labels_path, frames_path = dev_dir / "dev_labels.json", dev_dir / "dev_runtime_frames.json"
    labels, frames = read(labels_path)["rows"], read(frames_path)["frames"]
    for row in labels:
        relative = Path(row["source"]).resolve().relative_to(ROOT / "artifacts/inloop")
        if not (relative.parts[0].startswith("calib_runs") or relative.parts[0] == "v28r1_batch"):
            raise ValueError(f"Not an authorized development source: {relative}")
    rejected, _decisions = replay_filter(frames, filter_path)
    rejected = set(rejected)
    # Values are imported from the runtime module by its evaluation adapter;
    # derive each threshold from the corresponding decision diagnostic.
    _ids, decisions = replay_filter(frames, filter_path)
    floors = {item["category"]: item["confidence_floor"] for frame in decisions for item in frame["decisions"]
              if item.get("confidence_floor") is not None}
    rules = {}
    for category, specs in SUPPORT.items():
        traces, evidence = [], []
        for relative, index in specs:
            path = ROOT / "artifacts/inloop" / relative
            matches = [row for row in labels if Path(row["source"]) == path and row["raw_line_index"] == index
                       and row["category"] == category and row["row_id"] in rejected and row["label"] == "false" and not row["capped"]]
            if len(matches) != 1:
                raise ValueError(f"Support must be one labelled uncapped rejected row: {relative}:{index}")
            row = matches[0]
            evidence.append({key: row[key] for key in ("row_id", "source", "raw_line_index", "tick", "category", "observation", "label", "capped", "geometry")})
            traces.append(category_trace(path, category))
        comparisons = [{"pair": [a["source"], b["source"]], **compare(a["trace"], b["trace"])}
                       for a, b in itertools.combinations(traces, 2)]
        boundary = [row for row in labels if row["category"] == category and row["label"] == "true"
                    and row["observation"]["confidence"] == floors[category]]
        rules[category] = {"confidence_floor": floors[category], "comparison": "reject confidence strictly below floor; equality retained",
            "selection": "lowest confidence among all development rows labelled true in this class; conservative zero observed labelled-true loss",
            "boundary_true_rows": [{key: row[key] for key in ("row_id", "source", "raw_line_index", "tick", "observation", "same_color_matches", "capped")} for row in boundary],
            "three_uncapped_false_supports": evidence, "full_category_traces": traces, "pairwise_comparisons": comparisons,
            "at_least_three_independent_sequences": len(traces) >= 3 and all(not item["equivalent"] for item in comparisons)}
    counts = {}
    for category in SUPPORT:
        subset = [row for row in labels if row["category"] == category]
        counts[category] = {
            "rejected_by_label": dict(Counter(row["label"] for row in subset if row["row_id"] in rejected)),
            "rejected_capped_by_label": dict(Counter(row["label"] for row in subset if row["row_id"] in rejected and row["capped"])),
            "rejected_uncapped_by_label": dict(Counter(row["label"] for row in subset if row["row_id"] in rejected and not row["capped"])),
        }
    metrics = summarize(labels, rejected)
    return {"schema": "wm-filter-development-provenance/v1", "filter_file": str(filter_path), "filter_sha256": sha(filter_path),
        "dev_labels_sha256": sha(labels_path), "dev_runtime_frames_sha256": sha(frames_path),
        "no_test_data_read": True, "baseline": summarize(labels, [row["row_id"] for row in labels if row["baseline_rejected"]]),
        "candidate": metrics, "unknown_and_capped_rejections": counts, "rules": rules,
        "grouping": {"comparison_code": str(ROOT / "tools/stage_report.py"), "comparison_code_sha256": sha(ROOT / "tools/stage_report.py"),
            "tolerances_unchanged": POLICY["near_tolerances"],
            "normalization": "all observe frames from first to last detection of the relevant class; absolute ticks removed; raw readings retained; no layout/track IDs, format-specific fields or unavailable odometry used",
            "independence_basis": "three full class-related observation sequences are pairwise non-equivalent at existing tolerances; not layout names, not three isolated samples of one trajectory"},
        "labeled_dev_gates": {color: metric["false_kill_rate"] <= .02 and metric["filter_precision"] is not None and metric["filter_precision"] >= .95
                              for color, metric in metrics.items() if color in ("red", "blue")},
        "limits": ["Known labels cover only part of the raw observations; filtered unknowns are not declared false.",
                   "Legacy exact tick/stationary-pose evidence lacks native PNG/render matrices.",
                   "100cm labels follow the specified mechanical convention; runtime filter never uses distance.",
                   "Low-confidence suppression does not separate all true and false detections; high-confidence false detections remain.",
                   "These are development metrics, not sealed-test results or a generalization claim."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dev-dir", type=Path, default=ROOT / "artifacts/inloop/opt-1/filter-development")
    parser.add_argument("--filter-file", type=Path, default=ROOT / "programs/src/detection_filter.py")
    parser.add_argument("--out", type=Path, default=ROOT / "artifacts/inloop/opt-1/filter-candidate-v1/constant_provenance.json")
    args = parser.parse_args()
    report = generate(args.dev_dir.resolve(), args.filter_file.resolve())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(args.out), "labeled_dev_gates": report["labeled_dev_gates"],
                      "independence": {key: value["at_least_three_independent_sequences"] for key, value in report["rules"].items()}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
