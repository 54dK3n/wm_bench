"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const contract = require(path.join(root, "..", "..", "packages", "platform-contract.js"));
const mapRules = require("../guangyang-map-config.js");
const secret = "blockly-store-capacity-secret-1234567890";

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

function canonicalDigest(value) {
  return crypto.createHash("sha256").update(contract.canonicalJson(value), "utf8").digest("hex");
}

function taskMaps() {
  return Object.keys(mapRules.TASKS).map((taskId, index) => {
    const local = mapRules.defaultLayout(taskId);
    const layout = {
      schemaVersion: "chenlong.guangyang-map-layout/v2",
      checkpoints: local.checkpoints,
      targets: local.targets,
      storage: local.storage,
      distractors: local.distractors,
      obstacles: local.obstacles
    };
    return {
      taskId,
      sourceTaskId: `R2-GYI-MVP-0${index + 1}`,
      variantId: `map-0${index + 1}`,
      revision: 0,
      digest: canonicalDigest(layout),
      updatedAt: null,
      layout
    };
  });
}

function recordBody(map, index) {
  return {
    taskId: map.taskId,
    mapRevision: map.revision,
    mapDigest: map.digest,
    completed: true,
    checkpointCount: 4,
    targetDeliveredCount: 1,
    distractorClearedCount: 1,
    failedObstacleCount: 0,
    goalReached: true,
    blockedMoves: 0,
    offRoadEpisodes: 0,
    offRoadDurationMs: 0,
    durationMs: 10_000 + index,
    programCode: "await robot.forward(50)",
    workspaceXml: JSON.stringify({ blocks: [{ type: "robot_forward_cm" }] }),
    executionTrace: ["mission", "road_state"]
  };
}

test("500 simultaneous platform saves and submissions are durably batched below the gateway timeout", { timeout: 30_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-capacity-"));
  const port = 43000 + Math.floor(Math.random() * 9000);
  const origin = `http://127.0.0.1:${port}`;
  const child = childProcess.spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      BLOCKLY_PUBLIC_ORIGIN: origin,
      BLOCKLY_DATA_DIR: dataDir,
      BLOCKLY_STORE_WRITE_BATCH_MS: "25",
      PLATFORM_SSO_SECRET: secret
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForListening(child);
    const maps = taskMaps();
    const map = maps[0];
    const mapHeader = contract.signMapBundle(secret, maps);
    const users = Array.from({ length: 500 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(32, "0");
      const user = {
        id: `usr_${suffix}`,
        username: `capacity_${index + 1}`,
        displayName: `容量用户${index + 1}`,
        role: "user",
        teamId: `tea_${suffix}`,
        teamName: `容量队伍${index + 1}`,
        group: "primary_low",
        createdAt: "2026-08-28T00:00:00.000Z"
      };
      return { user, principal: contract.signPrincipal(secret, "blockly", user) };
    });
    const request = async (route, principal, body) => {
      const response = await fetch(`${origin}${route}`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          [contract.PRINCIPAL_HEADER]: principal,
          [contract.MAP_BUNDLE_HEADER]: mapHeader
        },
        body: JSON.stringify(body)
      });
      return { status: response.status, payload: await response.json().catch(() => null) };
    };

    const startedAt = Date.now();
    const saved = await Promise.all(users.map((entry, index) => request("/api/records", entry.principal, recordBody(map, index))));
    assert.ok(saved.every(result => result.status === 201), JSON.stringify(saved.find(result => result.status !== 201)));
    const recordIds = saved.map(result => result.payload.record.id);
    assert.equal(new Set(recordIds).size, 500);

    const submitted = await Promise.all(users.map((entry, index) => request(`/api/records/${recordIds[index]}/submit`, entry.principal, {})));
    assert.ok(submitted.every(result => result.status === 200), JSON.stringify(submitted.find(result => result.status !== 200)));
    assert.ok(Date.now() - startedAt < 15_000, "500人保存并提交必须在统一网关15秒截止前完成");

    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "primary-blockly-store.json"), "utf8"));
    assert.equal(persisted.schemaVersion, "chenlong.blockly-primary-store/v8");
    assert.equal(Object.hasOwn(persisted, "records"), false);
    const recordDatabase = new DatabaseSync(path.join(dataDir, persisted.recordStorage.databaseFile), { readOnly: true });
    const counts = recordDatabase.prepare(`
      SELECT COUNT(*) AS total, COUNT(DISTINCT id) AS unique_ids,
        SUM(CASE WHEN record_state = 'submitted' THEN 1 ELSE 0 END) AS submitted
      FROM records
    `).get();
    recordDatabase.close();
    assert.deepEqual({ total: Number(counts.total), uniqueIds: Number(counts.unique_ids), submitted: Number(counts.submitted) }, {
      total: 500,
      uniqueIds: 500,
      submitted: 500
    });
  } finally {
    child.kill();
    await new Promise(resolve => child.once("exit", resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
