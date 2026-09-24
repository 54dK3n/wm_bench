"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const AUTH_STORE_SCHEMA_VERSION = "chenlong.auth-store/v6";
const LEGACY_AUTH_STORE_SCHEMA_VERSION = "chenlong.auth-store/v1";
const TEAM_AUTH_STORE_SCHEMA_VERSION = "chenlong.auth-store/v2";
const GROUP_AUTH_STORE_SCHEMA_VERSION = "chenlong.auth-store/v3";
const TEAM_IDENTITY_AUTH_STORE_SCHEMA_VERSION = "chenlong.auth-store/v4";
const FOUR_GROUP_AUTH_STORE_SCHEMA_VERSION = "chenlong.auth-store/v5";
const AUTH_RESPONSE_SCHEMA_VERSION = "chenlong.auth/v1";
const AUTH_COOKIE_NAME = "chenlong_session";
const DEFAULT_AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_USERS = 2_000;
const MAX_USERS = 10_000;
const DEFAULT_MAX_AUTH_SESSIONS = 8_000;
const MAX_AUTH_SESSIONS = 10_000;
const DEFAULT_MAX_SESSIONS_PER_USER = 20;
const MAX_SESSIONS_PER_USER = 100;
const DEFAULT_MAX_PASSWORD_OPERATIONS = 2;
const MAX_PASSWORD_OPERATIONS = 8;
const DEFAULT_MAX_PASSWORD_QUEUE = 2_000;
const MAX_PASSWORD_QUEUE = 10_000;
const DEFAULT_PASSWORD_QUEUE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_PASSWORD_QUEUE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_MUTATIONS_PER_BATCH = 32;
const MAX_MUTATIONS_PER_BATCH = 256;
const DEFAULT_MUTATION_BATCH_WINDOW_MS = 10;
const MAX_MUTATION_BATCH_WINDOW_MS = 1_000;
const DEFAULT_MAX_MUTATION_QUEUE = 10_000;
const MAX_MUTATION_QUEUE = 50_000;
const MAX_AUTH_STORE_BYTES = 8 * 1024 * 1024;
const NO_MUTATION = Symbol("NO_MUTATION");
const USER_ID_PATTERN = /^usr_[a-f0-9]{32}$/;
const TEAM_ID_PATTERN = /^tea_[a-f0-9]{32}$/;
const AUTH_SESSION_ID_PATTERN = /^ase_[a-f0-9]{32}$/;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const OFFICIAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TEAM_INVITE_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
const ROLE_VALUES = new Set(["user", "admin"]);
const PARTICIPANT_GROUP_VALUES = Object.freeze([
  "primary",
  "junior",
  "high"
]);
const PARTICIPANT_GROUP_VALUE_SET = new Set(PARTICIPANT_GROUP_VALUES);
const DEFAULT_PARTICIPANT_GROUP = "primary";
const LEGACY_PARTICIPANT_GROUP_ALIASES = new Map([
  ["primary", "primary"],
  ["primary_school", "primary"],
  ["primary_low", "primary"],
  ["primary_high", "primary"],
  ["小学组", "primary"],
  ["小学", "primary"],
  ["小学组（1-3年级）", "primary"],
  ["小学组(1-3年级)", "primary"],
  ["小学低年级组", "primary"],
  ["小学低年级", "primary"],
  ["小学组（4-6年级）", "primary"],
  ["小学组(4-6年级)", "primary"],
  ["小学高年级组", "primary"],
  ["小学高年级", "primary"],
  ["junior", "junior"],
  ["middle_school", "junior"],
  ["初中组", "junior"],
  ["初中", "junior"],
  ["high", "high"],
  ["high_school", "high"],
  ["senior", "high"],
  ["高中组", "high"],
  ["高中", "high"]
]);
const SCRYPT_PARAMETERS = Object.freeze({
  algorithm: "scrypt",
  N: 32768,
  r: 8,
  p: 1,
  keyLength: 32,
  saltBytes: 16,
  maxmem: 64 * 1024 * 1024
});
// Blockly v6 used Node's default scrypt work factor.  Unified-platform
// migration keeps those hashes login-compatible and upgrades them after the
// first successful login instead of asking participants to reset passwords.
const LEGACY_BLOCKLY_SCRYPT_N = 16384;

class AuthStoreError extends Error {
  constructor(statusCode, code, message, headers = {}) {
    super(message);
    this.name = "AuthStoreError";
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

function exactKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every(key => allowed.has(key));
}

function validIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function normalizeUsername(value) {
  if (typeof value !== "string") {
    throw new AuthStoreError(400, "INVALID_USERNAME", "username must be a string");
  }
  const username = value.trim().normalize("NFC");
  if (!USERNAME_PATTERN.test(username)) {
    throw new AuthStoreError(
      400,
      "INVALID_USERNAME",
      "username must contain 3-32 ASCII letters, numbers, '.', '_' or '-', and start with a letter or number"
    );
  }
  return { username, usernameKey: username.toLowerCase() };
}

function normalizeDisplayName(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") {
    throw new AuthStoreError(400, "INVALID_DISPLAY_NAME", "displayName must be a string");
  }
  const displayName = value.trim().normalize("NFC");
  const length = [...displayName].length;
  if (length < 1 || length > 64 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(displayName)) {
    throw new AuthStoreError(400, "INVALID_DISPLAY_NAME", "displayName must contain 1-64 visible characters");
  }
  return displayName;
}

function normalizeTeamName(value) {
  if (typeof value !== "string") {
    throw new AuthStoreError(400, "INVALID_TEAM_NAME", "teamName must be a string");
  }
  const teamName = value.trim().normalize("NFC");
  const length = [...teamName].length;
  if (length < 1 || length > 64 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(teamName)) {
    throw new AuthStoreError(400, "INVALID_TEAM_NAME", "teamName must contain 1-64 visible characters");
  }
  return teamName;
}

function teamNameKey(teamName) {
  return normalizeTeamName(teamName).toLowerCase();
}

function normalizeTeamInviteCode(value) {
  if (typeof value !== "string") {
    throw new AuthStoreError(400, "INVALID_TEAM_INVITE_CODE", "team invite code must be a string");
  }
  const inviteCode = value.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!TEAM_INVITE_CODE_PATTERN.test(inviteCode)) {
    throw new AuthStoreError(400, "INVALID_TEAM_INVITE_CODE", "team invite code is invalid");
  }
  return inviteCode;
}

function normalizeTeamAction(value) {
  if (value === undefined) return "create";
  if (value !== "create" && value !== "join") {
    throw new AuthStoreError(400, "INVALID_TEAM_ACTION", "team action must be create or join");
  }
  return value;
}

function randomTeamInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  while (result.length < 8) {
    const bytes = crypto.randomBytes(12);
    for (const byte of bytes) {
      if (byte >= 248) continue;
      result += alphabet[byte % alphabet.length];
      if (result.length === 8) return result;
    }
  }
  return result;
}

