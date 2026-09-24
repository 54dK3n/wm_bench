const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

const {
  SCHEMA_VERSION,
  DETERMINISTIC_LEGACY_SCHEMA_VERSION,
  LEGACY_SCHEMA_VERSION,
  SIMULATION_SCHEMA_VERSION,
  VEHICLE_MODEL_VERSION,
  LEGACY_INTERACTION_SCHEMA_VERSION,
  INTERACTION_SCHEMA_VERSION,
  TASK_SCHEMA_VERSION,
  ROAD_CLEARANCE_TASK_SCHEMA_VERSION,
  VISION_EVIDENCE_SCHEMA_VERSION,
  CAMERA_DEFINITION_HASH,
  DETECTOR_DEFINITION_HASH,
  VISION_DEFINITION,
  NAVIGATION_DEFINITION,
  NAVIGATION_CONTROL_DEFINITION,
  CompetitionSession,
  DeterministicSimulator,
  PackageStateEngine,
  ReplayPlayer,
  RunRecorder,
  SeededRandom,
  normalizeInteractionDefinition,
  normalizeVisionDefinition,
  normalizeVisionEvidence,
  normalizeSimulationDefinition,
  rejudgeTask
} = require("../competition-core.js");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeDefinition(overrides = {}) {
  const definition = {
    schemaVersion: "chenlong.simulation/v1",
    stepMs: 20,
    seed: 0x12345678,
    initialPose: { x: 0, z: 0, heading: -Math.PI / 2 },
    vehicle: {
      version: "chenlong.vehicle/v1",
      radius: 0.2,
      collisionSkin: 0.01,
      maxLinearSpeed: 2,
      maxAngularSpeed: 4
    },
    world: {
      bounds: { minX: -5, maxX: 5, minZ: -3, maxZ: 3 },
      colliders: []
    }
  };
  return {
    ...definition,
    ...overrides,
    initialPose: { ...definition.initialPose, ...(overrides.initialPose || {}) },
    vehicle: { ...definition.vehicle, ...(overrides.vehicle || {}) },
    world: {
      ...definition.world,
      ...(overrides.world || {}),
      bounds: { ...definition.world.bounds, ...(overrides.world?.bounds || {}) },
      colliders: overrides.world?.colliders ? clone(overrides.world.colliders) : []
    }
  };
}

function poseOf(frame) {
  return frame?.pose || frame || {};
}

function tickOf(frame, stepMs = 20) {
  if (Number.isInteger(frame?.tick)) return frame.tick;
  const elapsedMs = Number(frame?.elapsedMs ?? frame?.t);
  return Math.round(elapsedMs / stepMs);
}

function elapsedOf(frame, stepMs = 20) {
  return Number(frame?.elapsedMs ?? frame?.t ?? tickOf(frame, stepMs) * stepMs);
}

function trajectorySignature(frames, stepMs = 20) {
  return frames.map(frame => {
    const pose = poseOf(frame);
    return {
      tick: tickOf(frame, stepMs),
      t: elapsedOf(frame, stepMs),
      x: Number(pose.x),
      z: Number(pose.z),
      heading: Number(pose.heading),
      linearSpeed: Number(frame.linearSpeed ?? frame.speed ?? 0),
      angularSpeed: Number(frame.angularSpeed ?? frame.steering ?? 0)
    };
  });
}

function commandSequence() {
  return [
    { kind: "drive", direction: 1, speedPercent: 50, durationMs: 500 },
    { kind: "turn_angle", direction: "left", angleDegrees: 90, durationMs: 500 },
    { kind: "drive", direction: 1, speedPercent: 50, durationMs: 500 }
  ];
}

function sampleFromFrame(frame, seq, stepMs) {
  const pose = poseOf(frame);
  return {
    seq,
    simulationTick: tickOf(frame, stepMs),
    t: elapsedOf(frame, stepMs),
    x: Number(pose.x),
    z: Number(pose.z),
    heading: Number(pose.heading),
    speed: Math.abs(Number(frame.linearSpeed ?? frame.speed ?? 0)),
    steering: Number(frame.angularSpeed ?? frame.steering ?? 0),
    holding: null,
    cameraFrameId: null
  };
}

function buildLiveRecord(definition, commands = commandSequence()) {
  const simulator = new DeterministicSimulator(definition);
  const samples = [];
  const inputs = [];
  let seq = 0;
  let trajectoryLength = 0;

  const appendNewFrames = () => {
    const trajectory = simulator.trajectory();
    trajectory.slice(trajectoryLength).forEach(frame => samples.push(sampleFromFrame(frame, ++seq, definition.stepMs)));
    trajectoryLength = trajectory.length;
  };
  appendNewFrames();

  commands.forEach(command => {
    const startState = simulator.snapshot();
    inputs.push({
      seq: ++seq,
      t: startState.elapsedMs,
      tick: startState.tick,
      type: "control",
      command: clone(command),
      world: clone(definition.world),
      startState: clone(startState),
      source: "python"
    });
    simulator.runCommand(command);
    appendNewFrames();
  });

  const finalPose = simulator.snapshot().pose;
  const taskDefinition = {
    id: "deterministic-reach",
    version: "1",
    type: "reach",
    goal: [finalPose.x, finalPose.z],
    goalRadius: 0.02
  };
  const taskReplay = rejudgeTask(taskDefinition, samples);
  assert.equal(taskReplay.state.finished, true, "the live fixture must finish its reach task");

  const record = {
    schemaVersion: DETERMINISTIC_LEGACY_SCHEMA_VERSION,
    runId: "run-deterministic-fixture",
    teamId: "test-team",
    taskId: taskDefinition.id,
    mapId: "deterministic-map",
    mapVersion: "1",
    ruleVersion: "1",
    taskDefinition,
    ruleDefinition: {
      vehicleRadius: definition.vehicle.radius,
      roads: [{ id: "wide-road", width: 8, points: [[-4, 0], [4, 0]] }]
    },
    scoringDefinition: {},
    simulationDefinition: clone(definition),
    randomSeed: definition.seed,
    sourceCode: "robot.forward(...)",
    clientStartedAt: "2026-01-01T00:00:00.000Z",
    clientEndedAt: "2026-01-01T00:00:01.500Z",
    inputs,
    samples,
    events: [],
    result: {
      score: 42,
      taskScore: 25,
      reason: "completed",
      taskFinished: true
    }
  };
  return { simulator, record, taskReplay };
}

const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngSha256(pngBase64 = ONE_PIXEL_PNG_BASE64) {
  return createHash("sha256").update(Buffer.from(pngBase64, "base64")).digest("hex");
}

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngWithDimensions(width, height) {
  const bytes = Buffer.from(ONE_PIXEL_PNG_BASE64, "base64");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(pngCrc32(bytes.subarray(12, 29)), 29);
  return bytes.toString("base64");
}

function pngWithTamperedIdat() {
  const bytes = Buffer.from(ONE_PIXEL_PNG_BASE64, "base64");
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    if (type === "IDAT") {
      bytes[dataStart] ^= 1;
      bytes.writeUInt32BE(pngCrc32(bytes.subarray(offset + 4, crcOffset)), crcOffset);
      return bytes.toString("base64");
    }
    offset = crcOffset + 4;
  }
  throw new Error("fixture PNG has no IDAT chunk");
}

function makeV4DeliveryRecord({ releaseTick = 10, timeLimitTicks = 11, manual = false } = {}) {
  const simulationDefinition = makeDefinition({
    initialPose: { x: 0, z: 0, heading: -Math.PI / 2 },
    world: { bounds: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 }, colliders: [] }
  });
  const interactionDefinition = {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    bounds: clone(simulationDefinition.world.bounds),
    packageRadius: 0.2,
    grab: { minForward: 0.1, maxForward: 1.2, maxLateral: 0.25, maxDistance: 1.2 },
    release: { forwardOffset: 1, lateralOffset: 0, stackSnapDistance: 0.1 },
    packages: [
      { id: "box-a", role: "target", x: 0.8, z: 0, stackLevel: 0 },
      { id: "decoy-a", role: "distractor", x: -1, z: 0, stackLevel: 0 },
      { id: "barrier-a", role: "obstacle", x: 0, z: 1, stackLevel: 0 }
    ]
  };
  const taskDefinition = {
    id: "v4-delivery",
    version: "1",
    type: "delivery",
    goal: [1, 0],
    deliveryRadius: 0.05,
    requiredPackageIds: ["box-a"]
  };
  const ruleDefinition = {
    vehicleRadius: simulationDefinition.vehicle.radius,
    roads: [{ id: "wide-road", width: 4, points: [[-2, 0], [2, 0]] }],
    trafficLights: [],
    speedZones: [],
    prohibitedZones: []
  };
  const scoringDefinition = {
    efficiency: { targetSeconds: 1, maxSeconds: 2 },
    autonomous: { penaltyPerIntervention: 3 }
  };
  let nextSequence = 1;
  const events = [
    { seq: nextSequence++, t: 0, type: "run_started" }
  ];
  const initialSampleSequence = nextSequence++;
  const inputs = [
    { seq: nextSequence++, t: 0, tick: 0, type: "package_grab", intent: {}, stateRevision: 1 }
  ];
  events.push({
    seq: nextSequence++,
    t: 0,
    type: "package_grabbed",
    interactionType: "package_grab",
    accepted: true,
    reason: "grabbed",
    packageId: "box-a",
    objectRole: "target",
    position: [0.8, 0],
    stackLevel: 0
  });
  if (manual) {
    inputs.push({
      seq: nextSequence++,
      t: Math.min(5, releaseTick) * simulationDefinition.stepMs,
      tick: Math.min(5, releaseTick),
      type: "manual_control",
      action: "manual_pause",
      stateRevision: 2
    });
    events.push({
      seq: nextSequence++,
      t: Math.min(5, releaseTick) * simulationDefinition.stepMs,
      type: "manual_control",
      action: "manual_pause"
    });
  }
  inputs.push({
    seq: nextSequence++,
    t: releaseTick * simulationDefinition.stepMs,
    tick: releaseTick,
    type: "package_release",
    intent: {},
    stateRevision: manual ? 3 : 2
  });
  const completionTime = releaseTick * simulationDefinition.stepMs;
  const completedBeforeLimit = releaseTick < timeLimitTicks;
  const autonomousScore = manual ? 7 : 10;
  if (completedBeforeLimit) {
    events.push({
      seq: nextSequence++,
      t: completionTime,
      type: "package_released",
      interactionType: "package_release",
      accepted: true,
      reason: "released",
      packageId: "box-a",
      objectRole: "target",
      position: [1, 0],
      stackLevel: 0
    });
  }
  const finalSampleSequence = nextSequence++;
  if (completedBeforeLimit) {
    events.push(
      { seq: nextSequence++, t: completionTime, type: "package_delivered", packageId: "box-a" },
      { seq: nextSequence++, t: completionTime, type: "task_completed", completed: 1, total: 1 }
    );
  }
  events.push({
    seq: nextSequence++,
    t: completionTime,
    type: "run_finished",
    reason: completedBeforeLimit ? "completed" : "timeout",
    score: completedBeforeLimit ? 50 + autonomousScore : 15 + autonomousScore
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    runDefinition: {
      simulationDefinition: clone(simulationDefinition),
      interactionDefinition: clone(interactionDefinition),
      taskDefinition: clone(taskDefinition),
      ruleDefinition: clone(ruleDefinition),
      scoringDefinition: clone(scoringDefinition),
      timeLimitTicks
    },
    randomSeed: simulationDefinition.seed,
    simulationEndTick: releaseTick,
    inputs,
    visionFrames: [],
    samples: [
      {
        seq: initialSampleSequence,
        tick: 0,
        t: 0,
        x: 0,
        z: 0,
        heading: -Math.PI / 2,
        speed: 0,
        steering: 0,
        holding: null,
        cameraFrameId: null,
        packages: [
          { id: "barrier-a", role: "obstacle", x: 0, z: 1, stackLevel: 0 },
          { id: "box-a", role: "target", x: 0.8, z: 0, stackLevel: 0 },
          { id: "decoy-a", role: "distractor", x: -1, z: 0, stackLevel: 0 }
        ]
      },
      {
        seq: finalSampleSequence,
        tick: releaseTick,
        t: completionTime,
        x: 0,
        z: 0,
        heading: -Math.PI / 2,
        speed: 0,
        steering: 0,
        holding: completedBeforeLimit ? null : "box-a",
        cameraFrameId: null,
        packages: [
          { id: "barrier-a", role: "obstacle", x: 0, z: 1, stackLevel: 0 },
          { id: "box-a", role: "target", x: completedBeforeLimit ? 1 : 0.8, z: 0, stackLevel: 0 },
          { id: "decoy-a", role: "distractor", x: -1, z: 0, stackLevel: 0 }
        ]
      }
    ],
    events,
    result: {
      score: completedBeforeLimit ? 50 + autonomousScore : 15 + autonomousScore,
      taskScore: completedBeforeLimit ? 25 : 0,
      ruleScore: 15,
      autonomousScore,
      efficiencyScore: completedBeforeLimit ? 10 : 0,
      taskFinished: completedBeforeLimit,
      reason: completedBeforeLimit ? "completed" : "timeout",
      simulationTick: releaseTick
    }
  };
}

