"""Explicit provider setup check: synthetic image and wholly fictional state.

Credentials are read only from the ignored local configuration. Headers and
credential values are never recorded. Production and historical logs stay intact.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import time
import urllib.error
import urllib.request
import zlib

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT))
from autonomous_brain.llm import LLMClient


def save(path, data):
    with path.open("x", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def main():
    config = {}
    for line in (ROOT / ".env.local").read_text().splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            config[key.strip()] = value.strip().strip("\"'")
    assert config["LLM_BASE_URL"] == "https://api.deepseek.com/v1"
    assert config["LLM_MODEL"] == "deepseek-flash"
    secret = config["LLM_API_KEY"]

    def call(name, endpoint, payload=None):
        if payload is not None:
            save(HERE / (name + "-request.json"), payload)
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
        request = urllib.request.Request(config["LLM_BASE_URL"] + endpoint, data=body,
            headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json"})
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                status, raw = response.status, response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read().decode("utf-8", errors="replace")
        elapsed = time.monotonic() - started
        if secret in raw:
            raise RuntimeError("Provider echoed a credential; response not recorded")
        save(HERE / (name + "-response.json"), {"status": status, "elapsed_s": elapsed, "body": raw})
        if status != 200:
            print(json.dumps({"step": name, "status": status, "passed": False}))
            raise SystemExit(1)
        return raw, elapsed

    raw, _ = call("models", "/models")
    available = [item["id"] for item in json.loads(raw)["data"]]
    assert config["LLM_MODEL"] in available, "Selected vision model absent from account model list"
    print(json.dumps({"step": "models", "selected_model": config["LLM_MODEL"], "available": True}), flush=True)

    expected = {"top_left": "yellow", "top_right": "blue", "bottom_left": "green", "bottom_right": "red"}
    colors = [(255, 255, 0), (0, 0, 255), (0, 180, 0), (255, 0, 0)]
    scanlines = bytearray()
    for y in range(512):
        scanlines.append(0)
        for x in range(512):
            row, col = int(y >= 256), int(x >= 256)
            inside = 24 <= x % 256 < 232 and 24 <= y % 256 < 232
            scanlines.extend(colors[row * 2 + col] if inside else (255, 255, 255))

    def chunk(kind, payload):
        return struct.pack("!I", len(payload)) + kind + payload + struct.pack("!I", zlib.crc32(kind + payload))

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!2I5B", 512, 512, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(scanlines))) + chunk(b"IEND", b"")
    with (HERE / "vision-fixture.png").open("xb") as f:
        f.write(png)
    payload = {"model": config["LLM_MODEL"], "temperature": 0, "thinking": {"type": "disabled"},
        "stream": True, "max_tokens": 128, "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": "Read the provided image. Respond only in JSON."},
            {"role": "user", "content": [
                {"type": "text", "text": "Identify the color of the four large squares in the image. Return JSON with keys top_left, top_right, bottom_left, bottom_right and basic English color names as values. Ignore the white background."},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()}}]}]}
    raw, elapsed = call("vision", "/chat/completions", payload)
    decoded, response_model, done, error = LLMClient._decode_stream(raw)
    answer = json.loads(decoded) if decoded is not None else None
    passed = answer == expected and done and not error
    save(HERE / "vision-check.json", {"version": "deepseek-provider-vision-check/v1", "pass": passed,
        "requested_model": config["LLM_MODEL"], "response_model": response_model,
        "temperature": 0, "thinking": "disabled", "stream": True, "elapsed_s": elapsed,
        "expected": expected, "actual": answer, "sse_done": done, "sse_error": error,
        "fixture_sha256": hashlib.sha256(png).hexdigest(),
        "scope": "Synthetic image capability test, not a robot task or camera pipeline test"})
    print(json.dumps({"step": "vision", "pass": passed, "response_model": response_model, "answer": answer}), flush=True)
    if not passed:
        raise SystemExit(1)

    # Entirely invented fixture; never read historical robot logs or positions.
    # The production system prompt is already published on the user's GitHub.
    state = {"task": "Synthetic connection test: explore the fictional road.",
        "round": 1, "simulation_seconds": 0, "objects": [],
        "robot": {"pose": {"right_cm": 0, "forward_cm": 0, "heading_deg": 0},
            "holding": False, "at_node": False, "at_junction": False,
            "on_road": True, "exit_angles": [], "exits": [],
            "front_clearance_cm": 100},
        "junction_history": [], "exploration_hints": [],
        "unexplored_exit_count": 1, "observed_junction_count": 0, "recent_actions": []}
    save(HERE / "synthetic-state.json", state)
    for key in ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_TEMPERATURE", "LLM_THINKING"):
        os.environ[key] = config[key]
    with LLMClient(log_path=HERE / "brain-probe.jsonl") as client:
        action = client.decide(state)
        save(HERE / "brain-probe-check.json", {"version": "deepseek-brain-client-check/v1", "pass": True,
            "action": action, "action_executed": False, "llm_calls": client.call_count,
            "llm_total_elapsed_s": client.total_elapsed_s,
            "input_kind": "wholly fictional JSON fixture; no historical state or image input to production planner"})
        print(json.dumps({"step": "brain_client", "pass": True, "calls": client.call_count, "action_executed": False}))


if __name__ == "__main__":
    main()
