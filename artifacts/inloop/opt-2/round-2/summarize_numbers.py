"""Reproduce the round-2 handoff using preserved files only; no simulator/tools execution."""
import base64
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
INPUTS = {}


def read_bytes(path):
    path = Path(path).resolve()
    payload = path.read_bytes()
    INPUTS[str(path)] = {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
    return payload


def read_json(path):
    return json.loads(read_bytes(path))


def sha(payload):
    return hashlib.sha256(payload).hexdigest()


def resolve(owner, path):
    path = Path(path)
    return path if path.is_absolute() else Path(owner).parent / path


def main():
    automatic = HERE / "AUTO_SUMMARY.md"
    if not automatic.exists():
        automatic.write_bytes((HERE / "SUMMARY.md").read_bytes())
    read_bytes(automatic)
    report = read_json(HERE / "opt2_report.json")
    preflight = read_json(HERE / "preflight.json")
    manifest = read_json(HERE / "code_manifest.json")
    freeze = read_json(HERE / "freeze_verification.json")
    index = read_json(HERE / "frozen_sources/INDEX.json")
    progress = read_json(HERE / "progress.json")
    python_test_text = read_bytes(HERE / "tests.txt").decode()
    node_test_text = read_bytes(HERE / "driver_tests.txt").decode()
    pylint_text = read_bytes(HERE / "pylint.txt").decode()
    tests = {"python_passed": int(re.search(r"(\d+) passed", python_test_text)[1]),
             "node_passed": int(re.search(r"pass (\d+)", node_test_text)[1]),
             "node_failed": int(re.search(r"fail (\d+)", node_test_text)[1]),
             "pylint_error_codes": re.findall(r"\bE(?:1123|1120|1121|0633|0602)\b", pylint_text),
             "pylint_zero_errors": preflight["checks"]["pylint_zero_errors"]}
    frozen_archives = {}
    for original, item in index.items():
        payload = read_bytes(HERE / item["archive"])
        frozen_archives[original] = {"archive": item["archive"],
            "matches_manifest": sha(payload) == item["sha256"] == manifest[original],
            "bytes_match_index": len(payload) == item["bytes"]}
    previous_path = Path(report["regression_audit"]["previous_report"])
    previous = read_json(previous_path)
    assert INPUTS[str(previous_path)]["sha256"] == report["regression_audit"]["previous_report_sha256"]
    runs = []
    for raw_path in sorted(HERE.glob("map-??.json")):
        raw = read_json(raw_path)
        record_path = resolve(raw_path, raw["fullRecordFile"])
        record = read_json(record_path)
        vision_path = resolve(raw_path, raw["visionEvidenceFile"])
        vision = read_json(vision_path)
        samples = read_json(resolve(raw_path, raw["samplesFile"]))
        terminal_bytes = read_bytes(raw_path.with_suffix(".partial.txt"))
        evaluated = next(run for run in report["runs"] if run["map"] == raw_path.stem)
        audit = evaluated["gate_details"]["native_record_evidence_binding"]["evidence"]
        preserved_audit_files = {}
        for filename, expected in audit["files"].items():
            payload = read_bytes(filename)
            preserved_audit_files[filename] = sha(payload) == expected["sha256"] and len(payload) == expected["bytes"]
        png_bindings = []
        for frame in vision["frames"]:
            native = next(f for f in record["visionFrames"] if f["evidenceId"] == frame["evidenceId"])
            truth = next(f for f in vision["renderTruth"]["frames"] if f["evidenceId"] == frame["evidenceId"])
            image_path = resolve(vision_path, frame["image"])
            payload = read_bytes(image_path)
            png_bindings.append({"image": str(image_path), "frame_id": frame["frameId"],
                "evidence_id": frame["evidenceId"], "tick": frame["tick"], "bytes": len(payload), "sha256": sha(payload),
                "native_bytes_exact": payload == base64.b64decode(native["pngBase64"], validate=True),
                "hashes_match": sha(payload) == frame["sha256"] == frame["exportedSha256"] == native["sha256"] == truth["imageSha256"],
                "exact_truth": truth["sameTickAndRevision"] is True and truth["exactRenderState"] is True
                    and truth["captureTick"] == truth["evidenceTick"] == frame["tick"] == native["tick"]
                    and truth["captureStateRevision"] == truth["evidenceStateRevision"] == frame["stateRevision"]})
        terminal = raw["hostIO"]["terminal"]["finalVerification"]
        final_native = raw["hostIO"]["finalNativeVerification"]
        queries = [item for item in record["inputs"] if item["type"] == "vision_query"]
        errors = [{"event_index": i, **item} for i, item in enumerate(record["events"]) if item["type"] == "program_error"]
        observes = [{"line_index": i, **item} for i, item in enumerate(raw["lines"]) if item.get("event") == "observe"]
        checks = {"frozen_native_audit_pass": audit["all_pass"],
            "audited_files_unchanged": all(preserved_audit_files.values()),
            "full_record_hash": INPUTS[str(record_path)]["sha256"] == raw["fullRecordExport"]["sha256"],
            "native_samples_exact": samples == record["samples"],
            "native_queries_exact": queries == vision["queries"],
            "png_and_exact_truth": all(p["native_bytes_exact"] and p["hashes_match"] and p["exact_truth"] for p in png_bindings),
            "terminal_final_pass": terminal["allPass"] is True and terminal["finalFullReadAvailable"] is True,
            "terminal_disk_exact": len(terminal_bytes) == terminal["bytes"] and sha(terminal_bytes) == terminal["sha256"],
            "native_final_pass": final_native["allPass"] is True
                and final_native["frames"] == len(record["visionFrames"])
                and final_native["queries"] == len(queries)
                and final_native["pngBytes"] == sum(p["bytes"] for p in png_bindings)}
        runs.append({"map": raw_path.stem, "raw_path": str(raw_path), "raw_sha256": INPUTS[str(raw_path)]["sha256"],
            "record_path": str(record_path), "program_errors": errors,
            "program_error_count": len(errors), "simulation_end_tick": record["simulationEndTick"],
            "simulation_seconds": record["result"]["durationSeconds"], "result_reason": record["result"]["reason"],
            "native_run_finished": [e for e in record["events"] if e["type"] == "run_finished"],
            "wall_seconds": raw["wallSeconds"], "timed_out": raw["timedOut"], "stall_reason": raw["stallReason"],
            "observes": observes, "observe_count": len(observes), "native_queries": len(queries),
            "png_bindings": png_bindings, "png_count": len(png_bindings), "png_bytes": sum(p["bytes"] for p in png_bindings),
            "samples": len(samples), "navigation_control_inputs": sum(i["type"] == "navigation_control" for i in record["inputs"]),
            "motion_control_inputs": sum(i["type"] == "control" for i in record["inputs"]),
            "grab_attempts": sum(e.get("interactionType") == "package_grab" for e in record["events"]),
            "accepted_grabs": sum(e["type"] == "package_grabbed" and e.get("accepted") is True for e in record["events"]),
            "deliveries": sum(e["type"] == "package_delivered" for e in record["events"]),
            "confirmed_tracks": len(evaluated["first_confirmed_tracks"]),
            "selection_events": sum(e.get("event") == "target_selection" for e in raw["lines"]),
            "target_trace_available": evaluated["target_trace"]["has_target_trace"],
            "second_ball_started": any(e.get("event") == "ball_start" and e["ball_index"] == 2 for e in raw["lines"]),
            "physical_two_deliveries": evaluated["physical_two_deliveries"],
            "success_keyframe_count": raw["demoEvidence"]["frames"],
            "host_io_final": {"terminal": terminal, "native": final_native},
            "evidence_checks": checks, "evidence_all_pass": all(checks.values()),
            "preserved_audit_files": preserved_audit_files})
    prior_successes = []
    for old in previous["runs"]:
        if not old["physical_two_deliveries"]:
            continue
        current = next(run for run in runs if run["map"] == old["map"])
        prior_successes.append({"map": old["map"], "previous_simulation_seconds": old["budgets"]["simulation_seconds"],
            "previous_physical_two_deliveries": True, "current_physical_two_deliveries": current["physical_two_deliveries"],
            "current_error": current["program_errors"], "regression": not current["physical_two_deliveries"]})
    totals = {"layouts": len(runs), "program_error_layouts": sum(bool(r["program_errors"]) for r in runs),
        "program_error_events": sum(r["program_error_count"] for r in runs),
        "startup_error_types": sorted({e["message"] for r in runs for e in r["program_errors"]}),
        "dual_delivery_layouts": sum(r["physical_two_deliveries"] for r in runs),
        "observes": sum(r["observe_count"] for r in runs), "png_count": sum(r["png_count"] for r in runs),
        "png_bytes": sum(r["png_bytes"] for r in runs), "samples": sum(r["samples"] for r in runs),
        "grab_attempts": sum(r["grab_attempts"] for r in runs), "deliveries": sum(r["deliveries"] for r in runs),
        "target_trace_layouts": sum(r["target_trace_available"] for r in runs),
        "evidence_pass_layouts": sum(r["evidence_all_pass"] for r in runs),
        "frozen_files": len(manifest), "batch_end_frozen_unchanged": sum(v is True for v in freeze.values()),
        "frozen_archive_matches": sum(v["matches_manifest"] and v["bytes_match_index"] for v in frozen_archives.values()),
        "timed_out": sum(r["timed_out"] for r in runs), "stalled": sum(r["stall_reason"] is not None for r in runs)}
    output = {"schema": "opt2-round2-numeric-handoff/v1", "simulation_runs_started_by_script": 0,
        "totals": totals, "preflight": tests, "preflight_all_pass": preflight["all_pass"],
        "program_identity": preflight["identity"], "source_file_sha256": preflight["sha256"],
        "frozen_batch_end_verification": freeze, "frozen_archive_verification": frozen_archives,
        "freeze_scope": "batch-end recorded verification plus preserved archive hashes; not a claim that live development files remain unchanged after this batch",
        "frozen_machine_grouping": report["scenarios"], "frozen_independent_success": report["independent_success"],
        "target_scene_success_rate": None,
        "target_scene_rate_reason": "No run has a target-related trace. The ten singleton machine groups do not establish ten independent target scenes.",
        "first_choice_accuracy": report["first_choice_accuracy"],
        "successful_two_delivery_seconds": report["successful_two_delivery_seconds"],
        "unseen_accuracy": report["unseen_accuracy"], "regression_audit": report["regression_audit"],
        "previous_success_regressions": prior_successes, "gates_unchanged": report["gates"],
        "all_gates_pass": report["all_gates_pass"], "batch_status": progress["status"],
        "runs": runs, "input_hashes": INPUTS}
    assert all(sha(Path(name).read_bytes()) == info["sha256"] for name, info in INPUTS.items())
    output["all_inputs_unchanged_during_summary"] = True
    (HERE / "numeric_evidence.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    rows = ["# 阶段 2 · 第 2 轮交付汇总", "",
        f"**本轮 FAIL：{totals['program_error_layouts']}/{totals['layouts']} 局出现 program_error，全部发生在 tick 0 / 仿真 0 秒；双球送达 {totals['dual_delivery_layouts']}/{totals['layouts']}。** 每局在首次 observe 后启动失败，没有进入目标选择、确认、抓取和送达。", "",
        "原始自动汇总原样保存在 [AUTO_SUMMARY.md](AUTO_SUMMARY.md)。冻结门槛和分组机读字段保留在 [opt2_report.json](opt2_report.json)，本说明不重写它们。全部数字与原始索引见 [numeric_evidence.json](numeric_evidence.json)。", "",
        "## 运行前检查与冻结", "",
        f"Python 离线测试 **{tests['python_passed']} passed**，Node 驱动测试 **{tests['node_passed']} passed / {tests['node_failed']} failed**，pylint 指定错误检查 **0 报错**，预检 all_pass={str(preflight['all_pass']).lower()}。这些检查未发现本次运行时启动缺陷，不能替代实际运行结果。", "",
        f"批后冻结核验 **{totals['batch_end_frozen_unchanged']}/{totals['frozen_files']} 文件未变**；本次另核对已封存源码副本 **{totals['frozen_archive_matches']}/{totals['frozen_files']}** 与冻结 SHA/字节数一致。这里指本轮执行期间和封存副本；后续开发目录中的修复不改变本轮历史。", "",
        f"版本 `{preflight['identity']['version']}`；源文件 SHA256 `{preflight['sha256']}`；平台 trim 后执行 SHA256 `{preflight['identity']['file_sha256']}`。WM commit `{preflight['identity']['wm_kit_commit']}`，嵌入包 SHA256 `{preflight['identity']['wm_embed_sha256']}`。", "",
        "## 逐布局原始结果", "",
        "下表的错误原文来自 full record 的 program_error；每局事件索引均为 1、seq=11、t=0 ms，随后 run_finished.reason=program_error。这里的“0 秒”是仿真尚未推进，不代表完成得快。", "",
        "| 布局 | 错误原文 | 错误 tick / 仿真 s | observe / 原生 PNG | PNG bytes | 抓取尝试 / 送达 | 驱动墙钟 s |",
        "|---|---|---:|---:|---:|---:|---:|"]
    for run in runs:
        message = "；".join(e["message"] for e in run["program_errors"])
        rows.append(f"| {run['map']} | {message} | {run['simulation_end_tick']} / {run['simulation_seconds']} | {run['observe_count']} / {run['png_count']} | {run['png_bytes']} | {run['grab_attempts']} / {run['deliveries']} | {run['wall_seconds']:.3f} |")
    rows += ["", "报错所指封存程序第 3761 行为 `run_target_flow()`。该平台提示只提供顶层行号及“名称不存在”，不能据此直接把缺失名称认定为 `run_target_flow`；具体启动根因由独立修复分析确认。", "",
        f"共 {totals['observes']} 次 observe、{totals['png_count']} 张原生 PNG、{totals['png_bytes']:,} 字节图像、{totals['samples']} 条 native samples。每局仅启动第一球，第二球未开始；没有确认轨迹或实际抓取，真值前/侧向、抓取视线夹角、确认后行驶距离及 WM 误差均为 **unknown / 未发生**，不能填写为 0。E/G 没有有效确认样本，本轮没有可报告的泛化精度。", "",
        "## 证据完整性与结果边界", "",
        f"证据终检 **{totals['evidence_pass_layouts']}/{totals['layouts']} 通过**：完整 record、samples、query/frame/PNG 原始字节与精确 render truth 绑定、原始程序 SHA 均通过冻结审计，审计所引用文件本次逐项复查未变；hostIO 的 terminal.finalVerification 与 finalNativeVerification 均为 true，终端磁盘字节数和 SHA 另行重算一致。没有抓取/送达成功事件，因此成功关键帧需求和实际张数均为 0。证据齐全记录的是失败过程，不使任务通过。", "",
        f"驱动 timedOut={totals['timed_out']}/{totals['layouts']}、stallReason 非空={totals['stalled']}/{totals['layouts']}。十局都是平台明确的 program_error 结束，不是墙钟期限或驱动停止造成。由于仅运行到 tick 0，本轮不能用来证明增量日志优化在长局中的性能收益，也不能验证道路提速或抓取角扫优化的实战效果。", "",
        f"冻结分组算法保留了 {len(report['scenarios'])} 个 singleton 条目，但 **{totals['target_trace_layouts']}/{totals['layouts']} 局有可分组的目标相关轨迹**。因此不能声称覆盖了 {len(report['scenarios'])} 个独立目标场景；本轮暴露的是 **{len(totals['startup_error_types'])} 种共同启动失败类型**。实际目标场景成功比例不可估计（null）。机读 independent_success 字段原样保留，不据此调整门槛或重新分组。", "",
        f"P3 首选：已评估 {report['first_choice_accuracy']['evaluated']} 局，匹配 {report['first_choice_accuracy']['matches']}/{report['first_choice_accuracy']['total']}（未知不作匹配）；没有成功双球局，耗时中位数为 null，不能写为 0 秒。确认/道路/抓取相关的“未违规”门没有实际闭环执行覆盖。", "",
        "## 上一轮成功回归", "",
        "| 布局 | 上一轮双球结果 / 仿真 s | 本轮结果 | 回归 |", "|---|---|---|---|"]
    for prior in prior_successes:
        rows.append(f"| {prior['map']} | 成功 / {prior['previous_simulation_seconds']} | tick 0 program_error，双球失败 | 是 |")
    rows += ["", f"上一轮 {len(prior_successes)} 条双球成功回归均失败；没有豁免或从分母中排除这些启动错误。原始门仍为 FAIL。", "",
        "复算本文件和所有数字（不运行仿真、不调用旧轮报告生成器）：", "",
        "```sh", "PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/round-2/summarize_numbers.py", "```", ""]
    (HERE / "SUMMARY.md").write_text("\n".join(rows))
    print(json.dumps({"totals": totals, "preflight": tests, "all_inputs_unchanged": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
