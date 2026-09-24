"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildTeamChallengeScores } = require("../admin-team-scores.js");

const root = path.resolve(__dirname, "..");
const ADMIN_USERNAME = "record_flow_admin";
const ADMIN_PASSWORD = "Record-Flow-Admin-12345";
const ALL_EXECUTION_METHODS = Object.freeze([
  "odometry", "road_state", "map_graph", "mission", "task_state", "release_preview",
  "follow_road", "take_exit",
  "sees", "count", "detect", "near", "centered", "direction", "distance_to", "approach", "observe"
]);

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
  assert.ok(value, "认证响应必须设置会话 Cookie");
  return value.split(";", 1)[0];
}

test("runs remain saved until the owner submits, then admin can inspect and export them", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-record-flow-"));
  const port = 32000 + Math.floor(Math.random() * 12000);
  const origin = `http://127.0.0.1:${port}`;
  const configuredPublicOrigin = "https://blockly-test-tunnel.example";
  const child = childProcess.spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      BLOCKLY_PUBLIC_ORIGIN: configuredPublicOrigin,
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
      const payload = await response.json().catch(() => null);
      return { response, payload };
    };

    const teamScoresAsset = await fetch(`${origin}/admin-team-scores.js`);
    assert.equal(teamScoresAsset.status, 200, "队伍最高分汇总脚本必须能由正式服务加载");
    assert.match(teamScoresAsset.headers.get("content-type") || "", /javascript/);
    const assetCsp = teamScoresAsset.headers.get("content-security-policy") || "";
    assert.match(assetCsp, /base-uri 'none'/);
    assert.match(assetCsp, /object-src 'none'/);
    assert.match(assetCsp, /frame-ancestors 'none'/);
    assert.equal(teamScoresAsset.headers.get("x-frame-options"), "DENY");
    assert.equal(teamScoresAsset.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(teamScoresAsset.headers.get("referrer-policy"), "no-referrer");
    assert.equal(teamScoresAsset.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
    assert.match(await teamScoresAsset.text(), /DEFAULT_PAGE_SIZE = 15/);

    for (const assetPath of [
      "/vendor/blockly/blockly_compressed.js",
      "/vendor/blockly/blocks_compressed.js",
      "/vendor/blockly/javascript_compressed.js",
      "/vendor/blockly/msg/zh-hans.js",
      "/vendor/three/three.min.js",
      "/vendor/lucide/lucide.min.js"
    ]) {
      const asset = await fetch(`${origin}${assetPath}`);
      assert.equal(asset.status, 200, `${assetPath} 必须由正式服务提供`);
      assert.match(asset.headers.get("content-type") || "", /javascript/);
      assert.ok((await asset.arrayBuffer()).byteLength > 0);
    }

    const configuredOriginRequest = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { Origin: configuredPublicOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "missing", password: "1234567890" })
    });
    assert.equal(configuredOriginRequest.status, 401, "配置的公网来源应通过来源校验，再按账号信息返回未授权");
    assert.match(configuredOriginRequest.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
    assert.equal(configuredOriginRequest.headers.get("x-frame-options"), "DENY");

    const untrustedOriginRequest = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { Origin: "https://untrusted.invalid", "Content-Type": "application/json" },
      body: JSON.stringify({ username: "missing", password: "1234567890" })
    });
    assert.equal(untrustedOriginRequest.status, 403, "其他来源仍必须被拒绝");

    const invalidGroup = await jsonRequest("/api/auth/register", {
      method: "POST",
      body: {
        username: "invalid_group_user",
        password: "1234567890",
        teamAction: "create",
        teamName: "无效分组队",
        group: "primary_unknown"
      }
    });
    assert.equal(invalidGroup.response.status, 400);
    assert.equal(invalidGroup.payload.error.code, "INVALID_PARTICIPANT_GROUP");

    const registered = await jsonRequest("/api/auth/register", {
      method: "POST",
      body: { username: "student001", password: "1234567890", teamAction: "create", teamName: "广阳岛一队", group: "high" }
    });
    assert.equal(registered.response.status, 201);
    assert.equal(registered.payload.user.group, "high");
    const studentCookie = cookieFrom(registered.response);

    const loggedIn = await jsonRequest("/api/auth/login", {
      method: "POST",
      body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }
    });
    assert.equal(loggedIn.response.status, 200);
    const adminCookie = cookieFrom(loggedIn.response);

    const maps = await jsonRequest("/api/maps", { cookie: studentCookie });
    assert.equal(maps.response.status, 200);
    const runMap = maps.payload.maps.find(map => map.taskId === "GYI-PRIMARY-01");
    assert.ok(runMap);

    const recordBody = {
      taskId: "GYI-PRIMARY-01",
      mapRevision: runMap.revision,
      mapDigest: runMap.digest,
      completed: true,
      checkpointCount: 4,
      targetDeliveredCount: 1,
      distractorClearedCount: 1,
      failedObstacleCount: 0,
      goalReached: true,
      blockedMoves: 0,
      offRoadEpisodes: 0,
      offRoadDurationMs: 0,
      durationMs: 12000,
      programCode: "car.forward(1)\ncar.turnRight(90)",
      workspaceXml: JSON.stringify({ blocks: [{ type: "car_forward", seconds: 1 }] }),
      executionTrace: [
        "observe", "mission", "follow_road", "road_state", "mission", "take_exit", "odometry",
        "detect", "map_graph", "near", "task_state", "centered", "release_preview", "direction",
        "sees", "distance_to", "count", "approach", "observe"
      ]
    };
    const invalidTrace = await jsonRequest("/api/records", {
      method: "POST",
      cookie: studentCookie,
      body: { ...recordBody, executionTrace: ["mission", "not_a_public_api"] }
    });
    assert.equal(invalidTrace.response.status, 400);
    assert.equal(invalidTrace.payload.error.code, "INVALID_EXECUTION_TRACE");

    const nonStringTrace = await jsonRequest("/api/records", {
      method: "POST",
      cookie: studentCookie,
      body: { ...recordBody, executionTrace: ["mission", 1] }
    });
    assert.equal(nonStringTrace.response.status, 400);
    assert.equal(nonStringTrace.payload.error.code, "INVALID_EXECUTION_TRACE");

    const oversizedTrace = await jsonRequest("/api/records", {
      method: "POST",
      cookie: studentCookie,
      body: { ...recordBody, executionTrace: Array(65).fill("mission") }
    });
    assert.equal(oversizedTrace.response.status, 400);
    assert.equal(oversizedTrace.payload.error.code, "INVALID_EXECUTION_TRACE");

    const saved = await jsonRequest("/api/records", {
      method: "POST",
      cookie: studentCookie,
      body: recordBody
    });
    assert.equal(saved.response.status, 201);
    assert.equal(saved.payload.record.recordState, "saved");
    assert.equal(saved.payload.record.submittedAt, null);
    assert.deepEqual(saved.payload.record.executionTrace, ALL_EXECUTION_METHODS);
    assert.deepEqual(saved.payload.record.capabilityUsage, {
      schemaVersion: "chenlong.blockly-runtime-capability-usage/v1",
      source: "runtime_reported",
      navigationSensorMethods: ALL_EXECUTION_METHODS.slice(0, 6),
      roadControlMethods: ALL_EXECUTION_METHODS.slice(6, 8),
      visionMethods: ALL_EXECUTION_METHODS.slice(8)
    });
    const recordId = saved.payload.record.id;

    const beforeSubmit = await jsonRequest("/api/admin/records", { cookie: adminCookie });
    assert.equal(beforeSubmit.response.status, 200);
    assert.deepEqual(beforeSubmit.payload.records, []);

    const submitted = await jsonRequest(`/api/records/${recordId}/submit`, {
      method: "POST", cookie: studentCookie, body: {}
    });
    assert.equal(submitted.response.status, 200);
    assert.equal(submitted.payload.record.recordState, "submitted");
    assert.equal(submitted.payload.duplicate, false);

    const afterSubmit = await jsonRequest("/api/admin/records", { cookie: adminCookie });
    assert.equal(afterSubmit.response.status, 200);
    assert.equal(afterSubmit.payload.records.length, 1);
    assert.equal(afterSubmit.payload.records[0].id, recordId);
    assert.equal(afterSubmit.payload.records[0].user.teamName, "广阳岛一队");
    assert.deepEqual(afterSubmit.payload.records[0].capabilityUsage, saved.payload.record.capabilityUsage);

    const detail = await jsonRequest(`/api/admin/records/${recordId}`, { cookie: adminCookie });
    assert.equal(detail.response.status, 200);
    assert.match(detail.payload.record.programCode, /car\.forward/);
    assert.match(detail.payload.record.workspaceXml, /car_forward/);
    assert.deepEqual(detail.payload.record.executionTrace, saved.payload.record.executionTrace);
    assert.deepEqual(detail.payload.record.capabilityUsage, saved.payload.record.capabilityUsage);

    const userExport = await jsonRequest("/api/admin/export/users", { cookie: adminCookie });
    assert.equal(userExport.response.status, 200);
    assert.ok(userExport.payload.users.some(user => user.username === "student001"
      && user.teamName === "广阳岛一队" && user.group === "high"));

    const recordExport = await jsonRequest("/api/admin/export/records", { cookie: adminCookie });
    assert.equal(recordExport.response.status, 200);
    assert.equal(recordExport.payload.records.length, 1);
    assert.match(recordExport.payload.records[0].programCode, /car\.turnRight/);
    assert.match(recordExport.payload.records[0].workspaceXml, /car_forward/);
    assert.equal(recordExport.payload.records[0].user.group, "high");
    assert.deepEqual(recordExport.payload.records[0].capabilityUsage, saved.payload.record.capabilityUsage);

    const teamRows = buildTeamChallengeScores({
      users: userExport.payload.users,
      records: afterSubmit.payload.records,
      taskIds: ["GYI-PRIMARY-01", "GYI-PRIMARY-02", "GYI-PRIMARY-03"]
    });
    const teamRow = teamRows.find(row => row.teamName === "广阳岛一队");
    assert.ok(teamRow, "后台队伍汇总必须包含刚刚提交成绩的队伍");
    assert.deepEqual(
      [teamRow.scores["GYI-PRIMARY-01"], teamRow.scores["GYI-PRIMARY-02"], teamRow.scores["GYI-PRIMARY-03"]],
      [afterSubmit.payload.records[0].score, null, null],
      "队伍汇总的任务最高分必须和正式记录接口完全一致"
    );
    assert.equal(teamRow.group, "high");
    assert.equal(teamRow.totalScore, afterSubmit.payload.records[0].score);
  } finally {
    child.kill();
    await new Promise(resolve => child.once("exit", resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