function makeLiveV4CompositeRecord() {
  const simulationDefinition = makeDefinition({
    initialPose: { x: 0, z: 0, heading: 0 },
    world: { bounds: { minX: -3, maxX: 3, minZ: -3, maxZ: 3 }, colliders: [] }
  });
  const interactionDefinition = {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    bounds: clone(simulationDefinition.world.bounds),
    packageRadius: 0.28,
    grab: { minForward: 0.1, maxForward: 1.2, maxLateral: 0.25, maxDistance: 1.2 },
    release: { forwardOffset: 1.5, lateralOffset: 0, stackSnapDistance: 0.1 },
    packages: [
      { id: "target-a", role: "target", radius: 0.28, x: 0, z: -0.8, stackLevel: 0 },
      { id: "decoy-a", role: "distractor", radius: 0.28, x: -0.8, z: 0, stackLevel: 0 },
      { id: "barrier-a", role: "obstacle", radius: 0.52, x: 0, z: -1.5, stackLevel: 0 }
    ]
  };
  const taskDefinition = {
    schemaVersion: TASK_SCHEMA_VERSION,
    id: "v4-island-composite",
    version: "2",
    type: "composite",
    checkpointRadius: 0.001,
    goalRadius: 0.001,
    checkpoints: [
      { id: "checkpoint-a", position: [0.25, 0] },
      { id: "checkpoint-b", position: [0.5, 0] }
    ],
    goal: [0, 0],
    deliveries: [
      {
        id: "target-storage",
        objectRole: "target",
        destinationRole: "storage",
        destination: [-1.5, 0],
        radius: 0.05,
        requiredPackageIds: ["target-a"]
      },
      {
        id: "distractor-cleanup",
        objectRole: "distractor",
        destinationRole: "cleanup",
        destination: [1.5, 0],
        radius: 0.05,
        requiredPackageIds: ["decoy-a"]
      }
    ]
  };
  const ruleDefinition = {
    vehicleRadius: simulationDefinition.vehicle.radius,
    roads: [{ id: "wide-route", width: 4, points: [[-2, 0], [2, 0]] }],
    trafficLights: [],
    speedZones: [],
    prohibitedZones: []
  };
  const scoringDefinition = {
    efficiency: { targetSeconds: 10, maxSeconds: 20 },
    autonomous: { penaltyPerIntervention: 3 }
  };
  const simulator = new DeterministicSimulator(simulationDefinition);
  const session = new CompetitionSession({
    taskId: taskDefinition.id,
    mapId: "composite-map",
    mapVersion: "2",
    ruleVersion: "2",
    timeLimitSeconds: 6,
    task: clone(taskDefinition),
    rules: clone(ruleDefinition),
    scoring: clone(scoringDefinition)
  }, {
    runId: "v4-live-composite-run",
    simulationDefinition: clone(simulationDefinition),
    interactionDefinition: clone(interactionDefinition),
    randomSeed: simulationDefinition.seed
  }, { sampleIntervalMs: simulationDefinition.stepMs });

  const sampleState = (frame = simulator.snapshot(), forceRecord = true) => {
    const pose = frame.pose || frame.state?.pose || frame;
    const tick = frame.tick ?? frame.state?.tick;
    return session.sample({
      tick,
      x: pose.x,
      z: pose.z,
      heading: pose.heading,
      speed: Math.abs(Number(frame.linearSpeed ?? 0)),
      steering: Number(frame.angularSpeed ?? 0)
    }, { forceRecord });
  };
  const runCommand = command => {
    const started = simulator.startCommand(command);
    session.addSimulationInput(started.command, {
      tick: started.startState.tick,
      startState: started.startState,
      source: "python"
    });
    while (simulator.hasActiveCommand()) sampleState(simulator.step());
  };
  const interact = (kind, { sample = true } = {}) => {
    const outcome = session.addInteractionInput(kind, { tick: simulator.tick, source: "python" });
    if (sample) sampleState(simulator.snapshot());
    return outcome;
  };

  sampleState(simulator.snapshot());
  assert.equal(interact("package_grab").packageId, "target-a");
  const blocked = interact("package_release");
  assert.deepEqual(
    { accepted: blocked.accepted, reason: blocked.reason, obstacleId: blocked.obstacleId },
    { accepted: false, reason: "blocked", obstacleId: "barrier-a" }
  );
  assert.equal(session.packageStateEngine.snapshot().holding, "target-a");

  runCommand({ kind: "turn_angle", direction: "left", angleDegrees: 90, durationMs: 400 });
  assert.equal(interact("package_release", { sample: false }).accepted, true);
  assert.deepEqual(session.taskEngine.snapshot().deliveredPackageIds, ["target-a"],
    "live placement must be judged at the typed interaction phase before a later telemetry sample");
  assert.equal(interact("package_grab").packageId, "decoy-a");
  runCommand({ kind: "turn_angle", direction: "left", angleDegrees: 180, durationMs: 800 });
  assert.equal(interact("package_release", { sample: false }).accepted, true);
  assert.deepEqual(session.taskEngine.snapshot().deliveredPackageIds, ["target-a", "decoy-a"]);
  runCommand({ kind: "drive", direction: 1, speedPercent: 25, durationMs: 1000 });
  runCommand({ kind: "turn_angle", direction: "left", angleDegrees: 180, durationMs: 800 });
  runCommand({ kind: "drive", direction: 1, speedPercent: 25, durationMs: 1000 });

  const record = session.finalRecord || session.finish("program_finished");
  assert.equal(record.result.reason, "completed", "the live composite fixture must finish all objectives");
  return { record, session, simulationDefinition, interactionDefinition, taskDefinition, ruleDefinition };
}

function makeLiveSpeedingRecord(ruleVersion = "2026.08-configurable.5") {
  const simulationDefinition = makeDefinition({ vehicle: { maxLinearSpeed: 2 } });
  const simulator = new DeterministicSimulator(simulationDefinition);
  const session = new CompetitionSession({
    taskId: "fixed-step-speeding",
    mapId: "fixed-step-map",
    mapVersion: "1",
    ruleVersion,
    timeLimitSeconds: 2,
    task: { id: "unreached-goal", type: "reach", goal: [4, 0], goalRadius: 0.05 },
    rules: {
      vehicleRadius: simulationDefinition.vehicle.radius,
      roads: [{ id: "limited-road", width: 4, speedLimit: 0.75, points: [[-2, 0], [5, 0]] }]
    },
    scoring: { penalties: { speeding: 1 } }
  }, {
    runId: `fixed-step-speeding-${ruleVersion}`,
    simulationDefinition,
    randomSeed: simulationDefinition.seed
  }, { sampleIntervalMs: 100 });
  const sampleState = (tick, pose, speed = 0, steering = 0, options = {}) => session.sample({
    tick,
    x: pose.x,
    z: pose.z,
    heading: pose.heading,
    speed: Math.abs(speed),
    steering
  }, options);
  const initial = simulator.snapshot();
  sampleState(initial.tick, initial.pose, 0, 0, { forceRecord: true });
  const started = simulator.startCommand({
    kind: "drive",
    direction: 1,
    speedPercent: 50,
    durationMs: 200
  });
  session.addSimulationInput(started.command, {
    tick: started.startState.tick,
    startState: started.startState,
    source: "python"
  });
  while (simulator.hasActiveCommand()) {
    const frame = simulator.step();
    sampleState(frame.state.tick, frame.state.pose, frame.linearSpeed, frame.angularSpeed);
  }
  return session.finish("program_finished");
}

function makeLiveCollisionRecord() {
  const simulationDefinition = makeDefinition({
    vehicle: { maxLinearSpeed: 1 },
    world: { colliders: [{ id: "ball-stop", type: "circle", x: 0.5, z: 0, radius: 0.1 }] }
  });
  const simulator = new DeterministicSimulator(simulationDefinition);
  const session = new CompetitionSession({
    taskId: "fixed-step-collision",
    mapId: "fixed-step-map",
    mapVersion: "1",
    ruleVersion: "2026.08-configurable.5",
    timeLimitSeconds: 2,
    task: { id: "unreached-goal", type: "reach", goal: [4, 0], goalRadius: 0.01 },
    rules: {
      vehicleRadius: simulationDefinition.vehicle.radius,
      roads: [{ id: "wide-road", width: 4, points: [[-2, 0], [5, 0]] }]
    },
    scoring: { penalties: { collision: 1 } }
  }, { simulationDefinition }, { sampleIntervalMs: 100 });
  const initial = simulator.snapshot();
  session.sample({
    tick: initial.tick,
    x: initial.pose.x,
    z: initial.pose.z,
    heading: initial.pose.heading,
    speed: 0,
    steering: 0
  }, { forceRecord: true });
  const started = simulator.startCommand({
    kind: "drive",
    direction: 1,
    speedPercent: 100,
    durationMs: 1000
  });
  session.addSimulationInput(started.command, {
    tick: started.startState.tick,
    startState: started.startState,
    source: "python"
  });
  let collisionRecorded = false;
  while (simulator.hasActiveCommand()) {
    const frame = simulator.step();
    if (frame.blocked && !collisionRecorded) {
      collisionRecorded = true;
      const collision = frame.collision || frame.collisions?.at(-1);
      session.recordViolation("collision", {
        colliderId: collision?.colliderId || "unknown",
        tick: collision?.tick ?? frame.tick,
        x: frame.x,
        z: frame.z
      }, frame.elapsedMs);
    }
    session.sample({
      tick: frame.state.tick,
      x: frame.state.pose.x,
      z: frame.state.pose.z,
      heading: frame.state.pose.heading,
      speed: Math.abs(frame.linearSpeed),
      steering: frame.angularSpeed
    });
  }
  return session.finish("program_finished");
}

function makeLiveAvoidanceCollisionRecord() {
  const simulationDefinition = makeDefinition({
    initialPose: { x: 0, z: 0, heading: -Math.PI / 2 },
    world: { bounds: { minX: -3, maxX: 3, minZ: -3, maxZ: 3 }, colliders: [] }
  });
  const interactionDefinition = {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    bounds: clone(simulationDefinition.world.bounds),
    packageRadius: 0.28,
    grab: { minForward: 0.1, maxForward: 1.2, maxLateral: 0.25, maxDistance: 1.2 },
    release: { forwardOffset: 0.7, lateralOffset: 0, stackSnapDistance: 0.1 },
    packages: [
      { id: "target-a", role: "target", radius: 0.28, x: -2, z: 0, stackLevel: 0 },
      { id: "barrier-a", role: "obstacle", radius: 0.52, x: 1.5, z: 0, stackLevel: 0 }
    ]
  };
  const taskDefinition = {
    schemaVersion: TASK_SCHEMA_VERSION,
    id: "deterministic-avoidance-gate",
    version: "1",
    type: "composite",
    checkpointRadius: 0.08,
    goalRadius: 0.12,
    checkpoints: [{ id: "outbound", position: [0.5, 0] }],
    goal: [0, 0],
    deliveries: [{
      id: "target-storage",
      objectRole: "target",
      destinationRole: "storage",
      destination: [-2, 0],
      radius: 0.05,
      requiredPackageIds: ["target-a"]
    }],
    avoidanceObjectIds: ["barrier-a"]
  };
  const ruleDefinition = {
    vehicleRadius: simulationDefinition.vehicle.radius,
    roads: [{ id: "wide-route", width: 4, points: [[-2.5, 0], [2.5, 0]] }],
    trafficLights: [],
    speedZones: [],
    prohibitedZones: []
  };
  const packageEngine = new PackageStateEngine(interactionDefinition);
  const simulator = new DeterministicSimulator(simulationDefinition);
  simulator.setWorld({
    bounds: clone(simulationDefinition.world.bounds),
    colliders: packageEngine.colliders()
  });
  const session = new CompetitionSession({
    taskId: taskDefinition.id,
    mapId: "avoidance-map",
    mapVersion: "1",
    ruleVersion: "1",
    timeLimitSeconds: 4,
    task: clone(taskDefinition),
    rules: clone(ruleDefinition),
    scoring: {}
  }, {
    runId: "live-avoidance-collision-run",
    simulationDefinition: clone(simulationDefinition),
    interactionDefinition: clone(interactionDefinition),
    randomSeed: simulationDefinition.seed
  }, { sampleIntervalMs: simulationDefinition.stepMs });

  const sampleState = frame => {
    const pose = frame.pose || frame.state?.pose || frame;
    const tick = frame.tick ?? frame.state?.tick;
    if (frame.collision) {
      session.recordViolation("collision", {
        colliderId: frame.collision.colliderId,
        tick: frame.collision.tick,
        x: frame.collision.x,
        z: frame.collision.z
      }, frame.collision.elapsedMs);
    }
    return session.sample({
      tick,
      x: pose.x,
      z: pose.z,
      heading: pose.heading,
      speed: Math.abs(Number(frame.linearSpeed ?? 0)),
      steering: Number(frame.angularSpeed ?? 0)
    }, { forceRecord: true });
  };
  const runCommand = command => {
    const started = simulator.startCommand(command);
    session.addSimulationInput(started.command, {
      tick: started.startState.tick,
      startState: started.startState,
      source: "python"
    });
    while (simulator.hasActiveCommand()) sampleState(simulator.step());
  };

  sampleState(simulator.snapshot());
  runCommand({ kind: "drive", direction: 1, speedPercent: 50, durationMs: 1000 });
  runCommand({ kind: "drive", direction: -1, speedPercent: 50, durationMs: 800 });
  return { record: session.finish("program_finished"), session };
}

