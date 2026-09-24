'use strict';
// Reproducible offline contract test: node tools/test_demo_keyframes_hook.js
// Uses only a VM mock; no server, browser, camera or simulator is started.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {installDemoKeyframesCapture} = require('./demo_keyframes_hook.js');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGD8AAAAASUVORK5CYII=';
const byteLength = Buffer.from(png,'base64').length;
let renders=0, reads=0;
const objects={holding:'red',packages:[{id:'red',role:'target',x:1,z:2}]};
const record={runId:'one',taskId:'R2-GYI-MVP-02',inputs:[],events:[],visionFrames:[]};
const ctx={camera:{matrixWorld:{elements:[1,0,0,0,0,1,0,0,0,0,1,0,3,4,5,1]}},cameraMode:'isometric',
  virtualCamera:{},robotPose:{x:1,z:2,heading:0},deterministicSimulator:{tick:40},
  competitionSession:{status:'running',stateRevision:1,recorder:{record},packageStateEngine:{snapshot:()=>objects}},
  renderer:{render(){assert.equal(this,ctx.renderer);renders++;return 17;},domElement:{width:1,height:1,toDataURL(){reads++;return 'data:image/png;base64,'+png;}}}};
vm.createContext(ctx);
assert.equal(vm.runInContext(`(${installDemoKeyframesCapture.toString()})()`,ctx).installed,true);
assert.equal(ctx.renderer.render({},ctx.camera),17);
assert.equal(reads,0);
record.inputs.push({seq:1,t:800,tick:40,type:'package_grab',stateRevision:1});
record.events.push({seq:2,t:800,type:'package_grabbed',accepted:true,packageId:'red',objectRole:'target',stateRevision:1});
const nativeBefore=JSON.stringify(record);
assert.equal(ctx.renderer.render({},ctx.virtualCamera),17);
assert.equal(reads,0);
ctx.deterministicSimulator.tick=43;
assert.equal(ctx.renderer.render({},ctx.camera),17);
const ledger=ctx.__wmDriverDemoKeyframes;
assert.equal(ledger.frames.length,1);
assert.equal(ledger.frames[0].eventTick,40);
assert.equal(ledger.frames[0].captureTick,43);
assert.equal(ledger.frames[0].tickDelta,3);
assert.equal(ledger.frames[0].sameTickAndRevision,false);
assert.equal(ledger.frames[0].byteLength,byteLength);
assert.equal(JSON.stringify(record),nativeBefore);
objects.packages[0].x=999;
ctx.camera.matrixWorld.elements[12]=999;
assert.equal(ledger.frames[0].objectState.packages[0].x,1);
assert.equal(ledger.frames[0].camera.world[0],3);
ctx.renderer.render({},ctx.camera);
assert.equal(reads,1);
// Successful delivery has no revision: bind exact preceding release input and capture even after completion.
record.inputs.push({seq:3,t:1000,tick:50,type:'package_release',stateRevision:2});
record.events.push({seq:4,t:1000,type:'package_released',accepted:true,packageId:'red',stateRevision:2});
record.events.push({seq:5,t:1000,type:'package_delivered',packageId:'red',objectRole:'target'});
ctx.competitionSession.status='completed';ctx.competitionSession.stateRevision=2;ctx.deterministicSimulator.tick=50;
ctx.renderer.render({},ctx.camera);
assert.equal(ledger.frames.length,2);assert.equal(ledger.frames[1].eventStateRevision,2);
assert.equal(ledger.frames[1].interactionInputSeq,3);assert.equal(ledger.frames[1].sameTickAndRevision,true);
record.events.push({seq:6,t:1020,type:'package_interaction_failed',accepted:false,packageId:'blue'});
ctx.renderer.render({},ctx.camera);assert.equal(reads,2);
// A missing exact input is an explicit failure, never replaced with a prior image.
record.events.push({seq:7,t:1040,type:'package_delivered',packageId:'missing',objectRole:'target'});
ctx.renderer.render({},ctx.camera);assert.equal(ledger.frames.length,2);
assert.equal(ledger.errors[0].eventSeq,7);assert.match(ledger.errors[0].message,/exact interaction input/);
// Stage 0 reports combined bytes; its native budget is unchanged and must not discard demo frames.
record.visionFrames.push({byteLength:20*1024*1024});
record.inputs.push({seq:8,t:1060,tick:53,type:'package_grab',stateRevision:3});
record.events.push({seq:9,t:1060,type:'package_grabbed',accepted:true,packageId:'blue',objectRole:'target',stateRevision:3});
ctx.deterministicSimulator.tick=53;ctx.competitionSession.stateRevision=3;
ctx.renderer.render({},ctx.camera);
assert.equal(ledger.frames.length,3);
assert.equal(record.visionFrames[0].byteLength,20*1024*1024);
assert.equal(ledger.budgetEnforcedOn,'native_vision_only');
// Duplicate successful grabs and distractor interactions must not create extra screenshots.
record.inputs.push({seq:10,t:1080,tick:54,type:'package_grab',stateRevision:4});
record.events.push({seq:11,t:1080,type:'package_grabbed',accepted:true,packageId:'blue',objectRole:'target',stateRevision:4});
record.events.push({seq:12,t:1080,type:'package_grabbed',accepted:true,packageId:'distractor',objectRole:'distractor',stateRevision:4});
ctx.deterministicSimulator.tick=54;ctx.competitionSession.stateRevision=4;
ctx.renderer.render({},ctx.camera);assert.equal(ledger.frames.length,3);
record.inputs.push({seq:13,t:1100,tick:55,type:'package_release',stateRevision:5});
record.events.push({seq:14,t:1100,type:'package_delivered',packageId:'blue',objectRole:'target'});
ctx.deterministicSimulator.tick=55;ctx.competitionSession.stateRevision=5;
ctx.renderer.render({},ctx.camera);assert.equal(ledger.frames.length,4);
assert.equal(ledger.screenshotBytes,4*byteLength);
assert.equal(renders,10); // exactly caller-requested render count, including virtual camera
// Native errors and return values are preserved.
const errContext={...ctx,renderer:{render(){throw new Error('native-error');},domElement:ctx.renderer.domElement}};
delete errContext.__wmDriverDemoKeyframes;
vm.createContext(errContext);vm.runInContext(`(${installDemoKeyframesCapture.toString()})()`,errContext);
assert.throws(()=>errContext.renderer.render({},errContext.camera),/native-error/);
console.log(JSON.stringify({pass:true,renderCalls:renders,captureReads:reads,retainedScreenshots:ledger.frames.length,
 cases:['no extra render/observe','virtual camera ignored','native record unchanged','post-event tick delta exact','deep detached snapshot','no duplicate event frame','completed delivery captured','failed grabs ignored','missing input explicit failure','stage0 combined PNG bytes reported without rejecting required screenshots','first success per target only; four images','native return/error preserved']}));
