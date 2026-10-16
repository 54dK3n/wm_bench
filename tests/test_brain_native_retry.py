"""Synthetic native receipts; real LLM retry, Executor and Actions boundaries.

No native model request or platform competition is started by these tests.
"""
import copy
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from autonomous_brain import chatgpt_transport as transport, run
from autonomous_brain.llm import LLMClient, LLMRequestError, CHATGPT_VERSION
from autonomous_brain.orchestration import LiveOrchestration
from test_brain_chatgpt_transport import rows as native_rows, fixture
from test_brain_grab_authorization import AuthorizationRuntime, actual_grabs
from test_brain_octos_orchestration import OCTOS


def native_body(request, action=None):
    rows = native_rows()
    text = json.dumps(action or {"action":"explore","params":{}}, separators=(",", ":"))
    for row in rows:
        item = (row.get("params") or {}).get("item") or {}
        if item.get("type") == "userMessage":
            item["content"][0]["text"] = json.dumps(request["messages"][1:], ensure_ascii=False, separators=(",", ":"))
        if item.get("type") == "agentMessage":
            item["text"] = text
        if row.get("method") == "turn/completed":
            row["params"]["turn"]["items"][0]["text"] = text
    return "\n".join(json.dumps(row) for row in rows)+"\n"


def partial_body(request):
    # Preserve a valid input receipt and optional partial output, without a
    # completed turn. The partial text must never be dispatched as an action.
    rows = [json.loads(line) for line in native_body(request).splitlines()]
    return "\n".join(json.dumps(row) for row in rows if row.get("method") != "turn/completed")+"\n"


