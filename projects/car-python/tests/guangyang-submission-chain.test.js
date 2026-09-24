"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
  CompetitionSession,
  DeterministicSimulator,
  ReplayPlayer,
  GUANGYANG_ISLAND_CONFIG,
  GUANGYANG_CHALLENGE_CONFIGS,
  NAVIGATION_DEFINITION,
  PUBLIC_NAVIGATION_DEFINITION,
  NAVIGATION_CONTROL_DEFINITION,
  projectNavigationQuery,
  geometry
} = require("../competition-core.js");
const { canonicalSha256 } = require("../backend/canonical-json.js");
const { verifyRecord } = require("../tools/verify-run-record.js");
const { LOCAL_CHALLENGES, createServer } = require("../server.js");
const { GuangyangMapConfigStore } = require("../backend/guangyang-map-config-store.js");
const { MAP_POOL_COUNTS, variantId } = require("../backend/guangyang-map-pool.js");
const { runRoute } = require("../tools/validate-guangyang-safe-route.js");
const { runRecoveryRoute } = require("../tools/validate-guangyang-recovery-route.js");

const STEP_MS = 20;
const RESULT_FIELDS = [
  "score", "taskScore", "ruleScore", "autonomousScore", "efficiencyScore", "ruleDeduction",
  "eventDeduction", "durationDeduction", "durationSeconds", "completedTasks", "totalTasks",
  "taskValid", "taskFinished", "reason", "simulationTick"
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function turnDurationMs(degrees) {
  const radians = Number(degrees) * Math.PI / 180;
  return Math.ceil(Math.max(260, radians / 2.8 * 1000) / STEP_MS) * STEP_MS;
}

function centimeterDriveCommand(distanceCm, direction, unitsPerMeter = 8) {
  const worldDistance = Number(distanceCm) * Number(unitsPerMeter) / 100;
  const nominalSpeed = 2.5 * 0.5;
  const durationTicks = Math.max(1,
    Math.ceil(worldDistance / (nominalSpeed * STEP_MS / 1000)));
  const durationMs = durationTicks * STEP_MS;
  return {
    kind: "drive",
    direction,
    durationMs,
    durationTicks,
    speed: worldDistance / (durationMs / 1000)
  };
}

function request(origin, { method = "GET", requestPath = "/", headers = {}, body } = {}) {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const clientRequest = http.request({
      hostname: target.hostname,
      port: target.port,
      method,
      path: requestPath,
      headers: { Connection: "close", ...headers }
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    clientRequest.once("error", reject);
    clientRequest.end(body);
  });
}

function jsonBodyRequest(origin, requestPath, value, { cookie, token } = {}) {
  const body = Buffer.from(JSON.stringify(value));
  return request(origin, {
    method: "POST",
    requestPath,
    headers: {
      Origin: origin,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body
  });
}

function responseJson(response) {
  assert.match(response.headers["content-type"] || "", /^application\/json\b/i);
  return JSON.parse(response.body.toString("utf8"));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}

function createLiveGuangyangRecord(binding = {}, route = runRoute()) {
  const challengeConfig = binding.challengeConfig || GUANGYANG_ISLAND_CONFIG;
  const runDefinition = clone(binding.runDefinition || LOCAL_CHALLENGES[challengeConfig.taskId].runDefinition);
  const simulator = new DeterministicSimulator(runDefinition.simulationDefinition);
  const session = new CompetitionSession(challengeConfig, {
    teamId: binding.teamId || "guangyang-submission-audit",
    runId: binding.runId || "run_guangyang_submission_audit",
    serverSessionId: binding.serverSessionId || "ses_11111111111111111111111111111111",
    challengeDigest: binding.challengeDigest || canonicalSha256(runDefinition),
    runDefinition,
    simulationDefinition: runDefinition.simulationDefinition,
    interactionDefinition: runDefinition.interactionDefinition,
    sourceCode: "# internal acceptance fixture; not a learner route"
  }, { now: () => 0, sampleIntervalMs: STEP_MS });

  const sampleFrame = (frame, forceRecord = false) => {
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
    }, { forceRecord });
  };

  const runCommand = command => {
    simulator.setWorld({
      bounds: clone(runDefinition.simulationDefinition.world.bounds),
      colliders: session.packageStateEngine.colliders()
    });
    const started = simulator.startCommand(command);
    session.addSimulationInput(started.command, {
      tick: started.startState.tick,
      startState: started.startState,
      source: "python"
    });
    while (simulator.hasActiveCommand() && session.status === "running") {
      sampleFrame(simulator.step());
    }
  };

  sampleFrame(simulator.snapshot(), true);
  for (const action of route.actions) {
    if (session.status !== "running") break;
    if (action.type === "forward" || action.type === "backward") {
      runCommand(centimeterDriveCommand(
        action.distanceCm,
        action.type === "forward" ? 1 : -1,
        challengeConfig.rules.unitsPerMeter
      ));
    } else if (action.type === "left_angle" || action.type === "right_angle") {
      runCommand({
        kind: "turn_angle",
        direction: action.type === "left_angle" ? "left" : "right",
        angleDegrees: action.degrees,
        durationMs: turnDurationMs(action.degrees)
      });
    } else if (action.type === "grab" || action.type === "release") {
      const outcome = session.addInteractionInput(action.type, { tick: simulator.tick, source: "python" });
      assert.equal(outcome.accepted, true, `${action.label}: ${outcome.reason}`);
      assert.equal(outcome.packageId, action.packageId, `${action.label}: unexpected package`);
      sampleFrame(simulator.snapshot(), true);
    } else {
      assert.fail(`unsupported acceptance action: ${action.type}`);
    }
  }

  const record = session.finalRecord || session.finish("program_finished");
  return { record, route, session };
}

