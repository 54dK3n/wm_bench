"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { gunzipSync, gzipSync } = require("node:zlib");

const contract = require("../packages/platform-contract.js");
const officialScores = require("../packages/score-download.js");
const platform = require("../server.js");

const SECRET = "platform-integration-test-secret-123456789";
const ADMIN = Object.freeze({
  id: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  username: "admin1",
  displayName: "管理员",
  teamName: null,
  group: null,
  role: "admin",
  createdAt: "2026-08-28T00:00:00.000Z"
});
const USER = Object.freeze({
  id: "usr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  username: "user001",
  displayName: "测试用户",
  teamName: "测试队01",
  group: "primary",
  role: "user",
  createdAt: "2026-08-28T00:00:00.000Z"
});
const TEAM_ID = "tea_cccccccccccccccccccccccccccccccc";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1", backlog: 2048 },
      () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function json(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length, ...headers });
  response.end(body);
}

function request(origin, requestPath, { method = "GET", headers = {}, body = null, agent = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(requestPath, origin);
    const req = http.request(target, { method, headers: { accept: "application/json", ...headers }, agent }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body !== null) req.end(body); else req.end();
  });
}

function parsed(result) {
  return JSON.parse(result.body.toString("utf8"));
}

function pythonMap(taskId) {
  const taskNumber = Number(taskId.slice(-1));
  const layout = {
    schemaVersion: "chenlong.guangyang-map-layout/v2",
    checkpoints: Array.from({ length: taskNumber * 2 + 2 }, (_, index) => [index, 0]),
    targets: Array.from({ length: taskNumber }, (_, index) => [index, 1]),
    storage: [0, 2],
    distractors: Array.from({ length: taskNumber }, (_, index) => [index, 3]),
    obstacles: Array.from({ length: taskNumber }, (_, index) => [index, 4])
  };
  return {
    schemaVersion: "chenlong.guangyang-map-config/v1",
    authoritative: false,
    mapId: "guangyang-island",
    baseMapVersion: "base",
    mapVersion: "base",
    revision: 0,
    updatedAt: null,
    digest: require("node:crypto").createHash("sha256").update(contract.canonicalJson(layout), "utf8").digest("hex"),
    layout
  };
}

