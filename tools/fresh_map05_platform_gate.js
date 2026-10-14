#!/usr/bin/env node
"use strict";

// Offline evaluation only. Reads the two explicitly labelled diagnostic runs;
// no platform, brain or model is started, and no truth goes to the robot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {gunzipSync} = require('node:zlib');
const {isDeepStrictEqual: equal} = require('node:util');
const oracle = require('./v4_stage1_content_audit.js');
const ROOT = path.resolve(__dirname, '..');
const VERSION = 'fresh-map05-platform-gate/v2';
const PREFLIGHT = path.join(ROOT,'artifacts/autonomous-brain/fresh-map05-gate-20260925/preflight-gate.json');
const QUALITY_ADAPTER_FILES = Object.freeze(['robot-camera-detector.js','robot-backend-runtime.js','robot-bridge-contract.js']);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const rel = file => path.relative(ROOT, file);
const lines = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const counts = () => Object.fromEntries(oracle.CATEGORIES.map(c => [c,0]));
const truthCounts = () => Object.fromEntries(oracle.TRUTH_CATEGORIES.map(c => [c,{expected:0,detected:0,misses:0}]));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value,null,2)+'\n');

function inspectRun(directory, {platformRoot = path.join(ROOT,'workspaces/guangyang-platform/projects/car-python'), allowedSourceChanges = []} = {}) {
  const fixture = read(path.join(directory, 'diagnostic-fixture.json'));
  assert.equal(fixture.diagnostic, true, 'missing diagnostic fixture label');
  assert.equal(fixture.real_model_used, false, 'input is not a diagnostic run');
  const trialDir = path.join(directory, 'map-05-run-1');
  const trial = read(path.join(trialDir,'evaluation.json'));
  const manifest = read(path.join(directory,'manifest.json'));
  const declared = read(path.join(trialDir,'evidence.json'));
  const failures = [], artifacts = {}, values = {};
  const check = (condition, code, detail = {}) => {if (!condition) failures.push({code,...detail});};
  check(trial.map === 'map-05', 'WRONG_LAYOUT');
  for (const name of ['record','sensorAudit','captures']) {
    const entry = declared[name];
    const file = path.join(trialDir,entry.file), packed = fs.readFileSync(file), unpacked = gunzipSync(packed);
    const packedSha256 = sha(packed), expandedSha256 = sha(unpacked);
    check(packedSha256 === entry.sha256 && expandedSha256 === entry.expandedSha256, 'EVIDENCE_SHA_MISMATCH',{name});
    artifacts[name] = {file:rel(file),sha256:packedSha256,expandedSha256};
    values[name] = JSON.parse(unpacked);
  }
  const bridgeFile = path.join(trialDir,'brain/bridge-calls.jsonl');
  const roundsFile = path.join(trialDir,'brain/rounds.jsonl');
  artifacts.bridge = {file:rel(bridgeFile),sha256:sha(fs.readFileSync(bridgeFile))};
  artifacts.rounds = {file:rel(roundsFile),sha256:sha(fs.readFileSync(roundsFile))};
  const transcript = lines(bridgeFile), rounds = lines(roundsFile);
  const actions = rounds.filter(row => row.action).map(row => row.action);
  check(equal(actions,[{action:'explore',params:{}},{action:'look_around',params:{}}]),'SCRIPT_ACTIONS_CHANGED',{actions});
  const record = values.record, cameras = values.captures, sensors = values.sensorAudit;
  check(record.complete === true,'INCOMPLETE_PLATFORM_RECORD');
  const nativeCalls = record.calls.filter(row=>row.method==='observe');
  const httpCalls = transcript.filter(row=>row.request.method==='observe');
  const nativeFrames = record.native.visionFrames;
  check(httpCalls.length > 0,'NO_OBSERVATIONS');
  for (const [name,rows] of [['nativeCalls',nativeCalls],['sensorAudit',sensors],['captures',cameras],['nativeFrames',nativeFrames]]) {
    check(rows.length === httpCalls.length,'OBSERVATION_COVERAGE_MISMATCH',{name,length:rows.length,bridgeCalls:httpCalls.length});
  }
  check(new Set(sensors.map(row=>row.requestId)).size===sensors.length,'DUPLICATE_SENSOR_REQUEST');
  check(new Set(cameras.map(row=>row.frameId)).size===cameras.length,'DUPLICATE_CAMERA_FRAME');
  const outputCounts = counts(), expectedCounts = truthCounts(), sourceCounts = {};
  const rows = httpCalls.map((entry,index)=>{
    const rowFailures = [];
    const require = (condition,code,detail={})=>{if(!condition) rowFailures.push({code,...detail});};
    const observation = entry.terminal?.result;
    require(entry.submission.status < 400 && entry.terminal.status === 'completed','BRIDGE_OBSERVE_FAILED');
    const sensor = sensors.find(row=>row.requestId===entry.request.requestId);
    const camera = cameras.find(row=>row.frameId===observation?.frameId && row.tick===observation?.tick);
    const frame = nativeFrames.find(row=>row.frameId===observation?.frameId && row.tick===observation?.tick);
    const call = nativeCalls[index];
    require(sensor !== undefined && camera !== undefined && frame !== undefined,'EVIDENCE_BINDING_MISSING');
    require(equal(call?.outcome?.result,observation) && equal(call?.args,entry.request.params),'RECORD_BRIDGE_MISMATCH');
    require(call?.started?.tick===observation?.tick && call?.finished?.tick===observation?.tick,'SENSOR_ADVANCED_TICK');
    require(sensor?.frameId===observation?.frameId && sensor?.tick===observation?.tick
      && equal(sensor?.params,entry.request.params),'RAW_DETECTOR_BRIDGE_BINDING');
    require(camera?.stateRevision===frame?.stateRevision,'CAMERA_REVISION_BINDING');
    let projection = null, truth = null;
    try {
      // The oracle is independent of robot-camera-detector.js. Category mapping,
      // letterbox transform and exclusions are explicit and auditable here.
      const quality = oracle.hasPixelQuality(sensor.robotDetections, observation.detections);
      const pixels = quality ? oracle.bindPixelFrame(nativeFrames, camera,
        requirePngCodec(platformRoot)) : null;
      projection = oracle.projectRawDetections(sensor.visionDetections,sensor.storageDetections,sensor.params,pixels);
      require(equal(projection.canonical,sensor.robotDetections),'INTERNAL_CANONICAL_MISMATCH');
      require(equal(projection.expected,observation.detections),'BRIDGE_CONTENT_MISMATCH',
        {difference:oracle.difference(projection.expected,observation.detections)});
      require(observation.width===640 && observation.height===480,'SOURCE_DIMENSIONS_CHANGED');
      for (const detection of observation.detections) {
        outputCounts[detection.category]++;
        sourceCounts[detection.source]=(sourceCounts[detection.source]||0)+1;
      }
      for (const mapping of projection.mappings.filter(row=>row.rawSource==='virtual-cv')) {
        require(sensor.robotDetections[mapping.projectedIndex]?.source==='virtual-cv','VIRTUAL_CV_RELABELLED');
      }
      truth = oracle.auditTruth({...camera,bridgeObservation:observation});
      for (const category of oracle.TRUTH_CATEGORIES) for (const key of ['expected','detected','misses']) {
        expectedCounts[category][key] += truth.counts[category][key];
      }
    } catch (error) {rowFailures.push({code:'EVIDENCE_SCHEMA_OR_ORACLE_ERROR',message:error.message});}
    return {index,requestId:entry.request.requestId,frameId:observation?.frameId,tick:observation?.tick,
      detections:observation?.detections,projection,truth,failures:rowFailures,exactContent:rowFailures.length===0};
  });
  const motions = record.calls.filter(row=>['take_exit','follow_road'].includes(row.method));
  check(motions.some(row=>row.outcome?.result?.distanceCm>0),'NO_ALONG_ROAD_MOTION');
  const sourceChecks = Object.entries(manifest.platform).map(([file,expectedSha256])=>{
    const sourceFile=path.join(platformRoot,file);
    const currentSha256=sha(fs.readFileSync(sourceFile));
    return {file,expectedSha256,currentSha256,match:expectedSha256===currentSha256};
  });
  check(sourceChecks.every(row=>row.match || allowedSourceChanges.includes(row.file)),'PLATFORM_CHANGED_SINCE_RUN');
  const allContentExact=failures.length===0 && rows.every(row=>row.exactContent);
  const fourClassesSeen=oracle.CATEGORIES.every(c=>outputCounts[c]>0);
  return {map:'map-05',directory:rel(directory),diagnostic:true,realModelUsed:false,actions,
    observations:rows.length,matchedObservations:rows.filter(row=>row.exactContent).length,
    outputCounts,sourceCounts,truthCounts:expectedCounts,sourceChecks,platform:manifest.platform,
    brainSource:manifest.brain,artifacts,motionCalls:motions.map(row=>({method:row.method,args:row.args,result:row.outcome.result})),
    failures,rows,gates:{bridgeInternalExact:allContentExact,fourClassesSeen},allPass:allContentExact&&fourClassesSeen};
}

