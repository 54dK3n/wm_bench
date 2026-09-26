#!/usr/bin/env python3
"""Reproduce R2's function-only gap and its regression; never evaluate a run."""
from __future__ import annotations

import argparse
import ast
import hashlib
import inspect
import json
from pathlib import Path
import subprocess
import sys
import types


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--baseline", default="d1538f7570a42b760ad518f133eaefd7bcac83a8")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    repo = args.repo.resolve()
    sys.path[:0] = [str(repo), str(repo / "tests"), str(repo / "vendor/wm_kit_opt2")]
    from brain_evidence_fixtures import task_fixture
    from test_brain_evidence_reliability import mutate_ball_everywhere
    from autonomous_brain.actions import ball_inside_region
    path = repo / "tools/evaluate_autonomous_brain.py"
    original = subprocess.run(["git", "show", args.baseline + ":tools/evaluate_autonomous_brain.py"],
                              cwd=repo, check=True, stdout=subprocess.PIPE).stdout.decode()
    current = path.read_text()
    results = []
    for name, source in (("baseline", original), ("candidate", current)):
        module = types.ModuleType("geometry_probe_" + name)
        module.__file__ = str(path)
        exec(compile(source, str(path), "exec"), module.__dict__)
        function = next(node for node in ast.parse(source).body
                        if isinstance(node, ast.FunctionDef) and node.name == "evaluate_task_scope")
        fixture = task_fixture()
        mutate_ball_everywhere(fixture, {"x": 500, "y": 400, "w": 30, "h": 30})
        placement = fixture[0]["action_evidence"][1]["evidence"]["placement"]
        result = module.evaluate_task_scope(*fixture[:len(inspect.signature(module.evaluate_task_scope).parameters)])
        results.append({"version": name, "evaluator_sha256": hashlib.sha256(source.encode()).hexdigest(),
            "function_ast_sha256": hashlib.sha256(ast.dump(function, include_attributes=False).encode()).hexdigest(),
            "ball_inside_region": ball_inside_region(placement["ball_bbox"], placement["storage_bbox"]),
            "failures": result["failures"]})
    report = {"scope": "evaluate_task_scope_function_only", "full_evaluate_run_executed": False,
              "simulator_or_model_called": False, "baseline": args.baseline, "results": results}
    with args.out.open("x") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
