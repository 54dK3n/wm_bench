"""Read-only public observation replay; preserve recorded simulation timestamps.

No evaluator inputs, map coordinates, or physical IDs are read. This is not a
competition. Baseline mode loads the preserved Perception source explicitly.
"""
import argparse
import dataclasses
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'vendor/wm_kit_opt2'), str(ROOT)]
from autonomous_brain.perception import Perception
from world_model.association import associate, build_cost_matrix
from world_model.providers.guangyang import odometry_to_pose


def snapshot(wm):
    return {t.obj_id: dataclasses.asdict(t) for t in wm.get_scene()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--brain', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--baseline', type=Path)
    ap.add_argument('--max-frame', type=int)
    args = ap.parse_args()
    cls = Perception
    if args.baseline:
        spec = importlib.util.spec_from_file_location('autonomous_brain.visibility_baseline', args.baseline)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cls = module.Perception
    calls = args.brain / 'bridge-calls.jsonl'
    with calls.open() as handle:
        camera = next(r['terminal']['result'] for line in handle
                      if (r := json.loads(line))['request']['method'] == 'camera_parameters')
    p = cls(camera)
    source = args.brain / 'observations.jsonl'
    original_update = p.wm.update
    context = {}

    def traced_update(detections, pose, now):
        context['before_wm_update'] = snapshot(p.wm)
        original_update(detections, pose, now=now)
        context['after_wm_update'] = snapshot(p.wm)
        before, after = context['before_wm_update'], context['after_wm_update']
        context['archived'] = {oid: dataclasses.asdict(p.wm.get_archived(oid))
                               for oid in before.keys() - after.keys()}
        context['created'] = sorted(after.keys() - before.keys())
    p.wm.update = traced_update
    count = 0
    with source.open() as handle, args.out.open('x') as output:
        for line in handle:
            r = json.loads(line)
            # These requested runs contain no manipulation. Reject a replay
            # that would silently omit action-driven lifecycle mutations.
            if r['holding']['holding']:
                raise ValueError('Held lifecycle requires action replay')
            obs, odo, now = r['observation'], r['odometry'], r['simulation_seconds']
            if args.max_frame and int(obs['frameId']) > args.max_frame:
                break
            tracks = p.wm.get_scene()
            context.clear()
            context.update(frame=obs['frameId'], observation_index=r['observation_index'],
                           simulation_time_s=now, original_observation=obs, odometry=odo,
                           before_perception=snapshot(p.wm))
            p.pose = odometry_to_pose(odo)
            converted = [p._convert(d, str(obs['frameId']), now) for d in obs['detections']]
            fed = [d for d, e in converted if d is not None and e['fed_to_world_model']]
            assignment = associate(tracks, fed, p.wm.aliases, p.wm.assoc_cfg, now=now)
            context['fed_matches'] = [tracks[i].obj_id for i, _ in assignment.matches]
            near = [(d, e) for d, e in converted if d is not None and not e['fed_to_world_model']
                    and e.get('raw_distance_cm', math.inf) < 40
                    and abs(e.get('raw_bearing_deg', math.inf)) <= 35]
            costs = build_cost_matrix(tracks, [d for d, _ in near], p.wm.aliases, p.wm.assoc_cfg, now=now)
            edges = [[i for i, cost in enumerate(row) if math.isfinite(cost)] for row in costs]
            context['near_candidates'] = [dict(e, candidate_ids=[tracks[j].obj_id for j in range(len(tracks)) if i in edges[j]])
                                          for i, (_, e) in enumerate(near)]
            context['bidirectionally_unique'] = [tracks[j].obj_id for j, indices in enumerate(edges)
                if len(indices) == 1 and sum(indices[0] in row for row in edges) == 1]
            result = p.update(obs, odo, simulation_time_s=now, round_index=r['round'],
                              observation_index=r['observation_index'])
            context['detections'] = result['detections']
            context['original_detections'] = r['perception']['detections']
            output.write(json.dumps(context, ensure_ascii=False, allow_nan=False) + '\n')
            count += 1
    print(json.dumps({'frames': count, 'out': str(args.out), 'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest()}))


if __name__ == '__main__':
    main()
