const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { DeterministicSimulator } = require("../competition-core.js");

const app = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
function functionSource(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(app);
  assert.ok(match, name);
  const end = app.indexOf("\n}", match.index);
  assert.ok(end > match.index, name + " end");
  return app.slice(match.index, end + 2);
}
function appRuntime(names, bindings) {
  const context = vm.createContext({ console, ...bindings });
  vm.runInContext(names.map(functionSource).join("\n"), context);
  return context;
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

// Reuse only the existing canvas fixture definitions, before its test cases.
// This loads the real pixel detector and complete vision.js into its own VM.
function visionRuntime(clock) {
  const fixture = fs.readFileSync(path.join(__dirname, "vision-runtime.test.js"), "utf8");
  const prefix = fixture.slice(0, fixture.indexOf('\ntest("'));
  class ClockDate extends Date { static now() { return clock.now(); } }
  return new Function("require", "__dirname", "Date", prefix
    + "\nreturn {runtime:createVisionRuntime(),paintBackground,paintCircle,virtualOptions};")
    (require, __dirname, ClockDate);
}

test("virtual run is fresh at tick zero and never reads wall time", async () => {
  let failWall = false;
  const { runtime, paintBackground, paintCircle, virtualOptions } = visionRuntime({ now() {
    if (failWall) throw new Error("wall time must not be read");
    return 999;
  } });
  const canvas = runtime.createCanvas();
  paintBackground(canvas);
  paintCircle(canvas, 320, 260, 60, [235, 35, 30, 255]);
  await runtime.vision.analyzeFrame(canvas, virtualOptions);
  runtime.vision.stop();
  runtime.vision.stop();
  let context = { tick: 0, stepMs: 20, stateRevision: 0, generation: 7 };
  runtime.vision.beginVirtualRun({ getContext: () => context });
  failWall = true;
  const first = await runtime.vision.analyzeFrame(canvas, virtualOptions);
  assert.equal(first.frameId, 1);
  assert.equal(first.updatedAt, 0);
  assert.equal(first.fresh, true);
  const detections = plain(runtime.vision.getDetections());
  runtime.vision.stop();
  const second = await runtime.vision.analyzeFrame(canvas, virtualOptions);
  assert.equal(second.frameId, 2, "stop must not consume run frame numbers");
  assert.deepEqual(plain(runtime.vision.getDetections()), detections.map(item => ({ ...item, frameId: 2 })));
  context = { ...context, tick: 1 };
  assert.equal(runtime.vision.getStatus().fresh, false);
  assert.equal((await runtime.vision.analyzeFrame(canvas, virtualOptions)).updatedAt, 20);
  context = { ...context, stateRevision: 1 };
  assert.equal(runtime.vision.getStatus().fresh, false);
  await runtime.vision.analyzeFrame(canvas, virtualOptions);
  context = { ...context, generation: 8 };
  assert.equal(runtime.vision.getStatus().fresh, false);
  runtime.vision.endVirtualRun();
  runtime.vision.beginVirtualRun({ getContext: () => ({ ...context, tick: 0 }) });
  assert.equal((await runtime.vision.analyzeFrame(canvas, virtualOptions)).frameId, 1);
});

test("virtual context rejects invalid time and revision rather than using wall time", () => {
  const { runtime } = visionRuntime({ now: () => 1 });
  assert.throws(() => runtime.vision.beginVirtualRun({}), /getContext/);
  for (const bad of [{ tick: -1 }, { stepMs: 0 }, { stateRevision: 0.5 }, { generation: null }]) {
    assert.throws(() => runtime.vision.beginVirtualRun({ getContext: () => ({
      tick: 0, stepMs: 20, stateRevision: 0, generation: 0, ...bad
    }) }), /context/);
  }
});

test("scene readiness follows the current generation and propagates resource failure", async () => {
  let resolveOld, resolveNew;
  const old = new Promise(resolve => { resolveOld = resolve; });
  const next = new Promise(resolve => { resolveNew = resolve; });
  const context = appRuntime(["ensureSimulationSceneReady"], {
    missionBuildGeneration: 1, simulationSceneReadyPromise: old
  });
  let done = false;
  const pending = context.ensureSimulationSceneReady().then(() => { done = true; });
  context.missionBuildGeneration = 2;
  context.simulationSceneReadyPromise = next;
  resolveOld();
  await Promise.resolve();
  assert.equal(done, false);
  resolveNew();
  await pending;
  assert.equal(done, true);
  context.simulationSceneReadyPromise = Promise.reject(new Error("texture failed"));
  await assert.rejects(context.ensureSimulationSceneReady(), /texture failed/);
});

function effectsBindings() {
  const ring = { rotation: {}, material: {}, scale: { value: 0, setScalar(value) { this.value = value; } } };
  return {
    goalPulseEffects: [{ ring, beacon: { material: {} }, glow: {} }],
    mazeSignalEffects: [{ phase: 0.4, ring: { rotation: {}, material: {} }, beam: { material: {} },
      core: { position: {}, rotation: {} } }],
    competitionTrafficLightVisuals: [], renderCompetitionHud() {},
    competitionSession: { status: "running", simulationDefinition: { stepMs: 20 } },
    deterministicSimulator: { tick: 25, config: { stepMs: 20 } },
    simulationVisionRunActive: true, robotBackendMode: false, virtualCameraGeneration: 4,
    performance: { now() { throw new Error("wall time consulted"); } }
  };
}

test("rAF wall timestamps do not change formal-run animated scene values", () => {
  const context = appRuntime(["simulationVisionContext", "simulationSceneElapsedMs", "animateSceneEffects", "animate"], {
    ...effectsBindings(), requestAnimationFrame() {}, targetRenderFps: () => 30,
    lastRenderAt: -Infinity, renderedFramesInWindow: 0, renderStatsWindowStartedAt: 0,
    renderedFps: 0, cameraMode: "orbit", sceneShadowDirty: false,
    renderer: { render() {} }, scene: {}, camera: {}
  });
  const snapshot = () => plain({ goal: context.goalPulseEffects, maze: context.mazeSignalEffects });
  context.animate(100);
  const first = snapshot();
  context.animate(999999);
  assert.deepEqual(snapshot(), first);
  context.deterministicSimulator.tick = 26;
  context.animate(1999999);
  assert.notDeepEqual(snapshot(), first);
});

function captureRuntime() {
  const calls = [];
  const robotPart = { visible: true };
  const target = { name: "target" };
  const camera = { name: "virtual" };
  const renderer = {
    shadowMap: { needsUpdate: false }, getRenderTarget: () => null,
    setRenderTarget(value) { calls.push(["target", value?.name ?? null]); },
    clear() { calls.push(["clear"]); },
    render() {
      assert.equal(this.shadowMap.needsUpdate, true);
      assert.equal(robotPart.visible, false);
      calls.push(["render"]);
    },
    readRenderTargetPixels(_target, _x, _y, _w, _h, out) { out.set([1,2,3,4,5,6,7,8]); }
  };
  let copied;
  const context = appRuntime(["captureVirtualCameraFrame", "ensureSimulationSceneReady", "simulationVisionContext", "simulationSceneElapsedMs"], {
    renderer, scene: { traverse() {}, updateMatrixWorld() { calls.push(["matrix"]); } },
    virtualCamera: camera, virtualCameraTarget: target,
    virtualCameraContext: { putImageData(data) { copied = [...data.data]; } },
    virtualCameraImageData: { data: new Uint8Array(8) }, virtualCameraPixels: new Uint8Array(8),
    VIRTUAL_CAMERA_WIDTH: 1, VIRTUAL_CAMERA_HEIGHT: 2, VIRTUAL_CAMERA_FOV: 60, VIRTUAL_PIXEL_CLASSES: [],
    virtualCameraCanvas: {}, virtualCameraGeneration: 5, simulationVisionRunActive: true,
    deterministicSimulator: { tick: 12, config: { stepMs: 20 } },
    competitionSession: { stateRevision: 2, simulationDefinition: { stepMs: 20 } },
    missionBuildGeneration: 2, simulationSceneReadyPromise: Promise.resolve(), navigationVisualPlayback: null,
    guangyangReliefRoot: { visible: false }, guangyangFlatMapPlane: { visible: true }, guangyangTerrainMesh: {},
    robotGroup: { children: [camera, robotPart] }, trajectoryLine: null, trajectoryHead: null,
    sceneShadowDirty: false, latestVirtualCameraFrameId: null,
    animateSceneEffects(time, milliseconds) { calls.push(["effects", time, milliseconds]); },
    updateVirtualCameraPose() { calls.push(["camera-matrix"]); },
    window: { CarVision: { async analyzeFrame() { calls.push(["analyze"]); return { frameId: 1 }; }, getDetections: () => [] } },
    addCompetitionVisionEvidence(_canvas, frameId, binding) { calls.push(["evidence", frameId, plain(binding)]); },
    renderTrainingVisionWorkbenchFrame() {}, clearTrainingVisionWorkbench() {}
  });
  return { context, calls, renderer, robotPart, copied: () => copied };
}

test("capture waits for resources and synchronizes effects, matrices, shadow before readback", async () => {
  const { context, calls, robotPart, copied } = captureRuntime();
  let ready;
  context.simulationSceneReadyPromise = new Promise(resolve => { ready = resolve; });
  const capture = context.captureVirtualCameraFrame();
  await Promise.resolve();
  assert.deepEqual(calls, []);
  ready();
  await capture;
  assert.deepEqual(calls.slice(0, 6), [["effects", .24, 240], ["matrix"], ["camera-matrix"],
    ["target", "target"], ["clear"], ["render"]]);
  assert.deepEqual(copied(), [5,6,7,8,1,2,3,4]);
  assert.equal(robotPart.visible, true);
  assert.equal(context.guangyangReliefRoot.visible, false);
  assert.equal(context.guangyangFlatMapPlane.visible, true);
  assert.deepEqual(calls.at(-1), ["evidence", 1, { tick: 12, stepMs: 20, stateRevision: 2, generation: 5 }]);
});

test("capture cannot bind changed state or a stale scene generation", async () => {
  const { context, calls } = captureRuntime();
  context.window.CarVision.analyzeFrame = async () => {
    context.competitionSession.stateRevision += 1;
    return { frameId: 1 };
  };
  await assert.rejects(context.captureVirtualCameraFrame(), /changed during/);
  assert.ok(!calls.some(call => call[0] === "evidence"));
  let ready;
  context.simulationSceneReadyPromise = new Promise(resolve => { ready = resolve; });
  const stale = context.captureVirtualCameraFrame();
  context.virtualCameraGeneration += 1;
  ready();
  assert.equal(await stale, null);
});

test("render failure restores visibility and the previous target without evidence", async () => {
  const { context, calls, renderer, robotPart } = captureRuntime();
  renderer.render = () => { throw new Error("GPU failure"); };
  await assert.rejects(context.captureVirtualCameraFrame(), /GPU failure/);
  assert.equal(robotPart.visible, true);
  assert.deepEqual(calls.at(-1), ["target", null]);
  assert.ok(!calls.some(call => call[0] === "evidence"));
});

function commandRuntime(backend) {
  const definition = { schemaVersion: "chenlong.simulation/v1", stepMs: 20, seed: 7,
    initialPose: { x: 0, z: 0, heading: 0 },
    vehicle: { version: "chenlong.vehicle/v1", radius: .2, collisionSkin: .01, maxLinearSpeed: 2, maxAngularSpeed: 4 },
    world: { bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5 }, colliders: [] } };
  const simulator = new DeterministicSimulator(definition);
  const records = [], sleeps = [];
  let wall = 1000;
  const context = appRuntime(["runDeterministicCommand"], {
    robotBackendMode: backend, stopRequested: false, pauseRequested: false,
    ensureDeterministicSimulator: () => simulator, simulationWorldDefinition: () => definition.world,
    competitionSession: { status: "running", addSimulationInput(command, detail) { records.push(["input", plain(command), plain(detail)]); } },
    performance: { now() { if (backend) throw new Error("backend read wall time"); wall += 7; return wall; } },
    sleep: async delay => { sleeps.push(delay); wall += delay; }, waitWhilePaused: async () => {},
    realtimeRun: { navigationDistance: 0 }, robotPose: {}, robotLinearSpeed: 0, robotSteering: 0,
    syncRobot() { records.push(["tick", simulator.tick, plain(simulator.compactSnapshot())]); },
    competitionTick(force) { records.push(["final", force, simulator.tick]); }, updateRobotTelemetry() {}
  });
  return { context, simulator, records, sleeps };
}

