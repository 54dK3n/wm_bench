"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUTHORITATIVE,
  BATCH_EVALUATION_SCHEMA_VERSION,
  BATCH_COMMITMENT_SCHEMA_VERSION,
  FIXED_SLOT_COUNT,
  RANKING_ORDER,
  BatchEvaluationError,
  digestSource,
  createBatchEvaluationState,
  bindBatchCommitment,
  verifyBatchCommitment,
  submitSlotResult,
  finalizeBatchEvaluation,
  summarizeBatchEvaluation,
  publicBatchProjection,
  compareBatchPublicProjections
} = require("../backend/batch-evaluation-core.js");

const SOURCE = "from robot import *\nprint(road_state())\n";
const NONCE = "a".repeat(64);

function privateSlots() {
  return Array.from({ length: FIXED_SLOT_COUNT }, (_value, index) => ({
    seed: 9100 + index,
    layoutId: `secret-layout-${index + 1}`,
    anchor: { x: index + 0.25, z: index + 0.75 },
    definition: { hiddenObject: `private-object-${index + 1}` }
  }));
}

function result({
  status = "valid",
  score = 80,
  completed = true,
  collisionCount = 0,
  outOfBoundsCount = 0
} = {}) {
  return { status, score, completed, collisionCount, outOfBoundsCount };
}

function create(options = {}) {
  return createBatchEvaluationState({
    batchId: options.batchId || "batch-001",
    source: options.source ?? SOURCE,
    privateSlots: options.privateSlots || privateSlots(),
    ...(options.commitmentNonce ? { commitmentNonce: options.commitmentNonce } : {})
  });
}

function submit(state, slotIndex, slotResult, source = SOURCE) {
  return submitSlotResult(state, { source, slotIndex, result: slotResult });
}

function submitAll(state, results, source = SOURCE) {
  return results.reduce((current, slotResult, index) => submit(current, index + 1, slotResult, source), state);
}

function expectCode(expectedCode, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof BatchEvaluationError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

test("batch source and exactly five private slots are locked at creation", () => {
  const inputSlots = privateSlots();
  const state = create({ privateSlots: inputSlots });
  assert.equal(AUTHORITATIVE, false);
  assert.equal(FIXED_SLOT_COUNT, 5);
  assert.equal(state.authoritative, false);
  assert.equal(state.sourceDigest, digestSource(SOURCE));
  assert.equal(state.nextSlotIndex, 1);
  assert.equal(state.slots.length, 5);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.slots));
  assert.ok(Object.isFrozen(state.slots[0].privateValue));

  inputSlots[0].seed = -1;
  inputSlots[0].anchor.x = -1;
  assert.equal(state.slots[0].privateValue.seed, 9100);
  assert.equal(state.slots[0].privateValue.anchor.x, 0.25);
  assert.throws(() => {
    state.slots[0].privateValue.seed = 0;
  }, TypeError);

  expectCode("INVALID_BATCH_CONFIG", () => createBatchEvaluationState({
    batchId: "batch-short",
    source: SOURCE,
    privateSlots: privateSlots().slice(0, 4)
  }));
  expectCode("INVALID_BATCH_CONFIG", () => createBatchEvaluationState({
    batchId: "batch-long",
    source: SOURCE,
    privateSlots: [...privateSlots(), {}]
  }));
});

