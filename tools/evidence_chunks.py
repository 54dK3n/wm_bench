#!/usr/bin/env python3
"""Split evidence bytes into Git-friendly chunks and restore them losslessly."""

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat
import sys
import uuid


SCHEMA = "wm-evidence-chunks"
VERSION = 1
DEFAULT_CHUNK_BYTES = 50 * 1024 * 1024
READ_BYTES = 1024 * 1024
MAX_CHUNKS = 65536
MAX_MANIFEST_BYTES = 16 * 1024 * 1024


def _parts(relative):
    """Require an unambiguous POSIX path relative to the selected repository."""
    if (not isinstance(relative, str) or not relative or "\\" in relative
            or "\0" in relative or PureWindowsPath(relative).drive):
        raise ValueError("paths must be canonical repository-relative strings")
    parts = relative.split("/")
    if PurePosixPath(relative).is_absolute() or any(p in {"", ".", ".."} for p in parts):
        raise ValueError("paths must be canonical repository-relative strings")
    return parts


@contextmanager
def _root(root):
    # The explicitly selected root is the trust boundary; every path below it
    # is opened component by component, without following symbolic links.
    fd = os.open(Path(root).resolve(), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        yield fd
    finally:
        os.close(fd)


@contextmanager
def _parent(root_fd, relative):
    parts = _parts(relative)
    fd = os.dup(root_fd)
    try:
        for component in parts[:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd, parts[-1]
    finally:
        os.close(fd)


def _stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


@contextmanager
def _reader(parent_fd, name, verify_on_exit=True):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("evidence inputs must be regular files")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            yield stream, before
        if verify_on_exit:
            _unchanged(parent_fd, name, fd, before)
    finally:
        os.close(fd)


def _unchanged(parent_fd, name, fd, before):
    after = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if _stamp(before) != _stamp(os.fstat(fd)) or _stamp(before) != _stamp(after):
        raise ValueError("input changed while it was being read")


def _new_file(parent_fd, name):
    return os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                   0o644, dir_fd=parent_fd)


def _identity(info):
    return info.st_dev, info.st_ino


def _unlink_owned(parent_fd, name, identity):
    try:
        if _identity(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)) == identity:
            os.unlink(name, dir_fd=parent_fd)
    except FileNotFoundError:
        pass


def _chunk_name(index):
    return f"chunk-{index:06d}.bin"


def _publish(parent_fd, temporary, destination, completed):
    """Link without replacing; detect pathname substitution around publication."""
    before = os.stat(temporary, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode) or _stamp(before) != _stamp(completed):
        raise ValueError("temporary file changed before publication")
    os.link(temporary, destination, src_dir_fd=parent_fd,
            dst_dir_fd=parent_fd, follow_symlinks=False)
    published = os.stat(destination, dir_fd=parent_fd, follow_symlinks=False)
    # Creating the hard link changes ctime; the remaining fields must match.
    if not stat.S_ISREG(published.st_mode) or _stamp(published)[:-1] != _stamp(completed)[:-1]:
        # A foreign inode may be a concurrently replaced destination. Preserve
        # it, just as we preserve any other file we did not create ourselves.
        _unlink_owned(parent_fd, destination, _identity(completed))
        raise ValueError("temporary file changed during publication; inspect destination")


