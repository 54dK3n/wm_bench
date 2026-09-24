"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
  GUANGYANG_ISLAND_CONFIG,
  createSession: createCompetitionSession
} = require("../competition-core.js");
const {
  BATCH_API_RESPONSE_SCHEMA_VERSION,
  BATCH_SLOT_LEASE_SCHEMA_VERSION,
  BATCH_OPEN_LIST_SCHEMA_VERSION,
  BATCH_OPEN_LIST_ORDER,
  RANKED_COMPETITION_ID,
  RANKED_EVALUATION_BASE_PATH,
  ADMIN_RANKED_RANKING_PATH,
  RANKED_EVALUATION_API_SCHEMA_VERSION,
  RANKED_SLOT_LEASE_SCHEMA_VERSION,
  RANKED_RANKING_SCHEMA_VERSION,
  RANKED_RANKING_STABLE_TIE_BREAK,
  LOCAL_CHALLENGES,
  createServer
} = require("../server.js");
const { canonicalSha256 } = require("../backend/canonical-json.js");

const RANKED_OWNER_EVALUATION_KEYS = [
  "purpose", "competitionId", "lockedTeamId", "evaluationPolicy", "createdAt", "expiresAt",
  "batch", "currentSlot", "anonymousParticipantId", "lockedSource", "result"
];

function request(origin, options = {}) {
  const target = new URL(options.requestPath || "/", origin);
  const body = options.body === undefined
    ? options.value === undefined ? null : Buffer.from(JSON.stringify(options.value))
    : Buffer.from(options.body);
  return new Promise((resolve, reject) => {
    const headers = { ...(options.headers || {}) };
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (body && !headers["Content-Type"]) headers["Content-Type"] = "application/json; charset=utf-8";
    if (body && !headers["Content-Length"]) headers["Content-Length"] = body.length;
    if (options.sameOrigin !== false && (options.method || (body ? "POST" : "GET")) !== "GET") {
      headers.Origin = origin;
    }
    const outgoing = http.request(target, {
      method: options.method || (body ? "POST" : "GET"),
      headers
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
    outgoing.once("error", reject);
    if (body) outgoing.end(body);
    else outgoing.end();
  });
}

function json(response) {
  return JSON.parse(response.body.toString("utf8"));
}

function errorCode(response) {
  return json(response).error?.code;
}

function syntheticVerifiedWorkerResult(buffer) {
  const record = JSON.parse(Buffer.from(buffer).toString("utf8"));
  const recordMetadata = {};
  [
    "schemaVersion", "runId", "serverSessionId", "challengeDigest", "teamId",
    "taskId", "mapId", "mapVersion", "ruleVersion"
  ].forEach(field => { recordMetadata[field] = record[field]; });
  recordMetadata.runDefinitionDigest = canonicalSha256(record.runDefinition);
  recordMetadata.sourceCodeDigest = canonicalSha256(record.sourceCode);
  recordMetadata.verifiedCollisionCount = 0;
  recordMetadata.verifiedOutOfBoundsCount = 0;
  return {
    report: {
      schemaVersion: "chenlong.verification-report/v1",
      status: "verified",
      reasonCodes: [],
      authoritative: false,
      replay: { verified: true, replayable: true, diagnostics: [], mismatches: [] },
      capabilities: { deterministicRecomputationComplete: true },
      resultComparison: { matched: true },
      recomputedResult: {
        score: record.result.score,
        taskFinished: record.result.taskFinished,
        reason: record.result.reason
      },
      recordedResult: record.result
    },
    recordMetadata
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}

function beginSlowSubmission(origin, cookie, batchId, slotIndex, lease, record) {
  const target = new URL(
    `/api/v1/evaluation-batches/${batchId}/slots/${slotIndex}`
      + `/sessions/${lease.session.sessionId}/submissions`,
    origin
  );
  const body = Buffer.from(JSON.stringify(record));
  let outgoing;
  const response = new Promise((resolve, reject) => {
    outgoing = http.request(target, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length
      }
    }, incoming => {
      const chunks = [];
      incoming.on("data", chunk => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () => resolve({
        statusCode: incoming.statusCode,
        headers: incoming.headers,
        body: Buffer.concat(chunks)
      }));
    });
    outgoing.once("error", reject);
    outgoing.write(body.subarray(0, 1));
  });
  return {
    response,
    finish() {
      outgoing.end(body.subarray(1));
    }
  };
}

async function register(origin, username) {
  const response = await request(origin, {
    requestPath: "/api/v1/auth/register",
    value: {
      username,
      password: "Strong-password-123!",
      displayName: username,
      teamName: username,
      group: "primary"
    }
  });
  assert.equal(response.statusCode, 201, response.body.toString("utf8"));
  const setCookie = Array.isArray(response.headers["set-cookie"])
    ? response.headers["set-cookie"][0]
    : response.headers["set-cookie"];
  return String(setCookie).split(";", 1)[0];
}

async function start(t, options = {}) {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chenlong-batch-api-"));
  const server = createServer({ dataDir, workerTimeoutMs: 20_000, ...options });
  const origin = await listen(server);
  t.after(async () => {
    await closeServer(server);
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });
  return { server, origin, dataDir };
}

async function createBatch(origin, cookie, source) {
  const response = await request(origin, {
    requestPath: "/api/v1/evaluation-batches",
    cookie,
    value: { source }
  });
  assert.equal(response.statusCode, 201, response.body.toString("utf8"));
  return { response, payload: json(response) };
}

async function listOpenBatches(origin, cookie) {
  const response = await request(origin, {
    requestPath: "/api/v1/evaluation-batches?phase=open",
    cookie
  });
  return { response, payload: json(response) };
}

async function leaseCurrentSlot(origin, cookie, batchId, teamId = "batch-api-team", slotIndex = 1) {
  const response = await request(origin, {
    requestPath: `/api/v1/evaluation-batches/${batchId}/current-slot/lease`,
    cookie,
    value: { teamId, slotIndex }
  });
  return { response, payload: json(response) };
}

async function createRankedBatch(origin, cookie, source, teamId) {
  const response = await request(origin, {
    requestPath: RANKED_EVALUATION_BASE_PATH,
    cookie,
    value: { source, teamId }
  });
  return { response, payload: json(response) };
}

async function leaseRankedSlot(origin, cookie, batchId, slotIndex = 1, value = { slotIndex }) {
  const response = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/${batchId}/current-slot/lease`,
    cookie,
    value
  });
  return { response, payload: json(response) };
}

async function submitRankedSlot(origin, cookie, batchId, slotIndex, lease, record) {
  return request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/${batchId}/slots/${slotIndex}`
      + `/sessions/${lease.session.sessionId}/submissions`,
    cookie,
    body: JSON.stringify(record)
  });
}

function recordForLease(lease, source) {
  const runDefinition = lease.runDefinition;
  const session = createCompetitionSession(GUANGYANG_ISLAND_CONFIG, {
    teamId: lease.session.teamId,
    runId: lease.session.runId,
    serverSessionId: lease.session.sessionId,
    challengeDigest: lease.session.challengeDigest,
    runDefinition,
    simulationDefinition: runDefinition.simulationDefinition,
    interactionDefinition: runDefinition.interactionDefinition,
    sourceCode: source
  }, { now: () => 0 });
  const pose = runDefinition.simulationDefinition.initialPose;
  session.sample({
    tick: 0,
    x: pose.x,
    z: pose.z,
    heading: pose.heading,
    speed: 0,
    steering: 0
  }, { forceRecord: true });
  return session.finish("program_finished");
}

function timeoutRecordForLease(lease, source) {
  const runDefinition = lease.runDefinition;
  const session = createCompetitionSession(GUANGYANG_ISLAND_CONFIG, {
    teamId: lease.session.teamId,
    runId: lease.session.runId,
    serverSessionId: lease.session.sessionId,
    challengeDigest: lease.session.challengeDigest,
    runDefinition,
    simulationDefinition: runDefinition.simulationDefinition,
    interactionDefinition: runDefinition.interactionDefinition,
    sourceCode: source
  }, { now: () => 0 });
  const pose = runDefinition.simulationDefinition.initialPose;
  const outcome = session.sample({
    tick: runDefinition.timeLimitTicks,
    x: pose.x,
    z: pose.z,
    heading: pose.heading,
    speed: 0,
    steering: 0
  }, { forceRecord: true });
  assert.equal(outcome.timedOut, true);
  return outcome.record;
}

async function submitSlot(origin, cookie, batchId, slotIndex, lease, record) {
  return request(origin, {
    requestPath: `/api/v1/evaluation-batches/${batchId}/slots/${slotIndex}`
      + `/sessions/${lease.session.sessionId}/submissions`,
    cookie,
    token: lease.submitToken,
    body: JSON.stringify(record)
  });
}

function assertPublicProjectionIsPrivate(payload, privateSource) {
  const serialized = JSON.stringify(payload);
  assert.equal(payload.schemaVersion, BATCH_API_RESPONSE_SCHEMA_VERSION);
  assert.equal(payload.authoritative, false);
  assert.doesNotMatch(serialized, /interactionDefinition|privateLayoutSelection|layoutId|anchorId|seedDigest|sourcePosition/);
  assert.equal(serialized.includes(privateSource), false);
  assert.equal(payload.currentSlot.slotIndex, payload.batch.nextSlotIndex);
}

test("batch create/read projections hide source and every private layout", async t => {
  const { origin } = await start(t);
  const ownerCookie = await register(origin, "batch-owner-a");
  const source = "# batch-private-source-a\ncar.stop()";
  const created = await createBatch(origin, ownerCookie, source);

  assertPublicProjectionIsPrivate(created.payload, source);
  assert.match(created.payload.batch.batchId, /^bat_[a-f0-9]{32}$/);
  assert.equal(created.payload.batch.slotCount, 5);
  assert.equal(created.payload.batch.nextSlotIndex, 1);
  assert.deepEqual(created.payload.batch.slots.map(slot => slot.status), Array(5).fill("pending"));

  const fetched = await request(origin, {
    requestPath: `/api/v1/evaluation-batches/${created.payload.batch.batchId}`,
    cookie: ownerCookie
  });
  assert.equal(fetched.statusCode, 200);
  assertPublicProjectionIsPrivate(json(fetched), source);
});

test("concurrent same-source create retries return one open batch and consume one opportunity", async t => {
  const { origin } = await start(t);
  const cookie = await register(origin, "batch-owner-create-idempotency");
  const source = "car.stop()\n# same-source concurrent create";
  const [first, second] = await Promise.all([
    createBatch(origin, cookie, source),
    createBatch(origin, cookie, source)
  ]);
  assert.equal(first.response.statusCode, 201, first.response.body.toString("utf8"));
  assert.equal(second.response.statusCode, 201, second.response.body.toString("utf8"));
  assert.equal(first.payload.batch.batchId, second.payload.batch.batchId);
  assert.deepEqual(first.payload, second.payload);
  const discovered = await listOpenBatches(origin, cookie);
  assert.deepEqual(discovered.payload.batches.map(item => item.batchId), [first.payload.batch.batchId]);

  const initialLease = await leaseCurrentSlot(origin, cookie, first.payload.batch.batchId);
  assert.equal(initialLease.response.statusCode, 201, initialLease.response.body.toString("utf8"));
  const afterBindingRetry = await createBatch(origin, cookie, source);
  assert.equal(afterBindingRetry.payload.batch.batchId, first.payload.batch.batchId);
  const recoveredLease = await request(origin, {
    requestPath: `/api/v1/evaluation-batches/${first.payload.batch.batchId}/current-slot/lease`,
    cookie,
    value: { slotIndex: 1 }
  });
  assert.equal(recoveredLease.statusCode, 200, recoveredLease.body.toString("utf8"));
  assert.equal(json(recoveredLease).lease.session.sessionId, initialLease.payload.lease.session.sessionId);

  const different = await createBatch(origin, cookie, `${source}\n# different source`);
  assert.equal(different.response.statusCode, 201, different.response.body.toString("utf8"));
  assert.notEqual(different.payload.batch.batchId, first.payload.batch.batchId);
});

