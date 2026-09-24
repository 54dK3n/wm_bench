#!/usr/bin/env python3
"""Read-only demo program checks; save evidence before the first simulation."""
import argparse
import ast
import base64
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from run_diagnostic_batch import program_identity
from platform_paths import platform_root

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "artifacts/inloop/stage-1/round-3/program.py"
PLATFORM = platform_root(required=False)


def dump(node):
    return ast.dump(node, include_attributes=False)


def inspect_source(path):
    text = path.read_text()
    tree = ast.parse(text, filename=str(path))
    funcs = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
    values = {target.id: node.value for node in tree.body if isinstance(node, ast.Assign)
              for target in node.targets if isinstance(target, ast.Name)}
    return text, tree, funcs, values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--program", type=Path, default=ROOT / "programs/world_model_two_target_demo.py")
    parser.add_argument("--out", type=Path, default=ROOT / "artifacts/inloop/demo")
    args = parser.parse_args()
    folder = args.out.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    text, tree, funcs, values = inspect_source(args.program)
    base, _old_tree, old_funcs, old_values = inspect_source(BASELINE)
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYLINTHOME="/private/tmp/wm_bench_pylint_cache")
    env["PYTHONPATH"] = os.pathsep.join(filter(None, ("/private/tmp/wm_bench_pylint", env.get("PYTHONPATH"))))
    lint = subprocess.run([sys.executable, "-m", "pylint", "--disable=all",
                           "--enable=E1123,E1120,E1121,E0633,E0602", "--additional-builtins=robot",
                           str(args.program)], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (folder / "pylint.txt").write_text(lint.stdout)
    tests = subprocess.run([sys.executable, "-m", "pytest", "programs/tests", "tests/test_demo_flow.py", "tests/test_demo_runner.py", "-q"], cwd=ROOT,
                            env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (folder / "tests.txt").write_text(tests.stdout)
    coordinates = subprocess.run([sys.executable, str(ROOT / "tools/check_no_layout_constants.py"), str(args.program)],
                                 env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (folder / "static_coordinates.json").write_text(coordinates.stdout)
    worker = (platform_root() / "python-worker.js").read_text()
    transformer_source = worker[worker.index("class AsyncRobotTransformer("):worker.index("student_run_target =")]
    namespace = {"ast": ast}
    exec(transformer_source, namespace)
    transformed = namespace["AsyncRobotTransformer"](set(funcs)).visit(ast.parse(text))
    ast.fix_missing_locations(transformed)
    compile(transformed, str(args.program), "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    preserved_functions = {name: name in funcs and dump(funcs[name]) == dump(node)
                           for name, node in old_funcs.items()}
    protected_constants = {name: name in values and dump(values[name]) == dump(node)
                           for name, node in old_values.items()
                           if name.startswith(("CONFIRM_", "APPROACH_", "GRAB_"))
                           or name in ("RANGE_CAL", "WM_KIT_COMMIT", "MAX_OBSERVES", "MEMORY_FORWARD_MIN_CM")}
    blob = lambda source: base64.b64decode(re.search(r'b64decode\("([^\"]+)"\)', source).group(1))
    checks = {
        "pylint_zero_errors": lint.returncode == 0,
        "regression_checks_pass": tests.returncode == 0,
        "layout_coordinate_check_pass": coordinates.returncode == 0,
        "actual_platform_async_transform_compile": True,
        "embedded_package_unchanged": blob(base) == blob(text),
        "protected_constants_unchanged": all(protected_constants.values()),
        "calibration_functions_unchanged": all(preserved_functions[name] for name in ("calibrate_reading", "calibrated_detection", "uncalibrate_reading")),
        "confirmation_functions_unchanged": all(preserved_functions[name] for name in ("_record_hit", "_confirmation_result", "_try_enter_range_and_confirm")),
        "no_truth_api_tokens": not any(isinstance(node, ast.Name) and node.id == "get_truth"
                                       or isinstance(node, ast.Attribute) and node.attr == "get_truth" for node in ast.walk(tree)),
        "removed_mission_target_anchor_variable": not any(isinstance(node, ast.Name) and node.id == "target_anchors" for node in ast.walk(tree)),
    }
    report = {"checks": checks, "all_pass": all(checks.values()), "program": str(args.program.resolve()),
              "sha256": hashlib.sha256(text.encode()).hexdigest(), "identity": program_identity(args.program),
              "baseline_sha256": hashlib.sha256(base.encode()).hexdigest(),
              "protected_constants": protected_constants,
              "baseline_function_ast_unchanged": preserved_functions,
              "added_functions": sorted(set(funcs) - set(old_funcs))}
    (folder / "preflight.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    (folder / "changes.patch").write_text("".join(difflib.unified_diff(base.splitlines(True), text.splitlines(True),
                                                        fromfile=str(BASELINE), tofile=str(args.program))))
    print(json.dumps({"all_pass": report["all_pass"], "checks": checks}, ensure_ascii=False))
    if not report["all_pass"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