// The first two user gates need one actual along-road survey. This immutable
// preflight uses the already completed smoke02 source/evidence, so driver startup
// need not depend on its own future smoke03 output. Both-run reporting is separate.
function createPreflight({platformRoot} = {}) {
  const run = inspectRun(path.join(ROOT,'artifacts/autonomous-brain/transport-smoke-02'), {platformRoot});
  assert.equal(run.allPass,true,'smoke02 preflight did not satisfy both platform gates');
  return {schema:'fresh-map05-platform-preflight/v1',evaluationOnly:true,diagnosticInput:true,
    autonomousTaskAcceptance:false, reviewer:{file:rel(__filename),sha256:sha(fs.readFileSync(__filename)),
      oracleFile:'tools/v4_stage1_content_audit.js',oracleSha256:sha(fs.readFileSync(path.join(__dirname,'v4_stage1_content_audit.js')))},
    run,allPass:run.allPass};
}

function verifyPreflightGate({platformRoot, gateFile} = {}) {
  const saved = read(gateFile || PREFLIGHT);
  const fresh = saved.schema === 'pixel-quality-platform-preflight/v1'
    ? createPixelQualityPreflight({platformRoot}) : createPreflight({platformRoot});
  assert.deepEqual(fresh,saved,'platform preflight evidence or independent reviewer changed');
  assert.equal(fresh.allPass,true,'platform preflight failed');
  return fresh;
}

