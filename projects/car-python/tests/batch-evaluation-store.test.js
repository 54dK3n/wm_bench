"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { canonicalSha256 } = require("../backend/canonical-json.js");
const {
  BATCH_STORE_RECORD_SCHEMA_VERSION,
  BATCH_STORE_PAYLOAD_SCHEMA_VERSION,
  BATCH_SLOT_SESSION_BINDING_SCHEMA_VERSION,
  BATCH_SLOT_VERIFIED_RECEIPT_SCHEMA_VERSION,
  MAX_OPEN_BATCHES_PER_OWNER,
  MAX_RETAINED_BATCHES_PER_OWNER,
  MAX_BATCH_RECORD_BYTES,
  MAX_ARCHIVED_BATCH_DIRECTORIES,
  OPEN_BATCH_GROWTH_RESERVE_BYTES,
  BatchEvaluationStoreError,
  BatchEvaluationStore
} = require("../backend/batch-evaluation-store.js");

const OWNER = `usr_${"1".repeat(32)}`;
const OTHER_OWNER = `usr_${"2".repeat(32)}`;
const SOURCE = "# locked contestant source\nprint('batch secret source')\n";

function result(overrides = {}) {
  return {
    status: "valid",
    score: 80,
    completed: true,
    collisionCount: 0,
    outOfBoundsCount: 0,
    ...overrides
  };
}

function sessionBinding(view, overrides = {}) {
  return {
    ownerUserId: OWNER,
    batchId: view.batch.batchId,
    slotIndex: view.batch.nextSlotIndex,
    layoutCommitment: view.currentSlot.layoutCommitment,
    sessionId: `ses_${"3".repeat(32)}`,
    runId: `run_${"4".repeat(32)}`,
    challengeDigest: "5".repeat(64),
    runDefinitionDigest: "6".repeat(64),
    ...overrides
  };
}

function verifiedCommand(view, binding, overrides = {}) {
  const recordSha256 = overrides.recordSha256 || "a".repeat(64);
  return {
    ownerUserId: OWNER,
    batchId: view.batch.batchId,
    slotIndex: view.batch.nextSlotIndex,
    sessionId: binding.sessionId,
    submissionId: `sub_${recordSha256.slice(0, 32)}`,
    recordSha256,
    result: result(),
    ...overrides
  };
}

async function expectCode(code, operation, statusCode = null) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof BatchEvaluationStoreError, error?.stack || String(error));
    assert.equal(error.code, code);
    if (statusCode !== null) assert.equal(error.statusCode, statusCode);
    return true;
  });
}

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-batch-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function createStore(t, options = {}) {
  const rootDir = options.rootDir || temporaryRoot(t);
  const store = new BatchEvaluationStore({ ...options, rootDir });
  await store.ready;
  return { store, rootDir };
}

function recordPath(rootDir, batchId) {
  return path.join(rootDir, "batches", batchId, "batch.json");
}

function readRecord(rootDir, batchId) {
  return JSON.parse(fs.readFileSync(recordPath(rootDir, batchId), "utf8"));
}

function writeRecord(rootDir, batchId, record) {
  fs.writeFileSync(recordPath(rootDir, batchId), `${JSON.stringify(record, null, 2)}\n`);
}