test("backend action loop preserves every physics step and sample without host sleeps", async () => {
  const backend = commandRuntime(true), paced = commandRuntime(false);
  assert.equal(backend.simulator.tick, 0);
  await Promise.resolve();
  assert.equal(backend.simulator.tick, 0, "idle time must not advance simulation");
  for (const command of [{ kind: "drive", direction: 1, speedPercent: 50, durationMs: 120 },
    { kind: "turn_angle", direction: "left", angleDegrees: 30 }, { kind: "wait", durationMs: 80 }]) {
    await backend.context.runDeterministicCommand(command);
    await paced.context.runDeterministicCommand(command);
  }
  assert.deepEqual(backend.records, paced.records);
  assert.deepEqual(backend.simulator.snapshot(), paced.simulator.snapshot());
  assert.deepEqual(backend.sleeps, []);
  assert.ok(paced.sleeps.length > 0);
});

test("gripper phases follow original 20ms wait ticks and settle deterministically", async () => {
  const trace = [], requests = [];
  const simulator = { tick: 9, config: { stepMs: 20 } };
  const context = appRuntime(["runInteractionAnimation", "queueInteractionAnimation", "applyInteractionAnimation",
    "animateGripper", "animateArmTo", "animateClawTo", "liftArmToCarryPosition"], {
    robotBackendMode: true, competitionSession: {}, interactionAnimationPlan: null,
    robotArm: { rotation: { x: 0 } }, robotClaw: { scale: { x: 1 } },
    ensureDeterministicSimulator: () => simulator, markSceneShadowDirty() {},
    performance: { now() { throw new Error("animation read wall time"); } },
    async runDeterministicCommand(command, onFrame) {
      requests.push(plain(command));
      for (let elapsed = 20; elapsed <= command.durationMs; elapsed += 20) {
        simulator.tick += 1;
        onFrame({ state: { tick: simulator.tick } });
        trace.push([elapsed, context.robotArm.rotation.x, context.robotClaw.scale.x]);
      }
    }
  });
  await context.runInteractionAnimation(() => context.animateGripper(true), 480);
  assert.deepEqual(requests, [{ kind: "wait", durationMs: 480 }]);
  assert.equal(trace.length, 24);
  assert.equal(trace[12][1], -.32);
  assert.equal(trace[12][2], 1);
  assert.equal(context.robotClaw.scale.x, .72);
  await context.runInteractionAnimation(context.liftArmToCarryPosition, 280);
  assert.equal(context.robotArm.rotation.x, 0);
  assert.equal(simulator.tick, 47);
});

