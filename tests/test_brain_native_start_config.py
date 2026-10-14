"""Restore the proven startup shape after the094938 thread/start rejection.

The exact public RPC error is replayed through a synthetic process peer; no
native inference, user configuration change or robot competition is started.
"""
import io
import json
from unittest.mock import patch

import pytest

from autonomous_brain import chatgpt_transport as transport
from autonomous_brain.llm import LLMClient, LLMRequestError
from autonomous_brain.orchestration import LiveOrchestration
from test_brain_chatgpt_transport import fixture
from test_brain_grab_authorization import AuthorizationRuntime
from test_brain_native_retry import decision_state, records
from test_brain_octos_orchestration import OCTOS


def test_start_config_preserves_original_controls_without_incomplete_cua_server():
    params = transport.start_params(fixture()["request"], "/synthetic-empty-directory")
    assert "mcp_servers.cua_repl.enabled" not in params["config"]
    assert params["config"] == {"model_reasoning_effort":"low", "features.shell_tool":False,
        "features.apply_patch_freeform":False, "features.multi_agent":False,
        "features.apps":False, "apps._default.enabled":False,
        "mcp_servers.node_repl.enabled":False, "mcp_servers.computer-use.enabled":False,
        "web_search":"disabled"}
    assert params["approvalPolicy"] == "never" and params["sandbox"] == "read-only"
    assert params["model"] == "gpt-6.1-sol" and params["modelProvider"] == "openai"
    assert params["allowProviderModelFallback"] is False
    assert params["environments"] == params["dynamicTools"] == []
    assert "Do not use tools" in params["developerInstructions"]


def test_original_invalid_transport_rpc_never_retries_or_reaches_robot_dispatch(tmp_path, monkeypatch):
    # Exact non-private id3 failure from094938. Earlier handshake replies are
    # synthetic and contain no user account data or credentials.
    error = {"code":-32600,
             "message":"failed to load configuration: invalid transport\nin `mcp_servers.cua_repl`\n"}
    payload = [{"id":1,"result":{}}, {"id":2,"result":{"account":{"type":"chatgpt"}}},
               {"id":3,"error":error}]
    children = []
    class Process:
        def __init__(self):
            self.stdin=io.StringIO()
            self.stdout=iter(json.dumps(row)+"\n" for row in payload)
            self.terminated=False
            self.waited=False
        def terminate(self): self.terminated=True
        def wait(self, timeout):
            self.waited=True
            return 0
    def popen(*args, **kwargs):
        proc=Process();children.append(proc);return proc
    monkeypatch.setenv("LLM_TRANSPORT", transport.TRANSPORT)
    monkeypatch.setenv("LLM_MODEL", transport.MODEL)
    monkeypatch.setenv("LLM_CODEX_BINARY", "synthetic-protocol-peer")
    r=AuthorizationRuntime()
    before_obs, before_commands=r.snapshot["observation_index"], len(r.bridge_records)
    with patch("autonomous_brain.llm.time.sleep") as sleep:
        with LLMClient(tmp_path/"config-error.jsonl", transport_retries=1) as client:
            adapter=LiveOrchestration(r, client, OCTOS)
            monkeypatch.setattr(transport.subprocess, "Popen", popen)
            with pytest.raises(LLMRequestError): adapter.run_next(1, decision_state(r.perception.objects()))
            assert adapter.last_action is None
            assert client.call_count == client.decision_count == 1
        assert sleep.call_count == 0
    assert len(children) == 1 and children[0].terminated and children[0].waited
    sent=[json.loads(row) for row in children[0].stdin.getvalue().splitlines()]
    assert [row["method"] for row in sent] == ["initialize","initialized","account/read","thread/start"]
    saved=records(tmp_path/"config-error.jsonl")[0]
    assert saved["transport_error"] == {"type":"ValueError"} and saved["action"] is None
    assert saved["transport_retry_limit"] == 1 and saved["transport_retry_index"] == 0
    assert json.loads(saved["response_body"].splitlines()[-1])["error"] == error
    assert r.snapshot["observation_index"] == before_obs and len(r.bridge_records) == before_commands