function fixtures() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "competition-platform-test-"));
  const authStorePath = path.join(temporary, "auth-store.json");
  const users = [ADMIN, USER];
  fs.writeFileSync(authStorePath, JSON.stringify({
    schemaVersion: "chenlong.auth-store/v6",
    revision: 1,
    users: users.map(user => ({ ...user, teamId: user.role === "admin" ? "tea_dddddddddddddddddddddddddddddddd" : TEAM_ID })),
    teams: [],
    sessions: []
  }));

  const observed = {
    pythonAuthenticated: true,
    pythonHealthStatus: 200,
    blocklyHealthStatus: 200,
    workshopHealthStatus: 200,
    pythonOrigins: [],
    pythonMeRequests: 0,
    pythonRecordRequests: [],
    pythonAggregateRequests: [],
    pythonRecordTotal: 0,
    pythonCompressedWrites: [],
    authBodies: [],
    ssoRequests: [],
    blocklyHeaders: [],
    blocklyRecordRequests: [],
    blocklyAggregateRequests: [],
    blocklyRecordTotal: 0,
    workshopHeaders: [],
    blocklyAdminStatus: 200,
    workshopAdminStatus: 200
  };
  const python = http.createServer((req, res) => {
    const url = new URL(req.url, "http://python.test");
    const admin = req.headers.cookie === "role=admin";
    const current = admin ? ADMIN : USER;
    if (url.pathname === "/api/health") return json(res, observed.pythonHealthStatus,
      observed.pythonHealthStatus === 200
        ? {
            schemaVersion: "chenlong.backend-health/v1",
            status: "ok",
            capabilities: { officialSsoConfigured: true, authUserCount: 999, queuedVerifications: 123 }
          }
        : { error: { message: "private Python failure detail" } });
    if (url.pathname === "/api/v1/auth/me") {
      observed.pythonMeRequests += 1;
      if (!observed.pythonAuthenticated) return json(res, 401, {
        schemaVersion: "chenlong.verification-report/v1",
        error: { code: "AUTHENTICATION_REQUIRED", message: "private authentication detail" }
      });
      return json(res, 200, { schemaVersion: "chenlong.auth/v1", authenticated: true, user: current, authoritative: false });
    }
    if (url.pathname === "/api/v1/auth/sso/jump") {
      observed.ssoRequests.push({ url: req.url, forwardedFor: req.headers["x-forwarded-for"] || null });
      res.writeHead(302, {
        Location: "/portal.html",
        "Set-Cookie": "chenlong_session=sso-test; Path=/; HttpOnly; SameSite=Strict"
      });
      res.end();
      return;
    }
    if (url.pathname.startsWith("/api/v1/auth/") && req.method === "POST") {
      observed.pythonOrigins.push(req.headers.origin || null);
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        observed.authBodies.push(body);
        if (url.pathname === "/api/v1/auth/register") {
          const allowed = body.teamAction === "join"
            ? ["username", "password", "group", "teamAction", "inviteCode"]
            : ["username", "password", "group", "teamAction", "teamName"];
          if (Object.keys(body).some(key => !allowed.includes(key))) return json(res, 400, { error: { message: "unexpected registration field" } });
        }
        return json(res, 200, { schemaVersion: "chenlong.auth/v1", authenticated: true, user: current, authoritative: false }, { "set-cookie": "chenlong_session=test; Path=/; HttpOnly" });
      });
      return;
    }
    if (url.pathname === "/api/v1/auth/team-invite") return json(res, 200, { schemaVersion: "chenlong.team-invite/v1", teamName: USER.teamName, inviteCode: "ABCDEFG2", authoritative: false });
    if (["/", "/index.html", "/admin.html", "/records.html"].includes(url.pathname)) {
      res.writeHead(302, { Location: `/login.html?returnTo=${encodeURIComponent(`${url.pathname}${url.search}`)}` });
      res.end();
      return;
    }
    if (url.pathname === "/api/v1/test-compressed-write" && req.method === "POST") {
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        observed.pythonCompressedWrites.push({
          contentEncoding: req.headers["content-encoding"] || null,
          origin: req.headers.origin || null,
          body
        });
        return json(res, 200, { received: body.length });
      });
      return;
    }
    const mapMatch = url.pathname.match(/^\/api\/v1\/(?:admin\/)?map-config\/(R2-GYI-MVP-0[123])(?:\/map-01)?$/);
    if (mapMatch) return json(res, 200, pythonMap(mapMatch[1]));
    if (url.pathname === "/api/v1/admin/users") {
      const extra = Array.from({ length: 15 }, (_, index) => ({
        id: `usr_${String(index + 10).padStart(32, "0")}`,
        username: `team${index + 2}`,
        displayName: `队员${index + 2}`,
        teamName: `测试队${String(index + 2).padStart(2, "0")}`,
        group: ["primary", "junior", "high"][index % 3],
        role: "user",
        createdAt: USER.createdAt
      }));
      return json(res, 200, { schemaVersion: "chenlong.admin-users/v1", users: [ADMIN, USER, ...extra], authoritative: false });
    }
    if (url.pathname === `/api/v1/admin/users/${USER.id}` && req.method === "PATCH") {
      observed.pythonOrigins.push(req.headers.origin || null);
      return json(res, 200, { schemaVersion: "chenlong.admin-user-update/v1", user: { ...USER, teamName: "新队名", group: "junior" }, authoritative: false });
    }
    if (url.pathname === "/api/v1/admin/team-task-scores") {
      observed.pythonAggregateRequests.push(req.url);
      const record = {
        id: "sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ownerUserId: USER.id,
        teamId: TEAM_ID,
        recordState: "submitted",
        taskId: "R2-GYI-MVP-01",
        score: observed.pythonRecordTotal > 0 ? 99 : 80,
        submittedAt: "2026-08-28T01:00:00.000Z"
      };
      return json(res, 200, {
        schemaVersion: "chenlong.python-team-task-scores/v1",
        records: [record],
        authoritative: false
      });
    }
    if (url.pathname === "/api/v1/admin/records") {
      observed.pythonRecordRequests.push(req.url);
      if (observed.pythonRecordTotal > 0) {
        const page = Number(url.searchParams.get("page") || 1);
        const pageSize = Number(url.searchParams.get("pageSize") || 1000);
        const total = observed.pythonRecordTotal;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const start = (page - 1) * pageSize;
        const records = Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, index) => ({
          recordState: "submitted",
          taskId: "R2-GYI-MVP-01",
          score: start + index === total - 1 ? 99 : 80,
          user: USER
        }));
        return json(res, 200, {
          schemaVersion: "chenlong.records/v1",
          records,
          pagination: { page, pageSize, total, totalPages, hasNext: page < totalPages },
          authoritative: false
        });
      }
      return json(res, 200, {
        schemaVersion: "chenlong.records/v1",
        records: [{ recordState: "submitted", taskId: "R2-GYI-MVP-01", score: 80, user: USER }],
        authoritative: false
      });
    }
    if (url.pathname === "/api/v1/records") return json(res, 200, {
      schemaVersion: "chenlong.records/v1",
      records: [{ recordState: "submitted", ownerUserId: USER.id, taskId: "R2-GYI-MVP-01", score: 80 }],
      authoritative: false
    });
    if (url.pathname === "/api/v1/admin/map-pools") {
      const members = [{ userId: USER.id, username: USER.username, displayName: USER.displayName }];
      const extras = Array.from({ length: 15 }, (_, index) => ({ userId: `usr_${String(index + 10).padStart(32, "0")}`, username: `team${index + 2}`, displayName: `队员${index + 2}` }));
      const assignments = [{ teamId: TEAM_ID, teamName: USER.teamName, members, maps: [1, 2, 3].map(number => ({ taskId: `R2-GYI-MVP-0${number}`, variantId: `map-0${number}`, variantNumber: number })) }, ...extras.map((member, index) => ({ teamId: `tea_${String(index + 10).padStart(32, "0")}`, teamName: `测试队${String(index + 2).padStart(2, "0")}`, members: [member], maps: [] }))];
      return json(res, 200, { schemaVersion: "chenlong.guangyang-map-pools-admin/v1", pools: [], assignments, authoritative: false });
    }
    res.writeHead(404); res.end();
  });
  const blockly = http.createServer((req, res) => {
    observed.blocklyHeaders.push(req.headers);
    if (req.url === "/api/health") return json(res, observed.blocklyHealthStatus,
      observed.blocklyHealthStatus === 200
        ? {
            schemaVersion: "chenlong.blockly-health/v1",
            status: "ok",
            capacity: { users: 999, records: 888 }
          }
        : { error: { message: "private Blockly failure detail" } });
    if (req.url === "/app.js" || req.url.startsWith("/app.js?")) {
      const body = Buffer.from('fetch("/api/maps"); location.href="/admin.html";');
      res.writeHead(200, { "content-type": "text/javascript", "content-length": body.length }); res.end(body); return;
    }
    if (req.url.startsWith("/api/records")) return json(res, 200, { schemaVersion: "chenlong.blockly-records/v1", records: [{ recordState: "submitted", taskId: "GYI-PRIMARY-02", score: 90 }], authoritative: false });
    if (req.url === "/api/admin/team-task-scores") {
      observed.blocklyAggregateRequests.push(req.url);
      const records = [
        { id: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ownerUserId: USER.id, teamId: TEAM_ID, recordState: "submitted", taskId: "GYI-PRIMARY-01", score: 95, submittedAt: "2026-08-28T01:01:00.000Z" },
        { id: "run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ownerUserId: USER.id, teamId: TEAM_ID, recordState: "submitted", taskId: "GYI-PRIMARY-02", score: 90, submittedAt: "2026-08-28T01:02:00.000Z" },
        ...(observed.blocklyRecordTotal > 0
          ? [{ id: "run_cccccccccccccccccccccccccccccccc", ownerUserId: USER.id, teamId: TEAM_ID, recordState: "submitted", taskId: "GYI-PRIMARY-03", score: 100, submittedAt: "2026-08-28T01:03:00.000Z" }]
          : [])
      ];
      return json(res, observed.blocklyAdminStatus, observed.blocklyAdminStatus === 200
        ? { schemaVersion: "chenlong.blockly-team-task-scores/v1", records, authoritative: false }
        : { error: { message: "unavailable" } });
    }
    if (req.url.startsWith("/api/admin/records")) {
      observed.blocklyRecordRequests.push(req.url);
      if (observed.blocklyAdminStatus !== 200) {
        return json(res, observed.blocklyAdminStatus, { error: { message: "unavailable" } });
      }
      if (observed.blocklyRecordTotal > 0) {
        const url = new URL(req.url, "http://blockly.test");
        const page = Number(url.searchParams.get("page") || 1);
        const pageSize = Number(url.searchParams.get("pageSize") || 1000);
        const total = observed.blocklyRecordTotal;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const start = (page - 1) * pageSize;
        const records = Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, index) => ({
          recordState: "submitted",
          taskId: "GYI-PRIMARY-03",
          score: start + index === total - 1 ? 100 : 70,
          user: { ...USER, teamId: TEAM_ID }
        }));
        return json(res, 200, {
          schemaVersion: "chenlong.blockly-admin-records/v1",
          records,
          pagination: { page, pageSize, total, totalPages, hasNext: page < totalPages },
          authoritative: false
        });
      }
      return json(res, 200, { schemaVersion: "chenlong.blockly-admin-records/v1", records: [{ recordState: "submitted", taskId: "GYI-PRIMARY-01", score: 95, user: { ...USER, teamId: TEAM_ID } }, { recordState: "submitted", taskId: "GYI-PRIMARY-02", score: 90, user: { ...USER, teamId: TEAM_ID } }], authoritative: false });
    }
    json(res, 200, { ok: true });
  });
  const workshop = http.createServer((req, res) => {
    observed.workshopHeaders.push(req.headers);
    if (req.url === "/api/competition/health") return json(res, observed.workshopHealthStatus,
      observed.workshopHealthStatus === 200
        ? {
            ok: true,
            service: "workshop-competition",
            scoringQueue: { active: 7, pending: 9 }
          }
        : { error: { message: "private Workshop failure detail" } });
    if (req.url === "/") {
      const body = Buffer.from('<!doctype html><title>识物工坊｜橙子识别比赛训练台</title><a href="/competition">比赛提交</a><a href="/portal.html">统一平台</a>');
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length });
      res.end(body);
      return;
    }
    if (req.url === "/app/globals.css") {
      const body = Buffer.from("body { color: #123; }");
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "content-length": body.length });
      res.end(body);
      return;
    }
    if (req.url.startsWith("/@id/") || req.url === "/@vite/client"
      || req.url === "/@react-refresh" || req.url.startsWith("/node_modules/")) {
      const body = Buffer.from("export const workshopAsset = true;");
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "content-length": body.length });
      res.end(body);
      return;
    }
    if (req.url === "/favicon.svg") {
      const body = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      res.writeHead(200, { "content-type": "image/svg+xml", "content-length": body.length });
      res.end(body);
      return;
    }
    if (req.url === "/api/competition/me") return json(res, 200, { team: { id: TEAM_ID }, latestSubmission: { id: "sub1", status: "submitted" } });
    if (req.url === "/api/competition/admin/overview") return json(res, observed.workshopAdminStatus, observed.workshopAdminStatus === 200
      ? { evaluationSets: [], leaderboards: { primary: [{ teamId: TEAM_ID, teamName: USER.teamName, division: "primary", status: "scored", scoreMicros: 880000 }], junior: [], senior: [] } }
      : { error: { message: "unavailable" } });
    json(res, 200, { ok: true });
  });
  return { temporary, authStorePath, observed, python, blockly, workshop };
}

