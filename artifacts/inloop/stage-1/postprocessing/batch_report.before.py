#!/usr/bin/env python3
"""10 布局诊断批跑汇总：每局一行。只用于报告；位置编号与标定标记不得进入任务程序。

    python3 tools/batch_report.py artifacts/inloop/v28_batch

追的球只由最终使用的 WM 轨迹与真值红球在 30cm 内关联；超出或没有轨迹即无对应真球。
抓取事件的实际对象单独记录，原始检测不用于给 WM 强行贴 A–G 标签。
"""
import json
import hashlib
import math
import re
import sys
from pathlib import Path

UNITS_PER_M = 8.0
CM = 100.0 / UNITS_PER_M
TRUTH_MATCH_CM = 30.0
POSITIONS = {  # 编号：(x, z, 标定状态)
    "A": (-9.87, -6.72, "已标定"), "B": (9.31, -3.26, "已用于模型选择"), "C": (10.08, 1.26, "已标定"),
    "D": (12.82, 5.64, "已标定"), "E": (0.51, 4.43, "未见过"), "F": (-6.29, -5.48, "已标定"),
    "G": (-6.75, -0.76, "未见过"),
}


def _deliberate_messages(path, lines):
    """Classify against the frozen source for this run, never today's working copy."""
    hashes = {l.get("file_sha256") for l in lines if l.get("event") == "program_version"}
    sources = [p for p in path.parent.glob("program*.py")
               if hashlib.sha256(p.read_text(encoding="utf-8").strip().encode("utf-8")).hexdigest() in hashes
               or hashlib.sha256(p.read_bytes()).hexdigest() in hashes]
    if len(sources) != 1:
        return []
    src = sources[0].read_text(encoding="utf-8")
    return [m.split("：")[0].split('" +')[0] for m in re.findall(r'raise RuntimeError\("([^"]+)"', src)]


def letter(x, z):
    key = min(POSITIONS, key=lambda k: math.hypot(POSITIONS[k][0] - x, POSITIONS[k][1] - z))
    return key if math.hypot(POSITIONS[key][0] - x, POSITIONS[key][1] - z) < 0.2 else "?"


def truth_matches(distance_cm):
    # The tiny absolute allowance only absorbs floating-point conversion at exactly 30cm.
    return distance_cm <= TRUTH_MATCH_CM or math.isclose(distance_cm, TRUTH_MATCH_CM, rel_tol=0, abs_tol=1e-9)


