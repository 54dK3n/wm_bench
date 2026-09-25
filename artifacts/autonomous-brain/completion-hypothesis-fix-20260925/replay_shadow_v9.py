"""Verify saved v9 model calls with the candidate client; never run actions."""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SHADOW = Path(sys.argv[1]).resolve()
BRAIN = (ROOT / sys.argv[2]).resolve()
OUT = (ROOT / sys.argv[3]).resolve()
if OUT.exists():
    raise ValueError("Refusing to overwrite evidence")
OUT.mkdir(parents=True)
sys.dont_write_bytecode = True
sys.path.insert(0, str(SHADOW))
from autonomous_brain import llm
assert Path(llm.__file__).is_relative_to(SHADOW)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def records(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

original = records(BRAIN / "llm.jsonl")
rounds = records(BRAIN / "rounds.jsonl")
assert {row["version"] for row in original} == {"autonomous-brain-llm/v9"}
sources = {"llm.jsonl": sha(BRAIN / "llm.jsonl"), "rounds.jsonl": sha(BRAIN / "rounds.jsonl")}
blocked = ("urllib.request.urlopen", "urllib.request.OpenerDirector.open",
           "http.client.HTTPConnection.request", "http.client.HTTPConnection.connect",
           "http.client.HTTPSConnection.connect", "socket.create_connection",
           "socket.socket.connect", "socket.socket.connect_ex", "socket.getaddrinfo")
checks = []
with ExitStack() as stack:
    guards = {name: stack.enter_context(patch(name, side_effect=AssertionError("network forbidden")))
              for name in blocked}
    environment = stack.enter_context(patch.object(llm.os, "environ"))
    for name in ("get", "__getitem__", "__contains__", "__iter__", "keys", "items", "values"):
        getattr(environment, name).side_effect = AssertionError("environment forbidden")
    sleep = stack.enter_context(patch.object(llm.time, "sleep", side_effect=AssertionError("sleep forbidden")))
    with llm.LLMClient(OUT / "replayed-llm.jsonl", replay_path=BRAIN / "llm.jsonl") as client:
        for row in rounds:
            actual, error = None, None
            try:
                actual = client.decide(row["state"])
            except Exception as exc:
                error = {"type": type(exc).__name__, "message": str(exc)}
            expected_error = None if row["action"] is not None else {
                "type": row["result"]["error_type"], "message": row["result"]["reason"]}
            checks.append({"round": row["round"], "action_equal": actual == row["action"],
                           "decision_error_equal": error == expected_error,
                           "call_count_equal": client.call_count == row["llm_call_count"]})
        client.assert_replay_consumed()
        call_count, elapsed = client.call_count, client.total_elapsed_s
    network_attempts = sum(guard.call_count for guard in guards.values())
    environment_attempts = len(environment.mock_calls)
    sleep_attempts = sleep.call_count
replayed = records(OUT / "replayed-llm.jsonl")
without_mode = lambda row: {key: value for key, value in row.items() if key != "mode"}
same = [without_mode(row) for row in original] == [without_mode(row) for row in replayed]
unchanged = all(sha(BRAIN / name) == digest for name, digest in sources.items())
result = {"scope": "offline_llm_transcript_replay", "task_acceptance": False,
          "full_simulation_replayed": False, "source_brain_directory": os.path.relpath(BRAIN, ROOT),
          "client_source": os.path.relpath(llm.__file__, ROOT), "client_sha256": sha(Path(llm.__file__)),
          "client_version": llm.VERSION, "source_sha256": sources,
          "source_evidence_unchanged": unchanged, "rounds": len(rounds), "calls": call_count,
          "all_records_consumed": True, "full_records_equal_except_mode": same,
          "network_attempts": network_attempts, "environment_attempts": environment_attempts,
          "sleep_attempts": sleep_attempts, "recorded_elapsed_s_replayed": elapsed, "checks": checks}
result["allPass"] = (same and unchanged and len(original) == call_count
                     and all(all(value for key, value in check.items() if key != "round") for check in checks)
                     and not network_attempts and not environment_attempts and not sleep_attempts)
(OUT / "checks.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({key: value for key, value in result.items() if key != "checks"}, ensure_ascii=False))
raise SystemExit(0 if result["allPass"] else 1)
