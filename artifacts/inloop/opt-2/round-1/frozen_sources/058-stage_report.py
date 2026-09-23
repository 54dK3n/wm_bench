#!/usr/bin/env python3
"""Offline stage-one evaluation; never starts a simulator or edits raw trials.

python3 tools/stage_report.py artifacts/inloop/STAGE_ROUND
Each round is grouped by its own target trajectories. The old v28r1 groups are
retained as a separate conservative comparison, never substituted for this round.
"""
import argparse
import bisect
import hashlib
import itertools
import json
import math
from pathlib import Path

from batch_report import CM, analyse

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_MAPS = {f"map-{i:02d}" for i in range(1, 11)}
MAX_OBSERVES = 92
MAX_VISION_BYTES = 20 * 1024 * 1024
POLICY = {
    "grouping": "current-round trajectories determine the current denominator; v28r1 groups are a separate conservative comparison",
    "start": "observe immediately preceding first nonempty WM frame; otherwise first red detection",
    "end": "before delivery_phase_start; delivery outcomes remain separately reported",
    "normalization": "remove absolute ticks, map/package/track IDs, blue detections, pre-confirmation patrol; robot/WM positions relative to first retained observation",
    "comparison": "same target-event order and categorical fields; complete-link groups (every member pair must match)",
    "near_tolerances": {"distance_cm": 3.0, "position_m": 0.03, "angle_deg": 2.0,
                        "confidence": 0.05, "relative_tick": 2, "counts": 0},
    "success": "all group members confirmed AND grabbed the WM-associated real target; mixed outcomes fail",
    "stationary_repeat": "consecutive actual observe calls at the same tick, or pose displacement <5cm AND heading change <10deg; prefer exact logged odometry, fallback to driver truth samples",
    "blocked_motion_guard": "observe_motion_violation is a failed attempted observation; it fails its run and the guard gate even though the actual observe was prevented",
    "fixed_rule_gates": "no run may fail a fixed rule; every confirmed-and-grabbed run must pass every fixed rule; unreached-phase unknowns on unsuccessful runs remain unknown",
    "truth_association": "WM-to-truth distance <=30cm; no raw-detection or nearest-only fallback labels",
}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def runs(folder):
    return {path.stem: json.loads(path.read_text()) for path in sorted(folder.glob("map-??.json"))}


def sample_index(folder, name):
    samples = json.loads((folder / f"{name}.samples.json").read_text())
    samples.sort(key=lambda sample: (sample["tick"], sample["seq"]))
    ticks = [sample["tick"] for sample in samples]

    def at(tick):
        index = bisect.bisect_right(ticks, tick) - 1
        return samples[index] if index >= 0 else None

    return samples, ticks, at


