"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { canonicalSha256 } = require("../backend/canonical-json.js");
const {
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION,
  GUANGYANG_LAYOUT_SELECTION_POLICY_VERSION,
  GUANGYANG_RANKED_LAYOUT_FORM_VERSION,
  GUANGYANG_RANKED_LAYOUT_FORM_V2,
  selectRankedGuangyangLayoutSequence
} = require("../backend/guangyang-private-layout-catalog.js");
const {
  BATCH_STORE_RECORD_SCHEMA_VERSION,
  BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2,
  RANKED_EVALUATION_POLICY_SCHEMA_VERSION,
  BATCH_SLOT_SESSION_BINDING_SCHEMA_VERSION_V2,
  MAX_RANKED_LOCKED_SOURCE_BYTES,
  BatchEvaluationStoreError,
  BatchEvaluationStore
} = require("../backend/batch-evaluation-store.js");

const COMPETITION_ID = "2026-r2-gyi-local-screening.1";
const OWNER_A = `usr_${"1".repeat(32)}`;
const OWNER_B = `usr_${"2".repeat(32)}`;
const OWNER_C = `usr_${"3".repeat(32)}`;
const SOURCE_A = "# ranked source A\nprint('ranked-a')\n";
const TEAM_A = "ranked-team-a";

const EVALUATION_POLICY = Object.freeze({
  schemaVersion: RANKED_EVALUATION_POLICY_SCHEMA_VERSION,
  purpose: "ranked",
  competitionId: COMPETITION_ID,
  catalogVersion: GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION,
  selectionPolicyVersion: GUANGYANG_LAYOUT_SELECTION_POLICY_VERSION,
  rankedFormVersion: GUANGYANG_RANKED_LAYOUT_FORM_VERSION,
  scoreMaximum: 100,
  slotCount: 5
});

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-ranked-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function createRankedStore(t, options = {}) {
  const rootDir = options.rootDir || temporaryRoot(t);
  const store = new BatchEvaluationStore({
    rootDir,
    purpose: "ranked",
    competitionId: COMPETITION_ID,
    layoutSequenceProvider: selectRankedGuangyangLayoutSequence,
    evaluationPolicy: EVALUATION_POLICY,
    ...options
  });
  await store.ready;
  return { store, rootDir };
}

function recordPath(rootDir, batchId) {
  return path.join(rootDir, "batches", batchId, "batch.json");
}

function readRecord(rootDir, batchId) {
  return JSON.parse(fs.readFileSync(recordPath(rootDir, batchId), "utf8"));
}

async function expectCode(code, operation, statusCode = null) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof BatchEvaluationStoreError, error?.stack || String(error));
    assert.equal(error.code, code);
    if (statusCode !== null) assert.equal(error.statusCode, statusCode);
    return true;
  });
}

function binding(view, teamId, slotIndex = view.batch.nextSlotIndex) {
  const digit = String(slotIndex % 10);
  return {
    ownerUserId: view.batchOwner || OWNER_A,
    batchId: view.batch.batchId,
    slotIndex,
    layoutCommitment: view.currentSlot.layoutCommitment,
    sessionId: `ses_${digit.repeat(32)}`,
    runId: `run_${((slotIndex + 5) % 10).toString().repeat(32)}`,
    challengeDigest: ((slotIndex + 1) % 10).toString().repeat(64),
    runDefinitionDigest: ((slotIndex + 2) % 10).toString().repeat(64),
    teamId
  };
}

