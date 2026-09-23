"""Uncertain or identity-mismatched executions must never be automatically replayed."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import run_demo


@pytest.mark.parametrize("failure", ["execution_unknown", "identity_mismatch"])
def test_unresolved_execution_blocks_resume(tmp_path, monkeypatch, failure):
    program = tmp_path / "demo.py"
    program.write_bytes((ROOT / "programs/world_model_two_target_demo.py").read_bytes())
    for name in run_demo.MANIFEST_FILES:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("frozen test dependency\n")
    monkeypatch.setattr(run_demo, "ROOT", tmp_path)
    calls = []

    def driver(command, **kwargs):
        if "--mission" not in command:
            return SimpleNamespace(returncode=0)
        calls.append(command)
        kwargs["stdout"].write("INLOOP running program\n")
        kwargs["stdout"].flush()
        if failure == "identity_mismatch":
            output = Path(command[command.index("--out") + 1])
            output.write_text(json.dumps({"assignedMap": "map-03", "lines": [
                {"event": "program_version", "version": "wrong"}],
                "record": {"events": [{"type": "program_finished"}]}}))
        return SimpleNamespace(returncode=1)

    monkeypatch.setattr(run_demo.subprocess, "run", driver)
    args = SimpleNamespace(program=str(program), out=str(tmp_path / "out"), map="map-03",
                           resume=False, max_allocations=2, node="node", timeout_ms=1000)
    with pytest.raises(RuntimeError):
        run_demo.run(args)
    progress = json.loads((tmp_path / "out/progress.json").read_text())
    assert progress["active"] is not None
    assert progress["active"]["requested_map"] == "map-03"
    if failure == "identity_mismatch":
        assert "map-03" in progress["completed"]
        assert (tmp_path / "out/map-03.json").is_file()
    args.resume = True
    with pytest.raises(ValueError, match="may have executed"):
        run_demo.run(args)
    assert len(calls) == 1
