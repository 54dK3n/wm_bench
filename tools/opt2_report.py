#!/usr/bin/env python3
"""Offline stage-2 two-target audit. Never runs the simulator or edits evidence.

The physical verdict does not inherit stage-0's 600-second or successful-depart
requirements. Unknown evidence is explicit; it never supplies a passing gate.
"""
import argparse
import bisect
import hashlib
import json
import math
from pathlib import Path
import statistics

from batch_report import POSITIONS, letter, truth_matches
from demo_report import analyse_demo, audit, number, resolve
from demo_timeline import reconstruct
from opt_report import odometer_at
from stage_report import POLICY, compare, digest, target_trace

ROOT = Path(__file__).resolve().parents[1]
MAPS = [f"map-{i:02d}" for i in range(1, 11)]
BASELINE = ROOT / "artifacts/inloop/opt-1/round-2"
IMAGE_LIMIT = 20 * 1024 * 1024


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def road_distance(inputs, start_tick, end_tick):
    """Exact completed follow/take_exit distances; never prorate crossing moves."""
    rows, unknown = [], []
    if not number(start_tick) or not number(end_tick) or end_tick < start_tick:
        return {"value_cm": None, "basis": "unknown_interval", "inputs": [], "unknown": []}
    for item in inputs:
        if item.get("type") != "navigation_control" or item.get("method") not in ("follow_road", "take_exit"):
            continue
        result = item.get("result") or {}
        tick, elapsed, moved = item.get("tick"), result.get("elapsedTicks"), result.get("distanceCm")
        row = {"input_seq": item.get("seq"), "method": item.get("method"), "start_tick": tick,
               "elapsed_ticks": elapsed, "distance_cm": moved}
        if not number(tick):
            unknown.append({**row, "reason": "missing_control_tick"})
            continue
        if not number(elapsed):
            if start_tick <= tick < end_tick:
                unknown.append({**row, "reason": "missing_control_end"})
            continue
        stop = tick + elapsed
        row["end_tick"] = stop
        if stop <= start_tick or tick >= end_tick:
            continue
        if tick < start_tick or stop > end_tick:
            unknown.append({**row, "reason": "control_crosses_interval_boundary"})
        elif not number(moved) or moved < 0:
            unknown.append({**row, "reason": "missing_or_invalid_distance"})
        else:
            rows.append(row)
    return {"value_cm": None if unknown else sum(row["distance_cm"] for row in rows),
            "basis": "unknown_no_interpolation" if unknown else "complete_native_road_controls",
            "inputs": rows, "unknown": unknown,
            "scope": "follow_road and take_exit only; excludes free forward/approach/turn movement"}


def segments(lines):
    starts = [(i, line) for i, line in enumerate(lines) if line.get("event") == "ball_start"]
    return [{"start": start, "end": starts[j + 1][0] if j + 1 < len(starts) else len(lines),
             "start_tick": line.get("tick"), "end_tick": starts[j + 1][1].get("tick") if j + 1 < len(starts) else math.inf,
             "ball_index": line.get("ball_index")} for j, (start, line) in enumerate(starts)]


def image_accounting(raw, raw_path, slices):
    vision = read(resolve(raw_path, raw["visionEvidenceFile"]))
    key_path = resolve(raw_path, raw.get("demoEvidenceFile") or raw.get("keyframesFile"))
    keyframes = read(key_path) if key_path and key_path.exists() else {}
    accounts = [{"ball_index": part["ball_index"], "native_frame_bytes": 0, "screenshot_bytes": 0,
                 "native_frames": [], "screenshots": []} for part in slices]
    unassigned = []
    for kind, frames, field in (("native", vision.get("frames", []), "native_frame_bytes"),
                                ("screenshot", keyframes.get("frames", []), "screenshot_bytes")):
        for frame in frames:
            tick = frame.get("tick") if kind == "native" else frame.get("eventTick", frame.get("tick"))
            size = frame.get("byteLength")
            candidates = [i for i, part in enumerate(slices) if number(tick) and number(part["start_tick"])
                          and part["end_tick"] is not None and part["start_tick"] <= tick < part["end_tick"]]
            evidence = {"tick": tick, "bytes": size, "frame_id": frame.get("frameId"), "image": frame.get("image"),
                        "event_seq": (frame.get("event") or {}).get("seq")}
            if len(candidates) != 1 or type(size) is not int or size < 0:
                unassigned.append({"kind": kind, **evidence})
                continue
            account = accounts[candidates[0]]
            account[field] += size
            account["native_frames" if kind == "native" else "screenshots"].append(evidence)
    for account in accounts:
        account["combined_image_bytes"] = account["native_frame_bytes"] + account["screenshot_bytes"]
    combined = raw.get("demoEvidence", {}).get("combinedImageBytes")
    native_total = raw.get("record", {}).get("vision", {}).get("frameBytes")
    return {"balls": accounts, "unassigned": unassigned, "reported_native_bytes": native_total,
            "reported_combined_bytes": combined,
            "all_bytes_accounted": not unassigned and type(combined) is int and type(native_total) is int
                and sum(row["combined_image_bytes"] for row in accounts) == combined
                and sum(row["native_frame_bytes"] for row in accounts) == native_total,
            "policy": "half-open ball_start tick intervals; screenshot ownership uses eventTick, not later captureTick"}


