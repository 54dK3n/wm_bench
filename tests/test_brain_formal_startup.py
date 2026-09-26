"""A rejected formal model must prevent constructing the robot runtime."""
import json

import pytest

from autonomous_brain import run


@pytest.mark.parametrize("override", [
    {"LLM_MODEL": "deepseek-chat"},
    {"LLM_TEMPERATURE": "0.1"},
    {"LLM_THINKING": "enabled"},
])
def test_main_rejects_wrong_config_before_robot_runtime(tmp_path, monkeypatch, override):
    values = {"LLM_BASE_URL": "https://example.invalid/v1", "LLM_API_KEY": "synthetic-secret",
              "LLM_MODEL": "deepseek-flash", "LLM_TEMPERATURE": "0", "LLM_THINKING": "disabled"}
    values.update(override)
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(run, "read_config", lambda: {
        "schema": "autonomous-brain-robot-config/v1", "origin": "http://robot.invalid",
        "bridge_id": "synthetic", "client_token": "synthetic",
        "task": "把两个红球送到绿色存放区", "simulation_step_ms": 20,
        "max_rounds": 200, "max_simulation_seconds": 1200})
    constructions = []

    def forbidden_runtime(*args, **kwargs):
        constructions.append(True)
        raise AssertionError("Robot Runtime must not be constructed with the wrong model configuration")

    monkeypatch.setattr(run, "Runtime", forbidden_runtime)
    out = tmp_path / "brain"
    assert run.main(["--out", str(out)]) == 1
    assert constructions == []
    summary = json.loads((out / "summary.json").read_text())
    assert summary["status"] == "failed"
    assert "Formal run requires" in summary["reason"]
    assert summary["simulation_seconds"] == summary["rounds"] == summary["llm_calls"] == 0
    assert summary["observations"] == 0
    assert not (out / "bridge-calls.jsonl").exists()
    assert not (out / "motions.jsonl").exists()
    assert (out / "rounds.jsonl").read_text() == ""
