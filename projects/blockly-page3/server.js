#!/usr/bin/env node
"use strict";

// Blockly remains independently deployable.  When PLATFORM_SSO_SECRET is set,
// authentication is exclusively supplied by the sibling platform's signed
// principal contract; local cookies and credential endpoints are disabled.
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const primaryGuangyangScoring = require("./guangyang-scoring.js");
const primaryGuangyangMaps = require("./guangyang-map-config.js");
const {
  BlocklyRecordStore,
  DATABASE_SCHEMA_VERSION: RECORD_DATABASE_SCHEMA_VERSION,
  DATABASE_FILE_NAME: RECORD_DATABASE_FILE_NAME
} = require("./blockly-record-store.js");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 6180);
const PUBLIC_ORIGIN = String(process.env.BLOCKLY_PUBLIC_ORIGIN || "").replace(/\/$/, "");
const PLATFORM_SSO_SECRET = String(process.env.PLATFORM_SSO_SECRET || "");
const PLATFORM_MODE = PLATFORM_SSO_SECRET.length > 0;
const LOCAL_AUTH_REQUESTED = String(process.env.BLOCKLY_ENABLE_LOCAL_AUTH || "").trim().toLowerCase() === "true";
const LOCAL_AUTH_ENABLED = !PLATFORM_MODE && LOCAL_AUTH_REQUESTED;
const BOOTSTRAP_ADMIN_USERNAME = String(process.env.BLOCKLY_BOOTSTRAP_ADMIN_USERNAME || "").normalize("NFC").trim();
const BOOTSTRAP_ADMIN_PASSWORD = String(process.env.BLOCKLY_BOOTSTRAP_ADMIN_PASSWORD || "");
const platformContract = PLATFORM_MODE
  ? require(path.join(__dirname, "..", "..", "packages", "platform-contract.js"))
  : null;
if (PLATFORM_MODE && Buffer.byteLength(PLATFORM_SSO_SECRET, "utf8") < 32) {
  throw new Error("PLATFORM_SSO_SECRET 必须至少包含 32 个 UTF-8 字节。");
}
if (LOCAL_AUTH_ENABLED) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(BOOTSTRAP_ADMIN_USERNAME)) {
    throw new Error("启用 Blockly 本地认证时，BLOCKLY_BOOTSTRAP_ADMIN_USERNAME 必须是 3–32 位合法用户名。");
  }
  if (BOOTSTRAP_ADMIN_PASSWORD.length < 10 || BOOTSTRAP_ADMIN_PASSWORD.length > 128) {
    throw new Error("启用 Blockly 本地认证时，BLOCKLY_BOOTSTRAP_ADMIN_PASSWORD 必须是 10–128 个字符。");
  }
}
const DATA_DIR = path.resolve(process.env.BLOCKLY_DATA_DIR || path.join(__dirname, ".blockly-data"));
const STORE_PATH = path.join(DATA_DIR, "primary-blockly-store.json");
const COOKIE_NAME = "chenlong_blockly_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_PROGRAM_CHARS = 128 * 1024;
const MAX_USERS = Math.min(10_000, Math.max(1, Math.trunc(Number(process.env.BLOCKLY_MAX_USERS || 2_000) || 2_000)));
const STORE_WRITE_BATCH_MS = Math.min(250, Math.max(0, Math.trunc(Number(process.env.BLOCKLY_STORE_WRITE_BATCH_MS || 20) || 20)));
const DEFAULT_RECORD_PAGE_SIZE = 250;
const MAX_RECORD_PAGE_SIZE = 1_000;
const LEGACY_RECORD_PAGE_SIZE = 1_000;
const MAX_RECORD_PAGE_NUMBER = 1_000_000;
const MAX_EXECUTION_TRACE_ENTRIES = 64;
const CAPABILITY_USAGE_SCHEMA_VERSION = "chenlong.blockly-runtime-capability-usage/v1";
const CAPABILITY_USAGE_SOURCE = "runtime_reported";
const NAVIGATION_SENSOR_METHODS = Object.freeze([
  "odometry", "road_state", "map_graph", "mission", "task_state", "release_preview"
]);
const ROAD_CONTROL_METHODS = Object.freeze(["follow_road", "take_exit"]);
const VISION_METHODS = Object.freeze([
  "sees", "count", "detect", "near", "centered", "direction", "distance_to", "approach", "observe"
]);
const EXECUTION_METHODS = Object.freeze([
  ...NAVIGATION_SENSOR_METHODS,
  ...ROAD_CONTROL_METHODS,
  ...VISION_METHODS
]);
const EXECUTION_METHOD_SET = new Set(EXECUTION_METHODS);
const PRIMARY_TASKS = Object.freeze({
  "GYI-PRIMARY-01": Object.freeze({ name: "广阳岛综合任务1", checkpoints: 4, objects: 1 }),
  "GYI-PRIMARY-02": Object.freeze({ name: "广阳岛综合任务2", checkpoints: 6, objects: 2 }),
  "GYI-PRIMARY-03": Object.freeze({ name: "广阳岛综合任务3", checkpoints: 8, objects: 3 })
});
const PLATFORM_MAP_LAYOUT_SCHEMA_VERSION = "chenlong.guangyang-map-layout/v2";
const PLATFORM_MAP_VARIANT_COUNTS = Object.freeze({
  "GYI-PRIMARY-01": 8,
  "GYI-PRIMARY-02": 10,
  "GYI-PRIMARY-03": 12
});
const PLATFORM_USER_IDENTITY = Symbol("chenlong.platform-user-identity");
const STORE_SCHEMA_VERSION = "chenlong.blockly-primary-store/v8";
const JSON_RECORD_STORE_SCHEMA_VERSION = "chenlong.blockly-primary-store/v7";
const DEFAULT_PARTICIPANT_GROUP = "primary";
const PARTICIPANT_GROUPS = new Set(["primary", "junior", "high"]);
const PARTICIPANT_GROUP_ALIASES = Object.freeze({
  primary: "primary", primary_low: "primary", primary_high: "primary", primary_school: "primary",
  "小学组": "primary", "小学组（1-3年级）": "primary", "小学组(1-3年级)": "primary",
  "小学组（4-6年级）": "primary", "小学组(4-6年级)": "primary",
  junior: "junior", middle_school: "junior", "初中组": "junior",
  high: "high", high_school: "high", senior: "high", "高中组": "high"
});
const STORE_LOCK_PATH = path.join(DATA_DIR, ".primary-blockly-store.writer.lock");
const TEAM_INVITE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; "
    + "script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http: https:; connect-src 'self' http: https:",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
});
const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/login.html", "login.html"],
  ["/auth.js", "auth.js"],
  ["/admin.html", "admin.html"],
  ["/admin-team-scores.js", "admin-team-scores.js"],
  ["/admin.js", "admin.js"],
  ["/app.js", "app.js"],
  ["/blockly-navigation-core.js", "blockly-navigation-core.js"],
  ["/guangyang-scoring.js", "guangyang-scoring.js"],
  ["/guangyang-map-config.js", "guangyang-map-config.js"],
  ["/admin.css", "admin.css"],
  ["/styles.css", "styles.css"],
  ["/favicon.svg", "favicon.svg"],
  ["/assets/guangyang-island.png", path.join("assets", "guangyang-island.png")],
  ["/vendor/blockly/blockly_compressed.js", path.join("vendor", "blockly", "blockly_compressed.js")],
  ["/vendor/blockly/blocks_compressed.js", path.join("vendor", "blockly", "blocks_compressed.js")],
  ["/vendor/blockly/javascript_compressed.js", path.join("vendor", "blockly", "javascript_compressed.js")],
  ["/vendor/blockly/msg/zh-hans.js", path.join("vendor", "blockly", "msg", "zh-hans.js")],
  ["/vendor/three/three.min.js", path.join("vendor", "three", "three.min.js")],
  ["/vendor/lucide/lucide.min.js", path.join("vendor", "lucide", "lucide.min.js")]
]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function canonicalParticipantGroup(value) {
  const key = String(value || DEFAULT_PARTICIPANT_GROUP).normalize("NFKC").trim().toLowerCase();
  return PARTICIPANT_GROUP_ALIASES[key] || DEFAULT_PARTICIPANT_GROUP;
}

