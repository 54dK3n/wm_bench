#!/usr/bin/env python3
"""Offline two-target demo audit. Never starts a simulator or modifies raw evidence.

analyse_demo(raw_path) is the runner API. CLI accepts one raw JSON or a demo
directory containing progress.json; it writes demo_report.json and DEMO.md.
Missing evidence is unknown, and unknown never satisfies a demo gate.
"""
import argparse
import ast
from collections import Counter
import hashlib
import itertools
import json
import math
from pathlib import Path

try:
    from . import check_no_layout_constants as coordinates
except ImportError:
    import check_no_layout_constants as coordinates

PNG = b"\x89PNG\r\n\x1a\n"


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def audit(status, evidence=None, reason=None):
    return {"status": status, "evidence": evidence, "reason": reason}


def numeric(entries, predicate, missing):
    known = [item for item in entries if number(item.get("value"))]
    if any(not predicate(item["value"]) for item in known):
        return audit("fail", entries)
    return audit("pass" if entries and len(entries) == len(known) else "unknown", entries,
                 None if entries and len(entries) == len(known) else missing)


def resolve(raw_path, value, fallback=None):
    if value:
        path = Path(value)
        if path.is_absolute():
            return path
        return raw_path.parent / path
    return fallback


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def file_info(path):
    if path is None or not path.is_file():
        return {"path": str(path) if path else None, "exists": False}
    payload = path.read_bytes()
    return {"path": str(path), "exists": True, "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest()}


def static_checks(path, lines):
    info = file_info(path)
    if not info["exists"]:
        missing = audit("unknown", info, "frozen_program_missing")
        return {"program_identity": missing, "no_target_anchor_access": missing, "no_layout_coordinates": missing}
    text = path.read_text(encoding="utf-8")
    versions = [line for line in lines if line.get("event") == "program_version"]
    hashes = {info["sha256"], hashlib.sha256(text.strip().encode()).hexdigest()}
    identity = bool(versions) and all(version.get("file_sha256") in hashes for version in versions)
    tree = ast.parse(text, filename=str(path))
    anchor_reads = []
    # Obstacle/distractor public anchors remain legal. Reject target filtering
    # and unguarded coordinate reads from members of mission.objects.
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    collections = {"mission_objects"}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        raw_read = any(isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute)
                       and child.func.attr == "get" and child.args and isinstance(child.args[0], ast.Constant)
                       and child.args[0].value == "objects" and "mission" in ast.unparse(child.func.value)
                       for child in ast.walk(node.value))
        raw_alias = isinstance(node.value, ast.Name) and node.value.id in collections
        if raw_read or raw_alias:
            collections.update(target.id for target in node.targets if isinstance(target, ast.Name))
    members = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.For, ast.comprehension)) and isinstance(node.target, ast.Name):
            if any(isinstance(child, ast.Name) and child.id in collections for child in ast.walk(node.iter)):
                members.append((node.target.id, parents.get(node) if isinstance(node, ast.comprehension) else node))

    def is_member(owner, node):
        if not isinstance(owner, ast.Name):
            return False
        ancestors, cursor = {node}, node
        while cursor in parents:
            cursor = parents[cursor]
            ancestors.add(cursor)
        return any(owner.id == name and scope in ancestors for name, scope in members)

    def role_guard(test, member):
        if isinstance(test, ast.BoolOp) and isinstance(test.op, ast.And):
            return any(role_guard(value, member) for value in test.values)
        if not isinstance(test, ast.Compare) or len(test.ops) != 1 or len(test.comparators) != 1:
            return False
        left = test.left
        if not (isinstance(left, ast.Call) and isinstance(left.func, ast.Attribute) and isinstance(left.func.value, ast.Name)
                and left.func.value.id == member and left.func.attr == "get" and left.args
                and isinstance(left.args[0], ast.Constant) and left.args[0].value == "role"):
            return False
        value = test.comparators[0]
        if isinstance(test.ops[0], ast.Eq) and isinstance(value, ast.Constant):
            return value.value in ("obstacle", "distractor")
        if isinstance(test.ops[0], ast.In) and isinstance(value, (ast.Tuple, ast.List, ast.Set)):
            return bool(value.elts) and all(isinstance(item, ast.Constant) and item.value in ("obstacle", "distractor") for item in value.elts)
        return False

    # A comprehension that filters role before exposing its members yields a
    # safe obstacle/distractor collection, even when it reads mission directly.
    safe_collections = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.ListComp):
            if all(isinstance(gen.target, ast.Name) and any(role_guard(test, gen.target.id) for test in gen.ifs)
                   for gen in node.value.generators):
                safe_collections.update(target.id for target in node.targets if isinstance(target, ast.Name))
    collections -= safe_collections
    members.clear()
    for node in ast.walk(tree):
        if isinstance(node, (ast.For, ast.comprehension)) and isinstance(node.target, ast.Name):
            direct_read = any(isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute)
                              and child.func.attr == "get" and child.args and isinstance(child.args[0], ast.Constant)
                              and child.args[0].value == "objects" and "mission" in ast.unparse(child.func.value)
                              for child in ast.walk(node.iter))
            if direct_read or any(isinstance(child, ast.Name) and child.id in collections for child in ast.walk(node.iter)):
                members.append((node.target.id, parents.get(node) if isinstance(node, ast.comprehension) else node))

    for node in ast.walk(tree):
        key, owner = None, None
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant):
            key, owner = node.slice.value, node.value
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("get", "pop", "setdefault") and node.args and isinstance(node.args[0], ast.Constant):
            key, owner = node.args[0].value, node.func.value
        bad = isinstance(node, ast.Name) and node.id == "target_anchors"
        if key in ("targets", "targetAnchors", "target_anchors") and "mission" in ast.unparse(owner):
            bad = True
        if key == "role" and is_member(owner, node):
            parent = parents.get(node)
            if isinstance(parent, ast.Compare) and any(isinstance(child, ast.Constant) and child.value == "target" for child in ast.walk(parent)):
                bad = True
        if key in ("roadId", "progressCm") and is_member(owner, node):
            cursor, allowed = node, False
            while cursor in parents:
                parent = parents[cursor]
                if isinstance(parent, ast.If) and cursor in parent.body and role_guard(parent.test, owner.id):
                    allowed = True
                if isinstance(parent, (ast.ListComp, ast.GeneratorExp)) and any(role_guard(test, owner.id) for gen in parent.generators for test in gen.ifs):
                    allowed = True
                cursor = parent
            bad = not allowed
        if bad:
            anchor_reads.append({"line": node.lineno, "expression": ast.unparse(node)[:240]})
    refs, truth_files = coordinates.references()
    sources = [(str(path), tree), *coordinates.embedded_sources(tree, str(path))]
    violations, scanned = [], []
    for name, source in sources:
        summary, pairs, _singles = coordinates.scan_source(name, source, refs)
        scanned.append(summary)
        violations.extend(pairs)
    return {
        "program_identity": audit("pass" if identity else "fail", {**info, "program_versions": versions}),
        "no_target_anchor_access": audit("fail" if anchor_reads else "pass", anchor_reads,
            "AST target-anchor and unguarded mission-object coordinate scan; legal obstacle/distractor filters retained; runtime protected-target test is complementary"),
        "no_layout_coordinates": audit("fail" if violations else "pass", {
            "pair_violations": violations, "scanned_sources": scanned, "truth_files": [str(p) for p in truth_files],
            "scope": "AST signed coordinate pairs, including embedded package; computed/encoded obfuscation needs review"}),
    }