test("private commitment binds the locked source and all private slots without public disclosure", () => {
  const state = create({ commitmentNonce: NONCE });
  assert.equal(state.commitment.schemaVersion, BATCH_COMMITMENT_SCHEMA_VERSION);
  assert.equal(state.commitment.sourceDigest, digestSource(SOURCE));
  assert.equal(state.commitment.slotCount, 5);
  assert.equal(state.commitment.nonce, NONCE);
  assert.match(state.commitment.privateSlotsDigest, /^[a-f0-9]{64}$/);
  assert.match(state.commitmentDigest, /^[a-f0-9]{64}$/);
  assert.equal(verifyBatchCommitment(state), true);

  const projection = publicBatchProjection(state);
  const serialized = JSON.stringify(projection);
  assert.deepEqual(Object.keys(projection).sort(), [
    "authoritative",
    "batchId",
    "commitmentDigest",
    "finalizationReason",
    "nextSlotIndex",
    "phase",
    "ranking",
    "schemaVersion",
    "slotCount",
    "slots",
    "sourceDigest",
    "summary"
  ]);
  assert.deepEqual(Object.keys(projection.slots[0]).sort(), [
    "collisionCount",
    "completed",
    "final",
    "outOfBoundsCount",
    "score",
    "slotIndex",
    "status"
  ]);
  assert.equal(projection.schemaVersion, BATCH_EVALUATION_SCHEMA_VERSION);
  assert.equal(projection.authoritative, false);
  assert.equal(projection.commitmentDigest, state.commitmentDigest);
  assert.equal(serialized.includes(NONCE), false);
  for (const secret of ["secret-layout", "private-object", "9100", '"seed"', '"layoutId"', '"anchor"', '"definition"']) {
    assert.equal(serialized.includes(secret), false, `public projection leaked ${secret}`);
  }
  assert.equal(serialized.includes(SOURCE), false);

  const tampered = {
    ...state,
    slots: state.slots.map((slot, index) => index === 2
      ? { ...slot, privateValue: { ...slot.privateValue, seed: 1 } }
      : slot)
  };
  assert.equal(verifyBatchCommitment(tampered), false);
  expectCode("INVALID_BATCH_STATE", () => publicBatchProjection(tampered));
});

test("commitment binding is deterministic, idempotent, immutable, and must precede results", () => {
  const initial = create();
  const bound = bindBatchCommitment(initial, { nonce: NONCE });
  assert.equal(bindBatchCommitment(bound, { nonce: NONCE }), bound);
  assert.equal(verifyBatchCommitment(bound), true);
  expectCode("COMMITMENT_LOCKED", () => bindBatchCommitment(bound, { nonce: "b".repeat(64) }));

  const started = submit(initial, 1, result());
  expectCode("COMMITMENT_TOO_LATE", () => bindBatchCommitment(started, { nonce: NONCE }));
  expectCode("INVALID_COMMITMENT", () => bindBatchCommitment(initial, { nonce: "predictable" }));
});

test("slot state machine rejects source replacement, skipped slots, and best-of retries", () => {
  const initial = create();
  const firstResult = result({ score: 72.5, completed: false, collisionCount: 2 });
  expectCode("SOURCE_LOCKED", () => submit(initial, 1, firstResult, `${SOURCE}# changed`));
  expectCode("SLOT_OUT_OF_ORDER", () => submit(initial, 2, firstResult));
  assert.equal(initial.nextSlotIndex, 1);

  const afterFirst = submit(initial, 1, firstResult);
  assert.equal(afterFirst.nextSlotIndex, 2);
  assert.equal(submit(afterFirst, 1, {
    outOfBoundsCount: 0,
    completed: false,
    score: 72.5,
    status: "valid",
    collisionCount: 2
  }), afterFirst, "canonical-identical retry must be idempotent");
  expectCode("SLOT_ALREADY_FINALIZED", () => submit(afterFirst, 1, result({ score: 99 })));
  expectCode("SLOT_OUT_OF_ORDER", () => submit(afterFirst, 3, result({ score: 99 })));
  assert.deepEqual(afterFirst.slots[0].result, firstResult);
});

test("invalid and timeout results are final zeroes and cannot carry an optimistic score", () => {
  const invalid = result({ status: "invalid", score: 0, completed: false, collisionCount: 3 });
  const timedOut = result({ status: "timeout", score: 0, completed: false, outOfBoundsCount: 2 });
  let state = create();
  state = submit(state, 1, invalid);
  state = submit(state, 2, timedOut);
  assert.equal(state.slots[0].result.score, 0);
  assert.equal(state.slots[1].result.score, 0);
  expectCode("INVALID_SLOT_RESULT", () => submit(create(), 1, result({
    status: "invalid",
    score: 90,
    completed: false
  })));
  expectCode("INVALID_SLOT_RESULT", () => submit(create(), 1, result({
    status: "timeout",
    score: 0,
    completed: true
  })));
});

