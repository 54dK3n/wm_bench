#!/usr/bin/env python3
"""Replay diagnostic-stub LLM transcripts offline; this is not task acceptance."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from autonomous_brain.llm import LLMClient

VERSION = "external-brain-offline-replay-smoke/v1"


def read_lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="transport-smoke directory")
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    source, out = Path(args.input).resolve(), Path(args.out).resolve()
    if out.exists():
        raise ValueError("refusing to overwrite replay diagnostic evidence")
    fixture = json.loads((source / "diagnostic-fixture.json").read_text())
    if fixture.get("diagnostic") is not True or fixture.get("model") != "diagnostic-stub":
        raise ValueError("this fixture tool only accepts explicitly labelled diagnostic-stub evidence")
    manifest = json.loads((source / "manifest.json").read_text())
    llm_source = ROOT / "autonomous_brain/llm.py"
    if sha(llm_source) != manifest["brain"]["autonomous_brain/llm.py"]:
        raise ValueError("LLM client changed since the recorded diagnostic run")
    brain = source / "map-05-run-1/brain"
    rounds, original = read_lines(brain / "rounds.jsonl"), read_lines(brain / "llm.jsonl")
    out.mkdir(parents=True)
    rows = []
    with patch.dict(os.environ, {"LLM_BASE_URL":"", "LLM_API_KEY":"", "LLM_MODEL":""}), \
         patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden in diagnostic replay")) as networking:
        client = LLMClient(log_path=out / "replayed-llm.jsonl", replay_path=brain / "llm.jsonl")
        try:
            for recorded in rounds:
                actual, error = None, None
                try:
                    actual = client.decide(recorded["state"])
                except Exception as exc:
                    error = {"type":type(exc).__name__, "message":str(exc)}
                expected_error = None if recorded.get("action") else {
                    "type":recorded["result"]["error_type"],"message":recorded["result"]["reason"]}
                rows.append({"round":recorded["round"], "expected_action":recorded.get("action"),
                             "actual_action":actual,"expected_error":expected_error,"actual_error":error,
                             "exact_match":actual == recorded.get("action") and error == expected_error})
            client.assert_replay_consumed()
            networking.assert_not_called()
            call_count, elapsed = client.call_count, client.total_elapsed_s
        finally:
            client.close()
    replay = read_lines(out / "replayed-llm.jsonl")
    # Only the mode marker changes to replay. Requests, responses, validation,
    # model name and recorded elapsed time remain byte-for-byte JSON values.
    records_equal = len(original) == len(replay) and all(
        {k:v for k,v in left.items() if k != "mode"} == {k:v for k,v in right.items() if k != "mode"}
        and right["mode"] == "replay" for left,right in zip(original,replay))
    result = {"schema":VERSION,"diagnostic":True,"real_model_used":False,"task_acceptance":False,
              "fixture_model":"diagnostic-stub","networking":"urllib.request.urlopen patched to raise; zero calls",
              "rows":rows,"recorded_calls":len(original),"replayed_calls":call_count,
              "all_records_consumed":True,"full_records_equal_except_mode":records_equal,
              "recorded_elapsed_s_replayed":elapsed,
              "source_sha256":{"tool":sha(Path(__file__)),"llm_client":sha(llm_source),
                                "rounds":sha(brain / "rounds.jsonl"),"original_llm":sha(brain / "llm.jsonl")},
              "allPass":all(row["exact_match"] for row in rows) and records_equal and call_count == 4}
    (out / "replay-checks.json").write_text(json.dumps(result,ensure_ascii=False,indent=2) + "\n")
    (out / "DIAGNOSTIC.md").write_text(
        "# 假模型记录离线回放诊断\n\n这不是任务验收，也不代表真实大模型调用已验证。\n\n"
        f"结果：{'PASS' if result['allPass'] else 'FAIL'}。使用 `diagnostic-stub` 原始状态与调用记录，"
        "按 explore、look_around、LLMOutputError 重放 3 轮；4 条调用记录全部耗尽。"
        "urllib 联网入口被禁止且调用次数为零。除 mode 从 live 变 replay 外，完整记录逐字段相同。\n\n"
        "详细检查及源日志 SHA256 见 `replay-checks.json`；回放输入输出见 `replayed-llm.jsonl`。\n")
    print(json.dumps({"diagnostic":True,"allPass":result["allPass"],"replayed_calls":call_count,
                      "network_calls":0,"out":str(out.relative_to(ROOT))}))
    return 0 if result["allPass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
