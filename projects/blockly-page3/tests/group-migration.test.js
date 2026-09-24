"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BlocklyRecordStore } = require("../blockly-record-store.js");

const root = path.resolve(__dirname, "..");
const contract = require(path.join(root, "..", "..", "packages", "platform-contract.js"));
const secret = "blockly-three-group-migration-secret-1234567890";
const administrator = Object.freeze({
  id: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  username: "migration_admin",
  displayName: "迁移管理员",
  role: "admin",
  teamId: null,
  teamName: null,
  group: null,
  createdAt: "2026-08-28T00:00:00.000Z"
});

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`测试服务启动超时：${output}`)), 10_000);
    child.stdout.on("data", chunk => {
      output += String(chunk);
      if (output.includes('"status":"listening"')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", chunk => { output += String(chunk); });
    child.once("exit", code => {
      clearTimeout(timer);
      reject(new Error(`测试服务提前退出（${code}）：${output}`));
    });
  });
}

test("v8 core users and SQLite record snapshots migrate both old primary groups to primary", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-v8-group-migration-"));
  const database = new BlocklyRecordStore({ dataDir });
  const createdAt = "2026-08-28T00:00:00.000Z";
  const teamId = "tea_11111111111111111111111111111111";
  const recordId = "run_11111111111111111111111111111111";
  try {
    database.insert({
      id: recordId,
      ownerUserId: "usr_11111111111111111111111111111111",
      ownerUsername: "legacy_low",
      ownerDisplayName: "旧小学用户",
      ownerTeamId: teamId,
      ownerTeamName: "旧小学队",
      ownerGroup: "primary_high",
      taskId: "GYI-PRIMARY-01",
      taskName: "广阳岛综合任务1",
      score: 88,
      completed: true,
      checkpointCount: 4,
      checkpointTotal: 4,
      recordState: "submitted",
      savedAt: createdAt,
      submittedAt: createdAt,
      createdAt,
      programCode: "await robot.forward(50)",
      workspaceXml: "{}",
      executionTrace: []
    });
    const descriptor = database.descriptor();
    database.close();
    fs.writeFileSync(path.join(dataDir, "primary-blockly-store.json"), `${JSON.stringify({
      schemaVersion: "chenlong.blockly-primary-store/v8",
      users: [
        {
          id: "usr_11111111111111111111111111111111", username: "legacy_low", displayName: "旧低年级",
          teamId, group: "primary_low", role: "user", createdAt
        },
        {
          id: "usr_22222222222222222222222222222222", username: "legacy_high", displayName: "旧高年级",
          teamId, group: "primary_high", role: "user", createdAt
        }
      ],
      teams: [{ id: teamId, teamName: "旧小学队", teamNameKey: "旧小学队", inviteCode: "ABCDEFGH", createdAt }],
      sessions: [],
      mapConfigs: {},
      recordStorage: descriptor
    }, null, 2)}\n`, "utf8");

    const port = 46000 + Math.floor(Math.random() * 3_000);
    const origin = `http://127.0.0.1:${port}`;
    const child = childProcess.spawn(process.execPath, [path.join(root, "server.js")], {
      cwd: root,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        BLOCKLY_PUBLIC_ORIGIN: origin,
        BLOCKLY_DATA_DIR: dataDir,
        PLATFORM_SSO_SECRET: secret
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    try {
      await waitForListening(child);
      const principal = contract.signPrincipal(secret, "blockly", administrator);
      const headers = { [contract.PRINCIPAL_HEADER]: principal };
      const usersResponse = await fetch(`${origin}/api/admin/users`, { headers });
      const usersPayload = await usersResponse.json();
      assert.equal(usersResponse.status, 200);
      assert.deepEqual(usersPayload.users.filter(user => user.role === "user").map(user => user.group),
        ["primary", "primary"]);
      const recordsResponse = await fetch(`${origin}/api/admin/records`, { headers });
      const recordsPayload = await recordsResponse.json();
      assert.equal(recordsResponse.status, 200);
      assert.equal(recordsPayload.records[0].user.group, "primary");
    } finally {
      child.kill();
      await new Promise(resolve => child.once("exit", resolve));
    }

    const migratedCore = JSON.parse(fs.readFileSync(path.join(dataDir, "primary-blockly-store.json"), "utf8"));
    assert.deepEqual(migratedCore.users.map(user => user.group), ["primary", "primary"]);
    const migratedDatabase = new BlocklyRecordStore({ dataDir });
    try {
      assert.equal(migratedDatabase.findById(recordId).ownerGroup, "primary");
    } finally {
      migratedDatabase.close();
    }
  } finally {
    try { database.close(); } catch (_error) {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
