"""Offline safety, exact-byte restoration and reproducible-archive contracts."""
import base64
import copy
import io
from pathlib import Path
import sys
import tarfile

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import package_refactor_evidence as pack


def fixture_map(root, label="refactor-r1", name="map-01"):
    folder = pack.ROUNDS[label]
    attempt = f"attempt-{int(name[-2:]):03d}"
    stem = folder + "/attempts/" + attempt
    png = b"\x89PNG\r\n\x1a\nnative-fixture"
    demo = b"\x89PNG\r\n\x1a\ndemo-fixture"
    native = {"evidenceId": "vision-1", "frameId": 7, "byteLength": len(png),
              "sha256": pack.digest(png), "pngBase64": base64.b64encode(png).decode()}
    record = pack.encoded({"taskId": "R2-GYI-MVP-02", "runId": "fixture-run", "visionFrames": [native]})
    raw = {"taskId": "R2-GYI-MVP-02", "assignedMap": name,
           "fullRecordFile": stem + ".record.json", "visionEvidenceFile": stem + ".vision.json",
           "demoEvidenceFile": stem + ".demo.json", "record": {"top": {"runId": "fixture-run"}},
           "fullRecordExport": {"sha256": pack.digest(record), "bytes": len(record)}}
    files = {stem + ".record.json": record}
    for prefix in (folder + "/" + name, stem):
        files.update({prefix + ".json": pack.encoded(raw), prefix + ".log": b"driver log\n",
                      prefix + ".samples.json": b"[]\n", prefix + ".partial.txt": b"GY fixture\n"})
    image = attempt + ".vision/evidence-1-tick-0.png"
    shot = attempt + ".demo/event-2-package_grabbed-tick-2.png"
    files[stem + ".vision.json"] = pack.encoded({"runId": "fixture-run", "frames": [
        {**{k: v for k, v in native.items() if k != "pngBase64"}, "image": image}]})
    files[stem + ".demo.json"] = pack.encoded({"runId": "fixture-run", "frames": [
        {"image": shot, "sha256": pack.digest(demo), "byteLength": len(demo)}]})
    files[folder + "/attempts/" + image] = png
    files[folder + "/attempts/" + shot] = demo
    for relative, data in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return files


@pytest.fixture
def one(tmp_path):
    root = tmp_path / "source"
    original = fixture_map(root)
    package, blobs = pack.collect_package(root, "refactor-r1", "map-01")
    destination = tmp_path / "packages"
    entry = pack.create_archive(destination / "refactor-r1-map-01.tar.xz", package, blobs)
    return root, original, destination, entry, package, blobs


def test_exact_bytes_and_native_png_not_stored_twice(one):
    root, original, destination, entry, _, blobs = one
    assert pack.validate_package(destination, entry) == original
    native = next(item for item in entry["files"] if "native_png" in item)
    assert "blobs/" + native["sha256"] not in blobs
    assert all((root / path).read_bytes() == data for path, data in original.items())


def test_deterministic_archive_and_idempotent_write(one, tmp_path):
    _, _, destination, entry, package, blobs = one
    other = tmp_path / "other" / entry["archive"]
    assert pack.create_archive(other, package, blobs) == entry
    assert other.read_bytes() == (destination / entry["archive"]).read_bytes()
    assert pack.create_archive(other, package, blobs) == entry


@pytest.mark.parametrize("path", ["../escape", "/absolute", "a/../escape", "a//b", "a\\b", "."])
def test_unsafe_relative_paths(path):
    with pytest.raises(ValueError):
        pack.safe_relative(path)


@pytest.mark.parametrize("path", ["server/data/auth.json", "artifacts/inloop/opt-2/round-2/map-01.json",
    "artifacts/inloop/refactor/round-1/attempts/attempt-001.auth.json",
    "artifacts/inloop/refactor/round-1/map-02.json"])
def test_only_own_executed_evidence_allowed(one, path):
    with pytest.raises(ValueError):
        pack.evidence_path(path, one[4])


def test_archive_hash_and_derived_frame_binding(one, tmp_path):
    _, _, destination, entry, package, blobs = one
    archive = destination / entry["archive"]
    archive.write_bytes(archive.read_bytes() + b"tamper")
    with pytest.raises(ValueError, match="SHA256"):
        pack.validate_package(destination, entry)
    broken = copy.deepcopy(package)
    next(item for item in broken["files"] if "native_png" in item)["native_png"]["frameId"] = 99
    other = tmp_path / "other"
    changed = pack.create_archive(other / entry["archive"], broken, blobs)
    with pytest.raises(ValueError, match="frame binding"):
        pack.validate_package(other, changed)


def test_symlink_ancestor_is_rejected(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (root / "link").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError, match="Symlink"):
        pack.local_path(root, "link/outside.json")


def test_hash_correct_tar_with_unsafe_member_is_never_extracted(one, tmp_path):
    _, _, destination, original, _, _ = one
    path = destination / original["archive"]
    with tarfile.open(path, "w:xz") as archive:
        member = tarfile.TarInfo("../outside")
        member.size = 1
        archive.addfile(member, io.BytesIO(b"x"))
    entry = {**original, "bytes": path.stat().st_size, "sha256": pack.digest(path.read_bytes())}
    with pytest.raises(ValueError, match="inventory"):
        pack.validate_package(destination, entry)
    assert not (tmp_path / "outside").exists()


def test_all_twenty_restore_conflict_precheck_and_idempotency(tmp_path):
    source = tmp_path / "source"
    originals = {}
    for label in pack.ROUNDS:
        for number in range(1, 11):
            originals.update(fixture_map(source, label, f"map-{number:02d}"))
    destination = tmp_path / "packages"
    manifest = pack.create(source, destination)
    assert manifest["summary"]["archives"] == 20
    target = tmp_path / "clone"
    conflict = target / sorted(originals)[-1]
    conflict.parent.mkdir(parents=True)
    conflict.write_bytes(b"preserve-existing")
    with pytest.raises(ValueError, match="nothing restored"):
        pack.check_or_restore(target, destination, True)
    assert [p for p in target.rglob("*") if p.is_file()] == [conflict]
    assert conflict.read_bytes() == b"preserve-existing"
    conflict.unlink()
    result = pack.check_or_restore(target, destination, True)
    assert result["all_pass"] and result["restored"] == len(originals)
    assert all((target / relative).read_bytes() == data for relative, data in originals.items())
    assert pack.check_or_restore(target, destination, True)["restored"] == 0


def test_incomplete_package_inventory_cannot_pass(tmp_path):
    root = tmp_path / "root"
    destination = tmp_path / "packages"
    destination.mkdir()
    (destination / "manifest.json").write_bytes(pack.encoded({"schema": pack.SCHEMA, "packages": []}))
    with pytest.raises(ValueError, match="twenty"):
        pack.check_or_restore(root, destination)
