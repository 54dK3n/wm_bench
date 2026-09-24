"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AuthStore } = require("../backend/auth-store.js");

const PASSWORD = "official-sso-auth-test-123";

async function temporaryRoot(t) {
  const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chenlong-sso-auth-"));
  t.after(() => fs.promises.rm(rootDir, { recursive: true, force: true }));
  return rootDir;
}

test("external SSO identities are passwordless, private in public profiles, and durable", async t => {
  const rootDir = await temporaryRoot(t);
  const store = new AuthStore({ rootDir });
  await store.register({ username: "sso_admin", password: PASSWORD, teamName: "管理队", group: "primary" });
  const login = await store.loginExternalIdentity({
    officialUserId: "official-user-1",
    officialTeamId: "official-team-1",
    group: "junior",
    teamName: "官网一队"
  });
  assert.equal(login.user.teamName, "官网一队");
  assert.ok(login.token);
  assert.equal("officialUserId" in login.user, false);

  const publicProfile = (await store.listPublicUsers()).find(user => user.id === login.user.id);
  assert.equal("officialUserId" in publicProfile, false);
  const adminProfile = (await store.listAdminUsers()).find(user => user.id === login.user.id);
  assert.equal(adminProfile.officialUserId, "official-user-1");
  assert.equal(adminProfile.officialTeamId, "official-team-1");

  const persisted = JSON.parse(await fs.promises.readFile(path.join(rootDir, "auth-store.json"), "utf8"));
  const stored = persisted.users.find(user => user.id === login.user.id);
  assert.equal("passwordHash" in stored, false);
  const reloaded = new AuthStore({ rootDir });
  await reloaded.ready;
  assert.equal((await reloaded.authenticate(login.token)).user.id, login.user.id);
  await assert.rejects(
    reloaded.login({ username: stored.username, password: PASSWORD }),
    error => error?.code === "INVALID_CREDENTIALS"
  );
});

test("external SSO updates its owned mapping and cannot claim local identities", async t => {
  const rootDir = await temporaryRoot(t);
  let store = new AuthStore({ rootDir });
  await assert.rejects(
    store.loginExternalIdentity({ officialUserId: "u0", officialTeamId: "t0", group: "high", teamName: "未初始化" }),
    error => error?.code === "EXTERNAL_ADMIN_REQUIRED"
  );
  await store.register({ username: "local_admin", password: PASSWORD, teamName: "管理队", group: "primary" });
  const localUser = await store.register({ username: "local_user", password: PASSWORD, teamName: "本地队", group: "primary" });
  const sameNamedExternal = await store.loginExternalIdentity({
    officialUserId: "external-local-name", officialTeamId: "external-local-team", group: "high", teamName: "本地队"
  });
  assert.equal(sameNamedExternal.user.teamName, "本地队");
  const sameNamedOfficial = await store.loginExternalIdentity({
    officialUserId: "external-duplicate-name", officialTeamId: "external-duplicate-team", group: "junior", teamName: "本地队"
  });
  const persistedTeams = JSON.parse(await fs.promises.readFile(path.join(rootDir, "auth-store.json"), "utf8"));
  const localTeamId = persistedTeams.users.find(user => user.username === "local_user").teamId;
  const firstOfficialTeamId = persistedTeams.users.find(user => user.officialUserId === "external-local-name").teamId;
  const secondOfficialTeamId = persistedTeams.users.find(user => user.officialUserId === "external-duplicate-name").teamId;
  assert.notEqual(firstOfficialTeamId, localTeamId,
    "official teams remain distinct even when their display names match a local team");
  assert.notEqual(secondOfficialTeamId, firstOfficialTeamId,
    "different official team IDs must not merge merely because their display names match");
  store = new AuthStore({ rootDir });
  await store.ready;
  const first = await store.loginExternalIdentity({
    officialUserId: "u1", officialTeamId: "t1", group: "junior", teamName: "官网队"
  });
  const teammate = await store.loginExternalIdentity({
    officialUserId: "u2", officialTeamId: "t1", group: "junior", teamName: "官网队"
  });
  const second = await store.loginExternalIdentity({
    officialUserId: "u1", officialTeamId: "t1", group: "high", teamName: "官网队（新）"
  });
  assert.equal(second.user.id, first.user.id);
  assert.equal(second.user.group, "high");
  assert.equal(second.user.teamName, "官网队（新）");
  assert.equal((await store.listAdminUsers()).filter(user => user.officialUserId === "u1").length, 1);
  const synchronizedTeammate = (await store.listAdminUsers()).find(user => user.id === teammate.user.id);
  assert.equal(synchronizedTeammate.group, "high");
  assert.equal(synchronizedTeammate.teamName, "官网队（新）");
  await assert.rejects(
    store.loginExternalIdentity({ officialUserId: "u1", officialTeamId: "t2", group: "primary_high", teamName: "转入队" }),
    error => error?.code === "OFFICIAL_TEAM_REASSIGNMENT_REQUIRES_ADMIN"
  );
  const stillBound = (await store.listAdminUsers()).find(user => user.id === first.user.id);
  assert.equal(stillBound.officialTeamId, "t1");
  assert.equal(stillBound.teamName, "官网队（新）");
  await assert.rejects(
    store.updateManagedUser(first.user.id, { teamName: "篡改", group: "primary" }),
    error => error?.code === "OFFICIAL_IDENTITY_MANAGED_EXTERNALLY"
  );
});
