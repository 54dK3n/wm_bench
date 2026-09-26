#!/usr/bin/env python3
"""Pure-memory completion review. No credential reads or real network calls.

Capture once: python3 -B review.py --capture
Recompute from the saved code snapshots: python3 -B review.py
"""
from __future__ import annotations

import argparse
import hashlib
from io import BytesIO, StringIO
import json
from pathlib import Path
import random
import subprocess

BASE_COMMIT = "d049ec79bfbc2187f182ada3444d20d1244e84bb"
SOURCE_PATH = "autonomous_brain/llm.py"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SEED = 44


def sha(source):
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def capture_sources():
    old = subprocess.check_output(
        ["git", "show", f"{BASE_COMMIT}:{SOURCE_PATH}"], cwd=ROOT, text=True)
    new = (ROOT / SOURCE_PATH).read_text(encoding="utf-8")
    for filename, source in (("baseline-llm-v13.py", old), ("candidate-llm-v14.py", new)):
        with (HERE / filename).open("x", encoding="utf-8") as destination:
            destination.write(source)


def review():
    old_source = (HERE / "baseline-llm-v13.py").read_text(encoding="utf-8")
    new_source = (HERE / "candidate-llm-v14.py").read_text(encoding="utf-8")
    old, new = {"__name__": "audit_old"}, {"__name__": "audit_new"}
    exec(compile(old_source, "baseline-llm-v13.py", "exec"), old)
    exec(compile(new_source, "candidate-llm-v14.py", "exec"), new)
    action = json.dumps({"action": "explore", "params": {}})

    def frame(finish=None, content=action):
        return "data: " + json.dumps({"model": "dummy", "choices": [
            {"index": 0, "delta": {"content": content}, "finish_reason": finish}
        ]}) + "\n\n"

    base = frame(None) + frame("stop", "")
    cases = {
        "stop_and_complete_done": base + "data: [DONE]\n\n",
        "stop_and_unterminated_done": base + "data: [DONE]",
        "stop_and_one_newline_done": base + "data: [DONE]\n",
        "stop_and_crlf_done": base + "data: [DONE]\r\n\r\n",
        "stop_and_cr_done": base + "data: [DONE]\r\r",
        "length_and_complete_done": frame("length") + "data: [DONE]\n\n",
        "content_filter": frame("content_filter") + "data: [DONE]\n\n",
        "tool_calls_finish": frame("tool_calls") + "data: [DONE]\n\n",
        "missing_finish": frame(None) + "data: [DONE]\n\n",
        "duplicate_stop": base + frame("stop", "") + "data: [DONE]\n\n",
        "choice_after_stop": base + frame(None, "") + "data: [DONE]\n\n",
        "usage_after_stop": base + 'data: {"choices": [], "usage": {}}\n\ndata: [DONE]\n\n',
        "done_then_choice": base + "data: [DONE]\n\n" + frame(None, ""),
    }
    expected_valid = {"stop_and_complete_done", "stop_and_crlf_done",
                      "stop_and_cr_done", "usage_after_stop"}
    explicit_results = []
    for name, body in cases.items():
        raw, model, done, error = new["LLMClient"]._decode_stream(body)
        valid = done and error is None
        assert valid == (name in expected_valid), name
        assert (old["LLMClient"]._decode_stream(body)
                == new["LLMClient"]._decode_stream(body, require_stop=False)), name
        explicit_results.append({"case": name, "body_sha256": sha(body),
                                 "could_validate_action": valid, "done": done, "error": error})

    rng = random.Random(SEED)
    parts = [frame(None), frame("stop", ""), frame("length", ""),
             "data: [DONE]\n\n", "data: [DONE]", ":comment\n\n", "\n",
             "event:message\n", "data: {}\n\n",
             'data: {"choices":[],"usage":{}}\n\n']
    corpus = hashlib.sha256()
    for number in range(3000):
        body = "".join(rng.choice(parts) for _ in range(rng.randrange(0, 8)))
        body += rng.choice(["", "\n", "\r", "\r\n"])
        if rng.random() < .3:
            body = body.replace("\n", rng.choice(["\r", "\r\n"]))
        encoded = body.encode("utf-8")
        corpus.update(len(encoded).to_bytes(8, "big"))
        corpus.update(encoded)
        assert (old["LLMClient"]._decode_stream(body)
                == new["LLMClient"]._decode_stream(body, require_stop=False)), number

    reasons = ["stop", "length", "content_filter", "tool_calls", None, False, {}, []]
    nonstream_results = []
    for reason in reasons:
        body = json.dumps({"choices": [{"message": {"content": action}, "finish_reason": reason}]})
        raw, model, error = new["LLMClient"]._decode_response(body)
        assert (error is None) == (reason == "stop")
        assert (old["LLMClient"]._decode_response(body)
                == new["LLMClient"]._decode_response(body, require_stop=False)[:2])
        nonstream_results.append({"finish_reason": reason, "could_validate_action": error is None,
                                  "error": error})

    class Response(BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.close()

    def client():
        # Bypass __init__: no environment reads, files, or real credentials.
        result = new["LLMClient"].__new__(new["LLMClient"])
        result._replay = None
        result._replay_cursor = 0
        result.transport_retries = 0
        result.call_count = 0
        result.decision_count = 1
        result.total_elapsed_s = 0
        result.timeout_s = 1
        result._base_url = "https://synthetic.invalid"
        result._api_key = "synthetic-only"
        result._log = StringIO()
        return result

    state = {"task": "synthetic review", "objects": [], "robot": {},
             "junction_history": [], "recent_actions": []}
    saved = new["urllib"].request.urlopen
    live_results = []
    try:
        for stream in [False, True]:
            for reason in reasons:
                choice = {"index": 0, "finish_reason": reason}
                if stream:
                    choice["delta"] = {"content": action}
                    body = "data: " + json.dumps({"choices": [choice]}) + "\n\ndata: [DONE]\n\n"
                else:
                    choice["message"] = {"content": action}
                    body = json.dumps({"choices": [choice]})
                new["urllib"].request.urlopen = lambda request, timeout: Response(body.encode())
                result = client()._call({"stream": stream}, state, 1)
                assert (result["action"] is not None) == (reason == "stop"), (stream, reason)
                assert (result["validation_error"] is None) == (reason == "stop")
                assert result["transport_error"] is None
                live_results.append({"stream": stream, "finish_reason": reason,
                                     "action": result["action"],
                                     "validation_error": result["validation_error"]})
    finally:
        new["urllib"].request.urlopen = saved

    capabilities = {}
    for name in ["EXTENDED_RETRY_VERSIONS", "RETRY_METADATA_REQUIRED_VERSIONS",
                 "DIAGNOSTICS_REQUIRED_VERSIONS"]:
        assert new[name] == old[name] | {new["VERSION"]}, name
        capabilities[name] = {"before": sorted(old[name]), "after": sorted(new[name])}
    assert new["NORMAL_FINISH_REQUIRED_VERSIONS"] == {new["VERSION"]}
    for name in ["RETRYABLE_TRANSPORT_ERRORS", "RETRYABLE_HTTP_STATUSES"]:
        assert new[name] == old[name], name
        capabilities[name] = sorted(new[name])
    assert new["SUPPORTED_TRANSCRIPT_VERSIONS"] == old["SUPPORTED_TRANSCRIPT_VERSIONS"] | {new["VERSION"]}
    return {
        "review": "deepseek-finish-v14-independent-review/v1", "passed": True,
        "base_commit": BASE_COMMIT, "source_path": SOURCE_PATH,
        "baseline": {"version": old["VERSION"], "sha256": sha(old_source), "file": "baseline-llm-v13.py"},
        "candidate": {"version": new["VERSION"], "sha256": sha(new_source), "file": "candidate-llm-v14.py"},
        "network_calls": 0, "credentials_read": False,
        "legacy_stream_equivalence": {"total": len(cases) + 3000, "explicit_cases": len(cases),
            "generated_cases": 3000, "seed": SEED, "mismatches": 0,
            "generated_corpus_sha256": corpus.hexdigest(),
            "algorithm": "Python random.Random(44); see review.py; corpus hash uses 8-byte big-endian byte length then UTF-8 body for each generated case"},
        "explicit_stream_results": explicit_results,
        "nonstream_results": {"total": len(nonstream_results), "mismatches": 0, "cases": nonstream_results},
        "synthetic_live_call_results": {"total": len(live_results),
            "abnormal_finish_produced_action": 0, "cases": live_results},
        "capabilities": capabilities,
        "limits": ["Legacy comparison uses saved HEAD v13 decoder semantics with require_stop=False; it is not a replay of every historical v1-v13 transcript.",
                   "Pure-memory urlopen replacement checks _call behavior; no actual provider/HTTP transport, robot action, or task execution occurred.",
                   "Live transport stops reading at the first complete DONE event; rejection of data after DONE applies to bytes supplied to the decoder, not unread provider bytes."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", action="store_true")
    args = parser.parse_args()
    if args.capture:
        capture_sources()
    result = review()
    print(json.dumps(result, ensure_ascii=False, indent=2))
