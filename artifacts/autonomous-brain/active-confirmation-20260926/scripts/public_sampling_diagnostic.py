"""Only public brain logs; no evaluation, record, capture, map, or truth input."""
from pathlib import Path
from collections import Counter,defaultdict
import argparse,json,hashlib,math
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--brain-dir',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
BASE,OUT=args.brain_dir,args.output
if OUT.exists():parser.error('Output already exists; choose a new path')
paths={name:BASE/name for name in ['summary.json','rounds.jsonl','observations.jsonl']}
summary=json.loads(paths['summary.json'].read_text())
rounds=[json.loads(line) for line in paths['rounds.jsonl'].open()]
observations=[json.loads(line) for line in paths['observations.jsonl'].open()]
# The last successful observed place determines the later public window.
places=[r for r in rounds if r['action']['action']=='place' and r['result'].get('success') is True]
cutoff=max(r['round'] for r in places)
late=[r for r in rounds if r['round']>cutoff]
first_seen={}
for o in observations:
 for obj in o['objects']:
  if obj.get('category')=='red-ball' and obj['id'] not in first_seen:
   first_seen[obj['id']]={'observation_index':o['observation_index'],'round':o['round']}
ids={oid for oid,first in first_seen.items() if first['round']>cutoff}
fed=defaultdict(list)
for o in observations:
 if o['round']<=cutoff:continue
 for j,d in enumerate(o['perception']['detections']):
  if d.get('category')=='red-ball' and d.get('fed_to_world_model') is True:
   raw=o['observation']['detections'][j]
   assert raw['bbox']==d['bbox'] and raw['category']==d['category']
   row={'observation_index':o['observation_index'],'frame_id':str(o['observation']['frameId']),'tick':o['observation']['tick'],
        'round':o['round'],'detection_index':j,'track_id':d['track_id'],'discovery_id':d.get('discovery_id'),
        'x_m':o['odometry']['rightCm']/100,'z_m':o['odometry']['forwardCm']/100,'heading_deg':o['odometry']['headingDeg']}
   fed[d['track_id']].append(row)
timeline={row['object_id']:row for row in summary['timeline']}
objects={row['id']:row for row in summary['final_objects']}
rows=[]
for oid in sorted(ids):
 samples=fed[oid];selected=[]
 for x in samples:
  if not selected or all(math.hypot(x['x_m']-a['x_m'],x['z_m']-a['z_m'])>=.15 for a in selected):selected.append(x)
 claimed=timeline[oid]['accepted_hit_poses']
 rows.append({'object_id':oid,'first_seen':first_seen[oid],'fed_detection_count':len(samples),
    'public_max_pairwise_translation_m':max((math.hypot(a['x_m']-b['x_m'],a['z_m']-b['z_m']) for a in samples for b in samples),default=0),
    'independent_poses_including_seed':len(selected),'additional_independent_poses_after_seed':max(0,len(selected)-1),
    'final_hit_count':objects[oid]['hit_count'],'accepted_hit_poses':claimed,'confirmed_s':timeline[oid]['confirmed_s'],
    'final_state':objects[oid]['state'],'all_fed_raw_refs':samples})
assert set(fed)==ids
result={'scope':'complete original public brain logs only; per-identity sampling, not physical object count',
 'inputs':{name:{'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()} for name,path in paths.items()},
 'window':{'after_successful_place_round':cutoff,'rounds_first':late[0]['round'],'rounds_last':late[-1]['round'],
  'action_counts':dict(Counter(r['action']['action'] for r in late))},
 'pose_rule':{'min_translation_m':.15,'seed_counts_as_first_hit':True,'heading_only_changes_do_not_add_translation_views':True},
 'counts':{'new_candidate_ids':len(ids),'fed_detection_records':sum(len(v) for v in fed.values()),
 'total_seed_hits':sum(x['independent_poses_including_seed']>0 for x in rows),
 'additional_independent_poses_after_seed':sum(x['additional_independent_poses_after_seed'] for x in rows),
 'confirmed_candidates':sum(x['confirmed_s'] is not None for x in rows)},'candidates':rows,
 'interpretation':'17 fed records are not 17 valid WM hits: each of 7 tracked hypotheses has 1 seed hit and 0 further translated viewpoint; seven identities do not prove seven physical balls.'}
with OUT.open('x') as f:json.dump(result,f,ensure_ascii=False,indent=2);f.write('\n')
print(json.dumps({'output':str(OUT),'window':result['window'],'counts':result['counts']},ensure_ascii=False))
