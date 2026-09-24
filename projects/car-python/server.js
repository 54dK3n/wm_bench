#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { Worker } = require("node:worker_threads");
const { gunzipSync } = require("node:zlib");
const {
  SCHEMA_VERSION,
  DETERMINISTIC_LEGACY_SCHEMA_VERSION,
  LEGACY_SCHEMA_VERSION,
  GUANGYANG_ISLAND_CONFIG,
  GUANGYANG_CHALLENGE_CONFIGS,
  NAVIGATION_DEFINITION,
  NAVIGATION_CONTROL_DEFINITION,
  VISION_DEFINITION,
  createSession
} = require("./competition-core.js");
const {
  REPORT_SCHEMA_VERSION,
  MAX_RECORD_BYTES,
  parseRecord,
  serializeReport
} = require("./tools/verify-run-record.js");
const { version: PACKAGE_VERSION } = require("./package.json");
const {
  SESSION_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_TTL_MS,
  DEFAULT_MAX_SESSIONS,
  MAX_ARCHIVED_SESSION_DIRECTORIES,
  DEFAULT_MAX_RECORD_LIST_ITEMS,
  SubmissionStoreError,
  SubmissionStore,
  normalizeParticipantId
} = require("./backend/submission-store.js");
const {
  AUTH_RESPONSE_SCHEMA_VERSION,
  AUTH_COOKIE_NAME,
  DEFAULT_AUTH_SESSION_TTL_MS,
  AuthStoreError,
  AuthStore
} = require("./backend/auth-store.js");
const {
  OfficialSsoError,
  OfficialSsoReplayStore,
  requireSsoSecret,
  verifySsoRequest
} = require("./backend/official-sso.js");
const internalServiceAuth = require("./backend/platform-service-auth.js");
const { createRobotBridge, RobotBridgeError } = require("./backend/robot-bridge.js");
const {
  DEFAULT_BATCH_TTL_MS,
  MAX_BATCH_TTL_MS,
  MAX_RANKED_LOCKED_SOURCE_BYTES,
  MAX_DISCOVERED_OPEN_BATCHES,
  RANKED_EVALUATION_POLICY_SCHEMA_VERSION,
  RANKED_SCORE_MAXIMUM,
  DEFAULT_RANKING_LIST_LIMIT,
  MAX_RANKING_LIST_LIMIT,
  MAX_RANKING_LIST_OFFSET,
  BatchEvaluationStoreError,
  BatchEvaluationStore
} = require("./backend/batch-evaluation-store.js");
const {
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION,
  GUANGYANG_LAYOUT_SELECTION_POLICY_VERSION,
  GUANGYANG_RANKED_LAYOUT_FORM_VERSION,
  selectRankedGuangyangLayoutSequence
} = require("./backend/guangyang-private-layout-catalog.js");
const { RANKING_ORDER } = require("./backend/batch-evaluation-core.js");
const { canonicalSha256 } = require("./backend/canonical-json.js");
const {
  MAP_CONFIG_SCHEMA_VERSION,
  MAP_CONFIG_UPDATE_SCHEMA_VERSION,
  MAP_CONFIG_BINDING_SCHEMA_VERSION,
  MAX_MAP_CONFIG_BYTES,
  GuangyangMapConfigStoreError,
  GuangyangMapConfigStore
} = require("./backend/guangyang-map-config-store.js");
const {
  MAP_POOL_ADMIN_SCHEMA_VERSION,
  MAP_POOL_COUNTS,
  MAP_POOL_VARIANT_ID_PATTERN,
  variantId,
  variantNumber,
  buildInitialMapPoolLayouts,
  assignedVariantId
} = require("./backend/guangyang-map-pool.js");

const SERVICE_SCHEMA_VERSION = "chenlong.backend-health/v1";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 6178;
const DEFAULT_WORKER_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENT_VERIFICATIONS = 4;
const MAX_WORKER_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_VERIFICATIONS = 4;
const DEFAULT_MAX_QUEUED_VERIFICATIONS = 512;
const MAX_QUEUED_VERIFICATIONS = 2000;
const DEFAULT_VERIFICATION_QUEUE_TIMEOUT_MS = 90_000;
const MAX_VERIFICATION_QUEUE_TIMEOUT_MS = 5 * 60_000;
const LEGACY_RECORD_LIST_ITEMS = 1000;
const DEFAULT_RECORD_PAGE_SIZE = 250;
const MAX_RECORD_PAGE_SIZE = 1000;
// Every ranked receipt belongs to its own batch-scoped session. The shared
// submission archive admits at most this many retained session directories, so
// this covers the complete possible ranked evidence working set without LRU
// churn across refreshes (plus a small overlap allowance during invalidation).
const MAX_RANKED_EVIDENCE_AUDIT_CACHE_ENTRIES = MAX_ARCHIVED_SESSION_DIRECTORIES + 64;
const RANKED_PREPARATION_CACHE_TTL_MS = 3_000;
const MAX_RANKED_PREPARATION_CACHE_TTL_MS = 5_000;
const RANKED_RANKING_READ_WINDOW_MS = 1_000;
const RANKED_RANKING_READ_LIMIT = 30;
const ADMIN_RANKED_RANKING_READ_WINDOW_MS = 5_000;
const ADMIN_RANKED_RANKING_READ_LIMIT = 150;
const MAX_RANKED_RANKING_RATE_KEYS = 10_000;
const MAX_WORKER_OLD_GENERATION_MB = 384;
const VERIFY_WORKER_PATH = path.join(__dirname, "tools", "verify-run-record-worker.js");
const STATIC_ROOT = __dirname;
const VENDOR_ROOT_REAL = fs.realpathSync.native(path.join(STATIC_ROOT, "vendor"));
const MAP_ASSET_PATH = "word/广阳岛仿真沙盘地图.png";
const SESSION_BODY_LIMIT_BYTES = 8 * 1024;
const SINGLE_SESSION_MODES = new Set(["standard", "ai"]);
const BATCH_BODY_LIMIT_BYTES = 2 * 1024 * 1024 + 64 * 1024;
const AUTH_BODY_LIMIT_BYTES = 16 * 1024;
const MAP_CONFIG_BODY_LIMIT_BYTES = Math.min(MAX_MAP_CONFIG_BYTES, 16 * 1024);
const LOGIN_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_LOGIN_ATTEMPT_KEYS = 10_000;
const DEFAULT_REGISTRATION_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const MAX_REGISTRATION_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;
// This deliberately exceeds the default 2,000-account capacity so that a
// coordinated opening can register every participant without disabling abuse
// protection. Operators can lower it once the initial registration wave ends.
const DEFAULT_MAX_REGISTRATION_ATTEMPTS = 2_400;
const MAX_REGISTRATION_ATTEMPTS = 100_000;
const DEFAULT_OFFICIAL_SSO_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const MAX_OFFICIAL_SSO_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_OFFICIAL_SSO_ATTEMPTS = 4_000;
const DEFAULT_MAX_OFFICIAL_SSO_ATTEMPTS_PER_IP = 1_000;
const MAX_OFFICIAL_SSO_ATTEMPTS = 100_000;
const SESSION_ID_SOURCE = "(ses_[a-f0-9]{32})";
const SUBMISSION_ID_SOURCE = "(sub_[a-f0-9]{32})";
const BATCH_ID_SOURCE = "(bat_[a-f0-9]{32})";
const USER_ID_SOURCE = "(usr_[a-f0-9]{32})";
const SESSION_ROUTE = new RegExp(`^/api/v1/sessions/${SESSION_ID_SOURCE}$`);
const DRAFTS_ROUTE = new RegExp(`^/api/v1/sessions/${SESSION_ID_SOURCE}/drafts$`);
const SUBMISSIONS_ROUTE = new RegExp(`^/api/v1/sessions/${SESSION_ID_SOURCE}/submissions$`);
const SUBMISSION_ROUTE = new RegExp(`^/api/v1/sessions/${SESSION_ID_SOURCE}/submissions/${SUBMISSION_ID_SOURCE}$`);
const SUBMISSION_RECORD_ROUTE = new RegExp(`^/api/v1/sessions/${SESSION_ID_SOURCE}/submissions/${SUBMISSION_ID_SOURCE}/record$`);
const RECORD_ROUTE = new RegExp(`^/api/v1/records/${SUBMISSION_ID_SOURCE}$`);
const RECORD_RUN_DATA_ROUTE = new RegExp(`^/api/v1/records/${SUBMISSION_ID_SOURCE}/run-record$`);
const RECORD_SUBMIT_ROUTE = new RegExp(`^/api/v1/records/${SUBMISSION_ID_SOURCE}/submit$`);
const ADMIN_RECORD_ROUTE = new RegExp(`^/api/v1/admin/records/${SUBMISSION_ID_SOURCE}$`);
const ADMIN_USER_ROUTE = new RegExp(`^/api/v1/admin/users/${USER_ID_SOURCE}$`);
const MAP_CONFIG_TASK_ROUTE = /^\/api\/v1\/map-config\/(R2-GYI-MVP-0[1-3])$/;
const ADMIN_MAP_CONFIG_TASK_ROUTE = /^\/api\/v1\/admin\/map-config\/(R2-GYI-MVP-0[1-3])$/;
const ADMIN_MAP_CONFIG_VARIANT_ROUTE = /^\/api\/v1\/admin\/map-config\/(R2-GYI-MVP-0[1-3])\/(map-(?:0[1-9]|1[0-9]|20))$/;
const ADMIN_MAP_POOLS_PATH = "/api/v1/admin/map-pools";
const BATCH_ROUTE = new RegExp(`^/api/v1/evaluation-batches/${BATCH_ID_SOURCE}$`);
const BATCH_CURRENT_SLOT_LEASE_ROUTE = new RegExp(
  `^/api/v1/evaluation-batches/${BATCH_ID_SOURCE}/current-slot/lease$`
);
const BATCH_SLOT_SUBMISSIONS_ROUTE = new RegExp(
  `^/api/v1/evaluation-batches/${BATCH_ID_SOURCE}/slots/([1-5])/sessions/${SESSION_ID_SOURCE}/submissions$`
);
const BATCH_CLOSE_ROUTE = new RegExp(`^/api/v1/evaluation-batches/${BATCH_ID_SOURCE}/close$`);
const RANKED_COMPETITION_ID = "2026-r2-gyi-local-screening.1";
const RANKED_COMPETITION_DISPLAY_NAME = "筛选五局（本地参考）";
const RANKED_EVALUATION_BASE_PATH = `/api/v1/competitions/${RANKED_COMPETITION_ID}/ranked-evaluation`;
const RANKED_EVALUATION_BASE_ROUTE_SOURCE = RANKED_EVALUATION_BASE_PATH
  .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RANKED_EVALUATION_ROUTE = new RegExp(`^${RANKED_EVALUATION_BASE_ROUTE_SOURCE}/${BATCH_ID_SOURCE}$`);
const RANKED_CURRENT_SLOT_LEASE_ROUTE = new RegExp(
  `^${RANKED_EVALUATION_BASE_ROUTE_SOURCE}/${BATCH_ID_SOURCE}/current-slot/lease$`
);
const RANKED_SLOT_SUBMISSIONS_ROUTE = new RegExp(
  `^${RANKED_EVALUATION_BASE_ROUTE_SOURCE}/${BATCH_ID_SOURCE}/slots/([1-5])/sessions/${SESSION_ID_SOURCE}/submissions$`
);
const RANKED_CLOSE_ROUTE = new RegExp(`^${RANKED_EVALUATION_BASE_ROUTE_SOURCE}/${BATCH_ID_SOURCE}/close$`);
const ADMIN_RANKED_RANKING_PATH = `/api/v1/admin/competitions/${RANKED_COMPETITION_ID}/ranked-evaluation/ranking`;
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function createGuangyangRunDefinition(config = GUANGYANG_ISLAND_CONFIG) {
  const objectTaskOverlay = config.objectTaskOverlay || { packageRadius: 0.28, objects: [] };
  const bounds = {
    minX: -Number(config.world.width) / 2,
    maxX: Number(config.world.width) / 2,
    minZ: -Number(config.world.depth) / 2,
    maxZ: Number(config.world.depth) / 2
  };
  const simulationDefinition = {
    schemaVersion: "chenlong.simulation/v1",
    stepMs: 20,
    seed: 0,
    initialPose: { x: config.start[0], z: config.start[1], heading: config.start[2] },
    vehicle: {
      version: "chenlong.vehicle/v1",
      radius: 0.44,
      collisionSkin: 0.005,
      maxLinearSpeed: 2.5,
      maxAngularSpeed: 2.8
    },
    world: { bounds, colliders: [] }
  };
  const interactionDefinition = {
    schemaVersion: "chenlong.package-interaction/v2",
    packageRadius: Number(objectTaskOverlay.packageRadius) || 0.28,
    stackKeyDigits: 3,
    bounds,
    grab: { minForward: 0.38, maxForward: 1.35, maxLateral: 0.38 },
    release: { forwardOffset: 1.1, lateralOffset: 0, stackSnapDistance: 0.62 },
    packages: (objectTaskOverlay.objects || []).map(object => ({
      id: object.id,
      x: object.position[0],
      z: object.position[1],
      stackLevel: 0,
      role: object.role,
      radius: Number(object.radius) || Number(objectTaskOverlay.packageRadius) || 0.28
    }))
  };
  const templateSession = createSession(config, {
    runId: "run_template",
    teamId: "template-team",
    runDefinition: {
      visionDefinition: VISION_DEFINITION,
      navigationDefinition: NAVIGATION_DEFINITION,
      navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
    },
    simulationDefinition,
    interactionDefinition
  }, { now: () => 0 });
  return templateSession.recorder.export().runDefinition;
}

const GUANGYANG_RUN_DEFINITIONS = Object.freeze(Object.fromEntries(
  GUANGYANG_CHALLENGE_CONFIGS.map(config => [
    config.taskId,
    deepFreeze(createGuangyangRunDefinition(config))
  ])
));
// Retain the original export for the private five-run routes and their
// historical evidence.  Those routes intentionally remain challenge 1 only.
const GUANGYANG_RUN_DEFINITION = GUANGYANG_RUN_DEFINITIONS[GUANGYANG_ISLAND_CONFIG.taskId];
const LOCAL_CHALLENGES = Object.freeze(Object.fromEntries(
  GUANGYANG_CHALLENGE_CONFIGS.map(config => [
    config.taskId,
    Object.freeze({
      taskId: config.taskId,
      taskVersion: config.taskVersion,
      mapId: config.mapId,
      mapVersion: config.mapVersion,
      ruleVersion: config.ruleVersion,
      displayName: config.displayName,
      timeLimitSeconds: config.timeLimitSeconds,
      runDefinition: GUANGYANG_RUN_DEFINITIONS[config.taskId]
    })
  ])
));

const BATCH_API_RESPONSE_SCHEMA_VERSION = "chenlong.batch-api-response/v1";
const BATCH_SLOT_LEASE_SCHEMA_VERSION = "chenlong.batch-slot-lease/v1";
const BATCH_OPEN_LIST_SCHEMA_VERSION = "chenlong.open-batch-list/v1";
const BATCH_OPEN_LIST_ORDER = "createdAt-desc,batchId-asc";
const RANKED_EVALUATION_API_SCHEMA_VERSION = "chenlong.ranked-evaluation-api/v1";
const RANKED_SLOT_LEASE_SCHEMA_VERSION = "chenlong.ranked-slot-lease/v1";
const RANKED_RANKING_SCHEMA_VERSION = "chenlong.ranked-ranking/v1";
const RANKED_RANKING_STABLE_TIE_BREAK = "server-private-stable-key";
const DATA_DIRECTORY_WRITER_LOCK_SCHEMA_VERSION = "chenlong.data-directory-writer-lock/v1";
const DATA_DIRECTORY_WRITER_LOCK_FILENAME = ".chenlong-writer.lock";
const MAX_WRITER_LOCK_BYTES = 4096;

class DataDirectoryWriterLockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DataDirectoryWriterLockError";
    this.code = code;
  }
}

function writerProcessIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return null;
  }
}

function readWriterLock(lockPath) {
  let stat;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_WRITER_LOCK_BYTES) {
    throw new DataDirectoryWriterLockError(
      "DATA_DIRECTORY_WRITER_LOCK_INVALID",
      "data directory writer lock is not a safe regular file"
    );
  }
  const source = fs.readFileSync(lockPath, "utf8");
  let value;
  try {
    value = JSON.parse(source);
  } catch (_error) {
    throw new DataDirectoryWriterLockError(
      "DATA_DIRECTORY_WRITER_LOCK_INVALID",
      "data directory writer lock is not valid JSON"
    );
  }
  const createdAtMs = Date.parse(value?.createdAt);
  const valid = value?.schemaVersion === DATA_DIRECTORY_WRITER_LOCK_SCHEMA_VERSION
    && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.token === "string" && /^[a-f0-9]{64}$/.test(value.token)
    && typeof value.createdAt === "string" && Number.isFinite(createdAtMs)
    && new Date(createdAtMs).toISOString() === value.createdAt;
  if (!valid) {
    throw new DataDirectoryWriterLockError(
      "DATA_DIRECTORY_WRITER_LOCK_INVALID",
      "data directory writer lock metadata is invalid"
    );
  }
  return { stat, source, value };
}

function unlinkMatchingWriterLock(lockPath, expected) {
  let current;
  try {
    current = readWriterLock(lockPath);
  } catch (_error) {
    return false;
  }
  if (!current
    || current.value.pid !== expected.pid
    || current.value.token !== expected.token
    || (expected.source !== undefined && current.source !== expected.source)
    || (Number.isSafeInteger(expected.stat?.ino) && Number.isSafeInteger(current.stat.ino)
      && expected.stat.ino !== current.stat.ino)
    || (Number.isSafeInteger(expected.stat?.dev) && Number.isSafeInteger(current.stat.dev)
      && expected.stat.dev !== current.stat.dev)) {
    return false;
  }
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function acquireDataDirectoryWriterLock(dataRoot) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const rootStat = fs.lstatSync(dataRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new DataDirectoryWriterLockError(
      "DATA_DIRECTORY_WRITER_LOCK_INVALID",
      "data directory must be a safe regular directory"
    );
  }
  const lockPath = path.join(dataRoot, DATA_DIRECTORY_WRITER_LOCK_FILENAME);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = crypto.randomBytes(32).toString("hex");
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      const payload = `${JSON.stringify({
        schemaVersion: DATA_DIRECTORY_WRITER_LOCK_SCHEMA_VERSION,
        pid: process.pid,
        token,
        createdAt: new Date().toISOString()
      })}\n`;
      fs.writeFileSync(descriptor, payload, "utf8");
      fs.fsyncSync(descriptor);
      let released = false;
      return {
        lockPath,
        token,
        release() {
          if (released) return;
          released = true;
          try {
            fs.closeSync(descriptor);
          } catch (_error) {
            // Continue to ownership verification; the descriptor may already be closed.
          }
          unlinkMatchingWriterLock(lockPath, { pid: process.pid, token });
        }
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (_closeError) { /* no-op */ }
        try { unlinkMatchingWriterLock(lockPath, { pid: process.pid, token }); } catch (_unlinkError) { /* no-op */ }
      }
      if (error?.code !== "EEXIST") throw error;
      const existing = readWriterLock(lockPath);
      if (!existing) continue;
      const alive = writerProcessIsAlive(existing.value.pid);
      if (alive !== false) {
        throw new DataDirectoryWriterLockError(
          "DATA_DIRECTORY_WRITER_ACTIVE",
          `data directory already has an active writer process (${existing.value.pid})`
        );
      }
      throw new DataDirectoryWriterLockError(
        "DATA_DIRECTORY_WRITER_STALE",
        `data directory has a stale writer lock for process ${existing.value.pid}; `
          + "verify that process is stopped, then remove the lock explicitly"
      );
    }
  }
  throw new DataDirectoryWriterLockError(
    "DATA_DIRECTORY_WRITER_LOCK_CONTENDED",
    "could not acquire the data directory writer lock"
  );
}

function batchApiResponse(stored, additional = {}) {
  return {
    schemaVersion: BATCH_API_RESPONSE_SCHEMA_VERSION,
    authoritative: false,
    batch: stored.batch,
    currentSlot: stored.currentSlot,
    ...additional
  };
}

const RANKED_COMPETITION_PUBLIC_METADATA = deepFreeze({
  competitionId: RANKED_COMPETITION_ID,
  displayName: RANKED_COMPETITION_DISPLAY_NAME,
  purpose: "ranked",
  scoreMaximum: RANKED_SCORE_MAXIMUM
});
const RANKED_EVALUATION_POLICY = deepFreeze({
  schemaVersion: RANKED_EVALUATION_POLICY_SCHEMA_VERSION,
  purpose: "ranked",
  competitionId: RANKED_COMPETITION_ID,
  catalogVersion: GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION,
  selectionPolicyVersion: GUANGYANG_LAYOUT_SELECTION_POLICY_VERSION,
  rankedFormVersion: GUANGYANG_RANKED_LAYOUT_FORM_VERSION,
  scoreMaximum: RANKED_SCORE_MAXIMUM,
  slotCount: 5
});

