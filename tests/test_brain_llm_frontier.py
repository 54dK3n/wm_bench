"""Literal v12 compatibility across the v13 frontier prompt revision."""

from contextlib import contextmanager
import copy
import hashlib
import io
import json
from unittest.mock import patch

import pytest

from autonomous_brain.llm import LLMClient, LLMRequestError, ReplayError


ACTION = {"action": "look_around", "params": {}}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


@pytest.fixture
def state():
    return {"task": "把红球送到绿色存放区", "objects": [], "robot": {"holding": False},
            "junction_history": [], "recent_actions": []}


def literal_transcript(state, limit, recovered, version="autonomous-brain-llm/v12"):
    """Do not use current VERSION or produce a live record to manufacture v12."""
    request = {"model": "historical-model", "temperature": 0,
               "response_format": {"type": "json_object"}, "stream": True,
               "messages": [{"role": "system", "content": "Literal recorded v12 prompt, before route hints."},
                            {"role": "user", "content": canonical(state)}]}
    raw = canonical(ACTION)
    body = "data: " + json.dumps({"model": "historical-model", "choices": [
        {"index": 0, "delta": {"content": raw}}]}) + "\n\ndata: [DONE]\n\n"
    rows = []
    for i in range(limit + 1):
        success = recovered and i == limit
        rows.append({"version": version, "call_index": i + 1, "decision_index": 1, "attempt": 1,
                     "mode": "live", "request": copy.deepcopy(request),
                     "request_sha256": hashlib.sha256(canonical(request).encode()).hexdigest(),
                     "response_body": body if success else None,
                     "response_model": "historical-model" if success else None,
                     "raw_output": raw if success else None, "action": ACTION if success else None,
                     "validation_error": None, "transport_error": None if success else {"type": "URLError"},
                     "elapsed_s": (i + 1) / 4, "transport_timeout_s": 180,
                     "transport_retry_limit": limit, "transport_retry_index": i,
                     "transport_retry_delay_s": 0 if i == 0 else 2 ** (i - 1),
                     "transport_diagnostics": ({"phase": "read_stream", "received_bytes": len(body.encode())}
                        if success else {"phase": "open", "received_bytes": 0,
                                         "reason_type": "ConnectionResetError", "reason_errno": 104})})
    return rows


def write_rows(path, rows):
    path.write_text("".join(canonical(row) + "\n" for row in rows))


