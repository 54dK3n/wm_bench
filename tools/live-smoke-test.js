#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");

const baseOrigin = new URL(process.env.CHENLONG_LIVE_ORIGIN || "http://127.0.0.1:6190").origin;
const browserOrigin = new URL(process.env.CHENLONG_LIVE_REQUEST_ORIGIN || baseOrigin).origin;
const participantUsername = process.env.CHENLONG_LIVE_USER || "test1";
const participantPassword = process.env.CHENLONG_LIVE_USER_PASSWORD;
const adminUsername = process.env.CHENLONG_LIVE_ADMIN || "qwer";
const adminPassword = process.env.CHENLONG_LIVE_ADMIN_PASSWORD;
const createRecord = process.env.CHENLONG_LIVE_CREATE_RECORD === "1";

if (!participantPassword || !adminPassword) {
  throw new Error("请通过 CHENLONG_LIVE_USER_PASSWORD 和 CHENLONG_LIVE_ADMIN_PASSWORD 提供联调账号密码。 ");
}

function request(requestPath, {
  method = "GET", cookie = "", body = null, origin = null, accept = "application/json"
} = {}) {
  const target = new URL(requestPath, baseOrigin);
  const encoded = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const headers = { Accept: accept };
    if (cookie) headers.Cookie = cookie;
    if (origin) headers.Origin = origin;
    if (encoded) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = encoded.length;
    }
    const transport = target.protocol === "https:" ? https : http;
    const outgoing = transport.request(target, { method, headers, timeout: 20_000 }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        buffer: Buffer.concat(chunks)
      }));
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error(`请求超时：${requestPath}`)));
    outgoing.on("error", reject);
    outgoing.end(encoded || undefined);
  });
}

function json(result, label) {
  try {
    return JSON.parse(result.buffer.toString("utf8"));
  } catch {
    throw new Error(`${label}没有返回有效 JSON（HTTP ${result.status}）。`);
  }
}

function expectStatus(result, expected, label) {
  if (result.status !== expected) {
    const text = result.buffer.toString("utf8").slice(0, 500);
    throw new Error(`${label}预期 HTTP ${expected}，实际 ${result.status}：${text}`);
  }
}

function sessionCookie(result) {
  const values = result.headers["set-cookie"] || [];
  const list = Array.isArray(values) ? values : [values];
  const value = list.find(item => String(item).startsWith("chenlong_session="));
  if (!value) throw new Error("登录响应没有统一会话 Cookie。");
  return String(value).split(";", 1)[0];
}

async function login(username, password) {
  const result = await request("/api/v1/auth/login", {
    method: "POST",
    origin: browserOrigin,
    body: { username, password }
  });
  expectStatus(result, 200, `登录 ${username}`);
  return { cookie: sessionCookie(result), payload: json(result, `登录 ${username}`) };
}

