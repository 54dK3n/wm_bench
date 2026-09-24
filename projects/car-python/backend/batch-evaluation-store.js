"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { canonicalJson, canonicalSha256 } = require("./canonical-json.js");
const {
  AUTHORITATIVE,
  BATCH_EVALUATION_SCHEMA_VERSION,
  BATCH_COMMITMENT_SCHEMA_VERSION,
  FIXED_SLOT_COUNT,
  BatchEvaluationError,
  digestSource,
  createBatchEvaluationState,
  verifyBatchCommitment,
  submitSlotResult,
  finalizeBatchEvaluation,
  publicBatchProjection,
  RANKING_ORDER,
  compareBatchPublicProjections
} = require("./batch-evaluation-core.js");
const {
  selectGuangyangLayoutSequence,
  projectPublicLayoutSelection
} = require("./guangyang-private-layout-catalog.js");
const { normalizeParticipantId } = require("./submission-store.js");

const BATCH_STORE_RECORD_SCHEMA_VERSION = "chenlong.batch-evaluation-store-record/v1";
const BATCH_STORE_PAYLOAD_SCHEMA_VERSION = "chenlong.batch-evaluation-store-private/v1";
const BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2 = "chenlong.batch-evaluation-store-private/v2";
const RANKED_EVALUATION_POLICY_SCHEMA_VERSION = "chenlong.ranked-evaluation-policy/v1";
const BATCH_SLOT_SESSION_BINDING_SCHEMA_VERSION = "chenlong.batch-slot-session-binding/v1";
const BATCH_SLOT_SESSION_BINDING_SCHEMA_VERSION_V2 = "chenlong.batch-slot-session-binding/v2";
const BATCH_SLOT_VERIFIED_RECEIPT_SCHEMA_VERSION = "chenlong.batch-slot-verified-receipt/v1";
const BATCH_SLOT_VERIFIED_RECEIPT_SCHEMA_VERSION_V2 = "chenlong.batch-slot-verified-receipt/v2";
const BATCH_SLOT_VERIFIED_COMMAND_SCHEMA_VERSION = "chenlong.batch-slot-verified-command/v1";
const BATCH_SLOT_VERIFIED_COMMAND_SCHEMA_VERSION_V2 = "chenlong.batch-slot-verified-command/v2";
const RANKED_ATTEMPT_LEDGER_RECORD_SCHEMA_VERSION = "chenlong.ranked-attempt-ledger-record/v1";
const RANKED_ATTEMPT_LEDGER_PAYLOAD_SCHEMA_VERSION = "chenlong.ranked-attempt-ledger/v1";
const DEFAULT_BATCH_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BATCH_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BATCHES = 100;
const MAX_BATCHES = 1000;
const DEFAULT_MAX_OPEN_BATCHES_PER_OWNER = 2;
const MAX_OPEN_BATCHES_PER_OWNER = 100;
const DEFAULT_MAX_RETAINED_BATCHES_PER_OWNER = 20;
const MAX_RETAINED_BATCHES_PER_OWNER = 1000;
const DEFAULT_MAX_STORAGE_BYTES = 256 * 1024 * 1024;
const MAX_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_BATCH_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_LOCKED_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_RANKED_LOCKED_SOURCE_BYTES = 128 * 1024;
const MAX_ARCHIVED_BATCH_DIRECTORIES = 10_000;
const MAX_RANKED_ATTEMPT_LEDGER_BYTES = 16 * 1024;
const MAX_DISCOVERED_OPEN_BATCHES = 2;
// Session bindings and five verified receipts are small, but they are written
// after batch creation. Reserve a deliberately generous fixed envelope for
// every open batch so later submit/close/expiry operations cannot be stranded
// by other successful creates consuming the remaining logical storage budget.
const OPEN_BATCH_GROWTH_RESERVE_BYTES = 64 * 1024;
const PRACTICE_PURPOSE = "practice";
const RANKED_PURPOSE = "ranked";
const LEGACY_RANKED_SCORE_MAXIMUM = 60;
const RANKED_SCORE_MAXIMUM = 100;
const SUPPORTED_RANKED_SCORE_MAXIMUMS = new Set([
  LEGACY_RANKED_SCORE_MAXIMUM,
  RANKED_SCORE_MAXIMUM
]);
const DEFAULT_RANKING_LIST_LIMIT = 50;
const MAX_RANKING_LIST_LIMIT = 100;
const MAX_RANKING_LIST_OFFSET = MAX_ARCHIVED_BATCH_DIRECTORIES;
const RANKED_ANONYMOUS_PARTICIPANT_SCHEMA_VERSION = "chenlong.ranked-anonymous-participant/v1";

const BATCH_ID_PATTERN = /^bat_[a-f0-9]{32}$/;
const OWNER_USER_ID_PATTERN = /^usr_[a-f0-9]{32}$/;
const SESSION_ID_PATTERN = /^ses_[a-f0-9]{32}$/;
const RUN_ID_PATTERN = /^run_[a-f0-9]{32}$/;
const SUBMISSION_ID_PATTERN = /^sub_[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const POLICY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const TEMPORARY_BATCH_DIRECTORY_PATTERN = /^\.bat_[a-f0-9]{32}\.[a-f0-9-]{36}\.tmp$/;
const TEMPORARY_RECORD_FILE_PATTERN = /^\.batch\.json\.[a-f0-9-]{36}\.tmp$/;
const RANKED_ATTEMPT_LEDGER_FILE_PATTERN = /^(usr_[a-f0-9]{32})\.json$/;
const TEMPORARY_RANKED_ATTEMPT_FILE_PATTERN = /^\.usr_[a-f0-9]{32}\.json\.[a-f0-9-]{36}\.tmp$/;

const PRIVATE_STATE_KEYS = Object.freeze([
  "schemaVersion", "authoritative", "batchId", "sourceDigest", "phase",
  "nextSlotIndex", "finalizationReason", "closeCommandDigest", "commitment",
  "commitmentDigest", "slots"
]);
const PRIVATE_SLOT_KEYS = Object.freeze([
  "slotIndex", "privateValue", "privateDigest", "result", "submissionDigest"
]);
const PRIVATE_COMMITMENT_KEYS = Object.freeze([
  "schemaVersion", "nonce", "batchId", "sourceDigest", "slotCount", "privateSlotsDigest"
]);
const PRIVATE_SLOT_EXECUTION_KEYS = Object.freeze([
  "slotIndex", "layoutCommitment", "sessionBinding", "verifiedReceipt"
]);
const PRIVATE_SESSION_BINDING_KEYS = Object.freeze([
  "schemaVersion", "sessionId", "runId", "challengeDigest", "runDefinitionDigest", "boundAt"
]);
const PRIVATE_SESSION_BINDING_V2_KEYS = Object.freeze([
  ...PRIVATE_SESSION_BINDING_KEYS,
  "teamId"
]);
const PRIVATE_VERIFIED_RECEIPT_KEYS = Object.freeze([
  "schemaVersion", "slotIndex", "sessionId", "sessionBindingDigest", "submissionId",
  "recordSha256", "resultDigest", "commandDigest", "receivedAt"
]);
const PRIVATE_VERIFIED_RECEIPT_V2_KEYS = Object.freeze([
  ...PRIVATE_VERIFIED_RECEIPT_KEYS,
  "reportSha256"
]);
const PRIVATE_PAYLOAD_V1_KEYS = Object.freeze([
  "schemaVersion", "authoritative", "batchId", "ownerUserId", "createdAt",
  "expiresAt", "lockedSource", "layoutSelectionSecret", "batchState", "batchStateDigest",
  "slotExecutions"
]);
const PRIVATE_PAYLOAD_V2_KEYS = Object.freeze([
  ...PRIVATE_PAYLOAD_V1_KEYS,
  "purpose", "competitionId", "lockedTeamId", "evaluationPolicy"
]);
const RANKED_EVALUATION_POLICY_KEYS = Object.freeze([
  "schemaVersion", "purpose", "competitionId", "catalogVersion",
  "selectionPolicyVersion", "rankedFormVersion", "scoreMaximum", "slotCount"
]);
const RANKED_ATTEMPT_LEDGER_KEYS = Object.freeze([
  "schemaVersion", "purpose", "competitionId", "ownerUserId", "batchId",
  "sourceDigest", "lockedTeamId", "state", "createdAt"
]);

class BatchEvaluationStoreError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "BatchEvaluationStoreError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function storeError(statusCode, code, message) {
  return new BatchEvaluationStoreError(statusCode, code, message);
}

function corrupt(message = "stored batch evaluation is invalid") {
  throw storeError(500, "BATCH_ARCHIVE_CORRUPTED", message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expectedKeys, code, label) {
  if (!isPlainObject(value)) throw storeError(400, code, `${label} must be a plain object`);
  const expected = new Set(expectedKeys);
  const actualKeys = Object.keys(value);
  for (const key of actualKeys) {
    if (!expected.has(key)) throw storeError(400, code, `${label} contains unsupported field ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw storeError(400, code, `${label}.${key} is required`);
    }
  }
}

function assertStoredExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) corrupt(`${label} must be a plain object`);
  const expected = new Set(expectedKeys);
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== expectedKeys.length || actualKeys.some(key => !expected.has(key))) {
    corrupt(`${label} uses an unsupported schema`);
  }
}

function boundedInteger(name, value, fallback, maximum) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function normalizeOwnerUserId(value) {
  if (typeof value !== "string" || !OWNER_USER_ID_PATTERN.test(value)) {
    throw storeError(400, "INVALID_BATCH_OWNER", "ownerUserId is invalid");
  }
  return value;
}

function normalizePolicyId(value, label) {
  if (typeof value !== "string" || !POLICY_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must contain 1-128 lowercase ASCII letters, numbers, '.', '_' or '-'`);
  }
  return value;
}

function normalizeRankedTeamId(value) {
  try {
    return normalizeParticipantId(value);
  } catch (_error) {
    throw storeError(400, "INVALID_TEAM_ID", "teamId must contain 1-64 letters, numbers, '.', '_' or '-'");
  }
}

function assertStoredRankedTeamId(value) {
  let normalized;
  try {
    normalized = normalizeParticipantId(value);
  } catch (_error) {
    corrupt("stored ranked teamId is invalid");
  }
  if (normalized !== value) corrupt("stored ranked teamId is not normalized");
  return value;
}

function normalizeRankedEvaluationPolicy(value, competitionId = null) {
  if (!isPlainObject(value)) throw new TypeError("ranked evaluation policy must be a plain object");
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== RANKED_EVALUATION_POLICY_KEYS.length
    || actualKeys.some(key => !RANKED_EVALUATION_POLICY_KEYS.includes(key))) {
    throw new TypeError("ranked evaluation policy uses an unsupported schema");
  }
  const normalized = {
    schemaVersion: value.schemaVersion,
    purpose: value.purpose,
    competitionId: normalizePolicyId(value.competitionId, "ranked evaluation policy competitionId"),
    catalogVersion: normalizePolicyId(value.catalogVersion, "ranked evaluation policy catalogVersion"),
    selectionPolicyVersion: normalizePolicyId(
      value.selectionPolicyVersion,
      "ranked evaluation policy selectionPolicyVersion"
    ),
    rankedFormVersion: normalizePolicyId(value.rankedFormVersion, "ranked evaluation policy rankedFormVersion"),
    scoreMaximum: value.scoreMaximum,
    slotCount: value.slotCount
  };
  if (normalized.schemaVersion !== RANKED_EVALUATION_POLICY_SCHEMA_VERSION
    || normalized.purpose !== RANKED_PURPOSE
    || (competitionId !== null && normalized.competitionId !== competitionId)
    || !SUPPORTED_RANKED_SCORE_MAXIMUMS.has(normalized.scoreMaximum)
    || normalized.slotCount !== FIXED_SLOT_COUNT) {
    throw new TypeError("ranked evaluation policy is invalid");
  }
  return deepFreeze(normalized);
}

function normalizeBatchId(value) {
  if (typeof value !== "string" || !BATCH_ID_PATTERN.test(value)) {
    throw storeError(404, "BATCH_NOT_FOUND", "batch evaluation not found");
  }
  return value;
}

