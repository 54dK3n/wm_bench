"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  AuthStore,
  LEGACY_BLOCKLY_SCRYPT_N
} = require("../backend/auth-store.js");

test("a migrated Blockly scrypt hash logs in once and upgrades to the Python work factor", async t => {
  const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chenlong-auth-legacy-blockly-"));
  t.after(() => fs.promises.rm(rootDir, { recursive: true, force: true }));
  const password = "1234567890";
  const original = new AuthStore({ rootDir });
  await original.register({
    username: "legacy_blockly",
    password,
    displayName: "旧积木账号",
    teamName: "旧积木队",
    group: "primary",
    teamAction: "create"
  });

  const storePath = path.join(rootDir, "auth-store.json");
  const state = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
  const salt = crypto.randomBytes(16);
  const legacyHash = crypto.scryptSync(password, salt, 32, {
    N: LEGACY_BLOCKLY_SCRYPT_N,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
  state.users[0].passwordHash = {
    algorithm: "scrypt",
    N: LEGACY_BLOCKLY_SCRYPT_N,
    r: 8,
    p: 1,
    keyLength: 32,
    salt: salt.toString("base64url"),
    hash: legacyHash.toString("base64url")
  };
  await fs.promises.writeFile(storePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  const migrated = new AuthStore({ rootDir });
  const result = await migrated.login({ username: "legacy_blockly", password });
  assert.equal(result.user.username, "legacy_blockly");
  const upgraded = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
  assert.equal(upgraded.users[0].passwordHash.N, 32768);
  assert.notEqual(upgraded.users[0].passwordHash.hash, legacyHash.toString("base64url"));
});
