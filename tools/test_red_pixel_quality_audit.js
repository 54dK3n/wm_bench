"use strict";

const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {gzipSync} = require('node:zlib');
const oracle = require('./v4_stage1_content_audit.js');
const gate = require('./fresh_map05_platform_gate.js');
const platform = path.resolve(__dirname,'../workspaces/guangyang-platform/projects/car-python');
const {decodeStrictVisionPng} = require(path.join(platform,'backend/strict-png.js'));
const adapter = require(path.join(platform,'robot-camera-detector.js'));
const fixtures = path.join(platform,'tests/fixtures/red-component-quality');
const manifest = JSON.parse(fs.readFileSync(path.join(fixtures,'manifest.json')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = value => structuredClone(value);

function example(index=1) {
  const fixture = manifest.frames[index], bytes = fs.readFileSync(path.join(fixtures,fixture.file));
  const pixels = {...decodeStrictVisionPng(bytes),frameId:fixture.frameId};
  const frame = {frameId:fixture.frameId,tick:12,stateRevision:7,width:640,height:480,mimeType:'image/png',
    pngBase64:bytes.toString('base64'),byteLength:bytes.length,sha256:sha(bytes)};
  const raw = fixture.redDetections.map(item=>({category:'target',source:item.source,confidence:item.confidence,
    frameId:fixture.frameId,box:{x:item.bbox.x,y:item.bbox.y+80,width:item.bbox.w,height:item.bbox.h}}));
  return {fixture,bytes,pixels,frame,raw};
}

for (let index=0;index<manifest.frames.length;index++) test(`independent original PNG recomputation: ${manifest.frames[index].name}`,()=>{
  const {fixture,bytes,pixels,raw} = example(index);
  assert.equal(sha(bytes),fixture.pngSha256);
  const canonical = oracle.projectRawDetections(raw,[],{},pixels).canonical;
  assert.deepEqual(canonical,adapter.detect(raw,[],{frameId:pixels.frameId,pixels:{width:640,height:480,data:pixels.rgba}}));
  assert.deepEqual(canonical.map(({pixelQuality,...item})=>item),fixture.redDetections);
  assert.deepEqual(canonical.map(({pixelQuality:q})=>({componentPixels:q.componentPixels,redSectorPixels:q.redSectorPixels,status:q.status})),fixture.quality);
  assert.deepEqual(oracle.projectRawDetections(raw,[]).canonical,fixture.redDetections,'legacy field omission unchanged');
});

test('independent quality preserves strict-majority boundary, separate same-frame components and clipped unknown',()=>{
  const pixels={frameId:3,width:640,height:480,rgba:Buffer.alloc(640*480*4)};
  // Two diagonally adjacent sampled points are distinct 4-connected components.
  for(const [x,y] of [[11,11],[13,13],[1,41]]) pixels.rgba.set([220,0,0,255],(y*640+x)*4);
  const components=oracle.redPixelComponents(pixels);
  assert.equal(components.length,3); assert.ok(components.every(row=>row.componentPixels===1));
  const left={frameId:3,box:{x:0,y:120,width:2,height:2}};
  assert.equal(oracle.pixelQuality(left,3,components).reason,'source_bbox_touches_boundary');
  const item={frameId:3,box:{x:10,y:90,width:2,height:2}};
  assert.equal(oracle.pixelQuality(item,3,components).status,'supported');
  assert.equal(oracle.pixelQuality(item,3,[{...item.box,componentPixels:2,redSectorPixels:1}]).reason,'red_sector_not_majority');
  assert.equal(oracle.pixelQuality(item,4,components).reason,'detection_frame_mismatch');
  assert.equal(oracle.pixelQuality(item,3,[...components,...components]).reason,'component_not_uniquely_matched');
});

test('native original PNG binding refuses wrong frame, tick, revision, bytes, hashes and duplicate frames',()=>{
  const {frame}=example(), capture={frameId:frame.frameId,tick:frame.tick,stateRevision:frame.stateRevision};
  assert.equal(oracle.bindPixelFrame([frame],capture,decodeStrictVisionPng).pngSha256,frame.sha256);
  for(const mutate of [f=>f.frameId++,f=>f.tick++,f=>f.stateRevision++,f=>f.byteLength++,f=>f.sha256='a'.repeat(64),
    f=>f.pngBase64=f.pngBase64.slice(4),f=>f.width=639]) {
    const changed=copy(frame); mutate(changed);
    assert.throws(()=>oracle.bindPixelFrame([changed],capture,decodeStrictVisionPng));
  }
  assert.throws(()=>oracle.bindPixelFrame([frame,frame],capture,decodeStrictVisionPng));
  assert.throws(()=>oracle.bindPixelFrame([frame],{...capture,rgbaSha256:'a'.repeat(64)},decodeStrictVisionPng));
});

function writtenRun(directory, mutate=()=>{}) {
  const {frame,pixels,raw}=example(4);
  const detections=oracle.projectRawDetections(raw,[],{},pixels).canonical;
  const observation={frameId:frame.frameId,tick:frame.tick,width:640,height:480,detections};
  mutate(observation);
  const sensor={requestId:'request-1',frameId:frame.frameId,tick:frame.tick,params:{},visionDetections:raw,
    storageDetections:[],robotDetections:copy(observation.detections)};
  const record={calls:[{method:'observe',args:{},started:{tick:frame.tick},finished:{tick:frame.tick},outcome:{result:observation}}],
    native:{visionFrames:[frame]}};
  const captures=[{frameId:frame.frameId,tick:frame.tick,stateRevision:frame.stateRevision}];
  const evidence={};
  for(const [name,value] of Object.entries({record,sensorAudit:[sensor],captures})) {
    const bytes=Buffer.from(JSON.stringify(value)),packed=gzipSync(bytes),file=`${name}.json.gz`;
    fs.writeFileSync(path.join(directory,file),packed); evidence[name]={file,sha256:sha(packed),expandedSha256:sha(bytes)};
  }
  fs.writeFileSync(path.join(directory,'evidence.json'),JSON.stringify(evidence));
  fs.mkdirSync(path.join(directory,'brain'),{recursive:true});
  fs.writeFileSync(path.join(directory,'brain/bridge-calls.jsonl'),JSON.stringify({request:{method:'observe',requestId:'request-1',params:{}},
    terminal:{status:'completed',result:observation}})+'\n');
}

test('complete native/sensor/capture/HTTP quality audit fails tampering even when every reported copy agrees',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wm-pixel-quality-audit-'));
  try {
    writtenRun(directory); assert.equal(gate.auditPixelQualityRun(directory).allPass,true);
    for(const mutate of [o=>o.detections[0].pixelQuality.componentPixels++,o=>o.detections[0].pixelQuality.status='unknown',
      o=>o.detections[0].pixelQuality.frameId++,o=>o.detections[0].pixelQuality.reason='pixel_frame_unavailable',
      o=>o.detections.forEach(item=>delete item.pixelQuality),o=>o.detections[0].category='blue-ball',
      o=>o.detections[0].confidence-=0.01,o=>o.detections[0].bbox.x++,o=>o.detections.reverse()]) {
      writtenRun(directory,mutate); assert.equal(gate.auditPixelQualityRun(directory).allPass,false);
    }
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

test('new preflight preserves original survey and original gate, limits source changes to the three adapter files',()=>{
  const parent=path.resolve(__dirname,'../artifacts/autonomous-brain/fresh-map05-gate-20260925/preflight-gate.json');
  const before=sha(fs.readFileSync(parent)), value=gate.createPixelQualityPreflight();
  assert.equal(value.allPass,true); assert.equal(value.newCompetitionRun,false);
  assert.equal(value.parent.sha256,before); assert.equal(sha(fs.readFileSync(parent)),before);
  assert.deepEqual(value.changedPlatformFiles.map(row=>row.file).sort(),['robot-backend-runtime.js','robot-bridge-contract.js','robot-camera-detector.js']);
  assert.ok(value.run.sourceChecks.filter(row=>!value.changedPlatformFiles.some(change=>change.file===row.file)).every(row=>row.match));
  assert.deepEqual(value.currentPlatform,Object.fromEntries(value.run.sourceChecks.map(row=>[row.file,row.currentSha256])));
  assert.deepEqual(value.run.platform,JSON.parse(fs.readFileSync(parent)).run.platform,'old survey source version is not rewritten');
  assert.equal(value.publicPixelReplay.survey.length,10); assert.equal(value.publicPixelReplay.fixtures.length,5);
});
