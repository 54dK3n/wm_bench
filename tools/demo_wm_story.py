#!/usr/bin/env python3
"""Extract the original saved demo's WM story; never executes robot/simulator code.

python3 tools/demo_wm_story.py
python3 tools/demo_wm_story.py --check
Only wm_story.json is written. Original reports, programs and evidence stay intact.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def resolve(folder, name):
    path = Path(name)
    if not path.is_absolute():
        return folder / path
    if path.exists():
        return path
    # Preserve source JSON; allow an evidence archive restored at another checkout.
    if "artifacts" in path.parts:
        return ROOT.joinpath(*path.parts[path.parts.index("artifacts"):])
    return path


def info(path):
    try:
        name = str(path.relative_to(ROOT))
    except ValueError:
        name = str(path)
    return {"path": name, "sha256": sha(path)}


def odometer(inputs, tick):
    rows = [(i, e) for i, e in enumerate(inputs)
            if e.get("type") == "navigation_query" and e.get("method") == "odometry"]
    exact = [(i, e) for i, e in rows if e.get("tick") == tick]
    if exact:
        selected, basis = [exact[-1]], "exact_tick"
    else:
        before = [(i, e) for i, e in rows if e.get("tick", math.inf) < tick]
        after = [(i, e) for i, e in rows if e.get("tick", -math.inf) > tick]
        if not before or not after or before[-1][1]["result"]["distanceCm"] != after[0][1]["result"]["distanceCm"]:
            raise ValueError(f"No exact or unchanged cumulative-distance bracket at tick {tick}")
        selected, basis = [before[-1], after[0]], "identical_cumulative_distance_brackets_no_interpolation"
    return {"tick": tick, "value_cm": selected[0][1]["result"]["distanceCm"], "basis": basis,
            "public_inputs": [{"input_index": i, "seq": e["seq"], "tick": e["tick"],
                               "distanceCm": e["result"]["distanceCm"]} for i, e in selected]}


def extract(folder, map_name):
    raw_path = folder / (map_name + ".json")
    raw = read(raw_path)
    record_path = resolve(folder, raw["fullRecordFile"])
    record = read(record_path)
    lines, inputs, events = raw["lines"], record["inputs"], record["events"]
    report_path, finalized_path = folder / "demo_report.json", folder / "demo_finalized.json"
    original = next(t for t in read(report_path)["trials"] if t["map"] == map_name)
    finalized = next(t for t in read(finalized_path)["trials"] if t["map"] == map_name)
    program, executed = folder / "program.py", folder / "executed_program.py"
    identity = read(folder / "identity.json")
    step_ms = record["simulationDefinition"]["stepMs"]
    assert step_ms == 20
    assert raw["record"]["events"] == events
    assert finalized["raw_sha256"] == sha(raw_path)
    assert record["sourceCode"] == executed.read_text()
    assert program.read_text().strip() == record["sourceCode"]
    assert sha(executed) == identity["file_sha256"] == lines[0]["file_sha256"]

    increments, previous, observe, associations = [], {}, None, []
    for i, e in enumerate(lines):
        if e["event"] == "observe":
            observe, associations = (i, e), []
        elif e["event"] == "wm_associations":
            associations = e["items"]
        elif e["event"] == "wm_targets":
            for track in e["tracks"]:
                count, track_id = track["hit"], track["id"]
                if count > previous.get(track_id, 0):
                    assert count == previous.get(track_id, 0) + 1 and observe
                    readings = [a for a in associations if a["track_id"] == track_id]
                    assert len(readings) == 1
                    ob_line, ob = observe
                    reading = readings[0]
                    native = [(j, q) for j, q in enumerate(inputs) if q.get("type") == "vision_query"
                              and q.get("method") == "observe" and q.get("tick") == ob["tick"]]
                    assert len(native) == 1
                    keys = ("category", "distanceCm", "bearingDeg", "confidence")
                    assert [{k: d.get(k) for k in keys} for d in native[0][1]["result"]
                            if d.get("category") in ("target", "distractor")] == ob["raw"]
                    raw_readings = [d for d in ob["raw"] if d["category"] == "target"
                                    and d["distanceCm"] == reading["distanceCm"] and d["bearingDeg"] == reading["bearingDeg"]]
                    assert len(raw_readings) == 1
                    increments.append({"track_id": track_id, "hit": count, "wm_line": i,
                        "observe_line": ob_line, "tick": ob["tick"], "seconds": ob["tick"] * step_ms / 1000,
                        "raw": raw_readings[0], "odometry_right_forward_cm_heading_deg": ob["odo"],
                        "native_observe_input_index": native[0][0], "native_observe_seq": native[0][1]["seq"]})
                previous[track_id] = count

    def event_ref(i, e):
        return {"event_index": i, "seq": e["seq"], "type": e["type"], "package_id": e["packageId"],
                "tick": e["t"] / step_ms, "seconds": e["t"] / 1000}

    balls = []
    starts = [(i, e) for i, e in enumerate(lines) if e["event"] == "ball_start"]
    for pos, (start, first) in enumerate(starts):
        end = starts[pos+1][0] if pos+1 < len(starts) else len(lines)
        local = list(enumerate(lines[start:end], start))
        selection_line, selection = next((i, e) for i, e in local if e["event"] == "ball_selection")
        track_id = selection["track_id"]
        hits = [h for h in increments if h["track_id"] == track_id]
        assert len(hits) == 3 and [h["hit"] for h in hits] == [1, 2, 3]
        assert all(40 <= h["raw"]["distanceCm"] < 90 for h in hits)
        gaps = [{"hit_pair": [j+1, k+1], "distance_cm": math.dist(a["odometry_right_forward_cm_heading_deg"][:2],
                 b["odometry_right_forward_cm_heading_deg"][:2])} for j, a in enumerate(hits)
                for k, b in enumerate(hits) if k > j]
        assert all(g["distance_cm"] >= 15 - 1e-10 for g in gaps)
        confirm_line, confirm = next((i, e) for i, e in local if e["event"] == "memory_confirmed")
        ball_confirm_line, ball_confirm = next((i, e) for i, e in local if e["event"] == "ball_confirmed")
        assert confirm["track_id"] == ball_confirm["track_id"] == track_id
        assert [h["distanceCm"] for h in confirm["hits"]] == [h["raw"]["distanceCm"] for h in hits]
        final_ball = next(b for b in finalized["balls"] if b["ball_index"] == first["ball_index"])
        package, = final_ball["package_ids"]
        grab_i, grab = next((i, e) for i, e in enumerate(events) if e.get("type") == "package_grabbed"
                           and e.get("accepted") is True and e.get("packageId") == package)
        delivery_i, delivery = next((i, e) for i, e in enumerate(events) if e.get("type") == "package_delivered"
                                   and e.get("packageId") == package and e["t"] >= grab["t"])
        grab_tick = grab["t"] / step_ms
        last_ob_line, last_ob = next((i, e) for i, e in reversed(local) if e["event"] == "observe" and e["tick"] <= grab_tick)
        assert last_ob_line == hits[-1]["observe_line"]
        vision = [(i, q) for i, q in enumerate(inputs) if q.get("type") == "vision_query"
                  and last_ob["tick"] < q.get("tick", -1) <= grab_tick]
        assert not any(q["method"] == "observe" for _, q in vision)
        first_approach = next((i, q) for i, q in vision if q["method"] == "approach_step")
        pure_end = first_approach[1]["tick"]
        assert not any(last_ob["tick"] < q["tick"] < pure_end for _, q in vision)
        odo_start, odo_pure_end, odo_grab = (odometer(inputs, t) for t in (last_ob["tick"], pure_end, grab_tick))
        metric_line, metric = next((i, e) for i, e in local if e["event"] == "memory_navigation_metric")
        approach_line, approach = next((i, e) for i, e in local if e["event"] == "approach_call")
        first_seen = final_ball["first_seen"]
        image = resolve(folder, first_seen["image"])
        assert sha(image) == first_seen["image_sha256"]
        old = next(b for b in original["balls"] if b["ball_index"] == first["ball_index"])
        assert old["source_verified"] and old["track_id"] == track_id
        assert [h["wm_line"] for h in hits] == old["source_evidence"]["new_hit_lines"]
        prior_ids = sorted({t["id"] for e in lines[:start] if e["event"] == "wm_targets" for t in e["tracks"]})
        assert track_id not in prior_ids and selection["target_source"] == "new_observations"
        balls.append({"ball_index": first["ball_index"], "track_id": track_id, "package_id": package,
            "source": selection["target_source"], "source_evidence": {"ball_start_line": start,
                "ball_start_tick": first["tick"], "selection_line": selection_line,
                "retained_all_WM_count_at_start": first["retained_wm_targets"], "prior_track_ids": prior_ids,
                "selected_track_existed_before_ball_start": False, "all_three_hits_after_ball_start": all(h["wm_line"] > start for h in hits)},
            "first_seen": {k: first_seen[k] for k in ("line_index", "tick", "seconds", "image", "image_sha256")},
            "actual_wm_hits": hits, "all_pair_pose_gaps_cm": gaps,
            "confirmation": {"memory_confirmed_line": confirm_line, "ball_confirmed_line": ball_confirm_line,
                "tick": ball_confirm["tick"], "seconds": ball_confirm["tick"] * step_ms / 1000,
                "last_sample_wm_distance_m": confirm["last_sample_wm_distance_m"]},
            "memory_travel": {"last_observe_line": last_ob_line, "last_observe_tick": last_ob["tick"],
                "pure_memory_before_approach_cm": round(odo_pure_end["value_cm"]-odo_start["value_cm"], 10),
                "pure_memory_ends_tick": pure_end, "pure_memory_vision_queries_between_boundaries": 0,
                "last_observe_to_grab_odometer_cm": round(odo_grab["value_cm"]-odo_start["value_cm"], 10),
                "last_observe_to_grab_observe_calls": 0, "odometer_start": odo_start,
                "odometer_before_approach": odo_pure_end, "odometer_at_grab": odo_grab,
                "permitted_approach_vision_records": [{"input_index": i, "seq": q["seq"], "tick": q["tick"], "method": q["method"]} for i, q in vision],
                "logged_memory_metric_line": metric_line, "logged_signed_forward_at_grab_cm": metric["forward_after_last_observe_cm"],
                "approach_call_line": approach_line, "logged_signed_forward_before_approach_cm": approach["forward_after_last_observe_cm"],
                "approach_wm_distance_m": approach["wm_distance_m"], "approach_max_steps": approach["max_steps"],
                "meaning": "Cumulative public odometer includes reversing. Signed business metric subtracts reversing; it is not total travel. Pure memory ends before allowed approach vision; no observe occurs until actual grab."},
            "grabbed": event_ref(grab_i, grab), "delivered": event_ref(delivery_i, delivery)})
    assert len(balls) == 2 and len({b["package_id"] for b in balls}) == 2
    source_paths = [raw_path, record_path, report_path, finalized_path, program, executed, folder/"identity.json", Path(__file__)]
    attempt_raw = record_path.with_name(record_path.name.replace(".record.json", ".json"))
    if attempt_raw.exists():
        assert sha(raw_path) == sha(attempt_raw)
        source_paths.append(attempt_raw)
    comparison = ROOT / "artifacts/inloop/opt-2/round-3/program.py"
    comparison_info = info(comparison) if comparison.exists() else None
    return {"schema": "demo-wm-story/v1", "scope": "Phase A only: offline original demo map-05 / attempt-030 evidence; no simulator or program execution",
        "map": map_name, "index_convention": "zero-based raw.lines and full-native-record events/inputs; seconds from tick*20ms",
        "program_identity": {"version": identity["version"], "raw_file_sha256": sha(program),
            "executed_source_sha256": sha(executed), "wm_kit_commit": identity["wm_kit_commit"],
            "wm_embed_sha256": identity["wm_embed_sha256"], "other_opt2_r3_program": comparison_info,
            "explanation": "58a24a... is original demo file; ee01a6... is its trim-normalized executed source. 59d8f6... belongs to later opt2-r3 and has no claim to this demo outcome."},
        "balls": balls, "checks_passed": True, "source_files": [info(p) for p in source_paths]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo-folder", type=Path, default=ROOT / "artifacts/inloop/demo")
    parser.add_argument("--map", default="map-05")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    folder = args.demo_folder.resolve()
    output = args.out or folder / "wm_story.json"
    report = extract(folder, args.map)
    encoded = (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode()
    if args.check:
        if not output.exists() or output.read_bytes() != encoded:
            parser.exit(1, "wm_story.json does not match recomputed original evidence\n")
    else:
        output.write_bytes(encoded)
    print(json.dumps({"output": str(output), "checks_passed": True, "verified_existing": args.check,
                      "balls": [{"ball_index": b["ball_index"], "track_id": b["track_id"],
                                 "confirmed_seconds": b["confirmation"]["seconds"],
                                 "grabbed_seconds": b["grabbed"]["seconds"], "delivered_seconds": b["delivered"]["seconds"]}
                                for b in report["balls"]]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
