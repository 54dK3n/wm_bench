"""Formal configuration, interrupted calls, and actual dependency evidence."""
import io
import json
from pathlib import Path
import sys
from types import ModuleType
from unittest.mock import patch

import pytest

from autonomous_brain.llm import LLMClient
from autonomous_brain.provenance import capture_world_model_provenance


@pytest.fixture
def formal_env(monkeypatch):
    for key, value in {"LLM_BASE_URL": "https://example.invalid/v1",
                       "LLM_API_KEY": "test-secret", "LLM_MODEL": "deepseek-flash",
                       "LLM_TEMPERATURE": "0", "LLM_THINKING": "disabled"}.items():
        monkeypatch.setenv(key, value)


@pytest.mark.parametrize("key,value", [("LLM_MODEL", "deepseek-chat"),
                                      ("LLM_TEMPERATURE", "0.1"),
                                      ("LLM_THINKING", "enabled"),
                                      ("LLM_THINKING", None)])
def test_formal_config_rejects_before_any_request(tmp_path, formal_env, monkeypatch, key, value):
    if value is None:
        monkeypatch.delenv(key)
    else:
        monkeypatch.setenv(key, value)
    with patch("urllib.request.urlopen", side_effect=AssertionError("must not request")):
        with LLMClient(tmp_path / "llm.jsonl") as client:
            with pytest.raises(ValueError, match="Formal run requires"):
                client.validate_formal_configuration()
            assert client.call_count == 0


def test_interrupted_request_retains_started_input_without_fabricated_finish(tmp_path, formal_env):
    state = {"task": "把两个红球送到绿色存放区", "objects": [], "robot": {},
             "junction_history": [], "recent_actions": []}
    with LLMClient(tmp_path / "llm.jsonl") as client:
        assert client.validate_formal_configuration()["formal_run"] is True
        with patch("urllib.request.urlopen", side_effect=KeyboardInterrupt), pytest.raises(KeyboardInterrupt):
            client.decide(state)
        rows = [json.loads(line) for line in client.lifecycle_path.read_text().splitlines()]
        assert len(rows) == 1 and rows[0]["event"] == "started"
        assert json.loads(rows[0]["request"]["messages"][1]["content"]) == state
        assert rows[0]["call_index"] == 1
        assert (tmp_path / "llm.jsonl").read_text() == ""
        assert "test-secret" not in client.lifecycle_path.read_text()


def test_finished_lifecycle_preserves_legacy_transcript_replay(tmp_path, formal_env, monkeypatch):
    state = {"task": "historical instruction", "objects": [], "robot": {},
             "junction_history": [], "recent_actions": []}
    monkeypatch.setenv("LLM_MODEL", "historical-model")
    monkeypatch.setenv("LLM_TEMPERATURE", "0.6")
    monkeypatch.setenv("LLM_THINKING", "enabled")
    response = io.BytesIO(json.dumps({"choices": [{"message": {"content":
        '{"action":"look_around","params":{}}'}, "finish_reason": "stop"}]}).encode())
    with patch("urllib.request.urlopen", return_value=response):
        with LLMClient(tmp_path / "old.jsonl", stream=False) as client:
            expected = client.decide(state)
    lifecycle = [json.loads(line) for line in (tmp_path / "old.lifecycle.jsonl").read_text().splitlines()]
    assert [row["event"] for row in lifecycle] == ["started", "finished"]
    assert lifecycle[-1]["elapsed_s"] >= 0
    assert lifecycle[-1]["action"] == expected
    with LLMClient(tmp_path / "replay.jsonl", replay_path=tmp_path / "old.jsonl") as client:
        assert client.validate_formal_configuration() == {"model": "historical-model",
            "temperature": 0.6, "thinking": "enabled", "stream": False,
            "response_format": {"type": "json_object"}, "mode": "replay",
            "formal_run": False, "recorded_parameters_preserved": True}
        assert client.decide(state) == expected
        client.assert_replay_consumed()


def test_dependency_content_change_and_location_override_are_detected(tmp_path, monkeypatch):
    package = tmp_path / "alternate" / "world_model"
    package.mkdir(parents=True)
    source = package / "__init__.py"
    source.write_text("version = 1\n")
    module = ModuleType("world_model")
    module.__file__ = str(source)
    # Avoid the test process's separately imported default package submodules.
    with patch.dict(sys.modules, {"world_model": module}, clear=True):
        before = capture_world_model_provenance(package.parent)
        source.write_text("version = 2\n")
        after = capture_world_model_provenance(package.parent)
        assert before["source_tree_sha256"] != after["source_tree_sha256"]
        assert after["loaded_package"] == str(package)
        assert after["declared_version"] is None
        with pytest.raises(RuntimeError, match="differs"):
            capture_world_model_provenance(tmp_path / "default")
