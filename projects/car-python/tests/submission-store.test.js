"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { gzipSync } = require("node:zlib");

const {
  SCHEMA_VERSION,
  createSession: createCompetitionSession
} = require("../competition-core.js");
const {
  LOCAL_CHALLENGES,
  DATA_DIRECTORY_WRITER_LOCK_FILENAME,
  createServer
} = require("../server.js");
const {
  SESSION_SCHEMA_VERSION,
  CHALLENGE_COMMITMENT_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
  DEFAULT_MAX_STORAGE_BYTES,
  STORAGE_WARNING_PERCENT,
  STORAGE_CRITICAL_PERCENT,
  SubmissionStoreError,
  SubmissionStore,
  aggregateBestSubmittedRecords,
  publicChallengeMetadata,
  publicVerificationSummary
} = require("../backend/submission-store.js");
const { canonicalSha256 } = require("../backend/canonical-json.js");

const TASK_ID = "R2-GYI-MVP-01";

test("default single-session capacity admits 500 concurrent active sessions", async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-500-sessions-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = new SubmissionStore({ rootDir });
  await store.ready;
  const sessions = await Promise.all(Array.from({ length: 500 }, (_, index) => store.createSession(
    `capacity-team-${index}`,
    LOCAL_CHALLENGES[TASK_ID],
    `usr_${crypto.createHash("sha256").update(String(index)).digest("hex").slice(0, 32)}`,
    { scope: "single" }
  )));
  assert.equal(new Set(sessions.map(item => item.session.sessionId)).size, 500);
});

test("run archive defaults to four GiB and reports warning and critical capacity", async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-storage-health-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = new SubmissionStore({ rootDir, maxStorageBytes: 100 });
  await store.ready;
  assert.equal(DEFAULT_MAX_STORAGE_BYTES, 4 * 1024 * 1024 * 1024);
  assert.equal(STORAGE_WARNING_PERCENT, 80);
  assert.equal(STORAGE_CRITICAL_PERCENT, 95);
  assert.deepEqual(store.storageStatus(), {
    status: "ok",
    usedBytes: 0,
    maxBytes: 100,
    availableBytes: 100,
    utilizationPercent: 0,
    warningThresholdPercent: 80,
    criticalThresholdPercent: 95,
    nearCapacity: false
  });
  store.usedBytes = 80;
  assert.equal(store.storageStatus().status, "warning");
  assert.equal(store.storageStatus().nearCapacity, true);
  store.usedBytes = 95;
  assert.equal(store.storageStatus().status, "critical");
  assert.equal(store.storageStatus().availableBytes, 5);
});

test("ranked archive deadlines are atomic, half-open, non-writing when late, and duplicate-safe", async t => {
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-ranked-deadline-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = new SubmissionStore({ rootDir, now: () => now });
  await store.ready;
  const ownerUserId = `usr_${"9".repeat(32)}`;

  const createCase = async suffix => {
    const batchId = `bat_${crypto.createHash("sha256").update(suffix).digest("hex").slice(0, 32)}`;
    const batchOptions = {
      scope: "ranked",
      batchId,
      slotIndex: 1,
      competitionId: "2026-r2-gyi-local-screening.1"
    };
    const created = await store.createSession(
      `deadline-team-${suffix}`,
      LOCAL_CHALLENGES[TASK_ID],
      ownerUserId,
      batchOptions
    );
    const session = await store.readSession(created.session.sessionId);
    const metadata = {
      schemaVersion: "chenlong.run-record/v4",
      serverSessionId: session.sessionId,
      runId: session.runId,
      challengeDigest: session.challengeDigest,
      runDefinitionDigest: canonicalSha256(session.challenge.runDefinition),
      teamId: session.teamId,
      taskId: session.challenge.taskId,
      mapId: session.challenge.mapId,
      mapVersion: session.challenge.mapVersion,
      ruleVersion: session.challenge.ruleVersion
    };
    const report = { schemaVersion: "chenlong.verification-report/v1", status: "verified" };
    return {
      session,
      metadata,
      report,
      reportBuffer: Buffer.from(`${JSON.stringify(report)}\n`),
      recordBuffer: Buffer.from(`{"case":"${suffix}"}\n`),
      batchOptions
    };
  };

  const before = await createCase("before");
  const beforeDeadline = new Date(now + 10).toISOString();
  const acceptedBefore = await store.saveVerifiedBatchSubmission(
    before.session.sessionId, ownerUserId, before.recordBuffer, before.reportBuffer,
    before.report, before.metadata, { ...before.batchOptions, notAfter: beforeDeadline }
  );
  assert.equal(acceptedBefore.manifest.receivedAt, new Date(now).toISOString());

  const boundary = await createCase("boundary");
  const boundaryDeadline = new Date(now).toISOString();
  const bytesBeforeBoundary = store.usedBytes;
  await assert.rejects(
    () => store.saveVerifiedBatchSubmission(
      boundary.session.sessionId, ownerUserId, boundary.recordBuffer, boundary.reportBuffer,
      boundary.report, boundary.metadata, { ...boundary.batchOptions, notAfter: boundaryDeadline }
    ),
    error => error instanceof SubmissionStoreError && error.code === "SUBMISSION_DEADLINE_EXPIRED"
  );
  assert.equal(store.usedBytes, bytesBeforeBoundary);
  assert.deepEqual(await store.listSubmissionManifests(boundary.session.sessionId), []);

  const late = await createCase("late");
  const lateDeadline = new Date(now).toISOString();
  const bytesBeforeLate = store.usedBytes;
  now += 1;
  await assert.rejects(
    () => store.saveVerifiedBatchSubmission(
      late.session.sessionId, ownerUserId, late.recordBuffer, late.reportBuffer,
      late.report, late.metadata, { ...late.batchOptions, notAfter: lateDeadline }
    ),
    error => error instanceof SubmissionStoreError
      && error.code === "SUBMISSION_DEADLINE_EXPIRED"
      && error.statusCode === 410
  );
  assert.equal(store.usedBytes, bytesBeforeLate);
  assert.deepEqual(await store.listSubmissionManifests(late.session.sessionId), []);

  now += 20;
  const bytesBeforeDuplicate = store.usedBytes;
  const duplicate = await store.saveVerifiedBatchSubmission(
    before.session.sessionId, ownerUserId, before.recordBuffer, before.reportBuffer,
    before.report, before.metadata, { ...before.batchOptions, notAfter: beforeDeadline }
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.manifest.receivedAt, new Date(Date.parse(beforeDeadline) - 10).toISOString());
  assert.equal(store.usedBytes, bytesBeforeDuplicate);
});

