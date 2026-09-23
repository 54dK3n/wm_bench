"""Stage-2 runner ledger safety; every subprocess is stubbed, no simulator."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_opt2_batch as runner


@pytest.fixture
def harness(tmp_path, monkeypatch):
    source = tmp_path / "student.py"
    source.write_text('PROGRAM_VERSION = "synthetic"\nWM_KIT_COMMIT = "synthetic"\nblob = base64.b64decode("AA==")\n')
    runner.save(source.with_suffix(".build.json"), {"fragments": {}})
    folder = tmp_path / "round-1"
    folder.mkdir()
    monkeypatch.setattr(runner, "freeze_paths", lambda source, frozen, build: [source, frozen])
    monkeypatch.setattr(runner, "retain_execution_evidence", lambda *args: {"synthetic_evidence": True})
    args = SimpleNamespace(out=str(folder), program=str(source), resume=False, node="never-executed",
                           timeout_ms=1, max_allocations=1)
    calls = []
    def preflight_or_execute(handler):
        def invoke(command, **kwargs):
            calls.append(command)
            if command[1].endswith("opt2_preflight.py"):
                runner.save(folder / "preflight.json", {"all_pass": True, "sha256": runner.sha(source)})
                return SimpleNamespace(returncode=0)
            return handler(command, kwargs)
        monkeypatch.setattr(runner.subprocess, "run", invoke)
    return args, source, folder, calls, preflight_or_execute


def test_unknown_execution_blocks_replay_and_does_not_repeat_preflight(harness):
    args, _source, folder, calls, install = harness
    def unknown(_command, kwargs):
        kwargs["stdout"].write("running program\n")
        return SimpleNamespace(returncode=1)
    install(unknown)
    with pytest.raises(RuntimeError, match="Unknown execution state"):
        runner.run(args)
    progress = json.loads((folder / "progress.json").read_text())
    assert progress["active"] and not progress["completed"]
    args.resume = True
    with pytest.raises(ValueError, match="unresolved active"):
        runner.run(args)
    assert len(calls) == 2  # preflight once, driver once


def test_executed_failure_consumes_layout_and_resume_only_requests_pending(harness):
    args, source, folder, calls, install = harness
    requests = []
    def executed(command, kwargs):
        pending = command[command.index("--want-maps") + 1].split(",")
        requests.append(pending)
        output = Path(command[command.index("--out") + 1])
        runner.save(output, {"assignedMap": pending[0], "lines": [{"event": "program_version", **runner.program_identity(source)}],
                             "record": {"events": [{"type": "program_error"}]}})
        kwargs["stdout"].write("running program\n")
        return SimpleNamespace(returncode=1)
    install(executed)
    runner.run(args)
    original = (folder / "map-01.json").read_bytes()
    args.resume, args.max_allocations = True, 2
    runner.run(args)
    progress = json.loads((folder / "progress.json").read_text())
    assert set(progress["completed"]) == {"map-01", "map-02"}
    assert "map-01" not in requests[1]
    assert (folder / "map-01.json").read_bytes() == original
    assert len([call for call in calls if call[1].endswith("opt2_preflight.py")]) == 1


def test_evidence_failure_consumes_layout_and_continues_batch(harness, monkeypatch):
    args, source, folder, _calls, install = harness
    def executed(command, _kwargs):
        output = Path(command[command.index("--out") + 1])
        pending = command[command.index("--want-maps") + 1].split(",")
        runner.save(output, {"assignedMap": pending[0], "lines": [{"event": "program_version", **runner.program_identity(source)}],
                             "record": {"events": [{"type": "program_error"}]}})
        return SimpleNamespace(returncode=1)
    def missing(*_args):
        return {"evidence_all_pass": False, "evidence_errors": ["executed_native_record_missing"]}
    monkeypatch.setattr(runner, "retain_execution_evidence", missing)
    install(executed)
    args.max_allocations = 2
    runner.run(args)
    progress = json.loads((folder / "progress.json").read_text())
    assert set(progress["completed"]) == {"map-01", "map-02"} and progress["active"] is None
    assert progress["completed"]["map-01"]["evidence_all_pass"] is False


def test_preflight_failure_never_starts_driver(harness, monkeypatch):
    args, _source, _folder, _calls, _install = harness
    calls = []
    def failure(command, **_kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=1)
    monkeypatch.setattr(runner.subprocess, "run", failure)
    with pytest.raises(ValueError, match="preflight must pass"):
        runner.run(args)
    assert len(calls) == 1 and calls[0][1].endswith("opt2_preflight.py")


def test_changed_dependency_is_recorded_false_without_masking(tmp_path):
    path = tmp_path / "dependency.py"
    path.write_text("original")
    runner.save(tmp_path / "code_manifest.json", {str(path): runner.sha(path)})
    path.write_text("changed")
    assert runner.freeze_checks(tmp_path) == {str(path): False}
    with pytest.raises(RuntimeError, match="Frozen stage-2"):
        runner.verify_freeze(tmp_path)


def test_source_archive_preserves_bytes_after_later_source_change(tmp_path):
    source = tmp_path / "program.py"
    original = 'print("原样")\n'.encode()
    source.write_bytes(original)
    folder = tmp_path / "round-1"
    folder.mkdir()
    index = runner.archive_sources(folder, [source])
    source.write_text("later revision\n")
    archived = folder / index[str(source)]["archive"]
    assert archived.read_bytes() == original
    assert runner.sha(archived) == index[str(source)]["sha256"]


def test_native_executed_snapshot_is_byte_exact(tmp_path, monkeypatch):
    source = 'print("中文")'
    native = {"sourceCode": source, "events": []}
    native_path = tmp_path / "record.json"
    runner.save(native_path, native)
    raw = {"fullRecordFile": str(native_path), "record": {"events": []},
           "fullRecordExport": {"sha256": runner.sha(native_path), "bytes": native_path.stat().st_size}}
    raw_path = tmp_path / "map-01.json"
    runner.save(raw_path, raw)
    monkeypatch.setattr(runner, "evidence_audit", lambda *_args: ({}, {key: {"status": "pass"} for key in
        ("full_raw_record_preserved", "samples_preserved", "native_png_evidence_complete", "driver_keyframes_preserved")}))
    monkeypatch.setattr(runner, "native_evidence", lambda *_args: {"all_pass": True, "mismatches": []})
    identity = {"file_sha256": runner.hashlib.sha256(source.encode()).hexdigest()}
    result = runner.retain_execution_evidence(raw_path, identity, tmp_path)
    assert (tmp_path / "executed_program.py").read_bytes() == source.encode()
    assert result["executed_source_sha256"] == identity["file_sha256"]