async function withPlatform(run, platformConfig = {}) {
  const f = fixtures();
  const pythonOrigin = await listen(f.python);
  const blocklyOrigin = await listen(f.blockly);
  const workshopOrigin = await listen(f.workshop);
  const server = platform.createServer({
    pythonOrigin,
    blocklyOrigin,
    workshopOrigin,
    authStorePath: f.authStorePath,
    secret: SECRET,
    ...platformConfig
  });
  const origin = await listen(server);
  try { await run({ ...f, server, origin, pythonOrigin, blocklyOrigin, workshopOrigin }); }
  finally {
    await Promise.all([close(server), close(f.python), close(f.blockly), close(f.workshop)]);
    fs.rmSync(f.temporary, { recursive: true, force: true });
  }
}

test("public authentication proxy checks the external Origin and rewrites it to Python", async () => {
  await withPlatform(async ({ origin, observed, pythonOrigin }) => {
    const bad = await request(origin, "/api/v1/auth/login", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: Buffer.from("{}") });
    assert.equal(bad.status, 403);
    assert.equal(observed.pythonOrigins.length, 0);
    const good = await request(origin, "/api/v1/auth/login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: Buffer.from("{}") });
    assert.equal(good.status, 200);
    assert.equal(observed.pythonOrigins[0], pythonOrigin);
    assert.match(String(good.headers["set-cookie"]), /chenlong_session=test/);
  });
});

test("configured HTTPS platform Origin is preserved through the Python authentication proxy", async () => {
  const publicOrigin = "https://contest.example.test";
  await withPlatform(async ({ origin, observed }) => {
    const result = await request(origin, "/api/v1/auth/login", {
      method: "POST",
      headers: { origin: publicOrigin, "content-type": "application/json" },
      body: Buffer.from("{}")
    });
    assert.equal(result.status, 200, result.body.toString("utf8"));
    assert.equal(observed.pythonOrigins.at(-1), publicOrigin);
  }, { publicOrigin });
});

test("Blockly logout preserves the configured HTTPS platform Origin", async () => {
  const publicOrigin = "https://contest.example.test";
  await withPlatform(async ({ origin, observed }) => {
    const result = await request(origin, "/blockly/api/auth/logout", {
      method: "POST",
      headers: { origin: publicOrigin, "content-type": "application/json" },
      body: Buffer.from("{}")
    });
    assert.equal(result.status, 204, result.body.toString("utf8"));
    assert.equal(observed.pythonOrigins.at(-1), publicOrigin);
  }, { publicOrigin });
});

