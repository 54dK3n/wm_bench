import json,math,sys,itertools
from pathlib import Path
sys.path[:0]=['vendor/wm_kit_opt2','.']
from autonomous_brain.perception import Perception,discovery_pixel_match,RANGE_CAL,DETECTOR_WIDTH_CM
from world_model.providers.guangyang import odometry_to_pose
root=Path('artifacts/autonomous-brain/identity-view-consistency-next')
fixture=json.loads(Path('tests/fixtures/identity_view_consistency_public.json').read_text())
original={(g['name'],r['source']['frame_id']):r['original_detection'] for g in fixture for r in g['sources']}
def residual(camera,s,p):
 pose=odometry_to_pose(s['odometry']);right,forward=pose.to_local(p['x'],p['z']);right*=100;forward=forward*100-RANGE_CAL['L_cm'];beta=math.atan2(right,forward)
 u=camera['cx']+camera['fx']*math.tan(beta);raw=(math.hypot(right,forward)-RANGE_CAL['a_cm'])*math.cos(beta)/RANGE_CAL['k'];box=s['bbox'];center=box['x']+box['w']/2;b=math.atan2(center-camera['cx'],camera['fx'])
 def reading(w):return DETECTOR_WIDTH_CM['red-ball']*camera['fy']/(max(1.,w)*max(.35,math.cos(b)))+camera['mount']['forwardCm']
 tol=.5+max(abs(reading(box['w']+d)-reading(box['w'])) for d in [-1,1])
 return {'predicted_center_u':u,'original_center_u':center,'center_error_px':u-center,'pixel_tolerance_px':1.5+camera['fx']*math.tan(math.radians(.005)),'predicted_raw_cm':raw,'bbox_raw_unclipped_cm':reading(box['w']),'range_error_cm':raw-reading(box['w']),'range_tolerance_cm':tol,'match':discovery_pixel_match(camera,s,p)}
def analyze(name,camera,rows,wm_position):
 p=Perception(camera);converted=[]
 for s in rows:
  p.pose=odometry_to_pose(s['odometry']);det,e=p._convert(original[(name,s['frame_id'])],str(s['frame_id']),s['simulation_time_s'])
  converted.append({'source':s,'conversion':e,'position_reproduced':math.hypot(det.x-s['position_m']['x'],det.z-s['position_m']['z'])<1e-12,'self_projection':residual(camera,s,s['position_m'])})
 mean={k:sum(s['position_m'][k] for s in rows)/len(rows) for k in ['x','z']}
 pairs=[{'frames':[a['frame_id'],b['frame_id']],'point_gap_cm':math.hypot(a['position_m']['x']-b['position_m']['x'],a['position_m']['z']-b['position_m']['z'])*100,'a_into_b':residual(camera,b,a['position_m']),'b_into_a':residual(camera,a,b['position_m'])} for a,b in itertools.combinations(rows,2)]
 return {'name':name,'camera':camera,'observations_and_conversion':converted,'mean':mean,'recorded_wm_position':wm_position,'mean_matches_record':math.hypot(mean['x']-wm_position['x'],mean['z']-wm_position['z'])<1e-12,'mean_projections':[{'frame':s['frame_id'],**residual(camera,s,mean)} for s in rows],'cross_view_pairs':pairs,'claim_limit':'Tracked IDs and accepted hits do not establish physical equivalence. No RGB original or physical truth used.'}
a=[analyze(g['name'],g['camera'],[r['source'] for r in g['sources']],g['wm_position']) for g in fixture]
(root/'view-consistency-original-confidence.json').write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n')
for g in a:print(g['name'],'frames',[s['source']['frame_id'] for s in g['observations_and_conversion']],'mean',g['mean'],'mean_matches',g['mean_matches_record'],'gaps',[round(z['point_gap_cm'],3) for z in g['cross_view_pairs']],'self',[s['self_projection']['match'] for s in g['observations_and_conversion']],'mean_u',[round(q['center_error_px'],3) for q in g['mean_projections']],'cross',[z['a_into_b']['match'] and z['b_into_a']['match'] for z in g['cross_view_pairs']])
