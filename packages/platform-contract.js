"use strict";

const crypto = require("node:crypto");

const PRINCIPAL_SCHEMA_VERSION = "chenlong.platform-principal/v1";
const MAP_BUNDLE_SCHEMA_VERSION = "chenlong.platform-map-bundle/v1";
const SIGNATURE_VERSION = "v1";
const PRINCIPAL_HEADER = "x-chenlong-platform-principal";
const MAP_BUNDLE_HEADER = "x-chenlong-platform-map";
const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 60_000;

const PYTHON_TO_PLATFORM_TASK = Object.freeze({
  "R2-GYI-MVP-01": "task1",
  "R2-GYI-MVP-02": "task2",
  "R2-GYI-MVP-03": "task3"
});

const BLOCKLY_TO_PLATFORM_TASK = Object.freeze({
  "GYI-PRIMARY-01": "task1",
  "GYI-PRIMARY-02": "task2",
  "GYI-PRIMARY-03": "task3"
});

const PLATFORM_TO_PYTHON_TASK = Object.freeze(Object.fromEntries(
  Object.entries(PYTHON_TO_PLATFORM_TASK).map(([source, platform]) => [platform, source])
));

const PLATFORM_TO_BLOCKLY_TASK = Object.freeze(Object.fromEntries(
  Object.entries(BLOCKLY_TO_PLATFORM_TASK).map(([source, platform]) => [platform, source])
));

const GROUP_TO_DIVISION = Object.freeze({
  primary: "primary",
  junior: "junior",
  high: "senior"
});

const LEGACY_GROUP_ALIASES = Object.freeze({
  primary: "primary",
  primary_low: "primary",
  primary_high: "primary",
  primary_school: "primary",
  "小学组": "primary",
  "小学组（1-3年级）": "primary",
  "小学组(1-3年级)": "primary",
  "小学低年级组": "primary",
  "小学组（4-6年级）": "primary",
  "小学组(4-6年级)": "primary",
  "小学高年级组": "primary",
  middle_school: "junior",
  junior: "junior",
  "初中组": "junior",
  high_school: "high",
  senior: "high",
  high: "high",
  "高中组": "high"
});

function canonicalParticipantGroup(value) {
  const key = String(value || "primary").normalize("NFKC").trim().toLowerCase();
  return LEGACY_GROUP_ALIASES[key] || null;
}

function requireSecret(secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new TypeError("platform SSO secret must contain at least 32 UTF-8 bytes");
  }
  return secret;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function encodePayload(payload) {
  return Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
}

function signature(secret, signedPart) {
  return crypto.createHmac("sha256", requireSecret(secret)).update(signedPart, "utf8").digest("base64url");
}

function signEnvelope(payload, secret) {
  const encoded = encodePayload(payload);
  const signedPart = `${SIGNATURE_VERSION}.${encoded}`;
  return `${signedPart}.${signature(secret, signedPart)}`;
}

function verifyEnvelope(value, secret, { audience, schemaVersion, now = Date.now() } = {}) {
  if (typeof value !== "string" || value.length > 24_000) throw new TypeError("signed platform header is invalid");
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== SIGNATURE_VERSION || !parts[1] || !parts[2]) {
    throw new TypeError("signed platform header is invalid");
  }
  const signedPart = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(signature(secret, signedPart), "utf8");
  const actual = Buffer.from(parts[2], "utf8");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new TypeError("signed platform header signature is invalid");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (_error) {
    throw new TypeError("signed platform header payload is invalid");
  }
  const timestamp = Number(now);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.schemaVersion !== schemaVersion || payload.audience !== audience
    || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
    || payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > MAX_TTL_MS
    || timestamp < payload.issuedAt - 5_000 || timestamp >= payload.expiresAt) {
    throw new TypeError("signed platform header claims are invalid or expired");
  }
  return payload;
}