test("simulation definitions normalize a versioned fixed-step vehicle and rectangular world", () => {
  const normalized = normalizeSimulationDefinition(makeDefinition({
    world: { bounds: { minX: -20, maxX: 20, minZ: -12, maxZ: 12 } }
  }));

  assert.equal(SIMULATION_SCHEMA_VERSION, "chenlong.simulation/v1");
  assert.equal(VEHICLE_MODEL_VERSION, "chenlong.vehicle/v1");
  assert.equal(normalized.schemaVersion, SIMULATION_SCHEMA_VERSION);
  assert.equal(normalized.vehicle.version, VEHICLE_MODEL_VERSION);
  assert.equal(normalized.stepMs, 20);
  assert.deepEqual(normalized.world.bounds, { minX: -20, maxX: 20, minZ: -12, maxZ: 12 });
  assert.equal(typeof SeededRandom, "function");
});

test("fixed steps carry frame remainder and produce the same path for different frame chunks", () => {
  const definition = makeDefinition();
  const coarse = new DeterministicSimulator(definition);
  const jittered = new DeterministicSimulator(definition);
  const command = { kind: "drive", direction: 1, speedPercent: 50, durationMs: 1000 };
  coarse.startCommand(command);
  jittered.startCommand(command);

  const fresh = new DeterministicSimulator(definition);
  fresh.startCommand(command);
  fresh.advance(19);
  assert.equal(fresh.snapshot().tick, 0, "a partial frame must not execute a fractional physics step");
  fresh.advance(1);
  assert.equal(fresh.snapshot().tick, 1, "the carried remainder must execute at exactly one fixed step");

  for (let group = 0; group < 10; group += 1) {
    coarse.advance(100);
    [7, 13, 29, 51].forEach(deltaMs => jittered.advance(deltaMs));
    assert.deepEqual(jittered.snapshot(), coarse.snapshot(), `state diverged after ${(group + 1) * 100}ms`);
  }

  assert.deepEqual(jittered.trajectory(), coarse.trajectory());
  assert.equal(coarse.snapshot().tick, 50);
  assert.equal(coarse.snapshot().elapsedMs, 1000);
  assert.ok(Math.abs(coarse.snapshot().pose.x - 1) < 1e-12);
  assert.ok(Math.abs(coarse.snapshot().pose.z) < 1e-12);
  assert.equal(coarse.snapshot().activeCommand, null);
});

test("fixed-step frame remainder never leaks across idle or zero-duration commands", () => {
  const definition = makeDefinition();
  const command = { kind: "drive", direction: 1, speedPercent: 50, durationMs: 100, durationTicks: 5 };

  const idle = new DeterministicSimulator(definition);
  assert.equal(idle.advance(100).steps.length, 0);
  idle.startCommand(command);
  assert.equal(idle.advance(0).steps.length, 0, "elapsed idle time must not execute a future command");
  assert.equal(idle.snapshot().tick, 0);

  const zeroDuration = new DeterministicSimulator(definition);
  const zeroResult = zeroDuration.advance(100, { kind: "wait", durationMs: 0, durationTicks: 0 });
  assert.equal(zeroResult.steps.length, 0);
  zeroDuration.startCommand(command);
  assert.equal(zeroDuration.advance(0).steps.length, 0, "a completed zero-duration command must not retain frame time");
  assert.equal(zeroDuration.snapshot().tick, 0);

  const singleChunk = new DeterministicSimulator(definition);
  const splitChunks = new DeterministicSimulator(definition);
  singleChunk.startCommand(command);
  splitChunks.startCommand(command);
  singleChunk.advance(19.9984);
  for (let index = 0; index < 4; index += 1) splitChunks.advance(4.9996);
  assert.deepEqual(splitChunks.snapshot(), singleChunk.snapshot());
  assert.deepEqual(splitChunks.trajectory(), singleChunk.trajectory());
  assert.equal(singleChunk.snapshot().tick, 0);
  singleChunk.advance(0.0016);
  splitChunks.advance(0.0016);
  assert.deepEqual(splitChunks.snapshot(), singleChunk.snapshot());
  assert.equal(singleChunk.snapshot().tick, 1);
});

test("fixed-step inputs stay chunk invariant and reject invalid numeric or physical states", () => {
  const definition = makeDefinition();
  const command = { kind: "drive", direction: 1, speed: 1, durationMs: 200, durationTicks: 10 };
  const wholeFrame = new DeterministicSimulator(definition);
  const splitFrame = new DeterministicSimulator(definition);
  wholeFrame.startCommand(command);
  splitFrame.startCommand(command);
  wholeFrame.advance(20);
  for (let index = 0; index < 17; index += 1) splitFrame.advance(20 / 17);
  assert.deepEqual(splitFrame.snapshot(), wholeFrame.snapshot(), "17 equal chunks must execute the same fixed tick");
  assert.deepEqual(splitFrame.trajectory(), wholeFrame.trajectory());

  assert.throws(
    () => new DeterministicSimulator(makeDefinition({ seed: 0x100000000 })),
    /unsigned 32-bit integer/
  );
  assert.throws(
    () => new DeterministicSimulator(definition).normalizeCommand({
      kind: "wait", durationMs: 20, durationTicks: "1"
    }),
    /durationTicks must be a non-negative safe integer/
  );
  assert.throws(
    () => new DeterministicSimulator(definition).reset({ x: 999, z: 999, heading: 0 }),
    /outside the playable bounds/
  );
  assert.throws(
    () => new DeterministicSimulator(definition).normalizeCommand({
      kind: "turn_angle", direction: 1, angleDegrees: 360, durationMs: 20, durationTicks: 1
    }),
    /angular speed exceeds the vehicle model/
  );
  assert.throws(
    () => new DeterministicSimulator(definition).normalizeCommand({
      kind: "turn_angle", direction: 1, angleDegrees: 90, durationMs: 0, durationTicks: 0
    }),
    /requires at least one simulation tick/
  );
});

test("the same seed and commands reproduce all deterministic state", () => {
  const definition = makeDefinition({ seed: 0xabcdef01 });
  const randomA = new SeededRandom(definition.seed);
  const randomB = new SeededRandom(definition.seed);
  const randomOther = new SeededRandom(definition.seed + 1);
  const sequenceA = Array.from({ length: 8 }, () => randomA.next());
  assert.deepEqual(Array.from({ length: 8 }, () => randomB.next()), sequenceA);
  assert.notDeepEqual(Array.from({ length: 8 }, () => randomOther.next()), sequenceA);
  randomA.reset();
  assert.deepEqual(Array.from({ length: 8 }, () => randomA.next()), sequenceA, "reset must replay the seeded sequence");

  const first = new DeterministicSimulator(definition);
  const second = new DeterministicSimulator(definition);
  commandSequence().forEach(command => {
    first.runCommand(command);
    second.runCommand(command);
  });

  assert.deepEqual(second.snapshot(), first.snapshot());
  assert.deepEqual(second.trajectory(), first.trajectory());
  assert.equal(second.snapshot().prngState, first.snapshot().prngState);

  const otherSeed = new DeterministicSimulator(makeDefinition({ seed: 0xabcdef02 }));
  assert.notEqual(otherSeed.snapshot().prngState, first.snapshot().prngState, "a different seed must initialize different PRNG state");
});

test("collisions stop the active command at the safety skin without tunnelling", () => {
  const simulator = new DeterministicSimulator(makeDefinition({
    vehicle: { maxLinearSpeed: 1 },
    world: {
      colliders: [{ id: "ball-stop", type: "circle", x: 1, z: 0, radius: 0.2 }]
    }
  }));

  simulator.runCommand({ kind: "drive", direction: 1, speedPercent: 100, durationMs: 2000 });
  const stopped = simulator.snapshot();
  assert.ok(Math.abs(stopped.pose.x - 0.59) < 1e-9, `unexpected collision stop x=${stopped.pose.x}`);
  assert.ok(Math.abs(stopped.pose.z) < 1e-12);
  assert.equal(stopped.linearSpeed, 0);
  assert.equal(stopped.angularSpeed, 0);
  assert.equal(stopped.activeCommand, null);
  assert.equal(stopped.collisions.length, 1);
  assert.equal(stopped.collisions[0].colliderId, "ball-stop");

  simulator.step();
  assert.deepEqual(simulator.snapshot().pose, stopped.pose, "idle steps after a collision must not tunnel through the collider");
  assert.equal(simulator.snapshot().collisions.length, 1, "one blocked command must produce one collision event");
});

test("rectangular map bounds use width and depth independently", () => {
  const simulator = new DeterministicSimulator(makeDefinition({
    initialPose: { x: 0, z: 0, heading: 0 },
    vehicle: { radius: 0.44, collisionSkin: 0.005, maxLinearSpeed: 2 },
    world: { bounds: { minX: -20, maxX: 20, minZ: -12, maxZ: 12 } }
  }));

  simulator.runCommand({ kind: "drive", direction: 1, speedPercent: 100, durationMs: 10000 });
  const stopped = simulator.snapshot();
  assert.ok(Math.abs(stopped.pose.x) < 1e-12);
  assert.ok(Math.abs(stopped.pose.z - (-12 + 0.44 + 0.005)) < 1e-9);
  assert.equal(stopped.collisions.length, 1);
  assert.equal(stopped.collisions[0].colliderId, "world-bounds");
});

test("ReplayPlayer regenerates command trajectory and reports tampered telemetry", () => {
  const definition = makeDefinition();
  const { simulator, record } = buildLiveRecord(definition);
  const expectedTrajectory = trajectorySignature(simulator.trajectory(), definition.stepMs);

  const player = new ReplayPlayer(record);
  assert.equal(player.mode, "deterministic");
  player.play();
  assert.deepEqual(trajectorySignature(player.trajectory(), definition.stepMs), expectedTrajectory);
  assert.deepEqual(player.snapshot().pose, simulator.snapshot().pose);
  assert.deepEqual(player.snapshot().collisions, simulator.snapshot().collisions);
  assert.equal(player.verify().ok, true);
  assert.equal(record.schemaVersion, DETERMINISTIC_LEGACY_SCHEMA_VERSION);
  assert.equal(player.analysis().scoreRecomputed, false, "v3 playback remains compatible but cannot independently rescore");

  const tampered = clone(record);
  tampered.samples[Math.floor(tampered.samples.length / 2)].x += 2;
  const tamperedPlayer = new ReplayPlayer(tampered);
  tamperedPlayer.play();
  assert.deepEqual(
    trajectorySignature(tamperedPlayer.trajectory(), definition.stepMs),
    expectedTrajectory,
    "recorded coordinates must never drive deterministic input replay"
  );
  const verification = tamperedPlayer.verify();
  assert.equal(verification.ok, false);
  assert.ok(verification.mismatches.some(item => item.field === "x"));
});