def target_trace(run, at):
    lines = run.get("lines", [])
    first_wm = next((i for i, line in enumerate(lines)
                     if line.get("event") == "wm_targets" and line.get("tracks")), None)
    if first_wm is not None:
        start = max(i for i in range(first_wm) if lines[i].get("event") == "observe")
    else:
        start = next((i for i, line in enumerate(lines) if line.get("event") == "observe"
                      and any(det.get("category") == "target" for det in line.get("raw", []))), None)
    if start is None:
        return {"start_line_index": None, "trace": [], "sha256": digest([])}
    end = next((i for i in range(start, len(lines)) if lines[i].get("event") == "delivery_phase_start"), len(lines))
    origin_tick = lines[start]["tick"]
    truth_origin = at(origin_tick)
    start_sample = at(0)
    heading = start_sample["heading"]
    dx, dz = truth_origin["x"] - start_sample["x"], truth_origin["z"] - start_sample["z"]
    origin = ((dx * math.cos(heading) - dz * math.sin(heading)) / 8.0,
              (-dx * math.sin(heading) - dz * math.cos(heading)) / 8.0)
    trace, source_indices = [], []
    scalar_fields = ("direction", "outcome", "reason", "stoppedBy", "onRoad", "hits", "distanceCm",
                     "requestedCm", "movedCm", "camera_distanceCm", "wm_distance_m", "gap_to_previous_m",
                     "offset_from_last_hit_m", "nearest_gap_m", "holding", "step", "advanced_cm")
    for index in range(start, end):
        line = lines[index]
        event = line.get("event")
        if event == "flow_end":
            continue
        item = {"event": event}
        for key in scalar_fields:
            if key in line:
                value = line[key]
                item[key] = round(value, 6) if type(value) is float else value
        if isinstance(line.get("hits"), list):
            item["hits"] = [{"pose_m": [round(hit["pose_x"] - origin[0], 6), round(hit["pose_z"] - origin[1], 6)],
                             "target_m": [round(hit["world_x"] - origin[0], 6), round(hit["world_z"] - origin[1], 6)],
                             "range_cm": hit.get("distanceCm"), "heading_deg": hit.get("pose_heading_deg")}
                            for hit in line["hits"]]
        if event == "observe":
            item["relative_tick"] = line["tick"] - origin_tick
            item["raw_target"] = sorted(
                [{"range_cm": det.get("distanceCm"), "bearing_deg": det.get("bearingDeg"),
                  "confidence": det.get("confidence")} for det in line.get("raw", [])
                 if det.get("category") == "target"],
                key=lambda det: (det["range_cm"] or 0, det["bearing_deg"] or 0))
        if event == "wm_targets":
            item["tracks"] = [{"target_m": [round(track["x"] - origin[0], 6), round(track["z"] - origin[1], 6)],
                               "hit": track.get("hit"), "state": track.get("state")}
                              for track in line.get("tracks", [])]
        if event == "confirmation_direction":
            decision = line.get("decision") or {}
            item["decision_rule"] = decision.get("rule")
            item["options"] = [{"direction": opt.get("direction"), "range_cm": opt.get("predicted_raw_cm"),
                                "in_window": opt.get("in_window")} for opt in decision.get("options", [])]
        if event == "viewpoint_selected":
            item["road"] = line.get("roadId")
            item["path_cm"] = line.get("pathCm")
            item["range_cm"] = line.get("predictedRawCm")
            item["goal_source"] = line.get("goalSource")
            if isinstance(line.get("point"), list):
                item["point_m"] = [round(line["point"][0] - origin[0], 6), round(line["point"][1] - origin[1], 6)]
        if "pose" in line and isinstance(line["pose"], list) and len(line["pose"]) >= 2:
            item["pose_m"] = [round(line["pose"][0] - origin[0], 6), round(line["pose"][1] - origin[1], 6)]
        trace.append(item)
        source_indices.append(index)
    return {"start_line_index": start, "end_line_index_exclusive": end, "origin_tick": origin_tick,
            "source_line_indices": source_indices, "trace": trace, "sha256": digest(trace)}


def tolerance(path):
    key = "/".join(str(part) for part in path).lower()
    if "relative_tick" in key:
        return 2.0
    if "confidence" in key:
        return 0.05
    if "_cm" in key or "distancecm" in key or "requestedcm" in key or "movedcm" in key:
        return 3.0
    if "_deg" in key:
        return 2.0
    if "_m" in key:
        return 0.03
    return 0.0


def compare(left, right):
    differences, failures = [], []

    def walk(a, b, path):
        if type(a) in (int, float) and type(b) in (int, float):
            delta, limit = abs(a - b), tolerance(path)
            if delta:
                item = {"path": "/".join(map(str, path)), "left": a, "right": b,
                        "absolute_delta": round(delta, 6), "tolerance": limit}
                differences.append(item)
                if delta > limit + 1e-9:
                    failures.append(item)
        elif isinstance(a, dict) and isinstance(b, dict) and set(a) == set(b):
            for key in sorted(a):
                walk(a[key], b[key], [*path, key])
        elif isinstance(a, list) and isinstance(b, list):
            if len(a) != len(b):
                failures.append({"path": "/".join(map(str, path)), "reason": "sequence_length_difference",
                                 "left_length": len(a), "right_length": len(b)})
            for index, (av, bv) in enumerate(zip(a, b)):
                walk(av, bv, [*path, index])
        elif a != b:
            failures.append({"path": "/".join(map(str, path)), "reason": "categorical_or_shape_difference"})

    walk(left, right, [])
    return {"equivalent": not failures, "exact": not failures and not differences,
            "numeric_differences": differences, "failures": failures}


