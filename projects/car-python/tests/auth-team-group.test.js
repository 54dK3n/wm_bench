"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AUTH_STORE_SCHEMA_VERSION, AuthStore } = require("../backend/auth-store.js");

const PASSWORD = "team-group-test-123";

test("competition group is team-scoped for invite joins and administrator updates", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-team-group-"));
  try {
    const store = new AuthStore({ rootDir });
    await store.register({
      username: "group_admin",
      password: PASSWORD,
      teamName: "管理占位队",
      group: "primary",
      teamAction: "create"
    });
    const leader = await store.register({
      username: "group_leader",
      password: PASSWORD,
      teamName: "统一组别队",
      group: "junior",
      teamAction: "create"
    });
    const invite = await store.getTeamInviteForUser(leader.user.id);
    const member = await store.register({
      username: "group_member",
      password: PASSWORD,
      group: "high",
      teamAction: "join",
      inviteCode: invite.inviteCode
    });
    assert.equal(member.user.group, "junior");

    await store.updateManagedUser(leader.user.id, {
      teamName: "统一组别队",
      group: "high"
    });
    const users = await store.listPublicUsers();
    assert.equal(users.find(user => user.id === leader.user.id).group, "high");
    assert.equal(users.find(user => user.id === member.user.id).group, "high");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v4 stores safely canonicalize legacy and Chinese group values without changing team identity", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-four-group-migration-"));
  try {
    const original = new AuthStore({ rootDir });
    await original.register({ username: "legacy_admin", password: PASSWORD, teamName: "旧管理队", group: "primary" });
    await original.register({ username: "legacy_low", password: PASSWORD, teamName: "旧小学队", group: "primary" });
    await original.register({ username: "legacy_high_primary", password: PASSWORD, teamName: "旧小学高段队", group: "primary" });
    await original.register({ username: "legacy_junior", password: PASSWORD, teamName: "旧初中队", group: "junior" });
    await original.register({ username: "legacy_high", password: PASSWORD, teamName: "旧高中队", group: "high" });

    const filePath = path.join(rootDir, "auth-store.json");
    const before = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    before.schemaVersion = "chenlong.auth-store/v4";
    const aliases = {
      legacy_admin: "小学组",
      legacy_low: "primary_school",
      legacy_high_primary: "小学组（4-6年级）",
      legacy_junior: "middle_school",
      legacy_high: "high_school"
    };
    before.users.forEach(user => { user.group = aliases[user.username]; });
    await fs.promises.writeFile(filePath, `${JSON.stringify(before, null, 2)}\n`, "utf8");

    const migrated = new AuthStore({ rootDir });
    await migrated.ready;
    const state = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    assert.equal(state.schemaVersion, AUTH_STORE_SCHEMA_VERSION);
    assert.equal(state.revision, before.revision + 1);
    assert.deepEqual(Object.fromEntries(state.users.map(user => [user.username, user.group])), {
      legacy_admin: "primary",
      legacy_low: "primary",
      legacy_high_primary: "primary",
      legacy_junior: "junior",
      legacy_high: "high"
    });
    assert.deepEqual(state.users.map(user => user.teamId), before.users.map(user => user.teamId));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("v5 four-group stores atomically merge low and high elementary members into one primary team group", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-three-group-migration-"));
  try {
    const original = new AuthStore({ rootDir });
    await original.register({
      username: "merge_admin",
      password: PASSWORD,
      teamName: "合并管理队",
      group: "primary"
    });
    const leader = await original.register({
      username: "merge_leader",
      password: PASSWORD,
      teamName: "小学合并队",
      group: "primary"
    });
    const invite = await original.getTeamInviteForUser(leader.user.id);
    const member = await original.register({
      username: "merge_member",
      password: PASSWORD,
      group: "primary",
      teamAction: "join",
      inviteCode: invite.inviteCode
    });

    const filePath = path.join(rootDir, "auth-store.json");
    const before = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    before.schemaVersion = "chenlong.auth-store/v5";
    before.users.find(user => user.id === leader.user.id).group = "primary_low";
    before.users.find(user => user.id === member.user.id).group = "primary_high";
    await fs.promises.writeFile(filePath, `${JSON.stringify(before, null, 2)}\n`, "utf8");

    const migrated = new AuthStore({ rootDir });
    await migrated.ready;
    const state = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    assert.equal(state.schemaVersion, AUTH_STORE_SCHEMA_VERSION);
    assert.equal(state.revision, before.revision + 1);
    assert.equal(state.users.find(user => user.id === leader.user.id).group, "primary");
    assert.equal(state.users.find(user => user.id === member.user.id).group, "primary");
    assert.equal(state.users.find(user => user.id === leader.user.id).teamId,
      state.users.find(user => user.id === member.user.id).teamId);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("stored teams with conflicting member groups fail closed and identify every conflicting member", async () => {
  for (const schemaVersion of ["chenlong.auth-store/v4", "chenlong.auth-store/v5", AUTH_STORE_SCHEMA_VERSION]) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-team-group-conflict-"));
    try {
      const original = new AuthStore({ rootDir });
      await original.register({
        username: `conflict_admin_${schemaVersion.at(-1)}`,
        password: PASSWORD,
        teamName: `冲突管理队${schemaVersion.at(-1)}`,
        group: "primary"
      });
      const leader = await original.register({
        username: `conflict_leader_${schemaVersion.at(-1)}`,
        password: PASSWORD,
        teamName: `冲突参赛队${schemaVersion.at(-1)}`,
        group: "primary"
      });
      const invite = await original.getTeamInviteForUser(leader.user.id);
      const member = await original.register({
        username: `conflict_member_${schemaVersion.at(-1)}`,
        password: PASSWORD,
        group: "primary",
        teamAction: "join",
        inviteCode: invite.inviteCode
      });
      const filePath = path.join(rootDir, "auth-store.json");
      const persisted = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
      persisted.schemaVersion = schemaVersion;
      persisted.users.find(user => user.id === member.user.id).group = "junior";
      const conflictedText = `${JSON.stringify(persisted, null, 2)}\n`;
      await fs.promises.writeFile(filePath, conflictedText, "utf8");

      const conflicted = new AuthStore({ rootDir });
      await assert.rejects(conflicted.ready, error => {
        assert.equal(error?.code, "AUTH_STORE_TEAM_GROUP_CONFLICT");
        assert.match(error.message, new RegExp(`冲突参赛队${schemaVersion.at(-1)}`));
        assert.match(error.message, new RegExp(`conflict_leader_${schemaVersion.at(-1)}:primary`));
        assert.match(error.message, new RegExp(`conflict_member_${schemaVersion.at(-1)}:junior`));
        return true;
      });
      assert.equal(await fs.promises.readFile(filePath, "utf8"), conflictedText,
        "a rejected migration must not rewrite the conflicting store");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
});
