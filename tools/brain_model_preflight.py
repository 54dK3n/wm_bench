#!/usr/bin/env python3
"""One isolated availability request, without a robot or task execution."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from autonomous_brain.llm import LLMClient, LLMRequestError


def perform(out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    result = {"schema": "brain-model-availability/v1", "formal_task": False,
              "robot_started": False, "max_requests": 1, "available": False}
    try:
        with LLMClient(out / "llm.jsonl", timeout_s=60, transport_retries=0) as client:
            result["configuration"] = client.validate_formal_configuration()
            result["configuration"]["formal_run"] = False
            request = {"model": client.model, "temperature": client.temperature,
                "thinking": {"type": client.thinking}, "stream": client.stream,
                "response_format": {"type": "json_object"}, "messages": [
                    {"role": "system", "content": "This is an isolated service availability check. No robot is connected. Return exactly the requested JSON."},
                    {"role": "user", "content": '{"action":"look_around","params":{}}'}]}
            client.decision_count = 1
            try:
                # Exactly one request: no transport retry or output repair.
                record = client._call(request, {"objects": []}, 1)
                result["available"] = (record["validation_error"] is None
                    and record["action"] == {"action": "look_around", "params": {}})
            except LLMRequestError:
                pass
            record = client.last_record or {}
            result.update(request_count=client.call_count,
                          transport_error=record.get("transport_error"),
                          validation_error=record.get("validation_error"),
                          elapsed_s=client.total_elapsed_s)
    except Exception as exc:
        # Configuration and endpoint exception text can contain credentials.
        result["failure_type"] = type(exc).__name__
    result["next_step"] = ("eligible_for_remaining_formal_gates" if result["available"]
                           else "stop_without_formal_run_or_service_changes")
    (out / "RESULT.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    result = perform(parser.parse_args().out)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["available"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
