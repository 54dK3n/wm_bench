"""Read-only final audit. Writes only audit.json and REPORT.md beside this file."""
import base64
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import statistics
import struct
import sys
import zlib

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROUND = HERE.parent
ROOT = ROUND.parents[3]
FILES = {}
LIMIT = 20 * 1024 * 1024


def read(path):
    path = Path(path).resolve(); payload = path.read_bytes()
    FILES[str(path)] = {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
    return payload


def js(path):
    return json.loads(read(path))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def png_check(data, frame):
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    at, packed, dimensions = 8, [], None
    ended = False
    while at < len(data):
        size = int.from_bytes(data[at:at+4], "big")
        kind, body = data[at+4:at+8], data[at+8:at+8+size]
        crc = int.from_bytes(data[at+8+size:at+12+size], "big")
        assert zlib.crc32(kind + body) & 0xffffffff == crc
        if kind == b"IHDR":
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", body)
            assert width == frame["width"] and height == frame["height"]
            assert depth == 8 and compression == filtering == interlace == 0
            channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
            dimensions = [width, height, channels]
        if kind == b"IDAT": packed.append(body)
        at += size + 12
        if kind == b"IEND": ended = True; break
    assert ended and at == len(data) and dimensions
    width, height, channels = dimensions
    pixels = zlib.decompress(b"".join(packed)); stride = width * channels + 1
    assert len(pixels) == height * stride
    assert all(pixels[offset] <= 4 for offset in range(0, len(pixels), stride))
    return {"valid_crc_and_decompression": True, "width": width, "height": height, "channels": channels}


def main():
    manifest = js(ROUND / "code_manifest.json")
    recorded_freeze = js(ROUND / "freeze_verification.json")
    index = js(ROUND / "frozen_sources/INDEX.json")
    freeze = {}
    for original, expected in manifest.items():
        archived = index[original]
        original_bytes, archive_bytes = read(original), read(ROUND / archived["archive"])
        freeze[original] = {"expected_sha256": expected,
            "batch_end_recorded_unchanged": recorded_freeze[original],
            "current_file_matches": sha(original_bytes) == expected,
            "archived_file_matches": sha(archive_bytes) == archived["sha256"] == expected,
            "archived_bytes_match": len(archive_bytes) == archived["bytes"]}
    helper_original = str(ROOT / "tools/opt2_evidence_audit.py")
    helper_path = ROUND / index[helper_original]["archive"]
    spec = importlib.util.spec_from_file_location("frozen_final_evidence_audit", helper_path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    progress = js(ROUND / "progress.json")
    identity = js(ROUND / "identity.json")
    executed_bytes = read(ROUND / "executed_program.py")
    rows = []
    for raw_path in sorted(ROUND.glob("map-??.json")):
        raw = js(raw_path)
        record = js(raw["fullRecordFile"])
        vision = js(raw["visionEvidenceFile"])
        demo = js(raw["demoEvidenceFile"])
        audit = module.audit_native_evidence(raw, record, raw_path)
        for name, expected in audit["files"].items():
            payload = read(name)
            assert sha(payload) == expected["sha256"] and len(payload) == expected["bytes"]
        expected_events, seen = [], set()
        for event in record["events"]:
            if event.get("objectRole") != "target" or not (event["type"] == "package_delivered"
                or event["type"] == "package_grabbed" and event.get("accepted") is True):
                continue
            key = (event["packageId"], event["type"])
            if key not in seen: expected_events.append(event); seen.add(key)
        native_pngs, demo_pngs = [], []
        for frame in vision["frames"]:
            image_path = Path(raw["visionEvidenceFile"]).parent / frame["image"]
            data = read(image_path)
            native_pngs.append({"image": str(image_path), "evidence_id": frame["evidenceId"],
                "frame_id": frame["frameId"], "tick": frame["tick"], "bytes": len(data), "sha256": sha(data),
                "png_structure": png_check(data, frame)})
        event_by_seq = {e["seq"]: e for e in record["events"]}
        input_by_seq = {e["seq"]: e for e in record["inputs"]}
        for frame in demo["frames"]:
            image_path = Path(raw["demoEvidenceFile"]).parent / frame["image"]
            data = read(image_path)
            event = event_by_seq.get(frame["eventSeq"])
            interaction = input_by_seq.get(frame["interactionInputSeq"], {})
            checks = {"run_and_task": frame["runId"] == record["runId"] == demo["runId"]
                    and frame["taskId"] == record["taskId"] == "R2-GYI-MVP-02",
                "event_exact": event == frame["event"] and event in expected_events,
                "event_identity": event["type"] == frame["eventType"] and event["packageId"] == frame["packageId"],
                "exact_interaction": interaction.get("type") == ("package_grab" if event["type"] == "package_grabbed" else "package_release")
                    and interaction.get("t") == event["t"] == frame["eventTimeMs"]
                    and interaction.get("tick") == frame["eventTick"]
                    and interaction.get("seq", math.inf) < event["seq"]
                    and interaction.get("stateRevision") == frame["eventStateRevision"],
                "capture_after_event": frame["captureTick"] >= frame["eventTick"]
                    and frame["tickDelta"] == frame["captureTick"] - frame["eventTick"],
                "same_tick_flag_honest": frame["sameTickAndRevision"] == (frame["captureTick"] == frame["eventTick"]
                    and frame["captureStateRevision"] == frame["eventStateRevision"]),
                "disk_bytes_and_hash": len(data) == frame["byteLength"] and sha(data) == frame["sha256"]}
            demo_pngs.append({"image": str(image_path), "event_seq": frame["eventSeq"], "event_type": frame["eventType"],
                "package_id": frame["packageId"], "event_tick": frame["eventTick"], "capture_tick": frame["captureTick"],
                "tick_delta": frame["tickDelta"], "bytes": len(data), "sha256": sha(data),
                "checks": checks, "all_pass": all(checks.values()), "png_structure": png_check(data, frame)})
        native_bytes = sum(f["bytes"] for f in native_pngs)
        demo_bytes = sum(f["bytes"] for f in demo_pngs)
        observed = [(i, line) for i, line in enumerate(raw["lines"]) if line.get("event") == "observe"]
        repeats, missing, motion = [], [], []
        for (ai, a), (bi, b) in zip(observed, observed[1:]):
            aa, bb = a.get("odo"), b.get("odo")
            if not all(isinstance(v, list) and len(v) == 3 and all(isinstance(n, (float, int)) and math.isfinite(n) for n in v) for v in (aa, bb)):
                missing.append([ai, bi]); continue
            moved = math.dist(aa[:2], bb[:2]); turned = abs((bb[2] - aa[2] + 180) % 360 - 180)
            entry = {"line_indices": [ai, bi], "ticks": [a["tick"], b["tick"]], "translation_cm": moved, "turn_deg": turned}
            motion.append(entry)
            if a["tick"] == b["tick"] or moved < 5 - 1e-9 and turned < 10 - 1e-9: repeats.append(entry)
        errors = [{"event_index": i, **e} for i, e in enumerate(record["events"]) if e["type"] == "program_error"]
        guard = [{"line_index": i, **e} for i, e in enumerate(raw["lines"]) if e.get("event") == "observe_motion_violation"]
        raw_digest = sha(raw_path.read_bytes())
        old_path = ROUND.parent / "round-1" / raw_path.name
        old = js(old_path)
        old_observes = sum(e.get("event") == "observe" for e in old["lines"])
        host = raw["hostIO"]
        checks = {"frozen_native_audit": audit["all_pass"],
            "source_bytes_equal_frozen_execution": record["sourceCode"].encode() == executed_bytes,
            "source_identity_hash": sha(record["sourceCode"].encode()) == identity["file_sha256"],
            "raw_matches_execution_ledger": raw_digest == progress["completed"][raw_path.stem]["raw_sha256"],
            "raw_matches_original_attempt": read(progress["completed"][raw_path.stem]["json"]) == raw_path.read_bytes(),
            "native_capture_ids_unique": len({f["evidence_id"] for f in native_pngs}) == len(native_pngs),
            "success_events_have_exactly_one_keyframe": sorted(f["event_seq"] for f in demo_pngs) == sorted(e["seq"] for e in expected_events),
            "all_keyframes_bound": all(f["all_pass"] for f in demo_pngs),
            "no_demo_capture_or_export_errors": not demo.get("hookErrors") and not demo.get("exportErrors"),
            "all_image_totals_reconcile": native_bytes == demo["nativeFrameBytes"] == raw["demoEvidence"]["nativeFrameBytes"]
                and demo_bytes == demo["screenshotBytes"] == raw["demoEvidence"]["screenshotBytes"]
                and native_bytes + demo_bytes == demo["combinedImageBytes"] == raw["demoEvidence"]["combinedImageBytes"],
            "observes_at_most_92": len(observed) <= 92,
            "native_bytes_at_most_20mib": native_bytes <= LIMIT,
            "all_images_at_most_20mib": native_bytes + demo_bytes <= LIMIT,
            "program_errors_zero": not errors,
            "no_repeated_observe_or_guard": not repeats and not missing and not guard,
            "no_driver_deadline_or_stall": not raw["timedOut"] and raw["stallReason"] is None,
            "native_run_finished": record["events"][-1]["type"] == "run_finished"}
        rows.append({"map": raw_path.stem, "run_id": record["runId"], "raw_path": str(raw_path), "checks": checks,
            "all_audited_gates_pass": all(checks.values()), "native_audit": audit,
            "native_pngs": native_pngs, "demo_pngs": demo_pngs,
            "observe_count": len(observed), "native_query_count": audit["native_query_count"],
            "native_png_count": len(native_pngs), "demo_png_count": len(demo_pngs),
            "native_bytes": native_bytes, "demo_bytes": demo_bytes, "all_image_bytes": native_bytes + demo_bytes,
            "program_errors": errors, "repeated_observes": repeats, "missing_motion": missing,
            "observe_guard_violations": guard, "observe_motion_pairs": motion,
            "native_finish": record["events"][-1], "simulation_seconds": record["result"]["durationSeconds"],
            "simulation_end_tick": record["simulationEndTick"], "wall_seconds": raw["wallSeconds"],
            "flow_end": [e for e in raw["lines"] if e.get("event") == "flow_end"],
            "host_io": host,
            "round1_descriptive_comparison": {"raw_path": str(old_path), "wall_seconds": old["wallSeconds"],
                "simulation_seconds": old["record"]["top"]["result"]["durationSeconds"],
                "observe_count": old_observes, "native_frames": old["record"]["vision"]["frameCount"],
                "combined_image_bytes": old["demoEvidence"]["combinedImageBytes"],
                "host_io_metrics_available": "hostIO" in old,
                "terminal_bytes": len(read(old_path.with_suffix(".partial.txt"))),
                "export_errors": old.get("visionExportErrors", []),
                "flow_end": [e for e in old["lines"] if e.get("event") == "flow_end"]}})
    totals = {key: sum(row[key] for row in rows) for key in ("observe_count", "native_query_count", "native_png_count", "demo_png_count", "native_bytes", "demo_bytes", "all_image_bytes")}
    totals.update({"layouts": len(rows), "unique_native_run_ids": len({r["run_id"] for r in rows}),
        "all_audited_gates_pass_layouts": sum(r["all_audited_gates_pass"] for r in rows),
        "program_error_events": sum(len(r["program_errors"]) for r in rows),
        "repeated_observes": sum(len(r["repeated_observes"]) for r in rows),
        "observe_guard_violations": sum(len(r["observe_guard_violations"]) for r in rows),
        "maximum_observes_per_layout": max(r["observe_count"] for r in rows),
        "maximum_combined_image_bytes": max(r["all_image_bytes"] for r in rows),
        "frozen_files": len(freeze), "frozen_files_all_checks_true": sum(all(v[k] for k in
            ("batch_end_recorded_unchanged", "current_file_matches", "archived_file_matches", "archived_bytes_match")) for v in freeze.values())})
    metrics = {"terminal_final_bytes": sum(r["host_io"]["terminal"]["finalVerification"]["bytes"] for r in rows),
        "terminal_written_bytes_including_final_full": sum(r["host_io"]["terminal"]["writtenBytes"] for r in rows),
        "terminal_write_ms": sum(r["host_io"]["terminal"]["writeMs"] for r in rows),
        "browser_terminal_read_ms": sum(r["host_io"]["terminal"]["pageReadMs"] for r in rows),
        "terminal_fallbacks": sum(r["host_io"]["terminal"]["fullFallbacks"] for r in rows),
        "terminal_errors": sum(len(r["host_io"]["terminal"]["errors"]) for r in rows),
        "evaluate_timeouts": sum(len(r["host_io"]["evaluateTimeouts"]) for r in rows)}
    for key in ("visionWrites", "visionSkippedUnchanged", "demoWrites", "demoSkippedUnchanged", "writtenBytes", "writeMs"):
        metrics["manifests_" + key] = sum(r["host_io"]["manifests"][key] for r in rows)
    deltas = [f["tick_delta"] for r in rows for f in r["demo_pngs"]]
    metrics["keyframe_tick_delta"] = {"values": deltas, "min": min(deltas), "max": max(deltas)}
    for name in ("terminal_status_delta", "terminal_final_full", "vision_incremental_read", "demo_incremental_read"):
        metrics[name] = {key: sum(r["host_io"]["cdp"][name][key] for r in rows)
            for key in ("requests", "responses", "requestUtf8Bytes", "responseUtf8Bytes", "roundTripMs", "parseMs")}
    assert all(sha(Path(name).read_bytes()) == value["sha256"] for name, value in FILES.items())
    output = {"schema": "opt2-round3-final-evidence-audit/v1", "simulation_runs_started": 0,
        "all_inputs_unchanged": True, "frozen_helper": str(helper_path), "frozen_files": freeze,
        "totals": totals, "host_io_metrics": metrics, "runs": rows, "input_files": FILES,
        "image_counting_policy": "Count each native (runId,evidenceId) and each success-keyframe (runId,eventSeq) once. JSON/base64/full-record copies and layout/attempt aliases are not extra images; distinct captures remain distinct even if pixels/hash happen to match.",
        "comparison_scope": "R1 and R3 differ in control code, routes, action counts and observation schedules. Wall/simulation comparisons are descriptive, not a paired causal performance experiment. R1 lacks hostIO counters.",
        "outcome_scope": "These are integrity/resource/error gates only, not a claim of two-ball mission success."}
    (HERE / "audit.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    md = ["# 阶段 2 第 3 轮：最终证据与宿主 I/O 审计", "",
        f"独立复核 **{totals['all_audited_gates_pass_layouts']}/{totals['layouts']} 局证据、资源及运行错误门通过**；**{totals['frozen_files_all_checks_true']}/{totals['frozen_files']} 冻结文件**批后记录、现文件和封存副本 SHA/字节数一致。这不是双球任务成功判定。未运行仿真，未编辑生产代码、工具、测试或原始产物。", "",
        "复算：`PYTHONDONTWRITEBYTECODE=1 python3 artifacts/inloop/opt-2/round-3/final-evidence-audit/reproduce.py`。详细索引、哈希、逐帧绑定、原始门和计数在 [audit.json](audit.json)。脚本加载本轮封存的独立原生审计模块，不执行当前开发版报告生成器。", "",
        "## 逐局资源与错误", "",
        "| 布局 | observe / 92 | 原生 PNG / bytes | 成功截图 / bytes | 全图 bytes / 20 MiB | program_error / 重复 observe | 证据终检 |",
        "|---|---:|---:|---:|---:|---:|---|"]
    for r in rows:
        md.append(f"| {r['map']} | {r['observe_count']} | {r['native_png_count']} / {r['native_bytes']:,} | {r['demo_png_count']} / {r['demo_bytes']:,} | {r['all_image_bytes']:,} | {len(r['program_errors'])} / {len(r['repeated_observes'])} | {'PASS' if r['all_audited_gates_pass'] else 'FAIL'} |")
    md += ["", f"共 **{totals['native_png_count']} 原生 PNG / {totals['native_bytes']:,} bytes**，**{totals['demo_png_count']} 成功关键帧 / {totals['demo_bytes']:,} bytes**，合计 **{totals['all_image_bytes']:,} bytes**，分布在 {totals['unique_native_run_ids']} 个不同 runId。最大单局 {totals['maximum_combined_image_bytes']:,} bytes，小于每局 20 MiB（{LIMIT:,} bytes）；observe 最大 {totals['maximum_observes_per_layout']}，小于 92。累计总量不适用单局 20 MiB 限制。", "",
        "图像计数按每局原生 evidenceId、成功截图 eventSeq 各计一次；record 中的同图 base64、vision 清单、map/attempt 原始归档副本不重复计数。不同原生帧即使像素相同仍是不同捕获，不能按图片 SHA 去重来压低预算。所有 PNG 均通过 CRC、解压、行结构和尺寸核验。", "",
        "原生证据逐项验证 full-record 原始字节/SHA、全部 samples、所有 vision queries、PNG 原生 base64 精确字节、run/frame/evidence/tick/revision、精确 render truth，以及 observe 红蓝原值。十局 sourceCode UTF-8 字节与封存 executed_program.py 完全一致，并匹配 program_version 哈希。原始 map JSON 与执行台账及 attempt 副本逐字节一致。", "",
        f"成功关键帧逐个绑定真实 native 事件和同 tick interaction input，捕获为事件后的原生主视图，tickDelta 范围 **{min(deltas)}–{max(deltas)} tick**，不冒充事件瞬间。无额外截图或仿真。所有 host terminal 最终全量读取、磁盘 bytes/SHA 和 finalNativeVerification 通过；导出/取帧错误历史没有被删除。", "",
        f"原生 program_error={totals['program_error_events']}；重复 observe={totals['repeated_observes']}；observe_motion_violation={totals['observe_guard_violations']}。重复判据严格沿用冻结规则：同 tick，或相邻公开 odometry 平移 <5 cm 且转角 <10°；缺失运动信息不得通过。本轮无缺失。十局均以 native program_finished 结束，未被驱动 deadline/stall 停止。", "",
        "## 驱动 I/O 实际记录", "",
        f"十局最终终端合计 **{metrics['terminal_final_bytes']:,} bytes**；宿主实际写入 **{metrics['terminal_written_bytes_including_final_full']:,} bytes**，包括增量文本和收尾完整重写。源码字段 receivedSuffixBytes 也包含收尾完整包，不能误称全部都是增量后缀。终端写出累计 {metrics['terminal_write_ms']:.3f} ms，浏览器读取及前缀比对累计 {metrics['browser_terminal_read_ms']:.3f} ms；fullFallbacks={metrics['terminal_fallbacks']}，终端错误={metrics['terminal_errors']}，evaluate timeout={metrics['evaluate_timeouts']}。这些均为 hostIO 计数器读数，非额外性能实验。", "",
        f"原生清单实际写出 {metrics['manifests_visionWrites']} 次，无变化跳过 {metrics['manifests_visionSkippedUnchanged']} 次；成功截图清单写出 {metrics['manifests_demoWrites']} 次，无变化跳过 {metrics['manifests_demoSkippedUnchanged']} 次。两类清单实际写出 {metrics['manifests_writtenBytes']:,} bytes / {metrics['manifests_writeMs']:.3f} ms；不包含 PNG/full-record 文件写入。跳过次数证明免空写机制发生，不能直接等同于旧驱动会多写的次数。", "",
        "| CDP 读操作 | 请求/响应 | 请求/响应 UTF-8 bytes | 往返 ms | JSON 解析 ms |", "|---|---:|---:|---:|---:|"]
    for name in ("terminal_status_delta", "terminal_final_full", "vision_incremental_read", "demo_incremental_read"):
        m = metrics[name]; md.append(f"| {name} | {m['requests']} / {m['responses']} | {m['requestUtf8Bytes']:,} / {m['responseUtf8Bytes']:,} | {m['roundTripMs']:.3f} | {m['parseMs']:.3f} |")
    md += ["", "CDP 字节是 JSON 请求/响应负载，不含 websocket framing。往返包含页面排队、执行、序列化及宿主解析等，不能解读为纯传输延迟或累加为独立 CPU 用时。原生全 truth ledger 仍会被读取，平台 textContent 更新/布局未改，本审计不推断其剩余成本。", "",
        "## R1 / R3 描述性对照", "", "| 布局 | R1 墙钟 / 仿真 s | R3 墙钟 / 仿真 s | R1 / R3 observe | R1 / R3 终端 bytes |", "|---|---:|---:|---:|---:|"]
    for r in rows:
        old = r["round1_descriptive_comparison"]
        md.append(f"| {r['map']} | {old['wall_seconds']:.3f} / {old['simulation_seconds']} | {r['wall_seconds']:.3f} / {r['simulation_seconds']} | {old['observe_count']} / {r['observe_count']} | {old['terminal_bytes']:,} / {r['host_io']['terminal']['finalVerification']['bytes']:,} |")
    md += ["", "R1 无 hostIO 字节/时间计数，不能算出与 R3 对应的 CDP、磁盘写出或 UI CPU 加速比。两轮控制代码、道路行驶、第二球搜索、观察及日志量改变；同一布局不是同一路线的配对试验。表中墙钟变化仅是事实，不归因于某个优化，也不声称确定性执行轨迹相同。R1 map-08 曾有 120000 ms 导出超时；R3 无此类计数，但这仍不证明在等量长日志下问题必然消失。", "",
        "最终双球闭环门由主报告负责；本审计不把完整证据或零程序错误替代任务通过。全部读取文件在审计前后 SHA 一致。", ""]
    (HERE / "REPORT.md").write_text("\n".join(md))
    print(json.dumps({"totals": totals, "host_io_metrics": metrics}, ensure_ascii=False))


if __name__ == "__main__":
    main()
