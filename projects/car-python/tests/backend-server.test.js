"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { gzipSync } = require("node:zlib");

const {
  SCHEMA_VERSION,
  DETERMINISTIC_LEGACY_SCHEMA_VERSION,
  INTERACTION_SCHEMA_VERSION,
  LEGACY_SCHEMA_VERSION
} = require("../competition-core.js");
const {
  MAX_RECORD_BYTES,
  REPORT_SCHEMA_VERSION
} = require("../tools/verify-run-record.js");
const {
  SERVICE_SCHEMA_VERSION,
  DATA_DIRECTORY_WRITER_LOCK_SCHEMA_VERSION,
  DATA_DIRECTORY_WRITER_LOCK_FILENAME,
  DataDirectoryWriterLockError,
  MAX_WORKER_TIMEOUT_MS,
  MAX_CONCURRENT_VERIFICATIONS,
  createVerificationQueue,
  paginateRecords,
  teamTaskBestRecords,
  createServer
} = require("../server.js");

test("bounded verifier queue runs 500 jobs in FIFO order without exceeding worker capacity", async () => {
  const queue = createVerificationQueue({
    maximumConcurrentVerifications: 2,
    maximumQueuedVerifications: 512,
    queueTimeoutMs: 10_000
  });
  let active = 0;
  let peak = 0;
  const started = [];
  const results = await Promise.all(Array.from({ length: 500 }, (_, index) => queue(async () => {
    active += 1;
    peak = Math.max(peak, active);
    started.push(index);
    await new Promise(resolve => setImmediate(resolve));
    active -= 1;
    return index;
  })));
  assert.equal(peak, 2);
  assert.deepEqual(started, results);
  assert.deepEqual(results, Array.from({ length: 500 }, (_, index) => index));
  assert.deepEqual(queue.status(), { active: 0, queued: 0 });
  queue.close();
});

test("record pagination remains bounded for 500, 1500, and 10000 retained records", () => {
  for (const total of [500, 1500, 10000]) {
    const records = Array.from({ length: total }, (_, id) => ({ id }));
    const first = paginateRecords(records, 1, 500);
    const last = paginateRecords(records, Math.ceil(total / 500), 500);
    assert.equal(first.records.length, 500);
    assert.equal(first.pagination.total, total);
    assert.equal(last.pagination.hasNext, false);
    assert.equal(last.records.at(-1).id, total - 1);
  }
});