function normalizedPrincipalUser(user) {
  if (!user || typeof user !== "object" || Array.isArray(user)) throw new TypeError("platform user is required");
  const role = user.role === "admin" ? "admin" : "user";
  const normalized = {
    id: String(user.id || ""),
    username: String(user.username || ""),
    displayName: String(user.displayName || user.username || ""),
    role,
    teamId: role === "admin" ? null : String(user.teamId || ""),
    teamName: role === "admin" ? null : String(user.teamName || ""),
    group: role === "admin" ? null : canonicalParticipantGroup(user.group),
    createdAt: String(user.createdAt || new Date(0).toISOString())
  };
  if (!/^usr_[a-f0-9]{32}$/.test(normalized.id)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(normalized.username)
    || !normalized.displayName || !Number.isFinite(Date.parse(normalized.createdAt))) {
    throw new TypeError("platform user identity is invalid");
  }
  if (role !== "admin" && (!/^tea_[a-f0-9]{32}$/.test(normalized.teamId)
    || !normalized.teamName || !Object.hasOwn(GROUP_TO_DIVISION, normalized.group))) {
    throw new TypeError("platform participant team identity is invalid");
  }
  return Object.freeze(normalized);
}

function signPrincipal(secret, audience, user, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (audience !== "blockly" && audience !== "workshop") throw new TypeError("platform principal audience is invalid");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_TTL_MS) throw new RangeError("platform principal ttl is invalid");
  const issuedAt = Number(now);
  return signEnvelope({
    schemaVersion: PRINCIPAL_SCHEMA_VERSION,
    audience,
    issuedAt,
    expiresAt: issuedAt + ttlMs,
    user: normalizedPrincipalUser(user)
  }, secret);
}

function verifyPrincipal(value, secret, audience, options = {}) {
  const payload = verifyEnvelope(value, secret, {
    audience,
    schemaVersion: PRINCIPAL_SCHEMA_VERSION,
    now: options.now
  });
  return Object.freeze({ ...payload, user: normalizedPrincipalUser(payload.user) });
}

function signMapBundle(secret, maps, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!Array.isArray(maps) || maps.length !== 3) throw new TypeError("platform map bundle must contain three tasks");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_TTL_MS) throw new RangeError("platform map bundle ttl is invalid");
  const issuedAt = Number(now);
  return signEnvelope({
    schemaVersion: MAP_BUNDLE_SCHEMA_VERSION,
    audience: "blockly",
    issuedAt,
    expiresAt: issuedAt + ttlMs,
    maps
  }, secret);
}

function verifyMapBundle(value, secret, options = {}) {
  const payload = verifyEnvelope(value, secret, {
    audience: "blockly",
    schemaVersion: MAP_BUNDLE_SCHEMA_VERSION,
    now: options.now
  });
  if (!Array.isArray(payload.maps) || payload.maps.length !== 3) throw new TypeError("platform map bundle is invalid");
  return Object.freeze(payload);
}

function platformTaskId(sourceTaskId) {
  return PYTHON_TO_PLATFORM_TASK[sourceTaskId] || BLOCKLY_TO_PLATFORM_TASK[sourceTaskId] || null;
}

function divisionForGroup(group) {
  return GROUP_TO_DIVISION[canonicalParticipantGroup(group)] || "primary";
}

module.exports = Object.freeze({
  PRINCIPAL_SCHEMA_VERSION,
  MAP_BUNDLE_SCHEMA_VERSION,
  PRINCIPAL_HEADER,
  MAP_BUNDLE_HEADER,
  DEFAULT_TTL_MS,
  PYTHON_TO_PLATFORM_TASK,
  BLOCKLY_TO_PLATFORM_TASK,
  PLATFORM_TO_PYTHON_TASK,
  PLATFORM_TO_BLOCKLY_TASK,
  GROUP_TO_DIVISION,
  canonicalParticipantGroup,
  canonicalJson,
  signPrincipal,
  verifyPrincipal,
  signMapBundle,
  verifyMapBundle,
  platformTaskId,
  divisionForGroup
});