def bound_truths(native, timeline):
    result = {}
    for observation in timeline["observations"]:
        frames = [frame for frame in native.get("renderTruth", {}).get("frames", [])
                  if frame.get("frameId") == observation["frame_id"]
                  and frame.get("evidenceTick") == observation["tick"]
                  and frame.get("imageSha256") == observation["image_sha256"]]
        if len(frames) == 1:
            result[observation["line_index"]] = frames[0]
    return result


def exact_grab_pose(record, tick):
    """Native input startState retains full precision; recorded samples round it."""
    matches = [{"input_seq": item.get("seq"), "pose": item["startState"]["pose"]}
               for item in record.get("inputs", []) if item.get("tick") == tick
               and (item.get("startState") or {}).get("tick") == tick
               and all(number((item["startState"].get("pose") or {}).get(key)) for key in ("x", "z", "heading"))]
    if matches and all(row["pose"] == matches[0]["pose"] for row in matches):
        return {"pose": matches[0]["pose"], "basis": "native_exact_tick_input_startState",
                "input_seq": [row["input_seq"] for row in matches], "tick": tick}
    return {"pose": None, "basis": "unknown_no_exact_pose" if not matches else "unknown_inconsistent_same_tick_poses",
            "input_seq": [row["input_seq"] for row in matches], "tick": tick}


def actual_grab_sight_angle(confirmation, grab_pose, initial):
    hits = confirmation.get("hits", []) if confirmation else []
    if not hits or not grab_pose or not initial:
        return None
    hit = hits[-1]
    if not all(number(hit.get(key)) for key in ("world_x", "world_z", "pose_x", "pose_z")):
        return None
    sight = math.degrees(math.atan2(hit["world_x"] - hit["pose_x"], hit["world_z"] - hit["pose_z"]))
    # Public odometry heading is left-positive; WM atan2(right, forward)
    # and Pose2D.yaw_rad are right-positive (the adapter negates heading).
    approach = math.degrees(initial["heading"] - grab_pose["heading"])
    return (approach - sight + 180) % 360 - 180


def associate(track, initial, truth, units):
    if not track or not initial or not truth or not number(units) or units <= 0:
        return audit("unknown", None, "missing_exact_bound_render_truth_or_WM")
    heading = initial["heading"]
    x = initial["x"] + units * (track["x"] * math.cos(heading) - track["z"] * math.sin(heading))
    z = initial["z"] + units * (-track["x"] * math.sin(heading) - track["z"] * math.cos(heading))
    candidates = [{"package_id": package["id"], "position": [package["x"], package["z"]],
                   "distance_cm": math.hypot(package["x"] - x, package["z"] - z) * 100 / units}
                  for package in truth["objectState"]["packages"] if package.get("role") == "target"]
    matched = [item for item in candidates if truth_matches(item["distance_cm"])]
    payload = {"wm_scene_position": [x, z], "candidates": candidates, "matches": matched,
               "frame_id": truth.get("frameId"), "tick": truth.get("evidenceTick"), "png_sha256": truth.get("imageSha256")}
    if len(matched) == 1:
        payload.update(matched[0])
        payload["position_label"] = letter(*matched[0]["position"])
        payload["calibration"] = POSITIONS.get(payload["position_label"], (None, None, "未编号"))[2]
        return audit("pass", payload)
    return audit("fail" if not matched else "unknown", payload,
                 "no_true_target_within_30cm" if not matched else "multiple_true_targets_within_30cm")


def confirmation_audit(lines, truths, initial, units):
    first, latest_observe, seen = [], None, set()
    for index, line in enumerate(lines):
        if line.get("event") == "observe":
            latest_observe = index
        if line.get("event") != "wm_targets":
            continue
        for track in line.get("tracks", []):
            if track.get("state") != "confirmed" or track.get("id") in seen:
                continue
            seen.add(track.get("id"))
            match = associate(track, initial, truths.get(latest_observe), units)
            first.append({"line_index": index, "observe_line_index": latest_observe, "track_id": track.get("id"),
                          "tick": lines[latest_observe].get("tick") if latest_observe is not None else None,
                          "association": match})
    return first