async function completeRanked(store, created, ownerUserId, teamId, score, options = {}) {
  let view = created;
  for (let slotIndex = 1; slotIndex <= 5; slotIndex += 1) {
    const slotBinding = binding({ ...view, batchOwner: ownerUserId }, teamId, slotIndex);
    const leased = await store.bindCurrentSlotSession(slotBinding);
    const recordSha256 = (options.recordDigit || String((slotIndex + 3) % 10)).repeat(64);
    view = await store.submitVerifiedSlotResult({
      ownerUserId,
      batchId: view.batch.batchId,
      slotIndex,
      sessionId: slotBinding.sessionId,
      submissionId: `sub_${recordSha256.slice(0, 32)}`,
      recordSha256,
      reportSha256: String((slotIndex + 4) % 10).repeat(64),
      archivedAt: leased.currentSlotBinding.boundAt,
      result: {
        status: "valid",
        score,
        completed: options.completed !== false,
        collisionCount: options.collisionCount || 0,
        outOfBoundsCount: options.outOfBoundsCount || 0
      }
    });
  }
  return view;
}

test("ranked creation writes strict v2 policy and the frozen five-layout holdout form", async t => {
  const { store, rootDir } = await createRankedStore(t);
  const created = await store.createRankedBatch({ ownerUserId: OWNER_A, source: SOURCE_A, teamId: TEAM_A });
  assert.equal(created.created, true);
  assert.equal(created.purpose, "ranked");
  assert.equal(created.competitionId, COMPETITION_ID);
  assert.equal(created.lockedTeamId, TEAM_A);
  assert.equal(created.lockedSource, SOURCE_A);
  assert.deepEqual(created.evaluationPolicy, EVALUATION_POLICY);
  assert.equal(created.batch.slotCount, 5);

  const record = readRecord(rootDir, created.batch.batchId);
  assert.equal(record.schemaVersion, BATCH_STORE_RECORD_SCHEMA_VERSION);
  assert.equal(record.payload.schemaVersion, BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2);
  assert.equal(record.payload.purpose, "ranked");
  assert.equal(record.payload.competitionId, COMPETITION_ID);
  assert.equal(record.payload.lockedTeamId, TEAM_A);
  assert.equal(record.payloadDigest, canonicalSha256(record.payload));
  assert.deepEqual(
    new Set(record.payload.batchState.slots.map(slot => slot.privateValue.layoutId)),
    new Set(GUANGYANG_RANKED_LAYOUT_FORM_V2)
  );
  record.payload.batchState.slots.forEach(slot => {
    assert.equal(slot.privateValue.selectionPurpose, "ranked");
    assert.equal(slot.privateValue.selectionPolicyVersion, GUANGYANG_LAYOUT_SELECTION_POLICY_VERSION);
    assert.equal(slot.privateValue.rankedFormVersion, GUANGYANG_RANKED_LAYOUT_FORM_VERSION);
  });
});

test("ranked source recovery is bounded to the owner-response UTF-8 budget", async t => {
  const rootDir = temporaryRoot(t);
  const store = (await createRankedStore(t, { rootDir })).store;
  const boundarySource = "界".repeat(Math.floor(MAX_RANKED_LOCKED_SOURCE_BYTES / 3))
    + "a".repeat(MAX_RANKED_LOCKED_SOURCE_BYTES % 3);
  assert.equal(Buffer.byteLength(boundarySource, "utf8"), MAX_RANKED_LOCKED_SOURCE_BYTES);
  const created = await store.createRankedBatch({
    ownerUserId: OWNER_A,
    source: boundarySource,
    teamId: TEAM_A
  });
  assert.equal(created.lockedSource, boundarySource);
  const restarted = (await createRankedStore(t, { rootDir })).store;
  assert.equal((await restarted.readRankedBatchForOwner({ ownerUserId: OWNER_A })).lockedSource,
    boundarySource);

  const otherRoot = temporaryRoot(t);
  const other = (await createRankedStore(t, { rootDir: otherRoot })).store;
  await expectCode("RANKED_SOURCE_TOO_LARGE", () => other.createRankedBatch({
    ownerUserId: OWNER_B,
    source: `${boundarySource}b`,
    teamId: "ranked-team-b"
  }), 400);
  assert.deepEqual(fs.readdirSync(path.join(otherRoot, "batches")), []);
  assert.deepEqual(fs.readdirSync(path.join(otherRoot, "attempts")), []);
});