function integerAngleLearnerRoute(
  challengeConfig = GUANGYANG_ISLAND_CONFIG,
  filename = "guangyang_direct_integer_high_score.py"
) {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../examples", filename),
    "utf8"
  );
  const packageOrder = [
    ...challengeConfig.objectTaskOverlay.objects.filter(item => item.role === "target"),
    ...challengeConfig.objectTaskOverlay.objects.filter(item => item.role === "distractor")
  ].map(item => item.id);
  let grabIndex = 0;
  let holding = null;
  const actions = [...source.matchAll(
    /robot\.(forward|backward|left_angle|right_angle|grab|release)\(([^)]*)\)/g
  )].map((match, index) => {
    const type = match[1];
    const args = match[2].split(",").map(value => value.trim()).filter(Boolean);
    if (type === "forward" || type === "backward") {
      assert.equal(args.length, 1, "learner route drive must use the one-argument centimeter API");
      assert.match(args[0], /^\d+\.\d$/, "learner route drive distance must use exactly one decimal place");
      return { type, distanceCm: Number(args[0]), label: `action-${index}` };
    }
    if (type === "left_angle" || type === "right_angle") {
      assert.match(args[0], /^\d+$/, "learner route angle must be an integer");
      return { type, degrees: Number(args[0]), label: `action-${index}` };
    }
    if (type === "grab") {
      holding = packageOrder[grabIndex++];
      return { type, packageId: holding, label: `action-${index}` };
    }
    const packageId = holding;
    holding = null;
    return { type, packageId, label: `action-${index}` };
  });
  return { actions, source };
}

