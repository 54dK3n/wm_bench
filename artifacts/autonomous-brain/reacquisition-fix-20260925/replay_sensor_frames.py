#!/usr/bin/env python3
"""Recheck Run13 sensor frames only; no layout, native events, or truth reads."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT), str(ROOT / 'vendor/wm_kit_opt2')]
from autonomous_brain.perception import Perception, VERSION


def main():
    brain = ROOT / 'artifacts/autonomous-brain/map05-run-13/map-05-run-1/brain'
    paths = [brain / 'bridge-calls.jsonl', brain / 'observations.jsonl']
    camera = None
    for line in paths[0].read_text().splitlines():
        row = json.loads(line)
        if row['request']['method'] == 'camera_parameters':
            camera = row['terminal']['result']
            break
    if camera is None:
        raise ValueError('Missing public camera parameters')
    model, comparisons = Perception(camera), []
    for line in paths[1].read_text().splitlines():
        row = json.loads(line)
        actual = model.update(row['observation'], row['odometry'],
            simulation_time_s=row['simulation_seconds'], round_index=row['round'])
        original = row['perception']
        # The intentional adapter version bump is the only permitted change.
        same_evidence = ({k: v for k, v in actual.items() if k != 'version'} ==
                         {k: v for k, v in original.items() if k != 'version'})
        comparisons.append({'observation_index': row['observation_index'],
                            'perception_evidence_identical_except_version': same_evidence,
                            'objects_identical': model.objects() == row['objects']})
    checks = {
        'version': 'reacquisition-run13-sensor-replay/v1',
        'perception_version': VERSION,
        'input_files': [{'path': str(p.relative_to(ROOT)),
                         'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths],
        'candidate_perception_sha256': hashlib.sha256(
            (ROOT / 'autonomous_brain/perception.py').read_bytes()).hexdigest(),
        'observations': len(comparisons), 'frames': comparisons,
        'reacquisition_bindings': model.reacquisition_bindings(),
        'truth_or_layout_inputs': [], 'network_calls': 0,
        'success': (bool(comparisons) and not model.reacquisition_bindings()
                    and all(x['perception_evidence_identical_except_version']
                            and x['objects_identical'] for x in comparisons)),
        'scope': 'Recorded sensor stream only. No controller, simulator, action replay, '
                 'cross-time physical identity proof, or task success claim.',
    }
    out = Path(__file__).with_name('run13-sensor-replay.json')
    with out.open('x') as handle:
        json.dump(checks, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write('\n')
    print(json.dumps({k: checks[k] for k in ('observations', 'reacquisition_bindings', 'success')}))
    return 0 if checks['success'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
