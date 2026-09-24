"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SSO_PARAMETER_NAMES = Object.freeze([
  "user_id", "team_id", "group_type", "team_name", "timestamp", "sign"
]);
const SSO_BUSINESS_PARAMETER_NAMES = Object.freeze(
  SSO_PARAMETER_NAMES.filter(name => name !== "sign").sort()
);
const SSO_GROUP_TYPES = new Map([
  ["primary", "primary"],
  ["primary_low", "primary"],
  ["primary_high", "primary"],
  ["junior", "junior"],
  ["high", "high"]
]);
const SSO_WINDOW_SECONDS = 5 * 60;
const SSO_REPLAY_SCHEMA_VERSION = "chenlong.official-sso-replay/v1";
const MAX_SSO_URL_BYTES = 8 * 1024;
const MAX_REPLAY_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SSO_AUDIT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SSO_AUDIT_FILES = 5;
const MAX_SSO_AUDIT_BYTES = 64 * 1024 * 1024;
const MAX_SSO_AUDIT_FILES = 20;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const SSO_ERRORS = Object.freeze({
  1001: Object.freeze({ statusCode: 400, message: "跳转参数不完整或格式不正确。" }),
  1002: Object.freeze({ statusCode: 400, message: "登录链接已过期，请返回大赛官网重新进入。" }),
  1003: Object.freeze({ statusCode: 403, message: "登录链接签名校验失败。" }),
  1004: Object.freeze({ statusCode: 403, message: "当前用户没有对应的参赛权限。" }),
  1005: Object.freeze({ statusCode: 409, message: "登录链接已失效，不能重复使用。" })
});

class OfficialSsoError extends Error {
  constructor(code, detail = "") {
    const definition = SSO_ERRORS[code] || SSO_ERRORS[1004];
    super(definition.message);
    this.name = "OfficialSsoError";
    this.code = String(code);
    this.statusCode = definition.statusCode;
    this.detail = detail;
  }
}

function requireSsoSecret(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 16) {
    throw new TypeError("CHENLONG_OFFICIAL_SSO_SECRET must contain at least 16 UTF-8 bytes");
  }
  return value;
}

function strictDecodeQueryComponent(value) {
  if (typeof value !== "string" || /%(?![0-9A-Fa-f]{2})/.test(value)) {
    throw new OfficialSsoError(1001, "invalid percent encoding");
  }
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch (_error) {
    throw new OfficialSsoError(1001, "invalid UTF-8 query encoding");
  }
}

function parseStrictSsoQuery(requestUrl) {
  if (typeof requestUrl !== "string" || Buffer.byteLength(requestUrl, "utf8") > MAX_SSO_URL_BYTES) {
    throw new OfficialSsoError(1001, "request URL is missing or too large");
  }
  const queryIndex = requestUrl.indexOf("?");
  const rawQuery = queryIndex < 0 ? "" : requestUrl.slice(queryIndex + 1);
  if (!rawQuery || rawQuery.includes("#")) throw new OfficialSsoError(1001, "query is missing");
  const pairs = rawQuery.split("&");
  if (pairs.length !== SSO_PARAMETER_NAMES.length || pairs.some(pair => pair.length === 0)) {
    throw new OfficialSsoError(1001, "query parameter count is invalid");
  }
  const values = Object.create(null);
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator < 1) throw new OfficialSsoError(1001, "query parameter is malformed");
    const name = strictDecodeQueryComponent(pair.slice(0, separator));
    const value = strictDecodeQueryComponent(pair.slice(separator + 1));
    if (!SSO_PARAMETER_NAMES.includes(name) || Object.hasOwn(values, name) || value.length === 0) {
      throw new OfficialSsoError(1001, "query parameter is unknown, repeated, or empty");
    }
    values[name] = value;
  }
  if (SSO_PARAMETER_NAMES.some(name => !Object.hasOwn(values, name))) {
    throw new OfficialSsoError(1001, "required query parameter is missing");
  }
  if (!EXTERNAL_ID_PATTERN.test(values.user_id) || !EXTERNAL_ID_PATTERN.test(values.team_id)) {
    throw new OfficialSsoError(1001, "external identity format is invalid");
  }
  const teamName = values.team_name.normalize("NFC").trim();
  if (teamName !== values.team_name || [...teamName].length < 1 || [...teamName].length > 64
    || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(teamName)) {
    throw new OfficialSsoError(1001, "team name is invalid");
  }
  if (!/^\d{10}$/.test(values.timestamp)) throw new OfficialSsoError(1002, "timestamp is invalid");
  return Object.freeze({ ...values });
}

