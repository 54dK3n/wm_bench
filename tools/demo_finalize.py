#!/usr/bin/env python3
"""Finalize an already finished demo report using raw, exact-render evidence.

python3 tools/demo_finalize.py artifacts/inloop/demo
--output-dir permits a separate offline preview; live DEMO.md is never replaced.
No robot, frozen evaluator, raw evidence, or simulator is changed.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import shlex

try:
    from .demo_timeline import reconstruct
    from .run_diagnostic_batch import program_identity, verify_identity
except ImportError:
    from demo_timeline import reconstruct
    from run_diagnostic_batch import program_identity, verify_identity

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def all_report_gates_pass(trial):
    gates, details = trial.get("gates", {}), trial.get("gate_details", {})
    return bool(gates) and all(value is True and details.get(name, {}).get("status") == "pass"
                               for name, value in gates.items())


def check_trial_identity(folder, trial, raw):
    """Preserve the runner's raw-file / trimmed-executed-source distinction."""
    frozen = folder / "program.py"
    identity = program_identity(frozen)
    if not verify_identity(raw, identity):
        raise ValueError("Executed program version/embed/source identity differs from frozen program")
    identity_path = folder / "identity.json"
    if identity_path.exists() and read(identity_path) != identity:
        raise ValueError("Stored runner identity differs from frozen program")
    manifest_path = folder / "code_manifest.json"
    if manifest_path.exists() and read(manifest_path).get(str(frozen)) != digest(frozen):
        raise ValueError("Frozen raw program hash differs from manifest")
    checked = {}
    for kind, item in trial.get("evidence_files", {}).items():
        if not item.get("exists"):
            checked[kind] = "unknown_missing_in_original_report"
            continue
        path = Path(item["path"])
        if not path.is_file() or digest(path) != item.get("sha256"):
            raise ValueError(f"Evidence changed after evaluator report: {kind}: {path}")
        checked[kind] = "sha256_matches_original_report"
    return {"executed_identity": identity, "frozen_raw_sha256": digest(frozen), "evidence_files": checked}


def verified_packages(raw):
    grabbed, delivered = set(), set()
    for event in raw.get("record", {}).get("events", []):
        package = event.get("packageId")
        if event.get("type") == "package_grabbed" and event.get("objectRole") == "target" and event.get("accepted") is True:
            grabbed.add(package)
        elif event.get("type") == "package_delivered" and event.get("objectRole") == "target" and package in grabbed:
            delivered.add(package)
        elif event.get("type") == "package_delivery_revoked":
            delivered.discard(package)
    return sorted(package for package in delivered if package)


def failure_evidence(raw):
    indexed = [{"line_index": i, **line} for i, line in enumerate(raw.get("lines", []))]
    end = next((line for line in reversed(indexed) if line.get("event") == "flow_end"), None)
    observe = next((line for line in reversed(indexed) if line.get("event") == "observe"), None)
    wm = next((line for line in reversed(indexed) if line.get("event") == "wm_targets"), None)
    stop = next((line for line in reversed(indexed) if line.get("event") not in ("flow_end", "ball_end")
                 and any(word in line.get("event", "") for word in ("fail", "abort", "exhaust", "violation"))), None)
    return {"flow_end": end, "last_observe": observe, "last_wm": wm, "last_failure_event": stop}