function requestedParticipantGroup(value) {
  const key = typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : "";
  const group = PARTICIPANT_GROUP_ALIASES[key];
  if (!PARTICIPANT_GROUPS.has(group)) {
    throw new HttpError(400, "INVALID_PARTICIPANT_GROUP", "请选择小学组、初中组或高中组。 ");
  }
  return group;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isPlatformUser(user) {
  return Boolean(user?.[PLATFORM_USER_IDENTITY]);
}

function teamForUser(user) {
  if (user.role === "admin") return null;
  if (isPlatformUser(user)) {
    return Object.freeze({
      id: user.teamId,
      teamName: user.teamName,
      teamNameKey: user.teamName.toLocaleLowerCase("zh-CN"),
      inviteCode: null,
      createdAt: user.createdAt
    });
  }
  const team = store.teams.find(item => item.id === user.teamId);
  if (!team) throw new HttpError(500, "ACCOUNT_DATA_CORRUPTED", "账户所属队伍信息不完整，请联系老师处理。");
  return team;
}

function publicUser(user) {
  const team = teamForUser(user);
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    teamId: team?.id || null,
    teamName: team?.teamName || null,
    group: user.role === "admin" ? null : canonicalParticipantGroup(user.group),
    role: user.role === "admin" ? "admin" : "user",
    createdAt: user.createdAt
  };
}

function platformUser(value) {
  const user = {
    ...value,
    group: value.role === "admin" ? null : canonicalParticipantGroup(value.group)
  };
  Object.defineProperty(user, PLATFORM_USER_IDENTITY, { value: true });
  return Object.freeze(user);
}

function ownerSnapshot(user) {
  const team = teamForUser(user);
  return {
    ownerUsername: user.username,
    ownerDisplayName: user.displayName,
    ownerTeamId: team?.id || null,
    ownerTeamName: team?.teamName || null,
    ownerGroup: user.role === "admin" ? null : canonicalParticipantGroup(user.group)
  };
}

function mapDigest(taskId, revision, layout) {
  return sha256(JSON.stringify({ taskId, revision, layout }));
}

function createInitialMapConfigs(timestamp = nowIso()) {
  const result = {};
  Object.keys(PRIMARY_TASKS).forEach(taskId => {
    const revision = 1;
    const layout = primaryGuangyangMaps.normalizeLayout(taskId, primaryGuangyangMaps.defaultLayout(taskId));
    const version = { revision, digest: mapDigest(taskId, revision, layout), updatedAt: timestamp, updatedByUserId: null, layout };
    result[taskId] = { taskId, currentRevision: revision, versions: [version] };
  });
  return result;
}

function defaultStore() {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    users: [],
    teams: [],
    sessions: [],
    mapConfigs: createInitialMapConfigs(),
    recordStorage: null
  };
}

function validStore(value) {
  if (!value || !Array.isArray(value.users) || !Array.isArray(value.sessions)) return false;
  if (value.schemaVersion === "chenlong.blockly-primary-store/v1") return true;
  if (value.schemaVersion === STORE_SCHEMA_VERSION) {
    return Array.isArray(value.teams)
      && value.mapConfigs && typeof value.mapConfigs === "object"
      && value.recordStorage && typeof value.recordStorage === "object"
      && value.recordStorage.schemaVersion === RECORD_DATABASE_SCHEMA_VERSION
      && value.recordStorage.databaseFile === RECORD_DATABASE_FILE_NAME
      && !Object.hasOwn(value, "records");
  }
  return [
    "chenlong.blockly-primary-store/v2",
    "chenlong.blockly-primary-store/v3",
    "chenlong.blockly-primary-store/v4",
    "chenlong.blockly-primary-store/v5",
    "chenlong.blockly-primary-store/v6",
    JSON_RECORD_STORE_SCHEMA_VERSION
  ].includes(value.schemaVersion)
    && Array.isArray(value.records)
    && Array.isArray(value.teams)
    && (!["chenlong.blockly-primary-store/v4", "chenlong.blockly-primary-store/v5", JSON_RECORD_STORE_SCHEMA_VERSION].includes(value.schemaVersion)
      || value.mapConfigs && typeof value.mapConfigs === "object");
}

function loadStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) return defaultStore();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch (_error) {
    throw new Error("Blockly 项目的数据文件无法读取，请先备份后再处理。");
  }
  if (!validStore(parsed)) throw new Error("Blockly 项目的数据文件格式不兼容。");
  return parsed;
}