function isoTimestamp(value, label) {
  if (typeof value !== "string") corrupt(`${label} is invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    corrupt(`${label} is invalid`);
  }
  return milliseconds;
}

function translateCoreError(error) {
  if (!(error instanceof BatchEvaluationError)) return error;
  if (error.code === "INVALID_BATCH_STATE") {
    return storeError(500, "BATCH_ARCHIVE_CORRUPTED", "stored batch evaluation state is invalid");
  }
  if (["SLOT_ALREADY_FINALIZED", "SLOT_OUT_OF_ORDER", "BATCH_FINALIZED", "SOURCE_LOCKED"].includes(error.code)) {
    return storeError(409, error.code, error.message);
  }
  return storeError(400, error.code, error.message);
}

function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function privateClone(value) {
  return deepFreeze(JSON.parse(canonicalJson(value)));
}

function layoutSequenceSeed(batchId, commitmentNonce) {
  return `${batchId}:${commitmentNonce}`;
}

function rankedLayoutSequenceSeed(competitionId, ownerUserId, batchId, commitmentNonce) {
  return [RANKED_PURPOSE, competitionId, ownerUserId, batchId, commitmentNonce].join(":");
}

function effectivePurpose(payload) {
  return payload.schemaVersion === BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2
    ? payload.purpose
    : PRACTICE_PURPOSE;
}

function makeRecord(payload) {
  const record = {
    schemaVersion: BATCH_STORE_RECORD_SCHEMA_VERSION,
    payloadDigest: canonicalSha256(payload),
    payload
  };
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function validateRankedAttemptLedgerRecord(record, expectedOwnerUserId = null, competitionId = null) {
  assertStoredExactKeys(record, ["schemaVersion", "payloadDigest", "payload"], "ranked attempt ledger record");
  if (record.schemaVersion !== RANKED_ATTEMPT_LEDGER_RECORD_SCHEMA_VERSION
    || !SHA256_PATTERN.test(record.payloadDigest || "")
    || canonicalSha256(record.payload) !== record.payloadDigest) {
    corrupt("ranked attempt ledger digest is invalid");
  }
  const payload = record.payload;
  assertStoredExactKeys(payload, RANKED_ATTEMPT_LEDGER_KEYS, "ranked attempt ledger payload");
  if (payload.schemaVersion !== RANKED_ATTEMPT_LEDGER_PAYLOAD_SCHEMA_VERSION
    || payload.purpose !== RANKED_PURPOSE
    || (competitionId !== null && payload.competitionId !== competitionId)
    || !OWNER_USER_ID_PATTERN.test(payload.ownerUserId || "")
    || (expectedOwnerUserId !== null && payload.ownerUserId !== expectedOwnerUserId)
    || !BATCH_ID_PATTERN.test(payload.batchId || "")
    || !SHA256_PATTERN.test(payload.sourceDigest || "")
    || !["reserved", "bound"].includes(payload.state)) {
    corrupt("ranked attempt ledger binding is invalid");
  }
  assertStoredRankedTeamId(payload.lockedTeamId);
  isoTimestamp(payload.createdAt, "ranked attempt ledger createdAt");
  return payload;
}

function makeRankedAttemptLedgerRecord(payload) {
  const record = {
    schemaVersion: RANKED_ATTEMPT_LEDGER_RECORD_SCHEMA_VERSION,
    payloadDigest: canonicalSha256(payload),
    payload
  };
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function sourceMetadata(source, {
  maximumBytes = MAX_LOCKED_SOURCE_BYTES,
  statusCode = 413,
  code = "BATCH_SOURCE_TOO_LARGE"
} = {}) {
  const byteLength = Buffer.byteLength(source, "utf8");
  if (byteLength > maximumBytes) {
    throw storeError(statusCode, code, "locked source exceeds its storage limit");
  }
  return {
    value: source,
    byteLength,
    digest: digestSource(source)
  };
}

function verifiedSlotCommandDigest(command, binding) {
  const ranked = binding.schemaVersion === BATCH_SLOT_SESSION_BINDING_SCHEMA_VERSION_V2;
  const payload = {
    schemaVersion: ranked
      ? BATCH_SLOT_VERIFIED_COMMAND_SCHEMA_VERSION_V2
      : BATCH_SLOT_VERIFIED_COMMAND_SCHEMA_VERSION,
    slotIndex: command.slotIndex,
    sessionBinding: binding,
    submissionId: command.submissionId,
    recordSha256: command.recordSha256,
    result: command.result
  };
  if (ranked) {
    payload.reportSha256 = command.reportSha256;
    payload.archivedAt = command.archivedAt;
  }
  return canonicalSha256(payload);
}

function assertStrictPrivateStateShape(state) {
  assertStoredExactKeys(state, PRIVATE_STATE_KEYS, "stored batch state");
  if (!Array.isArray(state.slots) || state.slots.length !== FIXED_SLOT_COUNT) {
    corrupt("stored batch slots are invalid");
  }
  state.slots.forEach((slot, index) => {
    assertStoredExactKeys(slot, PRIVATE_SLOT_KEYS, `stored batch slot ${index + 1}`);
    if (slot.result !== null) {
      assertStoredExactKeys(
        slot.result,
        ["status", "score", "completed", "collisionCount", "outOfBoundsCount"],
        `stored batch slot ${index + 1} result`
      );
    }
  });
  assertStoredExactKeys(state.commitment, PRIVATE_COMMITMENT_KEYS, "stored batch commitment");
}

function validateSlotExecutions(payload) {
  if (!Array.isArray(payload.slotExecutions) || payload.slotExecutions.length !== FIXED_SLOT_COUNT) {
    corrupt("stored slot execution bindings are invalid");
  }
  payload.slotExecutions.forEach((execution, index) => {
    const slotIndex = index + 1;
    const stateSlot = payload.batchState.slots[index];
    assertStoredExactKeys(execution, PRIVATE_SLOT_EXECUTION_KEYS, `stored slot execution ${slotIndex}`);
    if (execution.slotIndex !== slotIndex
      || execution.layoutCommitment !== stateSlot.privateValue?.layoutCommitment
      || !SHA256_PATTERN.test(execution.layoutCommitment || "")) {
      corrupt(`stored slot execution ${slotIndex} is not bound to its private layout`);
    }

    const binding = execution.sessionBinding;
    if (binding !== null) {
      const rankedBinding = payload.schemaVersion === BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2;
      assertStoredExactKeys(
        binding,
        rankedBinding ? PRIVATE_SESSION_BINDING_V2_KEYS : PRIVATE_SESSION_BINDING_KEYS,
        `stored slot ${slotIndex} session binding`
      );
      if (binding.schemaVersion !== (rankedBinding
        ? BATCH_SLOT_SESSION_BINDING_SCHEMA_VERSION_V2
        : BATCH_SLOT_SESSION_BINDING_SCHEMA_VERSION)
        || !SESSION_ID_PATTERN.test(binding.sessionId || "")
        || !RUN_ID_PATTERN.test(binding.runId || "")
        || !SHA256_PATTERN.test(binding.challengeDigest || "")
        || !SHA256_PATTERN.test(binding.runDefinitionDigest || "")) {
        corrupt(`stored slot ${slotIndex} session binding is invalid`);
      }
      if (rankedBinding) {
        assertStoredRankedTeamId(binding.teamId);
        if (binding.teamId !== payload.lockedTeamId) {
          corrupt(`stored slot ${slotIndex} session binding uses another ranked teamId`);
        }
      }
      isoTimestamp(binding.boundAt, `stored slot ${slotIndex} session binding time`);
    }

    const receipt = execution.verifiedReceipt;
    if (receipt !== null) {
      assertStoredExactKeys(
        receipt,
        payload.schemaVersion === BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2
          ? PRIVATE_VERIFIED_RECEIPT_V2_KEYS
          : PRIVATE_VERIFIED_RECEIPT_KEYS,
        `stored slot ${slotIndex} verified receipt`
      );
      if (binding === null
        || receipt.schemaVersion !== (payload.schemaVersion === BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2
          ? BATCH_SLOT_VERIFIED_RECEIPT_SCHEMA_VERSION_V2
          : BATCH_SLOT_VERIFIED_RECEIPT_SCHEMA_VERSION)
        || receipt.slotIndex !== slotIndex
        || receipt.sessionId !== binding.sessionId
        || receipt.sessionBindingDigest !== canonicalSha256(binding)
        || !SUBMISSION_ID_PATTERN.test(receipt.submissionId || "")
        || !SHA256_PATTERN.test(receipt.recordSha256 || "")
        || (payload.schemaVersion === BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2
          && !SHA256_PATTERN.test(receipt.reportSha256 || ""))
        || !SHA256_PATTERN.test(receipt.resultDigest || "")
        || !SHA256_PATTERN.test(receipt.commandDigest || "")
        || stateSlot.result === null
        || stateSlot.result.status === "missing"
        || receipt.resultDigest !== canonicalSha256(stateSlot.result)) {
        corrupt(`stored slot ${slotIndex} verified receipt is invalid`);
      }
      const receivedAt = isoTimestamp(receipt.receivedAt, `stored slot ${slotIndex} verified receipt time`);
      if (payload.schemaVersion === BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2
        && (receivedAt < Date.parse(binding.boundAt) || receivedAt >= Date.parse(payload.expiresAt))) {
        corrupt(`stored slot ${slotIndex} ranked receipt is outside its lease lifetime`);
      }
      const expectedCommandDigest = verifiedSlotCommandDigest({
        slotIndex,
        submissionId: receipt.submissionId,
        recordSha256: receipt.recordSha256,
        result: stateSlot.result,
        ...(payload.schemaVersion === BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2
          ? { reportSha256: receipt.reportSha256, archivedAt: receipt.receivedAt }
          : {})
      }, binding);
      if (receipt.commandDigest !== expectedCommandDigest) {
        corrupt(`stored slot ${slotIndex} verified command binding does not match`);
      }
    } else if (stateSlot.result !== null && stateSlot.result.status !== "missing") {
      corrupt(`stored slot ${slotIndex} result has no verified receipt`);
    }

    if (stateSlot.result === null && receipt !== null) {
      corrupt(`pending slot ${slotIndex} cannot have a verified receipt`);
    }
    if (binding !== null && stateSlot.result === null
      && payload.batchState.nextSlotIndex !== slotIndex) {
      corrupt(`future slot ${slotIndex} cannot have a session binding`);
    }
  });
}

function validatePrivatePayload(payload, expectedBatchId = null, validationContext = null) {
  const isV2 = payload?.schemaVersion === BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2;
  assertStoredExactKeys(
    payload,
    isV2 ? PRIVATE_PAYLOAD_V2_KEYS : PRIVATE_PAYLOAD_V1_KEYS,
    "stored batch payload"
  );
  if (![BATCH_STORE_PAYLOAD_SCHEMA_VERSION, BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2]
    .includes(payload.schemaVersion)
    || payload.authoritative !== AUTHORITATIVE
    || !BATCH_ID_PATTERN.test(payload.batchId || "")
    || (expectedBatchId !== null && payload.batchId !== expectedBatchId)
    || !OWNER_USER_ID_PATTERN.test(payload.ownerUserId || "")
    || !SHA256_PATTERN.test(payload.layoutSelectionSecret || "")
    || !SHA256_PATTERN.test(payload.batchStateDigest || "")) {
    corrupt();
  }

  if (isV2) {
    if (payload.purpose !== RANKED_PURPOSE
      || typeof validationContext?.layoutSequenceProvider !== "function"
      || validationContext.purpose !== RANKED_PURPOSE
      || payload.competitionId !== validationContext.competitionId) {
      corrupt("stored ranked batch purpose or competition binding is invalid");
    }
    assertStoredRankedTeamId(payload.lockedTeamId);
    let policy;
    try {
      policy = normalizeRankedEvaluationPolicy(payload.evaluationPolicy, payload.competitionId);
    } catch (_error) {
      corrupt("stored ranked evaluation policy is invalid");
    }
    const policyIdentity = ({ scoreMaximum: _scoreMaximum, ...identity }) => identity;
    if (canonicalJson(policyIdentity(policy))
      !== canonicalJson(policyIdentity(validationContext.evaluationPolicy))) {
      corrupt("stored ranked evaluation policy does not match this store");
    }
  }

  const createdAt = isoTimestamp(payload.createdAt, "stored batch createdAt");
  const expiresAt = isoTimestamp(payload.expiresAt, "stored batch expiresAt");
  if (expiresAt <= createdAt || expiresAt - createdAt > MAX_BATCH_TTL_MS) {
    corrupt("stored batch lifetime is invalid");
  }

  assertStoredExactKeys(payload.lockedSource, ["value", "byteLength", "digest"], "stored locked source");
  if (typeof payload.lockedSource.value !== "string"
    || !Number.isSafeInteger(payload.lockedSource.byteLength)
    || payload.lockedSource.byteLength < 0
    || payload.lockedSource.byteLength > (isV2
      ? MAX_RANKED_LOCKED_SOURCE_BYTES
      : MAX_LOCKED_SOURCE_BYTES)
    || Buffer.byteLength(payload.lockedSource.value, "utf8") !== payload.lockedSource.byteLength
    || !SHA256_PATTERN.test(payload.lockedSource.digest || "")) {
    corrupt("stored locked source metadata is invalid");
  }
  try {
    if (digestSource(payload.lockedSource.value) !== payload.lockedSource.digest) {
      corrupt("stored locked source digest does not match");
    }
  } catch (error) {
    if (error instanceof BatchEvaluationStoreError) throw error;
    corrupt("stored locked source is invalid");
  }

  assertStrictPrivateStateShape(payload.batchState);
  if (canonicalSha256(payload.batchState) !== payload.batchStateDigest) {
    corrupt("stored batch state digest does not match");
  }
  if (payload.batchState.schemaVersion !== BATCH_EVALUATION_SCHEMA_VERSION
    || payload.batchState.authoritative !== AUTHORITATIVE
    || payload.batchState.batchId !== payload.batchId
    || payload.batchState.sourceDigest !== payload.lockedSource.digest
    || payload.batchState.commitment?.schemaVersion !== BATCH_COMMITMENT_SCHEMA_VERSION
    || !SHA256_PATTERN.test(payload.batchState.commitment?.nonce || "")
    || !verifyBatchCommitment(payload.batchState)) {
    corrupt("stored batch state binding is invalid");
  }

  try {
    publicBatchProjection(payload.batchState);
    const selectionProvider = isV2
      ? validationContext.layoutSequenceProvider
      : selectGuangyangLayoutSequence;
    const selectionSeed = isV2
      ? rankedLayoutSequenceSeed(
        payload.competitionId,
        payload.ownerUserId,
        payload.batchId,
        payload.batchState.commitment.nonce
      )
      : layoutSequenceSeed(payload.batchId, payload.batchState.commitment.nonce);
    const expectedSelections = selectionProvider({
      secret: Buffer.from(payload.layoutSelectionSecret, "hex"),
      seed: selectionSeed,
      count: FIXED_SLOT_COUNT
    });
    payload.batchState.slots.forEach((slot, index) => {
      if (isV2 && slot.result?.status === "valid"
        && slot.result.score > payload.evaluationPolicy.scoreMaximum) {
        corrupt(`stored ranked slot ${index + 1} score exceeds its evaluation policy`);
      }
      if (isV2 && (slot.privateValue?.catalogVersion !== payload.evaluationPolicy.catalogVersion
        || slot.privateValue?.selectionPurpose !== RANKED_PURPOSE
        || slot.privateValue?.selectionPolicyVersion !== payload.evaluationPolicy.selectionPolicyVersion
        || slot.privateValue?.rankedFormVersion !== payload.evaluationPolicy.rankedFormVersion
        || slot.privateValue?.sequenceLength !== FIXED_SLOT_COUNT)) {
        corrupt(`stored ranked layout selection ${index + 1} does not match its evaluation policy`);
      }
      if (canonicalJson(slot.privateValue) !== canonicalJson(expectedSelections[index])) {
        corrupt(`stored private layout selection ${index + 1} does not match its locked sequence`);
      }
    });
    validateSlotExecutions(payload);
  } catch (error) {
    if (error instanceof BatchEvaluationStoreError) throw error;
    corrupt("stored private layout sequence is invalid");
  }
  return payload;
}

function validateRecord(record, expectedBatchId = null, validationContext = null) {
  assertStoredExactKeys(record, ["schemaVersion", "payloadDigest", "payload"], "stored batch record");
  if (record.schemaVersion !== BATCH_STORE_RECORD_SCHEMA_VERSION
    || !SHA256_PATTERN.test(record.payloadDigest || "")) {
    corrupt();
  }
  let actualDigest;
  try {
    actualDigest = canonicalSha256(record.payload);
  } catch (_error) {
    corrupt("stored batch payload is not canonical JSON");
  }
  if (actualDigest !== record.payloadDigest) corrupt("stored batch payload digest does not match");
  return validatePrivatePayload(record.payload, expectedBatchId, validationContext);
}

function publicStoredBatch(payload) {
  const batch = publicBatchProjection(payload.batchState);
  const nextSlot = payload.batchState.nextSlotIndex === null
    ? null
    : payload.batchState.slots[payload.batchState.nextSlotIndex - 1];
  const projected = {
    batch,
    currentSlot: nextSlot ? projectPublicLayoutSelection(nextSlot.privateValue) : null
  };
  if (payload.schemaVersion === BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2) {
    return privateClone({
      purpose: payload.purpose,
      competitionId: payload.competitionId,
      lockedTeamId: payload.lockedTeamId,
      evaluationPolicy: payload.evaluationPolicy,
      ...projected
    });
  }
  return Object.freeze(projected);
}

function rankedOwnerProjection(payload) {
  if (payload.schemaVersion !== BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2
    || payload.purpose !== RANKED_PURPOSE) {
    corrupt("ranked owner projection received a non-ranked batch");
  }
  return privateClone({
    ...publicStoredBatch(payload),
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
    anonymousParticipantId: anonymousParticipantId(payload.competitionId, payload.ownerUserId),
    lockedSource: payload.lockedSource.value
  });
}

function publicOpenBatchDiscovery(payload) {
  const batch = publicBatchProjection(payload.batchState);
  return privateClone({
    batchId: batch.batchId,
    sourceDigest: batch.sourceDigest,
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
    nextSlotIndex: batch.nextSlotIndex,
    summary: batch.summary
  });
}

function samePublicRankingTuple(left, right) {
  return RANKING_ORDER.every(({ field }) => left.ranking[field] === right.ranking[field]);
}

function anonymousParticipantId(competitionId, ownerUserId) {
  return `participant_${canonicalSha256({
    schemaVersion: RANKED_ANONYMOUS_PARTICIPANT_SCHEMA_VERSION,
    competitionId,
    ownerUserId
  }).slice(0, 32)}`;
}

function rankedResultEntry(payload, projection, rank) {
  const summary = projection.summary;
  return privateClone({
    rank,
    anonymousParticipantId: anonymousParticipantId(payload.competitionId, payload.ownerUserId),
    ownerUserId: payload.ownerUserId,
    lockedTeamId: payload.lockedTeamId,
    createdAt: payload.createdAt,
    finalizationReason: projection.finalizationReason,
    score: {
      value: summary.batchScore,
      mean: summary.meanScore,
      minimum: summary.minScore,
      maximum: RANKED_SCORE_MAXIMUM
    },
    quality: {
      slotCount: summary.slotCount,
      finalizedCount: summary.finalizedCount,
      completedCount: summary.completedCount,
      validCount: summary.validCount,
      invalidCount: summary.invalidCount,
      timeoutCount: summary.timeoutCount,
      missingCount: summary.missingCount,
      collisionCount: summary.collisionCount,
      outOfBoundsCount: summary.outOfBoundsCount
    },
    ranking: projection.ranking
  });
}

function rankedEntriesFromFinalizedPayloads(payloads) {
  return rankedEntriesFromPrepared(payloads.map(payload => ({
    payload,
    projection: publicBatchProjection(payload.batchState)
  })));
}

function rankedEntriesFromPrepared(finalized) {
  const scoreFields = ["batchScore", "minScore", "meanScore"];
  const normalized = finalized.map(item => {
    const archivedMaximum = item.payload.evaluationPolicy.scoreMaximum;
    if (archivedMaximum === RANKED_SCORE_MAXIMUM) return item;
    const projection = JSON.parse(canonicalJson(item.projection));
    const scale = RANKED_SCORE_MAXIMUM / archivedMaximum;
    scoreFields.forEach(field => {
      const value = Math.round((projection.summary[field] * scale + Number.EPSILON) * 100) / 100;
      projection.summary[field] = Object.is(value, -0) ? 0 : value;
      projection.ranking[field] = projection.summary[field];
    });
    return { ...item, projection };
  });
  normalized.sort((left, right) => (
    compareBatchPublicProjections(left.projection, right.projection)
  ));
  let publicRank = 0;
  return normalized.map((item, index) => {
    if (index === 0 || !samePublicRankingTuple(item.projection, normalized[index - 1].projection)) {
      publicRank = index + 1;
    }
    return rankedResultEntry(item.payload, item.projection, publicRank);
  });
}

async function ensurePlainDirectory(directory, label) {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) corrupt(`${label} is not a private directory`);
}

async function readStrictFile(filePath, maximumBytes, missing = false) {
  let stat;
  try {
    stat = await fs.promises.lstat(filePath);
  } catch (error) {
    if (missing && error?.code === "ENOENT") {
      throw storeError(404, "BATCH_NOT_FOUND", "batch evaluation not found");
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximumBytes) {
    corrupt("stored batch record file is invalid");
  }
  const handle = await fs.promises.open(filePath, "r");
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size !== stat.size
      || (Number.isSafeInteger(stat.ino) && Number.isSafeInteger(openedStat.ino) && stat.ino !== openedStat.ino)
      || (Number.isSafeInteger(stat.dev) && Number.isSafeInteger(openedStat.dev) && stat.dev !== openedStat.dev)) {
      corrupt("stored batch record changed while being opened");
    }
    const buffer = await handle.readFile();
    const finalStat = await handle.stat();
    if (buffer.length !== stat.size || finalStat.size !== stat.size) {
      corrupt("stored batch record changed while being read");
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

function parseRecordBuffer(buffer, expectedBatchId, validationContext = null) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (_error) {
    corrupt("stored batch record is not valid UTF-8");
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch (_error) {
    corrupt("stored batch record is not valid JSON");
  }
  return validateRecord(record, expectedBatchId, validationContext);
}

async function atomicWriteFile(directory, filename, buffer) {
  const targetPath = path.join(directory, filename);
  const temporaryPath = path.join(directory, `.${filename}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, targetPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

class BatchEvaluationStore {
  constructor(options = {}) {
    this.purpose = options.purpose === undefined ? PRACTICE_PURPOSE : options.purpose;
    if (![PRACTICE_PURPOSE, RANKED_PURPOSE].includes(this.purpose)) {
      throw new TypeError("purpose must be practice or ranked");
    }
    if (this.purpose === RANKED_PURPOSE) {
      this.competitionId = normalizePolicyId(options.competitionId, "competitionId");
      if (typeof options.layoutSequenceProvider !== "function") {
        throw new TypeError("ranked batch store requires a layoutSequenceProvider");
      }
      this.layoutSequenceProvider = options.layoutSequenceProvider;
      this.evaluationPolicy = normalizeRankedEvaluationPolicy(
        options.evaluationPolicy,
        this.competitionId
      );
    } else {
      this.competitionId = null;
      this.layoutSequenceProvider = selectGuangyangLayoutSequence;
      this.evaluationPolicy = null;
    }
    this.validationContext = Object.freeze({
      purpose: this.purpose,
      competitionId: this.competitionId,
      layoutSequenceProvider: this.layoutSequenceProvider,
      evaluationPolicy: this.evaluationPolicy
    });
    this.rootDir = path.resolve(options.rootDir || path.join(process.cwd(), ".runtime"));
    this.batchesDir = path.join(this.rootDir, "batches");
    this.rankedAttemptsDir = this.purpose === RANKED_PURPOSE
      ? path.join(this.rootDir, "attempts")
      : null;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.batchTtlMs = boundedInteger("batchTtlMs", options.batchTtlMs, DEFAULT_BATCH_TTL_MS, MAX_BATCH_TTL_MS);
    this.maxBatches = boundedInteger("maxBatches", options.maxBatches, DEFAULT_MAX_BATCHES, MAX_BATCHES);
    this.maxOpenBatchesPerOwner = boundedInteger(
      "maxOpenBatchesPerOwner",
      options.maxOpenBatchesPerOwner,
      this.purpose === RANKED_PURPOSE ? 1 : DEFAULT_MAX_OPEN_BATCHES_PER_OWNER,
      MAX_OPEN_BATCHES_PER_OWNER
    );
    this.maxRetainedBatchesPerOwner = boundedInteger(
      "maxRetainedBatchesPerOwner",
      options.maxRetainedBatchesPerOwner,
      this.purpose === RANKED_PURPOSE ? 1 : DEFAULT_MAX_RETAINED_BATCHES_PER_OWNER,
      MAX_RETAINED_BATCHES_PER_OWNER
    );
    if (this.maxOpenBatchesPerOwner > this.maxRetainedBatchesPerOwner) {
      throw new TypeError("maxOpenBatchesPerOwner cannot exceed maxRetainedBatchesPerOwner");
    }
    if (this.purpose === RANKED_PURPOSE
      && (this.maxOpenBatchesPerOwner !== 1 || this.maxRetainedBatchesPerOwner !== 1)) {
      throw new TypeError("ranked batch store owner limits must both equal 1");
    }
    this.maxStorageBytes = boundedInteger(
      "maxStorageBytes",
      options.maxStorageBytes,
      DEFAULT_MAX_STORAGE_BYTES,
      MAX_STORAGE_BYTES
    );
    this.usedBytes = 0;
    this.operationTail = Promise.resolve();
    this.rankingSnapshot = null;
    this.archiveIdentity = null;
    this.rankedOwnerBatchIds = new Map();
    this.rankedFinalizedIndex = new Map();
    this.rankedAttemptLedgers = new Map();
    this.rankedLedgerReady = false;
    this.ready = this.initialize();
  }

  timestampNow() {
    const value = Number(this.now());
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("now() must return a non-negative safe integer");
    return value;
  }

  async initialize() {
    await ensurePlainDirectory(this.rootDir, "batch store root");
    await ensurePlainDirectory(this.batchesDir, "batch store batches directory");
    if (this.purpose === RANKED_PURPOSE) {
      await ensurePlainDirectory(this.rankedAttemptsDir, "ranked attempt ledger directory");
      await this.cleanupRankedAttemptTemporaryFiles();
    }
    await this.cleanupTemporaryArtifacts();
    const archive = await this.scanArchiveUnlocked();
    this.usedBytes = archive.usedBytes;
    if (this.purpose === RANKED_PURPOSE) {
      await this.initializeRankedAttemptLedgersUnlocked(archive.records);
    }
    if (this.usedBytes > this.maxStorageBytes) {
      throw storeError(507, "BATCH_STORAGE_FULL", "batch storage budget is already exceeded");
    }
  }

  async withExclusiveOperation(operation) {
    await this.ready;
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.catch(() => {});
    return run;
  }

  batchDirectory(batchId) {
    const normalized = normalizeBatchId(batchId);
    const directory = path.resolve(this.batchesDir, normalized);
    if (path.dirname(directory) !== path.resolve(this.batchesDir)) {
      throw storeError(404, "BATCH_NOT_FOUND", "batch evaluation not found");
    }
    return directory;
  }

  async cleanupTemporaryArtifacts() {
    const entries = await fs.promises.readdir(this.batchesDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(this.batchesDir, entry.name);
      if (TEMPORARY_BATCH_DIRECTORY_PATTERN.test(entry.name)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) corrupt("batch archive temporary entry is invalid");
        const children = await fs.promises.readdir(entryPath, { withFileTypes: true });
        for (const child of children) {
          if (!child.isFile() || child.isSymbolicLink()) corrupt("batch archive temporary directory is invalid");
          await fs.promises.unlink(path.join(entryPath, child.name));
        }
        await fs.promises.rmdir(entryPath);
        continue;
      }
      if (!BATCH_ID_PATTERN.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) corrupt("stored batch path is invalid");
      const children = await fs.promises.readdir(entryPath, { withFileTypes: true });
      for (const child of children) {
        if (!TEMPORARY_RECORD_FILE_PATTERN.test(child.name)) continue;
        if (!child.isFile() || child.isSymbolicLink()) corrupt("stored batch temporary file is invalid");
        await fs.promises.unlink(path.join(entryPath, child.name));
      }
    }
  }

  async cleanupRankedAttemptTemporaryFiles() {
    const entries = await fs.promises.readdir(this.rankedAttemptsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!TEMPORARY_RANKED_ATTEMPT_FILE_PATTERN.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) corrupt("ranked attempt temporary entry is invalid");
      await fs.promises.unlink(path.join(this.rankedAttemptsDir, entry.name));
    }
  }

  async scanRankedAttemptLedgersUnlocked() {
    const entries = await fs.promises.readdir(this.rankedAttemptsDir, { withFileTypes: true });
    if (entries.some(entry => !RANKED_ATTEMPT_LEDGER_FILE_PATTERN.test(entry.name))
      || entries.length > MAX_ARCHIVED_BATCH_DIRECTORIES) {
      corrupt("ranked attempt ledger directory contains unsupported entries");
    }
    const ledgers = new Map();
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) corrupt("ranked attempt ledger path is invalid");
      const ownerUserId = RANKED_ATTEMPT_LEDGER_FILE_PATTERN.exec(entry.name)[1];
      const buffer = await readStrictFile(
        path.join(this.rankedAttemptsDir, entry.name),
        MAX_RANKED_ATTEMPT_LEDGER_BYTES
      );
      let record;
      try {
        record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
      } catch (_error) {
        corrupt("ranked attempt ledger is not valid JSON");
      }
      const payload = validateRankedAttemptLedgerRecord(record, ownerUserId, this.competitionId);
      ledgers.set(ownerUserId, payload);
    }
    return ledgers;
  }

  async writeRankedAttemptLedgerUnlocked(payload) {
    const validated = validateRankedAttemptLedgerRecord({
      schemaVersion: RANKED_ATTEMPT_LEDGER_RECORD_SCHEMA_VERSION,
      payloadDigest: canonicalSha256(payload),
      payload
    }, payload.ownerUserId, this.competitionId);
    const buffer = makeRankedAttemptLedgerRecord(validated);
    if (buffer.length > MAX_RANKED_ATTEMPT_LEDGER_BYTES) {
      throw storeError(500, "RANKED_ATTEMPT_LEDGER_TOO_LARGE", "ranked attempt ledger is too large");
    }
    await atomicWriteFile(this.rankedAttemptsDir, `${validated.ownerUserId}.json`, buffer);
    this.rankedAttemptLedgers.set(validated.ownerUserId, privateClone(validated));
    this.rankedOwnerBatchIds.set(validated.ownerUserId, validated.batchId);
    return validated;
  }

  rankedAttemptLedgerForPayload(payload, state = "bound") {
    return {
      schemaVersion: RANKED_ATTEMPT_LEDGER_PAYLOAD_SCHEMA_VERSION,
      purpose: RANKED_PURPOSE,
      competitionId: payload.competitionId,
      ownerUserId: payload.ownerUserId,
      batchId: payload.batchId,
      sourceDigest: payload.lockedSource.digest,
      lockedTeamId: payload.lockedTeamId,
      state,
      createdAt: payload.createdAt
    };
  }

  assertRankedLedgerMatchesPayload(ledger, payload) {
    if (ledger.competitionId !== payload.competitionId
      || ledger.ownerUserId !== payload.ownerUserId
      || ledger.batchId !== payload.batchId
      || ledger.sourceDigest !== payload.lockedSource.digest
      || ledger.lockedTeamId !== payload.lockedTeamId
      || ledger.createdAt !== payload.createdAt) {
      corrupt("ranked attempt ledger does not match its batch archive");
    }
  }

  async readPermanentRankedOwnerBatchUnlocked(ownerUserId) {
    const batchId = this.rankedOwnerBatchIds.get(ownerUserId) || null;
    if (batchId === null) return null;
    const ledger = this.rankedAttemptLedgers.get(ownerUserId) || null;
    if (ledger === null || ledger.batchId !== batchId) {
      corrupt("ranked owner index has no matching permanent attempt ledger");
    }
    try {
      const stored = this.authorizeStoredBatch(
        await this.readBatchDirectoryUnlocked(batchId),
        ownerUserId,
        { allowExpired: true }
      );
      this.assertRankedLedgerMatchesPayload(ledger, stored.payload);
      return stored;
    } catch (error) {
      if (!(error instanceof BatchEvaluationStoreError) || error.code !== "BATCH_NOT_FOUND") throw error;
      if (ledger.state === "bound") {
        corrupt("permanently bound ranked attempt is missing its batch archive");
      }
      throw storeError(
        503,
        "RANKED_ATTEMPT_RESERVATION_INCOMPLETE",
        "ranked attempt reservation must be resumed with its original source and team"
      );
    }
  }

  async initializeRankedAttemptLedgersUnlocked(records) {
    const ledgers = await this.scanRankedAttemptLedgersUnlocked();
    this.rankedAttemptLedgers = ledgers;
    for (const stored of records.values()) {
      let ledger = this.rankedAttemptLedgers.get(stored.payload.ownerUserId) || null;
      if (ledger === null) {
        ledger = await this.writeRankedAttemptLedgerUnlocked(
          this.rankedAttemptLedgerForPayload(stored.payload, "bound")
        );
      } else {
        this.assertRankedLedgerMatchesPayload(ledger, stored.payload);
        if (ledger.state === "reserved") {
          ledger = await this.writeRankedAttemptLedgerUnlocked({ ...ledger, state: "bound" });
        }
      }
    }
    for (const ledger of this.rankedAttemptLedgers.values()) {
      if (ledger.state === "bound" && !records.has(ledger.batchId)) {
        corrupt("permanently bound ranked attempt is missing its batch archive");
      }
    }
    this.rankedLedgerReady = true;
    this.rebuildRankedIndexes(records);
  }

  async readBatchDirectoryUnlocked(batchId) {
    const directory = this.batchDirectory(batchId);
    let stat;
    try {
      stat = await fs.promises.lstat(directory);
    } catch (error) {
      if (error?.code === "ENOENT") throw storeError(404, "BATCH_NOT_FOUND", "batch evaluation not found");
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) corrupt("stored batch directory is invalid");
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    if (entries.length !== 1 || entries[0].name !== "batch.json"
      || !entries[0].isFile() || entries[0].isSymbolicLink()) {
      corrupt("stored batch directory contains unsupported entries");
    }
    const buffer = await readStrictFile(path.join(directory, "batch.json"), MAX_BATCH_RECORD_BYTES, true);
    const payload = parseRecordBuffer(buffer, batchId, this.validationContext);
    return {
      directory,
      payload,
      byteLength: buffer.length,
      recordSha256: crypto.createHash("sha256").update(buffer).digest("hex")
    };
  }

  async scanArchiveUnlocked() {
    const entries = await fs.promises.readdir(this.batchesDir, { withFileTypes: true });
    const batchEntries = entries.filter(entry => BATCH_ID_PATTERN.test(entry.name));
    const unsupported = entries.filter(entry => !BATCH_ID_PATTERN.test(entry.name));
    if (unsupported.length) corrupt("batch archive contains an unsupported path");
    if (batchEntries.length > MAX_ARCHIVED_BATCH_DIRECTORIES) {
      corrupt("batch archive contains too many directories");
    }
    const records = new Map();
    let usedBytes = 0;
    for (const entry of batchEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) corrupt("stored batch path is invalid");
      const stored = await this.readBatchDirectoryUnlocked(entry.name);
      usedBytes += stored.byteLength;
      if (!Number.isSafeInteger(usedBytes)) corrupt("batch archive size is invalid");
      records.set(entry.name, stored);
    }
    if (this.purpose === RANKED_PURPOSE) {
      const owners = new Set();
      for (const stored of records.values()) {
        if (effectivePurpose(stored.payload) !== RANKED_PURPOSE
          || stored.payload.competitionId !== this.competitionId) {
          corrupt("ranked batch archive contains a batch from another purpose or competition");
        }
        if (owners.has(stored.payload.ownerUserId)) {
          corrupt("ranked batch archive contains multiple attempts for one owner");
        }
        owners.add(stored.payload.ownerUserId);
        if (this.rankedLedgerReady) {
          const ledger = this.rankedAttemptLedgers.get(stored.payload.ownerUserId) || null;
          if (ledger === null) corrupt("ranked batch archive has no permanent attempt ledger");
          this.assertRankedLedgerMatchesPayload(ledger, stored.payload);
        }
      }
      if (this.rankedLedgerReady) {
        for (const ledger of this.rankedAttemptLedgers.values()) {
          if (ledger.state === "bound" && !records.has(ledger.batchId)) {
            corrupt("permanently bound ranked attempt is missing its batch archive");
          }
        }
      }
      this.rebuildRankedIndexes(records);
    }
    const archiveIdentity = canonicalSha256({
      schemaVersion: "chenlong.batch-archive-content-identity/v1",
      records: [...records.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([batchId, stored]) => ({
          batchId,
          byteLength: stored.byteLength,
          recordSha256: stored.recordSha256
        }))
    });
    if (this.archiveIdentity !== null && this.archiveIdentity !== archiveIdentity) {
      this.rankingSnapshot = null;
    }
    this.archiveIdentity = archiveIdentity;
    return { records, usedBytes };
  }

  async inspectRankedArchiveIdentityForServer() {
    if (this.purpose !== RANKED_PURPOSE) {
      throw storeError(400, "INVALID_BATCH_PURPOSE", "ranked archive identity requires a ranked batch store");
    }
    await this.ready;
    // This intentionally does not join the mutation tail. Ranking refreshes use
    // the identity before and after their read-only audit and discard a candidate
    // when a concurrent atomic write changes it. Holding the mutation tail while
    // statting the whole archive would let ranking I/O delay an on-time submit.
    const entries = await fs.promises.readdir(this.batchesDir, { withFileTypes: true });
    const batchEntries = entries.filter(entry => BATCH_ID_PATTERN.test(entry.name));
    const temporaryEntries = entries.filter(entry => TEMPORARY_BATCH_DIRECTORY_PATTERN.test(entry.name));
    if (entries.length !== batchEntries.length + temporaryEntries.length
      || batchEntries.length > MAX_ARCHIVED_BATCH_DIRECTORIES
      || temporaryEntries.some(entry => !entry.isDirectory() || entry.isSymbolicLink())) {
        corrupt("ranked batch archive contains unsupported entries");
    }
    const identities = [];
    for (const entry of batchEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) corrupt("stored batch path is invalid");
      const directory = path.join(this.batchesDir, entry.name);
      const children = await fs.promises.readdir(directory, { withFileTypes: true });
      const records = children.filter(child => child.name === "batch.json");
      const temporaryRecords = children.filter(child => TEMPORARY_RECORD_FILE_PATTERN.test(child.name));
      if (children.length !== records.length + temporaryRecords.length
        || records.length !== 1
        || !records[0].isFile() || records[0].isSymbolicLink()
        || temporaryRecords.some(child => !child.isFile() || child.isSymbolicLink())) {
        corrupt("stored batch directory contains unsupported entries");
      }
      const stat = await fs.promises.lstat(path.join(directory, "batch.json"));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_BATCH_RECORD_BYTES) {
        corrupt("stored batch record file is invalid");
      }
      identities.push({
        batchId: entry.name,
        byteLength: stat.size,
        device: String(stat.dev),
        inode: String(stat.ino),
        modifiedMilliseconds: stat.mtimeMs,
        changedMilliseconds: stat.ctimeMs
      });
    }
    const attemptDirectoryEntries = await fs.promises.readdir(this.rankedAttemptsDir, { withFileTypes: true });
    const attemptEntries = attemptDirectoryEntries.filter(entry => RANKED_ATTEMPT_LEDGER_FILE_PATTERN.test(entry.name));
    const temporaryAttempts = attemptDirectoryEntries.filter(entry => TEMPORARY_RANKED_ATTEMPT_FILE_PATTERN.test(entry.name));
    if (attemptDirectoryEntries.length !== attemptEntries.length + temporaryAttempts.length
      || attemptEntries.length > MAX_ARCHIVED_BATCH_DIRECTORIES
      || temporaryAttempts.some(entry => !entry.isFile() || entry.isSymbolicLink())) {
      corrupt("ranked attempt ledger directory contains unsupported entries");
    }
    const attempts = [];
    for (const entry of attemptEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.isSymbolicLink()) corrupt("ranked attempt ledger path is invalid");
      const stat = await fs.promises.lstat(path.join(this.rankedAttemptsDir, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink()
        || stat.size < 1 || stat.size > MAX_RANKED_ATTEMPT_LEDGER_BYTES) {
        corrupt("ranked attempt ledger file is invalid");
      }
      attempts.push({
        filename: entry.name,
        byteLength: stat.size,
        device: String(stat.dev),
        inode: String(stat.ino),
        modifiedMilliseconds: stat.mtimeMs,
        changedMilliseconds: stat.ctimeMs
      });
    }
    return canonicalSha256({
      schemaVersion: "chenlong.batch-archive-file-identity/v1",
      records: identities,
      attempts
    });
  }

  rebuildRankedIndexes(records) {
    if (this.purpose !== RANKED_PURPOSE) return;
    const ownerBatchIds = new Map();
    const finalized = new Map();
    for (const [batchId, stored] of records) {
      ownerBatchIds.set(stored.payload.ownerUserId, batchId);
      if (stored.payload.batchState.phase === "finalized") {
        finalized.set(batchId, {
          payload: {
            competitionId: stored.payload.competitionId,
            ownerUserId: stored.payload.ownerUserId,
            lockedTeamId: stored.payload.lockedTeamId,
            createdAt: stored.payload.createdAt,
            evaluationPolicy: stored.payload.evaluationPolicy
          },
          projection: publicBatchProjection(stored.payload.batchState)
        });
      }
    }
    for (const ledger of this.rankedAttemptLedgers.values()) {
      ownerBatchIds.set(ledger.ownerUserId, ledger.batchId);
    }
    this.rankedOwnerBatchIds = ownerBatchIds;
    this.rankedFinalizedIndex = finalized;
  }

  updateRankedIndexes(payload) {
    if (this.purpose !== RANKED_PURPOSE) return;
    this.rankedOwnerBatchIds.set(payload.ownerUserId, payload.batchId);
    if (payload.batchState.phase === "finalized") {
      this.rankedFinalizedIndex.set(payload.batchId, {
        payload: {
          competitionId: payload.competitionId,
          ownerUserId: payload.ownerUserId,
          lockedTeamId: payload.lockedTeamId,
          createdAt: payload.createdAt,
          evaluationPolicy: payload.evaluationPolicy
        },
        projection: publicBatchProjection(payload.batchState)
      });
    } else {
      this.rankedFinalizedIndex.delete(payload.batchId);
    }
  }

  authorizeStoredBatch(stored, ownerUserId, { allowExpired = false } = {}) {
    const owner = normalizeOwnerUserId(ownerUserId);
    if (stored.payload.ownerUserId !== owner) {
      throw storeError(403, "BATCH_OWNER_MISMATCH", "batch evaluation belongs to another user");
    }
    if (!allowExpired && this.timestampNow() >= Date.parse(stored.payload.expiresAt)) {
      throw storeError(410, "BATCH_EXPIRED", "batch evaluation has expired");
    }
    return stored;
  }

  buildPrivatePayload({ batchId, ownerUserId, source, teamId = null, createdAtMilliseconds }) {
    const commitmentNonce = randomHex();
    const layoutSelectionSecret = randomHex();
    const selectionSeed = this.purpose === RANKED_PURPOSE
      ? rankedLayoutSequenceSeed(this.competitionId, ownerUserId, batchId, commitmentNonce)
      : layoutSequenceSeed(batchId, commitmentNonce);
    const privateSlots = this.layoutSequenceProvider({
      secret: Buffer.from(layoutSelectionSecret, "hex"),
      seed: selectionSeed,
      count: FIXED_SLOT_COUNT
    });
    let batchState;
    try {
      batchState = createBatchEvaluationState({
        batchId,
        source,
        privateSlots,
        commitmentNonce
      });
    } catch (error) {
      throw translateCoreError(error);
    }
    const lockedSource = sourceMetadata(source, this.purpose === RANKED_PURPOSE ? {
      maximumBytes: MAX_RANKED_LOCKED_SOURCE_BYTES,
      statusCode: 400,
      code: "RANKED_SOURCE_TOO_LARGE"
    } : undefined);
    const payload = {
      schemaVersion: this.purpose === RANKED_PURPOSE
        ? BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2
        : BATCH_STORE_PAYLOAD_SCHEMA_VERSION,
      authoritative: AUTHORITATIVE,
      batchId,
      ownerUserId,
      createdAt: new Date(createdAtMilliseconds).toISOString(),
      expiresAt: new Date(createdAtMilliseconds + this.batchTtlMs).toISOString(),
      lockedSource,
      layoutSelectionSecret,
      batchState,
      batchStateDigest: canonicalSha256(batchState),
      slotExecutions: batchState.slots.map(slot => ({
        slotIndex: slot.slotIndex,
        layoutCommitment: slot.privateValue.layoutCommitment,
        sessionBinding: null,
        verifiedReceipt: null
      }))
    };
    if (this.purpose === RANKED_PURPOSE) {
      payload.purpose = RANKED_PURPOSE;
      payload.competitionId = this.competitionId;
      payload.lockedTeamId = normalizeRankedTeamId(teamId);
      payload.evaluationPolicy = this.evaluationPolicy;
    }
    return validatePrivatePayload(payload, batchId, this.validationContext);
  }

  async completeReservedRankedAttemptUnlocked(ledger, source) {
    if (ledger.state !== "reserved") corrupt("only a reserved ranked attempt can be completed");
    const sourceInfo = sourceMetadata(source, {
      maximumBytes: MAX_RANKED_LOCKED_SOURCE_BYTES,
      statusCode: 400,
      code: "RANKED_SOURCE_TOO_LARGE"
    });
    if (sourceInfo.digest !== ledger.sourceDigest) {
      throw storeError(409, "RANKED_ATTEMPT_ALREADY_EXISTS",
        "this account already reserved its ranked batch with another source");
    }
    const payload = this.buildPrivatePayload({
      batchId: ledger.batchId,
      ownerUserId: ledger.ownerUserId,
      source,
      teamId: ledger.lockedTeamId,
      createdAtMilliseconds: Date.parse(ledger.createdAt)
    });
    const buffer = makeRecord(payload);
    if (buffer.length + OPEN_BATCH_GROWTH_RESERVE_BYTES > MAX_BATCH_RECORD_BYTES) {
      throw storeError(413, "BATCH_RECORD_TOO_LARGE", "ranked batch evaluation record exceeds its size limit");
    }
    if (this.usedBytes + buffer.length + OPEN_BATCH_GROWTH_RESERVE_BYTES > this.maxStorageBytes) {
      throw storeError(507, "BATCH_STORAGE_FULL", "ranked batch storage budget is full");
    }
    await this.createStoredDirectoryUnlocked(ledger.batchId, buffer);
    this.usedBytes += buffer.length;
    this.rankingSnapshot = null;
    this.updateRankedIndexes(payload);
    await this.writeRankedAttemptLedgerUnlocked({ ...ledger, state: "bound" });
    return payload;
  }

  async createStoredDirectoryUnlocked(batchId, buffer) {
    const finalDirectory = this.batchDirectory(batchId);
    const temporaryDirectory = path.join(
      this.batchesDir,
      `.${batchId}.${crypto.randomUUID()}.tmp`
    );
    await fs.promises.mkdir(temporaryDirectory, { recursive: false, mode: 0o700 });
    try {
      await atomicWriteFile(temporaryDirectory, "batch.json", buffer);
      await fs.promises.rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      const children = await fs.promises.readdir(temporaryDirectory, { withFileTypes: true }).catch(() => []);
      for (const child of children) {
        if (child.isFile() && !child.isSymbolicLink()) {
          await fs.promises.unlink(path.join(temporaryDirectory, child.name)).catch(() => {});
        }
      }
      await fs.promises.rmdir(temporaryDirectory).catch(() => {});
      throw error;
    }
  }

  async replacePayloadUnlocked(stored, payload, archiveUsedBytes) {
    const buffer = makeRecord(payload);
    if (buffer.length > MAX_BATCH_RECORD_BYTES) {
      throw storeError(413, "BATCH_RECORD_TOO_LARGE", "batch evaluation record exceeds its size limit");
    }
    const finalUsedBytes = archiveUsedBytes - stored.byteLength + buffer.length;
    if (finalUsedBytes > this.maxStorageBytes) {
      throw storeError(507, "BATCH_STORAGE_FULL", "batch storage budget is full");
    }
    await atomicWriteFile(stored.directory, "batch.json", buffer);
    this.usedBytes = finalUsedBytes;
    this.rankingSnapshot = null;
    this.updateRankedIndexes(payload);
  }

  async finalizeStoredBatchUnlocked(stored, archiveUsedBytes) {
    let batchState;
    try {
      batchState = finalizeBatchEvaluation(stored.payload.batchState, {
        source: stored.payload.lockedSource.value
      });
    } catch (error) {
      throw translateCoreError(error);
    }
    if (batchState === stored.payload.batchState) return stored.payload;
    const payload = validatePrivatePayload({
      ...stored.payload,
      batchState,
      batchStateDigest: canonicalSha256(batchState)
    }, stored.payload.batchId, this.validationContext);
    await this.replacePayloadUnlocked(stored, payload, archiveUsedBytes);
    return payload;
  }

  async createBatch(command) {
    if (this.purpose !== PRACTICE_PURPOSE) {
      throw storeError(400, "INVALID_BATCH_PURPOSE", "practice createBatch is unavailable in a ranked store");
    }
    assertExactKeys(command, ["ownerUserId", "source"], "INVALID_CREATE_BATCH_COMMAND", "create batch command");
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    if (typeof command.source !== "string") {
      throw storeError(400, "INVALID_BATCH_SOURCE", "source must be a string");
    }
    const requestedSource = sourceMetadata(command.source);
    return this.withExclusiveOperation(async () => {
      const archive = await this.scanArchiveUnlocked();
      this.usedBytes = archive.usedBytes;
      const now = this.timestampNow();
      const storedBatches = [...archive.records.values()];
      const openBatchCount = storedBatches.filter(stored => (
        stored.payload.batchState.phase === "open" && now < Date.parse(stored.payload.expiresAt)
      )).length;
      const ownerBatches = storedBatches.filter(stored => stored.payload.ownerUserId === ownerUserId);
      const ownerOpenBatchCount = ownerBatches.filter(stored => (
        stored.payload.batchState.phase === "open" && now < Date.parse(stored.payload.expiresAt)
      )).length;
      const reusable = ownerBatches.find(stored => (
        stored.payload.batchState.phase === "open"
        && now < Date.parse(stored.payload.expiresAt)
        && stored.payload.lockedSource.digest === requestedSource.digest
      ));
      if (reusable) return publicStoredBatch(reusable.payload);
      if (archive.usedBytes > this.maxStorageBytes) {
        throw storeError(507, "BATCH_STORAGE_FULL", "batch storage budget is already exceeded");
      }
      if (archive.records.size >= MAX_ARCHIVED_BATCH_DIRECTORIES) {
        throw storeError(507, "BATCH_ARCHIVE_FULL", "batch archive directory limit reached");
      }
      if (ownerBatches.length >= this.maxRetainedBatchesPerOwner) {
        throw storeError(
          429,
          "OWNER_BATCH_RETENTION_LIMIT_REACHED",
          "owner retained batch evaluation limit reached"
        );
      }
      if (ownerOpenBatchCount >= this.maxOpenBatchesPerOwner) {
        throw storeError(
          429,
          "OWNER_OPEN_BATCH_LIMIT_REACHED",
          "owner open batch evaluation limit reached"
        );
      }
      if (openBatchCount >= this.maxBatches) {
        throw storeError(429, "BATCH_LIMIT_REACHED", "open batch evaluation limit reached");
      }

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const batchId = `bat_${randomHex(16)}`;
        if (archive.records.has(batchId)) continue;
        const payload = this.buildPrivatePayload({
          batchId,
          ownerUserId,
          source: command.source,
          createdAtMilliseconds: now
        });
        const buffer = makeRecord(payload);
        if (buffer.length + OPEN_BATCH_GROWTH_RESERVE_BYTES > MAX_BATCH_RECORD_BYTES) {
          throw storeError(413, "BATCH_RECORD_TOO_LARGE", "batch evaluation record exceeds its size limit");
        }
        const openBatchReservations = storedBatches.reduce((total, stored) => (
          total + (stored.payload.batchState.phase === "open" ? OPEN_BATCH_GROWTH_RESERVE_BYTES : 0)
        ), 0);
        if (archive.usedBytes + openBatchReservations + buffer.length
          + OPEN_BATCH_GROWTH_RESERVE_BYTES > this.maxStorageBytes) {
          throw storeError(507, "BATCH_STORAGE_FULL", "batch storage budget is full");
        }
        try {
          await this.createStoredDirectoryUnlocked(batchId, buffer);
        } catch (error) {
          if (["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) continue;
          throw error;
        }
        this.usedBytes = archive.usedBytes + buffer.length;
        return publicStoredBatch(payload);
      }
      throw storeError(503, "BATCH_ID_UNAVAILABLE", "could not allocate a unique batch evaluation id");
    });
  }

  async createRankedBatch(command) {
    if (this.purpose !== RANKED_PURPOSE) {
      throw storeError(400, "INVALID_BATCH_PURPOSE", "ranked creation requires a ranked batch store");
    }
    assertExactKeys(
      command,
      ["ownerUserId", "source", "teamId"],
      "INVALID_CREATE_RANKED_BATCH_COMMAND",
      "create ranked batch command"
    );
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    if (typeof command.source !== "string") {
      throw storeError(400, "INVALID_BATCH_SOURCE", "source must be a string");
    }
    const requestedSource = sourceMetadata(command.source, {
      maximumBytes: MAX_RANKED_LOCKED_SOURCE_BYTES,
      statusCode: 400,
      code: "RANKED_SOURCE_TOO_LARGE"
    });
    const lockedTeamId = normalizeRankedTeamId(command.teamId);
    return this.withExclusiveOperation(async () => {
      const indexedBatchId = this.rankedOwnerBatchIds.get(ownerUserId) || null;
      if (indexedBatchId !== null) {
        const ledger = this.rankedAttemptLedgers.get(ownerUserId) || null;
        if (ledger === null || ledger.batchId !== indexedBatchId) {
          corrupt("ranked owner index has no matching permanent attempt ledger");
        }
        if (ledger.sourceDigest !== requestedSource.digest || ledger.lockedTeamId !== lockedTeamId) {
          throw storeError(
            409,
            "RANKED_ATTEMPT_ALREADY_EXISTS",
            "this account already created its ranked batch for this competition"
          );
        }
        let existing;
        try {
          existing = this.authorizeStoredBatch(
            await this.readBatchDirectoryUnlocked(indexedBatchId),
            ownerUserId,
            { allowExpired: true }
          );
        } catch (error) {
          if (!(error instanceof BatchEvaluationStoreError) || error.code !== "BATCH_NOT_FOUND") throw error;
          if (ledger.state === "bound") {
            corrupt("permanently bound ranked attempt is missing its batch archive");
          }
          const payload = await this.completeReservedRankedAttemptUnlocked(ledger, command.source);
          return privateClone({ created: true, ...rankedOwnerProjection(payload) });
        }
        this.assertRankedLedgerMatchesPayload(ledger, existing.payload);
        if (ledger.state === "reserved") {
          await this.writeRankedAttemptLedgerUnlocked({ ...ledger, state: "bound" });
        }
        const now = this.timestampNow();
        const payload = existing.payload.batchState.phase === "open"
          && now >= Date.parse(existing.payload.expiresAt)
          ? await this.finalizeStoredBatchUnlocked(existing, this.usedBytes)
          : existing.payload;
        if (payload.lockedSource.digest !== requestedSource.digest
          || payload.lockedTeamId !== lockedTeamId) {
          throw storeError(
            409,
            "RANKED_ATTEMPT_ALREADY_EXISTS",
            "this account already created its ranked batch for this competition"
          );
        }
        return privateClone({ created: false, ...rankedOwnerProjection(payload) });
      }
      const archive = await this.scanArchiveUnlocked();
      this.usedBytes = archive.usedBytes;
      const now = this.timestampNow();
      const storedBatches = [...archive.records.values()];

      const discoveredExisting = storedBatches
        .find(stored => stored.payload.ownerUserId === ownerUserId) || null;
      if (discoveredExisting) {
        const payload = discoveredExisting.payload.batchState.phase === "open"
          && now >= Date.parse(discoveredExisting.payload.expiresAt)
          ? await this.finalizeStoredBatchUnlocked(discoveredExisting, archive.usedBytes)
          : discoveredExisting.payload;
        if (payload.lockedSource.digest !== requestedSource.digest
          || payload.lockedTeamId !== lockedTeamId) {
          throw storeError(
            409,
            "RANKED_ATTEMPT_ALREADY_EXISTS",
            "this account already created its ranked batch for this competition"
          );
        }
        return privateClone({ created: false, ...rankedOwnerProjection(payload) });
      }

      if (archive.usedBytes > this.maxStorageBytes) {
        throw storeError(507, "BATCH_STORAGE_FULL", "ranked batch storage budget is already exceeded");
      }
      if (archive.records.size >= MAX_ARCHIVED_BATCH_DIRECTORIES) {
        throw storeError(507, "BATCH_ARCHIVE_FULL", "ranked batch archive directory limit reached");
      }
      const openBatchCount = storedBatches.filter(stored => (
        stored.payload.batchState.phase === "open" && now < Date.parse(stored.payload.expiresAt)
      )).length;
      if (openBatchCount >= this.maxBatches) {
        throw storeError(429, "BATCH_LIMIT_REACHED", "open ranked batch evaluation limit reached");
      }

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const batchId = `bat_${randomHex(16)}`;
        if (archive.records.has(batchId)) continue;
        const payload = this.buildPrivatePayload({
          batchId,
          ownerUserId,
          source: command.source,
          teamId: lockedTeamId,
          createdAtMilliseconds: now
        });
        const buffer = makeRecord(payload);
        if (buffer.length + OPEN_BATCH_GROWTH_RESERVE_BYTES > MAX_BATCH_RECORD_BYTES) {
          throw storeError(413, "BATCH_RECORD_TOO_LARGE", "ranked batch evaluation record exceeds its size limit");
        }
        const openBatchReservations = storedBatches.reduce((total, stored) => (
          total + (stored.payload.batchState.phase === "open" ? OPEN_BATCH_GROWTH_RESERVE_BYTES : 0)
        ), 0);
        if (archive.usedBytes + openBatchReservations + buffer.length
          + OPEN_BATCH_GROWTH_RESERVE_BYTES > this.maxStorageBytes) {
          throw storeError(507, "BATCH_STORAGE_FULL", "ranked batch storage budget is full");
        }
        const reservedLedger = this.rankedAttemptLedgerForPayload(payload, "reserved");
        await this.writeRankedAttemptLedgerUnlocked(reservedLedger);
        try {
          await this.createStoredDirectoryUnlocked(batchId, buffer);
        } catch (error) {
          throw error;
        }
        this.usedBytes = archive.usedBytes + buffer.length;
        this.rankingSnapshot = null;
        this.updateRankedIndexes(payload);
        await this.writeRankedAttemptLedgerUnlocked({ ...reservedLedger, state: "bound" });
        return privateClone({ created: true, ...rankedOwnerProjection(payload) });
      }
      throw storeError(503, "BATCH_ID_UNAVAILABLE", "could not allocate a unique ranked batch evaluation id");
    });
  }

  async readBatch(command) {
    assertExactKeys(command, ["ownerUserId", "batchId"], "INVALID_READ_BATCH_COMMAND", "read batch command");
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    const batchId = normalizeBatchId(command.batchId);
    return this.withExclusiveOperation(async () => {
      if (this.purpose === RANKED_PURPOSE) {
        const stored = this.authorizeStoredBatch(
          await this.readBatchDirectoryUnlocked(batchId),
          ownerUserId,
          { allowExpired: true }
        );
        const expired = this.timestampNow() >= Date.parse(stored.payload.expiresAt);
        const payload = expired && stored.payload.batchState.phase === "open"
          ? await this.finalizeStoredBatchUnlocked(stored, this.usedBytes)
          : stored.payload;
        return rankedOwnerProjection(payload);
      }
      const archive = await this.scanArchiveUnlocked();
      this.usedBytes = archive.usedBytes;
      const stored = archive.records.get(batchId);
      if (!stored) throw storeError(404, "BATCH_NOT_FOUND", "batch evaluation not found");
      this.authorizeStoredBatch(stored, ownerUserId, { allowExpired: true });
      const expired = this.timestampNow() >= Date.parse(stored.payload.expiresAt);
      const payload = expired && stored.payload.batchState.phase === "open"
        ? await this.finalizeStoredBatchUnlocked(stored, archive.usedBytes)
        : stored.payload;
      return publicStoredBatch(payload);
    });
  }

  async listOpenBatches(command) {
    assertExactKeys(command, ["ownerUserId"], "INVALID_LIST_OPEN_BATCHES_COMMAND", "list open batches command");
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    return this.withExclusiveOperation(async () => {
      const archive = await this.scanArchiveUnlocked();
      this.usedBytes = archive.usedBytes;
      const now = this.timestampNow();
      let archiveUsedBytes = archive.usedBytes;
      const open = [];
      for (const stored of archive.records.values()) {
        if (stored.payload.ownerUserId !== ownerUserId) continue;
        let payload = stored.payload;
        if (payload.batchState.phase === "open" && now >= Date.parse(payload.expiresAt)) {
          payload = await this.finalizeStoredBatchUnlocked(stored, archiveUsedBytes);
          archiveUsedBytes = this.usedBytes;
        }
        if (payload.batchState.phase === "open" && now < Date.parse(payload.expiresAt)) {
          open.push(publicOpenBatchDiscovery(payload));
        }
      }
      open.sort((left, right) => (
        Date.parse(right.createdAt) - Date.parse(left.createdAt)
        || (left.batchId < right.batchId ? -1 : left.batchId > right.batchId ? 1 : 0)
      ));
      return privateClone(open.slice(0, MAX_DISCOVERED_OPEN_BATCHES));
    });
  }

  async readRankedBatchForOwner(command) {
    if (this.purpose !== RANKED_PURPOSE) {
      throw storeError(400, "INVALID_BATCH_PURPOSE", "ranked owner lookup requires a ranked batch store");
    }
    assertExactKeys(
      command,
      ["ownerUserId"],
      "INVALID_READ_RANKED_BATCH_COMMAND",
      "read ranked batch command"
    );
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    return this.withExclusiveOperation(async () => {
      const stored = await this.readPermanentRankedOwnerBatchUnlocked(ownerUserId);
      if (stored === null) return null;
      const expired = this.timestampNow() >= Date.parse(stored.payload.expiresAt);
      const payload = expired && stored.payload.batchState.phase === "open"
        ? await this.finalizeStoredBatchUnlocked(stored, this.usedBytes)
        : stored.payload;
      return rankedOwnerProjection(payload);
    });
  }

  async rankedRankingSnapshotUnlocked() {
    const now = this.timestampNow();
    if (this.rankingSnapshot !== null
      && (this.rankingSnapshot.validUntil === null || now < this.rankingSnapshot.validUntil)) {
      return this.rankingSnapshot.entries;
    }
    const archive = await this.scanArchiveUnlocked();
    this.usedBytes = archive.usedBytes;
    let archiveUsedBytes = archive.usedBytes;
    let validUntil = null;
    const finalized = [];
    for (const stored of archive.records.values()) {
      let payload = stored.payload;
      if (payload.batchState.phase === "open" && now >= Date.parse(payload.expiresAt)) {
        payload = await this.finalizeStoredBatchUnlocked(stored, archiveUsedBytes);
        archiveUsedBytes = this.usedBytes;
      }
      if (payload.batchState.phase === "open") {
        const expiresAt = Date.parse(payload.expiresAt);
        validUntil = validUntil === null ? expiresAt : Math.min(validUntil, expiresAt);
      }
      if (payload.batchState.phase !== "finalized") continue;
      finalized.push(payload);
    }
    const entries = rankedEntriesFromFinalizedPayloads(finalized);
    this.rankingSnapshot = privateClone({ validUntil, entries });
    return this.rankingSnapshot.entries;
  }

  async listRankedResults(command) {
    if (this.purpose !== RANKED_PURPOSE) {
      throw storeError(400, "INVALID_BATCH_PURPOSE", "ranked results require a ranked batch store");
    }
    assertExactKeys(
      command,
      ["offset", "limit"],
      "INVALID_LIST_RANKED_RESULTS_COMMAND",
      "list ranked results command"
    );
    if (!Number.isSafeInteger(command.offset)
      || command.offset < 0 || command.offset > MAX_RANKING_LIST_OFFSET
      || !Number.isSafeInteger(command.limit)
      || command.limit < 1 || command.limit > MAX_RANKING_LIST_LIMIT) {
      throw storeError(400, "INVALID_LIST_RANKED_RESULTS_COMMAND", "ranked result pagination is invalid");
    }
    return this.withExclusiveOperation(async () => {
      const entries = await this.rankedRankingSnapshotUnlocked();
      return privateClone({
        total: entries.length,
        entries: entries.slice(command.offset, command.offset + command.limit)
      });
    });
  }

  async readRankedResultForOwner(command) {
    if (this.purpose !== RANKED_PURPOSE) {
      throw storeError(400, "INVALID_BATCH_PURPOSE", "ranked result lookup requires a ranked batch store");
    }
    assertExactKeys(
      command,
      ["ownerUserId"],
      "INVALID_READ_RANKED_RESULT_COMMAND",
      "read ranked result command"
    );
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    return this.withExclusiveOperation(async () => {
      const entries = await this.rankedRankingSnapshotUnlocked();
      const entry = entries.find(candidate => candidate.ownerUserId === ownerUserId) || null;
      return entry === null ? null : privateClone(entry);
    });
  }

  async readRankedResultForOwnerWithoutFinalizationForServer(command) {
    if (this.purpose !== RANKED_PURPOSE) {
      throw storeError(400, "INVALID_BATCH_PURPOSE", "ranked result lookup requires a ranked batch store");
    }
    assertExactKeys(
      command,
      ["ownerUserId"],
      "INVALID_READ_RANKED_RESULT_COMMAND",
      "read ranked owner result command"
    );
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    return this.withExclusiveOperation(async () => {
      const entries = rankedEntriesFromPrepared(
        [...this.rankedFinalizedIndex.values()].map(item => privateClone(item))
      );
      const entry = entries.find(candidate => candidate.ownerUserId === ownerUserId) || null;
      return entry === null ? null : privateClone(entry);
    });
  }

  assertCurrentSlot(payload, slotIndex) {
    if (!Number.isSafeInteger(slotIndex) || slotIndex < 1 || slotIndex > FIXED_SLOT_COUNT) {
      throw storeError(400, "INVALID_BATCH_SLOT", `slotIndex must be between 1 and ${FIXED_SLOT_COUNT}`);
    }
    if (payload.batchState.phase !== "open" || payload.batchState.nextSlotIndex === null) {
      throw storeError(409, "BATCH_FINALIZED", "batch evaluation is already finalized");
    }
    if (payload.batchState.nextSlotIndex !== slotIndex) {
      throw storeError(409, "SLOT_NOT_CURRENT", `slot ${payload.batchState.nextSlotIndex} is the current batch slot`);
    }
    return payload.batchState.slots[slotIndex - 1];
  }

  serverCurrentSlotLease(payload, slotIndex) {
    const slot = this.assertCurrentSlot(payload, slotIndex);
    const execution = payload.slotExecutions[slotIndex - 1];
    // This object is intentionally server-only. Public methods never call this
    // projector because it contains the locked source and current private layout.
    const projection = {
      authoritative: AUTHORITATIVE,
      batchId: payload.batchId,
      slotIndex,
      source: payload.lockedSource.value,
      sourceDigest: payload.lockedSource.digest,
      privateLayoutSelection: slot.privateValue,
      publicLayout: projectPublicLayoutSelection(slot.privateValue),
      currentSlotBinding: execution.sessionBinding
    };
    if (payload.schemaVersion === BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2) {
      projection.expiresAt = payload.expiresAt;
      projection.purpose = payload.purpose;
      projection.competitionId = payload.competitionId;
      projection.lockedTeamId = payload.lockedTeamId;
      projection.evaluationPolicy = payload.evaluationPolicy;
    }
    return privateClone(projection);
  }

  async readCurrentSlotForServer(command) {
    assertExactKeys(
      command,
      ["ownerUserId", "batchId", "slotIndex"],
      "INVALID_CURRENT_SLOT_COMMAND",
      "current slot server command"
    );
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    const batchId = normalizeBatchId(command.batchId);
    return this.withExclusiveOperation(async () => {
      const stored = this.authorizeStoredBatch(
        await this.readBatchDirectoryUnlocked(batchId),
        ownerUserId
      );
      return this.serverCurrentSlotLease(stored.payload, command.slotIndex);
    });
  }

  async readSlotExecutionForServer(command) {
    assertExactKeys(
      command,
      ["ownerUserId", "batchId", "slotIndex"],
      "INVALID_SLOT_EXECUTION_COMMAND",
      "slot execution server command"
    );
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    const batchId = normalizeBatchId(command.batchId);
    if (!Number.isSafeInteger(command.slotIndex)
      || command.slotIndex < 1
      || command.slotIndex > FIXED_SLOT_COUNT) {
      throw storeError(400, "INVALID_BATCH_SLOT", `slotIndex must be between 1 and ${FIXED_SLOT_COUNT}`);
    }
    return this.withExclusiveOperation(async () => {
      const stored = this.authorizeStoredBatch(
        await this.readBatchDirectoryUnlocked(batchId),
        ownerUserId
      );
      const slot = stored.payload.batchState.slots[command.slotIndex - 1];
      const isCompleted = slot.result !== null;
      const isCurrent = stored.payload.batchState.phase === "open"
        && stored.payload.batchState.nextSlotIndex === command.slotIndex;
      if (!isCompleted && !isCurrent) {
        throw storeError(409, "SLOT_NOT_AVAILABLE", "future batch slot execution is not available");
      }
      const execution = stored.payload.slotExecutions[command.slotIndex - 1];
      // Deliberately narrower than readCurrentSlotForServer: recovery callers
      // receive identifiers and receipts, never source or a private layout.
      const projection = {
        authoritative: AUTHORITATIVE,
        batchId,
        slotIndex: command.slotIndex,
        sourceDigest: stored.payload.lockedSource.digest,
        layoutCommitment: execution.layoutCommitment,
        sessionBinding: execution.sessionBinding,
        verifiedReceipt: execution.verifiedReceipt
      };
      if (stored.payload.schemaVersion === BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2) {
        projection.expiresAt = stored.payload.expiresAt;
        projection.purpose = stored.payload.purpose;
        projection.competitionId = stored.payload.competitionId;
        projection.lockedTeamId = stored.payload.lockedTeamId;
      }
      return privateClone(projection);
    });
  }

  rankedBatchEvidenceForServer(payload) {
    if (payload.schemaVersion !== BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2
      || payload.purpose !== RANKED_PURPOSE) {
      corrupt("ranked server evidence received a non-ranked batch");
    }
    return privateClone({
      authoritative: AUTHORITATIVE,
      purpose: payload.purpose,
      competitionId: payload.competitionId,
      ownerUserId: payload.ownerUserId,
      batchId: payload.batchId,
      phase: payload.batchState.phase,
      createdAt: payload.createdAt,
      expiresAt: payload.expiresAt,
      sourceDigest: payload.lockedSource.digest,
      lockedTeamId: payload.lockedTeamId,
      evaluationPolicy: payload.evaluationPolicy,
      rankingProjection: publicBatchProjection(payload.batchState),
      slots: payload.slotExecutions.map((execution, index) => ({
        slotIndex: execution.slotIndex,
        layoutCommitment: execution.layoutCommitment,
        sessionBinding: execution.sessionBinding,
        verifiedReceipt: execution.verifiedReceipt,
        result: payload.batchState.slots[index].result,
        current: payload.batchState.phase === "open"
          && payload.batchState.nextSlotIndex === execution.slotIndex
      }))
    });
  }

  async listRankedBatchIdentifiersForServer() {
    if (this.purpose !== RANKED_PURPOSE) {
      throw storeError(400, "INVALID_BATCH_PURPOSE", "ranked identifiers require a ranked batch store");
    }
    await this.ready;
    // Read the small permanent ledgers directly instead of scanning every large
    // batch record under the store mutation tail. A ranking candidate later reads
    // each referenced batch atomically and verifies the archive identity twice.
    const attemptDirectoryEntries = await fs.promises.readdir(this.rankedAttemptsDir, { withFileTypes: true });
    const attemptEntries = attemptDirectoryEntries.filter(entry => RANKED_ATTEMPT_LEDGER_FILE_PATTERN.test(entry.name));
    const temporaryAttempts = attemptDirectoryEntries.filter(entry => TEMPORARY_RANKED_ATTEMPT_FILE_PATTERN.test(entry.name));
    if (attemptDirectoryEntries.length !== attemptEntries.length + temporaryAttempts.length
      || attemptEntries.length > MAX_ARCHIVED_BATCH_DIRECTORIES
      || temporaryAttempts.some(entry => !entry.isFile() || entry.isSymbolicLink())) {
      corrupt("ranked attempt ledger directory contains unsupported entries");
    }
    const ledgers = [];
    const referencedBatchIds = new Set();
    for (const entry of attemptEntries) {
      if (!entry.isFile() || entry.isSymbolicLink()) corrupt("ranked attempt ledger path is invalid");
      const ownerUserId = RANKED_ATTEMPT_LEDGER_FILE_PATTERN.exec(entry.name)[1];
      const buffer = await readStrictFile(
        path.join(this.rankedAttemptsDir, entry.name),
        MAX_RANKED_ATTEMPT_LEDGER_BYTES
      );
      let record;
      try {
        record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
      } catch (_error) {
        corrupt("ranked attempt ledger is not valid JSON");
      }
      const ledger = validateRankedAttemptLedgerRecord(record, ownerUserId, this.competitionId);
      if (referencedBatchIds.has(ledger.batchId)) {
        corrupt("ranked attempt ledgers reference the same batch more than once");
      }
      referencedBatchIds.add(ledger.batchId);
      ledgers.push(ledger);
    }

    const archiveEntries = await fs.promises.readdir(this.batchesDir, { withFileTypes: true });
    const batchEntries = archiveEntries.filter(entry => BATCH_ID_PATTERN.test(entry.name));
    const temporaryBatches = archiveEntries.filter(entry => TEMPORARY_BATCH_DIRECTORY_PATTERN.test(entry.name));
    if (archiveEntries.length !== batchEntries.length + temporaryBatches.length
      || batchEntries.length > MAX_ARCHIVED_BATCH_DIRECTORIES
      || temporaryBatches.some(entry => !entry.isDirectory() || entry.isSymbolicLink())
      || batchEntries.some(entry => !entry.isDirectory() || entry.isSymbolicLink())) {
      corrupt("ranked batch archive contains unsupported entries");
    }
    const archivedBatchIds = new Set(batchEntries.map(entry => entry.name));
    for (const batchId of archivedBatchIds) {
      if (!referencedBatchIds.has(batchId)) {
        corrupt("ranked batch archive has no permanent attempt ledger");
      }
    }
    const identifiers = [];
    for (const ledger of ledgers) {
      if (!archivedBatchIds.has(ledger.batchId)) {
        if (ledger.state === "bound") {
          corrupt("permanently bound ranked attempt is missing its batch archive");
        }
        continue;
      }
      identifiers.push({ ownerUserId: ledger.ownerUserId, batchId: ledger.batchId });
    }
    return privateClone(identifiers.sort((left, right) => left.batchId.localeCompare(right.batchId)));
  }

  async readRankedBatchEvidenceSnapshotForServer(command) {
    if (this.purpose !== RANKED_PURPOSE) {
      throw storeError(400, "INVALID_BATCH_PURPOSE", "ranked evidence requires a ranked batch store");
    }
    assertExactKeys(
      command,
      ["ownerUserId", "batchId"],
      "INVALID_RANKED_EVIDENCE_COMMAND",
      "ranked evidence command"
    );
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    const batchId = normalizeBatchId(command.batchId);
    await this.ready;
    const stored = this.authorizeStoredBatch(
      await this.readBatchDirectoryUnlocked(batchId),
      ownerUserId,
      { allowExpired: true }
    );
    return this.rankedBatchEvidenceForServer(stored.payload);
  }

  rankPreparedRankedEvidenceForServer(evidence) {
    if (this.purpose !== RANKED_PURPOSE) {
      throw storeError(400, "INVALID_BATCH_PURPOSE", "ranked evidence requires a ranked batch store");
    }
    if (!Array.isArray(evidence) || evidence.length > MAX_ARCHIVED_BATCH_DIRECTORIES) {
      corrupt("prepared ranked evidence collection is invalid");
    }
    const finalized = [];
    const batchIds = new Set();
    for (const item of evidence) {
      if (!item || item.purpose !== RANKED_PURPOSE || item.competitionId !== this.competitionId
        || !BATCH_ID_PATTERN.test(item.batchId || "") || batchIds.has(item.batchId)
        || item.rankingProjection?.batchId !== item.batchId
        || item.rankingProjection?.sourceDigest !== item.sourceDigest
        || item.rankingProjection?.phase !== item.phase) {
        corrupt("prepared ranked evidence is inconsistent");
      }
      batchIds.add(item.batchId);
      if (item.phase !== "finalized") continue;
      finalized.push({
        payload: {
          competitionId: item.competitionId,
          ownerUserId: item.ownerUserId,
          lockedTeamId: item.lockedTeamId,
          createdAt: item.createdAt,
          evaluationPolicy: item.evaluationPolicy
        },
        projection: privateClone(item.rankingProjection)
      });
    }
    return rankedEntriesFromPrepared(finalized);
  }

  batchSessionEvidenceForServer(payload) {
    return privateClone({
      authoritative: AUTHORITATIVE,
      purpose: payload.schemaVersion === BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2
        ? payload.purpose
        : PRACTICE_PURPOSE,
      competitionId: payload.schemaVersion === BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2
        ? payload.competitionId
        : null,
      ownerUserId: payload.ownerUserId,
      batchId: payload.batchId,
      phase: payload.batchState.phase,
      expiresAt: payload.expiresAt,
      slots: payload.slotExecutions.map((execution, index) => ({
        slotIndex: execution.slotIndex,
        sessionBinding: execution.sessionBinding,
        verifiedReceipt: execution.verifiedReceipt,
        result: payload.batchState.slots[index].result
      }))
    });
  }

  async listBatchSessionEvidenceForServer() {
    return this.withExclusiveOperation(async () => {
      const archive = await this.scanArchiveUnlocked();
      this.usedBytes = archive.usedBytes;
      return [...archive.records.values()]
        .map(stored => this.batchSessionEvidenceForServer(stored.payload))
        .sort((left, right) => left.batchId.localeCompare(right.batchId));
    });
  }

  async readBatchSessionEvidenceForServer(command) {
    assertExactKeys(
      command,
      ["ownerUserId", "batchId"],
      "INVALID_BATCH_SESSION_EVIDENCE_COMMAND",
      "batch session evidence command"
    );
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    const batchId = normalizeBatchId(command.batchId);
    return this.withExclusiveOperation(async () => {
      const stored = this.authorizeStoredBatch(
        await this.readBatchDirectoryUnlocked(batchId),
        ownerUserId,
        { allowExpired: true }
      );
      return this.batchSessionEvidenceForServer(stored.payload);
    });
  }

  async listRankedBatchEvidenceForServer() {
    if (this.purpose !== RANKED_PURPOSE) {
      throw storeError(400, "INVALID_BATCH_PURPOSE", "ranked evidence requires a ranked batch store");
    }
    return this.withExclusiveOperation(async () => {
      const archive = await this.scanArchiveUnlocked();
      this.usedBytes = archive.usedBytes;
      return [...archive.records.values()]
        .map(stored => this.rankedBatchEvidenceForServer(stored.payload))
        .sort((left, right) => left.batchId.localeCompare(right.batchId));
    });
  }

  async readRankedOwnerBatchEvidenceForServer(command) {
    if (this.purpose !== RANKED_PURPOSE) {
      throw storeError(400, "INVALID_BATCH_PURPOSE", "ranked evidence requires a ranked batch store");
    }
    assertExactKeys(
      command,
      ["ownerUserId"],
      "INVALID_RANKED_EVIDENCE_COMMAND",
      "ranked owner evidence command"
    );
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    return this.withExclusiveOperation(async () => {
      const stored = await this.readPermanentRankedOwnerBatchUnlocked(ownerUserId);
      if (stored === null) return null;
      return this.rankedBatchEvidenceForServer(stored.payload);
    });
  }

  async readRankedBatchEvidenceForServer(command) {
    if (this.purpose !== RANKED_PURPOSE) {
      throw storeError(400, "INVALID_BATCH_PURPOSE", "ranked evidence requires a ranked batch store");
    }
    assertExactKeys(
      command,
      ["ownerUserId", "batchId"],
      "INVALID_RANKED_EVIDENCE_COMMAND",
      "ranked evidence command"
    );
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    const batchId = normalizeBatchId(command.batchId);
    return this.withExclusiveOperation(async () => {
      const stored = this.authorizeStoredBatch(
        await this.readBatchDirectoryUnlocked(batchId),
        ownerUserId,
        { allowExpired: true }
      );
      return this.rankedBatchEvidenceForServer(stored.payload);
    });
  }

  async bindCurrentSlotSession(command) {
    const commandKeys = [
      "ownerUserId", "batchId", "slotIndex", "layoutCommitment", "sessionId", "runId",
      "challengeDigest", "runDefinitionDigest"
    ];
    if (this.purpose === RANKED_PURPOSE) commandKeys.push("teamId");
    assertExactKeys(command, commandKeys, "INVALID_SLOT_SESSION_BINDING", "slot session binding command");
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    const batchId = normalizeBatchId(command.batchId);
    const rankedTeamId = this.purpose === RANKED_PURPOSE
      ? normalizeRankedTeamId(command.teamId)
      : null;
    if (!SHA256_PATTERN.test(command.layoutCommitment || "")
      || !SESSION_ID_PATTERN.test(command.sessionId || "")
      || !RUN_ID_PATTERN.test(command.runId || "")
      || !SHA256_PATTERN.test(command.challengeDigest || "")
      || !SHA256_PATTERN.test(command.runDefinitionDigest || "")) {
      throw storeError(400, "INVALID_SLOT_SESSION_BINDING", "slot session binding fields are invalid");
    }
    return this.withExclusiveOperation(async () => {
      let stored;
      let archiveUsedBytes;
      if (this.purpose === RANKED_PURPOSE) {
        stored = await this.readBatchDirectoryUnlocked(batchId);
        archiveUsedBytes = this.usedBytes;
      } else {
        const archive = await this.scanArchiveUnlocked();
        this.usedBytes = archive.usedBytes;
        stored = archive.records.get(batchId);
        archiveUsedBytes = archive.usedBytes;
      }
      if (archiveUsedBytes > this.maxStorageBytes) {
        throw storeError(507, "BATCH_STORAGE_FULL", "batch storage budget is already exceeded");
      }
      if (!stored) throw storeError(404, "BATCH_NOT_FOUND", "batch evaluation not found");
      this.authorizeStoredBatch(stored, ownerUserId);
      if (this.purpose === RANKED_PURPOSE && stored.payload.lockedTeamId !== rankedTeamId) {
        throw storeError(409, "RANKED_TEAM_LOCKED", "ranked slot session must use the locked teamId");
      }
      const slot = this.assertCurrentSlot(stored.payload, command.slotIndex);
      if (slot.privateValue.layoutCommitment !== command.layoutCommitment) {
        throw storeError(409, "SLOT_LAYOUT_MISMATCH", "layout commitment does not match the current slot");
      }
      const execution = stored.payload.slotExecutions[command.slotIndex - 1];
      const requestedBinding = {
        schemaVersion: this.purpose === RANKED_PURPOSE
          ? BATCH_SLOT_SESSION_BINDING_SCHEMA_VERSION_V2
          : BATCH_SLOT_SESSION_BINDING_SCHEMA_VERSION,
        sessionId: command.sessionId,
        runId: command.runId,
        challengeDigest: command.challengeDigest,
        runDefinitionDigest: command.runDefinitionDigest
      };
      if (this.purpose === RANKED_PURPOSE) requestedBinding.teamId = rankedTeamId;
      if (execution.sessionBinding !== null) {
        const existingComparable = {
          schemaVersion: execution.sessionBinding.schemaVersion,
          sessionId: execution.sessionBinding.sessionId,
          runId: execution.sessionBinding.runId,
          challengeDigest: execution.sessionBinding.challengeDigest,
          runDefinitionDigest: execution.sessionBinding.runDefinitionDigest
        };
        if (this.purpose === RANKED_PURPOSE) {
          existingComparable.teamId = execution.sessionBinding.teamId;
        }
        if (canonicalJson(existingComparable) !== canonicalJson(requestedBinding)) {
          throw storeError(409, "SLOT_SESSION_ALREADY_BOUND", "current slot is already bound to another session");
        }
        return this.serverCurrentSlotLease(stored.payload, command.slotIndex);
      }
      const sessionBinding = {
        ...requestedBinding,
        boundAt: new Date(this.timestampNow()).toISOString()
      };
      const slotExecutions = stored.payload.slotExecutions.map((candidate, index) => (
        index === command.slotIndex - 1 ? { ...candidate, sessionBinding } : candidate
      ));
      const payload = validatePrivatePayload(
        { ...stored.payload, slotExecutions },
        batchId,
        this.validationContext
      );
      await this.replacePayloadUnlocked(stored, payload, archiveUsedBytes);
      return this.serverCurrentSlotLease(payload, command.slotIndex);
    });
  }

  async submitVerifiedSlotResult(command, options = {}) {
    if (!isPlainObject(options)
      || Object.keys(options).some(key => key !== "allowExpiredCommit")
      || (this.purpose !== RANKED_PURPOSE && Object.keys(options).length !== 0)) {
      throw storeError(400, "INVALID_VERIFIED_SLOT_OPTIONS", "verified slot options are invalid");
    }
    const allowExpiredCommit = this.purpose === RANKED_PURPOSE
      && options.allowExpiredCommit === true;
    if (Object.prototype.hasOwnProperty.call(options, "allowExpiredCommit")
      && typeof options.allowExpiredCommit !== "boolean") {
      throw storeError(400, "INVALID_VERIFIED_SLOT_OPTIONS", "allowExpiredCommit must be boolean");
    }
    const commandKeys = [
      "ownerUserId", "batchId", "slotIndex", "sessionId", "submissionId", "recordSha256", "result"
    ];
    if (this.purpose === RANKED_PURPOSE) commandKeys.push("reportSha256", "archivedAt");
    assertExactKeys(
      command,
      commandKeys,
      "INVALID_VERIFIED_SLOT_COMMAND",
      "verified slot command"
    );
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    const batchId = normalizeBatchId(command.batchId);
    if (!Number.isSafeInteger(command.slotIndex) || command.slotIndex < 1 || command.slotIndex > FIXED_SLOT_COUNT
      || !SESSION_ID_PATTERN.test(command.sessionId || "")
      || !SUBMISSION_ID_PATTERN.test(command.submissionId || "")
      || !SHA256_PATTERN.test(command.recordSha256 || "")
      || (this.purpose === RANKED_PURPOSE && !SHA256_PATTERN.test(command.reportSha256 || ""))
      || command.submissionId !== `sub_${String(command.recordSha256).slice(0, 32)}`) {
      throw storeError(400, "INVALID_VERIFIED_SLOT_COMMAND", "verified slot record identity is invalid");
    }
    let archivedAt = null;
    if (this.purpose === RANKED_PURPOSE) {
      const archivedAtMilliseconds = Date.parse(command.archivedAt);
      if (typeof command.archivedAt !== "string"
        || !Number.isFinite(archivedAtMilliseconds)
        || new Date(archivedAtMilliseconds).toISOString() !== command.archivedAt) {
        throw storeError(400, "INVALID_VERIFIED_SLOT_COMMAND", "ranked archivedAt must be an exact ISO timestamp");
      }
      archivedAt = command.archivedAt;
    }
    return this.withExclusiveOperation(async () => {
      let stored;
      let archiveUsedBytes;
      if (this.purpose === RANKED_PURPOSE) {
        stored = await this.readBatchDirectoryUnlocked(batchId);
        archiveUsedBytes = this.usedBytes;
      } else {
        const archive = await this.scanArchiveUnlocked();
        this.usedBytes = archive.usedBytes;
        stored = archive.records.get(batchId);
        archiveUsedBytes = archive.usedBytes;
      }
      if (archiveUsedBytes > this.maxStorageBytes) {
        throw storeError(507, "BATCH_STORAGE_FULL", "batch storage budget is already exceeded");
      }
      if (!stored) throw storeError(404, "BATCH_NOT_FOUND", "batch evaluation not found");
      this.authorizeStoredBatch(stored, ownerUserId, { allowExpired: allowExpiredCommit });
      if (this.purpose === RANKED_PURPOSE
        && command.result?.status === "valid"
        && (typeof command.result.score !== "number"
          || !Number.isFinite(command.result.score)
          || command.result.score > stored.payload.evaluationPolicy.scoreMaximum)) {
        throw storeError(
          400,
          "RANKED_SCORE_OUT_OF_RANGE",
          `ranked result score must not exceed ${stored.payload.evaluationPolicy.scoreMaximum}`
        );
      }
      const execution = stored.payload.slotExecutions[command.slotIndex - 1];
      if (!execution?.sessionBinding || execution.sessionBinding.sessionId !== command.sessionId) {
        throw storeError(409, "SLOT_SESSION_MISMATCH", "verified result does not match the slot session binding");
      }
      if (this.purpose === RANKED_PURPOSE
        && (Date.parse(archivedAt) < Date.parse(execution.sessionBinding.boundAt)
          || Date.parse(archivedAt) >= Date.parse(stored.payload.expiresAt))) {
        throw storeError(
          410,
          "RANKED_SUBMISSION_OUTSIDE_WINDOW",
          "ranked submission was not archived inside its lease and batch lifetime"
        );
      }
      let batchState;
      try {
        batchState = submitSlotResult(stored.payload.batchState, {
          source: stored.payload.lockedSource.value,
          slotIndex: command.slotIndex,
          result: command.result
        });
      } catch (error) {
        throw translateCoreError(error);
      }
      const normalizedResult = batchState.slots[command.slotIndex - 1].result;
      const normalizedCommand = { ...command, result: normalizedResult };
      const commandDigest = verifiedSlotCommandDigest(normalizedCommand, execution.sessionBinding);
      if (execution.verifiedReceipt !== null) {
        if (execution.verifiedReceipt.commandDigest === commandDigest
          && execution.verifiedReceipt.submissionId === command.submissionId
          && execution.verifiedReceipt.recordSha256 === command.recordSha256) {
          return this.purpose === RANKED_PURPOSE
            ? rankedOwnerProjection(stored.payload)
            : publicStoredBatch(stored.payload);
        }
        throw storeError(409, "SLOT_ALREADY_FINALIZED", `slot ${command.slotIndex} already has its only verified record`);
      }
      const verifiedReceipt = {
        schemaVersion: this.purpose === RANKED_PURPOSE
          ? BATCH_SLOT_VERIFIED_RECEIPT_SCHEMA_VERSION_V2
          : BATCH_SLOT_VERIFIED_RECEIPT_SCHEMA_VERSION,
        slotIndex: command.slotIndex,
        sessionId: command.sessionId,
        sessionBindingDigest: canonicalSha256(execution.sessionBinding),
        submissionId: command.submissionId,
        recordSha256: command.recordSha256,
        resultDigest: canonicalSha256(normalizedResult),
        commandDigest,
        receivedAt: this.purpose === RANKED_PURPOSE
          ? archivedAt
          : new Date(this.timestampNow()).toISOString()
      };
      if (this.purpose === RANKED_PURPOSE) verifiedReceipt.reportSha256 = command.reportSha256;
      const slotExecutions = stored.payload.slotExecutions.map((candidate, index) => (
        index === command.slotIndex - 1 ? { ...candidate, verifiedReceipt } : candidate
      ));
      const payload = validatePrivatePayload({
        ...stored.payload,
        batchState,
        batchStateDigest: canonicalSha256(batchState),
        slotExecutions
      }, batchId, this.validationContext);
      await this.replacePayloadUnlocked(stored, payload, archiveUsedBytes);
      return this.purpose === RANKED_PURPOSE
        ? rankedOwnerProjection(payload)
        : publicStoredBatch(payload);
    });
  }

  async closeBatch(command) {
    assertExactKeys(command, ["ownerUserId", "batchId"], "INVALID_CLOSE_BATCH_COMMAND", "close batch command");
    const ownerUserId = normalizeOwnerUserId(command.ownerUserId);
    const batchId = normalizeBatchId(command.batchId);
    return this.withExclusiveOperation(async () => {
      let stored;
      let archiveUsedBytes;
      if (this.purpose === RANKED_PURPOSE) {
        stored = await this.readBatchDirectoryUnlocked(batchId);
        archiveUsedBytes = this.usedBytes;
      } else {
        const archive = await this.scanArchiveUnlocked();
        this.usedBytes = archive.usedBytes;
        stored = archive.records.get(batchId);
        archiveUsedBytes = archive.usedBytes;
      }
      if (archiveUsedBytes > this.maxStorageBytes) {
        throw storeError(507, "BATCH_STORAGE_FULL", "batch storage budget is already exceeded");
      }
      if (!stored) throw storeError(404, "BATCH_NOT_FOUND", "batch evaluation not found");
      this.authorizeStoredBatch(stored, ownerUserId, { allowExpired: true });
      const payload = await this.finalizeStoredBatchUnlocked(stored, archiveUsedBytes);
      return this.purpose === RANKED_PURPOSE
        ? rankedOwnerProjection(payload)
        : publicStoredBatch(payload);
    });
  }
}