test("one ranked attempt is permanent while identical source and team safely recover every phase", async t => {
  const { store, rootDir } = await createRankedStore(t);
  const created = await store.createRankedBatch({ ownerUserId: OWNER_A, source: SOURCE_A, teamId: TEAM_A });
  const concurrent = await Promise.all([
    store.createRankedBatch({ ownerUserId: OWNER_A, source: SOURCE_A, teamId: TEAM_A }),
    store.createRankedBatch({ ownerUserId: OWNER_A, source: SOURCE_A, teamId: TEAM_A })
  ]);
  concurrent.forEach(recovered => {
    assert.equal(recovered.created, false);
    assert.equal(recovered.batch.batchId, created.batch.batchId);
    assert.equal(recovered.lockedSource, SOURCE_A);
  });
  assert.equal(fs.readdirSync(path.join(rootDir, "batches")).length, 1);

  await expectCode("RANKED_ATTEMPT_ALREADY_EXISTS", () => store.createRankedBatch({
    ownerUserId: OWNER_A,
    source: `${SOURCE_A}# changed\n`,
    teamId: TEAM_A
  }), 409);
  await expectCode("RANKED_ATTEMPT_ALREADY_EXISTS", () => store.createRankedBatch({
    ownerUserId: OWNER_A,
    source: SOURCE_A,
    teamId: "another-team"
  }), 409);

  await store.closeBatch({ ownerUserId: OWNER_A, batchId: created.batch.batchId });
  const afterFinal = await store.createRankedBatch({ ownerUserId: OWNER_A, source: SOURCE_A, teamId: TEAM_A });
  assert.equal(afterFinal.created, false);
  assert.equal(afterFinal.batch.phase, "finalized");
  assert.equal(afterFinal.batch.summary.missingCount, 5);
});

test("a durable reservation resumes exact input after a pre-batch failure", async t => {
  const rootDir = temporaryRoot(t);
  const store = (await createRankedStore(t, { rootDir })).store;
  const originalCreateDirectory = store.createStoredDirectoryUnlocked.bind(store);
  let failOnce = true;
  store.createStoredDirectoryUnlocked = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw Object.assign(new Error("injected pre-batch failure"), { code: "INJECTED_FAILURE" });
    }
    return originalCreateDirectory(...args);
  };
  await assert.rejects(
    () => store.createRankedBatch({ ownerUserId: OWNER_A, source: SOURCE_A, teamId: TEAM_A }),
    error => error?.code === "INJECTED_FAILURE"
  );
  assert.equal(fs.readdirSync(path.join(rootDir, "batches")).length, 0);
  const ledgerPath = path.join(rootDir, "attempts", `${OWNER_A}.json`);
  const reserved = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(reserved.payload.state, "reserved");
  assert.equal(reserved.payload.sourceDigest, canonicalSha256(SOURCE_A));

  await expectCode("RANKED_ATTEMPT_ALREADY_EXISTS", () => store.createRankedBatch({
    ownerUserId: OWNER_A,
    source: `${SOURCE_A}# changed\n`,
    teamId: TEAM_A
  }), 409);
  await expectCode("RANKED_ATTEMPT_ALREADY_EXISTS", () => store.createRankedBatch({
    ownerUserId: OWNER_A,
    source: SOURCE_A,
    teamId: "changed-team"
  }), 409);
  await expectCode("RANKED_ATTEMPT_RESERVATION_INCOMPLETE", () => (
    store.readRankedBatchForOwner({ ownerUserId: OWNER_A })
  ), 503);

  const resumed = await store.createRankedBatch({ ownerUserId: OWNER_A, source: SOURCE_A, teamId: TEAM_A });
  assert.equal(resumed.created, true);
  assert.equal(resumed.lockedSource, SOURCE_A);
  assert.equal(JSON.parse(fs.readFileSync(ledgerPath, "utf8")).payload.state, "bound");

  const restarted = (await createRankedStore(t, { rootDir })).store;
  const recovered = await restarted.createRankedBatch({
    ownerUserId: OWNER_A,
    source: SOURCE_A,
    teamId: TEAM_A
  });
  assert.equal(recovered.created, false);
  assert.equal(recovered.batch.batchId, resumed.batch.batchId);
});

