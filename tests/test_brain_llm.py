"""LLM boundary tests with an in-process HTTP mock; never contact a model."""

import hashlib
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
    monkeypatch.delenv("LLM_TEMPERATURE", raising=False)
    monkeypatch.delenv("LLM_THINKING", raising=False)


def sse_response(chunks, *, done=True):
    body = "".join("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n" for chunk in chunks)
    return io.BytesIO((body + ("data: [DONE]\n\n" if done else "")).encode())


def response(content, *, stream=True, **extra):
    if stream:
        return sse_response([{"model": "served-model", "choices": [
            {"index": 0, "delta": {"content": content}, "finish_reason": "stop"}], **extra}])
    return io.BytesIO(json.dumps({"model": "served-model", "choices": [
        {"message": {"content": content}, "finish_reason": "stop"}], **extra}).encode())


def legacy_record(saved, version):
    saved["version"] = version
    number = int(version.rsplit("v", 1)[1])
    if number < 12:
        saved.pop("transport_diagnostics", None)
    if number < 6:
        saved["request"].pop("stream", None)
    saved["request_sha256"] = hashlib.sha256(json.dumps(saved["request"],
        ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    if number < 5:
        saved.pop("transport_timeout_s", None)
    if number < 7:
        for key in ("transport_retry_limit", "transport_retry_index", "transport_retry_delay_s"):
            saved.pop(key, None)
    return saved


def records(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines()]


def test_replay_restores_recorded_prompt_after_live_prompt_revision(tmp_path, state, monkeypatch):
    import autonomous_brain.llm as module
    source = tmp_path / "old-prompt.jsonl"
    with patch("urllib.request.urlopen", return_value=response('{"action":"explore","params":{}}')):
        with LLMClient(source) as live:
            expected = live.decide(state)
    monkeypatch.setattr(module, "SYSTEM_PROMPT", "A revised live prompt")
    with patch("urllib.request.urlopen", side_effect=AssertionError("replay must not network")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=source) as replay:
            assert replay.decide(state) == expected
            replay.assert_replay_consumed()
    assert records(tmp_path / "replay.jsonl")[0]["request"] == records(source)[0]["request"]


def test_live_prompt_explains_opposite_angle_signs_and_storage_choice_stays_with_model(tmp_path, state):
    state["robot"]["holding"] = True
    state["objects"] = [
        {"id": "near", "category": "storage-zone", "status": "CONFIRMED",
         "distance_cm": 47.2, "bearing_deg": -47.3},
        {"id": "far", "category": "storage-zone", "status": "CONFIRMED",
         "distance_cm": 68.4, "bearing_deg": 117.6},
    ]
    state["recent_actions"] = [{"round": 1, "action": {"action": "go_to", "params": {"object_id": "far"}},
                                "success": False, "reason": "known_route_exhausted_needs_exploration",
                                "evidence": {"after_observation": 8, "holding": True}}]
    # Prompt guidance cannot silently rewrite a valid model-selected object.
    selected = {"action": "go_to", "params": {"object_id": "far"}}
    with patch("urllib.request.urlopen", return_value=response(json.dumps(selected))) as send:
        with LLMClient(tmp_path / "calls.jsonl") as client:
            assert client.decide(state) == selected
    request = json.loads(send.call_args.args[0].data)
    prompt = request["messages"][0]["content"]
    assert "bearing_deg" in prompt and "右为正、左为负" in prompt
    assert "heading_deg" in prompt and "左为正、右为负" in prompt
    assert "-bearing_deg" in prompt
    assert "distance_cm" in prompt and "最近的 CONFIRMED 存放区" in prompt
    assert "known_route_exhausted_needs_exploration" in prompt
    assert "没有换位或新增道路/视觉证据" in prompt
    assert json.loads(request["messages"][1]["content"]) == state


@pytest.mark.parametrize("number", range(1, 12))
def test_legacy_repair_replay_keeps_original_prompt_and_state_without_convention(tmp_path, state, number):
    legacy_prompt = f"历史提示/v{number}：只按该轮记录的对象和出口选择一个动作。"
    path = tmp_path / "legacy-repair.jsonl"
    with patch("urllib.request.urlopen", side_effect=[
            response("invalid JSON", stream=False),
            response('{"action":"look_around","params":{}}', stream=False)]):
        with LLMClient(path, stream=False) as live:
            live.system_prompt = legacy_prompt
            expected = live.decide(state)
    original = [legacy_record(row, f"autonomous-brain-llm/v{number}") for row in records(path)]
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in original))
    assert "coordinate_convention" not in state
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("read environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")), \
            patch("autonomous_brain.llm.time.sleep", side_effect=AssertionError("replay slept")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as replay:
            assert replay.decide(state) == expected
            replay.assert_replay_consumed()
            assert replay.call_count == 2
    replayed = records(tmp_path / "replay.jsonl")
    assert [{k: v for k, v in row.items() if k != "mode"} for row in replayed] == [
        {k: v for k, v in row.items() if k != "mode"} for row in original]
    assert [row["attempt"] for row in replayed] == [1, 2]
    assert all(row["request"]["messages"][0]["content"] == legacy_prompt for row in replayed)
    assert all("coordinate_convention" not in json.loads(row["request"]["messages"][1]["content"])
               for row in replayed)


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
            assert send.call_args.kwargs["timeout"] == 180
            assert request.full_url == "https://model.example/v1/chat/completions"
            assert request.headers["Authorization"] == "Bearer never-record-this-key"
            assert body["model"] == "configured-model"
            assert body["stream"] is True
            assert body["temperature"] == 0
            assert type(body["temperature"]) is int
            assert "thinking" not in body
            assert body["response_format"] == {"type": "json_object"}
            assert json.loads(body["messages"][1]["content"])["recent_actions"] == state["recent_actions"][-5:]
            assert len(state["recent_actions"]) == 8
            assert saved["request"] == body
            assert saved["version"] == "autonomous-brain-llm/v16"
            assert saved["transport_timeout_s"] == 180
            assert saved["raw_output"] == raw
            assert saved["action"] == json.loads(raw)
            assert saved["response_model"] == "served-model"
            assert "never-record-this-key" not in path.read_text()


@pytest.mark.parametrize("timeout_s", [15, 0.25])
def test_explicit_transport_timeout_is_sent_logged_and_preserved_in_replay(tmp_path, state, timeout_s):
    path = tmp_path / "live.jsonl"
    with patch("urllib.request.urlopen", return_value=response('{"action":"look_around","params":{}}')) as send:
        with LLMClient(path, timeout_s=timeout_s) as live:
            expected = live.decide(state)
    assert send.call_args.kwargs["timeout"] == timeout_s
    saved = records(path)[0]
    assert saved["transport_timeout_s"] == timeout_s
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("read environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as replay:
            assert replay.decide(state) == expected
            replay.assert_replay_consumed()
    replayed = records(tmp_path / "replay.jsonl")[0]
    assert {k: v for k, v in replayed.items() if k != "mode"} == {
        k: v for k, v in saved.items() if k != "mode"}


def test_stream_assembles_unicode_content_only_and_preserves_raw_sse(tmp_path, state):
    state["objects"][0]["id"] = "红球一"
    raw = '{"action":"go_to","params":{"object_id":"红球一"}}'
    chunks = [
        {"model": "served-model", "choices": [{"index": 0, "delta": {"role": "assistant"}}]},
        {"choices": [{"index": 0, "delta": {"reasoning_content": "不能执行这段思考", "content": raw[:31]}}]},
        {"choices": [{"index": 0, "delta": {"content": raw[31:]}, "finish_reason": "stop"}]},
        {"choices": [], "usage": {"total_tokens": 99}},
    ]
    body = (": heartbeat\n\n" + sse_response(chunks).getvalue().decode()).replace("\n", "\r\n")
    path = tmp_path / "stream.jsonl"
    with patch("urllib.request.urlopen", return_value=io.BytesIO(body.encode())) as send:
        with LLMClient(path) as client:
            assert client.decide(state) == json.loads(raw)
            assert send.call_count == 1
    saved = records(path)[0]
    assert saved["response_body"] == body
    assert saved["raw_output"] == raw
    assert saved["response_model"] == "served-model"
    assert saved["action"] == json.loads(raw)


@pytest.mark.parametrize("raw", ['{"action":"look_around","params":{}}', '{"action":"look'])
def test_stream_requires_done_even_after_valid_json_or_finish_reason(tmp_path, state, raw):
    body = sse_response([{"model": "served-model", "choices": [
        {"index": 0, "delta": {"content": raw}, "finish_reason": "stop"}]}], done=False).getvalue()
    path = tmp_path / "incomplete-stream.jsonl"
    with patch("urllib.request.urlopen", return_value=io.BytesIO(body)) as send:
        with LLMClient(path) as client:
            with pytest.raises(LLMRequestError, match="IncompleteStream"):
                client.decide(state)
            assert send.call_count == client.call_count == 1
            with pytest.raises(RuntimeError, match="stopped"):
                client.decide(state)
    saved = records(path)[0]
    assert saved["response_body"] == body.decode()
    assert saved["raw_output"] == raw
    assert saved["action"] is saved["validation_error"] is None
    assert saved["transport_error"] == {"type": "IncompleteStream"}
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("read environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as replay:
            with pytest.raises(LLMRequestError, match="IncompleteStream"):
                replay.decide(state)
            replay.assert_replay_consumed()
    replayed = records(tmp_path / "replay.jsonl")[0]
    assert {k: v for k, v in replayed.items() if k != "mode"} == {
        k: v for k, v in saved.items() if k != "mode"}


def test_stream_read_error_logs_preceding_events_and_exception_partial(tmp_path, state):
    raw = '{"action":"look_around","params":{}}'
    prefix = sse_response([{"model": "served-model", "choices": [
        {"index": 0, "delta": {"content": raw}}]}], done=False).getvalue()
    partial = b'data: {"choices":['

    class InterruptedStream(io.BytesIO):
        def readline(self, *args, **kwargs):
            line = super().readline(*args, **kwargs)
            if not line:
                raise http.client.IncompleteRead(partial, 5)
            return line

    path = tmp_path / "read-error.jsonl"
    with patch("urllib.request.urlopen", return_value=InterruptedStream(prefix)) as send:
        with LLMClient(path) as client:
            with pytest.raises(LLMRequestError, match="IncompleteRead"):
                client.decide(state)
            assert send.call_count == 1
    saved = records(path)[0]
    assert saved["response_body"] == (prefix + partial).decode()
    assert saved["raw_output"] == raw
    assert saved["response_model"] == "served-model"
    assert saved["action"] is None
    assert saved["transport_error"] == {"type": "IncompleteRead"}
    with patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as replay:
            with pytest.raises(LLMRequestError, match="IncompleteRead"):
                replay.decide(state)
            replay.assert_replay_consumed()
    replayed = records(tmp_path / "replay.jsonl")[0]
    assert {k: v for k, v in replayed.items() if k != "mode"} == {
        k: v for k, v in saved.items() if k != "mode"}


@pytest.mark.parametrize("chunk", [
    {"choices": [{"index": 0, "delta": {"content": "{}"}}, {"index": 1, "delta": {"content": "{}"}}]},
    {"choices": [{"index": 1, "delta": {"content": "{}"}}]},
    {"choices": [{"index": 0, "delta": {"content": {"action": "done", "params": {}}}}]},
    {"error": {"type": "server_error"}, "choices": []},
])
def test_invalid_stream_envelopes_never_produce_actions_and_only_repair_once(tmp_path, state, chunk):
    with patch("urllib.request.urlopen", side_effect=[sse_response([chunk]), sse_response([chunk])]) as send:
        with LLMClient(tmp_path / "invalid-stream.jsonl") as client:
            with pytest.raises(LLMOutputError, match="one repair"):
                client.decide(state)
            assert send.call_count == client.call_count == 2
    assert all(call["action"] is None for call in records(tmp_path / "invalid-stream.jsonl"))


def test_explicit_nonstream_setting_is_restored_in_replay(tmp_path, state):
    path = tmp_path / "nonstream.jsonl"
    with patch("urllib.request.urlopen", return_value=response('{"action":"look_around","params":{}}', stream=False)):
        with LLMClient(path, stream=False) as live:
            expected = live.decide(state)
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("read environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as replay:
            assert replay.decide(state) == expected
            replay.assert_replay_consumed()
    saved, replayed = records(path)[0], records(tmp_path / "replay.jsonl")[0]
    assert replayed["request"]["stream"] is False
    assert {k: v for k, v in replayed.items() if k != "mode"} == {
        k: v for k, v in saved.items() if k != "mode"}


@pytest.mark.parametrize("version", ["autonomous-brain-llm/v4", "autonomous-brain-llm/v5", "autonomous-brain-llm/v6"])
def test_old_timeout_error_replays_without_new_metadata_or_retry(tmp_path, state, version):
    path = tmp_path / "v4-timeout.jsonl"
    with patch("urllib.request.urlopen", side_effect=TimeoutError("never-record-this-key")) as send:
        with LLMClient(path, timeout_s=60, stream=False) as live:
            with pytest.raises(LLMRequestError, match="TimeoutError") as original_error:
                live.decide(state)
            assert send.call_count == live.call_count == 1
    saved = records(path)[0]
    assert saved["transport_timeout_s"] == 60
    legacy_record(saved, version)
    path.write_text(json.dumps(saved) + "\n")
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("read environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path, transport_retries=2) as replay:
            with pytest.raises(LLMRequestError) as replay_error:
                replay.decide(state)
            assert str(replay_error.value) == str(original_error.value)
            assert replay.call_count == 1
            replay.assert_replay_consumed()
            with pytest.raises(RuntimeError, match="stopped"):
                replay.decide(state)
    replayed = records(tmp_path / "replay.jsonl")[0]
    assert ("transport_timeout_s" in replayed) == (version != "autonomous-brain-llm/v4")
    assert "transport_retry_limit" not in replayed
    assert {k: v for k, v in replayed.items() if k != "mode"} == {
        k: v for k, v in saved.items() if k != "mode"}


def test_transient_retries_log_each_call_then_replay_without_network_environment_or_sleep(tmp_path, state):
    path = tmp_path / "retry.jsonl"
    with patch("urllib.request.urlopen", side_effect=[
            urllib.error.URLError("never-record-this-key"), http.client.RemoteDisconnected(),
            response('{"action":"look_around","params":{}}')]) as send, \
            patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(path, transport_retries=2) as live:
            expected = live.decide(state)
            assert live.call_count == send.call_count == 3
            elapsed = live.total_elapsed_s
    saved = records(path)
    assert [call.args[0] for call in sleep.call_args_list] == [1, 2]
    assert [row["call_index"] for row in saved] == [1, 2, 3]
    assert [row["attempt"] for row in saved] == [1, 1, 1]
    assert [row["transport_retry_index"] for row in saved] == [0, 1, 2]
    assert [row["transport_retry_delay_s"] for row in saved] == [0, 1, 2]
    assert all(row["transport_retry_limit"] == 2 for row in saved)
    assert len({row["request_sha256"] for row in saved}) == 1
    assert len({call.args[0].data for call in send.call_args_list}) == 1
    assert elapsed == sum(row["elapsed_s"] for row in saved)
    assert "never-record-this-key" not in path.read_text()
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("read environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")), \
            patch("autonomous_brain.llm.time.sleep", side_effect=AssertionError("replay slept")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as replay:
            assert replay.transport_retries == 2
            assert replay.decide(state) == expected
            assert replay.call_count == 3
            assert replay.total_elapsed_s == elapsed
            replay.assert_replay_consumed()
    replayed = records(tmp_path / "replay.jsonl")
    assert [{k: v for k, v in row.items() if k != "mode"} for row in replayed] == [
        {k: v for k, v in row.items() if k != "mode"} for row in saved]


@pytest.mark.parametrize("error", [TimeoutError(), type("timeout", (TimeoutError,), {})(),
    urllib.error.URLError("offline"), http.client.RemoteDisconnected(),
    http.client.IncompleteRead(b"", 1), ConnectionResetError()])
def test_transport_retry_whitelist_stops_after_three_failures(tmp_path, state, error):
    path = tmp_path / "failed-retries.jsonl"
    with patch("urllib.request.urlopen", side_effect=error) as send, \
            patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(path, transport_retries=2) as client:
            with pytest.raises(LLMRequestError):
                client.decide(state)
            assert send.call_count == client.call_count == 3
            assert [call.args[0] for call in sleep.call_args_list] == [1, 2]
            with pytest.raises(RuntimeError, match="stopped"):
                client.decide(state)
    saved = records(path)
    assert all(row["action"] is None for row in saved)
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("read environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")), \
            patch("autonomous_brain.llm.time.sleep", side_effect=AssertionError("replay slept")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as replay:
            with pytest.raises(LLMRequestError):
                replay.decide(state)
            assert replay.call_count == 3
            replay.assert_replay_consumed()
    assert [{k: v for k, v in row.items() if k != "mode"}
            for row in records(tmp_path / "replay.jsonl")] == [
        {k: v for k, v in row.items() if k != "mode"} for row in saved]


@pytest.mark.parametrize("error", [OSError("not-whitelisted"), http.client.BadStatusLine("invalid")])
def test_nontransient_transport_errors_do_not_retry(tmp_path, state, error):
    with patch("urllib.request.urlopen", side_effect=error) as send, \
            patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(tmp_path / "permanent-transport.jsonl", transport_retries=2) as client:
            with pytest.raises(LLMRequestError):
                client.decide(state)
            assert send.call_count == client.call_count == 1
    sleep.assert_not_called()


def test_incomplete_stream_retry_discards_partial_content_before_success(tmp_path, state):
    incomplete = sse_response([{"model": "served-model", "choices": [
        {"index": 0, "delta": {"content": '{"action":"pick","params":'}}]}], done=False)
    path = tmp_path / "partial-retry.jsonl"
    with patch("urllib.request.urlopen", side_effect=[incomplete,
            response('{"action":"look_around","params":{}}')]) as send, \
            patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(path, transport_retries=2) as client:
            assert client.decide(state) == {"action": "look_around", "params": {}}
            assert send.call_count == client.call_count == 2
    first, second = records(path)
    assert first["transport_error"] == {"type": "IncompleteStream"}
    assert first["raw_output"] == '{"action":"pick","params":'
    assert second["raw_output"] == '{"action":"look_around","params":{}}'
    sleep.assert_called_once_with(1)


@pytest.mark.parametrize("status", [408, 429, 500, 502, 503, 504])
def test_retryable_http_status_then_success(tmp_path, state, status):
    error = urllib.error.HTTPError("https://model.example", status, "temporary", {}, io.BytesIO(b'{}'))
    with patch("urllib.request.urlopen", side_effect=[error,
            response('{"action":"look_around","params":{}}')]) as send, \
            patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(tmp_path / "http-retry.jsonl", transport_retries=2) as client:
            assert client.decide(state)["action"] == "look_around"
            assert send.call_count == client.call_count == 2
    sleep.assert_called_once_with(1)


@pytest.mark.parametrize("status", [400, 401, 403, 404])
def test_permanent_http_status_never_retries(tmp_path, state, status):
    error = urllib.error.HTTPError("https://model.example", status, "permanent", {}, io.BytesIO(b'{}'))
    with patch("urllib.request.urlopen", side_effect=error) as send, \
            patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(tmp_path / "permanent.jsonl", transport_retries=2) as client:
            with pytest.raises(LLMRequestError, match=f"HTTP {status}"):
                client.decide(state)
            assert send.call_count == client.call_count == 1
    sleep.assert_not_called()


def test_transport_retry_budget_resets_only_for_single_json_repair(tmp_path, state):
    path = tmp_path / "repair-retry.jsonl"
    responses = [TimeoutError(), response("invalid"),
                 http.client.RemoteDisconnected(), response('{"action":"look_around","params":{}}')]
    with patch("urllib.request.urlopen", side_effect=responses) as send, \
            patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(path, transport_retries=2) as client:
            assert client.decide(state)["action"] == "look_around"
            assert send.call_count == client.call_count == 4
    rows = records(path)
    assert [row["attempt"] for row in rows] == [1, 1, 2, 2]
    assert [row["transport_retry_index"] for row in rows] == [0, 1, 0, 1]
    assert [call.args[0] for call in sleep.call_args_list] == [1, 1]
    assert rows[0]["request"] == rows[1]["request"]
    assert rows[2]["request"] == rows[3]["request"]
    assert len(rows[2]["request"]["messages"]) == 4
    assert rows[2]["request"]["messages"][2]["content"] == "invalid"


def test_invalid_json_still_gets_only_one_repair_with_transport_retries_enabled(tmp_path, state):
    path = tmp_path / "invalid.jsonl"
    with patch("urllib.request.urlopen", side_effect=[response("invalid"), response("invalid")]) as send, \
            patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(path, transport_retries=2) as client:
            with pytest.raises(LLMOutputError, match="one repair"):
                client.decide(state)
            assert send.call_count == client.call_count == 2
    assert [row["transport_retry_index"] for row in records(path)] == [0, 0]
    sleep.assert_not_called()


@pytest.mark.parametrize("field,value", [("transport_retry_limit", 1),
    ("transport_retry_index", 2), ("transport_retry_delay_s", 2),
    ("transport_retry_limit", True), ("transport_retry_index", True),
    ("transport_retry_delay_s", None)])
def test_replay_rejects_inconsistent_transport_retry_metadata(tmp_path, state, field, value):
    path = tmp_path / "retry.jsonl"
    with patch("urllib.request.urlopen", side_effect=[TimeoutError(),
            response('{"action":"look_around","params":{}}')]), patch("autonomous_brain.llm.time.sleep"):
        with LLMClient(path, transport_retries=2) as client:
            client.decide(state)
    rows = records(path)
    rows[1][field] = value
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("read environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")), \
            patch("autonomous_brain.llm.time.sleep", side_effect=AssertionError("replay slept")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as replay:
            with pytest.raises(ReplayError, match=f"input mismatch: {field}"):
                replay.decide(state)
            assert replay.call_count == 1


@pytest.mark.parametrize("limit", [True, -1, 6, 1.0, "2", None])
def test_transport_retry_limit_is_bounded_integer(tmp_path, limit):
    with pytest.raises(ValueError, match="transport_retries"):
        LLMClient(tmp_path / "invalid-limit.jsonl", transport_retries=limit)


@pytest.mark.parametrize("reason,expected", [
    (ConnectionRefusedError(61, "https://private-user:private-key@private-endpoint"),
     {"reason_type": "ConnectionRefusedError", "reason_errno": 61}),
    (TimeoutError("private-timeout-detail"), {"reason_type": "TimeoutError"}),
    ("https://private-user:private-key@private-endpoint", {"reason_type": "str"}),
])
def test_urlerror_diagnostics_are_structural_and_replay_exactly(tmp_path, state, reason, expected):
    path = tmp_path / "failure.jsonl"
    with patch("urllib.request.urlopen", side_effect=urllib.error.URLError(reason)):
        with LLMClient(path) as client:
            with pytest.raises(LLMRequestError):
                client.decide(state)
    saved = records(path)[0]
    assert saved["transport_diagnostics"] == {"phase": "open", "received_bytes": 0, **expected}
    assert saved["transport_error"] == {"type": "URLError"}
    for forbidden in ("private-user", "private-key", "private-endpoint", "private-timeout-detail",
                      "never-record-this-key"):
        assert forbidden not in path.read_text()
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")), \
            patch("autonomous_brain.llm.time.sleep", side_effect=AssertionError("sleep")):
        with LLMClient(tmp_path / "replayed.jsonl", replay_path=path) as client:
            with pytest.raises(LLMRequestError):
                client.decide(state)
            client.assert_replay_consumed()
    assert [{k: v for k, v in row.items() if k != "mode"} for row in records(path)] == [
        {k: v for k, v in row.items() if k != "mode"} for row in records(tmp_path / "replayed.jsonl")]


def test_urlerror_reason_is_never_stringified_or_coerced_to_errno(tmp_path, state):
    class SecretReason:
        errno = True

        def __str__(self):
            raise AssertionError("Do not stringify exception reason")

    with patch("urllib.request.urlopen", side_effect=urllib.error.URLError(SecretReason())):
        with LLMClient(tmp_path / "failure.jsonl") as client:
            with pytest.raises(LLMRequestError):
                client.decide(state)
    assert records(tmp_path / "failure.jsonl")[0]["transport_diagnostics"] == {
        "phase": "open", "received_bytes": 0, "reason_type": "SecretReason"}


def test_stream_read_diagnostics_count_received_utf8_bytes_and_keep_partial_content(tmp_path, state):
    line = ('data: ' + json.dumps({"model": "测试模型", "choices": [{"index": 0,
        "delta": {"content": '{"action":"look_around","params":{}}'}}]}, ensure_ascii=False) + '\n').encode()

    class BrokenStream(io.BytesIO):
        def readline(self, *args):
            if self.tell() == len(line):
                raise urllib.error.URLError(ConnectionResetError(54, "private-read-detail"))
            return super().readline(*args)

    path = tmp_path / "partial.jsonl"
    with patch("urllib.request.urlopen", return_value=BrokenStream(line)):
        with LLMClient(path) as client:
            with pytest.raises(LLMRequestError):
                client.decide(state)
    saved = records(path)[0]
    assert saved["transport_diagnostics"] == {"phase": "read_stream", "received_bytes": len(line),
        "reason_type": "ConnectionResetError", "reason_errno": 54}
    assert saved["response_body"] == line.decode()
    assert saved["action"] is None
    assert saved["raw_output"] == '{"action":"look_around","params":{}}'
    assert "private-read-detail" not in path.read_text()


@pytest.mark.parametrize("stream", [False, True])
def test_success_diagnostics_count_actual_response_bytes(tmp_path, state, stream):
    body = response('{"action":"look_around","params":{}}', stream=stream)
    length = len(body.getvalue())
    with patch("urllib.request.urlopen", return_value=body):
        with LLMClient(tmp_path / "success.jsonl", stream=stream) as client:
            client.decide(state)
    assert records(tmp_path / "success.jsonl")[0]["transport_diagnostics"] == {
        "phase": "read_stream" if stream else "read_body", "received_bytes": length}


def test_incomplete_body_diagnostics_include_exception_partial_bytes(tmp_path, state):
    class BrokenBody(io.BytesIO):
        def read(self, *args):
            raise http.client.IncompleteRead("部分".encode(), 20)

    with patch("urllib.request.urlopen", return_value=BrokenBody()):
        with LLMClient(tmp_path / "partial-body.jsonl", stream=False) as client:
            with pytest.raises(LLMRequestError):
                client.decide(state)
    row = records(tmp_path / "partial-body.jsonl")[0]
    assert row["response_body"] == "部分"
    assert row["transport_diagnostics"] == {"phase": "read_body", "received_bytes": 6}


@pytest.mark.parametrize("broken_body", [False, True])
def test_http_diagnostics_distinguish_status_failure_from_error_body_read_failure(tmp_path, state, broken_body):
    body = "网关".encode()

    class ErrorBody(io.BytesIO):
        def read(self, *args):
            raise http.client.IncompleteRead(body, 20)

    error = urllib.error.HTTPError("https://model.example/v1", 502, "private-http-detail",
                                   None, ErrorBody() if broken_body else io.BytesIO(body))
    with patch("urllib.request.urlopen", side_effect=error):
        with LLMClient(tmp_path / "http.jsonl") as client:
            with pytest.raises(LLMRequestError):
                client.decide(state)
    row = records(tmp_path / "http.jsonl")[0]
    assert row["response_body"] == body.decode()
    assert row["transport_diagnostics"] == {
        "phase": "read_body" if broken_body else "open", "received_bytes": len(body)}
    assert "private-http-detail" not in (tmp_path / "http.jsonl").read_text()


@pytest.mark.parametrize("diagnostics", [None, {}, {"phase": "open"},
    {"phase": "connect", "received_bytes": 0}, {"phase": "open", "received_bytes": True},
    {"phase": "open", "received_bytes": -1}, {"phase": "open", "received_bytes": 1.0},
    {"phase": "open", "received_bytes": 0, "url": "not-allowed"},
    {"phase": "open", "received_bytes": 0, "reason_type": "reason with text"},
    {"phase": "open", "received_bytes": 0, "reason_type": 2},
    {"phase": "open", "received_bytes": 0, "reason_type": "x" * 81},
    {"phase": "open", "received_bytes": 0, "reason_errno": 54},
    {"phase": "open", "received_bytes": 0, "reason_type": "OSError", "reason_errno": True},
    {"phase": "open", "received_bytes": 0, "reason_type": "OSError", "reason_errno": "54"}])
def test_v12_replay_rejects_malformed_diagnostics(tmp_path, state, diagnostics):
    path = tmp_path / "source.jsonl"
    with patch("urllib.request.urlopen", return_value=response('{"action":"look_around","params":{}}')):
        with LLMClient(path) as client:
            client.decide(state)
    row = records(path)[0]
    if diagnostics is None:
        row.pop("transport_diagnostics")
    else:
        row["transport_diagnostics"] = diagnostics
    path.write_text(json.dumps(row) + '\n')
    with patch("urllib.request.urlopen", side_effect=AssertionError("network")), \
            patch("autonomous_brain.llm.time.sleep", side_effect=AssertionError("sleep")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as client:
            with pytest.raises(ReplayError, match="transport diagnostics"):
                client.decide(state)
            assert client.call_count == 0


@pytest.mark.parametrize("temperature", ["0", "0.0", "0.7", "2"])
@pytest.mark.parametrize("thinking", [None, "enabled", "disabled"])
def test_explicit_sampling_settings_are_sent_and_logged_on_every_attempt(
        tmp_path, state, monkeypatch, temperature, thinking):
    monkeypatch.setenv("LLM_TEMPERATURE", temperature)
    if thinking is not None:
        monkeypatch.setenv("LLM_THINKING", thinking)
    path = tmp_path / "calls.jsonl"
    with patch("urllib.request.urlopen", side_effect=[response("invalid"),
               response('{"action":"look_around","params":{}}')]) as send:
        with LLMClient(path) as client:
            assert client.decide(state) == {"action": "look_around", "params": {}}
            assert send.call_count == client.call_count == 2
    for call, saved in zip(send.call_args_list, records(path)):
        body = json.loads(call.args[0].data)
        assert body["temperature"] == json.loads(temperature)
        assert type(body["temperature"]) is type(json.loads(temperature))
        if thinking is None:
            assert "thinking" not in body
        else:
            assert body["thinking"] == {"type": thinking}
        assert saved["request"] == body
        assert saved["request_sha256"] == hashlib.sha256(call.args[0].data).hexdigest()


@pytest.mark.parametrize("value", ["true", "false", "null", "NaN", "Infinity",
    "-Infinity", "1e999", "-0.1", "2.1", '"0.7"', "{}", "[]", "", "invalid"])
def test_invalid_temperature_fails_before_network_or_log_creation(tmp_path, monkeypatch, value):
    monkeypatch.setenv("LLM_TEMPERATURE", value)
    path = tmp_path / "calls.jsonl"
    with patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with pytest.raises(ValueError, match="LLM_TEMPERATURE"):
            LLMClient(path)
    assert not path.exists()


@pytest.mark.parametrize("value", ["", "true", "false", "Enabled", " enabled", "auto"])
def test_invalid_thinking_fails_before_network_or_log_creation(tmp_path, monkeypatch, value):
    monkeypatch.setenv("LLM_THINKING", value)
    path = tmp_path / "calls.jsonl"
    with patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with pytest.raises(ValueError, match="LLM_THINKING"):
            LLMClient(path)
    assert not path.exists()


@pytest.mark.parametrize("temperature", ["0", "0.0", "0.7"])
@pytest.mark.parametrize("thinking", [None, "enabled", "disabled"])
def test_replay_restores_sampling_settings_without_environment_or_network(
        tmp_path, state, monkeypatch, temperature, thinking):
    monkeypatch.setenv("LLM_TEMPERATURE", temperature)
    if thinking is not None:
        monkeypatch.setenv("LLM_THINKING", thinking)
    path = tmp_path / "live.jsonl"
    with patch("urllib.request.urlopen", side_effect=[response("invalid"),
               response('{"action":"look_around","params":{}}')]):
        with LLMClient(path) as live:
            expected = live.decide(state)
    replay_path = tmp_path / "replay.jsonl"
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("read environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with LLMClient(replay_path, replay_path=path) as replay:
            assert replay.decide(state) == expected
            replay.assert_replay_consumed()
    for original, replayed in zip(records(path), records(replay_path)):
        assert {k: v for k, v in replayed.items() if k != "mode"} == {
            k: v for k, v in original.items() if k != "mode"}
        assert type(replayed["request"]["temperature"]) is type(json.loads(temperature))


@pytest.mark.parametrize("change", ["temperature", "thinking", "hash"])
def test_replay_checks_settings_and_hash_for_each_call(tmp_path, state, monkeypatch, change):
    monkeypatch.setenv("LLM_TEMPERATURE", "0.7")
    monkeypatch.setenv("LLM_THINKING", "disabled")
    path = tmp_path / "live.jsonl"
    with patch("urllib.request.urlopen", side_effect=[response("invalid"),
               response('{"action":"look_around","params":{}}')]):
        with LLMClient(path) as live:
            live.decide(state)
    calls = records(path)
    if change == "hash":
        calls[1]["request_sha256"] = "0" * 64
    else:
        calls[1]["request"][change] = 0.8 if change == "temperature" else {"type": "enabled"}
        calls[1]["request_sha256"] = hashlib.sha256(json.dumps(
            calls[1]["request"], ensure_ascii=False, sort_keys=True,
            separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    path.write_text("".join(json.dumps(call) + "\n" for call in calls))
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("read environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as replay:
            with pytest.raises(ReplayError, match="input mismatch: request"):
                replay.decide(state)
            assert replay.call_count == 1


@pytest.mark.parametrize("settings", [
    {"temperature": True}, {"temperature": -0.1}, {"temperature": 2.1},
    {"temperature": "0.7"}, {"thinking": None}, {"thinking": "disabled"},
    {"thinking": {"type": "auto"}}, {"thinking": {"type": "enabled", "budget": 3}},
])
def test_replay_rejects_invalid_recorded_sampling_settings_before_opening_log(
        tmp_path, state, settings):
    path = tmp_path / "live.jsonl"
    with patch("urllib.request.urlopen", return_value=response('{"action":"look_around","params":{}}')):
        with LLMClient(path) as live:
            live.decide(state)
    saved = records(path)[0]
    saved["request"].update(settings)
    path.write_text(json.dumps(saved) + "\n")
    replay_path = tmp_path / "replay.jsonl"
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("read environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with pytest.raises(ReplayError, match="Replay has invalid"):
            LLMClient(replay_path, replay_path=path)
    assert not replay_path.exists()


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


@pytest.mark.parametrize("version", ["autonomous-brain-llm/v1", "autonomous-brain-llm/v2",
                                     "autonomous-brain-llm/v3", "autonomous-brain-llm/v4",
                                     "autonomous-brain-llm/v5", "autonomous-brain-llm/v6",
                                     "autonomous-brain-llm/v7", "autonomous-brain-llm/v8", "autonomous-brain-llm/v9",
                                     "autonomous-brain-llm/v10", "autonomous-brain-llm/v11"])
def test_old_transcripts_keep_version_and_integer_zero_without_environment(
        tmp_path, state, version):
    path = tmp_path / "legacy.jsonl"
    with patch("urllib.request.urlopen", return_value=response('{"action":"look_around","params":{}}', stream=False)):
        with LLMClient(path, stream=False) as client:
            client.decide(state)
    saved = legacy_record(records(path)[0], version)
    assert type(saved["request"]["temperature"]) is int
    assert "thinking" not in saved["request"]
    path.write_text(json.dumps(saved) + "\n")
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("read environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=path) as client:
            assert client.decide(state) == {"action": "look_around", "params": {}}
            client.assert_replay_consumed()
    replayed = records(tmp_path / "replay.jsonl")[0]
    assert type(replayed["request"]["temperature"]) is int
    assert {k: v for k, v in replayed.items() if k != "mode"} == {k: v for k, v in saved.items() if k != "mode"}


def test_bad_http_envelope_has_one_repair(tmp_path, state):
    with patch("urllib.request.urlopen", side_effect=[sse_response([{}]),
               response('{"action":"look_around","params":{}}')]) as send:
        with LLMClient(tmp_path / "calls.jsonl") as client:
            assert client.decide(state)["action"] == "look_around"
            assert send.call_count == 2


def test_no_tool_calls_are_executed(tmp_path, state):
    payload = {"choices": [{"index": 0, "delta": {"content": '{"action":"done","params":{}}',
                "tool_calls": [{"function": {"name": "mission"}}]}}]}
    with patch("urllib.request.urlopen", side_effect=[sse_response([payload]),
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
