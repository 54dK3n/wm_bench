#!/usr/bin/env python3
"""Local fake-model diagnostic for exporting at least 500 real camera frames.

Fifty stationary scans exercise the real simulator and external brain. This is
an export diagnostic, never task acceptance and never a real model request.
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
VERSION = "external-brain-export-stress/v2"


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out).resolve()
    out.relative_to(ROOT)
    if out.exists():
        raise ValueError("Refusing to reuse diagnostic output")
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *unused):
            pass

        def do_POST(self):
            if self.path != "/v1/chat/completions":
                self.send_error(404)
                return
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            request = json.loads(raw)
            requests.append({"index": len(requests) + 1,
                             "request_sha256": hashlib.sha256(raw).hexdigest(),
                             "model": request.get("model"),
                             "temperature": request.get("temperature")})
            payload = {"id": f"export-stress-{len(requests)}", "model": "export-diagnostic-stub",
                       "choices": [{"index": 0, "message": {"role": "assistant",
                       "content": '{"action":"look_around","params":{}}'},
                       "finish_reason": "stop"}]}
            chunk = {"id": payload["id"], "object": "chat.completion.chunk",
                     "model": payload["model"], "choices": [{"index": 0,
                     "delta": payload["choices"][0]["message"], "finish_reason": None}]}
            terminal = {"id": payload["id"], "object": "chat.completion.chunk",
                        "model": payload["model"], "choices": [{"index": 0,
                        "delta": {}, "finish_reason": "stop"}]}
            encoded = ("data: " + json.dumps(chunk) + "\n\ndata: " + json.dumps(terminal)
                       + "\n\ndata: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = dict(os.environ)
    env.update(LLM_BASE_URL=f"http://127.0.0.1:{server.server_port}/v1",
               LLM_API_KEY="diagnostic-dummy-key", LLM_MODEL="export-diagnostic-stub",
               LLM_TEMPERATURE="0", LLM_THINKING="disabled",
               HTTP_PROXY="", HTTPS_PROXY="", ALL_PROXY="",
               NO_PROXY="127.0.0.1,localhost,::1")
    command = ["node", "tools/autonomous_brain_driver.js", "--out", str(out),
               "--max-rounds", "50", "--python", sys.executable,
               "--wall-timeout-seconds", "1200"]
    started = time.monotonic()
    try:
        process = subprocess.run(command, cwd=ROOT, env=env, capture_output=True,
                                 text=True, timeout=1800)
        out.mkdir(parents=True, exist_ok=True)
        for name, content in (("stdout", process.stdout), ("stderr", process.stderr)):
            (out / f"diagnostic-{name}.txt").write_text(content.replace(str(ROOT) + os.sep, ""))
        report = {"version": VERSION, "diagnostic": True, "real_model_used": False,
                  "task_acceptance": False, "driver_returncode": process.returncode,
                  "wall_elapsed_s": time.monotonic() - started,
                  "script_sha256": digest(__file__), "requests": requests,
                  "checks": {}}
        checks = report["checks"]
        try:
            summary = json.loads((out / "summary.json").read_text())
            trial = summary["trials"][0]
            run = out / "map-05-run-1"
            brain = json.loads((run / "brain/summary.json").read_text())
            rounds = [json.loads(line) for line in (run / "brain/rounds.jsonl").read_text().splitlines()]
            observations = sum(1 for _ in (run / "brain/observations.jsonl").open())
            checks["exactly_fifty_scans"] = (len(rounds) == 50 and
                all(row.get("action") == {"action": "look_around", "params": {}} and
                    row["result"]["success"] for row in rounds))
            checks["all_model_requests_local_fixture"] = len(requests) == 50 and all(
                row["model"] == "export-diagnostic-stub" and row["temperature"] == 0 for row in requests)
            checks["at_least_five_hundred_real_observations"] = observations >= 500
            checks["complete_frozen_driver_export"] = (summary["status"] == "complete" and
                summary["sourcesUnchanged"] and not trial.get("stopError") and not trial.get("error") and
                not trial.get("controllerErrors") and not trial["process"].get("interrupted"))
            checks["task_failure_retained"] = process.returncode == 1 and not summary["success"]
            evidence = json.loads((run / "evidence.json").read_text())
            report["datasets"] = {}
            for name in ("record", "samples", "sensorAudit", "captures"):
                entry = evidence[name]
                path = run / entry["file"]
                expanded = hashlib.sha256()
                size = 0
                with gzip.open(path, "rb") as source:
                    while chunk := source.read(1024 * 1024):
                        expanded.update(chunk)
                        size += len(chunk)
                passed = (digest(path) == entry["sha256"] and expanded.hexdigest() == entry["expandedSha256"]
                          and path.stat().st_size == entry["bytes"] and size == entry["expandedBytes"])
                checks[f"{name}_complete_and_hashed"] = passed
                report["datasets"][name] = entry
            report.update(rounds=len(rounds), observations=observations,
                          simulation_seconds=brain["simulation_seconds"])
        except Exception as error:
            checks["verification_complete"] = False
            report["verification_error"] = f"{type(error).__name__}: {error}"
        report["passed"] = all(checks.values())
        (out / "diagnostic-checks.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({key: value for key, value in report.items() if key != "requests"}))
        return 0 if report["passed"] else 1
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


if __name__ == "__main__":
    raise SystemExit(main())
