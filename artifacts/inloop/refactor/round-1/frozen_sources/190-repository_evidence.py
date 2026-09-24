#!/usr/bin/env python3
"""Inventory/check ignored local evidence without removing or changing it.

Default: check docs/local-evidence-manifest.json. Use --write explicitly to
replace that manifest from Git's ignored artifacts inventory. No simulator,
network, Git index mutation, or archive deletion is performed.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys

SCHEMA = "wm-local-evidence-manifest/v1"
CACHE_DIRECTORIES = frozenset({"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
                               ".hypothesis", ".cache", ".tox", ".venv", "node_modules"})
CACHE_FILENAMES = frozenset({".DS_Store", "Thumbs.db", ".coverage"})
CACHE_SUFFIXES = frozenset({".pyc", ".pyo", ".pid"})


def is_cache(path):
    return (bool(CACHE_DIRECTORIES.intersection(path.parts)) or path.name in CACHE_FILENAMES
            or path.suffix.lower() in CACHE_SUFFIXES)


def category(path):
    name = path.name
    if name.endswith(".record.json"):
        return "native_full_record"
    if name.endswith(".samples.json"):
        return "telemetry_samples"
    if name.endswith(".partial.txt"):
        return "terminal_log"
    if name.endswith(".vision.json"):
        return "native_vision_manifest"
    if name.endswith(".demo.json"):
        return "success_keyframe_manifest"
    if path.suffix.lower() == ".png":
        if any(part.endswith(".demo") for part in path.parts):
            return "success_keyframe_png"
        if any(part.endswith(".vision") for part in path.parts):
            return "native_vision_png"
        return "image"
    if "frozen_sources" in path.parts:
        return "frozen_dependency_snapshot"
    if "inloop_snapshot" in path.parts:
        return "historical_snapshot"
    if path.suffix.lower() == ".json" and (name.startswith("map-") or name.startswith("attempt-")):
        return "raw_run_or_allocation"
    if path.suffix.lower() in {".json", ".jsonl", ".csv"}:
        return "evaluation_or_diagnostic_data"
    if path.suffix.lower() in {".txt", ".log", ".out", ".md"}:
        return "text_evidence"
    if path.suffix.lower() in {".zip", ".bundle", ".gz", ".tar"}:
        return "archived_package"
    return "other_evidence"


def snapshot(path):
    """Hash regular files in bounded chunks; fail if a concurrent write is seen."""
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError(f"not a regular evidence file: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    after = path.lstat()
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError(f"file changed while hashing: {path}")
    return {"bytes": after.st_size, "sha256": digest.hexdigest()}


def evidence_path(root, relative):
    if not isinstance(relative, str):
        raise ValueError("evidence path must be a relative string")
    path = PurePosixPath(relative)
    if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != "artifacts":
        raise ValueError(f"evidence path outside artifacts/: {relative!r}")
    local = root.joinpath(*path.parts)
    if not local.resolve().is_relative_to(root):
        raise ValueError(f"evidence path resolves outside repository: {relative!r}")
    for parent in (local, *local.parents):
        if parent == root:
            break
        if parent.is_symlink():
            raise ValueError(f"symlink evidence requires an explicit separate policy: {relative!r}")
    return local


def git(root, *args):
    result = subprocess.run(["git", "-C", str(root), *args], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise ValueError(result.stderr.decode("utf-8", "replace").strip() or "Git command failed")
    return result.stdout


def write_manifest(root, manifest):
    # Require this directory to be the actual repository, not an accidental
    # enclosing worktree. The caller initializes Git and chooses ignore rules.
    top = Path(os.fsdecode(git(root, "rev-parse", "--show-toplevel")).strip()).resolve()
    if top != root:
        raise ValueError(f"--root must be the Git repository root: {top}")
    ignore = snapshot(root / ".gitignore")
    listed = git(root, "ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "artifacts")
    entries, cache_files, cache_bytes = [], 0, 0
    for relative in sorted({os.fsdecode(item) for item in listed.split(b"\0") if item}):
        path = evidence_path(root, relative)
        if is_cache(PurePosixPath(relative)):
            cache_files += 1
            cache_bytes += path.stat().st_size if path.is_file() else 0
            continue
        entries.append({"path": relative, **snapshot(path), "category": category(PurePosixPath(relative))})
    if snapshot(root / ".gitignore") != ignore:
        raise ValueError(".gitignore changed during inventory; rerun after ignore rules are stable")
    counts = Counter(item["category"] for item in entries)
    payload = {"schema": SCHEMA, "generated_at": datetime.now(timezone.utc).isoformat(),
               "gitignore": {"path": ".gitignore", **ignore},
               "selection": "git ls-files --others --ignored --exclude-standard -z -- artifacts",
               "policy": "Local files remain untouched; this manifest does not contain their data or upload them. Logs and raw evidence are not treated as caches.",
               "excluded_cache": {"files": cache_files, "bytes": cache_bytes,
                                  "directory_names": sorted(CACHE_DIRECTORIES),
                                  "filenames": sorted(CACHE_FILENAMES), "suffixes": sorted(CACHE_SUFFIXES)},
               "summary": {"files": len(entries), "bytes": sum(item["bytes"] for item in entries),
                           "categories": {key: {"files": counts[key], "bytes": sum(item["bytes"] for item in entries if item["category"] == key)}
                                          for key in sorted(counts)}}, "files": entries}
    manifest.parent.mkdir(parents=True, exist_ok=True)
    temporary = manifest.with_name(manifest.name + ".tmp")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
        temporary.replace(manifest)
    finally:
        temporary.unlink(missing_ok=True)
    return {"mode": "write", "ok": True, "manifest": manifest.relative_to(root).as_posix(),
            **payload["summary"], "excluded_cache": {"files": cache_files, "bytes": cache_bytes},
            "gitignore_sha256": ignore["sha256"]}


def check_manifest(root, manifest):
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    if (not isinstance(payload, dict) or payload.get("schema") != SCHEMA
            or not isinstance(payload.get("files"), list)):
        raise ValueError("unsupported or incomplete local evidence manifest")
    missing, changed, errors, seen = [], [], [], set()
    verified_bytes, checked = 0, 0
    for entry in payload["files"]:
        relative = entry.get("path") if isinstance(entry, dict) else None
        try:
            if not isinstance(entry, dict) or type(entry.get("bytes")) is not int or entry["bytes"] < 0:
                raise ValueError("invalid manifest file entry or byte count")
            if not isinstance(entry.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
                raise ValueError("invalid manifest SHA256")
            path = evidence_path(root, relative)
            if relative in seen:
                raise ValueError("duplicate manifest path")
            seen.add(relative)
            if is_cache(PurePosixPath(relative)):
                raise ValueError("cache file must not be included in evidence manifest")
            actual = snapshot(path); checked += 1
            if actual["bytes"] != entry["bytes"] or actual["sha256"] != entry["sha256"]:
                changed.append({"path": relative, "expected": {key: entry[key] for key in ("bytes", "sha256")}, "actual": actual})
            else:
                verified_bytes += actual["bytes"]
        except FileNotFoundError:
            missing.append(relative)
        except (OSError, ValueError, TypeError) as error:
            errors.append({"path": relative, "error": str(error)})
    ignore = payload.get("gitignore", {})
    if not isinstance(ignore, dict):
        raise ValueError("invalid recorded .gitignore metadata")
    try:
        current_ignore = snapshot(root / ".gitignore")
        ignore_matches = ignore.get("path") == ".gitignore" and all(current_ignore[key] == ignore.get(key) for key in ("bytes", "sha256"))
    except (OSError, ValueError) as error:
        ignore_matches = False; errors.append({"path": ".gitignore", "error": str(error)})
    ok = not missing and not changed and not errors and ignore_matches
    return {"mode": "check", "ok": ok, "manifest": manifest.relative_to(root).as_posix(),
            "listed_files": len(payload["files"]), "checked_files": checked, "verified_bytes": verified_bytes,
            "missing_count": len(missing), "changed_count": len(changed), "error_count": len(errors),
            "missing": missing, "changed": changed, "errors": errors,
            "gitignore_matches_recorded_input": ignore_matches,
            "scope": "Checks listed files and recorded .gitignore only; use --write to inventory newly ignored evidence."}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="inventory ignored evidence and replace the manifest")
    mode.add_argument("--check", action="store_true", help="verify the existing manifest (default)")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1], help="repository root")
    parser.add_argument("--manifest", type=Path, default=Path("docs/local-evidence-manifest.json"), help="manifest path within repository")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    manifest = (root / args.manifest).resolve()
    try:
        if not manifest.is_relative_to(root):
            raise ValueError("manifest path must remain inside repository")
        result = write_manifest(root, manifest) if args.write else check_manifest(root, manifest)
    except (OSError, ValueError, TypeError) as error:
        result = {"mode": "write" if args.write else "check", "ok": False,
                  "manifest": str(manifest), "error": str(error)}
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
