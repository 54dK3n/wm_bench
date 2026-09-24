"use strict";

const { canonicalJson, canonicalSha256 } = require("./canonical-json.js");

// This module only coordinates and aggregates caller-supplied results. It does
// not execute contestant code, verify a run, persist state, or protect secrets
// after private state leaves a trusted process. Those boundaries are deliberate.
const AUTHORITATIVE = false;
const BATCH_EVALUATION_SCHEMA_VERSION = "chenlong.batch-evaluation/v1";
const BATCH_COMMITMENT_SCHEMA_VERSION = "chenlong.batch-commitment/v1";
const SLOT_RESULT_COMMAND_SCHEMA_VERSION = "chenlong.batch-slot-result-command/v1";
const BATCH_CLOSE_COMMAND_SCHEMA_VERSION = "chenlong.batch-close-command/v1";
const FIXED_SLOT_COUNT = 5;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_PRIVATE_SLOT_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_COUNT = 1_000_000_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMITMENT_NONCE_PATTERN = /^[a-f0-9]{64}$/;
const PUBLIC_RESULT_STATUSES = new Set(["valid", "invalid", "timeout"]);
const INTERNAL_RESULT_STATUSES = new Set([...PUBLIC_RESULT_STATUSES, "missing"]);

const RANKING_ORDER = Object.freeze([
  Object.freeze({ field: "batchScore", direction: "desc" }),
  Object.freeze({ field: "completedCount", direction: "desc" }),
  // A zero-point, fully recomputed attempt must rank above an invalid or
  // absent result. Otherwise those normalized zero safety counters create a
  // perverse incentive to avoid producing a valid run record.
  Object.freeze({ field: "validCount", direction: "desc" }),
  Object.freeze({ field: "minScore", direction: "desc" }),
  Object.freeze({ field: "meanScore", direction: "desc" }),
  Object.freeze({ field: "invalidCount", direction: "asc" }),
  Object.freeze({ field: "missingCount", direction: "asc" }),
  Object.freeze({ field: "timeoutCount", direction: "asc" }),
  Object.freeze({ field: "collisionCount", direction: "asc" }),
  Object.freeze({ field: "outOfBoundsCount", direction: "asc" })
]);

class BatchEvaluationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BatchEvaluationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new BatchEvaluationError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactObject(value, requiredKeys, optionalKeys, code, label) {
  if (!isPlainObject(value)) fail(code, `${label} must be a plain object`);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code, `${label} contains unsupported field ${key}`);
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(code, `${label}.${key} is required`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function canonicalClone(value, code, label, maximumBytes = Infinity) {
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    fail(code, `${label} must be canonical JSON: ${error.message}`);
  }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    fail(code, `${label} exceeds its size limit`);
  }
  return JSON.parse(serialized);
}

function normalizeBatchId(value) {
  if (typeof value !== "string" || !BATCH_ID_PATTERN.test(value)) {
    fail("INVALID_BATCH_CONFIG", "batchId must contain 1-128 ASCII letters, numbers, '.', '_' or '-'");
  }
  return value;
}

function normalizeSource(value) {
  if (typeof value !== "string") fail("INVALID_SOURCE", "source must be a string");
  const byteLength = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (byteLength < 2 || byteLength > MAX_SOURCE_BYTES) {
    fail("INVALID_SOURCE", `source must be no larger than ${MAX_SOURCE_BYTES} encoded bytes`);
  }
  return value;
}

function digestSource(source) {
  return canonicalSha256(normalizeSource(source));
}

function normalizeCommitmentNonce(value) {
  if (typeof value !== "string" || !COMMITMENT_NONCE_PATTERN.test(value)) {
    fail("INVALID_COMMITMENT", "commitment nonce must be 64 lowercase hexadecimal characters");
  }
  return value;
}