def group_baseline(baseline, use_historical_context=True):
    traces = {}
    for name, run in runs(baseline).items():
        _samples, _ticks, at = sample_index(baseline, name)
        traces[name] = target_trace(run, at)
    groups = []
    for name in traces:
        matched = next((group for group in groups if traces[name]["trace"] and all(
            compare(traces[name]["trace"], traces[other]["trace"])["equivalent"] for other in group)), None)
        if matched is None:
            groups.append([name])
        else:
            matched.append(name)
    evidence = []
    for index, members in enumerate(groups, 1):
        pairs = [{"left_map": left, "right_map": right,
                  **compare(traces[left]["trace"], traces[right]["trace"])}
                 for left, right in itertools.combinations(members, 2)]
        # These two labels are user-supplied baseline context, not WM associations
        # and never enter runtime code or the E/G localization sample set.
        context = {"map-07": "E 场景（用户标注；无 WM 关联）", "map-09": "伪检测场景（无对应真球）"}
        label = context.get(members[0]) if use_historical_context else None
        if label is None:
            label = analyse(baseline / f"{members[0]}.json")["ball"] + " 场景"
        evidence.append({"scenario": f"S{index:02d}", "context_label": label,
                         "members": members, "pair_evidence": pairs})
    return evidence, traces


def repeated_observes(run, samples, ticks, at):
    observes = [(index, line) for index, line in enumerate(run.get("lines", [])) if line.get("event") == "observe"]
    repeats, unknown = [], []
    for (previous_index, previous), (index, current) in zip(observes, observes[1:]):
        t0, t1 = previous.get("tick"), current.get("tick")
        if t0 is None or t1 is None or at(t0) is None or at(t1) is None:
            unknown.append(index)
            continue
        a, b = at(t0), at(t1)
        old_odo, new_odo = previous.get("odo"), current.get("odo")
        if isinstance(old_odo, list) and isinstance(new_odo, list) and len(old_odo) >= 3 and len(new_odo) >= 3:
            translation = math.hypot(new_odo[0] - old_odo[0], new_odo[1] - old_odo[1])
            rotation = abs((new_odo[2] - old_odo[2] + 180) % 360 - 180)
            source = "exact_observe_odometry"
        else:
            translation = math.hypot(b["x"] - a["x"], b["z"] - a["z"]) * CM
            rotation = abs(math.degrees((b["heading"] - a["heading"] + math.pi) % (2 * math.pi) - math.pi))
            source = "driver_truth_sample"
        if t0 == t1 or (translation < 5 and rotation < 10):
            repeats.append({"previous_line_index": previous_index, "line_index": index,
                            "previous_observe_count": previous.get("observe_count"), "observe_count": current.get("observe_count"),
                            "previous_tick": t0, "tick": t1, "same_tick": t0 == t1,
                            "translation_cm": round(translation, 6), "rotation_deg": round(rotation, 6),
                            "pose_source": source, "truth_sample_ticks": [a["tick"], b["tick"]]})
    return repeats, unknown