let writerLockHeld = false;

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireWriterLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(STORE_LOCK_PATH, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: nowIso() })}\n`, "utf8");
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      writerLockHeld = true;
      return;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) {
        throw new Error("Blockly 数据目录已由另一个服务进程使用，请先关闭重复实例。");
      }
      let lockPid = null;
      let lockReadable = false;
      try {
        lockPid = Number(JSON.parse(fs.readFileSync(STORE_LOCK_PATH, "utf8")).pid);
        lockReadable = true;
      } catch (_readError) {}
      if (processIsRunning(lockPid)) {
        throw new Error(`Blockly 数据目录已由进程 ${lockPid} 使用，请先关闭重复实例。`);
      }
      if (!lockReadable) {
        const ageMs = Date.now() - fs.statSync(STORE_LOCK_PATH).mtimeMs;
        if (ageMs < 30_000) {
          throw new Error("Blockly 数据目录正在被另一个服务进程初始化，请稍后再试。");
        }
      }
      fs.unlinkSync(STORE_LOCK_PATH);
    }
  }
}

function releaseWriterLock() {
  if (!writerLockHeld) return;
  writerLockHeld = false;
  try {
    const lock = JSON.parse(fs.readFileSync(STORE_LOCK_PATH, "utf8"));
    if (Number(lock.pid) === process.pid) fs.unlinkSync(STORE_LOCK_PATH);
  } catch (_error) {}
}

function randomTeamInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  while (result.length < 8) {
    for (const byte of crypto.randomBytes(12)) {
      if (byte >= 248) continue;
      result += alphabet[byte % alphabet.length];
      if (result.length === 8) return result;
    }
  }
  return result;
}

function createTeamInStore(state, teamName) {
  const key = teamName.toLocaleLowerCase("zh-CN");
  if (state.teams.some(team => team.teamNameKey === key)) {
    throw new HttpError(409, "TEAM_NAME_TAKEN", "这个队伍名称已被使用，请换一个名称或使用邀请码加入。 ");
  }
  let inviteCode = "";
  do { inviteCode = randomTeamInviteCode(); } while (state.teams.some(team => team.inviteCode === inviteCode));
  const team = { id: randomId("tea"), teamName, teamNameKey: key, inviteCode, createdAt: nowIso() };
  state.teams.push(team);
  return team;
}

function legacyTeamName(user, usedKeys) {
  const source = typeof user.displayName === "string" && user.displayName.trim()
    ? user.displayName.trim().normalize("NFC")
    : user.username;
  const base = source.slice(0, 56) || user.username;
  let candidate = base;
  let suffix = 2;
  while (usedKeys.has(candidate.toLocaleLowerCase("zh-CN"))) {
    candidate = `${base.slice(0, 56)} ${suffix++}`;
  }
  return candidate;
}

function migrateLegacyStore(legacy) {
  const next = { schemaVersion: JSON_RECORD_STORE_SCHEMA_VERSION, users: [], teams: [], sessions: legacy.sessions, records: migrateSavedRecords(legacy.records), mapConfigs: createInitialMapConfigs() };
  const usedKeys = new Set();
  legacy.users.forEach(user => {
    const teamName = legacyTeamName(user, usedKeys);
    const team = createTeamInStore(next, teamName);
    usedKeys.add(team.teamNameKey);
    next.users.push({ ...user, displayName: user.displayName || user.username, teamId: team.id, group: DEFAULT_PARTICIPANT_GROUP, role: "user" });
  });
  return next;
}

function migrateSavedRecords(records) {
  return records.map(record => {
    const executionTrace = storedExecutionTrace(record.executionTrace);
    return {
      ...record,
      ownerGroup: record.ownerGroup == null ? record.ownerGroup : canonicalParticipantGroup(record.ownerGroup),
      executionTrace,
      capabilityUsage: deriveCapabilityUsage(executionTrace),
      recordState: record.recordState === "submitted" ? "submitted" : "saved",
      savedAt: record.savedAt || record.createdAt,
      submittedAt: record.recordState === "submitted" ? record.submittedAt || record.createdAt : null
    };
  });
}

function migrateOlderStore(value) {
  return {
    ...value,
    schemaVersion: JSON_RECORD_STORE_SCHEMA_VERSION,
    users: value.users.map(user => ({
      ...user,
      group: user.role === "admin" ? null : canonicalParticipantGroup(user.group)
    })),
    records: migrateSavedRecords(value.records),
    mapConfigs: value.mapConfigs && typeof value.mapConfigs === "object" ? value.mapConfigs : createInitialMapConfigs()
  };
}

function normalizeCoreParticipantGroups(state) {
  let changed = false;
  for (const user of state.users) {
    const group = user.role === "admin" ? null : canonicalParticipantGroup(user.group);
    if (user.group !== group) {
      user.group = group;
      changed = true;
    }
  }
  return changed;
}

acquireWriterLock();
process.once("exit", releaseWriterLock);

const coreStoreExisted = fs.existsSync(STORE_PATH);
let store = loadStore();
if (store.schemaVersion === "chenlong.blockly-primary-store/v1") {
  store = migrateLegacyStore(store);
} else if (store.schemaVersion !== STORE_SCHEMA_VERSION
  && store.schemaVersion !== JSON_RECORD_STORE_SCHEMA_VERSION) {
  store = migrateOlderStore(store);
}
if (coreStoreExisted && store.schemaVersion === STORE_SCHEMA_VERSION
  && !fs.existsSync(path.join(DATA_DIR, RECORD_DATABASE_FILE_NAME))) {
  throw new Error("Blockly 记录数据库缺失；为避免成绩丢失，服务已停止，请从备份恢复。");
}
const recordStore = new BlocklyRecordStore({ dataDir: DATA_DIR });
process.once("exit", () => {
  try { recordStore.close(); } catch (_error) {}
});
let storeNeedsWrite = !coreStoreExisted;
if (store.schemaVersion === STORE_SCHEMA_VERSION
  && Number.isSafeInteger(store.recordStorage?.legacyRecordCount)
  && recordStore.count() < store.recordStorage.legacyRecordCount) {
  throw new Error("Blockly 记录数据库少于迁移校验数量；为避免成绩丢失，服务已停止，请从备份恢复。");
}
if (store.schemaVersion === STORE_SCHEMA_VERSION && store.recordStorage) {
  const binding = recordStore.bindDescriptor(store.recordStorage, { allowLegacyBinding: true });
  if (binding.upgraded) {
    store.recordStorage = binding.descriptor;
    storeNeedsWrite = true;
  }
}
if (store.schemaVersion === JSON_RECORD_STORE_SCHEMA_VERSION) {
  const legacyRecords = migrateSavedRecords(store.records || []);
  const migration = recordStore.importLegacyRecords(legacyRecords, { legacyStorePath: STORE_PATH });
  const { records: _legacyRecords, ...core } = store;
  store = {
    ...core,
    schemaVersion: STORE_SCHEMA_VERSION,
    recordStorage: recordStore.descriptor(migration)
  };
  storeNeedsWrite = true;
} else if (!store.recordStorage) {
  store.recordStorage = recordStore.descriptor();
  storeNeedsWrite = true;
}
recordStore.migrateParticipantGroups(canonicalParticipantGroup);
if (normalizeCoreParticipantGroups(store)) storeNeedsWrite = true;
if (storeNeedsWrite) writeStoreSync();

function writeStoreSync() {
  const temporary = path.join(DATA_DIR, `.${path.basename(STORE_PATH)}.${crypto.randomUUID()}.tmp`);
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, STORE_PATH);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch (_error) {}
    }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_error) {}
  }
}

let pendingStoreWrite = null;

function writeStore() {
  if (pendingStoreWrite) return pendingStoreWrite;
  pendingStoreWrite = new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        writeStoreSync();
        resolve();
      } catch (error) {
        try {
          const reloaded = loadStore();
          if (reloaded.schemaVersion === STORE_SCHEMA_VERSION) store = reloaded;
        } catch (_reloadError) {}
        reject(error);
      } finally {
        pendingStoreWrite = null;
      }
    }, STORE_WRITE_BATCH_MS);
  });
  return pendingStoreWrite;
}

function passwordHash(password, salt = crypto.randomBytes(16).toString("base64url")) {
  const hash = crypto.scryptSync(password, salt, 32).toString("base64url");
  return { salt, hash };
}

function passwordMatches(user, password) {
  const candidate = passwordHash(password, user.passwordSalt).hash;
  const left = Buffer.from(candidate);
  const right = Buffer.from(user.passwordHash);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function ensureBootstrapAdministrator() {
  if (!LOCAL_AUTH_ENABLED) return;
  const existing = store.users.find(user => (
    user.username.toLowerCase() === BOOTSTRAP_ADMIN_USERNAME.toLowerCase()
  ));
  if (existing) {
    if (existing.role !== "admin") {
      throw new Error("BLOCKLY_BOOTSTRAP_ADMIN_USERNAME 已被普通用户占用，无法初始化本地管理员。");
    }
    return;
  }
  const password = passwordHash(BOOTSTRAP_ADMIN_PASSWORD);
  store.users.push({
    id: randomId("usr"),
    username: BOOTSTRAP_ADMIN_USERNAME,
    displayName: "管理员",
    role: "admin",
    teamId: null,
    group: null,
    passwordSalt: password.salt,
    passwordHash: password.hash,
    createdAt: nowIso()
  });
  writeStoreSync();
}

ensureBootstrapAdministrator();

function readCookie(request, name) {
  const pairs = String(request.headers.cookie || "").split(";");
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return null;
}

function clearExpiredSessions() {
  const now = Date.now();
  const before = store.sessions.length;
  store.sessions = store.sessions.filter(session => Date.parse(session.expiresAt) > now);
  if (store.sessions.length !== before) {
    void writeStore().catch(error => process.stderr.write(`Blockly 会话清理写入失败：${error.message}\n`));
  }
}

function platformHeader(request, name) {
  const value = request.headers[name];
  if (Array.isArray(value)) throw new HttpError(401, "INVALID_PLATFORM_CONTEXT", "统一平台身份头格式不正确。");
  return value;
}

function platformPrincipal(request) {
  if (!PLATFORM_MODE) return null;
  const value = platformHeader(request, platformContract.PRINCIPAL_HEADER);
  if (value === undefined) return null;
  try {
    const verified = platformContract.verifyPrincipal(value, PLATFORM_SSO_SECRET, "blockly");
    return {
      user: platformUser(verified.user),
      session: null,
      identitySource: "platform"
    };
  } catch (_error) {
    throw new HttpError(401, "INVALID_PLATFORM_PRINCIPAL", "统一平台登录身份无效或已过期，请刷新页面后重试。");
  }
}

function principal(request) {
  if (PLATFORM_MODE) {
    const shared = platformPrincipal(request);
    if (shared) return shared;
    throw new HttpError(401, "PLATFORM_AUTHENTICATION_REQUIRED", "请从统一竞赛平台登录后进入 Blockly。 ");
  }
  if (!LOCAL_AUTH_ENABLED) {
    throw new HttpError(401, "LOCAL_AUTH_DISABLED", "Blockly 本地认证未启用，请从统一竞赛平台进入。 ");
  }
  clearExpiredSessions();
  const token = readCookie(request, COOKIE_NAME);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401, "AUTHENTICATION_REQUIRED", "请先登录。");
  const session = store.sessions.find(item => item.tokenHash === sha256(token));
  if (!session) throw new HttpError(401, "AUTHENTICATION_REQUIRED", "登录已失效，请重新登录。");
  const user = store.users.find(item => item.id === session.userId);
  if (!user) throw new HttpError(401, "AUTHENTICATION_REQUIRED", "登录账户不存在。");
  return { user, session, identitySource: "local" };
}

function assertLocalAuthEnabled() {
  if (!LOCAL_AUTH_ENABLED) {
    throw new HttpError(403, "LOCAL_AUTH_DISABLED", "当前部署不提供 Blockly 本地登录、注册或退出接口。 ");
  }
}

function requireAdmin(request) {
  const account = principal(request);
  if (account.user.role !== "admin") throw new HttpError(403, "ADMIN_REQUIRED", "需要管理员权限。 ");
  return account;
}

function normalizeOrigin(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return "";
  }
}

function requestHostOrigin(request) {
  const host = String(request.headers.host || "").trim().toLowerCase();
  if (!host) return "";
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const protocol = ["http", "https"].includes(forwardedProtocol)
    ? forwardedProtocol
    : request.socket.encrypted ? "https" : "http";
  return normalizeOrigin(`${protocol}://${host}`);
}