function requirePngCodec(platformRoot) {
  // Generic strict PNG decoding only. Pixel classification is independently
  // implemented in the oracle and never imported from the platform adapter.
  return require(path.join(platformRoot,'backend/strict-png.js')).decodeStrictVisionPng;
}

function createPixelQualityPreflight({platformRoot = path.join(ROOT,'workspaces/guangyang-platform/projects/car-python')} = {}) {
  const parent = read(PREFLIGHT), run = inspectRun(path.join(ROOT,'artifacts/autonomous-brain/transport-smoke-02'),
    {platformRoot,allowedSourceChanges:QUALITY_ADAPTER_FILES});
  assert.equal(run.allPass,true,'legacy survey content or non-adapter source changed');
  const legacy = structuredClone(run);
  legacy.sourceChecks = legacy.sourceChecks.map(row => ({...row,currentSha256:row.expectedSha256,match:true}));
  assert.deepEqual(legacy,parent.run,'original survey fields no longer independently reproduce');
  const decoder = requirePngCodec(platformRoot), adapter = require(path.join(platformRoot,'robot-camera-detector.js'));
  const trial = path.join(ROOT,'artifacts/autonomous-brain/transport-smoke-02/map-05-run-1');
  const evidence = read(path.join(trial,'evidence.json'));
  const unpack = name => JSON.parse(gunzipSync(fs.readFileSync(path.join(trial,evidence[name].file))));
  const record = unpack('record'), sensors = unpack('sensorAudit'), cameras = unpack('captures');
  const comparisons = sensors.map(sensor => {
    const camera = cameras.find(row => row.frameId === sensor.frameId && row.tick === sensor.tick);
    const pixels = oracle.bindPixelFrame(record.native.visionFrames,camera,decoder);
    const expected = oracle.projectRawDetections(sensor.visionDetections,sensor.storageDetections,{},pixels).canonical;
    const actual = adapter.detect(sensor.visionDetections,sensor.storageDetections,
      {frameId:pixels.frameId,pixels:{width:pixels.width,height:pixels.height,data:pixels.rgba}});
    assert.deepEqual(actual,expected,'current adapter differs from independent old-survey PNG replay');
    const original = actual.map(({pixelQuality,...item}) => item);
    assert.deepEqual(original,sensor.robotDetections,'quality extension changed original survey detections');
    return {frameId:sensor.frameId,tick:sensor.tick,pngSha256:pixels.pngSha256,
      detections:expected,originalFieldsExact:true,qualityExact:true};
  });
  const fixtureDirectory = path.join(platformRoot,'tests/fixtures/red-component-quality');
  const manifestFile = path.join(fixtureDirectory,'manifest.json'), fixtures = read(manifestFile);
  const heldOut = fixtures.frames.map(frame => {
    const bytes = fs.readFileSync(path.join(fixtureDirectory,frame.file));
    assert.equal(sha(bytes),frame.pngSha256,'public PNG fixture changed');
    const decoded = decoder(bytes), pixels = {...decoded,frameId:frame.frameId};
    const raw = frame.redDetections.map(item => ({category:'target',source:item.source,confidence:item.confidence,
      frameId:frame.frameId,box:{x:item.bbox.x,y:item.bbox.y+80,width:item.bbox.w,height:item.bbox.h}}));
    const expected = oracle.projectRawDetections(raw,[],{},pixels).canonical;
    const actual = adapter.detect(raw,[],{frameId:frame.frameId,pixels:{width:640,height:480,data:decoded.rgba}});
    assert.deepEqual(actual,expected,'adapter differs from independent public PNG fixture replay');
    assert.deepEqual(actual.map(({pixelQuality,...item}) => item),frame.redDetections,'fixture original fields changed');
    return {name:frame.name,sourceFrame:frame.source_frame,frameId:frame.frameId,pngSha256:sha(bytes),
      detections:expected,originalFieldsExact:true,qualityExact:true};
  });
  return {schema:'pixel-quality-platform-preflight/v1',evaluationOnly:true,diagnosticInput:true,
    autonomousTaskAcceptance:false,newCompetitionRun:false,
    scope:'Original public PNG replay verifies an optional input extension; not a new survey or model run',
    parent:{file:rel(PREFLIGHT),sha256:sha(fs.readFileSync(PREFLIGHT))},
    reviewer:{file:rel(__filename),sha256:sha(fs.readFileSync(__filename)),oracleFile:'tools/v4_stage1_content_audit.js',
      oracleSha256:sha(fs.readFileSync(path.join(__dirname,'v4_stage1_content_audit.js')))},
    changedPlatformFiles:QUALITY_ADAPTER_FILES.map(file => ({file,previousSha256:parent.run.platform[file],sha256:sha(fs.readFileSync(path.join(platformRoot,file)))})),
    pngCodec:{file:'backend/strict-png.js',sha256:sha(fs.readFileSync(path.join(platformRoot,'backend/strict-png.js')))},
    fixtureManifest:{file:rel(manifestFile),sha256:sha(fs.readFileSync(manifestFile))},
    currentPlatform:Object.fromEntries(run.sourceChecks.map(row=>[row.file,row.currentSha256])),
    run,publicPixelReplay:{survey:comparisons,fixtures:heldOut},allPass:true};
}

