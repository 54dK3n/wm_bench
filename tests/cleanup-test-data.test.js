"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { BlocklyRecordStore } = require("../projects/blockly-page3/blockly-record-store.js");
const cleanup = require("../tools/cleanup-test-data.js");

const temporaryRoots = [];

function identifier(prefix, seed) {
  return `${prefix}_${crypto.createHash("md5").update(seed).digest("hex")}`;
}

function record(id, owner, overrides = {}) {
  return {
    id,
    ownerUserId: owner.id,
    ownerUsername: owner.username,
    ownerTeamId: owner.teamId,
    ownerTeamName: owner.teamName,
    ownerGroup: owner.group,
    taskId: "guangyang-island",
    recordState: "submitted",
    score: 10,
    submittedAt: "2026-08-28T01:00:00.000Z",
    savedAt: "2026-08-28T00:59:00.000Z",
    createdAt: "2026-08-28T00:58:00.000Z",
    programCode: "await robot.forward(50);",
    workspaceXml: "<xml></xml>",
    ...overrides
  };
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "competition-cleanup-test-"));
  temporaryRoots.push(root);
  const paths = cleanup.cleanupPaths(root);
  fs.mkdirSync(path.dirname(paths.authPath), { recursive: true });
  fs.mkdirSync(path.dirname(paths.blocklyPath), { recursive: true });
  fs.mkdirSync(paths.pythonSessionsPath, { recursive: true });
  fs.mkdirSync(paths.backupRoot, { recursive: true });

  const admin = {
    id: identifier("usr", "admin"), username: "qwer", role: "admin", teamId: null,
    teamName: null, group: null
  };
  const qa = {
    id: identifier("usr", "qa"), username: "qa_primary_low_fixture", role: "user",
    teamId: identifier("tea", "qa"), teamName: "QA队", group: "primary"
  };
  const participant = {
    id: identifier("usr", "participant"), username: "participant", role: "user",
    teamId: identifier("tea", "participant"), teamName: "正式队", group: "junior"
  };
  const users = [admin, qa, participant];
  const teams = [qa, participant].map(user => ({
    id: user.teamId, teamName: user.teamName, teamNameKey: user.teamName.toLowerCase(),
    inviteCode: user.id.slice(-8).toUpperCase(), createdAt: "2026-08-28T00:00:00.000Z"
  }));
  const auth = {
    schemaVersion: "chenlong.auth-store/v6", revision: 1,
    users, teams, sessions: users.map(user => ({
      id: identifier("ses", user.username), userId: user.id, tokenHash: "0".repeat(64),
      createdAt: "2026-08-28T00:00:00.000Z", expiresAt: "2026-08-29T00:00:00.000Z"
    }))
  };
  fs.writeFileSync(paths.authPath, `${JSON.stringify(auth, null, 2)}\n`);

  const store = new BlocklyRecordStore({ dataDir: path.dirname(paths.blocklyPath) });
  const qaRecord = record(identifier("run", "qa-record"), qa);
  const adminRecord = record(identifier("run", "admin-record"), admin, {
    submittedAt: "2026-08-20T01:00:00.000Z",
    programCode: "// 统一平台联调验收记录（非参赛程序）"
  });
  const oldRecord = record(identifier("run", "old-record"), participant, {
    submittedAt: "2026-08-20T01:00:00.000Z"
  });
  const currentRecord = record(identifier("run", "current-record"), participant);
  for (const value of [qaRecord, adminRecord, oldRecord, currentRecord]) store.insert(value);
  const descriptor = { ...store.descriptor(), legacyRecordCount: 4 };
  store.close();
  const blockly = {
    schemaVersion: "chenlong.blockly-primary-store/v7",
    users, teams, sessions: [], mapConfigs: {}, recordStorage: descriptor
  };
  fs.writeFileSync(paths.blocklyPath, `${JSON.stringify(blockly, null, 2)}\n`);

  const sessions = {
    qa: {
      ownerUserId: qa.id, ownerUsername: qa.username, teamId: qa.id,
      createdAt: "2026-08-28T00:00:00.000Z"
    },
    submittedToday: {
      ownerUserId: participant.id, ownerUsername: participant.username, teamId: participant.id,
      createdAt: "2026-08-20T00:00:00.000Z", submittedAt: "2026-08-28T02:00:00.000Z"
    },
    savedOld: {
      ownerUserId: participant.id, ownerUsername: participant.username, teamId: participant.id,
      createdAt: "2026-08-20T00:00:00.000Z", savedAt: "2026-08-21T02:00:00.000Z"
    },
    admin: {
      ownerUserId: admin.id, ownerUsername: admin.username,
      createdAt: "2026-08-20T00:00:00.000Z"
    }
  };
  for (const [name, value] of Object.entries(sessions)) {
    const directory = path.join(paths.pythonSessionsPath, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "session.json"), `${JSON.stringify(value)}\n`);
  }
  return { root, paths, admin, qa, participant, qaRecord, adminRecord, oldRecord, currentRecord };
}

function sqliteRecordIds(paths) {
  const store = new BlocklyRecordStore({ dataDir: path.dirname(paths.blocklyPath) });
  try { return store.all().map(item => item.id).sort(); } finally { store.close(); }
}

