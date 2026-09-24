"""Refactor gates reject shadowing, behavior changes and ambient platform paths."""
import ast
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import platform_paths
from refactor_preflight import BASELINE, check_build, duplicate_functions, inspect_refactor

ROOT = Path(__file__).resolve().parents[2]
CURRENT = ROOT / "programs/world_model_opt2.py"


def test_same_scope_shadowing_detected_even_in_conditional_branch():
    tree = ast.parse("def same(): pass\nif flag:\n    def same(): pass\n")
    assert duplicate_functions(tree) == [{"scope": "module", "name": "same", "lines": [1, 3]}]


def test_independent_function_scopes_do_not_collide():
    tree = ast.parse("def a():\n    def local(): pass\ndef b():\n    def local(): pass\n")
    assert duplicate_functions(tree) == []


def test_new_runtime_source_is_unique_and_retains_final_effective_behavior():
    result, tree = inspect_refactor(CURRENT)
    assert all(result["checks"].values()), result
    assert all(check_build(CURRENT, tree)["checks"].values())


def test_historical_final_program_actually_contains_the_removed_shadowing():
    duplicates = duplicate_functions(ast.parse(BASELINE.read_text()))
    assert {item["name"] for item in duplicates} == {
        "_vp_enter", "_vp_travel", "_wm_target", "release_target_at_storage"}


def test_changed_live_control_is_rejected(tmp_path):
    tree = ast.parse(CURRENT.read_text())
    target = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_opt2_travel_speed")
    target.body = [ast.Return(value=ast.Constant(value=101))]
    changed = tmp_path / "changed.py"
    changed.write_text(ast.unparse(tree))
    result, _ = inspect_refactor(changed)
    assert not result["checks"]["effective_runtime_functions_AST_unchanged"]
    assert result["runtime_function_checks"]["_opt2_travel_speed"] is False


def test_factory_cannot_silently_change_confirmation_range(tmp_path):
    text = CURRENT.read_text()
    assert text.count("guangyang_static_world_model(max_range_m=0.9)") == 1
    changed = tmp_path / "changed.py"
    changed.write_text(text.replace("guangyang_static_world_model(max_range_m=0.9)",
                                    "guangyang_static_world_model(max_range_m=1.0)"))
    result, _ = inspect_refactor(changed)
    assert not result["checks"]["explicit_locked_guangyang_factory"]


def test_platform_requires_explicit_environment(monkeypatch):
    monkeypatch.delenv("GUANGYANG_PLATFORM_ROOT", raising=False)
    assert platform_paths.platform_root(required=False) is None
    with pytest.raises(ValueError, match="GUANGYANG_PLATFORM_ROOT"):
        platform_paths.platform_root()


def test_platform_worker_override_cannot_bypass_environment(tmp_path, monkeypatch):
    platform = tmp_path / "configured"
    platform.mkdir()
    (platform / "python-worker.js").write_text("fixture")
    monkeypatch.setenv("GUANGYANG_PLATFORM_ROOT", str(platform))
    assert platform_paths.platform_worker() == platform / "python-worker.js"
    with pytest.raises(ValueError, match="must match"):
        platform_paths.platform_worker(tmp_path / "other-worker.js")


def test_frozen_reference_is_portable_and_cannot_escape(tmp_path, monkeypatch):
    repo, platform = tmp_path / "repo", tmp_path / "platform"
    repo.mkdir(); platform.mkdir()
    monkeypatch.setattr(platform_paths, "ROOT", repo)
    monkeypatch.setenv("GUANGYANG_PLATFORM_ROOT", str(platform))
    assert platform_paths.file_reference(repo / "tools/a.py") == "tools/a.py"
    assert platform_paths.file_reference(platform / "worker.js") == "@platform/worker.js"
    assert platform_paths.resolve_reference("@platform/worker.js") == platform / "worker.js"
    with pytest.raises(ValueError, match="escapes"):
        platform_paths.resolve_reference("@platform/../outside")
    with pytest.raises(ValueError, match="escapes"):
        platform_paths.repository_path("../outside")
