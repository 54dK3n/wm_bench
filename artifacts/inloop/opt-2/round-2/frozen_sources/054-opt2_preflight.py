#!/usr/bin/env python3
"""Stage-2 preflight: immutable measurement/confirmation, actual platform AST, measured k."""
import argparse
import ast
import base64
import difflib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile

from build_opt2_program import BASE, FRAGMENTS, ROOT, acquisition_bridges
from demo_preflight import PLATFORM, dump, inspect_source
from embed_detection_filter import BEGIN, END
from run_diagnostic_batch import program_identity


def audit_wm_addition(old_blob, new_blob):
    """All existing WM code must match; permit only the explicit action API."""
    old, new = zipfile.ZipFile(io.BytesIO(old_blob)), zipfile.ZipFile(io.BytesIO(new_blob))
    if old.namelist() != new.namelist():
        return False
    for name in old.namelist():
        if name != 'world_model/core.py' and old.read(name) != new.read(name):
            return False
    old_tree, new_tree = ast.parse(old.read('world_model/core.py')), ast.parse(new.read('world_model/core.py'))
    if ast.get_docstring(old_tree) is not None:
        old_tree.body.pop(0)
    if ast.get_docstring(new_tree) is not None:
        new_tree.body.pop(0)
    cls = next(node for node in new_tree.body if isinstance(node, ast.ClassDef) and node.name == 'WorldModel')
    added = [node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == 'mark_removed']
    if len(added) != 1:
        return False
    cls.body.remove(added[0])
    return dump(old_tree) == dump(new_tree)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--program", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    folder = args.out.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    source, tree, funcs, values = inspect_source(args.program)
    base, _, old_funcs, old_values = inspect_source(BASE)
    manifest = json.loads(args.program.with_suffix('.build.json').read_text())
    calibration_path = Path(manifest["calibration"])
    calibration = json.loads(calibration_path.read_text())
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYLINTHOME="/private/tmp/wm_bench_pylint_cache")
    env["PYTHONPATH"] = os.pathsep.join(filter(None, ("/private/tmp/wm_bench_pylint", env.get("PYTHONPATH"))))

    def run(command, name):
        result = subprocess.run(command, cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (folder / name).write_text(result.stdout)
        return result.returncode == 0

    lint = run([sys.executable, "-m", "pylint", "--disable=all", "--enable=E1123,E1120,E1121,E0633,E0602",
                "--additional-builtins=robot", str(args.program), "programs/detection_filter.py",
                "programs/target_selection.py"], "pylint.txt")
    selected_tests = ["programs/tests", "tools/test_detection_evaluation.py", "tools/tests/test_opt_filter_platform.py",
                      "tools/tests/test_p3_turn_calibration.py"]
    selected_tests.extend(str(path.relative_to(ROOT)) for path in sorted((ROOT / "tools/tests").glob("test_opt2*.py")))
    tests = run([sys.executable, "-m", "pytest", *selected_tests, "-q"], "tests.txt")
    driver_syntax = run(["/opt/homebrew/bin/node", "--check", "tools/inloop_driver.js"], "driver_syntax.txt")
    driver_tests = run(["/opt/homebrew/bin/node", "--test", "tools/tests/test_inloop_host_io.js"], "driver_tests.txt")
    coordinates = run([sys.executable, "tools/check_no_layout_constants.py", str(args.program)], "static_coordinates.json")
    worker = (PLATFORM / "python-worker.js").read_text()
    namespace = {"ast": ast}
    exec(worker[worker.index("class AsyncRobotTransformer("):worker.index("student_run_target =")], namespace)
    transformed = namespace["AsyncRobotTransformer"](set(funcs)).visit(ast.parse(source))
    ast.fix_missing_locations(transformed)
    compile(transformed, str(args.program), "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    same = {name: name in funcs and dump(funcs[name]) == dump(node) for name, node in old_funcs.items()}
    bridged = {node.name: node for node in ast.parse(acquisition_bridges(base)).body
               if isinstance(node, ast.FunctionDef)}
    protected = {name: name in values and dump(values[name]) == dump(node) for name, node in old_values.items()
                 if name.startswith(("CONFIRM_", "APPROACH_", "GRAB_"))
                 or name in ("RANGE_CAL", "MAX_OBSERVES", "MEMORY_FORWARD_MIN_CM",
                             "NAVIGATION_QUERY_LIMIT", "NAVIGATION_CONTROL_LIMIT")}
    blob = lambda text: base64.b64decode(re.search(r'b64decode\("([^\"]+)"\)', text).group(1))
    fragment_checks = {}
    for name in FRAGMENTS:
        text = (ROOT / "programs" / name).read_text()
        begin, end = '# BEGIN EXACT OPT2 FRAGMENT: ' + name + '\n', '# END EXACT OPT2 FRAGMENT: ' + name + '\n'
        fragment_checks[name] = (begin in source and end in source and source.split(begin, 1)[1].split(end, 1)[0] == text
                                 and manifest["fragments"][name] == hashlib.sha256(text.encode()).hexdigest())
    filter_source = (ROOT / "programs/detection_filter.py").read_text()
    package = blob(source)
    package_proof = json.loads((ROOT / 'artifacts/inloop/opt-2/wm-kit-action-evidence/manifest.json').read_text())
    checks = {
        "pylint_zero_errors": lint, "tests_pass": tests, "no_layout_coordinates": coordinates,
        "driver_syntax_valid": driver_syntax, "driver_host_IO_tests_pass": driver_tests,
        "actual_platform_async_transform_compile": True,
        "protected_constants_unchanged": all(protected.values()),
        "WM_existing_code_unchanged_only_action_api_added": audit_wm_addition(blob(base), package),
        "WM_action_commit_and_package_bound": ast.literal_eval(values['WM_KIT_COMMIT']) == package_proof['commit']
                                              and hashlib.sha256(package).hexdigest() == package_proof['package_sha256'],
        "M5_functions_unchanged": all(same[name] for name in ("calibrate_reading", "calibrated_detection", "uncalibrate_reading")),
        "confirmation_rules_unchanged": all(same[name] for name in ("_record_hit", "_confirmation_result")),
        "confirmation_planner_only_empty_frame_and_goal_liveness_hooks":
            dump(funcs["_try_enter_range_and_confirm"]) == dump(bridged["_try_enter_range_and_confirm"]),
        "WM_fusion_bridge_unchanged": same["_update_wm"],
        "known_geometry_before_frontiers_unchanged": same["_approach_graph_navigation"],
        "frozen_filter_exact_source": source.split(BEGIN, 1)[1].split(END, 1)[0] == filter_source,
        "embedded_fragments_exact": all(fragment_checks.values()),
        "measured_calibration_pass": calibration.get("all_pass") is True and calibration.get("k_cm_per_deg") is not None,
        "measured_k_bound": ast.literal_eval(values["TURN_COST_K"]) == calibration.get("k_cm_per_deg"),
        "calibration_hash_bound": hashlib.sha256(calibration_path.read_bytes()).hexdigest() == manifest["calibration_sha256"]
                                  == ast.literal_eval(values["TURN_CALIBRATION_SHA256"]),
        "build_source_hash_bound": hashlib.sha256(source.encode()).hexdigest() == manifest["program_sha256"],
        "no_truth_api": not any((isinstance(node, ast.Name) and node.id == "get_truth")
                                 or (isinstance(node, ast.Attribute) and node.attr == "get_truth") for node in ast.walk(tree)),
        "no_target_anchor_variable": not any(isinstance(node, ast.Name) and node.id == "target_anchors" for node in ast.walk(tree)),
    }
    report = {"all_pass": all(checks.values()), "checks": checks, "program": str(args.program.resolve()),
              "sha256": hashlib.sha256(source.encode()).hexdigest(), "identity": program_identity(args.program),
              "baseline_sha256": hashlib.sha256(base.encode()).hexdigest(), "protected_constants": protected,
              "fragment_checks": fragment_checks, "baseline_function_AST_unchanged": same, "build": manifest}
    (folder / "preflight.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    (folder / "changes.patch").write_text(''.join(difflib.unified_diff(base.splitlines(True), source.splitlines(True),
                                                      fromfile=str(BASE), tofile=str(args.program))))
    print(json.dumps({"all_pass": report["all_pass"], "checks": checks}, ensure_ascii=False))
    if not report["all_pass"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
