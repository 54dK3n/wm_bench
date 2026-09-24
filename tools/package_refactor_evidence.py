#!/usr/bin/env python3
"""Deterministic, offline C-evidence packages; no simulator or network access.

Create:  python3 tools/package_refactor_evidence.py --create
Check:   python3 tools/package_refactor_evidence.py --check
Restore: python3 tools/package_refactor_evidence.py --restore

Only executed per-map evidence under the two named rounds is accepted. Native
vision PNGs are reconstructed from unmodified native record pngBase64 fields;
demo keyframes are stored. No platform/server data or authentication files are
selected. Original file bytes (including historical paths inside JSON) remain
unchanged. --restore refuses conflicts and never extracts arbitrary tar paths.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = "artifacts/inloop/refactor/evidence-packages"
ROUNDS = {"opt2-r3": "artifacts/inloop/opt-2/round-3", "refactor-r1": "artifacts/inloop/refactor/round-1"}
SCHEMA = "refactor-evidence-packages/v1"
MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
MAX_EXPANDED_BYTES = 512 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=True, indent=2) + "\n").encode()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key: " + key)
        result[key] = value
    return result


def decode(data):
    return json.loads(data, object_pairs_hook=unique_object)


def safe_relative(value):
    if not isinstance(value, str) or not value or "\0" in value or "\\" in value:
        raise ValueError("Invalid relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or path.as_posix() != value or not path.parts:
        raise ValueError("Unsafe relative path: " + value)
    return path


def local_path(root, relative):
    parts = safe_relative(relative).parts
    path = root.joinpath(*parts)
    for current in (path, *path.parents):
        if current == root:
            break
        if current.is_symlink():
            raise ValueError("Symlink path refused: " + relative)
    if not path.resolve().is_relative_to(root):
        raise ValueError("Path escapes repository: " + relative)
    return path


def read_regular(path):
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError("Expected regular file: " + str(path))
    data = path.read_bytes()
    after = path.lstat()
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError("File changed while reading: " + str(path))
    return data


def evidence_path(relative, package):
    safe_relative(relative)
    prefix = ROUNDS.get(package["round"])
    if not prefix or not relative.startswith(prefix + "/"):
        raise ValueError("Evidence outside the approved round: " + relative)
    tail = relative[len(prefix) + 1:]
    own_map = re.escape(package["map"])
    own_attempt = re.escape(package["attempt"])
    patterns = [own_map + r"\.(?:json|log|samples\.json|partial\.txt)",
                r"attempts/" + own_attempt + r"\.(?:json|log|record\.json|samples\.json|vision\.json|demo\.json|partial\.txt)",
                r"attempts/" + own_attempt + r"\.vision/evidence-\d+-tick-\d+\.png",
                r"attempts/" + own_attempt + r"\.demo/event-\d+-package_(?:grabbed|delivered)-tick-\d+\.png"]
    if not any(re.fullmatch(pattern, tail) for pattern in patterns):
        raise ValueError("File is not approved per-map evidence: " + relative)
    return relative


def recorded_path(root, value):
    path = Path(value)
    if path.is_absolute():
        if path.is_relative_to(root):
            return path.relative_to(root).as_posix()
        if "artifacts" not in path.parts:
            raise ValueError("External evidence reference refused")
        path = Path(*path.parts[path.parts.index("artifacts"):])
    return safe_relative(path.as_posix()).as_posix()


def collect_package(root, label, name):
    folder = ROUNDS[label]
    raw_relative = folder + "/" + name + ".json"
    raw = decode(read_regular(local_path(root, raw_relative)))
    if raw.get("assignedMap") != name or raw.get("taskId") != "R2-GYI-MVP-02":
        raise ValueError("Executed map/task identity differs")
    record_relative = recorded_path(root, raw["fullRecordFile"])
    match = re.fullmatch(re.escape(folder) + r"/attempts/(attempt-\d{3,})\.record\.json", record_relative)
    if not match:
        raise ValueError("Native record is not this round's executed attempt")
    package = {"schema": SCHEMA, "round": label, "map": name, "attempt": match.group(1), "files": []}
    stored, blobs = {}, {}
    def add(relative):
        evidence_path(relative, package)
        payload = read_regular(local_path(root, relative))
        item = {"path": relative, "bytes": len(payload), "sha256": digest(payload), "blob": "blobs/" + digest(payload)}
        stored[relative] = item
        blobs[item["blob"]] = payload
        return payload
    for stem in (folder + "/" + name, folder + "/attempts/" + package["attempt"]):
        for suffix in (".json", ".log", ".samples.json", ".partial.txt"):
            add(stem + suffix)
    record_bytes = add(record_relative)
    record = decode(record_bytes)
    if record.get("taskId") != "R2-GYI-MVP-02" or record.get("runId") != raw.get("record", {}).get("top", {}).get("runId"):
        raise ValueError("Native record identity differs")
    export = raw["fullRecordExport"]
    if export["sha256"] != digest(record_bytes) or export["bytes"] != len(record_bytes):
        raise ValueError("Native record export hash/bytes differ")
    attempt_raw = decode(blobs[stored[folder + "/attempts/" + package["attempt"] + ".json"]["blob"]])
    if attempt_raw != raw:
        raise ValueError("Canonical and attempt raw files differ")
    for field, suffix in (("visionEvidenceFile", ".vision.json"), ("demoEvidenceFile", ".demo.json")):
        relative = recorded_path(root, raw[field])
        if relative != folder + "/attempts/" + package["attempt"] + suffix:
            raise ValueError("Evidence manifest references a different attempt")
        manifest = decode(add(relative))
        if manifest.get("runId") != record["runId"]:
            raise ValueError("Frame manifest run identity differs")
        native = {frame["evidenceId"]: frame for frame in record["visionFrames"]}
        if suffix == ".vision.json" and (len(native) != len(record["visionFrames"])
                or set(native) != {frame["evidenceId"] for frame in manifest["frames"]}
                or len(native) != len(manifest["frames"])):
            raise ValueError("Native/vision frame inventory differs")
        for frame in manifest["frames"]:
            image = str(PurePosixPath(relative).parent / safe_relative(frame["image"]))
            evidence_path(image, package)
            data = read_regular(local_path(root, image))
            if digest(data) != frame["sha256"] or len(data) != frame["byteLength"]:
                raise ValueError("Frame image hash/bytes differ")
            if suffix == ".demo.json":
                add(image)
            else:
                original = native[frame["evidenceId"]]
                if data != base64.b64decode(original["pngBase64"], validate=True):
                    raise ValueError("Native embedded PNG differs from preserved image")
                stored[image] = {"path": image, "bytes": len(data), "sha256": digest(data),
                                 "native_png": {"record": record_relative, "evidenceId": frame["evidenceId"], "frameId": frame["frameId"]}}
    package["files"] = [stored[key] for key in sorted(stored)]
    return package, blobs


def write_identical_or_new(path, data):
    if path.exists():
        if read_regular(path) != data:
            raise ValueError("Refusing to overwrite different file: " + str(path))
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(data)
    return True


def create_archive(path, package, blobs):
    metadata = encoded(package)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".evidence-", suffix=".tar.xz", dir=path.parent)
    os.close(descriptor)
    temporary = Path(temporary)
    try:
        with tarfile.open(temporary, "w:xz", format=tarfile.USTAR_FORMAT, preset=3) as archive:
            for name, data in [("package.json", metadata), *sorted(blobs.items())]:
                info = tarfile.TarInfo(name)
                info.size, info.mtime, info.mode, info.uid, info.gid = len(data), 0, 0o444, 0, 0
                info.uname = info.gname = ""
                archive.addfile(info, io.BytesIO(data))
        data = read_regular(temporary)
        if len(data) >= MAX_ARCHIVE_BYTES:
            raise ValueError("Archive must be smaller than 50 MiB: " + path.name)
        write_identical_or_new(path, data)
    finally:
        temporary.unlink(missing_ok=True)
    return {"archive": path.name, "bytes": len(data), "sha256": digest(data),
            "package_manifest_sha256": digest(metadata), **package}


def create(root, destination):
    packages = []
    for label in ROUNDS:
        for index in range(1, 11):
            name = f"map-{index:02d}"
            package, blobs = collect_package(root, label, name)
            entry = create_archive(destination / (label + "-" + name + ".tar.xz"), package, blobs)
            packages.append(entry)
            print(json.dumps({"created_or_identical": entry["archive"], "bytes": entry["bytes"]}), flush=True)
    manifest = {"schema": SCHEMA, "archive_limit_bytes_exclusive": MAX_ARCHIVE_BYTES,
                "policy": "Only these two executed task-2 rounds. Native PNGs derive byte-exactly from unmodified record; external platform/server/auth files excluded. No simulation.",
                "packages": packages, "summary": {"archives": len(packages),
                    "archive_bytes": sum(item["bytes"] for item in packages),
                    "restored_files": sum(len(item["files"]) for item in packages),
                    "restored_bytes": sum(file["bytes"] for item in packages for file in item["files"]),
                    "native_pngs_reconstructed": sum("native_png" in file for item in packages for file in item["files"])}}
    write_identical_or_new(destination / "manifest.json", encoded(manifest))
    return manifest


def validate_package(destination, entry):
    if not re.fullmatch(r"(?:opt2-r3|refactor-r1)-map-(?:0[1-9]|10)\.tar\.xz", entry["archive"]):
        raise ValueError("Unexpected archive name")
    if entry["archive"] != entry["round"] + "-" + entry["map"] + ".tar.xz" or not re.fullmatch(r"attempt-\d{3,}", entry["attempt"]):
        raise ValueError("Archive name/identity differs")
    archive_path = local_path(destination, entry["archive"])
    content = read_regular(archive_path)
    if len(content) != entry["bytes"] or len(content) >= MAX_ARCHIVE_BYTES or digest(content) != entry["sha256"]:
        raise ValueError("Archive size/SHA256 mismatch: " + entry["archive"])
    files = entry["files"]
    if not isinstance(files, list) or not files or len(files) != len({item["path"] for item in files}):
        raise ValueError("Invalid/duplicate file inventory")
    expected_blobs = {}
    for file in files:
        evidence_path(file["path"], entry)
        if type(file["bytes"]) is not int or not 0 <= file["bytes"] <= MAX_EXPANDED_BYTES or not re.fullmatch(r"[0-9a-f]{64}", file["sha256"]):
            raise ValueError("Invalid file size/SHA256")
        if ("blob" in file) == ("native_png" in file):
            raise ValueError("File must have exactly one storage mode")
        if ("native_png" in file) != (".vision/" in file["path"]):
            raise ValueError("Native PNG must use record-derived storage")
        if "blob" in file:
            if file["blob"] != "blobs/" + file["sha256"]:
                raise ValueError("Blob path must be content-addressed")
            expected_blobs[file["blob"]] = file["bytes"]
    if sum(file["bytes"] for file in files) > MAX_EXPANDED_BYTES:
        raise ValueError("Expanded package exceeds safety limit")
    blobs = {}
    with tarfile.open(fileobj=io.BytesIO(content), mode="r:xz") as archive:
        members = archive.getmembers()
        names = [item.name for item in members]
        if len(names) != len(set(names)) or set(names) != {"package.json", *expected_blobs}:
            raise ValueError("Archive inventory differs or has duplicate/unsafe members")
        for member in members:
            if not member.isfile() or member.size < 0 or member.size > MAX_EXPANDED_BYTES:
                raise ValueError("Only bounded regular archive members are allowed")
            if member.name in expected_blobs and member.size != expected_blobs[member.name]:
                raise ValueError("Tar member size differs")
            blobs[member.name] = archive.extractfile(member).read()
    package_bytes = blobs.pop("package.json")
    embedded = decode(package_bytes)
    if (digest(package_bytes) != entry["package_manifest_sha256"] or embedded.get("schema") != SCHEMA
            or any(embedded.get(key) != entry.get(key) for key in ("round", "map", "attempt", "files"))):
        raise ValueError("Embedded manifest differs")
    for name, data in blobs.items():
        if "blobs/" + digest(data) != name:
            raise ValueError("Stored blob SHA256 differs")
    restored, records = {}, {}
    lookup = {item["path"]: item for item in files}
    for file in files:
        if "blob" in file:
            data = blobs[file["blob"]]
        else:
            ref = file["native_png"]
            evidence_path(ref["record"], entry)
            record_item = lookup.get(ref["record"], {})
            if "blob" not in record_item or not ref["record"].endswith(".record.json"):
                raise ValueError("Derived PNG record is not stored in this package")
            if ref["record"] not in records:
                records[ref["record"]] = decode(blobs[record_item["blob"]])
            matching = [frame for frame in records[ref["record"]]["visionFrames"]
                        if frame["evidenceId"] == ref["evidenceId"] and frame["frameId"] == ref["frameId"]]
            if len(matching) != 1:
                raise ValueError("Derived PNG frame binding is ambiguous/missing")
            data = base64.b64decode(matching[0]["pngBase64"], validate=True)
        if len(data) != file["bytes"] or digest(data) != file["sha256"]:
            raise ValueError("Restored bytes/SHA256 mismatch: " + file["path"])
        restored[file["path"]] = data
    return restored


def check_or_restore(root, destination, restore=False):
    manifest = decode(read_regular(local_path(destination, "manifest.json")))
    if manifest.get("schema") != SCHEMA:
        raise ValueError("Unknown package manifest schema")
    packages = manifest["packages"]
    expected = {(label, f"map-{index:02d}") for label in ROUNDS for index in range(1, 11)}
    if len(packages) != len(expected) or {(item["round"], item["map"]) for item in packages} != expected:
        raise ValueError("Exactly twenty distinct executed layout packages are required")
    counts = {"archives": len(packages), "verified_files": 0, "verified_bytes": 0, "existing_identical": 0, "missing": 0, "restored": 0}
    paths = set()
    # Validate every archive and every existing destination before any write.
    for package in packages:
        for relative, data in validate_package(destination, package).items():
            if relative in paths:
                raise ValueError("Duplicate path across packages: " + relative)
            paths.add(relative)
            path = local_path(root, relative)
            counts["verified_files"] += 1; counts["verified_bytes"] += len(data)
            if path.exists():
                if read_regular(path) != data:
                    raise ValueError("Existing file differs; nothing restored: " + relative)
                counts["existing_identical"] += 1
            else:
                counts["missing"] += 1
    if restore:
        for package in packages:
            for relative, data in validate_package(destination, package).items():
                counts["restored"] += write_identical_or_new(local_path(root, relative), data)
    return {"all_pass": True, "mode": "restore" if restore else "check", **counts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--create", action="store_true")
    mode.add_argument("--restore", action="store_true")
    mode.add_argument("--check", action="store_true", help="validate archives/existing files (default)")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--packages", default=DESTINATION)
    args = parser.parse_args()
    try:
        root = args.root.resolve()
        destination = local_path(root, args.packages)
        if args.create:
            manifest = create(root, destination)
            result = {"all_pass": True, "mode": "create", **manifest["summary"]}
        else:
            result = check_or_restore(root, destination, args.restore)
    except (OSError, ValueError, TypeError, KeyError, tarfile.TarError) as error:
        result = {"all_pass": False, "error": str(error)}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    raise SystemExit(0 if result["all_pass"] else 1)


if __name__ == "__main__":
    main()
