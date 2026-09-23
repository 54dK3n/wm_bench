#!/usr/bin/env python3
"""Reproduce the numerical cover sheet from the frozen round report and records."""
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def read(name):
    return json.loads((HERE / name).read_text())


def main():
    report = read("opt2_report.json")
    progress = read("progress.json")
    identity = read("identity.json")
    runs = report["runs"]
    balls = [b for r in runs for b in r["balls"]]
    grabbed = [b for b in balls if b["confirmed_and_grabbed"]]
    stats = {
        "layouts": len(runs), "executions": len(progress["completed"]),
        "independent_scenes": len(report["scenarios"]),
        "dual_delivery_layouts": report["layout_success"],
        "dual_delivery_scenes": report["independent_success"],
        "optimal_first_choice_layouts": report["first_choice_accuracy"],
        "optimal_first_choice_scenes": report["independent_first_choice_accuracy"],
        "successful_simulation_seconds": report["successful_two_delivery_seconds"],
        "confirmed_and_grabbed_balls": len(grabbed),
        "confirmed_grabbed_delivered_balls": sum(b["confirmed_grabbed_and_delivered"] for b in balls),
        "first_ball_capture_layouts": sum(any(b["ball_index"] == 1 and b["confirmed_and_grabbed"] for b in r["balls"]) for r in runs),
        "observes_total": sum(r["budgets"]["observes"] for r in runs),
        "observes_max": max(r["budgets"]["observes"] for r in runs),
        "combined_image_bytes_max": max(r["budgets"]["combined_image_bytes"] for r in runs),
        "program_errors": sum(len(r["gate_details"]["program_errors_zero"]["evidence"]) for r in runs),
        "phantom_confirmations": sum(len(r["phantom_confirmations"]) for r in runs),
        "stationary_observes": sum(len(r["gate_details"]["no_stationary_observe_or_guard_violation"]["evidence"]["repeats"]) for r in runs),
        "guard_violations": sum(len(r["gate_details"]["no_stationary_observe_or_guard_violation"]["evidence"]["guard_violations"]) for r in runs),
        "approach_calls_max_per_ball": max(b["approach_calls"] for b in balls),
        "frozen_files": len(report["freeze_verification"]),
        "regressions": report["regression_audit"]["regressions"],
        "report_sha256": hashlib.sha256((HERE / "opt2_report.json").read_bytes()).hexdigest(),
    }
    record_counts = []
    for run in runs:
        record = json.loads(Path(run["full_record_file"]).read_text())
        record_counts.append({"map": run["map"], "samples": len(record.get("samples", [])),
                              "events": len(record.get("events", [])),
                              "raw_log": run["map"] + ".partial.txt",
                              "ending": run["flow_end"]})
    stats["records"] = record_counts
    (HERE / "numeric_evidence.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2) + "\n")
    lines = ["# 阶段 2 第 1 轮：FAIL", "",
             "完整十布局已执行完毕，每个布局仅执行一次。未进入阶段 3。", "",
             "本页由 `python3 artifacts/inloop/opt-2/round-1/summarize_numbers.py` 生成。",
             "所有门槛、逐球审计及原始日志行号见 [opt2_report.json](opt2_report.json)；",
             "逐球完整表见 [AUTO_SUMMARY.md](AUTO_SUMMARY.md)，数值来源索引见 [numeric_evidence.json](numeric_evidence.json)。", "",
             "| 退出条件 | 实测 | 判定与证据 |", "|---|---|---|",
             f"| 双球送达 ≥8/10 | {report['layout_success']['passed']}/10；独立场景 {report['independent_success']['passed']}/{len(report['scenarios'])} | FAIL；`runs[].platform_deliveries`、最终原生送达状态 |",
             f"| P3.4 首选最优 ≥8/10 | {report['first_choice_accuracy']['matches']}/10；独立场景 {report['independent_first_choice_accuracy']['matches']}/{len(report['scenarios'])} | PASS；`runs[].first_choice`（真值仅在 driver 评测中） |",
             f"| 双球成功局用时中位 ≤300s | {report['successful_two_delivery_seconds']['median']:.2f}s，原始值 {report['successful_two_delivery_seconds']['values']} | FAIL；原生最终 tick / 50 |",
             f"| 无回归 | 第一球成功场景回归 {len(stats['regressions'])}；{stats['first_ball_capture_layouts']}/10 抓到第一球 | PASS；`regression_audit`。首次阶段2按阶段1的确认抓取成功比较；送达变化另列，不能称送达无回归。 |",
             f"| 固定规则、安全及预算 | 已抓 {len(grabbed)} 球逐球审计全部通过；approach 最大 {stats['approach_calls_max_per_ball']} 次/球 | PASS；`balls[].fixed_rule_audit`，每球仍需3命中、不同位置、≥15cm间距、末点≥0.5m、纯记忆≥30cm、approach≤0.25m/max_steps=1 |",
             f"| observe ≤92、图像≤20MiB/局 | 最大 {stats['observes_max']} 次、{stats['combined_image_bytes_max']} bytes（含关键帧） | PASS；`runs[].budgets` |",
             f"| 程序报错 / 原地重复 / guard违规 / 幻影CONFIRMED | {stats['program_errors']} / {stats['stationary_observes']} / {stats['guard_violations']} / {stats['phantom_confirmations']} | PASS；`runs[].gate_details`、`first_confirmed_tracks` |",
             "| 证据链完整 | 9/10 冻结证据门通过；map-08 有一次增量导出超时 | FAIL；错误保留，未重跑。最终原生PNG、samples、query逐项绑定均通过，详见 evidence-diagnosis。 |", "",
             "P3.1：冻结的独立原生控制实验包括直行100cm×3及45°/90°/180°各3次；",
             "名义 k=0.060290462706043484 cm/°，最大拟合残差0.4356663%。",
             "既有真实任务118次控制的外部诊断最大残差23.5466%，21/118超过10%，",
             "不能据此声称复杂路况的时间预测也达到10%。原始失败拟合未删除。",
             "来源：[受控标定](../controlled-calibration/calibration.json)、[使用决策与独立场景依据](../constant-evidence/USAGE_DECISION.md)。", "",
             "| 布局 | 双球送达 | 首选最优 | 用时s | observe | 图像bytes | 最终日志证据 |", "|---|---|---|---|---|---|---|"]
    for run in runs:
        ending = run["flow_end"][-1] if run["flow_end"] else {}
        line = ending.get("line_index")
        evidence = f"[{run['map']}.partial.txt:{line}]({run['map']}.partial.txt) tick={ending.get('tick')} {ending.get('stage')}: {ending.get('reason')}"
        lines.append(f"| {run['map']} | {run['passed']} | {run['first_choice'].get('match')} | {run['budgets']['simulation_seconds']} | {run['budgets']['observes']} | {run['budgets']['combined_image_bytes']} | {evidence} |")
    lines += ["", "| 独立场景 | 布局 | 双球送达 |", "|---|---|---|"]
    for scene in report["scenarios"]:
        lines.append(f"| {scene['scenario']} | {' = '.join(scene['members'])} | {scene['passed']} |")
    lines += ["", "合并沿用冻结的完整链接比较与容差，双球轨迹拼接后比较；本轮只有 map-01/map-03 合并。", "",
              "未见位置只报告 E、G："]
    for label, items in report["unseen_accuracy"].items():
        lines.append(f"- {label}：n={len(items)}，" + "；".join(f"{item['map']}/球{item['ball_index']} {item['error_cm']:.4f}cm（确认日志行{item['confirmation_line']}）" for item in items))
    lines += ["", "这些样本不足以作全面泛化结论；其余位置仅逐球报告。", "",
              "程序与证据身份：", "",
              f"- PROGRAM_VERSION：`{identity['version']}`",
              f"- 文件 SHA256：`{hashlib.sha256((HERE / 'program.py').read_bytes()).hexdigest()}`",
              f"- 原生实际执行 sourceCode SHA256：`{identity['file_sha256']}`（executed_program.py，原文件末尾换行被平台去除）",
              f"- wm_kit 提交：`{identity['wm_kit_commit']}`",
              f"- 嵌入包 SHA256：`{identity['wm_embed_sha256']}`",
              f"- {stats['frozen_files']} 项冻结文件在批跑后校验一致；副本见 frozen_sources/INDEX.json。",
              "- 运行前323项测试通过；指定五类 pylint 错误为0（tests.txt、pylint.txt、preflight.json）。",
              "- 无布局坐标/真值/mission target锚点访问，静态检查通过；赛题1未运行。",
              "- 改动与常量依据见 [CHANGES.md](CHANGES.md)、[PRE_RUN_SUMMARY.md](PRE_RUN_SUMMARY.md)。",
              "- 阶段1过滤测试集已污染的披露继续有效；本轮不是新的无污染过滤验证。", ""]
    (HERE / "SUMMARY.md").write_text("\n".join(lines))
    print(json.dumps({k: v for k, v in stats.items() if k != "records"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
