# Byte-preserving evidence chunks

`tools/evidence_chunks.py` packages one large evidence file, including an already
compressed archive, as ordinary binary files of at most **50 MiB (52,428,800
bytes)**. It reads the original bytes directly; it never decompresses,
recompresses, deletes, or changes the original. No upload or Git change is made.

Run from the repository root:

```sh
python3 tools/evidence_chunks.py pack artifacts/example.json.gz artifacts/example.parts
python3 tools/evidence_chunks.py restore artifacts/example.parts/manifest.json
```

Commit the entire new package directory when appropriate. The original may stay
locally ignored. Restore on another checkout with the same relative directories,
or choose a different destination with `restore ... --target artifacts/restored.gz`.
Parent directories must already exist. Use `--root PATH` before the subcommand to
select a different repository root. All input/output paths other than that root
must be canonical repository-relative paths; symlink components are rejected.

The version 1 JSON manifest records the original relative path, total bytes and
SHA256, chunk size, and each chunk's zero-based index, filename, byte offset,
length and SHA256. Restore requires contiguous manifest order and verifies every
chunk and the whole file. Chunk filenames are local to the manifest directory.
An empty original has no chunks and the SHA256 of the empty byte string.

Pack exclusively reserves a new output directory and refuses any existing one.
Its `manifest.json` appears atomically only after all chunks are complete. Failed
runs clean up their own files; an interrupted process may leave an incomplete
directory without a manifest, which must not be treated as a valid package.
Restore writes a temporary file beside the destination and publishes it only
after validation, using an atomic operation that cannot replace an existing
file. An existing exact destination is accepted after validating the package;
an existing different destination is refused. Original file permissions and
timestamps are not reproduced; this format preserves file bytes.

Use a stable local directory while packaging or restoring. Concurrent file
changes are checked and fail validation; files replaced by another writer are
preserved for inspection rather than deleted during cleanup.

Evidence data is streamed in at most 1 MiB buffers. Metadata is bounded by 65,536
chunks and a 16 MiB manifest. `pack --chunk-bytes N` supports smaller chunks for testing (1 through
52,428,800 bytes); the default is suitable for large repository evidence.

Focused verification:

```sh
python3 -m unittest discover -s tests -p 'test_evidence_chunks.py' -v
```