test("owner-only open discovery recovers two lost batch ids without leaking private state", async t => {
  const { origin } = await start(t);
  const ownerCookie = await register(origin, "batch-owner-discovery");
  const otherCookie = await register(origin, "batch-other-discovery");
  const sources = ["car.stop()\n# discovery one", "car.stop()\n# discovery two"];
  const created = [];
  for (const source of sources) created.push((await createBatch(origin, ownerCookie, source)).payload);

  const unauthenticated = await listOpenBatches(origin, null);
  assert.equal(unauthenticated.response.statusCode, 401, unauthenticated.response.body.toString("utf8"));
  assert.equal(errorCode(unauthenticated.response), "AUTHENTICATION_REQUIRED");
  const foreign = await listOpenBatches(origin, otherCookie);
  assert.equal(foreign.response.statusCode, 200, foreign.response.body.toString("utf8"));
  assert.deepEqual(foreign.payload.batches, []);
  const injectedOwner = await request(origin, {
    requestPath: "/api/v1/evaluation-batches?phase=open&ownerUserId=ignored",
    cookie: ownerCookie
  });
  assert.equal(injectedOwner.statusCode, 400, injectedOwner.body.toString("utf8"));
  assert.equal(errorCode(injectedOwner), "INVALID_BATCH_LIST_QUERY");

  const { response, payload } = await listOpenBatches(origin, ownerCookie);
  assert.equal(response.statusCode, 200, response.body.toString("utf8"));
  assert.deepEqual(Object.keys(payload), ["schemaVersion", "authoritative", "phase", "limit", "order", "batches"]);
  assert.equal(payload.schemaVersion, BATCH_OPEN_LIST_SCHEMA_VERSION);
  assert.equal(payload.authoritative, false);
  assert.equal(payload.phase, "open");
  assert.equal(payload.limit, 2);
  assert.equal(payload.order, BATCH_OPEN_LIST_ORDER);
  assert.equal(payload.batches.length, 2);
  assert.deepEqual(payload.batches, [...payload.batches].sort((left, right) => (
    Date.parse(right.createdAt) - Date.parse(left.createdAt)
    || (left.batchId < right.batchId ? -1 : left.batchId > right.batchId ? 1 : 0)
  )));
  assert.deepEqual(new Set(payload.batches.map(item => item.batchId)),
    new Set(created.map(item => item.batch.batchId)));
  for (const item of payload.batches) {
    assert.deepEqual(Object.keys(item), [
      "batchId", "createdAt", "expiresAt", "nextSlotIndex", "sourceDigest", "summary"
    ]);
    assert.equal(item.nextSlotIndex, 1);
  }
  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    ...sources,
    ...created.map(item => item.currentSlot.layoutCommitment),
    "currentSlot", "layoutCommitment", "interactionDefinition", "layoutId", "anchorIds",
    "privateValue", "sessionId", "runId", "teamId", "sourceCode"
  ]) {
    assert.equal(serialized.includes(forbidden), false, `open discovery omits ${forbidden}`);
  }

  const overQuota = await request(origin, {
    requestPath: "/api/v1/evaluation-batches",
    cookie: ownerCookie,
    value: { source: "car.stop()\n# blocked third open batch" }
  });
  assert.equal(overQuota.statusCode, 429, overQuota.body.toString("utf8"));
  assert.equal(errorCode(overQuota), "OWNER_OPEN_BATCH_LIMIT_REACHED");
  for (const item of payload.batches) {
    const closed = await request(origin, {
      requestPath: `/api/v1/evaluation-batches/${item.batchId}/close`,
      cookie: ownerCookie,
      value: {}
    });
    assert.equal(closed.statusCode, 200, closed.body.toString("utf8"));
  }
  assert.deepEqual((await listOpenBatches(origin, ownerCookie)).payload.batches, []);
  const replacement = await createBatch(origin, ownerCookie, "car.stop()\n# quota released");
  assert.equal(replacement.response.statusCode, 201);
});

test("open discovery atomically removes expired batches and leaves them rankable", async t => {
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  const { origin } = await start(t, {
    now: () => now,
    batchTtlMs: 1_000,
    sessionTtlMs: 1_000
  });
  const cookie = await register(origin, "batch-owner-discovery-expiry");
  const source = "car.stop()\n# expired discovery";
  const { payload: created } = await createBatch(origin, cookie, source);
  now += 1_000;

  const discovered = await listOpenBatches(origin, cookie);
  assert.equal(discovered.response.statusCode, 200, discovered.response.body.toString("utf8"));
  assert.deepEqual(discovered.payload.batches, []);
  const fetched = await request(origin, {
    requestPath: `/api/v1/evaluation-batches/${created.batch.batchId}`,
    cookie
  });
  assert.equal(fetched.statusCode, 200, fetched.body.toString("utf8"));
  assert.equal(json(fetched).batch.phase, "finalized");
  assert.equal(json(fetched).batch.summary.missingCount, 5);
});

test("only the owner receives one recoverable current-slot lease and no future layout", async t => {
  const { origin, server } = await start(t);
  const ownerCookie = await register(origin, "batch-owner-b");
  const otherCookie = await register(origin, "batch-other-b");
  const source = "car.stop()\n# owner lease";
  const { payload: created } = await createBatch(origin, ownerCookie, source);
  const batchId = created.batch.batchId;

  const forbidden = await request(origin, {
    requestPath: `/api/v1/evaluation-batches/${batchId}`,
    cookie: otherCookie
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(errorCode(forbidden), "BATCH_OWNER_MISMATCH");
  const sessionsBeforeForeignLease = server.submissionStore.sessionCount;
  const foreignLease = await leaseCurrentSlot(origin, otherCookie, batchId);
  assert.equal(foreignLease.response.statusCode, 403);
  assert.equal(foreignLease.payload.error.code, "BATCH_OWNER_MISMATCH");
  assert.equal(server.submissionStore.sessionCount, sessionsBeforeForeignLease);

  const missingTeam = await request(origin, {
    requestPath: `/api/v1/evaluation-batches/${batchId}/current-slot/lease`,
    cookie: ownerCookie,
    value: { slotIndex: 1 }
  });
  assert.equal(missingTeam.statusCode, 400, missingTeam.body.toString("utf8"));
  assert.equal(errorCode(missingTeam), "INVALID_TEAM_ID");
  assert.equal(server.submissionStore.sessionCount, sessionsBeforeForeignLease);

  const { response, payload } = await leaseCurrentSlot(origin, ownerCookie, batchId);
  assert.equal(response.statusCode, 201, response.body.toString("utf8"));
  assert.equal(payload.lease.schemaVersion, BATCH_SLOT_LEASE_SCHEMA_VERSION);
  assert.equal(payload.lease.slotIndex, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.lease, "submitToken"), false);
  assert.equal(payload.lease.recovered, false);
  assert.equal(payload.lease.runDefinition.interactionDefinition.packages.length, 3);
  assert.deepEqual(Object.keys(payload.lease.layout).sort(), [
    "catalogVersion", "layoutCommitment", "mapId", "mapVersion", "schemaVersion", "sequenceLength", "slotIndex"
  ]);
  assert.equal(payload.lease.layout.slotIndex, 1);
  assert.equal(payload.lease.layout.slotIndex, payload.lease.slotIndex);
  assert.equal(JSON.stringify(payload).includes("gyi-layout-"), false);
  assert.equal((JSON.stringify(payload).match(/interactionDefinition/g) || []).length, 1,
    "only the leased current run definition may expose coordinates");

  const sessionCount = server.submissionStore.sessionCount;
  const repeatedResponse = await request(origin, {
    requestPath: `/api/v1/evaluation-batches/${batchId}/current-slot/lease`,
    cookie: ownerCookie,
    value: { slotIndex: 1 }
  });
  const repeated = json(repeatedResponse);
  assert.equal(repeatedResponse.statusCode, 200, repeatedResponse.body.toString("utf8"));
  assert.equal(repeated.lease.recovered, true);
  assert.equal(repeated.lease.session.sessionId, payload.lease.session.sessionId);
  assert.equal(repeated.lease.session.runId, payload.lease.session.runId);
  assert.deepEqual(repeated.lease.runDefinition, payload.lease.runDefinition);
  assert.equal(server.submissionStore.sessionCount, sessionCount, "lease recovery must not create another session");
});

test("verified slot submission is source/session/layout bound and exact retries are idempotent", { timeout: 30_000 }, async t => {
  const { origin } = await start(t);
  const cookie = await register(origin, "batch-owner-c");
  const source = "car.stop()\n# locked source c";
  const { payload: created } = await createBatch(origin, cookie, source);
  const batchId = created.batch.batchId;
  const { response: leaseResponse, payload: leasePayload } = await leaseCurrentSlot(origin, cookie, batchId);
  assert.equal(leaseResponse.statusCode, 201);
  const lease = leasePayload.lease;
  const record = recordForLease(lease, source);

  const submitted = await submitSlot(origin, cookie, batchId, 1, lease, record);
  assert.equal(submitted.statusCode, 201, submitted.body.toString("utf8"));
  const first = json(submitted);
  assert.equal(first.duplicate, false);
  assert.equal(first.submission.verification.status, "verified");
  assert.equal(first.batch.slots[0].status, "valid");
  assert.equal(first.batch.slots[0].final, true);
  assert.equal(first.batch.slots[0].score, first.submission.verification.recomputedResult.score);
  assert.equal(first.batch.slots[0].completed, false,
    "a verified unfinished run remains valid and keeps its recomputed score");
  assert.equal(first.batch.nextSlotIndex, 2);
  assert.equal(first.currentSlot.slotIndex, 2);

  const duplicate = await submitSlot(origin, cookie, batchId, 1, lease, record);
  assert.equal(duplicate.statusCode, 200, duplicate.body.toString("utf8"));
  assert.equal(json(duplicate).duplicate, true);
  assert.equal(json(duplicate).batch.nextSlotIndex, 2);

  const differentRecord = { ...record, harmlessRetryNonce: "different verified bytes" };
  const conflicting = await submitSlot(origin, cookie, batchId, 1, lease, differentRecord);
  assert.equal(conflicting.statusCode, 409, conflicting.body.toString("utf8"));
  assert.equal(errorCode(conflicting), "SLOT_ALREADY_FINALIZED");
});

test("concurrent different records archive only one winner and completed retries bypass verification", { timeout: 30_000 }, async t => {
  let verificationCount = 0;
  const { origin, server } = await start(t, {
    verifyInWorker: async buffer => {
      verificationCount += 1;
      await new Promise(resolve => setTimeout(resolve, 25));
      return syntheticVerifiedWorkerResult(buffer);
    }
  });
  const cookie = await register(origin, "batch-owner-concurrent");
  const source = "car.stop()\n# concurrent records";
  const { payload: created } = await createBatch(origin, cookie, source);
  const batchId = created.batch.batchId;
  const { payload: leasePayload } = await leaseCurrentSlot(origin, cookie, batchId);
  const lease = leasePayload.lease;
  const firstRecord = recordForLease(lease, source);
  const secondRecord = { ...firstRecord, harmlessConcurrentNonce: "different raw bytes" };
  const attempts = [firstRecord, secondRecord];

  const responses = await Promise.all(attempts.map(record => (
    submitSlot(origin, cookie, batchId, 1, lease, record)
  )));
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [201, 409]);
  const winnerIndex = responses.findIndex(response => response.statusCode === 201);
  const loserIndex = 1 - winnerIndex;
  assert.equal(errorCode(responses[loserIndex]), "SLOT_ALREADY_FINALIZED");
  assert.equal(verificationCount, 1, "the losing concurrent record must not enter the verifier");

  const winnerSha256 = crypto.createHash("sha256")
    .update(Buffer.from(JSON.stringify(attempts[winnerIndex])))
    .digest("hex");
  assert.equal(json(responses[winnerIndex]).submission.record.sha256, winnerSha256);
  let manifests = await server.submissionStore.listSubmissionManifests(lease.session.sessionId);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].record.sha256, winnerSha256);

  const losingRetry = await submitSlot(origin, cookie, batchId, 1, lease, attempts[loserIndex]);
  assert.equal(losingRetry.statusCode, 409);
  assert.equal(errorCode(losingRetry), "SLOT_ALREADY_FINALIZED");
  assert.equal(verificationCount, 1, "a completed conflicting retry must be rejected by raw digest");

  const exactRetry = await submitSlot(origin, cookie, batchId, 1, lease, attempts[winnerIndex]);
  assert.equal(exactRetry.statusCode, 200, exactRetry.body.toString("utf8"));
  assert.equal(json(exactRetry).duplicate, true);
  assert.equal(verificationCount, 1, "an exact retry must read the existing receipt without verification");
  manifests = await server.submissionStore.listSubmissionManifests(lease.session.sessionId);
  assert.equal(manifests.length, 1);
});