function trustedOrigins(request) {
  return new Set([
    normalizeOrigin(PUBLIC_ORIGIN),
    requestHostOrigin(request)
  ].filter(Boolean));
}

function assertSameOrigin(request) {
  const origin = normalizeOrigin(request.headers.origin);
  if (!origin || !trustedOrigins(request).has(origin)) {
    throw new HttpError(403, "CROSS_ORIGIN_REQUEST", "请求来源不受信任，请刷新页面后重试。");
  }
}

function parseJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new HttpError(413, "REQUEST_TOO_LARGE", "请求内容过大。"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        reject(new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "请求格式必须是 JSON。"));
        return;
      }
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (_error) {
        reject(new HttpError(400, "INVALID_JSON", "请求内容不是有效 JSON。"));
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        reject(new HttpError(400, "INVALID_REQUEST", "请求内容格式不正确。"));
        return;
      }
      resolve(value);
    });
  });
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeExecutionTrace(value) {
  if (!Array.isArray(value) || value.length > MAX_EXECUTION_TRACE_ENTRIES) {
    throw new HttpError(400, "INVALID_EXECUTION_TRACE", "运行时能力调用记录格式不正确。 ");
  }
  const methods = new Set();
  for (const method of value) {
    if (typeof method !== "string" || !EXECUTION_METHOD_SET.has(method)) {
      throw new HttpError(400, "INVALID_EXECUTION_TRACE", "运行时能力调用记录包含不支持的方法。 ");
    }
    methods.add(method);
  }
  return EXECUTION_METHODS.filter(method => methods.has(method));
}

function storedExecutionTrace(value) {
  if (value === undefined) return [];
  try {
    return normalizeExecutionTrace(value);
  } catch (_error) {
    return [];
  }
}

function deriveCapabilityUsage(executionTrace) {
  const methods = new Set(executionTrace);
  return {
    schemaVersion: CAPABILITY_USAGE_SCHEMA_VERSION,
    source: CAPABILITY_USAGE_SOURCE,
    navigationSensorMethods: NAVIGATION_SENSOR_METHODS.filter(method => methods.has(method)),
    roadControlMethods: ROAD_CONTROL_METHODS.filter(method => methods.has(method)),
    visionMethods: VISION_METHODS.filter(method => methods.has(method))
  };
}

function runtimeCapabilityForRecord(record) {
  const executionTrace = storedExecutionTrace(record?.executionTrace);
  return { executionTrace, capabilityUsage: deriveCapabilityUsage(executionTrace) };
}

function normalizedText(value, maximum, label) {
  if (typeof value !== "string") throw new HttpError(400, "INVALID_REQUEST", `${label}格式不正确。`);
  const normalized = value.trim().normalize("NFC");
  if (!normalized || [...normalized].length > maximum || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(normalized)) {
    throw new HttpError(400, "INVALID_REQUEST", `${label}格式不正确。`);
  }
  return normalized;
}

function normalizedTeamName(value) {
  return normalizedText(value, 64, "队伍名称");
}

function normalizedInviteCode(value) {
  if (typeof value !== "string") throw new HttpError(400, "INVALID_TEAM_INVITE_CODE", "请输入正确的 8 位队伍邀请码。 ");
  const code = value.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!TEAM_INVITE_PATTERN.test(code)) {
    throw new HttpError(400, "INVALID_TEAM_INVITE_CODE", "请输入正确的 8 位队伍邀请码。 ");
  }
  return code;
}

function sendJson(response, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store, max-age=0",
    ...SECURITY_HEADERS,
    ...headers
  });
  response.end(body);
}

function scoreRun({ completed, taskProgress, checkpointCount, blockedMoves, offRoadEpisodes, offRoadDurationMs, durationMs, task }) {
  return primaryGuangyangScoring.scoreRun({
    completed,
    checkpointCount,
    checkpointTotal: task.checkpoints,
    taskCompleted: taskProgress.completed,
    taskTotal: taskProgress.total,
    collisionCount: blockedMoves,
    offRoadEpisodes,
    offRoadDurationMs,
    durationMs
  });
}

function mapEntry(taskId) {
  const entry = store.mapConfigs?.[taskId];
  if (!entry || !Number.isInteger(entry.currentRevision) || !Array.isArray(entry.versions)) {
    throw new HttpError(500, "MAP_DATA_CORRUPTED", "比赛地图配置不完整，请联系管理员处理。 ");
  }
  return entry;
}

