"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { TextDecoder } = require("node:util");
const { canonicalSha256 } = require("./canonical-json.js");
const {
  deriveRecordCapabilityUsage,
  adminCapabilityUsage,
  capabilityUsageFromReport
} = require("./record-capability-usage.js");

const SESSION_SCHEMA_VERSION = "chenlong.local-session/v1";
const CHALLENGE_COMMITMENT_SCHEMA_VERSION = "chenlong.challenge-commitment/v1";
const SUBMISSION_SCHEMA_VERSION = "chenlong.local-submission/v1";
const RECORD_DRAFT_SCHEMA_VERSION = "chenlong.local-record-draft/v1";
const DRAFT_ORIGIN_SCHEMA_VERSION = "chenlong.local-record-draft-origin/v1";
const RECEIPT_SCHEMA_VERSION = "chenlong.submission-receipt/v1";
const SESSION_SCOPE_RECORD_SCHEMA_VERSION = "chenlong.local-session-scope-record/v1";
const SESSION_SCOPE_PAYLOAD_SCHEMA_VERSION = "chenlong.local-session-scope/v1";
const SESSION_RETIREMENT_RECORD_SCHEMA_VERSION = "chenlong.local-session-retirement-record/v1";
const SESSION_RETIREMENT_PAYLOAD_SCHEMA_VERSION = "chenlong.local-session-retirement/v1";
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 600;
const MAX_SESSIONS = 1000;
const DEFAULT_MAX_SUBMISSIONS_PER_SESSION = 10;
const MAX_SUBMISSIONS_PER_SESSION = 100;
// A 512 MiB archive is too small for the documented 500-participant event:
// representative records are commonly hundreds of KiB and every run is saved
// as a draft.  Four GiB keeps the default bounded while leaving enough room
// for several attempts across all three tasks.  Operators can still lower or
// raise it explicitly with CHENLONG_RUN_ARCHIVE_MAX_BYTES.
const DEFAULT_MAX_STORAGE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
const DRAFT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DRAFT_RETENTION_INTERVAL_MS = 60 * 1000;
const DRAFT_RETENTION_BATCH_SIZE = 25;
const STORAGE_WARNING_PERCENT = 80;
const STORAGE_CRITICAL_PERCENT = 95;
// Kept as the legacy bounded list-materialization size and ranked audit-cache
// sizing hint. It is deliberately not a retained archive/session capacity:
// completed history is bounded by maxStorageBytes while active work is bounded
// independently by maxSessions/maxSessionsByScope.
const MAX_ARCHIVED_SESSION_DIRECTORIES = 10_000;
const MAX_ARCHIVED_RECORD_BYTES = 40 * 1024 * 1024;
const MAX_COMPRESSED_DRAFT_RECORD_BYTES = MAX_ARCHIVED_RECORD_BYTES + (64 * 1024);
const MAX_ARCHIVED_REPORT_BYTES = 1024 * 1024;
const MAX_DRAFT_MANIFEST_BYTES = 64 * 1024;
const MAX_DRAFT_ORIGIN_BYTES = 8 * 1024;
const MAX_SESSION_METADATA_BYTES = 256 * 1024;
const MAX_SESSION_PRIVATE_SIDECAR_BYTES = 8 * 1024;
const SESSION_ID_PATTERN = /^ses_[a-f0-9]{32}$/;
const SUBMISSION_ID_PATTERN = /^sub_[a-f0-9]{32}$/;
const BATCH_ID_PATTERN = /^bat_[a-f0-9]{32}$/;
const RUN_ID_PATTERN = /^run_[a-f0-9]{32}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OWNER_USER_ID_PATTERN = /^usr_[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LEGACY_DRAFT_RECORD_FILENAME = "record.json";
const COMPRESSED_DRAFT_RECORD_FILENAME = "record.json.gz";
const DEFAULT_MAX_RECORD_LIST_ITEMS = MAX_ARCHIVED_SESSION_DIRECTORIES;
const MAX_CAPABILITY_USAGE_CACHE_ITEMS = DEFAULT_MAX_RECORD_LIST_ITEMS;
const PUBLIC_SCORE_MAXIMUM = 100;
const PUBLIC_VERIFICATION_REASON_CODE_LIMIT = 12;
const PUBLIC_VERIFICATION_REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const PUBLIC_VERIFICATION_STATUSES = new Set(["verified", "partial", "invalid", "error"]);
const PUBLIC_DETERMINISTIC_SCOPE_STATUSES = new Set(["complete", "incomplete"]);
const PUBLIC_VISION_STATUSES = new Set(["not_used", "not_recomputed", "matched"]);
const SESSION_SCOPES = new Set(["single", "practice", "ranked"]);
const SESSION_MODES = new Set(["standard", "ai"]);
const SESSION_RETIREMENT_REASONS = new Set([
  "batch_slot_completed",
  "batch_closed",
  "batch_expired"
]);

const SESSION_SCOPE_PAYLOAD_KEYS = Object.freeze([
  "schemaVersion", "sessionId", "runId", "ownerUserId", "scope",
  "batchId", "slotIndex", "competitionId"
]);
const SESSION_RETIREMENT_PAYLOAD_KEYS = Object.freeze([
  "schemaVersion", "sessionId", "runId", "ownerUserId", "retiredAt", "reason"
]);
const PRIVATE_SIDECAR_RECORD_KEYS = Object.freeze(["schemaVersion", "payload", "payloadDigest"]);

class SubmissionStoreError extends Error {
  constructor(statusCode, code, message, headers = {}) {
    super(message);
    this.name = "SubmissionStoreError";
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
  }
}

function boundedInteger(name, value, fallback, maximum) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function normalizeSessionScopeQuotas(value) {
  if (value === undefined || value === null) return null;
  if (!hasExactKeys(value, ["single", "practice", "ranked"])) {
    throw new TypeError("maxSessionsByScope must contain exact single, practice, and ranked limits");
  }
  const normalized = {
    single: boundedInteger("maxSessionsByScope.single", value.single, null, MAX_SESSIONS),
    practice: boundedInteger("maxSessionsByScope.practice", value.practice, null, MAX_SESSIONS),
    ranked: boundedInteger("maxSessionsByScope.ranked", value.ranked, null, MAX_SESSIONS)
  };
  if (normalized.single + normalized.practice + normalized.ranked > MAX_SESSIONS) {
    throw new TypeError(`maxSessionsByScope total must not exceed ${MAX_SESSIONS}`);
  }
  return Object.freeze(normalized);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function draftRecordStorage(record) {
  if (record?.storageEncoding === undefined) {
    return {
      filename: LEGACY_DRAFT_RECORD_FILENAME,
      byteLength: record?.byteLength,
      maximumBytes: MAX_ARCHIVED_RECORD_BYTES,
      compressed: false
    };
  }
  if (record?.storageEncoding === "gzip"
    && Number.isSafeInteger(record.storedByteLength)
    && record.storedByteLength > 0
    && record.storedByteLength <= MAX_COMPRESSED_DRAFT_RECORD_BYTES) {
    return {
      filename: COMPRESSED_DRAFT_RECORD_FILENAME,
      byteLength: record.storedByteLength,
      maximumBytes: MAX_COMPRESSED_DRAFT_RECORD_BYTES,
      compressed: true
    };
  }
  return null;
}

function decodeDraftRecordBuffer(buffer, storage, record) {
  if (!storage?.compressed) return buffer;
  let decoded;
  try {
    decoded = zlib.gunzipSync(buffer, { maxOutputLength: MAX_ARCHIVED_RECORD_BYTES });
  } catch (_error) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored compressed record draft is invalid");
  }
  if (decoded.length !== record.byteLength) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored compressed record draft length is invalid");
  }
  return decoded;
}

function createChallengeCommitment(runDefinition) {
  const commitment = {
    schemaVersion: CHALLENGE_COMMITMENT_SCHEMA_VERSION,
    nonce: crypto.randomBytes(32).toString("hex"),
    runDefinitionDigest: canonicalSha256(runDefinition)
  };
  return {
    commitment,
    challengeDigest: canonicalSha256(commitment)
  };
}

function validateSessionChallengeBinding(session) {
  let actualRunDefinitionDigest;
  try {
    actualRunDefinitionDigest = canonicalSha256(session?.challenge?.runDefinition);
  } catch (_error) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(session || {}, "challengeCommitment")) {
    return session?.challengeDigest === actualRunDefinitionDigest;
  }
  const commitment = session.challengeCommitment;
  return commitment?.schemaVersion === CHALLENGE_COMMITMENT_SCHEMA_VERSION
    && SHA256_PATTERN.test(commitment.nonce || "")
    && SHA256_PATTERN.test(commitment.runDefinitionDigest || "")
    && commitment.runDefinitionDigest === actualRunDefinitionDigest
    && canonicalSha256(commitment) === session.challengeDigest;
}

function sessionRunDefinitionDigest(session) {
  return session?.challengeCommitment?.runDefinitionDigest || session?.challengeDigest;
}

function publicChallengeMetadata(challenge = {}) {
  const result = {};
  ["taskId", "taskVersion", "mapId", "mapVersion", "ruleVersion", "displayName"].forEach(field => {
    if (typeof challenge?.[field] === "string") result[field] = challenge[field];
  });
  if (typeof challenge?.timeLimitSeconds === "number" && Number.isFinite(challenge.timeLimitSeconds)) {
    result.timeLimitSeconds = challenge.timeLimitSeconds;
  }
  if (SESSION_MODES.has(challenge?.sessionMode)) result.sessionMode = challenge.sessionMode;
  return result;
}

function publicVerificationSummary(report) {
  const value = report && typeof report === "object" && !Array.isArray(report) ? report : {};
  const status = PUBLIC_VERIFICATION_STATUSES.has(value.status) ? value.status : "unknown";
  const deterministicCandidate = value.verificationScope?.deterministic?.status;
  const deterministicStatus = PUBLIC_DETERMINISTIC_SCOPE_STATUSES.has(deterministicCandidate)
    ? deterministicCandidate
    : "unknown";
  const topLevelVision = PUBLIC_VISION_STATUSES.has(value.visionStatus) ? value.visionStatus : null;
  const scopeVision = PUBLIC_VISION_STATUSES.has(value.verificationScope?.vision)
    ? value.verificationScope.vision
    : null;
  const visionStatus = topLevelVision && scopeVision && topLevelVision !== scopeVision
    ? "unknown"
    : topLevelVision || scopeVision || "unknown";
  const reasonCodes = [];
  const seenReasonCodes = new Set();
  if (Array.isArray(value.reasonCodes)) {
    for (const candidate of value.reasonCodes) {
      if (reasonCodes.length >= PUBLIC_VERIFICATION_REASON_CODE_LIMIT) break;
      if (typeof candidate !== "string" || !PUBLIC_VERIFICATION_REASON_CODE_PATTERN.test(candidate)
        || seenReasonCodes.has(candidate)) continue;
      seenReasonCodes.add(candidate);
      reasonCodes.push(candidate);
    }
  }
  return {
    status,
    reasonCodes,
    visionStatus,
    verificationScope: {
      deterministic: { status: deterministicStatus },
      vision: visionStatus
    }
  };
}

function normalizedPublicScore(session, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const weights = session?.challenge?.runDefinition?.scoringDefinition?.weights;
  const fields = ["task", "rules", "autonomous", "efficiency"];
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) return null;
  const parts = fields.map(field => Number(weights[field]));
  if (!parts.every(part => Number.isFinite(part) && part >= 0)) return null;
  const frozenMaximum = parts.reduce((sum, part) => sum + part, 0);
  if (!(frozenMaximum > 0) || frozenMaximum > 1000 || value > frozenMaximum + 1e-9) return null;
  const normalized = Math.round((value / frozenMaximum * PUBLIC_SCORE_MAXIMUM + Number.EPSILON) * 100) / 100;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function submittedRecordTime(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : -1;
}

function bestSubmittedRecordKey(record) {
  if (record?.recordState !== "submitted" || typeof record.ownerUserId !== "string"
    || !OWNER_USER_ID_PATTERN.test(record.ownerUserId) || typeof record.taskId !== "string"
    || !record.taskId || typeof record.teamId !== "string" || !record.teamId
    || typeof record.score !== "number" || !Number.isFinite(record.score)
    || record.score < 0 || record.score > PUBLIC_SCORE_MAXIMUM
    || submittedRecordTime(record.submittedAt) < 0) {
    throw new TypeError("submitted record summary is invalid for score aggregation");
  }
  // A participant may be reassigned by the official SSO after submitting.
  // Keeping the immutable submission-time team in the aggregate key prevents
  // an old score from either moving to the new team or hiding a later score
  // that the same participant legitimately submitted for the new team.
  return `${record.ownerUserId}\n${record.teamId}\n${record.taskId}`;
}

