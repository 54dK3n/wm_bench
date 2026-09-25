"""Bounded transport recovery and legacy replay, using only in-process mocks."""

import hashlib
import http.client
import io
import json
import urllib.error
from unittest.mock import patch

import pytest

from autonomous_brain.llm import LLMClient, LLMOutputError, LLMRequestError


ACTION = {"action": "look_around", "params": {}}
DELAYS = [1, 2, 4, 8, 16]


@pytest.fixture
def state():
    return {"task": "把红球送到绿色存放区", "objects": [],
            "robot": {"holding": False}, "junction_history": [], "recent_actions": []}


@pytest.fixture(autouse=True)
def isolated_configuration():
    settings = {"LLM_BASE_URL": "https://model.example/v1",
                "LLM_API_KEY": "recovery-test-secret", "LLM_MODEL": "configured-model"}
    with patch("autonomous_brain.llm.os.environ.get", side_effect=settings.get), \
            patch("urllib.request.urlopen", side_effect=AssertionError("unmocked network request")):
        yield


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)


def response(content):
    chunk = {"model": "served-model", "choices": [
        {"index": 0, "delta": {"content": content}, "finish_reason": "stop"}]}
    return io.BytesIO(("data: " + json.dumps(chunk, ensure_ascii=False)
                       + "\n\ndata: [DONE]\n\n").encode())


def records(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_default_client_still_stops_after_one_transient_failure(tmp_path, state):
    path = tmp_path / "default.jsonl"
    with patch("urllib.request.urlopen", side_effect=TimeoutError()) as send, \
            patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(path) as client:
            assert client.transport_retries == 0
            with pytest.raises(LLMRequestError):
                client.decide(state)
            assert client.call_count == send.call_count == 1
    sleep.assert_not_called()
    assert records(path)[0]["transport_retry_limit"] == 0


def test_five_retries_exhaust_exactly_six_logged_requests(tmp_path, state):
    path = tmp_path / "exhausted.jsonl"
    errors = [http.client.RemoteDisconnected("recovery-test-secret") for _ in range(6)]
    with patch("urllib.request.urlopen", side_effect=errors) as send, \
            patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(path, transport_retries=5) as client:
            with pytest.raises(LLMRequestError, match="RemoteDisconnected"):
                client.decide(state)
            saved = records(path)  # Every failed request must already be flushed.
            assert client.call_count == send.call_count == len(saved) == 6
            assert client.decision_count == 1
            assert client.total_elapsed_s == sum(row["elapsed_s"] for row in saved)
            with pytest.raises(RuntimeError, match="stopped"):
                client.decide(state)
            assert send.call_count == 6
    assert [call.args[0] for call in sleep.call_args_list] == DELAYS
    assert [row["call_index"] for row in saved] == list(range(1, 7))
    assert [row["transport_retry_index"] for row in saved] == list(range(6))
    assert [row["transport_retry_delay_s"] for row in saved] == [0, *DELAYS]
    assert all(row["transport_retry_limit"] == 5 for row in saved)
    assert all(row["attempt"] == row["decision_index"] == 1 for row in saved)
    assert all(row["action"] is None and row["validation_error"] is None for row in saved)
    assert all(row["transport_error"]["type"] == "RemoteDisconnected" for row in saved)
    assert len({row["request_sha256"] for row in saved}) == 1
    assert len({call.args[0].data for call in send.call_args_list}) == 1
    assert "recovery-test-secret" not in path.read_text()


@pytest.mark.parametrize("success_on", [4, 5, 6])
def test_late_transient_recovery_returns_only_the_successful_action(tmp_path, state, success_on):
    path = tmp_path / "recovered.jsonl"
    replies = [TimeoutError() for _ in range(success_on - 1)] + [response(canonical(ACTION))]
    with patch("urllib.request.urlopen", side_effect=replies) as send, \
            patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(path, transport_retries=5) as client:
            assert client.decide(state) == ACTION
            assert client.call_count == send.call_count == success_on
            assert client.decision_count == 1
    saved = records(path)
    assert len(saved) == success_on
    assert [call.args[0] for call in sleep.call_args_list] == DELAYS[:success_on - 1]
    assert [row["call_index"] for row in saved] == list(range(1, success_on + 1))
    assert [row["transport_retry_index"] for row in saved] == list(range(success_on))
    assert [row["transport_retry_delay_s"] for row in saved] == [0, *DELAYS[:success_on - 1]]
    assert all(row["transport_retry_limit"] == 5 and row["attempt"] == 1 for row in saved)
    assert all(row["action"] is None and row["transport_error"] for row in saved[:-1])
    assert saved[-1]["action"] == ACTION
    assert saved[-1]["transport_error"] is saved[-1]["validation_error"] is None
    assert len({row["request_sha256"] for row in saved}) == 1
    assert len({call.args[0].data for call in send.call_args_list}) == 1
    replay_path = tmp_path / "replayed-recovery.jsonl"
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("read environment")) as env, \
            patch("urllib.request.urlopen", side_effect=AssertionError("replay contacted network")) as networking, \
            patch("autonomous_brain.llm.time.sleep", side_effect=AssertionError("replay slept")) as replay_sleep:
        with LLMClient(replay_path, replay_path=path) as replay:
            assert replay.transport_retries == 5
            assert replay.decide(state) == ACTION
            assert replay.call_count == success_on
            assert replay.total_elapsed_s == sum(row["elapsed_s"] for row in saved)
            replay.assert_replay_consumed()
    env.assert_not_called()
    networking.assert_not_called()
    replay_sleep.assert_not_called()
    assert records(replay_path) == [dict(row, mode="replay") for row in saved]


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
def test_permanent_http_failure_does_not_use_the_expanded_retry_budget(tmp_path, state, status):
    path = tmp_path / "permanent.jsonl"
    body = b'{"error":{"message":"permanent test failure"}}'
    error = urllib.error.HTTPError("https://model.example/v1/chat/completions", status,
                                   "permanent", {}, io.BytesIO(body))
    with patch("urllib.request.urlopen", side_effect=error) as send, \
            patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(path, transport_retries=5) as client:
            with pytest.raises(LLMRequestError, match=f"HTTP {status}"):
                client.decide(state)
            assert client.call_count == send.call_count == 1
            with pytest.raises(RuntimeError, match="stopped"):
                client.decide(state)
            assert send.call_count == 1
    sleep.assert_not_called()
    saved, = records(path)
    assert saved["transport_error"] == {"type": "HTTPError", "status": status}
    assert saved["response_body"] == body.decode()
    assert saved["transport_retry_index"] == saved["transport_retry_delay_s"] == 0
    assert saved["action"] is None