test("24,000 Python best-record candidates collapse to 2,000-by-three team-task maxima", () => {
  const records = [];
  for (let team = 0; team < 2_000; team += 1) {
    for (let task = 1; task <= 3; task += 1) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        records.push({
          id: `sub_${team}_${task}_${attempt}`,
          ownerUserId: `usr_${team}_${attempt}`,
          teamId: `tea_${team}`,
          taskId: `R2-GYI-MVP-0${task}`,
          score: 70 + attempt,
          recordState: "submitted",
          submittedAt: new Date(Date.parse("2026-08-28T00:00:00.000Z") + records.length).toISOString()
        });
      }
    }
  }
  const selected = teamTaskBestRecords(records);
  assert.equal(selected.length, 6_000);
  assert.ok(selected.every(record => record.score === 73));
  assert.equal(new Set(selected.map(record => `${record.teamId}\n${record.taskId}`)).size, selected.length);
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Kept local intentionally: the CLI test's fixture builder is not exported and
// requiring another node:test file would register its tests a second time.
function verifiedV4Record() {
  const simulationDefinition = {
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
      bounds: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 },
      colliders: []
    }
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: "backend-v4-verified",
    runDefinition: {
      simulationDefinition,
      interactionDefinition: {
        schemaVersion: INTERACTION_SCHEMA_VERSION,
        bounds: clone(simulationDefinition.world.bounds),
        packageRadius: 0.2,
        grab: { minForward: 0.1, maxForward: 1.2, maxLateral: 0.25, maxDistance: 1.2 },
        release: { forwardOffset: 1, lateralOffset: 0, stackSnapDistance: 0.1 },
        packages: [{ id: "box-a", role: "target", x: 0.8, z: 0, stackLevel: 0 }]
      },
      taskDefinition: {
        id: "backend-delivery",
        version: "1",
        type: "delivery",
        goal: [1, 0],
        deliveryRadius: 0.05,
        requiredPackageIds: ["box-a"]
      },
      ruleDefinition: {
        vehicleRadius: 0.2,
        roads: [{ id: "wide-road", width: 4, points: [[-2, 0], [2, 0]] }],
        trafficLights: [],
        speedZones: [],
        prohibitedZones: []
      },
      scoringDefinition: {
        efficiency: { targetSeconds: 1, maxSeconds: 2 },
        autonomous: { penaltyPerIntervention: 3 }
      },
      timeLimitTicks: 11
    },
    randomSeed: simulationDefinition.seed,
    simulationEndTick: 10,
    inputs: [
      { seq: 3, t: 0, tick: 0, type: "package_grab", intent: {}, stateRevision: 1 },
      { seq: 5, t: 200, tick: 10, type: "package_release", intent: {}, stateRevision: 2 }
    ],
    visionFrames: [],
    samples: [
      {
        seq: 2,
        tick: 0,
        t: 0,
        x: 0,
        z: 0,
        heading: -Math.PI / 2,
        speed: 0,
        steering: 0,
        holding: null,
        cameraFrameId: null
      },
      {
        seq: 7,
        tick: 10,
        t: 200,
        x: 0,
        z: 0,
        heading: -Math.PI / 2,
        speed: 0,
        steering: 0,
        holding: null,
        cameraFrameId: null
      }
    ],
    events: [
      { seq: 1, t: 0, type: "run_started" },
      {
        seq: 4,
        t: 0,
        type: "package_grabbed",
        interactionType: "package_grab",
        accepted: true,
        reason: "grabbed",
        packageId: "box-a",
        objectRole: "target",
        position: [0.8, 0],
        stackLevel: 0
      },
      {
        seq: 6,
        t: 200,
        type: "package_released",
        interactionType: "package_release",
        accepted: true,
        reason: "released",
        packageId: "box-a",
        objectRole: "target",
        position: [1, 0],
        stackLevel: 0
      },
      { seq: 8, t: 200, type: "package_delivered", packageId: "box-a" },
      { seq: 9, t: 200, type: "task_completed", completed: 1, total: 1 },
      { seq: 10, t: 200, type: "run_finished", reason: "completed", score: 60 }
    ],
    result: {
      score: 60,
      taskScore: 25,
      ruleScore: 15,
      autonomousScore: 10,
      efficiencyScore: 10,
      ruleDeduction: 0,
      eventDeduction: 0,
      durationDeduction: 0,
      durationSeconds: 0.2,
      completedTasks: 1,
      totalTasks: 1,
      taskValid: true,
      taskFinished: true,
      reason: "completed",
      simulationTick: 10
    }
  };
}

function telemetryV2Record() {
  return {
    schemaVersion: LEGACY_SCHEMA_VERSION,
    runId: "backend-v2-partial",
    samples: [
      { seq: 1, t: 0, x: 0, z: 0, heading: 0, speed: 0, steering: 0 },
      { seq: 2, t: 100, x: 0, z: -0.1, heading: 0, speed: 1, steering: 0 }
    ],
    events: [],
    result: { score: 10, reason: "program_finished" }
  };
}

function deterministicV3Record() {
  const base = verifiedV4Record();
  return {
    schemaVersion: DETERMINISTIC_LEGACY_SCHEMA_VERSION,
    runId: "backend-v3-partial",
    simulationDefinition: clone(base.runDefinition.simulationDefinition),
    randomSeed: base.randomSeed,
    taskDefinition: { id: "v3-reach", type: "reach", goal: [0, 0], goalRadius: 0.1 },
    ruleDefinition: clone(base.runDefinition.ruleDefinition),
    scoringDefinition: {},
    inputs: [],
    samples: [clone(base.samples[0])],
    events: [],
    result: {}
  };
}

function collectResponse(response, resolve, reject) {
  const chunks = [];
  response.on("data", chunk => chunks.push(chunk));
  response.once("error", reject);
  response.once("end", () => resolve({
    statusCode: response.statusCode,
    headers: response.headers,
    body: Buffer.concat(chunks)
  }));
}

const authenticationByOrigin = new Map();

function authenticatedHeaders(origin, method, headers) {
  const cookie = authenticationByOrigin.get(origin);
  return {
    ...(cookie ? { Cookie: cookie } : {}),
    ...(cookie && !["GET", "HEAD", "OPTIONS"].includes(method) ? { Origin: origin } : {}),
    ...headers
  };
}

