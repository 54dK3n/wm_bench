#!/usr/bin/env python3
"""Repeat only the already successful demo layout with its frozen program.

python3 tools/reproduce_demo.py --demo-folder artifacts/inloop/demo --out /tmp/NEW
The output directory must not exist. --plan-only validates without simulation.
Failure to reproduce every gate returns nonzero. No failed layout is retried.
"""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

try:
    from .demo_finalize import all_report_gates_pass, check_trial_identity, finalize, verified_packages
except ImportError:
    from demo_finalize import all_report_gates_pass, check_trial_identity, finalize, verified_packages

ROOT = Path(__file__).resolve().parents[1]


def make_plan(folder, output, node=None, timeout_ms=900000, max_allocations=200):
    folder, output = Path(folder).resolve(), Path(output).resolve()
    if output.exists():
        raise ValueError(f"Fresh --out required; refusing to overwrite {output}")
    progress_path = folder / "progress.json"
    if progress_path.exists():
        progress = json.loads(progress_path.read_text())
        if progress.get("status") == "running" or progress.get("active"):
            raise ValueError("Source demo is still active; wait for completed evidence")
    report = json.loads((folder / "demo_report.json").read_text())
    trials = report.get("trials", [report])
    success = next((trial for trial in trials if trial.get("all_gates_pass") is True), None)
    if success is None or not all_report_gates_pass(success):
        raise ValueError("No fully verified successful demo layout exists; do not run another trial")
    raw_path = Path(success["raw_file"])
    raw = json.loads(raw_path.read_text())
    if success.get("map") != raw.get("assignedMap") or success.get("map") not in {f"map-{i:02d}" for i in range(1, 11)}:
        raise ValueError("Successful report layout differs from the actual assigned layout")
    if len(verified_packages(raw)) != 2:
        raise ValueError("Reported success does not contain two actually grabbed and delivered targets")
    raw_hash = hashlib.sha256(raw_path.read_bytes()).hexdigest()
    if raw_hash != success.get("evidence_files", {}).get("raw", {}).get("sha256"):
        raise ValueError("Successful raw evidence changed")
    frozen = folder / "program.py"
    identity_check = check_trial_identity(folder, success, raw)
    manifest = json.loads((folder / "code_manifest.json").read_text())
    runner_tree = ast.parse((ROOT / "tools/run_demo.py").read_text())
    required = next(ast.literal_eval(node.value) for node in runner_tree.body
                    if isinstance(node, ast.Assign) and any(isinstance(name, ast.Name) and name.id == "MANIFEST_FILES" for name in node.targets))
    missing = [str(ROOT / name) for name in required if str(ROOT / name) not in manifest]
    if missing:
        raise ValueError("Original manifest does not cover runner dependencies: " + ", ".join(missing))
    mismatches = [name for name, expected in manifest.items() if not Path(name).is_file()
                  or hashlib.sha256(Path(name).read_bytes()).hexdigest() != expected]
    if mismatches:
        raise ValueError("Frozen demo manifest differs: " + ", ".join(mismatches))
    if str(frozen) not in manifest:
        raise ValueError("Frozen program is absent from the original manifest")
    command = [sys.executable, str(ROOT / "tools/run_demo.py"), "--program", str(frozen),
               "--out", str(output), "--map", success["map"], "--node", node or shutil.which("node") or "/opt/homebrew/bin/node",
               "--timeout-ms", str(timeout_ms), "--max-allocations", str(max_allocations)]
    return {"map": success["map"], "frozen_program": str(frozen), "program_sha256": manifest[str(frozen)],
            "executed_identity": identity_check["executed_identity"],
            "source_demo": str(folder), "output": str(output), "command": command,
            "policy": "fresh output; one execution of the successful layout; other allocations skipped before Run; stop on failure"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo-folder", type=Path, default=ROOT / "artifacts/inloop/demo")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--node")
    parser.add_argument("--timeout-ms", type=int, default=900000)
    parser.add_argument("--max-allocations", type=int, default=200)
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args()
    plan = make_plan(args.demo_folder, args.out, args.node, args.timeout_ms, args.max_allocations)
    print(json.dumps(plan, ensure_ascii=False), flush=True)
    if args.plan_only:
        return
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    result = subprocess.run(plan["command"], cwd=ROOT, env=env, check=False)
    output = Path(plan["output"])
    if not (output / "demo_report.json").is_file():
        print("Reproduction did not produce a completed trial report", file=sys.stderr)
        raise SystemExit(result.returncode or 1)
    final = finalize(output)
    if result.returncode or final["success_map"] != plan["map"] or not final["all_gates_pass"]:
        raise SystemExit(result.returncode or 1)


if __name__ == "__main__":
    main()