def build(folder, source_report=None):
    folder = Path(folder).resolve()
    report_path = Path(source_report).resolve() if source_report else folder / "demo_report.json"
    report = read(report_path)
    trials = report.get("trials", [report])
    progress_path = folder / "progress.json"
    progress = read(progress_path) if progress_path.exists() else {}
    details, selected = [], None
    for trial in trials:
        raw_path = Path(trial["raw_file"])
        raw = read(raw_path)
        if trial.get("map") != raw.get("assignedMap"):
            raise ValueError("Evaluator map differs from the actual assigned layout")
        expected = trial.get("evidence_files", {}).get("raw", {}).get("sha256")
        if expected != digest(raw_path):
            raise ValueError(f"Raw identity does not match completed evaluator report: {raw_path}")
        identity = check_trial_identity(folder, trial, raw)
        try:
            timeline = reconstruct(raw_path)
        except (KeyError, FileNotFoundError, ValueError) as error:
            timeline = {"balls": [], "binding_problems": [{"reason": "timeline_evidence_unavailable", "detail": str(error)}],
                        "status": "unknown", "raw_file": str(raw_path)}
        packages = verified_packages(raw)
        passed = trial.get("all_gates_pass") is True and all_report_gates_pass(trial) and len(packages) == 2
        if trial.get("all_gates_pass") is True and not passed:
            raise ValueError(f"Evaluator success lacks two actual final delivered targets: {trial['map']}")
        evidence_path = Path(raw["demoEvidenceFile"]) if raw.get("demoEvidenceFile") else None
        evidence = read(evidence_path) if evidence_path and evidence_path.exists() else {}
        keyframes = []
        for frame in evidence.get("frames", []):
            image = Path(frame["image"])
            if not image.is_absolute():
                image = evidence_path.parent / image
            keyframes.append({"package_id": frame.get("packageId"), "event": frame.get("eventType"),
                "event_seq": frame.get("eventSeq"), "event_tick": frame.get("eventTick"),
                "capture_tick": frame.get("captureTick"), "tick_delta": frame.get("tickDelta"),
                "same_tick_and_revision": frame.get("sameTickAndRevision"), "image": str(image),
                "image_sha256": frame.get("sha256"), "image_identity_verified": image.is_file() and digest(image) == frame.get("sha256")})
        balls = []
        for ball in trial.get("balls", []):
            ids = ball.get("distinct_package_ids", [])
            if not ids:
                ids = list(dict.fromkeys(event["packageId"] for event in ball.get("platform_grabs", [])))
            matched = next((item for item in timeline["balls"] if item["package_id"] in ids), None)
            first = matched.get("earliest_unambiguous_uncapped") if matched else None
            # In-domain exact-render uniqueness is sufficient for this offline
            # attribution; do not promote clipped or extrapolated candidates.
            seeing = first if first and first.get("m5_calibrated_domain") else None
            ball_confirmed = next((event for event in ball.get("timeline", []) if event.get("event") == "ball_confirmed"), None)
            balls.append({"ball_index": ball.get("ball_index"), "track_id": ball.get("track_id"), "package_ids": ids,
                "source": ball.get("source"), "first_seen": seeing,
                "first_seen_basis": "native raw plus exact render truth; unique uncapped M5 association <=3deg/30cm within calibration domain" if seeing else "unknown: no unique in-domain uncapped association",
                "earlier_raw_candidate": matched.get("earliest_raw_candidate") if matched else None,
                "first_wm_accepted": matched.get("first_wm_accepted") if matched else None,
                "confirmed": ball_confirmed or ball.get("confirmed_time"),
                "grabbed": ball.get("platform_grabs", [None])[0] if ball.get("platform_grabs") else None,
                "delivered": ball.get("platform_deliveries", [None])[0] if ball.get("platform_deliveries") else None,
                "fixed_rules_all_pass": ball.get("fixed_rules_all_pass"),
                "fixed_rule_audit": ball.get("fixed_rule_audit"),
                "keyframes": [frame for frame in keyframes if frame["package_id"] in ids]})
        row = {"map": trial["map"], "all_gates_pass": passed, "raw_file": str(raw_path),
            "raw_sha256": digest(raw_path), "verified_final_packages": packages, "balls": balls,
            "identity_check": identity,
            "timeline": timeline, "failure_evidence": failure_evidence(raw), "budgets": trial.get("budgets"),
            "failed_gates": trial.get("failure_reasons"), "keyframes": keyframes,
            "combined_image_bytes_information_only": evidence.get("combinedImageBytes")}
        details.append(row)
        if passed and selected is None:
            selected = row["map"]
    completed = set(progress.get("completed", {})) or {row["map"] for row in details}
    required = {f"map-{i:02d}" for i in range(1, 11)}
    all_ten_failed = selected is None and completed == required and {row["map"] for row in details} == required
    reasons = Counter(row["failure_evidence"]["flow_end"].get("reason") for row in details
                      if not row["all_gates_pass"] and row["failure_evidence"]["flow_end"] and row["failure_evidence"]["flow_end"].get("reason"))
    return {"schema": "wm-demo-final-delivery/v1", "folder": str(folder), "source_report": str(report_path),
        "source_report_sha256": digest(report_path), "runner_status": progress.get("status"),
        "success_map": selected, "all_gates_pass": selected is not None,
        "all_ten_failed_STOP": all_ten_failed, "most_frequent_stops": reasons.most_common(),
        "scope": "offline delivery presentation only; no gate relaxation, no success-rate statistics, no simulator",
        "trials": details}