test("official SSO jump is transparently routed to the single Python authentication writer", async () => {
  await withPlatform(async ({ origin, observed }) => {
    const query = "user_id=U10086&team_id=T20260100&group_type=primary&team_name=%E5%AE%9E%E9%AA%8C%E4%BA%8C%E5%B0%8F%E4%B8%80%E9%98%9F&timestamp=1800000000&sign="
      + "a".repeat(64);
    const result = await request(origin, `/sso/jump?${query}`);
    assert.equal(result.status, 302);
    assert.equal(result.headers.location, "/portal.html");
    assert.match(String(result.headers["set-cookie"]), /chenlong_session=sso-test/);
    assert.equal(observed.ssoRequests.length, 1);
    assert.equal(observed.ssoRequests[0].url, `/api/v1/auth/sso/jump?${query}`);
    assert.match(String(observed.ssoRequests[0].forwardedFor), /127\.0\.0\.1|::1/);
  });
});

test("official SSO ignores spoofed forwarding headers unless the direct proxy is explicitly trusted", async () => {
  await withPlatform(async ({ origin, observed }) => {
    const query = "user_id=U1&team_id=T1&group_type=primary&team_name=One&timestamp=1800000000&sign="
      + "b".repeat(64);
    const result = await request(origin, `/sso/jump?${query}`, {
      headers: { "x-forwarded-for": "198.51.100.10", "cf-connecting-ip": "198.51.100.11" }
    });
    assert.equal(result.status, 302);
    assert.match(String(observed.ssoRequests.at(-1).forwardedFor), /127\.0\.0\.1|::1/);
  });
});

test("official SSO forwards the normalized Cloudflare client IP only from an explicit trusted proxy", async () => {
  await withPlatform(async ({ origin, observed }) => {
    const query = "user_id=U2&team_id=T2&group_type=primary&team_name=Two&timestamp=1800000000&sign="
      + "c".repeat(64);
    const result = await request(origin, `/sso/jump?${query}`, {
      headers: { "x-forwarded-for": "198.51.100.20", "cf-connecting-ip": "203.0.113.20" }
    });
    assert.equal(result.status, 302);
    assert.equal(observed.ssoRequests.at(-1).forwardedFor, "203.0.113.20");
  }, { trustedProxyIps: ["127.0.0.1"] });
});

test("registration forwards only the Python strict registration schema", async () => {
  await withPlatform(async ({ origin, observed }) => {
    const body = { username: "accept001", password: "1234567890", group: "primary", teamAction: "create", teamName: "验收队" };
    const result = await request(origin, "/api/v1/auth/register", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(body))
    });
    assert.equal(result.status, 200);
    assert.deepEqual(observed.authBodies.at(-1), body);
    assert.equal(Object.hasOwn(observed.authBodies.at(-1), "displayName"), false);
  });
});

test("authentication proxy rejects oversized bodies before forwarding them", async () => {
  await withPlatform(async ({ origin, observed }) => {
    const body = Buffer.alloc(17 * 1024, 0x61);
    const result = await request(origin, "/api/v1/auth/register", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "content-length": String(body.length)
      },
      body
    });
    assert.equal(result.status, 413);
    assert.equal(parsed(result).error.code, "REQUEST_TOO_LARGE");
    assert.equal(observed.authBodies.length, 0);
    assert.equal(observed.pythonOrigins.length, 0);
  });
});

test("Python proxy preserves gzip record uploads while enforcing the compressed wire size", async () => {
  await withPlatform(async ({ origin, observed, pythonOrigin }) => {
    const original = Buffer.from(JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }));
    const body = gzipSync(original);
    assert.ok(body.length < 1024 * 1024);
    const result = await request(origin, "/python/api/v1/test-compressed-write", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(body.length)
      },
      body
    });
    assert.equal(result.status, 200, result.body.toString("utf8"));
    assert.equal(observed.pythonCompressedWrites.length, 1);
    assert.equal(observed.pythonCompressedWrites[0].contentEncoding, "gzip");
    assert.equal(observed.pythonCompressedWrites[0].origin, pythonOrigin);
    assert.deepEqual(gunzipSync(observed.pythonCompressedWrites[0].body), original);
  });
});

test("gateway liveness stays compatible while readiness reports only sanitized child-service state", async () => {
  await withPlatform(async ({ origin }) => {
    const liveness = await request(origin, "/api/health");
    assert.equal(liveness.status, 200);
    const livePayload = parsed(liveness);
    assert.equal(livePayload.schemaVersion, "chenlong.competition-platform/v1");
    assert.equal(livePayload.status, "ok");
    assert.equal(Object.hasOwn(livePayload, "checks"), false,
      "the existing liveness contract remains unchanged");

    const readiness = await request(origin, "/api/readiness");
    assert.equal(readiness.status, 200, readiness.body.toString("utf8"));
    assert.deepEqual(parsed(readiness), {
      schemaVersion: "chenlong.competition-platform-readiness/v1",
      status: "ok",
      service: "chenlong-competition-platform",
      checks: {
        gateway: { status: "ok" },
        python: { status: "ok" },
        blockly: { status: "ok" },
        workshop: { status: "ok" }
      },
      configuration: {
        trustedProxyConfigured: true,
        publicOriginConfigured: true,
        officialSsoConfigured: true
      },
      authoritative: false
    });
    assert.doesNotMatch(readiness.body.toString("utf8"), /authUserCount|queuedVerifications|records|scoringQueue|999|888|123/,
      "readiness must not relay child-service payloads or user data");
  }, { publicOrigin: "https://contest.example.test", trustedProxyIps: ["127.0.0.1"] });
});

test("gateway readiness degrades without changing liveness when one child service is unhealthy", async () => {
  await withPlatform(async ({ origin, observed }) => {
    observed.blocklyHealthStatus = 503;
    const liveness = await request(origin, "/api/health");
    assert.equal(liveness.status, 200);
    assert.equal(parsed(liveness).status, "ok");

    const readiness = await request(origin, "/api/readiness");
    assert.equal(readiness.status, 503);
    const payload = parsed(readiness);
    assert.equal(payload.status, "degraded");
    assert.deepEqual(payload.checks.python, { status: "ok" });
    assert.deepEqual(payload.checks.blockly, { status: "error", code: "UPSTREAM_HTTP_ERROR" });
    assert.deepEqual(payload.checks.workshop, { status: "ok" });
    assert.doesNotMatch(readiness.body.toString("utf8"), /private Blockly failure detail/);
  });
});

