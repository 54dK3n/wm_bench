"""Completion termination and literal legacy replay; no sockets or credentials."""

import hashlib
import io
import json
from unittest.mock import patch

import pytest

from autonomous_brain.llm import LLMClient, LLMOutputError, LLMRequestError, ReplayError


ACTION = {"action": "look_around", "params": {}}
RAW = '{"action":"look_around","params":{}}'
MISSING = object()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)


@pytest.fixture
def state():
    return {"task": "收集红球", "objects": [], "robot": {"holding": False},
            "junction_history": [], "recent_actions": []}


@pytest.fixture(autouse=True)
def isolated_configuration():
    settings = {"LLM_BASE_URL": "https://mock.invalid/v1", "LLM_API_KEY": "fake-finish-key",
                "LLM_MODEL": "requested-model"}
    with patch("autonomous_brain.llm.os.environ.get", side_effect=settings.get), \
            patch("urllib.request.urlopen", side_effect=AssertionError("unmocked network request")):
        yield


def chunk(content=MISSING, finish=MISSING, **extra):
    choice = {"index": 0, "delta": {}}
    if content is not MISSING:
        choice["delta"]["content"] = content
    if finish is not MISSING:
        choice["finish_reason"] = finish
    return {"model": "served-model", "choices": [choice], **extra}


def stream_body(chunks, ending="data: [DONE]\n\n"):
    return (": keep-alive\n\n" + "".join("data: " + canonical(row) + "\n\n"
                                           for row in chunks) + ending)


def nonstream_body(finish=MISSING):
    choice = {"index": 0, "message": {"content": RAW}}
    if finish is not MISSING:
        choice["finish_reason"] = finish
    return canonical({"model": "served-model", "choices": [choice]})