test("a bound attempt tombstone fails closed when its batch directory disappears", async t => {
  const rootDir = temporaryRoot(t);
  const store = (await createRankedStore(t, { rootDir })).store;
  const created = await store.createRankedBatch({ ownerUserId: OWNER_A, source: SOURCE_A, teamId: TEAM_A });
  fs.rmSync(path.join(rootDir, "batches", created.batch.batchId), { recursive: true, force: true });

  await expectCode("BATCH_ARCHIVE_CORRUPTED", () => (
    store.readRankedBatchForOwner({ ownerUserId: OWNER_A })
  ), 500);
  await expectCode("BATCH_ARCHIVE_CORRUPTED", () => store.createRankedBatch({
    ownerUserId: OWNER_A,
    source: SOURCE_A,
    teamId: TEAM_A
  }), 500);
  await expectCode("RANKED_ATTEMPT_ALREADY_EXISTS", () => store.createRankedBatch({
    ownerUserId: OWNER_A,
    source: `${SOURCE_A}# retake\n`,
    teamId: TEAM_A
  }), 409);

  const restarted = new BatchEvaluationStore({
    rootDir,
    purpose: "ranked",
    competitionId: COMPETITION_ID,
    layoutSequenceProvider: selectRankedGuangyangLayoutSequence,
    evaluationPolicy: EVALUATION_POLICY
  });
  await expectCode("BATCH_ARCHIVE_CORRUPTED", () => restarted.ready, 500);
});

test("ranked owner recovery returns source only to its owner and persists across restart", async t => {
  const rootDir = temporaryRoot(t);
  const first = (await createRankedStore(t, { rootDir })).store;
  const created = await first.createRankedBatch({ ownerUserId: OWNER_A, source: SOURCE_A, teamId: TEAM_A });
  assert.equal((await first.readRankedBatchForOwner({ ownerUserId: OWNER_B })), null);

  const restarted = (await createRankedStore(t, { rootDir })).store;
  const recovered = await restarted.readRankedBatchForOwner({ ownerUserId: OWNER_A });
  assert.equal(recovered.lockedSource, SOURCE_A);
  assert.equal(recovered.lockedTeamId, TEAM_A);
  assert.equal(recovered.batch.batchId, created.batch.batchId);
  assert.equal(JSON.stringify(await restarted.listRankedResults({ offset: 0, limit: 100 })).includes(SOURCE_A), false);
});

