#!/usr/bin/env python3
"""任务程序单局验收：WM 目标 vs 真球、每次 grab 的结果/reason 与真值前向/侧向、approach 次数、mission。

    python3 tools/verify_grab.py artifacts/inloop/v27_target_runs/<map>.json

真值只来自 driver 保存的 record.samples / record.events，程序运行时不可见。
坐标：里程计系 (rightCm, forwardCm) ↔ 场景系用 tick 0 的起点位姿换算，8 world units / m。
被抓的球 = package_grabbed 的包裹；没抓到时取第一次 grab 事件里的包裹（平台按最近的包裹判定）。
"""
import json
import math
import sys
from pathlib import Path

UNITS_PER_M = 8.0
CM = 100.0 / UNITS_PER_M


def main(path):
    result = json.loads(Path(path).read_text(encoding="utf-8"))
    samples_path = Path(result["samplesFile"])
    if not samples_path.exists():  # 结果文件被改名时，用同名 .samples.json
        samples_path = Path(str(path).replace(".json", "") + ".samples.json")
    samples = json.loads(samples_path.read_text(encoding="utf-8"))
    events = result["record"]["events"]
    lines = result["lines"]
    start = next(s for s in samples if s["tick"] == 0)
    h0 = start["heading"]
    f0 = (-math.sin(h0), -math.cos(h0))
    r0 = (math.cos(h0), -math.sin(h0))

    def odo_m_to_scene(x_right_m, z_fwd_m):
        return (start["x"] + (x_right_m * r0[0] + z_fwd_m * f0[0]) * UNITS_PER_M,
                start["z"] + (x_right_m * r0[1] + z_fwd_m * f0[1]) * UNITS_PER_M)

    def pose_at(tick):
        return max((s for s in samples if s["tick"] <= tick), key=lambda s: (s["tick"], s["seq"]))

    def body_frame(ball, s):
        h = s["heading"]
        dx, dz = ball[0] - s["x"], ball[1] - s["z"]
        return (round((dx * -math.sin(h) + dz * -math.cos(h)) * CM, 2), round((dx * math.cos(h) + dz * -math.sin(h)) * CM, 2))

    grab_events = [e for e in events if e.get("interactionType") == "package_grab"]
    grabbed = next((e for e in grab_events if e["type"] == "package_grabbed"), None)
    ref = grabbed or (grab_events[0] if grab_events else None)
    out = {"file": path, "assignedMap": result.get("assignedMap"),
           "version": next((l.get("version") for l in lines if l.get("event") == "program_version"), None),
           "mission": result["score"].get("mission") if isinstance(result.get("score"), dict) else None,
           "score": result["score"].get("total") if isinstance(result.get("score"), dict) else None,
           "runState": result.get("runState"), "stallReason": result.get("stallReason"),
           "grabbed": grabbed is not None,
           "delivered": any(e["type"] == "package_delivered" for e in events),
           "approach_calls": sum(1 for l in lines if l.get("event") == "approach_call"),
           "observe_count": max((l.get("observe_count", 0) for l in lines if l.get("event") == "observe"), default=0),
           "grab_count": len(grab_events),
           "grab_geometry": next((l for l in lines if l.get("event") == "grab_geometry"), None)}
    ball = ref["position"] if ref else None
    out["ball"] = {"packageId": ref.get("packageId") if ref else None, "position": ball}
    steps = [l for l in lines if l.get("event") == "grab_step"]
    attempts = []
    for i, e in enumerate(grab_events):
        tick = round(e["t"] / 20)
        fwd, right = body_frame(e.get("position") or ball, pose_at(tick))
        attempts.append({"n": i + 1, "type": e["type"], "reason": e.get("reason"), "packageId": e.get("packageId"),
                         "tick": tick, "truth_forward_cm": fwd, "truth_right_cm": right,
                         "program_step": ({k: steps[i].get(k) for k in ("step", "advanced_cm", "holding", "tick", "wm_distance_m")}
                                          if i < len(steps) else None)})
    out["grab_attempts"] = attempts
    if ball is not None:
        wm_rows = []
        for l in lines:
            if l.get("event") == "wm_targets":
                for t in l.get("tracks", []):
                    sx, sz = odo_m_to_scene(t["x"], t["z"])
                    wm_rows.append({"hit": t["hit"], "state": t["state"], "err_cm": round(math.hypot(sx - ball[0], sz - ball[1]) * CM, 2)})
        out["wm_vs_truth"] = wm_rows
        out["wm_final_err_cm"] = wm_rows[-1]["err_cm"] if wm_rows else None
        hits = next((l["hits"] for l in lines if l.get("event") == "memory_confirmed"), [])
        out["confirm_hits_vs_truth"] = []
        for hit in hits:
            sx, sz = odo_m_to_scene(hit["world_x"], hit["world_z"])
            out["confirm_hits_vs_truth"].append({"distanceCm": hit["distanceCm"],
                                                 "err_cm": round(math.hypot(sx - ball[0], sz - ball[1]) * CM, 2)})
    if grabbed is not None:
        fwd, right = body_frame(ball, pose_at(round(grabbed["t"] / 20)))
        out["grab"] = {"packageId": grabbed["packageId"], "truth_forward_cm": fwd, "truth_right_cm": right}
    else:
        out["program_tail"] = [l for l in lines if str(l.get("event", "")).startswith(("grab", "approach", "memory_navigation"))][-12:]
    out["checks"] = {
        "grabbed": grabbed is not None,
        "approach_calls_le_3": out["approach_calls"] <= 3,
        "mission_ge_1": str(out["mission"] or "").split("/")[0].strip() not in ("", "0", "--"),
    }
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