def read_rows(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def assert_exact_replay(source, destination, state, *, failed=False):
    source_bytes = source.read_bytes()
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")), \
            patch("autonomous_brain.llm.time.sleep", side_effect=AssertionError("sleep")):
        with LLMClient(destination, replay_path=source) as replay:
            if failed:
                with pytest.raises(LLMOutputError, match="one repair"):
                    replay.decide(state)
            else:
                assert replay.decide(state) == ACTION
            replay.assert_replay_consumed()
    assert source.read_bytes() == source_bytes
    # Source bytes and every recorded value, including the raw response, stay
    # exact. Replay output's only changed field is its established mode marker.
    assert read_rows(destination) == [dict(row, mode="replay") for row in read_rows(source)]


@pytest.mark.parametrize("stream", [True, False])
@pytest.mark.parametrize("finish", [MISSING, None, "", 0, False, [], {}, "length", "aborted",
                                    "insufficient_system_resource", "content_filter", "tool_calls", "unknown"])
def test_abnormal_finish_rejects_complete_json_and_replays_exactly(tmp_path, state, stream, finish):
    body = stream_body([chunk(RAW, finish)]) if stream else nonstream_body(finish)
    source = tmp_path / "invalid.jsonl"
    with patch("urllib.request.urlopen", side_effect=[io.BytesIO(body.encode()), io.BytesIO(body.encode())]) as send, \
            patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(source, stream=stream, transport_retries=5) as client:
            with pytest.raises(LLMOutputError, match="one repair"):
                client.decide(state)
            assert send.call_count == client.call_count == 2
            with pytest.raises(RuntimeError, match="stopped"):
                client.decide(state)
    sleep.assert_not_called()
    rows = read_rows(source)
    assert all(row["version"] == "autonomous-brain-llm/v15" for row in rows)
    assert all(row["response_body"] == body and row["raw_output"] == RAW for row in rows)
    assert all(row["action"] is None and row["validation_error"] and row["transport_error"] is None
               for row in rows)
    assert [row["attempt"] for row in rows] == [1, 2]
    assert_exact_replay(source, tmp_path / "replay.jsonl", state, failed=True)


@pytest.mark.parametrize("tail", [
    [chunk(finish="stop")], [chunk(finish="length")],
    [chunk(" ")], [chunk("")], [chunk()],
    [{"choices": [{"index": 0, "delta": {"reasoning_content": "late reasoning"}}]}],
])
def test_stream_rejects_duplicate_termination_or_choice_after_stop(tmp_path, state, tail):
    body = stream_body([chunk(RAW, "stop"), *tail])
    source = tmp_path / "late-choice.jsonl"
    with patch("urllib.request.urlopen", side_effect=[io.BytesIO(body.encode()), io.BytesIO(body.encode())]):
        with LLMClient(source) as client:
            with pytest.raises(LLMOutputError):
                client.decide(state)
    assert all(row["response_body"] == body and row["action"] is None for row in read_rows(source))
    assert_exact_replay(source, tmp_path / "replay.jsonl", state, failed=True)


def test_later_stop_cannot_erase_earlier_abnormal_finish(tmp_path, state):
    body = stream_body([chunk(RAW, "length"), chunk(finish="stop")])
    with patch("urllib.request.urlopen", side_effect=[io.BytesIO(body.encode()), io.BytesIO(body.encode())]):
        with LLMClient(tmp_path / "failed.jsonl") as client:
            with pytest.raises(LLMOutputError):
                client.decide(state)
    assert all(row["action"] is None for row in read_rows(tmp_path / "failed.jsonl"))


@pytest.mark.parametrize("same_chunk", [False, True])
@pytest.mark.parametrize("usage_only", [False, True])
def test_normal_finish_accepts_provider_usage_shapes_and_stops_reading_at_done(
        tmp_path, state, same_chunk, usage_only):
    usage = {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8}
    chunks = ([chunk(RAW, "stop", usage=usage)] if same_chunk else
              [chunk(RAW), chunk(finish="stop", usage=usage)])
    if usage_only:
        chunks.append({"choices": [], "usage": usage})
    body = stream_body(chunks)

    class KeepOpenAfterDone(io.BytesIO):
        def readline(self, *args):
            if self.tell() == len(body.encode()):
                raise AssertionError("must not wait for EOF after the complete [DONE] boundary")
            return super().readline(*args)

    path = tmp_path / "success.jsonl"
    with patch("urllib.request.urlopen", return_value=KeepOpenAfterDone(body.encode())):
        with LLMClient(path) as client:
            assert client.decide(state) == ACTION
    assert read_rows(path)[0]["response_body"] == body
    assert_exact_replay(path, tmp_path / "replay.jsonl", state)


@pytest.mark.parametrize("ending", ["", "data: [DONE]", "data: [DONE]\n"])
def test_stop_and_complete_json_still_need_a_complete_done_event(tmp_path, state, ending):
    body = stream_body([chunk(RAW, "stop")], ending)
    path = tmp_path / "incomplete.jsonl"
    with patch("urllib.request.urlopen", return_value=io.BytesIO(body.encode())) as send:
        with LLMClient(path) as client:
            with pytest.raises(LLMRequestError, match="IncompleteStream"):
                client.decide(state)
            assert send.call_count == 1
    row, = read_rows(path)
    assert row["response_body"] == body and row["raw_output"] == RAW and row["action"] is None
    assert row["transport_error"] == {"type": "IncompleteStream"}


@pytest.mark.parametrize("stream", [True, False])
def test_normal_repair_is_required_before_any_action_is_returned(tmp_path, state, stream):
    body = (lambda finish: stream_body([chunk(RAW, finish)])) if stream else nonstream_body
    path = tmp_path / "repaired.jsonl"
    with patch("urllib.request.urlopen", side_effect=[io.BytesIO(body("aborted").encode()),
                                                      io.BytesIO(body("stop").encode())]):
        with LLMClient(path, stream=stream) as client:
            assert client.decide(state) == ACTION
    first, second = read_rows(path)
    assert first["action"] is None and first["validation_error"]
    assert second["action"] == ACTION and second["validation_error"] is None
    assert second["request"]["messages"][-2]["content"] == RAW
    assert_exact_replay(path, tmp_path / "replay.jsonl", state)


def literal_row(state, number, body, *, stream, index=1):
    """Independent historical fixture, never generated through the live client."""
    request = {"model": "recorded-model", "temperature": 0,
               "response_format": {"type": "json_object"},
               "messages": [{"role": "system", "content": "Recorded prompt."},
                            {"role": "user", "content": canonical(state)}]}
    if stream or number >= 6:
        request["stream"] = stream
    row = {"version": f"autonomous-brain-llm/v{number}", "call_index": index,
           "decision_index": index, "attempt": 1, "mode": "live", "request": request,
           "request_sha256": hashlib.sha256(canonical(request).encode()).hexdigest(),
           "response_body": body, "response_model": "served-model", "raw_output": RAW,
           "action": ACTION, "validation_error": None, "transport_error": None, "elapsed_s": 0.25}
    if number >= 5:
        row["transport_timeout_s"] = 180
    if number >= 7:
        row.update(transport_retry_limit=0, transport_retry_index=0, transport_retry_delay_s=0)
    if number >= 12:
        row["transport_diagnostics"] = {"phase": "read_stream" if stream else "read_body",
                                        "received_bytes": len(body.encode())}
    return row


@pytest.mark.parametrize("number", range(1, 14))
@pytest.mark.parametrize("finish", [MISSING, "length", "aborted"])
def test_literal_v1_to_v13_nonstream_replay_keeps_original_end_semantics(tmp_path, state, number, finish):
    row = literal_row(state, number, nonstream_body(finish), stream=False)
    path = tmp_path / "historical.jsonl"
    path.write_text(canonical(row) + "\n")
    assert_exact_replay(path, tmp_path / "replayed.jsonl", state)


LEGACY_STREAMS = [
    stream_body([chunk(RAW)]), stream_body([chunk(RAW, "aborted")]),
    stream_body([chunk(RAW, "stop"), chunk(finish="stop")]),
    stream_body([chunk(RAW, "stop")], "data: [DONE]"),
    stream_body([chunk(RAW, "stop")], "data: [DONE]\n"),
    stream_body([chunk(RAW, "stop")]) + "data: [DONE]\n\n",
    stream_body([chunk(RAW, "stop")]) + "data: not-json\n\n",
]


@pytest.mark.parametrize("number", range(6, 14))
@pytest.mark.parametrize("body", LEGACY_STREAMS)
def test_literal_v6_to_v13_stream_replay_keeps_original_end_semantics(tmp_path, state, number, body):
    row = literal_row(state, number, body, stream=True)
    path = tmp_path / "historical.jsonl"
    path.write_text(canonical(row) + "\n")
    assert_exact_replay(path, tmp_path / "replayed.jsonl", state)


@pytest.mark.parametrize("body", LEGACY_STREAMS)
def test_v14_replay_rejects_a_forged_success_using_legacy_end_semantics(tmp_path, state, body):
    row = literal_row(state, 14, body, stream=True)
    source = tmp_path / "forged-success.jsonl"
    original = canonical(row) + "\n"
    source.write_text(original)
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with LLMClient(tmp_path / "replay.jsonl", replay_path=source) as replay:
            with pytest.raises(ReplayError, match="output validation mismatch"):
                replay.decide(state)
            assert replay.call_count == 0
    assert source.read_text() == original


@pytest.mark.parametrize("versions", [(13, 14), (14, 13)])
def test_finish_validation_uses_each_record_version(tmp_path, state, versions):
    rows = [literal_row(state, version,
                        stream_body([chunk(RAW, "stop" if version == 14 else "aborted")]),
                        stream=True, index=index)
            for index, version in enumerate(versions, 1)]
    source, output = tmp_path / "mixed.jsonl", tmp_path / "replayed.jsonl"
    source.write_text("".join(canonical(row) + "\n" for row in rows))
    original = source.read_bytes()
    with patch("autonomous_brain.llm.os.environ.get", side_effect=AssertionError("environment")), \
            patch("urllib.request.urlopen", side_effect=AssertionError("network")):
        with LLMClient(output, replay_path=source) as replay:
            assert replay.decide(state) == replay.decide(state) == ACTION
            replay.assert_replay_consumed()
    assert source.read_bytes() == original
    assert read_rows(output) == [dict(row, mode="replay") for row in rows]