def actual_hits(lines):
    """Retain real WM hit-count increments, including memory before ball_start."""
    previous, increments = {}, []
    observe, associations = None, []
    for index, line in enumerate(lines):
        event = line.get("event")
        if event == "observe":
            observe, associations = (index, line), []
        elif event == "wm_associations":
            associations = line.get("items", [])
        elif event == "wm_targets":
            for track in line.get("tracks", []):
                track_id, count = track.get("id"), track.get("hit")
                prior = previous.get(track_id, 0)
                if number(count) and count > prior:
                    readings = [item for item in associations if item.get("track_id") == track_id]
                    increments.append({"line_index": index, "observe_line_index": observe[0] if observe else None,
                        "track_id": track_id, "hit": count, "increment": count - prior,
                        "tick": observe[1].get("tick") if observe else None,
                        "odo": observe[1].get("odo") if observe else None, "readings": readings})
                if number(count):
                    previous[track_id] = count
    return increments


def ball_rules(indexed, track_id, increments):
    confirmations = [(i, line) for i, line in indexed if line.get("event") == "memory_confirmed"]
    counts, ranges, gaps, last, identities = [], [], [], [], []
    for index, line in confirmations:
        hits = line.get("hits")
        counts.append({"line_index": index, "value": len(hits) if isinstance(hits, list) else None})
        last.append({"line_index": index, "value": line.get("last_sample_wm_distance_m")})
        hits = hits if isinstance(hits, list) else []
        ids = [hit.get("track_id") for hit in hits]
        identities.append({"line_index": index, "selected_id": track_id, "confirmation_id": line.get("track_id"), "hit_ids": ids})
        ranges.extend({"line_index": index, "hit_index": h, "value": hit.get("distanceCm")} for h, hit in enumerate(hits))
        for (a, left), (b, right) in itertools.combinations(enumerate(hits), 2):
            xy = [left.get("pose_x"), left.get("pose_z"), right.get("pose_x"), right.get("pose_z")]
            gap = math.hypot(xy[0] - xy[2], xy[1] - xy[3]) if all(number(v) for v in xy) else None
            gaps.append({"line_index": index, "pair": [a, b], "value": gap})
    identity_known = bool(identities) and track_id is not None and all(
        row["confirmation_id"] is not None and len(row["hit_ids"]) == 3 and None not in row["hit_ids"] for row in identities)
    identity_bad = any(any(value is not None and value != track_id for value in [row["confirmation_id"], *row["hit_ids"]])
                       for row in identities) if track_id is not None else False
    approach = [(i, line) for i, line in indexed if line.get("event") == "approach_call"]
    def values(key):
        return [{"line_index": i, "value": line.get(key)} for i, line in approach]
    observed = [i for i, line in indexed if line.get("event") == "observe"]
    memories = values("forward_after_last_observe_cm")
    for entry in memories:
        if not any(index < entry["line_index"] for index in observed):
            entry["reported_value"], entry["value"] = entry["value"], None
    end = confirmations[0][0] if confirmations else -1
    fused = [entry for entry in increments if entry["track_id"] == track_id and entry["line_index"] < end]
    fused_complete = len(fused) >= 3 and all(entry["increment"] == 1 and isinstance(entry["odo"], list)
        and len(entry["odo"]) >= 2 and all(number(v) for v in entry["odo"][:2]) and entry["readings"] for entry in fused)
    fused_ranges = [{"line_index": entry["line_index"], "value": reading.get("distanceCm")}
                    for entry in fused for reading in entry["readings"]]
    fused_gaps = [{"pair": [a["line_index"], b["line_index"]], "value": math.dist(a["odo"][:2], b["odo"][:2])}
                  for a, b in itertools.combinations(fused, 2)] if fused_complete else []
    before_confirmation = [i for i, _line in approach if not any(c < i for c, _ in confirmations)]
    rules = {
        "confirmation_three_hits": numeric(counts, lambda x: x == 3, "confirmation_missing"),
        "confirmation_same_track": audit("fail" if identity_bad else "pass" if identity_known else "unknown", identities),
        "confirmation_window_40_90cm": numeric(ranges, lambda x: 40 <= x <= 90, "hit_ranges_missing"),
        "confirmation_all_pair_gaps_15cm": numeric(gaps, lambda x: x >= .15 - 1e-12, "hit_poses_missing"),
        "confirmation_last_distance_0_5m": numeric(last, lambda x: x >= .5, "last_confirmation_distance_missing"),
        "actual_wm_three_distinct_hits": audit("pass" if fused_complete else "unknown", fused, None if fused_complete else "incomplete_actual_WM_hit_evidence"),
        "actual_wm_window_40_90cm": numeric(fused_ranges, lambda x: 40 <= x <= 90, "actual_WM_ranges_missing"),
        "actual_wm_all_pair_gaps_15cm": numeric(fused_gaps, lambda x: x >= 15 - 1e-9, "actual_WM_poses_missing"),
        "memory_drive_30cm": numeric(memories, lambda x: x >= 30, "memory_drive_or_observe_missing"),
        "approach_distance_0_25m": numeric(values("wm_distance_m"), lambda x: x <= .25, "approach_missing"),
        "approach_max_steps_one": numeric(values("max_steps"), lambda x: x == 1, "approach_missing"),
        "approach_at_most_three": audit("fail" if len(approach) > 3 or before_confirmation else "pass" if approach else "unknown",
            {"count": len(approach), "line_indices": [i for i, _ in approach], "before_confirmation": before_confirmation}),
    }
    return rules