def time_label(event, source="lines"):
    if not event:
        return "unknown"
    tick = event.get("tick")
    if source == "events":
        tick = event.get("t") / 20 if event.get("t") is not None else None
        index = event.get("event_index")
    else:
        index = event.get("line_index")
    return f"{tick * .02:.2f}s / tick {tick:g} / {source}[{index}]" if tick is not None else "unknown"


def failure_label(row):
    evidence = row["failure_evidence"]
    end, observe, wm, stop = (evidence[key] for key in ("flow_end", "last_observe", "last_wm", "last_failure_event"))
    packages = row.get("verified_final_packages", [])
    parts = [f"实际已抓并保持送达={len(packages)}（{','.join(packages) or '无'}）"]
    if len(packages) == 2:
        parts.append("物理双送达已发生；流程/证据验收未通过")
    if end:
        parts.append(f"lines[{end['line_index']}] tick {end.get('tick')}：{end.get('reason') or end.get('stage')}; delivered={end.get('delivered_count')}, queries={end.get('navigation_queries')}, controls={end.get('navigation_controls')}")
    if stop:
        metrics = {key: value for key, value in stop.items() if key not in ("line_index", "event") and type(value) in (int, float)}
        parts.append(f"{stop['event']} lines[{stop['line_index']}] {json.dumps(metrics, ensure_ascii=False, separators=(',', ':'))}")
    if observe:
        red = [{key: item.get(key) for key in ("distanceCm", "bearingDeg", "confidence")}
               for item in observe.get("raw", []) if item.get("category") == "target"]
        parts.append(f"末 observe lines[{observe['line_index']}] count={observe.get('observe_count')}，红={json.dumps(red, ensure_ascii=False,separators=(',', ':'))}")
    if wm:
        parts.append(f"末 WM lines[{wm['line_index']}] " + ",".join(f"{track.get('id')}:{track.get('state')}/hit={track.get('hit')}" for track in wm.get("tracks", [])))
    failures = row.get("failed_gates", [])
    if failures:
        parts.append("未通过门槛（unknown=未核验）：" + ",".join(item["gate"] + "=" + item["status"] for item in failures))
    if not end and not stop:
        parts.append("unknown：缺少明确退出日志")
    return "；".join(parts).replace("|", "\\|")


