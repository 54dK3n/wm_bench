#!/usr/bin/env node
/* Native controller fixture calibration. No task map, robot program, or mock physics. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CORE = '/Users/ken/Desktop/robot_competition-main/projects/car-python/competition-core.js';
const DEFAULT_OUT = path.join(ROOT, 'artifacts/inloop/opt-2/controlled-calibration');
const SELF = path.resolve(__filename);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const canonical = value => JSON.stringify(value, (_key, val) => val && typeof val === 'object' && !Array.isArray(val)
  ? Object.fromEntries(Object.keys(val).sort().map(key => [key, val[key]])) : val);
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const turn = (a, b) => Math.abs(((b - a + 180) % 360 + 360) % 360 - 180);

// Frozen before any measurement: unweighted two-parameter OLS, no intercept,
// no robust weights, no residual pruning, and no coefficient substitution.
function fitAll(rows) {
  let dd = 0, da = 0, aa = 0, dt = 0, at = 0;
  for (const row of rows) {
    const d = row.actualDistanceCm, a = row.actualTurnDeg, t = row.elapsedTicks;
    dd += d*d; da += d*a; aa += a*a; dt += d*t; at += a*t;
  }
  const determinant = dd*aa - da*da;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return {valid:false, reason:'rank_deficient'};
  const a = (dt*aa-da*at)/determinant;
  const b = (dd*at-da*dt)/determinant;
  const residuals = rows.map(row => {
    const predictedTicks = a*row.actualDistanceCm+b*row.actualTurnDeg;
    return {id:row.id, predictedTicks, measuredTicks:row.elapsedTicks,
      relativeResidual:Math.abs(predictedTicks-row.elapsedTicks)/row.elapsedTicks};
  });
  return {valid:a>0 && b>=0, aTicksPerCm:a, bTicksPerDegree:b, kCmPerDegree:b/a,
    samples:rows.length, maxRelativeResidual:Math.max(...residuals.map(r=>r.relativeResidual)),
    allResidualsAtMost10pct:residuals.every(r=>r.relativeResidual<=0.1), residuals};
}

function prepare(coreFile, out) {
  assert(!fs.existsSync(path.join(out,'plan.json')), 'plan already exists; use a fresh --out directory');
  const rawFile = path.join(ROOT,'artifacts/inloop/opt-1/round-2/map-01.json');
  const recordFile = read(rawFile).fullRecordFile;
  const record = read(recordFile);
  // Copy ONLY public controller/configuration scalars; do not inspect samples,
  // interaction definitions, mission objects, task geometry, or scene targets.
  const simulation = {schemaVersion:record.simulationDefinition.schemaVersion,
    stepMs:record.simulationDefinition.stepMs, seed:record.simulationDefinition.seed,
    vehicle:record.simulationDefinition.vehicle};
  const rules = {unitsPerMeter:record.ruleDefinition.unitsPerMeter,
    navigationJunctionRadiusCm:record.ruleDefinition.navigationJunctionRadiusCm,
    vehicleRadius:record.ruleDefinition.vehicleRadius,
    speedingEnabled:false, wrongWayEnabled:false, redLightEnabled:false, prohibitedZonesEnabled:false,
    speedZones:[], trafficLights:[], prohibitedZones:[]};
  const core = require(coreFile);
  assert(typeof core.DeterministicSimulator==='function' && typeof core.NavigationActionRunner==='function', 'native constructors unavailable');
  // Competition public-road mode uses the official PUBLIC export, which
  // differs from the private default only in objectAnchorDisclosure.
  const navigationExport = canonical(core.PUBLIC_NAVIGATION_DEFINITION)===canonical(record.navigationDefinition)
    ? 'PUBLIC_NAVIGATION_DEFINITION' : 'NAVIGATION_DEFINITION';
  assert(canonical(core[navigationExport])===canonical(record.navigationDefinition), 'no official navigation contract matches recorded competition');
  assert(canonical(core.NAVIGATION_CONTROL_DEFINITION)===canonical(record.navigationControlDefinition), 'controller contract differs from recorded competition');
  const fixtures = {
    straight:{initialPose:{x:0,z:0,heading:0}, roads:[{id:'fixture-straight',width:2,points:[[0,24],[0,-24]]}]},
    junction:{initialPose:{x:0,z:0,heading:0}, roads:[
      {id:'fixture-south',width:2,points:[[0,16],[0,0]]},
      {id:'fixture-north',width:2,points:[[0,0],[0,-16]]},
      {id:'fixture-east',width:2,points:[[0,0],[16,0]]}], selectedExit:'fixture-north'}
  };
  const trials = [];
  for (const group of [0,45,90,180]) for (let repeat=1;repeat<=3;repeat++) {
    trials.push({id:`${group===0?'straight100':'turn'+group}-repeat${repeat}`,groupDeg:group,repeat,
      fixture:group===0?'straight':'junction',
      preparation:group===0?[]:[{kind:'turn_angle',direction:'right',angleDegrees:group}],
      method:group===0?'follow_road':'take_exit',
      args:group===0?{maxCm:100,speed:30,obeySpeedLimit:true}:{roadId:'fixture-north',speed:30,obeySpeedLimit:true}});
  }
  const plan = {schema:'p3-native-controller-fixture-plan/v1',frozenAtUtc:new Date().toISOString(),
    distinction:'Native DeterministicSimulator + NavigationActionRunner measurement fixture, NOT task1/task2 layout performance or hardware measurement',
    source:{coreFile,coreSha256:fileHash(coreFile),visionPixelCoreSha256:fileHash(path.join(path.dirname(coreFile),'vision-pixel-core.js')),
      runnerFile:SELF,runnerSha256:fileHash(SELF),navigationDefinitionExport:navigationExport,
      referencePublicConfigRecord:recordFile,referenceRecordSha256:fileHash(recordFile)},
    simulation,rules,world:{bounds:{minX:-32,maxX:32,minZ:-32,maxZ:32},colliders:[]},fixtures,trials,
    navigationDefinition:record.navigationDefinition,navigationControlDefinition:record.navigationControlDefinition,
    fit:{method:'unweighted OLS elapsedTicks=a*measuredDistanceCm+b*abs(measuredPublicHeadingDelta); no intercept; k=b/a',
      codeSha256:hash(fitAll.toString()), all12SamplesIncluded:true, residualLimit:0.1,
      residualDefinition:'abs(predictedTicks-measuredTicks)/measuredTicks; each sample <=10%; no row removal or tuning after results'},
    qualification:{speed:30,obeySpeedLimit:true,straight:'one follow_road100, accepted/max_distance, public measured100cm',
      turn:'public selected exit requested45/90/180, accepted/entered_road; fit uses actual public heading delta',
      exactPublicTickBoundaries:true,allStepsOnRoad:true,failedMeasurementsRetained:true,noRetry:true},
    repetitions:'Three independent simulator initializations per condition. Deterministic repetitions measure reproducibility, not independent physical layouts.',
    preparationPolicy:'Each fixture initialization and each native turn_angle alignment is logged; no preparation timing is counted as take_exit timing.',
    externalValidity:'Same core/vehicle/contracts as recorded competition; custom empty straight roads lack competition curves, speed-zone transitions, objects and complex entry paths. Historical118-row task diagnosis remains unchanged.'};
  fs.mkdirSync(out,{recursive:true}); save(path.join(out,'plan.json'),plan);
  save(path.join(out,'freeze.json'),{frozenAtUtc:plan.frozenAtUtc,planSha256:fileHash(path.join(out,'plan.json')),coreSha256:plan.source.coreSha256,
    runnerSha256:plan.source.runnerSha256,fitCodeSha256:plan.fit.codeSha256,measurementStarted:false});
  console.log(JSON.stringify({status:'plan_frozen_no_measurement',out,planSha256:fileHash(path.join(out,'plan.json')),trials:trials.length}));
}

function execute(coreFile,out) {
  const plan=read(path.join(out,'plan.json')),freeze=read(path.join(out,'freeze.json'));
  assert(!fs.existsSync(path.join(out,'measurements.json')), 'measurement output exists; refusing hidden rerun or overwrite');
  assert(fileHash(path.join(out,'plan.json'))===freeze.planSha256,'frozen plan changed');
  assert(fileHash(SELF)===plan.source.runnerSha256,'runner changed after freeze');
  assert(fileHash(coreFile)===plan.source.coreSha256,'native core changed after freeze');
  assert(hash(fitAll.toString())===plan.fit.codeSha256,'fit changed after freeze');
  const core=require(coreFile),rows=[],startUtc=new Date().toISOString();
  const nativeRun=core.NavigationActionRunner.prototype.run;
  fs.mkdirSync(path.join(out,'trials'),{recursive:true});
  for (const trial of plan.trials) {
    const fixture=plan.fixtures[trial.fixture],events=[],steps=[];
    const definition={...plan.simulation,initialPose:fixture.initialPose,world:plan.world};
    const simulator=new core.DeterministicSimulator(definition);
    const rules={...plan.rules,roads:fixture.roads};
    const topology=core.createNavigationTopologyContext(rules,plan.navigationDefinition);
    const runner=new core.NavigationActionRunner(simulator,{rules,navigationDefinition:plan.navigationDefinition,
      navigationControlDefinition:plan.navigationControlDefinition,roadTopology:topology});
    const odometry=()=>core.projectNavigationQuery('odometry',{pose:simulator.pose,initialPose:simulator.config.initialPose,
      distance:simulator.travelDistance,tick:simulator.tick,rules,navigationDefinition:plan.navigationDefinition});
    events.push({phase:'fixture_initialization',tick:simulator.tick,definition,publicOdometry:odometry(),roadState:runner.roadState()});
    for (const request of trial.preparation) {
      const before=odometry();simulator.startCommand(request);let count=0;
      while (simulator.hasActiveCommand()) {
        simulator.step();count++;
        steps.push({phase:'preparation',tick:simulator.tick,odometry:odometry(),onRoad:runner.roadState().onRoad});
      }
      events.push({phase:'preparation',request,before,after:odometry(),elapsedTicks:simulator.tick-before.tick,
        nativeStepCount:count,roadState:runner.roadState()});
    }
    const before=odometry(),beforeRoad=runner.roadState();
    const selected=trial.method==='take_exit'?beforeRoad.exits.find(e=>e.roadId===trial.args.roadId):null;
    const requestedTurn=selected?Math.abs(selected.turnDeg):0;
    const request={method:trial.method,args:trial.args};
    const result=runner.run(trial.method,trial.args,{beforeStep:command=>{
      events.push({phase:'measurement_controller_step',tick:simulator.tick,command});
    },onStep:()=>{steps.push({phase:'measurement',tick:simulator.tick,odometry:odometry(),onRoad:runner.roadState().onRoad});}});
    const after=odometry(),actualTurnDeg=turn(before.headingDeg,after.headingDeg);
    const row={id:trial.id,groupDeg:trial.groupDeg,repeat:trial.repeat,fixture:trial.fixture,request,requestedPublicExitTurnDeg:requestedTurn,
      result,before,after,actualDistanceCm:result.distanceCm,odometryDistanceCm:after.distanceCm-before.distanceCm,
      actualTurnDeg,elapsedTicks:result.elapsedTicks,nativeMeasurementStepCount:steps.filter(s=>s.phase==='measurement').length,
      preparationTicks:before.tick,allNativeStepsOnRoad:steps.every(s=>s.onRoad===true)};
    row.qualification={accepted:result.accepted===true,stopReason:result.stoppedBy===(trial.groupDeg===0?'max_distance':'entered_road'),
      requestedPublicTurnMatches:requestedTurn===trial.groupDeg,
      straightDistanceComplete:trial.groupDeg!==0 || (result.distanceCm===100 && row.odometryDistanceCm===100),
      exactPublicTicks:after.tick-before.tick===result.elapsedTicks && row.nativeMeasurementStepCount===result.elapsedTicks,
      allStepsOnRoad:row.allNativeStepsOnRoad};
    row.qualified=Object.values(row.qualification).every(Boolean);
    events.push({phase:'measurement_complete',request,result,before,after,roadStateBefore:beforeRoad,roadStateAfter:runner.roadState()});
    rows.push(row);save(path.join(out,'trials',trial.id+'.json'),{trial,events,steps,row});
    save(path.join(out,'progress.json'),{startedUtc:startUtc,completed:rows.map(r=>({id:r.id,qualified:r.qualified})),planned:plan.trials.length});
  }
  assert(core.NavigationActionRunner.prototype.run===nativeRun,'native controller modified during run');
  const fit=fitAll(rows); // All 12, including any protocol failures; never select a better subset.
  const allQualify=rows.length===12 && rows.every(r=>r.qualified);
  const checks={frozenSourceUnchanged:fileHash(coreFile)===plan.source.coreSha256,
    frozenRunnerUnchanged:fileHash(SELF)===plan.source.runnerSha256,frozenPlanUnchanged:fileHash(path.join(out,'plan.json'))===freeze.planSha256,
    sameNavigationContract:canonical(core[plan.source.navigationDefinitionExport])===canonical(plan.navigationDefinition),
    sameNavigationControlContract:canonical(core.NAVIGATION_CONTROL_DEFINITION)===canonical(plan.navigationControlDefinition),
    all12PlannedMeasurementsRetained:rows.length===plan.trials.length,allQualified:allQualify,
    allResidualsAtMost10pct:fit.valid && fit.allResidualsAtMost10pct};
  const report={schema:'p3-native-controller-fixture-measurement/v1',startedUtc:startUtc,finishedUtc:new Date().toISOString(),
    fixtureOnly:true,taskLayoutPerformanceRun:false,hardwareMeasurement:false,planSha256:freeze.planSha256,
    source:plan.source,checks,rows,fit,fixtureCalibrationPassed:Object.values(checks).every(Boolean),
    productionKAuthorized:false,externalValidity:plan.externalValidity,
    historicalTaskDiagnosis:path.join(ROOT,'artifacts/inloop/opt-2/calibration/calibration.json')};
  save(path.join(out,'measurements.json'),report);
  save(path.join(out,'calibration.json'),{schema:'p3-controlled-native-calibration/v1',all_pass:report.fixtureCalibrationPassed,
    k_cm_per_deg:report.fixtureCalibrationPassed?fit.kCmPerDegree:null,max_relative_residual:fit.maxRelativeResidual,
    samples:rows.length,source_sha256:plan.source.coreSha256,protocol_sha256:freeze.planSha256,
    fit_code_sha256:plan.fit.codeSha256,runner_sha256:plan.source.runnerSha256,
    scope:'native controller straight/junction fixture at speed30/obeySpeedLimit true; not task-layout performance or universal travel-time fit',
    external_validity:plan.externalValidity,measurements_sha256:fileHash(path.join(out,'measurements.json')),
    historical_task_diagnosis_preserved:report.historicalTaskDiagnosis});
  const residual=new Map(fit.residuals?.map(r=>[r.id,r])||[]);
  const md=['# 原生控制器夹具标定','',`夹具协议结果：${report.fixtureCalibrationPassed?'PASS':'FAIL'}；生产k授权：否。`,
    '', '这是直接运行平台原生 DeterministicSimulator / NavigationActionRunner 的人工直路与路口夹具，不是任务1/任务2布局批跑，也不是硬件测量。未mock物理或用速度公式生成测量数据。全部12次测量、原生逐tick轨迹和准备动作均保存。',
    '', '|实验|公开请求角°|实测净角°|距离cm|elapsedTicks|准备ticks|相对残差|资格|', '|---|---:|---:|---:|---:|---:|---:|---|'];
  for(const row of rows)md.push(`|${row.id}|${row.requestedPublicExitTurnDeg}|${row.actualTurnDeg}|${row.actualDistanceCm}|${row.elapsedTicks}|${row.preparationTicks}|${((residual.get(row.id)?.relativeResidual??NaN)*100).toFixed(4)}%|${row.qualified?'PASS':'FAIL'}|`);
  md.push('', `预先冻结无截距OLS：a=${fit.aTicksPerCm} ticks/cm；b=${fit.bTicksPerDegree} ticks/°；k=${fit.kCmPerDegree} cm/°。最大逐条相对残差=${(fit.maxRelativeResidual*100).toFixed(4)}%。没有按结果删样本。`,
    '', `核心 SHA256：${plan.source.coreSha256}；拟合代码 SHA256：${plan.fit.codeSha256}。plan.json/freeze.json记录了测量前冻结时间和源文件哈希。`,
    '', '实施等同性：使用相同核心文件/构造类、v6导航和v8控制合同；20ms步长、车体半径/碰撞皮肤/最大速度、单位比例及节点半径均来自已保存竞赛的公开配置。只替换为空直路/空路口几何、初始状态与无障碍世界，未替换控制器和物理步进。',
    '', '适用限制：夹具没有竞赛道路曲线、限速区切换、目标/障碍物和复杂路口进出路径；三次重复从相同夹具独立初始化，确定性相同不代表三独立真实场景。该k只在此控制协议下有测量支持，不能覆盖/推翻已有真实任务118条样本的超10%和不可行诊断，也不构成双球/目标选择性能通过。',
    '', '复跑到全新目录（禁止覆盖）：', '```sh', 'node tools/p3_native_calibration.js --prepare --out /private/tmp/p3-native-fresh', 'node tools/p3_native_calibration.js --run --out /private/tmp/p3-native-fresh', '```', '');
  fs.writeFileSync(path.join(out,'CONTROLLED_CALIBRATION.md'),md.join('\n'));
  console.log(JSON.stringify({out,fixtureCalibrationPassed:report.fixtureCalibrationPassed,productionKAuthorized:false,
    samples:rows.length,k:fit.kCmPerDegree,maxRelativeResidual:fit.maxRelativeResidual,checks}));
}

if(require.main===module){
  const args=process.argv.slice(2);const value=(flag,def)=>args.includes(flag)?args[args.indexOf(flag)+1]:def;
  const coreFile=path.resolve(value('--core',DEFAULT_CORE)),out=path.resolve(value('--out',DEFAULT_OUT));
  if(args.includes('--prepare'))prepare(coreFile,out);
  else if(args.includes('--run'))execute(coreFile,out);
  else throw new Error('choose --prepare (freeze without measuring) or --run (execute frozen native fixture)');
}
module.exports={fitAll};
