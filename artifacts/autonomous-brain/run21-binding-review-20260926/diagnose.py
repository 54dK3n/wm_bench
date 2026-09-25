#!/usr/bin/env python3
"""Unchanged evaluator v4 on global Run21 evidence and declared action prefixes.

This offline diagnosis never replaces the formal report or removes within-prefix
observations. Source and original evidence hashes are checked before and after.
"""
from collections import Counter, defaultdict
import gzip
import hashlib
import json
import math
from pathlib import Path
import runpy
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
TRIAL = ROOT / "artifacts/autonomous-brain/map05-run-21/map-05-run-1"


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load(path):
    with (gzip.open if path.suffix == ".gz" else open)(path, "rt", encoding="utf-8") as source:
        return json.load(source)


def lines(name):
    with (TRIAL / "brain" / (name + ".jsonl")).open() as source:
        return [json.loads(line) for line in source]


def stats(rows):
    errors = [r["error_cm"] for r in rows]
    return {"count": len(errors), "mean_cm": sum(errors) / len(errors) if errors else None,
            "rmse_cm": math.sqrt(sum(e * e for e in errors) / len(errors)) if errors else None,
            "max_cm": max(errors) if errors else None}


def main():
    destination = HERE / "diagnostic-v1.json"
    if destination.exists():
        raise ValueError("refusing to overwrite a completed diagnosis")
    manifest = load(HERE / "input-sha256.json")

    def verify():
        result = {r["path"]: sha(ROOT / r["path"]) == r["sha256"] for r in manifest["inputs"]}
        assert all(result.values()), "original input bytes changed"
        return result

    verify()
    evaluator_path = ROOT / manifest["evaluator_source"]["snapshot_path"]
    assert sha(evaluator_path) == manifest["evaluator_source"]["sha256"]
    evaluator = runpy.run_path(str(evaluator_path))
    assert evaluator["VERSION"] == "autonomous-brain-offline-evaluation/v4"
    formal = load(TRIAL.parent / "report/evaluation.json")
    assert formal["evaluator_sha256"] == sha(evaluator_path)
    observations, rounds, motions = lines("observations"), lines("rounds"), lines("motions")
    captures, summary = load(TRIAL / "captures.json.gz"), load(TRIAL / "brain/summary.json")
    full_record = load(TRIAL / "record.json.gz")
    # Keep the original evaluator's exact inputs; do not retain unrelated
    # render payloads after parsing the authenticated record.
    record = {"complete": full_record["complete"], "clock": full_record["clock"],
              "native": {key: full_record["native"][key] for key in ("samples", "events", "taskDefinition")}}
    del full_record
    assert record["native"]["samples"] == load(TRIAL / "samples.json.gz")
    expected = sorted({identity for d in record["native"]["taskDefinition"]["deliveries"]
                       if d.get("objectRole") == "target" and d.get("destinationRole") == "storage"
                       for identity in d.get("requiredPackageIds", [])})
    global_p = evaluator["evaluate_perception"](observations, captures, record, summary, expected)
    global_j = evaluator["evaluate_judge"](record, rounds, observations, motions, global_p["track_truth_bindings"])
    assert global_p == formal["perception"]
    assert global_j == formal["judge"]
    by_obs = {o["observation_index"]: o for o in observations}
    by_frame = defaultdict(list)
    for c in captures:
        by_frame[str(c["frameId"])].append(c)
    eligible = [r for r in rounds if (r.get("action") or {}).get("action") in {"pick", "place"}]

    def track_of(row):
        action = row["action"]
        selected = action.get("params", {}).get("object_id") if action["action"] == "pick" else row["state"]["robot"].get("held_object_id")
        return row["result"].get("evidence", {}).get("object_id", selected)

    action_tracks = sorted({track_of(r) for r in eligible})
    investigated_tracks = sorted(set(action_tracks) | set(global_p["ambiguous_track_ids"]))

    def frame(index):
        o = by_obs[index]
        matches = by_frame[str(o["observation"]["frameId"])]
        assert len(matches) == 1 and matches[0]["tick"] == o["observation"]["tick"]
        c = matches[0]
        return {"observation_index": index, "round": o["round"], "tick": o["observation"]["tick"],
                "simulation_seconds": o["simulation_seconds"], "brain_holding": o["holding"]["holding"],
                "holding_truth_id": c["holdingTruthId"],
                "red_geometry": [x for x in evaluator["match_pixels"](o["observation"]["detections"], c) if x["category"] == "red-ball"],
                "red_converted": [x for x in o["perception"]["detections"] if x["category"] == "red-ball"],
                "tracked_rows": [x for x in o["objects"] if x["id"] in investigated_tracks],
                "red_truth": [{**x, "projection": evaluator["project_center"](x, c["cameraPose"]),
                    "odometry_m": evaluator["world_to_odometry"](x["centerWorld"], c["odometryOrigin"], c["worldUnitsToMeters"])}
                    for x in c["truthObjects"] if x["category"] == "red-ball"],
                "cameraPose": c["cameraPose"], "odometryOrigin": c["odometryOrigin"],
                "worldUnitsToMeters": c["worldUnitsToMeters"]}

    histories, conflicts = {}, []
    for track in investigated_tracks:
        bindings = [b for b in global_p["binding_evidence"] if b["track_id"] == track]
        original = bindings[0]["truth_id"] if bindings else None
        wrong = [b for b in bindings if b["truth_id"] != original]
        histories[track] = {"first_unique_geometry_truth_id": original,
            "unique_geometry_counts": dict(Counter(b["truth_id"] for b in bindings)),
            "all_binding_rows": bindings, "conflicting_observation_indices": [b["observation_index"] for b in wrong]}
        for b in wrong:
            conflicts.append({"track_id": track, "original_geometry_truth_id": original,
                              "new_geometry_truth_id": b["truth_id"], "frame": frame(b["observation_index"])})

    temporal = []
    for row in eligible:
        evidence = row["result"]["evidence"]
        before, after = evidence["before_observation"], evidence.get("final_observation", evidence["after_observation"])
        prefix = [o for o in observations if o["observation_index"] <= after]
        assert [o["observation_index"] for o in prefix] == list(range(1, after + 1))
        prefix_motions = [m for m in motions if m["after_observation"] <= after]
        # Invoke the complete unchanged global aggregation on every full causal
        # observation prefix. This is not selected-frame or nearest-track repair.
        local_p = evaluator["evaluate_perception"](prefix, captures, record, summary, expected)
        local_j = evaluator["evaluate_judge"](record, [row], prefix, prefix_motions, local_p["track_truth_bindings"])["rows"][0]
        track = track_of(row)
        refs = {before, after, evidence.get("post_observation", after)}
        for name in ("release_observation", "placement"):
            if evidence.get(name):
                refs.add(int(evidence[name]["frame_id"]))
        for attempt in evidence.get("attempts", []):
            refs.update((attempt["before_observation"], attempt["after_observation"]))
        t0, t1 = (by_obs[i]["observation"]["tick"] for i in (before, after))
        target_ids = sorted({b["truth_id"] for b in local_p["binding_evidence"] if b["track_id"] == track})
        native_events = [{"native_event_index": i, **e} for i, e in enumerate(record["native"]["events"])
                         if e.get("packageId") in expected and t0 < e.get("tick", -1) <= t1]
        temporal.append({"round": row["round"], "action": row["action"], "object_id": track,
            "action_result": {k: row["result"][k] for k in ("success", "reason")},
            "prefix_start_observation": 1, "prefix_end_observation": after,
            "prefix_observation_count": len(prefix), "prefix_contains_all_observations": True,
            "prefix_target_truth_ids": target_ids,
            "prefix_bindings": local_p["track_truth_bindings"], "prefix_ambiguous_track_ids": local_p["ambiguous_track_ids"],
            "original_formal_judge": next(j for j in global_j["rows"] if j["round"] == row["round"]),
            "diagnostic_prefix_judge": local_j, "original_placement": evidence.get("placement"),
            "native_events": native_events,
            "native_endpoints": [{"tick": t, "samples": [{"tick": s["tick"], "holding": s.get("holding"),
                "packages": [p for p in s.get("packages", []) if p.get("id") in expected]}
                for s in record["native"]["samples"] if s.get("tick") == t]} for t in (t0, t1)],
            "frames": [frame(i) for i in sorted(refs)]})

    # First confirmation uses only consistent same-frame geometry accumulated
    # by that observation. Do not assign later identities to earlier frames.
    binding_at = defaultdict(list)
    for b in global_p["binding_evidence"]:
        binding_at[b["observation_index"]].append(b)
    seen_ids, causal_confirmation = defaultdict(set), {}
    for o in observations:
        for b in binding_at[o["observation_index"]]:
            seen_ids[b["track_id"]].add(b["truth_id"])
        for obj in o["objects"]:
            ids = seen_ids[obj["id"]]
            if obj.get("category") == "red-ball" and obj.get("state", obj.get("status")) == "CONFIRMED" and len(ids) == 1:
                identity = next(iter(ids))
                causal_confirmation.setdefault(identity, {"observation_index": o["observation_index"],
                    "round": o["round"], "frame_id": str(o["observation"]["frameId"]), "tick": o["observation"]["tick"],
                    "simulation_seconds": o["simulation_seconds"], "track_id": obj["id"],
                    "prefix_identity_set": sorted(ids)})
    timeline = [{"truth_id": b["truth_id"], "first_raw_seen": b["first_raw_seen"],
        "original_global_first_confirmed": b["first_confirmed"],
        "diagnostic_first_confirmed_with_consistent_causal_binding": causal_confirmation.get(b["truth_id"]),
        "first_grabbed_truth_event": b["first_grabbed_truth_event"],
        "first_delivered_truth_event": b["first_delivered_truth_event"],
        "final_active_delivery_truth_event": b["final_active_delivery_truth_event"],
        "delivery_revocations": b["delivery_revocations"],
        "brain_action_track_timelines": [t for t in summary["timeline"] if t.get("object_id") in action_tracks
            and histories[t["object_id"]]["first_unique_geometry_truth_id"] == b["truth_id"]]}
        for b in global_p["timeline"]]
    cutoff = min(c["frame"]["observation_index"] for c in conflicts) - 1 if conflicts else observations[-1]["observation_index"]
    pre_conflict = evaluator["evaluate_perception"]([o for o in observations if o["observation_index"] <= cutoff], captures, record, summary, expected)
    error_samples = [s for s in pre_conflict["position_samples"] if s["track_id"] in action_tracks]
    unmatched = [s for s in pre_conflict["unmatched_confirmed_samples"] if s["track_id"] in action_tracks]
    after_hashes = verify()
    assert sha(evaluator_path) == manifest["evaluator_source"]["sha256"]
    output = {"schema": "run21-binding-diagnostic/v1", "diagnostic_only": True,
        "formal_run_success": formal["success"], "formal_verdict_unchanged": True,
        "evaluator_version": evaluator["VERSION"], "evaluator_sha256": sha(evaluator_path),
        "script_sha256": sha(Path(__file__)), "input_sha256_manifest": "input-sha256.json",
        "inputs_unchanged": all(after_hashes.values()),
        "checks": {"frozen_v4_global_perception_exactly_matches_formal_report": True,
            "frozen_v4_global_judge_exactly_matches_formal_report": True,
            "native_samples_equal_separate_export": True,
            "all_action_prefixes_contain_every_observation_from_one_to_final": True},
        "formal": {"ambiguous_track_ids": global_p["ambiguous_track_ids"], "position_error": global_p["position_error"],
            "unmatched_confirmed_count": global_p["unmatched_confirmed_count"], "judge_counts": global_j["counts"],
            "failures": formal["failures"]},
        "action_tracks_derived_from_saved_actions": action_tracks,
        "binding_histories": histories, "conflicts": conflicts, "temporal_actions": temporal,
        "causal_target_timeline": timeline,
        "diagnostic_position_error": {"scope": "All CONFIRMED action-track observations in the contiguous prefix before the earliest identity conflict; unchanged v4 geometry and transform",
            "prefix_end_observation": cutoff, "stats": stats(error_samples),
            "by_track": {t: stats([s for s in error_samples if s["track_id"] == t]) for t in action_tracks},
            "samples": error_samples, "unmatched": unmatched,
            "unmatched_reasons": dict(Counter(s["reason"] for s in unmatched))},
        "limitations": ["Temporal scopes diagnose later global ambiguity; they do not replace the formal full-run identity rule.",
            "No inconvenient frame is omitted within any declared prefix.",
            "Unique projected-centre geometry does not independently establish occlusion visibility.",
            "No geometry threshold, production source, original report or formal FAIL was changed.",
            "A pre-release rejection without a release motion remains unverifiable under the unchanged Judge.",
            "Run21 still failed after LLM quota errors and never completed an observed done."]}
    with destination.open("x") as f:
        json.dump(output, f, ensure_ascii=False, indent=2, allow_nan=False)
        f.write("\n")
    print(json.dumps({"output": destination.relative_to(ROOT).as_posix(), "sha256": sha(destination),
        "formal_unchanged": True, "conflicts": [{"track": c["track_id"], "observation": c["frame"]["observation_index"]} for c in conflicts],
        "prefix_judge": [{"round": a["round"], **a["diagnostic_prefix_judge"]} for a in temporal],
        "diagnostic_error": output["diagnostic_position_error"]["stats"],
        "diagnostic_unmatched": len(unmatched), "prefix_before_conflict": cutoff}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