test("platform me enriches the public Python profile with its stable internal team id", async () => {
  await withPlatform(async ({ origin }) => {
    const result = await request(origin, "/api/platform/me", { headers: { cookie: "role=user" } });
    assert.equal(result.status, 200);
    assert.equal(parsed(result).user.teamId, TEAM_ID);
    assert.equal(parsed(result).user.teamName, USER.teamName);
    assert.equal(parsed(result).services.workshop, "/workshop/");
  });
});

test("unified gateway serves 500 simultaneous authenticated profile requests", async () => {
  await withPlatform(async ({ origin, observed }) => {
    const loadAgent = new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 16 });
    const startedAt = Date.now();
    let results;
    try {
      results = await Promise.all(Array.from({ length: 500 }, () =>
        request(origin, "/api/platform/me", { headers: { cookie: "role=user" }, agent: loadAgent })));
    } finally {
      loadAgent.destroy();
    }
    const elapsedMs = Date.now() - startedAt;
    assert.equal(results.filter(result => result.status === 200).length, 500);
    assert.equal(observed.pythonMeRequests, 500);
    assert.ok(elapsedMs < 15_000, `500 gateway requests took ${elapsedMs}ms`);
  });
});

test("unified admin page exposes the consolidated score, user, and subsystem panels", async () => {
  await withPlatform(async ({ origin }) => {
    const page = await request(origin, "/admin.html", { headers: { cookie: "role=admin" } });
    assert.equal(page.status, 200);
    const html = page.body.toString("utf8");
    assert.match(html, /href="\/admin\.css"/);
    assert.match(html, /data-admin-tab="scores"/);
    assert.match(html, /data-admin-tab="users"/);
    assert.match(html, /data-admin-tab="systems"/);
    assert.match(html, /导出总成绩 CSV/);
    assert.match(html, /\/python\/admin\.html/);
    assert.match(html, /\/blockly\/admin\.html\?platform=1/);
    assert.match(html, /\/workshop\/competition\/admin/);

    const style = await request(origin, "/admin.css");
    assert.equal(style.status, 200);
    assert.match(style.headers["content-type"], /text\/css/);
    assert.equal(style.headers["cache-control"], "public, max-age=300, must-revalidate");
    assert.ok(style.headers.etag);
    assert.match(style.body.toString("utf8"), /\.admin-tabs/);

    const cachedStyle = await request(origin, "/admin.css", {
      headers: { "if-none-match": style.headers.etag }
    });
    assert.equal(cachedStyle.status, 304);
    assert.equal(cachedStyle.body.length, 0);
  });
});

test("Blockly map adapter preserves Python revisions and signs the same three-map bundle", async () => {
  await withPlatform(async ({ origin, observed }) => {
    const mapsResult = await request(origin, "/blockly/api/maps", { headers: { cookie: "role=user" } });
    assert.equal(mapsResult.status, 200);
    const maps = parsed(mapsResult).maps;
    assert.equal(maps.length, 3);
    assert.equal(maps[0].taskId, "GYI-PRIMARY-01");
    assert.equal(maps[0].sourceTaskId, "R2-GYI-MVP-01");
    assert.equal(maps[0].variantId, "map-01");
    assert.deepEqual(maps.map(map => map.variantId), ["map-01", "map-10", "map-11"]);
    assert.equal(maps[0].revision, 0);
    assert.equal(maps[0].layout.schemaVersion, "chenlong.guangyang-map-layout/v2");
    assert.deepEqual(Object.keys(maps[0]).sort(), ["digest", "layout", "revision", "sourceTaskId", "taskId", "updatedAt", "variantId"].sort());

    const asset = await request(origin, "/blockly/app.js?v=20260828-010");
    assert.equal(asset.status, 200);
    assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.ok(asset.headers.etag);
    const headers = observed.blocklyHeaders.at(-1);
    assert.equal(headers[contract.PRINCIPAL_HEADER], undefined);
    assert.equal(headers[contract.MAP_BUNDLE_HEADER], undefined);
    assert.match(asset.body.toString(), /\/blockly\/api\/maps/);
    assert.match(asset.body.toString(), /\/blockly\/admin\.html/);

    const cachedAsset = await request(origin, "/blockly/app.js?v=20260828-010", {
      headers: { "if-none-match": asset.headers.etag }
    });
    assert.equal(cachedAsset.status, 304);
    assert.equal(cachedAsset.body.length, 0);

    const headAsset = await request(origin, "/blockly/app.js?v=20260828-010", { method: "HEAD" });
    assert.equal(headAsset.status, 200);
    assert.equal(Number(headAsset.headers["content-length"]), asset.body.length);
    assert.equal(headAsset.body.length, 0);

    const unversionedAsset = await request(origin, "/blockly/app.js");
    assert.equal(unversionedAsset.headers["cache-control"], "public, max-age=3600, must-revalidate");
  });
});

test("Blockly static pages do not perform identity or map lookups", async () => {
  await withPlatform(async ({ origin, observed }) => {
    const result = await request(origin, "/blockly/admin.html", { headers: { cookie: "role=admin" } });
    assert.equal(result.status, 200);
    const headers = observed.blocklyHeaders.at(-1);
    assert.equal(headers[contract.PRINCIPAL_HEADER], undefined);
    assert.equal(headers[contract.MAP_BUNDLE_HEADER], undefined);
  });
});

test("Blockly legacy login paths return to the central login instead of exposing a second account system", async () => {
  await withPlatform(async ({ origin }) => {
    const result = await request(origin, "/blockly/login.html");
    assert.equal(result.status, 302);
    assert.equal(result.headers.location, "/login.html?returnTo=%2Fblockly%2F");
  });
});