function mergeBestSubmittedRecord(index, record) {
  if (!(index instanceof Map)) throw new TypeError("best submitted record index must be a Map");
  const key = bestSubmittedRecordKey(record);
  const current = index.get(key) || null;
  const recordTime = submittedRecordTime(record.submittedAt);
  const currentBestTime = current ? submittedRecordTime(current.submittedAt) : -1;
  const currentLatestTime = current
    ? Math.max(currentBestTime, submittedRecordTime(current.latestSubmittedAt))
    : -1;
  const latestSubmittedAt = recordTime >= currentLatestTime
    ? record.submittedAt
    : current.latestSubmittedAt || current.submittedAt;
  const better = current === null
    || record.score > current.score
    || (record.score === current.score && (recordTime > currentBestTime
      || (recordTime === currentBestTime && String(record.id).localeCompare(String(current.id)) < 0)));
  const selected = better ? record : current;
  index.set(key, Object.freeze({ ...selected, latestSubmittedAt }));
  return index.get(key);
}

function aggregateBestSubmittedRecords(records) {
  const index = new Map();
  for (const record of records) mergeBestSubmittedRecord(index, record);
  return [...index.values()].sort((left, right) => (
    submittedRecordTime(right.latestSubmittedAt) - submittedRecordTime(left.latestSubmittedAt)
    || left.ownerUserId.localeCompare(right.ownerUserId)
    || left.teamId.localeCompare(right.teamId)
    || left.taskId.localeCompare(right.taskId)
  ));
}

function normalizeParticipantId(value) {
  if (typeof value !== "string") {
    throw new SubmissionStoreError(400, "INVALID_TEAM_ID", "teamId must be a string");
  }
  const normalized = value.trim().normalize("NFC");
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(normalized)) {
    throw new SubmissionStoreError(400, "INVALID_TEAM_ID", "teamId must contain 1-64 letters, numbers, '.', '_' or '-'");
  }
  return normalized;
}

function normalizeOwnerUserId(value, { allowMissing = false } = {}) {
  if (allowMissing && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || !OWNER_USER_ID_PATTERN.test(value)) {
    throw new SubmissionStoreError(400, "INVALID_OWNER_USER_ID", "ownerUserId is invalid");
  }
  return value;
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeSessionScopeOptions(options = undefined) {
  if (options === undefined) {
    return { scope: "single", batchId: null, slotIndex: null, competitionId: null };
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("session scope options must be an object");
  }
  const scope = options.scope;
  if (!SESSION_SCOPES.has(scope)) throw new TypeError("session scope is invalid");
  const expectedKeys = scope === "ranked"
    ? ["scope", "batchId", "slotIndex", "competitionId"]
    : scope === "practice"
      ? ["scope", "batchId", "slotIndex"]
      : ["scope"];
  if (!hasExactKeys(options, expectedKeys)) throw new TypeError("session scope options contain invalid fields");
  if (scope === "single") {
    return { scope, batchId: null, slotIndex: null, competitionId: null };
  }
  if (!BATCH_ID_PATTERN.test(options.batchId || "")
    || !Number.isSafeInteger(options.slotIndex)
    || options.slotIndex < 1
    || options.slotIndex > 5) {
    throw new TypeError("batch session scope binding is invalid");
  }
  if (scope === "practice") {
    return { scope, batchId: options.batchId, slotIndex: options.slotIndex, competitionId: null };
  }
  if (typeof options.competitionId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.competitionId)) {
    throw new TypeError("ranked competitionId is invalid");
  }
  return {
    scope,
    batchId: options.batchId,
    slotIndex: options.slotIndex,
    competitionId: options.competitionId
  };
}

function normalizeExpectedRecordScope(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !SESSION_SCOPES.has(value)) {
    throw new TypeError("expectedScope must be single, practice, ranked, or null");
  }
  return value;
}

function normalizeRecordStateFilter(value) {
  if (value === undefined || value === null) return null;
  if (!["saved", "submitted"].includes(value)) {
    throw new TypeError("recordState must be saved, submitted, or null");
  }
  return value;
}

function normalizeSessionLifetimeOptions(options = undefined) {
  if (options === undefined) return { notAfter: null };
  if (!options || typeof options !== "object" || Array.isArray(options)
    || !hasExactKeys(options, ["notAfter"])) {
    throw new TypeError("session lifetime options must contain exact notAfter");
  }
  const parsed = Date.parse(options.notAfter);
  if (typeof options.notAfter !== "string" || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== options.notAfter) {
    throw new TypeError("session notAfter must be an exact ISO timestamp");
  }
  return { notAfter: parsed };
}

function privateSidecarRecord(recordSchemaVersion, payload) {
  return {
    schemaVersion: recordSchemaVersion,
    payload,
    payloadDigest: canonicalSha256(payload)
  };
}

function validatePrivateSidecarRecord(record, recordSchemaVersion, payloadSchemaVersion, payloadKeys) {
  if (!hasExactKeys(record, PRIVATE_SIDECAR_RECORD_KEYS)
    || record.schemaVersion !== recordSchemaVersion
    || !hasExactKeys(record.payload, payloadKeys)
    || record.payload.schemaVersion !== payloadSchemaVersion
    || !SHA256_PATTERN.test(record.payloadDigest || "")
    || canonicalSha256(record.payload) !== record.payloadDigest) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored session private metadata is invalid");
  }
  return record.payload;
}

function validateSessionScopePayload(payload, session) {
  const normalizedOwner = session.ownerUserId || null;
  if (payload.sessionId !== session.sessionId
    || payload.runId !== session.runId
    || payload.ownerUserId !== normalizedOwner
    || !SESSION_SCOPES.has(payload.scope)) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored session scope is invalid");
  }
  const normalized = normalizeSessionScopeOptions(payload.scope === "ranked"
    ? {
      scope: payload.scope,
      batchId: payload.batchId,
      slotIndex: payload.slotIndex,
      competitionId: payload.competitionId
    }
    : payload.scope === "practice"
      ? { scope: payload.scope, batchId: payload.batchId, slotIndex: payload.slotIndex }
      : { scope: payload.scope });
  if (normalized.batchId !== payload.batchId
    || normalized.slotIndex !== payload.slotIndex
    || normalized.competitionId !== payload.competitionId) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored session scope is invalid");
  }
  return payload;
}

function validateSessionRetirementPayload(payload, session) {
  const retiredAtMilliseconds = Date.parse(payload.retiredAt);
  if (payload.sessionId !== session.sessionId
    || payload.runId !== session.runId
    || payload.ownerUserId !== (session.ownerUserId || null)
    || !Number.isFinite(retiredAtMilliseconds)
    || new Date(retiredAtMilliseconds).toISOString() !== payload.retiredAt
    || retiredAtMilliseconds < Date.parse(session.createdAt)
    || !SESSION_RETIREMENT_REASONS.has(payload.reason)) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored session retirement is invalid");
  }
  return payload;
}

function validateSessionId(value) {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw new SubmissionStoreError(404, "SESSION_NOT_FOUND", "session not found");
  }
  return value;
}

function validateSubmissionId(value) {
  if (typeof value !== "string" || !SUBMISSION_ID_PATTERN.test(value)) {
    throw new SubmissionStoreError(404, "SUBMISSION_NOT_FOUND", "submission not found");
  }
  return value;
}

function validIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validateBearerToken(value) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new SubmissionStoreError(401, "AUTHENTICATION_REQUIRED", "a valid session bearer token is required", {
      "WWW-Authenticate": "Bearer realm=\"chenlong-local-session\""
    });
  }
  return value;
}

async function readJsonFile(filePath, maximumBytes, missingCode, { withBuffer = false } = {}) {
  let stat;
  try {
    stat = await fs.promises.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new SubmissionStoreError(404, missingCode, missingCode === "SESSION_NOT_FOUND" ? "session not found" : "submission not found");
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored archive metadata is invalid");
  }
  const buffer = await fs.promises.readFile(filePath);
  if (buffer.length > maximumBytes || buffer.length !== stat.size) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored archive metadata changed while being read");
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (_error) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored archive metadata is not valid UTF-8");
  }
  try {
    const value = JSON.parse(source);
    return withBuffer ? { value, buffer } : value;
  } catch (_error) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored archive metadata is not valid JSON");
  }
}

function parseArchivedRunRecord(buffer) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (_error) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored run record is not valid UTF-8");
  }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid root");
    return value;
  } catch (_error) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored run record is not valid JSON");
  }
}