function request(origin, { method = "GET", path = "/", headers = {}, body } = {}) {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      method,
      path,
      headers: { Connection: "close", ...authenticatedHeaders(origin, method, headers) }
    }, response => collectResponse(response, resolve, reject));
    request.once("error", reject);
    request.end(body);
  });
}

function streamingRequest(origin, { method = "POST", path, headers = {} }) {
  const target = new URL(origin);
  let resolveResponse;
  let rejectResponse;
  const response = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const clientRequest = http.request({
    hostname: target.hostname,
    port: target.port,
    method,
    path,
    headers: {
      Connection: "close",
      "Transfer-Encoding": "chunked",
      ...authenticatedHeaders(origin, method, headers)
    }
  }, incoming => collectResponse(incoming, resolveResponse, rejectResponse));
  clientRequest.once("error", rejectResponse);
  return { clientRequest, response };
}

async function startServer(t, options = {}) {
  const dataDir = options.dataDir || await fs.promises.mkdtemp(path.join(os.tmpdir(), "chenlong-backend-test-"));
  const ownsDataDir = !options.dataDir;
  const server = createServer({ ...options, dataDir });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const registrationBody = Buffer.from(JSON.stringify({
    username: `backend-${String(address.port)}`,
    password: "Backend-Test-Password-2026!",
    teamName: "后端服务测试队",
    group: "primary"
  }));
  const registered = await request(origin, {
    method: "POST",
    path: "/api/v1/auth/register",
    headers: {
      Origin: origin,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": registrationBody.length
    },
    body: registrationBody
  });
  assert.equal(registered.statusCode, 201, registered.body.toString("utf8"));
  const setCookie = Array.isArray(registered.headers["set-cookie"])
    ? registered.headers["set-cookie"][0]
    : registered.headers["set-cookie"];
  assert.match(setCookie || "", /^chenlong_session=/);
  authenticationByOrigin.set(origin, setCookie.split(";", 1)[0]);

  t.after(async () => {
    authenticationByOrigin.delete(origin);
    server.closeAllConnections?.();
    if (server.listening) {
      await new Promise(resolve => server.close(resolve));
    }
    if (ownsDataDir) {
      const resolved = path.resolve(dataDir);
      assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
      assert.match(path.basename(resolved), /^chenlong-backend-test-/);
      await fs.promises.rm(resolved, { recursive: true, force: true });
    }
  });
  return origin;
}

function parseJson(response) {
  assert.match(response.headers["content-type"] || "", /^application\/json\b/i);
  return JSON.parse(response.body.toString("utf8"));
}

function assertApiError(response, statusCode, code) {
  assert.equal(response.statusCode, statusCode, response.body.toString("utf8"));
  const report = parseJson(response);
  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(report.status, "error");
  assert.equal(report.authoritative, false);
  assert.equal(report.error.code, code);
  assert.equal(typeof report.error.message, "string");
  assert.ok(report.error.message.length > 0);
  return report;
}

function jsonRequest(origin, record, options = {}) {
  const body = Buffer.from(JSON.stringify(record));
  return request(origin, {
    method: "POST",
    path: "/api/v1/verify-run-record",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      ...options.headers
    },
    body
  });
}

test("server configuration rejects values outside its fixed resource ceilings", () => {
  const invalidCases = [
    [{ maxBodyBytes: MAX_RECORD_BYTES + 1 }, /maxBodyBytes/],
    [{ verifyTimeoutMs: MAX_WORKER_TIMEOUT_MS + 1 }, /verifyTimeoutMs/],
    [{ maxConcurrentVerifications: MAX_CONCURRENT_VERIFICATIONS + 1 }, /maxConcurrentVerifications/],
    [{ sessionTtlMs: 999, batchTtlMs: 1000 }, /sessionTtlMs must be greater than or equal to batchTtlMs/],
    [{ batchTtlMs: 8 * 60 * 60 * 1000 + 1 }, /sessionTtlMs must be greater than or equal to batchTtlMs/],
    [{ maxBodyBytes: 1.5 }, /maxBodyBytes/],
    [{ verifyTimeoutMs: 1.5 }, /verifyTimeoutMs/],
    [{ maxConcurrentVerifications: 1.5 }, /maxConcurrentVerifications/]
  ];
  for (const [options, message] of invalidCases) {
    assert.throws(() => createServer(options), {
      name: "TypeError",
      message
    });
  }
});