test("formal timer cannot append records and lifecycle starts frame count before first sample", () => {
  const starter = functionSource("startCompetitionRun");
  assert.match(starter, /competitionSamplingIntervalId = competitionSession\.simulationDefinition\s*\? null/);
  assert.ok(starter.indexOf("await ensureSimulationSceneReady()") < starter.indexOf("let simulatorCore"));
  assert.ok(starter.indexOf("beginSimulationVisionRun()") < starter.indexOf("competitionTick(true)"));
  const definitions = ["setRobotBackendMode", "beginSimulationVisionRun", "endSimulationVisionRun"];
  const events = [];
  const context = appRuntime(definitions, {
    running: false, competitionSession: null, robotBackendMode: false, simulationVisionRunActive: false,
    packageIdCounter: 8, lastRobotTelemetryAt: 99999,
    virtualCameraGeneration: 2, virtualCameraCapturePromise: null, latestVirtualCameraFrameId: null,
    invalidateVirtualCameraFrame() { events.push("invalidate"); }, simulationVisionContext: () => ({}),
    window: { CarVision: { beginVirtualRun() { events.push("begin"); }, endVirtualRun() { events.push("end"); } } }
  });
  assert.equal(context.setRobotBackendMode(true), true);
  context.beginSimulationVisionRun();
  assert.equal(context.packageIdCounter, 0);
  assert.equal(context.lastRobotTelemetryAt, -Infinity);
  context.running = true;
  assert.throws(() => context.setRobotBackendMode(false), /during a run/);
  context.endSimulationVisionRun();
  context.endSimulationVisionRun();
  assert.deepEqual(events, ["invalidate", "begin", "end"]);
});