def records(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def decision_state(objects=None):
    return {"task":"把两个红球送到绿色存放区", "objects":[{**row, "status":row["state"]} for row in objects or []],
            "robot":{"holding":False}, "junction_history":[], "recent_actions":[]}


@pytest.fixture(autouse=True)
def native_environment(monkeypatch):
    monkeypatch.setenv("LLM_TRANSPORT", transport.TRANSPORT)
    monkeypatch.setenv("LLM_MODEL", transport.MODEL)


@pytest.mark.parametrize("outcome", ["success", "second_timeout", "unknown_grab"])
def test_same_decision_retry_waits_without_dispatch_then_executor_runs_at_most_once(tmp_path, monkeypatch, outcome):
    r = AuthorizationRuntime(fault="unknown_receipt" if outcome == "unknown_grab" else None)
    state = decision_state(r.perception.objects())
    original = copy.deepcopy(state)
    before_bridge, before_obs = len(r.bridge_records), r.snapshot["observation_index"]
    requests, sleeps = [], []
    def invoke(request, timeout_s):
        assert len(r.bridge_records) == before_bridge and r.snapshot["observation_index"] == before_obs
        assert not actual_grabs(r) and state == original
        requests.append(copy.deepcopy(request))
        if len(requests) == 1 or outcome == "second_timeout":
            raise transport.TransportFailure(partial_body(request), "TimeoutError")
        return native_body(request, {"action":"pick", "params":{"object_id":r.object_id}})
    def sleep(seconds):
        assert len(r.bridge_records) == before_bridge and len(requests) == 1
        sleeps.append(seconds)
    path = tmp_path/"native.jsonl"
    monkeypatch.setattr(transport, "invoke", invoke)
    monkeypatch.setattr("autonomous_brain.llm.time.sleep", sleep)
    with LLMClient(path, transport_retries=1) as client:
        adapter = LiveOrchestration(r, client, OCTOS)
        r.round = 1
        if outcome == "second_timeout":
            with pytest.raises(LLMRequestError): adapter.run_next(1, state)
            assert adapter.last_action is None and len(r.bridge_records) == before_bridge
            assert client.call_count == 2 and client.decision_count == 1
            with pytest.raises(RuntimeError, match="stopped after an error"): client.decide(state)
        elif outcome == "unknown_grab":
            with pytest.raises(ConnectionError, match="synthetic_grab_ack_loss"): adapter.run_next(1, state)
            assert len(actual_grabs(r)) == 1 and r.pending_grasp is not None
            assert r.pending_grasp["grab_ref"]["outcome_unknown"] is True
        else:
            action, result = adapter.run_next(1, state)
            assert action == {"action":"pick", "params":{"object_id":r.object_id}}
            assert result["success"] and len(actual_grabs(r)) == 1
            assert adapter.executor.max_retries == 0
    saved = records(path)
    assert len(requests) == 2 and requests[0] == requests[1]
    assert sleeps == [1] and state == original
    assert saved[0]["action"] is None
    assert {row["decision_index"] for row in saved} == {1}
    assert {row["attempt"] for row in saved} == {1}
    assert [row["transport_retry_index"] for row in saved] == [0, 1]
    assert [row["transport_retry_delay_s"] for row in saved] == [0, 1]
    assert len({row["request_sha256"] for row in saved}) == 1
    assert all(row["version"] == CHATGPT_VERSION == "autonomous-brain-llm/v25" for row in saved)
    assert all(row["request"]["model"] == "gpt-6.1-sol" and row["request"]["thinking"] == {"type":"low"}
               for row in saved)
    assert [row["event"] for row in records(tmp_path/"native.lifecycle.jsonl")] == ["started","finished","started","finished"]
    if outcome == "success":
        with patch.object(transport, "invoke", side_effect=AssertionError("offline replay")), \
                patch("autonomous_brain.llm.time.sleep", side_effect=AssertionError("no replay sleep")):
            with LLMClient(tmp_path/"replay.jsonl", replay_path=path) as replay:
                assert replay.decide(state) == action
                replay.assert_replay_consumed()


@pytest.mark.parametrize("body", [None, "{", "[]\n", '{"method":"item/started","params":{"item":{"type":"mcpToolCall"}}}\n',
    '{"method":"item/started","params":{"item":{"type":"commandExecution"}}}\n',
    '{"method":"item/tool/requestUserInput","id":6,"params":{}}\n',
    '{"method":"model/rerouted","params":{}}\n', '{"id":6,"error":{"code":1}}\n',
    '{"method":"turn/completed","params":{"turn":{"items":[{"type":"mcpToolCall"}]}}}\n',
    '{"id":4,"result":{"turn":{"items":[{"type":"commandExecution"}]}}}\n',
    '{"id":3,"result":{"model":"other","modelProvider":"openai","reasoningEffort":"low"}}\n',
    '{"id":3,"result":{"model":"gpt-6.1-sol","modelProvider":"other","reasoningEffort":"low"}}\n',
    '{"id":3,"result":{"model":"gpt-6.1-sol","modelProvider":"openai","reasoningEffort":"high"}}\n',
    '{"id":3,"result":{"model":"gpt-6.1-sol","modelProvider":"openai","reasoningEffort":"low","thread":{"model":"other","environments":[]}}}\n',
    '{"id":3,"result":{"model":"gpt-6.1-sol","modelProvider":"openai","reasoningEffort":"low","thread":{"model":"gpt-6.1-sol","environments":[{"id":"local"}]}}}\n',
    '{"id":2,"result":{"account":{"type":"apiKey"}}}\n',
    '{"method":"turn/completed","params":{"turn":{"status":"failed","items":[]}}}\n',
    '{"method":"turn/completed","params":{"turn":{"status":"completed","error":{"code":1},"items":[]}}}\n',
    '{"id":4,"result":{"turn":{"error":{"code":1},"items":[]}}}\n',
    '{"method":"item/started","params":"invalid"}\n'])
def test_ambiguous_tool_or_malformed_partial_never_retries(tmp_path, body):
    with patch.object(transport, "invoke", side_effect=transport.TransportFailure(body, "TimeoutError")) as invoke, \
            patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(tmp_path/"unsafe.jsonl", transport_retries=1) as client:
            with pytest.raises(LLMRequestError): client.decide(decision_state())
        assert invoke.call_count == 1 and sleep.call_count == 0
    assert records(tmp_path/"unsafe.jsonl")[0]["action"] is None


@pytest.mark.parametrize("error", ["ValueError", "OSError", "TimeoutExpired", "ConnectionError"])
def test_nonallowlisted_native_failure_does_not_retry(tmp_path, error):
    with patch.object(transport, "invoke", side_effect=transport.TransportFailure("", error)) as invoke:
        with LLMClient(tmp_path/"failure.jsonl", transport_retries=1) as client:
            with pytest.raises(LLMRequestError): client.decide(decision_state())
        assert invoke.call_count == 1


def test_default_stays_no_retry_and_legacy22_record_keeps_its_request_and_semantics(tmp_path):
    state = decision_state()
    with patch.object(transport, "invoke", side_effect=transport.TransportFailure("", "TimeoutError")) as invoke:
        with LLMClient(tmp_path/"default.jsonl") as client:
            with pytest.raises(LLMRequestError): client.decide(state)
        assert invoke.call_count == 1
    # Construct a labelled old-version record from the unchanged old request;
    # this is a synthetic replay compatibility case, not a historical run.
    with patch.object(transport, "invoke", side_effect=lambda request, timeout: native_body(request)):
        with LLMClient(tmp_path/"current.jsonl") as client: assert client.decide(state)["action"] == "explore"
    legacy = records(tmp_path/"current.jsonl")[0]
    legacy["version"] = "autonomous-brain-llm/v22"
    (tmp_path/"legacy.jsonl").write_text(json.dumps(legacy)+"\n")
    with patch.object(transport, "invoke", side_effect=AssertionError("offline only")):
        with LLMClient(tmp_path/"legacy-replay.jsonl", replay_path=tmp_path/"legacy.jsonl") as client:
            assert client.decide(state)["action"] == "explore"
            client.assert_replay_consumed()
    replay = records(tmp_path/"legacy-replay.jsonl")[0]
    assert replay["version"] == "autonomous-brain-llm/v22" and replay["request"] == legacy["request"]


@pytest.mark.parametrize("limit", [-1, 6, True, 1.5, None])
def test_native_retry_limit_has_the_same_bounded_integer_validation(tmp_path, limit):
    with pytest.raises(ValueError, match="transport_retries"):
        LLMClient(tmp_path/"invalid.jsonl", transport_retries=limit)


@pytest.mark.parametrize("native,expected", [(True,1),(False,5)])
def test_runtime_selects_one_native_retry_and_preserves_http_five(tmp_path, monkeypatch, native, expected):
    if not native: monkeypatch.delenv("LLM_TRANSPORT", raising=False)
    captured=[]
    def client(**kwargs):
        captured.append(kwargs)
        raise RuntimeError("synthetic stop before runtime startup")
    monkeypatch.setattr(run, "LLMClient", client)
    monkeypatch.setattr(run, "read_config", lambda:{"task":"offline startup configuration", "max_rounds":1})
    assert run.main(["--out", str(tmp_path/"run")]) == 1
    assert len(captured) == 1 and captured[0]["transport_retries"] == expected


def test_pure_inference_start_disables_actual_cua_server_without_changing_profile():
    params=transport.start_params(fixture()["request"], "/synthetic-empty-directory")
    assert params["config"]["mcp_servers.cua_repl.enabled"] is False
    assert params["config"]["mcp_servers.computer-use.enabled"] is False
    assert params["dynamicTools"] == [] and params["environments"] == []
    assert params["model"] == "gpt-6.1-sol" and params["config"]["model_reasoning_effort"] == "low"
    assert params["allowProviderModelFallback"] is False


def test_timeout_terminates_and_reaps_the_native_child_before_return(tmp_path, monkeypatch):
    import subprocess
    import sys
    script=tmp_path/"silent_native_peer"
    script.write_text("#!"+sys.executable+"\nimport time\ntime.sleep(10)\n")
    script.chmod(0o700)
    monkeypatch.setenv("LLM_CODEX_BINARY", str(script))
    original=subprocess.Popen
    children=[]
    def popen(*args, **kwargs):
        proc=original(*args, **kwargs);children.append(proc);return proc
    monkeypatch.setattr(transport.subprocess, "Popen", popen)
    with pytest.raises(transport.TransportFailure) as failure:
        transport.invoke(fixture()["request"], .1)
    assert failure.value.kind == "TimeoutError"
    assert len(children) == 1 and children[0].poll() is not None
