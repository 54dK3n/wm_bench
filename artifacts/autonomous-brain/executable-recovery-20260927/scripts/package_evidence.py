#!/usr/bin/env python3
"""Create-only final evidence manifest/package, after the formal run has ended.

No upload, model, simulator or environment-secret reads. The separate scanner
and explicit human classification must both cover the exact manifest first.
Run from the repository root; --repo may select an equivalent restored checkout.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile


ROUND = 'artifacts/autonomous-brain/executable-recovery-20260927'
SOURCE_COMMIT = 'a847a3c538c2787864633753b74dd906098ff6fd'
RELEASE_TAG = 'executable-recovery-20260927-a847a3c'
ARCHIVE = 'wm-bench-executable-recovery-20260927-evidence.tar.gz'
METADATA = ('SHA256SUMS', 'SECRET_SCAN_RAW.json', 'SECRET_SCAN.json')
EXCLUDED_ROOT_FILES = {*METADATA, 'DELIVERY.json', ARCHIVE + '.sha256'}


def safe_name(name):
    p = PurePosixPath(name)
    if (not name or not p.parts or p.is_absolute() or '..' in p.parts or p.as_posix() != name
            or any(c in name for c in ('\\', '\n', '\r', '\0'))):
        raise ValueError('Unsafe relative member name')
    return p


def local(repo, name):
    path = repo.joinpath(*safe_name(name).parts)
    cursor = repo
    for part in safe_name(name).parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError('Symbolic link refused: ' + name)
    if not path.resolve().is_relative_to(repo):
        raise ValueError('Path escapes repository: ' + name)
    return path


def hash_stream(stream):
    result = hashlib.sha256()
    size = 0
    while chunk := stream.read(1024 * 1024):
        result.update(chunk)
        size += len(chunk)
    return result.hexdigest(), size


def hash_file(path):
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError('Only ordinary files are allowed: ' + str(path))
    with path.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError('File replaced while opening: ' + str(path))
        digest, size = hash_stream(stream)
    after = path.lstat()
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_mode')
    if size != before.st_size or any(getattr(before, k) != getattr(after, k) for k in fields):
        raise ValueError('File changed while hashing: ' + str(path))
    return {'sha256': digest, 'bytes': size}


def excluded(relative):
    parts = PurePosixPath(relative).parts
    return (parts[:2] == ('raw', 'delivery')
            or len(parts) == 1 and (relative in EXCLUDED_ROOT_FILES or relative.startswith('PUBLICATION')))


def inventory(repo):
    root = local(repo, ROUND)
    found = []
    for directory, directories, filenames in os.walk(root, followlinks=False):
        for name in list(directories):
            p = Path(directory) / name
            if p.is_symlink():
                raise ValueError('Directory symlink refused: ' + str(p.relative_to(repo)))
            if excluded(p.relative_to(root).as_posix()):
                directories.remove(name)
        for name in filenames:
            p = Path(directory) / name
            if excluded(p.relative_to(root).as_posix()):
                continue
            relative = p.relative_to(repo).as_posix()
            p = local(repo, relative)
            if not stat.S_ISREG(p.lstat().st_mode):
                raise ValueError('Non-regular payload refused: ' + relative)
            safe_name(relative)
            found.append(relative)
    if not found or len(found) != len(set(found)):
        raise ValueError('Empty or duplicate payload inventory')
    return sorted(found)


def new_file(path, data):
    with path.open('xb') as stream:
        stream.write(data)


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode()


def unique_json(path):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate JSON key')
            result[key] = value
        return result
    return json.loads(path.read_bytes(), object_pairs_hook=pairs)


def manifest(repo):
    target = local(repo, ROUND + '/SHA256SUMS')
    if target.exists():
        raise ValueError('Manifest exists; originals are never overwritten')
    names = inventory(repo)
    rows = {name: hash_file(local(repo, name)) for name in names}
    if inventory(repo) != names:
        raise ValueError('Payload inventory changed during manifest generation')
    content = ''.join(rows[name]['sha256'] + '  ' + name + '\n' for name in names).encode()
    new_file(target, content)
    return {'mode': 'manifest', 'manifest': ROUND + '/SHA256SUMS',
            'manifest_sha256': hashlib.sha256(content).hexdigest(), 'payload_files': len(rows),
            'payload_bytes': sum(r['bytes'] for r in rows.values()),
            'next': 'Run scripts/scan_release_payload.py and independently classify every finding in SECRET_SCAN.json before pack.'}


def load_manifest(repo):
    rows = {}
    for line in local(repo, ROUND + '/SHA256SUMS').read_text().splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  (.+)', line)
        if not match:
            raise ValueError('Malformed SHA256SUMS line')
        digest, name = match.groups()
        safe_name(name)
        if not name.startswith(ROUND + '/') or excluded(name[len(ROUND) + 1:]) or name in rows:
            raise ValueError('Manifest has duplicate, excluded or out-of-round member')
        measured = hash_file(local(repo, name))
        if measured['sha256'] != digest:
            raise ValueError('Original manifest bytes changed: ' + name)
        rows[name] = measured
    if sorted(rows) != inventory(repo):
        raise ValueError('Current full payload inventory differs from the frozen manifest')
    return rows


def verify_scan(repo, rows):
    manifest_hash = hash_file(local(repo, ROUND + '/SHA256SUMS'))['sha256']
    raw_path = local(repo, ROUND + '/SECRET_SCAN_RAW.json')
    review_path = local(repo, ROUND + '/SECRET_SCAN.json')
    raw = unique_json(raw_path)
    review = unique_json(review_path)
    if (raw.get('manifest_sha256') != manifest_hash
            or review.get('manifest_sha256') != manifest_hash
            or review.get('raw_scan_sha256') != hash_file(raw_path)['sha256']):
        raise ValueError('Scan/classification is not bound to this exact manifest and raw report')
    if (review.get('status') not in {'PASS', 'PASS_AFTER_EXPLICIT_CLASSIFICATION'}
            or review.get('unresolved_sensitive_findings') != 0
            or review.get('actual_local_sensitive_value_matches') != 0
            or review.get('original_evidence_modified') is not False
            or raw.get('read_only_original_evidence') is not True
            or raw.get('all_original_sha256_match') is not True
            or review.get('all_original_sha256_match') is not True
            or not review.get('review_basis')):
        raise ValueError('Complete independent sensitive-content classification has not passed')
    scanned = raw.get('files', [])
    if (len(scanned) != len(rows) or raw.get('source_file_count') != len(rows)
            or raw.get('source_bytes') != sum(r['bytes'] for r in rows.values())
            or len({r['file'] for r in scanned}) != len(scanned)):
        raise ValueError('Scanner payload coverage differs')
    for entry in scanned:
        expected = rows.get(entry['file'])
        if (expected is None or entry.get('sha256') != expected['sha256']
                or entry.get('bytes') != expected['bytes'] or entry.get('matches_original_manifest') is not True):
            raise ValueError('Scanner did not verify the exact payload bytes')
    def key(row):
        return row.get('file'), row.get('rule'), row.get('line'), row.get('field')
    findings = raw.get('findings', [])
    reviewed = review.get('reviewed_findings', [])
    if Counter(map(key, findings)) != Counter(map(key, reviewed)):
        raise ValueError('Every raw finding must have exactly one explicit classification')
    expanded = raw.get('expanded_scan_units', [])
    units = {r['file']: r['sha256'] for r in expanded}
    if (not expanded or len(units) != len(expanded)
            or raw.get('expanded_scan_unit_count') != len(expanded)
            or raw.get('expanded_bytes_scanned') != sum(r['bytes'] for r in expanded)):
        raise ValueError('Expanded scanner coverage is missing or inconsistent')
    for entry in reviewed:
        if (entry.get('rule') == 'local_sensitive_environment_value'
                or entry.get('review_disposition') != 'non_sensitive_verified'
                or not entry.get('review_reason')
                or entry.get('file') not in units
                or entry.get('reviewed_unit_sha256') != units.get(entry.get('file'))):
            raise ValueError('A finding is unresolved, sensitive, or not bound to its scanned unit')
    return {'manifest_sha256': manifest_hash, 'raw_scan_sha256': hash_file(raw_path)['sha256'],
            'secret_scan_sha256': hash_file(review_path)['sha256']}


def pack(repo):
    root = local(repo, ROUND)
    destination = local(repo, ROUND + '/raw/delivery')
    output = destination / ARCHIVE
    checksum = root / (ARCHIVE + '.sha256')
    delivery_path = root / 'DELIVERY.json'
    if any(p.exists() or p.is_symlink() for p in (output, checksum, delivery_path)):
        raise ValueError('Delivery output exists; pack never overwrites an earlier attempt')
    if unique_json(local(repo, ROUND + '/FROZEN_INPUTS.json')).get('source_commit') != SOURCE_COMMIT:
        raise ValueError('Frozen source metadata is not the selected release revision')
    rows = load_manifest(repo)
    scan = verify_scan(repo, rows)
    members = dict(rows)
    for name in METADATA:
        member = ROUND + '/' + name
        members[member] = hash_file(local(repo, member))
    # USTAR contains only ordinary members; reject unsupported long names
    # instead of silently creating long-link or extended-header members.
    infos = {}
    for name, metadata in members.items():
        info = tarfile.TarInfo(safe_name(name).as_posix())
        info.type = tarfile.REGTYPE
        info.size, info.mode, info.mtime = metadata['bytes'], 0o644, 0
        info.uid = info.gid = 0
        info.uname = info.gname = ''
        info.tobuf(tarfile.USTAR_FORMAT)
        infos[name] = info
    destination.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for name in sorted(members):
                    with local(repo, name).open('rb') as stream:
                        archive.addfile(infos[name], stream)
    verified = set()
    with tarfile.open(output, 'r:gz') as archive:
        for member in archive:
            name = safe_name(member.name).as_posix()
            if not member.isreg() or member.linkname or name in verified or name not in members:
                raise ValueError('Archive has a non-regular, duplicate or unexpected member')
            digest, size = hash_stream(archive.extractfile(member))
            if {'sha256': digest, 'bytes': size} != members[name]:
                raise ValueError('Archived bytes differ from the original: ' + name)
            verified.add(name)
    if verified != set(members) or load_manifest(repo) != rows:
        raise ValueError('Payload changed during packaging or archive coverage differs')
    if verify_scan(repo, rows) != scan:
        raise ValueError('Scan metadata changed during packaging')
    for name in METADATA:
        member = ROUND + '/' + name
        if hash_file(local(repo, member)) != members[member]:
            raise ValueError('Packaged metadata changed: ' + name)
    container = hash_file(output)
    new_file(checksum, (container['sha256'] + '  ' + ARCHIVE + '\n').encode())
    delivery = {'schema': 'executable-recovery-evidence-delivery/v1',
        'created_at_utc': datetime.now(timezone.utc).isoformat(), 'source_commit': SOURCE_COMMIT,
        'release_url': 'https://github.com/54dK3n/wm_bench/releases/tag/' + RELEASE_TAG,
        'archive': ARCHIVE, 'archive_bytes': container['bytes'], 'archive_sha256': container['sha256'],
        'original_payload_files': len(rows), 'original_payload_bytes': sum(r['bytes'] for r in rows.values()),
        'metadata_members': [ROUND + '/' + name for name in METADATA],
        'archive_regular_members': len(members), 'archive_uncompressed_member_bytes': sum(r['bytes'] for r in members.values()),
        'safe_relative_unique_regular_members': True, 'every_member_sha256_matches_original': True,
        'original_payload_unchanged_after_packaging': True, 'sha256sums_sha256': scan['manifest_sha256'],
        'secret_scan_raw_sha256': scan['raw_scan_sha256'], 'secret_scan_sha256': scan['secret_scan_sha256'],
        'restore_instructions': 'RESTORE.md', 'raw_logs_committed_to_git': False,
        'container_checksum_and_delivery_metadata_uploaded_as_separate_assets': True,
        'excluded_generated_paths': ['raw/delivery/**', 'DELIVERY.json', ARCHIVE + '.sha256', 'PUBLICATION*'],
        'publication_verification': 'Added after anonymous full download as a separate asset; never self-included.',
        'upload_performed_by_this_script': False}
    new_file(delivery_path, json_bytes(delivery))
    return delivery


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('manifest', 'pack'))
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    args = parser.parse_args()
    result = (manifest if args.mode == 'manifest' else pack)(args.repo.resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