test("ReplayPlayer rejects unsafe tick ranges without throwing or running an unbounded replay", { timeout: 1000 }, () => {
  const definition = makeDefinition();
  const unsafeTickRecord = {
    schemaVersion: DETERMINISTIC_LEGACY_SCHEMA_VERSION,
    simulationDefinition: clone(definition),
    inputs: [{
      seq: 2,
      t: Number.MAX_SAFE_INTEGER * definition.stepMs,
      tick: Number.MAX_SAFE_INTEGER,
      type: "control",
      command: { kind: "wait", durationMs: 20, durationTicks: 1 }
    }],
    samples: [sampleFromFrame(new DeterministicSimulator(definition).trajectory()[0], 1, definition.stepMs)],
    events: []
  };
  let unsafeTickPlayer;
  assert.doesNotThrow(() => {
    unsafeTickPlayer = new ReplayPlayer(unsafeTickRecord);
  });
  assert.equal(unsafeTickPlayer.verify().ok, false);
  assert.match(unsafeTickPlayer.verify().diagnostics.join("\n"), /invalid start tick|tick replay limit/i);
  assert.ok(unsafeTickPlayer.trajectory().length < 10, "an unsafe input tick must not generate a long synthetic path");

  const unsafeDurationRecord = clone(unsafeTickRecord);
  unsafeDurationRecord.inputs[0] = {
    seq: 2,
    t: 0,
    tick: 0,
    type: "control",
    command: {
      kind: "drive",
      direction: 1,
      speedPercent: 50,
      durationMs: 20,
      durationTicks: Number.MAX_SAFE_INTEGER
    }
  };
  let unsafeDurationPlayer;
  assert.doesNotThrow(() => {
    unsafeDurationPlayer = new ReplayPlayer(unsafeDurationRecord);
  });
  assert.equal(unsafeDurationPlayer.verify().ok, false);
  assert.match(unsafeDurationPlayer.verify().diagnostics.join("\n"), /tick replay limit|replay failed/i);
  assert.ok(unsafeDurationPlayer.trajectory().length < 10, "an unsafe duration must fail before physics iteration");
});

test("ReplayPlayer diagnoses control inputs that begin after simulationEndTick", () => {
  const definition = makeDefinition();
  const initialFrame = new DeterministicSimulator(definition).trajectory()[0];
  const record = {
    schemaVersion: DETERMINISTIC_LEGACY_SCHEMA_VERSION,
    simulationDefinition: clone(definition),
    simulationEndTick: 5,
    inputs: [{
      seq: 2,
      t: 200,
      tick: 10,
      type: "control",
      command: { kind: "wait", durationMs: 20, durationTicks: 1 }
    }],
    samples: [{ ...sampleFromFrame(initialFrame, 1, definition.stepMs), tick: 5, simulationTick: 5, t: 100 }],
    events: []
  };

  const player = new ReplayPlayer(record);
  assert.equal(player.verify().ok, false);
  assert.match(player.verify().diagnostics.join("\n"), /starts after simulationEndTick 5/);
  assert.equal(player.trajectory().at(-1).tick, 5, "the rejected future input must not advance beyond the terminal tick");
});

test("ReplayPlayer requires explicit model versions, tick-aligned sample time, and non-empty v3 evidence", () => {
  const definition = makeDefinition();
  const { record } = buildLiveRecord(definition);

  const missingSimulationVersion = clone(record);
  delete missingSimulationVersion.simulationDefinition.schemaVersion;
  const missingSimulationPlayer = new ReplayPlayer(missingSimulationVersion);
  assert.equal(missingSimulationPlayer.verify().ok, false);
  assert.match(missingSimulationPlayer.verify().diagnostics.join("\n"), /must declare chenlong\.simulation\/v1/);

  const missingVehicleVersion = clone(record);
  delete missingVehicleVersion.simulationDefinition.vehicle.version;
  const missingVehiclePlayer = new ReplayPlayer(missingVehicleVersion);
  assert.equal(missingVehiclePlayer.verify().ok, false);
  assert.match(missingVehiclePlayer.verify().diagnostics.join("\n"), /must declare chenlong\.vehicle\/v1/);

  const tamperedTime = clone(record);
  tamperedTime.samples[Math.floor(tamperedTime.samples.length / 2)].t += 1;
  const tamperedTimePlayer = new ReplayPlayer(tamperedTime);
  assert.equal(tamperedTimePlayer.verify().ok, false);
  assert.ok(tamperedTimePlayer.verify().mismatches.some(item => item.field === "t"));

  const emptyPlayer = new ReplayPlayer({
    schemaVersion: DETERMINISTIC_LEGACY_SCHEMA_VERSION,
    simulationDefinition: clone(definition),
    inputs: [],
    samples: [],
    events: []
  });
  assert.equal(emptyPlayer.verify().ok, false);
  assert.match(emptyPlayer.verify().diagnostics.join("\n"), /neither control inputs nor telemetry samples/);
});

test("ReplayPlayer rejects reversed phases, backwards ticks, and contradictory deterministic metadata", () => {
  const definition = makeDefinition();
  const oneTick = buildLiveRecord(definition, [
    { kind: "drive", direction: 1, speed: 1, durationMs: 20, durationTicks: 1 }
  ]).record;
  oneTick.simulationEndTick = 1;
  oneTick.randomSeed = definition.seed;

  const reversedPhase = clone(oneTick);
  const finalTickSamples = reversedPhase.samples.filter(sample => (sample.tick ?? sample.simulationTick) === 1);
  assert.equal(finalTickSamples.length, 2, "the fixture must contain an executing and settled phase");
  [finalTickSamples[0].speed, finalTickSamples[1].speed] = [finalTickSamples[1].speed, finalTickSamples[0].speed];
  const phasePlayer = new ReplayPlayer(reversedPhase);
  assert.equal(phasePlayer.verify().ok, false);
  assert.match(phasePlayer.verify().diagnostics.join("\n"), /reverses deterministic phases/);

  const twoTick = buildLiveRecord(definition, [
    { kind: "drive", direction: 1, speed: 1, durationMs: 40, durationTicks: 2 }
  ]).record;
  twoTick.simulationEndTick = 2;
  twoTick.randomSeed = definition.seed;
  const initial = twoTick.samples.find(sample => (sample.tick ?? sample.simulationTick) === 0);
  const tickOne = twoTick.samples.find(sample => (sample.tick ?? sample.simulationTick) === 1);
  const tickTwo = twoTick.samples.filter(sample => (sample.tick ?? sample.simulationTick) === 2);
  twoTick.samples = [
    { ...initial, seq: 1 },
    { ...tickTwo[0], seq: 3 },
    { ...tickOne, seq: 4 },
    { ...tickTwo[1], seq: 5 }
  ];
  twoTick.inputs[0].seq = 2;
  const backwardsPlayer = new ReplayPlayer(twoTick);
  assert.equal(backwardsPlayer.verify().ok, false);
  assert.match(backwardsPlayer.verify().diagnostics.join("\n"), /monotonic tick\/sequence order/);

  const badStartState = clone(oneTick);
  badStartState.inputs[0].startState.pose.x += 1;
  assert.equal(new ReplayPlayer(badStartState).verify().ok, false);
  assert.match(new ReplayPlayer(badStartState).verify().diagnostics.join("\n"), /startState\.pose\.x/);

  const badSeed = clone(oneTick);
  badSeed.randomSeed += 1;
  assert.equal(new ReplayPlayer(badSeed).verify().ok, false);
  assert.match(new ReplayPlayer(badSeed).verify().diagnostics.join("\n"), /randomSeed does not match/);

});

test("ReplayPlayer fails malformed bounds and scalar telemetry without throwing", { timeout: 1000 }, () => {
  const definition = makeDefinition();
  const initialFrame = new DeterministicSimulator(definition).trajectory()[0];
  const initialSample = sampleFromFrame(initialFrame, 1, definition.stepMs);
  const terminalOverflow = {
    schemaVersion: DETERMINISTIC_LEGACY_SCHEMA_VERSION,
    simulationDefinition: clone(definition),
    randomSeed: definition.seed,
    simulationEndTick: 50001,
    inputs: [],
    samples: [initialSample],
    events: []
  };
  let overflowPlayer;
  assert.doesNotThrow(() => {
    overflowPlayer = new ReplayPlayer(terminalOverflow);
  });
  assert.equal(overflowPlayer.verify().ok, false);
  assert.ok(overflowPlayer.trajectory().length < 10, "an invalid terminal tick must not synthesize a capped path");

  const validInitialRecord = {
    ...terminalOverflow,
    simulationEndTick: 0
  };
  let padding = {};
  const deepRecord = { ...validInitialRecord, padding };
  for (let depth = 0; depth < 6000; depth += 1) {
    padding.child = {};
    padding = padding.child;
  }
  let deepPlayer;
  assert.doesNotThrow(() => {
    deepPlayer = new ReplayPlayer(deepRecord);
  });
  assert.equal(deepPlayer.verify().ok, true, "unknown deeply nested fields must not enter the replay clone");

  [null, "0", false, []].forEach(value => {
    const malformed = clone(validInitialRecord);
    malformed.samples[0] = {
      seq: 1,
      tick: 0,
      t: value,
      x: value,
      z: value,
      heading: value,
      speed: value,
      steering: value
    };
    assert.equal(new ReplayPlayer(malformed).verify().ok, false, `telemetry ${JSON.stringify(value)} must not coerce to zero`);
  });
});

test("collision replay stores linear frames and steps without cloning cumulative history", { timeout: 3000 }, () => {
  const collisionCount = 200;
  const definition = makeDefinition({ initialPose: { x: 4.8, z: 0, heading: -Math.PI / 2 } });
  const inputs = Array.from({ length: collisionCount }, (_, index) => ({
    seq: index + 2,
    t: index * definition.stepMs,
    tick: index,
    type: "control",
    command: { kind: "drive", direction: 1, speed: 1, durationMs: 20, durationTicks: 1 }
  }));
  const record = {
    schemaVersion: DETERMINISTIC_LEGACY_SCHEMA_VERSION,
    simulationDefinition: clone(definition),
    randomSeed: definition.seed,
    simulationEndTick: collisionCount,
    inputs,
    samples: [
      { seq: 1, tick: 0, t: 0, x: 4.8, z: 0, heading: -Math.PI / 2, speed: 0, steering: 0 },
      {
        seq: collisionCount + 2,
        tick: collisionCount,
        t: collisionCount * definition.stepMs,
        x: 4.8,
        z: 0,
        heading: -Math.PI / 2,
        speed: 0,
        steering: 0
      }
    ],
    events: []
  };

  const player = new ReplayPlayer(record);
  assert.equal(player.verify().ok, true);
  const frames = player.trajectory();
  assert.equal(frames.length, collisionCount * 2 + 1);
  assert.equal(frames.filter(frame => frame.collision).length, collisionCount);
  assert.equal(frames.some(frame => Object.prototype.hasOwnProperty.call(frame, "collisions")), false,
    "trajectory frames must not embed cumulative collision arrays");

  let state = player.snapshot();
  let steps = 0;
  while (!state.complete) {
    state = player.step();
    steps += 1;
    if (!state.complete) assert.equal(state.collisions.length, 0, "intermediate stepping must keep collision history lazy");
  }
  assert.equal(steps, frames.length - 1);
  assert.equal(state.collisionCount, collisionCount);
  assert.equal(state.collisions.length, collisionCount);
  assert.equal(player.collisionHistory().length, collisionCount);
  assert.equal(state.latestCollision.colliderId, "world-bounds");
});

test("simulation and replay analysis enforce geometry work budgets", { timeout: 5000 }, () => {
  const excessiveColliders = Array.from({ length: 1001 }, (_, index) => ({
    id: `collider-${index}`,
    type: "circle",
    x: -1000 + index * 0.1,
    z: -1000,
    radius: 0.01
  }));
  assert.throws(
    () => new DeterministicSimulator(makeDefinition({
      world: {
        bounds: { minX: -5000, maxX: 5000, minZ: -5000, maxZ: 5000 },
        colliders: excessiveColliders
      }
    })),
    /collider limit/
  );

  const definition = makeDefinition();
  const waitTicks = 5000;
  const analysisRecord = {
    schemaVersion: DETERMINISTIC_LEGACY_SCHEMA_VERSION,
    simulationDefinition: clone(definition),
    randomSeed: definition.seed,
    simulationEndTick: waitTicks,
    inputs: [{
      seq: 2,
      t: 0,
      tick: 0,
      type: "control",
      command: { kind: "wait", durationMs: waitTicks * definition.stepMs, durationTicks: waitTicks }
    }],
    samples: [
      { seq: 1, tick: 0, t: 0, x: 0, z: 0, heading: -Math.PI / 2, speed: 0, steering: 0 },
      {
        seq: 3,
        tick: waitTicks,
        t: waitTicks * definition.stepMs,
        x: 0,
        z: 0,
        heading: -Math.PI / 2,
        speed: 0,
        steering: 0
      }
    ],
    events: [],
    ruleDefinition: {
      vehicleRadius: definition.vehicle.radius,
      roads: Array.from({ length: 2000 }, (_, index) => ({
        id: `road-${index}`,
        width: 1,
        points: [[1000 + index, 1000], [1000 + index, 1001]]
      })),
      trafficLights: [],
      speedZones: [],
      prohibitedZones: []
    }
  };
  const analysisPlayer = new ReplayPlayer(analysisRecord);
  assert.equal(analysisPlayer.analysis().rulesRecomputed, false);
  assert.match(analysisPlayer.verify().diagnostics.join("\n"), /operation analysis limit/);
});

