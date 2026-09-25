"""Byte preservation, validation and non-replacing publication of evidence."""

import contextlib
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools import evidence_chunks as chunks


class EvidenceChunksTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "artifacts").mkdir()
        self.source = self.root / "artifacts/original.gz"
        self.data = gzip.compress(bytes(range(256)) * 32, mtime=1234)
        self.source.write_bytes(self.data)
        self.manifest_path = "artifacts/package/manifest.json"

    def pack(self, chunk_bytes=73):
        return chunks.pack(self.root, "artifacts/original.gz", "artifacts/package", chunk_bytes)

    def manifest(self):
        return json.loads((self.root / self.manifest_path).read_text())

    def rewrite_manifest(self, manifest):
        (self.root / self.manifest_path).write_text(json.dumps(manifest))

    def restore(self, target="artifacts/restored.gz"):
        return chunks.restore(self.root, self.manifest_path, target)

    def assert_no_restore_temps(self):
        self.assertEqual(list((self.root / "artifacts").glob(".restore-*.tmp")), [])

    def test_roundtrip_preserves_compressed_bytes_and_source_metadata(self):
        before = self.source.stat()
        result = self.pack()
        manifest = self.manifest()
        self.assertEqual(manifest["version"], 1)
        self.assertEqual(manifest["original"], {
            "path": "artifacts/original.gz", "bytes": len(self.data),
            "sha256": hashlib.sha256(self.data).hexdigest()})
        output = bytearray()
        for index, part in enumerate(manifest["chunks"]):
            data = (self.root / "artifacts/package" / part["path"]).read_bytes()
            self.assertEqual(part["index"], index)
            self.assertEqual(part["offset"], len(output))
            self.assertEqual(part["bytes"], len(data))
            self.assertEqual(part["sha256"], hashlib.sha256(data).hexdigest())
            self.assertLessEqual(len(data), 73)
            output.extend(data)
        self.assertEqual(bytes(output), self.data)
        self.assertEqual(result["chunks"], len(manifest["chunks"]))
        restored = self.restore()
        self.assertEqual(restored["status"], "restored")
        self.assertEqual((self.root / "artifacts/restored.gz").read_bytes(), self.data)
        self.assertEqual(chunks._stamp(before), chunks._stamp(self.source.stat()))
        self.assert_no_restore_temps()

    def test_default_chunk_size_is_fifty_mebibytes(self):
        chunks.pack(self.root, "artifacts/original.gz", "artifacts/package")
        self.assertEqual(self.manifest()["chunk_bytes"], 50 * 1024 * 1024)

    def test_exact_boundary_and_empty_file(self):
        for data in (b"", b"abcdefgh", b"abcdefghijklmnop"):
            with self.subTest(length=len(data)), tempfile.TemporaryDirectory() as root:
                Path(root, "input").write_bytes(data)
                chunks.pack(root, "input", "package", chunk_bytes=8)
                manifest = json.loads(Path(root, "package/manifest.json").read_text())
                self.assertEqual(len(manifest["chunks"]), len(data) // 8)
                chunks.restore(root, "package/manifest.json", "output")
                self.assertEqual(Path(root, "output").read_bytes(), data)

    def test_restore_defaults_to_original_path(self):
        self.pack()
        self.source.unlink()
        result = chunks.restore(self.root, self.manifest_path)
        self.assertEqual(result["path"], "artifacts/original.gz")
        self.assertEqual(self.source.read_bytes(), self.data)

    def test_existing_exact_target_is_accepted_without_mutation(self):
        self.pack()
        before = self.source.stat()
        result = chunks.restore(self.root, self.manifest_path)
        self.assertEqual(result["status"], "existing_exact")
        self.assertEqual(chunks._stamp(before), chunks._stamp(self.source.stat()))
        self.assert_no_restore_temps()

    def test_existing_different_target_is_never_replaced(self):
        self.pack()
        target = self.root / "artifacts/restored.gz"
        for data in (b"other", b"x" * len(self.data)):
            target.write_bytes(data)
            before = target.stat()
            with self.subTest(size=len(data)), self.assertRaisesRegex(ValueError, "overwrite"):
                self.restore()
            self.assertEqual(target.read_bytes(), data)
            self.assertEqual(chunks._stamp(before), chunks._stamp(target.stat()))
            self.assert_no_restore_temps()

    def test_corrupt_chunk_is_rejected_and_temporary_output_removed(self):
        self.pack()
        part = self.root / "artifacts/package" / self.manifest()["chunks"][0]["path"]
        part.write_bytes(b"X" * part.stat().st_size)
        with self.assertRaisesRegex(ValueError, "SHA256"):
            self.restore()
        self.assertFalse((self.root / "artifacts/restored.gz").exists())
        self.assert_no_restore_temps()
        # Idempotent restores still validate the package, even when the target
        # already matches the expected original digest.
        with self.assertRaisesRegex(ValueError, "SHA256"):
            chunks.restore(self.root, self.manifest_path)
        self.assertEqual(self.source.read_bytes(), self.data)

    def test_whole_file_sha_is_checked_after_individual_chunk_hashes(self):
        self.pack()
        manifest = self.manifest()
        manifest["original"]["sha256"] = "0" * 64
        self.rewrite_manifest(manifest)
        with self.assertRaisesRegex(ValueError, "whole-file"):
            self.restore()
        self.assertFalse((self.root / "artifacts/restored.gz").exists())
        self.assert_no_restore_temps()

    def test_truncated_and_missing_chunks_fail_without_publishing(self):
        for missing in (False, True):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as root:
                Path(root, "input").write_bytes(b"0123456789")
                chunks.pack(root, "input", "package", 5)
                part = Path(root, "package/chunk-000001.bin")
                if missing:
                    part.unlink()
                else:
                    part.write_bytes(b"1")
                with self.assertRaises((ValueError, FileNotFoundError)):
                    chunks.restore(root, "package/manifest.json", "output")
                self.assertFalse(Path(root, "output").exists())
                self.assertEqual(list(Path(root).glob(".restore-*.tmp")), [])

    def test_manifest_order_offset_size_and_duplicate_entries_are_rejected(self):
        self.pack()
        baseline = self.manifest()
        mutations = [
            lambda m: m["chunks"].reverse(),
            lambda m: m["chunks"][1].update(offset=0),
            lambda m: m["chunks"][1].update(bytes=1),
            lambda m: m["chunks"].__setitem__(1, m["chunks"][0]),
            lambda m: m["chunks"][0].update(index=False),
        ]
        for mutation in mutations:
            manifest = json.loads(json.dumps(baseline))
            mutation(manifest)
            self.rewrite_manifest(manifest)
            with self.assertRaisesRegex(ValueError, "invalid chunk"):
                self.restore()
            self.assert_no_restore_temps()

    def test_manifest_path_traversal_is_rejected(self):
        self.pack()
        baseline = self.manifest()
        for path in ("../outside", "/tmp/outside", "artifacts/../outside", "a\\b", "C:/outside"):
            for field in ("original", "chunk"):
                with self.subTest(path=path, field=field):
                    manifest = json.loads(json.dumps(baseline))
                    (manifest["original"] if field == "original" else manifest["chunks"][0])["path"] = path
                    self.rewrite_manifest(manifest)
                    with self.assertRaises(ValueError):
                        self.restore()
                    self.assert_no_restore_temps()

    def test_argument_paths_must_be_canonical_and_relative(self):
        self.pack()
        for path in ("", ".", "../outside", "/tmp/outside", "a//b", "a/./b", "a\\b", "a/", "C:/outside"):
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    chunks.pack(self.root, path, "new-package")
                with self.assertRaises(ValueError):
                    chunks.pack(self.root, "artifacts/original.gz", path)
                with self.assertRaises(ValueError):
                    chunks.restore(self.root, path, "output")
                with self.assertRaises(ValueError):
                    self.restore(path)

    def test_symlink_source_and_parent_components_are_rejected(self):
        (self.root / "linked.gz").symlink_to(self.source)
        (self.root / "linked").symlink_to(self.root / "artifacts", target_is_directory=True)
        for source in ("linked.gz", "linked/original.gz"):
            with self.subTest(source=source), self.assertRaises(OSError):
                chunks.pack(self.root, source, "package")
        with self.assertRaises(OSError):
            chunks.pack(self.root, "artifacts/original.gz", "linked/package")
        self.assertFalse((self.root / "artifacts/package").exists())

    def test_symlink_manifest_chunk_target_and_target_parent_are_rejected(self):
        self.pack()
        package = self.root / "artifacts/package"
        (self.root / "manifest-link.json").symlink_to(package / "manifest.json")
        with self.assertRaises(OSError):
            chunks.restore(self.root, "manifest-link.json", "output")
        (self.root / "linked").symlink_to(self.root / "artifacts", target_is_directory=True)
        with self.assertRaises(OSError):
            chunks.restore(self.root, "linked/package/manifest.json", "output")
        with self.assertRaises(OSError):
            self.restore("linked/restored.gz")
        (self.root / "target-link").symlink_to(self.source)
        with self.assertRaises(OSError):
            self.restore("target-link")
        part = package / "chunk-000000.bin"
        saved = self.root / "saved-chunk"
        part.rename(saved)
        part.symlink_to(saved)
        with self.assertRaises(OSError):
            self.restore()
        self.assertEqual(self.source.read_bytes(), self.data)
        self.assert_no_restore_temps()

    def test_existing_output_directory_is_never_reused(self):
        output = self.root / "artifacts/package"
        output.mkdir()
        for sentinel in (None, b"preserve"):
            if sentinel is not None:
                (output / "sentinel").write_bytes(sentinel)
            with self.assertRaises(FileExistsError):
                self.pack()
            self.assertEqual(sorted(p.name for p in output.iterdir()), [] if sentinel is None else ["sentinel"])

    def test_output_directory_symlink_is_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "sentinel").write_bytes(b"preserve")
        (self.root / "artifacts/package").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(FileExistsError):
            self.pack()
        self.assertEqual(sorted(p.name for p in outside.iterdir()), ["sentinel"])

    def test_failed_pack_cleans_only_its_new_output(self):
        with mock.patch.object(chunks.os, "fsync", side_effect=OSError("simulated failure")):
            with self.assertRaisesRegex(OSError, "simulated"):
                self.pack()
        self.assertFalse((self.root / "artifacts/package").exists())
        self.assertEqual(self.source.read_bytes(), self.data)

    def test_pack_manifest_is_published_last_and_never_replaces_racing_file(self):
        original_link = chunks.os.link
        output = self.root / "artifacts/package"

        def race(src, dst, **kwargs):
            self.assertFalse((output / "manifest.json").exists())
            self.assertEqual(b"".join(part.read_bytes() for part in sorted(output.glob("chunk-*.bin"))),
                             self.data)
            (output / "manifest.json").write_bytes(b"another writer")
            return original_link(src, dst, **kwargs)

        with mock.patch.object(chunks.os, "link", side_effect=race):
            with self.assertRaises(FileExistsError):
                self.pack()
        self.assertEqual((output / "manifest.json").read_bytes(), b"another writer")
        self.assertEqual(sorted(p.name for p in output.iterdir()), ["manifest.json"])
        self.assertEqual(self.source.read_bytes(), self.data)

    def test_concurrent_source_change_prevents_manifest_publication(self):
        original_new_file = chunks._new_file

        def mutate_source(parent_fd, name):
            if name == "chunk-000000.bin":
                self.source.write_bytes(b"changed")
            return original_new_file(parent_fd, name)

        with mock.patch.object(chunks, "_new_file", side_effect=mutate_source):
            with self.assertRaisesRegex(ValueError, "changed"):
                self.pack()
        self.assertFalse((self.root / "artifacts/package").exists())

    def test_growing_source_aborts_at_its_original_size(self):
        original_new_file = chunks._new_file
        names = []

        def grow_source(parent_fd, name):
            names.append(name)
            if name == "chunk-000000.bin":
                with self.source.open("ab") as stream:
                    stream.write(b"extra" * 1000)
            return original_new_file(parent_fd, name)

        with mock.patch.object(chunks, "_new_file", side_effect=grow_source):
            with self.assertRaisesRegex(ValueError, "changed"):
                self.pack()
        self.assertLessEqual(len(names), (len(self.data) + 72) // 73)
        self.assertFalse((self.root / "artifacts/package").exists())

    def test_growing_existing_target_has_a_bounded_read(self):
        self.pack()
        real_reader = chunks._reader
        reads = []

        @contextlib.contextmanager
        def growing_reader(parent_fd, name, **kwargs):
            with real_reader(parent_fd, name, **kwargs) as (stream, info):
                if name != "original.gz":
                    yield stream, info
                    return

                class GrowingStream:
                    def read(self, size):
                        reads.append(size)
                        with self.source.open("ab") as writer:
                            writer.write(b"x" * size)
                        return stream.read(size)

                fake = GrowingStream()
                fake.source = self.source
                yield fake, info

        with mock.patch.object(chunks, "_reader", side_effect=growing_reader):
            with self.assertRaisesRegex(ValueError, "changed"):
                chunks.restore(self.root, self.manifest_path)
        self.assertEqual(reads, [len(self.data) + 1])

    def test_racing_different_destination_is_not_overwritten(self):
        self.pack()
        original_link = chunks.os.link
        target = self.root / "artifacts/restored.gz"

        def race(src, dst, **kwargs):
            target.write_bytes(b"another writer")
            return original_link(src, dst, **kwargs)

        with mock.patch.object(chunks.os, "link", side_effect=race):
            with self.assertRaisesRegex(ValueError, "overwrite"):
                self.restore()
        self.assertEqual(target.read_bytes(), b"another writer")
        self.assert_no_restore_temps()

    def test_racing_exact_destination_is_accepted(self):
        self.pack()
        original_link = chunks.os.link
        target = self.root / "artifacts/restored.gz"

        def race(src, dst, **kwargs):
            target.write_bytes(self.data)
            return original_link(src, dst, **kwargs)

        with mock.patch.object(chunks.os, "link", side_effect=race):
            self.assertEqual(self.restore()["status"], "existing_exact")
        self.assertEqual(target.read_bytes(), self.data)
        self.assert_no_restore_temps()

    def test_temporary_path_substitution_cannot_report_success(self):
        self.pack()
        real_link = chunks.os.link

        def substitute(src, dst, **kwargs):
            parent_fd = kwargs["src_dir_fd"]
            os.unlink(src, dir_fd=parent_fd)
            os.symlink("original.gz", src, dir_fd=parent_fd)
            return real_link(src, dst, **kwargs)

        with mock.patch.object(chunks.os, "link", side_effect=substitute):
            with self.assertRaisesRegex(ValueError, "publication"):
                self.restore()
        self.assertTrue((self.root / "artifacts/restored.gz").is_symlink())
        self.assertEqual(self.source.read_bytes(), self.data)

    def test_temporary_manifest_substitution_cannot_report_success(self):
        real_link = chunks.os.link

        def substitute(src, dst, **kwargs):
            parent_fd = kwargs["src_dir_fd"]
            os.unlink(src, dir_fd=parent_fd)
            fd = os.open(src, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644, dir_fd=parent_fd)
            with os.fdopen(fd, "wb") as stream:
                stream.write(b"substituted manifest")
            return real_link(src, dst, **kwargs)

        with mock.patch.object(chunks.os, "link", side_effect=substitute):
            with self.assertRaisesRegex(ValueError, "publication"):
                self.pack()
        self.assertEqual((self.root / self.manifest_path).read_bytes(), b"substituted manifest")
        self.assertEqual(self.source.read_bytes(), self.data)

    def test_destination_replaced_after_link_is_not_deleted(self):
        self.pack()
        real_link = chunks.os.link
        target = self.root / "artifacts/restored.gz"

        def replace_after_link(src, dst, **kwargs):
            real_link(src, dst, **kwargs)
            target.unlink()
            target.write_bytes(b"another writer")

        with mock.patch.object(chunks.os, "link", side_effect=replace_after_link):
            with self.assertRaisesRegex(ValueError, "publication"):
                self.restore()
        self.assertEqual(target.read_bytes(), b"another writer")
        self.assert_no_restore_temps()

    def test_invalid_chunk_sizes_and_metadata_limits(self):
        for size in (0, -1, True, chunks.DEFAULT_CHUNK_BYTES + 1):
            with self.subTest(size=size), self.assertRaises(ValueError):
                self.pack(size)
        with mock.patch.object(chunks, "MAX_CHUNKS", 1):
            with self.assertRaisesRegex(ValueError, "limit"):
                self.pack()
        self.assertFalse((self.root / "artifacts/package").exists())
        self.pack()
        with mock.patch.object(chunks, "MAX_MANIFEST_BYTES", 10):
            with self.assertRaisesRegex(ValueError, "limit"):
                self.restore()

    def test_duplicate_json_keys_and_unknown_version_are_rejected(self):
        self.pack()
        manifest = self.manifest()
        manifest["version"] = 2
        self.rewrite_manifest(manifest)
        with self.assertRaisesRegex(ValueError, "version"):
            self.restore()
        (self.root / self.manifest_path).write_text('{"version":1,"version":2}')
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.restore()

    def test_non_regular_source_does_not_block_or_create_package(self):
        fifo = self.root / "pipe"
        os.mkfifo(fifo)
        with self.assertRaisesRegex(ValueError, "regular"):
            chunks.pack(self.root, "pipe", "package")
        self.assertFalse((self.root / "package").exists())

    def test_read_sizes_remain_bounded_even_for_large_chunks(self):
        self.source.write_bytes(b"x" * (chunks.READ_BYTES * 2 + 3))
        real_reader = chunks._reader
        sizes = []

        class RecordingReader:
            def __init__(self, stream):
                self.stream = stream

            def read(self, size):
                sizes.append(size)
                return self.stream.read(size)

            def fileno(self):
                return self.stream.fileno()

        @contextlib.contextmanager
        def reader(*args, **kwargs):
            with real_reader(*args, **kwargs) as (stream, info):
                yield RecordingReader(stream), info

        with mock.patch.object(chunks, "_reader", side_effect=reader):
            self.pack(chunks.DEFAULT_CHUNK_BYTES)
        self.assertGreater(len(sizes), 2)
        self.assertTrue(all(0 < size <= chunks.READ_BYTES for size in sizes))
        self.restore()
        self.assertEqual((self.root / "artifacts/restored.gz").stat().st_size, chunks.READ_BYTES * 2 + 3)

    def test_cli_roundtrip_and_failure_status(self):
        script = Path(chunks.__file__)
        for arguments in (["pack", "artifacts/original.gz", "artifacts/package", "--chunk-bytes", "73"],
                          ["restore", self.manifest_path, "--target", "artifacts/restored.gz"]):
            result = subprocess.run([sys.executable, str(script), "--root", str(self.root), *arguments],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertTrue(json.loads(result.stdout)["ok"])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = chunks.main(["--root", str(self.root), "restore", "../outside"])
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(output.getvalue())["ok"])


if __name__ == "__main__":
    unittest.main()