test("batch session scope is private, single-write, and durable retirement releases active capacity", async t => {
  let now = Date.parse("2026-08-21T01:00:00.000Z");
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-session-retirement-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const ownerUserId = `usr_${"8".repeat(32)}`;
  const batchId = `bat_${"7".repeat(32)}`;
  const scope = { scope: "practice", batchId, slotIndex: 1 };
  let store = new SubmissionStore({ rootDir, now: () => now, maxSessions: 1 });
  await store.ready;
  const created = await store.createSession(
    "retirement-team",
    LOCAL_CHALLENGES[TASK_ID],
    ownerUserId,
    scope
  );
  assert.deepEqual(Object.keys(created.session).sort(), [
    "authoritative", "challenge", "challengeDigest", "createdAt", "expiresAt", "maxSubmissions",
    "ownerUserId", "runId", "schemaVersion", "sessionId", "status", "submissionCount", "teamId"
  ].sort());
  assert.equal(JSON.stringify(created.session).includes(batchId), false);
  assert.equal((await store.readSessionScopeForServer(created.session.sessionId)).scope, "practice");
  assert.equal(await store.countActiveSessions(), 1);

  const session = await store.readSession(created.session.sessionId);
  const metadata = {
    schemaVersion: "chenlong.run-record/v4",
    serverSessionId: session.sessionId,
    runId: session.runId,
    challengeDigest: session.challengeDigest,
    runDefinitionDigest: canonicalSha256(session.challenge.runDefinition),
    teamId: session.teamId,
    taskId: session.challenge.taskId,
    mapId: session.challenge.mapId,
    mapVersion: session.challenge.mapVersion,
    ruleVersion: session.challenge.ruleVersion
  };
  const report = { schemaVersion: "chenlong.verification-report/v1", status: "verified" };
  const reportBuffer = Buffer.from(`${JSON.stringify(report)}\n`);
  const recordA = Buffer.from('{"winner":"a"}\n');
  const recordB = Buffer.from('{"winner":"b"}\n');

  await assert.rejects(
    () => store.saveSubmission(session, created.submitToken, recordA, reportBuffer, report, metadata),
    error => error instanceof SubmissionStoreError
      && error.statusCode === 403
      && error.code === "BATCH_SESSION_REQUIRES_BATCH_ROUTE"
  );
  assert.deepEqual(await store.listSubmissionManifests(session.sessionId), []);

  const attempts = await Promise.allSettled([recordA, recordB].map(recordBuffer => (
    store.saveVerifiedBatchSubmission(
      session.sessionId,
      ownerUserId,
      recordBuffer,
      reportBuffer,
      report,
      metadata,
      scope
    )
  )));
  assert.equal(attempts.filter(attempt => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter(attempt => (
    attempt.status === "rejected" && attempt.reason?.code === "BATCH_SESSION_SUBMISSION_EXISTS"
  )).length, 1);
  const accepted = attempts.find(attempt => attempt.status === "fulfilled").value;
  assert.equal((await store.listSubmissionManifests(session.sessionId)).length, 1);

  await store.retireSessionForServer(session.sessionId, "batch_slot_completed");
  await store.retireSessionForServer(session.sessionId, "batch_closed");
  assert.equal(await store.countActiveSessions(), 0);
  assert.equal((await store.readSubmission(
    session.sessionId,
    accepted.manifest.submissionId,
    null,
    { skipAuthorization: true }
  )).manifest.record.sha256, accepted.manifest.record.sha256);
  await assert.rejects(
    () => store.saveVerifiedBatchSubmission(
      session.sessionId,
      ownerUserId,
      recordA,
      reportBuffer,
      report,
      metadata,
      scope
    ),
    error => error instanceof SubmissionStoreError && error.code === "SESSION_RETIRED"
  );

  store = new SubmissionStore({ rootDir, now: () => now, maxSessions: 1 });
  await store.ready;
  assert.equal(await store.countActiveSessions(), 0);
  const replacement = await store.createSession("replacement-team", LOCAL_CHALLENGES[TASK_ID], ownerUserId);
  assert.match(replacement.session.sessionId, /^ses_[a-f0-9]{32}$/);

  const retirementPath = path.join(rootDir, "sessions", session.sessionId, "retirement.json");
  fs.writeFileSync(retirementPath, "{}\n");
  store = new SubmissionStore({ rootDir, now: () => now, maxSessions: 2 });
  await store.ready;
  assert.equal(await store.countActiveSessions(), 2, "damaged retirement markers must fail closed");
});

test("single-run drafts durably seal sessions, release quota, and remain owner-submittable", async t => {
  let now = Date.parse("2026-08-21T02:00:00.000Z");
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-single-session-seal-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const ownerUserId = `usr_${"6".repeat(32)}`;
  const options = { rootDir, now: () => now, sessionTtlMs: 1000, maxSessions: 1 };
  let store = new SubmissionStore(options);
  await store.ready;
  const savedRuns = [];

  for (let index = 0; index < 100; index += 1) {
    const created = await store.createSession(
      `capacity-team-${index}`,
      LOCAL_CHALLENGES[TASK_ID],
      ownerUserId
    );
    const session = await store.readSession(created.session.sessionId);
    const metadata = metadataForStoredSession(session);
    const recordBuffer = Buffer.from(`${JSON.stringify({ index, runId: session.runId })}\n`);
    const saved = await store.saveDraft(
      session,
      created.submitToken,
      recordBuffer,
      metadata,
      { score: index }
    );
    assert.equal(saved.duplicate, false);
    if (index < 2) savedRuns.push({ created, session, metadata, recordBuffer, saved });

    if (index === 0) {
      const duplicate = await store.saveDraft(
        session,
        created.submitToken,
        recordBuffer,
        metadata,
        { score: index }
      );
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.manifest.savedAt, saved.manifest.savedAt);

      const differentRecord = Buffer.from(`${JSON.stringify({ index, runId: session.runId, different: true })}\n`);
      await assert.rejects(
        () => store.saveDraft(session, created.submitToken, differentRecord, metadata, { score: index }),
        error => error instanceof SubmissionStoreError
          && error.statusCode === 409
          && error.code === "SINGLE_SESSION_RECORD_EXISTS"
      );
      const report = { schemaVersion: "chenlong.verification-report/v1", status: "verified" };
      await assert.rejects(
        () => store.saveSubmission(
          session,
          created.submitToken,
          differentRecord,
          Buffer.from(`${JSON.stringify(report)}\n`),
          report,
          metadata
        ),
        error => error instanceof SubmissionStoreError
          && error.statusCode === 409
          && error.code === "SINGLE_SESSION_RECORD_EXISTS"
      );
    }

    if (index === 49) {
      assert.equal(await store.countActiveSessions(), 0);
      store = new SubmissionStore(options);
      await store.ready;
      assert.equal(await store.countActiveSessions(), 0,
        "a restart must not count sessions that already contain single-run evidence");
    }
    now += 1;
  }

  assert.equal((await store.listArchiveSessionIds()).length, 100);
  assert.equal(await store.countActiveSessions(), 0);
  const newestFive = await store.listRecords({
    ownerUserId,
    expectedScope: "single",
    maximum: 10,
    limit: 5
  });
  assert.deepEqual(newestFive.map(record => record.score), [99, 98, 97, 96, 95],
    "a finite newest-record query must not fail merely because the archive is larger than its response bound");

  const report = { schemaVersion: "chenlong.verification-report/v1", status: "verified" };
  const reportBuffer = Buffer.from(`${JSON.stringify(report)}\n`);
  const first = savedRuns[0];
  const submitted = await store.saveVerifiedSingleSubmission(
    first.session.sessionId,
    ownerUserId,
    first.recordBuffer,
    reportBuffer,
    report,
    first.metadata
  );
  assert.equal(submitted.duplicate, false);
  await store.promoteDraftToSubmission(first.session.sessionId, submitted.manifest.submissionId, ownerUserId);
  const retryAfterPromotion = await store.saveDraft(
    first.session,
    first.created.submitToken,
    first.recordBuffer,
    first.metadata,
    { score: 0 }
  );
  assert.equal(retryAfterPromotion.duplicate, true,
    "a late auto-save retry must stay idempotent after formal promotion");
  assert.equal(retryAfterPromotion.manifest.savedAt, first.saved.manifest.savedAt);

  now += 1000;
  const expired = savedRuns[1];
  const expiredSubmission = await store.saveVerifiedSingleSubmission(
    expired.session.sessionId,
    ownerUserId,
    expired.recordBuffer,
    reportBuffer,
    report,
    expired.metadata
  );
  assert.equal(expiredSubmission.duplicate, false,
    "the owner must be able to submit an auto-saved draft after its lease expires");
  await store.promoteDraftToSubmission(
    expired.session.sessionId,
    expiredSubmission.manifest.submissionId,
    ownerUserId
  );
});

test("corrupt single-run evidence is not trusted to release active-session capacity", async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-single-seal-corruption-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const ownerUserId = `usr_${"a".repeat(32)}`;
  const options = { rootDir, maxSessions: 1 };
  let store = new SubmissionStore(options);
  await store.ready;
  const created = await store.createSession(
    "corrupt-seal-team",
    LOCAL_CHALLENGES[TASK_ID],
    ownerUserId
  );
  const session = await store.readSession(created.session.sessionId);
  const metadata = metadataForStoredSession(session);
  const recordBuffer = Buffer.from(`${JSON.stringify({ runId: session.runId })}\n`);
  const saved = await store.saveDraft(session, created.submitToken, recordBuffer, metadata, { score: 1 });
  const archivedRecordPath = path.join(
    rootDir,
    "sessions",
    session.sessionId,
    "drafts",
    saved.manifest.recordId,
    "record.json.gz"
  );
  const tamperedRecord = Buffer.from(await fs.promises.readFile(archivedRecordPath));
  tamperedRecord[0] ^= 1;
  await fs.promises.writeFile(archivedRecordPath, tamperedRecord);

  store = new SubmissionStore(options);
  await store.ready;
  assert.equal(await store.countActiveSessions(), 1,
    "same-length record tampering must fail closed for capacity accounting");
  await assert.rejects(
    () => store.createSession("blocked-by-corrupt-seal", LOCAL_CHALLENGES[TASK_ID], ownerUserId),
    error => error instanceof SubmissionStoreError
      && error.statusCode === 429
      && error.code === "SESSION_LIMIT_REACHED"
  );
});

test("scope quotas reserve ranked and practice capacity from each other", async t => {
  const ownerUserId = `usr_${"6".repeat(32)}`;
  const competitionId = "2026-r2-gyi-local-screening.1";
  const makeBatchId = (prefix, index) => `bat_${`${prefix}${index.toString(16)}`.padEnd(32, prefix).slice(0, 32)}`;

  const practiceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-practice-quota-"));
  t.after(() => fs.rmSync(practiceRoot, { recursive: true, force: true }));
  const practiceFull = new SubmissionStore({
    rootDir: practiceRoot,
    maxSessionsByScope: { single: 100, practice: 100, ranked: 100 }
  });
  await practiceFull.ready;
  for (let index = 0; index < 100; index += 1) {
    await practiceFull.createSession(
      `practice-${index}`,
      LOCAL_CHALLENGES[TASK_ID],
      ownerUserId,
      { scope: "practice", batchId: makeBatchId("a", index), slotIndex: 1 }
    );
  }
  await assert.rejects(
    () => practiceFull.createSession(
      "practice-overflow",
      LOCAL_CHALLENGES[TASK_ID],
      ownerUserId,
      { scope: "practice", batchId: makeBatchId("b", 0), slotIndex: 1 }
    ),
    error => error instanceof SubmissionStoreError && error.code === "SESSION_SCOPE_LIMIT_REACHED"
  );
  const rankedAfterPractice = await practiceFull.createSession(
    "ranked-reserved",
    LOCAL_CHALLENGES[TASK_ID],
    ownerUserId,
    {
      scope: "ranked",
      competitionId,
      batchId: makeBatchId("c", 0),
      slotIndex: 1
    }
  );
  assert.match(rankedAfterPractice.session.sessionId, /^ses_[a-f0-9]{32}$/);

  const rankedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-ranked-quota-"));
  t.after(() => fs.rmSync(rankedRoot, { recursive: true, force: true }));
  const rankedFull = new SubmissionStore({
    rootDir: rankedRoot,
    maxSessionsByScope: { single: 100, practice: 100, ranked: 100 }
  });
  await rankedFull.ready;
  for (let index = 0; index < 100; index += 1) {
    await rankedFull.createSession(
      `ranked-${index}`,
      LOCAL_CHALLENGES[TASK_ID],
      ownerUserId,
      {
        scope: "ranked",
        competitionId,
        batchId: makeBatchId("d", index),
        slotIndex: 1
      }
    );
  }
  const practiceAfterRanked = await rankedFull.createSession(
    "practice-reserved",
    LOCAL_CHALLENGES[TASK_ID],
    ownerUserId,
    { scope: "practice", batchId: makeBatchId("e", 0), slotIndex: 1 }
  );
  assert.match(practiceAfterRanked.session.sessionId, /^ses_[a-f0-9]{32}$/);
});