test("Python unauthenticated deep links retain their mounted path through the central login", async () => {
  await withPlatform(async ({ origin }) => {
    const cases = [
      ["/python/", "/login.html?returnTo=%2Fpython%2F"],
      ["/python/index.html", "/login.html?returnTo=%2Fpython%2Findex.html"],
      ["/python/admin.html", "/login.html?returnTo=%2Fpython%2Fadmin.html"],
      [
        "/python/records.html?task=1",
        "/login.html?returnTo=%2Fpython%2Frecords.html%3Ftask%3D1"
      ]
    ];
    for (const [requestPath, expectedLocation] of cases) {
      const result = await request(origin, requestPath);
      assert.equal(result.status, 302, requestPath);
      assert.equal(result.headers.location, expectedLocation, requestPath);
    }
  });
  assert.equal(
    platform.rewriteLocation("/login.html?returnTo=%2Fpython%2Frecords.html", "python"),
    "/login.html?returnTo=%2Fpython%2Frecords.html",
    "an already mounted returnTo must not be prefixed twice"
  );
});

test("Blockly record writes receive the participant principal and exact signed map bundle", async () => {
  await withPlatform(async ({ origin, observed }) => {
    const result = await request(origin, "/blockly/api/records", {
      method: "POST",
      headers: { cookie: "role=user", origin, "content-type": "application/json" },
      body: Buffer.from("{}")
    });
    assert.equal(result.status, 200);
    const headers = observed.blocklyHeaders.at(-1);
    assert.equal(contract.verifyPrincipal(headers[contract.PRINCIPAL_HEADER], SECRET, "blockly").user.teamId, TEAM_ID);
    assert.deepEqual(contract.verifyMapBundle(headers[contract.MAP_BUNDLE_HEADER], SECRET).maps.map(map => map.variantId), ["map-01", "map-10", "map-11"]);
  });
});

test("configured HTTPS platform Origin is preserved through Blockly record writes", async () => {
  const publicOrigin = "https://contest.example.test";
  await withPlatform(async ({ origin, observed }) => {
    const result = await request(origin, "/blockly/api/records", {
      method: "POST",
      headers: { cookie: "role=user", origin: publicOrigin, "content-type": "application/json" },
      body: Buffer.from("{}")
    });
    assert.equal(result.status, 200);
    assert.equal(observed.blocklyHeaders.at(-1).origin, publicOrigin);
  }, { publicOrigin });
});

