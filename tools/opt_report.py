#!/usr/bin/env python3
"""Offline v3 opt-1 report, preserving the frozen stage-1 grouping policy."""
import argparse
import hashlib
import json
import math
from pathlib import Path

from stage_report import evaluate as stage_evaluate, POLICY
from demo_timeline import reconstruct
from wm_hit_audit import generate as wm_audit

ROOT = Path(__file__).resolve().parents[1]
R3 = ROOT / "artifacts/inloop/stage-1/round-3"


def read(path):
    return json.loads(Path(path).read_text())


def save(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def odometer_at(inputs, tick):
    rows = [item for item in inputs if item.get("method") == "odometry"]
    exact = [item for item in rows if item.get("tick") == tick]
    if exact:
        return {"value_cm": exact[-1]["result"]["distanceCm"], "basis": "exact_tick", "input_seq": [exact[-1]["seq"]]}
    before = [item for item in rows if item.get("tick", math.inf) < tick]
    after = [item for item in rows if item.get("tick", -math.inf) > tick]
    if before and after:
        left, right = before[-1], after[0]
        if left["result"]["distanceCm"] == right["result"]["distanceCm"]:
            return {"value_cm": left["result"]["distanceCm"], "basis": "identical_cumulative_distance_brackets",
                    "input_seq": [left["seq"], right["seq"]], "bracket_ticks": [left["tick"], right["tick"]]}
    return {"value_cm": None, "basis": "unknown_no_exact_or_stationary_bracket"}


def diagnostics(path):
    raw = read(path)
    lines, record = raw["lines"], read(raw["fullRecordFile"])
    inputs, events, samples = record["inputs"], record["events"], record["samples"]
    native = read(raw["visionEvidenceFile"])
    timeline = reconstruct(path)
    # Only use native truth whose exact query/frame/run/PNG binding was verified
    # by reconstruct; unverified booleans alone cannot establish a phantom gate.
    truths = {}
    for observation in timeline["observations"]:
        matches = [frame for frame in native["renderTruth"]["frames"]
                   if frame.get("frameId") == observation["frame_id"]
                   and frame.get("evidenceTick") == observation["tick"]
                   and frame.get("imageSha256") == observation["image_sha256"]]
        if len(matches) == 1:
            truths[observation["tick"]] = matches[0]
    confirms = [(i, line) for i, line in enumerate(lines) if line.get("event") == "memory_confirmed"]
    confirmation = confirms[0] if confirms else None
    last_observe = next(((i, line) for i, line in reversed(list(enumerate(lines[:confirmation[0]])))
                         if line.get("event") == "observe"), None) if confirmation else None
    confirm_tick = last_observe[1]["tick"] if last_observe else None
    grabbed = [(i, event) for i, event in enumerate(events)
               if event.get("type") == "package_grabbed" and event.get("accepted") and event.get("objectRole") == "target"]
    if len({event["packageId"] for _, event in grabbed}) > 1:
        raise ValueError("opt-1 single-target diagnostics cannot summarize a two-target run")
    result = {"first_confirmed_seconds": confirm_tick * .02 if confirm_tick is not None else None,
              "confirmation_line": confirmation[0] if confirmation else None,
              "last_confirmation_observe_line": last_observe[0] if last_observe else None,
              "timeline": timeline, "balls": [], "phantom_confirmations": [], "phantom_unknown": []}
    for event_index, grab in grabbed:
        tick = round(grab["t"] / 20)
        exact_samples = [sample for sample in samples if sample["tick"] == tick]
        sample = exact_samples[-1] if exact_samples else None
        delivery = next(((i, event) for i, event in enumerate(events)
                         if event.get("type") == "package_delivered" and event.get("packageId") == grab["packageId"]), None)
        visible = next((ball for ball in timeline["balls"] if ball["package_id"] == grab["packageId"]), {})
        first = visible.get("earliest_unambiguous_uncapped")
        start_distance = odometer_at(inputs, confirm_tick) if confirm_tick is not None else {"value_cm": None}
        end_distance = odometer_at(inputs, tick)
        road = end_distance["value_cm"] - start_distance["value_cm"] if all(
            item["value_cm"] is not None for item in (start_distance, end_distance)) else None
        start_pose = truths.get(confirm_tick, {}).get("vehicle")
        straight = math.hypot(sample["x"] - start_pose["x"], sample["z"] - start_pose["z"]) * 12.5 if sample and start_pose else None
        geometry = next((line for line in lines if line.get("event") == "grab_geometry"), {})
        ball = {"package_id": grab["packageId"], "first_seen_seconds": first.get("seconds") if first else None,
                "first_seen_basis": "exact_render_unique_uncapped_raw" if first else "unknown",
                "first_seen_line": first.get("line_index") if first else None,
                "confirmed_seconds": result["first_confirmed_seconds"], "grabbed_seconds": grab["t"] / 1000,
                "delivered_seconds": delivery[1]["t"] / 1000 if delivery else None,
                "grab_event_index": event_index, "delivery_event_index": delivery[0] if delivery else None,
                "confirm_to_grab_road_cm": road, "confirm_to_grab_straight_cm": straight,
                "road_straight_ratio": road / straight if road is not None and straight else None,
                "odometer_boundaries": [start_distance, end_distance], "grab_truth_exact_tick": sample is not None,
                "sight_vs_approach_deg": geometry.get("sight_vs_approach_deg"),
                "observes": sum(line.get("event") == "observe" for line in lines),
                "native_vision_bytes": raw["record"]["vision"]["frameBytes"],
                "total_vision_bytes": raw.get("demoEvidence", {}).get("combinedImageBytes")}
        if sample:
            dx, dz = grab["position"][0] - sample["x"], grab["position"][1] - sample["z"]
            heading = sample["heading"]
            ball.update(grab_truth_forward_cm=(dx * -math.sin(heading) - dz * math.cos(heading)) * 12.5,
                        grab_truth_right_cm=(dx * math.cos(heading) - dz * math.sin(heading)) * 12.5)
        result["balls"].append(ball)
    initial = next(sample for sample in samples if sample["tick"] == 0)
    h0 = initial["heading"]
    confirmed_ids, latest_observe = set(), None
    for index, line in enumerate(lines):
        if line.get("event") == "observe":
            latest_observe = line
        if line.get("event") != "wm_targets":
            continue
        for track in line.get("tracks", []):
            if track.get("state") != "confirmed" or track["id"] in confirmed_ids:
                continue
            confirmed_ids.add(track["id"])
            truth = truths.get(latest_observe.get("tick")) if latest_observe else None
            if not truth:
                result["phantom_unknown"].append({"line_index": index, "track_id": track["id"], "reason": "no_exact_render_truth"})
                continue
            x = initial["x"] + 8 * (track["x"] * math.cos(h0) - track["z"] * math.sin(h0))
            z = initial["z"] + 8 * (-track["x"] * math.sin(h0) - track["z"] * math.cos(h0))
            candidates = [{"id": package["id"], "distance_cm": math.hypot(package["x"] - x, package["z"] - z) * 12.5}
                          for package in truth["objectState"]["packages"] if package["role"] == "target"]
            if not any(candidate["distance_cm"] <= 30 for candidate in candidates):
                result["phantom_confirmations"].append({"line_index": index, "track_id": track["id"],
                    "tick": latest_observe["tick"], "truth_candidates": candidates})
    return result


def evaluate(folder, previous, filter_report):
    stage = stage_evaluate(folder, previous)
    prior = stage_evaluate(previous, R3)
    by_map = {row["map"]: row for row in stage["runs"]}
    regressions = []
    for group in prior["scenarios"]:
        if group["passed"]:
            failed = [name for name in group["members"] if name not in by_map or not by_map[name]["confirmed_and_grabbed"]]
            if failed:
                regressions.append({"previous_scenario": group["scenario"], "members": group["members"], "failed_maps": failed,
                                    "failure_rows": [by_map[name] for name in failed if name in by_map]})
    extra = {name: diagnostics(folder / f"{name}.json") for name in by_map}
    stage["gates"]["no_regression_from_previous_successful_scenarios"] = not regressions
    stage["gates"]["map_02_confirmed_and_grabbed"] = by_map.get("map-02", {}).get("confirmed_and_grabbed", False)
    stage["gates"]["phantom_CONFIRMED_zero"] = all(not value["phantom_confirmations"] and not value["phantom_unknown"] for value in extra.values())
    combined = {name: read(folder / f"{name}.json").get("demoEvidence", {}).get("combinedImageBytes") for name in by_map}
    stage["gates"]["all_visual_evidence_at_most_20mib"] = all(type(value) is int and value <= 20 * 1024 * 1024 for value in combined.values())
    # Bind the test verdict to this round's runtime filter and evaluator identity.
    filter_metrics = read(filter_report)
    manifest = read(folder / "code_manifest.json")
    filter_path = str(ROOT / "programs/src/detection_filter.py")
    evaluator_path = str(ROOT / "tools/detection_evaluation.py")
    test_files = filter_metrics.get("frozen_files") or {}
    filter_binding = (filter_metrics.get("dataset") == "test"
                      and filter_metrics.get("filter_sha256") == manifest.get(filter_path)
                      and all(test_files.get(path) == manifest.get(path) and manifest.get(path)
                              for path in (filter_path, evaluator_path)))
    stage["gates"]["frozen_filter_test_identity_matches_round"] = bool(filter_binding)
    stage["gates"]["frozen_filter_test_metrics_pass"] = bool(filter_binding) and filter_metrics.get("all_gates_pass") is True
    stage.update(all_gates_pass=all(stage["gates"].values()), regressions=regressions,
                 previous_round=str(previous), per_ball_diagnostics=extra, filter_test_metrics=filter_metrics,
                 combined_visual_bytes=combined, actual_WM_hit_audit=wm_audit(folder),
                 filter_test_report_file=str(filter_report),
                 filter_test_report_sha256=hashlib.sha256(Path(filter_report).read_bytes()).hexdigest(),
                 frozen_grouping_policy=POLICY, scope="v3 opt-1; single target; no later-stage pass claims")
    return stage


def markdown(report):
    perf = report["independent_success"]
    lines = ["# opt-1 本轮验收", "", f"判定：{'PASS' if report['all_gates_pass'] else 'FAIL'}。独立场景确认并抓到 {perf['passed']}/{perf['total']}；回归 {len(report['regressions'])} 组。", "",
             "| 退出条件 | 判定 |", "|---|---|"]
    lines += [f"| {name} | {'PASS' if ok else 'FAIL'} |" for name, ok in report["gates"].items()]
    lines += ["", "| 布局 | WM对应球/标定 | 确认且抓到 | 误差cm | grab次数 | 前向/侧向cm | mission | 失败数值 |", "|---|---|---|---|---|---|---|---|"]
    for row in report["runs"]:
        lines.append(f"| {row['map']} | {row['ball']}/{row.get('calibration')} | {row['confirmed_and_grabbed']} | {row.get('wm_final_err_cm')} | {row['grabs']} | {row.get('grab_truth_forward_cm')}/{row.get('grab_truth_right_cm')} | {row['mission']} | {json.dumps(row.get('flow_end'), ensure_ascii=False)} |")
    lines += ["", "| 布局 | observe | 原生图像bytes | 全部图像bytes | program_error |", "|---|---|---|---|---|"]
    for row in report["runs"]:
        lines.append(f"| {row['map']} | {row['observes']} | {row['vision_bytes']} | {report['combined_visual_bytes'][row['map']]} | {row['platform_program_error_count']} |")
    lines += ["", "| 独立场景 | 成员 | 通过 |", "|---|---|---|"]
    lines += [f"| {group['scenario']} | {','.join(group['members'])} | {group['passed']} |" for group in report["scenarios"]]
    lines += ["", "| 布局/球 | 首见→确认→抓取→送达(s) | 道路/直线cm；比值 | 真值前/侧cm；视线夹角 | observe；全部图像bytes |", "|---|---|---|---|---|"]
    for name, value in report["per_ball_diagnostics"].items():
        if not value["balls"]:
            lines.append(f"| {name}/未抓到 | 首次确认 {value['first_confirmed_seconds']}；其余见原始轨迹 | 未到抓取，未知 | 未抓取，未知 | 见布局审计 |")
        for ball in value["balls"]:
            times = '→'.join(str(ball.get(key)) for key in ('first_seen_seconds','confirmed_seconds','grabbed_seconds','delivered_seconds'))
            lines.append(f"| {name}/{ball['package_id']} | {times} | {ball['confirm_to_grab_road_cm']}/{ball['confirm_to_grab_straight_cm']}；{ball['road_straight_ratio']} | {ball.get('grab_truth_forward_cm')}/{ball.get('grab_truth_right_cm')}；{ball['sight_vs_approach_deg']} | {ball['observes']}；{ball['total_vision_bytes']} |")
    lines += ["", "None 为未到达或证据未知，不能视为零。原始行、事件索引、里程边界与精确tick证据见 opt_report.json。定位测试结论仅E/G；其余球位只报告。分组方法/容差与旧stage-1一致。", "",
              "| 未见位置 | 关联布局样本数 | 独立场景样本数 | 最终误差cm（逐样本） |", "|---|---|---|---|"]
    for position, values in report["unseen_accuracy"].items():
        lines.append(f"| {position} | {len(values['matched_runs'])} | {len(values['independent_scenes'])} | {json.dumps(values['matched_runs'], ensure_ascii=False)} |")
    lines += ["",
              "回归证据：", "", "```json", json.dumps(report["regressions"], ensure_ascii=False, indent=2), "```", ""]
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--previous", type=Path, default=R3)
    parser.add_argument("--filter-report", type=Path, required=True)
    args = parser.parse_args()
    report = evaluate(args.folder.resolve(), args.previous.resolve(), args.filter_report.resolve())
    save(args.folder / "opt_report.json", report)
    (args.folder / "SUMMARY.md").write_text(markdown(report))
    print(json.dumps({"all_gates_pass": report["all_gates_pass"], "gates": report["gates"], "independent": report["independent_success"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