test("ReplayPlayer seek is repeatable and exposes non-authoritative recorded results", () => {
  const definition = makeDefinition();
  const { simulator, record, taskReplay } = buildLiveRecord(definition);
  const player = new ReplayPlayer(record);

  const firstSeek = player.seek(900);
  const secondSeek = player.seek(200);
  const repeatedSeek = player.seek(900);
  assert.deepEqual(repeatedSeek, firstSeek, "seeking backwards and forwards must rebuild the same state");
  assert.ok(secondSeek.elapsedMs <= 200);

  player.play();
  assert.deepEqual(player.snapshot().pose, simulator.snapshot().pose);
  assert.deepEqual(
    rejudgeTask(record.taskDefinition, trajectorySignature(player.trajectory(), definition.stepMs)).state,
    taskReplay.state
  );
  assert.deepEqual(player.result(), {
    recordedResult: record.result,
    verification: player.verify(),
    authoritative: false
  });
});

test("RunRecorder v4 keeps every typed input and vision frame in one immutable sequence timeline", () => {
  let now = 1000;
  const definition = makeDefinition();
  const recorder = new RunRecorder({
    runId: "input-timeline",
    simulationDefinition: definition,
    interactionDefinition: {
      packages: [{ id: "box-a", x: 0.8, z: 0 }],
      bounds: definition.world.bounds
    },
    randomSeed: definition.seed
  }, { now: () => now });
  recorder.sample({
    x: 0,
    z: 0,
    heading: -Math.PI / 2,
    speed: 0,
    steering: 0,
    simulationTick: 0
  }, true);
  const command = {
    kind: "drive",
    direction: 1,
    speed: 1,
    speedPercent: 50,
    durationMs: 500,
    durationTicks: 25
  };
  const input = recorder.input(command, {
    tick: 0,
    source: "python",
    seq: -1,
    type: "forged",
    world: definition.world
  });
  const interaction = recorder.interaction("package_grab", {
    packageId: "forged-box",
    position: [999, 999]
  }, { tick: 0, stateRevision: 1, source: "python" });
  const manual = recorder.manual("pause_button", { tick: 0, stateRevision: 2 });
  const evidence = recorder.visionEvidence({
    evidenceId: "evidence-1",
    frameId: "frame-1",
    tick: 0,
    stateRevision: 2,
    pngBase64: ONE_PIXEL_PNG_BASE64
  });
  const query = recorder.visionQuery("detect", [], [{ type: "red" }], "frame-1", {
    tick: 0,
    evidenceId: evidence.evidenceId
  });
  now = 1500;
  recorder.event("command_finished", { tick: 25 });
  const record = recorder.export();

  assert.equal(record.schemaVersion, SCHEMA_VERSION);
  assert.equal(record.simulationDefinition.schemaVersion, SIMULATION_SCHEMA_VERSION);
  assert.equal(record.samples[0].seq, 1);
  assert.equal(input.seq, 2);
  assert.equal(input.type, "control");
  assert.equal(input.t, 0);
  assert.deepEqual(input.command, command);
  assert.equal(Object.prototype.hasOwnProperty.call(input, "world"), false, "v4 control inputs must not carry mutable worlds");
  assert.equal(interaction.seq, 3);
  assert.deepEqual(interaction.intent, {}, "callers cannot forge package ids or release coordinates");
  assert.equal(manual.seq, 4);
  assert.equal(evidence.seq, 5);
  assert.equal(evidence.t, 0);
  assert.equal(query.seq, 6);
  assert.equal(record.events[0].seq, 7);
  assert.deepEqual([
    ...record.samples,
    ...record.inputs,
    ...record.visionFrames,
    ...record.events
  ].map(item => item.seq).sort((left, right) => left - right), [1, 2, 3, 4, 5, 6, 7]);
  command.durationTicks = 999;
  assert.equal(record.inputs[0].command.durationTicks, 25, "recorded inputs must not retain caller object references");
});

test("ReplayPlayer retains v2 telemetry playback as a non-deterministic fallback", () => {
  const record = {
    schemaVersion: LEGACY_SCHEMA_VERSION,
    samples: [
      { seq: 1, t: 0, x: 0, z: 0, heading: 0, speed: 0, steering: 0 },
      { seq: 2, t: 100, x: 0, z: -0.1, heading: 0, speed: 1, steering: 0 }
    ],
    events: [],
    result: { score: 10, reason: "program_finished" }
  };
  const player = new ReplayPlayer(record);

  assert.equal(player.mode, "telemetry");
  assert.deepEqual(trajectorySignature(player.trajectory()), [
    { tick: 0, t: 0, x: 0, z: 0, heading: 0, linearSpeed: 0, angularSpeed: 0 },
    { tick: 1, t: 100, x: 0, z: -0.1, heading: 0, linearSpeed: 1, angularSpeed: 0 }
  ]);
  assert.equal(player.verify().valid, false);
  assert.equal(player.result().authoritative, false);
  assert.match(player.verify().diagnostics.join("\n"), /telemetry playback/i);
});

test("v4 typed package inputs independently recompute delivery, rules, and the total score", () => {
  assert.equal(SCHEMA_VERSION, "chenlong.run-record/v4");
  assert.equal(DETERMINISTIC_LEGACY_SCHEMA_VERSION, "chenlong.run-record/v3");
  const record = makeV4DeliveryRecord();
  const player = new ReplayPlayer(record);
  const analysis = player.analysis();

  assert.equal(player.verify().ok, true, player.verify().diagnostics.join("\n"));
  assert.equal(analysis.interactionsRecomputed, true);
  assert.equal(analysis.taskRecomputed, true);
  assert.equal(analysis.rulesRecomputed, true);
  assert.equal(analysis.scoreRecomputed, true);
  assert.equal(analysis.recomputationComplete, true);
  assert.deepEqual(
    analysis.objectState.packages.map(item => [item.id, item.role]),
    [["barrier-a", "obstacle"], ["box-a", "target"], ["decoy-a", "distractor"]]
  );
  assert.deepEqual(
    {
      completed: analysis.task.completed,
      total: analysis.task.total,
      finished: analysis.task.finished,
      deliveredPackageIds: analysis.task.deliveredPackageIds
    },
    { completed: 1, total: 1, finished: true, deliveredPackageIds: ["box-a"] }
  );
  assert.deepEqual(
    {
      score: analysis.recomputedResult.score,
      taskScore: analysis.recomputedResult.taskScore,
      ruleScore: analysis.recomputedResult.ruleScore,
      autonomousScore: analysis.recomputedResult.autonomousScore,
      efficiencyScore: analysis.recomputedResult.efficiencyScore,
      reason: analysis.recomputedResult.reason
    },
    { score: 60, taskScore: 25, ruleScore: 15, autonomousScore: 10, efficiencyScore: 10, reason: "completed" }
  );
  assert.equal(analysis.resultMismatches.length, 0);
});

test("legacy interaction v1 records remain valid under v4 replay", () => {
  const record = makeV4DeliveryRecord();
  record.runDefinition.interactionDefinition.schemaVersion = LEGACY_INTERACTION_SCHEMA_VERSION;
  record.runDefinition.interactionDefinition.packages.forEach(item => { delete item.role; });
  record.samples.forEach(sample => sample.packages?.forEach(item => { delete item.role; }));
  record.events.forEach(event => { delete event.objectRole; });

  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  assert.equal(replay.analysis().recomputedResult.score, 60);
  assert.ok(replay.analysis().objectState.packages.every(item => item.role === "target"));
});

test("v4 replay rejects delivery definitions that require a distractor", () => {
  const record = makeV4DeliveryRecord();
  record.runDefinition.interactionDefinition.packages
    .find(item => item.id === "box-a").role = "distractor";
  record.samples.forEach(sample => {
    sample.packages.find(item => item.id === "box-a").role = "distractor";
  });
  record.events.filter(event => event.packageId === "box-a").forEach(event => {
    if (Object.prototype.hasOwnProperty.call(event, "objectRole")) event.objectRole = "distractor";
  });

  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, false);
  assert.equal(replay.analysis().taskRecomputed, false);
  assert.equal(replay.analysis().scoreRecomputed, false);
  assert.match(replay.verify().diagnostics.join("\n"), /required package box-a must have role target/);
});

test("CompetitionSession v4 delivery and ReplayPlayer independently reach the same task, rule, and score result", () => {
  const fixture = makeV4DeliveryRecord();
  const definitions = fixture.runDefinition;
  let now = 1700000000000;
  const session = new CompetitionSession({
    taskId: "v4-live-delivery",
    mapId: "v4-map",
    mapVersion: "1",
    ruleVersion: "1",
    timeLimitSeconds: definitions.timeLimitTicks * definitions.simulationDefinition.stepMs / 1000,
    task: clone(definitions.taskDefinition),
    rules: clone(definitions.ruleDefinition),
    scoring: clone(definitions.scoringDefinition)
  }, {
    runId: "v4-live-delivery-run",
    simulationDefinition: clone(definitions.simulationDefinition),
    interactionDefinition: clone(definitions.interactionDefinition)
  }, { now: () => now, sampleIntervalMs: 20 });
  const telemetry = tick => ({
    tick,
    x: 0,
    z: 0,
    heading: -Math.PI / 2,
    speed: 0,
    steering: 0
  });

  session.sample(telemetry(0), { forceRecord: true });
  const grabbed = session.addInteractionInput("package_grab", { tick: 0, source: "python" });
  assert.equal(grabbed.accepted, true);
  assert.equal(grabbed.objectRole, "target");
  session.sample(telemetry(10), { forceRecord: true });
  assert.equal(session.addInteractionInput("package_release", { tick: 10, source: "python" }).accepted, true);
  session.sample(telemetry(10), { forceRecord: true });
  const record = session.finalRecord;
  assert.equal(record.schemaVersion, SCHEMA_VERSION);
  assert.equal(record.result.score, 60);
  assert.deepEqual(
    record.runDefinition.interactionDefinition.packages.map(item => [item.id, item.role]),
    [["box-a", "target"], ["decoy-a", "distractor"], ["barrier-a", "obstacle"]]
  );
  assert.equal(record.events.find(event => event.type === "package_grabbed").objectRole, "target");

  const replay = new ReplayPlayer(record);
  const recomputed = replay.analysis().recomputedResult;
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  ["score", "taskScore", "ruleScore", "autonomousScore", "efficiencyScore", "taskFinished", "reason", "simulationTick"]
    .forEach(field => assert.equal(recomputed[field], record.result[field], field));
  assert.deepEqual(replay.analysis().objectState, session.packageStateEngine.snapshot());

  const alteredReleaseEvent = clone(record);
  alteredReleaseEvent.events.find(event => event.type === "package_released").position = [999, 999];
  const alteredReleasePlayer = new ReplayPlayer(alteredReleaseEvent);
  assert.deepEqual(alteredReleasePlayer.analysis().recomputedResult, recomputed);
  assert.equal(alteredReleasePlayer.verify().ok, false, "a forged package release position must be diagnosed");

  const strippedDeliveryEvent = clone(record);
  delete strippedDeliveryEvent.events.find(event => event.type === "package_delivered").packageId;
  const strippedDeliveryPlayer = new ReplayPlayer(strippedDeliveryEvent);
  assert.deepEqual(strippedDeliveryPlayer.analysis().recomputedResult, recomputed);
  assert.equal(strippedDeliveryPlayer.verify().ok, false, "removing required event evidence must be diagnosed");
});

