"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const zlib = require("node:zlib");

const BATCH_PATH = "/v1/score/batch-download";
const DOWNLOAD_PATH_PREFIX = "/v1/score/download/";
const STATE_SCHEMA_VERSION = "chenlong.score-download-state/v1";
const SNAPSHOT_SCHEMA_VERSION = "chenlong.official-score-snapshot/v1";
const CSV_COLUMNS = Object.freeze([
  "user_id",
  "team_id",
  "team_name",
  "group_type",
  "score_task1",
  "score_task2",
  "total_score",
  "group_rank",
  "promote_status",
  "evaluate_finish_time"
]);
const STAGES = new Set(["preliminary", "rematch"]);
const GROUP_TYPES = new Set(["primary", "junior", "high"]);
const GROUP_TYPE_ALIASES = Object.freeze({
  primary: "primary",
  primary_low: "primary",
  primary_high: "primary",
  primary_school: "primary",
  junior: "junior",
  middle_school: "junior",
  high: "high",
  high_school: "high",
  senior: "high"
});
const PULL_TYPES = new Set(["all", "increment"]);
const ALLOWED_BODY_KEYS = new Set([
  "competition_stage", "group_type", "pull_type", "last_update_time"
]);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_EXPORT_ROWS = 50_000;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_FIELD_BYTES = 512;
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
const DOWNLOAD_TTL_SECONDS = 24 * 60 * 60;
const DAILY_LIMIT = 5;
const INCREMENT_RATE_LIMIT = 60;
const INCREMENT_RATE_WINDOW_SECONDS = 60;
const SCORE_SOURCE_MESSAGES = Object.freeze({
  LIVE_STAGE_UNAVAILABLE: "当前实时成绩源不支持该赛段，请先配置该赛段的冻结快照",
  LIVE_INCREMENT_UNAVAILABLE: "实时成绩源不能保证权威增量，请使用声明支持增量的冻结快照",
  LIVE_PROMOTION_UNAVAILABLE: "权威晋级状态尚未配置，已停止生成成绩包",
  LIVE_SNAPSHOT_UNSTABLE: "成绩数据在读取期间持续变化，请稍后重试",
  SNAPSHOT_STAGE_UNAVAILABLE: "冻结成绩快照不包含所请求的赛段",
  SNAPSHOT_INCREMENT_INCOMPLETE: "冻结成绩快照未声明可进行权威增量导出",
  SNAPSHOT_UNSTABLE: "冻结成绩快照正在更新，请稍后重试"
});

class ScoreDownloadApiError extends Error {
  constructor(httpStatus, apiCode, message) {
    super(message);
    this.name = "ScoreDownloadApiError";
    this.httpStatus = httpStatus;
    this.apiCode = apiCode;
  }
}

function fail(httpStatus, apiCode, message) {
  throw new ScoreDownloadApiError(httpStatus, apiCode, message);
}

function writeJson(response, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  response.end(body);
}

function errorResponse(response, error) {
  const known = error instanceof ScoreDownloadApiError;
  writeJson(response, known ? error.httpStatus : 500, {
    code: known ? error.apiCode : 5001,
    message: known ? error.message : "服务器内部错误"
  });
}

function strictHeader(request, name, { required = true } = {}) {
  const lower = name.toLowerCase();
  if (Array.isArray(request.rawHeaders)) {
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (String(request.rawHeaders[index]).toLowerCase() === lower) count += 1;
    }
    if (count > 1) fail(400, 4001, `${name} 请求头不能重复`);
  }
  const value = request.headers?.[lower];
  if (Array.isArray(value)) fail(400, 4001, `${name} 请求头不能重复`);
  if (value === undefined || value === null || String(value).trim() === "") {
    if (required) fail(400, 4001, `缺少 ${name} 请求头`);
    return null;
  }
  return String(value).trim();
}

function normalizeIp(value) {
  if (typeof value !== "string") return null;
  let ip = value.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (ip.toLowerCase().startsWith("::ffff:") && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return net.isIP(ip) ? ip.toLowerCase() : null;
}

function normalizeIpList(values, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    throw new TypeError(`${label} must be a non-empty array of exact IP addresses`);
  }
  const result = new Set();
  for (const value of values) {
    const normalized = normalizeIp(String(value));
    if (!normalized) throw new TypeError(`${label} contains an invalid IP address`);
    result.add(normalized);
  }
  return result;
}