test("creates a fixed private five-layout batch while returning only two safe public projections", async t => {
  const { store, rootDir } = await createStore(t);
  const view = await store.createBatch({ ownerUserId: OWNER, source: SOURCE });
  assert.deepEqual(Object.keys(view), ["batch", "currentSlot"]);
  assert.equal(view.batch.authoritative, false);
  assert.equal(view.batch.slotCount, 5);
  assert.equal(view.batch.nextSlotIndex, 1);
  assert.equal(view.currentSlot.sequenceLength, 5);
  assert.equal(view.currentSlot.slotIndex, 1);
  assert.deepEqual(Object.keys(view.currentSlot), [
    "schemaVersion", "catalogVersion", "mapId", "mapVersion",
    "slotIndex", "sequenceLength", "layoutCommitment"
  ]);

  const record = readRecord(rootDir, view.batch.batchId);
  assert.equal(record.schemaVersion, BATCH_STORE_RECORD_SCHEMA_VERSION);
  assert.equal(record.payload.schemaVersion, BATCH_STORE_PAYLOAD_SCHEMA_VERSION);
  assert.equal(record.payload.authoritative, false);
  assert.equal(record.payload.ownerUserId, OWNER);
  assert.equal(record.payload.lockedSource.value, SOURCE);
  assert.equal(record.payload.batchState.slots.length, 5);
  assert.equal(record.payload.slotExecutions.length, 5);
  assert.match(record.payload.batchState.commitment.nonce, /^[a-f0-9]{64}$/);
  assert.match(record.payload.layoutSelectionSecret, /^[a-f0-9]{64}$/);
  assert.equal(record.payloadDigest, canonicalSha256(record.payload));
  assert.equal(record.payload.batchStateDigest, canonicalSha256(record.payload.batchState));

  const serializedPublic = JSON.stringify(view);
  assert.equal(serializedPublic.includes(SOURCE), false);
  assert.equal(serializedPublic.includes(OWNER), false);
  assert.equal(serializedPublic.includes(record.payload.batchState.commitment.nonce), false);
  assert.equal(serializedPublic.includes(record.payload.layoutSelectionSecret), false);
  for (const slot of record.payload.batchState.slots) {
    assert.equal(serializedPublic.includes(slot.privateValue.layoutId), false);
    Object.values(slot.privateValue.anchorIds).forEach(anchorId => {
      assert.equal(serializedPublic.includes(anchorId), false);
    });
  }
  for (const forbidden of ["privateValue", "interactionDefinition", "seedDigest", "layoutId", "anchorIds"]) {
    assert.equal(serializedPublic.includes(forbidden), false, `public view omits ${forbidden}`);
  }
  assert.equal(fs.existsSync(path.join(rootDir, "batches")), true);
  assert.equal(fs.existsSync(path.join(rootDir, "sessions")), false);

  const exactRetry = await store.createBatch({ ownerUserId: OWNER, source: SOURCE });
  assert.deepEqual(exactRetry, view, "an exact open-source retry must reuse the original batch");
  assert.deepEqual(fs.readdirSync(path.join(rootDir, "batches")), [view.batch.batchId]);

  const second = await store.createBatch({ ownerUserId: OWNER, source: `${SOURCE}# another attempt\n` });
  const secondRecord = readRecord(rootDir, second.batch.batchId);
  assert.notEqual(second.batch.batchId, view.batch.batchId);
  assert.notEqual(secondRecord.payload.batchState.commitment.nonce, record.payload.batchState.commitment.nonce);
  assert.notEqual(secondRecord.payload.layoutSelectionSecret, record.payload.layoutSelectionSecret);
  assert.notEqual(second.batch.commitmentDigest, view.batch.commitmentDigest);
});

test("concurrent identical creates are idempotent inside the store lock", async t => {
  const { store, rootDir } = await createStore(t);
  const [first, second] = await Promise.all([
    store.createBatch({ ownerUserId: OWNER, source: SOURCE }),
    store.createBatch({ ownerUserId: OWNER, source: SOURCE })
  ]);
  assert.deepEqual(second, first);
  assert.deepEqual(fs.readdirSync(path.join(rootDir, "batches")), [first.batch.batchId]);
  assert.equal((await store.listOpenBatches({ ownerUserId: OWNER })).length, 1);
});

test("an exact open-source retry remains readable when new capacity is exhausted", async t => {
  const { store } = await createStore(t);
  const created = await store.createBatch({ ownerUserId: OWNER, source: SOURCE });
  const archive = await store.scanArchiveUnlocked();
  const records = new Map(archive.records);
  for (let index = records.size; index < MAX_ARCHIVED_BATCH_DIRECTORIES; index += 1) {
    records.set(`bat_${index.toString(16).padStart(32, "0")}`, {
      payload: { ownerUserId: OTHER_OWNER, batchState: { phase: "finalized" } }
    });
  }
  store.maxStorageBytes = 1;
  store.scanArchiveUnlocked = async () => ({
    usedBytes: archive.usedBytes,
    records
  });
  assert.deepEqual(await store.createBatch({ ownerUserId: OWNER, source: SOURCE }), created);
});

test("open batch discovery is owner-only, bounded, stable, private, and finalizes expiry", async t => {
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  const { store, rootDir } = await createStore(t, {
    now: () => now,
    batchTtlMs: 1_000,
    maxOpenBatchesPerOwner: 3,
    maxRetainedBatchesPerOwner: 10
  });
  const first = await store.createBatch({ ownerUserId: OWNER, source: `${SOURCE}# first` });
  now += 1;
  const second = await store.createBatch({ ownerUserId: OWNER, source: `${SOURCE}# second` });
  now += 1;
  const third = await store.createBatch({ ownerUserId: OWNER, source: `${SOURCE}# third` });
  const foreign = await store.createBatch({ ownerUserId: OTHER_OWNER, source: `${SOURCE}# foreign` });

  const discovered = await store.listOpenBatches({ ownerUserId: OWNER });
  assert.equal(Object.isFrozen(discovered), true);
  assert.deepEqual(discovered.map(item => item.batchId), [third.batch.batchId, second.batch.batchId]);
  for (const item of discovered) {
    assert.deepEqual(Object.keys(item), [
      "batchId", "createdAt", "expiresAt", "nextSlotIndex", "sourceDigest", "summary"
    ]);
    assert.equal(item.nextSlotIndex, 1);
    assert.equal(item.summary.pendingCount, 5);
  }
  const serialized = JSON.stringify(discovered);
  for (const forbidden of [
    SOURCE, OWNER, OTHER_OWNER, "currentSlot", "layoutCommitment", "lockedSource",
    "interactionDefinition", "layoutId", "anchorIds", "sessionId", "runId", "privateValue"
  ]) {
    assert.equal(serialized.includes(forbidden), false, `open discovery omits ${forbidden}`);
  }
  assert.deepEqual((await store.listOpenBatches({ ownerUserId: OTHER_OWNER })).map(item => item.batchId), [
    foreign.batch.batchId
  ]);
  await expectCode("INVALID_LIST_OPEN_BATCHES_COMMAND", () => store.listOpenBatches({
    ownerUserId: OWNER,
    phase: "open"
  }), 400);

  now += 1_000;
  assert.deepEqual(await store.listOpenBatches({ ownerUserId: OWNER }), []);
  for (const view of [first, second, third]) {
    const persisted = readRecord(rootDir, view.batch.batchId);
    assert.equal(persisted.payload.batchState.phase, "finalized");
    assert.equal(persisted.payload.batchState.slots.every(slot => slot.result?.status === "missing"), true);
  }
  assert.equal(readRecord(rootDir, foreign.batch.batchId).payload.batchState.phase, "open",
    "listing one owner must not mutate another owner's expired batch");
});