@pytest.mark.parametrize("failures_before_each_output", [0, 5])
def test_expanded_transport_budget_still_allows_only_one_json_repair(
        tmp_path, state, failures_before_each_output):
    path = tmp_path / "invalid-outputs.jsonl"
    replies = ([TimeoutError() for _ in range(failures_before_each_output)]
               + [response("invalid first output")]
               + [http.client.RemoteDisconnected() for _ in range(failures_before_each_output)]
               + [response("invalid repaired output")])
    calls_per_output = failures_before_each_output + 1
    with patch("urllib.request.urlopen", side_effect=replies) as send, \
            patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(path, transport_retries=5) as client:
            with pytest.raises(LLMOutputError, match="one repair"):
                client.decide(state)
            assert client.call_count == send.call_count == 2 * calls_per_output
            assert client.decision_count == 1
            with pytest.raises(RuntimeError, match="stopped"):
                client.decide(state)
            assert send.call_count == 2 * calls_per_output
    saved = records(path)
    assert len(saved) == 2 * calls_per_output
    assert [row["attempt"] for row in saved] == [1] * calls_per_output + [2] * calls_per_output
    assert [row["transport_retry_index"] for row in saved] == list(range(calls_per_output)) * 2
    assert [call.args[0] for call in sleep.call_args_list] == DELAYS[:failures_before_each_output] * 2
    assert sum(row["validation_error"] is not None for row in saved) == 2
    assert all(row["action"] is None for row in saved)
    assert len({row["request_sha256"] for row in saved}) == 2
    initial, repair = saved[:calls_per_output], saved[calls_per_output:]
    assert all(row["request"] == initial[0]["request"] for row in initial)
    assert all(row["request"] == repair[0]["request"] for row in repair)
    assert len(initial[0]["request"]["messages"]) == 2
    assert len(repair[0]["request"]["messages"]) == 4
    assert repair[0]["request"]["messages"][2] == {
        "role": "assistant", "content": "invalid first output"}


def v11_transcript(state, retry_limit, recovered):
    """Construct the old schema independently, without v12 diagnostics."""
    request = {"model": "legacy-model", "temperature": 0,
               "response_format": {"type": "json_object"}, "stream": True,
               "messages": [{"role": "system", "content": "Recorded v11 prompt."},
                            {"role": "user", "content": canonical(state)}]}
    raw = canonical(ACTION)
    success_body = response(raw).getvalue().decode()
    rows = []
    for index in range(retry_limit + 1):
        succeeded = recovered and index == retry_limit
        rows.append({
            "version": "autonomous-brain-llm/v11", "call_index": index + 1,
            "decision_index": 1, "attempt": 1, "mode": "live", "request": request,
            "request_sha256": hashlib.sha256(canonical(request).encode()).hexdigest(),
            "response_body": success_body if succeeded else None,
            "response_model": "served-model" if succeeded else None,
            "raw_output": raw if succeeded else None, "action": ACTION if succeeded else None,
            "validation_error": None, "transport_error": None if succeeded else {"type": "URLError"},
            "elapsed_s": (index + 1) / 8, "transport_timeout_s": 180,
            "transport_retry_limit": retry_limit, "transport_retry_index": index,
            "transport_retry_delay_s": [0, 1, 2][index],
        })
    return rows


@pytest.mark.parametrize("retry_limit", [0, 2])
@pytest.mark.parametrize("recovered", [False, True], ids=["exhausted", "recovered"])
def test_v11_replay_keeps_old_budget_and_every_field_except_mode(
        tmp_path, state, retry_limit, recovered):
    source, destination = tmp_path / "v11.jsonl", tmp_path / "replayed.jsonl"
    original = v11_transcript(state, retry_limit, recovered)
    source_text = "".join(canonical(row) + "\n" for row in original)
    source.write_text(source_text)
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("read environment")) as env, \
            patch("urllib.request.urlopen", side_effect=AssertionError("replay contacted network")) as send, \
            patch("autonomous_brain.llm.time.sleep", side_effect=AssertionError("replay slept")) as sleep:
        with LLMClient(destination, replay_path=source, transport_retries=5) as client:
            assert client.transport_retries == retry_limit
            if recovered:
                assert client.decide(state) == ACTION
            else:
                with pytest.raises(LLMRequestError, match="LLM request failed: URLError; see transcript"):
                    client.decide(state)
            assert client.call_count == retry_limit + 1
            assert client.decision_count == 1
            assert client.total_elapsed_s == sum(row["elapsed_s"] for row in original)
            client.assert_replay_consumed()
    env.assert_not_called()
    send.assert_not_called()
    sleep.assert_not_called()
    assert source.read_text() == source_text
    assert records(destination) == [dict(row, mode="replay") for row in original]