function rankedEvaluationApiResponse(evaluation, additional = {}) {
  return {
    schemaVersion: RANKED_EVALUATION_API_SCHEMA_VERSION,
    authoritative: false,
    competition: RANKED_COMPETITION_PUBLIC_METADATA,
    evaluation,
    ...additional
  };
}

function rankedOwnerEvaluation(ownerView, result = null) {
  if (ownerView === null) return null;
  return {
    purpose: ownerView.purpose,
    competitionId: ownerView.competitionId,
    lockedTeamId: ownerView.lockedTeamId,
    evaluationPolicy: ownerView.evaluationPolicy,
    createdAt: ownerView.createdAt,
    expiresAt: ownerView.expiresAt,
    batch: ownerView.batch,
    currentSlot: ownerView.currentSlot,
    anonymousParticipantId: ownerView.anonymousParticipantId,
    lockedSource: ownerView.lockedSource,
    result
  };
}

function anonymousRankedResult(entry) {
  return {
    rank: entry.rank,
    anonymousParticipantId: entry.anonymousParticipantId,
    score: entry.score,
    quality: entry.quality,
    ranking: entry.ranking
  };
}

function adminRankedResult(entry, user) {
  if (!user) throw new HttpError(500, "RANKED_OWNER_UNKNOWN", "ranked result owner does not exist");
  return {
    ...anonymousRankedResult(entry),
    participant: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      teamName: user.teamName
    },
    teamId: entry.lockedTeamId,
    createdAt: entry.createdAt,
    finalizationReason: entry.finalizationReason
  };
}

function parseRankedRankingPagination(url) {
  for (const field of url.searchParams.keys()) {
    if (field !== "offset" && field !== "limit") {
      throw new HttpError(400, "RANKING_INVALID_QUERY", "ranking query only accepts offset and limit");
    }
  }
  const parseField = (field, fallback, minimum, maximum) => {
    const values = url.searchParams.getAll(field);
    if (values.length === 0) return fallback;
    if (values.length !== 1 || !/^(?:0|[1-9]\d*)$/.test(values[0])) {
      throw new HttpError(400, "RANKING_INVALID_QUERY", `${field} must be one decimal integer`);
    }
    const value = Number(values[0]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new HttpError(
        400,
        "RANKING_INVALID_QUERY",
        `${field} must be between ${minimum} and ${maximum}`
      );
    }
    return value;
  };
  return {
    offset: parseField("offset", 0, 0, MAX_RANKING_LIST_OFFSET),
    limit: parseField("limit", DEFAULT_RANKING_LIST_LIMIT, 1, MAX_RANKING_LIST_LIMIT)
  };
}

function rankedRankingResponse(scope, pagination, page, entries) {
  return {
    schemaVersion: RANKED_RANKING_SCHEMA_VERSION,
    authoritative: false,
    competition: RANKED_COMPETITION_PUBLIC_METADATA,
    scope,
    order: RANKING_ORDER,
    tiePolicy: "competition-ranking-on-public-order-fields",
    stableTieBreak: RANKED_RANKING_STABLE_TIE_BREAK,
    pagination: {
      offset: pagination.offset,
      limit: pagination.limit,
      returned: entries.length,
      total: page.total
    },
    entries
  };
}

function batchChallengeForPrivateLayout(privateLayoutSelection) {
  if (!privateLayoutSelection || typeof privateLayoutSelection !== "object"
    || !privateLayoutSelection.interactionDefinition
    || typeof privateLayoutSelection.layoutCommitment !== "string") {
    throw new HttpError(500, "BATCH_LAYOUT_INVALID", "current batch layout is invalid");
  }
  const runDefinition = deepFreeze({
    ...GUANGYANG_RUN_DEFINITION,
    interactionDefinition: privateLayoutSelection.interactionDefinition
  });
  return {
    challenge: deepFreeze({
      ...LOCAL_CHALLENGES[GUANGYANG_ISLAND_CONFIG.taskId],
      runDefinition
    }),
    runDefinition
  };
}

// The browser still receives the frozen scene so it can render and replay it,
// but an AI-autonomy session deliberately withholds the route anchors for the
// three movable objects from the student's Python navigation API.  The task
// goal, road graph and storage/checkpoint anchors remain available; locating
// target/distractor/obstacle must come from robot.observe().
function publishedChallengeForSingleSession(publishedMap, mode) {
  const sessionMode = mode === "ai" ? "ai" : "standard";
  const runDefinition = sessionMode === "ai"
    ? deepFreeze({
        ...publishedMap.runDefinition,
        navigationDefinition: NAVIGATION_DEFINITION
      })
    : publishedMap.runDefinition;
  return {
    // This server-selected field is persisted with the session. It lets the
    // administrator distinguish an AI-autonomy attempt from a teaching-mode
    // attempt after the record is submitted; the browser never gets to choose
    // or rewrite it.
    challenge: deepFreeze({ ...publishedMap.challenge, sessionMode, runDefinition }),
    runDefinition
  };
}

function verifiedBatchResult(report, metadata) {
  if (report?.status === "invalid") {
    return {
      status: "invalid",
      score: 0,
      completed: false,
      collisionCount: 0,
      outOfBoundsCount: 0
    };
  }
  if (report?.status !== "verified"
    || report?.replay?.verified !== true
    || report?.capabilities?.deterministicRecomputationComplete !== true
    || report?.resultComparison?.matched !== true) {
    throw new HttpError(422, "BATCH_RECORD_NOT_VERIFIED", "batch slot requires a fully verified run record");
  }
  const score = report?.recomputedResult?.score;
  const collisionCount = metadata?.verifiedCollisionCount;
  const outOfBoundsCount = metadata?.verifiedOutOfBoundsCount;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100
    || !Number.isSafeInteger(collisionCount) || collisionCount < 0
    || !Number.isSafeInteger(outOfBoundsCount) || outOfBoundsCount < 0) {
    throw new HttpError(422, "BATCH_RESULT_INVALID", "verified batch result summary is invalid");
  }
  if (report.recomputedResult.reason === "timeout") {
    return {
      status: "timeout",
      score: 0,
      completed: false,
      collisionCount,
      outOfBoundsCount
    };
  }
  return {
    status: "valid",
    score,
    completed: report.recomputedResult.taskFinished === true
      && report.recomputedResult.reason === "completed",
    collisionCount,
    outOfBoundsCount
  };
}

function verifiedRankedBatchResult(report, metadata) {
  const result = verifiedBatchResult(report, metadata);
  if (result.status === "valid" && result.score > RANKED_SCORE_MAXIMUM) {
    throw new HttpError(
      422,
      "RANKED_SCORE_OUT_OF_RANGE",
      `ranked result score must not exceed ${RANKED_SCORE_MAXIMUM}`
    );
  }
  return result;
}

function archivedRecordMetadata(buffer, report) {
  const record = parseRecord(buffer);
  const metadata = {};
  [
    "schemaVersion", "runId", "serverSessionId", "challengeDigest", "teamId",
    "taskId", "mapId", "mapVersion", "ruleVersion"
  ].forEach(field => { metadata[field] = record[field]; });
  metadata.runDefinitionDigest = canonicalSha256(record.runDefinition);
  metadata.sourceCodeDigest = canonicalSha256(record.sourceCode);
  const verifiedEvents = report?.status === "verified" && Array.isArray(record.events)
    ? record.events
    : [];
  metadata.verifiedCollisionCount = verifiedEvents.filter(event => (
    event?.type === "violation" && event?.violationType === "collision"
  )).length;
  metadata.verifiedOutOfBoundsCount = verifiedEvents.filter(event => (
    event?.type === "violation" && event?.violationType === "off_road"
  )).length;
  return metadata;
}

const TOP_LEVEL_STATIC_FILES = new Set([
  "index.html",
  "styles.css",
  "app.js",
  "competition-core.js",
  "vision-pixel-core.js",
  "robot-bridge-contract.js",
  "python-worker.js",
  "vision.js",
  "login.html",
  "auth.js",
  "auth-guard.js",
  "account.css",
  "records.html",
  "records.js",
  "admin.html",
  "admin-team-scores.js",
  "admin.js"
]);

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".zip": "application/zip"
});

class HttpError extends Error {
  constructor(statusCode, code, message, headers = {}) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
  }
}

function positiveInteger(value, fallback, { allowZero = false } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(number) || number < minimum) return fallback;
  return number;
}

function boundedServerOption(name, value, fallback, maximum) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function environmentInteger(name) {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${name} must be a safe integer`);
  return number;
}

function environmentBoolean(name) {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be true or false`);
}

function applySecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; "
      + "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
      + "img-src 'self' data: blob: http: https:; media-src 'self' blob: http: https:; "
      + "connect-src 'self' blob: http: https:; worker-src 'self' blob:"
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
}

function writeJson(response, statusCode, payload, additionalHeaders = {}) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...additionalHeaders
  });
  response.end(body);
}

function apiError(code, message) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: "error",
    authoritative: false,
    error: { code, message }
  };
}

function assertAllowedFields(value, allowedFields, codePrefix) {
  const unknownField = Object.keys(value).find(field => !allowedFields.has(field));
  if (unknownField) {
    throw new HttpError(400, `${codePrefix}_UNKNOWN_FIELD`, `unsupported ${codePrefix.toLowerCase()} field: ${unknownField}`);
  }
}

function authResponse(principal, { bootstrapAdmin = false, teamInviteCode = null } = {}) {
  const response = {
    schemaVersion: AUTH_RESPONSE_SCHEMA_VERSION,
    authenticated: true,
    user: principal.user,
    session: principal.session,
    bootstrapAdmin: Boolean(bootstrapAdmin),
    authoritative: false
  };
  if (typeof teamInviteCode === "string") response.teamInviteCode = teamInviteCode;
  return response;
}

function parseAuthCookie(request) {
  const header = request.headers.cookie;
  if (header === undefined) return null;
  if (typeof header !== "string" || header.length > 4096) {
    throw new HttpError(400, "INVALID_COOKIE", "Cookie header is invalid");
  }
  let token = null;
  for (const component of header.split(";")) {
    const separator = component.indexOf("=");
    if (separator < 1) continue;
    const name = component.slice(0, separator).trim();
    if (name !== AUTH_COOKIE_NAME) continue;
    if (token !== null) throw new HttpError(400, "DUPLICATE_AUTH_COOKIE", "authentication cookie is duplicated");
    token = component.slice(separator + 1).trim();
  }
  return token;
}

function authCookie(token, maxAgeSeconds, { secure = false, clear = false, sameSite = "Strict" } = {}) {
  if (sameSite !== "Strict" && sameSite !== "Lax") throw new TypeError("unsupported SameSite policy");
  const attributes = [
    `${AUTH_COOKIE_NAME}=${clear ? "" : token}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${clear ? 0 : Math.max(1, Math.floor(maxAgeSeconds))}`
  ];
  if (clear) attributes.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function officialSsoClientIp(request) {
  const remote = String(request.socket?.remoteAddress || "unknown").slice(0, 128);
  const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
  if (!loopback.has(remote)) return remote;
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded !== "string") return remote;
  return forwarded.split(",", 1)[0].trim().slice(0, 128) || remote;
}

function writeOfficialSsoErrorPage(response, error) {
  const normalized = error instanceof OfficialSsoError ? error : new OfficialSsoError(1004);
  const body = Buffer.from([
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<title>无法进入比赛平台</title></head><body>",
    "<main><h1>无法进入比赛平台</h1>",
    `<p>${normalized.message}</p><p>错误码：${normalized.code}</p>`,
    "<p><a href=\"/login.html\">返回登录页</a></p></main></body></html>"
  ].join(""), "utf8");
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
  if (Number.isSafeInteger(normalized.retryAfter) && normalized.retryAfter > 0) {
    headers["Retry-After"] = String(normalized.retryAfter);
  }
  response.writeHead(normalized.statusCode, headers);
  response.end(body);
}

function loopbackOriginForRequest(request) {
  const originHeader = request.headers.origin;
  const host = request.headers.host;
  if (typeof originHeader !== "string" || !host) return null;
  try {
    const origin = new URL(originHeader);
    const requestOrigin = new URL(`http://${host}`);
    const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
    if (origin.protocol !== "http:" || !loopbackHosts.has(origin.hostname)) return null;
    return origin.origin === requestOrigin.origin ? origin.origin : null;
  } catch (_error) {
    return null;
  }
}

function assertSameOrigin(request, configuredOrigin = null, allowLoopbackOrigin = false) {
  const originHeader = request.headers.origin;
  if (originHeader === undefined) return;
  if (typeof originHeader !== "string" || originHeader === "null") {
    throw new HttpError(403, "CROSS_ORIGIN_REQUEST", "cross-origin request is not allowed");
  }
  const host = request.headers.host;
  let supplied;
  let expected;
  try {
    supplied = new URL(originHeader).origin;
    expected = configuredOrigin || new URL(`http://${host}`).origin;
  } catch (_error) {
    throw new HttpError(403, "CROSS_ORIGIN_REQUEST", "cross-origin request is not allowed");
  }
  if (supplied !== expected && (!allowLoopbackOrigin || loopbackOriginForRequest(request) !== supplied)) {
    throw new HttpError(403, "CROSS_ORIGIN_REQUEST", "cross-origin request is not allowed");
  }
}

function recordsResponse(records, pagination = null) {
  const payload = {
    schemaVersion: "chenlong.records/v1",
    records,
    authoritative: false
  };
  if (pagination !== null) payload.pagination = pagination;
  return payload;
}

function teamTaskBestRecords(records) {
  const selected = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.recordState !== "submitted" || typeof record.ownerUserId !== "string"
      || typeof record.taskId !== "string" || typeof record.score !== "number"
      || !Number.isFinite(record.score) || record.score < 0 || record.score > 100) continue;
    const teamIdentity = typeof record.teamId === "string" && record.teamId
      ? `team:${record.teamId}`
      : `user:${record.ownerUserId}`;
    const key = `${teamIdentity}\n${record.taskId}`;
    const current = selected.get(key) || null;
    const submittedAt = Date.parse(record.submittedAt);
    const currentSubmittedAt = current ? Date.parse(current.submittedAt) : Number.NEGATIVE_INFINITY;
    if (current === null || record.score > current.score
      || (record.score === current.score && (submittedAt > currentSubmittedAt
        || (submittedAt === currentSubmittedAt && String(record.id).localeCompare(String(current.id)) < 0)))) {
      selected.set(key, {
        id: record.id,
        ownerUserId: record.ownerUserId,
        teamId: typeof record.teamId === "string" && record.teamId ? record.teamId : null,
        taskId: record.taskId,
        score: record.score,
        recordState: "submitted",
        submittedAt: record.submittedAt
      });
    }
  }
  return [...selected.values()].sort((left, right) => (
    String(right.submittedAt).localeCompare(String(left.submittedAt))
    || String(left.id).localeCompare(String(right.id))
  ));
}

function adminUsersResponse(users) {
  return {
    schemaVersion: "chenlong.admin-users/v1",
    users,
    authoritative: false
  };
}

function adminUserUpdateResponse(result) {
  return {
    schemaVersion: "chenlong.admin-user-update/v1",
    user: result.user,
    changed: result.changed,
    authoritative: false
  };
}

function participantVerificationReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return report;
  const { actualCapabilityUsage: _privateCapabilityUsage, ...participantReport } = report;
  return participantReport;
}

function parsePersonalRecordLimit(url) {
  for (const key of url.searchParams.keys()) {
    if (key !== "limit" || url.searchParams.getAll(key).length !== 1) {
      throw new HttpError(400, "RECORDS_INVALID_LIMIT", "records query is invalid");
    }
  }
  const values = url.searchParams.getAll("limit");
  if (values.length === 0) return null;
  if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) {
    throw new HttpError(400, "RECORDS_INVALID_LIMIT", "records limit must be one positive integer");
  }
  const limit = Number(values[0]);
  if (!Number.isSafeInteger(limit) || limit > LEGACY_RECORD_LIST_ITEMS) {
    throw new HttpError(
      400,
      "RECORDS_INVALID_LIMIT",
      `records limit must be between 1 and ${LEGACY_RECORD_LIST_ITEMS}`
    );
  }
  return limit;
}

function createVerificationQueue({ maximumConcurrentVerifications, maximumQueuedVerifications, queueTimeoutMs }) {
  let active = 0;
  let closed = false;
  const waiting = [];
  const drain = () => {
    while (!closed && active < maximumConcurrentVerifications && waiting.length) {
      const entry = waiting.shift();
      clearTimeout(entry.timer);
      active += 1;
      Promise.resolve().then(entry.operation).then(entry.resolve, entry.reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  };
  const run = operation => new Promise((resolve, reject) => {
    if (closed) return reject(new HttpError(503, "VERIFIER_CLOSED", "verification service is closing"));
    if (waiting.length >= maximumQueuedVerifications && active >= maximumConcurrentVerifications) {
      reject(new HttpError(503, "VERIFIER_QUEUE_FULL", "verification queue is currently full"));
      return;
    }
    const entry = { operation, resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      const index = waiting.indexOf(entry);
      if (index >= 0) waiting.splice(index, 1);
      reject(new HttpError(503, "VERIFIER_QUEUE_TIMEOUT", "verification queue wait timed out"));
    }, queueTimeoutMs);
    entry.timer.unref?.();
    waiting.push(entry);
    drain();
  });
  run.status = () => ({ active, queued: waiting.length });
  run.close = () => {
    closed = true;
    for (const entry of waiting.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(new HttpError(503, "VERIFIER_CLOSED", "verification service is closing"));
    }
  };
  return run;
}

function parseRecordPage(url) {
  const allowed = new Set(["page", "pageSize"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new HttpError(400, "RECORDS_INVALID_PAGE", "record pagination query is invalid");
    }
  }
  if (![...url.searchParams.keys()].length) return null;
  const pageSource = url.searchParams.get("page") || "1";
  const pageSizeSource = url.searchParams.get("pageSize") || String(DEFAULT_RECORD_PAGE_SIZE);
  if (!/^[1-9]\d*$/.test(pageSource) || !/^[1-9]\d*$/.test(pageSizeSource)) {
    throw new HttpError(400, "RECORDS_INVALID_PAGE", "record page and pageSize must be positive integers");
  }
  const page = Number(pageSource);
  const pageSize = Number(pageSizeSource);
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(pageSize) || pageSize > MAX_RECORD_PAGE_SIZE) {
    throw new HttpError(
      400,
      "RECORDS_INVALID_PAGE",
      `record pageSize must be between 1 and ${MAX_RECORD_PAGE_SIZE}`
    );
  }
  return { page, pageSize };
}

function paginateRecords(records, requestedPage, pageSize) {
  const total = records.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * pageSize;
  return {
    records: records.slice(offset, offset + pageSize),
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasNext: page < totalPages
    }
  };
}

function sourceCodeForRecordDetail(stored) {
  let record;
  try {
    record = parseRecord(stored?.buffer);
  } catch (_error) {
    throw new HttpError(500, "ARCHIVE_CORRUPTED", "stored run record cannot provide its Python source");
  }
  if (typeof record.sourceCode !== "string" || record.sourceCode.length > 128 * 1024) {
    throw new HttpError(500, "ARCHIVE_CORRUPTED", "stored Python source is invalid");
  }
  return record.sourceCode;
}

function recordDetailResponse(stored, user, { admin = false } = {}) {
  const response = {
    schemaVersion: "chenlong.record-detail/v1",
    record: { ...stored.summary, user: user || null },
    session: stored.session,
    manifest: stored.manifest,
    verification: admin ? stored.report : participantVerificationReport(stored.report),
    authoritative: false
  };
  // Source stays out of lists and CSV exports, but both the record owner and an
  // authenticated administrator need the exact archived program in the
  // per-record detail view for review and troubleshooting.
  response.sourceCode = sourceCodeForRecordDetail(stored);
  return response;
}