test("batch session lifetimes clamp to the parent deadline and expired leases release both scope quotas after restart", async t => {
  let now = Date.parse("2026-08-21T02:00:00.000Z");
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-parent-deadline-quota-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const ownerUserId = `usr_${"5".repeat(32)}`;
  const competitionId = "2026-r2-gyi-local-screening.1";
  const deadline = new Date(now + 100).toISOString();
  const quotaOptions = { single: 1, practice: 100, ranked: 100 };
  const batchId = index => `bat_${index.toString(16).padStart(32, "0")}`;
  let store = new SubmissionStore({
    rootDir,
    now: () => now,
    maxSessionsByScope: quotaOptions
  });
  await store.ready;

  let firstPractice;
  let firstRanked;
  for (let index = 0; index < 100; index += 1) {
    const practice = await store.createSession(
      `parent-practice-${index}`,
      LOCAL_CHALLENGES[TASK_ID],
      ownerUserId,
      { scope: "practice", batchId: batchId(index), slotIndex: 1 },
      { notAfter: deadline }
    );
    const ranked = await store.createSession(
      `parent-ranked-${index}`,
      LOCAL_CHALLENGES[TASK_ID],
      ownerUserId,
      {
        scope: "ranked",
        competitionId,
        batchId: batchId(1_000 + index),
        slotIndex: 1
      },
      { notAfter: deadline }
    );
    firstPractice ||= practice;
    firstRanked ||= ranked;
  }
  assert.equal(firstPractice.session.expiresAt, deadline);
  assert.equal(firstRanked.session.expiresAt, deadline);
  await assert.rejects(
    () => store.createSession(
      "practice-before-parent-deadline-overflow",
      LOCAL_CHALLENGES[TASK_ID],
      ownerUserId,
      { scope: "practice", batchId: batchId(2_000), slotIndex: 1 },
      { notAfter: deadline }
    ),
    error => error instanceof SubmissionStoreError && error.code === "SESSION_SCOPE_LIMIT_REACHED"
  );
  await assert.rejects(
    () => store.createSession(
      "ranked-before-parent-deadline-overflow",
      LOCAL_CHALLENGES[TASK_ID],
      ownerUserId,
      {
        scope: "ranked",
        competitionId,
        batchId: batchId(2_001),
        slotIndex: 1
      },
      { notAfter: deadline }
    ),
    error => error instanceof SubmissionStoreError && error.code === "SESSION_SCOPE_LIMIT_REACHED"
  );

  now += 100;
  store = new SubmissionStore({
    rootDir,
    now: () => now,
    maxSessionsByScope: quotaOptions
  });
  await store.ready;
  assert.equal(await store.countActiveSessions(), 0,
    "the half-open parent deadline releases capacity durably after restart");
  const directoryCountAtBoundary = (await fs.promises.readdir(path.join(rootDir, "sessions"))).length;
  await assert.rejects(
    () => store.createSession(
      "exact-parent-boundary",
      LOCAL_CHALLENGES[TASK_ID],
      ownerUserId,
      { scope: "practice", batchId: batchId(3_000), slotIndex: 1 },
      { notAfter: new Date(now).toISOString() }
    ),
    error => error instanceof SubmissionStoreError
      && error.statusCode === 410
      && error.code === "SESSION_DEADLINE_EXPIRED"
  );
  assert.equal((await fs.promises.readdir(path.join(rootDir, "sessions"))).length, directoryCountAtBoundary);

  const nextDeadline = new Date(now + 100).toISOString();
  const replacementPractice = await store.createSession(
    "practice-after-parent-deadline",
    LOCAL_CHALLENGES[TASK_ID],
    ownerUserId,
    { scope: "practice", batchId: batchId(3_001), slotIndex: 1 },
    { notAfter: nextDeadline }
  );
  const replacementRanked = await store.createSession(
    "ranked-after-parent-deadline",
    LOCAL_CHALLENGES[TASK_ID],
    ownerUserId,
    {
      scope: "ranked",
      competitionId,
      batchId: batchId(3_002),
      slotIndex: 1
    },
    { notAfter: nextDeadline }
  );
  assert.equal(replacementPractice.session.expiresAt, nextDeadline);
  assert.equal(replacementRanked.session.expiresAt, nextDeadline);
});

test("retained history enumeration is not part of active session admission", async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-session-limit-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = new SubmissionStore({ rootDir });
  await store.ready;
  store.listArchiveSessionIds = async () => {
    throw new Error("active admission must not enumerate retained archives");
  };
  const created = await store.createSession(
    "history-independent-team",
    LOCAL_CHALLENGES[TASK_ID],
    `usr_${"1".repeat(32)}`
  );
  assert.match(created.session.sessionId, /^ses_[a-f0-9]{32}$/);
  assert.equal(await store.countActiveSessions(), 1);
});

test("more than ten thousand historical submissions aggregate to 2,000-by-three winners without losing old highs", () => {
  const base = Date.parse("2026-08-28T00:00:00.000Z");
  const records = Array.from({ length: 12_000 }, (_value, index) => {
    const userIndex = index % 2_000;
    const taskIndex = index % 3;
    return {
      id: `sub_${crypto.createHash("sha256").update(`record-${index}`).digest("hex").slice(0, 32)}`,
      submissionId: `sub_${crypto.createHash("sha256").update(`record-${index}`).digest("hex").slice(0, 32)}`,
      sessionId: `ses_${crypto.createHash("sha256").update(`session-${index}`).digest("hex").slice(0, 32)}`,
      runId: `run_${crypto.createHash("sha256").update(`run-${index}`).digest("hex").slice(0, 32)}`,
      ownerUserId: `usr_${crypto.createHash("sha256").update(`user-${userIndex}`).digest("hex").slice(0, 32)}`,
      teamId: `owner-${userIndex}`,
      taskId: `R2-GYI-MVP-0${taskIndex + 1}`,
      taskName: `任务${taskIndex + 1}`,
      score: index < 6_000 ? 90 : 10,
      scoreMaximum: 100,
      status: "verified",
      verification: {},
      recordState: "submitted",
      savedAt: new Date(base + index * 1_000).toISOString(),
      submittedAt: new Date(base + index * 1_000).toISOString(),
      receivedAt: new Date(base + index * 1_000).toISOString(),
      authoritative: false
    };
  });
  const winners = aggregateBestSubmittedRecords(records);
  assert.equal(winners.length, 6_000);
  assert.ok(winners.every(record => record.score === 90), "later low scores cannot replace historical winners");
  assert.ok(winners.every(record => Date.parse(record.latestSubmittedAt) > Date.parse(record.submittedAt)),
    "latest evaluation time advances independently from the best-score record");
});

test("best-score aggregation retains separate immutable team ownership across an SSO transfer", () => {
  const ownerUserId = `usr_${"5".repeat(32)}`;
  const base = {
    id: `sub_${"1".repeat(32)}`,
    submissionId: `sub_${"1".repeat(32)}`,
    ownerUserId,
    taskId: "R2-GYI-MVP-01",
    taskName: "任务1",
    scoreMaximum: 100,
    status: "verified",
    verification: {},
    recordState: "submitted",
    savedAt: "2026-08-28T00:00:00.000Z",
    submittedAt: "2026-08-28T00:00:00.000Z",
    receivedAt: "2026-08-28T00:00:00.000Z",
    authoritative: false
  };
  const winners = aggregateBestSubmittedRecords([
    { ...base, teamId: "team-before-transfer", score: 90 },
    {
      ...base,
      id: `sub_${"2".repeat(32)}`,
      submissionId: `sub_${"2".repeat(32)}`,
      teamId: "team-after-transfer",
      score: 70,
      savedAt: "2026-08-28T01:00:00.000Z",
      submittedAt: "2026-08-28T01:00:00.000Z",
      receivedAt: "2026-08-28T01:00:00.000Z"
    }
  ]);
  assert.equal(winners.length, 2);
  assert.deepEqual(new Map(winners.map(record => [record.teamId, record.score])), new Map([
    ["team-before-transfer", 90],
    ["team-after-transfer", 70]
  ]));
});

test("best-score aggregate rebuilds from durable archives and updates incrementally", async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-best-score-index-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const ownerUserId = `usr_${"6".repeat(32)}`;
  let now = Date.parse("2026-08-28T01:00:00.000Z");
  let store = new SubmissionStore({ rootDir, now: () => now, maxSessions: 1 });
  await store.ready;

  const submitScore = async (score, suffix) => {
    const created = await store.createSession("aggregate-team", LOCAL_CHALLENGES[TASK_ID], ownerUserId);
    const session = await store.readSession(created.session.sessionId);
    const report = {
      schemaVersion: "chenlong.verification-report/v1",
      status: "verified",
      recomputedResult: { score }
    };
    const reportBuffer = Buffer.from(`${JSON.stringify(report)}\n`);
    return store.saveSubmission(
      session,
      created.submitToken,
      Buffer.from(`${JSON.stringify({ suffix })}\n`),
      reportBuffer,
      report,
      metadataForStoredSession(session)
    );
  };

  const high = await submitScore(90, "high");
  now += 1_000;
  await submitScore(20, "later-low");
  let winners = await store.listBestSubmittedRecords();
  assert.equal(winners.length, 1);
  assert.equal(winners[0].score, 90);
  assert.equal(winners[0].submissionId, high.manifest.submissionId);
  assert.equal(winners[0].latestSubmittedAt, new Date(now).toISOString());

  store = new SubmissionStore({ rootDir, now: () => now, maxSessions: 1 });
  await store.ready;
  winners = await store.listBestSubmittedRecords();
  assert.equal(winners.length, 1);
  assert.equal(winners[0].score, 90, "restart rebuild reads every durable archive, not a recent-record window");

  now += 1_000;
  const newerHigh = await submitScore(95, "new-high");
  winners = await store.listBestSubmittedRecords();
  assert.equal(winners[0].score, 95);
  assert.equal(winners[0].submissionId, newerHigh.manifest.submissionId);
});

test("public challenge metadata uses an allowlist and never exposes the private run definition", () => {
  const privateChallenge = {
    taskId: TASK_ID,
    taskVersion: "task-v1",
    mapId: "map-v1",
    mapVersion: "map-version-v1",
    ruleVersion: "rule-v1",
    displayName: "公开名称",
    timeLimitSeconds: 600,
    sessionMode: "ai",
    runDefinition: {
      simulationDefinition: { seed: 123456 },
      interactionDefinition: { packages: [{ id: "hidden-target", x: 9, z: 8 }] }
    },
    hiddenSeed: 123456,
    futurePrivateField: { coordinates: [9, 8] }
  };
  assert.deepEqual(publicChallengeMetadata(privateChallenge), {
    taskId: TASK_ID,
    taskVersion: "task-v1",
    mapId: "map-v1",
    mapVersion: "map-version-v1",
    ruleVersion: "rule-v1",
    displayName: "公开名称",
    timeLimitSeconds: 600,
    sessionMode: "ai"
  });
  assert.doesNotMatch(JSON.stringify(publicChallengeMetadata(privateChallenge)), /runDefinition|hidden-target|123456|coordinates/);
});