test("a slow submission cannot archive after close finalizes its slot as missing", async t => {
  let verificationCount = 0;
  let markPrechecked;
  const prechecked = new Promise(resolve => { markPrechecked = resolve; });
  const { origin, server } = await start(t, {
    onBatchSubmissionPrechecked: () => markPrechecked(),
    verifyInWorker: async buffer => {
      verificationCount += 1;
      return syntheticVerifiedWorkerResult(buffer);
    }
  });
  const cookie = await register(origin, "batch-owner-slow-close");
  const source = "car.stop()\n# slow close race";
  const { payload: created } = await createBatch(origin, cookie, source);
  const batchId = created.batch.batchId;
  const { payload: leasePayload } = await leaseCurrentSlot(origin, cookie, batchId);
  const lease = leasePayload.lease;
  const slow = beginSlowSubmission(origin, cookie, batchId, 1, lease, recordForLease(lease, source));
  await prechecked;

  const closedResponse = await request(origin, {
    requestPath: `/api/v1/evaluation-batches/${batchId}/close`,
    cookie,
    value: {}
  });
  assert.equal(closedResponse.statusCode, 200, closedResponse.body.toString("utf8"));
  assert.equal(json(closedResponse).batch.slots[0].status, "missing");
  slow.finish();
  const submitted = await slow.response;
  assert.equal(submitted.statusCode, 409, submitted.body.toString("utf8"));
  assert.equal(errorCode(submitted), "BATCH_FINALIZED");
  assert.equal(verificationCount, 0);
  assert.equal((await server.submissionStore.listSubmissionManifests(lease.session.sessionId)).length, 0);
});

test("a slow submission cannot archive after an expiry GET finalizes its slot", async t => {
  let now = Date.parse("2026-08-21T02:00:00.000Z");
  let verificationCount = 0;
  let markPrechecked;
  const prechecked = new Promise(resolve => { markPrechecked = resolve; });
  const { origin, server } = await start(t, {
    now: () => now,
    batchTtlMs: 1_000,
    onBatchSubmissionPrechecked: () => markPrechecked(),
    verifyInWorker: async buffer => {
      verificationCount += 1;
      return syntheticVerifiedWorkerResult(buffer);
    }
  });
  const cookie = await register(origin, "batch-owner-slow-expiry");
  const source = "car.stop()\n# slow expiry race";
  const { payload: created } = await createBatch(origin, cookie, source);
  const batchId = created.batch.batchId;
  const { payload: leasePayload } = await leaseCurrentSlot(origin, cookie, batchId);
  const lease = leasePayload.lease;
  const slow = beginSlowSubmission(origin, cookie, batchId, 1, lease, recordForLease(lease, source));
  await prechecked;
  now += 1_000;

  const fetched = await request(origin, {
    requestPath: `/api/v1/evaluation-batches/${batchId}`,
    cookie
  });
  assert.equal(fetched.statusCode, 200, fetched.body.toString("utf8"));
  assert.equal(json(fetched).batch.slots[0].status, "missing");
  slow.finish();
  const submitted = await slow.response;
  assert.equal(submitted.statusCode, 410, submitted.body.toString("utf8"));
  assert.equal(errorCode(submitted), "BATCH_EXPIRED");
  assert.equal(verificationCount, 0);
  assert.equal((await server.submissionStore.listSubmissionManifests(lease.session.sessionId)).length, 0);
});

test("restart recovery binds an orphan archive to its original record without best-of retry", { timeout: 30_000 }, async t => {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chenlong-batch-recovery-"));
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map(closeServer));
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  const firstServer = createServer({ dataDir, workerTimeoutMs: 20_000 });
  servers.push(firstServer);
  const firstOrigin = await listen(firstServer);
  const cookie = await register(firstOrigin, "batch-owner-crash-recovery");
  const source = "car.stop()\n# crash recovery";
  const { payload: created } = await createBatch(firstOrigin, cookie, source);
  const batchId = created.batch.batchId;
  const { payload: leasePayload } = await leaseCurrentSlot(firstOrigin, cookie, batchId);
  const lease = leasePayload.lease;
  const originalRecord = recordForLease(lease, source);
  const conflictingRecord = { ...originalRecord, recoveryBestOfNonce: "different bytes" };

  const originalAdvance = firstServer.batchStore.submitVerifiedSlotResult.bind(firstServer.batchStore);
  let failReceiptOnce = true;
  firstServer.batchStore.submitVerifiedSlotResult = async command => {
    if (failReceiptOnce) {
      failReceiptOnce = false;
      throw Object.assign(new Error("injected batch receipt write failure"), {
        statusCode: 500,
        code: "INJECTED_BATCH_RECEIPT_FAILURE"
      });
    }
    return originalAdvance(command);
  };
  const interrupted = await submitSlot(firstOrigin, cookie, batchId, 1, lease, originalRecord);
  assert.equal(interrupted.statusCode, 500, interrupted.body.toString("utf8"));
  assert.equal((await firstServer.submissionStore.listSubmissionManifests(lease.session.sessionId)).length, 1);
  assert.equal((await firstServer.batchStore.readBatch({
    ownerUserId: json(await request(firstOrigin, { requestPath: "/api/v1/auth/me", cookie })).user.id,
    batchId
  })).batch.nextSlotIndex, 1);
  await closeServer(firstServer);

  let restartedVerificationCount = 0;
  const secondServer = createServer({
    dataDir,
    verifyInWorker: async buffer => {
      restartedVerificationCount += 1;
      return syntheticVerifiedWorkerResult(buffer);
    }
  });
  servers.push(secondServer);
  const secondOrigin = await listen(secondServer);

  const conflict = await submitSlot(secondOrigin, cookie, batchId, 1, lease, conflictingRecord);
  assert.equal(conflict.statusCode, 409, conflict.body.toString("utf8"));
  assert.equal(errorCode(conflict), "SLOT_ALREADY_FINALIZED");
  assert.equal(restartedVerificationCount, 0);
  assert.equal((await secondServer.submissionStore.listSubmissionManifests(lease.session.sessionId)).length, 1);

  const recovered = await submitSlot(secondOrigin, cookie, batchId, 1, lease, originalRecord);
  assert.equal(recovered.statusCode, 200, recovered.body.toString("utf8"));
  const recoveredPayload = json(recovered);
  assert.equal(recoveredPayload.duplicate, true);
  assert.equal(recoveredPayload.batch.slots[0].final, true);
  assert.equal(recoveredPayload.batch.nextSlotIndex, 2);
  assert.equal(restartedVerificationCount, 0, "recovery must trust the validated archived report, not re-run code");
  assert.equal((await secondServer.submissionStore.listSubmissionManifests(lease.session.sessionId)).length, 1);
});

test("practice restart repairs receipt-before-retirement and frees the next lease", { timeout: 30_000 }, async t => {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chenlong-practice-retirement-repair-"));
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map(closeServer));
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });
  const firstServer = createServer({
    dataDir,
    maxSessions: 1,
    verifyInWorker: async buffer => syntheticVerifiedWorkerResult(buffer)
  });
  servers.push(firstServer);
  const firstOrigin = await listen(firstServer);
  const cookie = await register(firstOrigin, "practice-retirement-repair");
  const source = "car.stop()\n# practice retirement repair";
  const created = await createBatch(firstOrigin, cookie, source);
  const batchId = created.payload.batch.batchId;
  const leased = await leaseCurrentSlot(firstOrigin, cookie, batchId, "retirement-repair-team", 1);
  const originalRetire = firstServer.submissionStore.retireSessionForServer
    .bind(firstServer.submissionStore);
  let failRetirementOnce = true;
  firstServer.submissionStore.retireSessionForServer = async (...args) => {
    if (failRetirementOnce) {
      failRetirementOnce = false;
      throw Object.assign(new Error("injected retirement write failure"), {
        statusCode: 500,
        code: "INJECTED_RETIREMENT_FAILURE"
      });
    }
    return originalRetire(...args);
  };
  const interrupted = await submitSlot(
    firstOrigin,
    cookie,
    batchId,
    1,
    leased.payload.lease,
    recordForLease(leased.payload.lease, source)
  );
  assert.equal(interrupted.statusCode, 500, interrupted.body.toString("utf8"));
  assert.equal(await firstServer.submissionStore.countActiveSessions(), 1);
  await closeServer(firstServer);

  const restarted = createServer({
    dataDir,
    maxSessions: 1,
    verifyInWorker: async buffer => syntheticVerifiedWorkerResult(buffer)
  });
  servers.push(restarted);
  const restartedOrigin = await listen(restarted);
  const secondLease = await leaseCurrentSlot(
    restartedOrigin,
    cookie,
    batchId,
    "retirement-repair-team",
    2
  );
  assert.equal(secondLease.response.statusCode, 201, secondLease.response.body.toString("utf8"));
  assert.equal(secondLease.payload.batch.slots[0].status, "valid");
  assert.equal(await restarted.submissionStore.countActiveSessions(), 1,
    "the recovered first slot is retired before the second session consumes its scope slot");
  const closed = await request(restartedOrigin, {
    requestPath: `/api/v1/evaluation-batches/${batchId}/close`,
    cookie,
    value: {}
  });
  assert.equal(closed.statusCode, 200, closed.body.toString("utf8"));
  assert.equal(await restarted.submissionStore.countActiveSessions(), 0);
});

test("a server-produced invalid report consumes the slot as an immutable zero", { timeout: 30_000 }, async t => {
  const { origin } = await start(t);
  const cookie = await register(origin, "batch-owner-invalid");
  const source = "car.stop()\n# invalid report";
  const { payload: created } = await createBatch(origin, cookie, source);
  const batchId = created.batch.batchId;
  const { payload: leasePayload } = await leaseCurrentSlot(origin, cookie, batchId);
  const lease = leasePayload.lease;
  const validRecord = recordForLease(lease, source);
  const invalidRecord = {
    ...validRecord,
    result: { ...validRecord.result, score: validRecord.result.score + 1 }
  };

  const submitted = await submitSlot(origin, cookie, batchId, 1, lease, invalidRecord);
  assert.equal(submitted.statusCode, 201, submitted.body.toString("utf8"));
  const payload = json(submitted);
  assert.equal(payload.submission.verification.status, "invalid");
  assert.deepEqual(payload.batch.slots[0], {
    slotIndex: 1,
    final: true,
    status: "invalid",
    score: 0,
    completed: false,
    collisionCount: 0,
    outOfBoundsCount: 0
  });

  const retry = await submitSlot(origin, cookie, batchId, 1, lease, validRecord);
  assert.equal(retry.statusCode, 409, retry.body.toString("utf8"));
  assert.equal(errorCode(retry), "SLOT_ALREADY_FINALIZED");
});

