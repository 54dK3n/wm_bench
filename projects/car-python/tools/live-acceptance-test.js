#!/usr/bin/env node
"use strict";

// Writes one clearly labelled participant and three formally submitted records
// to an explicitly selected running installation. It is intentionally separate
// from the isolated browser E2E suite and refuses to run without a confirmation
// flag so routine development commands cannot pollute competition data.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const {
  DeterministicSimulator,
  createSession: createCompetitionSession
} = require("../competition-core.js");
const { LOCAL_CHALLENGES } = require("../server.js");

const TASKS = Object.freeze([
  Object.freeze({ taskId: "R2-GYI-MVP-01", label: "广阳岛综合任务1", mode: "basic" }),
  Object.freeze({ taskId: "R2-GYI-MVP-02", label: "广阳岛综合任务2", mode: "navigation" }),
  Object.freeze({ taskId: "R2-GYI-MVP-03", label: "广阳岛综合任务3", mode: "navigation" })
]);
const REQUEST_TIMEOUT_MS = 30_000;

function selectedOrigin() {
  const value = String(process.env.CHENLONG_ACCEPTANCE_ORIGIN || "http://127.0.0.1:6178").trim();
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("CHENLONG_ACCEPTANCE_ORIGIN 必须是没有路径、账号、查询或片段的 HTTP(S) 来源。");
  }
  return url.origin;
}

function request(origin, { method = "GET", requestPath = "/", headers = {}, body } = {}) {
  const target = new URL(origin);
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const outgoing = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method,
      path: requestPath,
      headers: { Connection: "close", ...headers }
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    outgoing.once("error", reject);
    outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => {
      outgoing.destroy(new Error(`验收请求超过 ${REQUEST_TIMEOUT_MS / 1000} 秒：${method} ${requestPath}`));
    });
    outgoing.end(body);
  });
}

function parseJson(response, label) {
  assert.match(response.headers["content-type"] || "", /^application\/json\b/i, `${label}没有返回 JSON`);
  return JSON.parse(response.body.toString("utf8"));
}

function expectStatus(response, expected, label) {
  assert.equal(response.statusCode, expected, `${label}失败：${response.body.toString("utf8")}`);
  return parseJson(response, label);
}