def two_ball_trace(raw, samples, slices, ball_rows):
    """Same frozen comparator/tolerances, with both target-related slots retained."""
    ordered = sorted(samples, key=lambda row: (row["tick"], row["seq"]))
    ticks = [row["tick"] for row in ordered]
    def at(tick):
        index = bisect.bisect_right(ticks, tick) - 1
        return ordered[index] if index >= 0 else None
    slots, provenance, nonempty = [], [], False
    for slot in (1, 2):
        matches = [(part, row) for part, row in zip(slices, ball_rows) if part["ball_index"] == slot]
        if len(matches) != 1:
            slots.append({"ball_slot": slot, "state": "not_started" if not matches else "duplicate_ball_start", "trace": []})
            continue
        part, row = matches[0]
        # Earlier lifetime memory remains valid; only the selected target belongs
        # in this ball's target-related fragment. Never concatenate delivered IDs.
        indices, segment, observed = [], [], False
        for index in range(part["start"], part["end"]):
            item = dict(raw["lines"][index])
            if item.get("event") == "observe":
                observed = True
            if item.get("event") == "wm_targets":
                item["tracks"] = [track for track in item.get("tracks", []) if track.get("id") == row.get("track_id")]
                if not observed:
                    continue  # target_trace requires an actual preceding observe
            segment.append(item)
            indices.append(index)
        trace = target_trace({"lines": segment}, at)
        nonempty = nonempty or bool(trace["trace"])
        slots.append({"ball_slot": slot, "state": "started", "source": row.get("source"), "trace": trace["trace"]})
        provenance.append({"ball_slot": slot, "raw_line_indices": [indices[i] for i in trace.get("source_line_indices", [])],
                           "trace_sha256": trace["sha256"]})
    return {"trace": slots, "has_target_trace": nonempty, "sha256": digest(slots), "provenance": provenance}


def first_choice(raw, record):
    try:
        from p3_offline_choice import evaluate_first_choice
    except ImportError:
        return {"evaluated": False, "match": False, "reason": "P3.4_evaluator_not_available",
                "selected_package_id": None, "optimal_package_ids": []}
    return evaluate_first_choice(raw, record)