def fixed_rules(run, row):
    """Audit invariant evidence. Missing / unreached evidence is unknown, never pass."""
    lines = run.get("lines", [])

    def result(status, evidence, reason=None):
        return {"status": status, "evidence": evidence, "reason": reason}

    def numeric_checks(entries, predicate, absent):
        if not entries:
            return result("unknown", [], absent)
        known = [entry for entry in entries if type(entry.get("value")) in (int, float) and math.isfinite(entry["value"])]
        if any(not predicate(entry["value"]) for entry in known):
            return result("fail", entries)
        return result("pass" if len(known) == len(entries) else "unknown", entries,
                      None if len(known) == len(entries) else "required_log_field_missing")

    confirmations = [(index, line) for index, line in enumerate(lines) if line.get("event") == "memory_confirmed"]
    sample_entries = []
    latest_tracks = None
    for index, line in enumerate(lines):
        if line.get("event") == "wm_targets":
            latest_tracks = line.get("tracks")
        if line.get("event") != "confirmation_sample":
            continue
        track_id = line.get("track_id")
        basis = "explicit_confirmation_sample_track_id"
        if track_id is None:
            basis = "unambiguous_preceding_wm_frame"
            if isinstance(latest_tracks, list) and len(latest_tracks) == 1 and latest_tracks[0].get("hit") == line.get("hits"):
                track_id = latest_tracks[0].get("id")
        sample_entries.append({"line_index": index, "hits": line.get("hits"), "track_id": track_id,
                               "track_id_basis": basis if track_id is not None else "missing_or_ambiguous",
                               "pose": line.get("pose"), "range_cm": line.get("camera_distanceCm")})

    counts, ranges, distances, gaps, track_groups = [], [], [], [], []
    previous_confirmation = -1
    for index, line in confirmations:
        hits = line.get("hits")
        count = len(hits) if isinstance(hits, list) else None
        counts.append({"line_index": index, "value": count})
        distances.append({"line_index": index, "value": line.get("last_sample_wm_distance_m")})
        accepted = [entry for entry in sample_entries if previous_confirmation < entry["line_index"] < index][-3:]
        ids = [entry["track_id"] for entry in accepted]
        known_ids = {track_id for track_id in ids if track_id is not None}
        complete_ids = len(accepted) == 3 and [entry["hits"] for entry in accepted] == [1, 2, 3] and None not in ids
        track_groups.append({"line_index": index, "samples": accepted, "same_track": len(known_ids) == 1,
                             "complete": complete_ids, "distinct_known_track_ids": sorted(known_ids)})
        if isinstance(hits, list):
            for n, hit in enumerate(hits):
                ranges.append({"line_index": index, "hit_index": n, "value": hit.get("distanceCm")})
            for (a_index, a), (b_index, b) in itertools.combinations(enumerate(hits), 2):
                fields = (a.get("pose_x"), a.get("pose_z"), b.get("pose_x"), b.get("pose_z"))
                gap = math.hypot(fields[0] - fields[2], fields[1] - fields[3]) if all(type(v) in (int, float) for v in fields) else None
                gaps.append({"line_index": index, "hit_pair": [a_index, b_index], "value": gap})
        previous_confirmation = index
    if not track_groups:
        track_status = "unknown"
    elif any(len(group["distinct_known_track_ids"]) > 1 for group in track_groups):
        track_status = "fail"
    elif all(group["complete"] and group["same_track"] for group in track_groups):
        track_status = "pass"
    else:
        track_status = "unknown"

    approach = [(index, line) for index, line in enumerate(lines) if line.get("event") == "approach_call"]
    approach_distances = [{"line_index": index, "value": line.get("wm_distance_m")} for index, line in approach]
    approach_steps = [{"line_index": index, "value": line.get("max_steps")} for index, line in approach]
    memory = [{"line_index": index, "value": line.get("forward_after_last_observe_cm"),
               "last_observe_line_index": max((i for i in range(index) if lines[i].get("event") == "observe"), default=None)}
              for index, line in approach]
    for entry in memory:
        if entry["last_observe_line_index"] is None:
            entry["reported_distance_cm"] = entry["value"]
            entry["value"] = None
    call_groups = []
    calls_per_track = {}
    for offset, (index, line) in enumerate(confirmations):
        end = confirmations[offset + 1][0] if offset + 1 < len(confirmations) else len(lines)
        calls = [i for i, _call in approach if index < i < end]
        identity = track_groups[offset]
        track_id = identity["distinct_known_track_ids"][0] if identity["complete"] and identity["same_track"] else None
        if track_id is not None:
            calls_per_track.setdefault(track_id, []).extend(calls)
        call_groups.append({"confirmation_line_index": index, "track_id": track_id,
                            "approach_line_indices": calls, "value": len(calls) if track_id is not None else None})
    outside_confirmed_region = [index for index, _call in approach if not any(cindex < index for cindex, _line in confirmations)]
    approach_cap = numeric_checks(call_groups, lambda value: value <= 3, "no_confirmed_target_interval")
    if any(len(calls) > 3 for calls in calls_per_track.values()):
        approach_cap = result("fail", {"confirmation_intervals": call_groups, "approach_indices_per_track": calls_per_track})
    if outside_confirmed_region:
        approach_cap = result("unknown", call_groups, "approach_without_identifiable_confirmed_target_interval")

    road_flags = []

    def collect_road(value, path):
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "onRoad":
                    road_flags.append({"path": path + "/onRoad", "value": item})
                else:
                    collect_road(item, path + "/" + key)
        elif isinstance(value, list):
            for index, item in enumerate(value):
                collect_road(item, path + "/" + str(index))

    collect_road(lines, "lines")
    record = run.get("record") or {}
    platform_result = (record.get("top") or {}).get("result") or {}
    off_road = (platform_result.get("violationMetrics") or {}).get("off_road")
    finished = any(event.get("type") == "run_finished" for event in record.get("events", []))
    if any(flag["value"] is False for flag in road_flags) or (isinstance(off_road, dict) and
            any(type(off_road.get(key)) in (int, float) and off_road[key] > 0 for key in ("episodes", "durationMs", "maxSeverity"))):
        road_status = "fail"
    elif finished and isinstance(off_road, dict) and all(off_road.get(key) == 0 for key in ("episodes", "durationMs", "maxSeverity")):
        road_status = "pass"
    else:
        road_status = "unknown"
    audit = {
        "confirmation_exactly_three_hits": numeric_checks(counts, lambda value: value == 3, "confirmation_not_reached_or_missing"),
        "confirmation_all_hits_in_40_90cm": numeric_checks(ranges, lambda value: 40 <= value <= 90, "no_confirmed_hit_ranges"),
        "confirmation_same_track_id": result(track_status, track_groups, None if track_status == "pass" else "track_identity_missing_ambiguous_or_changed"),
        "confirmation_all_pair_gaps_at_least_15cm": numeric_checks(gaps, lambda value: value >= 0.15 - 1e-12, "no_confirmed_hit_pose_pairs"),
        "confirmation_last_wm_distance_at_least_0_5m": numeric_checks(distances, lambda value: value >= 0.5, "confirmation_not_reached_or_distance_missing"),
        "pure_memory_drive_at_least_30cm_before_approach": numeric_checks(memory, lambda value: value >= 30, "approach_not_reached_or_memory_distance_missing"),
        "approach_wm_distance_at_most_0_25m": numeric_checks(approach_distances, lambda value: value <= 0.25, "approach_not_reached_or_distance_missing"),
        "approach_max_steps_one": numeric_checks(approach_steps, lambda value: value == 1, "approach_not_reached_or_max_steps_missing"),
        "approach_at_most_three_per_confirmed_ball": approach_cap,
        "on_road_entire_run": result(road_status, {"platform_run_finished": finished, "platform_off_road": off_road,
                                                   "explicit_onRoad_flags": road_flags},
                                           "full_run_platform_off_road_summary_required; sparse_true_flags_alone_do_not_prove_continuity"),
        "observe_count_at_most_92": result("pass" if row["observe_budget_gate_pass"] else "fail", {"count": row["observes"], "limit": 92}),
        "vision_bytes_at_most_20mib": result("unknown" if not row["vision_bytes_known"] else "pass" if row["vision_budget_gate_pass"] else "fail",
                                             {"bytes": row["vision_bytes"], "limit": MAX_VISION_BYTES}),
    }
    return audit