test("a fully verified competition time-limit result consumes the slot as timeout zero", { timeout: 30_000 }, async t => {
  const { origin } = await start(t, { workerTimeoutMs: 25_000 });
  const cookie = await register(origin, "batch-owner-timeout");
  const source = "car.stop()\n# competition timeout";
  const { payload: created } = await createBatch(origin, cookie, source);
  const batchId = created.batch.batchId;
  const { payload: leasePayload } = await leaseCurrentSlot(origin, cookie, batchId);
  const lease = leasePayload.lease;
  const record = timeoutRecordForLease(lease, source);

  const submitted = await submitSlot(origin, cookie, batchId, 1, lease, record);
  assert.equal(submitted.statusCode, 201, submitted.body.toString("utf8"));
  const payload = json(submitted);
  assert.equal(payload.submission.verification.status, "verified");
  assert.equal(payload.submission.verification.recomputedResult.reason, "timeout");
  assert.equal(payload.batch.slots[0].status, "timeout");
  assert.equal(payload.batch.slots[0].score, 0);
  assert.equal(payload.batch.slots[0].completed, false);
});

test("verifier infrastructure timeout releases the batch lock without consuming the slot", async t => {
  const timeoutError = Object.assign(new Error("injected verifier timeout"), {
    statusCode: 504,
    code: "VERIFICATION_TIMEOUT"
  });
  let verificationCount = 0;
  let markFirstStarted;
  let releaseFirst;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  const firstRelease = new Promise(resolve => { releaseFirst = resolve; });
  const { origin, server } = await start(t, {
    verifyInWorker: async buffer => {
      verificationCount += 1;
      if (verificationCount === 1) {
        markFirstStarted();
        await firstRelease;
        throw timeoutError;
      }
      return syntheticVerifiedWorkerResult(buffer);
    }
  });
  const cookie = await register(origin, "batch-owner-infra-timeout");
  const source = "car.stop()\n# verifier timeout";
  const { payload: created } = await createBatch(origin, cookie, source);
  const batchId = created.batch.batchId;
  const { payload: leasePayload } = await leaseCurrentSlot(origin, cookie, batchId);
  const lease = leasePayload.lease;
  const record = recordForLease(lease, source);

  const timedOutPromise = submitSlot(origin, cookie, batchId, 1, lease, record);
  await firstStarted;
  const succeedingPromise = submitSlot(origin, cookie, batchId, 1, lease, record);
  releaseFirst();
  const [timedOut, succeeded] = await Promise.all([timedOutPromise, succeedingPromise]);
  assert.equal(timedOut.statusCode, 504, timedOut.body.toString("utf8"));
  assert.equal(errorCode(timedOut), "VERIFICATION_TIMEOUT");
  assert.equal(succeeded.statusCode, 201, succeeded.body.toString("utf8"));
  assert.equal(json(succeeded).batch.slots[0].status, "valid");
  assert.equal(verificationCount, 2);
  const manifests = await server.submissionStore.listSubmissionManifests(lease.session.sessionId);
  assert.equal(manifests.length, 1, "the infrastructure timeout must not create an archive receipt");
});

test("source replacement and a session from outside the slot cannot advance the batch", { timeout: 30_000 }, async t => {
  const { origin } = await start(t);
  const cookie = await register(origin, "batch-owner-d");
  const source = "car.stop()\n# locked source d";
  const { payload: created } = await createBatch(origin, cookie, source);
  const batchId = created.batch.batchId;
  const { payload: leasePayload } = await leaseCurrentSlot(origin, cookie, batchId);
  const lease = leasePayload.lease;

  const changedSourceRecord = recordForLease(lease, `${source}\n# changed`);
  const changedSource = await submitSlot(origin, cookie, batchId, 1, lease, changedSourceRecord);
  assert.equal(changedSource.statusCode, 409, changedSource.body.toString("utf8"));
  assert.equal(errorCode(changedSource), "SOURCE_LOCKED");

  const ordinarySession = await request(origin, {
    requestPath: "/api/v1/sessions",
    cookie,
    value: { taskId: GUANGYANG_ISLAND_CONFIG.taskId }
  });
  assert.equal(ordinarySession.statusCode, 201);
  const ordinary = json(ordinarySession);
  const fakeLease = {
    session: ordinary,
    submitToken: ordinary.submitToken,
    runDefinition: lease.runDefinition
  };
  const foreignRecord = recordForLease(fakeLease, source);
  const foreign = await submitSlot(origin, cookie, batchId, 1, fakeLease, foreignRecord);
  assert.equal(foreign.statusCode, 409, foreign.body.toString("utf8"));
  assert.ok(["SESSION_RECORD_MISMATCH", "SLOT_SESSION_MISMATCH"].includes(errorCode(foreign)));

  const fetched = await request(origin, {
    requestPath: `/api/v1/evaluation-batches/${batchId}`,
    cookie
  });
  assert.equal(json(fetched).batch.nextSlotIndex, 1);
});

test("practice and ranked lease sessions reject the generic submission route", async t => {
  const { server, origin } = await start(t);
  const cookie = await register(origin, "batch-scope-owner");
  const capturedTokens = new Map();
  const originalCreateSession = server.submissionStore.createSession.bind(server.submissionStore);
  server.submissionStore.createSession = async (...args) => {
    const created = await originalCreateSession(...args);
    capturedTokens.set(created.session.sessionId, created.submitToken);
    return created;
  };

  const practice = await createBatch(origin, cookie, "car.stop()\n# private practice session scope");
  const practiceLease = await leaseCurrentSlot(
    origin,
    cookie,
    practice.payload.batch.batchId,
    "scoped-practice-team",
    1
  );
  assert.equal(practiceLease.response.statusCode, 201, practiceLease.response.body.toString("utf8"));
  const practiceSessionId = practiceLease.payload.lease.session.sessionId;
  const practiceEvidence = await server.batchStore.readBatchSessionEvidenceForServer({
    ownerUserId: (await server.submissionStore.readSession(practiceSessionId)).ownerUserId,
    batchId: practice.payload.batch.batchId
  });
  assert.equal(practiceLease.payload.lease.session.expiresAt, practiceEvidence.expiresAt,
    "practice lease lifetime is clamped to its parent batch deadline");
  assert.equal(practiceLease.response.body.includes(capturedTokens.get(practiceSessionId)), false);
  const genericPractice = await request(origin, {
    requestPath: `/api/v1/sessions/${practiceSessionId}/submissions`,
    cookie,
    token: capturedTokens.get(practiceSessionId),
    value: {}
  });
  assert.equal(genericPractice.statusCode, 403, genericPractice.body.toString("utf8"));
  assert.equal(errorCode(genericPractice), "BATCH_SESSION_REQUIRES_BATCH_ROUTE");
  assert.deepEqual(await server.submissionStore.listSubmissionManifests(practiceSessionId), []);

  const ranked = await createRankedBatch(
    origin,
    cookie,
    "car.stop()\n# private ranked session scope",
    "scoped-ranked-team"
  );
  const rankedBatchId = ranked.payload.evaluation.batch.batchId;
  const rankedLease = await leaseRankedSlot(origin, cookie, rankedBatchId, 1);
  assert.equal(rankedLease.response.statusCode, 201, rankedLease.response.body.toString("utf8"));
  const rankedSessionId = rankedLease.payload.lease.session.sessionId;
  assert.equal(rankedLease.payload.lease.session.expiresAt, ranked.payload.evaluation.expiresAt,
    "ranked lease lifetime is clamped to its parent batch deadline");
  assert.equal(rankedLease.response.body.includes(capturedTokens.get(rankedSessionId)), false);
  const genericRanked = await request(origin, {
    requestPath: `/api/v1/sessions/${rankedSessionId}/submissions`,
    cookie,
    token: capturedTokens.get(rankedSessionId),
    value: {}
  });
  assert.equal(genericRanked.statusCode, 403, genericRanked.body.toString("utf8"));
  assert.equal(errorCode(genericRanked), "BATCH_SESSION_REQUIRES_BATCH_ROUTE");
  assert.deepEqual(await server.submissionStore.listSubmissionManifests(rankedSessionId), []);
});

test("server scope quotas reserve lease capacity in both directions", { timeout: 30_000 }, async t => {
  const batchIdFor = (prefix, index) => (
    `bat_${`${prefix}${index.toString(16)}`.padEnd(32, prefix).slice(0, 32)}`
  );
  const first = await start(t);
  const firstCookie = await register(first.origin, "quota-practice-admin");
  const firstMe = await request(first.origin, { requestPath: "/api/v1/auth/me", cookie: firstCookie });
  const firstOwner = json(firstMe).user.id;
  for (let index = 0; index < 100; index += 1) {
    await first.server.submissionStore.createSession(
      `practice-cap-${index}`,
      LOCAL_CHALLENGES[GUANGYANG_ISLAND_CONFIG.taskId],
      firstOwner,
      { scope: "practice", batchId: batchIdFor("a", index), slotIndex: 1 }
    );
  }
  const ranked = await createRankedBatch(
    first.origin,
    firstCookie,
    "car.stop()\n# ranked reserved quota",
    "ranked-reserved-quota"
  );
  const rankedLease = await leaseRankedSlot(
    first.origin,
    firstCookie,
    ranked.payload.evaluation.batch.batchId,
    1
  );
  assert.equal(rankedLease.response.statusCode, 201, rankedLease.response.body.toString("utf8"));

  const second = await start(t);
  const secondCookie = await register(second.origin, "quota-ranked-admin");
  const secondMe = await request(second.origin, { requestPath: "/api/v1/auth/me", cookie: secondCookie });
  const secondOwner = json(secondMe).user.id;
  for (let index = 0; index < 100; index += 1) {
    await second.server.submissionStore.createSession(
      `ranked-cap-${index}`,
      LOCAL_CHALLENGES[GUANGYANG_ISLAND_CONFIG.taskId],
      secondOwner,
      {
        scope: "ranked",
        competitionId: RANKED_COMPETITION_ID,
        batchId: batchIdFor("d", index),
        slotIndex: 1
      }
    );
  }
  const practice = await createBatch(
    second.origin,
    secondCookie,
    "car.stop()\n# practice reserved quota"
  );
  const practiceLease = await leaseCurrentSlot(
    second.origin,
    secondCookie,
    practice.payload.batch.batchId,
    "practice-reserved-quota",
    1
  );
  assert.equal(practiceLease.response.statusCode, 201, practiceLease.response.body.toString("utf8"));
});

test("closing fills all unreported slots as missing and is idempotent", async t => {
  const { server, origin } = await start(t);
  const cookie = await register(origin, "batch-owner-e");
  const { payload: created } = await createBatch(origin, cookie, "car.stop()\n# close batch");
  const batchId = created.batch.batchId;
  const leased = await leaseCurrentSlot(origin, cookie, batchId, "batch-close-team", 1);
  assert.equal(leased.response.statusCode, 201, leased.response.body.toString("utf8"));
  assert.equal(await server.submissionStore.countActiveSessions(), 1);

  const close = () => request(origin, {
    requestPath: `/api/v1/evaluation-batches/${batchId}/close`,
    cookie,
    value: {}
  });
  const first = await close();
  assert.equal(first.statusCode, 200, first.body.toString("utf8"));
  const closed = json(first);
  assert.equal(closed.batch.phase, "finalized");
  assert.equal(closed.currentSlot, null);
  assert.equal(closed.batch.summary.missingCount, 5);
  assert.equal(closed.batch.summary.batchScore, 0);
  assert.deepEqual(closed.batch.slots.map(slot => slot.status), Array(5).fill("missing"));
  assert.equal(await server.submissionStore.countActiveSessions(), 0);

  const second = await close();
  assert.equal(second.statusCode, 200);
  assert.deepEqual(json(second).batch, closed.batch);
});

