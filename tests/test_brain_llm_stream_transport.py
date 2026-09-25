"""Exercise real urllib SSE transport using only a random loopback HTTP port."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
from unittest.mock import patch

import pytest

from autonomous_brain.llm import LLMClient, LLMOutputError, LLMRequestError


FAKE_KEY = "local-stream-test-key-not-a-real-credential"


@pytest.fixture
def state():
    return {"task": "把地图上的红球都送到绿色存放区", "objects": [
        {"id": "wm-1", "category": "red-ball", "status": "CONFIRMED"},
        {"id": "wm-2", "category": "storage-zone", "status": "tentative"}],
        "robot": {"holding": False}, "junction_history": [], "recent_actions": []}


def event(payload):
    return "data: " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n\n"


def stream_body(parts, *, done=True, usage=False):
    frames = [event({"id": "local-completion", "model": "local-served-model", "choices": [
        {"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})]
    frames.extend(event({"id": "local-completion", "model": "local-served-model", "choices": [
        {"index": 0, "delta": {"content": part}, "finish_reason": None}]}) for part in parts)
    frames.append(event({"id": "local-completion", "model": "local-served-model", "choices": [
        {"index": 0, "delta": {}, "finish_reason": "stop"}]}))
    if usage:
        frames.append(event({"id": "local-completion", "model": "local-served-model", "choices": [],
                             "usage": {"prompt_tokens": 20, "completion_tokens": 12, "total_tokens": 32}}))
    if done:
        frames.append("data: [DONE]\n\n")
    return "".join(frames).encode("utf-8")


@contextmanager
def local_stream_server(responses):
    """Serve finite HTTP/1.1 streams; EOF is a real connection close."""
    requests = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            requests.append({"path": self.path, "body": json.loads(body),
                             "authorization": self.headers.get("Authorization")})
            index = len(requests) - 1
            if index >= len(responses):
                self.send_response(500)
                self.send_header("Content-Length", "0")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            payload = responses[index]
            try:
                # Socket write boundaries deliberately differ from SSE frames.
                for offset in range(0, len(payload), 23):
                    self.wfile.write(payload[offset:offset + 23])
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                # A reader may close immediately after consuming [DONE].
                pass
            finally:
                self.close_connection = True

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}/v1"
    try:
        # Isolate both model configuration and urllib proxy configuration.
        # Never load a dotenv file or contact an external model endpoint.
        with patch.dict(os.environ, {"LLM_BASE_URL": base_url, "LLM_API_KEY": FAKE_KEY,
                                    "LLM_MODEL": "local-requested-model",
                                    "NO_PROXY": "127.0.0.1,localhost"}, clear=True):
            yield requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        assert not thread.is_alive()


def records(path):
    text = Path(path).read_text(encoding="utf-8")
    assert FAKE_KEY not in text
    return [json.loads(line) for line in text.splitlines()]


def assert_stream_request(request):
    assert request["path"] == "/v1/chat/completions"
    assert request["authorization"] == f"Bearer {FAKE_KEY}"
    assert request["body"]["model"] == "local-requested-model"
    assert request["body"]["stream"] is True
    assert request["body"]["response_format"] == {"type": "json_object"}


def test_real_http_sse_aggregates_deltas_usage_and_done(tmp_path, state):
    parts = ['{"action":', '"look_around",', '"params":{}}']
    raw = "".join(parts)
    payload = stream_body(parts, usage=True)
    log_path = tmp_path / "complete-stream.jsonl"
    with local_stream_server([payload]) as requests:
        with LLMClient(log_path=log_path, timeout_s=3) as client:
            assert client.decide(state) == {"action": "look_around", "params": {}}
            assert client.call_count == client.decision_count == len(requests) == 1
            saved = records(log_path)[0]  # The complete record is already flushed.
            assert_stream_request(requests[0])
            assert saved["version"] == "autonomous-brain-llm/v8"
            assert saved["request"] == requests[0]["body"]
            assert saved["response_body"].rstrip() == payload.decode("utf-8").rstrip()
            assert '"choices":[],"usage":' in saved["response_body"]
            assert saved["raw_output"] == raw
            assert saved["action"] == json.loads(raw)
            assert saved["response_model"] == "local-served-model"
            assert saved["transport_error"] is None
            assert saved["validation_error"] is None


def test_real_http_eof_without_done_logs_partial_and_never_retries_or_returns_action(tmp_path, state):
    # Even a syntactically complete action and finish_reason=stop are not enough.
    raw = '{"action":"pick","params":{"object_id":"wm-1"}}'
    payload = stream_body([raw[:18], raw[18:]], done=False)
    log_path = tmp_path / "incomplete-stream.jsonl"
    executed = []
    with local_stream_server([payload]) as requests:
        with LLMClient(log_path=log_path, timeout_s=3) as client:
            with pytest.raises(LLMRequestError, match="IncompleteStream"):
                action = client.decide(state)
                executed.append(action)  # Consumer executes only a returned action.
            assert executed == []
            assert client.call_count == len(requests) == 1
            assert_stream_request(requests[0])
            saved = records(log_path)
            assert len(saved) == 1
            assert saved[0]["response_body"].rstrip() == payload.decode("utf-8").rstrip()
            assert "[DONE]" not in saved[0]["response_body"]
            assert saved[0]["transport_error"]["type"] == "IncompleteStream"
            assert saved[0]["action"] is None
            assert saved[0]["validation_error"] is None
            with pytest.raises(RuntimeError, match="stopped"):
                client.decide(state)
            assert client.call_count == len(requests) == 1


def test_real_http_complete_invalid_json_has_only_one_repair_request(tmp_path, state):
    invalid = ["not a JSON object", '{"action":"look_around","params":']
    payloads = [stream_body([text], done=True) for text in invalid]
    log_path = tmp_path / "invalid-streams.jsonl"
    executed = []
    with local_stream_server(payloads) as requests:
        with LLMClient(log_path=log_path, timeout_s=3) as client:
            with pytest.raises(LLMOutputError, match="one repair"):
                action = client.decide(state)
                executed.append(action)
            assert executed == []
            assert client.call_count == len(requests) == 2
            saved = records(log_path)
            assert len(saved) == 2
            assert [record["attempt"] for record in saved] == [1, 2]
            assert [record["raw_output"] for record in saved] == invalid
            for request, record, payload in zip(requests, saved, payloads):
                assert_stream_request(request)
                assert record["response_body"].rstrip() == payload.decode("utf-8").rstrip()
                assert record["transport_error"] is None
                assert record["validation_error"]
                assert record["action"] is None
            assert len(requests[0]["body"]["messages"]) == 2
            repair_messages = requests[1]["body"]["messages"]
            assert len(repair_messages) == 4
            assert repair_messages[-2] == {"role": "assistant", "content": invalid[0]}
            assert repair_messages[-1]["role"] == "user"
            with pytest.raises(RuntimeError, match="stopped"):
                client.decide(state)
            assert client.call_count == len(requests) == 2