def evidence_audit(raw_path, raw, samples_path):
    files = {"raw": file_info(raw_path), "samples": file_info(samples_path)}
    record_path = resolve(raw_path, raw.get("fullRecordFile") or raw.get("recordFile"))
    files["full_record"] = file_info(record_path)
    record_check = audit("unknown", files["full_record"], "full_record_file_missing")
    if files["full_record"]["exists"]:
        full = load(record_path)
        events = full.get("events") if isinstance(full, dict) else None
        match = isinstance(events, list) and events == raw.get("record", {}).get("events")
        record_check = audit("pass" if match else "fail", {**files["full_record"], "events_equal_raw": match})
    vision_path = resolve(raw_path, raw.get("visionEvidenceFile"))
    files["vision_manifest"] = file_info(vision_path)
    vision_check = audit("unknown", files["vision_manifest"], "native_vision_manifest_missing")
    if files["vision_manifest"]["exists"]:
        vision = load(vision_path)
        frames, frame_checks = vision.get("frames", []), []
        for frame in frames:
            path = resolve(vision_path, frame.get("image"))
            info = file_info(path)
            info.update({"frameId": frame.get("frameId"), "tick": frame.get("tick")})
            info["valid"] = (info["exists"] and path.read_bytes().startswith(PNG)
                and info["bytes"] == frame.get("byteLength") and info["sha256"] == frame.get("sha256"))
            frame_checks.append(info)
        expected_count = raw.get("record", {}).get("vision", {}).get("frameCount")
        expected_bytes = raw.get("record", {}).get("vision", {}).get("frameBytes")
        required = ("allNativeFramesExported", "allNativeQueriesExported", "allObserveFramesBound",
                    "exportedBytesMatchNative", "allNativeFramesHaveExactRenderTruth")
        validation = vision.get("validation", {})
        valid = (bool(frames) and all(info["valid"] for info in frame_checks)
            and len(frames) == expected_count and sum(info.get("bytes", 0) for info in frame_checks) == expected_bytes
            and all(validation.get(key) is True for key in required) and not vision.get("exportErrors"))
        vision_check = audit("pass" if valid else "fail", {"manifest": files["vision_manifest"],
            "frame_checks": frame_checks, "validation": validation, "expected_count": expected_count,
            "expected_bytes": expected_bytes})
    keyframe_path = resolve(raw_path, raw.get("demoEvidenceFile") or raw.get("keyframesFile"))
    files["keyframes_manifest"] = file_info(keyframe_path)
    keyframe_check = audit("unknown", files["keyframes_manifest"], "driver_keyframe_manifest_missing")
    if files["keyframes_manifest"]["exists"]:
        keyframes = load(keyframe_path)
        frame_checks = []
        required_events = {}
        for index, event in enumerate(raw.get("record", {}).get("events", [])):
            if event.get("objectRole") == "target" and (event.get("type") == "package_delivered" or
                    event.get("type") == "package_grabbed" and event.get("accepted") is True):
                required_events.setdefault((event.get("packageId"), event["type"]), {"event_index": index, **event})
        for frame in keyframes.get("frames", []):
            path = resolve(keyframe_path, frame.get("image") or frame.get("path") or frame.get("file"))
            info = file_info(path)
            info.update({"event": frame.get("event"), "tick": frame.get("eventTick", frame.get("tick")),
                         "captureTick": frame.get("captureTick"), "sameTickAndRevision": frame.get("sameTickAndRevision")})
            info["valid"] = info["exists"] and path.read_bytes().startswith(PNG) and info["bytes"] == frame.get("byteLength")
            if frame.get("sha256"):
                info["valid"] = info["valid"] and info["sha256"] == frame["sha256"]
            frame_checks.append(info)
        missing = [event for event in required_events.values() if not any(
            isinstance(frame.get("event"), dict) and frame["event"].get("seq") == event.get("seq")
            and frame["event"].get("type") == event["type"] and frame["event"].get("packageId") == event.get("packageId")
            for frame in keyframes.get("frames", []))]
        summary = raw.get("demoEvidence", {})
        valid = (bool(required_events) and bool(frame_checks) and all(item["valid"] for item in frame_checks)
            and not missing and not keyframes.get("hookErrors") and not keyframes.get("exportErrors")
            and keyframes.get("allScreenshotBytesExported") is True and summary.get("allSuccessEventsHaveScreenshots") is True
            and not summary.get("hookErrors") and not summary.get("exportErrors") and not summary.get("error"))
        keyframe_check = audit("pass" if valid else "fail", {
            "manifest": files["keyframes_manifest"], "frames": frame_checks, "missing_events": missing,
            "screenshot_bytes": keyframes.get("screenshotBytes"), "native_frame_bytes": keyframes.get("nativeFrameBytes"),
            "combined_image_bytes": keyframes.get("combinedImageBytes"),
            "combined_images_within_20mib_information_only": keyframes.get("combinedImagesWithinBudget"),
            "budget_policy": "stage0: native platform cap only; combined image bytes are reported, not a demo gate"})
    return files, {"full_raw_record_preserved": record_check,
        "samples_preserved": audit("pass" if files["samples"]["exists"] and load(samples_path) else "unknown", files["samples"]),
        "native_png_evidence_complete": vision_check, "driver_keyframes_preserved": keyframe_check}