test("one locked source runs all five private layouts in strict order", { timeout: 30_000 }, async t => {
  const { server, origin } = await start(t);
  const cookie = await register(origin, "batch-owner-five-slots");
  const source = "car.stop()\n# same source for all five slots";
  const { payload: created } = await createBatch(origin, cookie, source);
  const batchId = created.batch.batchId;
  let latest = created;

  for (let slotIndex = 1; slotIndex <= 5; slotIndex += 1) {
    const { response, payload } = await leaseCurrentSlot(
      origin,
      cookie,
      batchId,
      "batch-five-team",
      slotIndex
    );
    assert.equal(response.statusCode, 201, response.body.toString("utf8"));
    assert.equal(payload.lease.slotIndex, slotIndex);
    assert.equal(payload.lease.layout.slotIndex, slotIndex);
    assert.equal(payload.batch.nextSlotIndex, slotIndex);
    assert.equal(await server.submissionStore.countActiveSessions(), 1);
    const record = recordForLease(payload.lease, source);
    const submitted = await submitSlot(origin, cookie, batchId, slotIndex, payload.lease, record);
    assert.equal(submitted.statusCode, 201, submitted.body.toString("utf8"));
    latest = json(submitted);
    assert.equal(await server.submissionStore.countActiveSessions(), 0);
    assert.equal(latest.batch.slots[slotIndex - 1].final, true);
    assert.equal(latest.batch.slots[slotIndex - 1].status, "valid");
    if (slotIndex < 5) {
      assert.equal(latest.batch.nextSlotIndex, slotIndex + 1);
      assert.equal(latest.currentSlot.slotIndex, slotIndex + 1);
    }
  }

  assert.equal(latest.batch.phase, "finalized");
  assert.equal(latest.batch.nextSlotIndex, null);
  assert.equal(latest.currentSlot, null);
  assert.equal(latest.batch.summary.finalizedCount, 5);
  assert.equal(latest.batch.summary.validCount, 5);
  assert.equal(latest.batch.summary.pendingCount, 0);
});

test("expired batches remain rankable while new lease and submit mutations fail closed", async t => {
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  const { server, origin } = await start(t, { now: () => now, batchTtlMs: 1_000 });
  const cookie = await register(origin, "batch-owner-expiry");
  const first = await createBatch(origin, cookie, "car.stop()\n# expire by read");
  const firstLease = await leaseCurrentSlot(
    origin,
    cookie,
    first.payload.batch.batchId,
    "batch-expiry-team",
    1
  );
  assert.equal(firstLease.response.statusCode, 201, firstLease.response.body.toString("utf8"));
  assert.equal(await server.submissionStore.countActiveSessions(), 1);
  now += 1_000;

  const fetched = await request(origin, {
    requestPath: `/api/v1/evaluation-batches/${first.payload.batch.batchId}`,
    cookie
  });
  assert.equal(fetched.statusCode, 200, fetched.body.toString("utf8"));
  const expiredProjection = json(fetched);
  assert.equal(expiredProjection.batch.phase, "finalized");
  assert.equal(expiredProjection.batch.summary.missingCount, 5);
  assert.equal(expiredProjection.batch.summary.batchScore, 0);
  assert.equal(expiredProjection.currentSlot, null);
  assert.equal(await server.submissionStore.countActiveSessions(), 0);

  const second = await createBatch(origin, cookie, "car.stop()\n# expire before lease");
  now += 1_000;
  const expiredLease = await leaseCurrentSlot(origin, cookie, second.payload.batch.batchId);
  assert.equal(expiredLease.response.statusCode, 410, expiredLease.response.body.toString("utf8"));
  assert.equal(expiredLease.payload.error.code, "BATCH_EXPIRED");

  const closed = await request(origin, {
    requestPath: `/api/v1/evaluation-batches/${second.payload.batch.batchId}/close`,
    cookie,
    value: {}
  });
  assert.equal(closed.statusCode, 200, closed.body.toString("utf8"));
  assert.equal(json(closed).batch.summary.missingCount, 5);
});

test("ranked create is one-shot, source-and-team idempotent, owner recoverable, and lease-team locked", async t => {
  const { origin } = await start(t);
  const adminCookie = await register(origin, "ranked-bootstrap-admin");
  const ownerCookie = await register(origin, "ranked-owner-create");
  const otherCookie = await register(origin, "ranked-owner-other");
  const source = "car.stop()\n# ranked owner private source";
  const teamId = "ranked-api-team";

  const unauthenticated = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/me`
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.body.includes(source), false);

  const empty = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/me`,
    cookie: ownerCookie
  });
  assert.equal(empty.statusCode, 200);
  assert.equal(json(empty).evaluation, null);

  const created = await createRankedBatch(origin, ownerCookie, source, teamId);
  assert.equal(created.response.statusCode, 201, created.response.body.toString("utf8"));
  assert.equal(created.payload.schemaVersion, RANKED_EVALUATION_API_SCHEMA_VERSION);
  assert.equal(created.payload.authoritative, false);
  assert.equal(created.payload.created, true);
  assert.equal(created.payload.competition.competitionId, RANKED_COMPETITION_ID);
  assert.equal(created.payload.competition.scoreMaximum, 100);
  assert.equal(created.payload.evaluation.lockedSource, source);
  assert.equal(created.payload.evaluation.lockedTeamId, teamId);
  assert.deepEqual(Object.keys(created.payload.evaluation), RANKED_OWNER_EVALUATION_KEYS);
  assert.match(created.payload.evaluation.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(created.payload.evaluation.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(created.payload.evaluation.result, null);
  assert.match(created.payload.evaluation.anonymousParticipantId, /^participant_[a-f0-9]{32}$/);
  const batchId = created.payload.evaluation.batch.batchId;
  assert.match(created.response.headers["cache-control"] || "", /no-store/);
  const openMe = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/me`,
    cookie: ownerCookie
  });
  assert.equal(openMe.statusCode, 200, openMe.body.toString("utf8"));
  assert.deepEqual(Object.keys(json(openMe).evaluation), RANKED_OWNER_EVALUATION_KEYS);
  assert.equal(json(openMe).evaluation.lockedSource, source);
  assert.equal(json(openMe).evaluation.result, null);
  const ownerDetail = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/${batchId}`,
    cookie: ownerCookie
  });
  assert.equal(ownerDetail.statusCode, 200);
  assert.deepEqual(Object.keys(json(ownerDetail).evaluation), RANKED_OWNER_EVALUATION_KEYS);
  assert.equal(json(ownerDetail).evaluation.lockedSource, source);
  assert.equal(json(ownerDetail).evaluation.result, null);

  const retry = await createRankedBatch(origin, ownerCookie, source, teamId);
  assert.equal(retry.response.statusCode, 200, retry.response.body.toString("utf8"));
  assert.equal(retry.payload.created, false);
  assert.equal(retry.payload.evaluation.batch.batchId, batchId);
  assert.equal(retry.payload.evaluation.lockedSource, source);

  for (const [changedSource, changedTeam] of [[`${source}\n# changed`, teamId], [source, "changed-team"]]) {
    const conflict = await createRankedBatch(origin, ownerCookie, changedSource, changedTeam);
    assert.equal(conflict.response.statusCode, 409, conflict.response.body.toString("utf8"));
    assert.equal(conflict.payload.error.code, "RANKED_ATTEMPT_ALREADY_EXISTS");
    assert.equal(conflict.response.body.includes(source), false);
  }

  const oversized = await createRankedBatch(
    origin,
    otherCookie,
    "a".repeat((128 * 1024) + 1),
    "oversized-ranked-team"
  );
  assert.equal(oversized.response.statusCode, 400, oversized.response.body.toString("utf8"));
  assert.equal(oversized.payload.error.code, "RANKED_SOURCE_TOO_LARGE");

  const otherMe = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/me`,
    cookie: otherCookie
  });
  assert.equal(otherMe.statusCode, 200);
  assert.equal(json(otherMe).evaluation, null);
  assert.equal(otherMe.body.includes(source), false);
  const forbiddenDetail = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/${batchId}`,
    cookie: otherCookie
  });
  assert.equal(forbiddenDetail.statusCode, 403);
  assert.equal(forbiddenDetail.body.includes(source), false);

  const injectedTeam = await leaseRankedSlot(origin, ownerCookie, batchId, 1, {
    slotIndex: 1,
    teamId: "injected-team"
  });
  assert.equal(injectedTeam.response.statusCode, 400);
  assert.equal(injectedTeam.payload.error.code, "RANKED_LEASE_UNKNOWN_FIELD");

  const leased = await leaseRankedSlot(origin, ownerCookie, batchId, 1);
  assert.equal(leased.response.statusCode, 201, leased.response.body.toString("utf8"));
  assert.equal(leased.payload.lease.schemaVersion, RANKED_SLOT_LEASE_SCHEMA_VERSION);
  assert.equal(leased.payload.lease.session.teamId, teamId);
  assert.equal(leased.payload.lease.recovered, false);
  assert.deepEqual(Object.keys(leased.payload.evaluation), RANKED_OWNER_EVALUATION_KEYS);
  assert.equal(leased.payload.evaluation.lockedSource, source);
  assert.equal(leased.payload.evaluation.result, null);
  const recoveredLease = await leaseRankedSlot(origin, ownerCookie, batchId, 1);
  assert.equal(recoveredLease.response.statusCode, 200);
  assert.equal(recoveredLease.payload.lease.recovered, true);
  assert.equal(recoveredLease.payload.lease.session.sessionId, leased.payload.lease.session.sessionId);
  assert.equal(recoveredLease.payload.lease.session.teamId, teamId);

  const anonymousOpenRanking = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking`,
    cookie: ownerCookie
  });
  assert.equal(anonymousOpenRanking.statusCode, 200);
  assert.equal(json(anonymousOpenRanking).entries.length, 0, "open ranked attempts never enter the ranking");
  assert.equal(anonymousOpenRanking.body.includes(source), false);
  assert.equal(anonymousOpenRanking.body.includes(teamId), false);
  assert.equal(anonymousOpenRanking.body.includes("ranked-owner-create"), false);

  const nonAdmin = await request(origin, {
    requestPath: ADMIN_RANKED_RANKING_PATH,
    cookie: ownerCookie
  });
  assert.equal(nonAdmin.statusCode, 403);
  const adminEmpty = await request(origin, {
    requestPath: ADMIN_RANKED_RANKING_PATH,
    cookie: adminCookie
  });
  assert.equal(adminEmpty.statusCode, 200);
  assert.equal(json(adminEmpty).entries.length, 0);
});

test("ranked create resumes an exact durable reservation after a pre-batch crash", async t => {
  const { server, origin } = await start(t);
  const cookie = await register(origin, "ranked-reservation-api-owner");
  const source = "car.stop()\n# durable API reservation";
  const teamId = "reservation-api-team";
  const originalCreateDirectory = server.rankedBatchStore.createStoredDirectoryUnlocked
    .bind(server.rankedBatchStore);
  let failOnce = true;
  server.rankedBatchStore.createStoredDirectoryUnlocked = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw Object.assign(new Error("injected pre-batch crash"), {
        statusCode: 500,
        code: "INJECTED_PRE_BATCH_CRASH"
      });
    }
    return originalCreateDirectory(...args);
  };

  const interrupted = await createRankedBatch(origin, cookie, source, teamId);
  assert.equal(interrupted.response.statusCode, 500, interrupted.response.body.toString("utf8"));
  const incomplete = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/me`,
    cookie
  });
  assert.equal(incomplete.statusCode, 503, incomplete.body.toString("utf8"));
  assert.equal(errorCode(incomplete), "RANKED_ATTEMPT_RESERVATION_INCOMPLETE");

  const changed = await createRankedBatch(origin, cookie, `${source}\n# changed`, `${teamId}-changed`);
  assert.equal(changed.response.statusCode, 409, changed.response.body.toString("utf8"));
  assert.equal(changed.payload.error.code, "RANKED_ATTEMPT_ALREADY_EXISTS");

  const resumed = await createRankedBatch(origin, cookie, source, teamId);
  assert.equal(resumed.response.statusCode, 201, resumed.response.body.toString("utf8"));
  assert.equal(resumed.payload.created, true);
  assert.equal(resumed.payload.evaluation.lockedSource, source);
  assert.equal(resumed.payload.evaluation.lockedTeamId, teamId);
  const recovered = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/me`,
    cookie
  });
  assert.equal(recovered.statusCode, 200, recovered.body.toString("utf8"));
  assert.equal(json(recovered).evaluation.batch.batchId, resumed.payload.evaluation.batch.batchId);
});

test("ranked submission uses the frozen team and final results have strict anonymous/admin projections", async t => {
  const { server, origin } = await start(t, {
    verifyInWorker: async buffer => syntheticVerifiedWorkerResult(buffer)
  });
  const adminCookie = await register(origin, "ranked-results-admin");
  const ownerCookie = await register(origin, "ranked-results-owner");
  const source = "car.stop()\n# ranked submit source";
  const teamId = "ranked-results-team";
  const created = await createRankedBatch(origin, ownerCookie, source, teamId);
  assert.equal(created.response.statusCode, 201);
  const batchId = created.payload.evaluation.batch.batchId;
  const leased = await leaseRankedSlot(origin, ownerCookie, batchId, 1);
  assert.equal(leased.response.statusCode, 201, leased.response.body.toString("utf8"));
  const record = recordForLease(leased.payload.lease, source);

  const wrongTeamRecord = { ...record, teamId: "tampered-team" };
  const wrongTeam = await submitRankedSlot(
    origin,
    ownerCookie,
    batchId,
    1,
    leased.payload.lease,
    wrongTeamRecord
  );
  assert.equal(wrongTeam.statusCode, 409, wrongTeam.body.toString("utf8"));
  assert.equal(errorCode(wrongTeam), "SESSION_RECORD_MISMATCH");

  const submitted = await submitRankedSlot(origin, ownerCookie, batchId, 1, leased.payload.lease, record);
  assert.equal(submitted.statusCode, 201, submitted.body.toString("utf8"));
  const submittedPayload = json(submitted);
  assert.deepEqual(Object.keys(submittedPayload.evaluation), RANKED_OWNER_EVALUATION_KEYS);
  assert.equal(submittedPayload.evaluation.result, null);
  assert.equal(submittedPayload.evaluation.batch.slots[0].status, "valid");
  assert.equal(submittedPayload.evaluation.batch.nextSlotIndex, 2);
  assert.equal(submittedPayload.submission.verification.authoritative, false);
  assert.equal(await server.submissionStore.countActiveSessions(), 0);

  const secondLease = await leaseRankedSlot(origin, ownerCookie, batchId, 2);
  assert.equal(secondLease.response.statusCode, 201, secondLease.response.body.toString("utf8"));
  assert.equal(await server.submissionStore.countActiveSessions(), 1);

  const closed = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/${batchId}/close`,
    cookie: ownerCookie,
    value: {}
  });
  assert.equal(closed.statusCode, 200, closed.body.toString("utf8"));
  assert.deepEqual(Object.keys(json(closed).evaluation), RANKED_OWNER_EVALUATION_KEYS);
  assert.equal(json(closed).evaluation.batch.phase, "finalized");
  assert.equal(json(closed).evaluation.batch.summary.missingCount, 4);
  assert.notEqual(json(closed).evaluation.result, null);
  assert.equal(await server.submissionStore.countActiveSessions(), 0);

  const anonymous = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking?offset=0&limit=10`,
    cookie: ownerCookie
  });
  assert.equal(anonymous.statusCode, 200, anonymous.body.toString("utf8"));
  const anonymousPayload = json(anonymous);
  assert.deepEqual(Object.keys(anonymousPayload), [
    "schemaVersion", "authoritative", "competition", "scope", "order", "tiePolicy",
    "stableTieBreak", "pagination", "entries"
  ]);
  assert.equal(anonymousPayload.schemaVersion, RANKED_RANKING_SCHEMA_VERSION);
  assert.equal(anonymousPayload.scope, "anonymous");
  assert.equal(anonymousPayload.stableTieBreak, RANKED_RANKING_STABLE_TIE_BREAK);
  assert.equal(anonymousPayload.pagination.total, 1);
  assert.deepEqual(Object.keys(anonymousPayload.entries[0]), [
    "rank", "anonymousParticipantId", "score", "quality", "ranking"
  ]);
  assert.equal(anonymousPayload.entries[0].quality.validCount, 1);
  assert.equal(anonymousPayload.entries[0].quality.missingCount, 4);
  assert.equal(anonymousPayload.entries[0].score.maximum, 100);
  for (const forbidden of [source, teamId, "ranked-results-owner", "ownerUserId", "batchId",
    "createdAt", "finalizationReason", "layoutCommitment", "sessionId", "runDefinition"]) {
    assert.equal(anonymous.body.includes(forbidden), false, `anonymous ranking omits ${forbidden}`);
  }

  const admin = await request(origin, {
    requestPath: ADMIN_RANKED_RANKING_PATH,
    cookie: adminCookie
  });
  assert.equal(admin.statusCode, 200, admin.body.toString("utf8"));
  const adminPayload = json(admin);
  assert.equal(adminPayload.scope, "admin");
  assert.equal(adminPayload.entries.length, 1);
  assert.equal(adminPayload.entries[0].participant.username, "ranked-results-owner");
  assert.equal(adminPayload.entries[0].participant.displayName, "ranked-results-owner");
  assert.equal(adminPayload.entries[0].participant.teamName, "ranked-results-owner");
  assert.match(adminPayload.entries[0].participant.id, /^usr_[a-f0-9]{32}$/);
  assert.equal(adminPayload.entries[0].teamId, teamId);
  assert.equal(admin.body.includes(source), false);
  assert.equal(admin.body.includes(batchId), false);

  const me = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/me`,
    cookie: ownerCookie
  });
  assert.equal(me.statusCode, 200);
  const mePayload = json(me);
  assert.equal(mePayload.evaluation.lockedSource, source);
  assert.equal(mePayload.evaluation.lockedTeamId, teamId);
  assert.equal(mePayload.evaluation.result.rank, 1);
  assert.equal(mePayload.evaluation.result.anonymousParticipantId,
    anonymousPayload.entries[0].anonymousParticipantId);
});

