"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { DEFAULT_PATHS, PROJECTS_ROOT, collectMigration } = require("../tools/migrate-legacy-data.js");

test("migration defaults follow the integrated platform directory layout", () => {
  const platformRoot = path.resolve(__dirname, "..");
  assert.equal(PROJECTS_ROOT, path.join(platformRoot, "projects"));
  assert.equal(DEFAULT_PATHS.pythonAuth,
    path.join(PROJECTS_ROOT, "car-python", ".runtime", "auth", "auth-store.json"));
  assert.equal(DEFAULT_PATHS.blocklyStore,
    path.join(PROJECTS_ROOT, "blockly-page3", ".blockly-data", "primary-blockly-store.json"));
  assert.equal(DEFAULT_PATHS.workshopRoot, path.join(PROJECTS_ROOT, "tmm"));
  assert.equal(DEFAULT_PATHS.backupRoot, path.join(platformRoot, "record-backups"));
});

function passwordHash(N = 32768) {
  return { algorithm: "scrypt", N, r: 8, p: 1, keyLength: 32, salt: "A".repeat(22), hash: "B".repeat(43) };
}

test("migration keeps Python identity, imports Blockly-only members and maps workshop teams", () => {
  const pythonState = {
    schemaVersion: "chenlong.auth-store/v4",
    revision: 4,
    users: [{
      id: "usr_11111111111111111111111111111111", username: "test1", usernameKey: "test1",
      displayName: "test1", teamId: "tea_11111111111111111111111111111111", teamName: "测试队",
      group: "primary_school", role: "user", passwordHash: passwordHash(), createdAt: "2026-08-01T00:00:00.000Z"
    }],
    teams: [{
      id: "tea_11111111111111111111111111111111", teamName: "测试队", teamNameKey: "测试队",
      inviteCode: "ABCDEFGH", createdAt: "2026-08-01T00:00:00.000Z"
    }],
    sessions: [{ id: "ase_11111111111111111111111111111111" }]
  };
  const blocklyState = {
    teams: [
      { id: "tea_22222222222222222222222222222222", teamName: "测试队", inviteCode: "BCDEFGHJ", createdAt: "2026-08-02T00:00:00.000Z" },
      { id: "tea_33333333333333333333333333333333", teamName: "积木队", inviteCode: "CDEFGHJK", createdAt: "2026-08-02T00:00:00.000Z" }
    ],
    users: [
      { id: "usr_22222222222222222222222222222222", username: "test1", displayName: "重复", teamId: "tea_22222222222222222222222222222222", group: "primary_school", role: "user", passwordSalt: "a", passwordHash: "b", createdAt: "2026-08-02T00:00:00.000Z" },
      { id: "usr_33333333333333333333333333333333", username: "block_user", displayName: "积木用户", teamId: "tea_33333333333333333333333333333333", group: "middle_school", role: "user", passwordSalt: "salt", passwordHash: "hash", createdAt: "2026-08-02T00:00:00.000Z" }
    ],
    records: [{ id: "run_1" }]
  };
  const result = collectMigration({
    pythonState,
    blocklyState,
    workshopTeams: [{ id: "old-workshop", team_name: "测试队", created_at: Date.parse("2026-08-03T00:00:00.000Z") }],
    workshopSubmissions: [{ id: "model-1" }],
    now: "2026-08-28T00:00:00.000Z"
  });
  assert.equal(result.state.users.length, 2);
  assert.equal(result.state.schemaVersion, "chenlong.auth-store/v6");
  assert.equal(result.state.teams.length, 2);
  assert.equal(result.state.sessions.length, 0);
  assert.equal(result.state.users.find(user => user.username === "block_user").passwordHash.N, 16384);
  assert.equal(result.mapping.sources.blockly.users["usr_22222222222222222222222222222222"], "usr_11111111111111111111111111111111");
  assert.equal(result.mapping.sources.workshop.teams["old-workshop"], "tea_11111111111111111111111111111111");
  assert.equal(result.mapping.sources.workshop.submissions["model-1"], "model-1");
});

test("migration normalizes every imported member to its canonical team group", () => {
  const pythonState = {
    schemaVersion: "chenlong.auth-store/v4", revision: 1,
    users: [{
      id: "usr_11111111111111111111111111111111", username: "captain", usernameKey: "captain",
      displayName: "队长", teamId: "tea_11111111111111111111111111111111", teamName: "同队",
      group: "middle_school", role: "user", passwordHash: passwordHash(), createdAt: "2026-08-01T00:00:00.000Z"
    }],
    teams: [{ id: "tea_11111111111111111111111111111111", teamName: "同队", teamNameKey: "同队", inviteCode: "ABCDEFGH", createdAt: "2026-08-01T00:00:00.000Z" }],
    sessions: []
  };
  const blocklyState = {
    teams: [{ id: "tea_22222222222222222222222222222222", teamName: "同队", inviteCode: "BCDEFGHJ", createdAt: "2026-08-02T00:00:00.000Z" }],
    users: [{ id: "usr_22222222222222222222222222222222", username: "member", displayName: "队员", teamId: "tea_22222222222222222222222222222222", group: "high_school", role: "user", passwordSalt: "salt", passwordHash: "hash", createdAt: "2026-08-02T00:00:00.000Z" }],
    records: []
  };
  const result = collectMigration({ pythonState, blocklyState, now: "2026-08-28T00:00:00.000Z" });
  assert.equal(result.state.users.find(user => user.username === "member").group, "junior");
  assert.equal(result.mapping.conflicts.at(-1).type, "team-group-normalized");
});

test("workshop link synchronization preserves old submissions under the canonical team identity", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "platform-workshop-link-test-"));
  const databasePath = path.join(temporary, "workshop.sqlite");
  try {
    const script = `
      const assert = require("node:assert/strict");
      const { DatabaseSync } = require("node:sqlite");
      const { syncWorkshopLinks } = require(process.argv[1]);
      const databasePath = process.argv[2];
      let database = new DatabaseSync(databasePath);
      database.exec(\`CREATE TABLE competition_teams (
        id TEXT PRIMARY KEY, team_name TEXT NOT NULL, team_name_key TEXT NOT NULL UNIQUE,
        division TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        latest_submission_id TEXT
      )\`);
      database.prepare("INSERT INTO competition_teams VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("old-workshop-team", "旧队名", "旧队名", "primary", 1, 1, "submission-1");
      database.close();
      const canonicalId = "tea_33333333333333333333333333333333";
      const state = {
        teams: [{ id: canonicalId, teamName: "新队名" }],
        users: [{ role: "user", teamId: canonicalId, group: "high_school" }]
      };
      assert.deepEqual(syncWorkshopLinks(databasePath, { "old-workshop-team": canonicalId }, state, 100), { linked: 1, total: 1 });
      assert.deepEqual(syncWorkshopLinks(databasePath, { "old-workshop-team": canonicalId }, state, 200), { linked: 0, total: 1 });
      database = new DatabaseSync(databasePath, { readOnly: true });
      assert.deepEqual({ ...database.prepare("SELECT platform_team_id, workshop_team_id FROM competition_platform_team_links").get() }, {
        platform_team_id: canonicalId,
        workshop_team_id: "old-workshop-team"
      });
      assert.deepEqual({ ...database.prepare("SELECT team_name, division, latest_submission_id FROM competition_teams WHERE id = ?").get("old-workshop-team") }, {
        team_name: "新队名",
        division: "senior",
        latest_submission_id: "submission-1"
      });
      database.close();
    `;
    const result = spawnSync(process.execPath, ["-e", script, path.resolve(__dirname, "../tools/migrate-legacy-data.js"), databasePath], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
