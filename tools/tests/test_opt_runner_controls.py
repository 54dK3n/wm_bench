"""Runner safety regressions; subprocesses are replaced, never start a simulator."""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_opt_batch as runner


@pytest.fixture
def setup_runner(tmp_path, monkeypatch):
    source = tmp_path / "student.py"
    source.write_text('PROGRAM_VERSION = "synthetic-test"\nWM_KIT_COMMIT = "synthetic"\nblob = base64.b64decode("AA==")\n')
    folder = tmp_path / "round-1"
    folder.mkdir()
    runner.save(folder / "preflight.json", {"all_pass": True, "sha256": runner.sha(source)})
    monkeypatch.setattr(runner, "DEPENDENCIES", ())
    args = SimpleNamespace(out=str(folder), program=str(source), resume=False, node="never-executed",
                           timeout_ms=1, max_allocations=1)
    return args, source, folder


def test_unknown_execution_keeps_active_and_refuses_resume(setup_runner, monkeypatch):
    args, _source, folder = setup_runner
    calls = []
    def unknown(command, **kwargs):
        calls.append(command)
        kwargs["stdout"].write("running program\n")
        return SimpleNamespace(returncode=1)
    monkeypatch.setattr(runner.subprocess, "run", unknown)
    with pytest.raises(RuntimeError, match="Unknown execution state"):
        runner.run(args)
    progress = json.loads((folder / "progress.json").read_text())
    assert progress["active"] and progress["completed"] == {}
    args.resume = True
    with pytest.raises(ValueError, match="may have executed"):
        runner.run(args)
    assert len(calls) == 1


def test_executed_error_consumes_layout_and_resume_only_requests_pending(setup_runner, monkeypatch):
    args, source, folder = setup_runner
    requests = []
    def executed(command, **kwargs):
        pending = command[command.index("--want-maps") + 1].split(",")
        requests.append(pending)
        output = Path(command[command.index("--out") + 1])
        runner.save(output, {"assignedMap": pending[0],
            "lines": [{"event": "program_version", **runner.program_identity(source)}],
            "record": {"events": [{"type": "program_error", "message": "synthetic executed failure"}]}})
        kwargs["stdout"].write("running program\n")
        return SimpleNamespace(returncode=1)
    monkeypatch.setattr(runner.subprocess, "run", executed)
    runner.run(args)
    first_bytes = (folder / "map-01.json").read_bytes()
    args.resume, args.max_allocations = True, 2
    runner.run(args)
    progress = json.loads((folder / "progress.json").read_text())
    assert set(progress["completed"]) == {"map-01", "map-02"}
    assert "map-01" not in requests[1]
    assert (folder / "map-01.json").read_bytes() == first_bytes
    assert progress["active"] is None


def test_changed_frozen_dependency_is_rejected(tmp_path):
    dependency = tmp_path / "helper.py"
    dependency.write_text("original\n")
    runner.save(tmp_path / "code_manifest.json", {str(dependency): runner.sha(dependency)})
    assert all(runner.verify_freeze(tmp_path).values())
    dependency.write_text("changed\n")
    with pytest.raises(RuntimeError, match="Frozen optimization files changed"):
        runner.verify_freeze(tmp_path)


def test_missing_preflight_never_starts_execution(setup_runner, monkeypatch):
    args, _source, folder = setup_runner
    runner.save(folder / "preflight.json", {"all_pass": False, "sha256": "unknown"})
    def forbidden(*_args, **_kwargs):
        raise AssertionError("subprocess must never start")
    monkeypatch.setattr(runner.subprocess, "run", forbidden)
    with pytest.raises(ValueError, match="passing preflight"):
        runner.run(args)