async function atomicWriteFile(directory, filename, data) {
  const targetPath = path.join(directory, filename);
  const temporaryPath = path.join(directory, `.${filename}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(data);
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

async function readExactFile(filePath, expectedLength, maximumBytes, missingCode) {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 1 || expectedLength > maximumBytes) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored archive file length is invalid");
  }
  let fileStat;
  try {
    fileStat = await fs.promises.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new SubmissionStoreError(404, missingCode, "submission not found");
    throw error;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== expectedLength) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored archive file is invalid");
  }
  const handle = await fs.promises.open(filePath, "r");
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size !== expectedLength) {
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored archive file changed while being opened");
    }
    const buffer = Buffer.allocUnsafe(expectedLength);
    let offset = 0;
    while (offset < expectedLength) {
      const { bytesRead } = await handle.read(buffer, offset, expectedLength - offset, offset);
      if (bytesRead < 1) throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored archive file ended unexpectedly");
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, expectedLength);
    if (extraBytes !== 0) {
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored archive file grew while being read");
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

async function inspectExactFile(filePath, expectedLength, maximumBytes, missingCode) {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 1 || expectedLength > maximumBytes) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored archive file length is invalid");
  }
  let fileStat;
  try {
    fileStat = await fs.promises.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new SubmissionStoreError(404, missingCode, "submission not found");
    throw error;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== expectedLength) {
    throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored archive file is invalid");
  }
  const handle = await fs.promises.open(filePath, "r");
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size !== expectedLength
      || (Number.isSafeInteger(fileStat.ino) && Number.isSafeInteger(openedStat.ino) && fileStat.ino !== openedStat.ino)
      || (Number.isSafeInteger(fileStat.dev) && Number.isSafeInteger(openedStat.dev) && fileStat.dev !== openedStat.dev)) {
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored archive file changed while being opened");
    }
  } finally {
    await handle.close();
  }
}

class SubmissionStore {
  constructor(options = {}) {
    this.rootDir = path.resolve(options.rootDir || path.join(process.cwd(), ".runtime"));
    this.sessionsDir = path.join(this.rootDir, "sessions");
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.sessionTtlMs = boundedInteger("sessionTtlMs", options.sessionTtlMs, DEFAULT_SESSION_TTL_MS, MAX_SESSION_TTL_MS);
    this.maxSessions = boundedInteger("maxSessions", options.maxSessions, DEFAULT_MAX_SESSIONS, MAX_SESSIONS);
    this.maxSessionsByScope = normalizeSessionScopeQuotas(options.maxSessionsByScope);
    if (this.maxSessionsByScope !== null) {
      this.maxSessions = Object.values(this.maxSessionsByScope).reduce((sum, value) => sum + value, 0);
    }
    this.maxSubmissionsPerSession = boundedInteger(
      "maxSubmissionsPerSession",
      options.maxSubmissionsPerSession,
      DEFAULT_MAX_SUBMISSIONS_PER_SESSION,
      MAX_SUBMISSIONS_PER_SESSION
    );
    this.maxStorageBytes = boundedInteger("maxStorageBytes", options.maxStorageBytes, DEFAULT_MAX_STORAGE_BYTES, MAX_STORAGE_BYTES);
    this.sessionCount = 0;
    this.activeSessions = new Map();
    this.capabilityUsageCache = new Map();
    this.bestSubmittedRecordIndex = null;
    this.bestSubmittedRecordPending = new Map();
    this.bestSubmittedRecordBuild = null;
    this.usedBytes = 0;
    this.mutationTail = Promise.resolve();
    this.draftRetentionTimer = null;
    this.draftRetentionCursor = 0;
    this.ready = this.initialize();
  }

  async pruneExpiredUnsubmittedDrafts(session) {
    const now = Number(this.now());
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("now() must return a non-negative safe integer");
    const cutoff = now - DRAFT_RETENTION_MS;
    const draftsDirectory = path.join(this.sessionDirectory(session.sessionId), "drafts");
    const submissionsDirectory = path.join(this.sessionDirectory(session.sessionId), "submissions");
    const [draftEntries, submissionEntries] = await Promise.all([
      fs.promises.readdir(draftsDirectory, { withFileTypes: true }).catch(error => {
        if (error?.code === "ENOENT") return [];
        throw error;
      }),
      fs.promises.readdir(submissionsDirectory, { withFileTypes: true }).catch(error => {
        if (error?.code === "ENOENT") return [];
        throw error;
      })
    ]);
    const submittedRecordIds = new Set(submissionEntries
      .filter(entry => entry.isDirectory() && SUBMISSION_ID_PATTERN.test(entry.name))
      .map(entry => entry.name));
    let reclaimedBytes = 0;
    for (const entry of draftEntries) {
      if (!entry.isDirectory() || !SUBMISSION_ID_PATTERN.test(entry.name)
        || submittedRecordIds.has(entry.name)) continue;
      const directory = this.draftDirectory(session.sessionId, entry.name);
      let manifest;
      try {
        manifest = await readJsonFile(
          path.join(directory, "manifest.json"),
          MAX_DRAFT_MANIFEST_BYTES,
          "SUBMISSION_NOT_FOUND"
        );
        this.validateDraftManifest(manifest, session, session.sessionId, entry.name);
      } catch (_error) {
        // Only a fully valid, unsubmitted draft is eligible for retention cleanup.
        continue;
      }
      const storage = draftRecordStorage(manifest.record);
      const files = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
      if (!storage || files.length !== 2
        || !files.every(file => file.isFile() && !file.isSymbolicLink()
          && ["manifest.json", storage.filename].includes(file.name))) continue;
      if (Date.parse(manifest.savedAt) <= cutoff) {
        for (const file of files) {
          reclaimedBytes += (await fs.promises.stat(path.join(directory, file.name))).size;
        }
        const temporaryDirectory = path.join(
          draftsDirectory,
          `.${entry.name}.${crypto.randomUUID()}.tmp`
        );
        await fs.promises.rename(directory, temporaryDirectory);
        await this.cleanupTemporaryDirectory(temporaryDirectory);
        continue;
      }
    }
    return reclaimedBytes;
  }

  async initialize() {
    await fs.promises.mkdir(this.sessionsDir, { recursive: true });
    const entries = await fs.promises.readdir(this.sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /^\.ses_[a-f0-9]{32}\.[a-f0-9-]+\.tmp$/.test(entry.name)) {
        await this.cleanupSessionTemporaryDirectory(path.join(this.sessionsDir, entry.name));
      }
    }
    const sessions = entries.filter(entry => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name));
    this.sessionCount = 0;
    this.activeSessions.clear();
    let usedBytes = 0;
    for (const sessionEntry of sessions) {
      const sessionDirectory = path.join(this.sessionsDir, sessionEntry.name);
      const firstLevel = await fs.promises.readdir(sessionDirectory, { withFileTypes: true }).catch(() => []);
      for (const entry of firstLevel) {
        if (entry.isFile() && !entry.isSymbolicLink()) {
          usedBytes += (await fs.promises.stat(path.join(sessionDirectory, entry.name))).size;
        }
        if (entry.isDirectory() && ["submissions", "drafts"].includes(entry.name)) {
          const submissionEntries = await fs.promises.readdir(path.join(sessionDirectory, entry.name), { withFileTypes: true }).catch(() => []);
          for (const submissionEntry of submissionEntries) {
            if (submissionEntry.isDirectory() && /^\.sub_[a-f0-9]{32}\.[a-f0-9-]+\.tmp$/.test(submissionEntry.name)) {
              await this.cleanupTemporaryDirectory(path.join(sessionDirectory, entry.name, submissionEntry.name));
              continue;
            }
            if (!submissionEntry.isDirectory() || !SUBMISSION_ID_PATTERN.test(submissionEntry.name)) continue;
            const submissionDirectory = path.join(sessionDirectory, entry.name, submissionEntry.name);
            const files = await fs.promises.readdir(submissionDirectory, { withFileTypes: true }).catch(() => []);
            for (const file of files) {
              if (!file.isFile() || file.isSymbolicLink()) continue;
              usedBytes += (await fs.promises.stat(path.join(submissionDirectory, file.name))).size;
            }
          }
        }
        if (usedBytes > this.maxStorageBytes) {
          throw new SubmissionStoreError(500, "ARCHIVE_LIMIT_EXCEEDED", "archive exceeds the configured storage budget");
        }
      }
      const sessionPath = path.join(sessionDirectory, "session.json");
      try {
        const session = await readJsonFile(sessionPath, MAX_SESSION_METADATA_BYTES, "SESSION_NOT_FOUND");
        let retired = false;
        try {
          retired = (await this.readStoredSessionRetirementUnlocked(session)) !== null;
        } catch (_error) {
          // A damaged retirement marker is never trusted to release capacity.
        }
        if (!retired && Number(this.now()) < Date.parse(session.expiresAt)) {
          let scope = "single";
          try {
            scope = (await this.readStoredSessionScopeUnlocked(session))?.scope || "single";
          } catch (_error) {
            scope = "unknown";
          }
          let sealed = false;
          if (scope === "single") {
            try {
              sealed = await this.singleSessionHasArchivedRecordUnlocked(session);
            } catch (_error) {
              // Invalid archive evidence is never trusted to release capacity.
            }
          }
          if (sealed) continue;
          this.activeSessions.set(session.sessionId, {
            scope,
            expiresAt: Date.parse(session.expiresAt)
          });
          this.sessionCount += 1;
        }
      } catch (_error) {
        // Corrupt sessions remain inside the storage budget and fail closed when queried.
      }
    }
    this.usedBytes = usedBytes;
    this.startDraftRetentionCleanup();
  }

  startDraftRetentionCleanup() {
    if (this.draftRetentionTimer !== null) return;
    this.draftRetentionTimer = setInterval(() => {
      void this.withMutationLock(async () => {
        let reclaimedBytes = 0;
        const sessionIds = await this.listArchiveSessionIds();
        if (sessionIds.length === 0) return;
        const start = this.draftRetentionCursor % sessionIds.length;
        const batchSize = Math.min(DRAFT_RETENTION_BATCH_SIZE, sessionIds.length);
        const batch = Array.from(
          { length: batchSize },
          (_unused, index) => sessionIds[(start + index) % sessionIds.length]
        );
        this.draftRetentionCursor = (start + batchSize) % sessionIds.length;
        for (const sessionId of batch) {
          try {
            reclaimedBytes += await this.pruneExpiredUnsubmittedDrafts(await this.readSession(sessionId));
          } catch (_error) {
            // Preserve unreadable sessions rather than risking removal of evidence.
          }
        }
        this.usedBytes = Math.max(0, this.usedBytes - reclaimedBytes);
      }).catch(() => {});
    }, DRAFT_RETENTION_INTERVAL_MS);
    this.draftRetentionTimer.unref?.();
  }

  storageStatus() {
    const usedBytes = Math.max(0, this.usedBytes);
    const availableBytes = Math.max(0, this.maxStorageBytes - usedBytes);
    const utilizationPercent = Math.round((usedBytes / this.maxStorageBytes) * 10_000) / 100;
    const status = utilizationPercent >= STORAGE_CRITICAL_PERCENT
      ? "critical"
      : utilizationPercent >= STORAGE_WARNING_PERCENT ? "warning" : "ok";
    return {
      status,
      usedBytes,
      maxBytes: this.maxStorageBytes,
      availableBytes,
      utilizationPercent,
      warningThresholdPercent: STORAGE_WARNING_PERCENT,
      criticalThresholdPercent: STORAGE_CRITICAL_PERCENT,
      nearCapacity: status !== "ok"
    };
  }

  async withMutationLock(operation) {
    const previous = this.mutationTail;
    let release;
    this.mutationTail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  sessionDirectory(sessionId) {
    return path.join(this.sessionsDir, validateSessionId(sessionId));
  }

  submissionDirectory(sessionId, submissionId) {
    return path.join(this.sessionDirectory(sessionId), "submissions", validateSubmissionId(submissionId));
  }

  draftDirectory(sessionId, recordId) {
    return path.join(this.sessionDirectory(sessionId), "drafts", validateSubmissionId(recordId));
  }

  sessionScopePath(sessionId) {
    return path.join(this.sessionDirectory(sessionId), "scope.json");
  }

  sessionRetirementPath(sessionId) {
    return path.join(this.sessionDirectory(sessionId), "retirement.json");
  }

  async readStoredSessionScopeUnlocked(session) {
    let record;
    try {
      record = await readJsonFile(
        this.sessionScopePath(session.sessionId),
        MAX_SESSION_PRIVATE_SIDECAR_BYTES,
        "SESSION_NOT_FOUND"
      );
    } catch (error) {
      if (error instanceof SubmissionStoreError && error.code === "SESSION_NOT_FOUND") return null;
      throw error;
    }
    const payload = validatePrivateSidecarRecord(
      record,
      SESSION_SCOPE_RECORD_SCHEMA_VERSION,
      SESSION_SCOPE_PAYLOAD_SCHEMA_VERSION,
      SESSION_SCOPE_PAYLOAD_KEYS
    );
    try {
      return validateSessionScopePayload(payload, session);
    } catch (error) {
      if (error instanceof SubmissionStoreError) throw error;
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored session scope is invalid");
    }
  }

  async readStoredSessionRetirementUnlocked(session) {
    let record;
    try {
      record = await readJsonFile(
        this.sessionRetirementPath(session.sessionId),
        MAX_SESSION_PRIVATE_SIDECAR_BYTES,
        "SESSION_NOT_FOUND"
      );
    } catch (error) {
      if (error instanceof SubmissionStoreError && error.code === "SESSION_NOT_FOUND") return null;
      throw error;
    }
    const payload = validatePrivateSidecarRecord(
      record,
      SESSION_RETIREMENT_RECORD_SCHEMA_VERSION,
      SESSION_RETIREMENT_PAYLOAD_SCHEMA_VERSION,
      SESSION_RETIREMENT_PAYLOAD_KEYS
    );
    return validateSessionRetirementPayload(payload, session);
  }

  sessionScopePayload(session, normalizedScope) {
    return {
      schemaVersion: SESSION_SCOPE_PAYLOAD_SCHEMA_VERSION,
      sessionId: session.sessionId,
      runId: session.runId,
      ownerUserId: session.ownerUserId || null,
      scope: normalizedScope.scope,
      batchId: normalizedScope.batchId,
      slotIndex: normalizedScope.slotIndex,
      competitionId: normalizedScope.competitionId
    };
  }

  async writePrivateSidecarUnlocked(sessionId, filename, record) {
    const buffer = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    if (buffer.length > MAX_SESSION_PRIVATE_SIDECAR_BYTES) {
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "session private metadata is too large");
    }
    if (this.usedBytes + buffer.length > this.maxStorageBytes) {
      throw new SubmissionStoreError(507, "ARCHIVE_STORAGE_FULL", "local archive storage budget is full");
    }
    await atomicWriteFile(this.sessionDirectory(sessionId), filename, buffer);
    this.usedBytes += buffer.length;
    return buffer.length;
  }

  async readSessionScopeForServer(sessionId) {
    await this.ready;
    const session = await this.readSession(sessionId);
    const stored = await this.readStoredSessionScopeUnlocked(session);
    return stored || this.sessionScopePayload(session, normalizeSessionScopeOptions());
  }

  async bindSessionScopeForServer(sessionId, options) {
    await this.ready;
    const normalizedScope = normalizeSessionScopeOptions(options);
    if (normalizedScope.scope === "single") {
      throw new TypeError("server batch scope must be practice or ranked");
    }
    return this.withMutationLock(async () => {
      const session = await this.readSession(sessionId);
      const requested = this.sessionScopePayload(session, normalizedScope);
      const existing = await this.readStoredSessionScopeUnlocked(session);
      if (existing !== null) {
        if (canonicalSha256(existing) !== canonicalSha256(requested)) {
          throw new SubmissionStoreError(409, "SESSION_SCOPE_MISMATCH", "session is bound to another submission scope");
        }
        return existing;
      }
      await this.writePrivateSidecarUnlocked(
        session.sessionId,
        "scope.json",
        privateSidecarRecord(SESSION_SCOPE_RECORD_SCHEMA_VERSION, requested)
      );
      return requested;
    });
  }

  async retireSessionForServer(sessionId, reason) {
    await this.ready;
    if (!SESSION_RETIREMENT_REASONS.has(reason)) throw new TypeError("session retirement reason is invalid");
    return this.withMutationLock(async () => {
      const session = await this.readSession(sessionId);
      const existing = await this.readStoredSessionRetirementUnlocked(session);
      if (existing !== null) {
        this.activeSessions.delete(session.sessionId);
        this.sessionCount = this.activeSessionCountsUnlocked().total;
        return existing;
      }
      const retiredAtMilliseconds = Number(this.now());
      if (!Number.isSafeInteger(retiredAtMilliseconds) || retiredAtMilliseconds < 0) {
        throw new TypeError("now() must return a non-negative safe integer");
      }
      const payload = {
        schemaVersion: SESSION_RETIREMENT_PAYLOAD_SCHEMA_VERSION,
        sessionId: session.sessionId,
        runId: session.runId,
        ownerUserId: session.ownerUserId || null,
        retiredAt: new Date(retiredAtMilliseconds).toISOString(),
        reason
      };
      validateSessionRetirementPayload(payload, session);
      await this.writePrivateSidecarUnlocked(
        session.sessionId,
        "retirement.json",
        privateSidecarRecord(SESSION_RETIREMENT_RECORD_SCHEMA_VERSION, payload)
      );
      this.activeSessions.delete(session.sessionId);
      if (retiredAtMilliseconds < Date.parse(session.expiresAt)) {
        this.sessionCount = Math.max(0, this.sessionCount - 1);
      }
      return payload;
    });
  }

  async singleSessionHasArchivedRecordUnlocked(session) {
    const drafts = await this.listDraftManifests(session.sessionId);
    const submissions = await this.listSubmissionManifests(session.sessionId);
    for (const manifest of drafts) {
      this.validateDraftManifest(manifest, session, session.sessionId, manifest.recordId);
      const storage = draftRecordStorage(manifest.record);
      const storedBuffer = await readExactFile(
        path.join(this.draftDirectory(session.sessionId, manifest.recordId), storage.filename),
        storage.byteLength,
        storage.maximumBytes,
        "SUBMISSION_NOT_FOUND"
      );
      const recordBuffer = decodeDraftRecordBuffer(storedBuffer, storage, manifest.record);
      if (sha256(recordBuffer) !== manifest.record.sha256) {
        throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored record draft digest does not match");
      }
    }
    for (const manifest of submissions) {
      const directory = this.submissionDirectory(session.sessionId, manifest.submissionId);
      const reportRead = await readJsonFile(
        path.join(directory, "report.json"),
        MAX_ARCHIVED_REPORT_BYTES,
        "SUBMISSION_NOT_FOUND",
        { withBuffer: true }
      );
      this.validateSubmissionManifest(
        manifest,
        session,
        session.sessionId,
        manifest.submissionId
      );
      if (reportRead.value?.schemaVersion !== manifest.report.schemaVersion
        || reportRead.value?.status !== manifest.report.status
        || reportRead.buffer.length !== manifest.report.byteLength
        || sha256(reportRead.buffer) !== manifest.report.sha256) {
        throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored submission metadata is invalid");
      }
      const recordBuffer = await readExactFile(
        path.join(directory, "record.json"),
        manifest.record.byteLength,
        MAX_ARCHIVED_RECORD_BYTES,
        "SUBMISSION_NOT_FOUND"
      );
      if (sha256(recordBuffer) !== manifest.record.sha256) {
        throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored run record digest does not match");
      }
    }
    return drafts.length > 0 || submissions.length > 0;
  }

  activeSessionCountsUnlocked() {
    const now = Number(this.now());
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("now() must return a non-negative safe integer");
    const counts = { single: 0, practice: 0, ranked: 0, unknown: 0, total: 0 };
    for (const [sessionId, active] of this.activeSessions) {
      if (now >= active.expiresAt) {
        this.activeSessions.delete(sessionId);
        continue;
      }
      counts[active.scope] += 1;
      counts.total += 1;
    }
    this.sessionCount = counts.total;
    return counts;
  }

  async createSession(
    teamId,
    challenge,
    ownerUserId = null,
    scopeOptions = undefined,
    lifetimeOptions = undefined
  ) {
    await this.ready;
    const normalizedTeamId = normalizeParticipantId(teamId);
    const normalizedOwnerUserId = normalizeOwnerUserId(ownerUserId, { allowMissing: true });
    const normalizedScope = normalizeSessionScopeOptions(scopeOptions);
    const normalizedLifetime = normalizeSessionLifetimeOptions(lifetimeOptions);
    if (normalizedScope.scope !== "single" && normalizedOwnerUserId === null) {
      throw new TypeError("batch-scoped sessions require an ownerUserId");
    }
    if (!challenge || typeof challenge !== "object" || typeof challenge.taskId !== "string") {
      throw new TypeError("challenge metadata is required");
    }
    if (!challenge.runDefinition || typeof challenge.runDefinition !== "object") {
      throw new TypeError("challenge runDefinition is required");
    }
    const { commitment: challengeCommitment, challengeDigest } = createChallengeCommitment(challenge.runDefinition);
    return this.withMutationLock(async () => {
      const activeSessionCounts = this.activeSessionCountsUnlocked();
      const activeSessionCount = activeSessionCounts.total;
      if (this.maxSessionsByScope !== null) {
        if (activeSessionCounts[normalizedScope.scope] + activeSessionCounts.unknown
          >= this.maxSessionsByScope[normalizedScope.scope]) {
          const genericScope = normalizedScope.scope === "single";
          throw new SubmissionStoreError(
            429,
            genericScope ? "SESSION_LIMIT_REACHED" : "SESSION_SCOPE_LIMIT_REACHED",
            genericScope ? "local session limit reached" : `local ${normalizedScope.scope} session limit reached`
          );
        }
      } else if (activeSessionCount >= this.maxSessions) {
        throw new SubmissionStoreError(429, "SESSION_LIMIT_REACHED", "local session limit reached");
      }
      const submitToken = crypto.randomBytes(32).toString("base64url");
      const createdAtMs = Number(this.now());
      if (!Number.isFinite(createdAtMs)) throw new TypeError("now() must return a finite timestamp");
      if (normalizedLifetime.notAfter !== null && createdAtMs >= normalizedLifetime.notAfter) {
        throw new SubmissionStoreError(
          410,
          "SESSION_DEADLINE_EXPIRED",
          "batch deadline passed before its session lease could be created"
        );
      }
      const expiresAtMs = normalizedLifetime.notAfter === null
        ? createdAtMs + this.sessionTtlMs
        : Math.min(createdAtMs + this.sessionTtlMs, normalizedLifetime.notAfter);
      const sessionId = `ses_${crypto.randomUUID().replaceAll("-", "")}`;
      const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`;
      const sessionDirectory = this.sessionDirectory(sessionId);
      const temporaryDirectory = path.join(this.sessionsDir, `.${sessionId}.${crypto.randomUUID()}.tmp`);
      const session = {
        schemaVersion: SESSION_SCHEMA_VERSION,
        sessionId,
        runId,
        teamId: normalizedTeamId,
        challenge: { ...challenge },
        challengeCommitment,
        challengeDigest,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        submitTokenHash: sha256(Buffer.from(submitToken)),
        authoritative: false
      };
      if (normalizedOwnerUserId) session.ownerUserId = normalizedOwnerUserId;
      const data = Buffer.from(`${JSON.stringify(session, null, 2)}\n`);
      const scopePayload = this.sessionScopePayload(session, normalizedScope);
      const scopeData = Buffer.from(`${JSON.stringify(
        privateSidecarRecord(SESSION_SCOPE_RECORD_SCHEMA_VERSION, scopePayload),
        null,
        2
      )}\n`);
      if (scopeData.length > MAX_SESSION_PRIVATE_SIDECAR_BYTES) {
        throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "session scope metadata is too large");
      }
      if (this.usedBytes + data.length + scopeData.length > this.maxStorageBytes) {
        throw new SubmissionStoreError(507, "ARCHIVE_STORAGE_FULL", "local archive storage budget is full");
      }
      await fs.promises.mkdir(temporaryDirectory, { recursive: false });
      try {
        await fs.promises.mkdir(path.join(temporaryDirectory, "submissions"), { recursive: false });
        await fs.promises.mkdir(path.join(temporaryDirectory, "drafts"), { recursive: false });
        await atomicWriteFile(temporaryDirectory, "session.json", data);
        await atomicWriteFile(temporaryDirectory, "scope.json", scopeData);
        await fs.promises.rename(temporaryDirectory, sessionDirectory);
      } catch (error) {
        await this.cleanupSessionTemporaryDirectory(temporaryDirectory);
        throw error;
      }
      this.sessionCount += 1;
      this.activeSessions.set(session.sessionId, {
        scope: normalizedScope.scope,
        expiresAt: Date.parse(session.expiresAt)
      });
      this.usedBytes += data.length + scopeData.length;
      return { session: this.publicSession(session, 0), submitToken };
    });
  }

  async readSession(sessionId) {
    await this.ready;
    const directory = this.sessionDirectory(sessionId);
    const session = await readJsonFile(path.join(directory, "session.json"), MAX_SESSION_METADATA_BYTES, "SESSION_NOT_FOUND");
    if (session?.schemaVersion !== SESSION_SCHEMA_VERSION || session.sessionId !== sessionId
      || typeof session.runId !== "string" || !/^run_[a-f0-9]{32}$/.test(session.runId)
      || typeof session.submitTokenHash !== "string" || !SHA256_PATTERN.test(session.submitTokenHash)
      || typeof session.challengeDigest !== "string" || !SHA256_PATTERN.test(session.challengeDigest)
      || !session.challenge?.runDefinition
      || (session.challenge?.sessionMode !== undefined && !SESSION_MODES.has(session.challenge.sessionMode))
      || !validateSessionChallengeBinding(session)
      || (session.ownerUserId !== undefined && session.ownerUserId !== null
        && !OWNER_USER_ID_PATTERN.test(session.ownerUserId))) {
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored session metadata is invalid");
    }
    return session;
  }

  async authorizeSession(sessionId, token, { allowExpired = false } = {}) {
    const session = await this.readSession(sessionId);
    const normalizedToken = validateBearerToken(token);
    const expected = Buffer.from(session.submitTokenHash, "hex");
    const actual = crypto.createHash("sha256").update(normalizedToken).digest();
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      throw new SubmissionStoreError(403, "INVALID_SESSION_TOKEN", "session bearer token is invalid");
    }
    const expiresAtMs = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAtMs)) throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored session expiry is invalid");
    if (!allowExpired && Number(this.now()) >= expiresAtMs) {
      throw new SubmissionStoreError(410, "SESSION_EXPIRED", "session has expired");
    }
    return session;
  }

  async listSubmissionManifests(sessionId) {
    const submissionsDirectory = path.join(this.sessionDirectory(sessionId), "submissions");
    const entries = await fs.promises.readdir(submissionsDirectory, { withFileTypes: true }).catch(error => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    const manifests = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SUBMISSION_ID_PATTERN.test(entry.name)) continue;
      const manifest = await readJsonFile(
        path.join(submissionsDirectory, entry.name, "manifest.json"),
        64 * 1024,
        "SUBMISSION_NOT_FOUND"
      );
      if (manifest?.schemaVersion !== SUBMISSION_SCHEMA_VERSION || manifest.submissionId !== entry.name) {
        throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored submission metadata is invalid");
      }
      manifests.push(manifest);
    }
    manifests.sort((left, right) => String(left.receivedAt).localeCompare(String(right.receivedAt)));
    return manifests;
  }

  async listDraftManifests(sessionId) {
    const draftsDirectory = path.join(this.sessionDirectory(sessionId), "drafts");
    const entries = await fs.promises.readdir(draftsDirectory, { withFileTypes: true }).catch(error => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    const manifests = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SUBMISSION_ID_PATTERN.test(entry.name)) continue;
      const manifest = await readJsonFile(
        path.join(draftsDirectory, entry.name, "manifest.json"),
        MAX_DRAFT_MANIFEST_BYTES,
        "SUBMISSION_NOT_FOUND"
      );
      if (manifest?.schemaVersion !== RECORD_DRAFT_SCHEMA_VERSION || manifest.recordId !== entry.name) {
        throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored record draft metadata is invalid");
      }
      manifests.push(manifest);
    }
    manifests.sort((left, right) => String(left.savedAt).localeCompare(String(right.savedAt)));
    return manifests;
  }

  validateDraftManifest(manifest, session, sessionId, recordId) {
    const expectedRun = {
      schemaVersion: "chenlong.run-record/v4",
      serverSessionId: session.sessionId,
      runId: session.runId,
      challengeDigest: session.challengeDigest,
      runDefinitionDigest: sessionRunDefinitionDigest(session),
      teamId: session.teamId,
      taskId: session.challenge.taskId,
      mapId: session.challenge.mapId,
      mapVersion: session.challenge.mapVersion,
      ruleVersion: session.challenge.ruleVersion
    };
    const ownerMatches = session.ownerUserId
      ? manifest?.ownerUserId === session.ownerUserId
      : (!Object.prototype.hasOwnProperty.call(manifest || {}, "ownerUserId") || manifest.ownerUserId === null);
    const score = manifest?.result?.score;
    const valid = manifest?.schemaVersion === RECORD_DRAFT_SCHEMA_VERSION
      && manifest.recordId === recordId
      && manifest.sessionId === sessionId
      && manifest.challengeDigest === session.challengeDigest
      && manifest.authoritative === false
      && ownerMatches
      && validIsoTimestamp(manifest.savedAt)
      && Object.keys(expectedRun).every(field => manifest.run?.[field] === expectedRun[field])
      && manifest.result && typeof manifest.result === "object" && !Array.isArray(manifest.result)
      && (score === null || (typeof score === "number" && Number.isFinite(score)))
      && typeof manifest.record?.sha256 === "string"
      && SHA256_PATTERN.test(manifest.record.sha256)
      && Number.isSafeInteger(manifest.record.byteLength)
      && manifest.record.byteLength > 0
      && manifest.record.byteLength <= MAX_ARCHIVED_RECORD_BYTES
      && draftRecordStorage(manifest.record) !== null;
    if (!valid) {
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored record draft metadata is invalid");
    }
  }

  async saveDraft(session, token, recordBuffer, metadata, result = {}) {
    await this.ready;
    const recordSha256 = sha256(recordBuffer);
    const recordId = `sub_${recordSha256.slice(0, 32)}`;
    return this.withMutationLock(async () => {
      session = await this.authorizeSession(session.sessionId, token);
      const storedScope = await this.readStoredSessionScopeUnlocked(session);
      if (storedScope !== null && storedScope.scope !== "single") {
        throw new SubmissionStoreError(403, "BATCH_SESSION_REQUIRES_BATCH_ROUTE",
          "batch-scoped sessions cannot create personal record drafts");
      }
      if ((await this.readStoredSessionRetirementUnlocked(session)) !== null) {
        throw new SubmissionStoreError(409, "SESSION_RETIRED", "session no longer accepts record drafts");
      }
      this.assertRecordMatchesSession(session, metadata);
      const existingDirectory = this.draftDirectory(session.sessionId, recordId);
      try {
        const existing = await this.readDraft(session.sessionId, recordId, null, { skipAuthorization: true });
        if (existing.manifest.record.sha256 !== recordSha256) {
          throw new SubmissionStoreError(409, "SUBMISSION_ID_COLLISION", "record digest prefix collision");
        }
        return { ...existing, duplicate: true };
      } catch (error) {
        if (!(error instanceof SubmissionStoreError) || error.code !== "SUBMISSION_NOT_FOUND") throw error;
      }

      // A completed single-run archive is the durable seal for its session.  A
      // late retry of the original draft remains idempotent even after that
      // draft has been promoted and reclaimed, but the session can never be
      // reused for a different run record.
      try {
        const existing = await this.readSubmission(
          session.sessionId,
          recordId,
          null,
          { skipAuthorization: true }
        );
        if (existing.manifest.record.sha256 !== recordSha256) {
          throw new SubmissionStoreError(409, "SUBMISSION_ID_COLLISION", "record digest prefix collision");
        }
        const origin = await this.readDraftOrigin(
          session.sessionId,
          recordId,
          existing.manifest.record.sha256
        );
        const scoreCandidate = Number(result?.score);
        return {
          manifest: {
            schemaVersion: RECORD_DRAFT_SCHEMA_VERSION,
            recordId,
            sessionId: session.sessionId,
            challengeDigest: session.challengeDigest,
            savedAt: origin?.savedAt || existing.manifest.receivedAt,
            authoritative: false,
            run: { ...metadata },
            result: { score: Number.isFinite(scoreCandidate) ? scoreCandidate : null },
            record: { ...existing.manifest.record },
            ...(session.ownerUserId ? { ownerUserId: session.ownerUserId } : {})
          },
          duplicate: true
        };
      } catch (error) {
        if (!(error instanceof SubmissionStoreError) || error.code !== "SUBMISSION_NOT_FOUND") throw error;
      }

      const manifests = await this.listDraftManifests(session.sessionId);
      const submissionManifests = await this.listSubmissionManifests(session.sessionId);
      if (manifests.length > 0 || submissionManifests.length > 0) {
        throw new SubmissionStoreError(409, "SINGLE_SESSION_RECORD_EXISTS",
          "single-run session already contains its only record");
      }
      const savedAtMilliseconds = Number(this.now());
      if (!Number.isSafeInteger(savedAtMilliseconds) || savedAtMilliseconds < 0) {
        throw new TypeError("now() must return a non-negative safe integer");
      }
      const scoreCandidate = Number(result?.score);
      const compressedRecordBuffer = zlib.gzipSync(recordBuffer);
      const manifest = {
        schemaVersion: RECORD_DRAFT_SCHEMA_VERSION,
        recordId,
        sessionId: session.sessionId,
        challengeDigest: session.challengeDigest,
        savedAt: new Date(savedAtMilliseconds).toISOString(),
        authoritative: false,
        run: { ...metadata },
        result: { score: Number.isFinite(scoreCandidate) ? scoreCandidate : null },
        record: {
          sha256: recordSha256,
          byteLength: recordBuffer.length,
          storageEncoding: "gzip",
          storedByteLength: compressedRecordBuffer.length
        }
      };
      if (session.ownerUserId) manifest.ownerUserId = session.ownerUserId;
      const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      const additionalBytes = compressedRecordBuffer.length + manifestBuffer.length;
      if (this.usedBytes + additionalBytes > this.maxStorageBytes) {
        throw new SubmissionStoreError(507, "ARCHIVE_STORAGE_FULL", "local archive storage budget is full");
      }

      const draftsDirectory = path.dirname(existingDirectory);
      await fs.promises.mkdir(draftsDirectory, { recursive: true });
      const temporaryDirectory = path.join(draftsDirectory, `.${recordId}.${crypto.randomUUID()}.tmp`);
      await fs.promises.mkdir(temporaryDirectory, { recursive: false });
      try {
        await atomicWriteFile(temporaryDirectory, COMPRESSED_DRAFT_RECORD_FILENAME, compressedRecordBuffer);
        await atomicWriteFile(temporaryDirectory, "manifest.json", manifestBuffer);
        await fs.promises.rename(temporaryDirectory, existingDirectory);
      } catch (error) {
        await this.cleanupTemporaryDirectory(temporaryDirectory);
        if (["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) {
          const existing = await this.readDraft(session.sessionId, recordId, null, { skipAuthorization: true });
          if (existing.manifest.record.sha256 === recordSha256) return { ...existing, duplicate: true };
        }
        throw error;
      }
      this.usedBytes += additionalBytes;
      this.activeSessions.delete(session.sessionId);
      this.sessionCount = this.activeSessionCountsUnlocked().total;
      return { manifest, duplicate: false };
    });
  }

  async readDraftMetadata(sessionId, recordId, token, { skipAuthorization = false } = {}) {
    const session = skipAuthorization
      ? await this.readSession(sessionId)
      : await this.authorizeSession(sessionId, token, { allowExpired: true });
    const directory = this.draftDirectory(sessionId, recordId);
    const manifest = await readJsonFile(
      path.join(directory, "manifest.json"),
      MAX_DRAFT_MANIFEST_BYTES,
      "SUBMISSION_NOT_FOUND"
    );
    this.validateDraftManifest(manifest, session, sessionId, recordId);
    const storage = draftRecordStorage(manifest.record);
    await inspectExactFile(
      path.join(directory, storage.filename),
      storage.byteLength,
      storage.maximumBytes,
      "SUBMISSION_NOT_FOUND"
    );
    return { manifest };
  }

  async readDraft(sessionId, recordId, token, { skipAuthorization = false } = {}) {
    const stored = await this.readDraftMetadata(sessionId, recordId, token, { skipAuthorization });
    const directory = this.draftDirectory(sessionId, recordId);
    const storage = draftRecordStorage(stored.manifest.record);
    const storedBuffer = await readExactFile(
      path.join(directory, storage.filename),
      storage.byteLength,
      storage.maximumBytes,
      "SUBMISSION_NOT_FOUND"
    );
    const buffer = decodeDraftRecordBuffer(storedBuffer, storage, stored.manifest.record);
    if (sha256(buffer) !== stored.manifest.record.sha256) {
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored record draft digest does not match");
    }
    return { ...stored, buffer };
  }

  validateDraftOrigin(value, sessionId, submissionId, recordSha256) {
    const valid = value?.schemaVersion === DRAFT_ORIGIN_SCHEMA_VERSION
      && value.sessionId === sessionId
      && value.recordId === submissionId
      && value.recordSha256 === recordSha256
      && validIsoTimestamp(value.savedAt)
      && value.authoritative === false;
    if (!valid) {
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored record draft origin is invalid");
    }
    return value;
  }

  async readDraftOrigin(sessionId, submissionId, recordSha256) {
    let value;
    try {
      value = await readJsonFile(
        path.join(this.submissionDirectory(sessionId, submissionId), "draft-origin.json"),
        MAX_DRAFT_ORIGIN_BYTES,
        "SUBMISSION_NOT_FOUND"
      );
    } catch (error) {
      if (error instanceof SubmissionStoreError && error.code === "SUBMISSION_NOT_FOUND") return null;
      throw error;
    }
    return this.validateDraftOrigin(value, sessionId, submissionId, recordSha256);
  }

  async promoteDraftToSubmission(sessionId, submissionId, ownerUserId) {
    await this.ready;
    return this.withMutationLock(async () => {
      const session = await this.readSession(sessionId);
      this.assertSessionOwner(session, ownerUserId);
      const submission = await this.readSubmissionMetadata(
        sessionId,
        submissionId,
        null,
        { skipAuthorization: true }
      );
      let draft = null;
      try {
        draft = await this.readDraftMetadata(sessionId, submissionId, null, { skipAuthorization: true });
      } catch (error) {
        if (!(error instanceof SubmissionStoreError) || error.code !== "SUBMISSION_NOT_FOUND") throw error;
      }
      let origin = await this.readDraftOrigin(
        sessionId,
        submissionId,
        submission.manifest.record.sha256
      );
      if (!origin && draft) {
        origin = {
          schemaVersion: DRAFT_ORIGIN_SCHEMA_VERSION,
          sessionId,
          recordId: submissionId,
          recordSha256: submission.manifest.record.sha256,
          savedAt: draft.manifest.savedAt,
          authoritative: false
        };
        const data = Buffer.from(`${JSON.stringify(origin, null, 2)}\n`);
        if (data.length > MAX_DRAFT_ORIGIN_BYTES) {
          throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "record draft origin is too large");
        }
        if (this.usedBytes + data.length > this.maxStorageBytes) {
          throw new SubmissionStoreError(507, "ARCHIVE_STORAGE_FULL", "local archive storage budget is full");
        }
        await atomicWriteFile(this.submissionDirectory(sessionId, submissionId), "draft-origin.json", data);
        this.usedBytes += data.length;
      }
      if (!draft) return { savedAt: origin?.savedAt || submission.manifest.receivedAt, reclaimedBytes: 0 };

      const directory = this.draftDirectory(sessionId, submissionId);
      const storage = draftRecordStorage(draft.manifest.record);
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      if (!storage || entries.length !== 2
        || !entries.every(entry => entry.isFile() && !entry.isSymbolicLink()
          && ["manifest.json", storage.filename].includes(entry.name))) {
        throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "record draft directory contains unsupported entries");
      }
      let reclaimedBytes = 0;
      for (const entry of entries) {
        const filePath = path.join(directory, entry.name);
        const stat = await fs.promises.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "record draft contains an unsafe file");
        }
        reclaimedBytes += stat.size;
      }
      for (const filename of [storage.filename, "manifest.json"]) {
        await fs.promises.unlink(path.join(directory, filename));
      }
      await fs.promises.rmdir(directory);
      this.usedBytes = Math.max(0, this.usedBytes - reclaimedBytes);
      return { savedAt: origin?.savedAt || draft.manifest.savedAt, reclaimedBytes };
    });
  }

  publicSession(session, submissionCount) {
    const result = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId: session.sessionId,
      runId: session.runId,
      teamId: session.teamId,
      challenge: publicChallengeMetadata(session.challenge),
      challengeDigest: session.challengeDigest,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      status: Number(this.now()) >= Date.parse(session.expiresAt) ? "expired" : "open",
      submissionCount,
      maxSubmissions: this.maxSubmissionsPerSession,
      authoritative: false
    };
    if (session.ownerUserId) result.ownerUserId = session.ownerUserId;
    return result;
  }

  assertSessionOwner(session, ownerUserId, { admin = false } = {}) {
    if (admin) return session;
    const normalizedOwnerUserId = normalizeOwnerUserId(ownerUserId);
    if (!session?.ownerUserId || session.ownerUserId !== normalizedOwnerUserId) {
      throw new SubmissionStoreError(403, "SESSION_OWNER_MISMATCH", "session belongs to another user");
    }
    return session;
  }

  async getSession(sessionId, token) {
    const session = await this.authorizeSession(sessionId, token, { allowExpired: true });
    const submissions = await this.listSubmissionManifests(sessionId);
    return { ...this.publicSession(session, submissions.length), submissions };
  }

  assertRecordMatchesSession(session, metadata) {
    const expected = {
      schemaVersion: "chenlong.run-record/v4",
      serverSessionId: session.sessionId,
      runId: session.runId,
      challengeDigest: session.challengeDigest,
      runDefinitionDigest: sessionRunDefinitionDigest(session),
      teamId: session.teamId,
      taskId: session.challenge.taskId,
      mapId: session.challenge.mapId,
      mapVersion: session.challenge.mapVersion,
      ruleVersion: session.challenge.ruleVersion
    };
    const mismatchedFields = Object.keys(expected).filter(field => metadata?.[field] !== expected[field]);
    if (mismatchedFields.length) {
      throw new SubmissionStoreError(
        409,
        "SESSION_RECORD_MISMATCH",
        `run record does not match session fields: ${mismatchedFields.join(", ")}`
      );
    }
  }

  validateSubmissionManifest(manifest, session, sessionId, submissionId) {
    const expectedRun = {
      schemaVersion: "chenlong.run-record/v4",
      serverSessionId: session.sessionId,
      runId: session.runId,
      challengeDigest: session.challengeDigest,
      runDefinitionDigest: sessionRunDefinitionDigest(session),
      teamId: session.teamId,
      taskId: session.challenge.taskId,
      mapId: session.challenge.mapId,
      mapVersion: session.challenge.mapVersion,
      ruleVersion: session.challenge.ruleVersion
    };
    const ownerMatches = session.ownerUserId
      ? manifest?.ownerUserId === session.ownerUserId
      : (!Object.prototype.hasOwnProperty.call(manifest || {}, "ownerUserId") || manifest.ownerUserId === null);
    const valid = manifest?.schemaVersion === SUBMISSION_SCHEMA_VERSION
      && manifest.submissionId === submissionId
      && manifest.sessionId === sessionId
      && manifest.challengeDigest === session.challengeDigest
      && manifest.authoritative === false
      && ownerMatches
      && Object.keys(expectedRun).every(field => manifest.run?.[field] === expectedRun[field])
      && typeof manifest.record?.sha256 === "string"
      && /^[a-f0-9]{64}$/.test(manifest.record.sha256)
      && Number.isSafeInteger(manifest.record.byteLength)
      && manifest.record.byteLength > 0
      && manifest.record.byteLength <= MAX_ARCHIVED_RECORD_BYTES
      && typeof manifest.report?.sha256 === "string"
      && /^[a-f0-9]{64}$/.test(manifest.report.sha256)
      && Number.isSafeInteger(manifest.report.byteLength)
      && manifest.report.byteLength > 0
      && manifest.report.byteLength <= MAX_ARCHIVED_REPORT_BYTES
      && typeof manifest.report.schemaVersion === "string"
      && typeof manifest.report.status === "string";
    if (!valid) {
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored submission metadata is invalid");
    }
  }

  async saveSubmission(session, token, recordBuffer, reportBuffer, report, metadata) {
    return this.saveSubmissionInternal(
      session,
      recordBuffer,
      reportBuffer,
      report,
      metadata,
      { token }
    );
  }

  async saveVerifiedSingleSubmission(
    sessionId,
    ownerUserId,
    recordBuffer,
    reportBuffer,
    report,
    metadata
  ) {
    return this.saveSubmissionInternal(
      { sessionId: validateSessionId(sessionId) },
      recordBuffer,
      reportBuffer,
      report,
      metadata,
      { ownerUserId: normalizeOwnerUserId(ownerUserId), allowExpired: true }
    );
  }

  async saveVerifiedBatchSubmission(
    sessionId,
    ownerUserId,
    recordBuffer,
    reportBuffer,
    report,
    metadata,
    options = {}
  ) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("verified batch submission options are invalid");
    }
    const allowedOptionKeys = new Set(["notAfter", "scope", "batchId", "slotIndex", "competitionId"]);
    if (Object.keys(options).some(key => !allowedOptionKeys.has(key))) {
      throw new TypeError("verified batch submission options are invalid");
    }
    const scopeOptions = options.scope === "ranked"
      ? {
        scope: options.scope,
        batchId: options.batchId,
        slotIndex: options.slotIndex,
        competitionId: options.competitionId
      }
      : {
        scope: options.scope,
        batchId: options.batchId,
        slotIndex: options.slotIndex
      };
    const expectedScope = normalizeSessionScopeOptions(scopeOptions);
    if (expectedScope.scope === "single") {
      throw new TypeError("verified batch submissions require practice or ranked scope");
    }
    if (expectedScope.scope === "practice"
      && (Object.prototype.hasOwnProperty.call(options, "competitionId")
        || Object.prototype.hasOwnProperty.call(options, "notAfter"))) {
      throw new TypeError("practice submission options are invalid");
    }
    if (expectedScope.scope === "ranked" && !Object.prototype.hasOwnProperty.call(options, "notAfter")) {
      throw new TypeError("ranked submissions require notAfter");
    }
    let notAfter = null;
    if (Object.prototype.hasOwnProperty.call(options, "notAfter")) {
      const parsed = Date.parse(options.notAfter);
      if (typeof options.notAfter !== "string"
        || !Number.isFinite(parsed)
        || new Date(parsed).toISOString() !== options.notAfter) {
        throw new TypeError("notAfter must be an exact ISO timestamp");
      }
      notAfter = options.notAfter;
    }
    return this.saveSubmissionInternal(
      { sessionId: validateSessionId(sessionId) },
      recordBuffer,
      reportBuffer,
      report,
      metadata,
      { ownerUserId: normalizeOwnerUserId(ownerUserId), notAfter, expectedScope }
    );
  }

  async saveSubmissionInternal(session, recordBuffer, reportBuffer, report, metadata, authorization) {
    const recordSha256 = sha256(recordBuffer);
    const submissionId = `sub_${recordSha256.slice(0, 32)}`;
    return this.withMutationLock(async () => {
      if (authorization?.ownerUserId) {
        session = await this.readSession(session.sessionId);
        this.assertSessionOwner(session, authorization.ownerUserId);
        if (authorization.allowExpired !== true
          && (authorization.notAfter === null || authorization.notAfter === undefined)
          && Number(this.now()) >= Date.parse(session.expiresAt)) {
          throw new SubmissionStoreError(410, "SESSION_EXPIRED", "session has expired");
        }
      } else {
        session = await this.authorizeSession(session.sessionId, authorization?.token);
      }
      const storedScope = await this.readStoredSessionScopeUnlocked(session);
      let effectiveScope = storedScope?.scope || "single";
      if (authorization?.expectedScope) {
        const requestedScope = this.sessionScopePayload(session, authorization.expectedScope);
        if (storedScope === null) {
          await this.writePrivateSidecarUnlocked(
            session.sessionId,
            "scope.json",
            privateSidecarRecord(SESSION_SCOPE_RECORD_SCHEMA_VERSION, requestedScope)
          );
          effectiveScope = requestedScope.scope;
        } else if (canonicalSha256(storedScope) !== canonicalSha256(requestedScope)) {
          throw new SubmissionStoreError(409, "SESSION_SCOPE_MISMATCH",
            "session is not bound to this batch slot submission route");
        }
      } else if (storedScope !== null && storedScope.scope !== "single") {
        throw new SubmissionStoreError(403, "BATCH_SESSION_REQUIRES_BATCH_ROUTE",
          "batch-scoped sessions cannot use the generic submission route");
      }
      if ((await this.readStoredSessionRetirementUnlocked(session)) !== null) {
        throw new SubmissionStoreError(409, "SESSION_RETIRED", "session no longer accepts archived submissions");
      }
      this.assertRecordMatchesSession(session, metadata);
      const existingDirectory = this.submissionDirectory(session.sessionId, submissionId);
      try {
        const existing = await this.readSubmission(session.sessionId, submissionId, null, { skipAuthorization: true });
        if (existing.manifest.record.sha256 !== recordSha256) {
          throw new SubmissionStoreError(409, "SUBMISSION_ID_COLLISION", "submission digest prefix collision");
        }
        if (effectiveScope === "single") {
          this.noteBestSubmittedRecord(session, existing.manifest, existing.report);
        }
        return { ...existing, duplicate: true };
      } catch (error) {
        if (!(error instanceof SubmissionStoreError) || error.code !== "SUBMISSION_NOT_FOUND") throw error;
      }

      const manifests = await this.listSubmissionManifests(session.sessionId);
      if (authorization?.expectedScope && manifests.length >= 1) {
        throw new SubmissionStoreError(409, "BATCH_SESSION_SUBMISSION_EXISTS",
          "batch slot session already contains its only archived submission");
      }
      if (effectiveScope === "single") {
        const drafts = await this.listDraftManifests(session.sessionId);
        const matchingDraft = drafts.find(manifest => manifest.recordId === submissionId);
        if (manifests.length > 0
          || drafts.some(manifest => manifest.recordId !== submissionId)
          || (matchingDraft && matchingDraft.record.sha256 !== recordSha256)) {
          throw new SubmissionStoreError(409, "SINGLE_SESSION_RECORD_EXISTS",
            "single-run session already contains its only record");
        }
      }
      if (manifests.length >= this.maxSubmissionsPerSession) {
        throw new SubmissionStoreError(429, "SUBMISSION_LIMIT_REACHED", "session submission limit reached");
      }
      const receivedAtMilliseconds = Number(this.now());
      if (!Number.isSafeInteger(receivedAtMilliseconds) || receivedAtMilliseconds < 0) {
        throw new TypeError("now() must return a non-negative safe integer");
      }
      if (authorization?.notAfter !== null && authorization?.notAfter !== undefined
        && receivedAtMilliseconds >= Date.parse(authorization.notAfter)) {
        throw new SubmissionStoreError(
          410,
          "SUBMISSION_DEADLINE_EXPIRED",
          "verified submission was not archived before its deadline"
        );
      }
      const receivedAt = new Date(receivedAtMilliseconds).toISOString();
      const manifest = {
        schemaVersion: SUBMISSION_SCHEMA_VERSION,
        submissionId,
        sessionId: session.sessionId,
        challengeDigest: session.challengeDigest,
        receivedAt,
        authoritative: false,
        run: { ...metadata },
        record: { sha256: recordSha256, byteLength: recordBuffer.length },
        report: {
          sha256: sha256(reportBuffer),
          byteLength: reportBuffer.length,
          schemaVersion: report.schemaVersion,
          status: report.status
        }
      };
      if (session.ownerUserId) manifest.ownerUserId = session.ownerUserId;
      const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      const additionalBytes = recordBuffer.length + reportBuffer.length + manifestBuffer.length;
      if (this.usedBytes + additionalBytes > this.maxStorageBytes) {
        throw new SubmissionStoreError(507, "ARCHIVE_STORAGE_FULL", "local archive storage budget is full");
      }

      const submissionsDirectory = path.dirname(existingDirectory);
      const temporaryDirectory = path.join(submissionsDirectory, `.${submissionId}.${crypto.randomUUID()}.tmp`);
      await fs.promises.mkdir(temporaryDirectory, { recursive: false });
      try {
        await atomicWriteFile(temporaryDirectory, "record.json", recordBuffer);
        await atomicWriteFile(temporaryDirectory, "report.json", reportBuffer);
        await atomicWriteFile(temporaryDirectory, "manifest.json", manifestBuffer);
        await fs.promises.rename(temporaryDirectory, existingDirectory);
      } catch (error) {
        await this.cleanupTemporaryDirectory(temporaryDirectory);
        if (["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) {
          const existing = await this.readSubmission(session.sessionId, submissionId, null, { skipAuthorization: true });
          if (existing.manifest.record.sha256 === recordSha256) {
            if (effectiveScope === "single") {
              this.noteBestSubmittedRecord(session, existing.manifest, existing.report);
            }
            return { ...existing, duplicate: true };
          }
        }
        throw error;
      }
      this.usedBytes += additionalBytes;
      if (effectiveScope === "single") {
        this.noteBestSubmittedRecord(session, manifest, report);
        this.activeSessions.delete(session.sessionId);
        this.sessionCount = this.activeSessionCountsUnlocked().total;
      }
      return { manifest, report, duplicate: false };
    });
  }

  async cleanupTemporaryDirectory(directory) {
    const resolved = path.resolve(directory);
    const expectedPrefix = `${path.resolve(this.sessionsDir)}${path.sep}`.toLowerCase();
    if (!resolved.toLowerCase().startsWith(expectedPrefix) || !path.basename(resolved).startsWith(".sub_")) return;
    const entries = await fs.promises.readdir(resolved, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() || entry.isSymbolicLink()) await fs.promises.unlink(path.join(resolved, entry.name)).catch(() => {});
    }
    await fs.promises.rmdir(resolved).catch(() => {});
  }

  async readSubmissionMetadata(sessionId, submissionId, token, { skipAuthorization = false } = {}) {
    const session = skipAuthorization
      ? await this.readSession(sessionId)
      : await this.authorizeSession(sessionId, token, { allowExpired: true });
    const directory = this.submissionDirectory(sessionId, submissionId);
    const manifest = await readJsonFile(path.join(directory, "manifest.json"), 64 * 1024, "SUBMISSION_NOT_FOUND");
    const reportRead = await readJsonFile(
      path.join(directory, "report.json"),
      MAX_ARCHIVED_REPORT_BYTES,
      "SUBMISSION_NOT_FOUND",
      { withBuffer: true }
    );
    const report = reportRead.value;
    this.validateSubmissionManifest(manifest, session, sessionId, submissionId);
    if (report?.schemaVersion !== manifest.report.schemaVersion || report?.status !== manifest.report.status) {
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored submission metadata is invalid");
    }
    if (reportRead.buffer.length !== manifest.report.byteLength || sha256(reportRead.buffer) !== manifest.report.sha256) {
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored verification report digest does not match");
    }
    await inspectExactFile(
      path.join(directory, "record.json"),
      manifest.record.byteLength,
      MAX_ARCHIVED_RECORD_BYTES,
      "SUBMISSION_NOT_FOUND"
    );
    return { manifest, report };
  }

  async inspectSubmissionEvidenceIdentity(sessionId, submissionId) {
    const normalizedSessionId = validateSessionId(sessionId);
    const normalizedSubmissionId = validateSubmissionId(submissionId);
    const session = await this.readSession(normalizedSessionId);
    const directory = this.submissionDirectory(normalizedSessionId, normalizedSubmissionId);
    const manifestRead = await readJsonFile(
      path.join(directory, "manifest.json"),
      64 * 1024,
      "SUBMISSION_NOT_FOUND",
      { withBuffer: true }
    );
    const manifest = manifestRead.value;
    this.validateSubmissionManifest(manifest, session, normalizedSessionId, normalizedSubmissionId);
    const inspectFile = async (filename, expectedBytes) => {
      let stat;
      try {
        stat = await fs.promises.lstat(path.join(directory, filename));
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new SubmissionStoreError(404, "SUBMISSION_NOT_FOUND", "submission evidence is incomplete");
        }
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedBytes) {
        throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored submission evidence is invalid");
      }
      return {
        byteLength: stat.size,
        device: String(stat.dev),
        inode: String(stat.ino),
        modifiedMilliseconds: stat.mtimeMs,
        changedMilliseconds: stat.ctimeMs
      };
    };
    return {
      sessionId: normalizedSessionId,
      submissionId: normalizedSubmissionId,
      manifestSha256: sha256(manifestRead.buffer),
      manifest: await inspectFile("manifest.json", manifestRead.buffer.length),
      record: await inspectFile("record.json", manifest.record.byteLength),
      report: await inspectFile("report.json", manifest.report.byteLength)
    };
  }

  async readSubmission(sessionId, submissionId, token, { skipAuthorization = false } = {}) {
    const stored = await this.readSubmissionMetadata(sessionId, submissionId, token, { skipAuthorization });
    const directory = this.submissionDirectory(sessionId, submissionId);
    const recordBuffer = await readExactFile(
      path.join(directory, "record.json"),
      stored.manifest.record.byteLength,
      MAX_ARCHIVED_RECORD_BYTES,
      "SUBMISSION_NOT_FOUND"
    );
    if (sha256(recordBuffer) !== stored.manifest.record.sha256) {
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored run record digest does not match");
    }
    return { ...stored, buffer: recordBuffer };
  }

  async readRecord(
    sessionId,
    submissionId,
    token,
    maximumBytes = MAX_ARCHIVED_RECORD_BYTES,
    { skipAuthorization = false } = {}
  ) {
    const session = skipAuthorization
      ? await this.readSession(sessionId)
      : await this.authorizeSession(sessionId, token, { allowExpired: true });
    const directory = this.submissionDirectory(sessionId, submissionId);
    const manifest = await readJsonFile(path.join(directory, "manifest.json"), 64 * 1024, "SUBMISSION_NOT_FOUND");
    this.validateSubmissionManifest(manifest, session, sessionId, submissionId);
    if (manifest.record.byteLength > maximumBytes) {
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored run record is invalid");
    }
    const buffer = await readExactFile(
      path.join(directory, "record.json"),
      manifest.record.byteLength,
      Math.min(MAX_ARCHIVED_RECORD_BYTES, maximumBytes),
      "SUBMISSION_NOT_FOUND"
    );
    if (sha256(buffer) !== manifest.record.sha256) {
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored run record digest does not match");
    }
    return { buffer, manifest };
  }

  async countActiveSessionsByScope() {
    const entries = await fs.promises.readdir(this.sessionsDir, { withFileTypes: true });
    const counts = { single: 0, practice: 0, ranked: 0, unknown: 0, total: 0 };
    const activeSessions = new Map();
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name)) continue;
      try {
        const session = await this.readSession(entry.name);
        let retired = false;
        try {
          retired = (await this.readStoredSessionRetirementUnlocked(session)) !== null;
        } catch (_error) {
          // A malformed marker fails closed and the unexpired session remains active.
        }
        if (!retired && Number(this.now()) < Date.parse(session.expiresAt)) {
          let scope = "single";
          try {
            scope = (await this.readStoredSessionScopeUnlocked(session))?.scope || "single";
          } catch (_error) {
            scope = "unknown";
          }
          let sealed = false;
          if (scope === "single") {
            try {
              sealed = await this.singleSessionHasArchivedRecordUnlocked(session);
            } catch (_error) {
              // Invalid archive evidence is never trusted to release capacity.
            }
          }
          if (sealed) continue;
          counts[scope] += 1;
          counts.total += 1;
          activeSessions.set(session.sessionId, {
            scope,
            expiresAt: Date.parse(session.expiresAt)
          });
        }
      } catch (_error) {
        // A corrupt directory cannot become an active session.
      }
    }
    this.activeSessions = activeSessions;
    this.sessionCount = counts.total;
    return counts;
  }

  async countActiveSessions() {
    return (await this.countActiveSessionsByScope()).total;
  }

  async listArchiveSessionIds() {
    await this.ready;
    const entries = await fs.promises.readdir(this.sessionsDir, { withFileTypes: true });
    const ids = entries
      .filter(entry => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name))
      .map(entry => entry.name)
      .sort();
    return ids;
  }

  noteBestSubmittedRecord(session, manifest, report) {
    if (!session?.ownerUserId) return;
    const summary = this.recordSummary(session, manifest, report);
    if (summary.score === null) return;
    if (this.bestSubmittedRecordIndex !== null) {
      mergeBestSubmittedRecord(this.bestSubmittedRecordIndex, summary);
    } else {
      mergeBestSubmittedRecord(this.bestSubmittedRecordPending, summary);
    }
  }

  async buildBestSubmittedRecordIndex() {
    const index = new Map();
    for (const sessionId of await this.listArchiveSessionIds()) {
      const session = await this.readSession(sessionId);
      if (!session.ownerUserId || !(await this.sessionMatchesExpectedRecordScope(session, "single"))) continue;
      for (const manifest of await this.listSubmissionManifests(sessionId)) {
        const stored = await this.readSubmissionMetadata(
          sessionId,
          manifest.submissionId,
          null,
          { skipAuthorization: true }
        );
        const summary = this.recordSummary(session, stored.manifest, stored.report);
        if (summary.score !== null) mergeBestSubmittedRecord(index, summary);
      }
    }
    // New submissions are noted synchronously after their archive rename. Any
    // that completed while the historical scan was awaiting I/O are merged
    // before the cache becomes visible, so no durable winner can be missed.
    for (const record of this.bestSubmittedRecordPending.values()) {
      mergeBestSubmittedRecord(index, record);
    }
    this.bestSubmittedRecordPending.clear();
    this.bestSubmittedRecordIndex = index;
    return index;
  }

  async listBestSubmittedRecords() {
    await this.ready;
    if (this.bestSubmittedRecordIndex === null) {
      if (this.bestSubmittedRecordBuild === null) {
        const build = this.buildBestSubmittedRecordIndex();
        this.bestSubmittedRecordBuild = build;
        build.finally(() => {
          if (this.bestSubmittedRecordBuild === build) this.bestSubmittedRecordBuild = null;
        }).catch(() => {});
      }
      await this.bestSubmittedRecordBuild;
    }
    return [...this.bestSubmittedRecordIndex.values()]
      .sort((left, right) => (
        submittedRecordTime(right.latestSubmittedAt) - submittedRecordTime(left.latestSubmittedAt)
        || left.ownerUserId.localeCompare(right.ownerUserId)
        || left.teamId.localeCompare(right.teamId)
        || left.taskId.localeCompare(right.taskId)
      ))
      .map(record => ({ ...record }));
  }

  recordSummary(session, manifest, report, options = {}) {
    const scoreCandidate = report?.recomputedResult?.score ?? report?.recordedResult?.score;
    const score = normalizedPublicScore(session, scoreCandidate);
    const verification = publicVerificationSummary(report);
    const savedAt = validIsoTimestamp(options.savedAt) ? options.savedAt : manifest.receivedAt;
    const summary = {
      id: manifest.submissionId,
      submissionId: manifest.submissionId,
      sessionId: session.sessionId,
      runId: session.runId,
      ownerUserId: session.ownerUserId || null,
      teamId: session.teamId,
      taskId: session.challenge.taskId,
      taskName: session.challenge.displayName || session.challenge.taskId,
      score,
      scoreMaximum: PUBLIC_SCORE_MAXIMUM,
      status: verification.status,
      verification,
      recordState: "submitted",
      savedAt,
      submittedAt: manifest.receivedAt,
      receivedAt: savedAt,
      challengeDigest: manifest.challengeDigest,
      recordSha256: manifest.record.sha256,
      recordByteLength: manifest.record.byteLength,
      authoritative: false
    };
    if (options.capabilityUsage) summary.capabilityUsage = { ...options.capabilityUsage };
    if (options.includeAutonomyMode === true) {
      const autonomyMode = session.challenge?.sessionMode === "ai" ? "ai" : "standard";
      const capabilityUsage = options.capabilityUsage;
      summary.autonomyMode = autonomyMode;
      summary.aiAutonomyVerified = autonomyMode === "ai"
        && verification.status === "verified"
        && capabilityUsage?.vision === true
        && capabilityUsage?.navigationSensors === true
        && capabilityUsage?.roadControls === true;
    }
    return summary;
  }

  async adminCapabilityUsageForStored(sessionId, manifest, report, recordBuffer = null) {
    const fromReport = capabilityUsageFromReport(report);
    if (fromReport.present) return fromReport.usage;
    const cacheKey = `${manifest.record.sha256}:${manifest.report.sha256}`;
    const cached = this.capabilityUsageCache.get(cacheKey);
    if (cached) return { ...cached };
    let buffer = recordBuffer;
    if (!Buffer.isBuffer(buffer)) {
      buffer = await readExactFile(
        path.join(this.submissionDirectory(sessionId, manifest.submissionId), "record.json"),
        manifest.record.byteLength,
        MAX_ARCHIVED_RECORD_BYTES,
        "SUBMISSION_NOT_FOUND"
      );
    }
    if (buffer.length !== manifest.record.byteLength || sha256(buffer) !== manifest.record.sha256) {
      throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "stored run record digest does not match");
    }
    const usage = adminCapabilityUsage(deriveRecordCapabilityUsage(parseArchivedRunRecord(buffer)));
    if (this.capabilityUsageCache.size >= MAX_CAPABILITY_USAGE_CACHE_ITEMS) {
      this.capabilityUsageCache.delete(this.capabilityUsageCache.keys().next().value);
    }
    this.capabilityUsageCache.set(cacheKey, usage);
    return { ...usage };
  }

  draftSummary(session, manifest) {
    return {
      id: manifest.recordId,
      submissionId: null,
      sessionId: session.sessionId,
      runId: session.runId,
      ownerUserId: session.ownerUserId || null,
      teamId: session.teamId,
      taskId: session.challenge.taskId,
      taskName: session.challenge.displayName || session.challenge.taskId,
      score: normalizedPublicScore(session, manifest.result.score),
      scoreMaximum: PUBLIC_SCORE_MAXIMUM,
      status: "pending",
      verification: {
        status: "pending",
        reasonCodes: [],
        visionStatus: "unknown",
        verificationScope: {
          deterministic: { status: "unknown" },
          vision: "unknown"
        }
      },
      recordState: "saved",
      savedAt: manifest.savedAt,
      submittedAt: null,
      receivedAt: manifest.savedAt,
      challengeDigest: manifest.challengeDigest,
      recordSha256: manifest.record.sha256,
      recordByteLength: manifest.record.byteLength,
      authoritative: false
    };
  }

  async sessionMatchesExpectedRecordScope(session, expectedScope) {
    if (expectedScope === null) return true;
    const storedScope = await this.readStoredSessionScopeUnlocked(session);
    // Archives created before scope sidecars existed were ordinary single-run
    // sessions.  A present but malformed sidecar throws instead of silently
    // falling back to that legacy rule.
    return (storedScope?.scope || "single") === expectedScope;
  }

  async listRecords({
    ownerUserId = null,
    includeAll = false,
    expectedScope = null,
    recordState = null,
    maximum = DEFAULT_MAX_RECORD_LIST_ITEMS,
    limit = null,
    includeCapabilityUsage = false,
    includeAutonomyMode = false
  } = {}) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > DEFAULT_MAX_RECORD_LIST_ITEMS) {
      throw new TypeError(`maximum must be an integer between 1 and ${DEFAULT_MAX_RECORD_LIST_ITEMS}`);
    }
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)) {
      throw new TypeError(`limit must be an integer between 1 and ${maximum}`);
    }
    if (typeof includeCapabilityUsage !== "boolean") {
      throw new TypeError("includeCapabilityUsage must be a boolean");
    }
    if (typeof includeAutonomyMode !== "boolean") {
      throw new TypeError("includeAutonomyMode must be a boolean");
    }
    const normalizedOwnerUserId = includeAll ? null : normalizeOwnerUserId(ownerUserId);
    const normalizedExpectedScope = normalizeExpectedRecordScope(expectedScope);
    const normalizedRecordState = normalizeRecordStateFilter(recordState);
    const records = [];
    const appendRecord = record => {
      if (limit === null && records.length >= maximum) {
        throw new SubmissionStoreError(413, "RECORD_LIST_LIMIT", "record list exceeds the configured response limit");
      }
      records.push(record);
      if (limit !== null && records.length > limit) {
        records.sort((left, right) => String(right.savedAt).localeCompare(String(left.savedAt)));
        records.length = limit;
      }
    };
    for (const sessionId of await this.listArchiveSessionIds()) {
      const session = await this.readSession(sessionId);
      if (!includeAll && session.ownerUserId !== normalizedOwnerUserId) continue;
      if (!(await this.sessionMatchesExpectedRecordScope(session, normalizedExpectedScope))) continue;
      const manifests = await this.listSubmissionManifests(sessionId);
      const draftManifests = await this.listDraftManifests(sessionId);
      const draftsById = new Map(draftManifests.map(manifest => [manifest.recordId, manifest]));
      if (normalizedRecordState !== "saved") {
        for (const manifest of manifests) {
          const stored = await this.readSubmissionMetadata(sessionId, manifest.submissionId, null, { skipAuthorization: true });
          const draft = draftsById.get(manifest.submissionId);
          const origin = await this.readDraftOrigin(
            sessionId,
            manifest.submissionId,
            stored.manifest.record.sha256
          );
          const capabilityUsage = includeCapabilityUsage
            ? await this.adminCapabilityUsageForStored(sessionId, stored.manifest, stored.report)
            : null;
          appendRecord(this.recordSummary(session, stored.manifest, stored.report, {
            savedAt: draft?.savedAt || origin?.savedAt,
            capabilityUsage,
            includeAutonomyMode
          }));
          draftsById.delete(manifest.submissionId);
        }
      } else {
        for (const manifest of manifests) draftsById.delete(manifest.submissionId);
      }
      if (normalizedRecordState !== "submitted") {
        for (const manifest of draftsById.values()) {
          const stored = await this.readDraftMetadata(sessionId, manifest.recordId, null, { skipAuthorization: true });
          appendRecord(this.draftSummary(session, stored.manifest));
        }
      }
    }
    records.sort((left, right) => String(right.savedAt).localeCompare(String(left.savedAt)));
    return limit === null ? records : records.slice(0, limit);
  }

  async findRecordMetadata(submissionId, options = {}) {
    return this.findRecord(submissionId, { ...options, metadataOnly: true });
  }

  async findRecord(submissionId, {
    ownerUserId = null,
    includeAll = false,
    expectedScope = null,
    metadataOnly = false,
    includeCapabilityUsage = false,
    includeAutonomyMode = false
  } = {}) {
    const normalizedSubmissionId = validateSubmissionId(submissionId);
    const normalizedOwnerUserId = includeAll ? null : normalizeOwnerUserId(ownerUserId);
    const normalizedExpectedScope = normalizeExpectedRecordScope(expectedScope);
    if (typeof includeCapabilityUsage !== "boolean") {
      throw new TypeError("includeCapabilityUsage must be a boolean");
    }
    if (typeof includeAutonomyMode !== "boolean") {
      throw new TypeError("includeAutonomyMode must be a boolean");
    }
    let found = null;
    for (const sessionId of await this.listArchiveSessionIds()) {
      const session = await this.readSession(sessionId);
      if (!includeAll && session.ownerUserId !== normalizedOwnerUserId) continue;
      if (!(await this.sessionMatchesExpectedRecordScope(session, normalizedExpectedScope))) continue;
      try {
        let submission = null;
        let draft = null;
        try {
          submission = metadataOnly
            ? await this.readSubmissionMetadata(sessionId, normalizedSubmissionId, null, { skipAuthorization: true })
            : await this.readSubmission(sessionId, normalizedSubmissionId, null, { skipAuthorization: true });
        } catch (error) {
          if (!(error instanceof SubmissionStoreError) || error.code !== "SUBMISSION_NOT_FOUND") throw error;
        }
        try {
          draft = metadataOnly
            ? await this.readDraftMetadata(sessionId, normalizedSubmissionId, null, { skipAuthorization: true })
            : await this.readDraft(sessionId, normalizedSubmissionId, null, { skipAuthorization: true });
        } catch (error) {
          if (!(error instanceof SubmissionStoreError) || error.code !== "SUBMISSION_NOT_FOUND") throw error;
        }
        if (!submission && !draft) throw new SubmissionStoreError(404, "SUBMISSION_NOT_FOUND", "submission not found");
        if (found) {
          throw new SubmissionStoreError(500, "ARCHIVE_CORRUPTED", "submission id appears in more than one session");
        }
        const origin = submission
          ? await this.readDraftOrigin(
              sessionId,
              normalizedSubmissionId,
              submission.manifest.record.sha256
            )
          : null;
        const summary = submission
          ? this.recordSummary(session, submission.manifest, submission.report, {
              savedAt: draft?.manifest?.savedAt || origin?.savedAt,
              capabilityUsage: includeCapabilityUsage
                ? await this.adminCapabilityUsageForStored(
                    sessionId,
                    submission.manifest,
                    submission.report,
                    submission.buffer
                  )
                : null,
              includeAutonomyMode
            })
          : this.draftSummary(session, draft.manifest);
        found = {
          session: this.publicSession(session, (await this.listSubmissionManifests(sessionId)).length),
          manifest: submission?.manifest || draft.manifest,
          report: submission?.report || null,
          draftManifest: draft?.manifest || null,
          buffer: draft?.buffer || submission?.buffer || null,
          summary
        };
      } catch (error) {
        if (!(error instanceof SubmissionStoreError) || error.code !== "SUBMISSION_NOT_FOUND") throw error;
      }
    }
    if (!found) throw new SubmissionStoreError(404, "RECORD_NOT_FOUND", "record not found");
    return found;
  }

  async cleanupSessionTemporaryDirectory(directory) {
    const resolved = path.resolve(directory);
    const expectedPrefix = `${path.resolve(this.sessionsDir)}${path.sep}`.toLowerCase();
    if (!resolved.toLowerCase().startsWith(expectedPrefix) || !path.basename(resolved).startsWith(".ses_")) return;
    const entries = await fs.promises.readdir(resolved, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(resolved, entry.name);
      if (entry.isFile() || entry.isSymbolicLink()) await fs.promises.unlink(entryPath).catch(() => {});
      else if (entry.isDirectory() && ["submissions", "drafts"].includes(entry.name)) {
        await fs.promises.rmdir(entryPath).catch(() => {});
      }
    }
    await fs.promises.rmdir(resolved).catch(() => {});
  }
}

module.exports = {
  SESSION_SCHEMA_VERSION,
  CHALLENGE_COMMITMENT_SCHEMA_VERSION,
  SUBMISSION_SCHEMA_VERSION,
  RECORD_DRAFT_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_TTL_MS,
  DEFAULT_MAX_SESSIONS,
  MAX_SESSIONS,
  DEFAULT_MAX_SUBMISSIONS_PER_SESSION,
  MAX_SUBMISSIONS_PER_SESSION,
  DEFAULT_MAX_STORAGE_BYTES,
  MAX_STORAGE_BYTES,
  STORAGE_WARNING_PERCENT,
  STORAGE_CRITICAL_PERCENT,
  MAX_ARCHIVED_SESSION_DIRECTORIES,
  MAX_SESSION_METADATA_BYTES,
  DEFAULT_MAX_RECORD_LIST_ITEMS,
  aggregateBestSubmittedRecords,
  SubmissionStoreError,
  SubmissionStore,
  normalizeParticipantId,
  normalizeOwnerUserId,
  validateBearerToken,
  publicChallengeMetadata,
  publicVerificationSummary
};
