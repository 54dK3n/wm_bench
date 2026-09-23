# Demo keyframe audit

Only completed runs are included. Native PNGs are decoded and compared byte-for-byte with the full original record. Every extra keyframe is inspected with view_image; screenshots are whole-map views, so success is checked against native events and captured object state.

| Map | Native frames / bytes | Keyframes / bytes | Event → capture ticks | Evidence audit |
|---|---:|---:|---|---|
| map-03 | 35 / 7930432 | 2 / 348128 | guangyang-target-2 package_grabbed: 2607→2609 (+2); guangyang-target-2 package_delivered: 4252→4254 (+2) | PASS |
| map-04 | 56 / 13314121 | 2 / 347857 | guangyang-target-2 package_grabbed: 6379→6381 (+2); guangyang-target-2 package_delivered: 10077→10079 (+2) | PASS |
| map-05 | 31 / 7280389 | 4 / 695637 | guangyang-target-1 package_grabbed: 9413→9416 (+3); guangyang-target-1 package_delivered: 11297→11300 (+3); guangyang-target-2 package_grabbed: 19918→19919 (+1); guangyang-target-2 package_delivered: 21953→21956 (+3) | PASS |

Stage 0 keeps the original native 20MiB cap; combined screenshot bytes are reported, not used as an additional gate. Evidence PASS is not task success: a run with only one ball delivered may have complete evidence.

Frozen source hashes unchanged: True.

## Reproduce numerical checks

Save the following Python block as a .py file, then run that file from the workspace root (Pillow required). VIEWED records the separate human image inspections; those cannot be reproduced by hash checks alone.

