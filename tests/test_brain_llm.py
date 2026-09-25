"""LLM boundary tests with an in-process HTTP mock; never contact a model."""

import io
import http.client
import json
from pathlib import Path
import urllib.error
from unittest.mock import patch

import pytest

from autonomous_brain.llm import (ActionValidationError, LLMClient, LLMOutputError,
                                  LLMRequestError, ReplayError, validate_action)


@pytest.fixture
def state():
    return {"task": "把地图上的红球都送到绿色存放区", "objects": [
        {"id": "wm-1", "category": "red-ball", "status": "CONFIRMED"},
        {"id": "wm-2", "category": "green-storage", "status": "tentative"}],
        "robot": {"holding": False}, "junction_history": [], "recent_actions": []}


@pytest.fixture(autouse=True)
def config(monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "https://model.example/v1/")
    monkeypatch.setenv("LLM_API_KEY", "never-record-this-key")
    monkeypatch.setenv("LLM_MODEL", "configured-model")


def response(content, **extra):
    return io.BytesIO(json.dumps({"model": "served-model", "choices": [
        {"message": {"content": content}}], **extra}).encode())


def records(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines()]


def test_request_contract_complete_flushed_record_and_recent_five(tmp_path, state):
    state["recent_actions"] = [{"round": value} for value in range(8)]
    raw = '{"action":"go_to","params":{"object_id":"wm-1"}}'
    path = tmp_path / "calls.jsonl"
    with patch("urllib.request.urlopen", return_value=response(raw)) as send:
        with LLMClient(path) as client:
            assert client.decide(state) == json.loads(raw)
            assert client.call_count == client.decision_count == 1
            assert client.total_elapsed_s >= 0
            saved = records(path)[0]  # visible even before close
            request = send.call_args.args[0]
            body = json.loads(request.data)
            assert request.full_url == "https://model.example/v1/chat/completions"
            assert request.headers["Authorization"] == "Bearer never-record-this-key"
            assert body["model"] == "configured-model"
            assert body["temperature"] == 0
            assert body["response_format"] == {"type": "json_object"}
            assert json.loads(body["messages"][1]["content"])["recent_actions"] == state["recent_actions"][-5:]
            assert len(state["recent_actions"]) == 8
            assert saved["request"] == body
            assert saved["raw_output"] == raw
            assert saved["action"] == json.loads(raw)
            assert saved["response_model"] == "served-model"
            assert "never-record-this-key" not in path.read_text()


@pytest.mark.parametrize("action", [
    {"action": "explore", "params": {}},
    {"action": "explore", "params": {"exit_angle": -90.5}},
    {"action": "look_around", "params": {}},
    {"action": "go_to", "params": {"object_id": "wm-1"}},
    {"action": "pick", "params": {"object_id": "wm-1"}},
    {"action": "place", "params": {}},
    {"action": "done", "params": {}},
])
def test_all_actions(action, state):
    assert validate_action(action, state) == action


@pytest.mark.parametrize("action", [
    [], {}, {"action": "done"},
    {"action": "done", "params": {}, "explanation": "ok"},
    {"action": "approach", "params": {}},
    {"action": "done", "params": []},
    {"action": "look_around", "params": {"speed": 3}},
    {"action": "explore", "params": {"exit_angle": True}},
    {"action": "explore", "params": {"exit_angle": float("inf")}},
    {"action": "explore", "params": {"exit_angle": float("nan")}},
    {"action": "explore", "params": {"exit_angle": 10 ** 1000}},
    {"action": "explore", "params": {"exit_angle": "90"}},
    {"action": "explore", "params": {"road_id": "secret"}},
    {"action": "pick", "params": {"object_id": "missing"}},
    {"action": "pick", "params": {"object_id": "wm-2"}},
    {"action": "go_to", "params": {"object_id": "wm-2"}},
    {"action": "go_to", "params": {"object_id": 1}},
    {"action": "pick", "params": {"object_id": " "}},
    {"action": "go_to", "params": {"object_id": "wm-1", "x": 10}},
])
def test_reject_invalid_actions(action, state):
    with pytest.raises(ActionValidationError):
        validate_action(action, state)