function createFormalObstacleCollisionRecord() {
  const runDefinition = clone(LOCAL_CHALLENGES[GUANGYANG_ISLAND_CONFIG.taskId].runDefinition);
  const simulator = new DeterministicSimulator(runDefinition.simulationDefinition);
  const session = new CompetitionSession(GUANGYANG_ISLAND_CONFIG, {
    teamId: "guangyang-collision-audit",
    runId: "run_guangyang_collision_audit",
    serverSessionId: "ses_22222222222222222222222222222222",
    challengeDigest: canonicalSha256(runDefinition),
    runDefinition,
    simulationDefinition: runDefinition.simulationDefinition,
    interactionDefinition: runDefinition.interactionDefinition
  }, { now: () => 0, sampleIntervalMs: STEP_MS });
  let collisionCount = 0;

  const sampleFrame = frame => {
    if (frame.collision) {
      collisionCount += 1;
      session.recordViolation("collision", {
        colliderId: frame.collision.colliderId,
        tick: frame.collision.tick,
        x: frame.collision.x,
        z: frame.collision.z
      }, frame.collision.elapsedMs);
    }
    const pose = frame.pose || frame.state?.pose || frame;
    return session.sample({
      tick: frame.tick ?? frame.state?.tick,
      x: pose.x,
      z: pose.z,
      heading: pose.heading,
      speed: Math.abs(Number(frame.linearSpeed ?? 0)),
      steering: Number(frame.angularSpeed ?? 0)
    }, { forceRecord: true });
  };
  const runCommand = command => {
    simulator.setWorld({
      bounds: clone(runDefinition.simulationDefinition.world.bounds),
      colliders: session.packageStateEngine.colliders()
    });
    const started = simulator.startCommand(command);
    session.addSimulationInput(started.command, {
      tick: started.startState.tick,
      startState: started.startState,
      source: "python"
    });
    while (simulator.hasActiveCommand()) sampleFrame(simulator.step());
  };
  const normalizeHeading = value => {
    const normalized = value % (Math.PI * 2);
    return normalized < 0 ? normalized + Math.PI * 2 : normalized;
  };
  const driveTo = point => {
    const pose = simulator.snapshot().pose;
    const targetHeading = normalizeHeading(Math.atan2(-(point[0] - pose.x), -(point[1] - pose.z)));
    let delta = targetHeading - normalizeHeading(pose.heading);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    const degrees = Math.abs(delta) * 180 / Math.PI;
    if (degrees >= 1) {
      runCommand({
        kind: "turn_angle",
        direction: delta > 0 ? "left" : "right",
        angleDegrees: degrees,
        durationMs: turnDurationMs(degrees)
      });
    }
    const aligned = simulator.snapshot().pose;
    const distance = Math.hypot(point[0] - aligned.x, point[1] - aligned.z);
    runCommand({
      kind: "drive",
      direction: 1,
      speedPercent: 30,
      durationMs: Math.ceil(distance / (0.75 * STEP_MS / 1000) - 1e-9) * STEP_MS
    });
  };

  sampleFrame(simulator.snapshot());
  [
    [593, 235], [593, 388], [298, 388], [298, 430], [302, 460], [319, 480]
  ].map(point => geometry.sourcePixelToWorld(point))
    .forEach(driveTo);

  assert.ok(collisionCount > 0, "the audit route must hit the required formal obstacle");
  return session.finish("program_finished");
}

test("the full Guangyang live session is a complete verified run-record/v4 submission", { timeout: 20_000 }, () => {
  const { record, route, session } = createLiveGuangyangRecord();

  assert.equal(session.taskEngine.snapshot().completed, 8);
  assert.equal(record.result.reason, "completed");
  assert.equal(record.result.score, 100);
  assert.equal(route.score.score, 98.8,
    "the conservative 30% core route keeps its independently frozen timing score");
  assert.equal(record.runDefinition.taskDefinition.schemaVersion, "chenlong.task/v5");
  assert.equal(record.runDefinition.interactionDefinition.schemaVersion, "chenlong.package-interaction/v2");
  assert.deepEqual(record.runDefinition.navigationControlDefinition, NAVIGATION_CONTROL_DEFINITION);
  assert.equal(record.inputs.some(input => input.type === "vision_query"), false);
  assert.deepEqual(record.visionFrames, []);
  assert.equal(RESULT_FIELDS.every(field => Object.prototype.hasOwnProperty.call(record.result, field)), true);
  assert.equal(canonicalSha256(record.runDefinition), record.challengeDigest);

  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  assert.equal(replay.analysis().recomputationComplete, true);
  assert.deepEqual(replay.analysis().recomputedResult, record.result);

  const report = verifyRecord(record, { source: "guangyang-submission-audit" });
  assert.equal(report.status, "verified", report.replay.diagnostics.join("\n"));
  assert.equal(report.capabilities.recomputationComplete, true);
  assert.equal(report.capabilities.visionQueryCount, 0);
  assert.equal(report.resultComparison.complete, true);
  assert.equal(report.resultComparison.matched, true);

  const cli = spawnSync(process.execPath, [path.resolve(__dirname, "../tools/verify-run-record.js"), "-"], {
    input: JSON.stringify(record),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 20_000
  });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const cliReport = JSON.parse(cli.stdout);
  assert.equal(cliReport.status, "verified");
  assert.equal(cliReport.recomputedResult.score, 100);
});