function canonicalSsoPayload(parameters) {
  return SSO_BUSINESS_PARAMETER_NAMES.map(name => `${name}=${parameters[name]}`).join("&");
}

function calculateSsoSignature(parameters, secret) {
  return crypto.createHash("sha256")
    .update(`${canonicalSsoPayload(parameters)}&secret=${requireSsoSecret(secret)}`, "utf8")
    .digest("hex");
}

function verifySsoRequest(requestUrl, secret, now = Date.now()) {
  const parameters = parseStrictSsoQuery(requestUrl);
  const timestamp = Number(parameters.timestamp);
  const nowSeconds = Math.floor(Number(now) / 1000);
  if (!Number.isSafeInteger(nowSeconds) || Math.abs(nowSeconds - timestamp) > SSO_WINDOW_SECONDS) {
    throw new OfficialSsoError(1002, "timestamp is outside the allowed window");
  }
  const expected = Buffer.from(calculateSsoSignature(parameters, secret), "hex");
  const validSignFormat = /^[a-f0-9]{64}$/.test(parameters.sign);
  const actual = validSignFormat ? Buffer.from(parameters.sign, "hex") : Buffer.alloc(expected.length);
  const matches = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  if (!validSignFormat || !matches) throw new OfficialSsoError(1003, "signature mismatch");
  const canonicalGroup = SSO_GROUP_TYPES.get(parameters.group_type);
  if (!canonicalGroup) {
    throw new OfficialSsoError(1004, "group type is not eligible");
  }
  // The signature is always checked against the exact value supplied by the
  // website.  Only after verification do legacy four-group values collapse
  // into the three-group internal contract.
  return Object.freeze({ ...parameters, group_type: canonicalGroup });
}

function replayKey(parameters) {
  return crypto.createHash("sha256")
    .update(`${parameters.user_id}\n${parameters.timestamp}\n${parameters.sign}`, "utf8")
    .digest("hex");
}

async function atomicWriteJson(directory, filePath, value) {
  const temporary = path.join(directory, `.official-sso-replay.${crypto.randomUUID()}.tmp`);
  const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  let handle;
  try {
    handle = await fs.promises.open(temporary, "wx", 0o600);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
    throw error;
  }
}

function boundedAuditOption(name, value, fallback, maximum) {
  const candidate = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return candidate;
}

