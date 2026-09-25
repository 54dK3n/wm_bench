"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");

// Execute the production functions without starting the whole browser UI.
// Function boundaries are top-level declarations, not hand-copied clock logic.
function productionFunction(name) {
  const start = appSource.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.notEqual(start, -1, `missing production function ${name}`);
  const rest = appSource.slice(start);
  const next = rest.slice(1).search(/\n(?:async )?function \w+\(/);
  assert.notEqual(next, -1, `missing function boundary after ${name}`);
  return rest.slice(0, next + 1);
}

function checkpointSnapshot(signals) {
  return signals.map(signal => ({
    phase: signal.phase,
    ringRotation: signal.ring.rotation.z,
    ringOpacity: signal.ring.material.opacity,
    beamOpacity: signal.beam.material.opacity,
    coreHeight: signal.core.position.y,
    coreRotation: signal.core.rotation.y
  }));
}

function runtime({tick = 50, stepMs = 20, wallMs = 10000} = {}) {
  const signals = [0, 1, 2, 3].map(index => ({
    phase: index * 1.7,
    ring: {rotation: {}, material: {}},
    beam: {material: {}},
    core: {position: {}, rotation: {}}
  }));
  const rendered = [];
  const context = vm.createContext({
    deterministicSimulator: {tick, config: {stepMs}},
    competitionSession: null,
    simulationVisionRunActive: true,
    robotBackendMode: true,
    virtualCameraGeneration: 1,
    mazeSignalEffects: signals,
    goalPulseEffects: [],
    competitionTrafficLightVisuals: [],
    performance: {now: () => wallMs},
    Date: {now: () => wallMs},
    requestAnimationFrame() {},
    targetRenderFps: () => 60,
    lastRenderAt: -Infinity,
    renderedFramesInWindow: 0,
    renderStatsWindowStartedAt: 0,
    renderedFps: 0,
    cameraMode: "top",
    sceneShadowDirty: false,
    shadowUpdateCount: 0,
    scene: {traverse() {}, updateMatrixWorld() {}},
    camera: {},
    virtualCamera: {},
    virtualCameraTarget: {},
    virtualCameraContext: {putImageData() {}},
    virtualCameraPixels: new Uint8Array(4),
    virtualCameraImageData: {data: new Uint8Array(4)},
    virtualCameraCanvas: {},
    VIRTUAL_CAMERA_WIDTH: 1,
    VIRTUAL_CAMERA_HEIGHT: 1,
    VIRTUAL_CAMERA_FOV: 60,
    VIRTUAL_PIXEL_CLASSES: [],
    navigationVisualPlayback: null,
    guangyangReliefRoot: null,
    guangyangFlatMapPlane: null,
    guangyangTerrainMesh: null,
    robotGroup: {children: []},
    trajectoryLine: null,
    trajectoryHead: null,
    latestVirtualCameraFrameId: null,
    ensureSimulationSceneReady: async () => {},
    updateVirtualCameraPose() {},
    addCompetitionVisionEvidence() {},
    renderTrainingVisionWorkbenchFrame() {},
    window: {CarVision: {analyzeFrame: async () => ({frameId: 1})}},
    renderer: {
      shadowMap: {},
      getRenderTarget: () => null,
      setRenderTarget() {},
      clear() {},
      readRenderTargetPixels() {},
      render() { rendered.push(checkpointSnapshot(signals)); }
    }
  });
  for (const name of ["simulationVisionContext", "simulationSceneElapsedMs", "animateSceneEffects", "animate", "captureVirtualCameraFrame"]) {
    vm.runInContext(productionFunction(name), context, {filename: `app.js:${name}`});
  }
  return {context, signals, rendered};
}

test("checkpoint animation is identical at the same tick despite different wall clocks and rAF timestamps", () => {
  const first = runtime({wallMs: 10000});
  const second = runtime({wallMs: 9000000});
  vm.runInContext("animate(10000)", first.context);
  vm.runInContext("animate(9000000)", second.context);
  assert.equal(first.rendered.length, 1);
  assert.deepEqual(first.rendered, second.rendered);
  // At tick 50 and step 20 ms, simulation time is exactly one second.
  assert.equal(first.rendered[0][0].ringRotation, 0.55);
  assert.equal(first.rendered[0][0].coreRotation, 1.2);
  assert.equal(first.rendered[0][1].ringRotation, 2.25);
});

test("checkpoint animation advances with ticks, including a non-default simulation step", () => {
  const run = runtime({tick: 40, stepMs: 25});
  vm.runInContext("animate(10000)", run.context);
  const before = checkpointSnapshot(run.signals);
  run.context.deterministicSimulator.tick = 80;
  vm.runInContext("animate(10100)", run.context);
  const after = checkpointSnapshot(run.signals);
  assert.equal(before[0].ringRotation, 0.55);
  assert.equal(after[0].ringRotation, 1.1);
  assert.equal(after[0].coreRotation, 2.4);
  assert.notEqual(after[0].coreHeight, before[0].coreHeight);
  assert.notEqual(after[0].ringOpacity, before[0].ringOpacity);
  assert.notEqual(after[0].beamOpacity, before[0].beamOpacity);
});

test("camera capture restores checkpoint tick phase before rendering, independent of prior UI renders", async () => {
  const first = runtime({wallMs: 1});
  const second = runtime({wallMs: 9999999});
  // Arbitrary prior visual phases must not contaminate sensor evidence.
  vm.runInContext("animateSceneEffects(4, 4000)", first.context);
  vm.runInContext("animateSceneEffects(91, 91000)", second.context);
  assert.notDeepEqual(checkpointSnapshot(first.signals), checkpointSnapshot(second.signals));
  const forbidWallClock = () => { throw new Error("sensor capture must not read the wall clock"); };
  for (const run of [first, second]) {
    run.context.performance.now = forbidWallClock;
    run.context.Date.now = forbidWallClock;
    await vm.runInContext("captureVirtualCameraFrame()", run.context);
  }
  assert.equal(first.rendered.length, 1);
  assert.deepEqual(first.rendered, second.rendered);
  assert.equal(first.rendered[0][0].ringRotation, 0.55);
  first.context.deterministicSimulator.tick = 100;
  await vm.runInContext("captureVirtualCameraFrame()", first.context);
  assert.equal(first.rendered[1][0].ringRotation, 1.1);
  assert.notDeepEqual(first.rendered[0], first.rendered[1]);
});