def analyse_trial(path):
    path = Path(path).resolve()
    raw, base = read(path), analyse_demo(path)
    record = read(resolve(path, raw["fullRecordFile"]))
    native = read(resolve(path, raw["visionEvidenceFile"]))
    lines, samples, inputs = raw["lines"], record["samples"], record["inputs"]
    timeline = reconstruct(path)
    units, slices = timeline["units_per_meter"], segments(lines)
    truths = bound_truths(native, timeline)
    initial = record.get("simulationDefinition", {}).get("initialPose")
    all_confirmed = confirmation_audit(lines, truths, initial, units)
    images = image_accounting(raw, path, slices)
    balls = []
    for offset, (part, basic) in enumerate(zip(slices, base["balls"])):
        start, end = part["start"], part["end"]
        indexed = list(enumerate(lines[start:end], start))
        confirms = [(i, row) for i, row in indexed if row.get("event") == "memory_confirmed"]
        confirmation = confirms[0] if confirms else None
        observe = next(((i, row) for i, row in reversed(indexed) if confirmation and i < confirmation[0]
                        and row.get("event") == "observe"), None)
        tick = observe[1].get("tick") if observe else None
        track = next((track for i, row in reversed(indexed) if confirmation and i < confirmation[0]
                      and row.get("event") == "wm_targets" for track in row.get("tracks", [])
                      if track.get("id") == basic["track_id"]), None)
        association = associate(track, initial, truths.get(observe[0]) if observe else None, units)
        package = (association.get("evidence") or {}).get("package_id") if association["status"] == "pass" else None
        grabs = basic["platform_grabs"]
        grabbed = next((event for event in grabs if event.get("packageId") == package), None)
        delivery = next((event for event in basic["platform_deliveries"] if event.get("packageId") == package), None)
        visibility = next((item for item in timeline["balls"] if item["package_id"] == package), {})
        first_confirmed = next((row for row in all_confirmed if row["track_id"] == basic["track_id"]), None)
        grab_tick = grabbed["t"] / 20 if grabbed else None
        exact_pose = exact_grab_pose(record, grab_tick) if grabbed else {"pose": None, "basis": "not_grabbed"}
        grab_pose = exact_pose["pose"]
        confirm_pose = truths.get(observe[0], {}).get("vehicle") if observe else None
        odo_start = odometer_at(inputs, tick) if tick is not None else {"value_cm": None, "basis": "no_confirmation"}
        odo_end = odometer_at(inputs, grab_tick) if grab_tick is not None else {"value_cm": None, "basis": "not_grabbed"}
        total = odo_end["value_cm"] - odo_start["value_cm"] if all(number(row.get("value_cm")) for row in (odo_start, odo_end)) else None
        straight = math.hypot(grab_pose["x"] - confirm_pose["x"], grab_pose["z"] - confirm_pose["z"]) * 100 / units if grab_pose and confirm_pose else None
        road = road_distance(inputs, tick, grab_tick)
        geometry = next(({"line_index": i, **row} for i, row in reversed(indexed) if row.get("event") == "grab_geometry"), None)
        accepted = next((item for item in timeline["balls"] if item["package_id"] == package), {}).get("first_wm_accepted")
        first_raw, first_unique = visibility.get("earliest_raw_candidate"), visibility.get("earliest_unambiguous_uncapped")
        calls = [{"line_index": i, **row} for i, row in indexed if row.get("event") == "approach_call"]
        attempts = [{"event_index": i, **event} for i, event in enumerate(record["events"])
                    if event.get("interactionType") == "package_grab" and number(part["start_tick"])
                    and part["start_tick"] * 20 <= event.get("t", -1) < part["end_tick"] * 20]
        ball = {**basic, "started": True, "WM_truth_association": association, "package_id": package,
                "first_raw_candidate": first_raw, "first_unambiguous_uncapped": first_unique,
                "first_raw_candidate_seconds": first_raw.get("seconds") if first_raw else None,
                "first_seen_seconds": first_unique.get("seconds") if first_unique else None,
                "first_seen_basis": "exact_render_unique_uncapped_raw" if first_unique else "unknown",
                "first_WM_accepted": accepted,
                "first_WM_accepted_seconds": accepted.get("seconds") if accepted else None,
                "first_WM_confirmed": first_confirmed,
                "first_WM_confirmed_seconds": first_confirmed["tick"] * .02 if first_confirmed and first_confirmed["tick"] is not None else None,
                "confirmed_seconds": tick * .02 if tick is not None else None,
                "confirmation_line": confirmation[0] if confirmation else None,
                "last_confirmation_observe_line": observe[0] if observe else None,
                "grabbed_seconds": grabbed["t"] / 1000 if grabbed else None,
                "delivered_seconds": delivery["t"] / 1000 if delivery else None,
                "grab_event_index": grabbed["event_index"] if grabbed else None,
                "delivery_event_index": delivery["event_index"] if delivery else None,
                "confirmed_and_grabbed": bool(package and confirmation and grabbed),
                "confirmed_grabbed_and_delivered": bool(package and confirmation and grabbed and delivery),
                "grab_attempts": len(attempts), "grab_attempt_details": attempts,
                "failed_grab_events_information_only": [event for event in attempts if event.get("accepted") is not True],
                "approach_calls": len(calls), "approach_call_lines": calls,
                "observes": sum(row.get("event") == "observe" for _, row in indexed),
                "image_accounting": images["balls"][offset],
                "confirm_to_grab_total_odometer_cm": total, "odometer_boundaries": [odo_start, odo_end],
                "confirm_to_grab_road_controls_cm": road["value_cm"], "road_control_evidence": road,
                "confirm_to_grab_straight_cm": straight,
                "total_odometer_straight_ratio": total / straight if number(total) and straight else None,
                "road_controls_straight_ratio": road["value_cm"] / straight if number(road["value_cm"]) and straight else None,
                "pre_approach_sight_angle_deg": geometry.get("sight_vs_approach_deg") if geometry else None,
                "actual_grab_sight_vs_approach_deg": actual_grab_sight_angle(confirmation[1] if confirmation else None, grab_pose, initial),
                "grab_geometry_line": geometry["line_index"] if geometry else None,
                "grab_truth_exact_tick": bool(grab_pose), "grab_truth_pose_evidence": exact_pose,
                "grab_truth_forward_cm": None, "grab_truth_right_cm": None}
        if grabbed and grab_pose:
            dx, dz = grabbed["position"][0] - grab_pose["x"], grabbed["position"][1] - grab_pose["z"]
            heading = grab_pose["heading"]
            ball.update(grab_truth_forward_cm=(dx * -math.sin(heading) - dz * math.cos(heading)) * 100 / units,
                        grab_truth_right_cm=(dx * math.cos(heading) - dz * math.sin(heading)) * 100 / units)
        balls.append(ball)
    trace = two_ball_trace(raw, samples, slices, balls)
    omitted = {"simulation_seconds_at_most_600", "two_ball_timelines_complete", "every_ball_fixed_rules_pass",
               "two_distinct_targets_grabbed_and_delivered"}
    details = {key: value for key, value in base["gate_details"].items() if key not in omitted}
    # No success events need screenshots in a failed pre-grab trial; complete
    # exports remain required. Successful targets still require matching PNGs.
    if not base["platform_grabs"] and not base["platform_deliveries"]:
        details["driver_keyframes_preserved"] = audit("pass", [], "no_success_events_require_screenshots")
    successful = [ball for ball in balls if ball["confirmed_grabbed_and_delivered"]]
    physical = len(successful) == 2 and len({ball["package_id"] for ball in successful}) == 2
    details["two_distinct_targets_confirmed_grabbed_delivered"] = audit("pass" if physical else "fail",
        [{"ball_index": ball["ball_index"], "package_id": ball["package_id"], "delivered": ball["confirmed_grabbed_and_delivered"]} for ball in balls])
    failures = [{"ball_index": ball["ball_index"], "rule": name, **value} for ball in balls
                for name, value in ball["fixed_rule_audit"].items() if value["status"] == "fail"
                or ball["confirmed_and_grabbed"] and value["status"] != "pass"]
    details["fixed_rules_no_failure_successful_balls_all_pass"] = audit("fail" if failures else "pass", failures)
    details["per_ball_approach_calls_at_most_3"] = audit("pass" if all(ball["approach_calls"] <= 3 for ball in balls) else "fail",
        [{"ball_index": ball["ball_index"], "count": ball["approach_calls"], "lines": [row["line_index"] for row in ball["approach_call_lines"]]} for ball in balls])
    details["complete_two_ball_attribution"] = audit("pass" if len(balls) == 2 and [ball["ball_index"] for ball in balls] == [1, 2]
        and len({ball["track_id"] for ball in balls}) == 2
        and all(ball["track_id"] and ball["source"] in ("memory", "new_observations") and ball["source_verified"] for ball in balls) else "fail",
        [{"ball_index": ball["ball_index"], "track_id": ball["track_id"], "source": ball["source"],
          "source_verified": ball["source_verified"], "source_evidence": ball["source_evidence"]} for ball in balls])
    details["all_images_at_most_20mib"] = audit("pass" if type(images["reported_combined_bytes"]) is int
        and images["reported_combined_bytes"] <= IMAGE_LIMIT else "unknown" if images["reported_combined_bytes"] is None else "fail",
        {"bytes": images["reported_combined_bytes"], "limit": IMAGE_LIMIT})
    details["per_ball_image_bytes_reconcile"] = audit("pass" if images["all_bytes_accounted"] else "unknown", images)
    phantom = [item for item in all_confirmed if item["association"]["status"] == "fail"]
    unknown = [item for item in all_confirmed if item["association"]["status"] == "unknown"]
    details["phantom_CONFIRMED_zero"] = audit("fail" if phantom else "unknown" if unknown else "pass",
        {"first_confirmed_tracks": len(all_confirmed), "phantom": phantom, "unknown": unknown})
    details["exact_render_bindings_complete"] = audit("fail" if timeline["binding_problems"] else "pass", timeline["binding_problems"])
    native_source = record.get("sourceCode")
    source_sha = hashlib.sha256(native_source.encode()).hexdigest() if isinstance(native_source, str) else None
    identity = base["program_versions"]
    identity_ok = len(identity) == 1 and source_sha == identity[0].get("file_sha256")
    details["executed_source_matches_logged_sha"] = audit("pass" if identity_ok else "unknown", {"executed_sha256": source_sha, "program_versions": identity})
    from opt2_evidence_audit import audit_native_evidence
    native_binding = audit_native_evidence(raw, record, path)
    details["native_record_evidence_binding"] = audit("pass" if native_binding.get("all_pass") is True else "fail", native_binding)
    choice = first_choice(raw, record)
    gates = {key: value["status"] == "pass" for key, value in details.items()}
    return {"schema": "wm-opt2-trial/v1", "map": raw.get("assignedMap"), "raw_file": str(path), "raw_sha256": sha(path),
            "full_record_file": str(resolve(path, raw["fullRecordFile"])), "full_record_sha256": sha(resolve(path, raw["fullRecordFile"])),
            "input_hashes": {"raw": sha(path), "native_record": sha(resolve(path, raw["fullRecordFile"])),
                             "samples": sha(path.with_name(path.stem + ".samples.json")) if path.with_name(path.stem + ".samples.json").is_file()
                                 else sha(resolve(path, raw["samplesFile"])) if raw.get("samplesFile") else None,
                             "program_file": sha(resolve(path, raw["program"])), "executed_source": source_sha,
                             "vision_manifest": sha(resolve(path, raw["visionEvidenceFile"])),
                             "keyframe_manifest": sha(resolve(path, raw["demoEvidenceFile"])) if raw.get("demoEvidenceFile") else None},
            "executed_source_sha256": source_sha, "program_versions": identity,
            "balls": balls, "not_started_ball_slots": [slot for slot in (1, 2) if slot not in {ball["ball_index"] for ball in balls}],
            "physical_two_deliveries": physical, "passed": all(gates.values()), "gates": gates, "gate_details": details,
            "budgets": {**base["budgets"], "combined_image_bytes": images["reported_combined_bytes"]},
            "image_accounting": images, "first_confirmed_tracks": all_confirmed, "phantom_confirmations": phantom,
            "phantom_unknown": unknown, "first_choice": choice, "target_trace": trace,
            "flow_end": base["flow_end"], "platform_grabs": base["platform_grabs"], "platform_deliveries": base["platform_deliveries"],
            "final_delivered_package_ids": base["verified_final_delivered_package_ids"], "timeline": timeline,
            "scope": "physical final deliveries survive depart failure; no additional 600s gate; zero-based line/event indices"}