async function main() {
  const health = await request("/api/health");
  expectStatus(health, 200, "统一平台健康检查");
  assert.equal(json(health, "统一平台健康检查").service, "chenlong-competition-platform");

  const rejected = await request("/api/v1/auth/login", {
    method: "POST",
    origin: "https://untrusted.example",
    body: { username: participantUsername, password: participantPassword }
  });
  expectStatus(rejected, 403, "跨来源登录保护");

  const participant = await login(participantUsername, participantPassword);
  assert.equal(participant.payload.user.role, "user");
  const meResult = await request("/api/platform/me", { cookie: participant.cookie });
  expectStatus(meResult, 200, "统一用户信息");
  const me = json(meResult, "统一用户信息").user;
  assert.equal(me.username, participantUsername);
  assert.match(me.teamId, /^tea_[a-f0-9]{32}$/);

  for (const [surface, label] of [["/python/", "Python"], ["/blockly/", "Blockly"]]) {
    const page = await request(surface, { cookie: participant.cookie, accept: "text/html" });
    expectStatus(page, 200, `${label} 主界面`);
    const html = page.buffer.toString("utf8");
    assert.match(html, /href=["']\/portal\.html["']/,
      `${label} 主界面应提供返回统一平台入口`);
    assert.doesNotMatch(html, new RegExp(`/${surface.split("/")[1]}/portal\\.html`),
      `${label} 返回入口不应被网关重复加前缀`);
  }

  const blocklyMe = await request("/blockly/api/auth/me", { cookie: participant.cookie });
  expectStatus(blocklyMe, 200, "Blockly 统一登录");
  assert.equal(json(blocklyMe, "Blockly 统一登录").user.username, participantUsername);
  const blocklyLegacyLogin = await request("/blockly/login.html");
  expectStatus(blocklyLegacyLogin, 302, "Blockly 旧登录入口回归统一登录");
  assert.equal(blocklyLegacyLogin.headers.location, "/login.html?returnTo=%2Fblockly%2F");

  const workshopMe = await request("/api/competition/me", { cookie: participant.cookie });
  expectStatus(workshopMe, 200, "识物工坊统一登录");
  assert.equal(json(workshopMe, "识物工坊统一登录").team.teamName, me.teamName);
  const workshopStudio = await request("/workshop/", { cookie: participant.cookie });
  expectStatus(workshopStudio, 200, "识物工坊训练台代理");
  const workshopStudioHtml = workshopStudio.buffer.toString("utf8");
  assert.match(workshopStudioHtml, /橙子识别比赛训练台/);
  assert.match(workshopStudioHtml, /\/workshop\/competition/);
  assert.doesNotMatch(workshopStudioHtml, /正在读取参赛信息/);
  const workshopPage = await request("/workshop/competition", { cookie: participant.cookie });
  expectStatus(workshopPage, 200, "识物工坊页面代理");
  const workshopHtml = workshopPage.buffer.toString("utf8");
  assert.doesNotMatch(workshopHtml, /\/workshop\/workshop\//);
  assert.match(workshopHtml, /\/portal\.html/);
  assert.match(workshopHtml, /\/workshop\//);

  const stylesheetPaths = [...workshopHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)]
    .map(match => match[1]);
  assert.ok(stylesheetPaths.length >= 2, "识物工坊页面应声明完整样式资源");
  for (const stylesheetPath of stylesheetPaths) {
    const stylesheet = await request(stylesheetPath, {
      cookie: participant.cookie,
      origin: browserOrigin,
      accept: "text/css,*/*;q=0.1"
    });
    expectStatus(stylesheet, 200, `识物工坊样式 ${stylesheetPath}`);
    assert.match(String(stylesheet.headers["content-type"] || ""), /text\/css/);
  }

  const browserEntryPath = workshopHtml.match(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/)?.[1];
  assert.ok(browserEntryPath, "识物工坊页面应声明浏览器入口");
  const runtimeAssetPaths = new Set([browserEntryPath, "/favicon.svg"]);
  if (workshopHtml.includes("/@vite/client")) {
    runtimeAssetPaths.add("/@vite/client");
    runtimeAssetPaths.add("/@react-refresh");
    runtimeAssetPaths.add("/node_modules/vite/dist/client/env.mjs");
  } else {
    for (const match of workshopHtml.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)) {
      runtimeAssetPaths.add(match[1]);
    }
  }
  for (const assetPath of runtimeAssetPaths) {
    const asset = await request(assetPath, {
      cookie: participant.cookie,
      origin: browserOrigin,
      accept: "*/*"
    });
    expectStatus(asset, 200, `识物工坊运行资源 ${assetPath}`);
    assert.doesNotMatch(asset.buffer.toString("utf8"), /Blocked dev request|origin .* is not allowed/i,
      `识物工坊运行资源 ${assetPath} 不应被 Vinext 来源校验拦截`);
  }

  const blocklyMapResult = await request("/blockly/api/maps", { cookie: participant.cookie });
  expectStatus(blocklyMapResult, 200, "Blockly 平台地图");
  const blocklyMaps = json(blocklyMapResult, "Blockly 平台地图").maps;
  assert.equal(blocklyMaps.length, 3);
  for (let index = 0; index < 3; index += 1) {
    const taskNumber = index + 1;
    const pythonTaskId = `R2-GYI-MVP-0${taskNumber}`;
    const pythonMapResult = await request(`/python/api/v1/map-config/${pythonTaskId}`, { cookie: participant.cookie });
    expectStatus(pythonMapResult, 200, `Python 任务${taskNumber}地图`);
    const pythonMap = json(pythonMapResult, `Python 任务${taskNumber}地图`);
    assert.equal(blocklyMaps[index].sourceTaskId, pythonTaskId);
    assert.equal(blocklyMaps[index].digest, pythonMap.digest);
    assert.equal(blocklyMaps[index].revision, pythonMap.revision);
    assert.deepEqual(blocklyMaps[index].layout, pythonMap.layout);
  }

  let createdRecordId = null;
  if (createRecord) {
    const map = blocklyMaps[0];
    const saved = await request("/blockly/api/records", {
      method: "POST",
      cookie: participant.cookie,
      origin: browserOrigin,
      body: {
        taskId: map.taskId,
        mapRevision: map.revision,
        mapDigest: map.digest,
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
        programCode: "// 统一平台联调验收记录（非参赛程序）",
        workspaceXml: "<xml xmlns=\"https://developers.google.com/blockly/xml\"></xml>",
        executionTrace: []
      }
    });
    expectStatus(saved, 201, "Blockly 保存联调记录");
    createdRecordId = json(saved, "Blockly 保存联调记录").record.id;
    const submitted = await request(`/blockly/api/records/${createdRecordId}/submit`, {
      method: "POST",
      cookie: participant.cookie,
      origin: browserOrigin,
      body: {}
    });
    expectStatus(submitted, 200, "Blockly 提交联调记录");
    assert.equal(json(submitted, "Blockly 提交联调记录").record.recordState, "submitted");
  }

  const scores = await request("/api/platform/scores/me", { cookie: participant.cookie });
  expectStatus(scores, 200, "个人共享成绩");
  const scorePayload = json(scores, "个人共享成绩");
  assert.deepEqual(Object.keys(scorePayload.taskScores).sort(), ["task1", "task2", "task3"]);

  const admin = await login(adminUsername, adminPassword);
  assert.equal(admin.payload.user.role, "admin");
  const usersResult = await request("/api/platform/admin/users", { cookie: admin.cookie });
  expectStatus(usersResult, 200, "统一用户管理");
  const users = json(usersResult, "统一用户管理").users;
  assert.ok(users.some(user => user.username === participantUsername && user.teamName === me.teamName));

  const overviewResult = await request("/api/platform/admin/overview?page=1", { cookie: admin.cookie });
  expectStatus(overviewResult, 200, "统一总分后台");
  const overview = json(overviewResult, "统一总分后台");
  assert.equal(overview.pagination.pageSize, 15);
  assert.ok(overview.teams.some(team => team.teamName === me.teamName));

  if (createdRecordId) {
    const recordsResult = await request("/blockly/api/admin/records", { cookie: admin.cookie });
    expectStatus(recordsResult, 200, "Blockly 后台记录");
    assert.ok(json(recordsResult, "Blockly 后台记录").records.some(record => record.id === createdRecordId));
    const detail = await request(`/blockly/api/admin/records/${createdRecordId}`, { cookie: admin.cookie });
    expectStatus(detail, 200, "Blockly 后台记录详情");
    assert.match(json(detail, "Blockly 后台记录详情").record.programCode, /联调验收/);
  }

  const exportResult = await request("/api/platform/admin/export", { cookie: admin.cookie });
  expectStatus(exportResult, 200, "统一成绩导出");
  assert.match(String(exportResult.headers["content-type"]), /text\/csv/);
  assert.match(exportResult.buffer.toString("utf8"), /队伍名称/);

  const workshopAdmin = await request("/api/competition/admin/overview", { cookie: admin.cookie });
  expectStatus(workshopAdmin, 200, "识物工坊管理员统一登录");
  const workshopOverview = json(workshopAdmin, "识物工坊管理员统一登录");
  const participantTeamIds = new Set(users.filter(user => user.role !== "admin" && user.teamId).map(user => user.teamId));
  for (const standing of Object.values(workshopOverview.leaderboards || {}).flat()) {
    assert.match(standing.teamId, /^tea_[a-f0-9]{32}$/, "识物历史成绩必须关联统一队伍编号");
    if (!participantTeamIds.has(standing.teamId)) continue;
    const unifiedTeam = overview.teams.find(team => team.teamId === standing.teamId);
    assert.ok(unifiedTeam, "识物参赛队必须出现在统一总分后台");
    const expectedWorkshopScore = standing.status === "scored"
      ? Math.round(Number(standing.scoreMicros) / 100) / 100
      : null;
    assert.equal(unifiedTeam.workshopScore, expectedWorkshopScore, "统一总分必须采用对应队伍的识物成绩");
  }

  const logout = await request("/api/v1/auth/logout", {
    method: "POST",
    cookie: participant.cookie,
    origin: browserOrigin,
    body: {}
  });
  expectStatus(logout, 200, "统一退出");
  const afterLogout = await request("/api/platform/me", { cookie: participant.cookie });
  expectStatus(afterLogout, 401, "退出后的会话失效");

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    participant: participantUsername,
    teamName: me.teamName,
    mapVariants: blocklyMaps.map(map => map.variantId),
    createdRecordId,
    teamCount: overview.pagination.total,
    userCount: users.length
  }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`统一平台在线验收失败：${error.stack || error.message}\n`);
  process.exitCode = 1;
});