test("create refuses the retained directory ceiling before making the archive unreadable", async t => {
  const { store, rootDir } = await createStore(t);
  store.scanArchiveUnlocked = async () => ({
    usedBytes: 0,
    records: new Map(Array.from({ length: MAX_ARCHIVED_BATCH_DIRECTORIES }, (_value, index) => [
      `bat_${index.toString(16).padStart(32, "0")}`,
      { payload: { ownerUserId: OTHER_OWNER, batchState: { phase: "finalized" } } }
    ]))
  });
  await expectCode("BATCH_ARCHIVE_FULL", () => store.createBatch({ ownerUserId: OWNER, source: SOURCE }), 507);
  assert.deepEqual(fs.readdirSync(path.join(rootDir, "batches")), []);
});

test("create reserves enough storage for every open batch to bind and finalize all five slots", async t => {
  const rejected = await createStore(t, {
    maxStorageBytes: OPEN_BATCH_GROWTH_RESERVE_BYTES
  });
  await expectCode("BATCH_STORAGE_FULL",
    () => rejected.store.createBatch({ ownerUserId: OWNER, source: SOURCE }), 507);

  const accepted = await createStore(t, {
    maxStorageBytes: OPEN_BATCH_GROWTH_RESERVE_BYTES * 2
  });
  let view = await accepted.store.createBatch({ ownerUserId: OWNER, source: SOURCE });
  const initialBytes = fs.statSync(recordPath(accepted.rootDir, view.batch.batchId)).size;
  for (let slotIndex = 1; slotIndex <= 5; slotIndex += 1) {
    const binding = sessionBinding(view, {
      sessionId: `ses_${String(slotIndex).repeat(32)}`,
      runId: `run_${String(slotIndex + 1).repeat(32)}`
    });
    await accepted.store.bindCurrentSlotSession(binding);
    view = await accepted.store.submitVerifiedSlotResult(verifiedCommand(view, binding, {
      recordSha256: slotIndex.toString(16).repeat(64),
      result: result({ score: 50 + slotIndex })
    }));
  }
  assert.equal(view.batch.phase, "finalized");
  assert.ok(fs.statSync(recordPath(accepted.rootDir, view.batch.batchId)).size
    <= initialBytes + OPEN_BATCH_GROWTH_RESERVE_BYTES);
});

test("persists across restart and binds every public and private operation to its owner", async t => {
  const rootDir = temporaryRoot(t);
  const first = new BatchEvaluationStore({ rootDir });
  await first.ready;
  const created = await first.createBatch({ ownerUserId: OWNER, source: SOURCE });

  const restarted = new BatchEvaluationStore({ rootDir });
  await restarted.ready;
  assert.deepEqual(await restarted.readBatch({
    ownerUserId: OWNER,
    batchId: created.batch.batchId
  }), created);

  for (const operation of [
    () => restarted.readBatch({ ownerUserId: OTHER_OWNER, batchId: created.batch.batchId }),
    () => restarted.readCurrentSlotForServer({ ownerUserId: OTHER_OWNER, batchId: created.batch.batchId, slotIndex: 1 }),
    () => restarted.readSlotExecutionForServer({ ownerUserId: OTHER_OWNER, batchId: created.batch.batchId, slotIndex: 1 }),
    () => restarted.closeBatch({ ownerUserId: OTHER_OWNER, batchId: created.batch.batchId })
  ]) {
    await expectCode("BATCH_OWNER_MISMATCH", operation, 403);
  }
  await expectCode("BATCH_NOT_FOUND", () => restarted.readBatch({
    ownerUserId: OWNER,
    batchId: "../batch.json"
  }), 404);
  await expectCode("INVALID_CREATE_BATCH_COMMAND", () => restarted.createBatch({
    ownerUserId: OWNER,
    source: SOURCE,
    route: "automatic"
  }), 400);
});