def analyse_demo(path):
    """Return a JSON-serializable audit for one raw trial, without writing files."""
    path = Path(path).resolve()
    raw = load(path)
    lines = raw.get("lines", [])
    record = raw.get("record") if isinstance(raw.get("record"), dict) else {}
    events = record.get("events", [])
    indexed_events = [{"event_index": i, **event} for i, event in enumerate(events)]
    finished = any(event.get("type") == "run_finished" for event in events)
    result = record.get("top", {}).get("result", {})
    samples_path = path.with_name(path.stem + ".samples.json")
    if not samples_path.is_file():
        samples_path = resolve(path, raw.get("samplesFile"), samples_path)
    samples = load(samples_path) if samples_path.is_file() else []
    roles = {package.get("id"): package.get("role") for sample in samples[:1] for package in sample.get("packages", [])}
    def target(event):
        return event.get("objectRole", roles.get(event.get("packageId"))) == "target"
    grabbed = [event for event in indexed_events if event.get("type") == "package_grabbed" and event.get("accepted") is True and target(event)]
    delivered = [event for event in indexed_events if event.get("type") == "package_delivered" and target(event)]
    current_delivered = {}
    for event in indexed_events:
        if target(event) and event.get("type") == "package_delivered":
            current_delivered[event.get("packageId")] = event
        elif event.get("type") == "package_delivery_revoked":
            current_delivered.pop(event.get("packageId"), None)
    verified_deliveries = [event for pid, event in current_delivered.items() if pid and any(
        grab.get("packageId") == pid and grab["event_index"] < event["event_index"] for grab in grabbed)]
    starts = [(i, line) for i, line in enumerate(lines) if line.get("event") == "ball_start"]
    increments, balls = actual_hits(lines), []
    for offset, (start, first) in enumerate(starts):
        end = starts[offset + 1][0] if offset + 1 < len(starts) else len(lines)
        indexed = list(enumerate(lines[start:end], start))
        selection = [(i, line) for i, line in indexed if line.get("event") == "ball_selection"]
        track_id = selection[-1][1].get("track_id") if selection else first.get("track_id")
        source = selection[-1][1].get("target_source") if selection else first.get("target_source")
        start_tick = first.get("tick")
        end_tick = starts[offset + 1][1].get("tick") if offset + 1 < len(starts) else math.inf
        relevant = [event for event in indexed_events if number(start_tick) and number(event.get("t"))
                    and end_tick is not None and start_tick * 20 <= event["t"] < end_tick * 20]
        ball_grabs = [event for event in relevant if event in grabbed]
        ball_deliveries = [event for event in relevant if event in verified_deliveries]
        fixed = ball_rules(indexed, track_id, increments)
        selected_lines = [(i, line) for i, line in indexed if line.get("event") in (
            "ball_start", "ball_selection", "confirmation_sample", "memory_confirmed", "ball_confirmed", "last_observe",
            "approach_call", "grab_result", "grab_attempt", "grab_step", "ball_grabbed", "memory_navigation_metric", "ball_delivered", "ball_end", "flow_end")]
        endings = [line for _, line in indexed if line.get("event") == "ball_end"]
        track_hits = [hit for hit in increments if hit["track_id"] == track_id]
        first_hit = track_hits[0] if track_hits else None
        prior_memory = [{"line_index": i, "track": track} for i, line in enumerate(lines[:start])
                        if line.get("event") == "wm_targets" for track in line.get("tracks", []) if track.get("id") == track_id]
        new_hit = [hit for hit in track_hits if start <= hit["line_index"] < end]
        source_verified = bool(prior_memory) if source == "memory" else bool(new_hit) and not prior_memory if source == "new_observations" else False
        confirmed = next(({"line_index": i, "tick": line.get("tick", next((prior.get("tick") for prior in reversed(lines[:i])
                           if number(prior.get("tick"))), None))} for i, line in indexed if line.get("event") == "memory_confirmed"), None)
        balls.append({"ball_index": first.get("ball_index"), "track_id": track_id, "source": source,
            "source_verified": source_verified, "source_evidence": {"prior_memory": prior_memory[-1:], "new_hit_lines": [h["line_index"] for h in new_hit]},
            "first_seen_associated_with_track": first_hit, "confirmed_time": confirmed,
            "first_seen_raw_corresponding_package": audit("unknown", None,
                "earliest raw visibility requires unambiguous exact render-truth package association; first WM hit is not a substitute"),
            "line_range": [start, end], "start_tick": start_tick,
            "timeline": [{"line_index": i, **line} for i, line in selected_lines],
            "platform_grabs": ball_grabs, "platform_deliveries": ball_deliveries,
            "distinct_package_ids": sorted({e["packageId"] for e in ball_deliveries}),
            "fixed_rule_audit": fixed,
            "fixed_rules_all_pass": all(item["status"] == "pass" for item in fixed.values()),
            "failure_reasons": [line.get("reason") for line in endings if line.get("success") is not True],
            "ending": endings[-1] if endings else None})
    observe = [(i, line) for i, line in enumerate(lines) if line.get("event") == "observe"]
    repeats, missing_motion = [], []
    for (a, left), (b, right) in zip(observe, observe[1:]):
        aa, bb = left.get("odo"), right.get("odo")
        if not all(isinstance(v, list) and len(v) == 3 and all(number(n) for n in v) for v in (aa, bb)):
            missing_motion.append([a, b])
            continue
        moved = math.dist(aa[:2], bb[:2])
        turned = abs((bb[2] - aa[2] + 180) % 360 - 180)
        if left.get("tick") == right.get("tick") or (moved < 5 - 1e-9 and turned < 10 - 1e-9):
            repeats.append({"line_indices": [a, b], "moved_cm": moved, "turned_deg": turned})
    errors = [event for event in indexed_events if event.get("type") == "program_error"]
    guards = [{"line_index": i, **line} for i, line in enumerate(lines) if line.get("event") == "observe_motion_violation"]
    offroad = result.get("violationMetrics", {}).get("off_road")
    road_flags = []
    def road_walk(value, location):
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "onRoad":
                    road_flags.append({"path": location + "/onRoad", "value": item})
                else:
                    road_walk(item, location + "/" + key)
        elif isinstance(value, list):
            for i, item in enumerate(value):
                road_walk(item, location + "/" + str(i))
    road_walk(lines, "lines")
    road_bad = any(item["value"] is False for item in road_flags) or isinstance(offroad, dict) and any(
        number(offroad.get(key)) and offroad[key] > 0 for key in ("episodes", "durationMs", "maxSeverity"))
    road_known = finished and isinstance(offroad, dict) and all(offroad.get(key) == 0 for key in ("episodes", "durationMs", "maxSeverity"))
    duration = result.get("durationSeconds")
    bytes_count = record.get("vision", {}).get("frameBytes")
    program_path = resolve(path, raw.get("program"), path.parent / "program.py")
    details = static_checks(program_path, lines)
    details.update({
        "run_finished": audit("pass" if finished and not raw.get("timedOut") else "fail", {"finished": finished, "timedOut": raw.get("timedOut")}),
        "two_distinct_targets_grabbed_and_delivered": audit("pass" if len(verified_deliveries) == 2 else "fail", verified_deliveries),
        "program_errors_zero": audit("fail" if errors else "pass" if finished else "unknown", errors),
        "simulation_seconds_at_most_600": numeric([{"value": duration}], lambda x: 0 <= x <= 600, "platform_duration_missing"),
        "observe_at_most_92": audit("pass" if finished and len(observe) <= 92 else "fail", {"count": len(observe), "reported_counts": [line.get("observe_count") for _, line in observe]}),
        "vision_at_most_20mib": numeric([{"value": bytes_count}], lambda x: 0 <= x <= 20 * 1024 * 1024, "vision_byte_count_missing"),
        "no_stationary_observe_or_guard_violation": audit("fail" if repeats or guards else "unknown" if missing_motion else "pass", {"repeats": repeats, "guard_violations": guards, "missing_motion": missing_motion}),
        "on_road_entire_run": audit("fail" if road_bad else "pass" if road_known else "unknown", {"platform_off_road": offroad, "explicit_false": [item for item in road_flags if item["value"] is False]}),
        "two_ball_timelines_complete": audit("pass" if len(balls) == 2 and [b["ball_index"] for b in balls] == [1, 2]
            and len({b["track_id"] for b in balls}) == 2 and all(b["track_id"] and b["source"] in ("memory", "new_observations")
            and b["source_verified"]
            and b["ending"] and b["ending"].get("success") is True and len(b["platform_deliveries"]) == 1 for b in balls) else "fail",
            [{key: b[key] for key in ("ball_index", "track_id", "source", "ending", "distinct_package_ids")} for b in balls]),
        "every_ball_fixed_rules_pass": audit("pass" if len(balls) == 2 and all(b["fixed_rules_all_pass"] for b in balls) else "fail",
            [{"ball_index": b["ball_index"], "not_pass": {k: v for k, v in b["fixed_rule_audit"].items() if v["status"] != "pass"}} for b in balls]),
    })
    files, evidence = evidence_audit(path, raw, samples_path)
    details.update(evidence)
    gates = {name: item["status"] == "pass" for name, item in details.items()}
    failures = [{"gate": name, "status": item["status"], "reason": item.get("reason")}
                for name, item in details.items() if item["status"] != "pass"]
    flow = [{"line_index": i, **line} for i, line in enumerate(lines) if line.get("event") == "flow_end"]
    return {"schema": "wm-two-target-demo-report/v1", "map": raw.get("assignedMap"),
        "raw_file": str(path), "index_convention": "zero-based raw lines / record.events arrays",
        "gates": gates, "gate_details": details, "all_gates_pass": all(gates.values()),
        "balls": balls, "failure_reasons": failures, "flow_end": flow,
        "budgets": {"simulation_seconds": duration, "observes": len(observe), "vision_bytes": bytes_count},
        "platform_grabs": grabbed, "platform_deliveries": delivered,
        "verified_final_delivered_package_ids": sorted(event["packageId"] for event in verified_deliveries),
        "evidence_files": files, "program_versions": [line for line in lines if line.get("event") == "program_version"]}