function normalizeIpAllowlist(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${label} must be a non-empty array of IP addresses or CIDR ranges`);
  }
  const blockList = new net.BlockList();
  for (const value of values) {
    const rule = String(value).trim();
    const slash = rule.indexOf("/");
    if (slash < 0) {
      const address = normalizeIp(rule);
      if (!address) throw new TypeError(`${label} contains an invalid IP address or CIDR range`);
      blockList.addAddress(address, net.isIP(address) === 4 ? "ipv4" : "ipv6");
      continue;
    }
    if (slash !== rule.lastIndexOf("/")) {
      throw new TypeError(`${label} contains an invalid IP address or CIDR range`);
    }
    const address = normalizeIp(rule.slice(0, slash));
    const prefixText = rule.slice(slash + 1).trim();
    const family = net.isIP(address);
    const maximumPrefix = family === 4 ? 32 : family === 6 ? 128 : -1;
    if (!/^(?:0|[1-9]\d*)$/.test(prefixText)) {
      throw new TypeError(`${label} contains an invalid IP address or CIDR range`);
    }
    const prefix = Number(prefixText);
    if (prefix > maximumPrefix) {
      throw new TypeError(`${label} contains an invalid IP address or CIDR range`);
    }
    blockList.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return Object.freeze({
    has(value) {
      const address = normalizeIp(value);
      return Boolean(address) && blockList.check(address, net.isIP(address) === 4 ? "ipv4" : "ipv6");
    }
  });
}

function sourceIp(request, trustedProxyIps) {
  const direct = normalizeIp(request.socket?.remoteAddress);
  if (!direct) fail(403, 4005, "无法确认请求来源 IP");
  if (!trustedProxyIps.has(direct)) return direct;
  const forwarded = strictHeader(request, "X-Forwarded-For", { required: true });
  const parts = forwarded.split(",").map(value => normalizeIp(value));
  if (!parts.length || parts.some(value => !value)) fail(403, 4005, "代理提供的来源 IP 无效");
  return parts[0];
}

function asciiCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "ascii"), Buffer.from(right, "ascii"));
}

function signatureParameters(body, appKey, timestamp) {
  const parameters = { AppKey: appKey, Timestamp: timestamp };
  for (const key of Object.keys(body)) parameters[key] = String(body[key]);
  return parameters;
}

function canonicalSignatureText(parameters, appSecret) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new TypeError("signature parameters must be an object");
  }
  if (typeof appSecret !== "string" || appSecret.length === 0) {
    throw new TypeError("AppSecret is required");
  }
  const pairs = Object.keys(parameters).sort(asciiCompare).map(key => `${key}=${parameters[key]}`);
  return `${pairs.join("&")}&AppSecret=${appSecret}`;
}

function computeRequestSign(parameters, appSecret) {
  return crypto.createHash("sha256")
    .update(canonicalSignatureText(parameters, appSecret), "utf8")
    .digest("hex");
}

function timingSafeHexEqual(actual, expected) {
  if (!/^[a-f0-9]{64}$/.test(actual)) return false;
  const left = Buffer.from(actual, "ascii");
  const right = Buffer.from(expected, "ascii");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function readJsonBody(request) {
  const contentType = strictHeader(request, "Content-Type");
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    fail(400, 4001, "Content-Type 必须为 application/json; charset=utf-8");
  }
  const contentLength = request.headers?.["content-length"];
  if (contentLength !== undefined && (!/^\d+$/.test(String(contentLength))
    || Number(contentLength) > MAX_BODY_BYTES)) {
    request.resume();
    fail(400, 4001, "请求体过大");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      request.resume();
      fail(400, 4001, "请求体过大");
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch (_error) {
    fail(400, 4001, "请求体不是有效 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, 4001, "请求体必须是 JSON 对象");
  }
  return value;
}

function validateBatchParameters(value) {
  for (const key of Object.keys(value)) {
    if (!ALLOWED_BODY_KEYS.has(key)) fail(400, 4001, `不支持的请求参数：${key}`);
  }
  if (typeof value.competition_stage !== "string" || !STAGES.has(value.competition_stage)) {
    fail(400, 4001, "competition_stage 必须为 preliminary 或 rematch");
  }
  if (value.group_type !== undefined
    && (typeof value.group_type !== "string" || !GROUP_TYPES.has(value.group_type))) {
    fail(400, 4001, "group_type 参数无效");
  }
  if (value.pull_type !== undefined
    && (typeof value.pull_type !== "string" || !PULL_TYPES.has(value.pull_type))) {
    fail(400, 4001, "pull_type 参数无效");
  }
  const pullType = value.pull_type || "all";
  if (pullType === "increment") {
    if (!Number.isSafeInteger(value.last_update_time) || value.last_update_time < 0
      || value.last_update_time > 9_999_999_999) {
      fail(400, 4001, "增量拉取必须提供有效的 last_update_time 秒级时间戳");
    }
  } else if (value.last_update_time !== undefined) {
    fail(400, 4001, "仅增量拉取可以提供 last_update_time");
  }
  return Object.freeze({
    competitionStage: value.competition_stage,
    groupType: value.group_type || null,
    pullType,
    lastUpdateTime: pullType === "increment" ? value.last_update_time : null
  });
}

function textField(value, name, { required = true } = {}) {
  if ((value === undefined || value === null || value === "") && !required) return "";
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)
    || Buffer.byteLength(value, "utf8") > MAX_TEXT_FIELD_BYTES) {
    throw new TypeError(`score row ${name} is invalid`);
  }
  return value.normalize("NFC").trim();
}

function integerField(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`score row ${name} is invalid`);
  }
  return value;
}

function normalizeScoreRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new TypeError("score row is invalid");
  const normalized = {
    user_id: textField(row.user_id, "user_id"),
    team_id: textField(row.team_id, "team_id"),
    team_name: textField(row.team_name, "team_name"),
    group_type: GROUP_TYPE_ALIASES[textField(row.group_type, "group_type").toLowerCase()] || "",
    score_task1: integerField(row.score_task1, "score_task1", 0, 75),
    score_task2: integerField(row.score_task2, "score_task2", 0, 25),
    total_score: integerField(row.total_score, "total_score", 0, 100),
    group_rank: 0,
    promote_status: integerField(row.promote_status, "promote_status", 0, 1),
    evaluate_finish_time: integerField(row.evaluate_finish_time, "evaluate_finish_time", 0, 9_999_999_999)
  };
  if (!GROUP_TYPES.has(normalized.group_type)) throw new TypeError("score row group_type is invalid");
  if (normalized.total_score !== normalized.score_task1 + normalized.score_task2) {
    throw new TypeError("score row total_score must equal score_task1 + score_task2");
  }
  return Object.freeze(normalized);
}

function assignGroupRanks(rows) {
  const groups = new Map([...GROUP_TYPES].map(group => [group, []]));
  const teams = new Map();
  const userIds = new Set();
  for (const row of rows) {
    if (userIds.has(row.user_id)) {
      throw new TypeError("score snapshot contains a duplicate user_id");
    }
    userIds.add(row.user_id);
    let team = teams.get(row.team_id);
    if (!team) {
      team = { representative: row, members: [row] };
      teams.set(row.team_id, team);
      groups.get(row.group_type).push(team);
      continue;
    }
    const current = team.representative;
    if (current.team_name !== row.team_name || current.group_type !== row.group_type
      || current.score_task1 !== row.score_task1 || current.score_task2 !== row.score_task2
      || current.total_score !== row.total_score || current.promote_status !== row.promote_status
      || current.evaluate_finish_time !== row.evaluate_finish_time) {
      throw new TypeError("score snapshot contains inconsistent rows for one team_id");
    }
    team.members.push(row);
  }
  const ranked = [];
  for (const group of GROUP_TYPES) {
    const members = groups.get(group).sort((left, right) => (
      right.representative.total_score - left.representative.total_score
      || Buffer.compare(
        Buffer.from(left.representative.team_id, "utf8"),
        Buffer.from(right.representative.team_id, "utf8")
      )
    ));
    let previousScore = null;
    let previousRank = 0;
    for (let index = 0; index < members.length; index += 1) {
      const team = members[index];
      const rank = previousScore === team.representative.total_score ? previousRank : index + 1;
      team.members.sort((left, right) => Buffer.compare(
        Buffer.from(left.user_id, "utf8"), Buffer.from(right.user_id, "utf8")
      ));
      for (const row of team.members) ranked.push(Object.freeze({ ...row, group_rank: rank }));
      previousScore = team.representative.total_score;
      previousRank = rank;
    }
  }
  return ranked;
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function scoreRowsCsv(rows) {
  const lines = [CSV_COLUMNS.map(csvCell).join(",")];
  for (const row of rows) lines.push(CSV_COLUMNS.map(column => csvCell(row[column])).join(","));
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xFFFFFFFF;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xFF] ^ (value >>> 8);
  return (value ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(epochSeconds) {
  const date = new Date(Math.max(epochSeconds, 315532800) * 1000);
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  };
}

function createScoreZip(csv, snapshotTime) {
  const name = Buffer.from("score.csv", "utf8");
  const compressed = zlib.deflateRawSync(csv, { level: 9 });
  const checksum = crc32(csv);
  const timestamp = dosDateTime(snapshotTime);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034B50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(timestamp.time, 10);
  local.writeUInt16LE(timestamp.date, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(csv.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014B50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(timestamp.time, 12);
  central.writeUInt16LE(timestamp.date, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(csv.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  const centralOffset = local.length + name.length + compressed.length;
  const centralSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([local, name, compressed, central, name, end]);
}

function encryptZip(zip, publicKey) {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(zip), cipher.final()]);
  const encryptedKey = crypto.publicEncrypt({
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256"
  }, aesKey);
  return {
    encryptedFile: Buffer.concat([iv, ciphertext]),
    encryptedKeyBase64: encryptedKey.toString("base64")
  };
}

function normalizeRsaPublicKey(value) {
  let key;
  try {
    key = crypto.createPublicKey(value);
  } catch (_error) {
    throw new TypeError("score download RSA public key is invalid");
  }
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 2048) {
    throw new TypeError("score download RSA public key must be RSA-2048");
  }
  return key;
}

function normalizeApps(apps) {
  if (apps === undefined || apps === null) return new Map();
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) {
    throw new TypeError("score download apps must be an object keyed by AppKey");
  }
  const result = new Map();
  for (const [appKey, value] of Object.entries(apps)) {
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(appKey) || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("score download AppKey configuration is invalid");
    }
    if (typeof value.appSecret !== "string" || Buffer.byteLength(value.appSecret, "utf8") < 32) {
      throw new TypeError(`score download AppSecret for ${appKey} must contain at least 32 UTF-8 bytes`);
    }
    result.set(appKey, Object.freeze({
      appKey,
      appSecret: value.appSecret,
      enabled: value.enabled !== false,
      ipAllowlist: normalizeIpAllowlist(value.ipAllowlist, `ipAllowlist for ${appKey}`),
      rsaPublicKey: normalizeRsaPublicKey(value.rsaPublicKey)
    }));
  }
  return result;
}

function freshState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    replay: {},
    inflight: {},
    daily: {},
    incremental: {},
    artifacts: {}
  };
}

function validStoredState(value) {
  return value && value.schemaVersion === STATE_SCHEMA_VERSION
    && value.replay && typeof value.replay === "object" && !Array.isArray(value.replay)
    && value.inflight && typeof value.inflight === "object" && !Array.isArray(value.inflight)
    && value.daily && typeof value.daily === "object" && !Array.isArray(value.daily)
    && (value.incremental === undefined
      || (value.incremental && typeof value.incremental === "object" && !Array.isArray(value.incremental)))
    && value.artifacts && typeof value.artifacts === "object" && !Array.isArray(value.artifacts);
}

function safeArtifactName(value) {
  return typeof value === "string" && /^score-[a-f0-9]{32}\.zip\.enc$/.test(value);
}

class PersistentDownloadState {
  constructor({
    statePath,
    artifactDir,
    nowSeconds,
    incrementRateLimit = INCREMENT_RATE_LIMIT,
    incrementRateWindowSeconds = INCREMENT_RATE_WINDOW_SECONDS
  }) {
    this.statePath = path.resolve(statePath);
    this.artifactDir = path.resolve(artifactDir);
    this.nowSeconds = nowSeconds;
    if (!Number.isSafeInteger(incrementRateLimit) || incrementRateLimit < 1 || incrementRateLimit > 10_000) {
      throw new TypeError("score download incremental rate limit must be an integer from 1 to 10000");
    }
    if (!Number.isSafeInteger(incrementRateWindowSeconds)
      || incrementRateWindowSeconds < 1 || incrementRateWindowSeconds > 86_400) {
      throw new TypeError("score download incremental rate window must be an integer from 1 to 86400 seconds");
    }
    this.incrementRateLimit = incrementRateLimit;
    this.incrementRateWindowSeconds = incrementRateWindowSeconds;
    this.tail = Promise.resolve();
  }

  runExclusive(operation) {
    const run = this.tail.then(async () => {
      const state = await this.read();
      const cleanup = this.prune(state, this.nowSeconds());
      const result = await operation(state);
      await this.write(state);
      await Promise.all(cleanup.map(name => this.removeArtifact(name)));
      return result;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  async read() {
    let text;
    try {
      text = await fsp.readFile(this.statePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return freshState();
      throw error;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch (_error) {
      throw new Error("score download state is corrupt");
    }
    if (!validStoredState(value)) throw new Error("score download state is incompatible");
    // v1 state files created before incremental pulls had no independent rate
    // bucket.  Initializing it in memory preserves those durable quotas and
    // upgrades the file atomically on the next operation.
    if (value.incremental === undefined) value.incremental = {};
    return value;
  }

  async write(state) {
    await fsp.mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await fsp.rename(temporary, this.statePath);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  prune(state, now) {
    const cleanup = [];
    for (const [key, expiresAt] of Object.entries(state.replay)) {
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) delete state.replay[key];
    }
    for (const [key, reservation] of Object.entries(state.inflight)) {
      const pullType = reservation?.pullType
        || (typeof reservation?.day === "string" ? "all" : null);
      const validDay = pullType === "all"
        ? typeof reservation?.day === "string"
        : pullType === "increment" && reservation?.day === null;
      if (!reservation || !Number.isSafeInteger(reservation.expiresAt) || reservation.expiresAt <= now
        || typeof reservation.appKey !== "string" || !PULL_TYPES.has(pullType) || !validDay) {
        delete state.inflight[key];
      } else {
        // Reservations from the original v1 state did not store pullType; all
        // such reservations necessarily belonged to the full-package quota.
        reservation.pullType = pullType;
      }
    }
    const currentDay = chinaDay(now);
    for (const key of Object.keys(state.daily)) {
      if (!key.endsWith(`\0${currentDay}`)) delete state.daily[key];
    }
    const incrementCutoff = now - this.incrementRateWindowSeconds;
    for (const [appKey, timestamps] of Object.entries(state.incremental)) {
      if (!Array.isArray(timestamps)
        || timestamps.some(value => !Number.isSafeInteger(value)
          || value < 0 || value > now + TIMESTAMP_TOLERANCE_SECONDS)) {
        throw new Error("score download incremental rate state is corrupt");
      }
      const active = timestamps.filter(value => value > incrementCutoff);
      if (active.length) state.incremental[appKey] = active;
      else delete state.incremental[appKey];
    }
    for (const [tokenHash, artifact] of Object.entries(state.artifacts)) {
      if (!artifact || !safeArtifactName(artifact.fileName)
        || !Number.isSafeInteger(artifact.expiresAt) || artifact.expiresAt <= now) {
        if (safeArtifactName(artifact?.fileName)) cleanup.push(artifact.fileName);
        delete state.artifacts[tokenHash];
      }
    }
    return cleanup;
  }

  async removeArtifact(fileName) {
    if (!safeArtifactName(fileName)) return;
    await fsp.rm(path.join(this.artifactDir, fileName), { force: true }).catch(() => undefined);
  }

  reserveRequest({ appKey, replayHash, now, pullType }) {
    return this.runExclusive(state => {
      if (Number.isSafeInteger(state.replay[replayHash]) && state.replay[replayHash] > now) {
        fail(401, 4003, "相同签名在五分钟内只能使用一次");
      }
      if (!PULL_TYPES.has(pullType)) throw new TypeError("score download reservation pull type is invalid");
      const day = chinaDay(now);
      if (pullType === "all") {
        const dayKey = `${appKey}\0${day}`;
        const used = Number(state.daily[dayKey] || 0);
        if (!Number.isSafeInteger(used) || used < 0) throw new Error("score download daily state is corrupt");
        const pending = Object.values(state.inflight)
          .filter(item => item?.appKey === appKey
            && (item.pullType || "all") === "all" && item.day === day).length;
        if (used + pending >= DAILY_LIMIT) fail(429, 4006, "当日全量打包调用次数已达到上限");
      } else {
        const incrementKey = `${appKey}\0increment`;
        const active = state.incremental[incrementKey] || [];
        if (!Array.isArray(active)) throw new Error("score download incremental rate state is corrupt");
        if (active.length >= this.incrementRateLimit) {
          fail(429, 4006, "增量打包调用频率已达到上限");
        }
        active.push(now);
        state.incremental[incrementKey] = active;
      }
      state.replay[replayHash] = now + TIMESTAMP_TOLERANCE_SECONDS;
      state.inflight[replayHash] = {
        appKey,
        pullType,
        day: pullType === "all" ? day : null,
        expiresAt: now + TIMESTAMP_TOLERANCE_SECONDS
      };
      return true;
    });
  }

  releaseReservation(replayHash) {
    return this.runExclusive(state => {
      delete state.inflight[replayHash];
    });
  }

  registerArtifact(tokenHash, artifact, replayHash) {
    return this.runExclusive(state => {
      if (state.artifacts[tokenHash]) throw new Error("score download token collision");
      const reservation = state.inflight[replayHash];
      if (!reservation || reservation.appKey !== artifact.appKey) {
        throw new Error("score download reservation is missing");
      }
      const pullType = reservation.pullType || "all";
      if (!PULL_TYPES.has(pullType)) throw new Error("score download reservation is invalid");
      if (pullType === "all") {
        const dayKey = `${reservation.appKey}\0${reservation.day}`;
        const used = Number(state.daily[dayKey] || 0);
        if (!Number.isSafeInteger(used) || used < 0 || used >= DAILY_LIMIT) {
          throw new Error("score download daily state is invalid");
        }
        state.daily[dayKey] = used + 1;
      }
      delete state.inflight[replayHash];
      state.artifacts[tokenHash] = artifact;
      return artifact;
    });
  }

  findArtifact(tokenHash, { now }) {
    return this.runExclusive(state => {
      const artifact = state.artifacts[tokenHash];
      if (!artifact || artifact.expiresAt <= now || typeof artifact.appKey !== "string"
        || !safeArtifactName(artifact.fileName)) return null;
      return { ...artifact };
    });
  }
}

function chinaDay(epochSeconds) {
  return new Date((epochSeconds + (8 * 60 * 60)) * 1000).toISOString().slice(0, 10);
}

async function saveEncryptedArtifact(state, encryptedFile, metadata) {
  await fsp.mkdir(state.artifactDir, { recursive: true });
  const fileName = `score-${crypto.randomBytes(16).toString("hex")}.zip.enc`;
  const destination = path.join(state.artifactDir, fileName);
  const temporary = `${destination}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, encryptedFile, { flag: "wx", mode: 0o600 });
  try {
    await fsp.rename(temporary, destination);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    const { replayHash, ...artifactMetadata } = metadata;
    await state.registerArtifact(
      metadata.tokenHash,
      { ...artifactMetadata, fileName, fileSize: encryptedFile.length },
      replayHash
    );
  } catch (error) {
    await fsp.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
  return { fileName, fileSize: encryptedFile.length };
}

function normalizePublicOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("score download public origin must be one HTTP(S) origin");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new TypeError("score download public origin must use HTTPS");
  return url.origin;
}

function normalizeSourceResult(result, criteria, now) {
  const rows = Array.isArray(result) ? result : result?.rows;
  const snapshotTime = Array.isArray(result) ? now : Number(result?.snapshotTime ?? now);
  if (!Array.isArray(rows) || !Number.isSafeInteger(snapshotTime) || snapshotTime < 0
    || snapshotTime > now + TIMESTAMP_TOLERANCE_SECONDS) {
    throw new TypeError("score data source returned an invalid snapshot");
  }
  const sourceRows = [];
  for (const raw of rows) {
    const row = normalizeScoreRow(raw);
    if (row.evaluate_finish_time > snapshotTime) throw new TypeError("score row is newer than snapshot_time");
    sourceRows.push(row);
  }
  const normalized = [];
  for (const row of assignGroupRanks(sourceRows)) {
    if (criteria.groupType && row.group_type !== criteria.groupType) continue;
    if (criteria.pullType === "increment" && row.evaluate_finish_time <= criteria.lastUpdateTime) continue;
    normalized.push(row);
    if (normalized.length > MAX_EXPORT_ROWS) fail(503, 5002, "成绩数量超过 5 万条，无法生成当前快照");
  }
  return { rows: normalized, snapshotTime };
}