function mapVersion(taskId, revision = null, digest = null) {
  const entry = mapEntry(taskId);
  const targetRevision = revision === null ? entry.currentRevision : revision;
  const version = entry.versions.find(item => item.revision === targetRevision && (digest === null || item.digest === digest));
  if (!version) throw new HttpError(409, "MAP_VERSION_NOT_FOUND", "本次运行使用的地图版本已无法核对，请刷新任务后重新运行。 ");
  return version;
}

function publicMapConfig(taskId, version = mapVersion(taskId)) {
  const task = PRIMARY_TASKS[taskId];
  return {
    taskId,
    taskName: task.name,
    revision: version.revision,
    digest: version.digest,
    updatedAt: version.updatedAt,
    layout: primaryGuangyangMaps.clone(version.layout)
  };
}

function allCurrentMapConfigs() {
  return Object.keys(PRIMARY_TASKS).map(taskId => publicMapConfig(taskId));
}

function platformMapError() {
  return new HttpError(400, "INVALID_PLATFORM_MAP_BUNDLE", "统一平台地图信息无效或已过期，请刷新任务后重试。");
}

function canonicalPlatformLayout(taskId, value) {
  if (!exactKeys(value, ["schemaVersion", "checkpoints", "targets", "storage", "distractors", "obstacles"])
    || value.schemaVersion !== PLATFORM_MAP_LAYOUT_SCHEMA_VERSION) {
    throw platformMapError();
  }
  let normalized;
  try {
    normalized = primaryGuangyangMaps.normalizeLayout(taskId, value);
  } catch (_error) {
    throw platformMapError();
  }
  const canonical = {
    schemaVersion: PLATFORM_MAP_LAYOUT_SCHEMA_VERSION,
    checkpoints: normalized.checkpoints,
    targets: normalized.targets,
    storage: normalized.storage,
    distractors: normalized.distractors,
    obstacles: normalized.obstacles
  };
  try {
    if (platformContract.canonicalJson(canonical) !== platformContract.canonicalJson(value)) throw platformMapError();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw platformMapError();
  }
  return canonical;
}

function normalizePlatformMap(raw) {
  if (!exactKeys(raw, ["taskId", "sourceTaskId", "variantId", "revision", "digest", "updatedAt", "layout"])) {
    throw platformMapError();
  }
  const task = PRIMARY_TASKS[raw.taskId];
  const platformTask = platformContract.platformTaskId(raw.taskId);
  const expectedSourceTaskId = platformTask && platformContract.PLATFORM_TO_PYTHON_TASK[platformTask];
  if (!task || raw.sourceTaskId !== expectedSourceTaskId
    || !Number.isSafeInteger(raw.revision) || raw.revision < 0
    || typeof raw.digest !== "string" || !/^[a-f0-9]{64}$/.test(raw.digest)
    || (raw.updatedAt !== null
      && (typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt))))) {
    throw platformMapError();
  }
  if (raw.variantId !== null) {
    const match = typeof raw.variantId === "string" && raw.variantId.match(/^map-(0[1-9]|1[0-9]|20)$/);
    if (!match || Number(match[1]) > PLATFORM_MAP_VARIANT_COUNTS[raw.taskId]) throw platformMapError();
  }
  const layout = canonicalPlatformLayout(raw.taskId, raw.layout);
  if (sha256(platformContract.canonicalJson(layout)) !== raw.digest) throw platformMapError();
  return Object.freeze({
    taskId: raw.taskId,
    taskName: task.name,
    sourceTaskId: raw.sourceTaskId,
    variantId: raw.variantId,
    revision: raw.revision,
    digest: raw.digest,
    updatedAt: raw.updatedAt,
    layout
  });
}

function platformMaps(request) {
  if (!PLATFORM_MODE) throw platformMapError();
  const value = platformHeader(request, platformContract.MAP_BUNDLE_HEADER);
  if (value === undefined) throw platformMapError();
  let bundle;
  try {
    bundle = platformContract.verifyMapBundle(value, PLATFORM_SSO_SECRET);
  } catch (_error) {
    throw platformMapError();
  }
  const byTask = new Map();
  for (const raw of bundle.maps) {
    const map = normalizePlatformMap(raw);
    if (byTask.has(map.taskId)) throw platformMapError();
    byTask.set(map.taskId, map);
  }
  if (byTask.size !== Object.keys(PRIMARY_TASKS).length) throw platformMapError();
  return Object.keys(PRIMARY_TASKS).map(taskId => {
    const map = byTask.get(taskId);
    if (!map) throw platformMapError();
    return map;
  });
}

function platformMapVersion(request, taskId, revision, digest) {
  const version = platformMaps(request).find(item => item.taskId === taskId
    && item.revision === revision && item.digest === digest);
  if (!version) throw new HttpError(409, "MAP_VERSION_NOT_FOUND", "本次运行使用的平台地图版本无法核对，请刷新任务后重新运行。");
  return version;
}

function recordSummary(record) {
  const runtimeCapability = runtimeCapabilityForRecord(record);
  return {
    id: record.id,
    taskId: record.taskId,
    score: record.score,
    scoreMaximum: 100,
    completed: record.completed,
    checkpointCount: record.checkpointCount,
    checkpointTotal: record.checkpointTotal,
    taskCompleted: Number.isInteger(record.taskCompleted) ? record.taskCompleted : null,
    taskTotal: Number.isInteger(record.taskTotal) ? record.taskTotal : null,
    targetDeliveredCount: Number.isInteger(record.targetDeliveredCount) ? record.targetDeliveredCount : null,
    distractorClearedCount: Number.isInteger(record.distractorClearedCount) ? record.distractorClearedCount : null,
    failedObstacleCount: Number.isInteger(record.failedObstacleCount) ? record.failedObstacleCount : null,
    goalReached: typeof record.goalReached === "boolean" ? record.goalReached : null,
    mapRevision: Number.isInteger(record.mapRevision) ? record.mapRevision : null,
    mapDigest: record.mapDigest || null,
    recordState: record.recordState,
    savedAt: record.savedAt,
    submittedAt: record.submittedAt,
    createdAt: record.createdAt,
    executionTrace: runtimeCapability.executionTrace,
    capabilityUsage: runtimeCapability.capabilityUsage,
    authoritative: false
  };
}

function strictPositiveIntegerQuery(url, name, fallback, maximum) {
  const values = url.searchParams.getAll(name);
  if (values.length === 0) return fallback;
  if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) {
    throw new HttpError(400, "INVALID_PAGINATION", `${name} 必须是正整数。`);
  }
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new HttpError(400, "INVALID_PAGINATION", `${name} 超出允许范围。`);
  }
  return value;
}

function recordPagination(url) {
  const legacy = !url.searchParams.has("page") && !url.searchParams.has("pageSize");
  return {
    legacy,
    page: strictPositiveIntegerQuery(url, "page", 1, MAX_RECORD_PAGE_NUMBER),
    pageSize: strictPositiveIntegerQuery(
      url,
      "pageSize",
      legacy ? LEGACY_RECORD_PAGE_SIZE : DEFAULT_RECORD_PAGE_SIZE,
      MAX_RECORD_PAGE_SIZE
    )
  };
}

function submittedStatsByOwner() {
  return recordStore.submittedStatsByOwner();
}

function adminUserSummary(user, submittedStats = submittedStatsByOwner()) {
  const stats = submittedStats.get(user.id) || { count: 0, highestScore: null };
  return {
    ...publicUser(user),
    recordCount: stats.count,
    highestScore: stats.highestScore
  };
}