test("ranked missing attempts tie publicly and ranking pagination is strict and stable", async t => {
  const { origin } = await start(t);
  const firstCookie = await register(origin, "ranked-tie-admin");
  const secondCookie = await register(origin, "ranked-tie-user");
  const first = await createRankedBatch(origin, firstCookie, "print('tie-a')", "tie-team-a");
  const second = await createRankedBatch(origin, secondCookie, "print('tie-b')", "tie-team-b");
  for (const [cookie, created] of [[firstCookie, first], [secondCookie, second]]) {
    const closed = await request(origin, {
      requestPath: `${RANKED_EVALUATION_BASE_PATH}/${created.payload.evaluation.batch.batchId}/close`,
      cookie,
      value: {}
    });
    assert.equal(closed.statusCode, 200, closed.body.toString("utf8"));
  }

  const readRanking = request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking?limit=100&offset=0`,
    cookie: secondCookie
  });
  const firstRead = await readRanking;
  const secondRead = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking?limit=100&offset=0`,
    cookie: secondCookie
  });
  assert.equal(firstRead.statusCode, 200);
  assert.deepEqual(json(secondRead), json(firstRead));
  assert.deepEqual(json(firstRead).entries.map(entry => entry.rank), [1, 1]);

  for (const query of ["?offset=-1", "?limit=0", "?limit=101", "?offset=0&offset=1", "?page=1"]) {
    const invalid = await request(origin, {
      requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking${query}`,
      cookie: secondCookie
    });
    assert.equal(invalid.statusCode, 400, `${query}: ${invalid.body.toString("utf8")}`);
    assert.equal(errorCode(invalid), "RANKING_INVALID_QUERY");
  }
});

test("admin can page 10,100 cached ranked rows without rescanning or rate-limit failure", async t => {
  const total = 10_100;
  let ownerUserId = null;
  let identifierScans = 0;
  let rankingBuilds = 0;
  let identityScans = 0;
  const rankedBatchStore = {
    ready: Promise.resolve(),
    async listRankedBatchIdentifiersForServer() {
      identifierScans += 1;
      return [];
    },
    rankPreparedRankedEvidenceForServer() {
      rankingBuilds += 1;
      return Array.from({ length: total }, (_value, index) => {
          return {
            rank: index + 1,
            anonymousParticipantId: `participant_${index.toString(16).padStart(32, "0")}`,
            ownerUserId,
            lockedTeamId: "large-ranking-team",
            createdAt: "2026-08-21T00:00:00.000Z",
            finalizationReason: "completed",
            score: { value: 100, mean: 100, minimum: 100, maximum: 100 },
            quality: {
              slotCount: 5,
              finalizedCount: 5,
              completedCount: 5,
              validCount: 5,
              invalidCount: 0,
              timeoutCount: 0,
              missingCount: 0,
              collisionCount: 0,
              outOfBoundsCount: 0
            },
            ranking: {}
          };
        });
    },
    async inspectRankedArchiveIdentityForServer() {
      identityScans += 1;
      return "mock-archive-identity";
    }
  };
  const { origin } = await start(t, {
    rankedBatchStore,
    rankedPreparationCacheTtlMs: 5_000
  });
  const cookie = await register(origin, "large-ranking-admin");
  const me = await request(origin, { requestPath: "/api/v1/auth/me", cookie });
  ownerUserId = json(me).user.id;

  for (let offset = 0; offset <= 10_000; offset += 100) {
    const page = await request(origin, {
      requestPath: `${ADMIN_RANKED_RANKING_PATH}?offset=${offset}&limit=100`,
      cookie
    });
    assert.equal(page.statusCode, 200, page.body.toString("utf8"));
    assert.equal(json(page).pagination.total, total);
  }
  assert.equal(rankingBuilds, 1, "one snapshot build should serve every HTTP page");
  assert.equal(identifierScans, 1, "one snapshot build should enumerate identifiers once");
  assert.equal(identityScans, 2, "one refresh should bracket its audit with two identity scans");
});

test("one cold ranked snapshot refresh serves 100 concurrent ranking requests", async t => {
  let identifierScans = 0;
  let identityScans = 0;
  let rankingBuilds = 0;
  let signalScanStarted;
  let releaseScan;
  const scanStarted = new Promise(resolve => { signalScanStarted = resolve; });
  const scanRelease = new Promise(resolve => { releaseScan = resolve; });
  t.after(() => releaseScan());
  const rankedBatchStore = {
    ready: Promise.resolve(),
    async listRankedBatchIdentifiersForServer() {
      identifierScans += 1;
      signalScanStarted();
      await scanRelease;
      return [];
    },
    rankPreparedRankedEvidenceForServer() {
      rankingBuilds += 1;
      return [];
    },
    async inspectRankedArchiveIdentityForServer() {
      identityScans += 1;
      return "cold-concurrent-identity";
    }
  };
  const { origin } = await start(t, {
    rankedBatchStore,
    rankedPreparationCacheTtlMs: 5_000
  });
  const cookie = await register(origin, "cold-ranking-admin");
  const requests = Array.from({ length: 100 }, () => request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking`,
    cookie
  }));
  await Promise.race([
    scanStarted,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("cold scan did not start")), 2_000))
  ]);
  releaseScan();
  const responses = await Promise.all(requests);
  responses.forEach(response => assert.equal(response.statusCode, 200, response.body.toString("utf8")));
  assert.equal(identifierScans, 1, "concurrent ranking requests share one identifier scan");
  assert.equal(rankingBuilds, 1, "concurrent ranking requests share one evidence ranking build");
  assert.equal(identityScans, 2, "the shared refresh performs one bracketed identity check");
});