test("integer-angle, one-decimal-centimeter learner route completes 8/8 without perception", { timeout: 20_000 }, () => {
  const route = integerAngleLearnerRoute();
  const { record, session } = createLiveGuangyangRecord({
    teamId: "integer-angle-route-audit",
    runId: "run_integer_angle_route_audit"
  }, route);

  assert.equal(session.taskEngine.snapshot().completed, 8);
  assert.equal(record.result.reason, "completed");
  assert.equal(record.result.score, 100);
  assert.equal(record.result.ruleScore, 25);
  assert.equal(record.result.autonomousScore, 15);
  assert.equal(record.events.some(event => event.type === "violation"), false);
  assert.equal(record.inputs.some(input => input.type === "navigation_query"), false);
  assert.equal(record.inputs.some(input => input.type === "navigation_control"), false);
  assert.equal(record.inputs.some(input => input.type === "vision_query"), false);
});

test("challenge 2 and 3 fixed routes complete every task unit without perception", { timeout: 30_000 }, () => {
  const expectations = [
    { difficulty: 2, total: 13, minimumScore: 95 },
    { difficulty: 3, total: 18, minimumScore: 89 }
  ];
  for (const expectation of expectations) {
    const challengeConfig = GUANGYANG_CHALLENGE_CONFIGS[expectation.difficulty - 1];
    const route = integerAngleLearnerRoute(
      challengeConfig,
      `guangyang_challenge_${expectation.difficulty}_direct_integer_high_score.py`
    );
    const { record, session } = createLiveGuangyangRecord({
      challengeConfig,
      teamId: `challenge-${expectation.difficulty}-fixed-route-audit`,
      runId: `run_challenge_${expectation.difficulty}_fixed_route_audit`
    }, route);

    assert.equal(session.taskEngine.snapshot().completed, expectation.total);
    assert.equal(record.result.completedTasks, expectation.total);
    assert.equal(record.result.totalTasks, expectation.total);
    assert.equal(record.result.reason, "completed");
    assert.ok(record.result.score >= expectation.minimumScore,
      `challenge ${expectation.difficulty} fixed route scored ${record.result.score}`);
    assert.equal(record.result.ruleScore, 25);
    assert.equal(record.result.autonomousScore, 15);
    assert.equal(record.events.some(event => event.type === "violation"), false);
    assert.equal(record.inputs.some(input => input.type === "navigation_query"), false);
    assert.equal(record.inputs.some(input => input.type === "navigation_control"), false);
    assert.equal(record.inputs.some(input => input.type === "vision_query"), false);
  }
});

test("the full Guangyang collision-recovery route is verified while remaining an unsuccessful 7/8 result", { timeout: 20_000 }, () => {
  const { record, session } = createLiveGuangyangRecord({
    teamId: "guangyang-recovery-audit",
    runId: "run_guangyang_recovery_audit"
  }, runRecoveryRoute());

  assert.equal(session.taskEngine.snapshot().completed, 7);
  assert.equal(record.result.reason, "program_finished");
  assert.equal(record.result.completedTasks, 7);
  assert.equal(record.result.totalTasks, 8);
  assert.equal(record.result.taskFinished, false);
  assert.equal(record.result.taskScore, 35);
  assert.equal(record.result.ruleScore, 23.3);
  assert.equal(record.result.autonomousScore, 15);
  assert.equal(record.result.score, 73.3);
  assert.deepEqual(
    record.events.filter(event => event.type === "violation")
      .map(event => [event.violationType, event.colliderId]),
    [["collision", "object:guangyang-obstacle-1"]]
  );
  assert.equal(record.events.some(event => event.type === "task_completed"), false);

  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  assert.deepEqual(replay.analysis().task.avoidanceProgress.failedObjectIds, ["guangyang-obstacle-1"]);
  assert.equal(replay.analysis().task.goalReached, true);
  assert.equal(replay.analysis().recomputedResult.completedTasks, 7);
  assert.equal(replay.analysis().recomputedResult.taskFinished, false);
  assert.equal(replay.analysis().recomputedResult.score, 73.3);

  const report = verifyRecord(record, { source: "guangyang-recovery-audit" });
  assert.equal(report.status, "verified", report.replay.diagnostics.join("\n"));
  assert.deepEqual(report.reasonCodes, []);
  assert.equal(report.replay.verified, true);
  assert.equal(report.capabilities.recomputationComplete, true);
  assert.equal(report.resultComparison.matched, true);
  assert.equal(report.recomputedResult.taskFinished, false,
    "verified means internally complete, not that the competition task passed");
});