function isJsonContentType(value) {
  if (typeof value !== "string") return false;
  return value.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function requireJsonRequest(request, { allowGzip = false } = {}) {
  if (!isJsonContentType(request.headers["content-type"])) {
    request.resume();
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const contentEncoding = String(request.headers["content-encoding"] || "identity").trim().toLowerCase();
  if (contentEncoding !== "identity" && !(allowGzip && contentEncoding === "gzip")) {
    request.resume();
    throw new HttpError(
      415,
      "UNSUPPORTED_CONTENT_ENCODING",
      allowGzip ? "Content-Encoding must be identity or gzip" : "Content-Encoding must be identity"
    );
  }
  return contentEncoding;
}

function decodeRequestBody(buffer, contentEncoding, maximumBytes) {
  if (contentEncoding !== "gzip") return buffer;
  try {
    return gunzipSync(buffer, { maxOutputLength: maximumBytes });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new HttpError(413, "INPUT_TOO_LARGE", `run record exceeds the ${maximumBytes} byte input limit`);
    }
    throw new HttpError(400, "INVALID_GZIP", "gzip request body is invalid");
  }
}

function parseJsonObject(buffer, codePrefix = "REQUEST") {
  if (!buffer.length) throw new HttpError(400, `${codePrefix}_EMPTY`, "JSON request body is empty");
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (_error) {
    throw new HttpError(400, `${codePrefix}_INVALID_UTF8`, "JSON request body must be valid UTF-8");
  }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  let value;
  try {
    value = JSON.parse(source);
  } catch (_error) {
    throw new HttpError(400, `${codePrefix}_INVALID_JSON`, "request body is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${codePrefix}_INVALID_ROOT`, "JSON request root must be an object");
  }
  return value;
}

function bearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : null;
}

function submissionReceipt(manifest, report, duplicate) {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    submissionId: manifest.submissionId,
    sessionId: manifest.sessionId,
    challengeDigest: manifest.challengeDigest,
    receivedAt: manifest.receivedAt,
    duplicate: Boolean(duplicate),
    authoritative: false,
    record: manifest.record,
    report: manifest.report,
    verification: participantVerificationReport(report)
  };
}

function draftRecordMetadata(record) {
  const output = {};
  const limits = {
    schemaVersion: 64,
    runId: 256,
    serverSessionId: 64,
    challengeDigest: 64,
    teamId: 64,
    taskId: 128,
    mapId: 128,
    mapVersion: 128,
    ruleVersion: 128
  };
  for (const [field, maximum] of Object.entries(limits)) {
    const value = record?.[field];
    output[field] = typeof value === "string" && value.length <= maximum ? value : null;
  }
  try {
    output.runDefinitionDigest = canonicalSha256(record?.runDefinition);
  } catch (_error) {
    output.runDefinitionDigest = null;
  }
  try {
    output.sourceCodeDigest = typeof record?.sourceCode === "string"
      ? canonicalSha256(record.sourceCode)
      : null;
  } catch (_error) {
    output.sourceCodeDigest = null;
  }
  return output;
}

function draftReceipt(manifest, duplicate) {
  return {
    schemaVersion: "chenlong.record-draft-receipt/v1",
    recordId: manifest.recordId,
    sessionId: manifest.sessionId,
    savedAt: manifest.savedAt,
    duplicate: Boolean(duplicate),
    recordState: "saved",
    authoritative: false
  };
}

function recordSubmitReceipt(stored, duplicate) {
  return {
    schemaVersion: "chenlong.record-submit-receipt/v1",
    recordId: stored.manifest.submissionId,
    submissionId: stored.manifest.submissionId,
    sessionId: stored.manifest.sessionId,
    submittedAt: stored.manifest.receivedAt,
    duplicate: Boolean(duplicate),
    recordState: "submitted",
    verification: participantVerificationReport(stored.report),
    authoritative: false
  };
}

function readRequestBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const declaredLength = request.headers["content-length"];
    if (declaredLength !== undefined) {
      const number = Number(declaredLength);
      if (!Number.isSafeInteger(number) || number < 0) {
        request.resume();
        reject(new HttpError(400, "INVALID_CONTENT_LENGTH", "Content-Length must be a non-negative integer"));
        return;
      }
      if (number > maximumBytes) {
        request.resume();
        reject(new HttpError(413, "INPUT_TOO_LARGE", `run record exceeds the ${maximumBytes} byte input limit`));
        return;
      }
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = error => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.resume();
      reject(error);
    };
    const onData = chunk => {
      total += chunk.length;
      if (total > maximumBytes) {
        fail(new HttpError(413, "INPUT_TOO_LARGE", `run record exceeds the ${maximumBytes} byte input limit`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    };

    request.on("data", onData);
    request.on("end", onEnd);
    request.once("aborted", () => fail(new HttpError(400, "REQUEST_ABORTED", "request body was aborted")));
    request.once("error", error => fail(new HttpError(400, "REQUEST_FAILED", error.message)));
  });
}