test.afterEach(() => {
  while (temporaryRoots.length) fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

test("SQLite cleanup removes QA and old participant data, preserves admin data, and creates a full backup", () => {
  const fixture = createFixture();
  const plan = cleanup.collectCleanupPlan({
    paths: fixture.paths, beforeDate: "2026-08-28", includeAdmin: false
  });
  assert.deepEqual(cleanup.summary(plan), {
    authUsers: 1,
    blocklyUsers: 1,
    authTeams: 1,
    blocklyTeams: 1,
    authSessions: 1,
    blocklySessions: 0,
    blocklyJsonRecords: 0,
    blocklySqliteRecords: 2,
    blocklyRecords: 2,
    pythonSessions: 2
  });
  const archive = path.join(fixture.paths.backupRoot, "cleanup-one");
  cleanup.applyCleanup(plan, archive);

  const auth = JSON.parse(fs.readFileSync(fixture.paths.authPath, "utf8"));
  const blockly = JSON.parse(fs.readFileSync(fixture.paths.blocklyPath, "utf8"));
  assert.deepEqual(auth.users.map(user => user.username).sort(), ["participant", "qwer"]);
  assert.equal(blockly.recordStorage.legacyRecordCount, 2);
  assert.deepEqual(sqliteRecordIds(fixture.paths), [fixture.adminRecord.id, fixture.currentRecord.id].sort());
  assert.equal(fs.existsSync(path.join(fixture.paths.pythonSessionsPath, "qa")), false);
  assert.equal(fs.existsSync(path.join(fixture.paths.pythonSessionsPath, "savedOld")), false);
  assert.equal(fs.existsSync(path.join(fixture.paths.pythonSessionsPath, "submittedToday")), true);
  assert.equal(fs.existsSync(path.join(fixture.paths.pythonSessionsPath, "admin")), true);
  assert.equal(fs.existsSync(path.join(archive, "full-backup", "blockly", cleanup.BLOCKLY_DATABASE_FILE)), true);
  assert.equal(fs.existsSync(path.join(archive, "full-backup", "car-python", "sessions", "qa", "session.json")), true);
  assert.equal(fs.existsSync(path.join(archive, "cleanup-result.json")), true);
});

test("--include-admin makes explicitly marked admin records and admin Python sessions removable", () => {
  const fixture = createFixture();
  const plan = cleanup.collectCleanupPlan({ paths: fixture.paths, includeAdmin: true });
  assert.ok(plan.removedBlocklySqliteRecords.some(item => item.record.id === fixture.adminRecord.id));
  assert.ok(plan.pythonSessionDirectories.some(directory => path.basename(directory) === "admin"));
  const archive = path.join(fixture.paths.backupRoot, "cleanup-admin");
  cleanup.applyCleanup(plan, archive);
  assert.equal(sqliteRecordIds(fixture.paths).includes(fixture.adminRecord.id), false);
  assert.equal(fs.existsSync(path.join(fixture.paths.pythonSessionsPath, "admin")), false);
});

test("non-empty archives and stale plans are rejected before formal data changes", () => {
  const fixture = createFixture();
  const plan = cleanup.collectCleanupPlan({ paths: fixture.paths });
  const authBefore = fs.readFileSync(fixture.paths.authPath);
  const recordsBefore = sqliteRecordIds(fixture.paths);
  const archive = path.join(fixture.paths.backupRoot, "not-empty");
  fs.mkdirSync(archive);
  fs.writeFileSync(path.join(archive, "existing.txt"), "keep");
  assert.throws(() => cleanup.applyCleanup(plan, archive), /new or empty/u);
  assert.deepEqual(fs.readFileSync(fixture.paths.authPath), authBefore);
  assert.deepEqual(sqliteRecordIds(fixture.paths), recordsBefore);

  const staleArchive = path.join(fixture.paths.backupRoot, "stale");
  const auth = JSON.parse(authBefore.toString("utf8"));
  auth.revision += 1;
  fs.writeFileSync(fixture.paths.authPath, `${JSON.stringify(auth, null, 2)}\n`);
  assert.throws(() => cleanup.applyCleanup(plan, staleArchive), /changed after planning/u);
  assert.equal(fs.existsSync(staleArchive), false);
});

test("legacy JSON record stores remain supported without creating a SQLite database", () => {
  const fixture = createFixture();
  fs.rmSync(fixture.paths.blocklyDatabasePath, { force: true });
  const blockly = JSON.parse(fs.readFileSync(fixture.paths.blocklyPath, "utf8"));
  delete blockly.recordStorage;
  blockly.schemaVersion = "chenlong.blockly-primary-store/v6";
  blockly.records = [fixture.qaRecord, fixture.adminRecord, fixture.currentRecord];
  fs.writeFileSync(fixture.paths.blocklyPath, `${JSON.stringify(blockly, null, 2)}\n`);
  const plan = cleanup.collectCleanupPlan({ paths: fixture.paths });
  assert.equal(plan.removedBlocklyJsonRecords.length, 1);
  const archive = path.join(fixture.paths.backupRoot, "legacy");
  cleanup.applyCleanup(plan, archive);
  const cleaned = JSON.parse(fs.readFileSync(fixture.paths.blocklyPath, "utf8"));
  assert.deepEqual(cleaned.records.map(item => item.id).sort(), [fixture.adminRecord.id, fixture.currentRecord.id].sort());
  assert.equal(fs.existsSync(fixture.paths.blocklyDatabasePath), false);
});

test("CLI parsing keeps administrator cleanup opt-in", () => {
  assert.equal(cleanup.parseArguments([]).includeAdmin, false);
  assert.equal(cleanup.parseArguments(["--include-admin"]).includeAdmin, true);
  assert.throws(() => cleanup.parseArguments(["--apply", "--archive", "--before"]), /archive requires/u);
  assert.throws(() => cleanup.parseArguments(["--before"]), /before requires/u);
});