def analyse_trial_safe(path):
    """A consumed layout with missing evidence stays in every denominator."""
    try:
        return analyse_trial(path)
    except (OSError, ValueError, KeyError, TypeError, StopIteration) as error:
        raw = read(path)
        lines = raw.get("lines", [])
        detail = {"evidence_available_for_full_audit": audit("unknown", {"type": type(error).__name__, "error": str(error)},
                                                          "executed_layout_retained_missing_evidence")}
        return {"schema": "wm-opt2-trial/v1", "map": raw.get("assignedMap", Path(path).stem), "raw_file": str(path),
                "raw_sha256": sha(path), "balls": [], "not_started_ball_slots": [],
                "physical_two_deliveries": False, "physical_two_deliveries_status": "unknown",
                "passed": False, "gates": {"evidence_available_for_full_audit": False}, "gate_details": detail,
                "budgets": {"simulation_seconds": raw.get("record", {}).get("top", {}).get("result", {}).get("durationSeconds"),
                            "observes": sum(row.get("event") == "observe" for row in lines),
                            "vision_bytes": raw.get("record", {}).get("vision", {}).get("frameBytes"),
                            "combined_image_bytes": raw.get("demoEvidence", {}).get("combinedImageBytes")},
                "first_choice": {"evaluated": False, "match": False, "reason": "missing_required_trial_evidence"},
                "target_trace": {"trace": [], "has_target_trace": False, "sha256": digest([])},
                "flow_end": [{"line_index": i, **row} for i, row in enumerate(lines) if row.get("event") == "flow_end"],
                "incomplete_evidence": True}