function auditPixelQualityRun(directory, {platformRoot = path.join(ROOT,'workspaces/guangyang-platform/projects/car-python')} = {}) {
  const declared = read(path.join(directory,'evidence.json')), values = {}, artifacts = {};
  for (const name of ['record','sensorAudit','captures']) {
    const file = path.join(directory,declared[name].file), packed = fs.readFileSync(file), unpacked = gunzipSync(packed);
    assert.equal(sha(packed),declared[name].sha256,`${name} packed SHA mismatch`);
    assert.equal(sha(unpacked),declared[name].expandedSha256,`${name} expanded SHA mismatch`);
    values[name] = JSON.parse(unpacked); artifacts[name] = {file:rel(file),sha256:sha(packed),expandedSha256:sha(unpacked)};
  }
  const bridgeFile = path.join(directory,'brain/bridge-calls.jsonl');
  const entries = lines(bridgeFile).filter(row => row.request?.method === 'observe' && row.terminal?.status === 'completed');
  artifacts.bridge = {file:rel(bridgeFile),sha256:sha(fs.readFileSync(bridgeFile))};
  const calls = values.record.calls.filter(row => row.method === 'observe'), failures = [];
  if (entries.length !== calls.length || entries.length !== values.sensorAudit.length || entries.length !== values.captures.length
      || entries.length !== values.record.native.visionFrames.length) failures.push({code:'OBSERVATION_COVERAGE_MISMATCH'});
  const decoder = requirePngCodec(platformRoot);
  const rows = entries.map((entry,index) => {
    const observation = entry.terminal.result;
    const result = {index,frameId:observation.frameId,tick:observation.tick,requestId:entry.request.requestId,failures:[]};
    try {
      const sensors = values.sensorAudit.filter(row => row.requestId === entry.request.requestId);
      const cameras = values.captures.filter(row => row.frameId === observation.frameId && row.tick === observation.tick);
      assert.equal(sensors.length,1); assert.equal(cameras.length,1);
      const sensor = sensors[0], camera = cameras[0], call = calls[index];
      assert.equal(sensor.frameId,observation.frameId); assert.equal(sensor.tick,observation.tick);
      assert.deepEqual(sensor.params,entry.request.params); assert.deepEqual(call.args,entry.request.params);
      assert.deepEqual(call.outcome.result,observation); assert.equal(call.started.tick,observation.tick);
      assert.equal(call.finished.tick,observation.tick); assert.equal(observation.width,640); assert.equal(observation.height,480);
      const pixels = oracle.bindPixelFrame(values.record.native.visionFrames,camera,decoder);
      const projection = oracle.projectRawDetections(sensor.visionDetections,sensor.storageDetections,sensor.params,pixels);
      assert.deepEqual(sensor.robotDetections,projection.canonical); assert.deepEqual(observation.detections,projection.expected);
      result.pngSha256 = pixels.pngSha256; result.qualities = projection.expected.filter(row => row.pixelQuality).map(row => row.pixelQuality);
    } catch(error) { result.failures.push({code:'PIXEL_QUALITY_CONTENT_OR_BINDING',message:error.message}); }
    result.allPass = result.failures.length === 0; return result;
  });
  return {schema:'same-frame-pixel-quality-audit/v1',evaluationOnly:true,autonomousTaskAcceptance:false,
    directory:rel(directory),artifacts,observations:rows.length,rows,failures,allPass:failures.length===0&&rows.length>0&&rows.every(row=>row.allPass)};
}