test("record summaries expose only bounded verification scope metadata", () => {
  const reasonCodes = Array.from({ length: 20 }, (_value, index) => `reason_${index}`);
  const report = {
    status: "verified",
    reasonCodes: ["vision_detections_not_recomputed", "vision_detections_not_recomputed", ...reasonCodes, "X-invalid"],
    visionStatus: "not_recomputed",
    verificationScope: {
      deterministic: { status: "complete", domains: ["secret-domain"] },
      vision: "not_recomputed"
    },
    replay: { diagnostics: ["must-not-reach-list-responses"] },
    source: "C:\\private\\secret.json",
    secret: "must-not-reach-list-responses",
    recomputedResult: { score: 58.5 }
  };
  const projection = publicVerificationSummary(report);
  assert.deepEqual(Object.keys(projection).sort(), ["reasonCodes", "status", "verificationScope", "visionStatus"]);
  assert.equal(projection.status, "verified");
  assert.equal(projection.visionStatus, "not_recomputed");
  assert.equal(projection.verificationScope.deterministic.status, "complete");
  assert.equal(projection.verificationScope.vision, "not_recomputed");
  assert.equal(projection.reasonCodes.length, 12);
  assert.equal(new Set(projection.reasonCodes).size, projection.reasonCodes.length);
  assert.doesNotMatch(JSON.stringify(projection), /private|secret|diagnostics|domains/i);

  const summary = SubmissionStore.prototype.recordSummary.call({}, {
    sessionId: "ses_11111111111111111111111111111111",
    runId: "run_11111111111111111111111111111111",
    ownerUserId: "usr_11111111111111111111111111111111",
    teamId: "bounded-team",
    challenge: {
      taskId: "bounded-task",
      displayName: "有界摘要任务",
      runDefinition: {
        scoringDefinition: { weights: { task: 25, rules: 15, autonomous: 10, efficiency: 10 } }
      }
    }
  }, {
    submissionId: "sub_11111111111111111111111111111111",
    receivedAt: "2026-08-20T00:00:00.000Z",
    challengeDigest: "a".repeat(64),
    record: { sha256: "b".repeat(64), byteLength: 123 }
  }, report);
  assert.equal(summary.score, 97.5);
  assert.equal(summary.scoreMaximum, 100);
  assert.deepEqual(summary.verification, projection);
  assert.equal(summary.status, "verified");
  assert.doesNotMatch(JSON.stringify(summary), /must-not-reach|private|secret-domain/i);

  const legacy = publicVerificationSummary({
    status: "partial",
    reasonCodes: ["legacy_vehicle_replay_only"]
  });
  assert.equal(legacy.status, "partial");
  assert.equal(legacy.verificationScope.deterministic.status, "unknown");
  assert.equal(legacy.visionStatus, "unknown");
  assert.deepEqual(legacy.reasonCodes, ["legacy_vehicle_replay_only"]);
});

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
const authenticatedUserIdByOrigin = new Map();

function authenticatedHeaders(origin, method, headers) {
  const cookie = authenticationByOrigin.get(origin);
  return {
    ...(cookie ? { Cookie: cookie } : {}),
    ...(cookie && !["GET", "HEAD", "OPTIONS"].includes(method) ? { Origin: origin } : {}),
    ...headers
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
      headers: { Connection: "close", ...authenticatedHeaders(origin, method, headers) }
    }, response => collectResponse(response, resolve, reject));
    clientRequest.once("error", reject);
    clientRequest.end(body);
  });
}

function parseJson(response) {
  assert.match(response.headers["content-type"] || "", /^application\/json\b/i);
  return JSON.parse(response.body.toString("utf8"));
}

function jsonRequest(origin, { method = "POST", requestPath, value, token, headers = {} }) {
  const body = Buffer.from(JSON.stringify(value));
  return request(origin, {
    method,
    requestPath,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body
  });
}

function authenticatedRequest(origin, { method = "GET", requestPath, token, body, headers = {} }) {
  return request(origin, {
    method,
    requestPath,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body
  });
}

async function temporaryDataDir(t) {
  const prefix = path.join(os.tmpdir(), "chenlong-submission-store-");
  const dataDir = await fs.promises.mkdtemp(prefix);
  t.after(async () => {
    const resolved = path.resolve(dataDir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.match(path.basename(resolved), /^chenlong-submission-store-/);
    await fs.promises.rm(resolved, { recursive: true, force: true });
  });
  return dataDir;
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

async function close(server) {
  const address = server.address();
  if (address && typeof address === "object") {
    authenticationByOrigin.delete(`http://127.0.0.1:${address.port}`);
    authenticatedUserIdByOrigin.delete(`http://127.0.0.1:${address.port}`);
  }
  server.closeAllConnections?.();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}

async function authenticateTestOrigin(origin, username = `submission-${new URL(origin).port}`) {
  async function register(registrationUsername) {
    const body = Buffer.from(JSON.stringify({
      username: registrationUsername,
      password: "Submission-Test-Password-2026!",
      teamName: registrationUsername,
      group: "primary"
    }));
    const response = await request(origin, {
      method: "POST",
      requestPath: "/api/v1/auth/register",
      headers: {
        Origin: origin,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length
      },
      body
    });
    assert.equal(response.statusCode, 201, response.body.toString("utf8"));
    const setCookie = Array.isArray(response.headers["set-cookie"])
      ? response.headers["set-cookie"][0]
      : response.headers["set-cookie"];
    assert.match(setCookie || "", /^chenlong_session=/);
    return {
      cookie: setCookie.split(";", 1)[0],
      userId: parseJson(response).user.id
    };
  }

  await register(`${username}-bootstrap`);
  const authenticated = await register(username);
  authenticationByOrigin.set(origin, authenticated.cookie);
  authenticatedUserIdByOrigin.set(origin, authenticated.userId);
  return authenticated.cookie;
}

async function startServer(t, options) {
  const server = createServer(options);
  const origin = await listen(server);
  await authenticateTestOrigin(origin);
  t.after(() => close(server));
  return { server, origin };
}

function assertApiError(response, statusCode, code) {
  assert.equal(response.statusCode, statusCode, response.body.toString("utf8"));
  const payload = parseJson(response);
  assert.equal(payload.status, "error");
  assert.equal(payload.authoritative, false);
  assert.equal(payload.error.code, code);
  assert.equal(typeof payload.error.message, "string");
  assert.ok(payload.error.message.length > 0);
  return payload;
}

function sessionFields(payload) {
  const session = payload.session || payload;
  return {
    id: session.sessionId || session.id || payload.sessionId,
    teamId: session.teamId || payload.teamId,
    taskId: session.challenge?.taskId || session.taskId || payload.taskId,
    runId: session.runId || payload.runId,
    challenge: session.challenge || payload.challenge,
    // Single-session responses deliberately keep the frozen definition outside
    // public challenge metadata.  Preserve it for record construction so these
    // tests replay the exact server-issued map, rather than a local fallback.
    runDefinition: payload.runDefinition || session.runDefinition,
    challengeDigest: session.challengeDigest || payload.challengeDigest,
    status: session.status || payload.status,
    submitToken: payload.submitToken
  };
}

function submissionFields(payload) {
  const submission = payload.submission || payload.receipt || payload;
  return {
    id: submission.submissionId || submission.id || payload.submissionId,
    sessionId: submission.sessionId || payload.sessionId,
    sha256: submission.record?.sha256 || submission.sha256 || payload.record?.sha256 || payload.sha256,
    duplicate: payload.duplicate ?? submission.duplicate,
    report: submission.verification || payload.verification,
    reportDescriptor: submission.report || payload.report,
    status: submission.status || payload.status
  };
}

async function createSession(origin, { teamId = "team-submission-test", taskId = TASK_ID } = {}) {
  const response = await jsonRequest(origin, {
    requestPath: "/api/v1/sessions",
    value: { taskId }
  });
  assert.equal(response.statusCode, 201, response.body.toString("utf8"));
  const payload = parseJson(response);
  assert.equal((payload.session || payload).schemaVersion, SESSION_SCHEMA_VERSION);
  assert.equal(payload.authoritative, false);
  const session = sessionFields(payload);
  assert.match(session.id, /^ses_[a-f0-9]{32}$/);
  assert.match(session.runId, /^run_[a-f0-9]{32}$/);
  assert.match(session.challengeDigest, /^[a-f0-9]{64}$/);
  assert.match(session.submitToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(session.teamId, /^tea_[a-f0-9]{32}$/,
    "normal sessions must bind to the authenticated team's immutable identity");
  assert.equal(session.taskId, taskId);
  assert.equal(Object.prototype.hasOwnProperty.call(session.challenge, "runDefinition"), false);
  assert.doesNotMatch(JSON.stringify(session.challenge), /simulationDefinition|interactionDefinition|guangyang-target-1/);
  return { response, payload, ...session };
}

function recordForSession(session, overrides = {}) {
  const runDefinition = session.runDefinition || LOCAL_CHALLENGES[session.taskId].runDefinition;
  const frozenChallenge = {
    ...session.challenge,
    task: runDefinition.taskDefinition,
    rules: runDefinition.ruleDefinition,
    scoring: runDefinition.scoringDefinition
  };
  const competitionSession = createCompetitionSession(frozenChallenge, {
    teamId: session.teamId,
    runId: session.runId,
    serverSessionId: session.id,
    challengeDigest: session.challengeDigest,
    runDefinition,
    simulationDefinition: runDefinition.simulationDefinition,
    interactionDefinition: runDefinition.interactionDefinition,
    sourceCode: "car.stop()"
  }, { now: () => 0 });
  const pose = runDefinition.simulationDefinition.initialPose;
  competitionSession.sample({
    tick: 0,
    x: pose.x,
    z: pose.z,
    heading: pose.heading,
    speed: 0,
    steering: 0
  }, { forceRecord: true });
  return {
    ...competitionSession.finish("program_finished"),
    ...overrides
  };
}

function recordMetadataConflicts(matching) {
  return [
    {
      field: "schemaVersion",
      record: { ...matching, schemaVersion: "chenlong.run-record/v3" }
    },
    { field: "teamId", record: { ...matching, teamId: "another-team" } },
    { field: "taskId", record: { ...matching, taskId: "another-task" } },
    { field: "runId", record: { ...matching, runId: "another-run" } },
    {
      field: "serverSessionId",
      record: { ...matching, serverSessionId: "ses_00000000000000000000000000000000" }
    },
    { field: "challengeDigest", record: { ...matching, challengeDigest: "0".repeat(64) } },
    { field: "mapId", record: { ...matching, mapId: "another-map" } },
    { field: "mapVersion", record: { ...matching, mapVersion: "another-map-version" } },
    { field: "ruleVersion", record: { ...matching, ruleVersion: "another-rule-version" } },
    {
      field: "runDefinitionDigest",
      record: {
        ...matching,
        runDefinition: {
          ...matching.runDefinition,
          timeLimitTicks: matching.runDefinition.timeLimitTicks + 1
        }
      }
    }
  ];
}

function assertSessionRecordBinding(record, session) {
  assert.equal(record.schemaVersion, SCHEMA_VERSION);
  assert.equal(record.serverSessionId, session.id);
  assert.equal(record.runId, session.runId);
  assert.equal(record.challengeDigest, session.challengeDigest);
  assert.equal(record.teamId, session.teamId);
  assert.equal(record.taskId, session.taskId);
  assert.equal(record.mapId, session.challenge.mapId);
  assert.equal(record.mapVersion, session.challenge.mapVersion);
  assert.equal(record.ruleVersion, session.challenge.ruleVersion);
  assert.equal(
    canonicalSha256(record.runDefinition),
    canonicalSha256(session.runDefinition || LOCAL_CHALLENGES[session.taskId].runDefinition)
  );
  return record;
}

function rawRecordForSession(session, overrides = {}) {
  return assertSessionRecordBinding(recordForSession(session, overrides), session);
}

function metadataForStoredSession(session) {
  return {
    schemaVersion: "chenlong.run-record/v4",
    serverSessionId: session.sessionId,
    runId: session.runId,
    challengeDigest: session.challengeDigest,
    runDefinitionDigest: canonicalSha256(session.challenge.runDefinition),
    teamId: session.teamId,
    taskId: session.challenge.taskId,
    mapId: session.challenge.mapId,
    mapVersion: session.challenge.mapVersion,
    ruleVersion: session.challenge.ruleVersion
  };
}

function submissionBody(record) {
  return Buffer.from(JSON.stringify(record));
}

async function submitRecord(origin, session, record) {
  const body = submissionBody(record);
  const response = await authenticatedRequest(origin, {
    method: "POST",
    requestPath: `/api/v1/sessions/${encodeURIComponent(session.id)}/submissions`,
    token: session.submitToken,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length
    },
    body
  });
  return { response, body };
}

async function listFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else result.push(absolutePath);
    }
  }
  await visit(root);
  return result;
}