function normalizeAppsFromEnvironment(env, explicitApps) {
  if (explicitApps !== undefined) return explicitApps;
  const filePath = env.CHENLONG_SCORE_DOWNLOAD_APPS_FILE;
  const inline = env.CHENLONG_SCORE_DOWNLOAD_APPS_JSON;
  if (filePath && inline) throw new TypeError("configure only one score download apps source");
  if (!filePath && !inline) return {};
  const text = filePath ? fs.readFileSync(path.resolve(filePath), "utf8") : inline;
  return JSON.parse(text);
}

async function readSnapshotBufferOnce(resolved) {
  const before = await fsp.lstat(resolved);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_SNAPSHOT_BYTES) {
    throw new TypeError("score snapshot file is unsafe or too large");
  }
  const handle = await fsp.open(resolved, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== before.size
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("score snapshot file changed while being opened");
    }
    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (buffer.length !== opened.size || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error("score snapshot file changed while being read");
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

async function readStableSnapshotPayload(resolved) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const before = await readSnapshotBufferOnce(resolved);
      const after = await readSnapshotBufferOnce(resolved);
      const beforeDigest = crypto.createHash("sha256").update(before).digest();
      const afterDigest = crypto.createHash("sha256").update(after).digest();
      if (beforeDigest.length === afterDigest.length && crypto.timingSafeEqual(beforeDigest, afterDigest)) {
        return JSON.parse(after.toString("utf8"));
      }
      lastError = new Error("score snapshot file changed between reads");
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error(`score snapshot is not stable: ${lastError?.message || "unknown error"}`);
  error.code = "SNAPSHOT_UNSTABLE";
  throw error;
}

