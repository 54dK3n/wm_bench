"use strict";

// Internal acceptance route for the frozen Guangyang configuration. This file is
// deliberately kept out of learner examples and the browser bundle: its known
// map geometry is only used to prove that all eight objectives are achievable.

const assert = require("node:assert/strict");
const CompetitionCore = require("../competition-core.js");

const config = CompetitionCore.GUANGYANG_ISLAND_CONFIG;
const sourceToWorld = point => CompetitionCore.geometry.sourcePixelToWorld(point);
const TWO_PI = Math.PI * 2;
const STEP_MS = 20;
// 30% resolves to 0.75 internal world units/s. It is the lowest road limit on the route, so the
// same deterministic command remains legal even where road corridors overlap.
const SPEED_WORLD_UNITS_PER_SECOND = 0.75;
const SPEED_PERCENT = 30;
const WORLD_UNITS_PER_METER = config.rules.unitsPerMeter;
const DRIVE_STEP_WORLD_UNITS = SPEED_WORLD_UNITS_PER_SECOND * STEP_MS / 1000;
const worldUnitsToCm = distance => distance * 100 / WORLD_UNITS_PER_METER;

function normalizeHeading(value) {
  const normalized = value % TWO_PI;
  return normalized < 0 ? normalized + TWO_PI : normalized;
}

function signedHeadingDelta(from, to) {
  let delta = normalizeHeading(to) - normalizeHeading(from);
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return delta;
}

function approachPoint(from, target, standoff) {
  const dx = target[0] - from[0];
  const dz = target[1] - from[1];
  const distance = Math.hypot(dx, dz);
  assert.ok(distance > standoff, "approach segment must be longer than its standoff");
  return [
    target[0] - dx / distance * standoff,
    target[1] - dz / distance * standoff
  ];
}

function resolvedTaskDefinition() {
  return {
    ...config.task,
    id: config.taskId,
    version: config.taskVersion,
    checkpoints: config.checkpoints,
    goal: config.goal
  };
}

function interactionDefinition() {
  return {
    schemaVersion: CompetitionCore.INTERACTION_SCHEMA_VERSION,
    packageRadius: config.objectTaskOverlay.packageRadius,
    stackKeyDigits: 3,
    bounds: { minX: -20, maxX: 20, minZ: -12, maxZ: 12 },
    grab: { minForward: 0.38, maxForward: 1.35, maxLateral: 0.38 },
    release: { forwardOffset: 1.1, lateralOffset: 0, stackSnapDistance: 0.62 },
    packages: config.objectTaskOverlay.objects.map(item => ({
      id: item.id,
      role: item.role,
      x: item.position[0],
      z: item.position[1],
      radius: item.radius,
      stackLevel: 0
    }))
  };
}

function simulationDefinition(colliders) {
  return {
    schemaVersion: CompetitionCore.SIMULATION_SCHEMA_VERSION,
    stepMs: STEP_MS,
    seed: 0,
    initialPose: { x: config.start[0], z: config.start[1], heading: config.start[2] },
    vehicle: {
      version: CompetitionCore.VEHICLE_MODEL_VERSION,
      radius: config.rules.vehicleRadius,
      collisionSkin: 0.005,
      maxLinearSpeed: 2.5,
      maxAngularSpeed: 2.8
    },
    world: {
      bounds: { minX: -20, maxX: 20, minZ: -12, maxZ: 12 },
      colliders
    }
  };
}