test("closing a batch marks every remaining slot missing once and scores all five slots", () => {
  let state = create();
  state = submit(state, 1, result({ score: 100, collisionCount: 1 }));
  state = submit(state, 2, result({ score: 80, completed: false, outOfBoundsCount: 2 }));
  state = submit(state, 3, result({ status: "invalid", score: 0, completed: false, collisionCount: 4 }));
  state = submit(state, 4, result({ status: "timeout", score: 0, completed: false, outOfBoundsCount: 3 }));
  const finalized = finalizeBatchEvaluation(state, { source: SOURCE });
  assert.equal(finalized.phase, "finalized");
  assert.equal(finalized.finalizationReason, "closed_with_missing");
  assert.equal(finalized.slots[4].result.status, "missing");
  assert.equal(finalized.slots[4].result.score, 0);
  assert.equal(finalizeBatchEvaluation(finalized, { source: SOURCE }), finalized);
  expectCode("SOURCE_LOCKED", () => finalizeBatchEvaluation(finalized, { source: "different" }));
  expectCode("SLOT_ALREADY_FINALIZED", () => submit(finalized, 5, result({ score: 100 })));

  const { summary, ranking } = summarizeBatchEvaluation(finalized);
  assert.deepEqual(summary, {
    slotCount: 5,
    finalizedCount: 5,
    pendingCount: 0,
    validCount: 2,
    invalidCount: 1,
    timeoutCount: 1,
    missingCount: 1,
    completedCount: 1,
    minScore: 0,
    meanScore: 36,
    batchScore: 25.2,
    collisionCount: 5,
    outOfBoundsCount: 5
  });
  assert.deepEqual(Object.keys(ranking), RANKING_ORDER.map(item => item.field));
  assert.deepEqual(ranking, {
    batchScore: 25.2,
    completedCount: 1,
    validCount: 2,
    minScore: 0,
    meanScore: 36,
    invalidCount: 1,
    missingCount: 1,
    timeoutCount: 1,
    collisionCount: 5,
    outOfBoundsCount: 5
  });
});

test("a running projection treats unresolved slots as zero without pretending they are final", () => {
  const state = submit(create(), 1, result({ score: 50, completed: true }));
  const projection = publicBatchProjection(state);
  assert.equal(projection.phase, "open");
  assert.equal(projection.nextSlotIndex, 2);
  assert.deepEqual(projection.slots.map(slot => slot.status), ["valid", "pending", "pending", "pending", "pending"]);
  assert.deepEqual(projection.slots.map(slot => slot.score), [50, 0, 0, 0, 0]);
  assert.equal(projection.summary.finalizedCount, 1);
  assert.equal(projection.summary.pendingCount, 4);
  assert.equal(projection.summary.missingCount, 0);
  assert.equal(projection.summary.meanScore, 10);
  assert.equal(projection.summary.minScore, 0);
  assert.equal(projection.summary.batchScore, 7);
  expectCode("INVALID_RANKING_INPUT", () => compareBatchPublicProjections(projection, projection));
});

test("five reported slots finalize automatically and use the exact 70/30 formula", () => {
  const scores = [90, 80, 70, 60, 50];
  const state = submitAll(create(), scores.map((score, index) => result({
    score,
    completed: index !== 4,
    collisionCount: index === 0 ? 1 : 0,
    outOfBoundsCount: index === 1 ? 1 : 0
  })));
  assert.equal(state.phase, "finalized");
  assert.equal(state.finalizationReason, "all_slots_reported");
  assert.equal(state.nextSlotIndex, null);
  assert.equal(state.closeCommandDigest, null);
  const projection = publicBatchProjection(state);
  assert.equal(projection.summary.meanScore, 70);
  assert.equal(projection.summary.minScore, 50);
  assert.equal(projection.summary.batchScore, 64);
  assert.equal(projection.summary.completedCount, 4);
  assert.equal(finalizeBatchEvaluation(state, { source: SOURCE }), state);
});

test("aggregation rounds only the exposed mean and final weighted score to two decimals", () => {
  const state = submitAll(create(), [12.344, 12.345, 12.346, 12.347, 12.348].map(score => result({ score })));
  const { summary } = summarizeBatchEvaluation(state);
  const exactMean = (12.344 + 12.345 + 12.346 + 12.347 + 12.348) / 5;
  assert.equal(summary.meanScore, 12.35);
  assert.equal(summary.minScore, 12.34);
  assert.equal(summary.batchScore, Math.round((0.7 * exactMean + 0.3 * 12.344 + Number.EPSILON) * 100) / 100);
});