def test_repair_once_then_success_and_offline_replay(tmp_path, state, monkeypatch):
    invalid = '{"action":"pick","params":{"object_id":"wm-2"}}'
    valid = '{"action":"explore","params":{}}'
    path = tmp_path / "live.jsonl"
    with patch("urllib.request.urlopen", side_effect=[response(invalid), response(valid)]) as send:
        with LLMClient(path) as live:
            expected = live.decide(state)
            assert send.call_count == live.call_count == 2
            assert live.decision_count == 1
            duration = live.total_elapsed_s
    calls = records(path)
    assert calls[0]["validation_error"] == "pick requires a CONFIRMED object"
    assert calls[1]["request"]["messages"][2]["content"] == invalid
    monkeypatch.delenv("LLM_BASE_URL")
    monkeypatch.delenv("LLM_API_KEY")
    monkeypatch.delenv("LLM_MODEL")
    with patch("urllib.request.urlopen", side_effect=AssertionError("replay contacted network")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as replay:
            assert replay.decide(state) == expected
            assert replay.call_count == 2
            assert replay.total_elapsed_s == duration
            replay.assert_replay_consumed()
    assert [c["request"] for c in records(tmp_path / "replay.jsonl")] == [c["request"] for c in calls]


@pytest.mark.parametrize("invalid", [
    "not json", '```json\n{"action":"done","params":{}}\n```',
    '{"action":"done","action":"place","params":{}}',
    '{"action":"explore","params":{"exit_angle":NaN}}',
    '{"action":"explore","params":{"exit_angle":1e999}}',
    '{"action":"explore","params":{"exit_angle":null}}',
    '[{"action":"done","params":{}}]',
])
def test_invalid_twice_stops_and_is_replayable(tmp_path, state, invalid):
    path = tmp_path / "invalid.jsonl"
    with patch("urllib.request.urlopen", side_effect=[response(invalid), response(invalid)]) as send:
        with LLMClient(path) as live:
            with pytest.raises(LLMOutputError, match="one repair"):
                live.decide(state)
            with pytest.raises(RuntimeError, match="stopped"):
                live.decide(state)
            assert send.call_count == 2
    assert len(records(path)) == 2
    with patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with LLMClient(tmp_path / "replayed.jsonl", replay_path=path) as replay:
            with pytest.raises(LLMOutputError):
                replay.decide(state)
            replay.assert_replay_consumed()


def test_replay_rejects_changed_state_without_network(tmp_path, state):
    path = tmp_path / "live.jsonl"
    with patch("urllib.request.urlopen", return_value=response('{"action":"done","params":{}}')):
        with LLMClient(path) as client:
            client.decide(state)
    state["robot"]["holding"] = True
    with patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as replay:
            with pytest.raises(ReplayError, match="input mismatch"):
                replay.decide(state)
            assert replay.call_count == 0


def test_replay_rejects_altered_logged_action(tmp_path, state):
    path = tmp_path / "live.jsonl"
    with patch("urllib.request.urlopen", return_value=response('{"action":"done","params":{}}')):
        with LLMClient(path) as client:
            client.decide(state)
    saved = records(path)
    saved[0]["action"] = {"action": "place", "params": {}}
    path.write_text(json.dumps(saved[0]) + "\n")
    with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as replay:
        with pytest.raises(ReplayError, match="output validation mismatch"):
            replay.decide(state)


def test_http_failure_stops_logs_and_replays_without_retry(tmp_path, state):
    error = urllib.error.HTTPError("https://model.example", 400, "Bad Request", {},
                                   io.BytesIO(b'{"error":"JSON mode unsupported"}'))
    path = tmp_path / "failure.jsonl"
    with patch("urllib.request.urlopen", side_effect=error) as send:
        with LLMClient(path) as live:
            with pytest.raises(LLMRequestError, match="HTTP 400"):
                live.decide(state)
            assert send.call_count == 1
    saved = records(path)[0]
    assert saved["response_body"] == '{"error":"JSON mode unsupported"}'
    assert saved["transport_error"]["status"] == 400
    with patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as replay:
            with pytest.raises(LLMRequestError):
                replay.decide(state)
            replay.assert_replay_consumed()


def test_timeout_never_logs_exception_credentials(tmp_path, state):
    path = tmp_path / "failure.jsonl"
    with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("never-record-this-key")):
        with LLMClient(path) as client:
            with pytest.raises(LLMRequestError):
                client.decide(state)
    assert "never-record-this-key" not in path.read_text()


