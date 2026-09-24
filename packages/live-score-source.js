"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const contract = require("./platform-contract.js");
const internalServiceAuth = require("./internal-service-auth.js");

const MAX_AUTH_STORE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const GROUP_ALIASES = Object.freeze({
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
const SCORE_EXPORT_ADMIN = Object.freeze({
  id: "usr_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  username: "score_export_service",
  displayName: "成绩导出服务",
  role: "admin",
  teamId: null,
  teamName: null,
  group: null,
  createdAt: "2026-08-28T00:00:00.000Z"
});
const AGENT = new http.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4 });

function normalizedOrigin(value, label) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError(`${label} must be a plain local HTTP origin`);
  }
  return parsed.origin;
}

function requireSecret(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    throw new TypeError("live score source platform secret must contain at least 32 UTF-8 bytes");
  }
  return value;
}

function readAuthStore(authStorePath) {
  const resolved = path.resolve(authStorePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_AUTH_STORE_BYTES) {
    throw new TypeError("live score source auth store is unsafe");
  }
  const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!value || !["chenlong.auth-store/v4", "chenlong.auth-store/v5", "chenlong.auth-store/v6"].includes(value.schemaVersion)
    || !Array.isArray(value.users) || !Array.isArray(value.teams)) {
    throw new TypeError("live score source auth store is incompatible");
  }
  return value;
}

