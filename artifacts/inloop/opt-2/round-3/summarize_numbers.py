#!/usr/bin/env python3
"""Reproduce final-stage cover/tables without running or modifying the simulator."""
import hashlib
import json
from pathlib import Path
import re
import statistics

HERE = Path(__file__).resolve().parent


def read(path):
    return json.loads(Path(path).read_text())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def fmt(value, digits=2):
    return "未发生/unknown" if value is None else f"{value:.{digits}f}"


def main():
    report = read(HERE / "opt2_report.json")
    wm_diagnosis_path = HERE / "final-wm-diagnosis/diagnosis.json"
    visibility_supplement = read(wm_diagnosis_path)["map02_ball2_visibility_supplement"]
    identity = read(HERE / "identity.json")
    progress = read(HERE / "progress.json")
    preflight = read(HERE / "preflight.json")
    rows = report["runs"]
    balls = [b for r in rows for b in r["balls"]]
    grabbed = [b for b in balls if b["confirmed_and_grabbed"]]
    stats = {
        "report_sha256": sha(HERE / "opt2_report.json"),
        "all_gates_pass": report["all_gates_pass"], "gates": report["gates"],
        "layout_success": report["layout_success"], "independent_success": report["independent_success"],
        "first_choice": report["first_choice_accuracy"],
        "independent_first_choice": report["independent_first_choice_accuracy"],
        "successful_seconds": report["successful_two_delivery_seconds"],
        "confirmed_tracks": sum(len(r["first_confirmed_tracks"]) for r in rows),
        "confirmed_and_grabbed_balls": len(grabbed),
        "confirmed_grabbed_delivered_balls": sum(b["confirmed_grabbed_and_delivered"] for b in balls),
        "first_ball_capture_layouts": sum(any(b["ball_index"] == 1 and b["confirmed_and_grabbed"]
                                                for b in r["balls"]) for r in rows),
        "program_errors": sum(len(r["gate_details"]["program_errors_zero"]["evidence"]) for r in rows),
        "stationary_observes": sum(len(r["gate_details"]["no_stationary_observe_or_guard_violation"]["evidence"]["repeats"]) for r in rows),
        "guard_violations": sum(len(r["gate_details"]["no_stationary_observe_or_guard_violation"]["evidence"]["guard_violations"]) for r in rows),
        "phantom_confirmations": sum(len(r["phantom_confirmations"]) for r in rows),
        "approach_max_per_ball": max(b["approach_calls"] for b in balls),
        "observe_total": sum(r["budgets"]["observes"] for r in rows),
        "observe_max": max(r["budgets"]["observes"] for r in rows),
        "combined_bytes_max": max(r["budgets"]["combined_image_bytes"] for r in rows),
        "combined_bytes_total": sum(r["budgets"]["combined_image_bytes"] for r in rows),
        "frozen_files": len(report["freeze_verification"]),
        "all_frozen_unchanged": all(report["freeze_verification"].values()),
        "completed_layouts": sorted(progress["completed"]),
        "executed_attempts": [a["map"] for a in progress["attempts"] if a["classification"] == "executed"],
        "preflight_checks": len(preflight["checks"]),
        "python_tests": int(re.search(r"(\d+) passed", (HERE / "tests.txt").read_text()).group(1)),
        "node_tests": int(re.search(r"tests (\d+)", (HERE / "driver_tests.txt").read_text()).group(1)),
        "regression_audit": report["regression_audit"],
        "unseen_accuracy": report["unseen_accuracy"],
        "identity": identity,
        "timeline_supplement": {
            "source": str(wm_diagnosis_path),
            "source_sha256": sha(wm_diagnosis_path),
            "source_key": "map02_ball2_visibility_supplement",
            "evidence": visibility_supplement,
            "frozen_report_modified": False,
        },
    }
    archives = read(HERE / "frozen_sources/INDEX.json")
    stats["source_archive_checks"] = {name: sha(HERE / item["archive"]) == item["sha256"]
        and (HERE / item["archive"]).stat().st_size == item["bytes"] for name, item in archives.items()}
    record_rows = []
    failure_groups = {}
    for row in rows:
        raw, native = read(row["raw_file"]), read(row["full_record_file"])
        end = row["flow_end"][-1] if row["flow_end"] else {}
        item = {"map": row["map"], "raw_sha256": sha(row["raw_file"]),
                "native_sha256": sha(row["full_record_file"]), "native_record": row["full_record_file"],
                "native_end_tick": native["simulationEndTick"],
                "native_duration_seconds_exact": native["simulationEndTick"] * .02,
                "native_frames": len(native["visionFrames"]), "samples": len(native["samples"]),
                "demo_frames": raw["demoEvidence"]["frames"],
                "native_png_bytes": raw["demoEvidence"]["nativeFrameBytes"],
                "demo_png_bytes": raw["demoEvidence"]["screenshotBytes"],
                "completed_tasks": native["result"]["completedTasks"], "total_tasks": native["result"]["totalTasks"],
                "flow_end": end, "ending_log_physical_line": None,
                "terminal_final": raw["hostIO"]["terminal"]["finalVerification"],
                "native_final": raw["hostIO"]["finalNativeVerification"]}
        for i, line in enumerate((HERE / (row["map"] + ".partial.txt")).read_text().splitlines(), 1):
            if line.startswith("GY "):
                try:
                    event = json.loads(line[3:])
                except ValueError:
                    continue
                if event.get("event") == "flow_end":
                    item["ending_log_physical_line"] = i
        record_rows.append(item)
        if not row["passed"]:
            key = end.get("reason") or "unknown"
            failure_groups.setdefault(key, []).append(row["map"])
    stats["records"] = record_rows
    exact_success_seconds = [rec["native_duration_seconds_exact"] for row, rec in zip(rows, record_rows)
                             if row["physical_two_deliveries"]]
    stats["exact_successful_seconds"] = {"values": exact_success_seconds,
        "median": statistics.median(exact_success_seconds) if exact_success_seconds else None,
        "basis": "native simulationEndTick * 0.02; frozen report retains platform durationSeconds rounded to 0.1s"}
    stats["failure_groups"] = failure_groups
    stats["native_frames_total"] = sum(x["native_frames"] for x in record_rows)
    stats["native_png_bytes_total"] = sum(x["native_png_bytes"] for x in record_rows)
    stats["demo_frames_total"] = sum(x["demo_frames"] for x in record_rows)
    stats["demo_png_bytes_total"] = sum(x["demo_png_bytes"] for x in record_rows)
    stats["samples_total"] = sum(x["samples"] for x in record_rows)
    stats["native_evidence_passes"] = sum(r["gates"]["native_record_evidence_binding"] for r in rows)
    for key in ("actual_wm_all_pair_gaps_15cm", "memory_drive_30cm", "approach_distance_0_25m"):
        values = [x["value"] for b in grabbed for x in b["fixed_rule_audit"][key].get("evidence", [])]
        stats[key + "_min_max"] = [min(values), max(values)] if values else None
    (HERE / "numeric_evidence.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2) + "\n")

    text = ["# 阶段 2 第 3 轮：FAIL，达到三轮上限后停止", "",
            "十布局各执行一次，全部结束后统一评估。双球送达未达到门槛，停止阶段2，不进入阶段3或阶段4。未启动赛题1。",
            "完整门槛和逐球证据见 [opt2_report.json](opt2_report.json)；[逐球表](BALL_TABLE.md)列全部时间线、里程比与抓取几何，原自动汇总保留为 [AUTO_SUMMARY.md](AUTO_SUMMARY.md)。",
            "本页和表格由同目录 summarize_numbers.py 从保存的报告、原生record和日志生成；数值索引见 [numeric_evidence.json](numeric_evidence.json)。", "",
            "| 退出条件 | 实测 | 判定 / 证据 |", "|---|---|---|",
            f"| 双球送达≥8/10 | {report['layout_success']['passed']}/10；独立场景{report['independent_success']['passed']}/{report['independent_success']['total']} | FAIL；原生两个不同目标package_delivered及最终送达状态 |",
            f"| P3.4首选最优≥8/10 | {report['first_choice_accuracy']['matches']}/10，已评估{report['first_choice_accuracy']['evaluated']}；独立场景{report['independent_first_choice_accuracy']['matches']}/{report['independent_first_choice_accuracy']['total']} | PASS；runs[].first_choice，未知不当匹配 |",
            f"| 成功局总用时中位≤300s | {fmt(stats['exact_successful_seconds']['median'])}s；原生tick值{exact_success_seconds} | PASS；simulationEndTick×0.02，含最后离开动作；冻结判定器按平台0.1s字段得到{fmt(report['successful_two_delivery_seconds']['median'], 1)}s，同样通过 |",
            f"| 无成功回归 | {len(report['regression_audit']['regressions'])}项；map-05/map-10继续双球送达 | PASS；保留第1轮成功基线，不让第2轮全体启动失败清空基线 |",
            f"| 程序报错 / 原地重复observe / guard违规 / 幻影CONFIRMED | {stats['program_errors']} / {stats['stationary_observes']} / {stats['guard_violations']} / {stats['phantom_confirmations']} | PASS；逐局gate_details及first_confirmed_tracks |",
            f"| 固定规则、安全与approach预算 | {len(grabbed)}个已抓球逐球通过；approach最大{stats['approach_max_per_ball']}次/球 | PASS；balls[].fixed_rule_audit；onRoad全程通过 |",
            f"| observe≤92与全部视觉≤20MiB/局 | 最大{stats['observe_max']}次 / {stats['combined_bytes_max']}bytes，含抓送关键帧 | PASS；runs[].budgets |",
            f"| 证据完整与冻结 | {stats['native_evidence_passes']}/10原生证据通过；{stats['frozen_files']}项冻结文件未变 | PASS；逐PNG/query/record/终端字节及SHA核验 |", "",
            f"全轮共{stats['confirmed_tracks']}条首次CONFIRMED轨迹，{len(grabbed)}球确认并抓到、{stats['confirmed_grabbed_delivered_balls']}球完成送达；第一球抓取{stats['first_ball_capture_layouts']}/10。",
            f"总observe={stats['observe_total']}；原生PNG={stats['native_frames_total']}张/{stats['native_png_bytes_total']}bytes，关键帧={stats['demo_frames_total']}张/{stats['demo_png_bytes_total']}bytes；samples={stats['samples_total']}。重复封存副本不重复计入单局视觉预算。", "",
            "全部机读门逐项列出（包括只有报告、不能替代双球退出条件的检查）：", "",
            "| 检查 | 判定 |", "|---|---|"]
    text += [f"| {name} | {'PASS' if passed else 'FAIL'} |" for name, passed in report["gates"].items()]
    text += ["", "| 布局 | 双球送达 | 首选最优 | 仿真s | observe / 全图像bytes | 最终任务项 | 失败/结束日志原值 |",
             "|---|---|---|---|---|---|---|"]
    for row, rec in zip(rows, record_rows):
        end = rec["flow_end"]
        evidence = (f"[L{rec['ending_log_physical_line']}]({row['map']}.partial.txt) "
                    f"nativeEndTick={rec['native_end_tick']}; ball={end.get('ball_index')}; "
                    f"{end.get('stage')}: {end.get('reason')}; Q={end.get('navigation_queries')},C={end.get('navigation_controls')}")
        text.append(f"| {row['map']} | {'PASS' if row['passed'] else 'FAIL'} | {row['first_choice'].get('match')} | {fmt(rec['native_duration_seconds_exact'])} | {row['budgets']['observes']} / {row['budgets']['combined_image_bytes']} | {rec['completed_tasks']}/{rec['total_tasks']} | {evidence} |")
    text += ["", "表中总任务项仅报告，不把本阶段双球成功等同全赛题完成。", "",
            "失败分组按最终日志原因计数：", ""]
    text += [f"- `{key}`：{len(maps)}局，{'、'.join(maps)}。" for key, maps in failure_groups.items()]
    text += ["", "逐条运动归因见 [motion诊断](final-motion-diagnosis/REPORT.md)，确认/WM归因见 [WM诊断](final-wm-diagnosis/REPORT.md)，完整证据核验见 [证据审计](final-evidence-audit/REPORT.md)。", "",
             "| 独立场景 | 布局 | 双球送达 |", "|---|---|---|"]
    text += [f"| {g['scenario']} | {' = '.join(g['members'])} | {g['passed']} |" for g in report["scenarios"]]
    text += ["", "沿用冻结的完整链接合并与容差，并比较两球目标片段。本轮每局目标片段均非空；map-03已进入第二球，map-01未进入，两局不再合并。未为提高比例调整分组。", "",
             "未见位置精度只列E/G；其余位置只在逐球表报告：", ""]
    for label, items in report["unseen_accuracy"].items():
        text.append(f"- {label}：n={len(items)}；" + "；".join(
            f"{x['map']}/球{x['ball_index']} {x['error_cm']:.4f}cm（JSON原始行索引{x['confirmation_line']}）" for x in items))
    text += ["", "样本量有限，不外推全面泛化。P3首选匹配也不代表双候选排序已得到充分实战覆盖，候选数量与未知代价限制见WM诊断。",
             "k沿用第1轮冻结的控制实验，不再拟合。名义控制拟合通过，复杂道路时间预测的外部残差限制继续披露，见 [使用决策](../constant-evidence/USAGE_DECISION.md)。",
             "阶段1过滤测试集在规则修改后已污染的披露继续有效，本轮不能当作新无污染过滤验证。", "",
             "版本与运行前检查：", "",
             f"- PROGRAM_VERSION：`{identity['version']}`",
             f"- 文件SHA256：`{sha(HERE / 'program.py')}`",
             f"- 实际执行sourceCode SHA256：`{identity['file_sha256']}`；executed_program.py与运行字节一致，平台删除原文件末尾换行。",
             f"- wm_kit提交：`{identity['wm_kit_commit']}`",
             f"- 嵌入包SHA256：`{identity['wm_embed_sha256']}`",
             f"- {stats['python_tests']}项Python测试、{stats['node_tests']}项Node测试通过；{stats['preflight_checks']}项预检通过。指定pylint错误0，无布局坐标/真值/target锚点访问。",
             "- 第2轮启动错误保留为失败轮；本轮只修正作用域并新增完整worker启动测试。详见 [CHANGES.md](CHANGES.md) 与 [启动诊断](../round-2/startup-diagnosis/DIAGNOSIS.md)。",
             "- 冻结源码副本及索引在frozen_sources/；全部原始日志、samples、record、PNG在本目录与attempts/中。", "",
             "```sh", "python3 artifacts/inloop/opt-2/round-3/summarize_numbers.py", "```", ""]
    (HERE / "SUMMARY.md").write_text("\n".join(text))
    table = ["# 第3轮逐球表", "", "None/unknown表示未发生或严格证据不足，不能当0。首见沿用冻结时间线的一对一、未封顶原始视觉对应；不把封顶方位线索当作定位证据。相机首见、WM接受首见与WM确认的完整归因见opt2_report.json及下方补充说明。", "",
             "| 布局/球 | 位置 / 标定属性 / 来源 | 首见→确认→抓取→送达(s) | WM误差cm | grab尝试 | observe / 图像bytes |",
             "|---|---|---|---|---|---|"]
    for row in rows:
        for b in row["balls"]:
            assoc = b["WM_truth_association"].get("evidence") or {}
            label = assoc.get("position_label", "无对应真球")
            values = [b[k] for k in ("first_seen_seconds", "confirmed_seconds", "grabbed_seconds", "delivered_seconds")]
            supplemented = (row["map"] == visibility_supplement["map"]
                            and b["ball_index"] == visibility_supplement["ball_index"])
            if supplemented:
                assert values[0] is None, "Supplement is only for the frozen report's missing field"
                values[0] = visibility_supplement["first_seen_seconds"]
            times = " → ".join(fmt(value) for value in values)
            if supplemented:
                times += "（首见补充）"
            table.append(f"| {row['map']}/{b['ball_index']} | {label} / {assoc.get('calibration', '未评估')} / {b['source']} | {times} | {fmt(assoc.get('distance_cm'))} | {b['grab_attempts']} | {b['observes']} / {b['image_accounting']['combined_image_bytes']} |")
        for slot in row["not_started_ball_slots"]:
            table.append(f"| {row['map']}/{slot} | 未开始 | 未发生 | 未发生 | 0 | 0 / 0 |")
    table += ["", f"map-02球2首见补充：{fmt(visibility_supplement['first_seen_seconds'])}s，raw.lines零基L{visibility_supplement['first_seen_line']}/tick={visibility_supplement['first_seen_tick']}；首次WM实际入库{fmt(visibility_supplement['first_WM_accepted_seconds'])}s，观察L{visibility_supplement['first_WM_accepted_observe_line']}、hit1快照L{visibility_supplement['first_WM_accepted_line']}。该首次入库帧含多个可对应D的红色读数，按冻结的一对一时间线规则存在歧义，故早于严格首见。",
              f"全局最早封顶方位候选{fmt(visibility_supplement['earliest_global_raw_candidate']['seconds'])}s；第二球分段最早封顶候选{fmt(visibility_supplement['earliest_ball2_raw_candidate']['seconds'])}s。旧时间线只枚举实际抓取/送达的物体，漏列未抓到的D；opt2_report.json原None及SHA保留，表内补充由保存的原始帧和真值离线复算，未运行仿真或修改判定门槛。详见 [WM诊断](final-wm-diagnosis/REPORT.md) 和 [补充JSON](final-wm-diagnosis/diagnosis.json)；输入SHA收录在numeric_evidence.json。", "",
              "| 布局/球 | 确认末点→抓取：全道路里程 / 直线cm / 二者比 | 其中follow/take_exit cm / 与直线比 | 真值前向 / 侧向cm | 接近前视线 / 实际抓取视线与接近夹角° |",
              "|---|---|---|---|---|"]
    for row in rows:
        for b in row["balls"]:
            table.append(f"| {row['map']}/{b['ball_index']} | {fmt(b['confirm_to_grab_total_odometer_cm'])} / {fmt(b['confirm_to_grab_straight_cm'])} / {fmt(b['total_odometer_straight_ratio'])} | {fmt(b['confirm_to_grab_road_controls_cm'])} / {fmt(b['road_controls_straight_ratio'])} | {fmt(b['grab_truth_forward_cm'])} / {fmt(b['grab_truth_right_cm'])} | {fmt(b['pre_approach_sight_angle_deg'])} / {fmt(b['actual_grab_sight_vs_approach_deg'])} |")
    table += ["", "全道路里程取原生odometry距离差，含fine及倒退等运动；本轮全程onRoad审计通过。另列只累计follow_road/take_exit的子项，该子项与直线比可能小于1，不能把它误称全部道路里程。未抓到球时确认到抓取的距离无终点，另在失败诊断报告到停止的距离，不能混写。", ""]
    (HERE / "BALL_TABLE.md").write_text("\n".join(table))
    print(json.dumps({k: stats[k] for k in ("all_gates_pass", "layout_success", "independent_success", "successful_seconds", "confirmed_tracks", "confirmed_and_grabbed_balls", "confirmed_grabbed_delivered_balls", "observe_total", "observe_max", "combined_bytes_max", "native_frames_total", "demo_frames_total", "samples_total", "failure_groups")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