function normalizePrivateSlots(value) {
  if (!Array.isArray(value) || value.length !== FIXED_SLOT_COUNT) {
    fail("INVALID_BATCH_CONFIG", `privateSlots must contain exactly ${FIXED_SLOT_COUNT} entries`);
  }
  return value.map((slot, index) => {
    if (!isPlainObject(slot)) {
      fail("INVALID_BATCH_CONFIG", `privateSlots[${index}] must be a plain object`);
    }
    return canonicalClone(slot, "INVALID_BATCH_CONFIG", `privateSlots[${index}]`, MAX_PRIVATE_SLOT_BYTES);
  });
}

function normalizeEventCount(value, field, code = "INVALID_SLOT_RESULT") {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EVENT_COUNT) {
    fail(code, `${field} must be an integer between 0 and ${MAX_EVENT_COUNT}`);
  }
  return value;
}

function normalizeSlotResult(value, { allowMissing = false, code = "INVALID_SLOT_RESULT" } = {}) {
  assertExactObject(
    value,
    ["status", "score", "completed", "collisionCount", "outOfBoundsCount"],
    [],
    code,
    "result"
  );
  const allowedStatuses = allowMissing ? INTERNAL_RESULT_STATUSES : PUBLIC_RESULT_STATUSES;
  if (typeof value.status !== "string" || !allowedStatuses.has(value.status)) {
    fail(code, `result.status must be ${[...allowedStatuses].join(", ")}`);
  }
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 100) {
    fail(code, "result.score must be a finite number between 0 and 100");
  }
  if (typeof value.completed !== "boolean") fail(code, "result.completed must be boolean");
  const collisionCount = normalizeEventCount(value.collisionCount, "result.collisionCount", code);
  const outOfBoundsCount = normalizeEventCount(value.outOfBoundsCount, "result.outOfBoundsCount", code);
  const score = Object.is(value.score, -0) ? 0 : value.score;
  if (value.status !== "valid" && (score !== 0 || value.completed !== false)) {
    fail(code, `${value.status} results must have score 0 and completed false`);
  }
  return deepFreeze({
    status: value.status,
    score,
    completed: value.completed,
    collisionCount,
    outOfBoundsCount
  });
}

function missingResult() {
  return deepFreeze({
    status: "missing",
    score: 0,
    completed: false,
    collisionCount: 0,
    outOfBoundsCount: 0
  });
}

function commitmentForState(state, nonce) {
  return deepFreeze({
    schemaVersion: BATCH_COMMITMENT_SCHEMA_VERSION,
    nonce,
    batchId: state.batchId,
    sourceDigest: state.sourceDigest,
    slotCount: FIXED_SLOT_COUNT,
    privateSlotsDigest: canonicalSha256(state.slots.map(slot => slot.privateValue))
  });
}

function verifyBatchCommitment(state) {
  try {
    if (!state?.commitment || !SHA256_PATTERN.test(state?.commitmentDigest || "")) return false;
    const expected = commitmentForState(state, state.commitment.nonce);
    return canonicalJson(expected) === canonicalJson(state.commitment)
      && canonicalSha256(expected) === state.commitmentDigest;
  } catch (_error) {
    return false;
  }
}