function createTeamInState(state, teamName, now, { allowDuplicateName = false } = {}) {
  const normalizedTeamName = normalizeTeamName(teamName);
  const nameKey = teamNameKey(normalizedTeamName);
  if (!allowDuplicateName && state.teams.some(team => team.teamNameKey === nameKey)) {
    throw new AuthStoreError(409, "TEAM_NAME_TAKEN", "team name is already registered");
  }
  const usedInviteCodes = new Set(state.teams.map(team => team.inviteCode));
  let inviteCode;
  do {
    inviteCode = randomTeamInviteCode();
  } while (usedInviteCodes.has(inviteCode));
  const team = {
    id: randomId("tea"),
    teamName: normalizedTeamName,
    teamNameKey: nameKey,
    inviteCode,
    createdAt: new Date(now).toISOString()
  };
  state.teams.push(team);
  return team;
}

function normalizeOfficialId(value, name) {
  if (typeof value !== "string" || !OFFICIAL_ID_PATTERN.test(value)) {
    throw new AuthStoreError(400, "INVALID_OFFICIAL_ID", `${name} is invalid`);
  }
  return value;
}

function officialUsername(officialUserId) {
  return `sso_${sha256(officialUserId).slice(0, 20)}`;
}

function adminUser(user) {
  return {
    ...publicUser(user),
    officialUserId: user.officialUserId || null,
    officialTeamId: user.officialTeamId || null
  };
}

function migrateStateToTeamIdentity(state) {
  const now = Date.now();
  const next = {
    schemaVersion: AUTH_STORE_SCHEMA_VERSION,
    revision: state.revision + 1,
    users: [],
    teams: [],
    sessions: state.sessions.map(session => ({ ...session }))
  };
  const teamsByNameKey = new Map();
  for (const legacyUser of state.users) {
    // Preserve old grouping when possible. Accounts without a historical team
    // become their own team, named after the unique username.
    const legacyTeamName = typeof legacyUser.teamName === "string" && legacyUser.teamName.trim()
      ? legacyUser.teamName
      : legacyUser.username;
    const normalizedTeamName = normalizeTeamName(legacyTeamName);
    const nameKey = teamNameKey(normalizedTeamName);
    let team = teamsByNameKey.get(nameKey);
    if (!team) {
      team = createTeamInState(next, normalizedTeamName, now);
      teamsByNameKey.set(nameKey, team);
    }
    next.users.push({
      ...legacyUser,
      teamId: team.id,
      teamName: team.teamName,
      group: normalizeLegacyParticipantGroup(legacyUser.group)
    });
  }
  return next;
}

function migrateParticipantGroups(state) {
  return {
    ...state,
    schemaVersion: AUTH_STORE_SCHEMA_VERSION,
    revision: state.revision + 1,
    users: state.users.map(user => ({
      ...user,
      group: user.role === "admin" && user.group === null
        ? null
        : normalizeLegacyParticipantGroup(user.group)
    }))
  };
}

function normalizeLegacyParticipantGroup(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_PARTICIPANT_GROUP;
  return normalizeCompatibleParticipantGroup(value);
}

function normalizeCompatibleParticipantGroup(value) {
  if (typeof value !== "string") {
    throw new AuthStoreError(400, "INVALID_GROUP", "stored participant group is invalid");
  }
  const key = value.normalize("NFKC").trim().toLowerCase();
  const normalized = LEGACY_PARTICIPANT_GROUP_ALIASES.get(key);
  if (!normalized) {
    throw new AuthStoreError(400, "INVALID_GROUP", "stored participant group is invalid");
  }
  return normalized;
}

function normalizeParticipantGroup(value) {
  if (typeof value !== "string" || !PARTICIPANT_GROUP_VALUE_SET.has(value)) {
    throw new AuthStoreError(
      400,
      "INVALID_GROUP",
      `group must be one of: ${PARTICIPANT_GROUP_VALUES.join(", ")}`
    );
  }
  return value;
}

function validatePassword(value) {
  if (typeof value !== "string") {
    throw new AuthStoreError(400, "INVALID_PASSWORD", "password must be a string");
  }
  const length = [...value].length;
  const byteLength = Buffer.byteLength(value, "utf8");
  if (length < 10 || length > 128 || byteLength > 512 || value.includes("\0")) {
    throw new AuthStoreError(400, "INVALID_PASSWORD", "password must contain 10-128 characters and at most 512 UTF-8 bytes");
  }
  return value;
}

function validateUserId(value, { allowNull = false } = {}) {
  if (allowNull && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || !USER_ID_PATTERN.test(value)) {
    throw new AuthStoreError(400, "INVALID_USER_ID", "user id is invalid");
  }
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function randomSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function scryptPassword(password, salt, parameters = SCRYPT_PARAMETERS) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, parameters.keyLength, {
      N: parameters.N,
      r: parameters.r,
      p: parameters.p,
      maxmem: SCRYPT_PARAMETERS.maxmem
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(Buffer.from(derivedKey));
    });
  });
}

async function createPasswordHash(password) {
  const salt = crypto.randomBytes(SCRYPT_PARAMETERS.saltBytes);
  const hash = await scryptPassword(password, salt);
  return {
    algorithm: SCRYPT_PARAMETERS.algorithm,
    N: SCRYPT_PARAMETERS.N,
    r: SCRYPT_PARAMETERS.r,
    p: SCRYPT_PARAMETERS.p,
    keyLength: SCRYPT_PARAMETERS.keyLength,
    salt: salt.toString("base64url"),
    hash: hash.toString("base64url")
  };
}

function publicUser(user) {
  const isParticipant = user.role !== "admin";
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    // An administrator can retain a legacy internal team binding so existing
    // stores remain valid, but it is not a participant profile.  Do not
    // expose a team or competition group for administrator accounts.
    teamName: isParticipant && typeof user.teamName === "string" ? user.teamName : null,
    group: isParticipant ? user.group : null,
    role: user.role,
    createdAt: user.createdAt
  };
}

function publicSession(session) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt
  };
}

function validatePasswordHash(value) {
  const allowed = new Set(["algorithm", "N", "r", "p", "keyLength", "salt", "hash"]);
  if (!exactKeys(value, allowed)) return false;
  if (value.algorithm !== SCRYPT_PARAMETERS.algorithm
    || (value.N !== SCRYPT_PARAMETERS.N && value.N !== LEGACY_BLOCKLY_SCRYPT_N)
    || value.r !== SCRYPT_PARAMETERS.r
    || value.p !== SCRYPT_PARAMETERS.p
    || value.keyLength !== SCRYPT_PARAMETERS.keyLength) return false;
  try {
    const salt = Buffer.from(value.salt, "base64url");
    const hash = Buffer.from(value.hash, "base64url");
    return typeof value.salt === "string" && typeof value.hash === "string"
      && salt.length === SCRYPT_PARAMETERS.saltBytes
      && hash.length === SCRYPT_PARAMETERS.keyLength
      && salt.toString("base64url") === value.salt
      && hash.toString("base64url") === value.hash;
  } catch (_error) {
    return false;
  }
}

