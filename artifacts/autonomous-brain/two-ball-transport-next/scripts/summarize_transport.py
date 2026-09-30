"""Terminal public-log index for this round only; no API, platform, or evaluator."""
from collections import Counter
import argparse, hashlib, json, math
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--brain',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
assert not a.out.exists(), 'create-only output'
manifest_path=a.brain.parent.parent/'manifest.json'
manifest_bytes=manifest_path.read_bytes()
source_commit=json.loads(manifest_bytes)['brainRevision']
assert isinstance(source_commit,str) and len(source_commit)==40 and all(c in '0123456789abcdef' for c in source_commit), 'manifest requires a complete source SHA'
summary=json.loads((a.brain/'summary.json').read_text())
assert summary['status'] in {'failed','done','interrupted','aborted'}, 'terminal summary required'
inputs={};data={}
for name in ['rounds','observations','motions','bridge-calls']:
 raw=(a.brain/(name+'.jsonl')).read_bytes();inputs[name]={'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)}
 data[name]=[json.loads(l) for l in raw.splitlines() if l.strip()]
rounds,obs,motions,bridge=(data[n] for n in ['rounds','observations','motions','bridge-calls'])
o={x['observation_index']:x for x in obs};br={x['request']['requestId']:x for x in bridge}
def pose(i):
 x=o[i];od=x['odometry'];rd=x['road']
 return {'observation':i,'tick':od['tick'],'pose_cm_deg':[od['rightCm'],od['forwardCm'],od['headingDeg']],'holding':x['holding']['holding'],'on_road':rd['onRoad'],'front_clearance_cm':rd['frontClearanceCm']}
def movement(m):
 before=pose(m['before_observation']);after=pose(m['after_observation']);bo=o[m['before_observation']]['odometry'];ao=o[m['after_observation']]['odometry']
 return {'command_ref':m.get('bridge_request_id'),'method':m['method'],'params':m['params'],'before':before,'after':after,'result':m.get('actuator_result'),'outcome_unknown':m.get('outcome_unknown',False),'selected_route_segment':m.get('selected_route_segment'),'travel_cm':round(ao['distanceCm']-bo['distanceCm'],4),'net_cm':round(math.hypot(ao['rightCm']-bo['rightCm'],ao['forwardCm']-bo['forwardCm']),6)}
grabs=[m for m in motions if m['method']=='grab']; releases=[m for m in motions if m['method']=='release']
successgrabs=[m for m in grabs if not o[m['before_observation']]['holding']['holding'] and o[m['after_observation']]['holding']['holding']]
start=successgrabs[0]['after_observation'] if successgrabs else None
end=releases[0]['before_observation'] if releases else (obs[-1]['observation_index'] if obs else None)
transport=[m for m in motions if start is not None and start<=m['before_observation']<=end and m['method'] not in {'grab','release'}]
physicalblocks=[m for m in transport if (m.get('actuator_result') or {}).get('stoppedBy') in {'front_clearance','collision','off_road','wrong_way'}]
episodes=[]
for i,r in enumerate(rounds):
 ev=r['result'].get('evidence') or {};pf=ev.get('passage_failures') or []
 rejection=ev.get('motion_not_sent') or (ev.get('observed_motion_failure') or {}).get('motion_not_sent')
 recovery=ev.get('transport_recovery')
 if not(pf or recovery or 'passage' in r['result']['reason']):continue
 nxt=rounds[i+1] if i+1<len(rounds) else None
 offered=(recovery or {}).get('choices',[])
 chosen=bool(nxt and any(c.get('action')==(nxt.get('action') or {}).get('action') and c.get('params')==(nxt.get('action') or {}).get('params') for c in offered))
 episodes.append({'round':r['round'],'action':r['action'],'reason':r['result']['reason'],'before_observation':ev.get('before_observation'),'after_observation':ev.get('after_observation'),'motion_not_sent':rejection,'passage_failures':pf,'transport_recovery':recovery,'next_action':nxt['action'] if nxt else None,'next_result':nxt['result']['reason'] if nxt else None,'next_action_exactly_matches_offered_choice':chosen})
result={'source_commit':source_commit,'scope':'Public observation/command evidence only; synthetic regression and physical evaluation are separate.','brain_status':summary['status'],'brain_reason':summary['reason'],'inputs':inputs,'manipulation_commands':[{'round':m['round'],**movement(m)} for m in motions if m['method'] in {'grab','release'}],'first_held_observation':start,'first_release_before_observation':releases[0]['before_observation'] if releases else None,'first_ball_transport_motion_count':len(transport),'first_ball_transport_actual_block_count':len(physicalblocks),'first_ball_transport_first_block':{'round':physicalblocks[0]['round'],**movement(physicalblocks[0])} if physicalblocks else None,'first_ball_transport_blocked_motions':[{'round':m['round'],**movement(m)} for m in physicalblocks],'passage_and_recovery_episodes':episodes,'round_reasons':dict(Counter(r['result']['reason'] for r in rounds)),'model_done_rounds':[r['round'] for r in rounds if (r.get('action') or {}).get('action')=='done'],'terminal_round':{'round':rounds[-1]['round'],'action':rounds[-1]['action'],'result':rounds[-1]['result']},'unknown_commands':[{'round':m['round'],**movement(m)} for m in motions if m.get('outcome_unknown')],'physical_delivery_count':'UNKNOWN_IN_THIS_PUBLIC_ONLY_INDEX'}
for name,v in inputs.items():assert hashlib.sha256((a.brain/(name+'.jsonl')).read_bytes()).hexdigest()==v['sha256'],'inputs changed'
assert manifest_path.read_bytes()==manifest_bytes,'manifest changed'
with a.out.open('x') as f:json.dump(result,f,ensure_ascii=False,indent=2);f.write('\n')
print(json.dumps({'output':str(a.out),'grabs':len(grabs),'releases':len(releases),'observed_grab_success':len(successgrabs),'first_held':start,'physical_transport_blocks':len(physicalblocks),'recovery_episodes':len(episodes)},ensure_ascii=False))