def analyse(path):
    r = json.loads(path.read_text(encoding="utf-8"))
    samples = json.loads(Path(str(path).replace(".json", ".samples.json")).read_text(encoding="utf-8"))
    record_available = isinstance(r.get("record"), dict) and isinstance(r["record"].get("events"), list)
    events = r["record"]["events"] if record_available else []
    lines = r["lines"]
    start = next(s for s in samples if s["tick"] == 0)
    h0 = start["heading"]
    f0, r0 = (-math.sin(h0), -math.cos(h0)), (math.cos(h0), -math.sin(h0))
    to_scene = lambda x, z: (start["x"] + (x * r0[0] + z * f0[0]) * UNITS_PER_M, start["z"] + (x * r0[1] + z * f0[1]) * UNITS_PER_M)
    pose_at = lambda tick: max((s for s in samples if s["tick"] <= tick), key=lambda s: (s["tick"], s["seq"]))
    targets = [p for p in samples[0]["packages"] if p["role"] == "target"]
    nearest = lambda x, z: min(targets, key=lambda p: math.hypot(p["x"] - x, p["z"] - z))

    grab_events = [e for e in events if e.get("interactionType") == "package_grab"]
    grabbed = next((e for e in grab_events if e["type"] == "package_grabbed"), None)
    wm_frames = [l["tracks"] for l in lines if l.get("event") == "wm_targets" and l.get("tracks")]
    wm_first = wm_frames[0][0] if wm_frames else None
    # last_observe records the track actually used by the controller. List ordering
    # alone does not identify the pursued track when several tentative tracks exist.
    active_positions = [l["target"] for l in lines if l.get("event") == "last_observe" and l.get("target")]
    wm_final = None
    if wm_frames:
        wm_final = (min(wm_frames[-1], key=lambda t: math.hypot(t["x"] - active_positions[-1][0],
                                                            t["z"] - active_positions[-1][1]))
                    if active_positions else wm_frames[-1][-1])
    raw_first = None
    for l in lines:
        if l.get("event") == "observe":
            reds = [d for d in l.get("raw", []) if d["category"] == "target"]
            if reds and l.get("tick") is not None:
                raw_first = (l["tick"], min(reds, key=lambda d: d["distanceCm"]))
                break
    ball, basis = None, "no_wm_track"
    wm_match_distance_cm = None
    if wm_final:
        scene = to_scene(wm_final["x"], wm_final["z"])
        candidate = nearest(*scene)
        wm_match_distance_cm = math.dist(scene, (candidate["x"], candidate["z"])) * CM
        if truth_matches(wm_match_distance_cm):
            ball, basis = (candidate["x"], candidate["z"]), "wm_track_within_30cm"
        else:
            basis = "wm_track_unmatched_over_30cm"

    def track_association(track):
        scene = to_scene(track["x"], track["z"])
        candidate = nearest(*scene)
        distance = math.dist(scene, (candidate["x"], candidate["z"])) * CM
        matched = truth_matches(distance)
        return {"matched": matched, "ball": letter(candidate["x"], candidate["z"]) if matched else None,
                "truth_id": candidate["id"] if matched else None,
                "distance_cm": round(distance, 1), "threshold_cm": TRUTH_MATCH_CM}

    row = {"map": r.get("assignedMap"), "file": path.name, "runState": r.get("runState"),
           "mission": (r.get("score") or {}).get("mission") if isinstance(r.get("score"), dict) else None,
           "observes": max((l.get("observe_count", 0) for l in lines if l.get("event") == "observe"), default=0),
           "approach_calls": sum(1 for l in lines if l.get("event") == "approach_call"),
           "grabs": len(grab_events), "grab_reasons": [e.get("reason") for e in grab_events], "basis": basis,
           "program_version": next((l for l in lines if l.get("event") == "program_version"), None),
           "grab_attempts": [], "ball": "无对应真球", "ball_xz": None, "calibration": None,
           "truth_match_threshold_cm": TRUTH_MATCH_CM,
           "wm_final_err_cm": None,
           "wm_nearest_truth_distance_cm": round(wm_match_distance_cm, 1) if wm_match_distance_cm is not None else None,
           "grabbed": grabbed is not None,
           "grabbed_ball": letter(*grabbed["position"]) if grabbed else None}
    for e in grab_events:
        tick = round(e["t"] / 20)
        s = pose_at(tick)
        bx, bz = e["position"]
        dx, dz, h = bx - s["x"], bz - s["z"], s["heading"]
        row["grab_attempts"].append({
            "attempt": len(row["grab_attempts"]) + 1, "tick": tick, "sample_tick": s["tick"],
            "tick_exact": s["tick"] == tick, "reason": e.get("reason"), "accepted": e.get("accepted"),
            "package_id": e.get("packageId"), "ball": letter(bx, bz),
            "truth_forward_cm": round((dx * -math.sin(h) + dz * -math.cos(h)) * CM, 1),
            "truth_right_cm": round((dx * math.cos(h) + dz * -math.sin(h)) * CM, 1),
        })
    if ball is not None:
        key = letter(*ball)
        row.update({"ball": key, "ball_xz": [round(ball[0], 2), round(ball[1], 2)],
                    "calibration": POSITIONS.get(key, (0, 0, "?"))[2]})
    if wm_final:
        association = track_association(wm_final)
        row.update({"wm_final_hits": wm_final["hit"], "wm_final_track_id": wm_final["id"],
                    "wm_final_association": association, "wm_final_truth_ball": association["ball"],
                    "wm_final_err_cm": association["distance_cm"] if association["matched"] else None,
                    "wm_final_tracks": [{**track, "truth_association": track_association(track)}
                                        for track in wm_frames[-1]]})
    if wm_first:
        first_association = track_association(wm_first)
        row.update({"wm_first_track_id": wm_first["id"],
                    "wm_first_err_cm": first_association["distance_cm"] if first_association["matched"] else None,
                    "wm_first_association": first_association,
                    "wm_first_truth_ball": first_association["ball"],
                    "wm_same_track": wm_first["id"] == wm_final["id"],
                    "wm_same_truth_target": bool(first_association["matched"] and association["matched"]
                                                 and first_association["truth_id"] == association["truth_id"])})
    if grabbed:
        s = pose_at(round(grabbed["t"] / 20))
        h = s["heading"]
        dx, dz = grabbed["position"][0] - s["x"], grabbed["position"][1] - s["z"]
        row["grab_truth_forward_cm"] = round((dx * -math.sin(h) + dz * -math.cos(h)) * CM, 1)
        row["grab_truth_right_cm"] = round((dx * math.cos(h) + dz * -math.sin(h)) * CM, 1)
    confirmed = any(l.get("event") == "memory_confirmed" for l in lines)
    fails = [l for l in lines if str(l.get("event", "")).endswith(("_failed", "_aborted")) or l.get("event") in
             ("confirmation_last_sample_too_close", "observe_budget_exhausted", "approach_min_distance_failed")]
    row["confirmation"] = "confirmed" if confirmed else (next((f"{l['event']}:{l.get('reason')}" for l in reversed(lines)
                                                               if str(l.get("event", "")).startswith("confirmation_") and l.get("reason")), None)
                                                          or ("target_never_seen" if not raw_first else "not_confirmed"))
    errors = [(str(e.get("message") or "").strip().splitlines() or ["program_error without message"])[-1]
              for e in events if e.get("type") == "program_error"]
    row["program_error"] = errors[0] if errors else None
    row["platform_program_error_count"] = len(errors)
    row["platform_program_errors"] = errors
    row["platform_record_available"] = record_available
    row["program_error_gate_pass"] = record_available and not errors
    # Both kinds remain platform program errors and fail the user's zero-error gate.
    deliberate_messages = _deliberate_messages(path, lines)
    deliberate_count = sum(err.startswith("RuntimeError:") and any(msg and msg in err for msg in deliberate_messages)
                           for err in errors)
    row["deliberate_failure_exit_count"] = deliberate_count
    row["unexpected_exception_count"] = len(errors) - deliberate_count
    row["error_kind"] = None
    if row["program_error"]:
        row["error_kind"] = "deliberate_failure_exit" if deliberate_count == len(errors) else "unexpected_exception"
    flow_end = next((l for l in reversed(lines) if l.get("event") == "flow_end"), None)
    row["flow_end"] = flow_end
    row["failure_stage"] = flow_end.get("stage") if flow_end and flow_end.get("success") is False else None
    row["failure_reason"] = (flow_end.get("reason") if flow_end and flow_end.get("success") is False
                             else row["program_error"])
    row["confirmation_accepted_hits"] = max((l.get("hits", 0) for l in lines
                                             if l.get("event") == "confirmation_sample"), default=0)
    row["fail_events"] = fails[-4:]
    row["direction_decisions"] = [{"outcome": l.get("outcome"), "direction": l.get("direction"),
                                   "rule": (l.get("decision") or {}).get("rule"),
                                   "pred": [(o["direction"], o["predicted_raw_cm"]) for o in (l.get("decision") or {}).get("options", [])]}
                                  for l in lines if l.get("event") == "confirmation_direction"]
    row["grab_geometry"] = next((l for l in lines if l.get("event") == "grab_geometry"), None)
    return row


