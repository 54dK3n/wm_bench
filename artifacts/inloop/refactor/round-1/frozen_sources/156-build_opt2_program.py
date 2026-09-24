#!/usr/bin/env python3
"""Build the standalone robot program from the ordered programs/src modules.

No historical program or Git checkout is read. The WorldModel package is built
from the verified vendor lock, with fixed ZIP metadata for repeatable bytes.
"""
import argparse
import ast
import base64
import hashlib
import io
import json
import math
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from tools.verify_worldmodel_vendor import check_vendor, read_lock

SOURCE_DIRECTORY = ROOT / "programs/src"
SOURCE_ORDER = (
    "runtime_imports.py", "program_identity.py", "navigation_errors.py",
    "navigation_cache_fragment.py", "mission_graph.py", "wm_imports.py",
    "wm_bootstrap.py", "wm_observe_state.py", "detection_filter.py",
    "confirmation.py", "viewpoint_planner_fragment.py", "confirmation_flow.py",
    "memory_approach_fragment.py", "approach.py", "target_selection.py",
    "opt2_flow_fragment.py", "opt2_delivery_fragment.py", "opt2_grasp_fragment.py",
    "opt2_motion_fragment.py", "opt2_acquisition_fragment.py", "entrypoint.py",
)
DEFAULT_CALIBRATION = ROOT / "artifacts/inloop/opt-2/controlled-calibration/calibration.json"
DEFAULT_VERSION = "wm-refactor-r1-20260924"
# Provenance only. The build never opens this historical file.
BASELINE_PATH = "artifacts/inloop/opt-2/round-3/program.py"
BASELINE_SHA256 = "59d8f617a7fd82135b710b6a32cf112b4c17c80aa770beb59407aa50d5cf17e6"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def relative(path):
    """All build inputs/outputs must travel with the project, not the host."""
    try:
        return Path(path).resolve().relative_to(ROOT).as_posix()
    except ValueError as error:
        raise ValueError("build paths must be inside the project: " + str(path)) from error


def build_zip(wm_source, lock):
    check, _actual = check_vendor(wm_source, lock["tracked_files"])
    if not check["all_pass"]:
        raise ValueError("WorldModel vendor does not match lock: " + json.dumps(check, ensure_ascii=False))
    names = sorted(name for name in lock["tracked_files"]
                   if name.startswith("world_model/") and name.endswith(".py"))
    if not names or "world_model/__init__.py" not in names:
        raise ValueError("vendor lock has no importable world_model package")
    buffer = io.BytesIO()
    files = {}
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in names:
            data = (wm_source / name).read_bytes()
            files[name] = digest(data)
            if files[name] != lock["tracked_files"][name]:
                raise ValueError("vendor changed during build: " + name)
            entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = 0o600 << 16
            archive.writestr(entry, data)
    return buffer.getvalue(), files


def build(calibration=DEFAULT_CALIBRATION, version=DEFAULT_VERSION,
          output=ROOT / "programs/world_model_opt2.py",
          wm_src=ROOT / "vendor/wm_kit_opt2", lock_path=ROOT / "vendor/worldmodel.lock.json"):
    calibration, output, wm_src, lock_path = map(Path, (calibration, output, wm_src, lock_path))
    for path in (calibration, output, wm_src, lock_path):
        relative(path)
    if not isinstance(version, str) or not version.strip():
        raise ValueError("program version must be nonempty")
    calibration_bytes = calibration.read_bytes()
    data = json.loads(calibration_bytes)
    k = data.get("k_cm_per_deg")
    if (data.get("all_pass") is not True or type(k) not in (float, int)
            or not math.isfinite(k) or k < 0):
        raise ValueError("A passing native-controller measurement and finite measured k are required")
    lock, lock_hash = read_lock(lock_path)
    zip_bytes, package_files = build_zip(wm_src.resolve(), lock)
    sources = []
    content = {}
    actual_sources = {path.name for path in SOURCE_DIRECTORY.glob("*.py")}
    if actual_sources != set(SOURCE_ORDER):
        raise ValueError("source inventory differs from fixed build order: " +
                         repr(sorted(actual_sources ^ set(SOURCE_ORDER))))
    for name in SOURCE_ORDER:
        path = SOURCE_DIRECTORY / name
        blob = path.read_bytes()
        content[name] = blob.decode("utf-8")
        sources.append({"path": relative(path), "sha256": digest(blob)})
    filter_hash = digest((SOURCE_DIRECTORY / "detection_filter.py").read_bytes())
    # Generated values have dedicated boundaries; source modules are copied
    # byte-for-byte. No text patching, function replacement, or legacy base.
    generated = {
        "runtime_imports.py": "PROGRAM_VERSION = " + json.dumps(version) + "\n",
        "program_identity.py": (
            "DETECTION_FILTER_SHA256 = " + json.dumps(filter_hash) + "\n"
            "TURN_COST_K = " + repr(k) + "\n"
            "TURN_CALIBRATION_SHA256 = " + json.dumps(digest(calibration_bytes)) + "\n"
            "WM_KIT_COMMIT = " + json.dumps(lock["commit"]) + "\n"
        ),
        "wm_imports.py": "_WM_ZIP_BYTES = base64.b64decode(" +
                         json.dumps(base64.b64encode(zip_bytes).decode("ascii")) + ")\n",
    }
    chunks = ["# Generated by tools/build_opt2_program.py; edit programs/src instead.\n"]
    for name in SOURCE_ORDER:
        chunks.extend(["\n# BEGIN SOURCE: programs/src/" + name + "\n",
                       content[name], "\n# END SOURCE: programs/src/" + name + "\n"])
        if name in generated:
            chunks.extend(["\n# BEGIN GENERATED METADATA\n", generated[name],
                           "# END GENERATED METADATA\n"])
    source = "".join(chunks)
    tree = ast.parse(source)
    names = [node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))]
    if len(names) != len(set(names)):
        raise ValueError("top-level definitions must be unique")
    compile(tree, str(output), "exec")
    manifest = {
        "schema_version": 2,
        "version": version,
        "k_cm_per_deg": k,
        "calibration": {"path": relative(calibration), "sha256": digest(calibration_bytes)},
        "wm": {"source": relative(wm_src), "lock": relative(lock_path),
               "lock_sha256": lock_hash, "commit": lock["commit"],
               "git_tree": lock["git_tree"], "embed_sha256": digest(zip_bytes),
               "files": package_files},
        "sources": sources,
        "builder": {"path": relative(Path(__file__)), "sha256": digest(Path(__file__).read_bytes())},
        "program": {"path": relative(output), "sha256": digest(source.encode("utf-8"))},
        "baseline": {"path": BASELINE_PATH, "sha256": BASELINE_SHA256,
                     "used_as_build_input": False},
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(source, encoding="utf-8")
    output.with_suffix(".build.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--calibration", type=Path, default=DEFAULT_CALIBRATION)
    parser.add_argument("--version", default=DEFAULT_VERSION)
    parser.add_argument("--wm-src", type=Path, default=ROOT / "vendor/wm_kit_opt2")
    parser.add_argument("--lock", type=Path, default=ROOT / "vendor/worldmodel.lock.json")
    parser.add_argument("--out", type=Path, default=ROOT / "programs/world_model_opt2.py")
    args = parser.parse_args()
    print(json.dumps(build(args.calibration, args.version, args.out, args.wm_src, args.lock), ensure_ascii=False))
