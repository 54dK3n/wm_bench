#!/usr/bin/env python3
"""Preflight the explicit-source refactor without starting a simulator.

Checks new source/lock provenance and effective final-round behavior, rather
than relaxing the historical preflight's fragment-overriding assumptions.
"""
import argparse
import ast
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

from opt2_runtime_smoke import FROZEN_COUNTEREXAMPLE, run_smoke
from platform_paths import ROOT, file_reference, platform_root, repository_path
from run_diagnostic_batch import program_identity
from verify_worldmodel_vendor import check_vendor, read_lock

BASELINE = ROOT / "artifacts/inloop/opt-2/round-3/program.py"
IDENTITY_CONSTANTS = {"PROGRAM_VERSION", "WM_KIT_COMMIT", "WM_EMBED_SHA256", "DETECTION_FILTER_SHA256"}
PROTECTED_CONSTANTS = {"MAX_OBSERVES", "PATROL_OBSERVE_BUDGET", "NAVIGATION_QUERY_LIMIT",
                       "NAVIGATION_CONTROL_LIMIT", "RANGE_CAL", "TURN_COST_K", "TURN_CALIBRATION_SHA256",
                       "CONFIDENCE_FLOORS", "FILTER_VERSION", "CRUISE_SPEED", "SLOW_SPEED"}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def dump(node):
    return ast.dump(node, include_attributes=False)


def duplicate_functions(tree):
    """Detect same-name definitions sharing lexical scope, including branches."""
    duplicates = []
    def scope(node, label):
        names = {}
        def descend(current):
            for child in ast.iter_child_nodes(current):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    names.setdefault(child.name, []).append(child.lineno)
                    scope(child, label + "." + child.name)
                elif isinstance(child, ast.ClassDef):
                    scope(child, label + "." + child.name)
                elif not isinstance(child, ast.Lambda):
                    descend(child)
        descend(node)
        duplicates.extend({"scope": label, "name": name, "lines": lines}
                          for name, lines in names.items() if len(lines) > 1)
    scope(tree, "module")
    return duplicates


def definitions(tree):
    # The historical source intentionally had overwritten definitions. Compare
    # against the last (effective) one, while forbidding duplicates in new code.
    functions = {node.name: node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    constants = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            try:
                ast.literal_eval(node.value)
            except (ValueError, TypeError):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id.isupper():
                    constants[target.id] = node.value
    return functions, constants


def inspect_refactor(program, baseline=BASELINE):
    text = program.read_text()
    tree = ast.parse(text, filename=str(program))
    old_tree = ast.parse(baseline.read_text())
    funcs, constants = definitions(tree)
    previous, old_constants = definitions(old_tree)
    duplicate = duplicate_functions(tree)
    same_functions = {name: name in previous and dump(node) == dump(previous[name]) for name, node in funcs.items()}
    required = PROTECTED_CONSTANTS | {name for name in old_constants if name.startswith(("CONFIRM_", "APPROACH_", "GRAB_", "OPT2_GRASP_"))}
    constant_checks = {name: name in constants and dump(constants[name]) == dump(old_constants[name]) for name in required}
    constant_checks.update({name: name in old_constants and dump(node) == dump(old_constants[name])
                            for name, node in constants.items() if name not in IDENTITY_CONSTANTS})
    imports = [node for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
               and node.module == "world_model.providers.guangyang"]
    factory_import = any(alias.name == "guangyang_static_world_model" and alias.asname is None
                         for node in imports for alias in node.names)
    calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)]
    factories = [node for node in calls if node.func.id == "guangyang_static_world_model"]
    expected_factory = ast.parse("guangyang_static_world_model(max_range_m=0.9)", mode="eval").body
    wm_assignment = [node for node in tree.body if isinstance(node, ast.Assign)
                     and any(isinstance(target, ast.Name) and target.id == "wm" for target in node.targets)]
    factory_ok = (factory_import and len(factories) == 1 and dump(factories[0]) == dump(expected_factory)
                  and len(wm_assignment) == 1 and dump(wm_assignment[0].value) == dump(expected_factory)
                  and not any(node.func.id == "WorldModel" for node in calls))
    forbidden = [node.id for node in ast.walk(tree) if isinstance(node, ast.Name)
                 and node.id in {"get_truth", "target_anchors"}]
    forbidden += [node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute) and node.attr == "get_truth"]
    return {"checks": {"no_duplicate_function_definitions": not duplicate,
                       "effective_runtime_functions_AST_unchanged": bool(funcs) and all(same_functions.values()),
                       "runtime_constants_unchanged": bool(constant_checks) and all(constant_checks.values()),
                       "explicit_locked_guangyang_factory": factory_ok, "no_truth_api_or_target_anchor": not forbidden},
            "duplicates": duplicate, "runtime_function_checks": same_functions,
            "removed_historical_functions": sorted(set(previous) - set(funcs)),
            "constant_checks": constant_checks, "forbidden_names": forbidden}, tree