function allAdminUserSummaries() {
  const submittedStats = submittedStatsByOwner();
  const summaries = store.users.map(user => adminUserSummary(user, submittedStats));
  const known = new Set(summaries.map(user => user.id));
  for (const record of recordStore.latestOwnerSnapshots(known)) {
    if (typeof record.ownerUsername !== "string") continue;
    const stats = submittedStats.get(record.ownerUserId) || { count: 0, highestScore: null };
    summaries.push({
      id: record.ownerUserId,
      username: record.ownerUsername,
      displayName: record.ownerDisplayName || record.ownerUsername,
      teamId: record.ownerTeamId || null,
      teamName: record.ownerTeamName || null,
      group: record.ownerGroup == null ? null : canonicalParticipantGroup(record.ownerGroup),
      role: "user",
      createdAt: record.createdAt,
      recordCount: stats.count,
      highestScore: stats.highestScore
    });
  }
  return summaries.sort((left, right) => left.username.localeCompare(right.username, "zh-CN"));
}

function adminRecordSummary(record, usersById = null) {
  const owner = usersById
    ? usersById.get(record.ownerUserId)
    : store.users.find(user => user.id === record.ownerUserId);
  const ownerSnapshotUser = typeof record.ownerUsername === "string"
    ? {
        id: record.ownerUserId,
        username: record.ownerUsername,
        displayName: record.ownerDisplayName || record.ownerUsername,
        teamId: record.ownerTeamId || null,
        teamName: record.ownerTeamName || null,
        group: record.ownerGroup == null ? null : canonicalParticipantGroup(record.ownerGroup),
        role: "user",
        createdAt: record.createdAt
      }
    : null;
  return {
    ...recordSummary(record),
    taskName: record.taskName,
    durationMs: record.durationMs,
    user: ownerSnapshotUser || (owner ? publicUser(owner) : null)
  };
}

function adminRecordDetail(record) {
  return { ...adminRecordSummary(record), programCode: record.programCode, workspaceXml: record.workspaceXml, scoreBreakdown: record.scoreBreakdown };
}

function cookieHeader(token, expiresAt) {
  const parts = [`${COOKIE_NAME}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Expires=${new Date(expiresAt).toUTCString()}`];
  if (PUBLIC_ORIGIN.startsWith("https://")) parts.push("Secure");
  return parts.join("; ");
}