test("the data directory admits one live writer and is reusable after server close", async t => {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chenlong-writer-lock-test-"));
  const servers = [];
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections?.();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      else server.dataDirectoryWriterLock?.release();
    }
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  const first = createServer({ dataDir });
  servers.push(first);
  await Promise.all([first.submissionStore.ready, first.authStore.ready, first.batchStore.ready]);
  await new Promise((resolve, reject) => {
    first.once("error", reject);
    first.listen(0, "127.0.0.1", resolve);
  });
  assert.throws(() => createServer({ dataDir }), error => {
    assert.ok(error instanceof DataDirectoryWriterLockError);
    assert.equal(error.code, "DATA_DIRECTORY_WRITER_ACTIVE");
    return true;
  });

  await new Promise(resolve => first.close(resolve));
  assert.equal(fs.existsSync(path.join(dataDir, DATA_DIRECTORY_WRITER_LOCK_FILENAME)), false);

  const restarted = createServer({ dataDir });
  servers.push(restarted);
  await Promise.all([restarted.submissionStore.ready, restarted.authStore.ready, restarted.batchStore.ready]);
  await new Promise((resolve, reject) => {
    restarted.once("error", reject);
    restarted.listen(0, "127.0.0.1", resolve);
  });
  await new Promise(resolve => restarted.close(resolve));
});

test("dead-process and malformed writer locks both fail closed until explicit cleanup", async t => {
  const staleDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chenlong-stale-writer-lock-test-"));
  const malformedDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chenlong-invalid-writer-lock-test-"));
  let server = null;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    else server?.dataDirectoryWriterLock?.release();
    await fs.promises.rm(staleDir, { recursive: true, force: true });
    await fs.promises.rm(malformedDir, { recursive: true, force: true });
  });
  const staleLockPath = path.join(staleDir, DATA_DIRECTORY_WRITER_LOCK_FILENAME);
  await fs.promises.writeFile(staleLockPath, `${JSON.stringify({
    schemaVersion: DATA_DIRECTORY_WRITER_LOCK_SCHEMA_VERSION,
    pid: 2_147_483_647,
    token: "a".repeat(64),
    createdAt: new Date(0).toISOString()
  })}\n`, { encoding: "utf8", mode: 0o600 });

  assert.throws(() => createServer({ dataDir: staleDir }), error => {
    assert.ok(error instanceof DataDirectoryWriterLockError);
    assert.equal(error.code, "DATA_DIRECTORY_WRITER_STALE");
    return true;
  });
  assert.equal(JSON.parse(await fs.promises.readFile(staleLockPath, "utf8")).token, "a".repeat(64));

  await fs.promises.unlink(staleLockPath);
  server = createServer({ dataDir: staleDir });
  await Promise.all([server.submissionStore.ready, server.authStore.ready, server.batchStore.ready]);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  await new Promise(resolve => server.close(resolve));

  await fs.promises.writeFile(
    path.join(malformedDir, DATA_DIRECTORY_WRITER_LOCK_FILENAME),
    "not-json\n",
    { encoding: "utf8", mode: 0o600 }
  );
  assert.throws(() => createServer({ dataDir: malformedDir }), error => {
    assert.ok(error instanceof DataDirectoryWriterLockError);
    assert.equal(error.code, "DATA_DIRECTORY_WRITER_LOCK_INVALID");
    return true;
  });
});