test("ranked cache expiry detects a deleted bound batch and never permits a retake", async t => {
  const { origin, dataDir } = await start(t, { rankedPreparationCacheTtlMs: 1 });
  const cookie = await register(origin, "ranked-deleted-batch-owner");
  const source = "car.stop()\n# ranked permanent tombstone";
  const teamId = "ranked-tombstone-team";
  const created = await createRankedBatch(origin, cookie, source, teamId);
  const batchId = created.payload.evaluation.batch.batchId;
  const closed = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/${batchId}/close`,
    cookie,
    value: {}
  });
  assert.equal(closed.statusCode, 200, closed.body.toString("utf8"));
  const warm = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking`,
    cookie
  });
  assert.equal(warm.statusCode, 200, warm.body.toString("utf8"));
  assert.equal(json(warm).entries.length, 1);

  await fs.promises.rm(
    path.join(dataDir, "ranked-evaluations", RANKED_COMPETITION_ID, "batches", batchId),
    { recursive: true, force: true }
  );
  await new Promise(resolve => setTimeout(resolve, 5));
  const rejected = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking`,
    cookie
  });
  assert.equal(rejected.statusCode, 500, rejected.body.toString("utf8"));
  assert.equal(errorCode(rejected), "BATCH_ARCHIVE_CORRUPTED");

  const retake = await createRankedBatch(origin, cookie, source, teamId);
  assert.equal(retake.response.statusCode, 500, retake.response.body.toString("utf8"));
  assert.equal(retake.payload.error.code, "BATCH_ARCHIVE_CORRUPTED");
});

test("ranked finalization barrier prevents TTL ranking and me reads from orphaning a slow submission", async t => {
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  let signalVerifierStarted;
  let releaseVerifier;
  const verifierStarted = new Promise(resolve => { signalVerifierStarted = resolve; });
  const verifierRelease = new Promise(resolve => { releaseVerifier = resolve; });
  const { server, origin } = await start(t, {
    now: () => now,
    batchTtlMs: 1_000,
    verifyInWorker: async buffer => {
      signalVerifierStarted();
      await verifierRelease;
      return syntheticVerifiedWorkerResult(buffer);
    }
  });
  const cookie = await register(origin, "ranked-barrier-owner");
  const source = "car.stop()\n# ranked barrier source";
  const created = await createRankedBatch(origin, cookie, source, "ranked-barrier-team");
  const batchId = created.payload.evaluation.batch.batchId;
  const leased = await leaseRankedSlot(origin, cookie, batchId, 1);
  assert.equal(leased.response.statusCode, 201);
  const record = recordForLease(leased.payload.lease, source);

  const submissionPromise = submitRankedSlot(origin, cookie, batchId, 1, leased.payload.lease, record);
  await verifierStarted;
  now += 1_000;
  const rankingPromise = request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking`,
    cookie
  });
  const mePromise = request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/me`,
    cookie
  });
  releaseVerifier();

  const [submission, ranking, me] = await Promise.all([submissionPromise, rankingPromise, mePromise]);
  assert.equal(submission.statusCode, 410, submission.body.toString("utf8"));
  assert.equal(errorCode(submission), "SUBMISSION_DEADLINE_EXPIRED");
  assert.equal(ranking.statusCode, 200, ranking.body.toString("utf8"));
  assert.equal(me.statusCode, 200, me.body.toString("utf8"));
  const rankingPayload = json(ranking);
  assert.equal(rankingPayload.entries.length, 1);
  assert.equal(rankingPayload.entries[0].quality.missingCount, 5);
  assert.equal(rankingPayload.entries[0].quality.validCount, 0);
  assert.equal(json(me).evaluation.batch.phase, "finalized");
  assert.equal(json(me).evaluation.batch.summary.missingCount, 5);
  const manifests = await server.submissionStore.listSubmissionManifests(
    leased.payload.lease.session.sessionId
  );
  assert.equal(manifests.length, 0, "expired slow verification never leaves an orphan submission archive");
});

test("ranked barrier commits one receipt when TTL crosses only after the final current-slot check", async t => {
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  const { server, origin } = await start(t, {
    now: () => now,
    batchTtlMs: 1_000,
    verifyInWorker: async buffer => syntheticVerifiedWorkerResult(buffer)
  });
  const cookie = await register(origin, "ranked-barrier-commit");
  const source = "car.stop()\n# ranked barrier commit";
  const created = await createRankedBatch(origin, cookie, source, "ranked-commit-team");
  const batchId = created.payload.evaluation.batch.batchId;
  const leased = await leaseRankedSlot(origin, cookie, batchId, 1);
  const record = recordForLease(leased.payload.lease, source);

  const originalSave = server.submissionStore.saveVerifiedBatchSubmission
    .bind(server.submissionStore);
  server.submissionStore.saveVerifiedBatchSubmission = async (...args) => {
    const stored = await originalSave(...args);
    now += 1_001;
    return stored;
  };
  const submitted = await submitRankedSlot(origin, cookie, batchId, 1, leased.payload.lease, record);
  assert.equal(submitted.statusCode, 201, submitted.body.toString("utf8"));
  assert.equal(json(submitted).evaluation.batch.slots[0].status, "valid");

  const ranking = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking`,
    cookie
  });
  assert.equal(ranking.statusCode, 200, ranking.body.toString("utf8"));
  assert.equal(json(ranking).entries[0].quality.validCount, 1);
  assert.equal(json(ranking).entries[0].quality.missingCount, 4);
  const manifests = await server.submissionStore.listSubmissionManifests(
    leased.payload.lease.session.sessionId
  );
  assert.equal(manifests.length, 1);
  const rankedRecord = JSON.parse(await fs.promises.readFile(
    path.join(server.rankedBatchStore.batchesDir, batchId, "batch.json"),
    "utf8"
  ));
  assert.equal(
    rankedRecord.payload.slotExecutions[0].verifiedReceipt.submissionId,
    manifests[0].submissionId
  );
});

test("ranked readers verify different batches concurrently while a ranking audit leaves unrelated readers free", async t => {
  let verifierStarts = 0;
  let releaseVerifiers;
  let signalBothStarted;
  const verifierRelease = new Promise(resolve => { releaseVerifiers = resolve; });
  const bothStarted = new Promise(resolve => { signalBothStarted = resolve; });
  t.after(() => releaseVerifiers());
  const { origin } = await start(t, {
    verifyInWorker: async buffer => {
      verifierStarts += 1;
      if (verifierStarts === 2) signalBothStarted();
      await verifierRelease;
      return syntheticVerifiedWorkerResult(buffer);
    }
  });
  const firstCookie = await register(origin, "ranked-rw-first");
  const secondCookie = await register(origin, "ranked-rw-second");
  const laterCookie = await register(origin, "ranked-rw-later");
  const firstSource = "car.stop()\n# rw first";
  const secondSource = "car.stop()\n# rw second";
  const laterSource = "car.stop()\n# rw later";
  const first = await createRankedBatch(origin, firstCookie, firstSource, "rw-first-team");
  const second = await createRankedBatch(origin, secondCookie, secondSource, "rw-second-team");
  const later = await createRankedBatch(origin, laterCookie, laterSource, "rw-later-team");
  const firstLease = await leaseRankedSlot(origin, firstCookie, first.payload.evaluation.batch.batchId, 1);
  const secondLease = await leaseRankedSlot(origin, secondCookie, second.payload.evaluation.batch.batchId, 1);

  const firstSubmission = submitRankedSlot(
    origin, firstCookie, first.payload.evaluation.batch.batchId, 1, firstLease.payload.lease,
    recordForLease(firstLease.payload.lease, firstSource)
  );
  const secondSubmission = submitRankedSlot(
    origin, secondCookie, second.payload.evaluation.batch.batchId, 1, secondLease.payload.lease,
    recordForLease(secondLease.payload.lease, secondSource)
  );
  await Promise.race([
    bothStarted,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("verifiers did not overlap")), 2_000))
  ]);
  assert.equal(verifierStarts, 2, "different ranked batches reach the verifier concurrently");

  const ranking = request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking`,
    cookie: firstCookie
  });
  const laterDetail = request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/${later.payload.evaluation.batch.batchId}`,
    cookie: laterCookie
  });
  const laterResponse = await Promise.race([
    laterDetail,
    new Promise((_resolve, reject) => setTimeout(() => (
      reject(new Error("unrelated ranked reader was blocked by ranking audit"))
    ), 2_000))
  ]);
  assert.equal(laterResponse.statusCode, 200, laterResponse.body.toString("utf8"));
  releaseVerifiers();

  const [firstResponse, secondResponse, rankingResponse] = await Promise.all([
    firstSubmission, secondSubmission, ranking
  ]);
  assert.equal(firstResponse.statusCode, 201, firstResponse.body.toString("utf8"));
  assert.equal(secondResponse.statusCode, 201, secondResponse.body.toString("utf8"));
  assert.equal(rankingResponse.statusCode, 200, rankingResponse.body.toString("utf8"));
});

