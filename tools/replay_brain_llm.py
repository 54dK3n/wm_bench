#!/usr/bin/env python3
"""Replay saved brain LLM decisions offline; this does not replay the simulator."""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import hashlib
import json
from os.path import relpath
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from autonomous_brain.llm import LLMClient, _strict_loads

VERSION = "autonomous-brain-offline-llm-replay/v1"
NETWORK_ENTRY_POINTS = (
    "urllib.request.urlopen", "urllib.request.OpenerDirector.open",
    "http.client.HTTPConnection.request", "http.client.HTTPConnection.connect",
    "http.client.HTTPSConnection.connect", "socket.create_connection",
    "socket.socket.connect", "socket.socket.connect_ex", "socket.socket.sendto",
    "socket.getaddrinfo",
)


def read_lines(path):
    rows = [_strict_loads(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()]
    if not rows or any(not isinstance(row, dict) for row in rows):
        raise ValueError(f"Expected nonempty JSON object records: {path.name}")
    return rows


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)


def without_mode(record):
    return {key: value for key, value in record.items() if key != "mode"}


def error_record(exc):
    return {"type": type(exc).__name__, "message": str(exc)}


class BlockedEnvironment:
    """Fail instead of accessing even one process environment variable."""

    def __init__(self):
        self.attempts = 0

    def deny(self, *args, **kwargs):
        self.attempts += 1
        raise AssertionError("environment access forbidden in offline LLM replay")

    get = __getitem__ = __iter__ = __contains__ = keys = items = values = deny


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="trial directory or its brain directory")
    parser.add_argument("--out", required=True, help="new directory for replay evidence")
    args = parser.parse_args(argv)
    source, out = Path(args.input).resolve(), Path(args.out).resolve()
    brain = source if (source / "llm.jsonl").is_file() else source / "brain"
    if out.exists():
        raise ValueError("Refusing to overwrite existing replay evidence")
    rounds_path, llm_path = brain / "rounds.jsonl", brain / "llm.jsonl"
    rounds, original = read_lines(rounds_path), read_lines(llm_path)
    for row in rounds:
        if not isinstance(row.get("state"), dict) or "action" not in row or "round" not in row:
            raise ValueError("Every round must contain state, action and round")
        if row["action"] is None:
            result = row.get("result", {})
            if not isinstance(result.get("error_type"), str) or not isinstance(result.get("reason"), str):
                raise ValueError("A round without an action must record its decision error")
    source_files = {"rounds": rounds_path, "original_llm": llm_path}
    summary_path = brain / "summary.json"
    summary = {}
    if summary_path.is_file():
        summary = _strict_loads(summary_path.read_text(encoding="utf-8"))
        source_files["original_summary"] = summary_path
    source_hashes = {name: sha(path) for name, path in source_files.items()}
    llm_source = ROOT / "autonomous_brain/llm.py"
    source_hashes.update(tool=sha(Path(__file__)), llm_client=sha(llm_source))
    out.mkdir(parents=True)
    replay_path = out / "replayed-llm.jsonl"
    rows, replay_error = [], None
    call_count, elapsed, all_consumed = 0, 0.0, False
    environment = BlockedEnvironment()
    with ExitStack() as stack:
        networking = {entry: stack.enter_context(patch(
            entry, side_effect=AssertionError("network forbidden in offline LLM replay")))
            for entry in NETWORK_ENTRY_POINTS}
        stack.enter_context(patch("autonomous_brain.llm.os.environ", new=environment))
        try:
            with LLMClient(log_path=replay_path, replay_path=llm_path) as client:
                for recorded in rounds:
                    actual, error = None, None
                    try:
                        actual = client.decide(recorded["state"])
                    except Exception as exc:
                        error = error_record(exc)
                    # The runner assigns action before executing it. A failed
                    # execution (even BridgeError) is not a failed LLM decision.
                    expected = recorded["action"]
                    expected_error = None if expected is not None else {
                        "type": recorded["result"]["error_type"],
                        "message": recorded["result"]["reason"]}
                    action_match = canonical(actual) == canonical(expected)
                    error_match = error == expected_error
                    count_match = ("llm_call_count" not in recorded
                                   or recorded["llm_call_count"] == client.call_count)
                    rows.append({
                        "round": recorded["round"], "expected_action": expected,
                        "actual_action": actual, "expected_error": expected_error,
                        "actual_error": error, "replayed_call_count": client.call_count,
                        "recorded_call_count": recorded.get("llm_call_count"),
                        "recorded_execution_result": recorded.get("result"),
                        "execution_failed_after_llm_success": expected is not None
                            and recorded.get("result", {}).get("success") is False,
                        "exact_match": action_match and error_match and count_match,
                    })
                call_count, elapsed = client.call_count, client.total_elapsed_s
                try:
                    client.assert_replay_consumed()
                    all_consumed = True
                except Exception as exc:
                    replay_error = error_record(exc)
        except Exception as exc:
            replay_error = error_record(exc)
        network_calls = {entry: mock.call_count for entry, mock in networking.items()}
    replay = read_lines(replay_path) if replay_path.is_file() and replay_path.stat().st_size else []
    mismatched_records = [index for index, (left, right) in enumerate(zip(original, replay), 1)
        if canonical(without_mode(left)) != canonical(without_mode(right)) or right.get("mode") != "replay"]
    records_equal = len(original) == len(replay) and not mismatched_records
    source_unchanged = all(sha(path) == source_hashes[name] for name, path in source_files.items())
    result = {
        "schema": VERSION, "scope": "offline_llm_transcript_replay",
        "task_acceptance": False, "full_simulation_replayed": False,
        "live_model_called": False, "source_brain_directory": relpath(brain, ROOT),
        "original_run": {key: summary.get(key) for key in ("status", "reason", "rounds", "llm_calls")},
        "original_llm_client_sha256": summary.get("source_sha256", {}).get("llm.py"),
        "rows": rows, "recorded_rounds": len(rounds), "replayed_rounds": len(rows),
        "recorded_calls": len(original), "replayed_calls": call_count,
        "all_records_consumed": all_consumed,
        "full_records_equal_except_mode": records_equal,
        "mismatched_record_indexes": mismatched_records, "replay_error": replay_error,
        "recorded_elapsed_s_replayed": elapsed,
        "network_calls": sum(network_calls.values()), "blocked_network_entry_points": network_calls,
        "environment_access_attempts": environment.attempts,
        "source_sha256": source_hashes, "source_evidence_unchanged": source_unchanged,
    }
    result["allPass"] = bool(rows) and all(row["exact_match"] for row in rows) and (
        len(rows) == len(rounds) and records_equal and all_consumed and replay_error is None
        and call_count == len(original) and not result["network_calls"]
        and not environment.attempts and source_unchanged)
    (out / "replay-checks.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out / "README.md").write_text(
        "# 离线模型调用重放\n\n"
        f"重放核验：{'PASS' if result['allPass'] else 'FAIL'}；{len(rows)}/{len(rounds)} 轮，"
        f"{call_count}/{len(original)} 条调用记录。网络调用 {result['network_calls']} 次，"
        f"环境读取尝试 {environment.attempts} 次。\n\n"
        "使用原 rounds.jsonl 的状态重新验证 llm.jsonl 中的模型输出；"
        "除 mode 外完整记录必须一致，且记录必须全部耗尽。已有 action 时，"
        "随后发生的动作执行失败不会误计为模型决策失败。\n\n"
        "这仅验证离线模型记录重放，不执行动作、不重放全仿真，也不代表任务成功。"
        f"原运行状态为 {summary.get('status', '未提供')}，原因：{summary.get('reason', '未提供')}。"
        "原运行结论和证据没有被改写。\n\n"
        "详细比对和源文件 SHA256 见 replay-checks.json；完整回放记录见 replayed-llm.jsonl。\n",
        encoding="utf-8")
    print(json.dumps({"scope": result["scope"], "allPass": result["allPass"],
        "replayed_rounds": len(rows), "replayed_calls": call_count,
        "network_calls": result["network_calls"], "out": relpath(out, ROOT)}, ensure_ascii=False))
    return 0 if result["allPass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