def group_trials(rows):
    groups = []
    for row in rows:
        trace = row["target_trace"]
        group = next((group for group in groups if trace["has_target_trace"] and all(
            item["target_trace"]["has_target_trace"] and compare(trace["trace"], item["target_trace"]["trace"])["equivalent"]
            for item in group)), None)
        if group is None:
            groups.append([row])
        else:
            group.append(row)
    return [{"scenario": f"S{index:02d}", "members": [row["map"] for row in group],
             "passed": all(row["passed"] for row in group), "physical_two_deliveries": all(row["physical_two_deliveries"] for row in group),
             "pairwise": [{"left": left["map"], "right": right["map"], **compare(left["target_trace"]["trace"], right["target_trace"]["trace"])}
                          for i, left in enumerate(group) for right in group[i + 1:]]}
            for index, group in enumerate(groups, 1)]


def regression_audit(rows, previous):
    current = {row["map"]: row for row in rows}
    prior_path = previous / ("opt2_report.json" if (previous / "opt2_report.json").exists() else "opt_report.json")
    prior = read(prior_path)
    is_two = prior_path.name == "opt2_report.json"
    checks = []
    for group in prior["scenarios"]:
        if not group["passed"]:
            continue
        failed = []
        for name in group["members"]:
            row = current.get(name)
            first = next((ball for ball in row["balls"] if ball["ball_index"] == 1), {}) if row else {}
            passed = row["passed"] if row and is_two else first.get("confirmed_and_grabbed", False)
            if not passed:
                failed.append(name)
        checks.append({"previous_scenario": group["scenario"], "members": group["members"], "passed": not failed, "failed_maps": failed})
    return {"previous_report": str(prior_path), "previous_report_sha256": sha(prior_path),
            "scope": "previous dual-delivery successful scenarios" if is_two else "opt1-r2 successful capture scenarios, first current ball only",
            "checks": checks, "regressions": [row for row in checks if not row["passed"]]}


