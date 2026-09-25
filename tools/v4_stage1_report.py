#!/usr/bin/env python3
"""Render the stage-1 report only from saved evaluator output; never tune gates."""
import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = "wm-v4-stage1-restoration-report/v2"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    directory, output = Path(args.input).resolve(), Path(args.out).resolve()
    if output.exists():
        raise SystemExit("Refusing to overwrite an existing report")
    data = json.loads((directory / "acceptance.json").read_text())
    audit = data["contentAudit"]
    trials, runs = data["trials"], audit["runs"]
    relative = directory.relative_to(output.parent).as_posix()
    verdict = "PASS" if data["allPass"] else "FAIL / STOP"
    rows = [row for run in runs for row in run["rows"]]
    failures_by_level = {
        "观测": [failure for row in rows for failure in row["failures"]],
        "单局": [failure for run in runs for failure in run["failures"]],
        "套件": audit["failures"],
        "配对": [failure for pair in audit["comparisons"] for failure in pair["failures"]],
    }
    all_failures = [failure for group in failures_by_level.values() for failure in group]
    content_codes = {"CAPTURE_SCHEMA", "RAW_PROJECTION", "BRIDGE_CONTENT_MISMATCH", "CANONICAL_CONTENT_MISMATCH",
                     "NO_OBSERVATIONS", "DUPLICATE_CAPTURE_REQUEST", "DUPLICATE_CAPTURE_FRAME", "RECORD_CALLS_MISSING",
                     "HTTP_TRANSCRIPT_MISSING", "RECORD_OBSERVE_COVERAGE", "HTTP_OBSERVE_COVERAGE",
                     "RECORD_CAPTURE_BINDING", "HTTP_CAPTURE_BINDING", "OBSERVE_TICK_BINDING", "ZERO_CLASS_OUTPUT"}
    content_failures = sum(failure["code"] in content_codes for failure in all_failures)
    truth_schema_failures = sum(failure["code"] == "TRUTH_SCHEMA" for failure in all_failures)
    phase_failures = sum(failure["code"].startswith("C-ENV-001") or failure["code"] in {"CHECKPOINT_SCHEMA", "PAIR_OBSERVATION_COUNT"}
                         or (failure["code"] == "PAIRED_CAPTURE_MISMATCH" and failure.get("field") in
                             {"checkpointSignals", "simulationStepMs", "simulationElapsedMs", "tick"})
                         for failure in all_failures)
    pixel_binding_failures = sum(failure["code"] in {"PAIR_OBSERVATION_COUNT", "PAIRED_RGBA_MISMATCH"}
                                 or (failure["code"] == "PAIRED_CAPTURE_MISMATCH" and failure.get("field") in
                                     {"requestId", "frameId", "tick"}) for failure in all_failures)
    suite_structure_failures = sum(failure["code"] in {"REQUIRES_THREE_LAYOUTS_TWO_RUNS", "REPORT_DIRECTORY_NOT_RELATIVE"}
                                  for failure in all_failures)
    execution_failures = sum(bool(trial.get(key)) for trial in trials
                             for key in ("error", "stopError", "evidenceError", "controllerErrors", "pageErrors"))
    execution_complete = (data["status"] == "complete" and len(trials) == len(data["maps"]) * data["runsPerMap"]
                          and not execution_failures and not suite_structure_failures)
    record_pairs = sum(row["equalEveryField"] for row in data["comparisons"])
    pixel_pairs = sum(row["rgbaSha256Equal"] for pair in audit["comparisons"] for row in pair["rows"])
    pixel_total = sum(len(pair["rows"]) for pair in audit["comparisons"])
    phase_pairs = sum(row["checkpointSignalsEqual"] for pair in audit["comparisons"] for row in pair["rows"])
    phase_formula_pass = sum(row.get("checkpoint", {}).get("allPass", False) for row in rows)
    rejected = []
    for trial in trials:
        record = json.loads((directory / trial["directory"] / "record.json").read_text())
        rejected.extend(event for event in record["bridgeCalls"] if event["type"] == "rejected")
    denied_ok = sum(row.get("code") == "METHOD_NOT_ALLOWED" for row in rejected)
    b_misses = sum(value["misses"] for value in audit["truthCounts"].values())
    exclusions = Counter(entry["excluded_with_reason"] for row in rows
                         for entry in (row.get("projection") or {}).get("exclusions", []))
    lines = [f"# v4 阶段 1 恢复验收：{verdict}", "",
             f"报告版本 `{VERSION}`；所有数值来自保存日志。正式运行目录：`{directory.relative_to(ROOT)}`。", "",
             "此前 acceptance-01 的「record 确定性」和「经桥 observe」通过结论已作废，本轮没有沿用。旧文件原样保留，状态见上级目录的 `ACCEPTANCE_STATUS.json`。", "",
             "平台已修复为放行并保留 `virtual-cv`；绿色地面原生来源为 `storage-ground-pixels`，未改标为 `yolo`。平台版本 `robot-backend-v4-stage1-r2`。", "",
             "## 门禁结果", "",
             "| 项目 | 本轮证据 | 结论 |", "|---|---|---|",
             f"| 运行完整性 | 状态 {data['status']}；{len(trials)} 局；执行错误项 {execution_failures}；套件结构错误 {suite_structure_failures} | {'PASS' if execution_complete else 'FAIL'} |",
             f"| a 内容一致性（按公开类别/相机坐标转换后） | {len(rows)} 次 observe；内容/绑定/帧格式失败 {content_failures}；四类检测数见下 | {'PASS' if content_failures == 0 and all(audit['outputCounts'].values()) else 'FAIL'} |",
             f"| b 应见必见 | 漏检 {b_misses} 次；真值证据格式失败 {truth_schema_failures}；不排除遮挡或按实例另设门槛 | {'PASS' if b_misses == 0 and truth_schema_failures == 0 else 'FAIL'} |",
             f"| c record | {record_pairs}/{len(data['comparisons'])} 布局对逐字段相同 | {'PASS' if record_pairs == len(data['comparisons']) == 3 else 'FAIL'} |",
             f"| c 相机 RGBA8 | {pixel_pairs}/{pixel_total} 对应观测帧像素 SHA256 相同；配对/绑定失败 {pixel_binding_failures} | {'PASS' if pixel_pairs == pixel_total and pixel_total and pixel_binding_failures == 0 else 'FAIL'} |",
             f"| C-ENV-001 | 实际动画配对 {phase_pairs}/{pixel_total} 相同；逐帧公式复算 {phase_formula_pass}/{len(rows)} 通过；各级相位/时钟证据失败 {phase_failures} | {'PASS' if pixel_total and phase_pairs == pixel_total and phase_formula_pass == len(rows) and phase_failures == 0 else 'FAIL'} |",
             f"| d 白名单 | {denied_ok}/{len(rejected)} 个负向调用拒绝码为 METHOD_NOT_ALLOWED；各局 record 审计保留 | {'PASS' if denied_ok == len(rejected) == len(trials) * len(data['manifest']['rejectedMethods']) and all(t['recordAudit']['allPass'] for t in trials) else 'FAIL'} |", "",
             "没有放宽任何门限或删除失败帧。" + ("阶段 1 未通过，阶段 2 保持停止。" if not data["allPass"] else "阶段 1 门禁通过。"), "",
             "各级失败按日志条目统计，同一观测可能产生多个失败条目；b 与 C-ENV 错误不归入 a 的内容不一致。", "",
             "| 日志层级 | 失败代码（配对字段） | 条数 |", "|---|---|---:|"]
    for level, group in failures_by_level.items():
        counts = Counter(failure["code"] + (f" ({failure['field']})" if "field" in failure else "") for failure in group)
        if not counts:
            lines.append(f"| {level} | 无 | 0 |")
        for code, count in sorted(counts.items()):
            lines.append(f"| {level} | `{code}` | {count} |")
    lines += ["", "## 按类别统计", "", "检测条数按每帧原样输出累加，不代表不同物体的数量。", "",
             "| 类别 | 桥检测条数 | 应见次数 | 检出次数 | 漏检次数 |", "|---|---:|---:|---:|---:|"]
    for category, count in audit["outputCounts"].items():
        truth = audit["truthCounts"].get(category)
        values = [truth[key] for key in ("expected", "detected", "misses")] if truth else ["不适用"] * 3
        lines.append(f"| {category} | {count} | {' | '.join(map(str, values))} |")
    lines += ["", "应见条件：相机原点的平面距离 30–85cm（含边界），水平 |方位|≤30°；只由评测真值计算。检出按同帧是否出现对应类别，不宣称实例召回。", "",
              "| 布局/运行 | 观测帧 | 红球/蓝球/障碍/存放区检测条数 | 红球检出/应见 | 蓝球检出/应见 | 障碍检出/应见 |", "|---|---:|---|---|---|---|"]
    for run in runs:
        counts = "/".join(str(run["outputCounts"][category]) for category in audit["outputCounts"])
        truth = [f"{run['truthCounts'][category]['detected']}/{run['truthCounts'][category]['expected']}"
                 for category in ("red-ball", "blue-ball", "obstacle")]
        lines.append(f"| {run['map']} / {run['run']} | {run['observations']} | {counts} | {' | '.join(truth)} |")
    lines += ["", "## 相位与内容检查说明", "",
              "相机渲染入口快照按 `tick × stepMs / 1000` 对每个 checkpoint 的相位、旋转、透明度和高度精确复算；未设置浮点容差。若有末位差异，本轮仍保留 FAIL，不能把差异自动归因于墙钟，也不能据此静默放宽门禁。独立时钟测试另覆盖同 tick 不同墙钟、tick 推进、相机采帧禁止墙钟读取。", ""]
    diagnostic_file = directory.parent / "checkpoint-diagnostic.json"
    if diagnostic_file.exists():
        diagnostic = json.loads(diagnostic_file.read_text())
        scope = diagnostic["scope"]
        if scope["suite"] == directory.name:
            for evidence in diagnostic["inputs"].values():
                if hashlib.sha256((ROOT / evidence["path"]).read_bytes()).hexdigest() != evidence["sha256"]:
                    raise SystemExit("Checkpoint diagnostic input SHA256 mismatch")
            counts, fields = diagnostic["counts"], diagnostic["fieldStatistics"]
            maximum_ulp = max(value["maxUlpDistance"] for value in fields.values())
            aligned_fields = sum(fields[field]["mismatches"] for field in ("phase", "ringRotationZ", "coreRotationY"))
            lines += [f"[浮点诊断](checkpoint-diagnostic.json) 仅分析 `{scope['map']} / run-{scope['run']}`："
                      f"{counts['observations']} 帧中 {counts['mismatchingFrames']} 帧有差异，"
                      f"涉及 {counts['mismatchingSignals']} 个信号、{counts['fieldMismatches']} 个字段；"
                      f"字段最大差异 {maximum_ulp} ULP。相位常量与两项线性旋转差异合计 {aligned_fields}，"
                      f"elapsed 时间差异 {counts['elapsedTimeDifferences']}。"
                      "这些证据符合跨运行时浮点计算差异的特征；日志缺少浏览器原始 Math.sin 输入输出等信息，"
                      "尚不能确证具体根因，也不能推断其他五局具有相同原因。该诊断不改变严格门禁结果。", ""]
    lines += [
              "外观类别与坐标的固定转换及旧标牌排除口径见 `docs/V4_STAGE1_ACCEPTANCE_RULES.md`。评测器独立复算原始检测，不把桥自己的输出当预期值。排除计数（全部逐项留存，不是漏检豁免）：", ""]
    for reason, count in sorted(exclusions.items()):
        lines.append(f"- `{reason}`：{count} 条。")
    lines += ["", "## 版本、日志与复算", "",
              "平台提交：`0e30478`（检测适配）与 `54b36f8`（C-ENV-001 测试）。",
              "平台分支：[v4/robot-backend](https://github.com/54dK3n/wm_bench/tree/v4/robot-backend)。",
              "评测分支：[v4/autonomous-observation](https://github.com/54dK3n/wm_bench/tree/v4/autonomous-observation)。", "",
              f"- [正式总表]({relative}/acceptance.json)", f"- [内容、应见与相位逐帧判定]({relative}/content-audit.json)",
              f"- [冻结源码 SHA256]({relative}/manifest.json)", f"- [离线复算结果]({relative}/recomputed.json)",
              f"- [原始 PNG 独立解码后的 RGBA 哈希核对]({relative}/pixel-verification.json)",
              "- [交付文件 SHA256](delivery-manifest.json)",
              "- [平台完整测试（含 HTTP）](platform-full-unit-tests.txt) / [平台专项离线测试](platform-unit-tests.txt) / [评测器测试](evaluator-unit-tests.txt)", "",
              "每局目录包含 record、samples、captures（原始检测、桥结果、相机矩阵、真值、RGBA 哈希、动画字段）、HTTP 往返、原生 PNG 索引与评测结果。PNG 原字节也在 record 内，独立 frames PNG 不重复上传。", "",
              "```sh", f"node tools/v4_stage1_recompute.js --input {directory.relative_to(ROOT)} --out /tmp/v4-stage1-check.json", "```", "",
              "从 record 中的原始 PNG 独立解码并核对 RGBA 哈希：", "", "```sh",
              f"python3 tools/v4_stage1_verify_pixels.py --input {directory.relative_to(ROOT)} --out /tmp/v4-stage1-pixels.json", "```", "",
              "恢复某局原始 PNG（逐文件校验原始 SHA256）：", "", "```sh",
              f"python3 tools/v4_stage1_extract_frames.py --record {directory.relative_to(ROOT)}/map-05-run-1/record.json --out /tmp/v4-stage1-frames", "```", "",
              "`contentExact`、`comparisonsExact`、`executionExact` 与 `matchesOriginalVerdict` 为 true 表示忠实复算，验收是否通过看 `allPass`。复算包括原 driver 的执行状态、试验数量、各局执行错误、重新配对的 record 与源码未变门禁；原运行错误及源码未变状态来自保存日志，离线复算不重新运行仿真。", "",
              "短程联调单独保留为 preflight-smoke-02；preflight-smoke-01 因沙箱禁止监听端口，未启动仿真。联调不充当六局验收。早先独立 HTTP 单测重跑曾被中断，本轮现已补齐完整测试；d 的正式六局 HTTP 拒绝记录仍单独报告。", ""]
    test_log = (directory.parent / "platform-full-unit-tests.txt").read_text()
    totals = {name: int(re.findall(rf"^(?:#|ℹ)\s+{name}\s+(\d+)\s*$", test_log, re.MULTILINE)[-1])
              for name in ("tests", "pass", "fail")}
    lines += [f"平台完整单测日志：{totals['pass']}/{totals['tests']} 通过，{totals['fail']} 失败。", ""]
    output.write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"report": output.relative_to(ROOT).as_posix(), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "verdict": verdict}))


if __name__ == "__main__":
    main()