test("the Guangyang replay rejects removed or forged terminal evidence", { timeout: 20_000 }, () => {
  const { record } = createLiveGuangyangRecord();
  const taskCompleted = record.events.find(event => event.type === "task_completed");
  assert.ok(taskCompleted, "the live record must contain its terminal task event");

  const removed = clone(record);
  removed.events = removed.events.filter(event => event.seq !== taskCompleted.seq);
  assert.equal(verifyRecord(removed).status, "invalid");

  const forged = clone(record);
  forged.events.find(event => event.type === "run_finished").score = 60;
  assert.equal(verifyRecord(forged).status, "invalid");

  const incompleteResult = clone(record);
  delete incompleteResult.result.durationDeduction;
  const incompleteReport = verifyRecord(incompleteResult);
  assert.equal(incompleteReport.status, "partial");
  assert.deepEqual(incompleteReport.reasonCodes, ["recorded_result_incomplete"]);
});

test("a required-obstacle collision cannot be erased or reassigned in the formal record", { timeout: 20_000 }, () => {
  const record = createFormalObstacleCollisionRecord();
  const collision = record.events.find(event => event.type === "violation" && event.violationType === "collision");
  assert.ok(collision, "the collision must be present in the live audit trail");
  assert.equal(collision.colliderId, "object:guangyang-obstacle-1");
  assert.equal(record.result.taskFinished, false);
  const originalReplay = new ReplayPlayer(record);
  assert.deepEqual(originalReplay.analysis().task.avoidanceProgress.failedObjectIds, ["guangyang-obstacle-1"]);
  assert.equal(originalReplay.verify().ok, true, originalReplay.verify().diagnostics.join("\n"));

  const removed = clone(record);
  removed.events = removed.events.filter(event => event.seq !== collision.seq);
  assert.equal(new ReplayPlayer(removed).verify().ok, false, "removing collision evidence must be detected");
  assert.equal(verifyRecord(removed).status, "invalid");

  const reassigned = clone(record);
  reassigned.events.find(event => event.seq === collision.seq).colliderId = "object:guangyang-target-1";
  assert.equal(new ReplayPlayer(reassigned).verify().ok, false, "changing the collided object must be detected");
  assert.equal(verifyRecord(reassigned).status, "invalid");
});