test("server-only current-slot access never reveals future layouts and session binding is immutable", async t => {
  const { store, rootDir } = await createStore(t);
  const view = await store.createBatch({ ownerUserId: OWNER, source: SOURCE });
  const record = readRecord(rootDir, view.batch.batchId);
  const lease = await store.readCurrentSlotForServer({
    ownerUserId: OWNER,
    batchId: view.batch.batchId,
    slotIndex: 1
  });
  assert.equal(lease.authoritative, false);
  assert.equal(lease.source, SOURCE);
  assert.equal(lease.privateLayoutSelection.layoutId, record.payload.batchState.slots[0].privateValue.layoutId);
  assert.deepEqual(lease.publicLayout, view.currentSlot);
  assert.equal(lease.currentSlotBinding, null);
  assert.equal(Object.isFrozen(lease), true);
  const leaseJson = JSON.stringify(lease);
  record.payload.batchState.slots.slice(1).forEach(slot => {
    assert.equal(leaseJson.includes(slot.privateValue.layoutId), false, "future layout stays private");
  });
  await expectCode("SLOT_NOT_CURRENT", () => store.readCurrentSlotForServer({
    ownerUserId: OWNER,
    batchId: view.batch.batchId,
    slotIndex: 2
  }), 409);

  const binding = sessionBinding(view);
  const bound = await store.bindCurrentSlotSession(binding);
  assert.equal(bound.currentSlotBinding.schemaVersion, BATCH_SLOT_SESSION_BINDING_SCHEMA_VERSION);
  assert.equal(bound.currentSlotBinding.sessionId, binding.sessionId);
  const bytesAfterFirstBind = fs.readFileSync(recordPath(rootDir, view.batch.batchId));
  const rebound = await store.bindCurrentSlotSession(binding);
  assert.deepEqual(rebound, bound);
  assert.deepEqual(fs.readFileSync(recordPath(rootDir, view.batch.batchId)), bytesAfterFirstBind,
    "identical binding retry does not rewrite the record");
  await expectCode("SLOT_SESSION_ALREADY_BOUND", () => store.bindCurrentSlotSession({
    ...binding,
    sessionId: `ses_${"7".repeat(32)}`
  }), 409);
  await expectCode("SLOT_LAYOUT_MISMATCH", () => {
    const freshStorePromise = store.createBatch({ ownerUserId: OWNER, source: SOURCE });
    return freshStorePromise.then(fresh => store.bindCurrentSlotSession({
      ...sessionBinding(fresh),
      layoutCommitment: "8".repeat(64)
    }));
  }, 409);
});

test("verified slot receipt requires its bound session and full record identity for idempotence", async t => {
  const { store, rootDir } = await createStore(t);
  const view = await store.createBatch({ ownerUserId: OWNER, source: SOURCE });
  const binding = sessionBinding(view);
  const command = verifiedCommand(view, binding);

  await expectCode("SLOT_SESSION_MISMATCH", () => store.submitVerifiedSlotResult(command), 409);
  await store.bindCurrentSlotSession(binding);
  const advanced = await store.submitVerifiedSlotResult(command);
  assert.equal(advanced.batch.nextSlotIndex, 2);
  assert.equal(advanced.currentSlot.slotIndex, 2);
  const stored = readRecord(rootDir, view.batch.batchId);
  assert.equal(stored.payload.slotExecutions[0].verifiedReceipt.schemaVersion,
    BATCH_SLOT_VERIFIED_RECEIPT_SCHEMA_VERSION);
  assert.equal(stored.payload.slotExecutions[0].verifiedReceipt.recordSha256, command.recordSha256);
  assert.equal(stored.payload.slotExecutions[0].verifiedReceipt.submissionId, command.submissionId);

  const bytesAfterFirstSubmit = fs.readFileSync(recordPath(rootDir, view.batch.batchId));
  assert.deepEqual(await store.submitVerifiedSlotResult(command), advanced);
  assert.deepEqual(fs.readFileSync(recordPath(rootDir, view.batch.batchId)), bytesAfterFirstSubmit,
    "identical verified RunRecord retry does not rewrite the record");

  const anotherRecordSha256 = "b".repeat(64);
  await expectCode("SLOT_ALREADY_FINALIZED", () => store.submitVerifiedSlotResult({
    ...command,
    recordSha256: anotherRecordSha256,
    submissionId: `sub_${anotherRecordSha256.slice(0, 32)}`
  }), 409);
  await expectCode("SLOT_ALREADY_FINALIZED", () => store.submitVerifiedSlotResult({
    ...command,
    result: result({ score: 99 })
  }), 409);
  await expectCode("SLOT_NOT_CURRENT", () => store.readCurrentSlotForServer({
    ownerUserId: OWNER,
    batchId: view.batch.batchId,
    slotIndex: 1
  }), 409);
  await expectCode("SLOT_NOT_CURRENT", () => store.bindCurrentSlotSession(binding), 409);

  await expectCode("INVALID_VERIFIED_SLOT_COMMAND", () => store.submitVerifiedSlotResult({
    ...verifiedCommand(advanced, sessionBinding(advanced, {
      sessionId: `ses_${"9".repeat(32)}`,
      runId: `run_${"a".repeat(32)}`
    })),
    verificationReport: { status: "verified" }
  }), 400);
  const nextBinding = sessionBinding(advanced, {
    sessionId: `ses_${"9".repeat(32)}`,
    runId: `run_${"a".repeat(32)}`
  });
  await store.bindCurrentSlotSession(nextBinding);
  await expectCode("INVALID_SLOT_RESULT", () => store.submitVerifiedSlotResult({
    ...verifiedCommand(advanced, nextBinding, { recordSha256: "c".repeat(64) }),
    result: { ...result(), verification: { status: "verified" } }
  }), 400);
});

