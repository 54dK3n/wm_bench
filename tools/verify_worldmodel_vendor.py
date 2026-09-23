#!/usr/bin/env python3
"""Check the locked WorldModel vendor snapshot without changing any files.

Default: python3 tools/verify_worldmodel_vendor.py
Optional Git-object check: add --upstream /path/to/worldmodel-clone

The lock must contain upstream_url, full commit and git_tree object IDs, and
tracked_files: {"relative/path": "sha256", ...}. Extra metadata is permitted.
Without --upstream, only the local file inventory and SHA256 values are checked;
the declared commit/tree/URL are not independently authenticated. With it, the
entire committed file inventory, tree ID and each `git show COMMIT:path` blob are
also checked. No fetch, checkout, index changes, simulation or writes occur.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CACHE_DIRECTORIES = frozenset({
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".hypothesis",
    ".cache", ".tox", ".venv", "node_modules",
})
CACHE_FILENAMES = frozenset({".DS_Store", "Thumbs.db", ".coverage"})


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key!r}")
        result[key] = value
    return result


def relative_path(value):
    if not isinstance(value, str) or not value or "\0" in value or "\\" in value:
        raise ValueError(f"invalid tracked relative path: {value!r}")
    path = PurePosixPath(value)
    if (path.is_absolute() or ".." in path.parts or path.as_posix() != value
            or not path.parts or path.parts[0] == ".git"):
        raise ValueError(f"noncanonical or unsafe tracked path: {value!r}")
    return path


def read_lock(path):
    content = path.read_bytes()
    lock = json.loads(content, object_pairs_hook=unique_object)
    if not isinstance(lock, dict):
        raise ValueError("lock must be a JSON object")
    if not isinstance(lock.get("upstream_url"), str) or not lock["upstream_url"].strip():
        raise ValueError("lock requires a nonempty upstream_url")
    for name in ("commit", "git_tree"):
        if not isinstance(lock.get(name), str) or not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", lock[name]):
            raise ValueError(f"lock {name} must be a full lowercase Git object ID")
    if len(lock["commit"]) != len(lock["git_tree"]):
        raise ValueError("commit and git_tree must use the same Git object format")
    files = lock.get("tracked_files")
    if not isinstance(files, dict) or not files:
        raise ValueError("lock requires a nonempty tracked_files path-to-SHA256 mapping")
    for name, digest in files.items():
        relative_path(name)
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError(f"invalid tracked file SHA256: {name!r}")
    return lock, hashlib.sha256(content).hexdigest()


def allowed_local_artifact(path):
    return (path.parts[0] == ".git" or bool(CACHE_DIRECTORIES.intersection(path.parts))
            or path.name in CACHE_FILENAMES or path.name.startswith(".coverage.")
            or path.suffix in {".pyc", ".pyo"})


def snapshot(path):
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError("expected a regular file, not a symlink/directory/special file")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    after = path.lstat()
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError("file changed while hashing")
    return {"bytes": after.st_size, "sha256": digest.hexdigest()}


def check_vendor(vendor, expected):
    if vendor.is_symlink() or not vendor.is_dir():
        raise ValueError("vendor must be an existing directory, not a symlink")
    inventory, ignored, errors = set(), [], []
    def walk(directory):
        with os.scandir(directory) as entries:
            for entry in entries:
                path = Path(entry.path)
                relative = path.relative_to(vendor).as_posix()
                # A locked file (including one in a cache-named directory) must
                # still be verified. Only unrelated local artifacts are skipped.
                needed = relative in expected or any(name.startswith(relative + "/") for name in expected)
                if allowed_local_artifact(PurePosixPath(relative)) and not needed:
                    ignored.append(relative)
                elif entry.is_dir(follow_symlinks=False):
                    walk(path)
                else:
                    inventory.add(relative)
    walk(vendor)
    missing = sorted(set(expected) - inventory)
    extra = sorted(inventory - set(expected))
    changed, actual = [], {}
    for relative in sorted(set(expected) & inventory):
        try:
            result = snapshot(vendor.joinpath(*relative_path(relative).parts))
            actual[relative] = result
            if result["sha256"] != expected[relative]:
                changed.append({"path": relative, "expected_sha256": expected[relative], **result})
        except (OSError, ValueError) as error:
            errors.append({"path": relative, "error": str(error)})
    return {"all_pass": not missing and not extra and not changed and not errors,
            "locked_files": len(expected), "hashed_files": len(actual),
            "hashed_bytes": sum(item["bytes"] for item in actual.values()),
            "missing": missing, "changed": changed, "extra_noncache": extra,
            "errors": errors, "ignored_local_artifacts": sorted(ignored)}, actual


def git(upstream, *args):
    command = ["git", "--no-replace-objects", "--no-optional-locks", "-C", str(upstream), *args]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise ValueError(result.stderr.decode("utf-8", "replace").strip() or "Git command failed")
    return result.stdout


def check_upstream(upstream, lock, actual):
    commit = lock["commit"]
    resolved = git(upstream, "rev-parse", "--verify", commit + "^{commit}").decode("ascii").strip()
    tree = git(upstream, "rev-parse", "--verify", commit + "^{tree}").decode("ascii").strip()
    entries = {}
    unsupported = []
    for record in git(upstream, "ls-tree", "-r", "-z", "--full-tree", commit).split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, kind, _object_id = metadata.decode("ascii").split()
        name = os.fsdecode(raw_path)
        entries[name] = kind
        if kind != "blob" or mode not in {"100644", "100755"}:
            unsupported.append({"path": name, "mode": mode, "type": kind})
    expected = lock["tracked_files"]
    missing = sorted(set(expected) - set(entries))
    unlisted = sorted(set(entries) - set(expected))
    mismatches, checked, checked_bytes = [], 0, 0
    for name in sorted(set(expected) & set(entries)):
        if entries[name] != "blob":
            continue
        blob = git(upstream, "show", commit + ":" + name)
        digest = hashlib.sha256(blob).hexdigest()
        checked += 1
        checked_bytes += len(blob)
        if (digest != expected[name] or actual.get(name, {}).get("sha256") != digest
                or actual.get(name, {}).get("bytes") != len(blob)):
            mismatches.append({"path": name, "upstream_sha256": digest,
                               "upstream_bytes": len(blob), "locked_sha256": expected[name],
                               "vendor": actual.get(name)})
    return {"requested": True, "all_pass": resolved == commit and tree == lock["git_tree"]
            and not missing and not unlisted and not unsupported and not mismatches,
            "clone": str(upstream), "resolved_commit": resolved, "actual_git_tree": tree,
            "commit_matches": resolved == commit, "tree_matches": tree == lock["git_tree"],
            "committed_files": len(entries), "checked_blobs": checked, "checked_bytes": checked_bytes,
            "missing_from_commit": missing, "unlisted_committed_files": unlisted,
            "unsupported_entries": unsupported, "mismatches": mismatches,
            "scope": "Verifies local Git objects; does not contact or authenticate the declared hosting URL."}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=ROOT / "vendor/worldmodel.lock.json")
    parser.add_argument("--vendor", type=Path, default=ROOT / "vendor/wm_kit_opt2")
    parser.add_argument("--upstream", type=Path, help="optional local Git clone containing the locked commit")
    args = parser.parse_args(argv)
    result = {"all_pass": False, "lock": str(args.lock.absolute()), "vendor": str(args.vendor.absolute())}
    try:
        lock, lock_hash = read_lock(args.lock)
        result.update({"lock_sha256": lock_hash, "upstream_url": lock["upstream_url"],
                       "commit": lock["commit"], "git_tree": lock["git_tree"]})
        local, actual = check_vendor(args.vendor.absolute(), lock["tracked_files"])
        result["vendor_check"] = local
        result["upstream_check"] = (check_upstream(args.upstream.absolute(), lock, actual) if args.upstream
                                    else {"requested": False, "all_pass": None,
                                          "scope": "Not checked; local hashes alone do not verify commit/tree/URL."})
        result["all_pass"] = local["all_pass"] and (not args.upstream or result["upstream_check"]["all_pass"])
    except (OSError, ValueError, TypeError) as error:
        result["error"] = str(error)
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0 if result["all_pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
