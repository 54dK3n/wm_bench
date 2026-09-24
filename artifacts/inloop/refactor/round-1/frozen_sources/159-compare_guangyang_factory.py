#!/usr/bin/env python3
"""Compare a new opt-in factory with opt2r3's embedded old WM; no simulator.

Only extracts the embedded ZIP and instantiates library objects. The production
program and its control flow are never executed. All generated inputs are
synthetic unit-test observations in arbitrary local coordinates, not layouts.
"""
import argparse
import ast
import base64
import dataclasses
import hashlib
import importlib
import importlib.util
import io
import json
import math
from pathlib import Path
import sys
import tempfile
import zipfile
from enum import Enum

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROGRAM = REPO_ROOT / "artifacts/inloop/opt-2/round-3/program.py"
DEFAULT_SOURCE = REPO_ROOT / "vendor/wm_kit_opt2"
DEFAULT_OUTPUT = REPO_ROOT / "artifacts/worldmodel-return/guangyang-equivalence.json"
# Import candidate code without modifying its repository with bytecode caches.
sys.dont_write_bytecode = True

def display_path(path):
    path = Path(path).resolve()
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)



def norm(obj):
    if isinstance(obj, Enum):
        return obj.value
    if dataclasses.is_dataclass(obj):
        return norm(dataclasses.asdict(obj))
    if isinstance(obj, dict):
        return {str(k): norm(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [norm(v) for v in obj]
    return obj


def load_package(root, name):
    spec = importlib.util.spec_from_file_location(
        name, Path(root) / 'world_model' / '__init__.py',
        submodule_search_locations=[str(Path(root) / 'world_model')])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return {key: importlib.import_module(name + '.' + key) for key in
            ('core', 'decay', 'association', 'types', 'providers.guangyang')}


def old_instance(mods):
    return mods['core'].WorldModel(
        assoc_cfg=mods['providers.guangyang'].guangyang_static_association_config(),
        decay_cfg=mods['decay'].DecayConfig(),
        fov_cfg=mods['decay'].FovConfig(max_range_m=0.9))


def detection(name='target', x=0.0, z=0.6, confidence=0.9, **kwargs):
    return dict(class_name=name, x=x, z=z, confidence=confidence, **kwargs)


def update(now, detections, x=0.0, z=0.0, yaw=0.0, uncertainty=0.0):
    return dict(op='update', now=now, detections=detections,
                pose=dict(x=x, z=z, yaw_rad=yaw, pose_uncertainty_cm=uncertainty))


def cases():
    ds = [detection(x=x, z=z) for x, z in [(0.0, .6), (.1, .66), (-.04, .7)]]
    result = {'three_unique_equal_weight': [update(i*4.5, [d], z=-.2*i)
              for i, d in enumerate(ds)]}
    result['repeat_pose_and_exact_15cm'] = [
        update(0, [detection()]), update(4.5, [detection(x=.2)], x=.05),
        update(9, [detection(x=.1)], x=.149999999),
        update(13.5, [detection(x=.1)], x=.15),
        update(18, [detection(x=-.05)], x=.35),
        update(22.5, [detection(x=.25)], x=0)]
    result['stable_id_aliases_and_classes'] = [
        update(0, [detection('sports ball'), detection('target', x=.65),
                   detection('distractor', x=-.65)]),
        update(.5, [detection('球', x=.02), detection('target', x=.67),
                    detection('distractor', x=-.67)], z=-.2),
        update(1, [detection('tennis ball', x=.04), detection('target', x=.69),
                   detection('distractor', x=-.69)], z=-.4)]
    result['same_class_nearest_assignment'] = [
        update(0, [detection(x=0), detection(x=.65)]),
        update(50, [detection(x=.2), detection(x=.5)], z=-.2)]
    result['static_gate_at_30cm_and_beyond'] = [
        update(0, [detection()]),
        update(50, [detection(x=.3)], z=-.2),
        update(100, [detection(x=.450000001)], z=-.4)]
    for name in ('target', 'distractor', 'obstacle', 'storage-zone',
                 'cleanup-zone', 'ball', 'basket', 'table', 'bottle', 'unknown'):
        for direction, yaw in [('in_fov', 0), ('out_of_fov', math.pi)]:
            result[f'decay_{name}_{direction}'] = [
                update(0, [detection(name)]),
                update(.5, [], yaw=yaw), update(2, [], yaw=yaw),
                update(3, [], yaw=yaw), update(20, [], yaw=yaw),
                update(240, [], yaw=yaw)]
    for label, distance, angle in [
        ('min_exact', .15, 0), ('min_below', .149999999, 0),
        ('max_exact', .9, 0), ('max_beyond', .900000001, 0),
        ('half_fov_exact', .6, 37.6), ('half_fov_beyond', .6, 37.600001),
        ('half_fov_negative', .6, -37.6)]:
        result['fov_' + label] = [
            update(0, [detection(x=distance*math.sin(math.radians(angle)),
                                 z=distance*math.cos(math.radians(angle)))]),
            update(2, [])]
    result['removal_archive_reobserve_and_active_name_priority'] = [
        update(0, [detection(), detection(x=.65, confidence=.6)]),
        update(.5, [detection(), detection(x=.65, confidence=.6)], z=-.2),
        dict(op='remove', obj_id='target_001', now=1),
        dict(op='remove', obj_id='target_001', now=2),
        dict(op='remove', obj_id='target', now=2),
        dict(op='remove', obj_id='nonexistent', now=2),
        update(3, [detection()]),
        update(30, [])]
    result['natural_lost_archive_then_removal'] = [
        update(0, [detection()]), update(20, []),
        dict(op='remove', obj_id='target_001', now=21),
        update(22, [detection()])]
    result['confidence_size_source_and_evidence_fields'] = [
        update(0, [detection(confidence=.8, radius_cm=9, frame_id='a',
                            frame_quality=dict(frame_id='a'))], uncertainty=2),
        update(.5, [detection(x=.1, confidence=.95, radius_cm=22,
                              size_trusted=True, size_source='local_registry',
                              radius_semantics='outer_radius', frame_id='b',
                              frame_quality=dict(frame_id='b', calibration_trusted=True),
                              bbox=[1,2,3,4], source='guangyang')], z=-.2, uncertainty=3),
        update(3, [detection(x=.15, confidence=.7, radius_cm=99,
                             size_trusted=False, size_source='external_claim',
                             frame_id='c')], z=-.4, uncertainty=4),
        update(3, []), update(2, [])]
    return result


def run_case(mods, wm, steps):
    history = []
    known_ids = set()
    for step in steps:
        outcome = None
        association = None
        if step['op'] == 'update':
            pose = mods['types'].RobotPose(**step['pose'])
            dets = []
            for args in step['detections']:
                args = dict(args)
                if args.get('frame_quality') is not None:
                    args['frame_quality'] = mods['types'].FrameQuality(**args['frame_quality'])
                dets.append(mods['types'].Detection(**args))
            association = norm(mods['association'].associate(
                wm.get_scene(), dets, wm.aliases, wm.assoc_cfg, now=step['now']))
            wm.update(dets, pose, now=step['now'])
        else:
            outcome = wm.mark_removed(step['obj_id'], now=step['now'])
        known_ids.update(wm._objects)
        known_ids.update(wm._lost)
        queries = sorted(known_ids | {'target', 'distractor', 'ball', 'sports ball', '球', 'nonexistent'})
        history.append(dict(
            association=association, outcome=outcome,
            active=[norm(obj) for obj in wm._objects.values()],
            archived=[norm(obj) for obj in wm._lost.values()],
            scene=norm(wm.get_scene()), snapshot=norm(wm.snapshot()),
            hit_poses=norm(wm._hit_poses), pose=norm(wm.pose),
            last_update_time=wm.last_update_time,
            queries={q: norm(wm.get_object(q)) for q in queries},
            contract=norm(wm.to_contract(now=step['now']))))
    return history


def config(wm):
    return dict(association=norm(wm.assoc_cfg), decay=norm(wm.decay_cfg),
                fov=norm(wm.fov_cfg), position_smoothing=wm.position_smoothing,
                nominal_dt_s=wm.nominal_dt_s, time_origin=wm.time_origin,
                visibility_is_config=wm.visibility is wm.fov_cfg,
                aliases=norm(wm.aliases.canonical_to_aliases))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--program', type=Path, default=DEFAULT_PROGRAM,
                    help='Frozen original opt2r3 program containing the baseline ZIP')
    ap.add_argument('--source', '--candidate', dest='source', type=Path, default=DEFAULT_SOURCE,
                    help='Candidate repository root containing world_model/ (default: vendored source)')
    ap.add_argument('--factory', default='providers.guangyang.guangyang_static_world_model')
    ap.add_argument('--factory-kwargs', default='{"max_range_m": 0.9}',
                    help='JSON factory keywords (default matches the original program FOV)')
    ap.add_argument('--legacy-self-check', action='store_true',
                    help='Validate the comparator against an unchanged legacy source')
    ap.add_argument('--out', type=Path, default=DEFAULT_OUTPUT, help='Comparison JSON output')
    args = ap.parse_args()
    tree = ast.parse(args.program.read_text())
    stmt = next(n for n in tree.body if isinstance(n, ast.Assign) and
                any(isinstance(t, ast.Name) and t.id == '_WM_ZIP_BYTES' for t in n.targets))
    blob = base64.b64decode(ast.literal_eval(stmt.value.args[0]))
    with tempfile.TemporaryDirectory(prefix='gy-factory-old-') as tmp:
        zipfile.ZipFile(io.BytesIO(blob)).extractall(tmp)
        old = load_package(tmp, 'gy_old_embedded')
        new = load_package(args.source, 'gy_candidate')
        if args.legacy_self_check:
            make = lambda: old_instance(new)
        else:
            module, name = args.factory.rsplit('.', 1)
            factory = getattr(importlib.import_module('gy_candidate.' + module), name)
            make = lambda: factory(**json.loads(args.factory_kwargs))
        before, after = config(old_instance(old)), config(make())
        mismatches = []
        if before != after:
            mismatches.append(dict(case='instance_configuration', expected=before, actual=after))
        results = []
        for label, steps in cases().items():
            a, b = run_case(old, old_instance(old), steps), run_case(new, make(), steps)
            indices = [i for i, (left, right) in enumerate(zip(a, b)) if left != right]
            results.append(dict(case=label, steps=len(steps), exact_equal=not indices))
            if indices:
                i = indices[0]
                mismatches.append(dict(case=label, first_step=i,
                                       differing_fields=[k for k in a[i] if a[i][k] != b[i][k]],
                                       expected=a[i], actual=b[i]))
        source_files = {str(p.relative_to(args.source)): hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in sorted((args.source / 'world_model').rglob('*.py'))}
        result = dict(all_pass=not mismatches, source=display_path(args.program),
                      program_sha256=hashlib.sha256(args.program.read_bytes()).hexdigest(),
                      old_embedded_sha256=hashlib.sha256(blob).hexdigest(),
                      candidate=display_path(args.source), candidate_source_sha256=source_files,
                      factory=args.factory, legacy_self_check=args.legacy_self_check,
                      factory_kwargs=json.loads(args.factory_kwargs),
                      scenario_count=len(results), step_count=sum(r['steps'] for r in results),
                      scenarios=results, mismatches=mismatches,
                      limitations=['Synthetic unit-level input only; no controller/simulator execution.',
                                   'Exact state equality covers listed sequences, not all possible inputs.',
                                   'Does not migrate or execute the production caller (C).'])
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False)+'\n')
        print(json.dumps({k:v for k,v in result.items() if k not in ('mismatches','scenarios','candidate_source_sha256')}, indent=2))
        print('mismatch_cases:', [m['case'] for m in mismatches])
        return 0 if result['all_pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