function validateStoredUser(user, { schemaVersion = AUTH_STORE_SCHEMA_VERSION } = {}) {
  const legacy = schemaVersion === LEGACY_AUTH_STORE_SCHEMA_VERSION;
  const teamOnly = schemaVersion === TEAM_AUTH_STORE_SCHEMA_VERSION;
  const groupOnly = schemaVersion === GROUP_AUTH_STORE_SCHEMA_VERSION;
  const teamIdentity = schemaVersion === TEAM_IDENTITY_AUTH_STORE_SCHEMA_VERSION
    || schemaVersion === FOUR_GROUP_AUTH_STORE_SCHEMA_VERSION
    || schemaVersion === AUTH_STORE_SCHEMA_VERSION;
  const localAllowed = new Set(legacy
    ? ["id", "username", "usernameKey", "displayName", "role", "passwordHash", "createdAt"]
    : teamOnly
      ? ["id", "username", "usernameKey", "displayName", "teamName", "role", "passwordHash", "createdAt"]
      : groupOnly
        ? ["id", "username", "usernameKey", "displayName", "teamName", "group", "role", "passwordHash", "createdAt"]
        : ["id", "username", "usernameKey", "displayName", "teamId", "teamName", "group", "role", "passwordHash", "createdAt"]);
  const externalAllowed = new Set([
    "id", "username", "usernameKey", "displayName", "teamId", "teamName", "group", "role",
    "officialUserId", "officialTeamId", "createdAt"
  ]);
  const external = (schemaVersion === FOUR_GROUP_AUTH_STORE_SCHEMA_VERSION
    || schemaVersion === AUTH_STORE_SCHEMA_VERSION) && exactKeys(user, externalAllowed);
  if ((!external && !exactKeys(user, localAllowed)) || !USER_ID_PATTERN.test(user.id) || !ROLE_VALUES.has(user.role)
    || !validIsoTimestamp(user.createdAt) || (!external && !validatePasswordHash(user.passwordHash))) return false;
  if (external && (user.role !== "user" || !OFFICIAL_ID_PATTERN.test(user.officialUserId)
    || !OFFICIAL_ID_PATTERN.test(user.officialTeamId))) return false;
  let normalized;
  try {
    normalized = normalizeUsername(user.username);
    if (normalizeDisplayName(user.displayName, normalized.username) !== user.displayName) return false;
    if (!legacy && user.teamName !== null && normalizeTeamName(user.teamName) !== user.teamName) return false;
    if (teamIdentity
      && (!TEAM_ID_PATTERN.test(user.teamId) || typeof user.teamName !== "string")) return false;
    if (!legacy && !teamOnly) {
      if (schemaVersion === AUTH_STORE_SCHEMA_VERSION) {
        if (normalizeParticipantGroup(user.group) !== user.group) return false;
      } else if (normalizeLegacyParticipantGroup(user.group) === null) {
        return false;
      }
    }
  } catch (_error) {
    return false;
  }
  return normalized.username === user.username && normalized.usernameKey === user.usernameKey;
}

function validateStoredTeam(team) {
  const localAllowed = new Set(["id", "teamName", "teamNameKey", "inviteCode", "createdAt"]);
  const officialAllowed = new Set(["id", "teamName", "teamNameKey", "inviteCode", "officialTeamId", "createdAt"]);
  const official = exactKeys(team, officialAllowed);
  if ((!official && !exactKeys(team, localAllowed)) || !TEAM_ID_PATTERN.test(team.id)
    || !validIsoTimestamp(team.createdAt) || (official && !OFFICIAL_ID_PATTERN.test(team.officialTeamId))) return false;
  try {
    return normalizeTeamName(team.teamName) === team.teamName
      && teamNameKey(team.teamName) === team.teamNameKey
      && normalizeTeamInviteCode(team.inviteCode) === team.inviteCode;
  } catch (_error) {
    return false;
  }
}

function validateStoredSession(session) {
  const allowed = new Set(["id", "tokenHash", "userId", "createdAt", "expiresAt"]);
  if (!exactKeys(session, allowed) || !AUTH_SESSION_ID_PATTERN.test(session.id)
    || !TOKEN_HASH_PATTERN.test(session.tokenHash) || !USER_ID_PATTERN.test(session.userId)
    || !validIsoTimestamp(session.createdAt) || !validIsoTimestamp(session.expiresAt)) return false;
  return Date.parse(session.expiresAt) > Date.parse(session.createdAt);
}