def read_rows(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


class DeniedEnvironment:
    def deny(self, *args, **kwargs):
        raise AssertionError("replay read the environment")

    get = __getitem__ = __iter__ = __contains__ = keys = items = values = deny


@contextmanager
def offline_only():
    with patch("autonomous_brain.llm.os.environ", new=DeniedEnvironment()), \
            patch("urllib.request.urlopen", side_effect=AssertionError("replay used network")) as network, \
            patch("autonomous_brain.llm.time.sleep", side_effect=AssertionError("replay slept")) as sleep:
        yield
    network.assert_not_called()
    sleep.assert_not_called()


@pytest.mark.parametrize("limit", [3, 5])
@pytest.mark.parametrize("recovered", [False, True], ids=["exhausted", "recovered"])
def test_literal_v12_extended_retry_replay_is_exact(tmp_path, state, limit, recovered):
    rows = literal_transcript(state, limit, recovered)
    source, output = tmp_path / "literal-v12.jsonl", tmp_path / "replayed.jsonl"
    write_rows(source, rows)
    original = source.read_bytes()
    with offline_only():
        with LLMClient(output, replay_path=source) as client:
            assert client.transport_retries == limit
            assert client.system_prompt == rows[0]["request"]["messages"][0]["content"]
            if recovered:
                assert client.decide(state) == ACTION
            else:
                with pytest.raises(LLMRequestError, match="URLError"):
                    client.decide(state)
            assert client.call_count == limit + 1
            client.assert_replay_consumed()
    assert source.read_bytes() == original
    assert read_rows(output) == [dict(row, mode="replay") for row in rows]
    assert all("exploration_hints" not in json.loads(row["request"]["messages"][1]["content"])
               for row in read_rows(output))


@pytest.mark.parametrize("version", ["autonomous-brain-llm/v12", "autonomous-brain-llm/v13",
                                     "autonomous-brain-llm/v14"])
@pytest.mark.parametrize("row_index", [0, 1])
@pytest.mark.parametrize("field", ["transport_retry_limit", "transport_retry_index",
                                   "transport_retry_delay_s", "transport_diagnostics"])
def test_literal_modern_versions_require_metadata_on_every_call(tmp_path, state, version, row_index, field):
    rows = literal_transcript(state, 3, True, version)
    rows[row_index].pop(field)
    source = tmp_path / "missing.jsonl"
    write_rows(source, rows)
    with offline_only():
        with LLMClient(tmp_path / "replayed.jsonl", replay_path=source) as client:
            with pytest.raises(ReplayError, match="transport"):
                client.decide(state)
            assert client.call_count == row_index


@pytest.mark.parametrize("limit", [3, 5])
def test_literal_v11_cannot_inherit_newer_retry_budget(tmp_path, state, limit):
    rows = literal_transcript(state, limit, True, "autonomous-brain-llm/v11")
    for row in rows:
        row.pop("transport_diagnostics")
    source = tmp_path / "v11-over-budget.jsonl"
    write_rows(source, rows)
    with offline_only(), pytest.raises(ReplayError, match="invalid transport retry limit"):
        LLMClient(tmp_path / "replayed.jsonl", replay_path=source)


@pytest.mark.parametrize("hints", [[], [{"kind": "recorded_directed_route", "next_exit_angle_deg": 90,
    "target_node_id": "junction-2", "target_exit_index": 1, "target_heading_deg": -90,
    "recorded_travelled_cm": 140, "cost_basis": "sum_public_odometry_distanceCm_differences",
    "traversal_ids": ["traversal-1"], "target_anchor_gap_cm": 2,
    "requires_fresh_arrival_and_exit_recheck": True}]])
def test_v13_prompt_transmits_hints_without_overriding_the_model_or_completion(tmp_path, state, hints):
    state["robot"].update({"at_node": True, "exit_angles": [90, -90]})
    state["exploration_hints"] = hints
    state["unexplored_exit_count"] = 7
    state["completion"] = {"pending_objects": ["wm-pending"]}
    before = copy.deepcopy(state)
    settings = {"LLM_BASE_URL": "https://model.example/v1", "LLM_API_KEY": "mock-test-secret",
                "LLM_MODEL": "configured-model"}
    # A hint remains advisory: the model can choose a different legal fresh exit.
    selected = {"action": "explore", "params": {"exit_angle": -90}}
    body = json.dumps({"model": "served-model", "choices": [
        {"message": {"content": canonical(selected)}, "finish_reason": "stop"}]})
    with patch("autonomous_brain.llm.os.environ.get", side_effect=settings.get), \
            patch("urllib.request.urlopen", return_value=io.BytesIO(body.encode())) as send:
        with LLMClient(tmp_path / "live.jsonl", stream=False) as client:
            assert client.decide(state) == selected
    assert state == before
    request = json.loads(send.call_args.args[0].data)
    assert json.loads(request["messages"][1]["content"]) == state
    assert request["temperature"] == 0 and type(request["temperature"]) is int
    prompt = request["messages"][0]["content"]
    for phrase in ("current_fresh_unexplored", "recorded_directed_route", "原样属于本轮 robot.exit_angles",
                   "每轮重新检查", "空 exploration_hints 不代表探索完成", "不证明物理路口身份相同",
                   "task_spec.quantity_mode", "known 时只按指令给出的 required_count", "无需探索完整地图",
                   "completion.ready_for_done", "unknown 时继续探索", "go_to 和 pick 只能选择当前状态为 CONFIRMED"):
        assert phrase in prompt
    assert read_rows(tmp_path / "live.jsonl")[0]["version"] == "autonomous-brain-llm/v15"