function jsonRequest(origin, { method = "POST", requestPath, cookie, token, value = {} }) {
  const body = Buffer.from(JSON.stringify(value));
  return request(origin, {
    method,
    requestPath,
    headers: {
      Origin: origin,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body
  });
}

function sessionCookie(response) {
  const lines = Array.isArray(response.headers["set-cookie"])
    ? response.headers["set-cookie"]
    : [response.headers["set-cookie"]].filter(Boolean);
  const line = lines.find(value => /^chenlong_session=/i.test(value));
  assert.ok(line, "注册成功但没有收到登录 Cookie");
  return line.split(";", 1)[0];
}

async function auditAsAdministrator(origin, { username, teamName, submissions, sourceByRecordId }) {
  const adminUsername = String(process.env.CHENLONG_ACCEPTANCE_ADMIN_USERNAME || "").trim();
  const adminPassword = String(process.env.CHENLONG_ACCEPTANCE_ADMIN_PASSWORD || "");
  if (!adminUsername && !adminPassword) return { status: "skipped" };
  assert.ok(adminUsername && adminPassword,
    "管理员验收必须同时设置 CHENLONG_ACCEPTANCE_ADMIN_USERNAME 与 CHENLONG_ACCEPTANCE_ADMIN_PASSWORD");
  const loginResponse = await jsonRequest(origin, {
    requestPath: "/api/v1/auth/login",
    value: { username: adminUsername, password: adminPassword }
  });
  const loggedIn = expectStatus(loginResponse, 200, "管理员登录");
  assert.equal(loggedIn.user?.role, "admin", "验收管理员账号没有管理员角色");
  const cookie = sessionCookie(loginResponse);

  const users = expectStatus(await request(origin, {
    requestPath: "/api/v1/admin/users",
    headers: { Cookie: cookie }
  }), 200, "管理员读取用户");
  const testUser = users.users.find(item => item.username === username);
  assert.ok(testUser, "管理员用户管理没有显示本次验收账号");
  assert.equal(testUser.teamName, teamName);

  const records = expectStatus(await request(origin, {
    requestPath: "/api/v1/admin/records",
    headers: { Cookie: cookie }
  }), 200, "管理员读取正式记录");
  const expectedIds = new Set(submissions.map(item => item.recordId));
  const accepted = records.records.filter(item => expectedIds.has(item.recordId || item.submissionId));
  assert.equal(accepted.length, TASKS.length, "管理员后台没有完整显示三项验收提交");
  assert.ok(accepted.every(item => item.user?.username === username && item.user?.teamName === teamName));
  assert.ok(accepted.every(item => !Object.hasOwn(item, "sourceCode")),
    "管理员列表不应批量返回完整 Python 源码");
  const byTask = new Map(accepted.map(item => [item.taskId, item]));
  assert.deepEqual(byTask.get("R2-GYI-MVP-01")?.capabilityUsage, {
    navigationSensors: true, roadControls: false, vision: false
  });
  for (const taskId of ["R2-GYI-MVP-02", "R2-GYI-MVP-03"]) {
    assert.deepEqual(byTask.get(taskId)?.capabilityUsage, {
      navigationSensors: true, roadControls: true, vision: false
    });
  }

  for (const submission of submissions) {
    const detail = expectStatus(await request(origin, {
      requestPath: `/api/v1/admin/records/${encodeURIComponent(submission.recordId)}`,
      headers: { Cookie: cookie }
    }), 200, `${submission.taskName}管理员详情`);
    assert.equal(detail.sourceCode, sourceByRecordId.get(submission.recordId));
    assert.equal(detail.record?.user?.username, username);
  }

  const pools = expectStatus(await request(origin, {
    requestPath: "/api/v1/admin/map-pools",
    headers: { Cookie: cookie }
  }), 200, "管理员读取地图池和队伍分配");
  assert.deepEqual(pools.pools.map(pool => pool.variantCount), [8, 10, 12]);
  const assignment = pools.assignments.find(item => item.teamName === teamName);
  assert.ok(assignment, "地图池没有显示验收队伍分配");
  assert.equal(assignment.maps.length, TASKS.length);

  expectStatus(await jsonRequest(origin, {
    requestPath: "/api/v1/auth/logout",
    cookie,
    value: {}
  }), 200, "管理员退出登录");
  return {
    status: "ok",
    users: "ok",
    submittedRecords: "ok",
    recordSourceCode: "ok",
    capabilityMarkers: "ok",
    mapPools: pools.pools.map(pool => pool.variantCount),
    assignedMaps: assignment.maps.map(item => ({ taskId: item.taskId, variantNumber: item.variantNumber }))
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sessionFields(payload) {
  const value = payload.session || payload;
  return {
    id: value.sessionId || value.id,
    runId: value.runId,
    teamId: value.teamId,
    challenge: value.challenge,
    challengeDigest: value.challengeDigest,
    runDefinition: payload.runDefinition || value.runDefinition,
    submitToken: payload.submitToken || value.submitToken
  };
}

function sampleSimulatorFrame(competitionSession, frame, forceRecord = false) {
  const pose = frame.pose || frame.state?.pose || frame;
  const tick = frame.tick ?? frame.state?.tick;
  return competitionSession.sample({
    tick,
    x: pose.x,
    z: pose.z,
    heading: pose.heading,
    speed: Math.abs(Number(frame.linearSpeed ?? 0)),
    steering: Number(frame.angularSpeed ?? 0)
  }, { forceRecord });
}

function buildRecord(session, task) {
  const runDefinition = clone(session.runDefinition);
  const frozenChallenge = {
    ...session.challenge,
    task: runDefinition.taskDefinition,
    rules: runDefinition.ruleDefinition,
    scoring: runDefinition.scoringDefinition
  };
  const sourceCode = task.mode === "navigation"
    ? [
      "mission = robot.mission()",
      "state = robot.task_state()",
      "road = robot.road_state()",
      "result = robot.follow_road(10, 10)",
      "print(mission, state, road, result)"
    ].join("\n")
    : "robot.forward(1)\nprint(robot.odometry())";
  const competitionSession = createCompetitionSession(frozenChallenge, {
    teamId: session.teamId,
    runId: session.runId,
    serverSessionId: session.id,
    challengeDigest: session.challengeDigest,
    runDefinition,
    simulationDefinition: runDefinition.simulationDefinition,
    interactionDefinition: runDefinition.interactionDefinition,
    sourceCode
  }, { now: () => 0 });
  const simulator = new DeterministicSimulator(runDefinition.simulationDefinition);
  sampleSimulatorFrame(competitionSession, simulator.snapshot(), true);

  if (task.mode === "navigation") {
    for (const method of ["mission", "task_state", "road_state"]) {
      competitionSession.addNavigationQuery(method);
    }
    competitionSession.runNavigationControl(simulator, "follow_road", { maxCm: 10, speed: 10 });
  } else {
    competitionSession.addNavigationQuery("odometry");
    simulator.setWorld({
      bounds: clone(runDefinition.simulationDefinition.world.bounds),
      colliders: competitionSession.packageStateEngine.colliders()
    });
    const started = simulator.startCommand({
      kind: "drive", direction: 1, speedPercent: 10, durationMs: 100
    });
    competitionSession.addSimulationInput(started.command, {
      tick: started.startState.tick,
      startState: started.startState,
      source: "python"
    });
    while (simulator.hasActiveCommand() && competitionSession.status === "running") {
      sampleSimulatorFrame(competitionSession, simulator.step());
    }
  }
  return { record: competitionSession.finish("program_finished"), sourceCode };
}

async function main() {
  if (!process.argv.includes("--confirm-live-write")) {
    throw new Error("该命令会写入真实账号和正式记录；请显式添加 --confirm-live-write。");
  }
  const origin = selectedOrigin();
  const health = expectStatus(await request(origin, { requestPath: "/api/health" }), 200, "健康检查");
  assert.equal(health.status, "ok", "服务健康状态不是 ok");

  const timestamp = Date.now().toString(36);
  const username = String(process.env.CHENLONG_ACCEPTANCE_USERNAME || `accept_${timestamp}`).slice(0, 31);
  const teamName = String(process.env.CHENLONG_ACCEPTANCE_TEAM || `验收测试队-${timestamp}`).slice(0, 64);
  const password = String(process.env.CHENLONG_ACCEPTANCE_PASSWORD
    || `Acceptance-${crypto.randomBytes(18).toString("base64url")}!`);
  const registerResponse = await jsonRequest(origin, {
    requestPath: "/api/v1/auth/register",
    value: {
      username,
      password,
      displayName: "系统验收测试用户",
      teamName,
      group: "primary"
    }
  });
  const registered = expectStatus(registerResponse, 201, "注册测试用户");
  assert.equal(registered.user?.username, username);
  assert.equal(registered.user?.role, "user", "测试用户不应成为管理员");
  const cookie = sessionCookie(registerResponse);

  const me = expectStatus(await request(origin, {
    requestPath: "/api/v1/auth/me",
    headers: { Cookie: cookie }
  }), 200, "读取当前用户");
  assert.equal(me.user?.teamName, teamName);
  assert.equal(me.user?.group, "primary");
  const invite = expectStatus(await request(origin, {
    requestPath: "/api/v1/auth/team-invite",
    headers: { Cookie: cookie }
  }), 200, "读取队伍邀请码");
  assert.match(invite.inviteCode || "", /^[A-HJ-NP-Z2-9]{8}$/);

  const submissions = [];
  const sourceByRecordId = new Map();
  for (const task of TASKS) {
    const sessionPayload = expectStatus(await jsonRequest(origin, {
      requestPath: "/api/v1/sessions",
      cookie,
      value: { taskId: task.taskId }
    }), 201, `${task.label}创建场次`);
    const session = sessionFields(sessionPayload);
    assert.match(session.id || "", /^ses_[a-f0-9]{32}$/);
    assert.match(session.submitToken || "", /^[A-Za-z0-9_-]{43}$/);
    const built = buildRecord(session, task);
    const saved = expectStatus(await jsonRequest(origin, {
      requestPath: `/api/v1/sessions/${encodeURIComponent(session.id)}/drafts`,
      cookie,
      token: session.submitToken,
      value: built.record
    }), 201, `${task.label}保存运行记录`);
    assert.equal(saved.recordState, "saved");
    const submitted = expectStatus(await jsonRequest(origin, {
      requestPath: `/api/v1/records/${encodeURIComponent(saved.recordId)}/submit`,
      cookie,
      value: {}
    }), 201, `${task.label}正式提交`);
    assert.equal(submitted.recordState, "submitted");
    assert.equal(submitted.verification?.status, "verified");
    const detail = expectStatus(await request(origin, {
      requestPath: `/api/v1/records/${encodeURIComponent(saved.recordId)}`,
      headers: { Cookie: cookie }
    }), 200, `${task.label}读取个人详情`);
    assert.equal(detail.sourceCode, built.sourceCode);
    submissions.push({
      taskId: task.taskId,
      taskName: task.label,
      recordId: saved.recordId,
      submissionId: submitted.submissionId,
      score: detail.record?.score,
      verification: submitted.verification.status
    });
    sourceByRecordId.set(saved.recordId, built.sourceCode);
  }

  const list = expectStatus(await request(origin, {
    requestPath: "/api/v1/records",
    headers: { Cookie: cookie }
  }), 200, "读取个人比赛记录");
  const ownSubmitted = list.records.filter(item => item.user?.username === username && item.recordState === "submitted");
  assert.equal(ownSubmitted.length, TASKS.length, "个人记录没有完整显示三项正式提交");
  assert.deepEqual(new Set(ownSubmitted.map(item => item.taskId)), new Set(TASKS.map(item => item.taskId)));

  const administrator = await auditAsAdministrator(origin, {
    username, teamName, submissions, sourceByRecordId
  });

  expectStatus(await jsonRequest(origin, {
    requestPath: "/api/v1/auth/logout",
    cookie,
    value: {}
  }), 200, "退出登录");

  process.stdout.write(`${JSON.stringify({
    schemaVersion: "chenlong.live-acceptance-report/v1",
    origin,
    username,
    teamName,
    group: "primary",
    submissions,
    checks: {
      health: "ok",
      registration: "ok",
      session: "ok",
      draftSave: "ok",
      formalSubmit: "ok",
      personalRecords: "ok",
      personalSourceCode: "ok",
      teamInvite: "ok",
      administrator,
      logout: "ok"
    }
  }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`[live-acceptance] ${error.stack || error}\n`);
  process.exitCode = 1;
});