```python
from pathlib import Path
import base64, hashlib, json
from PIL import Image, ImageStat

# Run from the workspace root. Human-reviewed PNG filenames record actual view_image reviews.
ROOT = Path.cwd() / 'artifacts/inloop/demo'
VIEWED = {
 'attempts/attempt-030.demo/event-002416-package_grabbed-tick-9416.png',
 'attempts/attempt-030.demo/event-002861-package_delivered-tick-11300.png',
 'attempts/attempt-030.demo/event-005026-package_grabbed-tick-19919.png',
 'attempts/attempt-030.demo/event-005506-package_delivered-tick-21956.png',

 'attempts/attempt-017.demo/event-002522-package_delivered-tick-10079.png',
 'attempts/attempt-017.demo/event-001654-package_grabbed-tick-6381.png',
 'attempts/attempt-013.demo/event-000728-package_grabbed-tick-2609.png',
 'attempts/attempt-013.demo/event-001120-package_delivered-tick-4254.png',
}
def digest(data):
 return hashlib.sha256(data).hexdigest()
def load(path):
 return json.loads(Path(path).read_text())
def image_info(path, frame):
 data = path.read_bytes()
 with Image.open(path) as image:
  image.load()
  extrema = image.convert('RGB').getextrema()
  stats = ImageStat.Stat(image.convert('RGB'))
  size = list(image.size)
 return {'path':str(path.resolve()),'bytes':len(data),'sha256':digest(data),'dimensions':size,
  'native_dimensions_match':size==[frame['width'],frame['height']],
  'hash_matches':digest(data)==frame['sha256'],'bytes_match':len(data)==frame['byteLength'],
  'decoded_png':data[:8]==b'\x89PNG\r\n\x1a\n','nonuniform_rgb':any(lo!=hi for lo,hi in extrema),
  'rgb_extrema':extrema,'rgb_stddev':stats.stddev}
rows=[]
for raw_path in sorted(ROOT.glob('map-??.json')):
 raw=load(raw_path)
 record_path=Path(raw['fullRecordFile']);record_bytes=record_path.read_bytes();record=json.loads(record_bytes)
 vision_path=Path(raw['visionEvidenceFile']);vision=load(vision_path)
 demo_path=Path(raw['demoEvidenceFile']);demo=load(demo_path)
 native={f['evidenceId']:f for f in record['visionFrames']}
 truths={f['evidenceId']:f for f in vision['renderTruth']['frames']}
 events={e['seq']:e for e in record['events']};inputs={q['seq']:q for q in record['inputs']}
 frame_rows=[]
 for frame in vision['frames']:
  info=image_info(vision_path.parent/frame['image'],frame)
  original=native[frame['evidenceId']]
  payload=original.get('pngBase64',original.get('payloadBase64'))
  payload=payload.split(',',1)[1] if payload.startswith('data:') else payload
  info['equals_native_png_payload']=base64.b64decode(payload)==Path(info['path']).read_bytes()
  truth=truths.get(frame['evidenceId'],{})
  info['exact_render_binding']=truth.get('exactRenderState') is True and all([
   truth.get('runId')==record['runId'],truth.get('frameId')==frame['frameId'],
   truth.get('evidenceSeq')==frame['seq'],truth.get('imageSha256')==frame['sha256'],
   truth.get('evidenceTick')==frame['tick'],truth.get('evidenceStateRevision')==frame['stateRevision'],
   truth.get('captureTick')==frame['tick'],truth.get('captureStateRevision')==frame['stateRevision']])
  frame_rows.append(info)
 by_id={f['evidenceId']:f for f in vision['frames']}
 queries=vision['queries']
 queries_match=queries==[q for q in record['inputs'] if q['type']=='vision_query']
 query_binding=all(q['evidenceId'] in by_id and by_id[q['evidenceId']]['frameId']==q['frameId']
                   and by_id[q['evidenceId']]['seq']<q['seq'] for q in queries)
 observed=[q for q in queries if q['method']=='observe']
 logs=[line for line in raw['lines'] if line.get('event')=='observe']
 log_fields=('category','distanceCm','bearingDeg','confidence')
 observe_logs_match=len(observed)==len(logs) and all([{k:d[k] for k in log_fields} for d in q['result'] if d.get('category') in ('target','distractor')]==line['raw'] and q['tick']==line['tick'] for q,line in zip(observed,logs))
 keyframes=[]
 for frame in demo['frames']:
  info=image_info(demo_path.parent/frame['image'],frame)
  event=events.get(frame['eventSeq']);q=inputs.get(frame['interactionInputSeq'])
  info.update({k:frame[k] for k in ('eventType','packageId','eventTick','captureTick','tickDelta','eventStateRevision','captureStateRevision')})
  info['actual_event_matches']=event==frame['event']
  info['exact_input_binding']=bool(event and q and q['seq']<event['seq'] and q['t']==event['t']
   and q['tick']==frame['eventTick'] and q['stateRevision']==frame['eventStateRevision']
   and frame['tickDelta']==frame['captureTick']-q['tick'])
  info['holding_at_capture']=frame['objectState']['holding']
  info['human_viewed']=str((demo_path.parent/frame['image']).relative_to(ROOT)) in VIEWED
  info['visual_finding']='Real nonblank whole-map main view; vehicle/package too small for image-only grasp/delivery judgement.' if info['human_viewed'] else 'Not yet manually viewed.'
  keyframes.append(info)
 expected=[];seen=set()
 for e in record['events']:
  key=(e.get('packageId'),e['type'])
  if e.get('objectRole')=='target' and (e['type']=='package_delivered' or (e['type']=='package_grabbed' and e.get('accepted') is True)) and key not in seen:
   expected.append(e['seq']);seen.add(key)
 native_bytes=sum(f['byteLength'] for f in record['visionFrames'])
 screenshot_bytes=sum(f['bytes'] for f in keyframes)
 checks={'full_record_hash_and_size':digest(record_bytes)==raw['fullRecordExport']['sha256'] and len(record_bytes)==raw['fullRecordExport']['bytes'],
  'native_frame_count':len(frame_rows)==len(native),'native_images':all(all(f[k] for k in ('native_dimensions_match','hash_matches','bytes_match','decoded_png','nonuniform_rgb','equals_native_png_payload','exact_render_binding')) for f in frame_rows),
  'all_queries_equal_native_record':queries_match,'all_queries_bind_exact_png':query_binding,'observe_logs_match_native_queries':observe_logs_match,
  'expected_keyframes_exactly_covered':expected==[f['eventSeq'] for f in demo['frames']],
  'keyframe_images_and_bindings':all(all(f[k] for k in ('native_dimensions_match','hash_matches','bytes_match','decoded_png','nonuniform_rgb','actual_event_matches','exact_input_binding')) for f in keyframes),
  'all_keyframes_human_viewed':all(f['human_viewed'] for f in keyframes),'no_evidence_errors':not demo.get('hookErrors') and not demo.get('exportErrors') and not vision.get('exportErrors') and not vision['renderTruth'].get('errors'),
  'native_budget_unchanged_and_within_cap':native_bytes<=20*1024*1024,
  'reported_combined_bytes_match':demo['combinedImageBytes']==native_bytes+screenshot_bytes}
 rows.append({'map':raw['assignedMap'],'run_id':record['runId'],'raw_file':str(raw_path.resolve()),'full_record_bytes':len(record_bytes),
  'native_frames':len(frame_rows),'native_queries':len(queries),'observe_queries':len(observed),'native_png_bytes':native_bytes,
  'keyframe_count':len(keyframes),'keyframe_png_bytes':screenshot_bytes,'combined_image_bytes':native_bytes+screenshot_bytes,
  'combined_byte_policy':'Stage 0 reports combined bytes; only native 20MiB cap is enforced.',
  'checks':checks,'keyframes':keyframes,'native_images':frame_rows,'evidence_pass':all(checks.values())})
manifest=load(ROOT/'code_manifest.json')
freeze={p:digest(Path(p).read_bytes())==expected for p,expected in manifest.items()}
report={'schema':'wm-demo-independent-keyframe-audit/v1','scope':'Offline evidence audit only; no simulation, new observe/render, detector replay or frozen source changes.',
 'frozen_source_hashes':freeze,'frozen_sources_unchanged':all(freeze.values()),'completed_maps':rows}
(ROOT/'keyframe_audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
summary=['# Demo keyframe audit','', 'Only completed runs are included. Native PNGs are decoded and compared byte-for-byte with the full original record. Every extra keyframe is inspected with view_image; screenshots are whole-map views, so success is checked against native events and captured object state.','', '| Map | Native frames / bytes | Keyframes / bytes | Event → capture ticks | Evidence audit |','|---|---:|---:|---|---|']
for row in rows:
 tick_text='; '.join(f"{f['packageId']} {f['eventType']}: {f['eventTick']}→{f['captureTick']} (+{f['tickDelta']})" for f in row['keyframes'])
 summary.append(f"| {row['map']} | {row['native_frames']} / {row['native_png_bytes']} | {row['keyframe_count']} / {row['keyframe_png_bytes']} | {tick_text} | {'PASS' if row['evidence_pass'] else 'INCOMPLETE/FAIL'} |")
summary.extend(['','Stage 0 keeps the original native 20MiB cap; combined screenshot bytes are reported, not used as an additional gate. Evidence PASS is not task success: a run with only one ball delivered may have complete evidence.','',f"Frozen source hashes unchanged: {all(freeze.values())}.",'','## Reproduce numerical checks','','Save the following Python block as a .py file, then run that file from the workspace root (Pillow required). VIEWED records the separate human image inspections; those cannot be reproduced by hash checks alone.','','```python',Path(__file__).read_text(),'```',''])
(ROOT/'keyframe_audit.md').write_text('\n'.join(summary))
print(json.dumps({'frozen_sources_unchanged':all(freeze.values()),'maps':[{k:r[k] for k in ('map','native_frames','native_png_bytes','keyframe_count','keyframe_png_bytes','evidence_pass','checks')} for r in rows]},ensure_ascii=False))

```