async function handleApi(request, response, url) {
  if (url.pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, {
      schemaVersion: "chenlong.blockly-health/v1",
      status: "ok",
      capacity: {
        maxUsers: MAX_USERS,
        storeWriteBatchMs: STORE_WRITE_BATCH_MS,
        users: store.users.length,
        records: recordStore.count(),
        recordStorage: RECORD_DATABASE_SCHEMA_VERSION
      },
      authentication: {
        mode: PLATFORM_MODE ? "platform" : LOCAL_AUTH_ENABLED ? "local" : "disabled"
      },
      authoritative: false
    });
    return;
  }
  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const { user } = principal(request);
    sendJson(response, 200, { schemaVersion: "chenlong.blockly-auth/v1", authenticated: true, user: publicUser(user), authoritative: false });
    return;
  }
  if (url.pathname === "/api/auth/team-invite" && request.method === "GET") {
    const { user } = principal(request);
    const team = teamForUser(user);
    if (!team) throw new HttpError(403, "ADMIN_HAS_NO_TEAM", "管理员账户没有队伍邀请码。 ");
    sendJson(response, 200, {
      schemaVersion: "chenlong.blockly-team-invite/v1",
      teamName: team.teamName,
      inviteCode: team.inviteCode,
      authoritative: false
    });
    return;
  }
  if (url.pathname === "/api/maps" && request.method === "GET") {
    const account = principal(request);
    sendJson(response, 200, {
      schemaVersion: "chenlong.blockly-maps/v1",
      maps: account.identitySource === "platform" ? platformMaps(request) : allCurrentMapConfigs(),
      authoritative: false
    });
    return;
  }
  if (url.pathname === "/api/admin/maps" && request.method === "GET") {
    requireAdmin(request);
    const maps = allCurrentMapConfigs().map(config => ({
      ...config,
      versionCount: mapEntry(config.taskId).versions.length
    }));
    sendJson(response, 200, { schemaVersion: "chenlong.blockly-admin-maps/v1", maps, authoritative: false });
    return;
  }
  const adminMapMatch = url.pathname.match(/^\/api\/admin\/maps\/(GYI-PRIMARY-0[123])$/);
  if (adminMapMatch && request.method === "PUT") {
    const { user } = requireAdmin(request);
    assertSameOrigin(request);
    const body = await parseJson(request);
    if (!exactKeys(body, ["baseRevision", "layout"]) || !Number.isInteger(body.baseRevision) || body.baseRevision < 1) {
      throw new HttpError(400, "INVALID_MAP_CONFIG", "地图保存内容格式不正确。 ");
    }
    const taskId = adminMapMatch[1];
    const entry = mapEntry(taskId);
    if (body.baseRevision !== entry.currentRevision) {
      throw new HttpError(409, "MAP_REVISION_CONFLICT", "地图已被其他管理员更新，请刷新后再保存。 ");
    }
    let layout;
    try {
      layout = primaryGuangyangMaps.normalizeLayout(taskId, body.layout);
    } catch (error) {
      throw new HttpError(400, "INVALID_MAP_CONFIG", `${error.message}。 `);
    }
    const revision = entry.currentRevision + 1;
    const version = {
      revision,
      digest: mapDigest(taskId, revision, layout),
      updatedAt: nowIso(),
      updatedByUserId: user.id,
      layout
    };
    entry.currentRevision = revision;
    entry.versions.push(version);
    await writeStore();
    sendJson(response, 200, {
      schemaVersion: "chenlong.blockly-admin-map-save-receipt/v1",
      map: publicMapConfig(taskId, version),
      authoritative: false
    });
    return;
  }
  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    requireAdmin(request);
    const users = allAdminUserSummaries();
    sendJson(response, 200, { schemaVersion: "chenlong.blockly-admin-users/v1", users, authoritative: false });
    return;
  }
  if (url.pathname === "/api/admin/records" && request.method === "GET") {
    requireAdmin(request);
    const pagination = recordPagination(url);
    const usersById = new Map(store.users.map(user => [user.id, user]));
    const selected = recordStore.page({
      recordState: "submitted",
      page: pagination.page,
      pageSize: pagination.pageSize
    });
    const records = selected.records.map(record => adminRecordSummary(record, usersById));
    sendJson(response, 200, {
      schemaVersion: "chenlong.blockly-admin-records/v1",
      records,
      pagination: {
        ...selected.pagination,
        truncated: pagination.legacy && selected.pagination.total > records.length
      },
      authoritative: false
    });
    return;
  }
  if (url.pathname === "/api/admin/team-task-scores" && request.method === "GET") {
    requireAdmin(request);
    if (url.search !== "") {
      throw new HttpError(400, "INVALID_TEAM_TASK_SCORE_QUERY", "队伍任务最高分接口不接受查询参数。 ");
    }
    sendJson(response, 200, {
      schemaVersion: "chenlong.blockly-team-task-scores/v1",
      records: recordStore.bestSubmittedTeamTaskScores(),
      authoritative: false
    });
    return;
  }
  const adminRecordDetailMatch = url.pathname.match(/^\/api\/admin\/records\/(run_[a-f0-9]{32})$/);
  if (adminRecordDetailMatch && request.method === "GET") {
    requireAdmin(request);
    const record = recordStore.findById(adminRecordDetailMatch[1], { submittedOnly: true });
    if (!record) throw new HttpError(404, "RECORD_NOT_FOUND", "没有找到这条正式提交记录。" );
    sendJson(response, 200, { schemaVersion: "chenlong.blockly-admin-record-detail/v1", record: adminRecordDetail(record), authoritative: false });
    return;
  }
  if (url.pathname === "/api/admin/export/users" && request.method === "GET") {
    requireAdmin(request);
    const users = allAdminUserSummaries();
    sendJson(response, 200, {
      schemaVersion: "chenlong.blockly-admin-users-export/v1",
      exportedAt: nowIso(),
      users,
      authoritative: false
    }, { "Content-Disposition": "attachment; filename=blockly-users.json" });
    return;
  }
  if (url.pathname === "/api/admin/export/records" && request.method === "GET") {
    requireAdmin(request);
    const usersById = new Map(store.users.map(user => [user.id, user]));
    const records = recordStore.all({ recordState: "submitted" })
      .map(record => ({
        ...adminRecordSummary(record, usersById),
        programCode: record.programCode,
        workspaceXml: record.workspaceXml,
        scoreBreakdown: record.scoreBreakdown
      }));
    sendJson(response, 200, {
      schemaVersion: "chenlong.blockly-admin-records-export/v1",
      exportedAt: nowIso(),
      records,
      authoritative: false
    }, { "Content-Disposition": "attachment; filename=blockly-records.json" });
    return;
  }
  if (url.pathname === "/api/auth/register" && request.method === "POST") {
    assertLocalAuthEnabled();
    assertSameOrigin(request);
    const body = await parseJson(request);
    const allowed = new Set(["username", "password", "teamAction", "teamName", "inviteCode", "group"]);
    const expectedKeys = body.teamAction === "create"
      ? ["username", "password", "teamAction", "teamName"]
      : ["username", "password", "teamAction", "inviteCode"];
    if (body.group !== undefined) expectedKeys.push("group");
    if (!Object.keys(body).every(key => allowed.has(key))
      || !["create", "join"].includes(body.teamAction)
      || !exactKeys(body, expectedKeys)) {
      throw new HttpError(400, "INVALID_REQUEST", "注册信息不完整或包含无法识别的字段。" );
    }
    const username = normalizedText(body.username, 32, "用户名");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(username)) {
      throw new HttpError(400, "INVALID_USERNAME", "用户名需为 3–32 位英文、数字、点、下划线或连字符。" );
    }
    if (typeof body.password !== "string" || body.password.length < 10 || body.password.length > 128) {
      throw new HttpError(400, "INVALID_PASSWORD", "密码需为 10–128 个字符。" );
    }
    if (store.users.some(user => user.username.toLowerCase() === username.toLowerCase())) {
      throw new HttpError(409, "USERNAME_TAKEN", "这个用户名已经被使用，请换一个。" );
    }
    if (store.users.length >= MAX_USERS) {
      throw new HttpError(503, "USER_CAPACITY_REACHED", "参赛账户数量已达上限，请联系管理员。" );
    }
    // 旧客户端未传分组时安全归入小学组；新客户端只接受三组制值及历史别名。
    const group = body.group === undefined ? DEFAULT_PARTICIPANT_GROUP : requestedParticipantGroup(body.group);
    const team = body.teamAction === "create"
      ? createTeamInStore(store, normalizedTeamName(body.teamName))
      : store.teams.find(item => item.inviteCode === normalizedInviteCode(body.inviteCode));
    if (!team) throw new HttpError(404, "TEAM_INVITE_NOT_FOUND", "未找到这个邀请码对应的队伍，请向队友确认后重试。" );
    const password = passwordHash(body.password);
    const user = {
      id: randomId("usr"), username, displayName: username, teamId: team.id, group, role: "user",
      passwordSalt: password.salt, passwordHash: password.hash, createdAt: nowIso()
    };
    store.users.push(user);
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    store.sessions.push({ tokenHash: sha256(token), userId: user.id, expiresAt });
    await writeStore();
    sendJson(response, 201, {
      schemaVersion: "chenlong.blockly-auth/v1", authenticated: true, user: publicUser(user),
      teamInviteCode: body.teamAction === "create" ? team.inviteCode : null,
      authoritative: false
    }, { "Set-Cookie": cookieHeader(token, expiresAt) });
    return;
  }
  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    assertLocalAuthEnabled();
    assertSameOrigin(request);
    const body = await parseJson(request);
    if (!exactKeys(body, ["username", "password"])) throw new HttpError(400, "INVALID_REQUEST", "登录信息格式不正确。" );
    const username = normalizedText(body.username, 32, "用户名");
    const user = store.users.find(item => item.username.toLowerCase() === username.toLowerCase());
    if (!user || typeof body.password !== "string" || !passwordMatches(user, body.password)) {
      throw new HttpError(401, "INVALID_CREDENTIALS", "用户名或密码不正确。" );
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    store.sessions.push({ tokenHash: sha256(token), userId: user.id, expiresAt });
    await writeStore();
    sendJson(response, 200, { schemaVersion: "chenlong.blockly-auth/v1", authenticated: true, user: publicUser(user), authoritative: false }, { "Set-Cookie": cookieHeader(token, expiresAt) });
    return;
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    assertLocalAuthEnabled();
    assertSameOrigin(request);
    const token = readCookie(request, COOKIE_NAME);
    if (token) {
      store.sessions = store.sessions.filter(session => session.tokenHash !== sha256(token));
      await writeStore();
    }
    response.writeHead(204, { "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`, "Cache-Control": "no-store, max-age=0" });
    response.end();
    return;
  }
  if (url.pathname === "/api/records" && request.method === "GET") {
    const { user } = principal(request);
    const pagination = recordPagination(url);
    const selected = recordStore.page({
      ownerUserId: user.id,
      page: pagination.page,
      pageSize: pagination.pageSize
    });
    const records = selected.records.map(recordSummary);
    sendJson(response, 200, {
      schemaVersion: "chenlong.blockly-records/v1",
      records,
      pagination: {
        ...selected.pagination,
        truncated: pagination.legacy && selected.pagination.total > records.length
      },
      authoritative: false
    });
    return;
  }
  const detailMatch = url.pathname.match(/^\/api\/records\/(run_[a-f0-9]{32})$/);
  if (detailMatch && request.method === "GET") {
    const { user } = principal(request);
    const record = recordStore.findById(detailMatch[1], { ownerUserId: user.id });
    if (!record) throw new HttpError(404, "RECORD_NOT_FOUND", "没有找到这条运行记录。" );
    sendJson(response, 200, { schemaVersion: "chenlong.blockly-record-detail/v1", record: { ...record, authoritative: false }, authoritative: false });
    return;
  }
  const submitMatch = url.pathname.match(/^\/api\/records\/(run_[a-f0-9]{32})\/submit$/);
  if (submitMatch && request.method === "POST") {
    const { user } = principal(request);
    assertSameOrigin(request);
    const body = await parseJson(request);
    if (!exactKeys(body, [])) throw new HttpError(400, "INVALID_SUBMIT_REQUEST", "提交请求格式不正确。" );
    const submission = recordStore.submit(submitMatch[1], user.id, nowIso());
    if (!submission) throw new HttpError(404, "RECORD_NOT_FOUND", "没有找到这条运行记录。" );
    const { record, duplicate } = submission;
    sendJson(response, 200, {
      schemaVersion: "chenlong.blockly-record-submit-receipt/v1",
      record: recordSummary(record),
      duplicate,
      authoritative: false
    });
    return;
  }
  if (url.pathname === "/api/records" && request.method === "POST") {
    const account = principal(request);
    const { user } = account;
    assertSameOrigin(request);
    const body = await parseJson(request);
    if (!exactKeys(body, ["taskId", "mapRevision", "mapDigest", "completed", "checkpointCount", "targetDeliveredCount", "distractorClearedCount", "failedObstacleCount", "goalReached", "blockedMoves", "offRoadEpisodes", "offRoadDurationMs", "durationMs", "programCode", "workspaceXml", "executionTrace"])) {
      throw new HttpError(400, "INVALID_RECORD", "运行记录格式不正确。" );
    }
    const executionTrace = normalizeExecutionTrace(body.executionTrace);
    const capabilityUsage = deriveCapabilityUsage(executionTrace);
    const task = PRIMARY_TASKS[body.taskId];
    const minimumMapRevision = account.identitySource === "platform" ? 0 : 1;
    if (!task || typeof body.completed !== "boolean"
      || !Number.isInteger(body.mapRevision) || body.mapRevision < minimumMapRevision
      || typeof body.mapDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.mapDigest)
      || !Number.isInteger(body.checkpointCount) || body.checkpointCount < 0 || body.checkpointCount > task.checkpoints
      || !Number.isInteger(body.targetDeliveredCount) || body.targetDeliveredCount < 0 || body.targetDeliveredCount > task.objects
      || !Number.isInteger(body.distractorClearedCount) || body.distractorClearedCount < 0 || body.distractorClearedCount > task.objects
      || !Number.isInteger(body.failedObstacleCount) || body.failedObstacleCount < 0 || body.failedObstacleCount > task.objects
      || body.failedObstacleCount > body.blockedMoves
      || typeof body.goalReached !== "boolean"
      || !Number.isInteger(body.blockedMoves) || body.blockedMoves < 0 || body.blockedMoves > 99
      || !Number.isInteger(body.offRoadEpisodes) || body.offRoadEpisodes < 0 || body.offRoadEpisodes > 99
      || !Number.isSafeInteger(body.offRoadDurationMs) || body.offRoadDurationMs < 0 || body.offRoadDurationMs > body.durationMs
      || !Number.isSafeInteger(body.durationMs) || body.durationMs < 0 || body.durationMs > 10 * 60 * 1000
      || typeof body.programCode !== "string" || body.programCode.length > MAX_PROGRAM_CHARS
      || typeof body.workspaceXml !== "string" || body.workspaceXml.length > MAX_PROGRAM_CHARS) {
      throw new HttpError(400, "INVALID_RECORD", "运行记录内容不正确。" );
    }
    const taskProgress = primaryGuangyangScoring.compositeTaskProgress({
      checkpointCount: body.checkpointCount,
      checkpointTotal: task.checkpoints,
      targetDeliveredCount: body.targetDeliveredCount,
      targetTotal: task.objects,
      distractorClearedCount: body.distractorClearedCount,
      distractorTotal: task.objects,
      failedObstacleCount: body.failedObstacleCount,
      obstacleTotal: task.objects,
      goalReached: body.goalReached
    });
    if (body.completed !== taskProgress.finished) {
      throw new HttpError(400, "INVALID_RECORD", "运行记录的完成状态与任务证据不一致。" );
    }
    const runMapVersion = account.identitySource === "platform"
      ? platformMapVersion(request, body.taskId, body.mapRevision, body.mapDigest)
      : mapVersion(body.taskId, body.mapRevision, body.mapDigest);
    const score = scoreRun({ ...body, task, taskProgress });
    const record = {
      id: randomId("run"),
      ownerUserId: user.id,
      taskId: body.taskId,
      taskName: task.name,
      completed: body.completed,
      checkpointCount: body.checkpointCount,
      checkpointTotal: task.checkpoints,
      taskCompleted: taskProgress.completed,
      taskTotal: taskProgress.total,
      targetDeliveredCount: taskProgress.targetDeliveredCount,
      distractorClearedCount: taskProgress.distractorClearedCount,
      failedObstacleCount: taskProgress.failedObstacleCount,
      goalReached: taskProgress.goalReached,
      mapRevision: runMapVersion.revision,
      mapDigest: runMapVersion.digest,
      mapLayout: primaryGuangyangMaps.clone(runMapVersion.layout),
      blockedMoves: body.blockedMoves,
      offRoadEpisodes: body.offRoadEpisodes,
      offRoadDurationMs: body.offRoadDurationMs,
      durationMs: body.durationMs,
      score: score.total,
      scoreBreakdown: score,
      programCode: body.programCode,
      workspaceXml: body.workspaceXml,
      executionTrace,
      capabilityUsage,
      ...ownerSnapshot(user),
      recordState: "saved",
      savedAt: nowIso(),
      submittedAt: null,
      createdAt: nowIso()
    };
    recordStore.insert(record);
    sendJson(response, 201, { schemaVersion: "chenlong.blockly-record-save-receipt/v1", record: recordSummary(record), authoritative: false });
    return;
  }
  throw new HttpError(404, "NOT_FOUND", "请求的接口不存在。" );
}