test("ranked slot bindings cryptographically retain the frozen team and reject replacement", async t => {
  const { store, rootDir } = await createRankedStore(t);
  const created = await store.createRankedBatch({ ownerUserId: OWNER_A, source: SOURCE_A, teamId: TEAM_A });
  const correct = binding(created, TEAM_A);
  await expectCode("RANKED_TEAM_LOCKED", () => store.bindCurrentSlotSession({
    ...correct,
    teamId: "wrong-team"
  }), 409);
  const bound = await store.bindCurrentSlotSession(correct);
  assert.equal(bound.currentSlotBinding.schemaVersion, BATCH_SLOT_SESSION_BINDING_SCHEMA_VERSION_V2);
  assert.equal(bound.currentSlotBinding.teamId, TEAM_A);
  const record = readRecord(rootDir, created.batch.batchId);
  assert.equal(record.payload.slotExecutions[0].sessionBinding.teamId, TEAM_A);
  assert.equal(record.payload.slotExecutions[0].sessionBinding.schemaVersion,
    BATCH_SLOT_SESSION_BINDING_SCHEMA_VERSION_V2);

  const oversizedDigest = "f".repeat(64);
  await expectCode("RANKED_SCORE_OUT_OF_RANGE", () => store.submitVerifiedSlotResult({
    ownerUserId: OWNER_A,
    batchId: created.batch.batchId,
    slotIndex: 1,
    sessionId: correct.sessionId,
    submissionId: `sub_${oversizedDigest.slice(0, 32)}`,
    recordSha256: oversizedDigest,
    reportSha256: "d".repeat(64),
    archivedAt: bound.currentSlotBinding.boundAt,
    result: {
      status: "valid",
      score: 100.01,
      completed: true,
      collisionCount: 0,
      outOfBoundsCount: 0
    }
  }), 400);
  const stillCurrent = await store.readCurrentSlotForServer({
    ownerUserId: OWNER_A,
    batchId: created.batch.batchId,
    slotIndex: 1
  });
  assert.equal(stillCurrent.currentSlotBinding.sessionId, correct.sessionId);

  const maximumDigest = "e".repeat(64);
  const accepted = await store.submitVerifiedSlotResult({
    ownerUserId: OWNER_A,
    batchId: created.batch.batchId,
    slotIndex: 1,
    sessionId: correct.sessionId,
    submissionId: `sub_${maximumDigest.slice(0, 32)}`,
    recordSha256: maximumDigest,
    reportSha256: "c".repeat(64),
    archivedAt: bound.currentSlotBinding.boundAt,
    result: {
      status: "valid",
      score: 100,
      completed: true,
      collisionCount: 0,
      outOfBoundsCount: 0
    }
  });
  assert.equal(accepted.batch.nextSlotIndex, 2);
});

test("ranked v2 reload fails closed when a self-digested stored score exceeds its /100 policy", async t => {
  const { store, rootDir } = await createRankedStore(t);
  const created = await store.createRankedBatch({ ownerUserId: OWNER_A, source: SOURCE_A, teamId: TEAM_A });
  const slotBinding = binding(created, TEAM_A);
  const leased = await store.bindCurrentSlotSession(slotBinding);
  const recordSha256 = "a".repeat(64);
  await store.submitVerifiedSlotResult({
    ownerUserId: OWNER_A,
    batchId: created.batch.batchId,
    slotIndex: 1,
    sessionId: slotBinding.sessionId,
    submissionId: `sub_${recordSha256.slice(0, 32)}`,
    recordSha256,
    reportSha256: "b".repeat(64),
    archivedAt: leased.currentSlotBinding.boundAt,
    result: {
      status: "valid",
      score: 100,
      completed: true,
      collisionCount: 0,
      outOfBoundsCount: 0
    }
  });

  const tampered = readRecord(rootDir, created.batch.batchId);
  tampered.payload.batchState.slots[0].result.score = 100.01;
  tampered.payload.batchStateDigest = canonicalSha256(tampered.payload.batchState);
  tampered.payloadDigest = canonicalSha256(tampered.payload);
  fs.writeFileSync(recordPath(rootDir, created.batch.batchId), `${JSON.stringify(tampered, null, 2)}\n`);

  await assert.rejects(
    () => createRankedStore(t, { rootDir }),
    error => error instanceof BatchEvaluationStoreError
      && error.code === "BATCH_ARCHIVE_CORRUPTED"
      && /(score exceeds|private layout sequence is invalid)/.test(error.message)
  );
});

test("a legacy /60 ranked archive reloads under /100 and is normalized only in the ranking projection", async t => {
  const rootDir = temporaryRoot(t);
  const legacyPolicy = Object.freeze({ ...EVALUATION_POLICY, scoreMaximum: 60 });
  const legacy = (await createRankedStore(t, { rootDir, evaluationPolicy: legacyPolicy })).store;
  const created = await legacy.createRankedBatch({ ownerUserId: OWNER_A, source: SOURCE_A, teamId: TEAM_A });
  await completeRanked(legacy, created, OWNER_A, TEAM_A, 60, { recordDigit: "d" });

  const restarted = (await createRankedStore(t, { rootDir })).store;
  const ownerView = await restarted.readRankedBatchForOwner({ ownerUserId: OWNER_A });
  assert.equal(ownerView.evaluationPolicy.scoreMaximum, 60, "the archived policy stays frozen");
  assert.equal(ownerView.batch.summary.batchScore, 60, "the archived owner evidence stays byte-semantically /60");

  const ranking = await restarted.listRankedResults({ offset: 0, limit: 100 });
  assert.equal(ranking.entries[0].score.value, 100);
  assert.equal(ranking.entries[0].score.mean, 100);
  assert.equal(ranking.entries[0].score.minimum, 100);
  assert.equal(ranking.entries[0].score.maximum, 100);
});