function assertState(state) {
  if (!isPlainObject(state)
    || state.schemaVersion !== BATCH_EVALUATION_SCHEMA_VERSION
    || state.authoritative !== AUTHORITATIVE
    || !BATCH_ID_PATTERN.test(state.batchId || "")
    || !SHA256_PATTERN.test(state.sourceDigest || "")
    || !Array.isArray(state.slots)
    || state.slots.length !== FIXED_SLOT_COUNT) {
    fail("INVALID_BATCH_STATE", "batch evaluation state is invalid");
  }
  let firstPending = null;
  let sawMissing = false;
  for (let index = 0; index < FIXED_SLOT_COUNT; index += 1) {
    const slot = state.slots[index];
    if (!isPlainObject(slot)
      || slot.slotIndex !== index + 1
      || !isPlainObject(slot.privateValue)
      || canonicalSha256(slot.privateValue) !== slot.privateDigest) {
      fail("INVALID_BATCH_STATE", `batch evaluation private slot ${index + 1} is invalid`);
    }
    if (slot.result === null) {
      if (firstPending === null) firstPending = index + 1;
      if (slot.submissionDigest !== null) {
        fail("INVALID_BATCH_STATE", `pending slot ${index + 1} has a submission digest`);
      }
      continue;
    }
    if (firstPending !== null) fail("INVALID_BATCH_STATE", "finalized slots must form a prefix");
    const normalized = normalizeSlotResult(slot.result, { allowMissing: true, code: "INVALID_BATCH_STATE" });
    if (canonicalJson(normalized) !== canonicalJson(slot.result)) {
      fail("INVALID_BATCH_STATE", `slot ${index + 1} result is not normalized`);
    }
    if (slot.result.status === "missing") {
      sawMissing = true;
      if (slot.submissionDigest !== null) {
        fail("INVALID_BATCH_STATE", `missing slot ${index + 1} cannot have a submission digest`);
      }
    } else {
      if (sawMissing || !SHA256_PATTERN.test(slot.submissionDigest || "")) {
        fail("INVALID_BATCH_STATE", `slot ${index + 1} finalization order is invalid`);
      }
    }
  }
  if (state.commitment === null) {
    if (state.commitmentDigest !== null) fail("INVALID_BATCH_STATE", "unbound state has a commitment digest");
  } else if (!verifyBatchCommitment(state)) {
    fail("INVALID_BATCH_STATE", "batch commitment binding is invalid");
  }
  if (state.phase === "open") {
    if (firstPending === null || sawMissing || state.nextSlotIndex !== firstPending
      || state.finalizationReason !== null || state.closeCommandDigest !== null) {
      fail("INVALID_BATCH_STATE", "open batch state is inconsistent");
    }
  } else if (state.phase === "finalized") {
    if (firstPending !== null || state.nextSlotIndex !== null) {
      fail("INVALID_BATCH_STATE", "finalized batch still contains pending slots");
    }
    if (state.finalizationReason === "all_slots_reported") {
      if (sawMissing || state.closeCommandDigest !== null) {
        fail("INVALID_BATCH_STATE", "reported batch finalization is inconsistent");
      }
    } else if (state.finalizationReason === "closed_with_missing") {
      if (!sawMissing || !SHA256_PATTERN.test(state.closeCommandDigest || "")) {
        fail("INVALID_BATCH_STATE", "missing batch finalization is inconsistent");
      }
    } else {
      fail("INVALID_BATCH_STATE", "batch finalization reason is invalid");
    }
  } else {
    fail("INVALID_BATCH_STATE", "batch phase is invalid");
  }
  return state;
}

function createBatchEvaluationState(options) {
  assertExactObject(
    options,
    ["batchId", "source", "privateSlots"],
    ["commitmentNonce"],
    "INVALID_BATCH_CONFIG",
    "options"
  );
  const batchId = normalizeBatchId(options.batchId);
  const sourceDigest = digestSource(options.source);
  const privateSlots = normalizePrivateSlots(options.privateSlots);
  let state = deepFreeze({
    schemaVersion: BATCH_EVALUATION_SCHEMA_VERSION,
    authoritative: AUTHORITATIVE,
    batchId,
    sourceDigest,
    phase: "open",
    nextSlotIndex: 1,
    finalizationReason: null,
    closeCommandDigest: null,
    commitment: null,
    commitmentDigest: null,
    slots: privateSlots.map((privateValue, index) => deepFreeze({
      slotIndex: index + 1,
      privateValue: deepFreeze(privateValue),
      privateDigest: canonicalSha256(privateValue),
      result: null,
      submissionDigest: null
    }))
  });
  if (Object.prototype.hasOwnProperty.call(options, "commitmentNonce")) {
    state = bindBatchCommitment(state, { nonce: options.commitmentNonce });
  }
  return assertState(state);
}