async function listEntries(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      result.push(absolutePath);
      if (entry.isDirectory()) await visit(absolutePath);
    }
  }
  await visit(root);
  return result;
}

async function findArchiveJsonFile(dataDir, filename, predicate) {
  const matches = [];
  for (const filePath of await listFiles(dataDir)) {
    if (path.basename(filePath) !== filename) continue;
    let value;
    try {
      value = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    } catch (_error) {
      continue;
    }
    if (predicate(value)) matches.push({ filePath, value });
  }
  assert.equal(matches.length, 1, `expected one matching ${filename}, found ${matches.length}`);
  return matches[0];
}

async function locateSessionArchive(dataDir, sessionId) {
  return findArchiveJsonFile(dataDir, "session.json", value => value?.sessionId === sessionId);
}

async function locateSubmissionArchive(dataDir, submissionId) {
  const manifest = await findArchiveJsonFile(
    dataDir,
    "manifest.json",
    value => value?.submissionId === submissionId
  );
  const submissionDirectory = path.dirname(manifest.filePath);
  const files = await listFiles(dataDir);
  function sibling(filename) {
    const matches = files.filter(filePath => (
      path.dirname(filePath) === submissionDirectory && path.basename(filePath) === filename
    ));
    assert.equal(matches.length, 1, `expected one ${filename} beside the selected manifest`);
    return matches[0];
  }
  return {
    manifestPath: manifest.filePath,
    manifest: manifest.value,
    recordPath: sibling("record.json"),
    reportPath: sibling("report.json")
  };
}

async function overwriteJson(filePath, mutate) {
  const current = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  const updated = mutate(current) || current;
  await fs.promises.writeFile(filePath, `${JSON.stringify(updated, null, 2)}\n`);
}

function differentDigest(digest) {
  assert.match(digest, /^[a-f0-9]{64}$/);
  return `${digest[0] === "0" ? "1" : "0"}${digest.slice(1)}`;
}

async function archivedSubmission(t) {
  const dataDir = await temporaryDataDir(t);
  const { origin } = await startServer(t, { dataDir });
  const session = await createSession(origin);
  const submitted = await submitRecord(origin, session, rawRecordForSession(session));
  assert.equal(submitted.response.statusCode, 201, submitted.response.body.toString("utf8"));
  const receipt = submissionFields(parseJson(submitted.response));
  const archive = await locateSubmissionArchive(dataDir, receipt.id);
  return { dataDir, origin, session, receipt, archive };
}

test("creates a non-authoritative session and never returns its submit token again", async t => {
  const dataDir = await temporaryDataDir(t);
  const { origin } = await startServer(t, { dataDir });
  const created = await createSession(origin);
  const second = await createSession(origin);
  assert.ok(created.runId);
  assert.notEqual(created.challengeDigest, second.challengeDigest,
    "two sessions for the same definition must use different public commitments");

  const fetchedResponse = await authenticatedRequest(origin, {
    requestPath: `/api/v1/sessions/${encodeURIComponent(created.id)}`,
    token: created.submitToken
  });
  assert.equal(fetchedResponse.statusCode, 200, fetchedResponse.body.toString("utf8"));
  const fetchedPayload = parseJson(fetchedResponse);
  assert.equal(fetchedPayload.authoritative, false);
  assert.equal(sessionFields(fetchedPayload).id, created.id);
  assert.equal(JSON.stringify(fetchedPayload).includes(created.submitToken), false);
  assert.doesNotMatch(JSON.stringify(fetchedPayload), /challengeCommitment|nonce|runDefinitionDigest/);

  const archived = await locateSessionArchive(dataDir, created.id);
  assert.equal(archived.value.challengeCommitment.schemaVersion, CHALLENGE_COMMITMENT_SCHEMA_VERSION);
  assert.match(archived.value.challengeCommitment.nonce, /^[a-f0-9]{64}$/);
  assert.equal(
    archived.value.challengeCommitment.runDefinitionDigest,
    canonicalSha256(archived.value.challenge.runDefinition)
  );
  assert.equal(created.challengeDigest, canonicalSha256(archived.value.challengeCommitment));
  assert.notEqual(created.challengeDigest, archived.value.challengeCommitment.runDefinitionDigest);

  const persistedText = (await Promise.all((await listFiles(dataDir)).map(file => fs.promises.readFile(file, "utf8")))).join("\n");
  assert.equal(persistedText.includes(created.submitToken), false, "the bearer token must only be stored as a digest");
});

test("requires the session bearer token and distinguishes missing from incorrect credentials", async t => {
  const dataDir = await temporaryDataDir(t);
  const { origin } = await startServer(t, { dataDir });
  const session = await createSession(origin);
  const sessionPath = `/api/v1/sessions/${encodeURIComponent(session.id)}`;

  const missingResponse = await request(origin, { requestPath: sessionPath });
  const missing = assertApiError(missingResponse, 401, "AUTHENTICATION_REQUIRED");
  assert.match(missing.error.message, /bearer token/i);
  assert.match(missingResponse.headers["www-authenticate"] || "", /^Bearer\b/i);
  assertApiError(await request(origin, {
    requestPath: sessionPath,
    headers: { Authorization: "Basic not-a-bearer-token" }
  }), 401, "AUTHENTICATION_REQUIRED");
  assertApiError(await request(origin, {
    requestPath: sessionPath,
    headers: { Authorization: `Bearer ${"x".repeat(43)}` }
  }), 403, "INVALID_SESSION_TOKEN");

  const raw = rawRecordForSession(session);
  const missingSubmit = await submitRecord(origin, { ...session, submitToken: "" }, raw);
  assertApiError(missingSubmit.response, 401, "AUTHENTICATION_REQUIRED");
  const wrongSubmit = await submitRecord(origin, { ...session, submitToken: "y".repeat(43) }, raw);
  assertApiError(wrongSubmit.response, 403, "INVALID_SESSION_TOKEN");
});

