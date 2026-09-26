"""Hash the dependency actually imported, without claiming an upstream version."""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
from pathlib import Path
import sys
from typing import Any


def capture_world_model_provenance(configured_root: str | Path) -> dict[str, Any]:
    root = Path(configured_root).resolve()
    module = importlib.import_module("world_model")
    package = Path(module.__file__).resolve().parent
    expected = (root / "world_model").resolve()
    if package != expected:
        raise RuntimeError("Loaded WorldModel location differs from configured WORLD_MODEL_ROOT")
    files = {}
    for file in sorted(package.rglob("*")):
        if not file.is_file() or "__pycache__" in file.parts:
            continue
        if file.suffix not in {".py", ".json", ".yaml", ".yml", ".toml"}:
            continue
        files[str(file.relative_to(root))] = hashlib.sha256(file.read_bytes()).hexdigest()
    if not files:
        raise RuntimeError("WorldModel dependency has no auditable source files")
    loaded = {}
    for name, imported in sorted(sys.modules.items()):
        if name != "world_model" and not name.startswith("world_model."):
            continue
        location = getattr(imported, "__file__", None)
        if not location:
            continue
        file = Path(location).resolve()
        if not file.is_relative_to(package):
            raise RuntimeError("WorldModel contains a module outside its declared package")
        loaded[name] = {"path": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
    canonical = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    return {"schema": "autonomous-brain-world-model-provenance/v1",
            "configured_root": str(root), "loaded_package": str(package),
            "declared_version": getattr(module, "__version__", None),
            "source_tree_sha256": hashlib.sha256(canonical).hexdigest(),
            "files": files, "loaded_modules": loaded,
            "version_basis": "actual_source_tree_sha256",
            "python": {"executable": sys.executable, "version": sys.version}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(Path(args.root).resolve()))
    # Match the brain's imports before capturing loaded-module evidence.
    from . import perception  # noqa: F401
    print(json.dumps(capture_world_model_provenance(args.root), sort_keys=True))


if __name__ == "__main__":
    main()