test("task v5 live session and ReplayPlayer independently derive any-road-edge distractor removal", () => {
  const simulationDefinition = makeDefinition({
    initialPose: { x: 0, z: 0, heading: 0 },
    world: { bounds: { minX: -4, maxX: 4, minZ: -4, maxZ: 4 }, colliders: [] }
  });
  const roads = [{ id: "road-a", width: 1, points: [[-4, 0], [4, 0]] }];
  const interactionDefinition = {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    packageRadius: 0.25,
    bounds: clone(simulationDefinition.world.bounds),
    grab: { minForward: 0.1, maxForward: 1.2, maxLateral: 0.3 },
    release: { forwardOffset: 1.2, lateralOffset: 0, stackSnapDistance: 0.1 },
    packages: [
      { id: "target-a", role: "target", radius: 0.25, x: 2, z: 0 },
      { id: "decoy-a", role: "distractor", radius: 0.25, x: 0, z: -0.8 }
    ]
  };
  const taskDefinition = {
    schemaVersion: ROAD_CLEARANCE_TASK_SCHEMA_VERSION,
    id: "v5-road-clearance",
    version: "1",
    type: "composite",
    checkpointRadius: 0.2,
    goalRadius: 0.2,
    checkpoints: [{ id: "checkpoint-a", position: [3, 0] }],
    goal: [0, 0],
    deliveries: [
      {
        id: "target-storage",
        objectRole: "target",
        destinationRole: "storage",
        destination: [-2, 0],
        radius: 0.2,
        requiredPackageIds: ["target-a"]
      },
      {
        id: "distractor-offroad-removal",
        objectRole: "distractor",
        destinationRole: "offroad-removal",
        placementRule: "road-edge-clearance",
        objectRadius: 0.25,
        minimumRoadEdgeClearance: 0.2,
        requiredPackageIds: ["decoy-a"]
      }
    ],
    placementGeometry: { roads },
    avoidanceObjectIds: []
  };
  const session = new CompetitionSession({
    taskId: taskDefinition.id,
    mapId: "v5-map",
    mapVersion: "1",
    ruleVersion: "1",
    timeLimitSeconds: 2,
    task: taskDefinition,
    rules: { vehicleRadius: 0.2, roads },
    scoring: {}
  }, {
    runId: "v5-road-clearance-run",
    simulationDefinition,
    interactionDefinition
  }, { sampleIntervalMs: simulationDefinition.stepMs });
  const pose = simulationDefinition.initialPose;
  session.sample({ tick: 0, ...pose, speed: 0, steering: 0 }, { forceRecord: true });
  const grabbed = session.addInteractionInput("package_grab", { tick: 0, source: "python" });
  assert.deepEqual([grabbed.accepted, grabbed.packageId, grabbed.objectRole], [true, "decoy-a", "distractor"]);
  const released = session.addInteractionInput("package_release", { tick: 0, source: "python" });
  assert.deepEqual([released.accepted, released.position], [true, [0, -1.2]]);
  assert.deepEqual(session.taskEngine.snapshot().deliveredPackageIds, ["decoy-a"]);
  const record = session.finish("program_finished");

  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  assert.equal(replay.analysis().interactionsRecomputed, true);
  assert.equal(replay.analysis().taskRecomputed, true);
  assert.deepEqual(replay.analysis().task, session.taskEngine.snapshot());

  const forgedEvent = clone(record);
  forgedEvent.events.find(event => event.type === "package_delivered").deliveryId = "client-selected-zone";
  const forgedReplay = new ReplayPlayer(forgedEvent);
  assert.deepEqual(forgedReplay.analysis().task, replay.analysis().task,
    "recorded delivery claims cannot change the geometry-derived task state");
  assert.equal(forgedReplay.verify().ok, false);

  const mismatchedRoads = clone(record);
  mismatchedRoads.taskDefinition.placementGeometry.roads[0].width = 0.8;
  mismatchedRoads.runDefinition.taskDefinition.placementGeometry.roads[0].width = 0.8;
  const mismatchedReplay = new ReplayPlayer(mismatchedRoads);
  assert.match(mismatchedReplay.verify().diagnostics.join("\n"),
    /placementGeometry roads must exactly match the competition rule roads/);
  assert.equal(mismatchedReplay.analysis().taskRecomputed, false);
});

test("v4 composite live run and replay independently agree on placements, patrol return, obstacles, rules, and score", () => {
  const fixture = makeLiveV4CompositeRecord();
  const { record, session } = fixture;
  assert.equal(record.runDefinition.taskDefinition.schemaVersion, TASK_SCHEMA_VERSION);
  assert.deepEqual(
    record.runDefinition.taskDefinition.deliveries.map(delivery => [
      delivery.id, delivery.objectRole, delivery.destinationRole, delivery.destination, delivery.requiredPackageIds
    ]),
    [
      ["target-storage", "target", "storage", [-1.5, 0], ["target-a"]],
      ["distractor-cleanup", "distractor", "cleanup", [1.5, 0], ["decoy-a"]]
    ]
  );
  assert.deepEqual(
    record.runDefinition.interactionDefinition.packages.map(item => [item.id, item.role, item.radius, item.x, item.z]),
    [
      ["target-a", "target", 0.28, 0, -0.8],
      ["decoy-a", "distractor", 0.28, -0.8, 0],
      ["barrier-a", "obstacle", 0.52, 0, -1.5]
    ]
  );
  assert.deepEqual(record.runDefinition.ruleDefinition, fixture.ruleDefinition);
  const blocked = record.events.find(event => event.type === "package_interaction_failed" && event.reason === "blocked");
  assert.deepEqual(
    { packageId: blocked?.packageId, objectRole: blocked?.objectRole, obstacleId: blocked?.obstacleId },
    { packageId: "target-a", objectRole: "target", obstacleId: "barrier-a" }
  );
  assert.deepEqual(
    record.events.filter(event => event.type === "package_delivered")
      .map(event => [event.packageId, event.deliveryId, event.objectRole, event.destinationRole]),
    [
      ["target-a", "target-storage", "target", "storage"],
      ["decoy-a", "distractor-cleanup", "distractor", "cleanup"]
    ]
  );
  assert.deepEqual(
    record.events.filter(event => event.type === "checkpoint").map(event => event.checkpointId),
    ["checkpoint-a", "checkpoint-b"]
  );

  const replay = new ReplayPlayer(record);
  const analysis = replay.analysis();
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  assert.equal(analysis.interactionsRecomputed, true);
  assert.equal(analysis.taskRecomputed, true);
  assert.equal(analysis.rulesRecomputed, true);
  assert.equal(analysis.scoreRecomputed, true);
  assert.equal(analysis.recomputationComplete, true);
  assert.deepEqual(analysis.task, session.taskEngine.snapshot());
  assert.deepEqual(analysis.objectState, session.packageStateEngine.snapshot());
  assert.deepEqual(analysis.task.deliveryProgress.map(delivery => ({
    id: delivery.id,
    deliveredPackageIds: delivery.deliveredPackageIds,
    finished: delivery.finished
  })), [
    { id: "target-storage", deliveredPackageIds: ["target-a"], finished: true },
    { id: "distractor-cleanup", deliveredPackageIds: ["decoy-a"], finished: true }
  ]);
  ["score", "taskScore", "ruleScore", "autonomousScore", "efficiencyScore", "taskFinished", "reason", "simulationTick"]
    .forEach(field => assert.equal(analysis.recomputedResult[field], record.result[field], field));
  assert.equal(analysis.recomputedResult.score, 60);
  assert.equal(analysis.recomputedResult.reason, "completed");
});

test("v4 composite live run and replay both reject completion after hitting a required avoidance object", () => {
  const { record, session } = makeLiveAvoidanceCollisionRecord();
  const liveTask = session.taskEngine.snapshot();
  assert.deepEqual(liveTask.avoidanceProgress, {
    requiredObjectIds: ["barrier-a"],
    failedObjectIds: ["barrier-a"],
    completed: 0,
    total: 1,
    finished: false
  });
  assert.equal(liveTask.goalReached, true);
  assert.equal(liveTask.completed, 3);
  assert.equal(liveTask.total, 4);
  assert.equal(record.result.taskFinished, false);
  assert.equal(record.result.reason, "program_finished");
  assert.equal(
    record.events.some(event => event.type === "task_completed"),
    false,
    "a collided avoidance run must never emit task_completed"
  );
  assert.deepEqual(
    record.events.filter(event => event.type === "violation")
      .map(event => [event.violationType, event.colliderId]),
    [["collision", "object:barrier-a"]]
  );

  const replay = new ReplayPlayer(record);
  const analysis = replay.analysis();
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  assert.equal(analysis.taskRecomputed, true);
  assert.deepEqual(analysis.task, liveTask);
  ["score", "taskScore", "ruleScore", "autonomousScore", "efficiencyScore", "taskFinished", "reason", "simulationTick"]
    .forEach(field => assert.equal(analysis.recomputedResult[field], record.result[field], field));
  assert.equal(analysis.recomputedResult.taskFinished, false);
  assert.equal(analysis.recomputedResult.reason, "program_finished");
});

test("v4 composite replay rejects definition mismatches and audits claimed placement evidence", () => {
  const { record } = makeLiveV4CompositeRecord();
  const expected = new ReplayPlayer(record).analysis().recomputedResult;
  const evidenceTampering = [
    ["sample position", candidate => {
      candidate.samples.at(-1).packages.find(item => item.id === "decoy-a").x = -2;
    }],
    ["sample role", candidate => {
      candidate.samples[0].packages.find(item => item.id === "decoy-a").role = "target";
    }],
    ["delivery id", candidate => {
      candidate.events.find(event => event.type === "package_delivered").deliveryId = "cleanup-forged";
    }],
    ["destination role", candidate => {
      candidate.events.find(event => event.type === "package_delivered").destinationRole = "cleanup";
    }],
    ["blocked obstacle", candidate => {
      candidate.events.find(event => event.reason === "blocked").obstacleId = "forged-obstacle";
    }]
  ];
  evidenceTampering.forEach(([label, mutate]) => {
    const candidate = clone(record);
    mutate(candidate);
    const replay = new ReplayPlayer(candidate);
    assert.deepEqual(replay.analysis().recomputedResult, expected,
      `${label} must not drive independently recomputed scoring`);
    assert.equal(replay.verify().ok, false, `${label} must be diagnosed`);
  });

  const wrongInteractionRole = clone(record);
  wrongInteractionRole.runDefinition.interactionDefinition.packages
    .find(item => item.id === "decoy-a").role = "target";
  const roleReplay = new ReplayPlayer(wrongInteractionRole);
  assert.equal(roleReplay.analysis().taskRecomputed, false);
  assert.equal(roleReplay.analysis().scoreRecomputed, false);
  assert.match(roleReplay.verify().diagnostics.join("\n"), /decoy-a must have role distractor/);

  const changedDestination = clone(record);
  changedDestination.runDefinition.taskDefinition.deliveries
    .find(delivery => delivery.id === "distractor-cleanup").destination = [2.5, 0];
  const destinationReplay = new ReplayPlayer(changedDestination);
  assert.equal(destinationReplay.verify().ok, false);
  assert.equal(destinationReplay.analysis().recomputedResult.taskFinished, false);
  assert.notDeepEqual(destinationReplay.analysis().recomputedResult, expected);
});

test("100ms telemetry recording keeps v5 live rule evaluation aligned with 20ms replay", () => {
  const record = makeLiveSpeedingRecord();
  assert.deepEqual(record.samples.map(sample => sample.t), [0, 100, 200]);
  assert.deepEqual(
    record.events.filter(event => event.type === "violation").map(event => [event.violationType, event.t]),
    [["speeding", 20]]
  );

  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  assert.deepEqual(
    replay.analysis().violations.map(violation => [violation.type, violation.t]),
    [["speeding", 20]]
  );
  assert.deepEqual(replay.analysis().violationMetrics, record.result.violationMetrics);
  assert.deepEqual(replay.analysis().recomputedResult, record.result);
});

test("navigation micro-command settled frames do not split live and replay rule episodes", () => {
  const simulationDefinition = makeDefinition({
    initialPose: { x: 0, z: 0, heading: -Math.PI / 2 },
    vehicle: { maxLinearSpeed: 1 }
  });
  const rules = {
    vehicleRadius: 0.2,
    roads: [{ id: "slow-road", width: 1.5, speedLimit: 0.1, points: [[-1, 0], [3, 0]] }]
  };
  const session = new CompetitionSession({
    taskId: "navigation-speed-audit",
    mapId: "map",
    mapVersion: "1",
    ruleVersion: "2026.08-configurable.5",
    task: { type: "reach", goal: [4, 2], goalRadius: 0.1 },
    rules,
    scoring: {}
  }, {
    simulationDefinition,
    runDefinition: {
      simulationDefinition,
      navigationDefinition: NAVIGATION_DEFINITION,
      navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
    }
  });
  const simulator = new DeterministicSimulator(simulationDefinition);
  session.sample({ tick: 0, x: 0, z: 0, heading: -Math.PI / 2, speed: 0, steering: 0 },
    { forceRecord: true });
  const result = session.runNavigationControl(simulator, "follow_road", { maxCm: 10, speed: 100 });
  assert.equal(result.elapsedTicks, 5);
  const record = session.finish("program_finished");
  assert.equal(record.result.violationMetrics.speeding.episodes, 1);
  assert.equal(record.result.violationMetrics.speeding.durationMs, 80);

  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  assert.deepEqual(replay.analysis().violationMetrics, record.result.violationMetrics);
  assert.deepEqual(replay.analysis().recomputedResult, record.result);
});