test("stores one exact raw-v4 record per single session and keeps byte-identical retries idempotent", async t => {
  const dataDir = await temporaryDataDir(t);
  const { origin } = await startServer(t, { dataDir });
  const session = await createSession(origin);
  const record = rawRecordForSession(session);
  const first = await submitRecord(origin, session, record);
  assert.equal(first.response.statusCode, 201, first.response.body.toString("utf8"));
  const firstPayload = parseJson(first.response);
  assert.equal(firstPayload.schemaVersion, RECEIPT_SCHEMA_VERSION);
  assert.equal(firstPayload.authoritative, false);
  const receipt = submissionFields(firstPayload);
  assert.match(receipt.id, /^sub_[a-f0-9]{32}$/);
  assert.equal(receipt.sessionId, session.id);
  assert.equal(receipt.sha256, crypto.createHash("sha256").update(first.body).digest("hex"));
  assert.equal(receipt.duplicate, false);
  assert.equal(receipt.report.status, "verified");
  assert.equal(receipt.report.authoritative, false);
  assert.equal(receipt.reportDescriptor.status, "verified");
  assert.match(receipt.reportDescriptor.sha256, /^[a-f0-9]{64}$/);

  const archived = await locateSubmissionArchive(dataDir, receipt.id);
  assert.equal(archived.manifest.challengeDigest, session.challengeDigest);
  assert.equal(archived.manifest.run.challengeDigest, session.challengeDigest);
  assert.equal(
    archived.manifest.run.runDefinitionDigest,
    canonicalSha256(session.runDefinition || LOCAL_CHALLENGES[session.taskId].runDefinition)
  );
  assert.notEqual(archived.manifest.run.runDefinitionDigest, archived.manifest.challengeDigest,
    "new archives must keep the public commitment separate from the private definition digest");

  const retried = await submitRecord(origin, session, record);
  assert.equal(retried.response.statusCode, 200, retried.response.body.toString("utf8"));
  const duplicate = submissionFields(parseJson(retried.response));
  assert.equal(duplicate.id, receipt.id);
  assert.equal(duplicate.sha256, receipt.sha256);
  assert.equal(duplicate.duplicate, true);

  const differentlyFormattedBody = Buffer.from(JSON.stringify(record, null, 2));
  const differentlyFormatted = await authenticatedRequest(origin, {
    method: "POST",
    requestPath: `/api/v1/sessions/${encodeURIComponent(session.id)}/submissions`,
    token: session.submitToken,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": differentlyFormattedBody.length
    },
    body: differentlyFormattedBody
  });
  assertApiError(differentlyFormatted, 409, "SINGLE_SESSION_RECORD_EXISTS");

  const concurrentSession = await createSession(origin, { teamId: "concurrent-single-team" });
  const concurrentRecord = rawRecordForSession(concurrentSession, {
    sourceCode: "car.stop()\n# concurrent retry"
  });
  const concurrent = await Promise.all([
    submitRecord(origin, concurrentSession, concurrentRecord),
    submitRecord(origin, concurrentSession, concurrentRecord)
  ]);
  assert.deepEqual(concurrent.map(item => item.response.statusCode).sort(), [200, 201]);
  const concurrentReceipts = concurrent.map(item => submissionFields(parseJson(item.response)));
  assert.equal(concurrentReceipts[0].id, concurrentReceipts[1].id);
  assert.equal(concurrentReceipts[0].sha256, concurrentReceipts[1].sha256);
  assert.deepEqual(concurrentReceipts.map(item => item.duplicate).sort(), [false, true]);

  const fetched = await authenticatedRequest(origin, {
    requestPath: `/api/v1/sessions/${encodeURIComponent(session.id)}/submissions/${encodeURIComponent(receipt.id)}`,
    token: session.submitToken
  });
  assert.equal(fetched.statusCode, 200, fetched.body.toString("utf8"));
  const fetchedReceipt = submissionFields(parseJson(fetched));
  assert.equal(fetchedReceipt.id, receipt.id);
  assert.equal(fetchedReceipt.sha256, receipt.sha256);
  assert.equal(fetchedReceipt.report.status, "verified");
});

test("auto-saved record drafts stay unsubmitted until their owner explicitly submits them", async t => {
  const dataDir = await temporaryDataDir(t);
  const { origin, server } = await startServer(t, { dataDir });
  const session = await createSession(origin, { teamId: "draft-flow-team" });
  const record = rawRecordForSession(session, {
    sourceCode: `car.stop()\n# ${"x".repeat(2 * 1024 * 1024)}`
  });
  const body = submissionBody(record);
  const compressedBody = gzipSync(body);
  assert.ok(compressedBody.length < 1024 * 1024,
    "the representative multi-megabyte draft must fit through a common 1 MiB proxy after gzip");
  const draftPath = `/api/v1/sessions/${encodeURIComponent(session.id)}/drafts`;

  const saved = await authenticatedRequest(origin, {
    method: "POST",
    requestPath: draftPath,
    token: session.submitToken,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Encoding": "gzip",
      "Content-Length": compressedBody.length
    },
    body: compressedBody
  });
  assert.equal(saved.statusCode, 201, saved.body.toString("utf8"));
  const savedPayload = parseJson(saved);
  assert.equal(savedPayload.schemaVersion, "chenlong.record-draft-receipt/v1");
  assert.equal(savedPayload.recordState, "saved");
  assert.equal(savedPayload.duplicate, false);
  assert.match(savedPayload.recordId, /^sub_[a-f0-9]{32}$/);

  const duplicateDraft = await authenticatedRequest(origin, {
    method: "POST",
    requestPath: draftPath,
    token: session.submitToken,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length
    },
    body
  });
  assert.equal(duplicateDraft.statusCode, 200, duplicateDraft.body.toString("utf8"));
  assert.equal(parseJson(duplicateDraft).duplicate, true);

  const sessionBeforeSubmit = await authenticatedRequest(origin, {
    requestPath: `/api/v1/sessions/${encodeURIComponent(session.id)}`,
    token: session.submitToken
  });
  assert.equal(parseJson(sessionBeforeSubmit).submissionCount, 0,
    "saving a draft must not create a formal submission");

  const beforeSubmit = await authenticatedRequest(origin, { requestPath: "/api/v1/records" });
  assert.equal(beforeSubmit.statusCode, 200, beforeSubmit.body.toString("utf8"));
  const savedRecord = parseJson(beforeSubmit).records.find(item => item.id === savedPayload.recordId);
  assert.equal(savedRecord.recordState, "saved");
  assert.equal(savedRecord.status, "pending");
  assert.equal(savedRecord.submissionId, null);
  assert.equal(savedRecord.submittedAt, null);
  assert.match(savedRecord.savedAt, /^\d{4}-\d{2}-\d{2}T/);

  const submitPath = `/api/v1/records/${encodeURIComponent(savedPayload.recordId)}/submit`;
  const concurrentSubmissions = await Promise.all([
    jsonRequest(origin, { requestPath: submitPath, value: {} }),
    jsonRequest(origin, { requestPath: submitPath, value: {} })
  ]);
  assert.deepEqual(concurrentSubmissions.map(response => response.statusCode).sort(), [200, 201]);
  const concurrentPayloads = concurrentSubmissions.map(parseJson);
  assert.equal(new Set(concurrentPayloads.map(payload => payload.recordId)).size, 1);
  assert.equal(new Set(concurrentPayloads.map(payload => payload.submittedAt)).size, 1);
  assert.deepEqual(concurrentPayloads.map(payload => payload.duplicate).sort(), [false, true]);
  const submittedPayload = concurrentPayloads.find(payload => payload.duplicate === false);
  assert.equal(submittedPayload.schemaVersion, "chenlong.record-submit-receipt/v1");
  assert.equal(submittedPayload.recordId, savedPayload.recordId);
  assert.equal(submittedPayload.recordState, "submitted");
  assert.equal(submittedPayload.verification.status, "verified");

  const retried = await jsonRequest(origin, { requestPath: submitPath, value: {} });
  assert.equal(retried.statusCode, 200, retried.body.toString("utf8"));
  const retriedPayload = parseJson(retried);
  assert.equal(retriedPayload.recordId, submittedPayload.recordId);
  assert.equal(retriedPayload.submissionId, submittedPayload.submissionId);
  assert.equal(retriedPayload.submittedAt, submittedPayload.submittedAt);
  assert.equal(retriedPayload.duplicate, true);

  const afterSubmit = await authenticatedRequest(origin, { requestPath: "/api/v1/records" });
  const records = parseJson(afterSubmit).records.filter(item => item.id === savedPayload.recordId);
  assert.equal(records.length, 1, "a submitted draft must not appear twice");
  assert.equal(records[0].recordState, "submitted");
  assert.equal(records[0].status, "verified");
  assert.equal(records[0].submissionId, savedPayload.recordId);
  assert.equal(records[0].savedAt, savedPayload.savedAt);
  assert.equal(records[0].submittedAt, submittedPayload.submittedAt);

  const sessionDirectory = path.join(dataDir, "sessions", session.id);
  const retainedFiles = await listFiles(sessionDirectory);
  const retainedRunRecords = retainedFiles.filter(filePath => path.basename(filePath) === "record.json");
  assert.equal(retainedRunRecords.length, 1,
    "formal submission must reclaim the large draft record instead of retaining two copies");
  await assert.rejects(
    fs.promises.lstat(path.join(sessionDirectory, "drafts", savedPayload.recordId)),
    error => error?.code === "ENOENT"
  );
  const exactArchiveBytes = (await Promise.all(retainedFiles.map(async filePath => (
    await fs.promises.lstat(filePath)
  ).size))).reduce((sum, size) => sum + size, 0);
  assert.equal(server.submissionStore.usedBytes, exactArchiveBytes,
    "draft reclamation must update the exact persistent storage accounting");
});