function createJsonScoreDataSource({ filePath, identityDataSource = null } = {}) {
  const resolved = path.resolve(filePath || "");
  if (!filePath) throw new TypeError("score snapshot file path is required");
  return {
    async listScoreRows(context) {
      const payload = await readStableSnapshotPayload(resolved);
      if (payload?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || !Array.isArray(payload.rows)
        || !Number.isSafeInteger(payload.snapshot_time)) {
        throw new TypeError("score snapshot file has an incompatible schema");
      }
      let rows = payload.rows.filter(row => row?.competition_stage === context.competitionStage);
      if (rows.length === 0) {
        const error = new Error("score snapshot does not contain the requested competition stage");
        error.code = "SNAPSHOT_STAGE_UNAVAILABLE";
        throw error;
      }
      if (context.pullType === "increment" && payload.incremental_complete !== true) {
        const error = new Error("score snapshot does not declare authoritative incremental completeness");
        error.code = "SNAPSHOT_INCREMENT_INCOMPLETE";
        throw error;
      }
      if (identityDataSource) {
        if (typeof identityDataSource.resolveMany !== "function") {
          throw new TypeError("identityDataSource.resolveMany is required");
        }
        const mappings = await identityDataSource.resolveMany(rows, context);
        if (!Array.isArray(mappings) || mappings.length !== rows.length) {
          throw new TypeError("identity data source returned incomplete mappings");
        }
        rows = rows.map((row, index) => ({ ...row, ...mappings[index] }));
      }
      return { rows, snapshotTime: payload.snapshot_time };
    }
  };
}

