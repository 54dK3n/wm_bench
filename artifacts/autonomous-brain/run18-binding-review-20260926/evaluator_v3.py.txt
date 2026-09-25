#!/usr/bin/env python3
"""Offline truth evaluation and Chinese report for one external-brain run.

Usage: python3 tools/evaluate_autonomous_brain.py --input RUN_DIR --out NEW_DIR
Reads evaluation-only exports after the brain has stopped. Never contacts the
simulator or a model, and never changes the input evidence. Exit 0 means the
run passed; exit 1 means a complete report was written with a failed verdict.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import re
from typing import Any


VERSION = "autonomous-brain-offline-evaluation/v3"
ROOT = Path(__file__).resolve().parents[1]
METHODS = {"observe", "camera_parameters", "odometry", "local_road", "holding",
           "grab", "release", "forward", "backward", "turn", "follow_road", "take_exit"}


def relative(path: Path) -> str:
    return Path(os.path.relpath(path.resolve(), ROOT)).as_posix()


def finite(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def seconds(item: dict, step_ms: float = 20) -> float | None:
    if finite(item.get("simulation_seconds")):
        return item["simulation_seconds"]
    if finite(item.get("t")):
        return item["t"] / 1000.0
    if finite(item.get("tick")):
        return item["tick"] * step_ms / 1000.0
    return None


def category(value: str | None) -> str | None:
    return {"target": "red-ball", "distractor": "blue-ball",
            "green-storage": "storage-zone"}.get(value, value)


def event_reference(index: int, event: dict, step_ms: float) -> dict:
    return {"event_index": index, "seq": event.get("seq"), "type": event.get("type"),
            "tick": event.get("tick"), "simulation_seconds": seconds(event, step_ms),
            "package_id": event.get("packageId")}


def world_to_odometry(point: list[float], origin: dict, scale: float) -> dict:
    """World scene coordinates -> initial-body right/forward coordinates in m."""
    dx, dz = point[0] - origin["x"], point[2] - origin["z"]
    heading = origin["heading"]
    return {"x": (dx * math.cos(heading) - dz * math.sin(heading)) * scale,
            "z": (-dx * math.sin(heading) - dz * math.cos(heading)) * scale}


def project_center(truth: dict, camera: dict) -> dict | None:
    """Invert the rigid column-major camera matrix and project into source pixels."""
    matrix, point = camera.get("matrixWorld", []), truth.get("centerWorld", [])
    if len(matrix) != 16 or len(point) != 3 or not all(finite(x) for x in matrix + point):
        return None
    if not all(finite(camera.get(key)) for key in ("fx", "fy", "cx", "cy")):
        return None
    delta = [point[i] - matrix[12 + i] for i in range(3)]
    x = sum(delta[i] * matrix[i] for i in range(3))
    y = sum(delta[i] * matrix[4 + i] for i in range(3))
    depth = -sum(delta[i] * matrix[8 + i] for i in range(3))
    if depth <= 0:
        return None
    return {"u": camera["cx"] + camera["fx"] * x / depth,
            "v": camera["cy"] - camera["fy"] * y / depth,
            "depth_world": depth}


def box_key(detection: dict) -> tuple | None:
    box = detection.get("bbox", {})
    values = [box.get(k) for k in ("x", "y", "w", "h")]
    if not all(finite(x) for x in values) or values[2] <= 0 or values[3] <= 0:
        return None
    return (category(detection.get("category")), *values)


def match_pixels(detections: list[dict], capture: dict) -> list[dict]:
    """Conservative geometric identity evidence; no distance-nearest attribution.

    A same-class truth centre must fall inside exactly one box, and that box
    must contain exactly one truth centre. This supplies a unique geometric
    correspondence, not a proof of visibility through occluders. No padding,
    distance threshold, detector tuning or world-model id assumption is used.
    """
    projections = []
    for truth in capture.get("truthObjects", []):
        if truth.get("active") is False:
            continue
        projected = project_center(truth, capture.get("cameraPose", {}))
        if projected is not None:
            projections.append((truth, projected))
    candidates = []
    counts: Counter = Counter()
    for index, detection in enumerate(detections):
        key = box_key(detection)
        possible = []
        if key is not None:
            kind, x, y, w, h = key
            for truth, projected in projections:
                if (category(truth.get("category")) == kind
                        and x <= projected["u"] <= x + w
                        and y <= projected["v"] <= y + h):
                    possible.append({"truth_id": truth["id"], "projection": projected})
                    counts[truth["id"]] += 1
        candidates.append({"detection_index": index, "category": detection.get("category"),
                           "bbox": detection.get("bbox"), "candidates": possible})
    for row in candidates:
        possible = row["candidates"]
        if len(possible) == 1 and counts[possible[0]["truth_id"]] == 1:
            row.update(status="unique", truth_id=possible[0]["truth_id"])
        elif possible:
            row.update(status="ambiguous", truth_id=None)
        else:
            row.update(status="unmatched", truth_id=None)
    return candidates


def terminal_done(rounds: list, observations: list, end_tick: Any) -> dict:
    last = rounds[-1] if rounds else {}
    result = last.get("result", {})
    evidence = result.get("evidence", {})
    reference = evidence.get("final_observation", evidence.get("after_observation"))
    matches = [row for row in observations if row.get("observation_index") == reference]
    observed = matches[0] if type(reference) is int and len(matches) == 1 else {}
    tick = observed.get("observation", {}).get("tick")
    verified = ((last.get("action") or {}).get("action") == "done" and result.get("success") is True
                and bool(observed) and observed.get("round") == last.get("round")
                and observed is observations[-1] and finite(tick) and tick == end_tick
                and observed.get("holding", {}).get("holding") is False)
    return {"verified": verified, "round": last.get("round"),
            "observation_index": reference, "observation_tick": tick}


def evaluate_delivery(record: dict, rounds: list, summary: dict, metadata: dict,
                      observations: list | None = None) -> dict:
    failures = []
    native = record.get("native", {})
    step_ms = record.get("clock", {}).get("stepMs", 20)
    if not finite(step_ms) or step_ms <= 0:
        failures.append("invalid_simulation_step")
        step_ms = 20
    definitions = [item for item in native.get("taskDefinition", {}).get("deliveries", [])
                   if item.get("objectRole") == "target" and item.get("destinationRole") == "storage"]
    destinations = {}
    for definition in definitions:
        for truth_id in definition.get("requiredPackageIds", []):
            if truth_id in destinations:
                failures.append(f"duplicate_target_definition:{truth_id}")
            destinations[truth_id] = definition
    expected = sorted(destinations)
    if len(expected) != 2:
        failures.append("evaluator_expected_two_red_targets")
    if record.get("complete") is not True:
        failures.append("incomplete_record")
    active = set()
    event_rows = defaultdict(list)
    for index, event in enumerate(native.get("events", [])):
        truth_id = event.get("packageId")
        if truth_id not in destinations:
            continue
        kind = event.get("type")
        if kind == "package_delivered":
            active.add(truth_id)
        elif kind == "package_delivery_revoked":
            active.discard(truth_id)
        if kind in {"package_grabbed", "package_delivered", "package_delivery_revoked"}:
            if kind == "package_grabbed" and event.get("accepted") is not True:
                continue
            event_rows[truth_id].append(event_reference(index, event, step_ms))
    samples = native.get("samples", [])
    last_sample = samples[-1] if samples else {}
    end_tick = native.get("simulationEndTick")
    if (not finite(last_sample.get("tick")) or not finite(end_tick)
            or last_sample.get("tick") != end_tick):
        failures.append("final_sample_tick_mismatch")
    finals = []
    for truth_id in expected:
        definition = destinations[truth_id]
        package = next((item for item in last_sample.get("packages", [])
                        if item.get("id") == truth_id), None)
        destination, radius = definition.get("destination"), definition.get("radius")
        valid_geometry = (isinstance(destination, list) and len(destination) == 2
                          and all(finite(x) for x in destination)
                          and finite(radius) and radius >= 0 and package is not None
                          and finite(package.get("x")) and finite(package.get("z")))
        distance = (math.hypot(package["x"] - destination[0], package["z"] - destination[1])
                    if valid_geometry else None)
        inside = valid_geometry and distance <= radius and last_sample.get("holding") != truth_id
        row = {"truth_id": truth_id, "active_delivery_event": truth_id in active,
               "inside_storage": bool(inside), "held": last_sample.get("holding") == truth_id,
               "sample_tick": last_sample.get("tick"), "destination_world": destination,
               "radius_world": radius, "distance_world": distance,
               "position_world": [package.get("x"), package.get("z")] if package else None,
               "events": event_rows[truth_id]}
        finals.append(row)
        if truth_id not in active:
            failures.append(f"no_active_delivery_event:{truth_id}")
        if not inside:
            failures.append(f"final_position_outside_storage:{truth_id}")
    simulation_seconds = end_tick * step_ms / 1000 if finite(end_tick) and end_tick >= 0 else None
    if simulation_seconds is None:
        failures.append("simulation_end_tick_missing")
    cap_rounds = min(200, metadata.get("maxRounds", 200))
    cap_seconds = min(1200, metadata.get("maxSimulationSeconds", 1200))
    round_numbers = [row.get("round") for row in rounds]
    count = max(round_numbers) if round_numbers and all(isinstance(n, int) for n in round_numbers) else len(rounds)
    if round_numbers != list(range(1, len(rounds) + 1)):
        failures.append("round_log_sequence_incomplete")
    if count >= cap_rounds:
        failures.append("round_limit_reached")
    if simulation_seconds is not None and simulation_seconds >= cap_seconds:
        failures.append("simulation_limit_reached")
    denied = [row for row in record.get("bridgeCalls", []) if row.get("type") == "rejected"]
    forbidden = [row for row in record.get("calls", []) if row.get("method") not in METHODS]
    if denied:
        failures.append("bridge_rejected_calls_present")
    if forbidden:
        failures.append("nonwhitelist_calls_executed")
    if summary.get("status") != "done":
        failures.append("brain_did_not_finish_with_observed_done")
    completion = terminal_done(rounds, observations or [], end_tick)
    if not completion["verified"]:
        failures.append("terminal_done_not_corroborated")
    process = metadata.get("process", {})
    if (process.get("spawnError") or process.get("interrupted")
            or ("code" in process and process["code"] != 0)
            or metadata.get("error") or metadata.get("stopError") or metadata.get("controllerErrors")):
        failures.append("execution_or_controller_error")
    return {"failures": failures, "expected_target_ids": expected,
            "delivered_target_ids": sorted(active), "final_positions": finals,
            "rounds": count, "round_records": len(rounds),
            "max_rounds": cap_rounds, "simulation_seconds": simulation_seconds,
            "max_simulation_seconds": cap_seconds, "step_ms": step_ms,
            "final_sample_tick": last_sample.get("tick"), "simulation_end_tick": end_tick,
            "terminal_done": completion,
            "rejected_calls": len(denied), "nonwhitelist_accepted_calls": len(forbidden)}


def evaluate_perception(observations: list, captures: list, record: dict,
                        summary: dict, expected_ids: list[str]) -> dict:
    by_frame = defaultdict(list)
    for capture in captures:
        by_frame[str(capture.get("frameId"))].append(capture)
    bindings = defaultdict(set)
    binding_evidence = []
    first_raw = {}
    rows = []
    raw_match_counts = Counter()
    issues = []
    native_samples = record.get("native", {}).get("samples", [])
    origin_fallback = native_samples[0] if native_samples else {}
    for index, observation in enumerate(observations):
        sensor = observation.get("observation", {})
        frame = str(sensor.get("frameId"))
        candidates = by_frame.get(frame, [])
        capture = candidates[0] if len(candidates) == 1 and candidates[0].get("tick") == sensor.get("tick") else None
        ref = {"observation_index": observation.get("observation_index", index + 1),
               "round": observation.get("round"), "frame_id": frame,
               "tick": sensor.get("tick"), "simulation_seconds": seconds(observation)}
        if capture is None:
            issues.append({**ref, "reason": "missing_or_ambiguous_exact_capture"})
            rows.append((observation, None, ref))
            continue
        raw = sensor.get("detections", [])
        matches = match_pixels(raw, capture)
        perception = observation.get("perception", {}).get("detections", [])
        converted = defaultdict(list)
        for detection in perception:
            if box_key(detection) is not None:
                converted[box_key(detection)].append(detection)
        for matched in matches:
            if category(matched.get("category")) != "red-ball":
                continue
            raw_match_counts[matched["status"]] += 1
            if matched["status"] != "unique":
                issues.append({**ref, **matched, "reason": "raw_red_detection_" + matched["status"]})
                continue
            truth_id = matched["truth_id"]
            if truth_id not in first_raw:
                first_raw[truth_id] = {**ref, **matched}
            key = box_key(raw[matched["detection_index"]])
            associated = converted.get(key, [])
            if len(associated) != 1 or not associated[0].get("track_id"):
                continue
            track_id = associated[0]["track_id"]
            bindings[track_id].add(truth_id)
            binding_evidence.append({**ref, "track_id": track_id, "truth_id": truth_id,
                                     "bbox": matched["bbox"], "method": "unique_same_frame_projected_center_in_exact_bbox"})
        rows.append((observation, capture, ref))
    resolved = {track: next(iter(ids)) for track, ids in bindings.items() if len(ids) == 1}
    ambiguous = {track: sorted(ids) for track, ids in bindings.items() if len(ids) != 1}
    samples = []
    unmatched = []
    confirmations = {}
    first_memory = {}
    for observation, capture, ref in rows:
        for obj in observation.get("objects", []):
            if category(obj.get("category")) != "red-ball":
                continue
            track_id = obj.get("id")
            truth_id = resolved.get(track_id)
            if truth_id is not None:
                first_memory.setdefault(truth_id, {**ref, "track_id": track_id,
                    "note": "first logged WM presence, not first raw sighting"})
            if str(obj.get("state", obj.get("status", ""))).upper() != "CONFIRMED":
                continue
            if truth_id is None:
                unmatched.append({**ref, "track_id": track_id,
                    "reason": "ambiguous_track_identity" if track_id in ambiguous else "unmatched_track_identity"})
                continue
            confirmations.setdefault(truth_id, {**ref, "track_id": track_id})
            truth = next((item for item in capture.get("truthObjects", [])
                          if item.get("id") == truth_id and item.get("active") is not False), None) if capture else None
            if truth is None:
                unmatched.append({**ref, "track_id": track_id, "truth_id": truth_id,
                                  "reason": "no_active_same_frame_truth"})
                continue
            origin = capture.get("odometryOrigin") or origin_fallback
            scale = capture.get("worldUnitsToMeters")
            if scale is None and finite(capture.get("cameraPose", {}).get("worldUnitsToCm")):
                scale = capture["cameraPose"]["worldUnitsToCm"] / 100
            position = obj.get("position_m", {})
            if (not all(finite(origin.get(key)) for key in ("x", "z", "heading"))
                    or not finite(scale) or scale <= 0
                    or not all(finite(position.get(key)) for key in ("x", "z"))):
                unmatched.append({**ref, "track_id": track_id, "truth_id": truth_id,
                                  "reason": "missing_coordinate_transform_or_wm_position"})
                continue
            transformed = world_to_odometry(truth["centerWorld"], origin, scale)
            error_cm = math.hypot(position["x"] - transformed["x"], position["z"] - transformed["z"]) * 100
            samples.append({**ref, "track_id": track_id, "truth_id": truth_id,
                            "position_m": position, "truth_odometry_m": transformed,
                            "origin": {key: origin[key] for key in ("x", "z", "heading")},
                            "world_units_to_meters": scale, "error_cm": error_cm})
    errors = [row["error_cm"] for row in samples]
    timeline = []
    native_events = record.get("native", {}).get("events", [])
    step_ms = record.get("clock", {}).get("stepMs", 20)
    for truth_id in expected_ids:
        grabs, deliveries, revokes = [], [], []
        active_delivery = None
        for index, event in enumerate(native_events):
            if event.get("packageId") != truth_id:
                continue
            if event.get("type") == "package_grabbed" and event.get("accepted") is True:
                grabs.append(event_reference(index, event, step_ms))
            if event.get("type") == "package_delivered":
                active_delivery = event_reference(index, event, step_ms)
                deliveries.append(active_delivery)
            if event.get("type") == "package_delivery_revoked":
                active_delivery = None
                revokes.append(event_reference(index, event, step_ms))
        tracks = sorted(track for track, identity in resolved.items() if identity == truth_id)
        memory_reports = [row for row in summary.get("timeline", []) if row.get("object_id") in tracks]
        timeline.append({"truth_id": truth_id, "wm_track_ids": tracks,
            "first_raw_seen": first_raw.get(truth_id), "first_confirmed": confirmations.get(truth_id),
            "first_logged_wm_presence": first_memory.get(truth_id),
            "first_grabbed_truth_event": grabs[0] if grabs else None,
            "first_delivered_truth_event": deliveries[0] if deliveries else None,
            "final_active_delivery_truth_event": active_delivery,
            "delivery_revocations": revokes, "brain_memory_timeline": memory_reports})
    return {"matching_method": "same-frame class + projected truth centre inside exact bbox, unique both ways; WM identities require consistent bbox-to-track associations",
            "matching_limitation": "geometric correspondence does not independently prove occlusion visibility; partial boxes excluding the centre remain unmatched; no nearest-distance fallback",
            "coordinate_convention": "initial robot right/forward metres; right=[cos(h0),-sin(h0)], forward=[-sin(h0),-cos(h0)]",
            "error_sample_definition": "one sample per logged CONFIRMED red track per observation with unique identity and active exact-frame truth; repeated estimates count as repeated samples",
            "position_error": {"count": len(errors), "mean_cm": sum(errors) / len(errors) if errors else None,
                               "rmse_cm": math.sqrt(sum(x * x for x in errors) / len(errors)) if errors else None,
                               "max_cm": max(errors) if errors else None},
            "position_samples": samples, "unmatched_confirmed_samples": unmatched,
            "unmatched_confirmed_count": len(unmatched), "ambiguous_track_ids": ambiguous,
            "track_truth_bindings": resolved, "binding_evidence": binding_evidence,
            "raw_red_match_counts": dict(raw_match_counts), "matching_issues": issues,
            "timeline": timeline}


def evaluate_source_proof(manifest: dict, driver_summary: dict, brain_summary: dict) -> dict:
    """Compare recorded byte identities, never the possibly newer working tree."""
    result = {"status": "missing", "failures": [], "recorded_before_after_equal": False,
              "driver_sources_unchanged": driver_summary.get("sourcesUnchanged") if isinstance(driver_summary, dict) else None,
              "brain_summary_hashes_match": False}
    if not manifest or not driver_summary:
        result["failures"].append("source_proof_missing")
        return result

    def sha(value):
        return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None

    def valid(value):
        if not isinstance(value, dict) or value.get("version") not in {
                f"wm-autonomous-brain-driver/v{number}" for number in range(1, 6)}:
            return False
        driver, brain, platform = (value.get(key) for key in ("driver", "brain", "platform"))
        return (isinstance(driver, dict) and driver.get("file") == "tools/autonomous_brain_driver.js"
                and sha(driver.get("sha256")) and isinstance(brain, dict) and bool(brain)
                and all(isinstance(key, str) and key.startswith("autonomous_brain/")
                        and key.endswith(".py") and ".." not in key.split("/") and sha(digest)
                        for key, digest in brain.items())
                and len({Path(key).name for key in brain}) == len(brain)
                and isinstance(platform, dict) and bool(platform) and all(sha(value) for value in platform.values())
                and sha(value.get("evaluatorCaptureSha256")))

    if not isinstance(manifest, dict) or not isinstance(driver_summary, dict):
        result.update(status="invalid")
        result["failures"].append("source_proof_unsupported_or_invalid_manifest")
        return result
    after = driver_summary.get("sourceManifestAfterRun")
    if not valid(manifest) or not valid(after) or driver_summary.get("schema") != manifest.get("version"):
        result.update(status="invalid")
        result["failures"].append("source_proof_unsupported_or_invalid_manifest")
        return result
    result["recorded_before_after_equal"] = manifest == after
    expected = {Path(path).name: value for path, value in manifest["brain"].items()}
    result["brain_summary_hashes_match"] = brain_summary.get("source_sha256") == expected
    result["recorded_brain_and_driver_files"] = len(expected) + 1
    for passed, failure in ((result["recorded_before_after_equal"], "source_proof_before_after_mismatch"),
                            (driver_summary.get("sourcesUnchanged") is True, "source_proof_driver_flag_not_true"),
                            (driver_summary.get("status") == "complete", "source_proof_driver_not_complete"),
                            (result["brain_summary_hashes_match"], "source_proof_brain_summary_hash_mismatch")):
        if not passed:
            result["failures"].append(failure)
    result["status"] = "verified" if not result["failures"] else "mismatch"
    return result


def stop_failure_kind(row: dict, final_round: Any, stop: dict, step_ms: float) -> str:
    result = row.get("result", {})
    stop = stop if isinstance(stop, dict) else {}
    value = stop.get("result", {})
    if stop.get("version") == "evaluator-stop/v1":
        for key in ("result", "result", "value"):
            value = value.get(key, {}) if isinstance(value, dict) else {}
    value = value if isinstance(value, dict) else {}
    known = stop.get("version") in {"evaluator-stop/v1", "evaluator-requested-stop/v1"}
    tick, recorded_time = value.get("tick"), row.get("simulation_seconds")
    if (known and stop.get("task_success") is False and finite(tick) and finite(recorded_time)
            and recorded_time >= tick * step_ms / 1000 and row.get("round") == final_round
            and result.get("error_type") == "BridgeError"
            and str(result.get("reason", "")).endswith(": NOT_RUNNING")):
        return "external_stop"
    return "execution_error" if result.get("error_type") else "action_failure"


def evaluate_judge(record: dict, rounds: list, observations: list, motions: list, bindings: dict) -> dict:
    """Audit bound pick/place outcomes; absent evidence is never a guessed verdict."""
    native = record.get("native", {})
    by_index = defaultdict(list)
    for observation in observations:
        by_index[observation.get("observation_index")].append(observation)
    samples_by_tick = defaultdict(list)
    for sample in native.get("samples", []):
        samples_by_tick[sample.get("tick")].append(sample)
    destinations = {}
    for definition in native.get("taskDefinition", {}).get("deliveries", []):
        if definition.get("objectRole") == "target" and definition.get("destinationRole") == "storage":
            for identity in definition.get("requiredPackageIds", []):
                destinations[identity] = definition

    def observation_at(index):
        rows = by_index.get(index, []) if type(index) is int else []
        return rows[0] if len(rows) == 1 else None

    def exact_sample(tick, identity, geometry=False):
        rows = samples_by_tick.get(tick, []) if finite(tick) else []
        snapshots = []
        for sample in rows:
            if "holding" not in sample:
                return None
            snapshot = {"holding": sample["holding"]}
            if geometry:
                packages = [item for item in sample.get("packages", []) if item.get("id") == identity]
                if len(packages) != 1 or not all(finite(packages[0].get(key)) for key in ("x", "z")):
                    return None
                snapshot.update(x=packages[0]["x"], z=packages[0]["z"])
            snapshots.append(snapshot)
        return snapshots[0] if snapshots and all(value == snapshots[0] for value in snapshots) else None

    audited = []
    for row in rounds:
        action, result = row.get("action") or {}, row.get("result", {})
        name = action.get("action")
        entry = {"round": row.get("round"), "action": name, "claimed_success": result.get("success"),
                 "independent_success": None, "status": "not_evaluated", "reason": "outside_pick_place_scope"}
        audited.append(entry)
        if name not in {"pick", "place"}:
            continue
        entry.update(status="unverifiable", reason="insufficient_action_evidence")
        evidence = result.get("evidence", {})
        selected = (action.get("params", {}).get("object_id") if name == "pick"
                    else row.get("state", {}).get("robot", {}).get("held_object_id"))
        object_id = evidence.get("object_id", selected)
        if selected is not None and object_id != selected:
            entry["reason"] = "conflicting_action_identity"
            continue
        identity = bindings.get(object_id)
        if identity not in destinations:
            entry["reason"] = "missing_or_ambiguous_truth_binding"
            continue
        entry.update(object_id=object_id, truth_id=identity)
        if record.get("complete") is not True or type(result.get("success")) is not bool:
            entry["reason"] = "incomplete_record_or_missing_claim"
            continue
        before_id = evidence.get("before_observation")
        after_id = evidence.get("final_observation", evidence.get("after_observation"))
        before, after = observation_at(before_id), observation_at(after_id)
        if (before is None or after is None or before_id >= after_id
                or before.get("round") != row.get("round") or after.get("round") != row.get("round")):
            entry["reason"] = "missing_or_ambiguous_observation_window"
            continue
        first_tick, last_tick = (item.get("observation", {}).get("tick") for item in (before, after))
        if not finite(first_tick) or not finite(last_tick) or first_tick > last_tick:
            entry["reason"] = "invalid_observation_ticks"
            continue
        method = "grab" if name == "pick" else "release"
        executed = [motion for motion in motions if motion.get("round") == row.get("round")
                    and motion.get("method") == method
                    and type(motion.get("before_observation")) is int
                    and type(motion.get("after_observation")) is int
                    and before_id <= motion["before_observation"] < motion["after_observation"] <= after_id]
        if not executed:
            entry["reason"] = "missing_actuator_motion_in_action_window"
            continue
        start = exact_sample(first_tick, identity)
        finish = exact_sample(last_tick, identity, geometry=name == "place")
        if start is None or finish is None:
            entry["reason"] = "missing_or_ambiguous_exact_tick_sample"
            continue
        events = [event for event in native.get("events", []) if event.get("packageId") == identity
                  and event.get("type") in {"package_grabbed", "package_delivered", "package_delivery_revoked"}]
        if any(not finite(event.get("tick")) for event in events):
            entry["reason"] = "missing_truth_event_tick"
            continue
        window_events = [event for event in events if first_tick < event["tick"] <= last_tick]
        if name == "pick":
            if start["holding"] is not None:
                entry["reason"] = "gripper_already_holding_before_pick"
                continue
            grabbed = any(event["type"] == "package_grabbed" and event.get("accepted") is True
                          for event in window_events)
            if finish["holding"] == identity and not grabbed:
                entry["reason"] = "holding_without_corresponding_grab_event"
                continue
            success = finish["holding"] == identity and grabbed
        else:
            if start["holding"] != identity:
                entry["reason"] = "selected_object_not_held_before_release"
                continue
            definition = destinations[identity]
            destination, radius = definition.get("destination"), definition.get("radius")
            if (not isinstance(destination, list) or len(destination) != 2
                    or not all(finite(value) for value in destination) or not finite(radius) or radius < 0):
                entry["reason"] = "missing_destination_geometry"
                continue
            active = False
            for event in window_events:
                if event["type"] == "package_delivered":
                    active = True
                elif event["type"] == "package_delivery_revoked":
                    active = False
            inside = math.hypot(finish["x"] - destination[0], finish["z"] - destination[1]) <= radius
            success = finish["holding"] is None and inside and active
        status = ("match" if success == result["success"]
                  else "false_positive" if result["success"] else "false_negative")
        entry.update(status=status, reason="exact_tick_truth_and_action_window", independent_success=success,
                     before_observation=before_id, final_observation=after_id,
                     before_tick=first_tick, final_tick=last_tick)
    counts = {name: sum(row["status"] == name for row in audited)
              for name in ("match", "false_positive", "false_negative", "unverifiable", "not_evaluated")}
    counts["eligible_actions"] = sum(row["action"] in {"pick", "place"} for row in audited)
    return {"scope": "Bound red-ball pick/place only; no truth verdict for explore/look_around/go_to/done.",
            "report_only": True, "counts": counts, "rows": audited}


def evaluate_run(directory: Path) -> dict:
    directory = Path(directory).resolve()
    inputs = {}
    failures = []

    def load(name, default, required=True, lines=False):
        plain = directory / name
        packed = directory / (name + ".gz")
        path = plain if plain.exists() else packed
        if not path.exists():
            if required:
                failures.append("missing_input:" + name)
            return default
        try:
            raw = path.read_bytes()
            expanded = gzip.decompress(raw) if path.suffix == ".gz" else raw
            value = ([json.loads(line) for line in expanded.decode("utf-8").splitlines() if line.strip()]
                     if lines else json.loads(expanded))
            inputs[name] = {"path": relative(path), "sha256": hashlib.sha256(raw).hexdigest(),
                            "bytes": len(raw), "expanded_sha256": hashlib.sha256(expanded).hexdigest(),
                            "expanded_bytes": len(expanded)}
            return value
        except (OSError, UnicodeError, ValueError) as exc:
            failures.append("unreadable_input:" + name + ":" + type(exc).__name__)
            return default

    record = load("record.json", {})
    captures = load("captures.json", [])
    summary = load("brain/summary.json", {})
    rounds = load("brain/rounds.jsonl", [], lines=True)
    observations = load("brain/observations.jsonl", [], lines=True)
    calls = load("brain/llm.jsonl", [], lines=True)
    bridge = load("brain/bridge-calls.jsonl", [], lines=True)
    motions = load("brain/motions.jsonl", [], required=False, lines=True)
    metadata = load("evaluation.json", {})
    evidence = load("evidence.json", {})
    manifest = load("../manifest.json", {})
    driver_summary = load("../summary.json", {})
    stop = load("../evaluator-stop.json", {}, required=False)
    source_proof = evaluate_source_proof(manifest, driver_summary, summary)
    failures.extend(source_proof["failures"])
    for key, file_key in (("record", "record.json"), ("captures", "captures.json")):
        expected = evidence.get(key, {})
        found = inputs.get(file_key)
        if found:
            if (not expected.get("sha256") or not expected.get("expandedSha256")
                    or expected.get("file") != Path(found["path"]).name):
                failures.append("evidence_hash_missing_or_wrong_file:" + key)
            elif (expected.get("sha256") != found["sha256"]
                    or expected.get("expandedSha256") != found["expanded_sha256"]
                    or ("bytes" in expected and expected["bytes"] != found["bytes"])
                    or ("expandedBytes" in expected and expected["expandedBytes"] != found["expanded_bytes"])):
                failures.append("evidence_sha_mismatch:" + key)
    delivery = evaluate_delivery(record, rounds, summary, metadata, observations)
    failures.extend(delivery["failures"])
    if not rounds:
        failures.append("no_completed_round_logs")
    if not observations:
        failures.append("no_observation_logs")
    if not calls:
        failures.append("no_llm_call_logs")
    if any(not finite(call.get("elapsed_s")) or call["elapsed_s"] < 0 for call in calls):
        failures.append("invalid_llm_elapsed_time")
    llm_seconds = sum(call["elapsed_s"] for call in calls if finite(call.get("elapsed_s")) and call["elapsed_s"] >= 0)
    for key, actual in (("rounds", delivery["rounds"]), ("llm_calls", len(calls))):
        if key in summary and summary[key] != actual:
            failures.append("brain_summary_counter_mismatch:" + key)
    if "llm_total_elapsed_s" in summary and not math.isclose(summary["llm_total_elapsed_s"], llm_seconds, rel_tol=1e-12, abs_tol=1e-9):
        failures.append("brain_summary_counter_mismatch:llm_total_elapsed_s")
    nonwhitelist_requests = [row for row in bridge if row.get("request", {}).get("method") not in METHODS]
    if nonwhitelist_requests:
        failures.append("nonwhitelist_brain_requests")
    perception = evaluate_perception(observations, captures, record, summary, delivery["expected_target_ids"])
    judge = evaluate_judge(record, rounds, observations, motions, perception["track_truth_bindings"])
    failures_by_action = [{"round": row.get("round"), "action": row.get("action"),
                           "simulation_seconds": row.get("simulation_seconds"), "result": row.get("result"),
                           "failure_kind": stop_failure_kind(row, rounds[-1].get("round"), stop, delivery["step_ms"])}
                          for row in rounds if row.get("result", {}).get("success") is False]
    failure_counts = Counter(row["failure_kind"] for row in failures_by_action)
    return {"version": VERSION, "evaluation_only": True, "run_directory": relative(directory),
            "map": metadata.get("map", directory.name.split("-run-")[0]),
            "success": not failures, "failures": list(dict.fromkeys(failures)),
            "delivery": delivery, "metrics": {"rounds": delivery["rounds"],
                "llm_calls": len(calls), "llm_total_elapsed_s": llm_seconds,
                "simulation_seconds": delivery["simulation_seconds"], "observations": len(observations),
                "failed_rounds": len(failures_by_action), "failed_actions": failure_counts["action_failure"],
                "execution_failures": failure_counts["execution_error"],
                "external_stop_failures": failure_counts["external_stop"], "bridge_calls": len(bridge),
                "nonwhitelist_brain_requests": len(nonwhitelist_requests)},
            "brain_status": summary.get("status"), "brain_reason": summary.get("reason"),
            "failed_actions": failures_by_action, "perception": perception,
            "source_proof": source_proof, "judge": judge,
            "external_stop": {"recorded": bool(stop), "version": stop.get("version"),
                              "reason": stop.get("reason"), "classified_failures": failure_counts["external_stop"]},
            "inputs": inputs, "evaluator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "rules": {"truth_only_in_evaluator": True,
                "success_recomputed_from_record": True, "determinism_is_not_a_gate": True,
                "position_error_is_report_only": True,
                "judge_disagreements_are_report_only": True,
                "limits": "reaching configured round/time cap fails; caps never exceed 200 rounds or 1200 seconds"}}


def report_text(result: dict) -> str:
    metrics, perception = result["metrics"], result["perception"]
    def fmt(value):
        return "未能确定" if value is None else f"{value:.6f}" if isinstance(value, float) else str(value)
    def time_at(value):
        return fmt(value.get("simulation_seconds")) if value else "未能确定"
    def safe(value):
        return str(value).replace(str(ROOT) + os.sep, "").replace("|", "\\|").replace("\n", " ")
    lines = [f"# 小车自主大脑离线评测：{result['map']}", "",
             f"结论：**{'PASS' if result['success'] else 'FAIL'}**。评测器版本 `{VERSION}`。",
             "结果由 record 中的红球交付事件、撤销事件和最终存放区内位置独立复算；没有使用 driver 的 success 布尔值。真值只在离线评测中使用。", "",
             f"输入目录：`{result['run_directory']}`。大脑状态：`{safe(result['brain_status'])}`；原因：{safe(result['brain_reason'])}。", "",
             "| 指标 | 结果 |", "|---|---:|",
             f"| 总轮数 | {metrics['rounds']} |", f"| 大模型调用次数（含修复与传输重试） | {metrics['llm_calls']} |",
             f"| 大模型累计耗时（秒） | {fmt(metrics['llm_total_elapsed_s'])} |",
             f"| 仿真用时（秒） | {fmt(metrics['simulation_seconds'])} |",
             f"| 观测次数 | {metrics['observations']} |", f"| 动作判定失败数 | {metrics['failed_actions']} |",
             f"| 执行或模型错误数 | {metrics['execution_failures']} |",
             f"| 评估方停止后的错误 | {metrics['external_stop_failures']} |",
             f"| 失败轮数合计 | {metrics['failed_rounds']} |", "",
             f"上限：{result['delivery']['max_rounds']} 轮 / {result['delivery']['max_simulation_seconds']} 秒；达到上限判失败。",
             f"最终样本tick：{result['delivery']['final_sample_tick']}；导出结束tick：{result['delivery']['simulation_end_tick']}。",
             f"末轮成功done及最终观测交叉核验：{result['delivery']['terminal_done']['verified']}；源码记录核验：{result['source_proof']['status']}。",
             "", "## 每球时间线", "",
             "下列时间均为仿真秒。首次看到由原始桥检测与同帧相机真值的唯一几何对应重建；确认由 WorldModel 的 CONFIRMED 记录重建；抓到和送达由原生事件核对。未能唯一对应时明确留空，WorldModel 首次入库不替代首次看到。", "",
             "| 真值红球 ID | WM 轨迹 ID | 首次看到 | 首次确认 | 首次抓到 | 最终未撤销交付事件 |", "|---|---|---:|---:|---:|---:|"]
    for ball in perception["timeline"]:
        lines.append(f"| {ball['truth_id']} | {', '.join(ball['wm_track_ids']) or '未匹配'} | {time_at(ball['first_raw_seen'])} | {time_at(ball['first_confirmed'])} | {time_at(ball['first_grabbed_truth_event'])} | {time_at(ball['final_active_delivery_truth_event'])} |")
    lines.extend(["", "## 最终真值核对", "", "| 红球 ID | 交付事件仍有效 | 最终在存放区 | 仍被夹持 |", "|---|---|---|---|"])
    for row in result["delivery"]["final_positions"]:
        lines.append(f"| {row['truth_id']} | {row['active_delivery_event']} | {row['inside_storage']} | {row['held']} |")
    counts = result["judge"]["counts"]
    lines.extend(["", "## 独立 Judge 对照", "",
        "仅对有唯一真值身份绑定、动作内grab/release记录、前后观测及同tick真值样本的pick/place作独立对照。缺失或歧义记为无法核验，不猜测；explore、look_around、go_to、done不套用抓放真值判据。对照统计本身不增加任务通过门槛。", "",
        "| 可对照动作 | 一致 | 假阳性（自报成功但真值失败） | 假阴性（自报失败但真值成功） | 无法核验 | 不在对照范围 |",
        "|---:|---:|---:|---:|---:|---:|",
        f"| {counts['eligible_actions']} | {counts['match']} | {counts['false_positive']} | {counts['false_negative']} | {counts['unverifiable']} | {counts['not_evaluated']} |",
        "", "逐轮身份、观测/tick范围和无法核验原因见evaluation.json的judge.rows。"])
    if result["external_stop"]["recorded"]:
        lines.extend(["", "评估方停止记录：" + safe(result["external_stop"]["reason"]) + "。",
                      "停止后NOT_RUNNING仅在已知停止记录、时间及末轮桥错误相符时单独分类；仍保留整局FAIL，不解释为自主完成。"])
    error = perception["position_error"]
    lines.extend(["", "## WorldModel 位置误差", "",
        "仅统计已通过原始像素框证据唯一绑定身份的 CONFIRMED 红球；真值由初始车体朝向和位置变换到里程计 right/forward 米坐标。每个轨迹、每次观测算一个样本，未更新的位置重复出现仍计入。没有最近距离强行匹配，也没有额外误差通过门限。", "",
        f"样本数 **{error['count']}**；平均误差 **{fmt(error['mean_cm'])} cm**；RMSE **{fmt(error['rmse_cm'])} cm**。",
        f"无法计入的确认轨迹观测数：{perception['unmatched_confirmed_count']}；身份冲突轨迹数：{len(perception['ambiguous_track_ids'])}。原始红球检测匹配：{safe(perception['raw_red_match_counts'])}。",
        "几何对应要求同类真值中心落在像素框内且双向唯一；无法独立证明遮挡可见性，部分框不含中心时会保持未匹配。每个误差样本、身份绑定、歧义与未匹配原因保存在 evaluation.json。", "",
        "## 失败轮次及原因", "", "| 轮次 | 动作 | 分类 | 原因及依据 |", "|---:|---|---|---|"])
    for row in result["failed_actions"]:
        detail = json.dumps(row["result"], ensure_ascii=False, separators=(",", ":"))
        lines.append(f"| {row['round']} | {safe(json.dumps(row['action'], ensure_ascii=False))} | {row['failure_kind']} | {safe(detail[:500])}{'…（完整内容见 evaluation.json）' if len(detail) > 500 else ''} |")
    if not result["failed_actions"]:
        lines.append("| — | — | — | 无已记录的失败动作 |")
    lines.extend(["", "失败判定项：" + ("；".join(safe(x) for x in result["failures"]) or "无") + "。", "",
                  "## 完整日志与复算", "", "以下全部为仓库相对路径；逐轮状态、模型原文、动作和结果保存在对应日志。", ""])
    for name, value in result["inputs"].items():
        lines.append(f"- `{value['path']}` — SHA256 `{value['sha256']}`")
    lines.extend(["", f"评测器 SHA256：`{result['evaluator_sha256']}`。", "",
                  f"复算：`python3 tools/evaluate_autonomous_brain.py --input {result['run_directory']} --out <新的报告目录>`。", ""])
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    if not args.input.is_dir():
        parser.error("--input must be an existing run directory")
    if args.out.exists():
        parser.error("--out must be a new directory; old evidence is never overwritten")
    result = evaluate_run(args.input)
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / "evaluation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    (args.out / "REPORT.md").write_text(report_text(result), encoding="utf-8")
    print(json.dumps({"success": result["success"], "failures": result["failures"],
                      "report": relative(args.out / "REPORT.md")}, ensure_ascii=False))
    return 0 if result["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