test("narrow server recovery reads current and completed execution receipts without source, layouts, or future slots", async t => {
  const { store, rootDir } = await createStore(t);
  const view = await store.createBatch({ ownerUserId: OWNER, source: SOURCE });
  const privateRecord = readRecord(rootDir, view.batch.batchId);
  const current = await store.readSlotExecutionForServer({
    ownerUserId: OWNER,
    batchId: view.batch.batchId,
    slotIndex: 1
  });
  assert.deepEqual(Object.keys(current), [
    "authoritative", "batchId", "layoutCommitment", "sessionBinding",
    "slotIndex", "sourceDigest", "verifiedReceipt"
  ]);
  assert.equal(current.authoritative, false);
  assert.equal(current.layoutCommitment, view.currentSlot.layoutCommitment);
  assert.equal(current.sessionBinding, null);
  assert.equal(current.verifiedReceipt, null);
  assert.equal(Object.isFrozen(current), true);
  const serializedCurrent = JSON.stringify(current);
  assert.equal(serializedCurrent.includes(SOURCE), false);
  assert.equal(serializedCurrent.includes("privateLayoutSelection"), false);
  assert.equal(serializedCurrent.includes("interactionDefinition"), false);
  privateRecord.payload.batchState.slots.forEach(slot => {
    assert.equal(serializedCurrent.includes(slot.privateValue.layoutId), false);
    Object.values(slot.privateValue.anchorIds).forEach(anchorId => {
      assert.equal(serializedCurrent.includes(anchorId), false);
    });
  });
  await expectCode("SLOT_NOT_AVAILABLE", () => store.readSlotExecutionForServer({
    ownerUserId: OWNER,
    batchId: view.batch.batchId,
    slotIndex: 2
  }), 409);

  const binding = sessionBinding(view);
  await store.bindCurrentSlotSession(binding);
  const command = verifiedCommand(view, binding);
  const advanced = await store.submitVerifiedSlotResult(command);
  const completed = await store.readSlotExecutionForServer({
    ownerUserId: OWNER,
    batchId: view.batch.batchId,
    slotIndex: 1
  });
  assert.equal(completed.sessionBinding.sessionId, binding.sessionId);
  assert.equal(completed.sessionBinding.runId, binding.runId);
  assert.equal(completed.verifiedReceipt.submissionId, command.submissionId);
  assert.equal(completed.verifiedReceipt.recordSha256, command.recordSha256);
  assert.equal(JSON.stringify(completed).includes(SOURCE), false);

  const nextCurrent = await store.readSlotExecutionForServer({
    ownerUserId: OWNER,
    batchId: view.batch.batchId,
    slotIndex: advanced.batch.nextSlotIndex
  });
  assert.equal(nextCurrent.sessionBinding, null);
  assert.equal(nextCurrent.verifiedReceipt, null);
});

test("concurrent binding and verified submission are serialized without best-of retries", async t => {
  const { store } = await createStore(t);
  const view = await store.createBatch({ ownerUserId: OWNER, source: SOURCE });
  const firstBinding = sessionBinding(view);
  const secondBinding = sessionBinding(view, {
    sessionId: `ses_${"7".repeat(32)}`,
    runId: `run_${"8".repeat(32)}`
  });
  const bindingOutcomes = await Promise.allSettled([
    store.bindCurrentSlotSession(firstBinding),
    store.bindCurrentSlotSession(secondBinding)
  ]);
  assert.deepEqual(bindingOutcomes.map(item => item.status), ["fulfilled", "rejected"]);
  assert.equal(bindingOutcomes[1].reason.code, "SLOT_SESSION_ALREADY_BOUND");

  const firstCommand = verifiedCommand(view, firstBinding);
  const otherRecordSha256 = "d".repeat(64);
  const secondCommand = {
    ...firstCommand,
    recordSha256: otherRecordSha256,
    submissionId: `sub_${otherRecordSha256.slice(0, 32)}`
  };
  const submissionOutcomes = await Promise.allSettled([
    store.submitVerifiedSlotResult(firstCommand),
    store.submitVerifiedSlotResult(secondCommand)
  ]);
  assert.deepEqual(submissionOutcomes.map(item => item.status), ["fulfilled", "rejected"]);
  assert.equal(submissionOutcomes[1].reason.code, "SLOT_ALREADY_FINALIZED");
});