test("personal record APIs expose only single scope while legacy scope-less singles remain visible", async t => {
  const dataDir = await temporaryDataDir(t);
  const { origin, server } = await startServer(t, { dataDir });
  const meResponse = await authenticatedRequest(origin, { requestPath: "/api/v1/auth/me" });
  assert.equal(meResponse.statusCode, 200, meResponse.body.toString("utf8"));
  const ownerUserId = parseJson(meResponse).user.id;

  const legacySession = await createSession(origin, { teamId: "legacy-single-team" });
  const scopePath = path.join(dataDir, "sessions", legacySession.id, "scope.json");
  await fs.promises.unlink(scopePath);
  const legacyRecord = rawRecordForSession(legacySession);
  const legacyBody = submissionBody(legacyRecord);
  const legacySaved = await authenticatedRequest(origin, {
    method: "POST",
    requestPath: `/api/v1/sessions/${encodeURIComponent(legacySession.id)}/drafts`,
    token: legacySession.submitToken,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": legacyBody.length
    },
    body: legacyBody
  });
  assert.equal(legacySaved.statusCode, 201, legacySaved.body.toString("utf8"));
  const legacyRecordId = parseJson(legacySaved).recordId;

  const report = { schemaVersion: "chenlong.verification-report/v1", status: "verified" };
  const reportBuffer = Buffer.from(`${JSON.stringify(report)}\n`);
  const scopedSubmissionIds = [];
  const scopedCases = [
    {
      teamId: "private-practice-team",
      scope: { scope: "practice", batchId: `bat_${"3".repeat(32)}`, slotIndex: 1 }
    },
    {
      teamId: "private-ranked-team",
      scope: {
        scope: "ranked",
        batchId: `bat_${"4".repeat(32)}`,
        slotIndex: 1,
        competitionId: "scope-filter-test.1"
      }
    }
  ];
  for (const scopedCase of scopedCases) {
    const created = await server.submissionStore.createSession(
      scopedCase.teamId,
      LOCAL_CHALLENGES[TASK_ID],
      ownerUserId,
      scopedCase.scope
    );
    const session = await server.submissionStore.readSession(created.session.sessionId);
    const metadata = metadataForStoredSession(session);
    const recordBuffer = Buffer.from(`${JSON.stringify({ scope: scopedCase.scope.scope, runId: session.runId })}\n`);
    const options = scopedCase.scope.scope === "ranked"
      ? { ...scopedCase.scope, notAfter: new Date(Date.now() + 60_000).toISOString() }
      : scopedCase.scope;
    const stored = await server.submissionStore.saveVerifiedBatchSubmission(
      session.sessionId,
      ownerUserId,
      recordBuffer,
      reportBuffer,
      report,
      metadata,
      options
    );
    scopedSubmissionIds.push(stored.manifest.submissionId);
  }

  const personal = await authenticatedRequest(origin, { requestPath: "/api/v1/records" });
  assert.equal(personal.statusCode, 200, personal.body.toString("utf8"));
  assert.deepEqual(parseJson(personal).records.map(record => record.id), [legacyRecordId]);

  for (const recordId of scopedSubmissionIds) {
    const detail = await authenticatedRequest(origin, {
      requestPath: `/api/v1/records/${encodeURIComponent(recordId)}`
    });
    assertApiError(detail, 404, "RECORD_NOT_FOUND");
    const raw = await authenticatedRequest(origin, {
      requestPath: `/api/v1/records/${encodeURIComponent(recordId)}/run-record`
    });
    assertApiError(raw, 404, "RECORD_NOT_FOUND");
    const submit = await jsonRequest(origin, {
      requestPath: `/api/v1/records/${encodeURIComponent(recordId)}/submit`,
      value: {}
    });
    assertApiError(submit, 404, "RECORD_NOT_FOUND");
  }

  const administratorView = await server.submissionStore.listRecords({ includeAll: true });
  assert.equal(administratorView.length, 3,
    "the administrator archive view intentionally retains all scopes");
  const submittedAcrossAllScopes = await server.submissionStore.listRecords({
    includeAll: true,
    recordState: "submitted"
  });
  assert.deepEqual(
    new Set(submittedAcrossAllScopes.map(record => record.id)),
    new Set(scopedSubmissionIds),
    "the submitted-state filter must omit ordinary saved drafts"
  );
  const submittedSingleView = await server.submissionStore.listRecords({
    includeAll: true,
    expectedScope: "single",
    recordState: "submitted"
  });
  assert.deepEqual(submittedSingleView, [],
    "the administrator formal-single view must omit drafts plus practice/ranked submissions");
  const savedSingleView = await server.submissionStore.listRecords({
    includeAll: true,
    expectedScope: "single",
    recordState: "saved"
  });
  assert.deepEqual(savedSingleView.map(record => record.id), [legacyRecordId]);
  await assert.rejects(
    () => server.submissionStore.listRecords({ includeAll: true, recordState: "unknown" }),
    error => error instanceof TypeError && /recordState/.test(error.message)
  );
  const personalStoreView = await server.submissionStore.listRecords({
    ownerUserId,
    expectedScope: "single"
  });
  assert.deepEqual(personalStoreView.map(record => record.id), [legacyRecordId]);
});

test("damaged scope metadata never falls back to legacy single-record visibility", async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-record-scope-corruption-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const ownerUserId = `usr_${"5".repeat(32)}`;
  const store = new SubmissionStore({ rootDir });
  await store.ready;
  const created = await store.createSession(
    "corrupt-scope-team",
    LOCAL_CHALLENGES[TASK_ID],
    ownerUserId
  );
  const session = await store.readSession(created.session.sessionId);
  const metadata = metadataForStoredSession(session);
  const recordBuffer = Buffer.from(`${JSON.stringify({ runId: session.runId })}\n`);
  const saved = await store.saveDraft(session, created.submitToken, recordBuffer, metadata, { score: 1 });
  await fs.promises.writeFile(store.sessionScopePath(session.sessionId), "{}\n");

  await assert.rejects(
    () => store.listRecords({ ownerUserId, expectedScope: "single" }),
    error => error instanceof SubmissionStoreError
      && error.statusCode === 500
      && error.code === "ARCHIVE_CORRUPTED"
  );
  await assert.rejects(
    () => store.findRecord(saved.manifest.recordId, { ownerUserId, expectedScope: "single" }),
    error => error instanceof SubmissionStoreError
      && error.statusCode === 500
      && error.code === "ARCHIVE_CORRUPTED"
  );
});

test("rejects records whose team, task, or run metadata does not match the session", async t => {
  const dataDir = await temporaryDataDir(t);
  const { origin } = await startServer(t, { dataDir });
  const session = await createSession(origin);
  const matching = rawRecordForSession(session);
  const conflicts = recordMetadataConflicts(matching);
  for (const { field, record } of conflicts) {
    const { response } = await submitRecord(origin, session, record);
    const error = assertApiError(response, 409, "SESSION_RECORD_MISMATCH");
    assert.match(error.error.message, new RegExp(`\\b${field}\\b`));
  }
  const afterConflicts = await authenticatedRequest(origin, {
    requestPath: `/api/v1/sessions/${encodeURIComponent(session.id)}`,
    token: session.submitToken
  });
  assert.equal(afterConflicts.statusCode, 200, afterConflicts.body.toString("utf8"));
  assert.equal(parseJson(afterConflicts).submissionCount, 0, "conflicting records must never consume a submission slot");
});

test("restores sessions, token digests, and submissions after reopening the same data directory", async t => {
  const dataDir = await temporaryDataDir(t);
  const firstServer = createServer({ dataDir });
  const firstOrigin = await listen(firstServer);
  const firstAuthCookie = await authenticateTestOrigin(firstOrigin, "restart-admin");
  const session = await createSession(firstOrigin);
  const record = rawRecordForSession(session);
  const submitted = await submitRecord(firstOrigin, session, record);
  assert.equal(submitted.response.statusCode, 201, submitted.response.body.toString("utf8"));
  const receipt = submissionFields(parseJson(submitted.response));
  await close(firstServer);

  const secondServer = createServer({ dataDir });
  const secondOrigin = await listen(secondServer);
  authenticationByOrigin.set(secondOrigin, firstAuthCookie);
  t.after(() => close(secondServer));
  const fetchedSession = await authenticatedRequest(secondOrigin, {
    requestPath: `/api/v1/sessions/${encodeURIComponent(session.id)}`,
    token: session.submitToken
  });
  assert.equal(fetchedSession.statusCode, 200, fetchedSession.body.toString("utf8"));
  assert.equal(sessionFields(parseJson(fetchedSession)).id, session.id);

  const fetchedSubmission = await authenticatedRequest(secondOrigin, {
    requestPath: `/api/v1/sessions/${encodeURIComponent(session.id)}/submissions/${encodeURIComponent(receipt.id)}`,
    token: session.submitToken
  });
  assert.equal(fetchedSubmission.statusCode, 200, fetchedSubmission.body.toString("utf8"));
  assert.equal(submissionFields(parseJson(fetchedSubmission)).sha256, receipt.sha256);

  const duplicate = await submitRecord(secondOrigin, session, record);
  assert.equal(duplicate.response.statusCode, 200, duplicate.response.body.toString("utf8"));
  assert.equal(submissionFields(parseJson(duplicate.response)).duplicate, true);
});

test("uses committed atomic files and cannot expose store contents through static hosting", async t => {
  const dataDir = await temporaryDataDir(t);
  const { origin } = await startServer(t, { dataDir });
  const session = await createSession(origin);
  const record = rawRecordForSession(session);
  const submitted = await submitRecord(origin, session, record);
  assert.equal(submitted.response.statusCode, 201, submitted.response.body.toString("utf8"));

  const files = await listFiles(dataDir);
  const entries = await listEntries(dataDir);
  assert.ok(files.length > 0);
  const writerLockPath = path.join(dataDir, DATA_DIRECTORY_WRITER_LOCK_FILENAME);
  assert.equal(files.includes(writerLockPath), true);
  assert.equal(entries.some(file => file !== writerLockPath && /(?:\.tmp|\.partial|\.lock)$/i.test(file)), false);
  for (const file of files) {
    const relative = path.relative(dataDir, file).split(path.sep).map(encodeURIComponent).join("/");
    const leaked = await request(origin, { requestPath: `/${encodeURIComponent(path.basename(dataDir))}/${relative}` });
    assert.ok([400, 404].includes(leaked.statusCode), `${relative} returned ${leaked.statusCode}`);
    assert.equal(leaked.body.includes(submitted.body), false);
  }
});

test("enforces session expiry, active-session ceilings, and the one-record single-session boundary", async t => {
  const expiryDir = await temporaryDataDir(t);
  let now = Date.parse("2026-08-19T00:00:00.000Z");
  const expiring = await startServer(t, {
    dataDir: expiryDir,
    sessionTtlMs: 1000,
    batchTtlMs: 1000,
    now: () => now
  });
  const expiredSession = await createSession(expiring.origin, { teamId: "expiring-team" });
  now += 1000;
  const archived = await authenticatedRequest(expiring.origin, {
    requestPath: `/api/v1/sessions/${encodeURIComponent(expiredSession.id)}`,
    token: expiredSession.submitToken
  });
  assert.equal(archived.statusCode, 200, archived.body.toString("utf8"));
  const expiredSubmission = await submitRecord(expiring.origin, expiredSession, rawRecordForSession(expiredSession));
  assertApiError(expiredSubmission.response, 410, "SESSION_EXPIRED");

  const sessionLimitDir = await temporaryDataDir(t);
  const limitedSessions = await startServer(t, { dataDir: sessionLimitDir, maxSessions: 1 });
  await createSession(limitedSessions.origin, { teamId: "first-team" });
  const secondSession = await jsonRequest(limitedSessions.origin, {
    requestPath: "/api/v1/sessions",
    value: { taskId: TASK_ID }
  });
  assertApiError(secondSession, 429, "SESSION_LIMIT_REACHED");

  const submissionLimitDir = await temporaryDataDir(t);
  const limitedSubmissions = await startServer(t, {
    dataDir: submissionLimitDir,
    maxSubmissionsPerSession: 1
  });
  const limitedSession = await createSession(limitedSubmissions.origin, { teamId: "limited-team" });
  const baseRecord = rawRecordForSession(limitedSession);
  const first = await submitRecord(limitedSubmissions.origin, limitedSession, baseRecord);
  assert.equal(first.response.statusCode, 201, first.response.body.toString("utf8"));
  const uniqueRecord = { ...baseRecord, sourceCode: "car.stop()\n# second raw record" };
  const second = await submitRecord(limitedSubmissions.origin, limitedSession, uniqueRecord);
  assertApiError(second.response, 409, "SINGLE_SESSION_RECORD_EXISTS");

  const idempotentRetry = await submitRecord(limitedSubmissions.origin, limitedSession, baseRecord);
  assert.equal(idempotentRetry.response.statusCode, 200, idempotentRetry.response.body.toString("utf8"));
  assert.equal(submissionFields(parseJson(idempotentRetry.response)).duplicate, true);
});

