"use strict";
// Offline contract test. No browser, server, simulation, or camera is started.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { installVisionTruthCapture } = require("./vision_truth_hook.js");
const camera = { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 0.645, -3, 1] } };
let renders = 0, evidenceCalls = 0;
const objects = { holding: null, packages: [{ id: "red", role: "target", x: 2, z: 4 }] };
const nativeRecord = { runId: "mock-run", visionFrames: [] };
const context = {
  renderer: { render(...args) { renders++; assert.equal(this, context.renderer); return args.length; } },
  virtualCamera: camera, virtualCameraCanvas: {}, robotPose: { x: 7, z: -2.57, heading: 0 },
  deterministicSimulator: { tick: 17 },
  competitionSession: { status: "running", stateRevision: 2, recorder: { record: nativeRecord },
    packageStateEngine: { snapshot: () => objects } },
  addCompetitionVisionEvidence(canvas, frameId) {
    evidenceCalls++;
    if (frameId === -1) throw new Error("native error");
    const recorded = { evidenceId: `vision-${evidenceCalls}`, frameId, seq: evidenceCalls,
      tick: context.deterministicSimulator.tick, stateRevision: context.competitionSession.stateRevision,
      sha256: "native-image-hash", byteLength: 123 };
    nativeRecord.visionFrames.push(recorded);
    return recorded;
  }
};
vm.createContext(context);
assert.equal(vm.runInContext(`(${installVisionTruthCapture.toString()})()`, context).installed, true);
const renderReturn = context.renderer.render({}, camera);
assert.equal(renderReturn, 2);
assert.equal(renders, 1); // exactly the one caller-requested render
objects.packages[0].x = 99;
camera.matrixWorld.elements[12] = 99;
context.robotPose.heading = 1;
context.deterministicSimulator.tick = 18;
const nativeReturn = context.addCompetitionVisionEvidence(context.virtualCameraCanvas, 41);
assert.equal(evidenceCalls, 1);
assert.equal(nativeReturn, nativeRecord.visionFrames[0]); // return identity unchanged
assert.equal(nativeRecord.visionFrames.length, 1); // no diagnostic entry in native ledger
const truth = context.__wmDriverVisionTruth.frames[0];
assert.equal(truth.captureTick, 17);
assert.equal(truth.evidenceTick, 18);
assert.equal(truth.sameTickAndRevision, false); // completion-time tick never replaces render tick
assert.equal(truth.vehicle.heading, 0);
assert.equal(truth.camera.world[0], 7);
assert.equal(truth.objectState.packages[0].x, 2); // snapshots are detached from mutable objects
assert.equal(truth.frameId, 41);
assert.equal(truth.evidenceId, nativeReturn.evidenceId);
assert.equal(truth.imageSha256, nativeReturn.sha256);
context.renderer.render({}, {});
assert.equal(context.__wmDriverVisionTruth.renderCount, 1); // main view ignored
context.addCompetitionVisionEvidence(context.virtualCameraCanvas, 42);
assert.equal(context.__wmDriverVisionTruth.frames.length, 1); // cannot reuse the same render
assert.equal(context.__wmDriverVisionTruth.errors[0].phase, "evidence_binding");
assert.throws(() => context.addCompetitionVisionEvidence(context.virtualCameraCanvas, -1), /native error/);
context.renderer.render({}, camera);
context.addCompetitionVisionEvidence(context.virtualCameraCanvas, 43);
assert.equal(context.__wmDriverVisionTruth.frames[1].sameTickAndRevision, true);
console.log("PASS: original render/evidence preserved; exact capture pose; deep snapshot; run/frame/hash binding; no extra calls or native entries; reused render rejected");
