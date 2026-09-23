#!/usr/bin/env python3
"""Run a source checkout's tests and untouched git-baseline tests on that source.

Only this report directory and temporary test copies are written. No simulator,
source edits, or dependency installation is performed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET


HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parents[2]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args])


def python_manifest(source):
    return {str(path.relative_to(source)): sha(path.read_bytes())
            for base in ("world_model", "judge", "tests")
            for path in sorted((source / base).rglob("*.py"))}


def copy_tests(source, target):
    manifest = {}
    for path in sorted((source / "tests").rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        relative = path.relative_to(source)
        data = path.read_bytes()
        dest = target / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        manifest[str(relative)] = sha(data)
    return manifest


def baseline_tests(repo, revision, target):
    manifest = {}
    names = git(repo, "ls-tree", "-r", "--name-only", "-z", revision, "tests").split(b"\0")
    for raw_name in names:
        if not raw_name:
            continue
        name = raw_name.decode()
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("unsafe git test path")
        data = git(repo, "show", f"{revision}:{name}")
        dest = target / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        manifest[name] = sha(data)
    if not manifest:
        raise ValueError("baseline revision has no tests")
    return manifest


BOOTSTRAP = r'''
import json, pathlib, sys
sys.dont_write_bytecode = True
source = pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0, str(source))
import world_model, judge, pytest
for module in (world_model, judge):
    assert pathlib.Path(module.__file__).resolve().is_relative_to(source), module.__file__
print("IMPORT_BINDING=" + json.dumps({"world_model": world_model.__file__, "judge": judge.__file__}))
result = pytest.main([sys.argv[2], "-q", "--import-mode=importlib", "-p", "no:cacheprovider", "--junitxml=" + sys.argv[3]])
checked = {}
for name, module in list(sys.modules.items()):
    if name == "world_model" or name.startswith("world_model.") or name == "judge" or name.startswith("judge."):
        path = getattr(module, "__file__", None)
        if path:
            assert pathlib.Path(path).resolve().is_relative_to(source), (name, path)
            checked[name] = path
print("ALL_MODULE_BINDINGS=" + json.dumps(checked, sort_keys=True))
raise SystemExit(result)
'''


def run_suite(source, tests_root, out, name):
    junit = out / (name + ".junit.xml")
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTEST_DISABLE_PLUGIN_AUTOLOAD="1")
    env.pop("PYTHONPATH", None)
    command = [sys.executable, "-c", BOOTSTRAP, str(source), str(tests_root / "tests"), str(junit)]
    proc = subprocess.run(command, cwd=tests_root, env=env, text=True, capture_output=True)
    (out / (name + ".txt")).write_text(proc.stdout + proc.stderr)
    root = ET.parse(junit).getroot() if junit.exists() else None
    suites = list(root.iter("testsuite")) if root is not None else []
    counts = {key: sum(int(suite.get(key, "0")) for suite in suites)
              for key in ("tests", "errors", "failures", "skipped")}
    counts["passed"] = counts["tests"] - counts["errors"] - counts["failures"] - counts["skipped"]
    imports = {}
    for line in proc.stdout.splitlines():
        if line.startswith("ALL_MODULE_BINDINGS="):
            imports = json.loads(line.split("=", 1)[1])
    return {"returncode": proc.returncode, **counts,
            "all_pass": proc.returncode == 0 and counts["tests"] > 0 and
                        not any(counts[k] for k in ("errors", "failures", "skipped")) and bool(imports),
            "import_bindings": imports, "log": str(out / (name + ".txt")),
            "junit": str(junit), "python": sys.executable,
            "pytest_args": ["-q", "--import-mode=importlib", "-p", "no:cacheprovider", "--junitxml"],
            "tests_copied_without_modification": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=WORKSPACE / "vendor/wm_kit_opt2")
    parser.add_argument("--baseline-repo", type=Path,
                        help="git repository containing baseline; defaults to --source")
    parser.add_argument("--baseline-rev", default="0ea6539")
    parser.add_argument("--out", type=Path, default=HERE / "latest")
    args = parser.parse_args()
    source = args.source.resolve()
    repo = (args.baseline_repo or source).resolve()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    revision = git(repo, "rev-parse", args.baseline_rev + "^{commit}").decode().strip()
    before = python_manifest(source)
    source_head = git(source, "rev-parse", "HEAD").decode().strip()
    status = git(source, "status", "--porcelain").decode()
    with tempfile.TemporaryDirectory(prefix="wm-feature-check-", dir="/private/tmp") as temp:
        temp = Path(temp)
        current = temp / "feature"
        baseline = temp / "baseline"
        current_manifest = copy_tests(source, current)
        baseline_manifest = baseline_tests(repo, revision, baseline)
        suites = {"feature": run_suite(source, current, out, "feature_tests"),
                  "baseline": run_suite(source, baseline, out, "baseline_tests")}
    after = python_manifest(source)
    result = {"source": str(source), "source_commit": source_head,
              "source_status_before": status,
              "baseline_repo": str(repo), "baseline_commit": revision,
              "baseline_tests_unmodified": True,
              "source_python_unchanged": before == after,
              "runner_sha256": sha(Path(__file__).read_bytes()),
              "source_python_sha256": before,
              "feature_test_sha256": current_manifest,
              "baseline_test_sha256": baseline_manifest,
              "suites": suites,
              "all_pass": before == after and all(item["all_pass"] for item in suites.values())}
    (out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"source_commit": source_head, "baseline_commit": revision,
                      "feature": suites["feature"]["passed"], "baseline": suites["baseline"]["passed"],
                      "all_pass": result["all_pass"], "output": str(out)}, ensure_ascii=False))
    return 0 if result["all_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