function verifyInWorker(buffer, timeoutMs, signal = null, trustedRunDefinition = null) {
  return new Promise((resolve, reject) => {
    const payload = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const worker = new Worker(VERIFY_WORKER_PATH, {
      workerData: { payload, trustedRunDefinition },
      transferList: [payload],
      resourceLimits: {
        maxOldGenerationSizeMb: MAX_WORKER_OLD_GENERATION_MB,
        maxYoungGenerationSizeMb: 64,
        stackSizeMb: 8
      }
    });
    let settled = false;

    const finish = (error, report) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
      Promise.resolve(worker.terminate()).then(() => {
        if (error) reject(error);
        else resolve(report);
      }, terminationError => {
        reject(new HttpError(500, "VERIFY_WORKER_TERMINATION_FAILED", terminationError.message));
      });
    };
    const timeout = setTimeout(() => {
      finish(new HttpError(504, "VERIFICATION_TIMEOUT", `verification exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    timeout.unref?.();
    const onAbort = () => finish(new HttpError(499, "CLIENT_CLOSED_REQUEST", "client closed the request"));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    worker.once("message", message => {
      if (message?.ok && message.report) {
        finish(null, {
          report: message.report,
          recordMetadata: message.recordMetadata && typeof message.recordMetadata === "object"
            ? message.recordMetadata
            : null
        });
        return;
      }
      const code = typeof message?.error?.code === "string" ? message.error.code : "VERIFY_FAILED";
      const detail = typeof message?.error?.message === "string" ? message.error.message : "verification failed";
      const inputCodes = new Set(["EMPTY_INPUT", "INVALID_UTF8", "INVALID_JSON", "INVALID_ROOT"]);
      finish(new HttpError(inputCodes.has(code) ? 400 : 422, code, detail));
    });
    worker.once("error", error => finish(new HttpError(500, "VERIFY_WORKER_FAILED", error.message)));
    worker.once("exit", code => {
      if (!settled) finish(new HttpError(500, "VERIFY_WORKER_EXITED", `verification worker exited without a report (code ${code})`));
    });
  });
}

function parseStaticPath(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/") || rawUrl.startsWith("//")) {
    throw new HttpError(400, "INVALID_PATH", "request path is invalid");
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl || "/", "http://127.0.0.1").pathname);
  } catch (_error) {
    throw new HttpError(400, "INVALID_PATH", "request path is not valid URL encoding");
  }
  if (pathname.includes("\0") || pathname.includes("\\")) {
    throw new HttpError(400, "INVALID_PATH", "request path is invalid");
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const segments = relativePath.split("/");
  if (!segments.length || segments.some(segment => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new HttpError(404, "NOT_FOUND", "resource not found");
  }
  const portablePath = segments.join("/");
  let policy = null;
  if (TOP_LEVEL_STATIC_FILES.has(portablePath)) policy = "exact";
  else if (portablePath.startsWith("vendor/")) policy = "vendor";
  else if (portablePath === MAP_ASSET_PATH) policy = "exact";
  if (!policy) throw new HttpError(404, "NOT_FOUND", "resource not found");

  const absolutePath = path.resolve(STATIC_ROOT, ...segments);
  const rootPrefix = `${path.resolve(STATIC_ROOT)}${path.sep}`.toLowerCase();
  if (!absolutePath.toLowerCase().startsWith(rootPrefix)) {
    throw new HttpError(404, "NOT_FOUND", "resource not found");
  }
  return { absolutePath, policy, portablePath };
}

async function serveStatic(request, response, parsedPath = null) {
  const { absolutePath, policy } = parsedPath || parseStaticPath(request.url);
  let realPath;
  let stat;
  try {
    realPath = await fs.promises.realpath(absolutePath);
    const normalizedRealPath = realPath.toLowerCase();
    const exactPathMatches = normalizedRealPath === absolutePath.toLowerCase();
    const vendorPathMatches = normalizedRealPath.startsWith(`${VENDOR_ROOT_REAL}${path.sep}`.toLowerCase());
    if ((policy === "exact" && !exactPathMatches) || (policy === "vendor" && !vendorPathMatches)) {
      throw new HttpError(404, "NOT_FOUND", "resource not found");
    }
    stat = await fs.promises.stat(realPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new HttpError(404, "NOT_FOUND", "resource not found");
    throw error;
  }
  if (!stat.isFile()) throw new HttpError(404, "NOT_FOUND", "resource not found");

  const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  const lastModified = stat.mtime.toUTCString();
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("ETag", etag);
  response.setHeader("Last-Modified", lastModified);
  response.setHeader("Content-Type", MIME_TYPES[path.extname(realPath).toLowerCase()] || "application/octet-stream");
  let start = 0;
  let end = Math.max(0, stat.size - 1);
  let partial = false;
  const rangeHeader = String(request.headers.range || "").trim();
  const ifRange = String(request.headers["if-range"] || "").trim();
  const ifRangeDate = ifRange && ifRange !== etag ? Date.parse(ifRange) : NaN;
  const rangeAllowed = !ifRange
    || ifRange === etag
    || (Number.isFinite(ifRangeDate) && stat.mtimeMs <= ifRangeDate + 999);
  if (rangeHeader && rangeAllowed) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match || (!match[1] && !match[2])) {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${stat.size}`);
      response.setHeader("Content-Length", 0);
      response.end();
      return;
    }
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        response.statusCode = 416;
        response.setHeader("Content-Range", `bytes */${stat.size}`);
        response.setHeader("Content-Length", 0);
        response.end();
        return;
      }
      start = Math.max(0, stat.size - suffixLength);
    } else {
      start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= stat.size || end < start) {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${stat.size}`);
      response.setHeader("Content-Length", 0);
      response.end();
      return;
    }
    end = Math.min(end, stat.size - 1);
    partial = true;
  }
  const contentLength = stat.size === 0 ? 0 : end - start + 1;
  response.statusCode = partial ? 206 : 200;
  response.setHeader("Content-Length", contentLength);
  if (partial) response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(realPath, partial ? { start, end } : undefined);
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    stream.once("error", finish);
    response.once("close", () => {
      if (!response.writableEnded) stream.destroy();
      finish();
    });
    response.once("finish", () => finish());
    stream.pipe(response);
  });
}

function createServer(options = {}) {
  const robotBridgeEnabled = options.robotBridgeEnabled === undefined
    ? process.env.CHENLONG_ROBOT_BRIDGE === "1" : options.robotBridgeEnabled;
  if (typeof robotBridgeEnabled !== "boolean") throw new TypeError("robotBridgeEnabled must be boolean");
  const robotBridge = robotBridgeEnabled ? createRobotBridge(options.robotBridge || {}) : null;
  const maximumRecordBytes = boundedServerOption(
    "maxBodyBytes",
    options.maxBodyBytes ?? options.maximumRecordBytes,
    MAX_RECORD_BYTES,
    MAX_RECORD_BYTES
  );
  const workerTimeoutMs = boundedServerOption(
    "verifyTimeoutMs",
    options.verifyTimeoutMs ?? options.workerTimeoutMs,
    DEFAULT_WORKER_TIMEOUT_MS,
    MAX_WORKER_TIMEOUT_MS
  );
  const maximumConcurrentVerifications = boundedServerOption(
    "maxConcurrentVerifications",
    options.maxConcurrentVerifications ?? options.maximumConcurrentVerifications,
    DEFAULT_MAX_CONCURRENT_VERIFICATIONS,
    MAX_CONCURRENT_VERIFICATIONS
  );
  const maximumQueuedVerifications = boundedServerOption(
    "maxQueuedVerifications", options.maxQueuedVerifications,
    DEFAULT_MAX_QUEUED_VERIFICATIONS, MAX_QUEUED_VERIFICATIONS
  );
  const verificationQueueTimeoutMs = boundedServerOption(
    "verificationQueueTimeoutMs", options.verificationQueueTimeoutMs,
    DEFAULT_VERIFICATION_QUEUE_TIMEOUT_MS, MAX_VERIFICATION_QUEUE_TIMEOUT_MS
  );
  const sessionTtlMs = boundedServerOption(
    "sessionTtlMs",
    options.sessionTtlMs,
    DEFAULT_SESSION_TTL_MS,
    MAX_SESSION_TTL_MS
  );
  const batchTtlMs = boundedServerOption(
    "batchTtlMs",
    options.batchTtlMs,
    DEFAULT_BATCH_TTL_MS,
    MAX_BATCH_TTL_MS
  );
  const rankedPreparationCacheTtlMs = boundedServerOption(
    "rankedPreparationCacheTtlMs",
    options.rankedPreparationCacheTtlMs,
    RANKED_PREPARATION_CACHE_TTL_MS,
    MAX_RANKED_PREPARATION_CACHE_TTL_MS
  );
  const registrationWindowMs = boundedServerOption(
    "registrationWindowMs",
    options.registrationWindowMs,
    DEFAULT_REGISTRATION_ATTEMPT_WINDOW_MS,
    MAX_REGISTRATION_ATTEMPT_WINDOW_MS
  );
  const maxRegistrationAttempts = boundedServerOption(
    "maxRegistrationAttempts",
    options.maxRegistrationAttempts,
    DEFAULT_MAX_REGISTRATION_ATTEMPTS,
    MAX_REGISTRATION_ATTEMPTS
  );
  const officialSsoAttemptWindowMs = boundedServerOption(
    "officialSsoAttemptWindowMs",
    options.officialSsoAttemptWindowMs,
    DEFAULT_OFFICIAL_SSO_ATTEMPT_WINDOW_MS,
    MAX_OFFICIAL_SSO_ATTEMPT_WINDOW_MS
  );
  const maxOfficialSsoAttempts = boundedServerOption(
    "maxOfficialSsoAttempts",
    options.maxOfficialSsoAttempts,
    DEFAULT_MAX_OFFICIAL_SSO_ATTEMPTS,
    MAX_OFFICIAL_SSO_ATTEMPTS
  );
  const maxOfficialSsoAttemptsPerIp = boundedServerOption(
    "maxOfficialSsoAttemptsPerIp",
    options.maxOfficialSsoAttemptsPerIp,
    DEFAULT_MAX_OFFICIAL_SSO_ATTEMPTS_PER_IP,
    MAX_OFFICIAL_SSO_ATTEMPTS
  );
  if (sessionTtlMs < batchTtlMs) {
    throw new TypeError("sessionTtlMs must be greater than or equal to batchTtlMs");
  }
  const verificationRunner = typeof options.verifyInWorker === "function"
    ? options.verifyInWorker
    : verifyInWorker;
  const onBatchSubmissionPrechecked = typeof options.onBatchSubmissionPrechecked === "function"
    ? options.onBatchSubmissionPrechecked
    : null;
  const onRankedAccessQueued = typeof options.onRankedAccessQueued === "function"
    ? options.onRankedAccessQueued
    : null;
  const dataRoot = path.resolve(options.dataDir || process.env.CHENLONG_DATA_DIR || path.join(STATIC_ROOT, ".runtime"));
  const officialSsoSecretSource = options.officialSsoSecret ?? process.env.CHENLONG_OFFICIAL_SSO_SECRET;
  const officialSsoSecret = officialSsoSecretSource === undefined || officialSsoSecretSource === ""
    ? null
    : requireSsoSecret(officialSsoSecretSource);
  const platformServiceSecretSource = options.platformServiceSecret ?? process.env.CHENLONG_PLATFORM_SSO_SECRET;
  const platformServiceSecret = platformServiceSecretSource === undefined || platformServiceSecretSource === ""
    ? null
    : requireSsoSecret(platformServiceSecretSource);
  const platformServiceNowSeconds = () => Math.floor(Number(
    typeof options.now === "function" ? options.now() : Date.now()
  ) / 1000);
  const platformServiceReplayWindow = platformServiceSecret === null
    ? null
    : new internalServiceAuth.ServiceReplayWindow({ nowSeconds: platformServiceNowSeconds });
  const secureCookies = options.secureCookies === true;
  if (options.allowInsecureOfficialSsoForTests !== undefined
    && typeof options.allowInsecureOfficialSsoForTests !== "boolean") {
    throw new TypeError("allowInsecureOfficialSsoForTests must be a boolean");
  }
  const allowInsecureOfficialSsoForTests = options.allowInsecureOfficialSsoForTests === true;
  if (options.allowLoopbackOrigin !== undefined && typeof options.allowLoopbackOrigin !== "boolean") {
    throw new TypeError("allowLoopbackOrigin must be a boolean");
  }
  const allowLoopbackOrigin = options.allowLoopbackOrigin === true;
  let publicOrigin = null;
  if (options.publicOrigin !== undefined && options.publicOrigin !== null) {
    try {
      const parsedOrigin = new URL(options.publicOrigin);
      if (!["http:", "https:"].includes(parsedOrigin.protocol)
        || parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== "/"
        || parsedOrigin.search || parsedOrigin.hash) throw new TypeError("invalid public origin");
      publicOrigin = parsedOrigin.origin;
  } catch (_error) {
      throw new TypeError("publicOrigin must be an HTTP(S) origin without a path, query, credentials or fragment");
    }
  }
  if (officialSsoSecret !== null && !allowInsecureOfficialSsoForTests) {
    if (publicOrigin === null || new URL(publicOrigin).protocol !== "https:" || !secureCookies) {
      throw new TypeError(
        "official SSO requires an HTTPS publicOrigin and secureCookies=true; "
        + "only isolated tests may set allowInsecureOfficialSsoForTests"
      );
    }
  }
  const assertRequestSameOrigin = request => assertSameOrigin(request, publicOrigin, allowLoopbackOrigin);
  const secureCookieForRequest = request => secureCookies && !(
    allowLoopbackOrigin && loopbackOriginForRequest(request) !== null
  );
  const writerLock = acquireDataDirectoryWriterLock(dataRoot);
  let submissionStore;
  let authStore;
  let batchStore;
  let rankedBatchStore;
  let mapConfigStore;
  let mapConfigStores;
  let mapConfigPools;
  let officialSsoReplayStore;
  try {
    // Validate the published map synchronously before starting any other
    // asynchronous stores. A damaged publication therefore prevents startup
    // without leaving partially initialized background work behind.
    mapConfigStores = new Map();
    mapConfigPools = new Map();
    for (const config of GUANGYANG_CHALLENGE_CONFIGS) {
      const suppliedStores = options.mapConfigStores;
      const supplied = suppliedStores instanceof Map
        ? suppliedStores.get(config.taskId)
        : suppliedStores && typeof suppliedStores === "object"
          ? suppliedStores[config.taskId]
          : null;
      // mapConfigStore/mapConfigDataDir are kept as the original challenge 1
      // injection hooks so existing deployments and tests keep their
      // published map.  The new challenges live in their own directories.
      const isChallengeOne = config.taskId === GUANGYANG_ISLAND_CONFIG.taskId;
      const rootDir = isChallengeOne
        ? options.mapConfigDataDir || path.join(dataRoot, "map-config", config.mapId)
        : path.join(dataRoot, "map-config", config.mapId, `challenge-${config.difficulty}`);
      const initialLayouts = buildInitialMapPoolLayouts(config);
      const pool = new Map();
      initialLayouts.forEach((initialLayout, index) => {
        const id = variantId(index + 1);
        const injectedPool = options.mapConfigPools instanceof Map
          ? options.mapConfigPools.get(config.taskId)
          : options.mapConfigPools && typeof options.mapConfigPools === "object"
            ? options.mapConfigPools[config.taskId]
            : null;
        const injected = injectedPool instanceof Map
          ? injectedPool.get(id)
          : injectedPool && typeof injectedPool === "object"
            ? injectedPool[id]
            : null;
        const firstStore = index === 0
          ? supplied || (isChallengeOne && options.mapConfigStore)
          : null;
        pool.set(id, injected || firstStore || new GuangyangMapConfigStore({
          rootDir: index === 0 ? rootDir : path.join(rootDir, id),
          baseConfig: config,
          baseChallenge: LOCAL_CHALLENGES[config.taskId],
          initialLayout,
          now: options.now
        }));
      });
      mapConfigPools.set(config.taskId, pool);
      mapConfigStores.set(config.taskId, pool.get("map-01"));
    }
    mapConfigStore = mapConfigStores.get(GUANGYANG_ISLAND_CONFIG.taskId);
    submissionStore = options.submissionStore || new SubmissionStore({
      rootDir: dataRoot,
      now: options.now,
      sessionTtlMs,
      maxSessions: options.maxSessions,
      maxSessionsByScope: options.maxSessionsByScope || (options.maxSessions !== undefined ? {
        single: options.maxSessions,
        practice: options.maxSessions,
        ranked: options.maxSessions
      } : { single: 600, practice: 200, ranked: 200 }),
      maxSubmissionsPerSession: options.maxSubmissionsPerSession,
      maxStorageBytes: options.maxStorageBytes
    });
    authStore = options.authStore || new AuthStore({
      rootDir: options.authDataDir || path.join(dataRoot, "auth"),
      now: options.now,
      authSessionTtlMs: options.authSessionTtlMs,
      maxUsers: options.maxUsers,
      maxAuthSessions: options.maxAuthSessions,
      maxSessionsPerUser: options.maxSessionsPerUser,
      maxPasswordOperations: options.maxPasswordOperations,
      maxPasswordQueue: options.maxPasswordQueue,
      passwordQueueTimeoutMs: options.passwordQueueTimeoutMs,
      registrationOpen: options.registrationOpen
    });
    officialSsoReplayStore = officialSsoSecret === null ? null : new OfficialSsoReplayStore({
      rootDir: options.officialSsoDataDir || path.join(dataRoot, "official-sso"),
      now: typeof options.officialSsoNow === "function" ? options.officialSsoNow : options.now,
      maxAuditBytes: options.maxOfficialSsoAuditBytes,
      maxAuditFiles: options.maxOfficialSsoAuditFiles
    });
    batchStore = options.batchStore || new BatchEvaluationStore({
      rootDir: dataRoot,
      now: options.now,
      batchTtlMs,
      maxBatches: options.maxBatches,
      maxOpenBatchesPerOwner: options.maxOpenBatchesPerOwner,
      maxRetainedBatchesPerOwner: options.maxRetainedBatchesPerOwner,
      maxStorageBytes: options.maxBatchStorageBytes
    });
    rankedBatchStore = options.rankedBatchStore || new BatchEvaluationStore({
      rootDir: options.rankedBatchDataDir
        || path.join(dataRoot, "ranked-evaluations", RANKED_COMPETITION_ID),
      purpose: "ranked",
      competitionId: RANKED_COMPETITION_ID,
      layoutSequenceProvider: selectRankedGuangyangLayoutSequence,
      evaluationPolicy: RANKED_EVALUATION_POLICY,
      now: options.now,
      batchTtlMs,
      maxBatches: options.maxRankedBatches,
      maxOpenBatchesPerOwner: 1,
      maxRetainedBatchesPerOwner: 1,
      maxStorageBytes: options.maxRankedBatchStorageBytes
    });
  } catch (error) {
    writerLock.release();
    throw error;
  }
  const loginAttempts = new Map();
  const registrationAttempts = [];
  const officialSsoAttemptsByIp = new Map();
  let officialSsoAttempts = { count: 0, resetAt: 0 };
  let officialSsoAuditFailures = 0;
  const batchOperationTails = new Map();
  const rankedEvidenceAuditCache = new Map();
  const rankedRankingReads = new Map();
  const rankedAccessQueue = [];
  let rankedActiveReaders = 0;

  function mapPoolForTask(taskId) {
    const pool = mapConfigPools.get(taskId);
    if (!pool) throw new HttpError(404, "CHALLENGE_NOT_FOUND", "requested task is not registered by this server");
    return pool;
  }

  function assignedMapStore(taskId, teamId) {
    const pool = mapPoolForTask(taskId);
    const id = assignedVariantId(taskId, teamId);
    const store = pool.get(id);
    if (!store) throw new HttpError(500, "MAP_POOL_CORRUPTED", "assigned map variant is unavailable");
    return { id, store };
  }

  async function adminMapPoolsResponse() {
    const pools = await Promise.all(GUANGYANG_CHALLENGE_CONFIGS.map(async config => {
      const pool = mapPoolForTask(config.taskId);
      const variants = await Promise.all([...pool.entries()].map(async ([id, store]) => {
        const snapshot = await store.snapshot();
        return {
          variantId: id,
          variantNumber: variantNumber(id),
          revision: snapshot.revision,
          updatedAt: snapshot.updatedAt,
          digest: snapshot.digest,
          mapVersion: snapshot.mapVersion
        };
      }));
      return {
        taskId: config.taskId,
        displayName: config.displayName,
        variantCount: MAP_POOL_COUNTS[config.taskId],
        variants
      };
    }));
    const teams = await authStore.listTeamsForAdmin();
    const assignments = teams.map(team => ({
      teamId: team.teamId,
      teamName: team.teamName,
      members: team.members,
      maps: GUANGYANG_CHALLENGE_CONFIGS.map(config => {
        const id = assignedVariantId(config.taskId, team.teamId);
        return {
          taskId: config.taskId,
          variantId: id,
          variantNumber: variantNumber(id)
        };
      })
    }));
    return {
      schemaVersion: MAP_POOL_ADMIN_SCHEMA_VERSION,
      pools,
      assignments,
      authoritative: false
    };
  }
  let rankedWriterActive = false;
  let rankedGlobalGeneration = 0;
  let rankedGlobalSnapshot = null;
  let rankedGlobalRefreshFlight = null;
  let rankedArchiveIdentityFlight = null;
  const verificationQueue = createVerificationQueue({
    maximumConcurrentVerifications,
    maximumQueuedVerifications,
    queueTimeoutMs: verificationQueueTimeoutMs
  });

  const invalidateRankedGlobalSnapshot = () => {
    rankedGlobalGeneration += 1;
    rankedGlobalSnapshot = null;
  };

  const enforceRankedRankingReadLimit = principal => {
    const now = Date.now();
    for (const [key, entry] of rankedRankingReads) {
      if (entry.resetAt <= now) rankedRankingReads.delete(key);
    }
    const ownerUserId = principal.user.id;
    const admin = principal.user.role === "admin";
    const limit = admin ? ADMIN_RANKED_RANKING_READ_LIMIT : RANKED_RANKING_READ_LIMIT;
    const windowMs = admin ? ADMIN_RANKED_RANKING_READ_WINDOW_MS : RANKED_RANKING_READ_WINDOW_MS;
    const current = rankedRankingReads.get(ownerUserId);
    if (current && current.resetAt > now && current.count >= limit) {
      throw new HttpError(429, "RANKING_RATE_LIMITED", "ranked ranking refresh rate exceeded", {
        "Retry-After": String(Math.max(1, Math.ceil((current.resetAt - now) / 1000)))
      });
    }
    if (!current || current.resetAt <= now) {
      rankedRankingReads.set(ownerUserId, { count: 1, resetAt: now + windowMs });
    } else {
      current.count += 1;
    }
    while (rankedRankingReads.size > MAX_RANKED_RANKING_RATE_KEYS) {
      rankedRankingReads.delete(rankedRankingReads.keys().next().value);
    }
  };

  const requirePrincipal = async request => authStore.authenticate(parseAuthCookie(request));

  const requireAdmin = async request => {
    const principal = await requirePrincipal(request);
    if (principal.user.role !== "admin") {
      throw new HttpError(403, "ADMIN_REQUIRED", "administrator role is required");
    }
    return principal;
  };

  const authorizeCompetitionSession = async (
    request,
    sessionId,
    { allowExpired = false, adminBypass = true } = {}
  ) => {
    const principal = await requirePrincipal(request);
    if (adminBypass && principal.user.role === "admin") {
      return {
        principal,
        session: await submissionStore.readSession(sessionId),
        token: null,
        adminBypass: true
      };
    }
    const token = bearerToken(request);
    const session = await submissionStore.authorizeSession(sessionId, token, { allowExpired });
    submissionStore.assertSessionOwner(session, principal.user.id);
    return { principal, session, token, adminBypass: false };
  };

  const readBoundBatchSession = async (
    execution,
    ownerUserId,
    { expectedTeamId = null, expectedScope = null } = {}
  ) => {
    const binding = execution?.sessionBinding;
    if (!binding) {
      throw new HttpError(409, "SLOT_SESSION_NOT_LEASED", "batch slot has no bound session lease");
    }
    const session = await submissionStore.readSession(binding.sessionId);
    submissionStore.assertSessionOwner(session, ownerUserId);
    const mismatches = [];
    if (session.runId !== binding.runId) mismatches.push("runId");
    if (session.challengeDigest !== binding.challengeDigest) mismatches.push("challengeDigest");
    if (canonicalSha256(session.challenge?.runDefinition) !== binding.runDefinitionDigest) {
      mismatches.push("runDefinitionDigest");
    }
    if (expectedTeamId !== null
      && (binding.teamId !== expectedTeamId || session.teamId !== expectedTeamId)) {
      mismatches.push("teamId");
    }
    if (mismatches.length) {
      throw new HttpError(500, "BATCH_SESSION_BINDING_CORRUPTED",
        `batch slot session binding is inconsistent: ${mismatches.join(", ")}`);
    }
    if (expectedScope !== null) {
      await submissionStore.bindSessionScopeForServer(session.sessionId, expectedScope);
    }
    return session;
  };

  const withBatchOperationLock = async (batchId, operation) => {
    const previous = batchOperationTails.get(batchId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    batchOperationTails.set(batchId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (batchOperationTails.get(batchId) === current) batchOperationTails.delete(batchId);
    }
  };

  const dispatchRankedAccessQueue = () => {
    if (rankedWriterActive || rankedAccessQueue.length === 0) return;
    if (rankedAccessQueue[0].mode === "write") {
      if (rankedActiveReaders !== 0) {
        // An admitted ranked submission may pass a waiting snapshot publisher.
        // The publisher performs no I/O, but waiting behind it until another
        // slow verifier finishes could otherwise push this submit past TTL.
        for (let index = rankedAccessQueue.length - 1; index >= 1; index -= 1) {
          if (rankedAccessQueue[index].mode !== "priority-read") continue;
          const [waiter] = rankedAccessQueue.splice(index, 1);
          rankedActiveReaders += 1;
          let released = false;
          waiter.resolve(() => {
            if (released) return;
            released = true;
            rankedActiveReaders -= 1;
            dispatchRankedAccessQueue();
          });
        }
        return;
      }
      const waiter = rankedAccessQueue.shift();
      rankedWriterActive = true;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        rankedWriterActive = false;
        dispatchRankedAccessQueue();
      });
      return;
    }
    while (["read", "priority-read"].includes(rankedAccessQueue[0]?.mode) && !rankedWriterActive) {
      const waiter = rankedAccessQueue.shift();
      rankedActiveReaders += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        rankedActiveReaders -= 1;
        dispatchRankedAccessQueue();
      });
    }
  };

  const acquireRankedAccess = mode => new Promise(resolve => {
    rankedAccessQueue.push({ mode, resolve });
    try {
      onRankedAccessQueued?.({
        mode,
        activeReaders: rankedActiveReaders,
        writerActive: rankedWriterActive,
        queuedModes: rankedAccessQueue.map(waiter => waiter.mode)
      });
    } catch (_error) {
      // Diagnostics hooks cannot alter coordinator liveness.
    }
    dispatchRankedAccessQueue();
  });

  const withRankedAccess = async (mode, operation) => {
    const release = await acquireRankedAccess(mode);
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const withRankedReadBarrier = operation => withRankedAccess("read", operation);
  const withRankedSubmissionBarrier = operation => withRankedAccess("priority-read", operation);
  const withRankedWriteBarrier = operation => withRankedAccess("write", operation);

  const archivedRankedEvidence = async (batchEvidence, slotEvidence, stored, session) => {
    const manifest = stored.manifest;
    const binding = slotEvidence.sessionBinding;
    if (!binding || manifest.sessionId !== binding.sessionId) {
      throw new HttpError(500, "BATCH_SUBMISSION_BINDING_CORRUPTED",
        "archived ranked submission does not match its slot session");
    }
    const archivedAt = Date.parse(manifest.receivedAt);
    if (!Number.isFinite(archivedAt)
      || new Date(archivedAt).toISOString() !== manifest.receivedAt
      || archivedAt < Date.parse(binding.boundAt)
      || archivedAt >= Date.parse(batchEvidence.expiresAt)) {
      throw new HttpError(500, "BATCH_SUBMISSION_TIME_CORRUPTED",
        "archived ranked submission is outside its lease and batch lifetime");
    }
    let metadata;
    try {
      metadata = archivedRecordMetadata(stored.buffer, stored.report);
    } catch (_error) {
      throw new HttpError(500, "BATCH_SUBMISSION_RECORD_CORRUPTED",
        "archived ranked record cannot be independently inspected");
    }
    submissionStore.assertRecordMatchesSession(session, metadata);
    const metadataFields = [
      "schemaVersion", "runId", "serverSessionId", "challengeDigest", "teamId",
      "taskId", "mapId", "mapVersion", "ruleVersion", "runDefinitionDigest",
      "sourceCodeDigest", "verifiedCollisionCount", "verifiedOutOfBoundsCount"
    ];
    if (metadataFields.some(field => stored.manifest.run?.[field] !== metadata[field])
      || metadata.sourceCodeDigest !== batchEvidence.sourceDigest
      || metadata.teamId !== batchEvidence.lockedTeamId
      || binding.teamId !== batchEvidence.lockedTeamId) {
      throw new HttpError(500, "BATCH_SUBMISSION_BINDING_CORRUPTED",
        "archived ranked record does not match its locked source, team, or metadata");
    }
    const result = verifiedRankedBatchResult(stored.report, metadata);
    return { archivedAt: manifest.receivedAt, metadata, result };
  };

  const auditRankedReceiptEvidence = async (batchEvidence, slotEvidence) => {
    const receipt = slotEvidence.verifiedReceipt;
    if (!receipt || !slotEvidence.sessionBinding || slotEvidence.result === null
      || slotEvidence.result.status === "missing") {
      throw new HttpError(500, "BATCH_RECEIPT_EVIDENCE_CORRUPTED",
        "ranked verified result is missing its durable receipt evidence");
    }
    const session = await readBoundBatchSession(slotEvidence, batchEvidence.ownerUserId, {
      expectedTeamId: batchEvidence.lockedTeamId,
      expectedScope: {
        scope: "ranked",
        competitionId: batchEvidence.competitionId,
        batchId: batchEvidence.batchId,
        slotIndex: slotEvidence.slotIndex
      }
    });
    let identity;
    try {
      identity = await submissionStore.inspectSubmissionEvidenceIdentity(
        session.sessionId,
        receipt.submissionId
      );
    } catch (_error) {
      throw new HttpError(500, "BATCH_RECEIPT_EVIDENCE_CORRUPTED",
        "ranked receipt evidence is missing or structurally invalid");
    }
    const cacheKey = canonicalSha256({
      schemaVersion: "chenlong.ranked-evidence-audit-cache-key/v1",
      competitionId: batchEvidence.competitionId,
      batchId: batchEvidence.batchId,
      ownerUserId: batchEvidence.ownerUserId,
      sourceDigest: batchEvidence.sourceDigest,
      lockedTeamId: batchEvidence.lockedTeamId,
      expiresAt: batchEvidence.expiresAt,
      slotIndex: slotEvidence.slotIndex,
      sessionBinding: slotEvidence.sessionBinding,
      receipt,
      result: slotEvidence.result,
      identity
    });
    const cached = rankedEvidenceAuditCache.get(cacheKey);
    if (cached) {
      rankedEvidenceAuditCache.delete(cacheKey);
      rankedEvidenceAuditCache.set(cacheKey, cached);
      await cached;
      return;
    }
    const audit = (async () => {
      const stored = await submissionStore.readSubmission(
        session.sessionId,
        receipt.submissionId,
        null,
        { skipAuthorization: true }
      );
      const audited = await archivedRankedEvidence(batchEvidence, slotEvidence, stored, session);
      if (stored.manifest.record.sha256 !== receipt.recordSha256
        || stored.manifest.report.sha256 !== receipt.reportSha256
        || stored.manifest.receivedAt !== receipt.receivedAt
        || canonicalSha256(audited.result) !== receipt.resultDigest
        || canonicalSha256(slotEvidence.result) !== receipt.resultDigest) {
        throw new HttpError(500, "BATCH_RECEIPT_EVIDENCE_CORRUPTED",
          "ranked receipt no longer matches its archived record and report");
      }
    })();
    rankedEvidenceAuditCache.set(cacheKey, audit);
    while (rankedEvidenceAuditCache.size > MAX_RANKED_EVIDENCE_AUDIT_CACHE_ENTRIES) {
      rankedEvidenceAuditCache.delete(rankedEvidenceAuditCache.keys().next().value);
    }
    try {
      await audit;
    } catch (error) {
      if (rankedEvidenceAuditCache.get(cacheKey) === audit) rankedEvidenceAuditCache.delete(cacheKey);
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, "BATCH_RECEIPT_EVIDENCE_CORRUPTED",
        "ranked receipt evidence failed independent verification");
    }
  };

  const reconcileRankedBatchEvidence = async batchEvidence => {
    const pending = batchEvidence.slots.find(slot => (
      slot.current && slot.result === null && slot.sessionBinding !== null
    ));
    if (!pending) return false;
    const session = await readBoundBatchSession(pending, batchEvidence.ownerUserId, {
      expectedTeamId: batchEvidence.lockedTeamId,
      expectedScope: {
        scope: "ranked",
        competitionId: batchEvidence.competitionId,
        batchId: batchEvidence.batchId,
        slotIndex: pending.slotIndex
      }
    });
    const manifests = await submissionStore.listSubmissionManifests(session.sessionId);
    if (manifests.length === 0) return false;
    if (manifests.length !== 1) {
      throw new HttpError(500, "BATCH_SLOT_ARCHIVE_AMBIGUOUS",
        "ranked slot session contains more than one archived submission");
    }
    const stored = await submissionStore.readSubmission(
      session.sessionId,
      manifests[0].submissionId,
      null,
      { skipAuthorization: true }
    );
    const audited = await archivedRankedEvidence(batchEvidence, pending, stored, session);
    await rankedBatchStore.submitVerifiedSlotResult({
      ownerUserId: batchEvidence.ownerUserId,
      batchId: batchEvidence.batchId,
      slotIndex: pending.slotIndex,
      sessionId: session.sessionId,
      submissionId: stored.manifest.submissionId,
      recordSha256: stored.manifest.record.sha256,
      reportSha256: stored.manifest.report.sha256,
      archivedAt: stored.manifest.receivedAt,
      result: audited.result
    }, { allowExpiredCommit: true });
    return true;
  };

  const auditRankedBatchEvidence = async batchEvidence => {
    for (const slot of batchEvidence.slots) {
      if (slot.verifiedReceipt !== null) {
        await auditRankedReceiptEvidence(batchEvidence, slot);
        continue;
      }
      if (slot.result?.status !== "missing" || slot.sessionBinding === null) continue;
      const manifests = await submissionStore.listSubmissionManifests(slot.sessionBinding.sessionId);
      if (manifests.length !== 0) {
        throw new HttpError(500, "BATCH_FINALIZATION_EVIDENCE_CONFLICT",
          "a ranked slot was finalized missing despite durable archived evidence");
      }
    }
  };

  const retireBatchSessions = async batchEvidence => {
    const expired = rankedLogicalNow() >= Date.parse(batchEvidence.expiresAt);
    for (const slot of batchEvidence.slots) {
      if (slot.sessionBinding === null) continue;
      const scope = batchEvidence.purpose === "ranked"
        ? {
          scope: "ranked",
          competitionId: batchEvidence.competitionId,
          batchId: batchEvidence.batchId,
          slotIndex: slot.slotIndex
        }
        : {
          scope: "practice",
          batchId: batchEvidence.batchId,
          slotIndex: slot.slotIndex
        };
      await submissionStore.bindSessionScopeForServer(slot.sessionBinding.sessionId, scope);
      if (slot.verifiedReceipt !== null) {
        await submissionStore.retireSessionForServer(
          slot.sessionBinding.sessionId,
          "batch_slot_completed"
        );
      } else if (batchEvidence.phase === "finalized") {
        await submissionStore.retireSessionForServer(
          slot.sessionBinding.sessionId,
          expired ? "batch_expired" : "batch_closed"
        );
      }
    }
  };

  const prepareRankedBatch = async (ownerUserId, batchId) => {
    let evidence = await rankedBatchStore.readRankedBatchEvidenceForServer({ ownerUserId, batchId });
    if (await reconcileRankedBatchEvidence(evidence)) {
      invalidateRankedGlobalSnapshot();
      evidence = await rankedBatchStore.readRankedBatchEvidenceForServer({ ownerUserId, batchId });
    }
    await auditRankedBatchEvidence(evidence);
    await retireBatchSessions(evidence);
    return evidence;
  };

  const prepareRankedOwner = async ownerUserId => {
    let evidence = await rankedBatchStore.readRankedOwnerBatchEvidenceForServer({ ownerUserId });
    if (evidence === null) return null;
    if (await reconcileRankedBatchEvidence(evidence)) {
      invalidateRankedGlobalSnapshot();
      evidence = await rankedBatchStore.readRankedOwnerBatchEvidenceForServer({ ownerUserId });
    }
    await auditRankedBatchEvidence(evidence);
    await retireBatchSessions(evidence);
    return evidence;
  };

  const prepareRankedBatchForRanking = async ({ ownerUserId, batchId }) => {
    let evidence;
    await withBatchOperationLock(`ranked:${batchId}`, async () => {
      evidence = await rankedBatchStore.readRankedBatchEvidenceSnapshotForServer({ ownerUserId, batchId });
      if (await reconcileRankedBatchEvidence(evidence)) {
        invalidateRankedGlobalSnapshot();
        evidence = await rankedBatchStore.readRankedBatchEvidenceSnapshotForServer({ ownerUserId, batchId });
      }
      const phaseBeforeExpiryCheck = evidence.phase;
      await rankedBatchStore.readBatch({ ownerUserId, batchId });
      evidence = await rankedBatchStore.readRankedBatchEvidenceSnapshotForServer({ ownerUserId, batchId });
      if (phaseBeforeExpiryCheck !== evidence.phase) invalidateRankedGlobalSnapshot();
    });
    // Full record/report hashing deliberately happens after releasing the batch
    // lock. A same-batch submission must never wait behind large evidence I/O;
    // its controlled mutation changes the generation and discards this candidate.
    await auditRankedBatchEvidence(evidence);
    await retireBatchSessions(evidence);
    return evidence;
  };

  const rankedLogicalNow = () => {
    const value = Number(typeof options.now === "function" ? options.now() : Date.now());
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("now() must return a non-negative safe integer");
    return value;
  };

  const currentRankedArchiveIdentity = async () => {
    if (rankedArchiveIdentityFlight !== null) return rankedArchiveIdentityFlight;
    const flight = rankedBatchStore.inspectRankedArchiveIdentityForServer();
    rankedArchiveIdentityFlight = flight;
    try {
      return await flight;
    } finally {
      if (rankedArchiveIdentityFlight === flight) rankedArchiveIdentityFlight = null;
    }
  };

  const reusableRankedGlobalSnapshot = async snapshot => {
    if (snapshot === null
      || snapshot.generation !== rankedGlobalGeneration
      || Date.now() >= snapshot.refreshBefore
      || (snapshot.validUntil !== null && rankedLogicalNow() >= snapshot.validUntil)) {
      return false;
    }
    // Controlled creates, leases, archives, receipts and finalization invalidate
    // the generation immediately. Direct filesystem edits can remain visible in
    // a response only for this bounded preparation TTL; the next refresh performs
    // a two-sided archive identity check and fails closed on missing evidence.
    return true;
  };

  const buildRankedGlobalSnapshotCandidate = () => withRankedReadBarrier(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const generation = rankedGlobalGeneration;
      const identityBefore = await currentRankedArchiveIdentity();
      const identifiers = await rankedBatchStore.listRankedBatchIdentifiersForServer();
      const evidence = [];
      for (const identifier of identifiers) {
        evidence.push(await prepareRankedBatchForRanking(identifier));
      }
      if (generation !== rankedGlobalGeneration) continue;
      const identityAfter = await currentRankedArchiveIdentity();
      if (generation !== rankedGlobalGeneration || identityBefore !== identityAfter) continue;
      const logicalNow = rankedLogicalNow();
      const openExpiries = evidence
        .filter(batchEvidence => batchEvidence.phase === "open")
        .map(batchEvidence => Date.parse(batchEvidence.expiresAt));
      const validUntil = openExpiries.length ? Math.min(...openExpiries) : null;
      if (validUntil !== null && logicalNow >= validUntil) continue;
      return {
        generation,
        refreshBefore: Date.now() + rankedPreparationCacheTtlMs,
        validUntil,
        archiveIdentity: identityAfter,
        evidence,
        entries: rankedBatchStore.rankPreparedRankedEvidenceForServer(evidence)
      };
    }
    throw new HttpError(503, "RANKING_REFRESH_RETRY", "ranked state changed during ranking refresh");
  });

  const publishRankedGlobalSnapshotCandidate = candidate => {
    // This writer contains no I/O. Ranked submit admission uses priority-read and
    // may pass it while earlier readers are still active, so a queued publication
    // can never push an on-time submit beyond its archive deadline.
    return withRankedWriteBarrier(() => {
      if (candidate.generation !== rankedGlobalGeneration
        || (candidate.validUntil !== null && rankedLogicalNow() >= candidate.validUntil)) {
        throw new HttpError(503, "RANKING_REFRESH_RETRY", "ranked state changed during ranking refresh");
      }
      rankedGlobalSnapshot = candidate;
      return candidate;
    });
  };

  const refreshRankedGlobalSnapshot = async () => {
    if (await reusableRankedGlobalSnapshot(rankedGlobalSnapshot)) return rankedGlobalSnapshot;
    const candidate = await buildRankedGlobalSnapshotCandidate();
    return publishRankedGlobalSnapshotCandidate(candidate);
  };

  const trustedRankedGlobalSnapshot = async () => {
    const cached = rankedGlobalSnapshot;
    if (await reusableRankedGlobalSnapshot(cached)) return cached;
    if (cached !== null && rankedGlobalSnapshot === cached) invalidateRankedGlobalSnapshot();
    if (rankedGlobalRefreshFlight !== null) return rankedGlobalRefreshFlight;
    const flight = refreshRankedGlobalSnapshot();
    rankedGlobalRefreshFlight = flight;
    try {
      return await flight;
    } finally {
      if (rankedGlobalRefreshFlight === flight) rankedGlobalRefreshFlight = null;
    }
  };

  const trustedRankedOwnerResult = async ownerUserId => {
    const snapshot = await trustedRankedGlobalSnapshot();
    return snapshot.entries.find(entry => entry.ownerUserId === ownerUserId) || null;
  };

  const decorateRecord = async record => ({
    ...record,
    user: record.ownerUserId ? await authStore.getPublicUser(record.ownerUserId) : null
  });

  const loginAttemptKey = (request, username) => {
    const remoteAddress = String(request.socket?.remoteAddress || "unknown").slice(0, 128);
    return `${remoteAddress}\n${String(username || "").trim().toLowerCase().slice(0, 64)}`;
  };

  const pruneLoginAttempts = now => {
    for (const [key, value] of loginAttempts) {
      if (value.resetAt <= now) loginAttempts.delete(key);
    }
    while (loginAttempts.size > MAX_LOGIN_ATTEMPT_KEYS) {
      loginAttempts.delete(loginAttempts.keys().next().value);
    }
  };

  const enforceLoginRateLimit = (key, now) => {
    pruneLoginAttempts(now);
    const entry = loginAttempts.get(key);
    if (entry && entry.count >= MAX_LOGIN_ATTEMPTS && entry.resetAt > now) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      throw new HttpError(429, "LOGIN_RATE_LIMITED", "too many failed login attempts", {
        "Retry-After": String(retryAfter)
      });
    }
  };

  const recordFailedLogin = (key, now) => {
    const current = loginAttempts.get(key);
    if (!current || current.resetAt <= now) {
      loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_ATTEMPT_WINDOW_MS });
    } else {
      current.count += 1;
    }
    pruneLoginAttempts(now);
  };

  const pruneRegistrationAttempts = now => {
    const oldestAllowed = now - registrationWindowMs;
    let expired = 0;
    while (expired < registrationAttempts.length && registrationAttempts[expired] <= oldestAllowed) {
      expired += 1;
    }
    if (expired > 0) registrationAttempts.splice(0, expired);
  };

  const enforceRegistrationRateLimit = now => {
    pruneRegistrationAttempts(now);
    if (registrationAttempts.length >= maxRegistrationAttempts) {
      const retryAt = registrationAttempts[0] + registrationWindowMs;
      const retryAfter = Math.max(1, Math.ceil((retryAt - now) / 1000));
      throw new HttpError(429, "REGISTRATION_RATE_LIMITED", "too many registration attempts", {
        "Retry-After": String(retryAfter)
      });
    }
    registrationAttempts.push(now);
  };

  const enforceOfficialSsoRateLimit = (ip, now) => {
    if (!Number.isFinite(now)) throw new TypeError("official SSO rate-limit clock is invalid");
    if (officialSsoAttempts.resetAt <= now) {
      officialSsoAttempts = { count: 0, resetAt: now + officialSsoAttemptWindowMs };
      officialSsoAttemptsByIp.clear();
    }
    const key = String(ip || "unknown").slice(0, 128);
    let entry = officialSsoAttemptsByIp.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + officialSsoAttemptWindowMs };
      officialSsoAttemptsByIp.set(key, entry);
    }
    if (officialSsoAttempts.count >= maxOfficialSsoAttempts
      || entry.count >= maxOfficialSsoAttemptsPerIp) {
      const retryAt = Math.min(officialSsoAttempts.resetAt, entry.resetAt);
      const limited = new OfficialSsoError(1004, "official SSO rate limit exceeded");
      limited.statusCode = 429;
      limited.retryAfter = Math.max(1, Math.ceil((retryAt - now) / 1000));
      limited.rateLimited = true;
      throw limited;
    }
    officialSsoAttempts.count += 1;
    entry.count += 1;
  };

  const runVerificationBuffer = async (buffer, response, trustedRunDefinition = null) => {
    const abortController = new AbortController();
    const abortOnClose = () => {
      if (!response.writableEnded) abortController.abort();
    };
    response.once("close", abortOnClose);
    try {
      const verification = await verificationRunner(
        buffer,
        workerTimeoutMs,
        abortController.signal,
        trustedRunDefinition
      );
      return { buffer, ...verification };
    } finally {
      response.removeListener("close", abortOnClose);
    }
  };

  const withVerificationCapacity = operation => verificationQueue(operation);

  const executeVerificationBuffer = (buffer, response, trustedRunDefinition = null) => (
    withVerificationCapacity(() => runVerificationBuffer(buffer, response, trustedRunDefinition))
  );

  const executeVerificationRequest = (
    request,
    response,
    trustedRunDefinition = null,
    contentEncoding = "identity"
  ) => (
    withVerificationCapacity(async () => {
      const wireBuffer = await readRequestBody(request, maximumRecordBytes);
      const buffer = decodeRequestBody(wireBuffer, contentEncoding, maximumRecordBytes);
      return runVerificationBuffer(buffer, response, trustedRunDefinition);
    }).catch(error => {
      if (["VERIFIER_QUEUE_FULL", "VERIFIER_QUEUE_TIMEOUT"].includes(error?.code)) request.resume();
      throw error;
    })
  );

  const server = http.createServer(async (request, response) => {
    applySecurityHeaders(response);
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const bridgePrefix = "/api/v1/robot-bridge";
      const isBridgeRoute = url.pathname === bridgePrefix || url.pathname.startsWith(`${bridgePrefix}/`);
      // A bridge client capability is never an alternate login, admin, record,
      // scene or controller credential. Existing route authorization is intact.
      if (request.headers["x-robot-bridge-client"] !== undefined && !isBridgeRoute) {
        throw new RobotBridgeError(403, "CLIENT_CAPABILITY_SCOPE");
      }
      if (isBridgeRoute) {
        if (!robotBridge) throw new RobotBridgeError(404, "BRIDGE_DISABLED");
        if (!internalServiceAuth.loopbackAddress(request.socket?.remoteAddress)) {
          throw new RobotBridgeError(403, "BRIDGE_LOOPBACK_ONLY");
        }
        assertRequestSameOrigin(request);
        if (url.search) throw new RobotBridgeError(400, "BRIDGE_QUERY_NOT_ALLOWED");
        const readBridgeBody = async () => {
          requireJsonRequest(request);
          return parseJsonObject(await readRequestBody(request, 64 * 1024), "ROBOT_BRIDGE");
        };
        if (url.pathname === `${bridgePrefix}/controllers` && request.method === "POST") {
          if (request.headers["x-robot-bridge-client"] !== undefined) {
            throw new RobotBridgeError(403, "CLIENT_CAPABILITY_SCOPE");
          }
          const principal = await requirePrincipal(request);
          const body = await readBridgeBody();
          assertAllowedFields(body, new Set(), "ROBOT_BRIDGE");
          writeJson(response, 201, robotBridge.register(principal.user.id));
          return;
        }
        const controllerMatch = url.pathname.match(/^\/api\/v1\/robot-bridge\/controllers\/([a-f0-9]{32})\/(next|results|close|trace)$/);
        if (controllerMatch) {
          if (request.headers["x-robot-bridge-client"] !== undefined) {
            throw new RobotBridgeError(403, "CLIENT_CAPABILITY_SCOPE");
          }
          const principal = await requirePrincipal(request);
          const [, bridgeId, operation] = controllerMatch;
          robotBridge.authorizeController(bridgeId, principal.user.id, request.headers["x-robot-bridge-controller"]);
          if (operation === "next" && request.method === "GET") {
            const abort = new AbortController();
            const cancel = () => abort.abort();
            response.once("close", cancel);
            try {
              const result = await robotBridge.next(bridgeId, abort.signal);
              if (!response.destroyed) writeJson(response, 200, result);
            } finally { response.removeListener("close", cancel); }
            return;
          }
          if (operation === "results" && request.method === "POST") {
            writeJson(response, 200, robotBridge.complete(bridgeId, await readBridgeBody()));
            return;
          }
          if (operation === "close" && request.method === "POST") {
            const body = await readBridgeBody();
            assertAllowedFields(body, new Set(), "ROBOT_BRIDGE");
            writeJson(response, 200, robotBridge.closeController(bridgeId));
            return;
          }
          if (operation === "trace" && request.method === "GET") {
            writeJson(response, 200, robotBridge.trace(bridgeId));
            return;
          }
          throw new RobotBridgeError(405, "BRIDGE_METHOD_NOT_ALLOWED");
        }
        const clientMatch = url.pathname.match(/^\/api\/v1\/robot-bridge\/([a-f0-9]{32})\/(commands(?:\/([A-Za-z0-9_-]{1,128}))?|trace)$/);
        if (clientMatch) {
          const [, bridgeId, operation, requestId] = clientMatch;
          robotBridge.authorizeClient(bridgeId, request.headers["x-robot-bridge-client"]);
          if (operation === "commands" && request.method === "POST") {
            const result = robotBridge.submit(bridgeId, await readBridgeBody());
            writeJson(response, ["queued", "dispatched"].includes(result.status) ? 202 : 200, result);
            return;
          }
          if (requestId && request.method === "GET") {
            writeJson(response, 200, robotBridge.status(bridgeId, requestId));
            return;
          }
          if (operation === "trace" && request.method === "GET") {
            writeJson(response, 200, robotBridge.trace(bridgeId));
            return;
          }
          throw new RobotBridgeError(405, "BRIDGE_METHOD_NOT_ALLOWED");
        }
        throw new RobotBridgeError(404, "BRIDGE_ROUTE_NOT_FOUND");
      }
      if (url.pathname === "/api/v1/internal/platform/score-records") {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "internal score records endpoint only accepts GET", { Allow: "GET" });
        }
        if (platformServiceSecret === null || platformServiceReplayWindow === null
          || !internalServiceAuth.loopbackAddress(request.socket?.remoteAddress)) {
          throw new HttpError(403, "INTERNAL_SERVICE_FORBIDDEN", "internal score service authentication failed");
        }
        const serviceHeader = request.headers[internalServiceAuth.SERVICE_HEADER];
        if (Array.isArray(serviceHeader)) {
          throw new HttpError(403, "INTERNAL_SERVICE_FORBIDDEN", "internal score service authentication failed");
        }
        try {
          internalServiceAuth.verifyServiceRequest(
            serviceHeader,
            platformServiceSecret,
            request.url,
            platformServiceReplayWindow,
            { nowSeconds: platformServiceNowSeconds() }
          );
        } catch (_error) {
          throw new HttpError(403, "INTERNAL_SERVICE_FORBIDDEN", "internal score service authentication failed");
        }
        const pageRequest = parseRecordPage(url) || { page: 1, pageSize: 1000 };
        const records = await submissionStore.listBestSubmittedRecords();
        const selected = paginateRecords(records, pageRequest.page, pageRequest.pageSize);
        writeJson(response, 200, recordsResponse(selected.records, selected.pagination));
        return;
      }
      if (url.pathname === "/api/v1/auth/sso/jump") {
        if (request.method !== "GET") {
          writeOfficialSsoErrorPage(response, new OfficialSsoError(1001, "SSO endpoint only accepts GET"));
          return;
        }
        const ip = officialSsoClientIp(request);
        let parameters = null;
        try {
          enforceOfficialSsoRateLimit(ip, Date.now());
          if (officialSsoSecret === null || officialSsoReplayStore === null) {
            throw new OfficialSsoError(1004, "official SSO is not configured");
          }
          parameters = verifySsoRequest(request.url, officialSsoSecret, (
            typeof options.officialSsoNow === "function" ? options.officialSsoNow() : Date.now()
          ));
          const authenticated = await officialSsoReplayStore.consume(parameters, () => (
            authStore.loginExternalIdentity({
              officialUserId: parameters.user_id,
              officialTeamId: parameters.team_id,
              group: parameters.group_type,
              teamName: parameters.team_name
            })
          ));
          await officialSsoReplayStore.audit({
            userId: parameters.user_id,
            sourceTimestamp: parameters.timestamp,
            ip,
            result: "success"
          }).catch(() => { officialSsoAuditFailures += 1; });
          response.writeHead(302, {
            Location: "/portal.html",
            "Set-Cookie": authCookie(authenticated.token, authStore.sessionTtlMs / 1000, {
              secure: secureCookieForRequest(request),
              sameSite: "Lax"
            }),
            "Cache-Control": "no-store, max-age=0",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff"
          });
          response.end();
        } catch (error) {
          const publicError = error instanceof OfficialSsoError
            ? error
            : new OfficialSsoError(1004, error instanceof AuthStoreError ? error.code : "SSO processing failed");
          if (officialSsoReplayStore !== null && !publicError.rateLimited) {
            await officialSsoReplayStore.audit({
              userId: parameters?.user_id || null,
              sourceTimestamp: parameters?.timestamp || null,
              ip,
              result: "failure",
              code: publicError.code,
              detail: publicError.detail
            }).catch(() => { officialSsoAuditFailures += 1; });
          }
          writeOfficialSsoErrorPage(response, publicError);
        }
        return;
      }
      if (url.pathname === "/api/health") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "health endpoint only accepts GET", { Allow: "GET, HEAD" });
        }
        await Promise.all([
          submissionStore.ready,
          authStore.ready,
          batchStore.ready,
          rankedBatchStore.ready,
          ...[...mapConfigPools.values()].flatMap(pool => (
            [...pool.values()].map(store => store.ready)
          ))
        ]);
        const authStatus = await authStore.status();
        const verificationStatus = verificationQueue.status();
        const runArchiveStorage = submissionStore.storageStatus();
        const body = {
          schemaVersion: SERVICE_SCHEMA_VERSION,
          status: "ok",
          service: "chenlong-simulation-backend",
          version: PACKAGE_VERSION,
          authoritative: false,
          runArchiveStorage,
          capabilities: {
            staticHosting: true,
            runRecordVerification: true,
            sessionArchive: true,
            recordDraftArchive: true,
            ownerRecordSubmission: true,
            batchEvaluation: true,
            rankedBatchEvaluation: true,
            singleDataDirectoryWriter: true,
            batchSlotCount: 5,
            batchApiSchemaVersion: BATCH_API_RESPONSE_SCHEMA_VERSION,
            batchOpenListSchemaVersion: BATCH_OPEN_LIST_SCHEMA_VERSION,
            rankedEvaluationApiSchemaVersion: RANKED_EVALUATION_API_SCHEMA_VERSION,
            rankedRankingSchemaVersion: RANKED_RANKING_SCHEMA_VERSION,
            rankedCompetitionId: RANKED_COMPETITION_ID,
            maxDiscoveredOpenBatches: MAX_DISCOVERED_OPEN_BATCHES,
            authentication: true,
            publishedMapConfiguration: true,
            teamAssignedMapPools: true,
            mapPoolCounts: MAP_POOL_COUNTS,
            mapConfigSchemaVersion: MAP_CONFIG_SCHEMA_VERSION,
            mapConfigUpdateSchemaVersion: MAP_CONFIG_UPDATE_SCHEMA_VERSION,
            mapConfigBindingSchemaVersion: MAP_CONFIG_BINDING_SCHEMA_VERSION,
            roles: ["user", "admin"],
            authCookieName: AUTH_COOKIE_NAME,
            authSessionTtlMs: authStatus.sessionTtlMs,
            bootstrapAdminPolicy: "first_registered_user_when_store_is_empty",
            bootstrapAdminPending: authStatus.bootstrapAdminPending,
            authUserCount: authStatus.userCount,
            maxAuthUsers: authStatus.maxUsers,
            maxAuthSessions: authStatus.maxSessions,
            maxAuthSessionsPerUser: authStatus.maxSessionsPerUser,
            maxPasswordOperations: authStatus.maxPasswordOperations,
            maxPasswordQueue: authStatus.maxPasswordQueue,
            passwordQueueTimeoutMs: authStatus.passwordQueueTimeoutMs,
            maxAuthMutationsPerBatch: authStatus.maxMutationsPerBatch,
            authMutationBatchWindowMs: authStatus.mutationBatchWindowMs,
            maxAuthMutationQueue: authStatus.maxMutationQueue,
            queuedAuthMutations: authStatus.queuedMutations,
            processingAuthMutationBatch: authStatus.processingMutationBatch,
            registrationOpen: authStatus.registrationOpen,
            registrationWindowMs,
            maxRegistrationAttempts,
            officialSsoConfigured: officialSsoSecret !== null,
            officialSsoAttemptWindowMs,
            maxOfficialSsoAttempts,
            maxOfficialSsoAttemptsPerIp,
            officialSsoAuditFailures,
            sessionSchemaVersion: SESSION_SCHEMA_VERSION,
            challengeIds: Object.keys(LOCAL_CHALLENGES),
            acceptedRunRecordSchemas: [SCHEMA_VERSION, DETERMINISTIC_LEGACY_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION],
            maxBodyBytes: maximumRecordBytes,
            verifyTimeoutMs: workerTimeoutMs,
            maxConcurrentVerifications: maximumConcurrentVerifications,
            maxQueuedVerifications: maximumQueuedVerifications,
            verificationQueueTimeoutMs,
            activeVerifications: verificationStatus.active,
            queuedVerifications: verificationStatus.queued,
            sessionTtlMs: submissionStore.sessionTtlMs,
            maxSessions: submissionStore.maxSessions,
            maxSubmissionsPerSession: submissionStore.maxSubmissionsPerSession,
            maxStorageBytes: submissionStore.maxStorageBytes
          }
        };
        if (request.method === "HEAD") {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end();
        } else {
          writeJson(response, 200, body);
        }
        return;
      }

      if (url.pathname === "/api/v1/auth/register") {
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "registration endpoint only accepts POST", { Allow: "POST" });
        }
        assertRequestSameOrigin(request);
        requireJsonRequest(request);
        const body = parseJsonObject(await readRequestBody(request, AUTH_BODY_LIMIT_BYTES), "REGISTER");
        assertAllowedFields(body, new Set(["username", "password", "displayName", "teamAction", "teamName", "inviteCode", "group"]), "REGISTER");
        enforceRegistrationRateLimit(Date.now());
        const created = await authStore.register(body);
        writeJson(response, 201, authResponse(created, {
          bootstrapAdmin: created.bootstrapAdmin,
          teamInviteCode: created.teamInviteCode
        }), {
          "Set-Cookie": authCookie(created.token, authStore.sessionTtlMs / 1000, { secure: secureCookieForRequest(request) })
        });
        return;
      }

      if (url.pathname === "/api/v1/auth/login") {
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "login endpoint only accepts POST", { Allow: "POST" });
        }
        assertRequestSameOrigin(request);
        requireJsonRequest(request);
        const body = parseJsonObject(await readRequestBody(request, AUTH_BODY_LIMIT_BYTES), "LOGIN");
        assertAllowedFields(body, new Set(["username", "password"]), "LOGIN");
        const now = Date.now();
        const attemptKey = loginAttemptKey(request, body.username);
        enforceLoginRateLimit(attemptKey, now);
        let authenticated;
        try {
          authenticated = await authStore.login({ ...body, administratorsOnly: true });
        } catch (error) {
          if (error instanceof AuthStoreError && error.code === "INVALID_CREDENTIALS") {
            recordFailedLogin(attemptKey, now);
          }
          throw error;
        }
        loginAttempts.delete(attemptKey);
        writeJson(response, 200, authResponse(authenticated), {
          "Set-Cookie": authCookie(authenticated.token, authStore.sessionTtlMs / 1000, { secure: secureCookieForRequest(request) })
        });
        return;
      }

      if (url.pathname === "/api/v1/auth/logout") {
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "logout endpoint only accepts POST", { Allow: "POST" });
        }
        assertRequestSameOrigin(request);
        requireJsonRequest(request);
        const body = parseJsonObject(await readRequestBody(request, AUTH_BODY_LIMIT_BYTES), "LOGOUT");
        assertAllowedFields(body, new Set(), "LOGOUT");
        await authStore.logout(parseAuthCookie(request));
        writeJson(response, 200, {
          schemaVersion: AUTH_RESPONSE_SCHEMA_VERSION,
          authenticated: false,
          authoritative: false
        }, {
          "Set-Cookie": authCookie("", 0, { secure: secureCookieForRequest(request), clear: true })
        });
        return;
      }

      if (url.pathname === "/api/v1/auth/me") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "current-user endpoint only accepts GET", { Allow: "GET, HEAD" });
        }
        const principal = await requirePrincipal(request);
        const body = authResponse(principal);
        if (request.method === "HEAD") {
          const serialized = `${JSON.stringify(body)}\n`;
          response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(serialized)
          });
          response.end();
        } else {
          writeJson(response, 200, body);
        }
        return;
      }

      if (url.pathname === "/api/v1/auth/team-invite") {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "team invite endpoint only accepts GET", { Allow: "GET" });
        }
        if (url.search !== "") {
          throw new HttpError(400, "TEAM_INVITE_INVALID_QUERY", "team invite endpoint does not accept query parameters");
        }
        const principal = await requirePrincipal(request);
        const invite = await authStore.getTeamInviteForUser(principal.user.id);
        writeJson(response, 200, {
          schemaVersion: "chenlong.team-invite/v1",
          teamName: invite.teamName,
          inviteCode: invite.inviteCode,
          authoritative: false
        });
        return;
      }

      if (url.pathname === "/api/v1/records") {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "records endpoint only accepts GET", { Allow: "GET" });
        }
        const principal = await requirePrincipal(request);
        const pageRequest = (url.searchParams.has("page") || url.searchParams.has("pageSize"))
          ? parseRecordPage(url) : null;
        const records = await submissionStore.listRecords({
          ownerUserId: principal.user.id,
          expectedScope: "single",
          limit: pageRequest ? DEFAULT_MAX_RECORD_LIST_ITEMS : (parsePersonalRecordLimit(url) || LEGACY_RECORD_LIST_ITEMS)
        });
        const selected = pageRequest ? paginateRecords(records, pageRequest.page, pageRequest.pageSize) : null;
        const visibleRecords = selected ? selected.records : records;
        writeJson(response, 200, recordsResponse(
          await Promise.all(visibleRecords.map(decorateRecord)),
          selected?.pagination || null
        ));
        return;
      }

      const mapConfigTaskMatch = url.pathname.match(MAP_CONFIG_TASK_ROUTE);
      if (url.pathname === "/api/v1/map-config" || mapConfigTaskMatch) {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "map configuration endpoint only accepts GET", {
            Allow: "GET"
          });
        }
        const principal = await requirePrincipal(request);
        if (url.search !== "") {
          throw new HttpError(400, "MAP_CONFIG_INVALID_QUERY", "map configuration endpoint does not accept query parameters");
        }
        const taskId = mapConfigTaskMatch?.[1] || GUANGYANG_ISLAND_CONFIG.taskId;
        const { store } = assignedMapStore(taskId, principal.teamId);
        writeJson(response, 200, await store.publicConfig());
        return;
      }

      if (url.pathname === ADMIN_MAP_POOLS_PATH) {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "administrator map pools endpoint only accepts GET", {
            Allow: "GET"
          });
        }
        await requireAdmin(request);
        if (url.search !== "") {
          throw new HttpError(400, "MAP_POOL_INVALID_QUERY", "administrator map pools endpoint does not accept query parameters");
        }
        writeJson(response, 200, await adminMapPoolsResponse());
        return;
      }

      const adminMapConfigVariantMatch = url.pathname.match(ADMIN_MAP_CONFIG_VARIANT_ROUTE);
      const adminMapConfigTaskMatch = url.pathname.match(ADMIN_MAP_CONFIG_TASK_ROUTE);
      if (url.pathname === "/api/v1/admin/map-config" || adminMapConfigTaskMatch || adminMapConfigVariantMatch) {
        if (request.method !== "GET" && request.method !== "PUT") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "administrator map configuration endpoint only accepts GET or PUT", {
            Allow: "GET, PUT"
          });
        }
        await requireAdmin(request);
        if (url.search !== "") {
          throw new HttpError(400, "MAP_CONFIG_INVALID_QUERY", "administrator map configuration endpoint does not accept query parameters");
        }
        const taskId = adminMapConfigVariantMatch?.[1]
          || adminMapConfigTaskMatch?.[1]
          || GUANGYANG_ISLAND_CONFIG.taskId;
        const pool = mapPoolForTask(taskId);
        const requestedVariantId = adminMapConfigVariantMatch?.[2] || "map-01";
        if (!MAP_POOL_VARIANT_ID_PATTERN.test(requestedVariantId)
          || variantNumber(requestedVariantId) > MAP_POOL_COUNTS[taskId]) {
          throw new HttpError(404, "MAP_VARIANT_NOT_FOUND", "requested map variant is not registered by this task");
        }
        const store = pool.get(requestedVariantId);
        if (!store) throw new HttpError(500, "MAP_POOL_CORRUPTED", "requested map variant is unavailable");
        if (request.method === "GET") {
          writeJson(response, 200, await store.publicConfig());
          return;
        }
        assertRequestSameOrigin(request);
        requireJsonRequest(request);
        const body = parseJsonObject(
          await readRequestBody(request, MAP_CONFIG_BODY_LIMIT_BYTES),
          "MAP_CONFIG"
        );
        writeJson(response, 200, await store.update(body));
        return;
      }

      const recordRunDataMatch = url.pathname.match(RECORD_RUN_DATA_ROUTE);
      if (recordRunDataMatch) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "record replay endpoint only accepts GET", { Allow: "GET, HEAD" });
        }
        const principal = await requirePrincipal(request);
        const submissionId = recordRunDataMatch[1];
        const archived = await submissionStore.findRecordMetadata(submissionId, {
          ownerUserId: principal.user.id,
          expectedScope: "single"
        });
        const stored = archived.draftManifest
          ? await submissionStore.readDraft(
              archived.session.sessionId,
              submissionId,
              null,
              { skipAuthorization: true }
            )
          : await submissionStore.readRecord(
              archived.session.sessionId,
              submissionId,
              null,
              maximumRecordBytes,
              { skipAuthorization: true }
            );
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": stored.buffer.length,
          "Content-Disposition": `inline; filename="${submissionId}.json"`,
          "Cache-Control": "no-store, max-age=0",
          "X-Content-SHA256": stored.manifest.record.sha256
        });
        if (request.method === "HEAD") response.end();
        else response.end(stored.buffer);
        return;
      }

      const recordSubmitMatch = url.pathname.match(RECORD_SUBMIT_ROUTE);
      if (recordSubmitMatch) {
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "record submit endpoint only accepts POST", { Allow: "POST" });
        }
        const principal = await requirePrincipal(request);
        assertRequestSameOrigin(request);
        requireJsonRequest(request);
        const body = parseJsonObject(await readRequestBody(request, AUTH_BODY_LIMIT_BYTES), "RECORD_SUBMIT");
        assertAllowedFields(body, new Set(), "RECORD_SUBMIT");
        const recordId = recordSubmitMatch[1];
        const outcome = await withVerificationCapacity(async () => {
          if (response.destroyed) {
            throw new HttpError(499, "CLIENT_CLOSED_REQUEST", "client disconnected before verification started");
          }
          // Load the potentially large draft only after a bounded queue slot is
          // available. A 500-user submit wave therefore cannot retain hundreds
          // of full run-record buffers while waiting for a worker.
          const archived = await submissionStore.findRecord(recordId, {
            ownerUserId: principal.user.id,
            expectedScope: "single"
          });
          if (archived.summary.recordState === "submitted") {
            if (archived.draftManifest) {
              await submissionStore.promoteDraftToSubmission(
                archived.session.sessionId,
                recordId,
                principal.user.id
              );
            }
            return {
              statusCode: 200,
              receipt: recordSubmitReceipt({ manifest: archived.manifest, report: archived.report }, true)
            };
          }
          if (!archived.draftManifest || !Buffer.isBuffer(archived.buffer)) {
            throw new HttpError(409, "RECORD_DRAFT_MISSING", "saved record draft is unavailable");
          }
          const privateSession = await submissionStore.readSession(archived.session.sessionId);
          submissionStore.assertSessionOwner(privateSession, principal.user.id);
          const verification = await runVerificationBuffer(
            archived.buffer,
            response,
            privateSession.challenge.runDefinition
          );
          submissionStore.assertRecordMatchesSession(privateSession, verification.recordMetadata);
          const reportBuffer = Buffer.from(serializeReport(verification.report));
          const saved = await submissionStore.saveVerifiedSingleSubmission(
            privateSession.sessionId,
            principal.user.id,
            verification.buffer,
            reportBuffer,
            verification.report,
            verification.recordMetadata
          );
          await submissionStore.promoteDraftToSubmission(
            privateSession.sessionId,
            saved.manifest.submissionId,
            principal.user.id
          );
          return {
            statusCode: saved.duplicate ? 200 : 201,
            receipt: recordSubmitReceipt(saved, saved.duplicate)
          };
        });
        writeJson(response, outcome.statusCode, outcome.receipt);
        return;
      }

      const recordMatch = url.pathname.match(RECORD_ROUTE);
      if (recordMatch) {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "record detail endpoint only accepts GET", { Allow: "GET" });
        }
        const principal = await requirePrincipal(request);
        const stored = await submissionStore.findRecord(recordMatch[1], {
          ownerUserId: principal.user.id,
          expectedScope: "single"
        });
        writeJson(response, 200, recordDetailResponse(stored, await authStore.getPublicUser(stored.summary.ownerUserId)));
        return;
      }

      if (url.pathname === "/api/v1/admin/users") {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "administrator users endpoint only accepts GET", {
            Allow: "GET"
          });
        }
        await requireAdmin(request);
        if (url.search !== "") {
          throw new HttpError(400, "ADMIN_USERS_INVALID_QUERY", "administrator users endpoint does not accept query parameters");
        }
        writeJson(response, 200, adminUsersResponse(await authStore.listAdminUsers()));
        return;
      }

      const adminUserMatch = url.pathname.match(ADMIN_USER_ROUTE);
      if (adminUserMatch) {
        if (request.method !== "PATCH") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "administrator user endpoint only accepts PATCH", {
            Allow: "PATCH"
          });
        }
        await requireAdmin(request);
        assertRequestSameOrigin(request);
        requireJsonRequest(request);
        const body = parseJsonObject(
          await readRequestBody(request, AUTH_BODY_LIMIT_BYTES),
          "ADMIN_USER_UPDATE"
        );
        const requiredFields = new Set(["teamName", "group"]);
        assertAllowedFields(body, requiredFields, "ADMIN_USER_UPDATE");
        const missingField = [...requiredFields].find(field => !Object.hasOwn(body, field));
        if (missingField) {
          throw new HttpError(
            400,
            "ADMIN_USER_UPDATE_MISSING_FIELD",
            `missing administrator user update field: ${missingField}`
          );
        }
        const result = await authStore.updateManagedUser(adminUserMatch[1], body);
        writeJson(response, 200, adminUserUpdateResponse(result));
        return;
      }

      if (url.pathname === "/api/v1/admin/records") {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "administrator records endpoint only accepts GET", { Allow: "GET" });
        }
        await requireAdmin(request);
        const pageRequest = parseRecordPage(url);
        const records = await submissionStore.listRecords({
          includeAll: true,
          expectedScope: "single",
          recordState: "submitted",
          includeCapabilityUsage: true,
          includeAutonomyMode: true,
          limit: pageRequest ? DEFAULT_MAX_RECORD_LIST_ITEMS : LEGACY_RECORD_LIST_ITEMS
        });
        const selected = pageRequest ? paginateRecords(records, pageRequest.page, pageRequest.pageSize) : null;
        const visibleRecords = selected ? selected.records : records;
        writeJson(response, 200, recordsResponse(
          await Promise.all(visibleRecords.map(decorateRecord)),
          selected?.pagination || null
        ));
        return;
      }

      if (url.pathname === "/api/v1/admin/team-task-scores") {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "administrator team-task scores endpoint only accepts GET", { Allow: "GET" });
        }
        await requireAdmin(request);
        if (url.search !== "") {
          throw new HttpError(400, "TEAM_TASK_SCORES_INVALID_QUERY", "administrator team-task scores endpoint does not accept query parameters");
        }
        writeJson(response, 200, {
          schemaVersion: "chenlong.python-team-task-scores/v1",
          records: teamTaskBestRecords(await submissionStore.listBestSubmittedRecords()),
          authoritative: false
        });
        return;
      }

      const adminRecordMatch = url.pathname.match(ADMIN_RECORD_ROUTE);
      if (adminRecordMatch) {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "administrator record detail endpoint only accepts GET", { Allow: "GET" });
        }
        await requireAdmin(request);
        const stored = await submissionStore.findRecord(adminRecordMatch[1], {
          includeAll: true,
          expectedScope: "single",
          includeCapabilityUsage: true,
          includeAutonomyMode: true
        });
        if (stored.summary.recordState !== "submitted") {
          throw new HttpError(404, "RECORD_NOT_FOUND", "record not found");
        }
        writeJson(response, 200, recordDetailResponse(
          stored,
          await authStore.getPublicUser(stored.summary.ownerUserId),
          { admin: true }
        ));
        return;
      }

      if (url.pathname === ADMIN_RANKED_RANKING_PATH) {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "administrator ranked ranking only accepts GET", {
            Allow: "GET"
          });
        }
        const principal = await requireAdmin(request);
        enforceRankedRankingReadLimit(principal);
        const pagination = parseRankedRankingPagination(url);
        const snapshot = await trustedRankedGlobalSnapshot();
        const page = {
          total: snapshot.entries.length,
          entries: snapshot.entries.slice(pagination.offset, pagination.offset + pagination.limit)
        };
        const users = await Promise.all(page.entries.map(entry => authStore.getPublicUser(entry.ownerUserId)));
        const entries = page.entries.map((entry, index) => adminRankedResult(entry, users[index]));
        writeJson(response, 200, rankedRankingResponse("admin", pagination, page, entries));
        return;
      }

      if (url.pathname === `${RANKED_EVALUATION_BASE_PATH}/ranking`) {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "ranked ranking only accepts GET", { Allow: "GET" });
        }
        const principal = await requirePrincipal(request);
        enforceRankedRankingReadLimit(principal);
        const pagination = parseRankedRankingPagination(url);
        const snapshot = await trustedRankedGlobalSnapshot();
        const page = {
          total: snapshot.entries.length,
          entries: snapshot.entries.slice(pagination.offset, pagination.offset + pagination.limit)
        };
        const entries = page.entries.map(anonymousRankedResult);
        writeJson(response, 200, rankedRankingResponse("anonymous", pagination, page, entries));
        return;
      }

      if (url.pathname === `${RANKED_EVALUATION_BASE_PATH}/me`) {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "ranked owner endpoint only accepts GET", { Allow: "GET" });
        }
        const principal = await requirePrincipal(request);
        const ownerView = await withBatchOperationLock(`ranked-owner:${principal.user.id}`, () => (
          withRankedReadBarrier(async () => {
          await prepareRankedOwner(principal.user.id);
          const before = await rankedBatchStore.readRankedOwnerBatchEvidenceForServer({
            ownerUserId: principal.user.id
          });
          const view = await rankedBatchStore.readRankedBatchForOwner({ ownerUserId: principal.user.id });
          if (before?.phase === "open" && view?.batch.phase === "finalized") {
            invalidateRankedGlobalSnapshot();
            await prepareRankedOwner(principal.user.id);
          }
          return view;
          })
        ));
        const result = ownerView?.batch.phase === "finalized"
          ? await trustedRankedOwnerResult(principal.user.id)
          : null;
        const evaluation = ownerView
          ? rankedOwnerEvaluation(ownerView, result ? anonymousRankedResult(result) : null)
          : null;
        writeJson(response, 200, rankedEvaluationApiResponse(evaluation));
        return;
      }

      if (url.pathname === RANKED_EVALUATION_BASE_PATH) {
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "ranked evaluation endpoint only accepts POST", {
            Allow: "POST"
          });
        }
        let principal;
        try {
          principal = await requirePrincipal(request);
        } catch (error) {
          request.resume();
          throw error;
        }
        assertRequestSameOrigin(request);
        requireJsonRequest(request);
        const body = parseJsonObject(await readRequestBody(request, BATCH_BODY_LIMIT_BYTES), "RANKED_BATCH");
        assertAllowedFields(body, new Set(["source", "teamId"]), "RANKED_BATCH");
        if (typeof body.source !== "string"
          || Buffer.byteLength(body.source, "utf8") > MAX_RANKED_LOCKED_SOURCE_BYTES) {
          throw new HttpError(400, "RANKED_SOURCE_TOO_LARGE",
            `ranked source must be at most ${MAX_RANKED_LOCKED_SOURCE_BYTES} UTF-8 bytes`);
        }
        const stored = await withBatchOperationLock(`ranked-owner:${principal.user.id}`, () => (
          withRankedReadBarrier(async () => {
          let before;
          try {
            before = await prepareRankedOwner(principal.user.id);
          } catch (error) {
            // A crash after the permanent reservation but before the batch
            // directory is created is resumable only through createRankedBatch,
            // which rechecks the exact locked source digest and team. All other
            // preparation failures remain fail-closed.
            if (!(error instanceof BatchEvaluationStoreError)
              || error.code !== "RANKED_ATTEMPT_RESERVATION_INCOMPLETE") throw error;
            before = null;
          }
          const createdOrRecovered = await rankedBatchStore.createRankedBatch({
            ownerUserId: principal.user.id,
            source: body.source,
            teamId: body.teamId
          });
          if (createdOrRecovered.created || before?.phase !== createdOrRecovered.batch.phase) {
            invalidateRankedGlobalSnapshot();
          }
          await prepareRankedOwner(principal.user.id);
          return createdOrRecovered;
          })
        ));
        const result = stored.batch.phase === "finalized"
          ? await trustedRankedOwnerResult(principal.user.id)
          : null;
        const { created, ...ownerView } = stored;
        writeJson(response, created ? 201 : 200, rankedEvaluationApiResponse({
          ...rankedOwnerEvaluation(ownerView, result ? anonymousRankedResult(result) : null)
        }, { created }));
        return;
      }

      const rankedCurrentSlotLeaseMatch = url.pathname.match(RANKED_CURRENT_SLOT_LEASE_ROUTE);
      if (rankedCurrentSlotLeaseMatch) {
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "ranked slot lease endpoint only accepts POST", {
            Allow: "POST"
          });
        }
        let principal;
        try {
          principal = await requirePrincipal(request);
        } catch (error) {
          request.resume();
          throw error;
        }
        assertRequestSameOrigin(request);
        requireJsonRequest(request);
        const body = parseJsonObject(await readRequestBody(request, SESSION_BODY_LIMIT_BYTES), "RANKED_LEASE");
        assertAllowedFields(body, new Set(["slotIndex"]), "RANKED_LEASE");
        const batchId = rankedCurrentSlotLeaseMatch[1];
        const leased = await withBatchOperationLock(`ranked-owner:${principal.user.id}`, () => (
          withRankedReadBarrier(() => withBatchOperationLock(`ranked:${batchId}`, async () => {
          const slotIndex = body.slotIndex;
          await prepareRankedBatch(principal.user.id, batchId);
          const serverSlot = await rankedBatchStore.readCurrentSlotForServer({
            ownerUserId: principal.user.id,
            batchId,
            slotIndex
          });
          const { challenge, runDefinition } = batchChallengeForPrivateLayout(serverSlot.privateLayoutSelection);
          let publicSession;
          let recovered = false;
          if (serverSlot.currentSlotBinding !== null) {
            const storedSession = await readBoundBatchSession(
              { sessionBinding: serverSlot.currentSlotBinding },
              principal.user.id,
              {
                expectedTeamId: serverSlot.lockedTeamId,
                expectedScope: {
                  scope: "ranked",
                  competitionId: RANKED_COMPETITION_ID,
                  batchId,
                  slotIndex
                }
              }
            );
            if (canonicalSha256(runDefinition) !== serverSlot.currentSlotBinding.runDefinitionDigest) {
              throw new HttpError(500, "BATCH_SESSION_BINDING_CORRUPTED",
                "current ranked layout no longer matches its session lease");
            }
            publicSession = submissionStore.publicSession(
              storedSession,
              (await submissionStore.listSubmissionManifests(storedSession.sessionId)).length
            );
            recovered = true;
          } else {
            const created = await submissionStore.createSession(
              serverSlot.lockedTeamId,
              challenge,
              principal.user.id,
              {
                scope: "ranked",
                competitionId: RANKED_COMPETITION_ID,
                batchId,
                slotIndex
              },
              { notAfter: serverSlot.expiresAt }
            );
            await rankedBatchStore.bindCurrentSlotSession({
              ownerUserId: principal.user.id,
              batchId,
              slotIndex,
              layoutCommitment: serverSlot.publicLayout.layoutCommitment,
              sessionId: created.session.sessionId,
              runId: created.session.runId,
              challengeDigest: created.session.challengeDigest,
              runDefinitionDigest: canonicalSha256(runDefinition),
              teamId: serverSlot.lockedTeamId
            });
            invalidateRankedGlobalSnapshot();
            publicSession = created.session;
          }
          const updated = await rankedBatchStore.readBatch({ ownerUserId: principal.user.id, batchId });
          return {
            updated,
            recovered,
            lease: {
              schemaVersion: RANKED_SLOT_LEASE_SCHEMA_VERSION,
              authoritative: false,
              recovered,
              competitionId: RANKED_COMPETITION_ID,
              batchId,
              slotIndex,
              layout: serverSlot.publicLayout,
              session: publicSession,
              runDefinition
            }
          };
          }))
        ));
        writeJson(
          response,
          leased.recovered ? 200 : 201,
          rankedEvaluationApiResponse(rankedOwnerEvaluation(leased.updated, null), { lease: leased.lease })
        );
        return;
      }

      const rankedSlotSubmissionsMatch = url.pathname.match(RANKED_SLOT_SUBMISSIONS_ROUTE);
      if (rankedSlotSubmissionsMatch) {
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "ranked slot submission endpoint only accepts POST", {
            Allow: "POST"
          });
        }
        const [, batchId, slotIndexSource, sessionId] = rankedSlotSubmissionsMatch;
        const slotIndex = Number(slotIndexSource);
        assertRequestSameOrigin(request);
        let principal;
        try {
          principal = await requirePrincipal(request);
        } catch (error) {
          request.resume();
          throw error;
        }
        let outcome;
        try {
          outcome = await withBatchOperationLock(`ranked-owner:${principal.user.id}`, () => (
            withRankedSubmissionBarrier(() => withBatchOperationLock(`ranked:${batchId}`, async () => {
            const batchEvidence = await prepareRankedBatch(principal.user.id, batchId);
            const execution = batchEvidence.slots[slotIndex - 1];
            if (!execution
              || execution.sessionBinding?.sessionId !== sessionId
              || execution.sessionBinding?.teamId !== batchEvidence.lockedTeamId) {
              throw new HttpError(409, "SLOT_SESSION_MISMATCH",
                "submission session does not match the ranked slot lease");
            }
            const session = await readBoundBatchSession(execution, principal.user.id, {
              expectedTeamId: batchEvidence.lockedTeamId,
              expectedScope: {
                scope: "ranked",
                competitionId: RANKED_COMPETITION_ID,
                batchId,
                slotIndex
              }
            });
            await onBatchSubmissionPrechecked?.({
              purpose: "ranked",
              competitionId: RANKED_COMPETITION_ID,
              batchId,
              slotIndex,
              sessionId
            });
            requireJsonRequest(request);
            const recordBuffer = await readRequestBody(request, maximumRecordBytes);
            const recordSha256 = crypto.createHash("sha256").update(recordBuffer).digest("hex");

            if (execution.verifiedReceipt !== null) {
              if (execution.verifiedReceipt.recordSha256 !== recordSha256) {
                throw new HttpError(409, "SLOT_ALREADY_FINALIZED",
                  `slot ${slotIndex} already has its only verified record`);
              }
              const stored = await submissionStore.readSubmission(
                session.sessionId,
                execution.verifiedReceipt.submissionId,
                null,
                { skipAuthorization: true }
              );
              return {
                stored: { ...stored, duplicate: true },
                updated: await rankedBatchStore.readBatch({ ownerUserId: principal.user.id, batchId }),
                duplicate: true
              };
            }
            if (!execution.current || execution.result !== null) {
              throw new HttpError(409, "SLOT_NOT_CURRENT", "ranked slot is no longer current");
            }

            const verification = await executeVerificationBuffer(
              recordBuffer,
              response,
              session.challenge.runDefinition
            );
            submissionStore.assertRecordMatchesSession(session, verification.recordMetadata);
            if (verification.recordMetadata?.sourceCodeDigest !== batchEvidence.sourceDigest) {
              throw new HttpError(409, "SOURCE_LOCKED",
                "run record source does not match the source locked for this ranked batch");
            }
            const result = verifiedRankedBatchResult(verification.report, verification.recordMetadata);
            const postVerificationEvidence = await rankedBatchStore.readRankedBatchEvidenceForServer({
              ownerUserId: principal.user.id,
              batchId
            });
            const postVerificationExecution = postVerificationEvidence.slots[slotIndex - 1];
            if (!postVerificationExecution?.current
              || postVerificationExecution.sessionBinding?.sessionId !== session.sessionId
              || postVerificationExecution.sessionBinding?.teamId !== batchEvidence.lockedTeamId
              || postVerificationExecution.verifiedReceipt !== null) {
              throw new HttpError(409, "SLOT_ALREADY_FINALIZED",
                `slot ${slotIndex} changed before its verified ranked result could be archived`);
            }
            const reportBuffer = Buffer.from(serializeReport(verification.report));
            const stored = await submissionStore.saveVerifiedBatchSubmission(
              session.sessionId,
              principal.user.id,
              verification.buffer,
              reportBuffer,
              verification.report,
              verification.recordMetadata,
              {
                scope: "ranked",
                competitionId: RANKED_COMPETITION_ID,
                batchId,
                slotIndex,
                notAfter: batchEvidence.expiresAt
              }
            );
            invalidateRankedGlobalSnapshot();
            const postArchiveEvidence = await rankedBatchStore.readRankedBatchEvidenceForServer({
              ownerUserId: principal.user.id,
              batchId
            });
            const postArchiveExecution = postArchiveEvidence.slots[slotIndex - 1];
            if (!postArchiveExecution?.current
              || postArchiveExecution.sessionBinding?.sessionId !== session.sessionId
              || postArchiveExecution.verifiedReceipt !== null) {
              throw new HttpError(409, "SLOT_ALREADY_FINALIZED",
                `slot ${slotIndex} changed before its archived ranked result could be committed`);
            }
            const updated = await rankedBatchStore.submitVerifiedSlotResult({
              ownerUserId: principal.user.id,
              batchId,
              slotIndex,
              sessionId: session.sessionId,
              submissionId: stored.manifest.submissionId,
              recordSha256: stored.manifest.record.sha256,
              reportSha256: stored.manifest.report.sha256,
              archivedAt: stored.manifest.receivedAt,
              result
            }, { allowExpiredCommit: true });
            await submissionStore.retireSessionForServer(
              session.sessionId,
              "batch_slot_completed"
            );
            invalidateRankedGlobalSnapshot();
            return { stored, updated, duplicate: Boolean(stored.duplicate) };
            }))
          ));
        } catch (error) {
          request.resume();
          throw error;
        }
        let finalResult = null;
        if (outcome.updated.batch.phase === "finalized") {
          finalResult = await trustedRankedOwnerResult(principal.user.id);
        }
        writeJson(response, outcome.duplicate ? 200 : 201, rankedEvaluationApiResponse(
          rankedOwnerEvaluation(outcome.updated, finalResult ? anonymousRankedResult(finalResult) : null), {
          duplicate: outcome.duplicate,
          submission: submissionReceipt(outcome.stored.manifest, outcome.stored.report, outcome.duplicate)
        }));
        return;
      }

      const rankedCloseMatch = url.pathname.match(RANKED_CLOSE_ROUTE);
      if (rankedCloseMatch) {
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "ranked close endpoint only accepts POST", { Allow: "POST" });
        }
        let principal;
        try {
          principal = await requirePrincipal(request);
        } catch (error) {
          request.resume();
          throw error;
        }
        assertRequestSameOrigin(request);
        requireJsonRequest(request);
        const body = parseJsonObject(await readRequestBody(request, SESSION_BODY_LIMIT_BYTES), "RANKED_CLOSE");
        assertAllowedFields(body, new Set(), "RANKED_CLOSE");
        const batchId = rankedCloseMatch[1];
        const stored = await withBatchOperationLock(`ranked-owner:${principal.user.id}`, () => (
          withRankedReadBarrier(() => (
            withBatchOperationLock(`ranked:${batchId}`, async () => {
            const before = await prepareRankedBatch(principal.user.id, batchId);
            const closed = await rankedBatchStore.closeBatch({ ownerUserId: principal.user.id, batchId });
            if (before.phase !== closed.batch.phase) invalidateRankedGlobalSnapshot();
            await retireBatchSessions(await rankedBatchStore.readRankedBatchEvidenceForServer({
              ownerUserId: principal.user.id,
              batchId
            }));
            return closed;
            })
          ))
        ));
        const result = await trustedRankedOwnerResult(principal.user.id);
        writeJson(response, 200, rankedEvaluationApiResponse(
          rankedOwnerEvaluation(stored, result ? anonymousRankedResult(result) : null)
        ));
        return;
      }

      const rankedEvaluationMatch = url.pathname.match(RANKED_EVALUATION_ROUTE);
      if (rankedEvaluationMatch) {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "ranked evaluation detail only accepts GET", { Allow: "GET" });
        }
        const principal = await requirePrincipal(request);
        const batchId = rankedEvaluationMatch[1];
        const stored = await withBatchOperationLock(`ranked-owner:${principal.user.id}`, () => (
          withRankedReadBarrier(() => (
            withBatchOperationLock(`ranked:${batchId}`, async () => {
            const before = await prepareRankedBatch(principal.user.id, batchId);
            const viewed = await rankedBatchStore.readBatch({ ownerUserId: principal.user.id, batchId });
            if (before.phase !== viewed.batch.phase) {
              invalidateRankedGlobalSnapshot();
              await retireBatchSessions(await rankedBatchStore.readRankedBatchEvidenceForServer({
                ownerUserId: principal.user.id,
                batchId
              }));
            }
            return viewed;
            })
          ))
        ));
        const result = stored.batch.phase === "finalized"
          ? await trustedRankedOwnerResult(principal.user.id)
          : null;
        writeJson(response, 200, rankedEvaluationApiResponse(
          rankedOwnerEvaluation(stored, result ? anonymousRankedResult(result) : null)
        ));
        return;
      }

      if (url.pathname === "/api/v1/evaluation-batches") {
        if (request.method === "GET") {
          const query = [...url.searchParams.entries()];
          if (query.length !== 1 || query[0][0] !== "phase" || query[0][1] !== "open") {
            throw new HttpError(400, "INVALID_BATCH_LIST_QUERY", "batch discovery requires exactly phase=open");
          }
          const principal = await requirePrincipal(request);
          const batches = await batchStore.listOpenBatches({ ownerUserId: principal.user.id });
          for (const evidence of await batchStore.listBatchSessionEvidenceForServer()) {
            if (evidence.phase === "finalized") await retireBatchSessions(evidence);
          }
          writeJson(response, 200, {
            schemaVersion: BATCH_OPEN_LIST_SCHEMA_VERSION,
            authoritative: false,
            phase: "open",
            limit: MAX_DISCOVERED_OPEN_BATCHES,
            order: BATCH_OPEN_LIST_ORDER,
            batches
          });
          return;
        }
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "batch endpoint only accepts GET or POST", {
            Allow: "GET, POST"
          });
        }
        let principal;
        try {
          principal = await requirePrincipal(request);
        } catch (error) {
          request.resume();
          throw error;
        }
        assertRequestSameOrigin(request);
        requireJsonRequest(request);
        const body = parseJsonObject(await readRequestBody(request, BATCH_BODY_LIMIT_BYTES), "BATCH");
        assertAllowedFields(body, new Set(["source"]), "BATCH");
        const stored = await batchStore.createBatch({
          ownerUserId: principal.user.id,
          source: body.source
        });
        writeJson(response, 201, batchApiResponse(stored));
        return;
      }

      const batchCurrentSlotLeaseMatch = url.pathname.match(BATCH_CURRENT_SLOT_LEASE_ROUTE);
      if (batchCurrentSlotLeaseMatch) {
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "batch slot lease endpoint only accepts POST", { Allow: "POST" });
        }
        let principal;
        try {
          principal = await requirePrincipal(request);
        } catch (error) {
          request.resume();
          throw error;
        }
        assertRequestSameOrigin(request);
        requireJsonRequest(request);
        const body = parseJsonObject(await readRequestBody(request, SESSION_BODY_LIMIT_BYTES), "BATCH_LEASE");
        assertAllowedFields(body, new Set(["teamId", "slotIndex"]), "BATCH_LEASE");
        const batchId = batchCurrentSlotLeaseMatch[1];
        const leased = await withBatchOperationLock(batchId, async () => {
          const slotIndex = body.slotIndex;
          const batchSessionEvidence = await batchStore.readBatchSessionEvidenceForServer({
            ownerUserId: principal.user.id,
            batchId
          });
          await retireBatchSessions(batchSessionEvidence);
          const serverSlot = await batchStore.readCurrentSlotForServer({
            ownerUserId: principal.user.id,
            batchId,
            slotIndex
          });
          const { challenge, runDefinition } = batchChallengeForPrivateLayout(serverSlot.privateLayoutSelection);
          let publicSession;
          let recovered = false;
          if (serverSlot.currentSlotBinding !== null) {
            const storedSession = await readBoundBatchSession({
              sessionBinding: serverSlot.currentSlotBinding
            }, principal.user.id, {
              expectedScope: { scope: "practice", batchId, slotIndex }
            });
            const requestedTeamId = body.teamId === undefined ? null : normalizeParticipantId(body.teamId);
            if (requestedTeamId !== null && storedSession.teamId !== requestedTeamId) {
              throw new HttpError(409, "SLOT_LEASE_TEAM_MISMATCH", "current slot lease is bound to another teamId");
            }
            if (canonicalSha256(runDefinition) !== serverSlot.currentSlotBinding.runDefinitionDigest) {
              throw new HttpError(500, "BATCH_SESSION_BINDING_CORRUPTED", "current layout no longer matches its session lease");
            }
            publicSession = submissionStore.publicSession(
              storedSession,
              (await submissionStore.listSubmissionManifests(storedSession.sessionId)).length
            );
            recovered = true;
          } else {
            const leaseTeamId = normalizeParticipantId(body.teamId);
            const created = await submissionStore.createSession(
              leaseTeamId,
              challenge,
              principal.user.id,
              { scope: "practice", batchId, slotIndex },
              { notAfter: batchSessionEvidence.expiresAt }
            );
            await batchStore.bindCurrentSlotSession({
              ownerUserId: principal.user.id,
              batchId,
              slotIndex,
              layoutCommitment: serverSlot.publicLayout.layoutCommitment,
              sessionId: created.session.sessionId,
              runId: created.session.runId,
              challengeDigest: created.session.challengeDigest,
              runDefinitionDigest: canonicalSha256(runDefinition)
            });
            publicSession = created.session;
          }
          const updated = await batchStore.readBatch({ ownerUserId: principal.user.id, batchId });
          return {
            updated,
            recovered,
            lease: {
              schemaVersion: BATCH_SLOT_LEASE_SCHEMA_VERSION,
              authoritative: false,
              recovered,
              batchId,
              slotIndex,
              layout: serverSlot.publicLayout,
              session: publicSession,
              runDefinition
            }
          };
        });
        writeJson(response, leased.recovered ? 200 : 201, batchApiResponse(leased.updated, { lease: leased.lease }));
        return;
      }

      const batchSlotSubmissionsMatch = url.pathname.match(BATCH_SLOT_SUBMISSIONS_ROUTE);
      if (batchSlotSubmissionsMatch) {
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "batch slot submission endpoint only accepts POST", { Allow: "POST" });
        }
        const [, batchId, slotIndexSource, sessionId] = batchSlotSubmissionsMatch;
        const slotIndex = Number(slotIndexSource);
        assertRequestSameOrigin(request);
        let principal;
        try {
          principal = await requirePrincipal(request);
          const execution = await batchStore.readSlotExecutionForServer({
            ownerUserId: principal.user.id,
            batchId,
            slotIndex
          });
          if (execution.sessionBinding?.sessionId !== sessionId) {
            throw new HttpError(409, "SLOT_SESSION_MISMATCH", "submission session does not match the batch slot lease");
          }
        } catch (error) {
          request.resume();
          throw error;
        }
        await onBatchSubmissionPrechecked?.({ batchId, slotIndex, sessionId });
        requireJsonRequest(request);
        const recordBuffer = await readRequestBody(request, maximumRecordBytes);
        const recordSha256 = crypto.createHash("sha256").update(recordBuffer).digest("hex");
        const outcome = await withBatchOperationLock(batchId, async () => {
          const execution = await batchStore.readSlotExecutionForServer({
            ownerUserId: principal.user.id,
            batchId,
            slotIndex
          });
          if (execution.sessionBinding?.sessionId !== sessionId) {
            throw new HttpError(409, "SLOT_SESSION_MISMATCH", "submission session does not match the batch slot lease");
          }
          const session = await readBoundBatchSession(execution, principal.user.id, {
            expectedScope: { scope: "practice", batchId, slotIndex }
          });
          if (execution.verifiedReceipt !== null) {
            if (execution.verifiedReceipt.recordSha256 !== recordSha256) {
              throw new HttpError(409, "SLOT_ALREADY_FINALIZED",
                `slot ${slotIndex} already has its only verified record`);
            }
            const stored = await submissionStore.readSubmission(
              session.sessionId,
              execution.verifiedReceipt.submissionId,
              null,
              { skipAuthorization: true }
            );
            if (stored.manifest.record.sha256 !== recordSha256) {
              throw new HttpError(500, "BATCH_SUBMISSION_BINDING_CORRUPTED",
                "stored batch receipt does not match its archived submission");
            }
            await submissionStore.retireSessionForServer(
              session.sessionId,
              "batch_slot_completed"
            );
            return {
              stored: { ...stored, duplicate: true },
              updated: await batchStore.readBatch({ ownerUserId: principal.user.id, batchId }),
              duplicate: true
            };
          }

          const currentSlot = await batchStore.readCurrentSlotForServer({
            ownerUserId: principal.user.id,
            batchId,
            slotIndex
          });
          if (currentSlot.currentSlotBinding?.sessionId !== session.sessionId
            || currentSlot.publicLayout.layoutCommitment !== execution.layoutCommitment) {
            throw new HttpError(409, "SLOT_SESSION_MISMATCH",
              "current batch slot no longer matches its leased session and layout");
          }
          const archivedManifests = await submissionStore.listSubmissionManifests(session.sessionId);
          if (archivedManifests.length > 1) {
            throw new HttpError(500, "BATCH_SLOT_ARCHIVE_AMBIGUOUS",
              "batch slot session contains more than one archived submission");
          }
          if (archivedManifests.length === 1) {
            const archivedManifest = archivedManifests[0];
            if (archivedManifest.record?.sha256 !== recordSha256) {
              throw new HttpError(409, "SLOT_ALREADY_FINALIZED",
                `slot ${slotIndex} already archived a different record before its batch receipt`);
            }
            const stored = await submissionStore.readSubmission(
              session.sessionId,
              archivedManifest.submissionId,
              null,
              { skipAuthorization: true }
            );
            submissionStore.assertRecordMatchesSession(session, stored.manifest.run);
            if (stored.manifest.run?.sourceCodeDigest !== execution.sourceDigest) {
              throw new HttpError(500, "BATCH_SUBMISSION_BINDING_CORRUPTED",
                "archived batch source does not match its locked source");
            }
            const result = verifiedBatchResult(stored.report, stored.manifest.run);
            const updated = await batchStore.submitVerifiedSlotResult({
              ownerUserId: principal.user.id,
              batchId,
              slotIndex,
              sessionId: session.sessionId,
              submissionId: stored.manifest.submissionId,
              recordSha256: stored.manifest.record.sha256,
              result
            });
            await submissionStore.retireSessionForServer(
              session.sessionId,
              "batch_slot_completed"
            );
            return { stored: { ...stored, duplicate: true }, updated, duplicate: true };
          }

          const verification = await executeVerificationBuffer(
            recordBuffer,
            response,
            session.challenge.runDefinition
          );
          submissionStore.assertRecordMatchesSession(session, verification.recordMetadata);
          if (verification.recordMetadata?.sourceCodeDigest !== execution.sourceDigest) {
            throw new HttpError(409, "SOURCE_LOCKED", "run record source does not match the source locked for this batch");
          }
          const result = verifiedBatchResult(verification.report, verification.recordMetadata);
          const postVerificationExecution = await batchStore.readSlotExecutionForServer({
            ownerUserId: principal.user.id,
            batchId,
            slotIndex
          });
          if (postVerificationExecution.sessionBinding?.sessionId !== session.sessionId
            || postVerificationExecution.verifiedReceipt !== null) {
            throw new HttpError(409, "SLOT_ALREADY_FINALIZED",
              `slot ${slotIndex} changed before its verified result could be archived`);
          }
          const reportBuffer = Buffer.from(serializeReport(verification.report));
          const stored = await submissionStore.saveVerifiedBatchSubmission(
            session.sessionId,
            principal.user.id,
            verification.buffer,
            reportBuffer,
            verification.report,
            verification.recordMetadata,
            { scope: "practice", batchId, slotIndex }
          );
          const updated = await batchStore.submitVerifiedSlotResult({
            ownerUserId: principal.user.id,
            batchId,
            slotIndex,
            sessionId: session.sessionId,
            submissionId: stored.manifest.submissionId,
            recordSha256: stored.manifest.record.sha256,
            result
          });
          await submissionStore.retireSessionForServer(
            session.sessionId,
            "batch_slot_completed"
          );
          return { stored, updated, duplicate: Boolean(stored.duplicate) };
        });
        writeJson(response, outcome.duplicate ? 200 : 201, batchApiResponse(outcome.updated, {
          duplicate: outcome.duplicate,
          submission: submissionReceipt(outcome.stored.manifest, outcome.stored.report, outcome.duplicate)
        }));
        return;
      }

      const batchCloseMatch = url.pathname.match(BATCH_CLOSE_ROUTE);
      if (batchCloseMatch) {
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "batch close endpoint only accepts POST", { Allow: "POST" });
        }
        let principal;
        try {
          principal = await requirePrincipal(request);
        } catch (error) {
          request.resume();
          throw error;
        }
        assertRequestSameOrigin(request);
        requireJsonRequest(request);
        const body = parseJsonObject(await readRequestBody(request, SESSION_BODY_LIMIT_BYTES), "BATCH_CLOSE");
        assertAllowedFields(body, new Set(), "BATCH_CLOSE");
        const batchId = batchCloseMatch[1];
        const stored = await withBatchOperationLock(batchId, () => batchStore.closeBatch({
          ownerUserId: principal.user.id,
          batchId
        }));
        await retireBatchSessions(await batchStore.readBatchSessionEvidenceForServer({
          ownerUserId: principal.user.id,
          batchId
        }));
        writeJson(response, 200, batchApiResponse(stored));
        return;
      }

      const batchMatch = url.pathname.match(BATCH_ROUTE);
      if (batchMatch) {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "stored batch endpoint only accepts GET", { Allow: "GET" });
        }
        const principal = await requirePrincipal(request);
        const batchId = batchMatch[1];
        const stored = await withBatchOperationLock(batchId, async () => {
          const viewed = await batchStore.readBatch({
            ownerUserId: principal.user.id,
            batchId
          });
          if (viewed.batch.phase === "finalized") {
            await retireBatchSessions(await batchStore.readBatchSessionEvidenceForServer({
              ownerUserId: principal.user.id,
              batchId
            }));
          }
          return viewed;
        });
        writeJson(response, 200, batchApiResponse(stored));
        return;
      }

      if (url.pathname === "/api/v1/sessions") {
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "session endpoint only accepts POST", { Allow: "POST" });
        }
        let principal;
        try {
          principal = await requirePrincipal(request);
        } catch (error) {
          request.resume();
          throw error;
        }
        assertRequestSameOrigin(request);
        requireJsonRequest(request);
        const body = parseJsonObject(await readRequestBody(request, SESSION_BODY_LIMIT_BYTES), "SESSION");
        assertAllowedFields(body, new Set(["taskId", "mode"]), "SESSION");
        if (typeof body.taskId !== "string" || !Object.prototype.hasOwnProperty.call(LOCAL_CHALLENGES, body.taskId)) {
          throw new HttpError(404, "CHALLENGE_NOT_FOUND", "requested task is not registered by this server");
        }
        const mode = body.mode === undefined ? "standard" : body.mode;
        if (typeof mode !== "string" || !SINGLE_SESSION_MODES.has(mode)) {
          throw new HttpError(400, "SESSION_MODE_INVALID", "session mode must be standard or ai for Guangyang");
        }
        // A single-run session is bound to the authenticated team's immutable
        // internal id. The browser cannot choose or spoof this key; account
        // ownership remains separately bound to the authenticated user.
        const { store: selectedMapStore } = assignedMapStore(body.taskId, principal.teamId);
        const publishedMap = await selectedMapStore.snapshot();
        const selected = publishedMap
          ? publishedChallengeForSingleSession(publishedMap, mode)
          : {
              challenge: deepFreeze({
                ...LOCAL_CHALLENGES[body.taskId],
                sessionMode: "standard"
              }),
              runDefinition: LOCAL_CHALLENGES[body.taskId].runDefinition
            };
        const challenge = selected.challenge;
        const created = await submissionStore.createSession(
          principal.teamId,
          challenge,
          principal.user.id
        );
        const sessionResponse = {
          ...created.session,
          submitToken: created.submitToken
        };
        if (publishedMap) {
          sessionResponse.mapConfig = publishedMap.binding;
          sessionResponse.runDefinition = selected.runDefinition;
        }
        writeJson(response, 201, sessionResponse);
        return;
      }

      const submissionRecordMatch = url.pathname.match(SUBMISSION_RECORD_ROUTE);
      if (submissionRecordMatch) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "stored record endpoint only accepts GET", { Allow: "GET, HEAD" });
        }
        const [, sessionId, submissionId] = submissionRecordMatch;
        const authorized = await authorizeCompetitionSession(
          request,
          sessionId,
          { allowExpired: true }
        );
        const stored = await submissionStore.readRecord(
          sessionId,
          submissionId,
          authorized.token,
          maximumRecordBytes,
          { skipAuthorization: authorized.adminBypass }
        );
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": stored.buffer.length,
          "Content-Disposition": `attachment; filename="${submissionId}.json"`,
          "X-Content-SHA256": stored.manifest.record.sha256
        });
        if (request.method === "HEAD") response.end();
        else response.end(stored.buffer);
        return;
      }

      const submissionMatch = url.pathname.match(SUBMISSION_ROUTE);
      if (submissionMatch) {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "stored submission endpoint only accepts GET", { Allow: "GET" });
        }
        const [, sessionId, submissionId] = submissionMatch;
        const authorized = await authorizeCompetitionSession(
          request,
          sessionId,
          { allowExpired: true }
        );
        const stored = await submissionStore.readSubmission(
          sessionId,
          submissionId,
          authorized.token,
          { skipAuthorization: authorized.adminBypass }
        );
        writeJson(response, 200, submissionReceipt(stored.manifest, stored.report, false));
        return;
      }

      const submissionsMatch = url.pathname.match(SUBMISSIONS_ROUTE);
      if (submissionsMatch) {
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "submission endpoint only accepts POST", { Allow: "POST" });
        }
        const sessionId = submissionsMatch[1];
        assertRequestSameOrigin(request);
        let session;
        let token;
        let principal;
        try {
          ({ session, token, principal } = await authorizeCompetitionSession(
            request,
            sessionId,
            { adminBypass: false }
          ));
        } catch (error) {
          request.resume();
          throw error;
        }
        const submissionScope = await submissionStore.readSessionScopeForServer(sessionId);
        if (submissionScope.scope !== "single") {
          request.resume();
          throw new HttpError(403, "BATCH_SESSION_REQUIRES_BATCH_ROUTE",
            "batch-scoped sessions cannot use the generic submission route");
        }
        const contentEncoding = requireJsonRequest(request, { allowGzip: true });
        const verification = await executeVerificationRequest(
          request,
          response,
          session.challenge.runDefinition,
          contentEncoding
        );
        submissionStore.assertRecordMatchesSession(session, verification.recordMetadata);
        const reportBuffer = Buffer.from(serializeReport(verification.report));
        const stored = await submissionStore.saveSubmission(
          session,
          token,
          verification.buffer,
          reportBuffer,
          verification.report,
          verification.recordMetadata
        );
        await submissionStore.promoteDraftToSubmission(
          session.sessionId,
          stored.manifest.submissionId,
          principal.user.id
        );
        writeJson(
          response,
          stored.duplicate ? 200 : 201,
          submissionReceipt(stored.manifest, stored.report, stored.duplicate)
        );
        return;
      }

      const draftsMatch = url.pathname.match(DRAFTS_ROUTE);
      if (draftsMatch) {
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "record draft endpoint only accepts POST", { Allow: "POST" });
        }
        const sessionId = draftsMatch[1];
        assertRequestSameOrigin(request);
        let session;
        let token;
        try {
          ({ session, token } = await authorizeCompetitionSession(
            request,
            sessionId,
            { adminBypass: false }
          ));
        } catch (error) {
          request.resume();
          throw error;
        }
        const contentEncoding = requireJsonRequest(request, { allowGzip: true });
        const wireBuffer = await readRequestBody(request, maximumRecordBytes);
        const buffer = decodeRequestBody(wireBuffer, contentEncoding, maximumRecordBytes);
        let record;
        try {
          record = parseRecord(buffer);
        } catch (error) {
          throw new HttpError(400, typeof error?.code === "string" ? error.code : "INVALID_RECORD",
            typeof error?.message === "string" ? error.message : "run record is invalid");
        }
        const metadata = draftRecordMetadata(record);
        submissionStore.assertRecordMatchesSession(session, metadata);
        const stored = await submissionStore.saveDraft(session, token, buffer, metadata, record.result);
        writeJson(response, stored.duplicate ? 200 : 201, draftReceipt(stored.manifest, stored.duplicate));
        return;
      }

      const sessionMatch = url.pathname.match(SESSION_ROUTE);
      if (sessionMatch) {
        if (request.method !== "GET") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "session endpoint only accepts GET", { Allow: "GET" });
        }
        const sessionId = sessionMatch[1];
        const authorized = await authorizeCompetitionSession(
          request,
          sessionId,
          { allowExpired: true }
        );
        let session;
        if (authorized.adminBypass) {
          const submissions = await submissionStore.listSubmissionManifests(sessionId);
          session = {
            ...submissionStore.publicSession(authorized.session, submissions.length),
            submissions
          };
        } else {
          session = await submissionStore.getSession(sessionId, authorized.token);
        }
        writeJson(response, 200, session);
        return;
      }

      if (url.pathname === "/api/v1/verify-run-record") {
        if (request.method !== "POST") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "verification endpoint only accepts POST", { Allow: "POST" });
        }
        const contentEncoding = requireJsonRequest(request, { allowGzip: true });
        const { report } = await executeVerificationRequest(request, response, null, contentEncoding);
        const body = serializeReport(participantVerificationReport(report));
        response.writeHead(report.status === "invalid" ? 422 : 200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body)
        });
        response.end(body);
        return;
      }

      if (url.pathname.startsWith("/api/")) throw new HttpError(404, "API_NOT_FOUND", "API endpoint not found");
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "static resources only accept GET or HEAD", { Allow: "GET, HEAD" });
      }
      const parsedStaticPath = parseStaticPath(request.url);
      if (["index.html", "records.html", "admin.html"].includes(parsedStaticPath.portablePath)) {
        let principal;
        try {
          principal = await requirePrincipal(request);
        } catch (error) {
          if (error instanceof AuthStoreError && error.statusCode === 401) {
            const returnTo = `${url.pathname}${url.search}`;
            response.writeHead(302, {
              Location: `/login.html?returnTo=${encodeURIComponent(returnTo)}`
            });
            response.end();
            return;
          }
          throw error;
        }
        if (parsedStaticPath.portablePath === "admin.html" && principal.user.role !== "admin") {
          throw new HttpError(403, "ADMIN_REQUIRED", "administrator role is required");
        }
      }
      await serveStatic(request, response, parsedStaticPath);
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      const code = typeof error?.code === "string" ? error.code : "INTERNAL_ERROR";
      const publicError = error instanceof HttpError
        || error instanceof RobotBridgeError
        || error instanceof SubmissionStoreError
        || error instanceof AuthStoreError
        || error instanceof BatchEvaluationStoreError
        || error instanceof GuangyangMapConfigStoreError;
      const message = publicError ? error.message : "internal server error";
      const headers = publicError ? { ...error.headers } : {};
      if (statusCode === 503) headers["Retry-After"] = "1";
      writeJson(response, statusCode, apiError(code, message), headers);
    }
  });

  // Exceed the queue timeout so admitted waiters are not disconnected early.
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.authStore = authStore;
  server.officialSsoReplayStore = officialSsoReplayStore;
  server.submissionStore = submissionStore;
  server.batchStore = batchStore;
  server.rankedBatchStore = rankedBatchStore;
  server.mapConfigStore = mapConfigStore;
  server.mapConfigStores = mapConfigStores;
  server.mapConfigPools = mapConfigPools;
  server.dataDirectoryWriterLock = writerLock;
  server.robotBridge = robotBridge;
  server.once("close", () => {
    robotBridge?.close();
    verificationQueue.close();
    writerLock.release();
  });
  return server;
}

function startServer(options = {}) {
  const host = options.host || process.env.HOST || DEFAULT_HOST;
  const port = positiveInteger(options.port ?? process.env.PORT, DEFAULT_PORT, { allowZero: true });
  const server = createServer(options);
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    process.stdout.write(`${JSON.stringify({
      status: "listening",
      url: `http://${host}:${actualPort}/`,
      pid: process.pid,
      authoritative: false
    })}\n`);
  });

  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return server;
}

if (require.main === module) {
  startServer({
    publicOrigin: process.env.CHENLONG_PUBLIC_ORIGIN || undefined,
    secureCookies: process.env.CHENLONG_SECURE_COOKIES === "true",
    allowLoopbackOrigin: process.env.CHENLONG_ALLOW_LOOPBACK_ORIGIN === "true",
    maxUsers: environmentInteger("CHENLONG_MAX_USERS"),
    maxAuthSessions: environmentInteger("CHENLONG_MAX_AUTH_SESSIONS"),
    maxSessionsPerUser: environmentInteger("CHENLONG_MAX_AUTH_SESSIONS_PER_USER"),
    maxPasswordOperations: environmentInteger("CHENLONG_MAX_PASSWORD_OPERATIONS"),
    maxPasswordQueue: environmentInteger("CHENLONG_MAX_PASSWORD_QUEUE"),
    passwordQueueTimeoutMs: environmentInteger("CHENLONG_PASSWORD_QUEUE_TIMEOUT_MS"),
    registrationOpen: environmentBoolean("CHENLONG_REGISTRATION_OPEN"),
    maxRegistrationAttempts: environmentInteger("CHENLONG_MAX_REGISTRATION_ATTEMPTS"),
    registrationWindowMs: environmentInteger("CHENLONG_REGISTRATION_WINDOW_MS"),
    maxConcurrentVerifications: environmentInteger("CHENLONG_MAX_CONCURRENT_VERIFICATIONS"),
    maxQueuedVerifications: environmentInteger("CHENLONG_MAX_QUEUED_VERIFICATIONS"),
    verificationQueueTimeoutMs: environmentInteger("CHENLONG_VERIFICATION_QUEUE_TIMEOUT_MS"),
    maxStorageBytes: environmentInteger("CHENLONG_RUN_ARCHIVE_MAX_BYTES"),
    officialSsoSecret: process.env.CHENLONG_OFFICIAL_SSO_SECRET || undefined,
    allowInsecureOfficialSsoForTests: process.env.CHENLONG_OFFICIAL_SSO_ALLOW_INSECURE_TEST_MODE === "true",
    maxOfficialSsoAuditBytes: process.env.CHENLONG_OFFICIAL_SSO_MAX_AUDIT_BYTES,
    maxOfficialSsoAuditFiles: process.env.CHENLONG_OFFICIAL_SSO_MAX_AUDIT_FILES,
    officialSsoAttemptWindowMs: process.env.CHENLONG_OFFICIAL_SSO_RATE_WINDOW_MS,
    maxOfficialSsoAttempts: process.env.CHENLONG_OFFICIAL_SSO_MAX_ATTEMPTS,
    maxOfficialSsoAttemptsPerIp: process.env.CHENLONG_OFFICIAL_SSO_MAX_ATTEMPTS_PER_IP,
    platformServiceSecret: process.env.CHENLONG_PLATFORM_SSO_SECRET || undefined
  });
}

module.exports = {
  SERVICE_SCHEMA_VERSION,
  AUTH_RESPONSE_SCHEMA_VERSION,
  AUTH_COOKIE_NAME,
  BATCH_API_RESPONSE_SCHEMA_VERSION,
  BATCH_SLOT_LEASE_SCHEMA_VERSION,
  BATCH_OPEN_LIST_SCHEMA_VERSION,
  BATCH_OPEN_LIST_ORDER,
  RANKED_COMPETITION_ID,
  RANKED_COMPETITION_DISPLAY_NAME,
  RANKED_EVALUATION_BASE_PATH,
  ADMIN_RANKED_RANKING_PATH,
  RANKED_EVALUATION_API_SCHEMA_VERSION,
  RANKED_SLOT_LEASE_SCHEMA_VERSION,
  RANKED_RANKING_SCHEMA_VERSION,
  RANKED_RANKING_STABLE_TIE_BREAK,
  DATA_DIRECTORY_WRITER_LOCK_SCHEMA_VERSION,
  DATA_DIRECTORY_WRITER_LOCK_FILENAME,
  DataDirectoryWriterLockError,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_WORKER_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_VERIFICATIONS,
  MAX_WORKER_TIMEOUT_MS,
  MAX_CONCURRENT_VERIFICATIONS,
  DEFAULT_MAX_QUEUED_VERIFICATIONS,
  MAX_QUEUED_VERIFICATIONS,
  DEFAULT_VERIFICATION_QUEUE_TIMEOUT_MS,
  MAX_VERIFICATION_QUEUE_TIMEOUT_MS,
  createVerificationQueue,
  paginateRecords,
  teamTaskBestRecords,
  DEFAULT_REGISTRATION_ATTEMPT_WINDOW_MS,
  MAX_REGISTRATION_ATTEMPT_WINDOW_MS,
  DEFAULT_MAX_REGISTRATION_ATTEMPTS,
  MAX_REGISTRATION_ATTEMPTS,
  GUANGYANG_CHALLENGE_CONFIGS,
  LOCAL_CHALLENGES,
  createServer,
  createBackendServer: createServer,
  startServer
};