test("the session API freezes the Guangyang challenge digest and archives the 100-point record as verified", { timeout: 30_000 }, async t => {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "guangyang-submission-chain-"));
  t.after(async () => {
    const resolved = path.resolve(dataDir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.match(path.basename(resolved), /^guangyang-submission-chain-/);
    await fs.promises.rm(resolved, { recursive: true, force: true });
  });
  // This API-chain fixture exercises the same acceptance geometry through the
  // current one-argument centimeter API. Point every task-1 assignment at one isolated copy of
  // map 1; map-pool diversity and assignment are covered independently.
  const acceptanceMapStore = new GuangyangMapConfigStore({
    rootDir: path.join(dataDir, "acceptance-map"),
    baseConfig: GUANGYANG_ISLAND_CONFIG,
    baseChallenge: LOCAL_CHALLENGES[GUANGYANG_ISLAND_CONFIG.taskId]
  });
  const taskOnePool = Object.fromEntries(
    Array.from({ length: MAP_POOL_COUNTS[GUANGYANG_ISLAND_CONFIG.taskId] }, (_item, index) => (
      [variantId(index + 1), acceptanceMapStore]
    ))
  );
  const server = createServer({
    dataDir,
    verifyTimeoutMs: 20_000,
    mapConfigPools: { [GUANGYANG_ISLAND_CONFIG.taskId]: taskOnePool }
  });
  const origin = await listen(server);
  t.after(() => closeServer(server));

  const registration = await jsonBodyRequest(origin, "/api/v1/auth/register", {
    username: `guangyang-audit-${new URL(origin).port}`,
    password: "Guangyang-Audit-Password-2026!",
    teamName: "广阳岛审计测试队",
    group: "primary"
  });
  assert.equal(registration.statusCode, 201, registration.body.toString("utf8"));
  const setCookie = Array.isArray(registration.headers["set-cookie"])
    ? registration.headers["set-cookie"][0]
    : registration.headers["set-cookie"];
  const cookie = String(setCookie).split(";", 1)[0];

  const sessionResponse = await jsonBodyRequest(origin, "/api/v1/sessions", {
    taskId: GUANGYANG_ISLAND_CONFIG.taskId
  }, { cookie });
  assert.equal(sessionResponse.statusCode, 201, sessionResponse.body.toString("utf8"));
  const issued = responseJson(sessionResponse);
  assert.equal(Object.prototype.hasOwnProperty.call(issued.challenge, "runDefinition"), false);
  assert.equal(issued.challenge.sessionMode, "standard");
  assert.deepEqual(Object.keys(issued.mapConfig).sort(), [
    "digest", "mapVersion", "revision", "schemaVersion"
  ]);
  assert.equal(issued.mapConfig.schemaVersion, "chenlong.guangyang-map-config-binding/v1");
  assert.equal(issued.mapConfig.revision, 0);
  assert.equal(issued.mapConfig.mapVersion, issued.challenge.mapVersion);
  assert.deepEqual(issued.runDefinition, {
    ...LOCAL_CHALLENGES[GUANGYANG_ISLAND_CONFIG.taskId].runDefinition,
    navigationDefinition: PUBLIC_NAVIGATION_DEFINITION
  });
  assert.equal(issued.runDefinition.interactionDefinition.schemaVersion, "chenlong.package-interaction/v2");
  assert.match(JSON.stringify(issued.runDefinition), /guangyang-target-1/);
  assert.match(JSON.stringify(issued.runDefinition), /navigationControlDefinition|chenlong\.navigation-control/);
  assert.doesNotMatch(JSON.stringify(issued.challenge), /runDefinition|interactionDefinition|guangyang-target-1/);
  assert.doesNotMatch(JSON.stringify(issued.challenge), /navigationControlDefinition|chenlong\.navigation-control/);
  assert.notEqual(
    canonicalSha256(LOCAL_CHALLENGES[GUANGYANG_ISLAND_CONFIG.taskId].runDefinition),
    issued.challengeDigest,
    "the public digest must be a salted commitment rather than an enumerable definition digest"
  );
  assert.doesNotMatch(JSON.stringify(issued), /challengeCommitment|nonce|runDefinitionDigest/);

  const aiSessionResponse = await jsonBodyRequest(origin, "/api/v1/sessions", {
    taskId: GUANGYANG_ISLAND_CONFIG.taskId,
    mode: "ai"
  }, { cookie });
  assert.equal(aiSessionResponse.statusCode, 201, aiSessionResponse.body.toString("utf8"));
  const aiIssued = responseJson(aiSessionResponse);
  assert.equal(aiIssued.challenge.sessionMode, "ai");
  assert.deepEqual(aiIssued.mapConfig, issued.mapConfig);
  assert.deepEqual(aiIssued.runDefinition, {
    ...LOCAL_CHALLENGES[GUANGYANG_ISLAND_CONFIG.taskId].runDefinition,
    navigationDefinition: NAVIGATION_DEFINITION
  });
  const hiddenMission = projectNavigationQuery("mission", {
    pose: aiIssued.runDefinition.simulationDefinition.initialPose,
    initialPose: aiIssued.runDefinition.simulationDefinition.initialPose,
    distance: 0,
    tick: 0,
    mapId: aiIssued.challenge.mapId,
    mapVersion: aiIssued.challenge.mapVersion,
    rules: aiIssued.runDefinition.ruleDefinition,
    taskDefinition: aiIssued.runDefinition.taskDefinition,
    simulationDefinition: aiIssued.runDefinition.simulationDefinition,
    interactionDefinition: aiIssued.runDefinition.interactionDefinition,
    navigationDefinition: aiIssued.runDefinition.navigationDefinition
  });
  assert.deepEqual(hiddenMission.objects, [], "AI mode must not disclose object road anchors");

  const { record } = createLiveGuangyangRecord({
    teamId: issued.teamId,
    runId: issued.runId,
    serverSessionId: issued.sessionId,
    challengeDigest: issued.challengeDigest,
    runDefinition: issued.runDefinition
  });
  const submissionResponse = await jsonBodyRequest(
    origin,
    `/api/v1/sessions/${encodeURIComponent(issued.sessionId)}/submissions`,
    record,
    { cookie, token: issued.submitToken }
  );
  assert.equal(submissionResponse.statusCode, 201, submissionResponse.body.toString("utf8"));
  const receipt = responseJson(submissionResponse);
  assert.equal(receipt.verification.status, "verified");
  assert.equal(receipt.verification.recomputedResult.score, 100);
  assert.equal(receipt.verification.capabilities.recomputationComplete, true);
  assert.equal(receipt.challengeDigest, issued.challengeDigest);

  const { record: aiRecord } = createLiveGuangyangRecord({
    teamId: aiIssued.teamId,
    runId: aiIssued.runId,
    serverSessionId: aiIssued.sessionId,
    challengeDigest: aiIssued.challengeDigest,
    runDefinition: aiIssued.runDefinition
  });
  const aiSubmissionResponse = await jsonBodyRequest(
    origin,
    `/api/v1/sessions/${encodeURIComponent(aiIssued.sessionId)}/submissions`,
    aiRecord,
    { cookie, token: aiIssued.submitToken }
  );
  assert.equal(aiSubmissionResponse.statusCode, 201, aiSubmissionResponse.body.toString("utf8"));
  const aiSubmissionId = responseJson(aiSubmissionResponse).submissionId;
  const administratorRecords = await request(origin, {
    requestPath: "/api/v1/admin/records",
    headers: { Cookie: cookie }
  });
  assert.equal(administratorRecords.statusCode, 200, administratorRecords.body.toString("utf8"));
  const aiSummary = responseJson(administratorRecords).records.find(record => record.id === aiSubmissionId);
  assert.deepEqual({
    autonomyMode: aiSummary?.autonomyMode,
    aiAutonomyVerified: aiSummary?.aiAutonomyVerified,
    capabilityUsage: aiSummary?.capabilityUsage
  }, {
    autonomyMode: "ai",
    aiAutonomyVerified: false,
    capabilityUsage: { navigationSensors: false, roadControls: false, vision: false }
  }, "a server-issued AI session is identifiable, but cannot self-certify without trusted visual-navigation-control evidence");

  const alteredDefinition = clone(record);
  alteredDefinition.runDefinition.timeLimitTicks += 1;
  const rejectedResponse = await jsonBodyRequest(
    origin,
    `/api/v1/sessions/${encodeURIComponent(issued.sessionId)}/submissions`,
    alteredDefinition,
    { cookie, token: issued.submitToken }
  );
  assert.equal(rejectedResponse.statusCode, 409, rejectedResponse.body.toString("utf8"));
  const rejection = responseJson(rejectedResponse);
  assert.equal(rejection.error.code, "SESSION_RECORD_MISMATCH");
  assert.match(rejection.error.message, /runDefinitionDigest/);
});

module.exports = { createLiveGuangyangRecord };