def render_details(report):
    trials = report.get("trials", [report])
    successful = next((row for row in trials if row["all_gates_pass"]), None)
    text = ["# 双目标 Demo", "", "仅展示首次通过的演示；失败布局保留，不计算成功率。", "",
            "| 布局 | 结果 | 已验证送达目标 | 仿真秒 | observe | 停止原因 / 未通过门槛 |",
            "|---|---|---|---:|---:|---|"]
    for row in trials:
        reasons = [item.get("reason") for item in row["flow_end"] if item.get("success") is not True and item.get("reason")]
        reasons += [item["gate"] + "=" + item["status"] for item in row["failure_reasons"]]
        text.append(f"| {row['map']} | {'通过' if row['all_gates_pass'] else '未通过'} | {', '.join(row['verified_final_delivered_package_ids']) or '无'} | {row['budgets']['simulation_seconds']} | {row['budgets']['observes']} | {'; '.join(reasons) or '—'} |")
    selected = successful or (trials[-1] if trials else None)
    if selected:
        text += ["", f"主时间线：{selected['map']}。原始记录：`{selected['raw_file']}`。所有索引为零起点。"]
        for ball in selected["balls"]:
            text += ["", f"## 第 {ball['ball_index']} 球", "", f"轨迹 `{ball['track_id']}`；来源 `{ball['source']}`；平台目标 `{', '.join(ball['distinct_package_ids']) or '未送达'}`。", "",
                     "| lines 索引 | tick | 事件 | 数值 / 状态 |", "|---:|---:|---|---|"]
            for event in ball["timeline"]:
                data = {k: v for k, v in event.items() if k not in ("line_index", "event", "tick")}
                text.append(f"| {event['line_index']} | {event.get('tick', '—')} | {event['event']} | `{json.dumps(data, ensure_ascii=False, separators=(',', ':'))}` |")
            text += ["", "固定规则：" + "；".join(f"{key}={value['status']}" for key, value in ball["fixed_rule_audit"].items()) + "。"]
        text += ["", "## 门槛与证据", "", "| 门槛 | 状态 |", "|---|---|"]
        text += [f"| {name} | {item['status']} |" for name, item in selected["gate_details"].items()]
        text += ["", "数值与证据文件 SHA256 见 `demo_report.json`。缺证据为 unknown，不计通过。"]
    if not successful:
        counts = Counter(item.get("reason") for row in trials for item in row["flow_end"] if item.get("reason"))
        text += ["", "未获得通过演示。最频停止原因：" + ("；".join(f"{name}（{count} 次）" for name, count in counts.most_common()) or "缺少明确 flow_end 原因，见未通过门槛") + "。"]
    return "\n".join(text) + "\n"


