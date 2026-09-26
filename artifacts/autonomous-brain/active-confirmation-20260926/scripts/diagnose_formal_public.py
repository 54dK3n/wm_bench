#!/usr/bin/env python3
"""Create a public-log diagnosis; never import the brain or read evaluator truth.

Only summary.json, rounds.jsonl, motions.jsonl and observations.jsonl are read.
Observations are streamed. A completed, stable input and a new output are required.
This is a log join/counting script, not an acceptance evaluator or identity oracle.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path


FOCUS_ROUNDS = {8, 9, 68, 69, 93, 94, 95, 96, 97, 98}
FOCUS_OBSERVATIONS = {356, 357, 358} | set(range(476, 489))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def selected(row, keys):
    return {key: row[key] for key in keys if key in row}


def walk(value, pointer=""):
    if isinstance(value, dict):
        yield pointer, value
        for key, child in value.items():
            escaped = str(key).replace("~", "~0").replace("/", "~1")
            yield from walk(child, pointer + "/" + escaped)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, pointer + "/" + str(index))


def pose_distance(a, b):
    return math.hypot(a["rightCm"] - b["rightCm"], a["forwardCm"] - b["forwardCm"])


class Inputs:
    names = ("summary.json", "rounds.jsonl", "motions.jsonl", "observations.jsonl")

    def __init__(self, directory):
        self.paths = {name: directory / name for name in self.names}
        self.before = {name: self.signature(path) for name, path in self.paths.items()}
        self.sources = {}

    @staticmethod
    def signature(path):
        stat = path.stat()
        return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns

    def summary(self):
        path = self.paths["summary.json"]
        data = path.read_bytes()
        self.sources["summary.json"] = {"path": str(path), "sha256": digest(data), "bytes": len(data)}
        value = json.loads(data)
        if value.get("status") not in {"done", "failed"} or value.get("reason") == "not_started":
            raise ValueError("A completed brain summary is required; do not diagnose a running prefix")
        return value

    def rows(self, name):
        path = self.paths[name]
        sha, count, size = hashlib.sha256(), 0, 0
        with path.open("rb") as stream:
            for number, line in enumerate(stream, 1):
                if not line.endswith(b"\n") or not line.strip():
                    raise ValueError(f"Incomplete or empty log line: {name}:{number}")
                sha.update(line)
                count += 1
                size += len(line)
                yield json.loads(line), {"file": name, "line": number, "line_sha256": digest(line)}
        self.sources[name] = {"path": str(path), "sha256": sha.hexdigest(), "rows": count, "bytes": size}

    def unchanged(self):
        for name, path in self.paths.items():
            if self.signature(path) != self.before[name]:
                raise ValueError(f"Input changed while reading: {name}; do not publish prefix totals")


def diagnose(directory):
    inputs = Inputs(directory)
    summary = inputs.summary()
    rounds = list(inputs.rows("rounds.jsonl"))
    motions = list(inputs.rows("motions.jsonl"))
    round_numbers = [row.get("round") for row, _ in rounds]
    if round_numbers != list(range(1, len(rounds) + 1)) or summary.get("rounds") != len(rounds):
        raise ValueError("Completed summary and complete sequential rounds disagree")

    actions, reasons, successful_actions = Counter(), Counter(), Counter()
    reasons_by_action = defaultdict(Counter)
    sampling, reposition, focus_rounds, command_actions = [], [], [], []
    candidate_refs, attempt_versions = {}, {}
    boundary_indices = set(FOCUS_OBSERVATIONS)

    def candidate(value, ref):
        if not isinstance(value, dict) or not isinstance(value.get("path"), list):
            return
        key = value.get("route_version") or digest(canonical(value["path"]).encode())
        entry = candidate_refs.setdefault(key, {"route_version": value.get("route_version"),
            "first_public_candidate": value, "refs": []})
        if ref not in entry["refs"]:
            entry["refs"].append(ref)

    def attempt(value, ref, object_id=None):
        if not isinstance(value, dict) or "before_observation" not in value or "route_version" not in value:
            return
        oid = value.get("canonical_object_id", object_id)
        key = canonical([oid, value["before_observation"], value["route_version"]])
        entry = attempt_versions.setdefault(key, {"object_id": oid, "versions": []})
        if not any(old["evidence"] == value for old in entry["versions"]):
            entry["versions"].append({"ref": ref, "evidence": value})

    for row, ref in rounds:
        number, result = row["round"], row.get("result") or {}
        action = row.get("action") or {}
        name = action.get("action", "no_valid_action")
        evidence = result.get("evidence") or {}
        actions[name] += 1
        reasons[result.get("reason", "missing_reason")] += 1
        reasons_by_action[name][result.get("reason", "missing_reason")] += 1
        if result.get("success") is True:
            successful_actions[name] += 1
        if number in FOCUS_ROUNDS:
            focus_rounds.append({"ref": ref, "original_public_round": row})
        before = evidence.get("before_observation")
        after = evidence.get("final_observation", evidence.get("after_observation"))
        boundary_indices.update(index for index in (before, after) if isinstance(index, int))
        if name in {"pick", "place", "done"}:
            command_actions.append({"round": number, "ref": ref, "action": action, "result": result})
        # A raised post-action error may retain the original result below its
        # evidence. Keep these distinct paths, but never count recent_actions.
        for pointer, item in walk(evidence, "/result/evidence"):
            if item.get("schema") == "brain-confirmation-sampling/v1":
                item_before = (item.get("steps") or [{}])[0].get("before_observation", before)
                item_after = (item.get("steps") or [{}])[-1].get("after_observation", after)
                boundary_indices.update(index for index in (item_before, item_after,
                    item.get("final_confirmation_observation")) if isinstance(index, int))
                for step in item.get("steps", []):
                    boundary_indices.update(index for index in (step.get("before_observation"),
                        step.get("after_observation")) if isinstance(index, int))
                sampling.append({"round": number, "ref": dict(ref, pointer=pointer),
                    "action": action, "action_success": result.get("success"),
                    "action_reason": result.get("reason"), "before_observation": item_before,
                    "last_sampling_observation": item_after, "final_action_observation": after,
                    "original_sampling_evidence": item})
            if "known_paths" in item:
                for index, value in enumerate(item["known_paths"]):
                    candidate(value, dict(ref, pointer=f"{pointer}/known_paths/{index}", round=number))
        road = evidence.get("road_reposition")
        if isinstance(road, dict):
            reposition.append({"round": number, "ref": dict(ref, pointer="/result/evidence/road_reposition"),
                "object_id": action.get("params", {}).get("object_id"), "action_success": result.get("success"),
                "action_reason": result.get("reason"), "before_observation": before,
                "final_observation": after, "evidence": road})
            for index, item in enumerate(road.get("attempts", [])):
                current_ref = dict(ref, pointer=f"/result/evidence/road_reposition/attempts/{index}", round=number)
                candidate(item.get("candidate"), current_ref)
                attempt(item.get("progress"), current_ref, action.get("params", {}).get("object_id"))
        for pointer, item in walk(row.get("state", {}).get("navigation", []), "/state/navigation"):
            if "known_paths" in item:
                for index, value in enumerate(item["known_paths"]):
                    candidate(value, dict(ref, pointer=f"{pointer}/known_paths/{index}", round=number))
            if "candidate_reached" in item and "route_version" in item:
                attempt(item, dict(ref, pointer=pointer, round=number))

    observations, index_refs, red_chain, identities, focus_observations = {}, {}, [], {}, []
    first_observation = last_observation = None
    raw_red_frames, fed_count, hit_record_count, hit_keys = 0, 0, 0, set()
    integrity_findings, per_round_observations = [], Counter()
    for row, ref in inputs.rows("observations.jsonl"):
        index = row["observation_index"]
        if index != len(index_refs) + 1:
            raise ValueError("Observations must be complete, unique and sequential")
        index_refs[index] = ref
        first_observation = row if first_observation is None else first_observation
        last_observation = row
        frame = str(row["observation"]["frameId"])
        detections = row.get("perception", {}).get("detections", [])
        objects = {obj["id"]: obj for obj in row.get("objects", []) if obj.get("category") == "red-ball"}
        records = {record["id"]: record for record in row.get("discovery_evidence", {}).get("records", [])}
        red_rows = []
        per_round_observations[row["round"]] += 1
        used = set()
        for raw_index, raw in enumerate(row["observation"].get("detections", [])):
            if raw.get("category") != "red-ball":
                continue
            candidates = [i for i, converted in enumerate(detections) if i not in used
                and converted.get("category") == raw.get("category") and converted.get("bbox") == raw.get("bbox")]
            converted_index = raw_index if raw_index in candidates else candidates[0] if len(candidates) == 1 else None
            converted = detections[converted_index] if converted_index is not None else {}
            if converted_index is not None:
                used.add(converted_index)
            else:
                integrity_findings.append({"code": "raw_converted_red_join_unavailable", "observation_index": index,
                    "raw_detection_index": raw_index, "candidate_converted_indices": candidates})
            oid = converted.get("track_id")
            obj = objects.get(oid, {})
            hit_pose = next((pose for pose in obj.get("hit_poses", []) if str(pose.get("frame_id")) == frame), None)
            fed = converted.get("fed_to_world_model") is True
            accepted = fed and hit_pose is not None
            source = records.get(converted.get("discovery_id"), {})
            item = {"ref": dict(ref, pointer=f"/observation/detections/{raw_index}"),
                "round": row["round"], "observation_index": index, "frame_id": frame,
                "tick": row["observation"]["tick"], "raw_detection_index": raw_index,
                "converted_detection_index": converted_index, "raw_detection": raw, "converted_detection": converted,
                "odometry": row["odometry"], "discovery_id": source.get("id"),
                "hypothesis_id": source.get("hypothesis_id"), "track_id": oid,
                "fed_to_world_model": fed, "accepted_hit_on_this_frame": accepted,
                "accepted_hit_pose": hit_pose, "object_state": obj.get("state"), "object_hit_count": obj.get("hit_count")}
            red_rows.append(item)
            red_chain.append(item)
            fed_count += fed
            hit_record_count += accepted
            if accepted:
                hit_keys.add((oid, frame))
        raw_red_frames += bool(red_rows)
        for oid, obj in objects.items():
            entry = identities.setdefault(oid, {"id": oid, "first_ref": ref, "first_observation": index,
                "first_round": row["round"], "state_changes": [], "hit_changes": []})
            previous = entry.get("latest", {})
            if obj.get("state") != previous.get("state"):
                entry["state_changes"].append({"observation_index": index, "round": row["round"], "frame_id": frame,
                    "before": previous.get("state"), "after": obj.get("state")})
            if obj.get("hit_count") != previous.get("hit_count"):
                entry["hit_changes"].append({"observation_index": index, "round": row["round"], "frame_id": frame,
                    "before": previous.get("hit_count", 0), "after": obj.get("hit_count"), "hit_poses": obj.get("hit_poses", [])})
            entry["latest"] = obj
        compact = {"ref": ref, "observation_index": index, "round": row["round"],
            "frame_id": frame, "simulation_seconds": row.get("simulation_seconds"),
            "odometry": row["odometry"], "holding": row.get("holding"), "road": row.get("road"),
            "red_detection_count": len(red_rows), "red_detections": red_rows,
            "red_objects": list(objects.values())}
        # Retain lightweight endpoints for joining every action/motion. Full
        # cumulative discovery ledgers are never accumulated in memory.
        observations[index] = {key: compact[key] for key in ("ref", "observation_index", "round", "frame_id",
            "simulation_seconds", "odometry", "holding", "red_detection_count", "red_objects")}
        if index in boundary_indices:
            observations[index]["red_detections"] = red_rows
        if row["round"] in FOCUS_ROUNDS or index in FOCUS_OBSERVATIONS:
            compact["original_public_observation"] = row["observation"]
            compact["original_perception"] = row["perception"]
            ids = {item.get("discovery_id") for item in red_rows}
            compact["current_discovery_sources"] = [record for key, record in records.items() if key in ids]
            compact["discovery_ledger_counts"] = {key: len(row.get("discovery_evidence", {}).get(key, []))
                for key in ("records", "unresolved", "resolutions", "associations")}
            focus_observations.append(compact)

    if last_observation is None or summary.get("observations") != len(observations):
        raise ValueError("Completed summary and complete observations disagree")
    motion_details, methods = [], Counter()
    for row, ref in motions:
        methods[row.get("method", "missing_method")] += 1
        before, after = observations.get(row.get("before_observation")), observations.get(row.get("after_observation"))
        detail = {"ref": ref, "original_motion": row, "actual_odometer_delta_cm": None, "net_displacement_cm": None}
        if before is not None and after is not None:
            detail.update(actual_odometer_delta_cm=after["odometry"]["distanceCm"] - before["odometry"]["distanceCm"],
                net_displacement_cm=pose_distance(before["odometry"], after["odometry"]))
        else:
            integrity_findings.append({"code": "motion_observation_boundary_missing", "ref": ref})
        motion_details.append(detail)

    def joined_window(before_index, after_index):
        before, after = observations.get(before_index), observations.get(after_index)
        if before is None or after is None:
            return {"available": False, "before_observation": before_index, "after_observation": after_index}
        return {"available": True, "before": before, "after": after,
            "actual_odometer_delta_cm": after["odometry"]["distanceCm"] - before["odometry"]["distanceCm"],
            "net_displacement_cm": pose_distance(before["odometry"], after["odometry"]),
            "motions": [m for m in motion_details if isinstance(m["original_motion"].get("before_observation"), int)
                and isinstance(m["original_motion"].get("after_observation"), int)
                and before_index <= m["original_motion"]["before_observation"]
                and m["original_motion"]["after_observation"] <= after_index],
            "red_observations": [{"observation_index": i, "frame_id": o["frame_id"],
                "raw_red_count": o["red_detection_count"]} for i, o in observations.items() if before_index <= i <= after_index]}

    for item in sampling:
        proof = item["original_sampling_evidence"]
        item["joined_sampling_window"] = joined_window(item["before_observation"], item["last_sampling_observation"])
        item["joined_full_action_window"] = joined_window(item["before_observation"], item["final_action_observation"])
        before, after = observations.get(item["before_observation"], {}), observations.get(item["final_action_observation"], {})
        oid = proof.get("confirmed_object_id") or proof.get("initial_object_id")
        first_obj = next((o for o in before.get("red_objects", []) if o["id"] == oid), {})
        last_obj = next((o for o in after.get("red_objects", []) if o["id"] == oid), {})
        item["public_object_hit_delta"] = {"object_id": oid, "before_hit_count": first_obj.get("hit_count"),
            "after_hit_count": last_obj.get("hit_count"), "delta": (last_obj["hit_count"] - first_obj.get("hit_count", 0))
            if last_obj else None, "note": "A first seed hit is included when the object was not yet admitted before sampling."}
        step_ids = {detection["track_id"] for step in proof.get("steps", [])
            for key in ("before_detection", "after_detection")
            for detection in [step.get(key)] if isinstance(detection, dict) and detection.get("track_id") is not None}
        item["observed_track_ids_in_sampling_steps"] = sorted(step_ids)
        item["public_hit_deltas_by_observed_track"] = []
        for track in sorted(step_ids):
            start_obj = next((o for o in before.get("red_objects", []) if o["id"] == track), {})
            end_obj = next((o for o in after.get("red_objects", []) if o["id"] == track), {})
            item["public_hit_deltas_by_observed_track"].append({"track_id": track,
                "before_hit_count": start_obj.get("hit_count"), "after_hit_count": end_obj.get("hit_count"),
                "before_state": start_obj.get("state"), "after_state": end_obj.get("state"),
                "delta_including_new_seed": end_obj["hit_count"] - start_obj.get("hit_count", 0) if end_obj else None})
    for item in reposition:
        item["joined_action_window"] = joined_window(item["before_observation"], item["final_observation"])

    ledger = summary.get("discovery_evidence") or {}
    pending = ledger.get("unresolved", [])
    final_objects = summary.get("final_objects", [])
    latest_state = rounds[-1][0].get("state", {}) if rounds else {}
    full_reposition = [item for item in reposition if item["action_success"] is True
        and item["evidence"].get("status") == "reposition_and_visual_standoff_verified"]
    attempted = list(attempt_versions.values())
    reached = [item for item in attempted if any(version["evidence"].get("candidate_reached") is True for version in item["versions"])]
    focus_motion = [item for item in motion_details if item["original_motion"].get("round") in FOCUS_ROUNDS
        or item["original_motion"].get("before_observation") in FOCUS_OBSERVATIONS
        or item["original_motion"].get("after_observation") in FOCUS_OBSERVATIONS]
    inputs.unchanged()
    return {"schema": "formal-public-brain-diagnosis/v1", "scope": {"complete_public_brain_logs_only": True,
        "truth_read": False, "brain_or_model_executed": False, "task_acceptance": False,
        "identity_scope": "Logged discovery hypotheses and WM tracks; never physical object identities."},
        "sources": inputs.sources, "script_sha256": digest(Path(__file__).read_bytes()),
        "counts": {"rounds": len(rounds), "observations": len(observations), "motions": len(motions),
            "model_calls_reported_by_summary": summary.get("llm_calls"),
            "model_calls_reported_by_last_round": rounds[-1][0].get("llm_call_count") if rounds else None,
            "actions": dict(actions), "successful_actions": dict(successful_actions), "result_reasons": dict(reasons),
            "result_reasons_by_action": {name: dict(values) for name, values in reasons_by_action.items()},
            "motor_methods": dict(methods), "raw_red_detection_rows": len(red_chain), "observations_with_raw_red": raw_red_frames,
            "observations_without_raw_red": len(observations) - raw_red_frames, "fed_detection_rows": fed_count,
            "accepted_hit_detection_rows": hit_record_count, "unique_accepted_track_frame_hits": len(hit_keys),
            "red_track_ids_seen": len(identities), "sampling_evidence_entries": len(sampling)},
        "reported_run": selected(summary, ("status", "reason", "rounds", "observations", "llm_calls", "simulation_seconds", "limits")),
        "public_motion": {"whole_run_odometer_delta_cm": last_observation["odometry"]["distanceCm"] - first_observation["odometry"]["distanceCm"],
            "net_displacement_cm": pose_distance(first_observation["odometry"], last_observation["odometry"]),
            "motion_counts_do_not_equal_independent_target_viewpoints": True},
        "red_detection_chain": red_chain, "track_identity_chains": list(identities.values()),
        "discovery_identity_links": {key: ledger.get(key, []) for key in ("associations", "resolutions", "resolution_revocations")},
        "sampling": sampling, "repositioning": {"internal_candidates_generated_total": None,
            "generation_limit": "Internal enumeration is not fully logged. Counts below describe retained public candidates/attempts only.",
            "distinct_logged_route_versions": len(candidate_refs), "logged_candidates": list(candidate_refs.values()),
            "candidate_attempts_directly_logged_in_action_results": sum(len(item["evidence"].get("attempts", [])) for item in reposition),
            "candidate_arrivals_directly_logged_in_action_results": sum(attempt.get("reached") is True
                for item in reposition for attempt in item["evidence"].get("attempts", [])),
            "distinct_logged_candidate_attempts": len(attempted), "candidate_attempts_with_reported_arrival": len(reached),
            "full_reposition_success_count": len(full_reposition),
            "full_success_definition": "One current go_to result with success=true and road_reposition.status=reposition_and_visual_standoff_verified; arrival alone is insufficient.",
            "attempt_deduplication": "canonical object ID + route_version + before_observation; subsequent logged stages retained as versions.",
            "attempts": attempted, "actions": reposition},
        "grasp_place_done_actions": command_actions, "gripper_motions": [m for m in motion_details
            if m["original_motion"].get("method") in {"grab", "release"}],
        "reported_action_evidence": summary.get("action_evidence", []),
        "final_obligations": {"interpretation": "Reported obligations/hypotheses; no physical ball count or task verdict inferred.",
            "holding": last_observation.get("holding"), "held_object_id": summary.get("held_object_id"),
            "pending_grasp": summary.get("pending_grasp"), "final_objects": final_objects,
            "object_state_counts": dict(Counter(o.get("state") for o in final_objects if o.get("category") == "red-ball")),
            "object_completion_classifications": dict(Counter(o.get("completion_classification") for o in final_objects if o.get("category") == "red-ball")),
            "unresolved_discovery_record_count": len(pending),
            "unresolved_discovery_hypothesis_count": len({r.get("hypothesis_id", r.get("id")) for r in pending}),
            "unresolved_discovery_records": pending, "exploration_state_reported": summary.get("exploration_state"),
            "last_decision_completion": latest_state.get("completion"),
            "last_decision_completion_is_pre_action": True},
        "focus_original_public_refs": {"definition": "r8/r9, r68/r69 with o356-o358, and r93-r98 with o476-o488. Earlier rejected opportunities and the later actually moved sampling attempt must be distinguished; no earliest-blocker verdict is hard-coded.",
            "rounds": focus_rounds, "observations": focus_observations, "motions": focus_motion},
        "integrity_findings": integrity_findings,
        "definitions": {"accepted_hit": "A fed public red detection joined by track_id and exact frame_id to that observation's object.hit_poses; unique (track_id, frame_id) is counted separately from detection rows.",
            "model_calls": "Only summary/last-round reported totals; this script does not replay or independently evaluate the model transcript.",
            "candidate_arrival": "A retained progress event reports candidate_reached=true; full raw event and public motion boundaries remain available, not an independent topology verdict.",
            "raw_absence": "No red-ball rows in the original observation.detections; absence does not prove the physical object is absent.",
            "sensor_absence_cause": "Public logs alone cannot distinguish physical occlusion from CV detection loss.",
            "final_completion": "No production completion function is rerun; last-decision completion is explicitly pre-action."}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--brain-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Output exists; select a new path")
    result = diagnose(args.brain_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"output": str(args.output), "counts": result["counts"],
        "reported_run": result["reported_run"], "integrity_findings": len(result["integrity_findings"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