async function regularFileSize(filePath) {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("official SSO audit path is unsafe");
    return stat.size;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

class OfficialSsoReplayStore {
  constructor({
    rootDir,
    now = () => Date.now(),
    maxAuditBytes = DEFAULT_MAX_SSO_AUDIT_BYTES,
    maxAuditFiles = DEFAULT_MAX_SSO_AUDIT_FILES
  } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.filePath = path.join(this.rootDir, "official-sso-replay.json");
    this.auditPath = path.join(this.rootDir, "official-sso-audit.jsonl");
    this.now = now;
    this.maxAuditBytes = boundedAuditOption(
      "maxAuditBytes", maxAuditBytes, DEFAULT_MAX_SSO_AUDIT_BYTES, MAX_SSO_AUDIT_BYTES
    );
    this.maxAuditFiles = boundedAuditOption(
      "maxAuditFiles", maxAuditFiles, DEFAULT_MAX_SSO_AUDIT_FILES, MAX_SSO_AUDIT_FILES
    );
    this.entries = new Map();
    this.operationTail = Promise.resolve();
    this.auditTail = Promise.resolve();
    this.ready = this.initialize();
  }

  async initialize() {
    await fs.promises.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    let source = null;
    try {
      const stat = await fs.promises.lstat(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_REPLAY_FILE_BYTES) {
        throw new Error("unsafe replay file");
      }
      source = await fs.promises.readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (source !== null) {
      const value = JSON.parse(source);
      if (value?.schemaVersion !== SSO_REPLAY_SCHEMA_VERSION || !Array.isArray(value.entries)) {
        throw new Error("official SSO replay data is invalid");
      }
      for (const entry of value.entries) {
        if (!entry || typeof entry !== "object" || !/^[a-f0-9]{64}$/.test(entry.key)
          || !Number.isSafeInteger(entry.expiresAt)) throw new Error("official SSO replay entry is invalid");
        this.entries.set(entry.key, entry.expiresAt);
      }
    }
    const auditEntries = await fs.promises.readdir(this.rootDir, { withFileTypes: true });
    await Promise.all(auditEntries.map(async entry => {
      const match = entry.name.match(/^official-sso-audit\.(\d+)\.jsonl$/);
      if (!match || Number(match[1]) < this.maxAuditFiles) return;
      const target = path.join(this.rootDir, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("official SSO audit archive is unsafe");
      await fs.promises.rm(target, { force: true });
    }));
    await this.pruneAndPersist(false);
  }

  async pruneAndPersist(forceWrite = true) {
    const now = Number(this.now());
    let changed = false;
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (!forceWrite && !changed) return;
    await atomicWriteJson(this.rootDir, this.filePath, {
      schemaVersion: SSO_REPLAY_SCHEMA_VERSION,
      entries: [...this.entries].map(([key, expiresAt]) => ({ key, expiresAt }))
    });
  }

  async consume(parameters, operation) {
    await this.ready;
    const previous = this.operationTail;
    let release;
    this.operationTail = new Promise(resolve => { release = resolve; });
    await previous;
    const key = replayKey(parameters);
    try {
      const now = Number(this.now());
      for (const [storedKey, expiresAt] of this.entries) {
        if (expiresAt <= now) this.entries.delete(storedKey);
      }
      if (this.entries.has(key)) throw new OfficialSsoError(1005, "replay detected");
      // Keep the replay marker until the signed URL can no longer pass the
      // timestamp check. A future-dated URL remains valid for up to twice the
      // nominal skew from its first use, so an expiry based only on `now`
      // would reopen the same URL before its signature window closes.
      const sourceTimestamp = Number(parameters.timestamp);
      const expiresAt = (sourceTimestamp + SSO_WINDOW_SECONDS + 1) * 1000;
      this.entries.set(key, Math.max(expiresAt, now + 1_000));
      await this.pruneAndPersist();
      return await operation();
    } finally {
      release();
    }
  }

  async audit({ userId = null, sourceTimestamp = null, ip = "unknown", result, code = null, detail = null }) {
    await this.ready;
    const entry = {
      schemaVersion: "chenlong.official-sso-audit/v1",
      occurredAt: new Date(Number(this.now())).toISOString(),
      userId: typeof userId === "string" ? userId.slice(0, 128) : null,
      sourceTimestamp: typeof sourceTimestamp === "string" ? sourceTimestamp.slice(0, 10) : null,
      ip: String(ip || "unknown").slice(0, 128),
      result: result === "success" ? "success" : "failure",
      code: code === null ? null : String(code).slice(0, 4)
    };
    if (typeof detail === "string" && detail.trim()) entry.detail = detail.trim().slice(0, 128);
    const line = `${JSON.stringify(entry)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    const write = this.auditTail.then(async () => {
      if (lineBytes > this.maxAuditBytes) throw new Error("official SSO audit entry exceeds its file budget");
      const currentSize = await regularFileSize(this.auditPath);
      if (currentSize > 0 && currentSize + lineBytes > this.maxAuditBytes) {
        if (this.maxAuditFiles === 1) {
          await fs.promises.rm(this.auditPath, { force: true });
        } else {
          const lastArchive = path.join(this.rootDir, `official-sso-audit.${this.maxAuditFiles - 1}.jsonl`);
          await fs.promises.rm(lastArchive, { force: true });
          for (let index = this.maxAuditFiles - 2; index >= 1; index -= 1) {
            const source = path.join(this.rootDir, `official-sso-audit.${index}.jsonl`);
            const destination = path.join(this.rootDir, `official-sso-audit.${index + 1}.jsonl`);
            const size = await regularFileSize(source);
            if (size > 0) await fs.promises.rename(source, destination);
            else await fs.promises.rm(source, { force: true });
          }
          await fs.promises.rename(this.auditPath, path.join(this.rootDir, "official-sso-audit.1.jsonl"));
        }
      }
      const handle = await fs.promises.open(this.auditPath, "a", 0o600);
      try {
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.auditTail = write.catch(() => {});
    return write;
  }
}

module.exports = {
  SSO_PARAMETER_NAMES,
  SSO_BUSINESS_PARAMETER_NAMES,
  SSO_GROUP_TYPES,
  SSO_WINDOW_SECONDS,
  DEFAULT_MAX_SSO_AUDIT_BYTES,
  DEFAULT_MAX_SSO_AUDIT_FILES,
  MAX_SSO_AUDIT_BYTES,
  MAX_SSO_AUDIT_FILES,
  SSO_ERRORS,
  OfficialSsoError,
  OfficialSsoReplayStore,
  requireSsoSecret,
  parseStrictSsoQuery,
  canonicalSsoPayload,
  calculateSsoSignature,
  verifySsoRequest,
  replayKey
};
