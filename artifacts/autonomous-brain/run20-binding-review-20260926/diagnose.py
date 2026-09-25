#!/usr/bin/env python3
"""Offline diagnostic only: unchanged frozen v4 geometry and action judgments.

Run from the repository root with Python 3. No network, simulator, credentials,
production modules, original evidence writes, or replacement formal verdict.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
import math
from pathlib import Path
import runpy

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
TRIAL = ROOT / "artifacts/autonomous-brain/map05-run-20/map-05-run-1"
TRACKS = ("target_031", "target_111")


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load(path):
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as source:
        return json.load(source)


def lines(name):
    with (TRIAL / "brain" / (name + ".jsonl")).open() as source:
        return [json.loads(line) for line in source]


def stats(rows):
    values = [row["error_cm"] for row in rows]
    return {"count": len(values), "mean_cm": sum(values) / len(values) if values else None,
            "rmse_cm": math.sqrt(sum(x*x for x in values) / len(values)) if values else None,
            "max_cm": max(values) if values else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="diagnostic-v1.json")
    args = parser.parse_args()
    destination = (HERE / args.output).resolve()
    if destination.parent != HERE or destination.exists():
        raise ValueError("output must be a new file inside this diagnostic directory")
    manifest = load(HERE / "input-sha256.json")
    verified = {item["path"]: sha(ROOT / item["path"]) == item["sha256"]
                for item in manifest["inputs"]}
    assert all(verified.values()), "input SHA changed"
    evaluator_path = ROOT / manifest["evaluator_source"]["snapshot_path"]
    assert sha(evaluator_path) == manifest["evaluator_source"]["sha256"]
    evaluator = runpy.run_path(str(evaluator_path))
    assert evaluator["VERSION"] == "autonomous-brain-offline-evaluation/v4"
    formal = load(TRIAL.parent / "report/evaluation.json")
    assert formal["evaluator_sha256"] == sha(evaluator_path)
    observations, rounds, motions = lines("observations"), lines("rounds"), lines("motions")
    captures = load(TRIAL / "captures.json.gz")
    # Keep only original native fields consumed by the unchanged evaluator.
    full_record = load(TRIAL / "record.json.gz")
    record = {"complete": full_record["complete"], "clock": full_record["clock"],
              "native": {key: full_record["native"][key]
                         for key in ("samples", "events", "taskDefinition")}}
    del full_record
    assert record["native"]["samples"] == load(TRIAL / "samples.json.gz")
    expected = sorted({identity for definition in record["native"]["taskDefinition"]["deliveries"]
                       if definition.get("objectRole") == "target"
                       and definition.get("destinationRole") == "storage"
                       for identity in definition.get("requiredPackageIds", [])})
    summary = load(TRIAL / "brain/summary.json")
    perception = evaluator["evaluate_perception"](observations, captures, record, summary, expected)
    judge = evaluator["evaluate_judge"](record, rounds, observations, motions,
                                         perception["track_truth_bindings"])
    assert perception == formal["perception"], "frozen v4 perception differs from formal report"
    assert judge == formal["judge"], "frozen v4 Judge differs from formal report"
    by_obs = {row["observation_index"]: row for row in observations}
    by_frame = defaultdict(list)
    for capture in captures:
        by_frame[str(capture["frameId"])].append(capture)

    def frame(index):
        observation = by_obs[index]
        sensor = observation["observation"]
        matches = by_frame[str(sensor["frameId"])]
        assert len(matches) == 1 and matches[0]["tick"] == sensor["tick"]
        capture = matches[0]
        red = [row for row in evaluator["match_pixels"](sensor["detections"], capture)
               if row["category"] == "red-ball"]
        transformed = []
        for truth in capture["truthObjects"]:
            if truth["category"] == "red-ball":
                transformed.append({**truth,
                    "projection": evaluator["project_center"](truth, capture["cameraPose"]),
                    "odometry_m": evaluator["world_to_odometry"](
                        truth["centerWorld"], capture["odometryOrigin"], capture["worldUnitsToMeters"])})
        return {"observation_index": index, "round": observation["round"],
                "simulation_seconds": observation["simulation_seconds"], "tick": sensor["tick"],
                "brain_holding": observation["holding"]["holding"],
                "holdingTruthId": capture["holdingTruthId"],
                "red_geometry": red,
                "red_converted": [row for row in observation["perception"]["detections"]
                                  if row["category"] == "red-ball"],
                "tracked_rows": [row for row in observation["objects"] if row["id"] in TRACKS],
                "red_truth": transformed, "cameraPose": capture["cameraPose"],
                "robotWorldPose": capture["robotWorldPose"],
                "odometryOrigin": capture["odometryOrigin"],
                "worldUnitsToMeters": capture["worldUnitsToMeters"]}

    conflicts, histories = [], {}
    for track in TRACKS:
        bindings = [row for row in perception["binding_evidence"] if row["track_id"] == track]
        original = bindings[0]["truth_id"]
        wrong = [row for row in bindings if row["truth_id"] != original]
        histories[track] = {"first_unique_geometry_truth_id": original,
            "unique_geometry_counts": dict(Counter(row["truth_id"] for row in bindings)),
            "all_binding_rows": bindings, "conflicting_observation_indices": [row["observation_index"] for row in wrong]}
        for row in wrong:
            evidence = frame(row["observation_index"])
            histories_at_frame = {item["id"]: item for item in evidence["tracked_rows"]}
            converted = next(item for item in evidence["red_converted"]
                             if item.get("track_id") == track and item["bbox"] == row["bbox"])
            gaps = {oid: math.hypot(converted["position_m"]["x"] - item["position_m"]["x"],
                                    converted["position_m"]["z"] - item["position_m"]["z"])
                    for oid, item in histories_at_frame.items() if item["state"] == "DELIVERED"}
            candidates, candidate_table = [], []
            for detection in evidence["red_converted"]:
                geometry = next(item for item in evidence["red_geometry"] if item["bbox"] == detection["bbox"])
                distances = {oid: math.hypot(detection["position_m"]["x"] - item["position_m"]["x"],
                                            detection["position_m"]["z"] - item["position_m"]["z"])
                             for oid, item in histories_at_frame.items() if item["state"] == "DELIVERED"}
                # This is exactly the existing delivered-suppression gate, not
                # an identity rule added to the frozen evaluator.
                for oid, gap in distances.items():
                    if gap <= .15:
                        candidates.append((gap, geometry["detection_index"], oid))
                candidate_table.append({"detection_index": geometry["detection_index"],
                    "geometric_truth_id": geometry["truth_id"], "geometry_status": geometry["status"],
                    "bbox": detection["bbox"], "position_m": detection["position_m"],
                    "distances_to_delivered_memory_m": distances,
                    "logged_known_delivered_object_id": detection.get("known_delivered_object_id")})
            used_detections, used_ids, chosen = set(), set(), []
            for gap, index, oid in sorted(candidates):
                if index not in used_detections and oid not in used_ids:
                    used_detections.add(index); used_ids.add(oid)
                    chosen.append({"distance_m": gap, "detection_index": index, "delivered_object_id": oid})
            assert all(next((item["delivered_object_id"] for item in chosen
                             if item["detection_index"] == candidate["detection_index"]), None)
                       == candidate["logged_known_delivered_object_id"] for candidate in candidate_table)
            conflicts.append({"track_id": track, "original_geometry_truth_id": original,
                              "new_geometry_truth_id": row["truth_id"],
                              "delivered_memory_distances_m": gaps,
                              "existing_suppression_candidate_table": candidate_table,
                              "existing_suppression_greedy_choices": chosen,
                              "existing_suppression_exactly_reproduced": True, "frame": evidence})

    temporal = []
    for row in rounds:
        action = row.get("action") or {}
        if action.get("action") not in ("pick", "place"):
            continue
        result = row["result"]; evidence = result["evidence"]
        track = evidence["object_id"]
        before = evidence["before_observation"]
        after = evidence.get("final_observation", evidence["after_observation"])
        # Same global aggregation algorithm, but a declared causal prefix ending
        # at this completed action. Never delete inconvenient within-prefix frames.
        prefix_sets = defaultdict(set)
        for binding in perception["binding_evidence"]:
            if binding["observation_index"] <= after:
                prefix_sets[binding["track_id"]].add(binding["truth_id"])
        prefix_bindings = {key: next(iter(values)) for key, values in prefix_sets.items() if len(values) == 1}
        local_judge = evaluator["evaluate_judge"](record, [row], observations, motions, prefix_bindings)["rows"][0]
        references = {before, after, evidence.get("post_observation", after)}
        if evidence.get("release_observation"):
            references.add(int(evidence["release_observation"]["frame_id"]))
        if evidence.get("placement"):
            references.add(int(evidence["placement"]["frame_id"]))
        for attempt in evidence.get("attempts", []):
            references.update((attempt["before_observation"], attempt["after_observation"]))
        start_tick = by_obs[before]["observation"]["tick"]
        end_tick = by_obs[after]["observation"]["tick"]
        native = record["native"]
        events = [{"native_event_index": index, **event} for index, event in enumerate(native["events"])
                  if event.get("packageId") in expected and start_tick < event.get("tick", -1) <= end_tick]
        endpoints = []
        for tick in (start_tick, end_tick):
            samples = [{"tick": sample["tick"], "holding": sample.get("holding"),
                        "packages": [p for p in sample.get("packages", []) if p.get("id") in expected]}
                       for sample in native["samples"] if sample.get("tick") == tick]
            endpoints.append({"tick": tick, "samples": samples})
        temporal.append({"round": row["round"], "action": action, "object_id": track,
                         "action_result": {"success": result["success"], "reason": result["reason"]},
                         "prefix_end_observation": after,
                         "prefix_target_truth_ids": sorted(prefix_sets[track]),
                         "original_formal_judge": next(x for x in judge["rows"] if x["round"] == row["round"]),
                         "diagnostic_prefix_judge": local_judge,
                         "original_placement": evidence.get("placement"),
                         "native_events": events, "native_endpoints": endpoints,
                         "frames": [frame(index) for index in sorted(references)]})

    cutoff = min(row["frame"]["observation_index"] for row in conflicts) - 1
    prefix_p = evaluator["evaluate_perception"](
        [row for row in observations if row["observation_index"] <= cutoff], captures, record, summary, expected)
    error_samples = [row for row in prefix_p["position_samples"] if row["track_id"] in TRACKS]
    unmatched = [row for row in prefix_p["unmatched_confirmed_samples"] if row["track_id"] in TRACKS]
    after_hashes = {item["path"]: sha(ROOT / item["path"]) == item["sha256"] for item in manifest["inputs"]}
    assert all(after_hashes.values())
    output = {"schema": "run20-binding-diagnostic/v1", "diagnostic_only": True,
              "formal_run_success": False, "formal_verdict_unchanged": True,
              "evaluator_version": evaluator["VERSION"], "evaluator_sha256": sha(evaluator_path),
              "script_sha256": sha(Path(__file__)), "input_sha256_manifest": "input-sha256.json",
              "inputs_unchanged": all(after_hashes.values()),
              "checks": {"frozen_v4_perception_exactly_matches_formal_report": True,
                         "frozen_v4_judge_exactly_matches_formal_report": True,
                         "native_samples_equal_separate_samples_export": True},
              "formal": {"ambiguous_track_ids": perception["ambiguous_track_ids"],
                         "position_error": perception["position_error"],
                         "unmatched_confirmed_count": perception["unmatched_confirmed_count"],
                         "judge_counts": judge["counts"], "failures": formal["failures"]},
              "binding_histories": histories, "conflicts": conflicts,
              "temporal_actions": temporal,
              "diagnostic_position_error": {
                  "scope": "CONFIRMED observations through the frame before the first global identity conflict; exact frozen-v4 transform and geometry",
                  "prefix_end_observation": cutoff, "stats": stats(error_samples),
                  "by_track": {track: stats([row for row in error_samples if row["track_id"] == track]) for track in TRACKS},
                  "samples": error_samples, "unmatched": unmatched,
                  "unmatched_reasons": dict(Counter(row["reason"] for row in unmatched))},
              "limitations": [
                  "Prefixes are retrospective diagnostic scopes, not a replacement for the formal full-run identity rule.",
                  "Unique projected-center geometry does not independently establish visibility through occlusion.",
                  "No evidence or source was rewritten, and no geometry threshold changed.",
                  "Run20 remains FAIL: the 200-round limit and absence of autonomous done are not repaired by this diagnosis."]}
    with destination.open("x", encoding="utf-8") as target:
        json.dump(output, target, ensure_ascii=False, indent=2, allow_nan=False)
        target.write("\n")
    print(json.dumps({"output": destination.relative_to(ROOT).as_posix(),
                      "sha256": sha(destination), "formal_unchanged": True,
                      "conflicting_frames": [row["frame"]["observation_index"] for row in conflicts],
                      "prefix_judge": [{"round": row["round"], **row["diagnostic_prefix_judge"]} for row in temporal],
                      "diagnostic_error": output["diagnostic_position_error"]["stats"],
                      "diagnostic_unmatched": len(unmatched)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
