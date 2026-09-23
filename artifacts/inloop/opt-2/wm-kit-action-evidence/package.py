#!/usr/bin/env python3
"""Offline delivery packager: tracked commit bytes only; does not run a robot."""
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(__file__).resolve().parent
SOURCE = ROOT / "vendor/wm_kit_opt2"
ORIGINAL = Path("/Users/ken/wm_kit")
BASE = "ad237a143f0d35e100a28c15567d4b75bd56cccf"
COMMIT = "326a5f8892b9da11996b5f3d3d0fc56341aca6e4"


def git(folder, *args):
    return subprocess.check_output(["git", "-C", str(folder), *args])


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    assert git(SOURCE, "rev-parse", "HEAD").decode().strip() == COMMIT
    assert git(SOURCE, "rev-parse", "HEAD^").decode().strip() == BASE
    assert not git(SOURCE, "status", "--porcelain")
    assert git(ORIGINAL, "rev-parse", "HEAD").decode().strip() == BASE
    assert not git(ORIGINAL, "diff", "HEAD")
    changed = git(SOURCE, "diff", "--name-only", BASE, COMMIT).decode().splitlines()
    assert changed == ["docs/ACTION_EVIDENCE.md", "tests/test_action_evidence.py",
                       "world_model/core.py"]
    program = (ROOT / "artifacts/inloop/opt-1/round-2/program.py").read_text()
    blob = re.search(r'b64decode\("([^"]+)"\)', program).group(1)
    old = zipfile.ZipFile(io.BytesIO(base64.b64decode(blob)))
    buf, entries = io.BytesIO(), []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in old.namelist():
            data = git(SOURCE, "show", f"{COMMIT}:{name}")
            assert data == (SOURCE / name).read_bytes()
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
            entries.append({"path": name, "sha256": sha(data),
                            "changed_from_base_embed": data != old.read(name)})
    data = buf.getvalue()
    (OUT / "world_model.zip").write_bytes(data)
    bundle = OUT / "wm_kit_opt2.bundle"
    git(SOURCE, "bundle", "create", str(bundle), "HEAD")
    subprocess.run(["git", "-C", str(SOURCE), "bundle", "verify", str(bundle)],
                   check=True)
    manifest = {
        "base_commit": BASE, "commit": COMMIT, "source": str(SOURCE),
        "source_status_clean": True, "original_head_unchanged": True,
        "original_tracked_worktree_unchanged": True,
        "original_untracked_not_copied": True, "changed_files": changed,
        "package": str(OUT / "world_model.zip"), "package_sha256": sha(data),
        "package_bytes": len(data), "entries": entries,
        "bundle": str(bundle), "bundle_sha256": sha(bundle.read_bytes()),
        "test_command": "PYTHONDONTWRITEBYTECODE=1 python3 -m pytest tests/ -q",
        "test_cwd": str(SOURCE), "test_result": "157 passed in 0.15s",
        "test_scope": "All tracked tests in isolated clone, including 14 new action-evidence cases; original untracked acceptance harness is excluded.",
        "runtime_integration": "Root-owned; caller must verify public holding target, then mark exact selected ID. No robot run performed by this packager.",
        "semantics": "Action evidence revokes original-position belief; not perception decay and not proof of delivery.",
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"commit": COMMIT, "source": str(SOURCE),
                      "package_sha256": sha(data), "bundle": str(bundle)}))


if __name__ == "__main__":
    main()