function mimeType(fileName) {
  if (fileName.endsWith(".html")) return "text/html; charset=utf-8";
  if (fileName.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (fileName.endsWith(".css")) return "text/css; charset=utf-8";
  if (fileName.endsWith(".svg")) return "image/svg+xml";
  if (fileName.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function serveStatic(response, pathname) {
  const relative = STATIC_FILES.get(pathname);
  if (!relative) throw new HttpError(404, "NOT_FOUND", "页面不存在。" );
  const filePath = path.join(__dirname, relative);
  const body = fs.readFileSync(filePath);
  response.writeHead(200, {
    "Content-Type": mimeType(relative),
    "Content-Length": body.length,
    "Cache-Control": "no-store, max-age=0",
    ...SECURITY_HEADERS
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else if (request.method === "GET" || request.method === "HEAD") {
      if (request.method === "HEAD") {
        const relative = STATIC_FILES.get(url.pathname);
        if (!relative) throw new HttpError(404, "NOT_FOUND", "页面不存在。" );
        const stat = fs.statSync(path.join(__dirname, relative));
        response.writeHead(200, {
          "Content-Type": mimeType(relative),
          "Content-Length": stat.size,
          "Cache-Control": "no-store, max-age=0",
          ...SECURITY_HEADERS
        });
        response.end();
      } else serveStatic(response, url.pathname);
    } else throw new HttpError(405, "METHOD_NOT_ALLOWED", "不支持这个请求方式。" );
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof HttpError ? error.message : "服务暂时无法处理请求。";
    if (!response.headersSent) sendJson(response, status, { error: { code, message }, authoritative: false });
    else response.destroy();
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`${JSON.stringify({ status: "listening", url: `http://${HOST}:${PORT}/`, dataDir: DATA_DIR })}\n`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(async () => {
    try { await pendingStoreWrite; } catch (_error) {}
    try { recordStore.close(); } catch (_error) {}
    releaseWriterLock();
    process.exit(0);
  });
  setTimeout(() => {
    try { recordStore.close(); } catch (_error) {}
    releaseWriterLock();
    process.exit(1);
  }, 5_000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