def fixed_rule_gates(rows, complete):
    return {
        "fixed_rules_no_failures_all_runs": complete and all(
            audit["status"] != "fail"
            for row in rows for audit in row["fixed_rule_audit"].values()),
        "fixed_rules_all_pass_for_confirmed_and_grabbed": complete and all(
            bool(row["fixed_rule_audit"]) and all(
                audit["status"] == "pass" for audit in row["fixed_rule_audit"].values())
            for row in rows if row["confirmed_and_grabbed"]),
    }


def evaluate(folder, baseline):
    baseline_groups, baseline_traces = group_baseline(baseline)
    current_groups, _current_traces = group_baseline(folder, use_historical_context=False)
    raw_runs = runs(folder)
    rows = []
    traces = {}
    for name, run in raw_runs.items():
        row = analyse(folder / f"{name}.json")
        samples, ticks, at = sample_index(folder, name)
        repeats, unknown = repeated_observes(run, samples, ticks, at)
        guard_failures = [{"line_index": index, **line} for index, line in enumerate(run.get("lines", []))
                          if line.get("event") == "observe_motion_violation"]
        vision = (run.get("record") or {}).get("vision") or {}
        byte_count = vision.get("frameBytes")
        bytes_known = type(byte_count) in (int, float) and byte_count >= 0 and (
            byte_count > 0 or row["observes"] == 0)
        observe_events = sum(line.get("event") == "observe" for line in run.get("lines", []))
        count = max(observe_events, row["observes"])
        row.update({"observe_events": observe_events, "observes": count,
                    "stationary_repeat_count": len(repeats), "stationary_repeat_evidence": repeats,
                    "stationary_repeat_unknown_lines": unknown, "stationary_repeat_gate_pass": not repeats and not unknown,
                    "observe_motion_violation_count": len(guard_failures), "observe_motion_violation_evidence": guard_failures,
                    "observe_motion_guard_gate_pass": not guard_failures,
                    "vision_bytes": byte_count, "vision_bytes_known": bytes_known,
                    "vision_mib": round(byte_count / 1024 ** 2, 4) if bytes_known else None,
                    "observe_budget_gate_pass": count <= MAX_OBSERVES,
                    "vision_budget_gate_pass": bytes_known and byte_count <= MAX_VISION_BYTES,
                    "confirmed_and_grabbed": not guard_failures and row["confirmation"] == "confirmed" and row["grabbed"]
                    and row.get("ball") in tuple("ABCDEFG") and row["ball"] == row["grabbed_ball"]})
        row["fixed_rule_audit"] = fixed_rules(run, row)
        statuses = {audit["status"] for audit in row["fixed_rule_audit"].values()}
        row["fixed_rule_audit_status"] = "fail" if "fail" in statuses else "unknown" if "unknown" in statuses else "pass"
        rows.append(row)
        traces[name] = target_trace(run, at)
    by_map = {row["map"]: row for row in rows}
    def score_groups(groups):
      scenario_rows = []
      for group in groups:
        members = [by_map[name] for name in group["members"] if name in by_map]
        outcomes = {row["map"]: row["confirmed_and_grabbed"] for row in members}
        scenario_rows.append({**group, "outcomes": outcomes, "mixed_outcomes": len(set(outcomes.values())) > 1,
                              "missing_members": sorted(set(group["members"]) - set(outcomes)),
                              "passed": len(members) == len(group["members"]) and all(outcomes.values()),
                              "delivery_outcomes": {row["map"]: (row.get("flow_end") or {}).get("success") for row in members},
                              "current_pair_evidence": [{"left_map": left, "right_map": right,
                                  **compare(traces[left]["trace"], traces[right]["trace"])}
                                  for left, right in itertools.combinations(outcomes, 2)]})
      return scenario_rows
    scenario_rows = score_groups(current_groups)
    baseline_scenarios = score_groups(baseline_groups)
    complete = set(raw_runs) == EXPECTED_MAPS and set(baseline_traces) == EXPECTED_MAPS
    passed = sum(group["passed"] for group in scenario_rows)
    total = len(scenario_rows)
    gates = {"complete_ten_layouts": complete,
             "program_errors_zero": complete and all(row["program_error_gate_pass"] for row in rows),
             "stationary_repeat_observes_zero": complete and all(row["stationary_repeat_gate_pass"] for row in rows),
             "observe_motion_guard_violations_zero": complete and all(row["observe_motion_guard_gate_pass"] for row in rows),
             "observe_budget_92": complete and all(row["observe_budget_gate_pass"] for row in rows),
             "vision_budget_20mib": complete and all(row["vision_budget_gate_pass"] for row in rows),
             "independent_confirmed_and_grabbed_at_least_80_percent": complete and total > 0 and passed / total >= 0.8}
    gates.update(fixed_rule_gates(rows, complete))
    unseen = {}
    for letter in ("E", "G"):
        qualified = [row for row in rows if row.get("ball") == letter and row.get("wm_final_err_cm") is not None]
        unseen[letter] = {"matched_runs": [{"map": row["map"], "final_error_cm": row["wm_final_err_cm"]} for row in qualified],
                          "independent_scenes": [{"scenario": group["scenario"],
                              "worst_member_error_cm": max(row["wm_final_err_cm"] for row in qualified if row["map"] in group["members"])}
                              for group in scenario_rows if any(row["map"] in group["members"] for row in qualified)]}
    evidence_files = sorted(set([*folder.glob("map-??.json"), *folder.glob("map-??.samples.json"),
                                 *baseline.glob("map-??.json"), *baseline.glob("map-??.samples.json")]))
    return {"folder": str(folder), "baseline_folder": str(baseline), "policy": POLICY,
            "input_sha256": {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in evidence_files},
            "gates": gates, "all_gates_pass": all(gates.values()),
            "independent_success": {"passed": passed, "total": total, "rate": passed / total if total else None,
                                    "required_successes": math.ceil(total * 0.8)},
            "baseline_conservative_success": {"passed": sum(group["passed"] for group in baseline_scenarios),
                "total": len(baseline_scenarios), "rate": sum(group["passed"] for group in baseline_scenarios) / len(baseline_scenarios)},
            "baseline_scenarios": baseline_scenarios,
            "scenarios": scenario_rows, "runs": rows, "baseline_target_traces": baseline_traces,
            "current_target_traces": traces, "unseen_accuracy": unseen,
            "accuracy_note": "Only 30cm-matched E/G trajectories qualify; this is conditional matched accuracy, not unconditional recall or precision. Unmatched estimates are failure diagnostics, never relabelled E/G samples.",
            "fixed_rule_audit_summary": {name: {status: [row["map"] for row in rows if row["fixed_rule_audit"][name]["status"] == status]
                                                for status in ("pass", "fail", "unknown")}
                                         for name in rows[0]["fixed_rule_audit"]} if rows else {},
            "stage_scope": "stage 1 numeric gates only; later stages are not executed or declared complete; at most three full ten-layout rounds per stage",
            "unmatched_runs": [row["map"] for row in rows if row.get("ball") == "无对应真球"]}