function report(result) {
  const text=['# map-05 新实跑平台门禁','',`平台两项门禁：**${result.allPass?'PASS':'FAIL'}**。`,'',
    '输入来自两次独立启动的真实平台、外部 Python 大脑和机器人桥，执行固定 `explore → look_around` 脚本。模型是本机诊断替身 `diagnostic-stub`；这份报告只验证平台接口，不是自主任务验收，也不是实际大模型验收。','',
    '必过项：每次桥检测与内部原始检测经独立固定转换后完全一致；红球、蓝球、障碍、存放区均至少出现一次。应见检出与重复检测一致性仅报告。','',
    '| 运行目录 | observe | 完全一致 | 红球 | 蓝球 | 障碍 | 存放区 |','|---|---:|---:|---:|---:|---:|---:|'];
  for(const run of result.runs) text.push(`| \`${run.directory}\` | ${run.observations} | ${run.matchedObservations} | ${oracle.CATEGORIES.map(c=>run.outputCounts[c]).join(' | ')} |`);
  text.push('','独立转换复用 `tools/v4_stage1_content_audit.js`，不导入平台检测适配器：640×640 letterbox 框固定移除 80 像素上下边框并裁切，外观类别 target/distractor 映射为 red-ball/blue-ball；保留原始 source 和置信度。旧直立标牌不代表地面存放区，排除原因逐条保存；绿色区域使用独立地面像素检测输出。桥、内部规范化输出、原始检测、HTTP 调用、record 和相机帧逐条绑定。','',
    '| 类别 | 应见 | 对应类别检出 | 未检出 |','|---|---:|---:|---:|');
  for(const c of oracle.TRUTH_CATEGORIES) {const v=result.truthCounts[c];text.push(`| ${c} | ${v.expected} | ${v.detected} | ${v.misses} |`);}
  text.push('','应见范围：相机平面距离 30–85cm（含端点），绝对方位≤30°。统计单位为（帧，真值物体），检出只表示该帧有对应类别；同类多物体不声称已完成实例匹配。零应见类别明确表示本短脚本未验证该类召回，不另设门槛。','',
    `两次检测比较：${result.repeatDetectionReport.pairs.length} 对，完全相同 ${result.repeatDetectionReport.pairs.filter(row=>row.equal).length} 对；总体 ${result.repeatDetectionReport.equal?'相同':'有差异'}（只报告）。`,'',
    '每项数字可从 `gate.json` 的逐帧检测、投影映射和真值几何复算，原始压缩与解压文件 SHA256 均已核对。真值仅由此离线评测器读取。原有严格验收 FAIL 和诊断失败局保持不动。','',
    '复核：','', '```sh',`node tools/fresh_map05_platform_gate.js --inputs ${result.runs.map(r=>r.directory).join(',')} --out ${result.outputDirectory} --check`,'```','');
  return text.join('\n');
}