test("close is atomic and idempotently converts every unreported slot to a zero missing result", async t => {
  const { store, rootDir } = await createStore(t);
  const view = await store.createBatch({ ownerUserId: OWNER, source: SOURCE });
  await store.bindCurrentSlotSession(sessionBinding(view));
  const closed = await store.closeBatch({ ownerUserId: OWNER, batchId: view.batch.batchId });
  assert.equal(closed.batch.authoritative, false);
  assert.equal(closed.batch.phase, "finalized");
  assert.equal(closed.batch.finalizationReason, "closed_with_missing");
  assert.equal(closed.batch.summary.missingCount, 5);
  assert.equal(closed.batch.summary.batchScore, 0);
  assert.equal(closed.currentSlot, null);
  const bytes = fs.readFileSync(recordPath(rootDir, view.batch.batchId));
  assert.deepEqual(await store.closeBatch({ ownerUserId: OWNER, batchId: view.batch.batchId }), closed);
  assert.deepEqual(fs.readFileSync(recordPath(rootDir, view.batch.batchId)), bytes);
  await expectCode("BATCH_FINALIZED", () => store.readCurrentSlotForServer({
    ownerUserId: OWNER,
    batchId: view.batch.batchId,
    slotIndex: 1
  }), 409);
});

test("strict record schema, hashes, directory shape, UTF-8, and size checks reject tampering", async t => {
  const cases = [
    record => {
      record.payload.ownerUserId = OTHER_OWNER;
    },
    record => {
      record.payload.debug = true;
      record.payloadDigest = canonicalSha256(record.payload);
    },
    record => {
      record.payload.batchState.slots[0].privateValue.layoutId = "gyi-layout-tampered";
      record.payload.batchStateDigest = canonicalSha256(record.payload.batchState);
      record.payloadDigest = canonicalSha256(record.payload);
    }
  ];
  for (const mutate of cases) {
    const rootDir = temporaryRoot(t);
    const store = new BatchEvaluationStore({ rootDir });
    await store.ready;
    const view = await store.createBatch({ ownerUserId: OWNER, source: SOURCE });
    const record = readRecord(rootDir, view.batch.batchId);
    mutate(record);
    writeRecord(rootDir, view.batch.batchId, record);
    await expectCode("BATCH_ARCHIVE_CORRUPTED", () => store.readBatch({
      ownerUserId: OWNER,
      batchId: view.batch.batchId
    }), 500);
  }

  const extraRoot = temporaryRoot(t);
  const extraStore = new BatchEvaluationStore({ rootDir: extraRoot });
  await extraStore.ready;
  const extraView = await extraStore.createBatch({ ownerUserId: OWNER, source: SOURCE });
  fs.writeFileSync(path.join(extraRoot, "batches", extraView.batch.batchId, "unexpected.txt"), "x");
  await expectCode("BATCH_ARCHIVE_CORRUPTED", () => extraStore.readBatch({
    ownerUserId: OWNER,
    batchId: extraView.batch.batchId
  }), 500);

  const sizeRoot = temporaryRoot(t);
  const sizeStore = new BatchEvaluationStore({ rootDir: sizeRoot });
  await sizeStore.ready;
  const sizeView = await sizeStore.createBatch({ ownerUserId: OWNER, source: SOURCE });
  fs.writeFileSync(recordPath(sizeRoot, sizeView.batch.batchId), Buffer.alloc(MAX_BATCH_RECORD_BYTES + 1));
  await expectCode("BATCH_ARCHIVE_CORRUPTED", () => sizeStore.readBatch({
    ownerUserId: OWNER,
    batchId: sizeView.batch.batchId
  }), 500);
});

test("TTL releases the open-batch limit and public reads atomically score every expired slot as missing", async t => {
  let now = Date.parse("2026-08-21T00:00:00.000Z");
  const { store } = await createStore(t, {
    now: () => now,
    batchTtlMs: 1000,
    maxBatches: 1
  });
  const first = await store.createBatch({ ownerUserId: OWNER, source: SOURCE });
  await expectCode("BATCH_LIMIT_REACHED", () => store.createBatch({
    ownerUserId: OWNER,
    source: `${SOURCE}# a distinct concurrent attempt\n`
  }), 429);
  now += 1001;
  const second = await store.createBatch({ ownerUserId: OWNER, source: SOURCE });
  assert.notEqual(second.batch.batchId, first.batch.batchId);
  const expired = await store.readBatch({
    ownerUserId: OWNER,
    batchId: first.batch.batchId
  });
  assert.equal(expired.batch.phase, "finalized");
  assert.equal(expired.batch.finalizationReason, "closed_with_missing");
  assert.equal(expired.batch.summary.missingCount, 5);
  assert.equal(expired.batch.summary.batchScore, 0);
  assert.equal(expired.currentSlot, null);
  assert.deepEqual(await store.closeBatch({
    ownerUserId: OWNER,
    batchId: first.batch.batchId
  }), expired);
  assert.deepEqual(await store.readBatch({
    ownerUserId: OWNER,
    batchId: first.batch.batchId
  }), expired);

  const diskRoot = temporaryRoot(t);
  const diskStore = new BatchEvaluationStore({ rootDir: diskRoot, maxStorageBytes: 1024 });
  await diskStore.ready;
  await expectCode("BATCH_STORAGE_FULL", () => diskStore.createBatch({
    ownerUserId: OWNER,
    source: SOURCE
  }), 507);
});