def evaluate(folder, previous=BASELINE):
    folder, previous = Path(folder).resolve(), Path(previous).resolve()
    rows = [analyse_trial_safe(path) for path in sorted(folder.glob("map-??.json"))]
    groups = group_trials(rows)
    regression = regression_audit(rows, previous)
    progress = read(folder / "progress.json")
    manifest = read(folder / "code_manifest.json")
    frozen = {path: Path(path).is_file() and sha(path) == expected for path, expected in manifest.items()}
    ledger = {row["map"]: {"recorded_raw_sha256": progress.get("completed", {}).get(row["map"], {}).get("raw_sha256"),
                            "actual_raw_sha256": row["raw_sha256"],
                            "matches": row["raw_sha256"] == progress.get("completed", {}).get(row["map"], {}).get("raw_sha256")}
              for row in rows}
    executions = [entry.get("map") for entry in progress.get("attempts", []) if entry.get("classification") == "executed"]
    complete = (progress.get("status") == "complete" and set(progress.get("completed", {})) == set(MAPS)
                and {row["map"] for row in rows} == set(MAPS) and len(executions) == 10 and set(executions) == set(MAPS))
    choice_matches = sum(row["first_choice"].get("evaluated") is True and row["first_choice"].get("match") is True for row in rows)
    choice_evaluated = sum(row["first_choice"].get("evaluated") is True for row in rows)
    global_names = ("program_errors_zero", "observe_at_most_92", "vision_at_most_20mib", "all_images_at_most_20mib",
                    "no_stationary_observe_or_guard_violation", "on_road_entire_run", "phantom_CONFIRMED_zero",
                    "fixed_rules_no_failure_successful_balls_all_pass", "per_ball_approach_calls_at_most_3",
                    "program_identity", "no_target_anchor_access", "no_layout_coordinates", "run_finished",
                    "full_raw_record_preserved", "samples_preserved", "native_png_evidence_complete",
                    "driver_keyframes_preserved", "exact_render_bindings_complete", "executed_source_matches_logged_sha",
                    "per_ball_image_bytes_reconcile", "native_record_evidence_binding")
    gates = {"complete_ten_layouts_once": complete, "frozen_dependencies_unchanged": bool(frozen) and all(frozen.values()),
             "raw_trial_hashes_match_execution_ledger": len(ledger) == 10 and all(value["matches"] for value in ledger.values()),
             "no_regression_from_previous_successful_scenarios": not regression["regressions"]}
    gates.update({name: len(rows) == 10 and all(row["gates"].get(name) is True for row in rows) for name in global_names})
    successful = [row for row in rows if row["passed"]]
    successful_seconds = [row["budgets"]["simulation_seconds"] for row in rows if row["physical_two_deliveries"]]
    median_seconds = statistics.median(successful_seconds) if successful_seconds and all(number(value) for value in successful_seconds) else None
    gates["two_target_delivery_at_least_8_of_10_layouts"] = len(rows) == 10 and len(successful) >= 8
    gates["P3_4_first_choice_matches_at_least_8_of_10_layouts"] = len(rows) == 10 and choice_matches >= 8
    gates["successful_two_delivery_median_seconds_at_most_300"] = number(median_seconds) and median_seconds <= 300
    build_path = folder / "build.json"
    build = read(build_path) if build_path.exists() else {}
    calibration_path = Path(build["calibration"]) if build.get("calibration") else None
    calibration = read(calibration_path) if calibration_path and calibration_path.is_file() else {}
    calibration_bound = bool(calibration_path and calibration_path.is_file() and manifest.get(str(calibration_path.resolve())) == sha(calibration_path)
                             == build.get("calibration_sha256"))
    gates["measured_turn_cost_k_pass_and_frozen"] = calibration_bound and calibration.get("all_pass") is True
    unseen = {label: [{"map": row["map"], "ball_index": ball["ball_index"],
                      "error_cm": ball["WM_truth_association"]["evidence"]["distance_cm"],
                      "confirmation_line": ball["confirmation_line"]}
                     for row in rows for ball in row["balls"] if ball["WM_truth_association"]["status"] == "pass"
                     and ball["WM_truth_association"]["evidence"].get("position_label") == label] for label in ("E", "G")}
    passed = sum(group["passed"] for group in groups)
    by_map = {row["map"]: row for row in rows}
    independent_choice = [{"scenario": group["scenario"], "members": group["members"],
                           "match": all(by_map[name]["first_choice"].get("evaluated") is True
                                        and by_map[name]["first_choice"].get("match") is True for name in group["members"])}
                          for group in groups]
    return {"schema": "wm-opt2-round/v1", "folder": str(folder), "runs": rows, "scenarios": groups,
            "independent_success": {"passed": passed, "total": len(groups), "rate": passed / len(groups) if groups else None},
            "layout_success": {"passed": sum(row["passed"] for row in rows), "total": len(rows)},
            "successful_two_delivery_seconds": {"values": successful_seconds, "median": median_seconds, "limit": 300},
            "first_choice_accuracy": {"matches": choice_matches, "evaluated": choice_evaluated, "total": len(rows),
                                      "rate": choice_matches / len(rows) if rows else None, "unknown_counts_as_match": False},
            "independent_first_choice_accuracy": {"matches": sum(group["match"] for group in independent_choice),
                                                   "total": len(groups), "scenarios": independent_choice},
            "gates": gates, "all_gates_pass": bool(gates) and all(gates.values()), "regression_audit": regression,
            "freeze_verification": frozen, "raw_execution_ledger_audit": ledger, "unseen_accuracy": unseen,
            "turn_cost_calibration": {"file": str(calibration_path) if calibration_path else None,
                                      "bound_to_manifest": calibration_bound, "report": calibration},
            "frozen_grouping_policy": {**POLICY, "two_ball_extension": "selected-target fragments for both ball slots; explicit boundaries; same tolerances/complete-link; never only first ball"},
            "scope": "stage2: >=8/10 dual deliveries, >=8/10 optimal first choices, successful-run median <=300s; independent scenes also reported without an invented extra rate gate"}