test("failed writer-lock acquisition never unlinks a replacement owned by another token", async t => {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chenlong-writer-replacement-test-"));
  t.after(() => fs.promises.rm(dataDir, { recursive: true, force: true }));
  const lockPath = path.join(dataDir, DATA_DIRECTORY_WRITER_LOCK_FILENAME);
  const replacement = {
    schemaVersion: DATA_DIRECTORY_WRITER_LOCK_SCHEMA_VERSION,
    pid: process.pid,
    token: "b".repeat(64),
    createdAt: new Date(0).toISOString()
  };
  const originalFsyncSync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = descriptor => {
    if (injected) return originalFsyncSync(descriptor);
    injected = true;
    fs.closeSync(descriptor);
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`, { encoding: "utf8", mode: 0o600 });
    const error = new Error("injected writer lock fsync failure after path replacement");
    error.code = "EIO";
    throw error;
  };
  try {
    assert.throws(() => createServer({ dataDir }), error => error?.code === "EIO");
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }
  assert.equal(injected, true);
  assert.deepEqual(JSON.parse(await fs.promises.readFile(lockPath, "utf8")), replacement,
    "cleanup must not unlink a lock whose token differs from the one this acquisition wrote");
});

test("health endpoint describes the non-authoritative service and enforces methods", async t => {
  const origin = await startServer(t, {
    maxBodyBytes: 4096,
    verifyTimeoutMs: 1234,
    maxConcurrentVerifications: 1,
    maxStorageBytes: 100
  });
  const response = await request(origin, { path: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store, max-age=0");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.match(response.headers["content-security-policy"] || "", /default-src 'self'/);
  assert.match(response.headers["content-security-policy"] || "", /object-src 'none'/);
  const health = parseJson(response);
  assert.equal(health.schemaVersion, SERVICE_SCHEMA_VERSION);
  assert.equal(health.status, "ok");
  assert.equal(health.authoritative, false);
  assert.equal(health.capabilities.staticHosting, true);
  assert.equal(health.capabilities.runRecordVerification, true);
  assert.equal(health.capabilities.singleDataDirectoryWriter, true);
  assert.equal(health.capabilities.maxBodyBytes, 4096);
  assert.equal(health.capabilities.verifyTimeoutMs, 1234);
  assert.equal(health.capabilities.maxConcurrentVerifications, 1);
  assert.ok(health.capabilities.acceptedRunRecordSchemas.includes(SCHEMA_VERSION));
  assert.deepEqual(health.runArchiveStorage, {
    status: "ok",
    usedBytes: 0,
    maxBytes: 100,
    availableBytes: 100,
    utilizationPercent: 0,
    warningThresholdPercent: 80,
    criticalThresholdPercent: 95,
    nearCapacity: false
  });

  const head = await request(origin, { method: "HEAD", path: "/api/health" });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body.length, 0);

  const rejected = await request(origin, { method: "POST", path: "/api/health" });
  assertApiError(rejected, 405, "METHOD_NOT_ALLOWED");
  assert.equal(rejected.headers.allow, "GET, HEAD");
});

test("the backend serves the browser app, JavaScript, model artifacts, and WASM with safe MIME types", async t => {
  const origin = await startServer(t);
  const index = await request(origin);
  assert.equal(index.statusCode, 200);
  assert.match(index.headers["content-type"] || "", /^text\/html\b/);
  assert.match(index.body.toString("utf8"), /competition-core\.js/);

  const core = await request(origin, { path: "/competition-core.js?v=test" });
  assert.equal(core.statusCode, 200);
  assert.match(core.headers["content-type"] || "", /^text\/javascript\b/);
  assert.match(core.body.toString("utf8", 0, 2000), /SCHEMA_VERSION/);

  const teamScores = await request(origin, { path: "/admin-team-scores.js?v=test" });
  assert.equal(teamScores.statusCode, 200);
  assert.match(teamScores.headers["content-type"] || "", /^text\/javascript\b/);
  assert.match(teamScores.body.toString("utf8"), /DEFAULT_PAGE_SIZE = 15/);

  const artifacts = [
    ["/vendor/pyodide/pyodide.asm.wasm", "application/wasm", 1_000_000],
    ["/vendor/vision/yolov8n-fp16.onnx", "application/octet-stream", 1_000_000],
    [`/word/${encodeURIComponent("广阳岛仿真沙盘地图.png")}`, "image/png", 100_000]
  ];
  for (const [path, contentType, minimumLength] of artifacts) {
    const response = await request(origin, { method: "HEAD", path });
    assert.equal(response.statusCode, 200, `${path}: ${response.body.toString("utf8")}`);
    assert.equal(response.headers["content-type"], contentType);
    assert.ok(Number(response.headers["content-length"]) > minimumLength);
    assert.equal(response.body.length, 0);
  }

  const wasmHead = await request(origin, { method: "HEAD", path: artifacts[0][0] });
  const wasmSize = Number(wasmHead.headers["content-length"]);
  assert.equal(wasmHead.headers["accept-ranges"], "bytes");
  const partial = await request(origin, {
    path: artifacts[0][0],
    headers: { Range: "bytes=16-31", "If-Range": wasmHead.headers.etag }
  });
  assert.equal(partial.statusCode, 206);
  assert.equal(partial.headers["content-range"], `bytes 16-31/${wasmSize}`);
  assert.equal(partial.headers["content-length"], "16");
  assert.equal(partial.body.length, 16);

  const staleIfRange = await request(origin, {
    method: "HEAD",
    path: artifacts[0][0],
    headers: { Range: "bytes=16-31", "If-Range": '"stale"' }
  });
  assert.equal(staleIfRange.statusCode, 200);
  assert.equal(Number(staleIfRange.headers["content-length"]), wasmSize);

  const unsatisfied = await request(origin, {
    method: "HEAD",
    path: artifacts[0][0],
    headers: { Range: `bytes=${wasmSize}-` }
  });
  assert.equal(unsatisfied.statusCode, 416);
  assert.equal(unsatisfied.headers["content-range"], `bytes */${wasmSize}`);
});

test("static allow-list and path parsing deny source, metadata, and traversal attempts", async t => {
  const origin = await startServer(t);
  const deniedPaths = [
    "/package.json",
    "/server.js",
    "/tools/verify-run-record.js",
    `/word/${encodeURIComponent("AI 智能车虚实融合挑战赛1.2.docx")}`,
    "/..%2f..%2fWindows%2fwin.ini",
    "/%2e%2e%5c%2e%2e%5cWindows%5cwin.ini",
    "/vendor/%2e%2e/server.js"
  ];
  for (const path of deniedPaths) {
    const response = await request(origin, { path });
    assert.ok([400, 404].includes(response.statusCode), `${path} returned ${response.statusCode}`);
    const report = parseJson(response);
    assert.equal(report.status, "error");
    assert.equal(report.authoritative, false);
    assert.ok(["INVALID_PATH", "NOT_FOUND"].includes(report.error.code));
  }

  const postStatic = await request(origin, { method: "POST", path: "/" });
  assertApiError(postStatic, 405, "METHOD_NOT_ALLOWED");
  assert.equal(postStatic.headers.allow, "GET, HEAD");

  const unknownApi = await request(origin, { path: "/api/not-real" });
  assertApiError(unknownApi, 404, "API_NOT_FOUND");
});

test("verification endpoint returns verified and invalid reports with distinct HTTP status", async t => {
  const origin = await startServer(t);
  const accepted = await jsonRequest(origin, verifiedV4Record());
  assert.equal(accepted.statusCode, 200, accepted.body.toString("utf8"));
  const verified = parseJson(accepted);
  assert.equal(verified.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(verified.status, "verified");
  assert.equal(verified.source, "http-api");
  assert.equal(verified.authoritative, false);
  assert.equal(verified.replay.verified, true);
  assert.equal(verified.capabilities.deterministicRecomputationComplete, true);
  assert.equal(verified.capabilities.recomputationComplete, true);
  assert.equal(verified.visionStatus, "not_used");
  assert.equal(verified.verificationScope.deterministic.status, "complete");
  assert.equal(verified.verificationScope.vision, "not_used");

  for (const record of [deterministicV3Record(), telemetryV2Record()]) {
    const legacyResponse = await jsonRequest(origin, record);
    assert.equal(legacyResponse.statusCode, 200, legacyResponse.body.toString("utf8"));
    const partial = parseJson(legacyResponse);
    assert.equal(partial.status, "partial");
    assert.equal(partial.record.schemaVersion, record.schemaVersion);
    assert.equal(partial.authoritative, false);
    assert.equal(partial.capabilities.deterministicRecomputationComplete, false);
    assert.equal(partial.capabilities.recomputationComplete, false);
  }

  const tampered = verifiedV4Record();
  tampered.samples.at(-1).x = 1.5;
  const rejected = await jsonRequest(origin, tampered);
  assert.equal(rejected.statusCode, 422, rejected.body.toString("utf8"));
  const invalid = parseJson(rejected);
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.authoritative, false);
  assert.equal(invalid.replay.verified, false);
  assert.ok(invalid.replay.mismatchCount > 0);
});

test("verification endpoint rejects wrong methods and media types before parsing", async t => {
  const origin = await startServer(t);
  const wrongMethod = await request(origin, { method: "GET", path: "/api/v1/verify-run-record" });
  assertApiError(wrongMethod, 405, "METHOD_NOT_ALLOWED");
  assert.equal(wrongMethod.headers.allow, "POST");

  const missingType = await request(origin, {
    method: "POST",
    path: "/api/v1/verify-run-record",
    body: "{}"
  });
  assertApiError(missingType, 415, "UNSUPPORTED_MEDIA_TYPE");

  const wrongType = await request(origin, {
    method: "POST",
    path: "/api/v1/verify-run-record",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(verifiedV4Record())
  });
  assertApiError(wrongType, 415, "UNSUPPORTED_MEDIA_TYPE");

  const compressedBody = gzipSync(Buffer.from(JSON.stringify(verifiedV4Record())));
  const compressed = await request(origin, {
    method: "POST",
    path: "/api/v1/verify-run-record",
    headers: {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Content-Length": compressedBody.length
    },
    body: compressedBody
  });
  assert.equal(compressed.statusCode, 200, compressed.body.toString("utf8"));
  assert.equal(parseJson(compressed).status, "verified");

  for (const contentEncoding of ["br", "identity, gzip"]) {
    const encoded = await request(origin, {
      method: "POST",
      path: "/api/v1/verify-run-record",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": contentEncoding
      },
      body: JSON.stringify(verifiedV4Record())
    });
    assertApiError(encoded, 415, "UNSUPPORTED_CONTENT_ENCODING");
  }
});

test("verification endpoint strictly rejects malformed JSON, non-object roots, empty input, and invalid UTF-8", async t => {
  const origin = await startServer(t);
  const cases = [
    [Buffer.from("{not-json"), "INVALID_JSON"],
    [Buffer.from("[]"), "INVALID_ROOT"],
    [Buffer.alloc(0), "EMPTY_INPUT"],
    [Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), "INVALID_UTF8"]
  ];
  for (const [body, code] of cases) {
    const response = await request(origin, {
      method: "POST",
      path: "/api/v1/verify-run-record",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length
      },
      body
    });
    assertApiError(response, 400, code);
  }
});

test("declared-length and chunked requests cannot exceed the configured body limit", async t => {
  const origin = await startServer(t, { maxBodyBytes: 256 });
  const body = Buffer.from(JSON.stringify({ padding: "x".repeat(512) }));

  const declared = await request(origin, {
    method: "POST",
    path: "/api/v1/verify-run-record",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": body.length
    },
    body
  });
  assertApiError(declared, 413, "INPUT_TOO_LARGE");

  const chunked = await request(origin, {
    method: "POST",
    path: "/api/v1/verify-run-record",
    headers: {
      "Content-Type": "application/json",
      "Transfer-Encoding": "chunked"
    },
    body
  });
  assertApiError(chunked, 413, "INPUT_TOO_LARGE");
});

test("worker verification has a hard timeout without blocking health checks", async t => {
  const origin = await startServer(t, { verifyTimeoutMs: 1 });
  const verificationPromise = jsonRequest(origin, verifiedV4Record());
  const health = await request(origin, { path: "/api/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(parseJson(health).status, "ok");

  const timedOut = await verificationPromise;
  assertApiError(timedOut, 504, "VERIFICATION_TIMEOUT");
});

test("concurrency limit queues excess work while one slow upload owns the only slot", async t => {
  const origin = await startServer(t, { maxConcurrentVerifications: 1 });
  const body = Buffer.from(JSON.stringify(verifiedV4Record()));
  const contenders = [0, 1].map(() => streamingRequest(origin, {
    path: "/api/v1/verify-run-record",
    headers: { "Content-Type": "application/json" }
  }));
  contenders[0].clientRequest.write(body.subarray(0, 1));
  contenders[1].clientRequest.end(body);

  const health = await request(origin, { path: "/api/health" });
  assert.equal(health.statusCode, 200);

  contenders[0].clientRequest.end(body.subarray(1));
  const accepted = await Promise.all(contenders.map(item => item.response));
  for (const response of accepted) {
    assert.equal(response.statusCode, 200, response.body.toString("utf8"));
    assert.equal(parseJson(response).status, "verified");
  }
});