def check_build(program, tree):
    manifest = json.loads(program.with_suffix(".build.json").read_text())
    lock_path = ROOT / "vendor/worldmodel.lock.json"
    lock, lock_hash = read_lock(lock_path)
    vendor, _actual = check_vendor(ROOT / "vendor/wm_kit_opt2", lock["tracked_files"])
    sources = manifest["sources"]
    source_checks = {item["path"]: sha(repository_path(item["path"])) == item["sha256"] for item in sources}
    source_paths = [item["path"] for item in sources]
    relative_paths = source_paths + [manifest[key]["path"] for key in ("program", "baseline", "calibration")]
    relative_paths += [manifest["wm"]["source"], manifest["wm"]["lock"]]
    portable = all(not Path(name).is_absolute() and repository_path(name).relative_to(ROOT).as_posix() == name for name in relative_paths)
    embedded = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute) and node.func.attr == "b64decode"
                and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)]
    if len(embedded) != 1:
        raise ValueError("Expected exactly one literal embedded WorldModel package")
    payload = base64.b64decode(embedded[0].args[0].value, validate=True)
    archive = zipfile.ZipFile(io.BytesIO(payload))
    names = archive.namelist()
    expected_package = {name: value for name, value in lock["tracked_files"].items()
                        if name.startswith("world_model/") and name.endswith(".py")}
    package_checks = {name: name in names and hashlib.sha256(archive.read(name)).hexdigest() == digest
                      for name, digest in expected_package.items()}
    package_exact = len(names) == len(set(names)) and set(names) == set(expected_package) and all(package_checks.values())
    calibration = repository_path(manifest["calibration"]["path"])
    measured = json.loads(calibration.read_text())
    k = measured.get("k_cm_per_deg")
    _funcs, constants = definitions(tree)
    values = {name: ast.literal_eval(value) for name, value in constants.items()}
    checks = {"build_schema_v2": manifest.get("schema_version") == 2,
              "builder_source_bound": manifest["builder"]["path"] == "tools/build_opt2_program.py"
                    and manifest["builder"]["sha256"] == sha(ROOT / "tools/build_opt2_program.py"),
              "build_paths_repository_relative": portable,
              "explicit_sources_bound": bool(source_checks) and all(source_checks.values()) and len(set(source_paths)) == len(source_paths)
                    and all(name.startswith("programs/src/") for name in source_paths),
              "program_build_hash_bound": manifest["program"]["path"] == file_reference(program)
                    and manifest["program"]["sha256"] == sha(program),
              "baseline_identity_bound": manifest["baseline"]["path"] == file_reference(BASELINE)
                    and manifest["baseline"]["sha256"] == sha(BASELINE),
              "vendor_locked_files_exact": vendor["all_pass"],
              "vendor_lock_and_commit_bound": manifest["wm"]["source"] == "vendor/wm_kit_opt2"
                    and manifest["wm"]["lock"] == "vendor/worldmodel.lock.json"
                    and manifest["wm"]["lock_sha256"] == lock_hash
                    and manifest["wm"]["commit"] == lock["commit"] == values["WM_KIT_COMMIT"],
              "embedded_package_exact_locked_vendor": package_exact
                    and manifest["wm"]["files"] == expected_package
                    and manifest["wm"]["embed_sha256"] == hashlib.sha256(payload).hexdigest(),
              "calibration_hash_and_k_bound": measured.get("all_pass") is True and type(k) in (int, float)
                    and math.isfinite(k) and k >= 0 and k == manifest["k_cm_per_deg"] == values["TURN_COST_K"]
                    and sha(calibration) == manifest["calibration"]["sha256"] == values["TURN_CALIBRATION_SHA256"]}
    return {"checks": checks, "source_checks": source_checks, "vendor": vendor,
            "embedded_file_checks": package_checks, "build": manifest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--program", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--node", default=shutil.which("node"))
    args = parser.parse_args()
    program, folder = repository_path(args.program), repository_path(args.out)
    platform_root()
    folder.mkdir(parents=True, exist_ok=True)
    report = {"all_pass": False, "program": file_reference(program), "sha256": sha(program), "checks": {}}
    try:
        structural, tree = inspect_refactor(program)
        bound = check_build(program, tree)
        report.update(structural=structural, provenance=bound, identity=program_identity(program))
        report["checks"].update(structural["checks"])
        report["checks"].update(bound["checks"])
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        with tempfile.TemporaryDirectory(prefix="wm-refactor-pylint-") as cache:
            env["PYLINTHOME"] = cache
            def run(command, filename):
                result = subprocess.run(command, cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
                (folder / filename).write_text(result.stdout)
                return result.returncode == 0
            report["checks"]["pylint_five_errors_zero"] = run([sys.executable, "-m", "pylint", "--disable=all",
                "--enable=E1123,E1120,E1121,E0633,E0602", "--additional-builtins=robot", str(program)], "pylint.txt")
            selected = ["programs/tests", "tests", "tools/test_detection_evaluation.py", "tools/tests", "vendor/wm_kit_opt2/tests"]
            report["checks"]["all_offline_tests_pass"] = run([sys.executable, "-m", "pytest", *selected, "-q"], "tests.txt")
            if not args.node:
                raise ValueError("Node.js is required on PATH or via --node")
            report["checks"]["driver_syntax_valid"] = run([args.node, "--check", "tools/inloop_driver.js"], "driver_syntax.txt")
            report["checks"]["driver_host_IO_tests_pass"] = run([args.node, "--test", "tools/tests/test_inloop_host_io.js"], "driver_tests.txt")
            report["checks"]["no_layout_coordinates"] = run([sys.executable, "tools/check_no_layout_constants.py", str(program)], "static_coordinates.json")
        for label, path in (("candidate", program), ("baseline", BASELINE), ("counterexample", FROZEN_COUNTEREXAMPLE)):
            smoke = run_smoke(path)
            filename = "runtime_smoke.json" if label == "candidate" else "runtime_smoke_" + label + ".json"
            (folder / filename).write_text(json.dumps(smoke, ensure_ascii=False, indent=2) + "\n")
            if label == "counterexample":
                passed = (not smoke["all_pass"] and smoke.get("error_type") == "NameError"
                          and smoke.get("error_message") == "name 'OPT2_MEMORY_TRAVEL_ACTIVE' is not defined"
                          and smoke.get("startup", {}).get("consumed_inputs") == 7)
            else:
                passed = smoke["all_pass"]
            report["checks"]["real_worker_" + label + ("_rejected" if label == "counterexample" else "_passed")] = passed
        report["all_pass"] = all(report["checks"].values())
    except (OSError, ValueError, TypeError, KeyError, SyntaxError, zipfile.BadZipFile) as error:
        report["error"] = str(error)
    (folder / "preflight.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"all_pass": report["all_pass"], "checks": report["checks"], "error": report.get("error")}, ensure_ascii=False))
    raise SystemExit(0 if report["all_pass"] else 1)


if __name__ == "__main__":
    main()