test("backend fallback package IDs and telemetry/vision timestamps never consult wall time", () => {
  let evaluated = 0, telemetry = 0;
  const wallFailure = () => { throw new Error("backend used wall time"); };
  const context = appRuntime(["createPackageId", "readVisionObjects", "updateRobotTelemetry"], {
    robotBackendMode: true, simulationVisionRunActive: true, packageIdCounter: 0,
    Date: { now: wallFailure }, performance: { now: wallFailure },
    simulationSceneElapsedMs: () => 100, lastRobotTelemetryAt: -Infinity,
    ROBOT_TELEMETRY_INTERVAL_MS: 80, targetSelect: { value: "sim" },
    getVisionSnapshot: () => ({ objects: [{ confidence: 1, source: "virtual-cv", capturedAt: 100 },
      { confidence: .2, source: "virtual-cv", capturedAt: 100 }] }),
    frontDistance: () => 5, updateDistance() { telemetry += 1; }, updateRobotState() {},
    missionAttempt: { spec: { type: "composite" } }, evaluateMissionProgress() { evaluated += 1; }
  });
  assert.equal(context.createPackageId(), "package-1");
  assert.equal(context.createPackageId(), "package-2");
  assert.equal(context.readVisionObjects(.6).length, 1);
  context.updateRobotTelemetry();
  context.updateRobotTelemetry();
  assert.equal(telemetry, 1);
  assert.equal(evaluated, 1);
  assert.match(functionSource("evaluateMissionProgress"),
    /robotBackendMode \? simulationSceneElapsedMs\(\) : performance\.now\(\)/);
});