function validateState(value) {
  const current = value?.schemaVersion === AUTH_STORE_SCHEMA_VERSION;
  const teamIdentity = current
    || value?.schemaVersion === FOUR_GROUP_AUTH_STORE_SCHEMA_VERSION
    || value?.schemaVersion === TEAM_IDENTITY_AUTH_STORE_SCHEMA_VERSION;
  const allowed = new Set(teamIdentity
    ? ["schemaVersion", "revision", "users", "teams", "sessions"]
    : ["schemaVersion", "revision", "users", "sessions"]);
  const supportedSchema = value?.schemaVersion === AUTH_STORE_SCHEMA_VERSION
    || value?.schemaVersion === FOUR_GROUP_AUTH_STORE_SCHEMA_VERSION
    || value?.schemaVersion === TEAM_IDENTITY_AUTH_STORE_SCHEMA_VERSION
    || value?.schemaVersion === GROUP_AUTH_STORE_SCHEMA_VERSION
    || value?.schemaVersion === TEAM_AUTH_STORE_SCHEMA_VERSION
    || value?.schemaVersion === LEGACY_AUTH_STORE_SCHEMA_VERSION;
  if (!exactKeys(value, allowed)
    || !supportedSchema
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.users) || !Array.isArray(value.sessions)
    || (teamIdentity && (!Array.isArray(value.teams) || value.teams.length > MAX_USERS))
    || value.users.length > MAX_USERS || value.sessions.length > MAX_AUTH_SESSIONS) {
    throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "stored authentication data is invalid");
  }
  const teamsById = new Map();
  const localTeamNames = new Set();
  const inviteCodes = new Set();
  const officialTeamIds = new Set();
  if (teamIdentity) {
    for (const team of value.teams) {
      if (!validateStoredTeam(team) || teamsById.has(team.id)
        || (!team.officialTeamId && localTeamNames.has(team.teamNameKey))
        || inviteCodes.has(team.inviteCode)) {
        throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "stored authentication teams are invalid");
      }
      teamsById.set(team.id, team);
      if (!team.officialTeamId) localTeamNames.add(team.teamNameKey);
      inviteCodes.add(team.inviteCode);
      if (team.officialTeamId) {
        if (officialTeamIds.has(team.officialTeamId)) {
          throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "stored official team identity is duplicated");
        }
        officialTeamIds.add(team.officialTeamId);
      }
    }
  }
  const userIds = new Set();
  const usernames = new Set();
  let adminCount = 0;
  const officialUserIds = new Set();
  const participantGroupsByTeam = new Map();
  for (const user of value.users) {
    if (!validateStoredUser(user, { schemaVersion: value.schemaVersion })
      || userIds.has(user.id) || usernames.has(user.usernameKey)) {
      throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "stored authentication users are invalid");
    }
    if (teamIdentity) {
      const team = teamsById.get(user.teamId);
      if (!team || team.teamName !== user.teamName) {
        throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "stored authentication user team is invalid");
      }
      if (user.officialUserId) {
        if (officialUserIds.has(user.officialUserId) || team.officialTeamId !== user.officialTeamId) {
          throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "stored official user identity is invalid");
        }
        officialUserIds.add(user.officialUserId);
      } else if (team.officialTeamId) {
        throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "local user references an official team");
      }
      if (user.role !== "admin") {
        const normalizedGroup = current
          ? normalizeParticipantGroup(user.group)
          : normalizeLegacyParticipantGroup(user.group);
        const existing = participantGroupsByTeam.get(user.teamId);
        if (existing && existing.group !== normalizedGroup) {
          const members = [...existing.members, `${user.username}:${normalizedGroup}`].join(", ");
          throw new AuthStoreError(
            500,
            "AUTH_STORE_TEAM_GROUP_CONFLICT",
            `stored team "${team.teamName}" has conflicting participant groups (${members})`
          );
        }
        if (existing) existing.members.push(`${user.username}:${normalizedGroup}`);
        else participantGroupsByTeam.set(user.teamId, {
          group: normalizedGroup,
          members: [`${user.username}:${normalizedGroup}`]
        });
      }
    }
    userIds.add(user.id);
    usernames.add(user.usernameKey);
    if (user.role === "admin") adminCount += 1;
  }
  if (value.users.length > 0 && adminCount < 1) {
    throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "authentication data has no administrator");
  }
  const sessionIds = new Set();
  const tokenHashes = new Set();
  for (const session of value.sessions) {
    if (!validateStoredSession(session) || !userIds.has(session.userId)
      || sessionIds.has(session.id) || tokenHashes.has(session.tokenHash)) {
      throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "stored authentication sessions are invalid");
    }
    sessionIds.add(session.id);
    tokenHashes.add(session.tokenHash);
  }
  return value;
}

function emptyState() {
  return {
    schemaVersion: AUTH_STORE_SCHEMA_VERSION,
    revision: 0,
    users: [],
    teams: [],
    sessions: []
  };
}

async function readStateFile(filePath) {
  let stat;
  try {
    stat = await fs.promises.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_AUTH_STORE_BYTES) {
    throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "stored authentication file is invalid");
  }
  const handle = await fs.promises.open(filePath, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== stat.size) {
      throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "stored authentication file changed while being opened");
    }
    const buffer = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead < 1) throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "stored authentication file ended unexpectedly");
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, buffer.length);
    if (extraBytes !== 0) {
      throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "stored authentication file grew while being read");
    }
    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (_error) {
      throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "stored authentication file is not valid UTF-8");
    }
    let state;
    try {
      state = JSON.parse(source);
    } catch (_error) {
      throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "stored authentication file is not valid JSON");
    }
    return validateState(state);
  } finally {
    await handle.close();
  }
}