test("expired execution APIs reject without mutation, then a post-restart public read finalizes the batch", async t => {
  let now = Date.parse("2026-08-21T01:00:00.000Z");
  const rootDir = temporaryRoot(t);
  const store = new BatchEvaluationStore({ rootDir, now: () => now, batchTtlMs: 1000 });
  await store.ready;
  const view = await store.createBatch({ ownerUserId: OWNER, source: SOURCE });
  const binding = sessionBinding(view);
  await store.bindCurrentSlotSession(binding);
  now += 1000;
  const beforeRejectedExecution = fs.readFileSync(recordPath(rootDir, view.batch.batchId));

  await expectCode("BATCH_EXPIRED", () => store.readCurrentSlotForServer({
    ownerUserId: OWNER,
    batchId: view.batch.batchId,
    slotIndex: 1
  }), 410);
  await expectCode("BATCH_EXPIRED", () => store.readSlotExecutionForServer({
    ownerUserId: OWNER,
    batchId: view.batch.batchId,
    slotIndex: 1
  }), 410);
  await expectCode("BATCH_EXPIRED", () => store.bindCurrentSlotSession(binding), 410);
  await expectCode("BATCH_EXPIRED", () => store.submitVerifiedSlotResult(
    verifiedCommand(view, binding)
  ), 410);
  assert.deepEqual(fs.readFileSync(recordPath(rootDir, view.batch.batchId)), beforeRejectedExecution,
    "expired execution attempts cannot mutate the still-open private state");

  const restarted = new BatchEvaluationStore({ rootDir, now: () => now, batchTtlMs: 1000 });
  await restarted.ready;
  const finalized = await restarted.readBatch({ ownerUserId: OWNER, batchId: view.batch.batchId });
  assert.equal(finalized.batch.phase, "finalized");
  assert.equal(finalized.batch.summary.missingCount, 5);
  assert.equal(finalized.batch.summary.batchScore, 0);
  const stored = readRecord(rootDir, view.batch.batchId);
  assert.equal(stored.payload.batchState.phase, "finalized");
  assert.deepEqual(stored.payload.batchState.slots.map(slot => slot.result.status),
    ["missing", "missing", "missing", "missing", "missing"]);
  assert.equal(stored.payload.slotExecutions[0].sessionBinding.sessionId, binding.sessionId);
  assert.equal(stored.payload.slotExecutions[0].verifiedReceipt, null);
});

test("concurrent expired read and close calls persist one deterministic final ranking", async t => {
  let now = Date.parse("2026-08-21T02:00:00.000Z");
  const { store, rootDir } = await createStore(t, {
    now: () => now,
    batchTtlMs: 1000
  });
  const view = await store.createBatch({ ownerUserId: OWNER, source: SOURCE });
  const binding = sessionBinding(view);
  await store.bindCurrentSlotSession(binding);
  const afterFirst = await store.submitVerifiedSlotResult(verifiedCommand(view, binding));
  assert.equal(afterFirst.batch.nextSlotIndex, 2);
  now += 1000;

  const command = { ownerUserId: OWNER, batchId: view.batch.batchId };
  const outcomes = await Promise.all([
    store.readBatch(command),
    store.closeBatch(command),
    store.readBatch(command),
    store.closeBatch(command)
  ]);
  outcomes.slice(1).forEach(candidate => assert.deepEqual(candidate, outcomes[0]));
  const finalized = outcomes[0];
  assert.equal(finalized.batch.phase, "finalized");
  assert.equal(finalized.batch.summary.validCount, 1);
  assert.equal(finalized.batch.summary.missingCount, 4);
  assert.equal(finalized.batch.summary.meanScore, 16);
  assert.equal(finalized.batch.summary.minScore, 0);
  assert.equal(finalized.batch.summary.batchScore, 11.2);

  const bytesAfterConcurrentFinalization = fs.readFileSync(recordPath(rootDir, view.batch.batchId));
  assert.deepEqual(await store.readBatch(command), finalized);
  assert.deepEqual(await store.closeBatch(command), finalized);
  assert.deepEqual(fs.readFileSync(recordPath(rootDir, view.batch.batchId)), bytesAfterConcurrentFinalization,
    "finalized expiry retries are read-only and byte-identical");
});

