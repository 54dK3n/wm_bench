"""One logged model-only retry of an unchanged failed request; no robot access."""
from pathlib import Path
import hashlib
import json
import os
import sys
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from autonomous_brain.llm import LLMClient, LLMRequestError, _canonical

VERSION = "kimi-failed-request-probe/v1"

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    out = Path(__file__).parent / "request-01"
    out.mkdir(exist_ok=False)
    for raw in (ROOT / ".env.local").read_text().splitlines():
        if not raw.strip() or raw.lstrip().startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        if key.strip() in {"LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_TEMPERATURE", "LLM_THINKING"}:
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))
    assert urlparse(os.environ["LLM_BASE_URL"]).hostname == "api.moonshot.cn"
    source = ROOT / "artifacts/autonomous-brain/map05-run-16/map-05-run-1/brain/llm.jsonl"
    record = json.loads(source.read_text().splitlines()[-1])
    assert record["call_index"] == 22 and record["decision_index"] == 20
    assert record["transport_error"] == {"type": "HTTPError", "status": 502}
    request = record["request"]
    request_sha = hashlib.sha256(_canonical(request).encode()).hexdigest()
    assert request_sha == record["request_sha256"]
    state = json.loads(request["messages"][1]["content"])
    sources = {str(p.relative_to(ROOT)): sha(p) for p in sorted((ROOT / "autonomous_brain").glob("*.py"))}
    result = {"version": VERSION, "source": str(source.relative_to(ROOT)),
              "source_sha256": sha(source), "source_call": 22, "source_decision": 20,
              "request_sha256": request_sha, "robot_calls": 0,
              "purpose": "unchanged-request recovery diagnostic; not a trial or resumed robot action",
              "sources_before": sources}
    with LLMClient(log_path=out / "llm.jsonl", transport_retries=0) as client:
        client.decision_count = 1
        try:
            reply = client._call(request, state, attempt=1)
            result.update(status="response_received", action=reply["action"], validation_error=reply["validation_error"])
        except LLMRequestError:
            result.update(status="transport_failed", transport_error=client.last_record["transport_error"])
        result.update(elapsed_s=client.last_record["elapsed_s"],
                      request_unchanged=client.last_record["request_sha256"] == request_sha,
                      model_calls=client.call_count)
    result["sources_after"] = {str(p.relative_to(ROOT)): sha(p) for p in sorted((ROOT / "autonomous_brain").glob("*.py"))}
    result["sources_unchanged"] = result["sources_before"] == result["sources_after"]
    result["transcript_sha256"] = sha(out / "llm.jsonl")
    (out / "summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: result[k] for k in ["status", "elapsed_s", "request_unchanged", "model_calls", "robot_calls", "sources_unchanged"]}))

if __name__ == "__main__":
    main()