test("a ranking audit that starts first cannot push an on-time ranked submit past TTL", async t => {
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  let signalIdentifierScan;
  let releaseIdentifierScan;
  const identifierScanStarted = new Promise(resolve => { signalIdentifierScan = resolve; });
  const identifierScanRelease = new Promise(resolve => { releaseIdentifierScan = resolve; });
  t.after(() => releaseIdentifierScan());
  const { server, origin } = await start(t, {
    now: () => now,
    batchTtlMs: 1_000,
    verifyInWorker: async buffer => syntheticVerifiedWorkerResult(buffer)
  });
  const cookie = await register(origin, "ranked-refresh-before-submit");
  const source = "car.stop()\n# ranking audit started first";
  const created = await createRankedBatch(origin, cookie, source, "refresh-before-submit-team");
  const batchId = created.payload.evaluation.batch.batchId;
  const leased = await leaseRankedSlot(origin, cookie, batchId, 1);

  const originalIdentifiers = server.rankedBatchStore.listRankedBatchIdentifiersForServer
    .bind(server.rankedBatchStore);
  let pauseOnce = true;
  server.rankedBatchStore.listRankedBatchIdentifiersForServer = async () => {
    if (pauseOnce) {
      pauseOnce = false;
      signalIdentifierScan();
      await identifierScanRelease;
    }
    return originalIdentifiers();
  };

  const ranking = request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking`,
    cookie
  });
  await Promise.race([
    identifierScanStarted,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("ranking audit did not start")), 2_000))
  ]);
  const submitted = await submitRankedSlot(
    origin,
    cookie,
    batchId,
    1,
    leased.payload.lease,
    recordForLease(leased.payload.lease, source)
  );
  assert.equal(submitted.statusCode, 201, submitted.body.toString("utf8"));
  now += 1_000;
  releaseIdentifierScan();

  const rankingResponse = await ranking;
  assert.equal(rankingResponse.statusCode, 200, rankingResponse.body.toString("utf8"));
  assert.equal(json(rankingResponse).entries[0].quality.validCount, 1);
  assert.equal(json(rankingResponse).entries[0].quality.missingCount, 4);
  const manifests = await server.submissionStore.listSubmissionManifests(
    leased.payload.lease.session.sessionId
  );
  assert.equal(manifests.length, 1, "on-time archive remains the only durable slot evidence");
});

test("one owner's queued me reads neither block another submit nor starve a ranking writer", async t => {
  let releaseFirstMe;
  let signalFirstMe;
  let signalWriterQueued;
  const firstMeRelease = new Promise(resolve => { releaseFirstMe = resolve; });
  const firstMeStarted = new Promise(resolve => { signalFirstMe = resolve; });
  const writerQueued = new Promise(resolve => { signalWriterQueued = resolve; });
  let watchWriter = false;
  t.after(() => releaseFirstMe());
  const { server, origin } = await start(t, {
    verifyInWorker: async buffer => syntheticVerifiedWorkerResult(buffer),
    onRankedAccessQueued: event => {
      if (watchWriter && event.mode === "write" && event.activeReaders === 1) signalWriterQueued();
    }
  });
  const spamCookie = await register(origin, "ranked-owner-spam");
  const submitCookie = await register(origin, "ranked-owner-submit");
  const spamMe = await request(origin, { requestPath: "/api/v1/auth/me", cookie: spamCookie });
  const spamOwnerUserId = json(spamMe).user.id;
  const spamBatch = await createRankedBatch(
    origin,
    spamCookie,
    "car.stop()\n# owner-local queue",
    "owner-local-team"
  );
  assert.equal(spamBatch.response.statusCode, 201);
  const submitSource = "car.stop()\n# unrelated submit";
  const submitBatch = await createRankedBatch(origin, submitCookie, submitSource, "unrelated-team");
  const submitBatchId = submitBatch.payload.evaluation.batch.batchId;
  const submitLease = await leaseRankedSlot(origin, submitCookie, submitBatchId, 1);

  const originalOwnerEvidence = server.rankedBatchStore.readRankedOwnerBatchEvidenceForServer
    .bind(server.rankedBatchStore);
  let pauseOnce = true;
  server.rankedBatchStore.readRankedOwnerBatchEvidenceForServer = async command => {
    if (pauseOnce && command.ownerUserId === spamOwnerUserId) {
      pauseOnce = false;
      signalFirstMe();
      await firstMeRelease;
    }
    return originalOwnerEvidence(command);
  };

  const firstMeRequest = request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/me`,
    cookie: spamCookie
  });
  await firstMeStarted;
  const completionOrder = [];
  const queuedMeRequests = Array.from({ length: 99 }, () => request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/me`,
    cookie: spamCookie
  }).then(response => {
    if (!completionOrder.includes("queued-me")) completionOrder.push("queued-me");
    return response;
  }));

  watchWriter = true;
  const ranking = request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking`,
    cookie: submitCookie
  }).then(response => {
    completionOrder.push("writer");
    return response;
  });
  await Promise.race([
    writerQueued,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("ranking writer did not queue")), 2_000))
  ]);
  const submitted = await submitRankedSlot(
    origin,
    submitCookie,
    submitBatchId,
    1,
    submitLease.payload.lease,
    recordForLease(submitLease.payload.lease, submitSource)
  );
  assert.equal(submitted.statusCode, 201, submitted.body.toString("utf8"));
  releaseFirstMe();

  const [firstMeResponse, rankingResponse, ...queuedResponses] = await Promise.all([
    firstMeRequest,
    ranking,
    ...queuedMeRequests
  ]);
  assert.equal(firstMeResponse.statusCode, 200, firstMeResponse.body.toString("utf8"));
  assert.equal(rankingResponse.statusCode, 503, rankingResponse.body.toString("utf8"));
  assert.equal(errorCode(rankingResponse), "RANKING_REFRESH_RETRY");
  queuedResponses.forEach(response => assert.equal(response.statusCode, 200, response.body.toString("utf8")));
  assert.ok(completionOrder.indexOf("writer") < completionOrder.indexOf("queued-me"),
    `writer must precede queued owner reads: ${completionOrder.join(",")}`);
  const retry = await request(origin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking`,
    cookie: submitCookie
  });
  assert.equal(retry.statusCode, 200, retry.body.toString("utf8"));
});

test("ranked restart reconciles an on-time archive before TTL ranking and rejects best-of retry", { timeout: 30_000 }, async t => {
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chenlong-ranked-recovery-"));
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map(closeServer));
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  const firstServer = createServer({
    dataDir,
    now: () => now,
    batchTtlMs: 1_000,
    verifyInWorker: async buffer => syntheticVerifiedWorkerResult(buffer)
  });
  servers.push(firstServer);
  const firstOrigin = await listen(firstServer);
  const cookie = await register(firstOrigin, "ranked-crash-owner");
  const source = "car.stop()\n# ranked crash recovery";
  const created = await createRankedBatch(firstOrigin, cookie, source, "ranked-crash-team");
  const batchId = created.payload.evaluation.batch.batchId;
  const leased = await leaseRankedSlot(firstOrigin, cookie, batchId, 1);
  const originalRecord = recordForLease(leased.payload.lease, source);
  const conflictingRecord = { ...originalRecord, recoveryBestOfNonce: "different bytes" };

  const originalCommit = firstServer.rankedBatchStore.submitVerifiedSlotResult
    .bind(firstServer.rankedBatchStore);
  let failReceiptOnce = true;
  firstServer.rankedBatchStore.submitVerifiedSlotResult = async (...args) => {
    if (failReceiptOnce) {
      failReceiptOnce = false;
      throw Object.assign(new Error("injected ranked receipt write failure"), {
        statusCode: 500,
        code: "INJECTED_RANKED_RECEIPT_FAILURE"
      });
    }
    return originalCommit(...args);
  };
  const interrupted = await submitRankedSlot(
    firstOrigin, cookie, batchId, 1, leased.payload.lease, originalRecord
  );
  assert.equal(interrupted.statusCode, 500, interrupted.body.toString("utf8"));
  assert.equal((await firstServer.submissionStore.listSubmissionManifests(
    leased.payload.lease.session.sessionId
  )).length, 1);
  await closeServer(firstServer);

  now += 1_000;
  let restartedVerificationCount = 0;
  const secondServer = createServer({
    dataDir,
    now: () => now,
    batchTtlMs: 1_000,
    verifyInWorker: async buffer => {
      restartedVerificationCount += 1;
      return syntheticVerifiedWorkerResult(buffer);
    }
  });
  servers.push(secondServer);
  const secondOrigin = await listen(secondServer);
  const ranking = await request(secondOrigin, {
    requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking`,
    cookie
  });
  assert.equal(ranking.statusCode, 200, ranking.body.toString("utf8"));
  assert.equal(json(ranking).entries.length, 1);
  assert.equal(json(ranking).entries[0].quality.validCount, 1);
  assert.equal(json(ranking).entries[0].quality.missingCount, 4);
  assert.equal(await secondServer.submissionStore.countActiveSessions(), 0,
    "restart reconciliation must durably retire the recovered slot session");

  const conflict = await submitRankedSlot(
    secondOrigin, cookie, batchId, 1, leased.payload.lease, conflictingRecord
  );
  assert.equal(conflict.statusCode, 409, conflict.body.toString("utf8"));
  assert.equal(errorCode(conflict), "SLOT_ALREADY_FINALIZED");
  const recovered = await submitRankedSlot(
    secondOrigin, cookie, batchId, 1, leased.payload.lease, originalRecord
  );
  assert.equal(recovered.statusCode, 200, recovered.body.toString("utf8"));
  assert.equal(json(recovered).duplicate, true);
  assert.equal(restartedVerificationCount, 0);
});

test("ranked evidence audit caches unchanged files, fails closed on tampering, and isolates other owners", async t => {
  for (const tamper of ["delete-report", "modify-report", "modify-record"]) {
    await t.test(tamper, async child => {
      const { server, origin, dataDir } = await start(child, {
        verifyInWorker: async buffer => syntheticVerifiedWorkerResult(buffer),
        rankedPreparationCacheTtlMs: 1
      });
      const ownerCookie = await register(origin, `ranked-evidence-${tamper}`);
      const source = `car.stop()\n# ranked evidence ${tamper}`;
      const created = await createRankedBatch(origin, ownerCookie, source, `evidence-${tamper}`);
      const batchId = created.payload.evaluation.batch.batchId;
      const leased = await leaseRankedSlot(origin, ownerCookie, batchId, 1);
      const submitted = await submitRankedSlot(
        origin,
        ownerCookie,
        batchId,
        1,
        leased.payload.lease,
        recordForLease(leased.payload.lease, source)
      );
      assert.equal(submitted.statusCode, 201, submitted.body.toString("utf8"));

      const originalRead = server.submissionStore.readSubmission.bind(server.submissionStore);
      let fullEvidenceReads = 0;
      server.submissionStore.readSubmission = async (...args) => {
        fullEvidenceReads += 1;
        return originalRead(...args);
      };
      const closed = await request(origin, {
        requestPath: `${RANKED_EVALUATION_BASE_PATH}/${batchId}/close`,
        cookie: ownerCookie,
        value: {}
      });
      assert.equal(closed.statusCode, 200, closed.body.toString("utf8"));
      assert.equal(fullEvidenceReads, 1, "first receipt audit performs one full record read");

      const firstRanking = await request(origin, {
        requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking`,
        cookie: ownerCookie
      });
      const secondRanking = await request(origin, {
        requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking`,
        cookie: ownerCookie
      });
      assert.equal(firstRanking.statusCode, 200, firstRanking.body.toString("utf8"));
      assert.equal(secondRanking.statusCode, 200, secondRanking.body.toString("utf8"));
      assert.equal(fullEvidenceReads, 1, "unchanged trusted file identity reuses the evidence audit");

      const [manifest] = await server.submissionStore.listSubmissionManifests(
        leased.payload.lease.session.sessionId
      );
      const submissionDirectory = path.join(
        dataDir,
        "sessions",
        leased.payload.lease.session.sessionId,
        "submissions",
        manifest.submissionId
      );
      if (tamper === "delete-report") {
        await fs.promises.unlink(path.join(submissionDirectory, "report.json"));
      } else {
        const filename = tamper === "modify-report" ? "report.json" : "record.json";
        await fs.promises.appendFile(path.join(submissionDirectory, filename), " ");
      }
      await new Promise(resolve => setTimeout(resolve, 5));
      const rejectedRanking = await request(origin, {
        requestPath: `${RANKED_EVALUATION_BASE_PATH}/ranking`,
        cookie: ownerCookie
      });
      assert.equal(rejectedRanking.statusCode, 500, rejectedRanking.body.toString("utf8"));
      assert.equal(errorCode(rejectedRanking), "BATCH_RECEIPT_EVIDENCE_CORRUPTED");

      const isolatedCookie = await register(origin, `ranked-isolated-${tamper}`);
      const isolatedSource = `car.stop()\n# isolated ${tamper}`;
      const isolated = await createRankedBatch(
        origin,
        isolatedCookie,
        isolatedSource,
        `isolated-${tamper}`
      );
      assert.equal(isolated.response.statusCode, 201, isolated.response.body.toString("utf8"));
      const isolatedMe = await request(origin, {
        requestPath: `${RANKED_EVALUATION_BASE_PATH}/me`,
        cookie: isolatedCookie
      });
      assert.equal(isolatedMe.statusCode, 200, isolatedMe.body.toString("utf8"));
      assert.equal(json(isolatedMe).evaluation.lockedSource, isolatedSource);
      const isolatedLease = await leaseRankedSlot(
        origin,
        isolatedCookie,
        isolated.payload.evaluation.batch.batchId,
        1
      );
      assert.equal(isolatedLease.response.statusCode, 201, isolatedLease.response.body.toString("utf8"));
      const isolatedSubmission = await submitRankedSlot(
        origin,
        isolatedCookie,
        isolated.payload.evaluation.batch.batchId,
        1,
        isolatedLease.payload.lease,
        recordForLease(isolatedLease.payload.lease, isolatedSource)
      );
      assert.equal(isolatedSubmission.statusCode, 201, isolatedSubmission.body.toString("utf8"));
    });
  }
});