function runRoute({ collisionRecovery = false } = {}) {
  const packages = new CompetitionCore.PackageStateEngine(interactionDefinition());
  const simulator = new CompetitionCore.DeterministicSimulator(simulationDefinition(packages.colliders()));
  const task = new CompetitionCore.TaskEngine(resolvedTaskDefinition());
  const rules = new CompetitionCore.RuleEngine(config.rules);
  const actions = [];
  const taskEvents = [];
  const ruleViolations = [];
  let previousRuleSample = null;

  const packageObservation = elapsedMs => {
    const pose = simulator.snapshot().pose;
    const state = packages.snapshot();
    const evaluation = task.evaluate({
      x: pose.x,
      z: pose.z,
      elapsedMs,
      holding: state.holding,
      packages: state.packages
    }, elapsedMs);
    taskEvents.push(...evaluation.events);
    return evaluation;
  };

  const observeFrame = frame => {
    const sample = {
      x: frame.x,
      z: frame.z,
      heading: frame.heading,
      speed: Math.abs(frame.linearSpeed),
      elapsedMs: frame.elapsedMs
    };
    const ruleResult = rules.evaluate(sample, previousRuleSample, frame.elapsedMs);
    ruleViolations.push(...ruleResult.violations.map(item => ({ ...item, elapsedMs: frame.elapsedMs })));
    previousRuleSample = sample;
    if (frame.collision) {
      task.noteCollision(frame.collision.colliderId);
      ruleViolations.push({
        type: "collision",
        elapsedMs: frame.collision.elapsedMs,
        tick: frame.collision.tick,
        colliderId: frame.collision.colliderId,
        x: frame.collision.x,
        z: frame.collision.z
      });
    }
    packageObservation(frame.elapsedMs);
  };

  const runCommand = (command, action) => {
    const collisionCountBefore = simulator.snapshot().collisionCount;
    simulator.setWorld({
      bounds: { minX: -20, maxX: 20, minZ: -12, maxZ: 12 },
      colliders: packages.colliders()
    });
    const result = simulator.runCommand(command);
    result.frames.forEach(observeFrame);
    if (action.expectedCollisionId) {
      assert.equal(result.result.blocked, true, `collision route did not hit: ${action.label}`);
      const commandCollisions = result.snapshot.collisions.slice(collisionCountBefore);
      assert.deepEqual(commandCollisions.map(item => item.colliderId), [action.expectedCollisionId],
        `collision route hit the wrong collider: ${action.label}`);
    } else {
      assert.equal(result.result.blocked, false, `route command was blocked: ${action.label}`);
    }
    actions.push({ ...action, endPose: { ...result.snapshot.pose } });
  };

  const turnToward = (point, label) => {
    const pose = simulator.snapshot().pose;
    const desired = normalizeHeading(Math.atan2(-(point[0] - pose.x), -(point[1] - pose.z)));
    const delta = signedHeadingDelta(pose.heading, desired);
    const degrees = Math.abs(delta) * 180 / Math.PI;
    // The public Python angle API accepts 1..360 degrees. Sub-degree corrections
    // are deliberately skipped so this acceptance sequence remains executable
    // through the same API instead of relying on a core-only capability.
    if (degrees < 1) return;
    const durationMs = Math.ceil(Math.max(260, Math.abs(delta) / 2.8 * 1000) / STEP_MS) * STEP_MS;
    const direction = delta > 0 ? "left" : "right";
    runCommand({
      kind: "turn_angle",
      direction,
      angleDegrees: degrees,
      durationMs
    }, { type: direction === "left" ? "left_angle" : "right_angle", degrees, label });
  };

  const driveTo = (point, label) => {
    turnToward(point, `${label} / 对准`);
    const pose = simulator.snapshot().pose;
    const distance = Math.hypot(point[0] - pose.x, point[1] - pose.z);
    const durationTicks = Math.max(1, Math.ceil(distance / DRIVE_STEP_WORLD_UNITS - 1e-9));
    const durationMs = durationTicks * STEP_MS;
    runCommand({
      kind: "drive",
      direction: 1,
      durationMs,
      durationTicks,
      speedPercent: SPEED_PERCENT
    }, {
      type: "forward",
      seconds: durationMs / 1000,
      speedPercent: SPEED_PERCENT,
      distanceCm: worldUnitsToCm(durationMs / 1000 * SPEED_WORLD_UNITS_PER_SECOND),
      label
    });
  };

  const driveUntilCollision = (point, colliderId, label) => {
    turnToward(point, `${label} / 对准`);
    const pose = simulator.snapshot().pose;
    const distance = Math.hypot(point[0] - pose.x, point[1] - pose.z);
    const durationTicks = Math.max(1, Math.ceil(distance / DRIVE_STEP_WORLD_UNITS - 1e-9));
    const durationMs = durationTicks * STEP_MS;
    runCommand({
      kind: "drive",
      direction: 1,
      durationMs,
      durationTicks,
      speedPercent: SPEED_PERCENT
    }, {
      type: "forward",
      seconds: durationMs / 1000,
      speedPercent: SPEED_PERCENT,
      distanceCm: worldUnitsToCm(durationMs / 1000 * SPEED_WORLD_UNITS_PER_SECOND),
      label,
      expectedCollisionId: colliderId
    });
  };

  const interact = (kind, expectedId, label) => {
    const pose = simulator.snapshot().pose;
    const outcome = packages.apply(kind, { packageId: expectedId }, pose);
    assert.equal(outcome.accepted, true, `${label}: ${outcome.reason}`);
    assert.equal(outcome.packageId, expectedId, `${label}: unexpected package`);
    actions.push({ type: kind, packageId: expectedId, label, pose: { ...pose }, outcome });
    packageObservation(simulator.snapshot().elapsedMs);
    return outcome;
  };

  packageObservation(0);

  // North-west target and storage objective.
  const northWestEntry = [365, 234];
  [
    [593, 205], [593, 235], [500, 235], [410, 236], northWestEntry
  ].forEach((point, index) => driveTo(sourceToWorld(point), `西北目标路线 ${index + 1}`));

  const target = config.objectTaskOverlay.objects.find(item => item.role === "target");
  const storage = config.objectTaskOverlay.zones.find(item => item.role === "storage");
  const targetApproach = approachPoint(sourceToWorld(northWestEntry), target.position, 0.92);
  driveTo(targetApproach, "目标物抓取位");
  interact("grab", target.id, "抓取目标物");
  const storageApproach = approachPoint(targetApproach, storage.position, 1.1);
  driveTo(storageApproach, "存放点释放位");
  interact("release", target.id, "目标物放入存放点");

  // Checkpoint 1, then move the south-west distractor completely beyond the
  // road edge while the vehicle itself remains in the Huangge spur corridor. The
  // west-south connector is intentionally never used because its centerline is
  // occupied by the required avoidance object.
  [
    [365, 234], [410, 236], [500, 235], [593, 235], [594, 307], [593, 333],
    [593, 388], [594, 470], [593, 556], [520, 556], [450, 557], [394, 559]
  ].forEach((point, index) => driveTo(sourceToWorld(point), `检查点一至黄葛林 ${index + 1}`));

  const distractor = config.objectTaskOverlay.objects.find(item => item.role === "distractor");
  const distractorApproach = approachPoint(sourceToWorld([394, 559]), distractor.position, 0.92);
  driveTo(distractorApproach, "混淆物抓取位");
  interact("grab", distractor.id, "抓取混淆物");
  driveTo(sourceToWorld([397, 610]), "道路外移除入口");
  driveTo(sourceToWorld([414.4, 610]), "道路内释放位");
  const offroadReleasePose = { ...simulator.snapshot().pose };
  assert.equal(CompetitionCore.geometry.nearestRoad(
    [offroadReleasePose.x, offroadReleasePose.z],
    config.roads,
    config.rules.vehicleRadius
  ).onRoad, true, "vehicle must remain fully inside the road while releasing the distractor");
  const offroadRelease = interact("release", distractor.id, "混淆物移出道路");
  const releaseRoadClearance = CompetitionCore.geometry.roadBoundaryClearance(
    offroadRelease.position,
    config.roads,
    distractor.radius
  );
  assert.ok(releaseRoadClearance.clearance + 1e-9 >= 0.2,
    "the complete distractor body must clear every road edge by the required safety margin");

  // Return through the lower/central roads for checkpoints 2 and 3.
  [
    [397, 610], [394, 559], [450, 557], [520, 556], [593, 556], [594, 470], [593, 388]
  ].forEach((point, index) => driveTo(sourceToWorld(point), `检查点二入口 ${index + 1}`));

  if (collisionRecovery) {
    // Negative/recovery acceptance only: enter the west obstacle connector,
    // hit the one required avoidance object, retreat along the same corridor,
    // and then rejoin the safe route. This remains an internal test route.
    [
      [298, 388], [298, 430]
    ].forEach((point, index) => driveTo(sourceToWorld(point), `指定障碍碰撞入口 ${index + 1}`));
    driveUntilCollision(
      sourceToWorld([319, 480]),
      "object:guangyang-obstacle-1",
      "指定障碍碰撞"
    );
    [
      [298, 430], [298, 388], [593, 388]
    ].forEach((point, index) => driveTo(sourceToWorld(point), `碰撞后恢复路线 ${index + 1}`));
  }

  [
    [700, 388], [800, 388], [865, 388], [869, 367], [874, 357], [882, 347],
    [892, 337], [902, 327], [906, 307], [902, 327], [892, 337], [882, 347],
    [874, 357], [869, 367], [865, 388], [868, 407], [875, 417], [883, 427]
  ].forEach((point, index) => driveTo(sourceToWorld(point), `检查点二与三 ${index + 1}`));

  // East-inner-south reaches checkpoint 4; lower-east and central roads return
  // to the parking start/finish without entering the south slow zone.
  [
    [891, 437], [899, 447], [906, 456], [913, 480], [915, 500], [912, 520],
    [905, 540], [896, 560], [881, 580], [860, 600], [838, 620], [817, 635],
    [803, 620], [790, 612], [775, 598], [760, 584], [746, 570], [730, 562],
    [700, 556], [593, 556], [594, 470], [593, 388], [594, 307], [593, 235],
    [593, 205], [593, 164]
  ].forEach((point, index) => driveTo(sourceToWorld(point), `检查点四与返航 ${index + 1}`));

  const taskState = task.snapshot();
  const packageState = packages.snapshot();
  const finalPose = simulator.snapshot().pose;
  const obstacleId = "guangyang-obstacle-1";
  const distractorFinal = packageState.packages.find(item => item.id === distractor.id);
  const distractorDelivery = task.definition().deliveries.find(item => item.objectRole === "distractor");
  const distractorRoadClearance = CompetitionCore.geometry.roadBoundaryClearance(
    [distractorFinal.x, distractorFinal.z],
    config.roads,
    distractor.radius
  );
  const obstacleCollisions = simulator.snapshot().collisions
    .filter(item => item.colliderId === `object:${obstacleId}`);

  assert.equal(taskState.finished, !collisionRecovery,
    collisionRecovery ? "the collision route must remain incomplete" : "the composite task must finish");
  assert.equal(taskState.completed, collisionRecovery ? 7 : 8,
    collisionRecovery ? "only the avoidance unit must fail" : "all eight objective units must complete");
  assert.deepEqual(taskState.visitedCheckpointIds, config.checkpoints.map(item => item.id));
  assert.deepEqual([...taskState.deliveredPackageIds].sort(), [distractor.id, target.id].sort());
  assert.equal(taskState.goalReached, true);
  assert.equal(taskState.avoidanceProgress.completed, collisionRecovery ? 0 : 1);
  assert.deepEqual(taskState.avoidanceProgress.failedObjectIds,
    collisionRecovery ? [obstacleId] : []);
  assert.equal(obstacleCollisions.length, collisionRecovery ? 1 : 0);
  assert.equal(simulator.snapshot().collisionCount, collisionRecovery ? 1 : 0);
  assert.equal(ruleViolations.filter(item => item.type === "collision").length,
    collisionRecovery ? 1 : 0);
  assert.deepEqual(ruleViolations.filter(item => item.type !== "collision"), [],
    "the acceptance route must not leave a road, speed, or violate another driving rule");
  assert.equal(distractorDelivery.placementRule, "road-edge-clearance");
  assert.equal(Object.prototype.hasOwnProperty.call(distractorDelivery, "destination"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(distractorDelivery, "radius"), false);
  assert.ok(distractorRoadClearance.clearance + 1e-9 >= distractorDelivery.minimumRoadEdgeClearance,
    `distractor does not clear road ${distractorRoadClearance.road?.id || "unknown"} by the required margin`);
  assert.ok(Math.hypot(finalPose.x - config.goal[0], finalPose.z - config.goal[1]) <= config.task.goalRadius);

  const durationSeconds = simulator.snapshot().elapsedMs / 1000;
  const ruleMetrics = rules.metrics(simulator.snapshot().elapsedMs);
  const score = new CompetitionCore.CompetitionJudge(config.scoring).score({
    task: taskState,
    violations: ruleViolations,
    violationMetrics: ruleMetrics,
    durationSeconds,
    manualInterventions: 0
  });

  return {
    taskState,
    finalPose,
    packageState,
    actions,
    taskEvents,
    ruleViolations,
    ruleMetrics,
    durationSeconds,
    score,
    offroadRemoval: {
      releasePose: offroadReleasePose,
      package: distractorFinal,
      clearance: distractorRoadClearance
    },
    distanceMeters: actions
      .filter(action => action.type === "forward")
      .reduce((sum, action) => sum + action.distanceCm / 100, 0),
    collisions: simulator.snapshot().collisions
  };
}

if (require.main === module) {
  const result = runRoute();
  const compactActions = result.actions.map(action => action.type === "forward"
    ? `robot.forward(${action.distanceCm.toFixed(4)})  # ${action.label}`
    : action.type === "left_angle" || action.type === "right_angle"
      ? `robot.${action.type}(${action.degrees.toFixed(2)})  # ${action.label}`
      : `robot.${action.type}()  # ${action.label}`);
  console.log(JSON.stringify({
    completed: `${result.taskState.completed}/${result.taskState.total}`,
    visitedCheckpointIds: result.taskState.visitedCheckpointIds,
    deliveredPackageIds: result.taskState.deliveredPackageIds,
    avoidanceProgress: result.taskState.avoidanceProgress,
    goalReached: result.taskState.goalReached,
    durationSeconds: result.durationSeconds,
    distanceMeters: Number(result.distanceMeters.toFixed(2)),
    collisionCount: result.collisions.length,
    ruleViolations: result.ruleViolations,
    ruleMetrics: result.ruleMetrics,
    score: result.score,
    finalPose: result.finalPose,
    actions: compactActions
  }, null, 2));
}

function runRecoveryRoute() {
  return runRoute({ collisionRecovery: true });
}

module.exports = { runRoute, runRecoveryRoute };