def test_incomplete_http_response_is_recorded_and_replayed_without_retry(tmp_path, state):
    path = tmp_path / "incomplete.jsonl"
    error = http.client.IncompleteRead(b'{"choices":[\xff', 20)
    with patch("urllib.request.urlopen", side_effect=error) as send:
        with LLMClient(path) as client:
            with pytest.raises(LLMRequestError, match="IncompleteRead"):
                client.decide(state)
            assert send.call_count == client.call_count == 1
            saved = records(path)[0]
            assert saved["response_body"] == '{"choices":[\ufffd'
            assert saved["transport_error"] == {"type": "IncompleteRead"}
            assert saved["request"]["messages"][1]["content"]
    with patch("urllib.request.urlopen", side_effect=AssertionError("replay contacted network")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as client:
            with pytest.raises(LLMRequestError, match="IncompleteRead"):
                client.decide(state)
            client.assert_replay_consumed()
    replayed = records(tmp_path / "replay.jsonl")[0]
    assert {k: v for k, v in replayed.items() if k != "mode"} == {k: v for k, v in saved.items() if k != "mode"}


def test_http_status_error_with_incomplete_body_is_recorded(tmp_path, state):
    class InterruptedBody(io.BytesIO):
        def read(self, *args, **kwargs):
            raise http.client.IncompleteRead(b'{"error":"\xff', 10)

    path = tmp_path / "incomplete-error.jsonl"
    error = urllib.error.HTTPError("https://model.example", 502, "upstream failed", {}, InterruptedBody())
    with patch("urllib.request.urlopen", side_effect=error) as send:
        with LLMClient(path) as client:
            with pytest.raises(LLMRequestError, match="HTTP 502"):
                client.decide(state)
            assert send.call_count == client.call_count == 1
    saved = records(path)[0]
    assert saved["transport_error"] == {"type": "HTTPError", "status": 502, "body_read_error": "IncompleteRead"}
    assert saved["response_body"] == '{"error":"\ufffd'


def test_http_protocol_exception_without_partial_body_is_recorded(tmp_path, state):
    path = tmp_path / "bad-status.jsonl"
    with patch("urllib.request.urlopen", side_effect=http.client.BadStatusLine("malformed status")) as send:
        with LLMClient(path) as client:
            with pytest.raises(LLMRequestError, match="BadStatusLine"):
                client.decide(state)
            assert send.call_count == client.call_count == 1
    saved = records(path)[0]
    assert saved["response_body"] is None
    assert saved["transport_error"] == {"type": "BadStatusLine"}


def test_v1_transcripts_remain_replayable_without_rewriting_their_version(tmp_path, state):
    path = tmp_path / "v1.jsonl"
    with patch("urllib.request.urlopen", return_value=response('{"action":"look_around","params":{}}')):
        with LLMClient(path) as client:
            client.decide(state)
    saved = records(path)[0]
    saved["version"] = "autonomous-brain-llm/v1"
    path.write_text(json.dumps(saved) + "\n")
    with patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as client:
            assert client.decide(state) == {"action": "look_around", "params": {}}
            client.assert_replay_consumed()
    replayed = records(tmp_path / "replay.jsonl")[0]
    assert {k: v for k, v in replayed.items() if k != "mode"} == {k: v for k, v in saved.items() if k != "mode"}


def test_bad_http_envelope_has_one_repair(tmp_path, state):
    with patch("urllib.request.urlopen", side_effect=[io.BytesIO(b'{}'),
               response('{"action":"look_around","params":{}}')]) as send:
        with LLMClient(tmp_path / "calls.jsonl") as client:
            assert client.decide(state)["action"] == "look_around"
            assert send.call_count == 2


def test_no_tool_calls_are_executed(tmp_path, state):
    payload = {"choices": [{"message": {"content": '{"action":"done","params":{}}',
                "tool_calls": [{"function": {"name": "mission"}}]}}]}
    with patch("urllib.request.urlopen", side_effect=[io.BytesIO(json.dumps(payload).encode()),
               response('{"action":"look_around","params":{}}')]):
        with LLMClient(tmp_path / "calls.jsonl") as client:
            assert client.decide(state)["action"] == "look_around"
            assert client.call_count == 2


def test_nonfinite_state_fails_before_any_request(tmp_path, state):
    state["robot"]["distance"] = float("nan")
    with patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with LLMClient(tmp_path / "calls.jsonl") as client:
            with pytest.raises(ValueError):
                client.decide(state)
            assert client.call_count == 0


def test_replay_must_consume_all_calls(tmp_path, state):
    path = tmp_path / "live.jsonl"
    with patch("urllib.request.urlopen", side_effect=[
            response('{"action":"done","params":{}}'),
            response('{"action":"done","params":{}}')]):
        with LLMClient(path) as live:
            live.decide(state)
            live.decide(state)
    with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as replay:
        replay.decide(state)
        with pytest.raises(ReplayError, match="all recorded calls"):
            replay.assert_replay_consumed()


def test_existing_log_is_never_overwritten(tmp_path):
    path = tmp_path / "existing.jsonl"
    path.write_text("original\n")
    with pytest.raises(FileExistsError):
        LLMClient(path)
    assert path.read_text() == "original\n"
