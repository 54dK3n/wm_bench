#!/usr/bin/env python3
"""Summarize completed offline/local gates; never runs a model or simulator."""
import collections
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

R = Path('artifacts/autonomous-brain/executable-recovery-20260927')
def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p):
    return json.loads((R / p).read_text())
def write(name, value):
    with (R / name).open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')

xml = ET.parse(R / 'raw/gate/python-final.xml')
suites = list(xml.getroot().iter('testsuite'))
counts = {key: sum(int(s.get(key, 0)) for s in suites)
          for key in ('tests', 'failures', 'errors', 'skipped')}
assert counts['tests'] > 0 and not any(counts[k] for k in ('failures', 'errors', 'skipped'))
by_file = collections.Counter(t.get('classname') for t in xml.getroot().iter('testcase'))
node = {}
for name, log, expected in [('driver', 'raw/gate/node-driver.txt', 29),
                             ('platform', 'raw/gate/node-platform-localhost.txt', 15)]:
    content = (R / log).read_text()
    assert f'pass {expected}\n' in content and 'fail 0\n' in content and 'skipped 0\n' in content
    node[name] = dict(passed=expected, failed=0, skipped=0, log=log)
component = read('raw/gate/component-frozen-candidate.json')
view = read('raw/gate/viewpoint-frozen-candidate.json')
prior = read('raw/gate/prior-scenarios-frozen-candidate.json')
assert component['diagnostic_checks_satisfied'] and all(component['checks'].values())
assert view['checks_satisfied'] and view['sources_unchanged_during_export']
assert prior['diagnostic_checks_satisfied']
native = read('raw/platform-local-final/platform-diagnostic.json')
local = read('raw/platform-local-final/local-controller-diagnostic.json')
assert local['passed'] and local['within_budget'] and native['sources_unchanged']
assert native['child_exit_code'] == 0 and native['whitelist_violations'] == 0
for name, expected in native['source_sha256'].items():
    assert sha(Path(name)) == expected, name
brain = {str(p): sha(p) for p in sorted(Path('autonomous_brain').glob('*.py'))}
old = json.loads(Path('artifacts/autonomous-brain/active-confirmation-20260926/FROZEN_INPUTS.json').read_text())['source_manifest']
platform = Path('workspaces/guangyang-platform/projects/car-python')
for name, expected in old['platformRuntimeSources'].items():
    assert sha(platform / name) == expected, name
for name, expected in old['worldModel']['files'].items():
    assert sha(Path('vendor/wm_kit_opt2') / name) == expected, name
logs = ['raw/gate/python-final.xml', 'raw/gate/python-final.txt',
        'raw/gate/node-driver.txt', 'raw/gate/node-platform-localhost.txt',
        'raw/gate/component-frozen-candidate.json', 'raw/gate/viewpoint-frozen-candidate.json',
        'raw/gate/prior-scenarios-frozen-candidate.json',
        'raw/platform-local-final/platform-diagnostic.json',
        'raw/platform-local-final/local-controller-diagnostic.json',
        'raw/recovery/historical-v18-replay/replay-checks.json']
gate = dict(schema='executable-recovery-gate/v1',
    reviewed_baseline='d68bddc2aa6ddca734add829f23127ee9e05fe50',
    classification='offline_and_bounded_native_local_not_formal_acceptance',
    python=counts, node=node, tested_brain_source_sha256=brain,
    unchanged_platform_runtime_files=len(old['platformRuntimeSources']),
    unchanged_world_model_package_files=len(old['worldModel']['files']),
    component_checks=component['checks'], viewpoint_cases=len(view['cases']),
    native_local=dict(passed=local['passed'], primitive_count=local['primitive_count'],
        simulation_seconds=local['simulation_seconds'], cases=[c['name'] for c in local['cases']],
        native_sampling_visibility={k: local['native_sampling_visibility'].get(k)
            for k in ('candidate_count','attempts','confirmation_success','refusal_reason')},
        limitation='Local inverse primitive only; not full task acceptance or native sampling confirmation.'),
    evidence_sha256={name:sha(R / name) for name in logs})
write('GATE.json', gate)
write('TESTS.json', dict(counts=counts, by_classname=dict(sorted(by_file.items()))))
print(json.dumps({'python':counts, 'node':node, 'native':gate['native_local']},ensure_ascii=False))
