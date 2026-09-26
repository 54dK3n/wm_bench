"""Anonymous read-back of this exact release; never prints redirect URLs."""
import datetime
import hashlib
import json
import urllib.request
from pathlib import Path

R = Path('artifacts/autonomous-brain/active-confirmation-20260926')
TAG = 'active-confirmation-20260926-dec5b07'
HEADERS = {'User-Agent': 'wm-bench-evidence-verification'}
API = 'https://api.github.com/repos/54dK3n/wm_bench/releases/tags/' + TAG
out = R / 'raw/delivery/public-release-download-verification.json'
if out.exists():
    raise SystemExit('Refusing to replace existing verification')
with urllib.request.urlopen(urllib.request.Request(API, headers=HEADERS), timeout=60) as response:
    release = json.load(response)
assert release['tag_name'] == TAG and not release['draft'] and release['prerelease']
archive = 'wm-bench-active-confirmation-20260926-evidence.tar.gz'
local = {name: R / name for name in [archive + '.sha256', 'RESTORE.md', 'REPORT.md',
    'METRICS.json', 'SHA256SUMS', 'SECRET_SCAN.json', 'DELIVERY.json', 'REVIEW.md']}
local[archive] = R / 'raw/delivery' / archive
assets = {a['name']: a for a in release['assets']}
assert set(local) == set(assets), 'Published asset inventory differs'
checks = []
for name, path in local.items():
    asset = assets[name]
    url = asset['browser_download_url']
    assert url == 'https://github.com/54dK3n/wm_bench/releases/download/' + TAG + '/' + name
    checksum = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=60) as response:
        status = response.status
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            size += len(block)
            checksum.update(block)
    expected = hashlib.sha256(path.read_bytes()).hexdigest()
    assert checksum.hexdigest() == expected and size == path.stat().st_size == asset['size'], name
    if asset.get('digest'):
        assert asset['digest'] == 'sha256:' + expected
    row = {'name': name, 'url': url, 'asset_id': asset['id'], 'http_status': status,
        'bytes': size, 'sha256': expected, 'matches_local_original': True,
        'github_digest': asset.get('digest')}
    checks.append(row)
    print(json.dumps({'verified': name, 'bytes': size, 'sha256': expected}), flush=True)
result = {'verified_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'authentication': 'none; anonymous public API and complete asset download',
    'release_url': release['html_url'], 'release_id': release['id'], 'tag': TAG,
    'draft': release['draft'], 'prerelease': release['prerelease'],
    'published_at': release['published_at'], 'all_assets_downloaded_and_verified': True,
    'assets': checks}
with out.open('x') as stream:
    json.dump(result, stream, ensure_ascii=False, indent=2)
    stream.write('\n')