def markdown(report):
    performance = report["independent_success"]
    lines = ["# 阶段一独立场景评测", "", f"独立场景确认且抓到：{performance['passed']}/{performance['total']}；"
             f"80% 门限需至少 {performance['required_successes']} 组成功。组内一局失败即该组失败。", "",
             "| 场景 | 本轮成员 | 各局确认且抓到 | 组结果 | 组内差异 |", "|---|---|---|---|---|"]
    for group in report["scenarios"]:
        lines.append(f"| {group['scenario']} {group['context_label']} | {', '.join(group['members'])} | {group['outcomes']} | "
                     f"{'PASS' if group['passed'] else 'FAIL'} | {'存在成功/失败差异' if group['mixed_outcomes'] else '无'} |")
    lines += ["", "门限：", *[f"- {name}: {'PASS' if passed else 'FAIL'}" for name, passed in report["gates"].items()], "",
              "逐布局审计值（不作为性能平均分母）：", "",
              "| 布局 | WM 30cm 内关联 | 确认且抓到 | 重复 / guard阻止 | observe | 证据 MiB | program_error |",
              "|---|---|---|---|---|---|---|"]
    for row in report["runs"]:
        lines.append(f"| {row['map']} | {row['ball']} | {row['confirmed_and_grabbed']} | {row['stationary_repeat_count']} / {row['observe_motion_violation_count']} | "
                     f"{row['observes']} | {row['vision_mib']} | {row['platform_program_error_count']} |")
    lines += ["", "分组从首个 WM 命中前的 observe 开始（无 WM 时从首个红球检测），在投放开始前结束。"
              "去绝对 tick、轨迹/包裹 ID、蓝球和前期巡逻，坐标减首个采样位姿；保留事件顺序、红球读数、确认决策与移动结果。",
              "近似容差固定为距离 3cm、相对坐标 3cm、方位 2°、置信度 0.05、相对 tick 2；计数和类别必须相同。"
              "每组所有成员两两通过，不使用传递链合并。本轮按本轮轨迹重新分组；旧六组只作另列的保守对照，不冒充本轮独立场景。",
              "", "逐字段差值、归一轨迹及原始日志行索引保存在 stage_report.json；投放差异单独保留。",
              "E/G 仅统计 30cm 内确实关联的轨迹；未关联 WM 不计入测试精度，不能由最近邻贴标签。", ""]
    historical = report["baseline_conservative_success"]
    lines += [f"旧六组保守对照：{historical['passed']}/{historical['total']}。", "",
              "| 旧组成员 | 本轮各局结果 | 保守组结果 | 本轮轨迹仍等价 |", "|---|---|---|---|"]
    for group in report["baseline_scenarios"]:
        lines.append(f"| {', '.join(group['members'])} | {group['outcomes']} | {'PASS' if group['passed'] else 'FAIL'} | "
                     f"{all(pair['equivalent'] for pair in group['current_pair_evidence'])} |")
    lines.append("")
    lines += ["固定规则证据审计（unknown 不等于通过，未到达该阶段也不虚构证据）：", "",
              "| 固定规则 | pass | fail | unknown |", "|---|---|---|---|"]
    for name, counts in report["fixed_rule_audit_summary"].items():
        lines.append(f"| {name} | {', '.join(counts['pass']) or '—'} | {', '.join(counts['fail']) or '—'} | {', '.join(counts['unknown']) or '—'} |")
    lines += ["", "完整平台 run_finished + off_road episodes/durationMs/maxSeverity 均为 0，可证明平台记录的全程在路上；"
              "仅零星 onRoad=true 不能判通过。每次确认的三点检查所有两两间距，并通过显式 track_id 或唯一前置 WM 轨迹及匹配 hit 计数核对同轨迹。",
              "任一局固定规则 fail 都使总门限失败；已经确认且抓到的局，所有固定规则必须 pass。未成功局未进入阶段的 unknown 保留，不单独否定原有 80% 门限。",
              "本报告只评估阶段一；后续阶段未执行、未宣称完成。每阶段最多三轮，每轮必须完整十布局。", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--baseline", type=Path, default=ROOT / "artifacts/inloop/v28r1_batch")
    args = parser.parse_args()
    report = evaluate(args.folder.resolve(), args.baseline.resolve())
    (args.folder / "stage_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    (args.folder / "STAGE_REPORT.md").write_text(markdown(report))
    print(json.dumps({"independent_success": report["independent_success"], "gates": report["gates"],
                      "groups": [group["members"] for group in report["scenarios"]]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