function bindBatchCommitment(state, command) {
  assertState(state);
  assertExactObject(command, ["nonce"], [], "INVALID_COMMITMENT", "commitment command");
  const nonce = normalizeCommitmentNonce(command.nonce);
  if (state.commitment) {
    if (state.commitment.nonce === nonce) return state;
    fail("COMMITMENT_LOCKED", "batch commitment is already bound");
  }
  if (state.slots.some(slot => slot.result !== null)) {
    fail("COMMITMENT_TOO_LATE", "batch commitment must be bound before the first slot result");
  }
  const commitment = commitmentForState(state, nonce);
  return assertState(deepFreeze({
    ...state,
    commitment,
    commitmentDigest: canonicalSha256(commitment)
  }));
}

function assertLockedSource(state, source) {
  if (digestSource(source) !== state.sourceDigest) {
    fail("SOURCE_LOCKED", "this batch is locked to a different source document");
  }
}

function submitSlotResult(state, command) {
  assertState(state);
  assertExactObject(
    command,
    ["source", "slotIndex", "result"],
    [],
    "INVALID_SLOT_COMMAND",
    "slot result command"
  );
  assertLockedSource(state, command.source);
  if (!Number.isInteger(command.slotIndex)
    || command.slotIndex < 1
    || command.slotIndex > FIXED_SLOT_COUNT) {
    fail("INVALID_SLOT_COMMAND", `slotIndex must be an integer between 1 and ${FIXED_SLOT_COUNT}`);
  }
  const result = normalizeSlotResult(command.result);
  const submissionDigest = canonicalSha256({
    schemaVersion: SLOT_RESULT_COMMAND_SCHEMA_VERSION,
    source: command.source,
    slotIndex: command.slotIndex,
    result
  });
  const existing = state.slots[command.slotIndex - 1];
  if (existing.result !== null) {
    if (existing.submissionDigest === submissionDigest) return state;
    fail("SLOT_ALREADY_FINALIZED", `slot ${command.slotIndex} already has its only final result`);
  }
  if (state.phase === "finalized") fail("BATCH_FINALIZED", "batch evaluation is already finalized");
  if (command.slotIndex !== state.nextSlotIndex) {
    fail("SLOT_OUT_OF_ORDER", `slot ${state.nextSlotIndex} must be finalized next`);
  }
  const slots = state.slots.map((slot, index) => index === command.slotIndex - 1
    ? deepFreeze({ ...slot, result, submissionDigest })
    : slot);
  const nextSlotIndex = slots.find(slot => slot.result === null)?.slotIndex || null;
  return assertState(deepFreeze({
    ...state,
    slots: deepFreeze(slots),
    phase: nextSlotIndex === null ? "finalized" : "open",
    nextSlotIndex,
    finalizationReason: nextSlotIndex === null ? "all_slots_reported" : null,
    closeCommandDigest: null
  }));
}

function finalizeBatchEvaluation(state, command) {
  assertState(state);
  assertExactObject(command, ["source"], [], "INVALID_CLOSE_COMMAND", "close command");
  assertLockedSource(state, command.source);
  if (state.phase === "finalized") return state;
  const closeCommandDigest = canonicalSha256({
    schemaVersion: BATCH_CLOSE_COMMAND_SCHEMA_VERSION,
    source: command.source
  });
  const slots = state.slots.map(slot => slot.result === null
    ? deepFreeze({ ...slot, result: missingResult(), submissionDigest: null })
    : slot);
  return assertState(deepFreeze({
    ...state,
    slots: deepFreeze(slots),
    phase: "finalized",
    nextSlotIndex: null,
    finalizationReason: "closed_with_missing",
    closeCommandDigest
  }));
}

