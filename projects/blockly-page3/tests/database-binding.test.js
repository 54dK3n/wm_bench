"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const {
  BlocklyRecordStore,
  DATABASE_FILE_NAME,
  DATABASE_ID_PATTERN
} = require("../blockly-record-store.js");

const root = path.resolve(__dirname, "..");
const CORE_SCHEMA_VERSION = "chenlong.blockly-primary-store/v8";

function sampleRecord(index, ownerSuffix = 1) {
  const createdAt = new Date(Date.parse("2026-08-28T00:00:00.000Z") + index * 1_000).toISOString();
  return {
    id: `run_${index.toString(16).padStart(32, "0")}`,
    ownerUserId: `usr_${ownerSuffix.toString(16).padStart(32, "0")}`,
    ownerUsername: `binding_${ownerSuffix}`,
    ownerDisplayName: `绑定用户${ownerSuffix}`,
    ownerTeamId: `tea_${ownerSuffix.toString(16).padStart(32, "0")}`,
    ownerTeamName: `绑定队伍${ownerSuffix}`,
    ownerGroup: "primary_low",
    taskId: `GYI-PRIMARY-0${(index % 3) + 1}`,
    taskName: `广阳岛综合任务${(index % 3) + 1}`,
    score: 50 + index,
    recordState: "saved",
    savedAt: createdAt,
    submittedAt: null,
    createdAt,
    programCode: `await robot.forward(${index + 1})`,
    workspaceXml: JSON.stringify({ index, ownerSuffix }),
    executionTrace: []
  };
}

function writeCore(dataDir, recordStorage) {
  const core = {
    schemaVersion: CORE_SCHEMA_VERSION,
    users: [],
    teams: [],
    sessions: [],
    mapConfigs: {},
    recordStorage,
    defaultAdminConfigured: true
  };
  fs.writeFileSync(path.join(dataDir, "primary-blockly-store.json"), `${JSON.stringify(core, null, 2)}\n`);
  return core;
}

function createFixture(dataDir, recordCount = 2, ownerSuffix = 1) {
  fs.mkdirSync(dataDir, { recursive: true });
  const store = new BlocklyRecordStore({ dataDir });
  try {
    for (let index = 1; index <= recordCount; index += 1) {
      store.insert(sampleRecord(index, ownerSuffix));
    }
    const descriptor = store.descriptor();
    writeCore(dataDir, descriptor);
    return descriptor;
  } finally {
    store.close();
  }
}

function launch(dataDir) {
  return childProcess.spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      BLOCKLY_DATA_DIR: dataDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function waitForOutcome(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Blockly 数据库绑定测试启动超时：${output}`));
    }, 10_000);
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...value, output });
    };
    child.stdout.on("data", chunk => {
      output += String(chunk);
      if (output.includes('"status":"listening"')) finish({ kind: "listening" });
    });
    child.stderr.on("data", chunk => { output += String(chunk); });
    child.once("exit", (code, signal) => finish({ kind: "exit", code, signal }));
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_error) {}
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function expectStarts(dataDir) {
  const child = launch(dataDir);
  const outcome = await waitForOutcome(child);
  try {
    assert.equal(outcome.kind, "listening", outcome.output);
  } finally {
    await stopChild(child);
  }
}

async function expectRejected(dataDir, pattern) {
  const child = launch(dataDir);
  const outcome = await waitForOutcome(child);
  if (outcome.kind === "listening") await stopChild(child);
  assert.equal(outcome.kind, "exit", `被替换的记录数据库不应启动：${outcome.output}`);
  assert.notEqual(outcome.code, 0);
  assert.match(outcome.output, pattern);
}

test("bound database identity survives normal restarts", { timeout: 30_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-database-binding-normal-"));
  try {
    const descriptor = createFixture(dataDir);
    assert.match(descriptor.databaseId, DATABASE_ID_PATTERN);
    await expectStarts(dataDir);
    await expectStarts(dataDir);
    const core = JSON.parse(fs.readFileSync(path.join(dataDir, "primary-blockly-store.json"), "utf8"));
    assert.equal(core.recordStorage.databaseId, descriptor.databaseId);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an old unbound v8 core safely binds its existing database once", { timeout: 30_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-database-binding-upgrade-"));
  try {
    createFixture(dataDir);
    const corePath = path.join(dataDir, "primary-blockly-store.json");
    const core = JSON.parse(fs.readFileSync(corePath, "utf8"));
    delete core.recordStorage.databaseId;
    fs.writeFileSync(corePath, `${JSON.stringify(core, null, 2)}\n`);
    const databasePath = path.join(dataDir, DATABASE_FILE_NAME);
    const database = new DatabaseSync(databasePath);
    database.prepare("DELETE FROM metadata WHERE key = 'databaseId'").run();
    database.close();

    await expectStarts(dataDir);
    const upgraded = JSON.parse(fs.readFileSync(corePath, "utf8"));
    assert.match(upgraded.recordStorage.databaseId, DATABASE_ID_PATTERN);
    const upgradedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    const identity = upgradedDatabase.prepare(
      "SELECT value FROM metadata WHERE key = 'databaseId' LIMIT 1"
    ).get().value;
    upgradedDatabase.close();
    assert.equal(upgraded.recordStorage.databaseId, identity);
    await expectStarts(dataDir);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("deleting or replacing a bound database fails closed regardless of record count", { timeout: 30_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-database-binding-tamper-"));
  try {
    const deletedDir = path.join(base, "deleted");
    createFixture(deletedDir);
    fs.unlinkSync(path.join(deletedDir, DATABASE_FILE_NAME));
    await expectRejected(deletedDir, /记录数据库缺失/);

    const emptyDir = path.join(base, "empty-target");
    const emptyReplacementDir = path.join(base, "empty-replacement");
    createFixture(emptyDir);
    createFixture(emptyReplacementDir, 0, 2);
    fs.copyFileSync(
      path.join(emptyReplacementDir, DATABASE_FILE_NAME),
      path.join(emptyDir, DATABASE_FILE_NAME)
    );
    await expectRejected(emptyDir, /数据库身份与核心文件不匹配/);

    const equalDir = path.join(base, "equal-target");
    const equalReplacementDir = path.join(base, "equal-replacement");
    createFixture(equalDir, 2, 3);
    createFixture(equalReplacementDir, 2, 4);
    fs.copyFileSync(
      path.join(equalReplacementDir, DATABASE_FILE_NAME),
      path.join(equalDir, DATABASE_FILE_NAME)
    );
    await expectRejected(equalDir, /数据库身份与核心文件不匹配/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