test("collision audit preserves and strictly checks collider position and tick evidence", () => {
  const record = makeLiveCollisionRecord();
  const collision = record.events.find(event => event.type === "violation");
  assert.deepEqual(
    { type: collision.violationType, colliderId: collision.colliderId, tick: collision.tick, x: collision.x, z: collision.z },
    { type: "collision", colliderId: "ball-stop", tick: 10, x: 0.19, z: 0 }
  );
  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));

  const forgedPosition = clone(record);
  forgedPosition.events.find(event => event.type === "violation").x += 0.01;
  assert.equal(new ReplayPlayer(forgedPosition).verify().ok, false);

  const forgedTick = clone(record);
  forgedTick.events.find(event => event.type === "violation").tick += 1;
  assert.equal(new ReplayPlayer(forgedTick).verify().ok, false);
});

test("legacy .4 sampled-event compatibility is forward-only, bounded, and one-to-one", () => {
  const current = makeLiveSpeedingRecord();
  const currentPlayer = new ReplayPlayer(current);
  const delayedCurrent = clone(current);
  delayedCurrent.events.find(event => event.type === "violation").t = 100;
  assert.equal(new ReplayPlayer(delayedCurrent).verify().ok, false,
    "current rule versions must retain exact 20ms event timing");

  const legacy = clone(delayedCurrent);
  legacy.ruleVersion = "2026.08-configurable.4";
  const legacyPlayer = new ReplayPlayer(legacy);
  assert.equal(legacyPlayer.verify().ok, true, legacyPlayer.verify().diagnostics.join("\n"));
  assert.deepEqual(legacyPlayer.analysis().recomputedResult, currentPlayer.analysis().recomputedResult,
    "ruleVersion may select evidence-time compatibility but must not drive recomputation");

  const missingViolation = clone(legacy);
  missingViolation.events = missingViolation.events.filter(event => event.type !== "violation");
  assert.equal(new ReplayPlayer(missingViolation).verify().ok, false,
    "deleting recomputed violation evidence must fail reverse completeness");

  const wrongViolation = clone(legacy);
  wrongViolation.events.find(event => event.type === "violation").violationType = "off_road";
  assert.equal(new ReplayPlayer(wrongViolation).verify().ok, false);

  const earlyViolation = clone(legacy);
  earlyViolation.events.find(event => event.type === "violation").t = 0;
  assert.equal(new ReplayPlayer(earlyViolation).verify().ok, false,
    "legacy evidence cannot precede the independently derived event");

  const tooLateViolation = clone(legacy);
  tooLateViolation.events.find(event => event.type === "violation").t = 121;
  assert.equal(new ReplayPlayer(tooLateViolation).verify().ok, false,
    "legacy evidence cannot lag the independently derived event by more than 100ms");

  const legacyTask = makeV4DeliveryRecord({ releaseTick: 10, timeLimitTicks: 30 });
  legacyTask.ruleVersion = "2026.08-configurable.4";
  legacyTask.simulationEndTick = 20;
  legacyTask.result.simulationTick = 20;
  legacyTask.samples.at(-1).tick = 20;
  legacyTask.samples.at(-1).t = 400;
  legacyTask.events.filter(event => ["package_delivered", "task_completed"].includes(event.type))
    .forEach(event => { event.t = 280; });
  legacyTask.events.find(event => event.type === "run_finished").t = 400;
  const legacyTaskPlayer = new ReplayPlayer(legacyTask);
  assert.equal(legacyTaskPlayer.verify().ok, true, legacyTaskPlayer.verify().diagnostics.join("\n"));

  const strictTask = clone(legacyTask);
  strictTask.ruleVersion = "2026.08-configurable.5";
  assert.equal(new ReplayPlayer(strictTask).verify().ok, false,
    "task-event timing tolerance must be limited to the known .4 sampled cadence");

  const missingLifecycle = clone(legacy);
  missingLifecycle.events = missingLifecycle.events.filter(event => event.type !== "run_started");
  assert.equal(new ReplayPlayer(missingLifecycle).verify().ok, false,
    "lifecycle evidence remains exact and mandatory in legacy records");
});

test("v4 replay consumes same-tick typed inputs by sequence and excludes completion at the timeout boundary", () => {
  const sameTick = new ReplayPlayer(makeV4DeliveryRecord({ releaseTick: 0, timeLimitTicks: 1 }));
  assert.equal(sameTick.verify().ok, true, sameTick.verify().diagnostics.join("\n"));
  assert.deepEqual(
    sameTick.trajectory().filter(frame => frame.phase).map(frame => frame.phase),
    ["package_grab", "package_release"]
  );
  assert.equal(sameTick.analysis().recomputedResult.reason, "completed");

  const beforeBoundary = new ReplayPlayer(makeV4DeliveryRecord({ releaseTick: 9, timeLimitTicks: 10 }));
  assert.equal(beforeBoundary.analysis().recomputedResult.reason, "completed");
  assert.equal(beforeBoundary.analysis().recomputedResult.taskFinished, true);

  const boundaryRecord = makeV4DeliveryRecord({ releaseTick: 10, timeLimitTicks: 10 });
  boundaryRecord.events = [];
  boundaryRecord.result = {};
  const atBoundary = new ReplayPlayer(boundaryRecord);
  assert.equal(atBoundary.analysis().recomputedResult.reason, "timeout");
  assert.equal(atBoundary.analysis().recomputedResult.taskFinished, false,
    "an input at the exact time limit must not complete the task");
  assert.equal(atBoundary.analysis().recomputedResult.taskScore, 0);
});

test("v4 recorded samples, events, results, worlds, and claimed interaction outcomes never drive recomputation", () => {
  const base = makeV4DeliveryRecord();
  const expected = new ReplayPlayer(base).analysis().recomputedResult;
  assert.ok(expected);
  const cases = [
    ["sample", record => { record.samples.at(-1).x = 1.5; }],
    ["sample object role", record => { record.samples[0].packages[0].role = "target"; }],
    ["event", record => { record.events[0].type = "package_delivery_revoked"; }],
    ["event object role", record => {
      record.events.find(event => event.type === "package_grabbed").objectRole = "distractor";
    }],
    ["result", record => { record.result.score = 1; }],
    ["world", record => { record.inputs[0].world = clone(record.runDefinition.simulationDefinition.world); }],
    ["package outcome", record => {
      record.inputs[0].intent = { packageId: "forged", position: [999, 999] };
      record.inputs[0].packageId = "forged";
      record.inputs[0].position = [999, 999];
    }]
  ];

  cases.forEach(([label, mutate]) => {
    const tampered = clone(base);
    mutate(tampered);
    const player = new ReplayPlayer(tampered);
    assert.deepEqual(player.analysis().recomputedResult, expected, `${label} changed independently recomputed scoring`);
    assert.equal(player.verify().ok, false, `${label} tampering must be diagnosed`);
    assert.ok(player.verify().mismatches.length || player.verify().diagnostics.length,
      `${label} tampering must produce a concrete mismatch or diagnostic`);
  });
});

test("manual autonomy deductions come only from typed inputs and are counted once", () => {
  const record = makeV4DeliveryRecord({ manual: true });
  record.events.push({
    seq: Math.max(...[
      ...record.inputs,
      ...record.samples,
      ...record.events
    ].map(item => item.seq)) + 1,
    t: 100,
    type: "manual_control",
    action: "duplicated_client_event"
  });
  const player = new ReplayPlayer(record);
  const result = player.analysis().recomputedResult;
  assert.equal(result.autonomousScore, 7);
  assert.equal(result.score, 57);
});

test("PNG vision evidence verifies SHA-256, dimensions, prior references, tampering, and limits", () => {
  const evidence = normalizeVisionEvidence({
    schemaVersion: VISION_EVIDENCE_SCHEMA_VERSION,
    evidenceId: "evidence-1",
    frameId: "frame-1",
    tick: 0,
    stateRevision: 0,
    width: 1,
    height: 1,
    byteLength: Buffer.from(ONE_PIXEL_PNG_BASE64, "base64").length,
    sha256: pngSha256(),
    pngBase64: ONE_PIXEL_PNG_BASE64
  });
  assert.deepEqual(
    { width: evidence.width, height: evidence.height, sha256: evidence.sha256, mimeType: evidence.mimeType },
    { width: 1, height: 1, sha256: pngSha256(), mimeType: "image/png" }
  );
  assert.throws(() => normalizeVisionEvidence({ ...evidence, width: 2 }), /width does not match/);
  assert.throws(() => normalizeVisionEvidence({ ...evidence, sha256: "0".repeat(64) }), /SHA-256 does not match/);
  assert.throws(() => normalizeVisionEvidence({
    evidenceId: "oversized-dimension",
    pngBase64: pngWithDimensions(4097, 1)
  }), /dimensions must be between/);
  const headerOnlyPng = Buffer.alloc(24);
  [137, 80, 78, 71, 13, 10, 26, 10].forEach((value, index) => { headerOnlyPng[index] = value; });
  headerOnlyPng.write("IHDR", 12, "ascii");
  headerOnlyPng.writeUInt32BE(1, 16);
  headerOnlyPng.writeUInt32BE(1, 20);
  assert.throws(() => normalizeVisionEvidence({
    evidenceId: "header-only",
    pngBase64: headerOnlyPng.toString("base64")
  }), /complete PNG|PNG chunk|IEND/);

  const definition = makeDefinition();
  const record = {
    schemaVersion: SCHEMA_VERSION,
    runDefinition: {
      simulationDefinition: clone(definition),
      taskDefinition: { id: "vision-reach", type: "reach", goal: [0, 0], goalRadius: 0.1 },
      ruleDefinition: { vehicleRadius: 0.2, roads: [{ id: "road", width: 4, points: [[-2, 0], [2, 0]] }] },
      scoringDefinition: {},
      timeLimitTicks: 10
    },
    randomSeed: definition.seed,
    simulationEndTick: 0,
    inputs: [{
      seq: 3,
      t: 0,
      tick: 0,
      type: "vision_query",
      method: "detect",
      args: [],
      result: [{ type: "red" }],
      frameId: "frame-1",
      evidenceId: "evidence-1"
    }],
    visionFrames: [{ ...evidence, seq: 2, t: 0 }],
    samples: [{
      seq: 1,
      tick: 0,
      t: 0,
      x: 0,
      z: 0,
      heading: -Math.PI / 2,
      speed: 0,
      steering: 0,
      holding: null,
      cameraFrameId: "frame-1"
    }],
    events: [
      { seq: 4, t: 0, type: "goal_reached", x: 0, z: 0 },
      { seq: 5, t: 0, type: "task_completed", completed: 1, total: 1 },
      { seq: 6, t: 0, type: "run_started" },
      { seq: 7, t: 0, type: "run_finished", reason: "completed", score: 60 }
    ],
    result: {}
  };
  const verified = new ReplayPlayer(record);
  assert.equal(verified.analysis().visionEvidenceVerified, true);
  assert.equal(verified.verify().ok, true, verified.verify().diagnostics.join("\n"));

  const badReference = clone(record);
  badReference.inputs[0].evidenceId = "missing-evidence";
  const referencePlayer = new ReplayPlayer(badReference);
  assert.equal(referencePlayer.analysis().visionEvidenceVerified, false);
  assert.match(referencePlayer.verify().diagnostics.join("\n"), /prior matching evidence/);

  const badPayload = clone(record);
  badPayload.visionFrames[0].pngBase64 = pngWithTamperedIdat();
  const payloadPlayer = new ReplayPlayer(badPayload);
  assert.equal(payloadPlayer.analysis().visionEvidenceVerified, false);
  assert.match(payloadPlayer.verify().diagnostics.join("\n"), /SHA-256 does not match/);
});