def markdown(report):
    count, choice = report["independent_success"], report["first_choice_accuracy"]
    text = ["# 阶段 2 双球报告", "", f"已设门槛：{'PASS' if report['all_gates_pass'] else 'FAIL / 未评估'}。独立场景双球送达 {count['passed']}/{count['total']}；首次选择 {choice['matches']}/{choice['total']}，已评估 {choice['evaluated']}。", "",
            "| 门槛 | 判定 |", "|---|---|"]
    text += [f"| {name} | {'PASS' if value else 'FAIL / unknown'} |" for name, value in report["gates"].items()]
    text += ["", "| 布局/球 | 来源/真实目标 | 首见→确认→抓取→送达(s) | WM误差cm | observe/图像bytes | 全里程/道路/直线cm | 道路比 | 真值前/侧cm | 接近前/实际抓取视线夹角° |", "|---|---|---|---|---|---|---|---|---|"]
    for row in report["runs"]:
        for ball in row["balls"]:
            association = ball["WM_truth_association"].get("evidence") or {}
            times = "→".join(str(ball.get(key)) for key in ("first_seen_seconds", "confirmed_seconds", "grabbed_seconds", "delivered_seconds"))
            text.append(f"| {row['map']}/{ball['ball_index']} | {ball['source']}/{ball['package_id']} ({association.get('position_label')}) | {times} | {association.get('distance_cm')} | {ball['observes']}/{ball['image_accounting']['combined_image_bytes']} | {ball['confirm_to_grab_total_odometer_cm']}/{ball['confirm_to_grab_road_controls_cm']}/{ball['confirm_to_grab_straight_cm']} | {ball['road_controls_straight_ratio']} | {ball['grab_truth_forward_cm']}/{ball['grab_truth_right_cm']} | {ball['pre_approach_sight_angle_deg']}/{ball['actual_grab_sight_vs_approach_deg']} |")
        for slot in row["not_started_ball_slots"]:
            text.append(f"| {row['map']}/{slot} | 未开始 | unknown | unknown | 0/0 | unknown | unknown | unknown | unknown |")
    text += ["", "| 布局 | 双球通过 | 仿真s | 整局observe/图像bytes | 退出日志 |", "|---|---|---|---|---|"]
    for row in report["runs"]:
        text.append(f"| {row['map']} | {row['passed']} | {row['budgets']['simulation_seconds']} | {row['budgets']['observes']}/{row['budgets']['combined_image_bytes']} | {json.dumps(row['flow_end'], ensure_ascii=False)} |")
    text += ["", "None/unknown 不当作零；全部原始行、精确 tick/事件、PNG 哈希、逐球固定规则、里程边界见 opt2_report.json。首见允许早于该球开始。100cm 仅供方位候选；精确首见必须未封顶且唯一关联。末次离开失败不撤销已经验证的实际送达。600s 仅报告，不增加为阶段2硬门。", "",
             "回归：", "", "```json", json.dumps(report["regression_audit"], ensure_ascii=False, indent=2), "```", ""]
    return "\n".join(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--previous", type=Path, default=BASELINE)
    args = parser.parse_args()
    report = evaluate(args.folder, args.previous)
    save(args.folder / "opt2_report.json", report)
    (args.folder / "SUMMARY.md").write_text(markdown(report), encoding="utf-8")
    print(json.dumps({"all_gates_pass": report["all_gates_pass"], "gates": report["gates"],
                      "independent": report["independent_success"], "first_choice": report["first_choice_accuracy"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