def render(report):
    trials = report.get("trials", [report])
    selected = next((row for row in trials if row["all_gates_pass"]), None)
    text = ["# 双目标 Demo", "", "结果：" + (f"{selected['map']} 首次通过，两种不同目标均确实抓取并送达。" if selected else "未获得通过演示。"), ""]
    def when(tick=None, event=None, line=None):
        if event:
            return f"{event['t'] / 1000:.2f}s / tick {event['t'] / 20:g} / events[{event['event_index']}]"
        if number(tick):
            return f"{tick * .02:.2f}s / tick {tick:g}" + (f" / lines[{line}]" if line is not None else "")
        return "未知"
    if selected:
        text += ["| 球 / 轨迹 | 来源 | 首次看到 / 首次关联命中 | confirmed | grabbed | delivered |", "|---|---|---|---|---|---|"]
        for ball in selected["balls"]:
            first, confirmed = ball["first_seen_associated_with_track"] or {}, ball["confirmed_time"] or {}
            grab = ball["platform_grabs"][0] if ball["platform_grabs"] else None
            delivery = ball["platform_deliveries"][0] if ball["platform_deliveries"] else None
            text.append(f"| {ball['ball_index']} / {ball['track_id']} | {ball['source']} | 首次看到 unknown；关联 {when(first.get('tick'), line=first.get('observe_line_index'))} | {when(confirmed.get('tick'), line=confirmed.get('line_index'))} | {when(event=grab)} | {when(event=delivery)} |")
        text += ["", f"仿真 {selected['budgets']['simulation_seconds']} 秒；observe {selected['budgets']['observes']}；原生视觉 {selected['budgets']['vision_bytes']} bytes。固定规则、程序错误及完整证据均见逐项审计。"]
    failures = [row for row in trials if not row["all_gates_pass"]]
    if failures:
        text += ["", "| 失败布局 | 停止原因 |", "|---|---|"]
        for row in failures:
            reasons = [event.get("reason") for event in row["flow_end"] if event.get("success") is not True and event.get("reason")]
            if not reasons:
                reasons = [item["gate"] + "=" + item["status"] for item in row["failure_reasons"]]
            text.append(f"| {row['map']} | {'; '.join(reasons)} |")
        if selected is None:
            counts = Counter(event.get("reason") for row in failures for event in row["flow_end"] if event.get("reason"))
            text += ["", "最频卡点：" + ("；".join(f"{reason}（{count} 局）" for reason, count in counts.most_common(3)) or "缺少明确退出原因，查看门槛证据") + "。"]
    raw_path = Path(trials[0]["raw_file"]) if trials else None
    target_path = str(raw_path.parent if "trials" in report else raw_path) if raw_path else "<demo目录>"
    text += ["", "本报告不计算成功率。数值、原始行索引和图像哈希见 [DETAILS.md](DETAILS.md) 与 [demo_report.json](demo_report.json)。unknown 不计通过；合计图像大小只报告。", "",
             "离线复跑：", "", f"```sh\npython3 tools/demo_report.py {target_path}\n```", ""]
    return "\n".join(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    path = args.path.resolve()
    if path.is_dir():
        progress = load(path / "progress.json")
        trials = [analyse_demo(path / f"{name}.json") for name in progress.get("completed", {})]
        success = next((row["map"] for row in trials if row["all_gates_pass"]), None)
        report = {"schema": "wm-two-target-demo-summary/v1", "status": progress.get("status"),
            "success_map": success, "all_gates_pass": success is not None, "trials": trials,
            "scope": "demo evidence only; no rate or independent-scene statistics"}
        folder = args.output_dir or path
    else:
        report, folder = analyse_demo(path), args.output_dir or path.parent
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "demo_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (folder / "DEMO.md").write_text(render(report), encoding="utf-8")
    (folder / "DETAILS.md").write_text(render_details(report), encoding="utf-8")
    print(json.dumps({"report": str(folder / "demo_report.json"), "all_gates_pass": report["all_gates_pass"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