def main(folder):
    folder = Path(folder)
    rows = [analyse(p) for p in sorted(folder.glob("map-*.json")) if not p.name.endswith((".samples.json", ".verify.json", ".calib.json"))]
    (folder / "batch_report.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    hdr = "| 布局 | 球 | 标定 | 确认 | WM 误差 cm | 抓取 | 前向/侧向 cm | mission | 结束方式 |"
    print(hdr)
    print("|---|---|---|---|---|---|---|---|---|")
    for x in rows:
        fr = f"{x.get('grab_truth_forward_cm')}/{x.get('grab_truth_right_cm')}" if "grab_truth_forward_cm" in x else "—"
        print(f"| {x['map']} | {x.get('ball', '—')} | {x.get('calibration', '—')} | {x['confirmation']} | {x.get('wm_final_err_cm', '—')} "
              f"| {x['grabs']} {x['grab_reasons']} | {fr} | {x['mission']} | {x['error_kind'] or 'normal_end'}: {x['failure_reason'] or ''} |")
    errors = sum(bool(x["platform_program_error_count"]) for x in rows)
    unexpected = sum(bool(x["unexpected_exception_count"]) for x in rows)
    complete = len(rows) == 10 and {x["map"] for x in rows} == {f"map-{i:02d}" for i in range(1, 11)}
    gate_pass = complete and all(x["program_error_gate_pass"] for x in rows)
    metrics = {"executed_layouts": len(rows), "all_ten_layouts_present_once": complete,
               "platform_program_error_runs": errors, "unexpected_exception_runs": unexpected,
               "program_error_gate_pass": gate_pass,
               "unseen_position_runs": {key: [x["map"] for x in rows if x.get("ball") == key] for key in ("E", "G")}}
    (folder / "batch_metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n平台 program_error：{errors}/{len(rows)}；意外异常：{unexpected}/{len(rows)}。"
          f"程序报错门限：{'PASS' if gate_pass else 'FAIL'}。")


if __name__ == "__main__":
    main(sys.argv[1])
