#!/usr/bin/env python3
"""Required checks and immutable-constant audit before an optimization round."""
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

from demo_preflight import BASELINE, PLATFORM, ROOT, dump, inspect_source
from run_diagnostic_batch import program_identity
from embed_detection_filter import BEGIN, END


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--program", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--tests", nargs="+", default=["programs/tests", "tools/test_detection_evaluation.py", "tools/tests/test_opt_reporting.py", "tools/tests/test_opt_runner_controls.py", "tools/tests/test_opt_filter_platform.py"])
    args = parser.parse_args()
    folder = args.out.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    text, tree, funcs, values = inspect_source(args.program)
    base, _tree, old_funcs, old_values = inspect_source(BASELINE)
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYLINTHOME="/private/tmp/wm_bench_pylint_cache")
    env["PYTHONPATH"] = os.pathsep.join(filter(None, ("/private/tmp/wm_bench_pylint", env.get("PYTHONPATH"))))
    def execute(command, output):
        result = subprocess.run(command, cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (folder / output).write_text(result.stdout)
        return result.returncode == 0
    lint = execute([sys.executable, "-m", "pylint", "--disable=all", "--enable=E1123,E1120,E1121,E0633,E0602",
                    "--additional-builtins=robot", str(args.program), "programs/detection_filter.py"], "pylint.txt")
    tests = execute([sys.executable, "-m", "pytest", *args.tests, "-q"], "tests.txt")
    coordinates = execute([sys.executable, "tools/check_no_layout_constants.py", str(args.program)], "static_coordinates.json")
    worker = (PLATFORM / "python-worker.js").read_text()
    transformer_source = worker[worker.index("class AsyncRobotTransformer("):worker.index("student_run_target =")]
    namespace = {"ast": ast}
    exec(transformer_source, namespace)
    transformed = namespace["AsyncRobotTransformer"](set(funcs)).visit(ast.parse(text))
    ast.fix_missing_locations(transformed)
    compile(transformed, str(args.program), "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    preserved = {name: name in funcs and dump(funcs[name]) == dump(node) for name, node in old_funcs.items()}
    protected = {name: name in values and dump(values[name]) == dump(node) for name, node in old_values.items()
                 if name.startswith(("CONFIRM_", "APPROACH_", "GRAB_"))
                 or name in ("RANGE_CAL", "WM_KIT_COMMIT", "MAX_OBSERVES", "MEMORY_FORWARD_MIN_CM")}
    blob = lambda source: base64.b64decode(re.search(r'b64decode\("([^\"]+)"\)', source).group(1))
    standalone_filter = (ROOT / "programs/detection_filter.py").read_text()
    embedded_filter = text.split(BEGIN, 1)[1].split(END, 1)[0] if BEGIN in text and END in text else None
    checks = {
        "pylint_zero_errors": lint, "tests_pass": tests, "no_layout_coordinates": coordinates,
        "platform_async_transform_compile": True, "protected_constants_unchanged": all(protected.values()),
        "embedded_world_model_unchanged": blob(base) == blob(text),
        "M5_functions_unchanged": all(preserved[name] for name in ("calibrate_reading", "calibrated_detection", "uncalibrate_reading")),
        "confirmation_rules_unchanged": all(preserved[name] for name in ("_record_hit", "_confirmation_result", "_try_enter_range_and_confirm")),
        "WM_update_function_unchanged": preserved["_update_wm"],
        "embedded_filter_exact_source": embedded_filter == standalone_filter,
        "embedded_filter_hash_matches": ast.literal_eval(values.get("DETECTION_FILTER_SHA256", ast.Constant(None)))
                                         == hashlib.sha256(standalone_filter.encode()).hexdigest(),
        "no_truth_api": not any((isinstance(node, ast.Name) and node.id == "get_truth")
                                 or (isinstance(node, ast.Attribute) and node.attr == "get_truth") for node in ast.walk(tree)),
        "no_target_anchor_variable": not any(isinstance(node, ast.Name) and node.id == "target_anchors" for node in ast.walk(tree)),
    }
    report = {"checks": checks, "all_pass": all(checks.values()), "program": str(args.program.resolve()),
              "sha256": hashlib.sha256(text.encode()).hexdigest(), "identity": program_identity(args.program),
              "baseline_sha256": hashlib.sha256(base.encode()).hexdigest(), "protected_constants": protected,
              "baseline_function_AST_unchanged": preserved, "new_functions": sorted(set(funcs) - set(old_funcs))}
    (folder / "preflight.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    (folder / "changes.patch").write_text("".join(difflib.unified_diff(base.splitlines(True), text.splitlines(True),
                                                        fromfile=str(BASELINE), tofile=str(args.program))))
    print(json.dumps({"all_pass": report["all_pass"], "checks": checks}, ensure_ascii=False))
    if not report["all_pass"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
