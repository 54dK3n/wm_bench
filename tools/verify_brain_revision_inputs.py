#!/usr/bin/env python3
"""Verify immutable historical evidence and dependencies without starting a run."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
HISTORY = Path('artifacts/autonomous-brain/stage1-review-20260926')


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def compare(root, entries):
    return {'entries': len(entries), 'mismatches': [name for name, expected in entries.items()
        if not (root / name).is_file() or sha(root / name) != expected]}


def verify(restore):
    entries = {}
    for line in (ROOT / HISTORY / 'SHA256SUMS').read_text().splitlines():
        expected, name = line.split('  ', 1)
        if name in entries or Path(name).is_absolute() or '..' in Path(name).parts:
            raise ValueError('Invalid or duplicate historical manifest path')
        entries[name] = expected
    proof = json.loads((ROOT / HISTORY / 'SOURCE_PROVENANCE.json').read_text())
    platform_root = ROOT / proof['platform_root']
    platform = compare(platform_root, proof['platform_files'])
    platform['revision'] = subprocess.check_output(
        ['git', '-C', str(platform_root), 'rev-parse', 'HEAD'], text=True).strip()
    platform['expected_revision'] = proof['platform_commit']
    vendor = subprocess.run(['python3', str(ROOT / 'tools/verify_worldmodel_vendor.py')],
        cwd=ROOT, capture_output=True, text=True)
    vendor_result = json.loads(vendor.stdout)
    result = {'original': compare(ROOT, entries), 'isolated_restore': compare(restore, entries),
        'platform': platform, 'world_model': vendor_result}
    result['pass'] = (not result['original']['mismatches']
        and not result['isolated_restore']['mismatches'] and not platform['mismatches']
        and platform['revision'] == platform['expected_revision']
        and vendor.returncode == 0 and vendor_result.get('all_pass') is True)
    sources = sorted(set(ROOT.glob('autonomous_brain/**/*.py'))
        | set(ROOT.glob('tests/*brain*.py'))
        | set(ROOT.glob('tools/*brain*.py'))
        | set(ROOT.glob('tools/*brain*.js'))
        | set(ROOT.glob('tools/tests/test_autonomous_brain_*.js'))
        | {Path(__file__), ROOT / 'tools/diagnose_road_reposition.py',
           ROOT / 'tools/audit_delivered_identity_prefix.py', ROOT / 'tools/probe_task_scope_geometry.py'})
    result['source_sha256'] = {str(p.relative_to(ROOT)): sha(p) for p in sources if p.is_file()}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restore', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        parser.error('--out must be a new file')
    result = verify(args.restore.resolve())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k not in {'source_sha256', 'world_model'}}))
    return 0 if result['pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
