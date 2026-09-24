#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PROJECTS_ROOT = path.join(ROOT, "projects");
const DEFAULT_PATHS = Object.freeze({
  pythonAuth: path.join(PROJECTS_ROOT, "car-python", ".runtime", "auth", "auth-store.json"),
  blocklyStore: path.join(PROJECTS_ROOT, "blockly-page3", ".blockly-data", "primary-blockly-store.json"),
  workshopRoot: path.join(PROJECTS_ROOT, "tmm"),
  mapping: path.join(ROOT, "data", "legacy-id-map.json"),
  backupRoot: path.join(ROOT, "record-backups")
});

const LEGACY_MAP_SCHEMA = "chenlong.platform-legacy-id-map/v1";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const GROUP_DIVISIONS = Object.freeze({
  primary: "primary",
  junior: "junior",
  high: "senior"
});
const GROUP_ALIASES = Object.freeze({
  primary: "primary", primary_low: "primary", primary_high: "primary", primary_school: "primary", "小学组": "primary",
  "小学组（1-3年级）": "primary", "小学组(1-3年级)": "primary", "小学低年级组": "primary",
  "小学组（4-6年级）": "primary", "小学组(4-6年级)": "primary", "小学高年级组": "primary",
  junior: "junior", middle_school: "junior", "初中组": "junior",
  high: "high", high_school: "high", senior: "high", "高中组": "high"
});

function canonicalParticipantGroup(value) {
  const key = String(value || "primary").normalize("NFKC").trim().toLowerCase();
  return GROUP_ALIASES[key] || "primary";
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeKey(value) {
  return String(value || "").trim().normalize("NFC").toLocaleLowerCase("zh-CN");
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function randomInvite(used) {
  while (true) {
    let value = "";
    for (const byte of crypto.randomBytes(8)) value += ALPHABET[byte % ALPHABET.length];
    if (!used.has(value)) return value;
  }
}

function validIso(value, fallback = new Date().toISOString()) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function safeId(value, prefix, used) {
  let id = typeof value === "string" && new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(value)
    ? value : randomId(prefix);
  while (used.has(id)) id = randomId(prefix);
  used.add(id);
  return id;
}

function findWorkshopDatabase(workshopRoot) {
  const stateRoot = path.join(workshopRoot, ".wrangler", "state");
  if (!fs.existsSync(stateRoot)) return null;
  const candidates = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".sqlite") && entry.name !== "metadata.sqlite"
        && fullPath.toLocaleLowerCase("en-US").includes(`${path.sep}d1${path.sep}`)) {
        candidates.push({ path: fullPath, size: fs.statSync(fullPath).size });
      }
    }
  };
  visit(stateRoot);
  return candidates.sort((left, right) => right.size - left.size)[0]?.path || null;
}

function readWorkshopTeams(workshopRoot) {
  const databasePath = findWorkshopDatabase(workshopRoot);
  if (!databasePath) return { databasePath: null, teams: [], submissions: [] };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (_error) {
    return { databasePath, teams: [], submissions: [], warning: "node:sqlite unavailable" };
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const hasTeams = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'competition_teams'").get();
    if (!hasTeams) return { databasePath, teams: [], submissions: [] };
    const teams = database.prepare(`
      SELECT id, team_name, division, created_at, updated_at, latest_submission_id
      FROM competition_teams ORDER BY created_at, id
    `).all();
    const submissions = database.prepare(`
      SELECT id, team_id, status, score_micros, model_name, submitted_at,
             scored_at, evaluation_version
      FROM competition_submissions ORDER BY submitted_at, id
    `).all();
    return { databasePath, teams, submissions };
  } finally {
    database.close();
  }
}