def markdown(final):
    selected = next((row for row in final["trials"] if row["map"] == final["success_map"]), None)
    text = ["# 双目标 Demo", ""]
    if selected:
        text += [f"**{selected['map']} 通过**：同局两个不同目标确实抓取并送达，全部既定门槛通过。", "",
                 "| 球 / 实际包裹 | 来源 | 首次可确证看到 | confirmed | grabbed | delivered |", "|---|---|---|---|---|---|"]
        for ball in selected["balls"]:
            first = ball["first_seen"]
            first_label = f"[{time_label(first)}]({first['image']})" if first else "unknown"
            text.append(f"| {ball['ball_index']} / {', '.join(ball['package_ids'])} | {ball['source']} | {first_label} | {time_label(ball['confirmed'])} | {time_label(ball['grabbed'], 'events')} | {time_label(ball['delivered'], 'events')} |")
        text += ["", "首次看到采用未封顶、精确渲染且唯一匹配证据；更早的 100cm 候选若存在，仍只记为候选。首次 WM 关联另保留在 `demo_finalized.json`。", "",
                 "| 球 / 关键帧 | 平台事件 tick | 截图 tick | PNG |", "|---|---:|---:|---|"]
        for frame in selected["keyframes"]:
            text.append(f"| {frame['package_id']} / {frame['event']} | {frame['event_tick']} | {frame['capture_tick']} | [原图]({frame['image']}) |")
        budget = selected["budgets"]
        text += ["", f"仿真 {budget['simulation_seconds']}s；observe {budget['observes']}/92；原生视觉 {budget['vision_bytes']} bytes；合计图像 {selected['combined_image_bytes_information_only']} bytes（只报告）。"]
    elif final["all_ten_failed_STOP"]:
        text += ["**STOP：十个布局全部未通过双目标 demo，停止，不进入优化。**"]
    else:
        text += [f"**尚无通过的双目标 demo**；runner 状态 `{final['runner_status']}`。不能将单球送达视为成功。"]
    failures = [row for row in final["trials"] if not row["all_gates_pass"]]
    if failures:
        text += ["", "| 失败布局 | 原始日志证据（零起点索引） |", "|---|---|"]
        text += [f"| {row['map']} | {failure_label(row)} |" for row in failures]
        if not selected:
            frequent = final["most_frequent_stops"][:3]
            text += ["", "最频卡点：" + ("；".join(f"{reason}（{count} 局）" for reason, count in frequent) or "unknown，缺少明确退出原因") + "。"]
    folder = final["folder"]
    text += ["", "完整固定规则、原始日志与哈希见 [demo_report.json](demo_report.json)、[DETAILS.md](DETAILS.md)；首次看到与首次 WM 命中的区别及全部候选见 [demo_finalized.json](demo_finalized.json)。不计算成功率。", "", "复跑：", "", "```sh"]
    if selected:
        text += [f"python3 tools/reproduce_demo.py --demo-folder {shlex.quote(folder)} --out /tmp/wm-demo-reproduction-NEW"]
    else:
        text += [f"python3 tools/demo_finalize.py {shlex.quote(folder)}  # 仅离线复算；当前无已通过布局可复跑"]
    text += ["```", ""]
    return "\n".join(text)