function main(argv=process.argv.slice(2)) {
  let input,output,platformRoot,check=false,preflightMode=null;
  for(let i=0;i<argv.length;i++) {
    if(argv[i]==='--check'){check=true;continue;}
    if(argv[i]==='--preflight-create'){preflightMode='create';continue;}
    if(argv[i]==='--preflight-check'){preflightMode='check';continue;}
    if(argv[i]==='--inputs') input=argv[++i];
    else if(argv[i]==='--out') output=argv[++i];
    else if(argv[i]==='--platform-root') platformRoot=path.resolve(argv[++i]);
    else throw new Error(`unsupported argument ${argv[i]}`);
  }
  if(preflightMode) {
    const value=preflightMode==='check'?verifyPreflightGate({platformRoot}):createPreflight({platformRoot});
    if(preflightMode==='create') {assert.ok(!fs.existsSync(PREFLIGHT),'refusing to overwrite preflight');write(PREFLIGHT,value);}
    console.log(JSON.stringify({preflight:preflightMode,allPass:value.allPass,observations:value.run.observations}));
    return value;
  }
  assert.ok(input&&output,'--inputs run1,run2 and --out are required');
  const dirs=input.split(',').map(d=>path.resolve(d));
  assert.equal(dirs.length,2,'exactly two runs required');
  assert.notEqual(dirs[0],dirs[1],'must be two independently saved runs');
  const runs=dirs.map(directory=>inspectRun(directory,{platformRoot})), totals=counts(), truth=truthCounts();
  for(const run of runs) {
    for(const c of oracle.CATEGORIES)totals[c]+=run.outputCounts[c];
    for(const c of oracle.TRUTH_CATEGORIES)for(const k of ['expected','detected','misses'])truth[c][k]+=run.truthCounts[c][k];
  }
  const pairs=Array.from({length:Math.max(...runs.map(r=>r.rows.length))},(_,index)=>{
    const left=runs[0].rows[index],right=runs[1].rows[index];
    return {index,leftFrameId:left?.frameId??null,rightFrameId:right?.frameId??null,
      leftTick:left?.tick??null,rightTick:right?.tick??null,equal:!!left&&!!right&&equal(left.detections,right.detections),
      difference:oracle.difference(left?.detections??null,right?.detections??null)};
  });
  const out=path.resolve(output);
  const result={schema:VERSION,evaluationOnly:true,diagnosticInputs:true,autonomousTaskAcceptance:false,
    outputDirectory:rel(out),reviewer:{file:rel(__filename),sha256:sha(fs.readFileSync(__filename)),
      oracleFile:'tools/v4_stage1_content_audit.js',oracleSha256:sha(fs.readFileSync(path.join(__dirname,'v4_stage1_content_audit.js')))},
    runs,totalCounts:totals,truthCounts:truth,repeatDetectionReport:{gate:false,equal:pairs.every(p=>p.equal),pairs},
    samePlatformSources:equal(runs[0].platform,runs[1].platform),
    sameBrainSources:equal(runs[0].brainSource,runs[1].brainSource),
    gates:{bridgeInternalExact:runs.every(r=>r.gates.bridgeInternalExact),fourClassesSeen:runs.every(r=>r.gates.fourClassesSeen)},
    allPass:runs.every(r=>r.allPass)&&equal(runs[0].platform,runs[1].platform)};
  if(check) assert.deepEqual(result,read(path.join(out,'gate.json')));
  else {
    for(const name of ['gate.json','REPORT.md'])assert.ok(!fs.existsSync(path.join(out,name)),`refusing to overwrite ${name}`);
    fs.mkdirSync(out,{recursive:true});write(path.join(out,'gate.json'),result);fs.writeFileSync(path.join(out,'REPORT.md'),report(result));
  }
  console.log(JSON.stringify({allPass:result.allPass,observations:runs.map(r=>r.observations),counts:totals,truth,repeatEqual:result.repeatDetectionReport.equal}));
  process.exitCode=result.allPass?0:1;
  return result;
}
module.exports={VERSION,inspectRun,createPreflight,verifyPreflightGate,createPixelQualityPreflight,auditPixelQualityRun,report,main};
if(require.main===module) main();