test("default owner quotas isolate users and closing releases only the open-batch allowance", async t => {
  const { store } = await createStore(t);
  const first = await store.createBatch({ ownerUserId: OWNER, source: SOURCE });
  await store.createBatch({ ownerUserId: OWNER, source: `${SOURCE}# second` });
  await expectCode("OWNER_OPEN_BATCH_LIMIT_REACHED", () => store.createBatch({
    ownerUserId: OWNER,
    source: `${SOURCE}# blocked third`
  }), 429);

  await store.createBatch({ ownerUserId: OTHER_OWNER, source: SOURCE });
  await store.createBatch({ ownerUserId: OTHER_OWNER, source: `${SOURCE}# isolated second` });
  await expectCode("OWNER_OPEN_BATCH_LIMIT_REACHED", () => store.createBatch({
    ownerUserId: OTHER_OWNER,
    source: `${SOURCE}# isolated blocked third`
  }), 429);

  await store.closeBatch({ ownerUserId: OWNER, batchId: first.batch.batchId });
  const replacement = await store.createBatch({ ownerUserId: OWNER, source: `${SOURCE}# replacement` });
  assert.equal(replacement.batch.phase, "open");
  assert.notEqual(replacement.batch.batchId, first.batch.batchId);
});

test("concurrent creates share one owner quota decision inside the archive mutation lock", async t => {
  const { store } = await createStore(t, {
    maxOpenBatchesPerOwner: 1,
    maxRetainedBatchesPerOwner: 5
  });
  const outcomes = await Promise.allSettled([
    store.createBatch({ ownerUserId: OWNER, source: `${SOURCE}# race one` }),
    store.createBatch({ ownerUserId: OWNER, source: `${SOURCE}# race two` })
  ]);
  assert.deepEqual(outcomes.map(item => item.status), ["fulfilled", "rejected"]);
  assert.equal(outcomes[1].reason.code, "OWNER_OPEN_BATCH_LIMIT_REACHED");

  const other = await store.createBatch({ ownerUserId: OTHER_OWNER, source: SOURCE });
  assert.equal(other.batch.phase, "open", "another owner has an independent allowance");
  await store.closeBatch({ ownerUserId: OWNER, batchId: outcomes[0].value.batch.batchId });
  const next = await store.createBatch({ ownerUserId: OWNER, source: `${SOURCE}# after close` });
  assert.equal(next.batch.phase, "open");
});

test("retained quota counts closed and expired records and survives store restart without deleting them", async t => {
  let now = Date.parse("2026-08-21T03:00:00.000Z");
  const rootDir = temporaryRoot(t);
  const options = {
    rootDir,
    now: () => now,
    batchTtlMs: 1000,
    maxOpenBatchesPerOwner: 1,
    maxRetainedBatchesPerOwner: 2
  };
  const store = new BatchEvaluationStore(options);
  await store.ready;
  const closed = await store.createBatch({ ownerUserId: OWNER, source: `${SOURCE}# retained closed` });
  await store.closeBatch({ ownerUserId: OWNER, batchId: closed.batch.batchId });
  const expired = await store.createBatch({ ownerUserId: OWNER, source: `${SOURCE}# retained expired` });
  now += 1000;
  await expectCode("OWNER_BATCH_RETENTION_LIMIT_REACHED", () => store.createBatch({
    ownerUserId: OWNER,
    source: `${SOURCE}# retained blocked`
  }), 429);
  assert.equal(fs.existsSync(path.dirname(recordPath(rootDir, closed.batch.batchId))), true);
  assert.equal(fs.existsSync(path.dirname(recordPath(rootDir, expired.batch.batchId))), true);

  const restarted = new BatchEvaluationStore(options);
  await restarted.ready;
  await expectCode("OWNER_BATCH_RETENTION_LIMIT_REACHED", () => restarted.createBatch({
    ownerUserId: OWNER,
    source: `${SOURCE}# still blocked after restart`
  }), 429);
  const isolated = await restarted.createBatch({ ownerUserId: OTHER_OWNER, source: SOURCE });
  assert.equal(isolated.batch.phase, "open");
  assert.equal(fs.readdirSync(path.join(rootDir, "batches")).length, 3,
    "quota enforcement never deletes retained user batches");
});

test("owner quota configuration has fixed upper bounds and cannot invert open versus retained limits", t => {
  const rootDir = temporaryRoot(t);
  assert.throws(() => new BatchEvaluationStore({
    rootDir,
    maxOpenBatchesPerOwner: MAX_OPEN_BATCHES_PER_OWNER + 1
  }), /maxOpenBatchesPerOwner/);
  assert.throws(() => new BatchEvaluationStore({
    rootDir,
    maxRetainedBatchesPerOwner: MAX_RETAINED_BATCHES_PER_OWNER + 1
  }), /maxRetainedBatchesPerOwner/);
  assert.throws(() => new BatchEvaluationStore({
    rootDir,
    maxOpenBatchesPerOwner: 3,
    maxRetainedBatchesPerOwner: 2
  }), /cannot exceed/);
});