function roundTwo(value) {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function summarizeBatchEvaluation(state) {
  assertState(state);
  const effectiveResults = state.slots.map(slot => slot.result || missingResult());
  const scores = effectiveResults.map(result => result.status === "valid" ? result.score : 0);
  const scoreTotal = scores.reduce((sum, score) => sum + score, 0);
  const exactMean = scoreTotal / FIXED_SLOT_COUNT;
  const exactMin = Math.min(...scores);
  const countStatus = status => state.slots.filter(slot => slot.result?.status === status).length;
  const finalizedCount = state.slots.filter(slot => slot.result !== null).length;
  const summary = {
    slotCount: FIXED_SLOT_COUNT,
    finalizedCount,
    pendingCount: FIXED_SLOT_COUNT - finalizedCount,
    validCount: countStatus("valid"),
    invalidCount: countStatus("invalid"),
    timeoutCount: countStatus("timeout"),
    missingCount: countStatus("missing"),
    completedCount: effectiveResults.filter(result => result.completed).length,
    minScore: roundTwo(exactMin),
    meanScore: roundTwo(exactMean),
    batchScore: roundTwo(0.70 * exactMean + 0.30 * exactMin),
    collisionCount: effectiveResults.reduce((sum, result) => sum + result.collisionCount, 0),
    outOfBoundsCount: effectiveResults.reduce((sum, result) => sum + result.outOfBoundsCount, 0)
  };
  const ranking = {};
  RANKING_ORDER.forEach(({ field }) => {
    ranking[field] = summary[field];
  });
  return deepFreeze({ summary: deepFreeze(summary), ranking: deepFreeze(ranking) });
}

function publicBatchProjection(state) {
  assertState(state);
  const { summary, ranking } = summarizeBatchEvaluation(state);
  return deepFreeze({
    schemaVersion: BATCH_EVALUATION_SCHEMA_VERSION,
    authoritative: AUTHORITATIVE,
    batchId: state.batchId,
    sourceDigest: state.sourceDigest,
    commitmentDigest: state.commitmentDigest,
    phase: state.phase,
    finalizationReason: state.finalizationReason,
    nextSlotIndex: state.nextSlotIndex,
    slotCount: FIXED_SLOT_COUNT,
    slots: state.slots.map(slot => {
      const result = slot.result || missingResult();
      return deepFreeze({
        slotIndex: slot.slotIndex,
        final: slot.result !== null,
        status: slot.result?.status || "pending",
        score: slot.result?.status === "valid" ? result.score : 0,
        completed: slot.result?.completed || false,
        collisionCount: slot.result?.collisionCount || 0,
        outOfBoundsCount: slot.result?.outOfBoundsCount || 0
      });
    }),
    summary,
    ranking
  });
}

function assertRankableProjection(value, label) {
  if (!isPlainObject(value)
    || value.schemaVersion !== BATCH_EVALUATION_SCHEMA_VERSION
    || value.authoritative !== AUTHORITATIVE
    || value.phase !== "finalized"
    || !isPlainObject(value.ranking)
    || typeof value.batchId !== "string"
    || !SHA256_PATTERN.test(value.sourceDigest || "")) {
    fail("INVALID_RANKING_INPUT", `${label} must be a finalized public batch projection`);
  }
  RANKING_ORDER.forEach(({ field }) => {
    if (typeof value.ranking[field] !== "number" || !Number.isFinite(value.ranking[field])) {
      fail("INVALID_RANKING_INPUT", `${label}.ranking.${field} must be finite`);
    }
  });
}

function compareBatchPublicProjections(left, right) {
  assertRankableProjection(left, "left");
  assertRankableProjection(right, "right");
  for (const { field, direction } of RANKING_ORDER) {
    if (left.ranking[field] === right.ranking[field]) continue;
    return direction === "desc"
      ? right.ranking[field] - left.ranking[field]
      : left.ranking[field] - right.ranking[field];
  }
  const batchOrder = left.batchId.localeCompare(right.batchId, "en");
  if (batchOrder !== 0) return batchOrder;
  return left.sourceDigest.localeCompare(right.sourceDigest, "en");
}

module.exports = {
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
};
