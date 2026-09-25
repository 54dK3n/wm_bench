#!/usr/bin/env python3
"""Diagnostic fixture: real external brain/bridge, loopback scripted fake LLM.

This never exercises a real model and cannot establish task acceptance. Two
valid responses (explore, look_around) are followed by two invalid JSON outputs,
so the expected brain outcome is a logged LLMOutputError and a complete export.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
VERSION = "external-brain-transport-smoke/v3"
RESPONSES = ['{"action":"explore","params":{}}',
             '{"action":"look_around","params":{}}',
             'INVALID_JSON_DIAGNOSTIC_FIRST', 'INVALID_JSON_DIAGNOSTIC_REPAIR']
METHODS = {"observe", "camera_parameters", "odometry", "local_road", "holding", "grab", "release",
           "forward", "backward", "turn", "follow_road", "take_exit"}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def dump(path, value):
    text = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    Path(path).write_text(text.replace(str(ROOT) + os.sep, ""), encoding="utf-8")


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def read_lines(path):
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]


def verify(out, fixture, returncode):
    checks = []
    def check(name, passed, detail=None):
        checks.append({"check": name, "passed": bool(passed), "detail": detail})
    run = out / "map-05-run-1"
    driver = read(out / "summary.json")
    summary = read(run / "brain/summary.json")
    rounds = read_lines(run / "brain/rounds.jsonl")
    llm = read_lines(run / "brain/llm.jsonl")
    bridge = read_lines(run / "brain/bridge-calls.jsonl")
    observations = read_lines(run / "brain/observations.jsonl")
    evidence = read(run / "evidence.json")
    values = {}
    for name, entry in evidence.items():
        packed = (run / entry["file"]).read_bytes()
        if entry.get("compression", "gzip") == "gzip":
            content = gzip.decompress(packed)
        elif entry["compression"] == "none":
            content = packed
        else:
            raise ValueError("Unsupported diagnostic evidence encoding")
        check(f"{name}_compressed_and_expanded_sha256",
              hashlib.sha256(packed).hexdigest() == entry["sha256"] and
              hashlib.sha256(content).hexdigest() == entry["expandedSha256"])
        values[name] = json.loads(content)
    record = values["record"]
    actions = [row["action"]["action"] for row in rounds if row.get("action")]
    check("exactly_two_actions", actions == ["explore", "look_around"], actions)
    check("exactly_four_fake_model_responses", len(fixture["requests"]) == 4, len(fixture["requests"]))
    check("llm_logged_all_four_calls", len(llm) == 4 and summary["llm_calls"] == 4)
    check("one_repair_on_third_decision", [(r["decision_index"], r["attempt"]) for r in llm] == [(1,1),(2,1),(3,1),(3,2)])
    check("invalid_json_stops_before_third_action", len(rounds) == 3 and rounds[-1]["action"] is None
          and rounds[-1]["result"].get("error_type") == "LLMOutputError")
    check("brain_reports_expected_failure", summary["status"] == "failed" and summary["reason"].startswith("LLMOutputError:"), summary["reason"])
    check("fixture_is_loopback_only", fixture["bind_host"] == "127.0.0.1" and fixture["model"] == "diagnostic-stub")
    check("json_mode_temperature_zero", all(r["request"].get("model") == "diagnostic-stub"
          and r["request"].get("temperature") == 0
          and r["request"].get("response_format") == {"type":"json_object"} for r in fixture["requests"]))
    nonempty = sum(bool(row["observation"]["detections"]) for row in observations)
    check("real_camera_observations_nonempty", len(observations) > 0 and nonempty > 0, {"total":len(observations), "nonempty":nonempty})
    requested = [entry["request"]["method"] for entry in bridge]
    check("only_whitelisted_bridge_requests", set(requested) <= METHODS, sorted(set(requested)))
    check("no_rejected_bridge_calls", not any(row.get("type") == "rejected" for row in record["bridgeCalls"]))
    check("complete_platform_record", record["complete"] is True)
    check("simulation_advanced_under_limit", 0 < record["native"]["simulationEndTick"] * record["clock"]["stepMs"] < 1200 * 1000)
    check("platform_hard_limit_1200_seconds", record["runtime"]["timeLimitSeconds"] == 1200)
    check("driver_export_complete_without_infrastructure_error", driver["status"] == "complete"
          and len(driver["trials"]) == 1 and not driver["trials"][0].get("error")
          and not driver["trials"][0].get("stopError") and not driver["trials"][0].get("controllerErrors")
          and not driver["trials"][0].get("process",{}).get("interrupted"))
    check("source_frozen_during_run", driver["sourcesUnchanged"])
    check("driver_reports_task_failure_as_expected", returncode == 1 and driver["success"] is False)
    by_frame = {(row["frameId"],row["tick"]):row for row in values["sensorAudit"]}
    match = len(by_frame) == len(observations)
    for row in observations:
        observation = row["observation"]
        native = by_frame.get((observation["frameId"],observation["tick"]),{})
        match = match and native.get("robotDetections") == observation["detections"]
    check("bridge_matches_internal_detector_each_observation", match)
    check("truth_captures_and_native_frames_cover_observations", len(values["captures"]) == len(observations)
          and len(record["native"]["visionFrames"]) == len(observations))
    counts = {}
    for row in observations:
        for item in row["observation"]["detections"]:
            counts[item["category"]] = counts.get(item["category"],0) + 1
    return {"schema":VERSION,"diagnostic":True,"real_model_used":False,"task_acceptance":False,
            "intended_outcome":"two actions, one invalid-JSON repair, then expected failure with complete export",
            "transport_checks_passed":all(row["passed"] for row in checks),"checks":checks,
            "actions":actions,"rounds":len(rounds),"fake_model_responses":len(fixture["requests"]),
            "observations":len(observations),"nonempty_observations":nonempty,"detection_counts":counts,
            "simulation_seconds":summary["simulation_seconds"],"brain_stop_reason":summary["reason"],
            "driver_returncode":returncode,"model":"diagnostic-stub"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args(argv)
    out = Path(args.out).resolve()
    if args.verify_only:
        fixture = read(out / "diagnostic-fixture.json")
        result = verify(out, fixture, fixture["driver_returncode"])
        previous = read(out / "diagnostic-checks.json")
        if result != previous:
            raise AssertionError("diagnostic results differ from saved report")
        print(json.dumps({"diagnostic":True,"recomputed_equal":True,"transport_checks_passed":result["transport_checks_passed"]}))
        return 0 if result["transport_checks_passed"] else 1
    if out.exists():
        raise ValueError("Refusing to reuse diagnostic output directory")
    fixture = {"schema":VERSION,"diagnostic":True,"real_model_used":False,"task_acceptance":False,
               "bind_host":"127.0.0.1","model":"diagnostic-stub","requests":[],
               "tool_sha256":digest(__file__),"driver_sha256":digest(ROOT / "tools/autonomous_brain_driver.js")}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *unused):
            pass
        def do_POST(self):
            if self.path != "/v1/chat/completions":
                self.send_error(404)
                return
            body = self.rfile.read(int(self.headers.get("Content-Length","0")))
            request = json.loads(body)
            index = len(fixture["requests"])
            raw = RESPONSES[index] if index < len(RESPONSES) else "UNEXPECTED_EXTRA_REQUEST"
            payload = {"id":f"diagnostic-{index+1}","object":"chat.completion","model":"diagnostic-stub",
                       "choices":[{"index":0,"message":{"role":"assistant","content":raw},"finish_reason":"stop"}]}
            fixture["requests"].append({"index":index+1,"request":request,"response":payload})
            if request.get("stream"):
                chunk = {"id": payload["id"], "object": "chat.completion.chunk",
                         "model": payload["model"], "choices": [{"index": 0,
                         "delta": payload["choices"][0]["message"], "finish_reason": None}]}
                terminal = {"id": payload["id"], "object": "chat.completion.chunk",
                            "model": payload["model"], "choices": [{"index": 0,
                            "delta": {}, "finish_reason": "stop"}]}
                encoded = ("data: " + json.dumps(chunk) + "\n\ndata: " + json.dumps(terminal)
                           + "\n\ndata: [DONE]\n\n").encode()
                content_type = "text/event-stream"
            else:
                encoded = json.dumps(payload).encode()
                content_type = "application/json"
            fixture["requests"][-1]["wire_response"] = encoded.decode()
            self.send_response(200)
            self.send_header("Content-Type",content_type)
            self.send_header("Content-Length",str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
    server = ThreadingHTTPServer(("127.0.0.1",0),Handler)
    thread = threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    env = dict(os.environ)
    env.update(LLM_BASE_URL=f"http://127.0.0.1:{server.server_port}/v1",LLM_API_KEY="diagnostic-dummy-key",
               LLM_MODEL="diagnostic-stub",LLM_TEMPERATURE="0",LLM_THINKING="disabled",
               WORLD_MODEL_ROOT=str(ROOT / "vendor/wm_kit_opt2"),
               HTTP_PROXY="",HTTPS_PROXY="",ALL_PROXY="",NO_PROXY="127.0.0.1,localhost,::1")
    cmd = ["node","tools/autonomous_brain_driver.js","--out",str(out),"--max-rounds","5",
           "--python",sys.executable,"--wall-timeout-seconds","600"]
    started = time.monotonic()
    try:
        completed = subprocess.run(cmd,cwd=ROOT,env=env,capture_output=True,text=True,timeout=720)
        fixture["driver_returncode"] = completed.returncode
        fixture["wall_elapsed_seconds"] = time.monotonic() - started
        out.mkdir(parents=True,exist_ok=True)
        (out / "diagnostic-driver-stdout.txt").write_text(completed.stdout.replace(str(ROOT)+os.sep,""))
        (out / "diagnostic-driver-stderr.txt").write_text(completed.stderr.replace(str(ROOT)+os.sep,""))
        dump(out / "diagnostic-fixture.json",fixture)
        try:
            result = verify(out,fixture,completed.returncode)
        except Exception as exc:
            result = {"schema":VERSION,"diagnostic":True,"real_model_used":False,"task_acceptance":False,
                      "transport_checks_passed":False,"verification_error":f"{type(exc).__name__}: {exc}",
                      "driver_returncode":completed.returncode}
        dump(out / "diagnostic-checks.json",result)
        lines = ["# 外部大脑传输联调（诊断 fixture）","",
                 "**这不是任务验收：使用本机假模型 diagnostic-stub，没有调用真实大模型。**","",
                 "平台、外部 Python 大脑、WorldModel、机器人桥及真实相机检测均运行实际代码。假模型只依次返回 explore、look_around、非法 JSON、非法 JSON；预期大脑在第三轮一次修复失败后停止。","",
                 f"传输检查：{'PASS' if result['transport_checks_passed'] else 'FAIL'}。任务验收：未执行。","",
                 "数值和全部检查见同目录 `diagnostic-checks.json`；完整假模型请求/响应见 `diagnostic-fixture.json`；真实平台及脑日志见 `map-05-run-1/`。","",
                 "复核命令：","","```sh",f"python3 tools/smoke_external_brain.py --out {out.relative_to(ROOT)} --verify-only","```",""]
        (out / "DIAGNOSTIC.md").write_text("\n".join(lines),encoding="utf-8")
        print(json.dumps(result,ensure_ascii=False))
        return 0 if result["transport_checks_passed"] else 1
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


if __name__ == "__main__":
    raise SystemExit(main())