function createMappedScoreDataSource(scoreDataSource, identityDataSource) {
  if (typeof scoreDataSource?.listScoreRows !== "function"
    || typeof identityDataSource?.resolveMany !== "function") {
    throw new TypeError("score and identity data sources must implement listScoreRows/resolveMany");
  }
  return {
    async listScoreRows(context) {
      const result = await scoreDataSource.listScoreRows(context);
      const rows = Array.isArray(result) ? result : result?.rows;
      if (!Array.isArray(rows)) throw new TypeError("score data source returned invalid rows");
      const mappings = await identityDataSource.resolveMany(rows, context);
      if (!Array.isArray(mappings) || mappings.length !== rows.length) {
        throw new TypeError("identity data source returned incomplete mappings");
      }
      return {
        rows: rows.map((row, index) => ({ ...row, ...mappings[index] })),
        snapshotTime: Array.isArray(result) ? context.snapshotTime : result.snapshotTime
      };
    }
  };
}

function scoreContributions(taskScores, workshopScore) {
  const programming = [taskScores?.task1, taskScores?.task2, taskScores?.task3]
    .map(value => Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) : 0);
  const workshop = Number.isFinite(workshopScore) ? Math.min(Math.max(workshopScore, 0), 100) : 0;
  const scoreTask1 = Math.round(programming.reduce((sum, value) => sum + value, 0) / 4);
  const scoreTask2 = Math.round(workshop / 4);
  return Object.freeze({ score_task1: scoreTask1, score_task2: scoreTask2, total_score: scoreTask1 + scoreTask2 });
}

