#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");

const baseUrl = String(process.env.BLOCKLY_TEST_URL || "http://127.0.0.1:6180").replace(/\/$/, "");
const requestOrigin = String(process.env.BLOCKLY_TEST_ORIGIN || baseUrl).replace(/\/$/, "");
const adminUsername = process.env.BLOCKLY_ADMIN_USERNAME;
const adminPassword = process.env.BLOCKLY_ADMIN_PASSWORD;
if (!adminUsername) throw new Error("请通过 BLOCKLY_ADMIN_USERNAME 提供测试管理员用户名");
if (!adminPassword) throw new Error("请通过 BLOCKLY_ADMIN_PASSWORD 提供管理员密码");

const stamp = Date.now().toString(36);
const username = `accept_${stamp}`.slice(0, 32);
const teammate = `mate_${stamp}`.slice(0, 32);
const teamName = `Blockly验收队${stamp.toUpperCase()}`.slice(0, 64);
const password = `Test-${stamp}-123456`;

function cookieFrom(response) {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "登录或注册响应缺少 Cookie");
  return value.split(";", 1)[0];
}

async function call(route, { method = "GET", cookie = "", body, origin = requestOrigin } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { Origin: origin, "Content-Type": "application/json" } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, payload };
}

async function must(route, options, status = 200) {
  const result = await call(route, options);
  assert.equal(result.response.status, status, `${options?.method || "GET"} ${route}: ${JSON.stringify(result.payload)}`);
  return result.payload;
}