def finalize(folder, output_dir=None, source_report=None):
    folder = Path(folder).resolve()
    output = Path(output_dir).resolve() if output_dir else folder
    progress = read(folder / "progress.json") if (folder / "progress.json").exists() else {}
    if output == folder and (progress.get("status") == "running" or progress.get("active")):
        raise ValueError("Runner is active; use a separate --output-dir for an offline preview")
    final = build(folder, source_report)
    output.mkdir(parents=True, exist_ok=True)
    (output / "demo_finalized.json").write_text(json.dumps(final, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "DEMO.md").write_text(markdown(final), encoding="utf-8")
    for trial in final["trials"]:
        (output / f"{trial['map']}.timeline.json").write_text(json.dumps(trial["timeline"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return final


def self_check(folder):
    """Re-runnable bounded offline contract tests, including synthetic success."""
    import copy
    import tempfile
    from unittest.mock import patch
    try:
        from .reproduce_demo import make_plan
    except ImportError:
        from reproduce_demo import make_plan
    folder = Path(folder).resolve()
    manifest = read(folder / "code_manifest.json")
    before = {name: digest(Path(name)) for name in manifest}
    formal = folder / "DEMO.md"
    formal_before = digest(formal) if formal.exists() else None
    progress = read(folder / "progress.json")
    source = next(folder / f"{name}.demo_eval.json" for name in progress.get("completed", {})
                  if (folder / f"{name}.demo_eval.json").exists())
    original = read(source)
    checks = {}

    def check(name, condition):
        checks[name] = bool(condition)
        if not condition:
            raise AssertionError(name)

    def rejects(name, call, text):
        try:
            call()
        except ValueError as error:
            check(name, text in str(error))
        else:
            check(name, False)

    with tempfile.TemporaryDirectory(prefix="demo-finalizer-contract-") as temporary:
        temp = Path(temporary).resolve()
        failed = finalize(folder, temp / "preview", source)
        check("real_completed_failure_not_promoted", not failed["all_gates_pass"])
        check("failure_row_has_exact_log_index_and_numbers", "lines[" in markdown(failed) and "queries=" in markdown(failed))
        check("raw_and_trimmed_hashes_both_recorded", failed["trials"][0]["identity_check"]["frozen_raw_sha256"]
              != failed["trials"][0]["identity_check"]["executed_identity"]["file_sha256"])
        if progress.get("status") == "running" or progress.get("active"):
            rejects("active_runner_cannot_replace_DEMO", lambda: finalize(folder, source_report=source), "Runner is active")
            rejects("active_source_cannot_be_reproduced", lambda: make_plan(folder, temp / "run"), "still active")
        # The following fixture changes only temporary copies. Its fabricated
        # extra package exercises the interface, never counts as an actual run.
        fixture = temp / "synthetic"
        fixture.mkdir()
        (fixture / "program.py").write_bytes((folder / "program.py").read_bytes())
        (fixture / "identity.json").write_bytes((folder / "identity.json").read_bytes())
        synthetic_manifest = {**manifest, str(fixture / "program.py"): digest(fixture / "program.py")}
        (fixture / "code_manifest.json").write_text(json.dumps(synthetic_manifest))
        (fixture / "progress.json").write_text(json.dumps({"status": "success", "completed": {original["map"]: {}}}))
        raw = read(Path(original["raw_file"]))
        fixture_events = raw["record"]["events"]
        grab = next(copy.deepcopy(e) for e in fixture_events if e.get("type") == "package_grabbed" and e.get("accepted") is True)
        delivery = next(copy.deepcopy(e) for e in fixture_events if e.get("type") == "package_delivered")
        grab["packageId"] = delivery["packageId"] = "SYNTHETIC-CONTRACT-TEST-ONLY"
        fixture_events.extend([grab, delivery])
        raw_path = fixture / "synthetic.json"
        raw_path.write_text(json.dumps(raw))
        trial = copy.deepcopy(original)
        trial["raw_file"] = str(raw_path)
        trial["all_gates_pass"] = True
        trial["gates"] = {name: True for name in trial["gates"]}
        for detail in trial["gate_details"].values():
            detail["status"] = "pass"
        trial["evidence_files"]["raw"] = {"exists": True, "path": str(raw_path), "sha256": digest(raw_path)}
        report_path = fixture / "demo_report.json"
        report_path.write_text(json.dumps({"trials": [trial]}))
        plan = make_plan(fixture, temp / "fresh-run")
        check("positive_plan_uses_existing_runner_cli", plan["command"][1] == str(ROOT / "tools/run_demo.py"))
        check("positive_plan_selects_only_successful_layout", plan["command"][plan["command"].index("--map") + 1] == original["map"])
        check("positive_plan_uses_frozen_program", plan["command"][plan["command"].index("--program") + 1] == str(fixture / "program.py"))
        check("planning_never_creates_output_or_starts_simulator", not (temp / "fresh-run").exists())
        rejects("existing_output_rejected", lambda: make_plan(fixture, fixture), "Fresh --out")
        bad = copy.deepcopy(trial)
        bad["all_gates_pass"] = False
        report_path.write_text(json.dumps({"trials": [bad]}))
        rejects("no_success_rejected", lambda: make_plan(fixture, temp / "fresh-run"), "No fully verified")
        bad = copy.deepcopy(trial)
        bad["gate_details"][next(iter(bad["gate_details"]))]["status"] = "fail"
        report_path.write_text(json.dumps({"trials": [bad]}))
        rejects("inconsistent_gate_boolean_and_detail_rejected", lambda: make_plan(fixture, temp / "fresh-run"), "No fully verified")
        report_path.write_text(json.dumps({"trials": [trial]}))
        old_source = (fixture / "program.py").read_bytes()
        (fixture / "program.py").write_bytes(old_source + b"# synthetic mutation\n")
        rejects("executed_identity_mutation_rejected", lambda: make_plan(fixture, temp / "fresh-run"), "identity differs")
        (fixture / "program.py").write_bytes(old_source)
        missing_manifest = dict(synthetic_manifest)
        missing_manifest.pop(str(ROOT / "tools/demo_report.py"))
        (fixture / "code_manifest.json").write_text(json.dumps(missing_manifest))
        rejects("missing_runner_dependency_rejected", lambda: make_plan(fixture, temp / "fresh-run"), "runner dependencies")
        (fixture / "code_manifest.json").write_text(json.dumps(synthetic_manifest))
        raw["record"]["events"].append({"type": "package_delivery_revoked", "packageId": "SYNTHETIC-CONTRACT-TEST-ONLY"})
        raw_path.write_text(json.dumps(raw))
        rejects("revoked_delivery_rejected", lambda: make_plan(fixture, temp / "fresh-run"), "two actually")
        raw["record"]["events"].pop()
        raw_path.write_text(json.dumps(raw))
        known = reconstruct(Path(original["raw_file"]))
        expected = known["balls"][0]["earliest_unambiguous_uncapped"]
        module = __name__
        with patch(module + ".reconstruct", return_value=known):
            shown = build(fixture)
        check("first_seen_comes_from_exact_uncapped_raw", shown["trials"][0]["balls"][0]["first_seen"]["line_index"] == expected["line_index"])
        check("WM_acceptance_retained_separately", shown["trials"][0]["balls"][0]["first_wm_accepted"] is not None)
        unknown = copy.deepcopy(known)
        unknown["balls"][0]["earliest_unambiguous_uncapped"] = None
        with patch(module + ".reconstruct", return_value=unknown):
            shown = build(fixture)
        check("missing_raw_visibility_does_not_fallback_to_WM", shown["trials"][0]["balls"][0]["first_seen"] is None)
        (fixture / "progress.json").write_text(json.dumps({"status": "exhausted", "completed": {f"map-{i:02d}": {} for i in range(1, 11)}}))
        trial["all_gates_pass"] = False
        report_path.write_text(json.dumps({"trials": [trial]}))
        with patch(module + ".reconstruct", return_value=known):
            shown = build(fixture)
        check("partial_report_cannot_claim_all_ten_failed", shown["all_ten_failed_STOP"] is False)
        fake_stop = copy.deepcopy(shown)
        fake_stop["all_ten_failed_STOP"] = True
        check("all_ten_failure_renders_STOP", "STOP：十个布局全部未通过" in markdown(fake_stop))
    after = {name: digest(Path(name)) for name in manifest}
    check("all_frozen_files_unchanged", before == after and all(after[name] == expected for name, expected in manifest.items()))
    check("formal_DEMO_not_modified", formal_before == (digest(formal) if formal.exists() else None))
    check("does_not_require_git_repository", not (ROOT / ".git").exists())
    return {"schema": "wm-demo-finalizer-checks/v1", "scope": "offline only; temporary synthetic contract fixtures are not trial results; no simulator invoked",
        "command": f"python3 tools/demo_finalize.py {folder} --self-check",
        "checks": checks, "all_checks_pass": all(checks.values()), "source_trial_report": str(source),
        "source_trial_report_sha256": digest(source), "frozen_manifest_entries_verified": len(manifest),
        "frozen_raw_program_sha256": digest(folder / "program.py"), "executed_identity": program_identity(folder / "program.py"),
        "workspace_has_git_directory": (ROOT / ".git").exists(),
        "tool_sha256": {name: digest(ROOT / "tools" / name) for name in ("demo_finalize.py", "reproduce_demo.py", "demo_timeline.py")}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--source-report", type=Path, help="offline preview of an existing completed single-trial evaluator result")
    parser.add_argument("--self-check", action="store_true", help="offline contract tests only; writes finalizer_checks.json")
    args = parser.parse_args()
    if args.self_check:
        result = self_check(args.folder)
        (args.folder / "finalizer_checks.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"all_checks_pass": result["all_checks_pass"], "checks": len(result["checks"]), "simulator_started": False}))
        return
    result = finalize(args.folder, args.output_dir, args.source_report)
    print(json.dumps({"success_map": result["success_map"], "all_ten_failed_STOP": result["all_ten_failed_STOP"],
                      "output_dir": str(args.output_dir or args.folder)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