function createScoreDownloadService(config = {}) {
  const env = config.env || process.env;
  const nowSeconds = typeof config.nowSeconds === "function"
    ? config.nowSeconds
    : () => Math.floor(Date.now() / 1000);
  const runtimeDir = path.resolve(config.runtimeDir
    || env.CHENLONG_SCORE_DOWNLOAD_RUNTIME_DIR
    || path.join(process.cwd(), ".runtime", "score-download"));
  const apps = normalizeApps(normalizeAppsFromEnvironment(env, config.apps));
  const trustedProxyIps = normalizeIpList(config.trustedProxyIps
    ?? (env.CHENLONG_SCORE_DOWNLOAD_TRUSTED_PROXIES
      ? env.CHENLONG_SCORE_DOWNLOAD_TRUSTED_PROXIES.split(",").map(value => value.trim()).filter(Boolean)
      : []), "trusted proxy IPs", { allowEmpty: true });
  let scoreDataSource = config.scoreDataSource || null;
  const snapshotPath = config.snapshotPath || env.CHENLONG_SCORE_DOWNLOAD_SNAPSHOT_PATH;
  if (!scoreDataSource && snapshotPath) {
    scoreDataSource = createJsonScoreDataSource({ filePath: snapshotPath, identityDataSource: config.identityDataSource });
  }
  if (scoreDataSource && typeof scoreDataSource.listScoreRows !== "function") {
    throw new TypeError("scoreDataSource.listScoreRows is required");
  }
  const configuredOrigin = config.publicOrigin || env.CHENLONG_SCORE_DOWNLOAD_PUBLIC_ORIGIN || null;
  const state = new PersistentDownloadState({
    statePath: config.statePath || path.join(runtimeDir, "state.json"),
    artifactDir: config.artifactDir || path.join(runtimeDir, "artifacts"),
    nowSeconds,
    incrementRateLimit: config.incrementRateLimit ?? INCREMENT_RATE_LIMIT,
    incrementRateWindowSeconds: config.incrementRateWindowSeconds ?? INCREMENT_RATE_WINDOW_SECONDS
  });

  function appForRequest(request) {
    const appKey = strictHeader(request, "AppKey");
    const app = apps.get(appKey);
    if (!app || !app.enabled) fail(401, 4002, "AppKey 无效或已禁用");
    const requestIp = sourceIp(request, trustedProxyIps);
    if (!app.ipAllowlist.has(requestIp)) fail(403, 4005, "IP 不在白名单");
    return { app, appKey, requestIp };
  }

  async function batch(request, response, externalOrigin) {
    const rawBody = await readJsonBody(request);
    const criteria = validateBatchParameters(rawBody);
    const { app, appKey } = appForRequest(request);
    const timestampText = strictHeader(request, "Timestamp");
    if (!/^\d{10}$/.test(timestampText)) fail(401, 4004, "Timestamp 必须为 10 位秒级时间戳");
    const timestamp = Number(timestampText);
    const now = nowSeconds();
    if (Math.abs(now - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) {
      fail(401, 4004, "请求时间戳已过期");
    }
    const sign = strictHeader(request, "Sign");
    if (!/^[a-f0-9]{64}$/.test(sign)) fail(401, 4003, "Sign 必须为 64 位小写 SHA256");
    const parameters = signatureParameters(rawBody, appKey, timestampText);
    const expected = computeRequestSign(parameters, app.appSecret);
    if (!timingSafeHexEqual(sign, expected)) fail(401, 4003, "签名校验失败");
    const replayHash = crypto.createHash("sha256").update(`${appKey}\0${sign}`, "utf8").digest("hex");
    const origin = normalizePublicOrigin(configuredOrigin || externalOrigin);
    await state.reserveRequest({ appKey, replayHash, now, pullType: criteria.pullType });
    try {
      if (!scoreDataSource) fail(503, 5002, "官方成绩或身份映射数据源尚未就绪");
      let sourceResult;
      try {
        sourceResult = await scoreDataSource.listScoreRows({
          ...criteria,
          snapshotTime: now,
          maximumRows: MAX_EXPORT_ROWS + 1
        });
      } catch (error) {
        if (error instanceof ScoreDownloadApiError) throw error;
        fail(503, 5002, SCORE_SOURCE_MESSAGES[error?.code] || "成绩数据正在生成，请稍后重试");
      }
      let snapshot;
      try {
        snapshot = normalizeSourceResult(sourceResult, criteria, now);
      } catch (error) {
        if (error instanceof ScoreDownloadApiError) throw error;
        fail(503, 5002, "成绩快照不完整或格式无效");
      }
      const csv = scoreRowsCsv(snapshot.rows);
      const zip = createScoreZip(csv, snapshot.snapshotTime);
      const encrypted = encryptZip(zip, app.rsaPublicKey);
      const token = crypto.randomBytes(32).toString("base64url");
      const tokenHash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
      const expiresAt = now + DOWNLOAD_TTL_SECONDS;
      const downloadName = `score-${criteria.competitionStage}-${snapshot.snapshotTime}.zip.enc`;
      const saved = await saveEncryptedArtifact(state, encrypted.encryptedFile, {
        tokenHash,
        replayHash,
        appKey,
        createdAt: now,
        expiresAt,
        downloadName,
        competitionStage: criteria.competitionStage,
        pullType: criteria.pullType,
        snapshotTime: snapshot.snapshotTime
      });
      writeJson(response, 200, {
        code: 200,
        message: "success",
        data: {
          total: snapshot.rows.length,
          download_url: `${origin}${DOWNLOAD_PATH_PREFIX}${token}`,
          file_size: saved.fileSize,
          encrypt_password: encrypted.encryptedKeyBase64,
          expire_time: expiresAt,
          snapshot_time: snapshot.snapshotTime
        }
      });
    } catch (error) {
      await state.releaseReservation(replayHash).catch(() => undefined);
      throw error;
    }
  }

  async function download(request, response, pathname) {
    const token = pathname.slice(DOWNLOAD_PATH_PREFIX.length);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(404, 4001, "下载地址无效或已过期");
    const requestIp = sourceIp(request, trustedProxyIps);
    const suppliedAppKey = strictHeader(request, "AppKey", { required: false });
    const tokenHash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
    const artifact = await state.findArtifact(tokenHash, { now: nowSeconds() });
    if (!artifact) fail(404, 4001, "下载地址无效或已过期");
    if (suppliedAppKey !== null && suppliedAppKey !== artifact.appKey) {
      fail(404, 4001, "下载地址无效或已过期");
    }
    const app = apps.get(artifact.appKey);
    if (!app || !app.enabled) fail(404, 4001, "下载地址无效或已过期");
    if (!app.ipAllowlist.has(requestIp)) fail(403, 4005, "IP 不在白名单");
    const filePath = path.join(state.artifactDir, artifact.fileName);
    let stat;
    try {
      stat = await fsp.lstat(filePath);
    } catch (_error) {
      fail(404, 4001, "下载地址无效或已过期");
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.fileSize) {
      fail(404, 4001, "下载地址无效或已过期");
    }
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename="${artifact.downloadName}"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "X-Content-Encryption": "AES-256-CBC; iv-prefix=16"
    });
    await pipeline(fs.createReadStream(filePath), response);
  }

  return Object.freeze({
    configured: apps.size > 0 && Boolean(scoreDataSource),
    async handle(request, response, { pathname, externalOrigin }) {
      try {
        if (pathname === BATCH_PATH) {
          if (request.method !== "POST") fail(405, 4001, "接口仅支持 POST", { Allow: "POST" });
          await batch(request, response, externalOrigin);
          return true;
        }
        if (pathname.startsWith(DOWNLOAD_PATH_PREFIX)) {
          if (request.method !== "GET") fail(405, 4001, "下载接口仅支持 GET");
          await download(request, response, pathname);
          return true;
        }
        return false;
      } catch (error) {
        if (!response.headersSent && !response.destroyed) errorResponse(response, error);
        else if (!response.writableEnded) response.destroy();
        return true;
      }
    }
  });
}

module.exports = Object.freeze({
  BATCH_PATH,
  DOWNLOAD_PATH_PREFIX,
  STATE_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  CSV_COLUMNS,
  MAX_EXPORT_ROWS,
  TIMESTAMP_TOLERANCE_SECONDS,
  DOWNLOAD_TTL_SECONDS,
  DAILY_LIMIT,
  INCREMENT_RATE_LIMIT,
  INCREMENT_RATE_WINDOW_SECONDS,
  ScoreDownloadApiError,
  canonicalSignatureText,
  computeRequestSign,
  scoreRowsCsv,
  createScoreZip,
  encryptZip,
  scoreContributions,
  createJsonScoreDataSource,
  createMappedScoreDataSource,
  createScoreDownloadService
});