module.exports = {
  BATCH_STORE_RECORD_SCHEMA_VERSION,
  BATCH_STORE_PAYLOAD_SCHEMA_VERSION,
  BATCH_STORE_PAYLOAD_SCHEMA_VERSION_V2,
  RANKED_EVALUATION_POLICY_SCHEMA_VERSION,
  BATCH_SLOT_SESSION_BINDING_SCHEMA_VERSION,
  BATCH_SLOT_SESSION_BINDING_SCHEMA_VERSION_V2,
  BATCH_SLOT_VERIFIED_RECEIPT_SCHEMA_VERSION,
  BATCH_SLOT_VERIFIED_RECEIPT_SCHEMA_VERSION_V2,
  DEFAULT_BATCH_TTL_MS,
  MAX_BATCH_TTL_MS,
  DEFAULT_MAX_BATCHES,
  MAX_BATCHES,
  DEFAULT_MAX_OPEN_BATCHES_PER_OWNER,
  MAX_OPEN_BATCHES_PER_OWNER,
  DEFAULT_MAX_RETAINED_BATCHES_PER_OWNER,
  MAX_RETAINED_BATCHES_PER_OWNER,
  DEFAULT_MAX_STORAGE_BYTES,
  MAX_STORAGE_BYTES,
  MAX_BATCH_RECORD_BYTES,
  MAX_RANKED_LOCKED_SOURCE_BYTES,
  MAX_ARCHIVED_BATCH_DIRECTORIES,
  MAX_DISCOVERED_OPEN_BATCHES,
  OPEN_BATCH_GROWTH_RESERVE_BYTES,
  PRACTICE_PURPOSE,
  RANKED_PURPOSE,
  RANKED_SCORE_MAXIMUM,
  DEFAULT_RANKING_LIST_LIMIT,
  MAX_RANKING_LIST_LIMIT,
  MAX_RANKING_LIST_OFFSET,
  BatchEvaluationStoreError,
  BatchEvaluationStore
};