def pack(root, source, output_dir, chunk_bytes=DEFAULT_CHUNK_BYTES):
    """Create a new package; never change the source or reuse an output directory."""
    _parts(source)
    _parts(output_dir)
    if type(chunk_bytes) is not int or not 1 <= chunk_bytes <= DEFAULT_CHUNK_BYTES:
        raise ValueError("chunk bytes must be between 1 and 50 MiB")
    with _root(root) as root_fd, _parent(root_fd, source) as (source_fd, source_name), \
            _parent(root_fd, output_dir) as (parent_fd, directory_name), \
            _reader(source_fd, source_name, verify_on_exit=False) as (source_stream, before):
        if (before.st_size + chunk_bytes - 1) // chunk_bytes > MAX_CHUNKS:
            raise ValueError("input would exceed the manifest chunk limit")
        # mkdir is an exclusive reservation: an existing directory, including
        # an empty directory or symlink, must never be replaced or reused.
        os.mkdir(directory_name, 0o755, dir_fd=parent_fd)
        package_fd = os.open(directory_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                             dir_fd=parent_fd)
        directory_identity = _identity(os.fstat(package_fd))
        owned = []
        complete = False
        try:
            chunks = []
            total = 0
            whole_digest = hashlib.sha256()
            while block := source_stream.read(min(READ_BYTES, chunk_bytes)):
                if total + len(block) > before.st_size:
                    raise ValueError("source changed while it was being packaged")
                if len(chunks) >= MAX_CHUNKS:
                    raise ValueError("input exceeds the manifest chunk limit")
                name = _chunk_name(len(chunks))
                fd = _new_file(package_fd, name)
                owned.append((name, _identity(os.fstat(fd))))
                chunk_digest = hashlib.sha256()
                chunk_total = 0
                with os.fdopen(fd, "wb") as chunk_stream:
                    while block:
                        if total + chunk_total + len(block) > before.st_size:
                            raise ValueError("source changed while it was being packaged")
                        chunk_stream.write(block)
                        whole_digest.update(block)
                        chunk_digest.update(block)
                        chunk_total += len(block)
                        if chunk_total == chunk_bytes:
                            break
                        block = source_stream.read(min(READ_BYTES, chunk_bytes - chunk_total))
                    chunk_stream.flush()
                    os.fsync(chunk_stream.fileno())
                chunks.append({"index": len(chunks), "path": name, "offset": total,
                               "bytes": chunk_total, "sha256": chunk_digest.hexdigest()})
                total += chunk_total
            if total != before.st_size:
                raise ValueError("source changed while it was being packaged")
            _unchanged(source_fd, source_name, source_stream.fileno(), before)
            manifest = {"schema": SCHEMA, "version": VERSION,
                        "original": {"path": source, "bytes": total,
                                     "sha256": whole_digest.hexdigest()},
                        "chunk_bytes": chunk_bytes, "chunks": chunks}
            encoded = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
            if len(encoded) > MAX_MANIFEST_BYTES:
                raise ValueError("manifest exceeds its size limit")
            temporary = ".manifest-" + uuid.uuid4().hex + ".tmp"
            fd = _new_file(package_fd, temporary)
            identity = _identity(os.fstat(fd))
            owned.append((temporary, identity))
            with os.fdopen(fd, "wb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
                completed = os.fstat(stream.fileno())
            os.fsync(package_fd)
            _unchanged(source_fd, source_name, source_stream.fileno(), before)
            # An atomic, non-replacing link is the package's commit marker.
            _publish(package_fd, temporary, "manifest.json", completed)
            owned.append(("manifest.json", identity))
            os.unlink(temporary, dir_fd=package_fd)
            os.fsync(package_fd)
            os.fsync(parent_fd)
            complete = True
            return {"mode": "pack", "ok": True, "manifest": output_dir + "/manifest.json",
                    "chunks": len(chunks), **manifest["original"]}
        finally:
            if not complete:
                # Only remove entries this invocation created. Never recurse
                # through a directory that another writer may have changed.
                for name, identity in reversed(owned):
                    _unlink_owned(package_fd, name, identity)
                try:
                    if _identity(os.stat(directory_name, dir_fd=parent_fd,
                                         follow_symlinks=False)) == directory_identity:
                        os.rmdir(directory_name, dir_fd=parent_fd)
                except (FileNotFoundError, OSError):
                    pass
            os.close(package_fd)


def _unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate manifest key")
        result[key] = value
    return result


def _sha(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _manifest(package_fd, name):
    with _reader(package_fd, name) as (stream, info):
        if info.st_size > MAX_MANIFEST_BYTES:
            raise ValueError("manifest exceeds its size limit")
        data = stream.read(MAX_MANIFEST_BYTES + 1)
        if len(data) > MAX_MANIFEST_BYTES:
            raise ValueError("manifest exceeds its size limit")
        payload = json.loads(data, object_pairs_hook=_unique_keys)
    if (not isinstance(payload, dict) or payload.get("schema") != SCHEMA
            or type(payload.get("version")) is not int or payload["version"] != VERSION):
        raise ValueError("unsupported manifest schema/version")
    original = payload.get("original")
    if (not isinstance(original, dict) or type(original.get("bytes")) is not int
            or original["bytes"] < 0 or not _sha(original.get("sha256"))):
        raise ValueError("invalid original file metadata")
    _parts(original.get("path"))
    chunk_bytes = payload.get("chunk_bytes")
    chunks = payload.get("chunks")
    if (type(chunk_bytes) is not int or not 1 <= chunk_bytes <= DEFAULT_CHUNK_BYTES
            or not isinstance(chunks, list) or len(chunks) > MAX_CHUNKS
            or len(chunks) != (original["bytes"] + chunk_bytes - 1) // chunk_bytes):
        raise ValueError("invalid chunk size/count")
    offset = 0
    for index, chunk in enumerate(chunks):
        if (not isinstance(chunk, dict) or type(chunk.get("index")) is not int
                or chunk["index"] != index or chunk.get("path") != _chunk_name(index)
                or type(chunk.get("offset")) is not int or chunk["offset"] != offset
                or type(chunk.get("bytes")) is not int
                or chunk["bytes"] != min(chunk_bytes, original["bytes"] - offset)
                or not _sha(chunk.get("sha256"))):
            raise ValueError("invalid chunk order, path, offset, size or SHA256")
        offset += chunk["bytes"]
    return payload


def _matches(parent_fd, name, original):
    try:
        with _reader(parent_fd, name) as (stream, info):
            digest = hashlib.sha256()
            if info.st_size != original["bytes"]:
                raise ValueError("refusing to overwrite an existing different target")
            total = 0
            while block := stream.read(min(READ_BYTES, original["bytes"] - total + 1)):
                total += len(block)
                if total > original["bytes"]:
                    raise ValueError("existing target changed while it was being read")
                digest.update(block)
            if digest.hexdigest() != original["sha256"]:
                raise ValueError("refusing to overwrite an existing different target")
        return True
    except FileNotFoundError:
        return False


def _concatenate(package_fd, manifest, output):
    whole_digest = hashlib.sha256()
    total = 0
    for chunk in manifest["chunks"]:
        digest = hashlib.sha256()
        chunk_total = 0
        with _reader(package_fd, chunk["path"]) as (stream, info):
            if info.st_size != chunk["bytes"]:
                raise ValueError(f"chunk size mismatch: {chunk['path']}")
            while block := stream.read(READ_BYTES):
                chunk_total += len(block)
                if chunk_total > chunk["bytes"]:
                    raise ValueError(f"chunk grew while reading: {chunk['path']}")
                digest.update(block)
                whole_digest.update(block)
                if output is not None:
                    output.write(block)
        if chunk_total != chunk["bytes"] or digest.hexdigest() != chunk["sha256"]:
            raise ValueError(f"chunk SHA256/size mismatch: {chunk['path']}")
        total += chunk_total
    if total != manifest["original"]["bytes"] or whole_digest.hexdigest() != manifest["original"]["sha256"]:
        raise ValueError("restored whole-file SHA256/size mismatch")


def restore(root, manifest_path, target=None):
    """Verify a package and publish its bytes without replacing another file."""
    with _root(root) as root_fd, _parent(root_fd, manifest_path) as (package_fd, manifest_name):
        manifest = _manifest(package_fd, manifest_name)
        original = manifest["original"]
        target = original["path"] if target is None else target
        with _parent(root_fd, target) as (target_fd, target_name):
            existed = _matches(target_fd, target_name, original)
            temporary = ".restore-" + uuid.uuid4().hex + ".tmp"
            identity = None
            try:
                if existed:
                    _concatenate(package_fd, manifest, None)
                    if not _matches(target_fd, target_name, original):
                        raise ValueError("existing target disappeared during validation")
                else:
                    fd = _new_file(target_fd, temporary)
                    identity = _identity(os.fstat(fd))
                    with os.fdopen(fd, "wb") as stream:
                        _concatenate(package_fd, manifest, stream)
                        stream.flush()
                        os.fsync(stream.fileno())
                        completed = os.fstat(stream.fileno())
                    try:
                        _publish(target_fd, temporary, target_name, completed)
                    except FileExistsError:
                        if not _matches(target_fd, target_name, original):
                            raise ValueError("target changed while publishing")
                        existed = True
                    os.fsync(target_fd)
            finally:
                if identity is not None:
                    _unlink_owned(target_fd, temporary, identity)
            return {"mode": "restore", "ok": True, "path": target,
                    "bytes": original["bytes"], "sha256": original["sha256"],
                    "status": "existing_exact" if existed else "restored"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1],
                        help="repository root (all other paths are relative to it)")
    commands = parser.add_subparsers(dest="command", required=True)
    pack_parser = commands.add_parser("pack", help="create a new chunk package")
    pack_parser.add_argument("source", help="repository-relative original file")
    pack_parser.add_argument("output_dir", help="new repository-relative package directory")
    pack_parser.add_argument("--chunk-bytes", type=int, default=DEFAULT_CHUNK_BYTES,
                             help="bytes per chunk, at most 52428800 (default)")
    restore_parser = commands.add_parser("restore", help="validate and restore a package")
    restore_parser.add_argument("manifest", help="repository-relative manifest.json")
    restore_parser.add_argument("--target", help="repository-relative destination; defaults to original path")
    args = parser.parse_args(argv)
    try:
        result = (pack(args.root, args.source, args.output_dir, args.chunk_bytes)
                  if args.command == "pack" else restore(args.root, args.manifest, args.target))
    except (OSError, ValueError, TypeError) as error:
        result = {"mode": args.command, "ok": False, "error": str(error)}
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