test("validates session and submission media, JSON, identity encoding, and input size boundaries", async t => {
  const dataDir = await temporaryDataDir(t);
  const { origin } = await startServer(t, { dataDir, maxBodyBytes: 4096 });
  const wrongSessionType = await request(origin, {
    method: "POST",
    requestPath: "/api/v1/sessions",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ taskId: TASK_ID })
  });
  assertApiError(wrongSessionType, 415, "UNSUPPORTED_MEDIA_TYPE");

  const malformedSessionJson = await request(origin, {
    method: "POST",
    requestPath: "/api/v1/sessions",
    headers: { "Content-Type": "application/json" },
    body: "{not-json"
  });
  assertApiError(malformedSessionJson, 400, "SESSION_INVALID_JSON");

  for (const value of [null, [], {}, { teamId: "client-controlled", taskId: TASK_ID }, { taskId: "unknown" }]) {
    const malformed = await jsonRequest(origin, {
      requestPath: "/api/v1/sessions",
      value
    });
    assert.ok([400, 404].includes(malformed.statusCode), malformed.body.toString("utf8"));
    assert.equal(parseJson(malformed).status, "error");
  }

  const session = await createSession(origin, { teamId: "boundary-team" });
  const submissionPath = `/api/v1/sessions/${encodeURIComponent(session.id)}/submissions`;
  const wrongSubmissionType = await authenticatedRequest(origin, {
    method: "POST",
    requestPath: submissionPath,
    token: session.submitToken,
    headers: { "Content-Type": "text/plain" },
    body: "{}"
  });
  assertApiError(wrongSubmissionType, 415, "UNSUPPORTED_MEDIA_TYPE");

  const encoded = await authenticatedRequest(origin, {
    method: "POST",
    requestPath: submissionPath,
    token: session.submitToken,
    headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    body: "not-really-gzip"
  });
  assertApiError(encoded, 400, "INVALID_GZIP");

  const unsupportedEncoding = await authenticatedRequest(origin, {
    method: "POST",
    requestPath: submissionPath,
    token: session.submitToken,
    headers: { "Content-Type": "application/json", "Content-Encoding": "br" },
    body: "not-really-brotli"
  });
  assertApiError(unsupportedEncoding, 415, "UNSUPPORTED_CONTENT_ENCODING");

  const malformedJson = await authenticatedRequest(origin, {
    method: "POST",
    requestPath: submissionPath,
    token: session.submitToken,
    headers: { "Content-Type": "application/json" },
    body: "{not-json"
  });
  assertApiError(malformedJson, 400, "INVALID_JSON");

  const oversizedBody = Buffer.alloc(4097, 0x20);
  const oversized = await authenticatedRequest(origin, {
    method: "POST",
    requestPath: submissionPath,
    token: session.submitToken,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": oversizedBody.length
    },
    body: oversizedBody
  });
  assertApiError(oversized, 413, "INPUT_TOO_LARGE");

  const draftPath = `/api/v1/sessions/${encodeURIComponent(session.id)}/drafts`;
  const malformedGzip = await authenticatedRequest(origin, {
    method: "POST",
    requestPath: draftPath,
    token: session.submitToken,
    headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    body: "not-really-gzip"
  });
  assertApiError(malformedGzip, 400, "INVALID_GZIP");

  const expandedBody = gzipSync(Buffer.from(JSON.stringify({ padding: "x".repeat(5000) })));
  assert.ok(expandedBody.length < 4096);
  const oversizedExpanded = await authenticatedRequest(origin, {
    method: "POST",
    requestPath: draftPath,
    token: session.submitToken,
    headers: {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Content-Length": expandedBody.length
    },
    body: expandedBody
  });
  assertApiError(oversizedExpanded, 413, "INPUT_TOO_LARGE");

  const storageDir = await temporaryDataDir(t);
  const storageLimited = await startServer(t, { dataDir: storageDir, maxStorageBytes: 1 });
  const storageFull = await jsonRequest(storageLimited.origin, {
    requestPath: "/api/v1/sessions",
    value: { taskId: TASK_ID }
  });
  assertApiError(storageFull, 507, "ARCHIVE_STORAGE_FULL");
});

test("fails closed when a stored session run definition or its challenge digest is tampered", async t => {
  const cases = [
    {
      name: "run definition",
      mutate(session) {
        session.challenge.runDefinition.timeLimitTicks += 1;
      }
    },
    {
      name: "challenge digest",
      mutate(session) {
        session.challengeDigest = differentDigest(session.challengeDigest);
      }
    },
    {
      name: "commitment nonce",
      mutate(session) {
        session.challengeCommitment.nonce = differentDigest(session.challengeCommitment.nonce);
      }
    },
    {
      name: "private run definition digest",
      mutate(session) {
        session.challengeCommitment.runDefinitionDigest = differentDigest(
          session.challengeCommitment.runDefinitionDigest
        );
      }
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async t => {
      const dataDir = await temporaryDataDir(t);
      const { origin } = await startServer(t, { dataDir });
      const session = await createSession(origin);
      const stored = await locateSessionArchive(dataDir, session.id);
      await overwriteJson(stored.filePath, value => {
        item.mutate(value);
        return value;
      });

      const response = await authenticatedRequest(origin, {
        requestPath: `/api/v1/sessions/${encodeURIComponent(session.id)}`,
        token: session.submitToken
      });
      assertApiError(response, 500, "ARCHIVE_CORRUPTED");
    });
  }
});

test("legacy v1 sessions without a salted commitment or scope sidecar remain readable and submittable", async t => {
  const dataDir = await temporaryDataDir(t);
  const { origin } = await startServer(t, { dataDir });
  const created = await createSession(origin, { teamId: "legacy-session-team" });
  const stored = await locateSessionArchive(dataDir, created.id);
  const legacyDigest = canonicalSha256(stored.value.challenge.runDefinition);
  await overwriteJson(stored.filePath, session => {
    delete session.challengeCommitment;
    session.challengeDigest = legacyDigest;
    return session;
  });
  await fs.promises.unlink(path.join(dataDir, "sessions", created.id, "scope.json"));
  const legacy = { ...created, challengeDigest: legacyDigest };

  const fetched = await authenticatedRequest(origin, {
    requestPath: `/api/v1/sessions/${encodeURIComponent(legacy.id)}`,
    token: legacy.submitToken
  });
  assert.equal(fetched.statusCode, 200, fetched.body.toString("utf8"));
  assert.equal(sessionFields(parseJson(fetched)).challengeDigest, legacyDigest);

  const submitted = await submitRecord(origin, legacy, rawRecordForSession(legacy));
  assert.equal(submitted.response.statusCode, 201, submitted.response.body.toString("utf8"));
  assert.equal(submissionFields(parseJson(submitted.response)).report.status, "verified");
});

test("fails closed when stored report or record bytes are tampered", async t => {
  await t.test("report.json", async t => {
    const { origin, session, receipt, archive } = await archivedSubmission(t);
    await overwriteJson(archive.reportPath, report => {
      report.status = report.status === "verified" ? "invalid" : "verified";
      return report;
    });

    const response = await authenticatedRequest(origin, {
      requestPath: `/api/v1/sessions/${encodeURIComponent(session.id)}/submissions/${encodeURIComponent(receipt.id)}`,
      token: session.submitToken
    });
    assertApiError(response, 500, "ARCHIVE_CORRUPTED");
  });

  await t.test("record.json", async t => {
    const { origin, session, receipt, archive } = await archivedSubmission(t);
    await overwriteJson(archive.recordPath, record => {
      record.sourceCode = `${record.sourceCode}\n# archive was tampered`;
      return record;
    });

    const submissionPath = `/api/v1/sessions/${encodeURIComponent(session.id)}/submissions/${encodeURIComponent(receipt.id)}`;
    assertApiError(await authenticatedRequest(origin, {
      requestPath: submissionPath,
      token: session.submitToken
    }), 500, "ARCHIVE_CORRUPTED");
    assertApiError(await authenticatedRequest(origin, {
      requestPath: `${submissionPath}/record`,
      token: session.submitToken
    }), 500, "ARCHIVE_CORRUPTED");
  });
});

test("fails closed when security-critical submission manifest fields are tampered", async t => {
  const cases = [
    {
      name: "manifest schema",
      mutate(manifest) {
        manifest.schemaVersion = "chenlong.local-submission/tampered";
      }
    },
    {
      name: "submission identity",
      mutate(manifest) {
        manifest.submissionId = "sub_00000000000000000000000000000000";
      }
    },
    {
      name: "session identity",
      mutate(manifest) {
        manifest.sessionId = "ses_00000000000000000000000000000000";
      }
    },
    {
      name: "challenge binding",
      mutate(manifest) {
        manifest.challengeDigest = differentDigest(manifest.challengeDigest);
      }
    },
    {
      name: "run binding",
      mutate(manifest) {
        manifest.run.runId = "run_00000000000000000000000000000000";
      }
    },
    {
      name: "record digest descriptor",
      mutate(manifest) {
        manifest.record.sha256 = differentDigest(manifest.record.sha256);
      }
    },
    {
      name: "report digest descriptor",
      mutate(manifest) {
        manifest.report.sha256 = differentDigest(manifest.report.sha256);
      }
    },
    {
      name: "report status descriptor",
      mutate(manifest) {
        manifest.report.status = manifest.report.status === "verified" ? "invalid" : "verified";
      }
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async t => {
      const { origin, session, receipt, archive } = await archivedSubmission(t);
      await overwriteJson(archive.manifestPath, manifest => {
        item.mutate(manifest);
        return manifest;
      });

      const response = await authenticatedRequest(origin, {
        requestPath: `/api/v1/sessions/${encodeURIComponent(session.id)}/submissions/${encodeURIComponent(receipt.id)}`,
        token: session.submitToken
      });
      assertApiError(response, 500, "ARCHIVE_CORRUPTED");
    });
  }
});