function collectMigration({ pythonState, blocklyState, workshopTeams = [], workshopSubmissions = [], now = new Date().toISOString() }) {
  const next = JSON.parse(JSON.stringify(pythonState));
  next.schemaVersion = "chenlong.auth-store/v6";
  next.users = next.users.map(user => ({
    ...user,
    group: user.role === "admin" && user.group === null ? null : canonicalParticipantGroup(user.group)
  }));
  const mapping = {
    schemaVersion: LEGACY_MAP_SCHEMA,
    generatedAt: now,
    sources: { python: {}, blockly: { users: {}, teams: {}, records: {} }, workshop: { teams: {}, submissions: {} } },
    conflicts: []
  };
  const usedUserIds = new Set(next.users.map(user => user.id));
  const usedTeamIds = new Set(next.teams.map(team => team.id));
  const usedInvites = new Set(next.teams.map(team => team.inviteCode));
  const userByKey = new Map(next.users.map(user => [user.usernameKey, user]));
  const teamByKey = new Map(next.teams.map(team => [team.teamNameKey, team]));
  const teamGroupById = new Map();
  for (const user of next.users) {
    if (user.role === "admin" || !user.teamId || !Object.hasOwn(GROUP_DIVISIONS, user.group)) continue;
    if (!teamGroupById.has(user.teamId)) teamGroupById.set(user.teamId, user.group);
  }
  next.users.forEach(user => { mapping.sources.python[user.id] = user.id; });

  const blocklyTeamById = new Map((blocklyState.teams || []).map(team => [team.id, team]));
  for (const legacyTeam of blocklyState.teams || []) {
    const key = normalizeKey(legacyTeam.teamName);
    let canonical = teamByKey.get(key);
    if (!canonical) {
      const inviteCode = typeof legacyTeam.inviteCode === "string" && /^[A-HJ-NP-Z2-9]{8}$/.test(legacyTeam.inviteCode)
        && !usedInvites.has(legacyTeam.inviteCode) ? legacyTeam.inviteCode : randomInvite(usedInvites);
      usedInvites.add(inviteCode);
      canonical = {
        id: safeId(legacyTeam.id, "tea", usedTeamIds),
        teamName: String(legacyTeam.teamName).trim().normalize("NFC"),
        teamNameKey: key,
        inviteCode,
        createdAt: validIso(legacyTeam.createdAt, now)
      };
      next.teams.push(canonical);
      teamByKey.set(key, canonical);
    }
    mapping.sources.blockly.teams[legacyTeam.id] = canonical.id;
  }

  for (const legacyUser of blocklyState.users || []) {
    const usernameKey = normalizeKey(legacyUser.username);
    const existing = userByKey.get(usernameKey);
    if (existing) {
      mapping.sources.blockly.users[legacyUser.id] = existing.id;
      const legacyTeam = blocklyTeamById.get(legacyUser.teamId);
      if (legacyUser.role !== "admin" && legacyTeam && normalizeKey(existing.teamName) !== normalizeKey(legacyTeam.teamName)) {
        mapping.conflicts.push({
          type: "username-team-mismatch",
          username: legacyUser.username,
          canonicalTeam: existing.teamName,
          legacyTeam: legacyTeam.teamName,
          resolution: "kept-python-team"
        });
      }
      continue;
    }
    if (legacyUser.role === "admin") {
      mapping.conflicts.push({ type: "extra-admin", username: legacyUser.username, resolution: "not-imported" });
      continue;
    }
    const legacyTeam = blocklyTeamById.get(legacyUser.teamId);
    const canonicalTeamId = mapping.sources.blockly.teams[legacyTeam?.id];
    const canonicalTeam = next.teams.find(team => team.id === canonicalTeamId);
    if (!canonicalTeam || typeof legacyUser.passwordSalt !== "string" || typeof legacyUser.passwordHash !== "string") {
      mapping.conflicts.push({ type: "invalid-blockly-user", username: legacyUser.username, resolution: "not-imported" });
      continue;
    }
    const requestedGroup = canonicalParticipantGroup(legacyUser.group);
    const canonicalGroup = teamGroupById.get(canonicalTeam.id) || requestedGroup;
    if (canonicalGroup !== requestedGroup) {
      mapping.conflicts.push({
        type: "team-group-normalized",
        username: legacyUser.username,
        teamName: canonicalTeam.teamName,
        requestedGroup,
        canonicalGroup,
        resolution: "inherited-team-group"
      });
    }
    teamGroupById.set(canonicalTeam.id, canonicalGroup);
    const canonicalUser = {
      id: safeId(legacyUser.id, "usr", usedUserIds),
      username: String(legacyUser.username).trim().normalize("NFC"),
      usernameKey,
      displayName: String(legacyUser.displayName || legacyUser.username).trim().normalize("NFC"),
      teamId: canonicalTeam.id,
      teamName: canonicalTeam.teamName,
      group: canonicalGroup,
      role: "user",
      passwordHash: {
        algorithm: "scrypt",
        N: 16384,
        r: 8,
        p: 1,
        keyLength: 32,
        salt: legacyUser.passwordSalt,
        hash: legacyUser.passwordHash
      },
      createdAt: validIso(legacyUser.createdAt, now)
    };
    next.users.push(canonicalUser);
    userByKey.set(usernameKey, canonicalUser);
    mapping.sources.blockly.users[legacyUser.id] = canonicalUser.id;
  }
  for (const record of blocklyState.records || []) mapping.sources.blockly.records[record.id] = record.id;

  for (const legacyTeam of workshopTeams) {
    const teamName = String(legacyTeam.team_name || "").trim().normalize("NFC");
    const key = normalizeKey(teamName);
    if (!teamName || !key) continue;
    let canonical = teamByKey.get(key);
    if (!canonical) {
      canonical = {
        id: safeId(null, "tea", usedTeamIds),
        teamName,
        teamNameKey: key,
        inviteCode: randomInvite(usedInvites),
        createdAt: validIso(Number(legacyTeam.created_at), now)
      };
      usedInvites.add(canonical.inviteCode);
      next.teams.push(canonical);
      teamByKey.set(key, canonical);
      mapping.conflicts.push({
        type: "workshop-team-unclaimed",
        legacyTeamId: legacyTeam.id,
        teamName,
        canonicalTeamId: canonical.id,
        resolution: "created-team-without-members"
      });
    }
    mapping.sources.workshop.teams[legacyTeam.id] = canonical.id;
  }
  for (const submission of workshopSubmissions) mapping.sources.workshop.submissions[submission.id] = submission.id;

  next.revision = Number.isSafeInteger(next.revision) ? next.revision + 1 : 1;
  next.sessions = [];
  return { state: next, mapping };
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function backupInputs(paths, workshopDatabase) {
  const destination = path.join(paths.backupRoot, `integrated-platform-${timestampSlug()}`);
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(paths.pythonAuth, path.join(destination, "python-auth-store.json"));
  fs.copyFileSync(paths.blocklyStore, path.join(destination, "blockly-primary-store.json"));
  if (workshopDatabase && fs.existsSync(workshopDatabase)) {
    fs.copyFileSync(workshopDatabase, path.join(destination, "workshop-d1.sqlite"));
  }
  return destination;
}

function backupWorkshopDatabase(paths, workshopDatabase) {
  if (!workshopDatabase || !fs.existsSync(workshopDatabase)) throw new Error("识物工坊本地数据库不存在。 ");
  const destination = path.join(paths.backupRoot, `integrated-platform-links-${timestampSlug()}`);
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(workshopDatabase, path.join(destination, "workshop-d1.sqlite"));
  return destination;
}

function syncWorkshopLinks(databasePath, workshopTeamMapping, canonicalState, now = Date.now()) {
  if (!databasePath || !fs.existsSync(databasePath)) throw new Error("识物工坊本地数据库不存在。 ");
  if (!workshopTeamMapping || typeof workshopTeamMapping !== "object" || Array.isArray(workshopTeamMapping)) {
    throw new TypeError("识物工坊队伍映射无效。 ");
  }
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(databasePath);
  const canonicalTeams = new Map((canonicalState?.teams || []).map(team => [team.id, team]));
  const canonicalGroups = new Map();
  for (const user of canonicalState?.users || []) {
    if (user.role !== "admin" && user.teamId && !canonicalGroups.has(user.teamId)) {
      canonicalGroups.set(user.teamId, canonicalParticipantGroup(user.group));
    }
  }
  let linked = 0;
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN IMMEDIATE");
    database.exec(`CREATE TABLE IF NOT EXISTS competition_platform_team_links (
      platform_team_id TEXT PRIMARY KEY NOT NULL,
      workshop_team_id TEXT NOT NULL UNIQUE REFERENCES competition_teams(id) ON DELETE CASCADE,
      linked_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    const workshopTeam = database.prepare("SELECT id FROM competition_teams WHERE id = ? LIMIT 1");
    const linkByPlatform = database.prepare("SELECT workshop_team_id FROM competition_platform_team_links WHERE platform_team_id = ? LIMIT 1");
    const linkByWorkshop = database.prepare("SELECT platform_team_id FROM competition_platform_team_links WHERE workshop_team_id = ? LIMIT 1");
    const insert = database.prepare(`INSERT INTO competition_platform_team_links (
      platform_team_id, workshop_team_id, linked_at, updated_at
    ) VALUES (?, ?, ?, ?)`);
    const updateTeam = database.prepare(`UPDATE competition_teams
      SET team_name = ?, team_name_key = ?, division = ?, updated_at = ?
      WHERE id = ?`);
    for (const [legacyTeamId, canonicalTeamId] of Object.entries(workshopTeamMapping)) {
      if (typeof legacyTeamId !== "string" || !legacyTeamId || !/^tea_[a-f0-9]{32}$/.test(canonicalTeamId)) {
        throw new TypeError("识物工坊队伍映射包含无效标识。 ");
      }
      if (!workshopTeam.get(legacyTeamId)) throw new Error(`识物工坊旧队伍不存在：${legacyTeamId}`);
      const byPlatform = linkByPlatform.get(canonicalTeamId);
      const byWorkshop = linkByWorkshop.get(legacyTeamId);
      if ((byPlatform && byPlatform.workshop_team_id !== legacyTeamId)
        || (byWorkshop && byWorkshop.platform_team_id !== canonicalTeamId)) {
        throw new Error("识物工坊队伍已有冲突的平台关联。 ");
      }
      if (!byPlatform && !byWorkshop) {
        insert.run(canonicalTeamId, legacyTeamId, now, now);
        linked += 1;
      }
      const canonicalTeam = canonicalTeams.get(canonicalTeamId);
      const canonicalGroup = canonicalGroups.get(canonicalTeamId);
      if (canonicalTeam && canonicalGroup) {
        updateTeam.run(
          canonicalTeam.teamName,
          normalizeKey(canonicalTeam.teamName),
          GROUP_DIVISIONS[canonicalGroup],
          now,
          legacyTeamId
        );
      }
    }
    database.exec("COMMIT");
    return { linked, total: Object.keys(workshopTeamMapping).length };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch (_rollbackError) { /* no active transaction */ }
    throw error;
  } finally {
    database.close();
  }
}

async function validateCandidate(state) {
  const temporaryRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "chenlong-platform-auth-validate-"));
  try {
    atomicWriteJson(path.join(temporaryRoot, "auth-store.json"), state);
    const { AuthStore } = require(path.join(PROJECTS_ROOT, "car-python", "backend", "auth-store.js"));
    const store = new AuthStore({ rootDir: temporaryRoot });
    await store.ready;
    return store.status();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const syncOnly = process.argv.includes("--sync-workshop-links");
  const paths = { ...DEFAULT_PATHS };
  const pythonState = readJson(paths.pythonAuth);
  if (syncOnly) {
    const workshop = readWorkshopTeams(paths.workshopRoot);
    const mapping = readJson(paths.mapping);
    if (mapping?.schemaVersion !== LEGACY_MAP_SCHEMA) throw new Error("历史映射文件版本无效。 ");
    const backupDirectory = backupWorkshopDatabase(paths, workshop.databasePath);
    const result = syncWorkshopLinks(
      workshop.databasePath,
      mapping.sources?.workshop?.teams,
      pythonState
    );
    process.stdout.write(`${JSON.stringify({ mode: "sync-workshop-links", backupDirectory, workshopDatabase: workshop.databasePath, ...result }, null, 2)}\n`);
    return;
  }
  const blocklyState = readJson(paths.blocklyStore);
  const workshop = readWorkshopTeams(paths.workshopRoot);
  const result = collectMigration({
    pythonState,
    blocklyState,
    workshopTeams: workshop.teams,
    workshopSubmissions: workshop.submissions
  });
  const validation = await validateCandidate(result.state);
  const report = {
    mode: apply ? "apply" : "dry-run",
    before: {
      pythonUsers: pythonState.users.length,
      pythonTeams: pythonState.teams.length,
      blocklyUsers: blocklyState.users.length,
      blocklyTeams: blocklyState.teams.length,
      blocklyRecords: blocklyState.records.length,
      workshopTeams: workshop.teams.length,
      workshopSubmissions: workshop.submissions.length
    },
    after: {
      users: result.state.users.length,
      teams: result.state.teams.length,
      sessions: result.state.sessions.length,
      conflicts: result.mapping.conflicts.length
    },
    validation,
    workshopDatabase: workshop.databasePath
  };
  if (apply) {
    const backupDirectory = backupInputs(paths, workshop.databasePath);
    atomicWriteJson(paths.pythonAuth, result.state);
    atomicWriteJson(paths.mapping, result.mapping);
    report.workshopLinks = syncWorkshopLinks(
      workshop.databasePath,
      result.mapping.sources.workshop.teams,
      result.state
    );
    report.backupDirectory = backupDirectory;
    report.mappingFile = paths.mapping;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

module.exports = { DEFAULT_PATHS, PROJECTS_ROOT, collectMigration, findWorkshopDatabase, readWorkshopTeams, syncWorkshopLinks };

if (require.main === module) main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
