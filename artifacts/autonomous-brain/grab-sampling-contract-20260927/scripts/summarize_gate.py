#!/usr/bin/env python3
"""Recompute local gate counts and selected source fingerprints; no live calls."""
import argparse
import ast
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    repo, evidence = args.repo.resolve(), args.evidence.resolve()
    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    tree = ET.parse(evidence / 'raw/gate/python-final.xml')
    counts = {key: sum(int(s.get(key, 0)) for s in tree.getroot().iter('testsuite'))
              for key in ('tests', 'failures', 'errors', 'skipped')}
    assert counts['tests'] and not any(counts[k] for k in ('failures', 'errors', 'skipped'))
    node = {}
    for name, file in [('driver', 'node-driver.txt'), ('platform', 'node-platform-localhost.txt')]:
        content = (evidence / 'raw/gate' / file).read_text()
        values = {key: int(re.search(r'\b' + key + r' (\d+)\s*$', content, re.M).group(1))
                  for key in ('tests', 'pass', 'fail', 'skipped')}
        assert values['tests'] == values['pass'] and values['fail'] == values['skipped'] == 0
        node[name] = values
    replay = json.loads((evidence / 'raw/gate/historical-v19-replay/replay-checks.json').read_text())
    assert replay['allPass']
    sampling = json.loads((evidence / 'raw/gate/sampling-frozen-candidate.json').read_text())
    grasp = json.loads((evidence / 'raw/gate/grab-frozen-candidate.json').read_text())
    assert sampling['checks_satisfied'] and sampling['sources_unchanged']
    assert grasp['sources_unchanged_during_export'] and all(not c['audit']['failures'] for c in grasp['examples'])
    for exported in (sampling['source_before'], grasp['source_sha256']):
        for name, digest in exported.items():
            assert sha(repo / name) == digest, name
    old = json.loads((repo / 'artifacts/autonomous-brain/executable-recovery-20260927/FROZEN_INPUTS.json').read_text())['source_manifest']
    for name, digest in old['platformRuntimeSources'].items():
        assert sha(repo / 'workspaces/guangyang-platform/projects/car-python' / name) == digest
    for name, digest in old['worldModel']['files'].items():
        assert sha(repo / 'vendor/wm_kit_opt2' / name) == digest
    sources = sorted((repo / 'autonomous_brain').glob('*.py')) + [repo / name for name in (
        'tools/brain_evidence_audit.py', 'tools/evaluate_autonomous_brain.py',
        'tools/autonomous_brain_driver.js', 'tools/brain_model_preflight.py', 'tools/brain_model_preflight.js')]
    selected = {str(p.relative_to(repo)): {'sha256': sha(p),
        **({'ast_sha256': hashlib.sha256(ast.dump(ast.parse(p.read_bytes()), include_attributes=False).encode()).hexdigest()}
           if p.suffix == '.py' else {})} for p in sources}
    result = {'schema': 'grab-sampling-local-gate/v1', 'repo_argument': str(repo),
        'reviewed_baseline': '10e3c879d2499d6f893151f24857c315f12fe2e7',
        'scope': 'function_and_synthetic_sensor_regression_not_formal_acceptance',
        'python': counts, 'python_by_classname': dict(sorted(Counter(t.get('classname') for t in tree.getroot().iter('testcase')).items())),
        'node': node, 'selected_sources': selected,
        'unchanged_platform_runtime_files': len(old['platformRuntimeSources']),
        'unchanged_wm_package_files': len(old['worldModel']['files']),
        'historical_replay': {k: replay[k] for k in ('scope', 'allPass', 'replayed_rounds', 'replayed_calls', 'network_calls')},
        'synthetic_components': {'sampling_cases': len(sampling['cases']), 'sampling_checks_satisfied': True,
                                 'grab_cases': grasp['example_count'], 'all_grab_audit_checks_satisfied': True},
        'evidence_sha256': {str(p.relative_to(evidence)): sha(p) for p in sorted((evidence / 'raw/gate').rglob('*')) if p.is_file()}}
    with args.output.open('x') as f:
        json.dump(result, f, ensure_ascii=False, indent=2); f.write('\n')
    print(json.dumps({'python': counts, 'node': node, 'historical_replay_pass': True}))


if __name__ == '__main__':
    main()