function rawJson(origin, requestPath, headers, label) {
  const target = new URL(requestPath, origin);
  return new Promise((resolve, reject) => {
    const request = http.get(target, {
      headers: { Accept: "application/json", "Accept-Encoding": "identity", ...headers },
      agent: AGENT,
      timeout: 30_000
    }, response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) request.destroy(new Error(`${label} response is too large`));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`${label} returned HTTP ${response.statusCode || 0}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
        } catch (_error) {
          reject(new Error(`${label} returned invalid JSON`));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error(`${label} timed out`)));
    request.on("error", reject);
  });
}

function payloadFingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function bytewiseTextCompare(left, right) {
  return Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
}

// Login sessions, password hashes and audit metadata do not affect an official
// score row.  Excluding them is important: otherwise an unrelated login while
// an export is being captured can make an otherwise stable score snapshot look
// inconsistent forever.  Every identity field consumed by buildLiveRows is
// included here, in a deterministic order.
function identityFingerprint(authStore) {
  const users = authStore.users.map(user => ({
    id: user.id,
    role: user.role,
    teamId: user.teamId,
    group: user.group,
    officialUserId: user.officialUserId ?? null,
    officialTeamId: user.officialTeamId ?? null
  })).sort((left, right) => bytewiseTextCompare(left.id, right.id));
  const teams = authStore.teams.map(team => ({
    id: team.id,
    teamName: team.teamName,
    officialTeamId: team.officialTeamId ?? null
  })).sort((left, right) => bytewiseTextCompare(left.id, right.id));
  return payloadFingerprint({ schemaVersion: authStore.schemaVersion, users, teams });
}

function liveSourceUnavailable(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readPagedRecordsOnce(origin, basePath, headersForPath, label) {
  const pagePath = page => `${basePath}${basePath.includes("?") ? "&" : "?"}page=${page}&pageSize=${PAGE_SIZE}`;
  const firstPath = pagePath(1);
  const first = await rawJson(origin, firstPath, headersForPath(firstPath), label);
  if (!Array.isArray(first.records)) throw new TypeError(`${label} records are invalid`);
  const totalPages = Number(first.pagination?.totalPages || 1);
  if (!Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > MAX_PAGES) {
    throw new TypeError(`${label} pagination is invalid or too large`);
  }
  const remaining = totalPages === 1 ? [] : await Promise.all(Array.from({ length: totalPages - 1 }, async (_, index) => {
    const requestPath = pagePath(index + 2);
    return rawJson(origin, requestPath, headersForPath(requestPath), label);
  }));
  const pages = [first, ...remaining];
  if (pages.some((page, index) => !Array.isArray(page.records)
    || Number(page.pagination?.page) !== index + 1 || Number(page.pagination?.totalPages) !== totalPages)) {
    throw new TypeError(`${label} pagination changed during snapshot`);
  }
  const records = pages.flatMap(page => page.records);
  return {
    records,
    fingerprint: payloadFingerprint({
      total: Number(first.pagination?.total ?? records.length),
      totalPages,
      records
    })
  };
}

async function pagedRecords(origin, basePath, headersForPath, label) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const before = await readPagedRecordsOnce(origin, basePath, headersForPath, label);
      const after = await readPagedRecordsOnce(origin, basePath, headersForPath, label);
      if (before.fingerprint === after.fingerprint) return after.records;
      lastError = new Error(`${label} changed while the score snapshot was being read`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`${label} could not provide a stable score snapshot`);
}

async function stableJson(origin, requestPath, headers, label) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const before = await rawJson(origin, requestPath, headers, label);
      const after = await rawJson(origin, requestPath, headers, label);
      if (payloadFingerprint(before) === payloadFingerprint(after)) return after;
      lastError = new Error(`${label} changed while the score snapshot was being read`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`${label} could not provide a stable score snapshot`);
}

function normalizedScore(value) {
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
}

function epochSeconds(value) {
  if (Number.isSafeInteger(value) && value >= 0 && value <= 9_999_999_999) return value;
  const millis = Date.parse(String(value || ""));
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : 0;
}

function groupType(value) {
  return GROUP_ALIASES[String(value || "").normalize("NFKC").trim().toLowerCase()] || null;
}

function emptyTaskScores() {
  return { task1: null, task2: null, task3: null };
}

function teamState(teamId, identity) {
  return {
    localTeamId: teamId,
    officialTeamId: identity.officialTeamId,
    teamName: identity.teamName,
    groupType: identity.groupType,
    users: [],
    python: emptyTaskScores(),
    blockly: emptyTaskScores(),
    workshop: null,
    finishTime: 0
  };
}

function applyRecordScores(records, teams, usersById, target) {
  for (const record of records) {
    if (record?.recordState !== "submitted") continue;
    const owner = usersById.get(record.ownerUserId || record.user?.id);
    // A valid stored team id is the immutable submission-time owner and must
    // win over the user's current SSO team.  Historical Python archives could
    // instead store the owner user id in record.teamId; because that value is
    // not a known team, those legacy records safely fall back to the current
    // account mapping. Blockly follows the same rule.
    const localTeamId = [record.teamId, record.user?.teamId, owner?.teamId]
      .find(candidate => typeof candidate === "string" && teams.has(candidate));
    const team = teams.get(localTeamId);
    const task = contract.platformTaskId(record.taskId);
    const score = normalizedScore(record.score);
    if (!team || !task || score === null) continue;
    if (team[target][task] === null || score > team[target][task]) team[target][task] = score;
    team.finishTime = Math.max(
      team.finishTime,
      epochSeconds(record.latestSubmittedAt || record.submittedAt || record.savedAt)
    );
  }
}

function workshopPercent(standing) {
  if (standing?.status !== "scored") return null;
  const micros = Number(standing.scoreMicros);
  return Number.isFinite(micros) && micros >= 0 && micros <= 1_000_000
    ? Math.round(micros / 100) / 100
    : null;
}

function mergedTasks(team) {
  return Object.fromEntries(["task1", "task2", "task3"].map(task => {
    const values = [team.python[task], team.blockly[task]].filter(Number.isFinite);
    return [task, values.length ? Math.max(...values) : 0];
  }));
}

function promotionMap(filePath, competitionStage) {
  if (!filePath) {
    throw liveSourceUnavailable(
      "LIVE_PROMOTION_UNAVAILABLE",
      "live score source requires an authoritative promotion status file"
    );
  }
  try {
    const resolved = path.resolve(filePath);
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 4 * 1024 * 1024) {
      throw new TypeError("promotion status file is unsafe");
    }
    const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
    if (value?.schemaVersion !== "chenlong.official-promotions/v1"
      || !value.stages || typeof value.stages !== "object" || Array.isArray(value.stages)) {
      throw new TypeError("promotion status file is incompatible");
    }
    const stage = value.stages[competitionStage];
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
      throw new TypeError("promotion stage is missing or invalid");
    }
    const result = new Map();
    for (const [teamId, status] of Object.entries(stage)) {
      if (status !== 0 && status !== 1) throw new TypeError("promotion status is invalid");
      result.set(teamId, status);
    }
    return result;
  } catch (error) {
    if (error?.code === "LIVE_PROMOTION_UNAVAILABLE") throw error;
    throw liveSourceUnavailable(
      "LIVE_PROMOTION_UNAVAILABLE",
      `authoritative promotion status could not be loaded: ${error?.message || "unknown error"}`
    );
  }
}

function buildLiveRows({ authStore, pythonRecords, blocklyRecords, workshopOverview, competitionStage, promotions }) {
  const usersById = new Map(authStore.users.map(user => [user.id, user]));
  const storedTeams = new Map(authStore.teams.map(team => [team.id, team]));
  const teams = new Map();
  for (const user of authStore.users) {
    if (user.role === "admin" || !user.officialUserId || !user.officialTeamId) continue;
    const localTeam = storedTeams.get(user.teamId);
    const normalizedGroup = groupType(user.group);
    if (!localTeam || !normalizedGroup || localTeam.officialTeamId !== user.officialTeamId) {
      throw new TypeError("official identity mapping is incomplete");
    }
    const identity = {
      officialTeamId: user.officialTeamId,
      teamName: localTeam.teamName,
      groupType: normalizedGroup
    };
    let team = teams.get(user.teamId);
    if (!team) {
      team = teamState(user.teamId, identity);
      teams.set(user.teamId, team);
    } else if (team.officialTeamId !== identity.officialTeamId || team.teamName !== identity.teamName
      || team.groupType !== identity.groupType) {
      throw new TypeError("official team members have inconsistent identity data");
    }
    team.users.push(user);
  }
  applyRecordScores(pythonRecords, teams, usersById, "python");
  applyRecordScores(blocklyRecords, teams, usersById, "blockly");
  for (const standing of Object.values(workshopOverview?.leaderboards || {}).flat()) {
    const team = teams.get(standing.teamId);
    const score = workshopPercent(standing);
    if (!team || score === null) continue;
    team.workshop = score;
    team.finishTime = Math.max(team.finishTime, epochSeconds(standing.scoredAt || standing.submittedAt));
  }
  const rows = [];
  for (const team of teams.values()) {
    const contribution = require("./score-download.js").scoreContributions(mergedTasks(team), team.workshop);
    for (const user of team.users) {
      rows.push({
        competition_stage: competitionStage,
        user_id: user.officialUserId,
        team_id: team.officialTeamId,
        team_name: team.teamName,
        group_type: team.groupType,
        ...contribution,
        group_rank: 1,
        promote_status: promotions.get(team.officialTeamId) || 0,
        evaluate_finish_time: team.finishTime
      });
    }
  }
  return rows;
}

function createLiveScoreDataSource({
  upstreams,
  secret,
  authStorePath,
  promotionFile = process.env.CHENLONG_SCORE_DOWNLOAD_PROMOTIONS_FILE,
  supportedStages = ["preliminary"],
  nowSeconds = () => Math.floor(Date.now() / 1000)
} = {}) {
  const origins = {
    python: normalizedOrigin(upstreams?.python, "Python origin"),
    blockly: normalizedOrigin(upstreams?.blockly, "Blockly origin"),
    workshop: normalizedOrigin(upstreams?.workshop, "Workshop origin")
  };
  const platformSecret = requireSecret(secret);
  const stages = new Set(supportedStages);
  if (![...stages].every(stage => ["preliminary", "rematch"].includes(stage))) {
    throw new TypeError("live score source stages are invalid");
  }
  if (typeof nowSeconds !== "function") throw new TypeError("live score source nowSeconds must be a function");
  const resolvedAuthStore = path.resolve(authStorePath);
  return {
    async listScoreRows(context) {
      if (!stages.has(context.competitionStage)) {
        throw liveSourceUnavailable(
          "LIVE_STAGE_UNAVAILABLE",
          `live score source is not configured for ${context.competitionStage}`
        );
      }
      if (context.pullType === "increment") {
        throw liveSourceUnavailable(
          "LIVE_INCREMENT_UNAVAILABLE",
          "live score source cannot authoritatively track incremental identity, group, team, or promotion changes"
        );
      }
      const blocklyPrincipal = contract.signPrincipal(platformSecret, "blockly", SCORE_EXPORT_ADMIN);
      const workshopPrincipal = contract.signPrincipal(platformSecret, "workshop", SCORE_EXPORT_ADMIN);
      let consistencyError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const authBefore = readAuthStore(resolvedAuthStore);
        const promotionsBefore = promotionMap(promotionFile, context.competitionStage);
        const [pythonRecords, blocklyRecords, workshopOverview] = await Promise.all([
          pagedRecords(
            origins.python,
            "/api/v1/internal/platform/score-records",
            requestPath => ({
              [internalServiceAuth.SERVICE_HEADER]: internalServiceAuth.signServiceRequest(platformSecret, requestPath)
            }),
            "Python score source"
          ),
          pagedRecords(
            origins.blockly,
            "/api/admin/records",
            () => ({ [contract.PRINCIPAL_HEADER]: blocklyPrincipal }),
            "Blockly score source"
          ),
          stableJson(origins.workshop, "/api/competition/admin/overview", {
            [contract.PRINCIPAL_HEADER]: workshopPrincipal
          }, "Workshop score source")
        ]);
        const authAfter = readAuthStore(resolvedAuthStore);
        const promotionsAfter = promotionMap(promotionFile, context.competitionStage);
        const authStable = identityFingerprint(authBefore) === identityFingerprint(authAfter);
        const promotionsStable = payloadFingerprint([...promotionsBefore].sort())
          === payloadFingerprint([...promotionsAfter].sort());
        if (!authStable || !promotionsStable) {
          consistencyError = liveSourceUnavailable(
            "LIVE_SNAPSHOT_UNSTABLE",
            "identity or promotion data changed while the score snapshot was being read"
          );
          continue;
        }
        const rows = buildLiveRows({
          authStore: authAfter,
          pythonRecords,
          blocklyRecords,
          workshopOverview,
          competitionStage: context.competitionStage,
          promotions: promotionsAfter
        });
        if (rows.length > Number(context.maximumRows || 50_001)) {
          throw new Error("live score source row limit exceeded");
        }
        const completedAt = Number(nowSeconds());
        if (!Number.isSafeInteger(completedAt) || completedAt < 0) {
          throw new TypeError("live score source clock is invalid");
        }
        return { rows, snapshotTime: completedAt };
      }
      throw consistencyError || new Error("live score source could not capture a stable snapshot");
    }
  };
}

module.exports = Object.freeze({
  SCORE_EXPORT_ADMIN,
  buildLiveRows,
  createLiveScoreDataSource,
  identityFingerprint
});