async function atomicWriteState(directory, filePath, state) {
  const data = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  if (data.length > MAX_AUTH_STORE_BYTES) {
    throw new AuthStoreError(507, "AUTH_STORE_FULL", "authentication store exceeds its storage budget");
  }
  const temporaryPath = path.join(directory, `.auth-store.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, filePath);
    try {
      const directoryHandle = await fs.promises.open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (_error) {
      // Directory fsync is not available on every supported Windows filesystem.
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

class AuthStore {
  constructor(options = {}) {
    this.rootDir = path.resolve(options.rootDir || path.join(process.cwd(), ".runtime", "auth"));
    this.filePath = path.join(this.rootDir, "auth-store.json");
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.sessionTtlMs = boundedInteger(
      "authSessionTtlMs",
      options.sessionTtlMs ?? options.authSessionTtlMs,
      DEFAULT_AUTH_SESSION_TTL_MS,
      MAX_AUTH_SESSION_TTL_MS
    );
    this.maxUsers = boundedInteger("maxUsers", options.maxUsers, DEFAULT_MAX_USERS, MAX_USERS);
    this.maxSessions = boundedInteger(
      "maxAuthSessions",
      options.maxSessions ?? options.maxAuthSessions,
      DEFAULT_MAX_AUTH_SESSIONS,
      MAX_AUTH_SESSIONS
    );
    this.maxSessionsPerUser = boundedInteger(
      "maxSessionsPerUser",
      options.maxSessionsPerUser,
      DEFAULT_MAX_SESSIONS_PER_USER,
      MAX_SESSIONS_PER_USER
    );
    this.maxPasswordOperations = boundedInteger(
      "maxPasswordOperations",
      options.maxPasswordOperations,
      DEFAULT_MAX_PASSWORD_OPERATIONS,
      MAX_PASSWORD_OPERATIONS
    );
    this.maxPasswordQueue = boundedInteger(
      "maxPasswordQueue",
      options.maxPasswordQueue ?? options.maxPasswordQueueLength,
      DEFAULT_MAX_PASSWORD_QUEUE,
      MAX_PASSWORD_QUEUE
    );
    this.passwordQueueTimeoutMs = boundedInteger(
      "passwordQueueTimeoutMs",
      options.passwordQueueTimeoutMs,
      DEFAULT_PASSWORD_QUEUE_TIMEOUT_MS,
      MAX_PASSWORD_QUEUE_TIMEOUT_MS
    );
    this.maxMutationsPerBatch = boundedInteger(
      "maxMutationsPerBatch",
      options.maxMutationsPerBatch,
      DEFAULT_MAX_MUTATIONS_PER_BATCH,
      MAX_MUTATIONS_PER_BATCH
    );
    this.mutationBatchWindowMs = boundedInteger(
      "mutationBatchWindowMs",
      options.mutationBatchWindowMs,
      DEFAULT_MUTATION_BATCH_WINDOW_MS,
      MAX_MUTATION_BATCH_WINDOW_MS
    );
    this.maxMutationQueue = boundedInteger(
      "maxMutationQueue",
      options.maxMutationQueue,
      DEFAULT_MAX_MUTATION_QUEUE,
      MAX_MUTATION_QUEUE
    );
    if (options.registrationOpen !== undefined && typeof options.registrationOpen !== "boolean") {
      throw new TypeError("registrationOpen must be a boolean");
    }
    this.registrationOpen = options.registrationOpen !== false;
    this.state = null;
    this.writeState = atomicWriteState;
    this.mutationQueue = [];
    this.mutationBatchTimer = null;
    this.mutationBatchScheduled = false;
    this.processingMutationBatch = false;
    this.activePasswordOperations = 0;
    this.passwordOperationQueue = [];
    this.dummySalt = crypto.randomBytes(SCRYPT_PARAMETERS.saltBytes);
    this.dummyHash = crypto.randomBytes(SCRYPT_PARAMETERS.keyLength);
    this.ready = this.initialize();
  }

  timestamp() {
    const milliseconds = Number(this.now());
    if (!Number.isFinite(milliseconds)) throw new TypeError("now() must return a finite timestamp");
    return milliseconds;
  }

  async initialize() {
    await fs.promises.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const entries = await fs.promises.readdir(this.rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /^\.auth-store\.[a-f0-9-]+\.tmp$/.test(entry.name)) {
        await fs.promises.unlink(path.join(this.rootDir, entry.name)).catch(() => {});
      }
    }
    let state = await readStateFile(this.filePath);
    if (!state) {
      state = emptyState();
      await this.writeState(this.rootDir, this.filePath, state);
    } else if (state.schemaVersion === TEAM_IDENTITY_AUTH_STORE_SCHEMA_VERSION
      || state.schemaVersion === FOUR_GROUP_AUTH_STORE_SCHEMA_VERSION) {
      state = migrateParticipantGroups(state);
      validateState(state);
      await this.writeState(this.rootDir, this.filePath, state);
    } else if (state.schemaVersion !== AUTH_STORE_SCHEMA_VERSION) {
      state = migrateStateToTeamIdentity(state);
      validateState(state);
      await this.writeState(this.rootDir, this.filePath, state);
    }
    const now = this.timestamp();
    const activeSessions = state.sessions.filter(session => Date.parse(session.expiresAt) > now);
    if (state.users.length > this.maxUsers || activeSessions.length > this.maxSessions) {
      throw new AuthStoreError(500, "AUTH_STORE_LIMIT_EXCEEDED", "stored authentication data exceeds configured limits");
    }
    const perUser = new Map();
    for (const session of activeSessions) {
      const count = (perUser.get(session.userId) || 0) + 1;
      if (count > this.maxSessionsPerUser) {
        throw new AuthStoreError(500, "AUTH_STORE_LIMIT_EXCEEDED", "stored user sessions exceed configured limits");
      }
      perUser.set(session.userId, count);
    }
    if (activeSessions.length !== state.sessions.length) {
      state = { ...state, revision: state.revision + 1, sessions: activeSessions };
      await this.writeState(this.rootDir, this.filePath, state);
    }
    this.state = state;
  }

  noMutation(result) {
    return { [NO_MUTATION]: true, result };
  }

  scheduleMutationBatch() {
    if (this.processingMutationBatch || this.mutationBatchScheduled || this.mutationQueue.length === 0) return;
    if (this.mutationQueue.length >= this.maxMutationsPerBatch) {
      if (this.mutationBatchTimer !== null) {
        clearTimeout(this.mutationBatchTimer);
        this.mutationBatchTimer = null;
      }
      this.mutationBatchScheduled = true;
      queueMicrotask(() => {
        this.mutationBatchScheduled = false;
        void this.flushMutationBatch();
      });
      return;
    }
    if (this.mutationBatchTimer === null) {
      this.mutationBatchTimer = setTimeout(() => {
        this.mutationBatchTimer = null;
        void this.flushMutationBatch();
      }, this.mutationBatchWindowMs);
    }
  }

  async flushMutationBatch() {
    if (this.processingMutationBatch || this.mutationQueue.length === 0) return;
    if (this.mutationBatchTimer !== null) {
      clearTimeout(this.mutationBatchTimer);
      this.mutationBatchTimer = null;
    }
    this.processingMutationBatch = true;
    const batch = this.mutationQueue.splice(0, this.maxMutationsPerBatch);
    let draft = this.state;
    const successful = [];
    const dependentNoops = [];
    try {
      for (const entry of batch) {
        const candidate = JSON.parse(JSON.stringify(draft));
        const now = this.timestamp();
        candidate.sessions = candidate.sessions.filter(session => Date.parse(session.expiresAt) > now);
        try {
          const result = await entry.operation(candidate, now);
          if (result?.[NO_MUTATION] === true) {
            dependentNoops.push({ entry, result: result.result });
            continue;
          }
          candidate.revision = draft.revision + 1;
          validateState(candidate);
          draft = candidate;
          successful.push({ entry, result });
        } catch (error) {
          entry.settled = true;
          entry.reject(error);
        }
      }

      if (successful.length > 0) {
        try {
          await this.writeState(this.rootDir, this.filePath, draft);
          this.state = draft;
        } catch (error) {
          for (const { entry } of [...successful, ...dependentNoops]) {
            entry.settled = true;
            entry.reject(error);
          }
          return;
        }
      }
      for (const { entry, result } of [...successful, ...dependentNoops]) {
        entry.settled = true;
        entry.resolve(result);
      }
    } catch (error) {
      for (const entry of batch) {
        if (!entry.settled) {
          entry.settled = true;
          entry.reject(error);
        }
      }
    } finally {
      this.processingMutationBatch = false;
      this.scheduleMutationBatch();
    }
  }

  async withMutation(operation) {
    if (typeof operation !== "function") throw new TypeError("mutation operation must be a function");
    await this.ready;
    if (this.mutationQueue.length >= this.maxMutationQueue) {
      throw new AuthStoreError(503, "AUTH_MUTATION_QUEUE_FULL", "authentication write queue is full", {
        "Retry-After": "1"
      });
    }
    return new Promise((resolve, reject) => {
      this.mutationQueue.push({ operation, resolve, reject, settled: false });
      this.scheduleMutationBatch();
    });
  }

  dispatchPasswordOperations() {
    while (this.activePasswordOperations < this.maxPasswordOperations
      && this.passwordOperationQueue.length > 0) {
      const entry = this.passwordOperationQueue.shift();
      if (!entry || entry.settled) continue;
      entry.settled = true;
      clearTimeout(entry.timer);
      this.activePasswordOperations += 1;
      entry.resolve();
    }
  }

  acquirePasswordOperation() {
    if (this.activePasswordOperations < this.maxPasswordOperations
      && this.passwordOperationQueue.length === 0) {
      this.activePasswordOperations += 1;
      return Promise.resolve();
    }
    if (this.passwordOperationQueue.length >= this.maxPasswordQueue) {
      return Promise.reject(new AuthStoreError(
        503,
        "AUTH_QUEUE_FULL",
        "password operation queue is full",
        { "Retry-After": "1" }
      ));
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null, settled: false };
      entry.timer = setTimeout(() => {
        if (entry.settled) return;
        const index = this.passwordOperationQueue.indexOf(entry);
        if (index < 0) return;
        this.passwordOperationQueue.splice(index, 1);
        entry.settled = true;
        reject(new AuthStoreError(
          503,
          "AUTH_QUEUE_TIMEOUT",
          "password operation waited too long",
          { "Retry-After": "1" }
        ));
      }, this.passwordQueueTimeoutMs);
      entry.timer.unref?.();
      this.passwordOperationQueue.push(entry);
      this.dispatchPasswordOperations();
    });
  }

  releasePasswordOperation() {
    this.activePasswordOperations = Math.max(0, this.activePasswordOperations - 1);
    this.dispatchPasswordOperations();
  }

  async withPasswordOperation(operation) {
    await this.acquirePasswordOperation();
    try {
      return await operation();
    } finally {
      this.releasePasswordOperation();
    }
  }

  assertRegistrationAllowed(state, {
    usernameKey,
    teamAction,
    normalizedTeamName,
    normalizedInviteCode
  }) {
    // A closed registration window must not make a fresh deployment
    // impossible to administer. Exactly the first successfully committed
    // account retains the historical bootstrap-administrator behavior.
    if (!this.registrationOpen && state.users.length > 0) {
      throw new AuthStoreError(403, "REGISTRATION_CLOSED", "participant registration is closed");
    }
    if (state.users.some(user => user.usernameKey === usernameKey)) {
      throw new AuthStoreError(409, "USERNAME_TAKEN", "username is already registered");
    }
    if (state.users.length >= this.maxUsers) {
      throw new AuthStoreError(429, "USER_LIMIT_REACHED", "local user limit reached");
    }
    if (teamAction === "create") {
      const nameKey = teamNameKey(normalizedTeamName);
      if (state.teams.some(team => team.teamNameKey === nameKey)) {
        throw new AuthStoreError(409, "TEAM_NAME_TAKEN", "team name is already registered");
      }
    } else if (!state.teams.some(team => team.inviteCode === normalizedInviteCode)) {
      throw new AuthStoreError(404, "TEAM_INVITE_NOT_FOUND", "team invite code does not match a team");
    }
  }

  createSessionInState(state, user, now) {
    const userSessions = state.sessions
      .filter(session => session.userId === user.id)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    while (userSessions.length >= this.maxSessionsPerUser) {
      const oldest = userSessions.shift();
      state.sessions = state.sessions.filter(session => session.id !== oldest.id);
    }
    if (state.sessions.length >= this.maxSessions) {
      throw new AuthStoreError(503, "AUTH_SESSION_LIMIT", "authentication session capacity is full", { "Retry-After": "1" });
    }
    const token = randomSessionToken();
    const session = {
      id: randomId("ase"),
      tokenHash: sha256(token),
      userId: user.id,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.sessionTtlMs).toISOString()
    };
    state.sessions.push(session);
    return { token, session };
  }

  async register({ username, password, displayName, teamName, group, teamAction, inviteCode }) {
    const normalized = normalizeUsername(username);
    const validatedPassword = validatePassword(password);
    const normalizedDisplayName = normalizeDisplayName(displayName, normalized.username);
    const normalizedGroup = normalizeParticipantGroup(group);
    const normalizedTeamAction = normalizeTeamAction(teamAction);
    if (normalizedTeamAction === "join" && teamName !== undefined) {
      throw new AuthStoreError(400, "TEAM_JOIN_NAME_NOT_ALLOWED", "joining a team only accepts an invite code");
    }
    if (normalizedTeamAction === "create" && inviteCode !== undefined) {
      throw new AuthStoreError(400, "TEAM_CREATE_INVITE_NOT_ALLOWED", "creating a team does not accept an invite code");
    }
    const normalizedTeamName = normalizedTeamAction === "create" ? normalizeTeamName(teamName) : null;
    const normalizedInviteCode = normalizedTeamAction === "join" ? normalizeTeamInviteCode(inviteCode) : null;
    await this.ready;
    const registration = {
      usernameKey: normalized.usernameKey,
      teamAction: normalizedTeamAction,
      normalizedTeamName,
      normalizedInviteCode
    };
    // Reject requests that cannot succeed before spending an expensive scrypt
    // slot. The same checks run again under the mutation lock below so that
    // concurrent registrations cannot race the user, team, or closure limits.
    this.assertRegistrationAllowed(this.state, registration);
    const passwordHash = await this.withPasswordOperation(() => createPasswordHash(validatedPassword));
    return this.withMutation((state, now) => {
      this.assertRegistrationAllowed(state, registration);
      let team;
      let createdTeam = false;
      if (normalizedTeamAction === "create") {
        team = createTeamInState(state, normalizedTeamName, now);
        createdTeam = true;
      } else {
        team = state.teams.find(item => item.inviteCode === normalizedInviteCode);
        if (!team) {
          throw new AuthStoreError(404, "TEAM_INVITE_NOT_FOUND", "team invite code does not match a team");
        }
        if (team.officialTeamId) {
          throw new AuthStoreError(403, "TEAM_INVITE_UNAVAILABLE", "official teams do not accept local registrations");
        }
      }
      const existingParticipant = normalizedTeamAction === "join"
        ? state.users.find(item => item.role !== "admin" && item.teamId === team.id)
        : null;
      const effectiveGroup = existingParticipant?.group || normalizedGroup;
      const bootstrapAdmin = state.users.length === 0;
      const user = {
        id: randomId("usr"),
        username: normalized.username,
        usernameKey: normalized.usernameKey,
        displayName: normalizedDisplayName,
        teamId: team.id,
        teamName: team.teamName,
        group: effectiveGroup,
        role: bootstrapAdmin ? "admin" : "user",
        passwordHash,
        createdAt: new Date(now).toISOString()
      };
      state.users.push(user);
      const createdSession = this.createSessionInState(state, user, now);
      return {
        user: publicUser(user),
        session: publicSession(createdSession.session),
        token: createdSession.token,
        bootstrapAdmin,
        // Returned only to a new team creator. Public users and records do
        // not expose this join credential.
        teamInviteCode: createdTeam ? team.inviteCode : null
      };
    });
  }

  async login({ username, password, administratorsOnly = false }) {
    let normalized = null;
    try {
      normalized = normalizeUsername(username);
    } catch (_error) {
      // Keep the public error generic while still doing one password hash below.
    }
    let validatedPassword = null;
    try {
      validatedPassword = validatePassword(password);
    } catch (error) {
      if (typeof password !== "string" || Buffer.byteLength(String(password), "utf8") > 512) throw error;
      validatedPassword = String(password);
    }
    await this.ready;
    const candidate = normalized
      ? this.state.users.find(user => user.usernameKey === normalized.usernameKey)
      : null;
    const passwordCandidate = candidate?.passwordHash ? candidate : null;
    const salt = passwordCandidate ? Buffer.from(passwordCandidate.passwordHash.salt, "base64url") : this.dummySalt;
    const expected = passwordCandidate ? Buffer.from(passwordCandidate.passwordHash.hash, "base64url") : this.dummyHash;
    const actual = await this.withPasswordOperation(() => scryptPassword(
      validatedPassword,
      salt,
      passwordCandidate?.passwordHash || SCRYPT_PARAMETERS
    ));
    const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!passwordCandidate || !matches) {
      throw new AuthStoreError(401, "INVALID_CREDENTIALS", "username or password is incorrect", {
        "WWW-Authenticate": "Cookie realm=\"chenlong\""
      });
    }
    if (administratorsOnly && candidate.role !== "admin") {
      throw new AuthStoreError(403, "LOCAL_LOGIN_ADMIN_ONLY", "此登录入口仅供管理员使用。");
    }
    const upgradedPasswordHash = candidate && candidate.passwordHash.N !== SCRYPT_PARAMETERS.N
      ? await this.withPasswordOperation(() => createPasswordHash(validatedPassword))
      : null;
    return this.withMutation((state, now) => {
      const user = state.users.find(item => item.id === candidate.id);
      if (!user) throw new AuthStoreError(401, "INVALID_CREDENTIALS", "username or password is incorrect");
      if (upgradedPasswordHash) user.passwordHash = upgradedPasswordHash;
      const createdSession = this.createSessionInState(state, user, now);
      return {
        user: publicUser(user),
        session: publicSession(createdSession.session),
        token: createdSession.token,
        bootstrapAdmin: false
      };
    });
  }

  async loginExternalIdentity({ officialUserId, officialTeamId, group, teamName }) {
    const normalizedOfficialUserId = normalizeOfficialId(officialUserId, "officialUserId");
    const normalizedOfficialTeamId = normalizeOfficialId(officialTeamId, "officialTeamId");
    const normalizedGroup = normalizeCompatibleParticipantGroup(group);
    const normalizedTeamName = normalizeTeamName(teamName);
    const username = officialUsername(normalizedOfficialUserId);
    const usernameKey = username.toLowerCase();
    await this.ready;
    return this.withMutation((state, now) => {
      if (!state.users.some(user => user.role === "admin")) {
        throw new AuthStoreError(403, "EXTERNAL_ADMIN_REQUIRED", "an administrator must initialize the platform first");
      }
      let user = state.users.find(item => item.officialUserId === normalizedOfficialUserId);
      const usernameConflict = state.users.find(item => item.usernameKey === usernameKey);
      if (usernameConflict && usernameConflict !== user) {
        throw new AuthStoreError(409, "EXTERNAL_IDENTITY_CONFLICT", "official identity conflicts with a local account");
      }
      if (user && user.usernameKey !== usernameKey) {
        throw new AuthStoreError(409, "EXTERNAL_IDENTITY_CONFLICT", "official identity mapping is inconsistent");
      }
      if (user && user.officialTeamId !== normalizedOfficialTeamId) {
        throw new AuthStoreError(
          403,
          "OFFICIAL_TEAM_REASSIGNMENT_REQUIRES_ADMIN",
          "official user team binding cannot be changed by browser SSO"
        );
      }

      let team = state.teams.find(item => item.officialTeamId === normalizedOfficialTeamId);
      if (!team) {
        if (state.users.length >= this.maxUsers) {
          throw new AuthStoreError(429, "USER_LIMIT_REACHED", "local user limit reached");
        }
        team = createTeamInState(state, normalizedTeamName, now, { allowDuplicateName: true });
        team.officialTeamId = normalizedOfficialTeamId;
      } else if (team.teamName !== normalizedTeamName) {
        team.teamName = normalizedTeamName;
        team.teamNameKey = teamNameKey(normalizedTeamName);
        for (const member of state.users) {
          if (member.teamId === team.id) member.teamName = normalizedTeamName;
        }
      }

      if (!user) {
        if (state.users.length >= this.maxUsers) {
          throw new AuthStoreError(429, "USER_LIMIT_REACHED", "local user limit reached");
        }
        user = {
          id: randomId("usr"),
          username,
          usernameKey,
          displayName: `官网选手-${sha256(normalizedOfficialUserId).slice(0, 8)}`,
          teamId: team.id,
          teamName: team.teamName,
          group: normalizedGroup,
          role: "user",
          officialUserId: normalizedOfficialUserId,
          officialTeamId: normalizedOfficialTeamId,
          createdAt: new Date(now).toISOString()
        };
        state.users.push(user);
      } else {
        user.teamId = team.id;
        user.teamName = team.teamName;
        user.group = normalizedGroup;
        user.officialTeamId = normalizedOfficialTeamId;
      }
      for (const member of state.users) {
        if (member.officialTeamId === normalizedOfficialTeamId) member.group = normalizedGroup;
      }
      const createdSession = this.createSessionInState(state, user, now);
      return {
        user: publicUser(user),
        session: publicSession(createdSession.session),
        token: createdSession.token,
        bootstrapAdmin: false
      };
    });
  }

  async authenticate(token) {
    await this.ready;
    if (typeof token !== "string" || !SESSION_TOKEN_PATTERN.test(token)) {
      throw new AuthStoreError(401, "AUTHENTICATION_REQUIRED", "a valid login session is required", {
        "WWW-Authenticate": "Cookie realm=\"chenlong\""
      });
    }
    const tokenHash = sha256(token);
    const session = this.state.sessions.find(item => item.tokenHash === tokenHash);
    const now = this.timestamp();
    if (!session || Date.parse(session.expiresAt) <= now) {
      if (session) {
        await this.withMutation(state => {
          state.sessions = state.sessions.filter(item => item.id !== session.id);
          return null;
        });
      }
      throw new AuthStoreError(401, "AUTHENTICATION_REQUIRED", "login session is missing or expired", {
        "WWW-Authenticate": "Cookie realm=\"chenlong\""
      });
    }
    const user = this.state.users.find(item => item.id === session.userId);
    if (!user) throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "login session references an unknown user");
    // teamId stays server-side: it binds new competition sessions to a stable
    // team identity without exposing a mutable grouping key in public profile
    // responses.
    return { user: publicUser(user), session: publicSession(session), tokenHash, teamId: user.teamId };
  }

  async logout(token) {
    await this.ready;
    if (typeof token !== "string" || !SESSION_TOKEN_PATTERN.test(token)) return false;
    const tokenHash = sha256(token);
    if (!this.state.sessions.some(session => session.tokenHash === tokenHash)) return false;
    return this.withMutation(state => {
      const previousLength = state.sessions.length;
      state.sessions = state.sessions.filter(session => session.tokenHash !== tokenHash);
      return state.sessions.length !== previousLength;
    });
  }

  async status() {
    await this.ready;
    return {
      userCount: this.state.users.length,
      bootstrapAdminPending: this.state.users.length === 0,
      sessionTtlMs: this.sessionTtlMs,
      maxUsers: this.maxUsers,
      maxSessions: this.maxSessions,
      maxSessionsPerUser: this.maxSessionsPerUser,
      maxPasswordOperations: this.maxPasswordOperations,
      maxPasswordQueue: this.maxPasswordQueue,
      passwordQueueTimeoutMs: this.passwordQueueTimeoutMs,
      activePasswordOperations: this.activePasswordOperations,
      queuedPasswordOperations: this.passwordOperationQueue.length,
      maxMutationsPerBatch: this.maxMutationsPerBatch,
      mutationBatchWindowMs: this.mutationBatchWindowMs,
      maxMutationQueue: this.maxMutationQueue,
      queuedMutations: this.mutationQueue.length,
      processingMutationBatch: this.processingMutationBatch,
      registrationOpen: this.registrationOpen
    };
  }

  async getPublicUser(userId) {
    await this.ready;
    const normalized = validateUserId(userId, { allowNull: true });
    if (!normalized) return null;
    const user = this.state.users.find(item => item.id === normalized);
    return user ? publicUser(user) : null;
  }

  async getTeamInviteForUser(userId) {
    await this.ready;
    const normalizedUserId = validateUserId(userId);
    const user = this.state.users.find(item => item.id === normalizedUserId);
    if (!user) throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "authenticated user is missing");
    if (user.role === "admin") {
      throw new AuthStoreError(403, "TEAM_INVITE_UNAVAILABLE", "administrator accounts do not participate in teams");
    }
    if (user.officialUserId) {
      throw new AuthStoreError(403, "TEAM_INVITE_UNAVAILABLE", "official teams do not use local invite codes");
    }
    const team = this.state.teams.find(item => item.id === user.teamId);
    if (!team) throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "authenticated user references an unknown team");
    return Object.freeze({ teamName: team.teamName, inviteCode: team.inviteCode });
  }

  async listPublicUsers() {
    await this.ready;
    return this.state.users.map(publicUser);
  }

  async listAdminUsers() {
    await this.ready;
    return this.state.users.map(adminUser);
  }

  async listTeamsForAdmin() {
    await this.ready;
    return this.state.teams.map(team => {
      const members = this.state.users
        .filter(user => user.role !== "admin" && user.teamId === team.id)
        .map(user => ({
          userId: user.id,
          username: user.username,
          displayName: user.displayName
        }))
        .sort((left, right) => left.username.localeCompare(right.username, "zh-CN"));
      return {
        teamId: team.id,
        teamName: team.teamName,
        members
      };
    }).filter(team => team.members.length > 0)
      .sort((left, right) => left.teamName.localeCompare(right.teamName, "zh-CN"));
  }

  async updateManagedUser(userId, { teamName, group }) {
    const normalizedUserId = validateUserId(userId);
    const normalizedTeamName = normalizeTeamName(teamName);
    const normalizedGroup = normalizeParticipantGroup(group);
    return this.withMutation(state => {
      const current = state.users.find(user => user.id === normalizedUserId);
      if (!current) {
        throw new AuthStoreError(404, "USER_NOT_FOUND", "user does not exist");
      }
      if (current.role === "admin") {
        throw new AuthStoreError(409, "ADMIN_ACCOUNT_NOT_PARTICIPANT", "administrator accounts do not have a team or participant group");
      }
      if (current.officialUserId) {
        throw new AuthStoreError(409, "OFFICIAL_IDENTITY_MANAGED_EXTERNALLY", "official participant data is managed by SSO");
      }
      const currentTeam = state.teams.find(team => team.id === current.teamId);
      if (!currentTeam) throw new AuthStoreError(500, "AUTH_STORE_CORRUPTED", "user references an unknown team");
      const changingTeamName = currentTeam.teamName !== normalizedTeamName;
      if (changingTeamName) {
        const conflict = state.teams.find(team => team.teamNameKey === teamNameKey(normalizedTeamName));
        if (conflict && conflict.id !== currentTeam.id) {
          throw new AuthStoreError(409, "TEAM_NAME_TAKEN", "team name is already registered");
        }
      }
      const changingTeamGroup = state.users.some(member => (
        member.role !== "admin" && member.teamId === currentTeam.id && member.group !== normalizedGroup
      ));
      const changed = changingTeamName || changingTeamGroup;
      if (!changed) return this.noMutation({ user: publicUser(current), changed: false });

      const user = state.users.find(item => item.id === normalizedUserId);
      if (changingTeamName) {
        const team = state.teams.find(item => item.id === user.teamId);
        team.teamName = normalizedTeamName;
        team.teamNameKey = teamNameKey(normalizedTeamName);
        for (const member of state.users) {
          if (member.teamId === team.id) member.teamName = normalizedTeamName;
        }
      }
      for (const member of state.users) {
        if (member.role !== "admin" && member.teamId === currentTeam.id) member.group = normalizedGroup;
      }
      return { user: publicUser(user), changed: true };
    });
  }
}

module.exports = {
  AUTH_STORE_SCHEMA_VERSION,
  TEAM_AUTH_STORE_SCHEMA_VERSION,
  FOUR_GROUP_AUTH_STORE_SCHEMA_VERSION,
  AUTH_RESPONSE_SCHEMA_VERSION,
  AUTH_COOKIE_NAME,
  DEFAULT_AUTH_SESSION_TTL_MS,
  MAX_AUTH_SESSION_TTL_MS,
  DEFAULT_MAX_USERS,
  MAX_USERS,
  DEFAULT_MAX_AUTH_SESSIONS,
  MAX_AUTH_SESSIONS,
  DEFAULT_MAX_SESSIONS_PER_USER,
  MAX_SESSIONS_PER_USER,
  DEFAULT_MAX_PASSWORD_OPERATIONS,
  MAX_PASSWORD_OPERATIONS,
  DEFAULT_MAX_PASSWORD_QUEUE,
  MAX_PASSWORD_QUEUE,
  DEFAULT_PASSWORD_QUEUE_TIMEOUT_MS,
  MAX_PASSWORD_QUEUE_TIMEOUT_MS,
  DEFAULT_MAX_MUTATIONS_PER_BATCH,
  MAX_MUTATIONS_PER_BATCH,
  DEFAULT_MUTATION_BATCH_WINDOW_MS,
  MAX_MUTATION_BATCH_WINDOW_MS,
  DEFAULT_MAX_MUTATION_QUEUE,
  MAX_MUTATION_QUEUE,
  MAX_AUTH_STORE_BYTES,
  LEGACY_BLOCKLY_SCRYPT_N,
  PARTICIPANT_GROUP_VALUES,
  DEFAULT_PARTICIPANT_GROUP,
  USER_ID_PATTERN,
  OFFICIAL_ID_PATTERN,
  AuthStoreError,
  AuthStore,
  normalizeUsername,
  normalizeDisplayName,
  normalizeTeamName,
  normalizeTeamInviteCode,
  normalizeParticipantGroup,
  validatePassword,
  validateUserId
};