test("new v4 sessions freeze the vision contract and bind every evidence frame while old v4 remains compatible", () => {
  const definition = makeDefinition();
  const session = new CompetitionSession({
    taskId: "vision-binding",
    mapId: "vision-map",
    mapVersion: "1",
    ruleVersion: "1",
    timeLimitSeconds: 2,
    task: { id: "vision-binding", type: "reach", goal: [1, 0], goalRadius: 0.05 },
    rules: { vehicleRadius: 0.2, roads: [{ id: "road", width: 4, points: [[-2, 0], [2, 0]] }] },
    scoring: {}
  }, { simulationDefinition: definition });
  session.sample({
    tick: 0,
    x: definition.initialPose.x,
    z: definition.initialPose.z,
    heading: definition.initialPose.heading,
    speed: 0,
    steering: 0
  }, { forceRecord: true });
  const evidence = session.addVisionEvidence({ frameId: "bound-frame", pngBase64: ONE_PIXEL_PNG_BASE64 });
  const record = session.finish("program_finished");

  assert.deepEqual(record.runDefinition.visionDefinition, VISION_DEFINITION);
  assert.equal(evidence.cameraDefinitionHash, CAMERA_DEFINITION_HASH);
  assert.equal(evidence.detectorDefinitionHash, DETECTOR_DEFINITION_HASH);
  assert.deepEqual(normalizeVisionDefinition(record.runDefinition.visionDefinition), VISION_DEFINITION);
  assert.throws(() => normalizeVisionDefinition({ ...VISION_DEFINITION, version: "forged" }), /frozen virtual vision contract/);
  assert.equal(new ReplayPlayer(record).verify().ok, true);

  const missingBinding = clone(record);
  delete missingBinding.visionFrames[0].cameraDefinitionHash;
  const missingPlayer = new ReplayPlayer(missingBinding);
  assert.equal(missingPlayer.verify().ok, false);
  assert.match(missingPlayer.verify().diagnostics.join("\n"), /cameraDefinitionHash/);

  const wrongBinding = clone(record);
  wrongBinding.visionFrames[0].detectorDefinitionHash = "0".repeat(64);
  const wrongPlayer = new ReplayPlayer(wrongBinding);
  assert.equal(wrongPlayer.verify().ok, false);
  assert.match(wrongPlayer.verify().diagnostics.join("\n"), /detectorDefinitionHash/);

  const legacyV4 = clone(record);
  delete legacyV4.runDefinition.visionDefinition;
  delete legacyV4.visionFrames[0].cameraDefinitionHash;
  delete legacyV4.visionFrames[0].detectorDefinitionHash;
  assert.equal(new ReplayPlayer(legacyV4).verify().ok, true,
    "v4 records written before the frozen vision contract must not be rejected for missing hashes");
});

test("run_end preserves live lifecycle reasons and cannot forge or omit external termination", () => {
  const definition = makeDefinition();
  const telemetry = tick => ({
    tick,
    x: 0,
    z: 0,
    heading: -Math.PI / 2,
    speed: 0,
    steering: 0
  });
  const createSession = ({ goal = [1, 0], timeLimitTicks = 10 } = {}) => new CompetitionSession({
    taskId: "run-end-lifecycle",
    mapId: "run-end-map",
    mapVersion: "1",
    ruleVersion: "1",
    timeLimitSeconds: timeLimitTicks * definition.stepMs / 1000,
    task: { id: "run-end-task", type: "reach", goal, goalRadius: 0.05 },
    rules: { vehicleRadius: 0.2, roads: [{ id: "road", width: 4, points: [[-2, 0], [2, 0]] }] },
    scoring: { efficiency: { targetSeconds: 1, maxSeconds: 2 } }
  }, { simulationDefinition: definition }, { sampleIntervalMs: 20 });

  const externalRecord = reason => {
    const session = createSession();
    session.sample(telemetry(0), { forceRecord: true });
    session.sample(telemetry(1), { forceRecord: true });
    if (reason === "stopped") session.addManualInput("stop", { tick: 1, control: "stop_button" });
    return session.finish(reason);
  };
  const records = {
    program_error: externalRecord("program_error"),
    client_watchdog: externalRecord("client_watchdog"),
    stopped: externalRecord("stopped")
  };
  const completedSession = createSession({ goal: [0, 0] });
  records.completed = completedSession.sample(telemetry(0), { forceRecord: true }).record;
  const timeoutSession = createSession({ timeLimitTicks: 1 });
  timeoutSession.sample(telemetry(0), { forceRecord: true });
  records.timeout = timeoutSession.sample(telemetry(1), { forceRecord: true }).record;

  Object.entries(records).forEach(([reason, record]) => {
    assert.equal(record.result.reason, reason);
    assert.deepEqual(
      record.inputs.filter(input => input.type === "run_end").map(input => input.reason),
      [reason]
    );
    if (reason === "stopped") {
      assert.equal(record.inputs.filter(input => input.type === "manual_control").length, 1);
    }
    const player = new ReplayPlayer(record);
    assert.equal(player.analysis().recomputedResult.reason, reason);
    assert.equal(player.analysis().externalTerminationRecomputed, true);
    assert.equal(player.analysis().recomputationComplete, true);
    assert.equal(player.verify().ok, true, `${reason}: ${player.verify().diagnostics.join("\n")}`);
  });

  ["completed", "timeout"].forEach(forgedReason => {
    const forged = clone(records.program_error);
    forged.inputs.find(input => input.type === "run_end").reason = forgedReason;
    forged.result.reason = forgedReason;
    forged.events.find(event => event.type === "run_finished").reason = forgedReason;
    const player = new ReplayPlayer(forged);
    assert.equal(player.analysis().recomputedResult.reason, "program_finished");
    assert.equal(player.verify().ok, false);
    assert.match(player.verify().diagnostics.join("\n"), /run_end reason .* does not match derived program_finished/);
  });

  const afterRunEnd = clone(records.program_error);
  const nextSequence = Math.max(...[
    ...afterRunEnd.inputs,
    ...afterRunEnd.samples,
    ...afterRunEnd.events
  ].map(item => item.seq)) + 1;
  afterRunEnd.inputs.push({
    seq: nextSequence,
    t: definition.stepMs,
    tick: 1,
    type: "control",
    command: { kind: "wait", durationMs: definition.stepMs, durationTicks: 1 }
  });
  const afterRunEndPlayer = new ReplayPlayer(afterRunEnd);
  assert.equal(afterRunEndPlayer.analysis().recomputedResult.reason, "program_error");
  assert.equal(afterRunEndPlayer.verify().ok, false);
  assert.match(afterRunEndPlayer.verify().diagnostics.join("\n"), /inputs after run_end/);

  const missingRunEnd = clone(records.program_error);
  missingRunEnd.inputs = missingRunEnd.inputs.filter(input => input.type !== "run_end");
  const missingRunEndPlayer = new ReplayPlayer(missingRunEnd);
  assert.equal(missingRunEndPlayer.analysis().externalTerminationRecomputed, false);
  assert.equal(missingRunEndPlayer.analysis().recomputedResult.reason, "program_finished");
  assert.equal(missingRunEndPlayer.analysis().recomputationComplete, false);
  assert.equal(missingRunEndPlayer.verify().ok, false);
});

test("program finish records terminal telemetry between 100ms sampling boundaries", () => {
  const definition = makeDefinition();
  const session = new CompetitionSession({
    taskId: "terminal-sample-boundary",
    mapId: "terminal-sample-map",
    mapVersion: "1",
    ruleVersion: "1",
    timeLimitSeconds: 2,
    task: { id: "terminal-sample-task", type: "reach", goal: [4, 0], goalRadius: 0.01 },
    rules: { vehicleRadius: 0.2, roads: [{ id: "road", width: 4, points: [[-5, 0], [5, 0]] }] },
    scoring: {}
  }, { simulationDefinition: definition }, { sampleIntervalMs: 100 });
  const telemetry = tick => ({
    tick,
    x: definition.initialPose.x,
    z: definition.initialPose.z,
    heading: definition.initialPose.heading,
    speed: 0,
    steering: 0
  });
  session.sample(telemetry(0), { forceRecord: true });
  session.sample(telemetry(1));
  session.sample(telemetry(2));
  session.sample(telemetry(3));

  const record = session.finish("program_finished");
  const terminalSamples = record.samples.filter(sample => sample.tick === 3);
  assert.equal(record.simulationEndTick, 3);
  assert.equal(terminalSamples.length, 1,
    "finishing at 60ms must force the final tick even though the regular sample interval is 100ms");
  const runEnd = record.inputs.find(input => input.type === "run_end");
  assert.ok(terminalSamples[0].seq < runEnd.seq, "terminal telemetry must precede run_end in the evidence ledger");
  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  assert.deepEqual(replay.analysis().recomputedResult, record.result);
});

test("CompetitionSession derives time, task events, and scores from simulation ticks", () => {
  const definition = makeDefinition();
  const simulator = new DeterministicSimulator(definition);
  commandSequence().forEach(command => simulator.runCommand(command));
  const finalFrame = simulator.trajectory().at(-1);
  const config = {
    taskId: "tick-clock-task",
    mapId: "tick-clock-map",
    mapVersion: "1",
    ruleVersion: "1",
    timeLimitSeconds: 3,
    task: {
      type: "reach",
      goal: [finalFrame.x, finalFrame.z],
      goalRadius: 0.02
    },
    rules: {
      vehicleRadius: definition.vehicle.radius,
      roads: [{ id: "wide-road", width: 4, points: [[-2, 0], [2, 0]] }]
    },
    scoring: { efficiency: { targetSeconds: 1, maxSeconds: 3 } }
  };

  const runAtWallRate = wallAdvanceMs => {
    let wallNow = 1700000000000;
    const session = new CompetitionSession(config, {
      runId: "tick-clock-run",
      simulationDefinition: definition,
      randomSeed: definition.seed
    }, { now: () => wallNow, sampleIntervalMs: 100 });
    let completedRecord = null;
    simulator.trajectory().forEach(frame => {
      if (completedRecord) return;
      wallNow += wallAdvanceMs;
      const result = session.sample({
        tick: frame.tick,
        x: frame.x,
        z: frame.z,
        heading: frame.heading,
        speed: Math.abs(frame.linearSpeed),
        steering: frame.angularSpeed
      });
      completedRecord = result.record || null;
    });
    return completedRecord || session.finish("program_finished");
  };

  const fastWall = runAtWallRate(1);
  const heavilyThrottledWall = runAtWallRate(10000);
  assert.deepEqual(heavilyThrottledWall.samples, fastWall.samples);
  assert.deepEqual(heavilyThrottledWall.events, fastWall.events);
  assert.deepEqual(heavilyThrottledWall.result, fastWall.result);
  assert.equal(fastWall.result.reason, "completed");
  assert.equal(fastWall.result.simulationTick, 74);
  assert.equal(fastWall.result.durationSeconds, 1.5);
});

test("CompetitionSession rejects pose changes but permits kinematic changes within one simulation tick", () => {
  const definition = makeDefinition();
  const session = new CompetitionSession({
    taskId: "same-tick-state",
    timeLimitSeconds: 2,
    task: { type: "reach", goal: [4, 0], goalRadius: 0.01 },
    rules: { vehicleRadius: 0.2, roads: [{ id: "road", width: 4, points: [[-5, 0], [5, 0]] }] }
  }, { simulationDefinition: definition });
  const base = {
    tick: 0,
    x: definition.initialPose.x,
    z: definition.initialPose.z,
    heading: definition.initialPose.heading,
    speed: 0,
    steering: 0
  };

  session.sample(base, { forceRecord: true });
  assert.throws(() => session.sample({ ...base, x: base.x + 0.1 }, { forceRecord: true }), /cannot change pose within the same tick/);
  const kinematicUpdate = session.sample({ ...base, speed: 1, steering: -0.5 }, { forceRecord: true });
  assert.equal(kinematicUpdate.sampled, true);
  assert.equal(session.status, "running");
  assert.equal(session.recorder.latestSample().tick, 0);
  assert.equal(session.recorder.latestSample().speed, 1);
  assert.equal(session.recorder.latestSample().steering, -0.5);
});

test("deterministic competition timeout is enforced at the simulation tick boundary", () => {
  let wallNow = 1700000000000;
  const definition = makeDefinition();
  const session = new CompetitionSession({
    taskId: "tick-timeout",
    timeLimitSeconds: 2,
    task: { type: "reach", goal: [4, 0], goalRadius: 0.01 },
    rules: { vehicleRadius: 0.2, roads: [{ id: "road", width: 4, points: [[-5, 0], [5, 0]] }] }
  }, { simulationDefinition: definition }, { now: () => wallNow });
  const telemetry = tick => ({ tick, x: tick / 100, z: 0, heading: -Math.PI / 2, speed: 0.5, steering: 0 });

  wallNow += 60 * 60 * 1000;
  assert.equal(session.sample(telemetry(99)).timedOut, undefined, "wall-clock throttling must not end the run");
  assert.equal(session.status, "running");
  const boundary = session.sample(telemetry(100));
  assert.equal(boundary.timedOut, true);
  assert.equal(boundary.record.result.reason, "timeout");
  assert.equal(boundary.record.result.durationSeconds, 2);
  assert.equal(boundary.record.result.simulationTick, 100);
  assert.equal(boundary.record.simulationEndTick, 100);
  assert.equal(boundary.record.samples.at(-1).tick, 100, "timeout telemetry must preserve the exact boundary tick");
  assert.equal(boundary.record.samples.at(-1).t, 2000);
});