test("ranked results finalize all expiries atomically, rank only finalized attempts, and share public ties", async t => {
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  const { store, rootDir } = await createRankedStore(t, { now: () => now, batchTtlMs: 1_000 });
  const a = await store.createRankedBatch({ ownerUserId: OWNER_A, source: SOURCE_A, teamId: TEAM_A });
  const b = await store.createRankedBatch({ ownerUserId: OWNER_B, source: "print('b')", teamId: "team-b" });
  const c = await store.createRankedBatch({ ownerUserId: OWNER_C, source: "print('c')", teamId: "team-c" });
  await store.closeBatch({ ownerUserId: OWNER_A, batchId: a.batch.batchId });
  await store.closeBatch({ ownerUserId: OWNER_B, batchId: b.batch.batchId });

  const beforeExpiry = await store.listRankedResults({ offset: 0, limit: 100 });
  assert.equal(beforeExpiry.total, 2);
  assert.deepEqual(beforeExpiry.entries.map(entry => entry.rank), [1, 1]);
  assert.equal(beforeExpiry.entries.every(entry => entry.quality.missingCount === 5), true);

  now += 1_001;
  const afterExpiry = await store.listRankedResults({ offset: 0, limit: 100 });
  assert.equal(afterExpiry.total, 3);
  assert.deepEqual(afterExpiry.entries.map(entry => entry.rank), [1, 1, 1]);
  const expiredRecord = readRecord(rootDir, c.batch.batchId);
  assert.equal(expiredRecord.payload.batchState.phase, "finalized");
  assert.equal(expiredRecord.payload.batchState.finalizationReason, "closed_with_missing");

  const restarted = (await createRankedStore(t, { rootDir, now: () => now, batchTtlMs: 1_000 })).store;
  const afterRestart = await restarted.listRankedResults({ offset: 0, limit: 100 });
  assert.deepEqual(afterRestart, afterExpiry, "private tie ordering and public ranks stay stable across restart");
});

test("ranked comparison keeps quality ordering while exposing no batch, source, layout, or session fields", async t => {
  const { store } = await createRankedStore(t);
  const a = await store.createRankedBatch({ ownerUserId: OWNER_A, source: SOURCE_A, teamId: TEAM_A });
  const b = await store.createRankedBatch({ ownerUserId: OWNER_B, source: "print('b')", teamId: "team-b" });
  await completeRanked(store, a, OWNER_A, TEAM_A, 55, { recordDigit: "a" });
  await completeRanked(store, b, OWNER_B, "team-b", 50, { recordDigit: "b", collisionCount: 1 });
  const ranking = await store.listRankedResults({ offset: 0, limit: 100 });
  assert.deepEqual(ranking.entries.map(entry => [entry.ownerUserId, entry.rank]), [
    [OWNER_A, 1],
    [OWNER_B, 2]
  ]);
  assert.equal(ranking.entries[0].score.maximum, 100);
  assert.equal(ranking.entries[0].quality.validCount, 5);
  assert.equal(ranking.entries[1].quality.collisionCount, 5);
  const serialized = JSON.stringify(ranking.entries.map(({ ownerUserId, lockedTeamId, ...entry }) => entry));
  for (const forbidden of ["batchId", "source", "layout", "session", "runDefinition", SOURCE_A, OWNER_A, TEAM_A]) {
    assert.equal(serialized.includes(forbidden), false, `public-safe store projection omits ${forbidden}`);
  }
});