test("unified user management is admin-only and rewrites safe PATCH origins", async () => {
  await withPlatform(async ({ origin, observed, pythonOrigin }) => {
    const denied = await request(origin, "/api/platform/admin/users", { headers: { cookie: "role=user" } });
    assert.equal(denied.status, 403);
    const users = await request(origin, "/api/platform/admin/users", { headers: { cookie: "role=admin" } });
    assert.equal(users.status, 200);
    assert.equal(parsed(users).users.find(user => user.id === USER.id).teamId, TEAM_ID);
    const updated = await request(origin, `/api/platform/admin/users/${USER.id}`, {
      method: "PATCH",
      headers: { cookie: "role=admin", origin, "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ teamName: "新队名", group: "junior" }))
    });
    assert.equal(updated.status, 200);
    assert.equal(observed.pythonOrigins.at(-1), pythonOrigin);
  });
});

test("configured HTTPS platform Origin is preserved through administrator updates", async () => {
  const publicOrigin = "https://contest.example.test";
  await withPlatform(async ({ origin, observed }) => {
    const updated = await request(origin, `/api/platform/admin/users/${USER.id}`, {
      method: "PATCH",
      headers: { cookie: "role=admin", origin: publicOrigin, "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ teamName: "新队名", group: "primary" }))
    });
    assert.equal(updated.status, 200);
    assert.equal(observed.pythonOrigins.at(-1), publicOrigin);
  }, { publicOrigin });
});

test("Workshop proxy injects an audience-bound platform principal", async () => {
  await withPlatform(async ({ origin, observed }) => {
    const result = await request(origin, "/api/competition/me", { headers: { cookie: "role=user" } });
    assert.equal(result.status, 200);
    const header = observed.workshopHeaders.at(-1)[contract.PRINCIPAL_HEADER];
    assert.equal(contract.verifyPrincipal(header, SECRET, "workshop").user.id, USER.id);
    assert.throws(() => contract.verifyPrincipal(header, SECRET, "blockly"));
  });
});

test("Workshop writes discard external proxy metadata before the local same-origin check", async () => {
  const publicOrigin = "https://contest.example.test";
  await withPlatform(async ({ origin, observed, workshopOrigin }) => {
    const result = await request(origin, "/api/competition/submissions", {
      method: "POST",
      headers: {
        cookie: "role=user",
        origin: publicOrigin,
        "content-type": "application/json",
        forwarded: "for=203.0.113.7;proto=https;host=contest.example.test",
        "x-forwarded-for": "203.0.113.7",
        "x-forwarded-host": "contest.example.test",
        "x-forwarded-proto": "https",
        "cf-connecting-ip": "203.0.113.7"
      },
      body: Buffer.from("{}")
    });
    assert.equal(result.status, 200);
    const forwarded = observed.workshopHeaders.at(-1);
    assert.equal(forwarded.origin, workshopOrigin);
    for (const name of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "cf-connecting-ip"]) {
      assert.equal(forwarded[name], undefined);
    }
  }, { publicOrigin });
});

test("unauthenticated Workshop pages redirect to central login while Workshop APIs keep JSON 401", async () => {
  await withPlatform(async ({ origin, observed }) => {
    observed.pythonAuthenticated = false;
    const page = await request(origin, "/workshop/competition?tab=rules");
    assert.equal(page.status, 302);
    assert.equal(page.headers.location,
      "/login.html?returnTo=%2Fworkshop%2Fcompetition%3Ftab%3Drules");
    assert.equal(page.body.length, 0);

    const api = await request(origin, "/api/competition/me");
    assert.equal(api.status, 401);
    assert.equal(api.headers.location, undefined);
    assert.match(api.headers["content-type"], /application\/json/);
    assert.deepEqual(parsed(api), {
      schemaVersion: "chenlong.competition-platform/v1",
      authoritative: false,
      error: { code: "AUTHENTICATION_REQUIRED", message: "请先登录统一比赛平台。" }
    });
    assert.equal(observed.workshopHeaders.length, 0,
      "unauthenticated page and API requests must not reach Workshop");
  });
});

test("Workshop root opens the training studio and keeps submission as its next step", async () => {
  await withPlatform(async ({ origin, observed }) => {
    const result = await request(origin, "/workshop/", { headers: { cookie: "role=user" } });
    assert.equal(result.status, 200);
    const html = result.body.toString("utf8");
    assert.match(html, /橙子识别比赛训练台/);
    assert.match(html, /href="\/workshop\/competition"/);
    assert.match(html, /href="\/portal\.html"/);
    const header = observed.workshopHeaders.at(-1)[contract.PRINCIPAL_HEADER];
    assert.equal(contract.verifyPrincipal(header, SECRET, "workshop").user.id, USER.id);
  });
});

test("Workshop Vinext assets bypass per-file identity lookups and never expose /@fs", async () => {
  await withPlatform(async ({ origin, observed, workshopOrigin }) => {
    const paths = [
      "/app/globals.css",
      "/@id/__x00__virtual:vite-rsc/entry-browser",
      "/@vite/client",
      "/@react-refresh",
      "/node_modules/vite/dist/client/env.mjs",
      "/favicon.svg"
    ];
    for (const assetPath of paths) {
      const result = await request(origin, assetPath, {
        headers: { cookie: "role=user", origin }
      });
      assert.equal(result.status, 200, assetPath);
      const forwarded = observed.workshopHeaders.at(-1);
      assert.equal(forwarded[contract.PRINCIPAL_HEADER], undefined,
        "public static assets must not carry participant identity");
      assert.equal(forwarded.origin, workshopOrigin,
        "browser module requests must look same-origin to Vinext instead of exposing the tunnel origin");
    }
    assert.equal(observed.pythonMeRequests, 0,
      "loading static assets must not call the account service once per file");

    assert.equal(platform.isWorkshopAssetPath("/@fs/D:/private.txt"), false);
    assert.equal(platform.isWorkshopAssetPath("/appish/not-an-asset.js"), false);
    const blocked = await request(origin, "/@fs/D:/private.txt", { headers: { cookie: "role=user" } });
    assert.equal(blocked.status, 404);
  });
});

test("Python and Blockly navigation preserve the unified platform root link", () => {
  const source = Buffer.from('<a href="/portal.html">返回统一平台</a><a href="/admin.html">管理后台</a>');
  const python = platform.rewriteTextBody(source, "python", "text/html; charset=utf-8").toString("utf8");
  const blockly = platform.rewriteTextBody(source, "blockly", "text/html; charset=utf-8").toString("utf8");
  assert.match(python, /href="\/portal\.html"/);
  assert.match(python, /href="\/python\/admin\.html"/);
  assert.doesNotMatch(python, /\/python\/python\//);
  assert.match(blockly, /href="\/portal\.html"/);
  assert.match(blockly, /href="\/blockly\/admin\.html"/);
  assert.doesNotMatch(blockly, /\/blockly\/blockly\//);
});

test("Workshop rewriting keeps unified root links and prefixes its competition route exactly once", () => {
  const source = Buffer.from('<a href="/competition">工坊</a><a href="/portal.html">平台</a><script>const link={href:`/competition`,query:`/competition?tab=1`,hash:`/competition#rules`,dynamic:`/competition${suffix}`}</script><script src="/_next/app.js"></script>');
  const output = platform.rewriteTextBody(source, "workshop", "text/html; charset=utf-8").toString("utf8");
  assert.match(output, /href="\/workshop\/competition"/);
  assert.match(output, /href:`\/workshop\/competition`/);
  assert.match(output, /query:`\/workshop\/competition\?tab=1`/);
  assert.match(output, /hash:`\/workshop\/competition#rules`/);
  assert.match(output, /dynamic:`\/workshop\/competition\$\{suffix\}`/);
  assert.match(output, /href="\/portal\.html"/);
  assert.match(output, /src="\/_next\/app\.js"/);
  assert.doesNotMatch(output, /\/workshop\/workshop\//);
  assert.equal(platform.rewriteLocation("/portal.html", "workshop"), "/portal.html");
  assert.equal(platform.rewriteLocation("/competition", "workshop"), "/workshop/competition");
  assert.equal(platform.rewriteLocation("/workshop/competition", "workshop"), "/workshop/competition");
});

test("admin overview chooses the better Python or Blockly task score, adds workshop, and pages 15 teams", async () => {
  await withPlatform(async ({ origin }) => {
    const first = await request(origin, "/api/platform/admin/overview?page=1", { headers: { cookie: "role=admin" } });
    assert.equal(first.status, 200);
    const payload = parsed(first);
    assert.equal(payload.pagination.pageSize, 15);
    assert.equal(payload.pagination.total, 16);
    assert.equal(payload.pagination.unfilteredTotal, 16);
    assert.equal(payload.teams.length, 15);
    const team = payload.teams.find(item => item.teamName === USER.teamName);
    assert.equal(team.taskScores.task1, 95);
    assert.equal(team.taskScores.task2, 90);
    assert.equal(team.taskScores.task3, null);
    assert.equal(team.workshopScore, 88);
    assert.equal(team.totalScore, 68);
    assert.deepEqual(team.maps.map(map => map.variantNumber), [1, 2, 3]);
    const second = parsed(await request(origin, "/api/platform/admin/overview?page=2", { headers: { cookie: "role=admin" } }));
    assert.equal(second.teams.length, 1);

    const primary = parsed(await request(origin, "/api/platform/admin/overview?page=1&group=primary", { headers: { cookie: "role=admin" } }));
    assert.equal(primary.pagination.total, 6);
    assert.equal(primary.pagination.unfilteredTotal, 16);
    assert.equal(primary.teams.every(item => item.group === "primary"), true);
    const junior = parsed(await request(origin, "/api/platform/admin/overview?page=1&group=junior", { headers: { cookie: "role=admin" } }));
    assert.equal(junior.pagination.total, 5);
    assert.equal(junior.teams.every(item => item.group === "junior"), true);
    const invalid = await request(origin, "/api/platform/admin/overview?group=unknown", { headers: { cookie: "role=admin" } });
    assert.equal(invalid.status, 400);
    assert.equal(parsed(invalid).error.code, "ADMIN_OVERVIEW_INVALID_GROUP");
  });
});

test("admin total-score CSV exports an explicit Chinese group column", async () => {
  await withPlatform(async ({ origin }) => {
    const result = await request(origin, "/api/platform/admin/export", { headers: { cookie: "role=admin" } });
    assert.equal(result.status, 200);
    assert.match(result.headers["content-type"], /text\/csv/);
    const csv = result.body.toString("utf8");
    assert.equal(csv.startsWith('\uFEFF"队伍名称","分组","任务1"'), true);
    assert.match(csv, /"小学组"/u);
    assert.match(csv, /"初中组"/u);
    assert.match(csv, /"高中组"/u);
    assert.doesNotMatch(csv, /,"(?:primary|junior|high)",/);
  });
});

test("admin total uses the same integer contribution rounding as the official score package", () => {
  const taskScores = { task1: 66, task2: 66, task3: 66 };
  assert.deepEqual(officialScores.scoreContributions(taskScores, 66), {
    score_task1: 50,
    score_task2: 17,
    total_score: 67
  });
  assert.equal(platform.combinedScore(taskScores, 66), 67,
    "198 programming points plus 66 workshop points must not display 66 in admin while exporting 67");
});

test("admin overview uses a stable Python best-score aggregate when raw history exceeds 20,000 records", async () => {
  await withPlatform(async ({ origin, observed }) => {
    observed.pythonRecordTotal = 25_001;
    const result = await request(origin, "/api/platform/admin/overview", { headers: { cookie: "role=admin" } });
    assert.equal(result.status, 200);
    const team = parsed(result).teams.find(item => item.teamName === USER.teamName);
    assert.equal(team.taskScores.task1, 99,
      "the best-score aggregate must include the historical maximum");
    assert.deepEqual(observed.pythonRecordRequests, [], "the unified overview must not scan raw Python history");
    assert.deepEqual(observed.pythonAggregateRequests, [
      "/api/v1/admin/team-task-scores"
    ]);
  });
});

test("admin aggregation keeps 2,000 teams and all three programming maxima without raw-history growth", () => {
  const teamCount = 2_000;
  const users = Array.from({ length: teamCount }, (_, index) => ({
    id: `usr_scale_${index}`,
    username: `scale_${index}`,
    displayName: `规模用户${index}`,
    teamName: `规模队伍${index}`,
    group: ["primary", "junior", "high"][index % 3],
    role: "user"
  }));
  const assignments = users.map((user, index) => ({
    teamId: `tea_scale_${index}`,
    teamName: user.teamName,
    members: [{ userId: user.id }],
    maps: []
  }));
  const pythonRecords = users.flatMap((user, index) => [1, 2, 3].map(task => ({
    ownerUserId: user.id,
    teamId: `tea_scale_${index}`,
    recordState: "submitted",
    taskId: `R2-GYI-MVP-0${task}`,
    score: 80 + task
  })));
  const blocklyRecords = users.flatMap((user, index) => [1, 2, 3].map(task => ({
    ownerUserId: user.id,
    teamId: `tea_scale_${index}`,
    recordState: "submitted",
    taskId: `GYI-PRIMARY-0${task}`,
    score: 90 + task
  })));
  const rows = platform.buildAdminRows({
    users,
    assignments,
    pythonRecords,
    blocklyRecords,
    workshopOverview: { leaderboards: {} }
  });
  assert.equal(rows.length, teamCount);
  assert.deepEqual(rows[0].taskScores, { task1: 91, task2: 92, task3: 93 });
  assert.equal(rows[0].totalScore, 69);
  assert.equal(platform.paginate(rows, 134).items.length, 5);
});

test("admin overview uses one Blockly team-task aggregate when raw history exceeds 20,000 records", async () => {
  await withPlatform(async ({ origin, observed }) => {
    observed.blocklyRecordTotal = 30_001;
    const result = await request(origin, "/api/platform/admin/overview", { headers: { cookie: "role=admin" } });
    assert.equal(result.status, 200);
    const team = parsed(result).teams.find(item => item.teamName === USER.teamName);
    assert.equal(team.taskScores.task3, 100,
      "the team-task aggregate must include the historical maximum");
    assert.deepEqual(observed.blocklyRecordRequests, [], "the unified overview must not scan raw Blockly history");
    assert.deepEqual(observed.blocklyAggregateRequests, ["/api/admin/team-task-scores"]);
  });
});

test("admin overview and CSV fail closed instead of reporting false zeroes when a score source is unavailable", async () => {
  await withPlatform(async ({ origin, observed }) => {
    observed.blocklyAdminStatus = 503;
    const overview = await request(origin, "/api/platform/admin/overview", { headers: { cookie: "role=admin" } });
    assert.equal(overview.status, 503);
    assert.equal(parsed(overview).error.code, "UPSTREAM_UNAVAILABLE");
    const csv = await request(origin, "/api/platform/admin/export", { headers: { cookie: "role=admin" } });
    assert.equal(csv.status, 503);
    assert.equal(parsed(csv).error.code, "UPSTREAM_UNAVAILABLE");

    observed.blocklyAdminStatus = 200;
    observed.workshopAdminStatus = 503;
    const workshopFailure = await request(origin, "/api/platform/admin/overview", { headers: { cookie: "role=admin" } });
    assert.equal(workshopFailure.status, 503);
    assert.equal(parsed(workshopFailure).error.code, "UPSTREAM_UNAVAILABLE");
  });
});

test("score helpers are stable for missing items and CSV-safe aggregation inputs", () => {
  assert.deepEqual(platform.mergeTaskScores(
    { task1: 80, task2: null, task3: 50 },
    { task1: 70, task2: 90, task3: null }
  ), { task1: 80, task2: 90, task3: 50 });
  assert.equal(platform.combinedScore({ task1: 80, task2: 90, task3: 50 }, null), 55);
  assert.deepEqual(platform.paginate(Array.from({ length: 31 }, (_, index) => index), 3), {
    page: 3, pageSize: 15, total: 31, totalPages: 3, items: [30]
  });
});
