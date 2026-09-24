"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const ADMIN_USERNAME = "map_flow_admin";
const ADMIN_PASSWORD = "Map-Flow-Admin-12345";

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`测试服务启动超时：${output}`)), 10000);
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

function cookieFrom(response) {
  const value = response.headers.get("set-cookie");
  assert.ok(value);
  return value.split(";", 1)[0];
}

test("admin publishes versioned maps for all tasks and records stay bound to the run map", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-map-flow-"));
  const port = 44000 + Math.floor(Math.random() * 10000);
  const origin = `http://127.0.0.1:${port}`;
  const child = childProcess.spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      BLOCKLY_PUBLIC_ORIGIN: origin,
      BLOCKLY_DATA_DIR: dataDir,
      PLATFORM_SSO_SECRET: "",
      BLOCKLY_ENABLE_LOCAL_AUTH: "true",
      BLOCKLY_BOOTSTRAP_ADMIN_USERNAME: ADMIN_USERNAME,
      BLOCKLY_BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForListening(child);
    const jsonRequest = async (route, { method = "GET", cookie = "", body } = {}) => {
      const response = await fetch(`${origin}${route}`, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body !== undefined ? { Origin: origin, "Content-Type": "application/json" } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { response, payload: await response.json().catch(() => null) };
    };
    const adminLogin = await jsonRequest("/api/auth/login", {
      method: "POST", body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }
    });
    assert.equal(adminLogin.response.status, 200);
    const adminCookie = cookieFrom(adminLogin.response);
    const studentRegister = await jsonRequest("/api/auth/register", {
      method: "POST",
      body: { username: "mapstudent", password: "1234567890", teamAction: "create", teamName: "地图验收队" }
    });
    assert.equal(studentRegister.response.status, 201);
    assert.equal(studentRegister.payload.user.group, "primary", "旧客户端未传小组时默认归入小学组");
    const studentCookie = cookieFrom(studentRegister.response);

    const initial = await jsonRequest("/api/admin/maps", { cookie: adminCookie });
    assert.equal(initial.response.status, 200);
    assert.equal(initial.payload.maps.length, 3);
    const originalTask1 = structuredClone(initial.payload.maps.find(map => map.taskId === "GYI-PRIMARY-01"));

    for (const initialMap of initial.payload.maps) {
      let current = structuredClone(initialMap);
      for (const delta of [0.04, -0.03, 0.02]) {
        const layout = structuredClone(current.layout);
        layout.checkpoints[0][1] = Math.round((layout.checkpoints[0][1] + delta) * 10000) / 10000;
        const saved = await jsonRequest(`/api/admin/maps/${current.taskId}`, {
          method: "PUT", cookie: adminCookie, body: { baseRevision: current.revision, layout }
        });
        assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
        assert.equal(saved.payload.map.revision, current.revision + 1);
        assert.notEqual(saved.payload.map.digest, current.digest);
        current = { ...saved.payload.map, versionCount: current.versionCount + 1 };
      }
    }

    const published = await jsonRequest("/api/maps", { cookie: studentCookie });
    assert.equal(published.response.status, 200);
    assert.equal(published.payload.maps.length, 3);
    published.payload.maps.forEach(map => assert.equal(map.revision, 4));

    const currentTask1 = published.payload.maps.find(map => map.taskId === "GYI-PRIMARY-01");
    const conflict = await jsonRequest("/api/admin/maps/GYI-PRIMARY-01", {
      method: "PUT", cookie: adminCookie,
      body: { baseRevision: originalTask1.revision, layout: currentTask1.layout }
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.payload.error.code, "MAP_REVISION_CONFLICT");

    const invalidLayout = structuredClone(currentTask1.layout);
    invalidLayout.checkpoints[0] = [0, 0];
    const invalid = await jsonRequest("/api/admin/maps/GYI-PRIMARY-01", {
      method: "PUT", cookie: adminCookie,
      body: { baseRevision: currentTask1.revision, layout: invalidLayout }
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.error.code, "INVALID_MAP_CONFIG");

    const oldVersionRecord = await jsonRequest("/api/records", {
      method: "POST", cookie: studentCookie,
      body: {
        taskId: originalTask1.taskId,
        mapRevision: originalTask1.revision,
        mapDigest: originalTask1.digest,
        completed: true,
        checkpointCount: 4,
        targetDeliveredCount: 1,
        distractorClearedCount: 1,
        failedObstacleCount: 0,
        goalReached: true,
        blockedMoves: 0,
        offRoadEpisodes: 0,
        offRoadDurationMs: 0,
        durationMs: 60000,
        programCode: "car.forward(1)",
        workspaceXml: JSON.stringify({ blocks: [{ type: "car_forward" }] }),
        executionTrace: []
      }
    });
    assert.equal(oldVersionRecord.response.status, 201, JSON.stringify(oldVersionRecord.payload));
    assert.equal(oldVersionRecord.payload.record.mapRevision, originalTask1.revision);

    const unknownVersion = await jsonRequest("/api/records", {
      method: "POST", cookie: studentCookie,
      body: {
        taskId: currentTask1.taskId,
        mapRevision: 999,
        mapDigest: "a".repeat(64),
        completed: false,
        checkpointCount: 0,
        targetDeliveredCount: 0,
        distractorClearedCount: 0,
        failedObstacleCount: 0,
        goalReached: false,
        blockedMoves: 0,
        offRoadEpisodes: 0,
        offRoadDurationMs: 0,
        durationMs: 1000,
        programCode: "car.forward(1)",
        workspaceXml: "{}",
        executionTrace: []
      }
    });
    assert.equal(unknownVersion.response.status, 409);
    assert.equal(unknownVersion.payload.error.code, "MAP_VERSION_NOT_FOUND");
  } finally {
    child.kill();
    await new Promise(resolve => child.once("exit", resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