test("slot result commands have a strict bounded schema", () => {
  const base = create();
  for (const badResult of [
    { ...result(), score: NaN },
    { ...result(), score: Infinity },
    { ...result(), score: -1 },
    { ...result(), score: 101 },
    { ...result(), collisionCount: -1 },
    { ...result(), outOfBoundsCount: 1.5 },
    { ...result(), extra: true },
    { ...result(), status: "missing" }
  ]) {
    expectCode("INVALID_SLOT_RESULT", () => submit(base, 1, badResult));
  }
  expectCode("INVALID_SLOT_COMMAND", () => submitSlotResult(base, {
    source: SOURCE,
    slotIndex: 1,
    result: result(),
    bestOf: true
  }));
  expectCode("INVALID_SLOT_COMMAND", () => submitSlotResult(base, {
    source: SOURCE,
    slotIndex: 1.5,
    result: result()
  }));
});

test("ranking comparator follows published metrics and has deterministic final ties", () => {
  const makeProjection = ({ batchId, completed = 5, collisions = 0, outOfBounds = 0 }) => {
    const results = Array.from({ length: 5 }, (_value, index) => result({
      score: 80,
      completed: index < completed,
      collisionCount: index === 0 ? collisions : 0,
      outOfBoundsCount: index === 0 ? outOfBounds : 0
    }));
    return publicBatchProjection(submitAll(create({ batchId }), results));
  };
  const best = makeProjection({ batchId: "batch-a", completed: 5, collisions: 0 });
  const fewerCompleted = makeProjection({ batchId: "batch-b", completed: 4, collisions: 0 });
  const moreCollisions = makeProjection({ batchId: "batch-c", completed: 5, collisions: 2 });
  const tiedLaterId = makeProjection({ batchId: "batch-z", completed: 5, collisions: 0 });
  const ordered = [fewerCompleted, tiedLaterId, moreCollisions, best].sort(compareBatchPublicProjections);
  assert.deepEqual(ordered.map(item => item.batchId), ["batch-a", "batch-z", "batch-c", "batch-b"]);
  assert.ok(compareBatchPublicProjections(best, fewerCompleted) < 0);
  assert.ok(compareBatchPublicProjections(best, moreCollisions) < 0);
  assert.ok(compareBatchPublicProjections(best, tiedLaterId) < 0);
});

test("ranking never rewards invalid or missing slots for their normalized zero safety counters", () => {
  const validFailure = publicBatchProjection(submitAll(
    create({ batchId: "batch-valid" }),
    Array.from({ length: 5 }, (_value, index) => result({
      score: 0,
      completed: false,
      collisionCount: index === 0 ? 4 : 0,
      outOfBoundsCount: index === 0 ? 2 : 0
    }))
  ));
  const invalidFailure = publicBatchProjection(submitAll(
    create({ batchId: "batch-invalid" }),
    Array.from({ length: 5 }, () => result({ status: "invalid", score: 0, completed: false }))
  ));
  const missingFailure = publicBatchProjection(finalizeBatchEvaluation(
    create({ batchId: "batch-missing" }),
    { source: SOURCE }
  ));
  const saferValidFailure = publicBatchProjection(submitAll(
    create({ batchId: "batch-valid-safe" }),
    Array.from({ length: 5 }, () => result({ score: 0, completed: false }))
  ));

  assert.ok(compareBatchPublicProjections(validFailure, invalidFailure) < 0,
    "a verified zero-score attempt must beat an invalid record");
  assert.ok(compareBatchPublicProjections(validFailure, missingFailure) < 0,
    "a verified zero-score attempt must beat an absent record");
  assert.ok(compareBatchPublicProjections(missingFailure, invalidFailure) < 0,
    "an absent record is ranked above an integrity-invalid record at an otherwise exact tie");
  assert.ok(compareBatchPublicProjections(saferValidFailure, validFailure) < 0,
    "safety counters break ties only after result quality is identical");
});