(async () => {
  const health = await must("/api/health");
  assert.equal(health.status, "ok");

  const blockedOrigin = await call("/api/auth/login", {
    method: "POST", origin: "https://untrusted.invalid",
    body: { username: adminUsername, password: adminPassword }
  });
  assert.equal(blockedOrigin.response.status, 403);
  assert.equal(blockedOrigin.payload.error.code, "CROSS_ORIGIN_REQUEST");

  const adminLogin = await call("/api/auth/login", {
    method: "POST", body: { username: adminUsername, password: adminPassword }
  });
  assert.equal(adminLogin.response.status, 200, JSON.stringify(adminLogin.payload));
  const adminCookie = cookieFrom(adminLogin.response);

  const registration = await call("/api/auth/register", {
    method: "POST",
    body: { username, password, teamAction: "create", teamName }
  });
  assert.equal(registration.response.status, 201, JSON.stringify(registration.payload));
  const studentCookie = cookieFrom(registration.response);
  const inviteCode = registration.payload.teamInviteCode;
  assert.match(inviteCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);

  const invite = await must("/api/auth/team-invite", { cookie: studentCookie });
  assert.equal(invite.inviteCode, inviteCode);
  const teammateRegistration = await call("/api/auth/register", {
    method: "POST",
    body: { username: teammate, password, teamAction: "join", inviteCode }
  });
  assert.equal(teammateRegistration.response.status, 201, JSON.stringify(teammateRegistration.payload));
  assert.equal(teammateRegistration.payload.user.teamName, teamName);

  const adminMaps = await must("/api/admin/maps", { cookie: adminCookie });
  assert.equal(adminMaps.maps.length, 3);
  const savedRecordIds = [];
  const submittedRecordIds = [];
  const finalRevisions = {};

  for (const originalMap of adminMaps.maps) {
    const alteredLayout = structuredClone(originalMap.layout);
    alteredLayout.checkpoints[0][1] = Math.round((alteredLayout.checkpoints[0][1] + 0.04) * 10000) / 10000;
    const alteredReceipt = await must(`/api/admin/maps/${originalMap.taskId}`, {
      method: "PUT", cookie: adminCookie,
      body: { baseRevision: originalMap.revision, layout: alteredLayout }
    });
    const alteredMap = alteredReceipt.map;
    assert.equal(alteredMap.revision, originalMap.revision + 1);

    const publicMaps = await must("/api/maps", { cookie: studentCookie });
    const studentMap = publicMaps.maps.find(map => map.taskId === originalMap.taskId);
    assert.equal(studentMap.digest, alteredMap.digest);

    const total = alteredMap.layout.checkpoints.length;
    const objectTotal = Math.max(1, (total - 2) / 2);
    const low = await must("/api/records", {
      method: "POST", cookie: studentCookie,
      body: {
        taskId: alteredMap.taskId, mapRevision: alteredMap.revision, mapDigest: alteredMap.digest,
        completed: false, checkpointCount: Math.floor(total / 2),
        targetDeliveredCount: 0, distractorClearedCount: 0, failedObstacleCount: 1, goalReached: false,
        blockedMoves: 1,
        offRoadEpisodes: 1, offRoadDurationMs: 1200, durationMs: 180000,
        programCode: "await robot.forward(0.5);\nawait robot.turnAngle(\"right\", 90);",
        workspaceXml: JSON.stringify({ blocks: { languageVersion: 0, blocks: [{ type: "robot_move", fields: { DIR: "forward" } }] } }),
        executionTrace: []
      }
    }, 201);
    savedRecordIds.push(low.record.id);
    assert.equal(low.record.recordState, "saved");

    const high = await must("/api/records", {
      method: "POST", cookie: studentCookie,
      body: {
        taskId: alteredMap.taskId, mapRevision: alteredMap.revision, mapDigest: alteredMap.digest,
        completed: true, checkpointCount: total,
        targetDeliveredCount: objectTotal, distractorClearedCount: objectTotal, failedObstacleCount: 0, goalReached: true,
        blockedMoves: 0,
        offRoadEpisodes: 0, offRoadDurationMs: 0, durationMs: 60000,
        programCode: "await robot.forward(1);\nawait robot.turnAngle(\"left\", 90);",
        workspaceXml: JSON.stringify({ blocks: { languageVersion: 0, blocks: [{ type: "robot_move", fields: { DIR: "forward" } }, { type: "robot_turn_left_90" }] } }),
        executionTrace: ["mission", "follow_road"]
      }
    }, 201);
    savedRecordIds.push(high.record.id);
    assert.equal(high.record.score, 100);
    const submitted = await must(`/api/records/${high.record.id}/submit`, {
      method: "POST", cookie: studentCookie, body: {}
    });
    assert.equal(submitted.record.recordState, "submitted");
    submittedRecordIds.push(high.record.id);
    const duplicate = await must(`/api/records/${high.record.id}/submit`, {
      method: "POST", cookie: studentCookie, body: {}
    });
    assert.equal(duplicate.duplicate, true);

    const restoredReceipt = await must(`/api/admin/maps/${originalMap.taskId}`, {
      method: "PUT", cookie: adminCookie,
      body: { baseRevision: alteredMap.revision, layout: originalMap.layout }
    });
    assert.deepEqual(restoredReceipt.map.layout, originalMap.layout);
    finalRevisions[originalMap.taskId] = restoredReceipt.map.revision;
  }

  const personalRecords = await must("/api/records", { cookie: studentCookie });
  assert.equal(personalRecords.records.length, 6);
  assert.equal(personalRecords.records.filter(record => record.recordState === "submitted").length, 3);
  assert.equal(personalRecords.records.filter(record => record.recordState === "saved").length, 3);

  const adminUsers = await must("/api/admin/users", { cookie: adminCookie });
  assert.ok(adminUsers.users.some(user => user.username === username && user.teamName === teamName && user.recordCount === 3));
  assert.ok(adminUsers.users.some(user => user.username === teammate && user.teamName === teamName));

  const adminRecords = await must("/api/admin/records", { cookie: adminCookie });
  const createdSubmissions = adminRecords.records.filter(record => submittedRecordIds.includes(record.id));
  assert.equal(createdSubmissions.length, 3);
  assert.deepEqual(new Set(createdSubmissions.map(record => record.taskId)), new Set(["GYI-PRIMARY-01", "GYI-PRIMARY-02", "GYI-PRIMARY-03"]));
  for (const record of createdSubmissions) {
    const detail = await must(`/api/admin/records/${record.id}`, { cookie: adminCookie });
    assert.match(detail.record.programCode, /robot\.forward/);
    assert.match(detail.record.workspaceXml, /robot_move/);
    assert.ok(detail.record.mapRevision);
  }

  const usersExport = await must("/api/admin/export/users", { cookie: adminCookie });
  assert.ok(usersExport.users.some(user => user.username === username));
  const recordsExport = await must("/api/admin/export/records", { cookie: adminCookie });
  assert.equal(recordsExport.records.filter(record => submittedRecordIds.includes(record.id)).length, 3);

  const finalMaps = await must("/api/maps", { cookie: studentCookie });
  finalMaps.maps.forEach(map => assert.equal(map.revision, finalRevisions[map.taskId]));

  process.stdout.write(`${JSON.stringify({
    ok: true,
    baseUrl,
    username,
    teammate,
    teamName,
    savedRuns: savedRecordIds.length,
    submittedRuns: submittedRecordIds.length,
    submittedRecordIds,
    finalRevisions
  }, null, 2)}\n`);
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
