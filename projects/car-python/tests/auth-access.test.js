"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
  DeterministicSimulator,
  createSession: createCompetitionSession
} = require("../competition-core.js");
const {
  AUTH_STORE_SCHEMA_VERSION,
  DEFAULT_PARTICIPANT_GROUP,
  PARTICIPANT_GROUP_VALUES,
  AuthStore
} = require("../backend/auth-store.js");
const { LOCAL_CHALLENGES, createServer } = require("../server.js");
const { calculateSsoSignature } = require("../backend/official-sso.js");

const AUTH_SCHEMA_VERSION = "chenlong.auth/v1";
const TASK_ID = "R2-GYI-MVP-01";
const PASSWORD = "Correct-Horse-Battery-2026!";

function collectResponse(response, resolve, reject) {
  const chunks = [];
  response.on("data", chunk => chunks.push(chunk));
  response.once("error", reject);
  response.once("end", () => resolve({
    statusCode: response.statusCode,
    headers: response.headers,
    body: Buffer.concat(chunks)
  }));
}

function request(origin, { method = "GET", requestPath = "/", headers = {}, body } = {}) {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const clientRequest = http.request({
      hostname: target.hostname,
      port: target.port,
      method,
      path: requestPath,
      headers: { Connection: "close", ...headers }
    }, response => collectResponse(response, resolve, reject));
    clientRequest.once("error", reject);
    clientRequest.end(body);
  });
}

function jsonRequest(origin, {
  method = "POST",
  requestPath,
  value = {},
  cookie,
  requestOrigin = origin,
  headers = {}
}) {
  const body = Buffer.from(JSON.stringify(value));
  return request(origin, {
    method,
    requestPath,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      ...(requestOrigin === null ? {} : { Origin: requestOrigin }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
    },
    body
  });
}

function parseJson(response) {
  assert.match(response.headers["content-type"] || "", /^application\/json\b/i);
  return JSON.parse(response.body.toString("utf8"));
}

function assertApiError(response, statusCode, code) {
  assert.equal(response.statusCode, statusCode, response.body.toString("utf8"));
  const payload = parseJson(response);
  assert.equal(payload.status, "error");
  assert.equal(payload.error?.code, code);
  return payload;
}

function setCookieLines(response) {
  const value = response.headers["set-cookie"];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function sessionCookie(response) {
  const line = setCookieLines(response).find(value => /^chenlong_session=/i.test(value));
  assert.ok(line, "response must set the chenlong_session cookie");
  const pair = line.split(";", 1)[0];
  assert.match(pair, /^chenlong_session=[A-Za-z0-9_-]+$/);
  return { line, pair, token: pair.slice(pair.indexOf("=") + 1) };
}

async function temporaryDataDir(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chenlong-auth-test-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.match(path.basename(resolved), /^chenlong-auth-test-/);
    await fs.promises.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

async function startServer(t, options = {}) {
  const dataDir = options.dataDir || await temporaryDataDir(t);
  const server = createServer({ ...options, dataDir });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { origin: `http://127.0.0.1:${address.port}`, dataDir, server };
}

test("official SSO creates an HttpOnly session, redirects, hides IDs publicly, and rejects replay", async t => {
  const now = 1_800_000_000_000;
  const secret = "official-server-test-secret-32-bytes";
  const { origin } = await startServer(t, {
    officialSsoSecret: secret,
    officialSsoNow: () => now,
    allowInsecureOfficialSsoForTests: true
  });
  const adminResponse = await register(origin, "official_admin", { teamName: "管理队" });
  const adminCookie = sessionCookie(adminResponse);
  const parameters = {
    user_id: "website-user-1",
    team_id: "website-team-1",
    group_type: "primary_high",
    team_name: "官网代表队",
    timestamp: String(Math.floor(now / 1000))
  };
  parameters.sign = calculateSsoSignature(parameters, secret);
  const requestPath = `/api/v1/auth/sso/jump?${new URLSearchParams(parameters)}`;
  const jumped = await request(origin, { requestPath });
  assert.equal(jumped.statusCode, 302);
  assert.equal(jumped.headers.location, "/portal.html");
  const participantCookie = sessionCookie(jumped);
  assert.match(participantCookie.line, /HttpOnly/i);
  assert.match(participantCookie.line, /SameSite=Lax/i);

  const me = parseJson(await request(origin, {
    requestPath: "/api/v1/auth/me",
    headers: { Cookie: participantCookie.pair }
  }));
  assert.equal(me.user.teamName, "官网代表队");
  assert.equal(me.user.group, "primary", "legacy primary_high SSO input must be stored canonically");
  assert.equal("officialUserId" in me.user, false);
  const adminUsers = parseJson(await request(origin, {
    requestPath: "/api/v1/admin/users",
    headers: { Cookie: adminCookie.pair }
  }));
  const external = adminUsers.users.find(user => user.id === me.user.id);
  assert.equal(external.officialUserId, "website-user-1");
  assert.equal(external.officialTeamId, "website-team-1");

  const replay = await request(origin, { requestPath });
  assert.equal(replay.statusCode, 409);
  assert.match(replay.body.toString("utf8"), /1005/);
});

test("official SSO refuses browser-driven team reassignment and audits the exact policy reason", async t => {
  const now = 1_800_000_050_000;
  const secret = "official-team-binding-secret-32-bytes";
  const { origin, server } = await startServer(t, {
    officialSsoSecret: secret,
    officialSsoNow: () => now,
    allowInsecureOfficialSsoForTests: true
  });
  await register(origin, "official_binding_admin", { teamName: "绑定管理队" });
  const jumpPath = ({ teamId, teamName, group }) => {
    const parameters = {
      user_id: "website-bound-user",
      team_id: teamId,
      group_type: group,
      team_name: teamName,
      timestamp: String(Math.floor(now / 1000))
    };
    parameters.sign = calculateSsoSignature(parameters, secret);
    return `/api/v1/auth/sso/jump?${new URLSearchParams(parameters)}`;
  };
  const first = await request(origin, {
    requestPath: jumpPath({ teamId: "website-team-a", teamName: "官网甲队", group: "primary_high" })
  });
  assert.equal(first.statusCode, 302, first.body.toString("utf8"));

  const reassignment = await request(origin, {
    requestPath: jumpPath({ teamId: "website-team-b", teamName: "官网乙队", group: "junior" })
  });
  assert.equal(reassignment.statusCode, 403, reassignment.body.toString("utf8"));
  assert.match(reassignment.body.toString("utf8"), /错误码：1004/);
  const bound = (await server.authStore.listAdminUsers())
    .find(user => user.officialUserId === "website-bound-user");
  assert.equal(bound.officialTeamId, "website-team-a");
  assert.equal(bound.teamName, "官网甲队");
  assert.equal(bound.group, "primary");

  const auditLines = (await fs.promises.readFile(server.officialSsoReplayStore.auditPath, "utf8"))
    .trim().split("\n").map(line => JSON.parse(line));
  const rejected = auditLines.find(entry => entry.result === "failure" && entry.code === "1004");
  assert.equal(rejected?.detail, "OFFICIAL_TEAM_REASSIGNMENT_REQUIRES_ADMIN");
});

test("official SSO fails closed without HTTPS and Secure cookies outside explicit test mode", async t => {
  const dataDir = await temporaryDataDir(t);
  assert.throws(
    () => createServer({ dataDir, officialSsoSecret: "official-fail-closed-secret-32-bytes" }),
    /HTTPS publicOrigin and secureCookies=true/
  );
  assert.throws(
    () => createServer({
      dataDir,
      officialSsoSecret: "official-fail-closed-secret-32-bytes",
      publicOrigin: "http://contest.example.test",
      secureCookies: true
    }),
    /HTTPS publicOrigin and secureCookies=true/
  );
});

test("official SSO audit storage failure does not turn a committed login into an error page", async t => {
  const now = 1_800_000_100_000;
  const secret = "official-audit-failure-secret-32-bytes";
  const { origin, server } = await startServer(t, {
    officialSsoSecret: secret,
    officialSsoNow: () => now,
    allowInsecureOfficialSsoForTests: true
  });
  await register(origin, "official_audit_admin", { teamName: "审计管理队" });
  await server.officialSsoReplayStore.ready;
  server.officialSsoReplayStore.audit = async () => {
    const error = new Error("injected audit disk failure");
    error.code = "ENOSPC";
    throw error;
  };
  const parameters = {
    user_id: "website-audit-user",
    team_id: "website-audit-team",
    group_type: "junior",
    team_name: "审计故障队",
    timestamp: String(Math.floor(now / 1000))
  };
  parameters.sign = calculateSsoSignature(parameters, secret);
  const jumped = await request(origin, {
    requestPath: `/api/v1/auth/sso/jump?${new URLSearchParams(parameters)}`
  });
  assert.equal(jumped.statusCode, 302, jumped.body.toString("utf8"));
  const cookie = sessionCookie(jumped);
  const me = parseJson(await request(origin, {
    requestPath: "/api/v1/auth/me",
    headers: { Cookie: cookie.pair }
  }));
  assert.equal(me.user.teamName, "审计故障队");
});

test("official SSO rate limit is bounded per client IP and returns Retry-After", async t => {
  const now = 1_800_000_200_000;
  const secret = "official-rate-limit-secret-32-bytes";
  const { origin } = await startServer(t, {
    officialSsoSecret: secret,
    officialSsoNow: () => now,
    allowInsecureOfficialSsoForTests: true,
    maxOfficialSsoAttempts: 2,
    maxOfficialSsoAttemptsPerIp: 1
  });
  await register(origin, "official_limit_admin", { teamName: "限流管理队" });
  const signedPath = suffix => {
    const parameters = {
      user_id: `website-limit-user-${suffix}`,
      team_id: `website-limit-team-${suffix}`,
      group_type: "high",
      team_name: `限流队${suffix}`,
      timestamp: String(Math.floor(now / 1000))
    };
    parameters.sign = calculateSsoSignature(parameters, secret);
    return `/api/v1/auth/sso/jump?${new URLSearchParams(parameters)}`;
  };
  assert.equal((await request(origin, { requestPath: signedPath("a") })).statusCode, 302);
  const limited = await request(origin, { requestPath: signedPath("b") });
  assert.equal(limited.statusCode, 429, limited.body.toString("utf8"));
  assert.match(String(limited.headers["retry-after"]), /^\d+$/);
  assert.match(limited.body.toString("utf8"), /错误码：1004/);
});

async function register(origin, username, {
  password = PASSWORD,
  displayName,
  teamName = username,
  group = DEFAULT_PARTICIPANT_GROUP,
  requestOrigin = origin
} = {}) {
  const value = { username, password, teamName, group };
  if (displayName !== undefined) value.displayName = displayName;
  return jsonRequest(origin, {
    requestPath: "/api/v1/auth/register",
    value,
    requestOrigin
  });
}

async function login(origin, username, { password = PASSWORD, requestOrigin = origin } = {}) {
  return jsonRequest(origin, {
    requestPath: "/api/v1/auth/login",
    value: { username, password },
    requestOrigin
  });
}

async function registerUser(origin, username, options = {}) {
  const response = await register(origin, username, options);
  assert.equal(response.statusCode, 201, response.body.toString("utf8"));
  const payload = parseJson(response);
  assert.equal(payload.schemaVersion, AUTH_SCHEMA_VERSION);
  assert.equal(payload.authenticated, true);
  assert.equal(payload.user?.username, username);
  if (payload.user?.role === "admin") {
    assert.equal(payload.user.teamName, null);
    assert.equal(payload.user.group, null);
  } else {
    assert.ok(PARTICIPANT_GROUP_VALUES.includes(payload.user?.group));
  }
  return { response, payload, cookie: sessionCookie(response) };
}

async function readAllFileText(root) {
  const chunks = [];
  async function visit(directory) {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile() && !entry.isSymbolicLink()) chunks.push(await fs.promises.readFile(filePath, "utf8"));
    }
  }
  await visit(root);
  return chunks.join("\n");
}

function assertNoSecrets(value, forbiddenStrings = []) {
  const sensitiveKey = /^(?:password|passwordHash|submitToken|submitTokenHash|sessionToken|sessionTokenHash|tokenHash|secret)$/i;
  function visit(item) {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      assert.equal(sensitiveKey.test(key), false, `response leaked sensitive field ${key}`);
      visit(child);
    }
  }
  visit(value);
  const encoded = JSON.stringify(value);
  forbiddenStrings.filter(Boolean).forEach(secret => assert.equal(encoded.includes(secret), false, "response leaked a credential"));
}

function competitionSessionFields(payload) {
  const envelope = payload;
  const session = payload.session || payload;
  return {
    id: session.sessionId || session.id,
    runId: session.runId,
    teamId: session.teamId,
    challenge: session.challenge,
    challengeDigest: session.challengeDigest,
    runDefinition: envelope.runDefinition || session.runDefinition,
    mapConfig: envelope.mapConfig || session.mapConfig,
    submitToken: payload.submitToken || session.submitToken
  };
}

async function createArchivedSession(origin, cookie, teamId) {
  const response = await jsonRequest(origin, {
    requestPath: "/api/v1/sessions",
    cookie,
    value: { taskId: TASK_ID }
  });
  assert.equal(response.statusCode, 201, response.body.toString("utf8"));
  const session = competitionSessionFields(parseJson(response));
  assert.match(session.id, /^ses_[a-f0-9]{32}$/);
  assert.match(session.teamId, /^tea_[a-f0-9]{32}$/);
  assert.match(session.submitToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.prototype.hasOwnProperty.call(session.challenge, "runDefinition"), false);
  assert.equal(typeof session.runDefinition?.simulationDefinition, "object");
  assert.equal(typeof session.runDefinition?.interactionDefinition, "object");
  return session;
}

function recordForSession(session, sourceCode = "car.stop()", {
  navigationSensorMethods = [],
  roadControlMethods = []
} = {}) {
  // Normal Guangyang sessions now freeze the exact public map definition at
  // the top level; historical fixtures may still lack it.
  const runDefinition = session.runDefinition || LOCAL_CHALLENGES[TASK_ID].runDefinition;
  const frozenChallenge = {
    ...session.challenge,
    task: runDefinition.taskDefinition,
    rules: runDefinition.ruleDefinition,
    scoring: runDefinition.scoringDefinition
  };
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
  const pose = runDefinition.simulationDefinition.initialPose;
  competitionSession.sample({
    tick: 0,
    x: pose.x,
    z: pose.z,
    heading: pose.heading,
    speed: 0,
    steering: 0
  }, { forceRecord: true });
  navigationSensorMethods.forEach(method => competitionSession.addNavigationQuery(method));
  if (roadControlMethods.length) {
    const simulator = new DeterministicSimulator(runDefinition.simulationDefinition);
    roadControlMethods.forEach(method => {
      if (method === "follow_road") {
        competitionSession.runNavigationControl(simulator, method, { maxCm: 10, speed: 10 });
      } else {
        competitionSession.runNavigationControl(simulator, method, { roadId: "parking-connector" });
      }
    });
  }
  return competitionSession.finish("program_finished");
}

async function submitRecord(origin, cookie, session, {
  requestOrigin = origin,
  sourceCode = "car.stop()",
  navigationSensorMethods = [],
  roadControlMethods = []
} = {}) {
  const body = Buffer.from(JSON.stringify(recordForSession(session, sourceCode, {
    navigationSensorMethods,
    roadControlMethods
  })));
  return request(origin, {
    method: "POST",
    requestPath: `/api/v1/sessions/${encodeURIComponent(session.id)}/submissions`,
    headers: {
      Origin: requestOrigin,
      Cookie: cookie,
      Authorization: `Bearer ${session.submitToken}`,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length
    },
    body
  });
}

async function saveDraftRecord(origin, cookie, session, {
  requestOrigin = origin,
  sourceCode = "car.stop()",
  navigationSensorMethods = [],
  roadControlMethods = []
} = {}) {
  const body = Buffer.from(JSON.stringify(recordForSession(session, sourceCode, {
    navigationSensorMethods,
    roadControlMethods
  })));
  return request(origin, {
    method: "POST",
    requestPath: `/api/v1/sessions/${encodeURIComponent(session.id)}/drafts`,
    headers: {
      Origin: requestOrigin,
      Cookie: cookie,
      Authorization: `Bearer ${session.submitToken}`,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length
    },
    body
  });
}

function recordItems(payload) {
  const value = payload.records || payload.items || payload.submissions;
  assert.ok(Array.isArray(value), "record list response must contain an array");
  return value;
}

function recordId(value) {
  return value?.submissionId || value?.id || value?.submission?.submissionId;
}

test("register, me, logout, and login use an opaque hardened cookie without persisting plaintext credentials", async t => {
  const { origin, dataDir } = await startServer(t);
  const registered = await registerUser(origin, "first-admin", { displayName: "First Admin" });
  assert.equal(registered.payload.user.displayName, "First Admin");
  assert.equal(registered.payload.user.teamName, null);
  assert.equal(registered.payload.user.group, null);
  assert.equal(registered.payload.user.role, "admin");
  assert.match(registered.cookie.line, /;\s*HttpOnly(?:;|$)/i);
  assert.match(registered.cookie.line, /;\s*SameSite=Strict(?:;|$)/i);
  assert.match(registered.cookie.line, /;\s*Path=\/(?:;|$)/i);
  assert.doesNotMatch(registered.cookie.line, /;\s*Secure(?:;|$)/i);
  assertNoSecrets(registered.payload, [PASSWORD, registered.cookie.token]);

  const me = await request(origin, {
    requestPath: "/api/v1/auth/me",
    headers: { Cookie: registered.cookie.pair }
  });
  assert.equal(me.statusCode, 200, me.body.toString("utf8"));
  const mePayload = parseJson(me);
  assert.equal(mePayload.schemaVersion, AUTH_SCHEMA_VERSION);
  assert.equal(mePayload.authenticated, true);
  assert.equal(mePayload.user?.username, "first-admin");
  assert.equal(mePayload.user?.teamName, null);
  assert.equal(mePayload.user?.group, null);
  assert.equal(mePayload.user?.role, "admin");
  assert.match(mePayload.session?.expiresAt || "", /^\d{4}-\d{2}-\d{2}T/);
  assertNoSecrets(mePayload, [PASSWORD, registered.cookie.token]);

  const loggedOut = await jsonRequest(origin, {
    requestPath: "/api/v1/auth/logout",
    cookie: registered.cookie.pair,
    value: {}
  });
  assert.equal(loggedOut.statusCode, 200, loggedOut.body.toString("utf8"));
  const cleared = setCookieLines(loggedOut).join("\n");
  assert.match(cleared, /^chenlong_session=/im);
  assert.match(cleared, /(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
  assertApiError(await request(origin, {
    requestPath: "/api/v1/auth/me",
    headers: { Cookie: registered.cookie.pair }
  }), 401, "AUTHENTICATION_REQUIRED");

  const loggedIn = await login(origin, "first-admin");
  assert.equal(loggedIn.statusCode, 200, loggedIn.body.toString("utf8"));
  const loggedInPayload = parseJson(loggedIn);
  const loginCookie = sessionCookie(loggedIn);
  assert.equal(loggedInPayload.user?.role, "admin");
  assert.equal(loggedInPayload.user?.teamName, null);
  assert.equal(loggedInPayload.user?.group, null);
  assertNoSecrets(loggedInPayload, [PASSWORD, loginCookie.token]);

  assertApiError(await request(origin, {
    requestPath: "/api/v1/auth/team-invite",
    headers: { Cookie: loginCookie.pair }
  }), 403, "TEAM_INVITE_UNAVAILABLE");

  const storedText = await readAllFileText(dataDir);
  assert.equal(storedText.includes(PASSWORD), false, "plaintext passwords must never be persisted");
  assert.equal(storedText.includes(registered.cookie.token), false, "raw session cookies must never be persisted");
  assert.equal(storedText.includes(loginCookie.token), false, "raw replacement session cookies must never be persisted");
});

test("a public HTTPS deployment may explicitly admit its matching local loopback workbench without weakening public cookies", async t => {
  const publicOrigin = "https://training.example.test";
  const { origin } = await startServer(t, {
    publicOrigin,
    secureCookies: true,
    allowLoopbackOrigin: true
  });

  const local = await registerUser(origin, "local-workbench", { teamName: "本机联调队" });
  assert.doesNotMatch(local.cookie.line, /;\s*Secure(?:;|$)/i,
    "the explicit HTTP loopback workbench must receive a cookie it can return");

  const publicUser = await registerUser(origin, "public-workbench", {
    teamName: "公网联调队",
    requestOrigin: publicOrigin
  });
  assert.match(publicUser.cookie.line, /;\s*Secure(?:;|$)/i,
    "the configured public HTTPS origin must retain a Secure cookie");

  const mismatchedLoopback = await register(origin, "wrong-loopback-host", {
    teamName: "错误本机来源队",
    requestOrigin: origin.replace("127.0.0.1", "localhost")
  });
  assertApiError(mismatchedLoopback, 403, "CROSS_ORIGIN_REQUEST");

  const unrelatedOrigin = await register(origin, "unrelated-origin", {
    teamName: "错误外部来源队",
    requestOrigin: "https://untrusted.example.test"
  });
  assertApiError(unrelatedOrigin, 403, "CROSS_ORIGIN_REQUEST");
});

test("registration requires a normalized visible team name and returns it from every authentication view", async t => {
  const { origin } = await startServer(t);
  await registerUser(origin, "team-contract-admin");
  const base = { username: "team-contract", password: PASSWORD, group: DEFAULT_PARTICIPANT_GROUP };

  assertApiError(await jsonRequest(origin, {
    requestPath: "/api/v1/auth/register",
    value: base
  }), 400, "INVALID_TEAM_NAME");
  assertApiError(await jsonRequest(origin, {
    requestPath: "/api/v1/auth/register",
    value: { ...base, teamName: "   " }
  }), 400, "INVALID_TEAM_NAME");
  assertApiError(await jsonRequest(origin, {
    requestPath: "/api/v1/auth/register",
    value: { ...base, teamName: "队".repeat(65) }
  }), 400, "INVALID_TEAM_NAME");
  assertApiError(await jsonRequest(origin, {
    requestPath: "/api/v1/auth/register",
    value: { ...base, teamName: "辰龙\u0000队" }
  }), 400, "INVALID_TEAM_NAME");

  const registered = await registerUser(origin, "normalized-team", {
    displayName: "队长",
    teamName: "  Cafe\u0301 辰龙队  "
  });
  assert.equal(registered.payload.user.teamName, "Café 辰龙队");

  const me = await request(origin, {
    requestPath: "/api/v1/auth/me",
    headers: { Cookie: registered.cookie.pair }
  });
  assert.equal(parseJson(me).user?.teamName, "Café 辰龙队");

  const loggedIn = await login(origin, "normalized-team");
  assert.equal(loggedIn.statusCode, 200, loggedIn.body.toString("utf8"));
  assert.equal(parseJson(loggedIn).user?.teamName, "Café 辰龙队");
});

test("teams use a unique name and an invite code, while public identity never leaks the internal team credential", async t => {
  const { origin, dataDir } = await startServer(t);
  await registerUser(origin, "team-bootstrap-admin");
  const leader = await registerUser(origin, "team-leader", {
    teamName: "  星河探索队  ",
    group: "junior"
  });
  const inviteCode = leader.payload.teamInviteCode;
  assert.match(inviteCode, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(leader.payload.user.teamName, "星河探索队");

  const duplicate = await register(origin, "team-duplicate", {
    teamName: "星河探索队",
    group: "junior"
  });
  assertApiError(duplicate, 409, "TEAM_NAME_TAKEN");

  const joined = await jsonRequest(origin, {
    requestPath: "/api/v1/auth/register",
    value: {
      username: "team-member",
      password: PASSWORD,
      group: "high",
      teamAction: "join",
      inviteCode
    }
  });
  assert.equal(joined.statusCode, 201, joined.body.toString("utf8"));
  const joinedPayload = parseJson(joined);
  assert.equal(joinedPayload.teamInviteCode, undefined);
  assert.equal(joinedPayload.user?.teamName, "星河探索队");
  assert.equal(joinedPayload.user?.group, "junior",
    "joining an existing team must inherit that team's competition group");

  const leaderSession = await createArchivedSession(origin, leader.cookie.pair);
  const memberSession = await createArchivedSession(origin, sessionCookie(joined).pair);
  assert.equal(memberSession.teamId, leaderSession.teamId,
    "team members must receive the same immutable competition participant identity");

  const leaderInvite = await request(origin, {
    requestPath: "/api/v1/auth/team-invite",
    headers: { Cookie: leader.cookie.pair }
  });
  assert.equal(leaderInvite.statusCode, 200, leaderInvite.body.toString("utf8"));
  assert.deepEqual(parseJson(leaderInvite), {
    schemaVersion: "chenlong.team-invite/v1",
    teamName: "星河探索队",
    inviteCode,
    authoritative: false
  });

  const memberInvite = await request(origin, {
    requestPath: "/api/v1/auth/team-invite",
    headers: { Cookie: sessionCookie(joined).pair }
  });
  assert.equal(memberInvite.statusCode, 200, memberInvite.body.toString("utf8"));
  assert.equal(parseJson(memberInvite).inviteCode, inviteCode,
    "every logged-in member of a team may retrieve the same team invite code");
  assertApiError(await request(origin, { requestPath: "/api/v1/auth/team-invite" }), 401, "AUTHENTICATION_REQUIRED");
  const inviteMethod = await request(origin, {
    method: "POST",
    requestPath: "/api/v1/auth/team-invite",
    headers: { Cookie: leader.cookie.pair }
  });
  assertApiError(inviteMethod, 405, "METHOD_NOT_ALLOWED");
  assert.equal(inviteMethod.headers.allow, "GET");
  assertApiError(await request(origin, {
    requestPath: "/api/v1/auth/team-invite?extra=1",
    headers: { Cookie: leader.cookie.pair }
  }), 400, "TEAM_INVITE_INVALID_QUERY");

  assertApiError(await jsonRequest(origin, {
    requestPath: "/api/v1/auth/register",
    value: {
      username: "team-wrong-code",
      password: PASSWORD,
      group: DEFAULT_PARTICIPANT_GROUP,
      teamAction: "join",
      inviteCode: "ABCDEFGH"
    }
  }), 404, "TEAM_INVITE_NOT_FOUND");

  const me = await request(origin, {
    requestPath: "/api/v1/auth/me",
    headers: { Cookie: leader.cookie.pair }
  });
  const mePayload = parseJson(me);
  assert.equal(JSON.stringify(mePayload).includes(inviteCode), false);
  assert.equal(JSON.stringify(joinedPayload.user).includes(inviteCode), false);

  const persisted = JSON.parse(await fs.promises.readFile(path.join(dataDir, "auth", "auth-store.json"), "utf8"));
  assert.equal(persisted.teams.length, 2);
  const storedLeader = persisted.users.find(user => user.username === "team-leader");
  const storedMember = persisted.users.find(user => user.username === "team-member");
  assert.ok(storedLeader && storedMember);
  assert.equal(storedLeader.teamId, storedMember.teamId);
  assert.equal(persisted.teams.find(team => team.id === storedLeader.teamId)?.inviteCode, inviteCode);
});

test("registration requires exactly one frozen participant group and returns it from register, me, login, and public lookup", async t => {
  const { origin, server } = await startServer(t);
  const base = {
    username: "group-contract",
    password: PASSWORD,
    teamName: "分组契约队"
  };
  for (const group of [undefined, null, "", "primary_low", "primary_high", " primary ", "PRIMARY", 1]) {
    const value = { ...base };
    if (group !== undefined) value.group = group;
    assertApiError(await jsonRequest(origin, {
      requestPath: "/api/v1/auth/register",
      value
    }), 400, "INVALID_GROUP");
  }

  await registerUser(origin, "group-bootstrap-admin");

  for (const [index, group] of PARTICIPANT_GROUP_VALUES.entries()) {
    const username = `group-user-${index}`;
    const registered = await registerUser(origin, username, {
      teamName: `分组测试队${index + 1}`,
      group
    });
    assert.equal(registered.payload.user.group, group);
    assert.deepEqual(Object.keys(registered.payload.user).sort(), [
      "createdAt", "displayName", "group", "id", "role", "teamName", "username"
    ]);

    const me = await request(origin, {
      requestPath: "/api/v1/auth/me",
      headers: { Cookie: registered.cookie.pair }
    });
    assert.equal(parseJson(me).user?.group, group);

    const loggedIn = await login(origin, username);
    assert.equal(loggedIn.statusCode, 200, loggedIn.body.toString("utf8"));
    assert.equal(parseJson(loggedIn).user?.group, group);

    const publicUser = await server.authStore.getPublicUser(registered.payload.user.id);
    assert.equal(publicUser?.group, group);
    assert.deepEqual(Object.keys(publicUser || {}).sort(), [
      "createdAt", "displayName", "group", "id", "role", "teamName", "username"
    ]);
  }
});

test("v1 authentication stores migrate old accounts to a one-person primary-school team", async t => {
  const dataDir = await temporaryDataDir(t);
  const rootDir = path.join(dataDir, "auth-migration");
  const original = new AuthStore({ rootDir });
  await original.ready;
  await original.register({
    username: "legacy-account",
    password: PASSWORD,
    displayName: "旧账户",
    teamName: "迁移前测试队",
    group: "high"
  });

  const storePath = path.join(rootDir, "auth-store.json");
  const legacy = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
  legacy.schemaVersion = "chenlong.auth-store/v1";
  legacy.users = legacy.users.map(({ teamId: _teamId, teamName: _teamName, group: _group, ...user }) => user);
  delete legacy.teams;
  await fs.promises.writeFile(storePath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

  const migratedStore = new AuthStore({ rootDir });
  await migratedStore.ready;
  const authenticated = await migratedStore.login({ username: "legacy-account", password: PASSWORD });
  assert.equal(authenticated.user.teamName, null);
  assert.equal(authenticated.user.group, null);
  assert.equal(authenticated.user.username, "legacy-account");

  const migrated = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
  assert.equal(migrated.schemaVersion, AUTH_STORE_SCHEMA_VERSION);
  assert.equal(migrated.users[0].teamName, "legacy-account");
  assert.match(migrated.users[0].teamId, /^tea_[a-f0-9]{32}$/);
  assert.equal(migrated.teams.length, 1);
  assert.equal(migrated.users[0].group, DEFAULT_PARTICIPANT_GROUP);
  assert.equal(migrated.revision, legacy.revision + 2,
    "migration and replacement login session must each advance the durable revision");
});

test("v2 authentication stores migrate every existing account into the primary-school group", async t => {
  const dataDir = await temporaryDataDir(t);
  const rootDir = path.join(dataDir, "auth-v2-migration");
  const original = new AuthStore({ rootDir });
  await original.ready;
  const registered = await original.register({
    username: "team-era-account",
    password: PASSWORD,
    displayName: "旧版队伍账户",
    teamName: "已有队伍名",
    group: "high"
  });

  const storePath = path.join(rootDir, "auth-store.json");
  const previous = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
  const v2 = {
    ...previous,
    schemaVersion: "chenlong.auth-store/v2",
    users: previous.users.map(({ teamId: _teamId, group: _group, ...user }) => user)
  };
  delete v2.teams;
  await fs.promises.writeFile(storePath, `${JSON.stringify(v2, null, 2)}\n`, { mode: 0o600 });

  const migratedStore = new AuthStore({ rootDir });
  await migratedStore.ready;
  const authenticated = await migratedStore.authenticate(registered.token);
  assert.equal(authenticated.user.teamName, null);
  assert.equal(authenticated.user.group, null);

  const migrated = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
  assert.equal(migrated.schemaVersion, AUTH_STORE_SCHEMA_VERSION);
  assert.equal(migrated.revision, v2.revision + 1);
  assert.equal(migrated.users[0].group, DEFAULT_PARTICIPANT_GROUP);
});

test("current authentication stores fail closed when a persisted participant group is missing or unknown", async t => {
  const dataDir = await temporaryDataDir(t);
  for (const [name, mutate] of [
    ["missing", user => { delete user.group; }],
    ["unknown", user => { user.group = "university"; }]
  ]) {
    const rootDir = path.join(dataDir, `auth-invalid-group-${name}`);
    const original = new AuthStore({ rootDir });
    await original.ready;
    await original.register({
      username: `invalid-group-${name}`,
      password: PASSWORD,
      displayName: "严格持久化测试",
      teamName: "严格持久化队",
      group: DEFAULT_PARTICIPANT_GROUP
    });
    const storePath = path.join(rootDir, "auth-store.json");
    const stored = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
    mutate(stored.users[0]);
    await fs.promises.writeFile(storePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });

    const corrupted = new AuthStore({ rootDir });
    await assert.rejects(corrupted.ready, error => {
      assert.equal(error?.code, "AUTH_STORE_CORRUPTED");
      return true;
    });
  }
});

test("duplicate usernames and incorrect passwords fail without issuing a session", async t => {
  const { origin } = await startServer(t);
  await registerUser(origin, "unique-user");

  const duplicate = await register(origin, "unique-user");
  assertApiError(duplicate, 409, "USERNAME_TAKEN");
  assert.equal(setCookieLines(duplicate).length, 0);

  const incorrect = await login(origin, "unique-user", { password: "Definitely-Wrong-Password!" });
  assertApiError(incorrect, 401, "INVALID_CREDENTIALS");
  assert.equal(setCookieLines(incorrect).length, 0);
});

test("authentication sessions expire at their configured boundary", async t => {
  let now = Date.parse("2026-08-19T00:00:00.000Z");
  const { origin } = await startServer(t, { authSessionTtlMs: 1000, now: () => now });
  const registered = await registerUser(origin, "expiring-user");

  now += 999;
  const beforeBoundary = await request(origin, {
    requestPath: "/api/v1/auth/me",
    headers: { Cookie: registered.cookie.pair }
  });
  assert.equal(beforeBoundary.statusCode, 200, beforeBoundary.body.toString("utf8"));

  now += 1;
  const expired = await request(origin, {
    requestPath: "/api/v1/auth/me",
    headers: { Cookie: registered.cookie.pair }
  });
  assertApiError(expired, 401, "AUTHENTICATION_REQUIRED");
});

test("cross-origin state changes are rejected and cannot mutate authentication or competition state", async t => {
  const { origin } = await startServer(t);
  const maliciousOrigin = "https://attacker.invalid";

  const crossOriginRegistration = await register(origin, "csrf-target", { requestOrigin: maliciousOrigin });
  assertApiError(crossOriginRegistration, 403, "CROSS_ORIGIN_REQUEST");
  assert.equal(setCookieLines(crossOriginRegistration).length, 0);

  const registered = await registerUser(origin, "csrf-target");
  const crossOriginLogin = await login(origin, "csrf-target", { requestOrigin: maliciousOrigin });
  assertApiError(crossOriginLogin, 403, "CROSS_ORIGIN_REQUEST");
  assert.equal(setCookieLines(crossOriginLogin).length, 0);

  const rejectedSession = await jsonRequest(origin, {
    requestPath: "/api/v1/sessions",
    cookie: registered.cookie.pair,
    requestOrigin: maliciousOrigin,
    value: { taskId: TASK_ID }
  });
  assertApiError(rejectedSession, 403, "CROSS_ORIGIN_REQUEST");

  const session = await createArchivedSession(origin, registered.cookie.pair, "csrf-team");
  const rejectedSubmission = await submitRecord(origin, registered.cookie.pair, session, {
    requestOrigin: maliciousOrigin
  });
  assertApiError(rejectedSubmission, 403, "CROSS_ORIGIN_REQUEST");
  const recordsAfterRejectedWrite = await request(origin, {
    requestPath: "/api/v1/records",
    headers: { Cookie: registered.cookie.pair }
  });
  assert.equal(recordsAfterRejectedWrite.statusCode, 200, recordsAfterRejectedWrite.body.toString("utf8"));
  assert.deepEqual(recordItems(parseJson(recordsAfterRejectedWrite)), []);

  const crossOriginLogout = await jsonRequest(origin, {
    requestPath: "/api/v1/auth/logout",
    cookie: registered.cookie.pair,
    requestOrigin: maliciousOrigin,
    value: {}
  });
  assertApiError(crossOriginLogout, 403, "CROSS_ORIGIN_REQUEST");

  const stillAuthenticated = await request(origin, {
    requestPath: "/api/v1/auth/me",
    headers: { Cookie: registered.cookie.pair }
  });
  assert.equal(stillAuthenticated.statusCode, 200, stillAuthenticated.body.toString("utf8"));

  const wrongMethod = await request(origin, {
    requestPath: "/api/v1/auth/logout",
    headers: { Cookie: registered.cookie.pair }
  });
  assert.equal(wrongMethod.statusCode, 405, wrongMethod.body.toString("utf8"));
});

test("login stays public while simulation pages and competition archives require authentication", async t => {
  const { origin } = await startServer(t);
  for (const publicPath of ["/login.html", "/auth.js"]) {
    const response = await request(origin, { requestPath: publicPath });
    assert.equal(response.statusCode, 200, `${publicPath}: ${response.body.toString("utf8")}`);
  }

  for (const protectedPath of ["/", "/index.html", "/records.html", "/admin.html"]) {
    const response = await request(origin, { requestPath: protectedPath });
    assert.equal(response.statusCode, 302, `${protectedPath}: ${response.body.toString("utf8")}`);
    assert.match(response.headers.location || "", /^\/login\.html(?:\?returnTo=|$)/);
  }

  const unauthenticatedCreate = await jsonRequest(origin, {
    requestPath: "/api/v1/sessions",
    value: { taskId: TASK_ID }
  });
  assertApiError(unauthenticatedCreate, 401, "AUTHENTICATION_REQUIRED");

  assertApiError(await request(origin, {
    requestPath: "/api/v1/sessions/ses_00000000000000000000000000000000",
    headers: { Authorization: `Bearer ${"x".repeat(43)}` }
  }), 401, "AUTHENTICATION_REQUIRED");
  assertApiError(await request(origin, { requestPath: "/api/v1/records" }), 401, "AUTHENTICATION_REQUIRED");

  const admin = await registerUser(origin, "page-admin");
  const simulation = await request(origin, {
    requestPath: "/",
    headers: { Cookie: admin.cookie.pair }
  });
  assert.equal(simulation.statusCode, 200, simulation.body.toString("utf8"));

  const user = await registerUser(origin, "page-user");
  const deniedAdminPage = await request(origin, {
    requestPath: "/admin.html",
    headers: { Cookie: user.cookie.pair }
  });
  assert.equal(deniedAdminPage.statusCode, 403, deniedAdminPage.body.toString("utf8"));
  const allowedAdminPage = await request(origin, {
    requestPath: "/admin.html",
    headers: { Cookie: admin.cookie.pair }
  });
  assert.equal(allowedAdminPage.statusCode, 200, allowedAdminPage.body.toString("utf8"));
});

test("users can only read their own records while administrators can inspect all records without secrets", async t => {
  const { origin, server } = await startServer(t);
  const admin = await registerUser(origin, "records-admin");
  const alice = await registerUser(origin, "records-alice", { teamName: "辰龙甲队" });
  const bob = await registerUser(origin, "records-bob", { teamName: "辰龙乙队" });
  assert.equal(alice.payload.user.role, "user");
  assert.equal(bob.payload.user.role, "user");

  const aliceSession = await createArchivedSession(origin, alice.cookie.pair, "alice-team");
  const aliceSubmitted = await submitRecord(origin, alice.cookie.pair, aliceSession);
  assert.equal(aliceSubmitted.statusCode, 201, aliceSubmitted.body.toString("utf8"));
  const aliceReceipt = parseJson(aliceSubmitted);
  const aliceSubmissionId = recordId(aliceReceipt);
  assert.match(aliceSubmissionId, /^sub_[a-f0-9]{32}$/);

  const aliceSecondSession = await createArchivedSession(origin, alice.cookie.pair, "alice-team");
  const aliceSecondSubmitted = await submitRecord(origin, alice.cookie.pair, aliceSecondSession, {
    sourceCode: "car.stop()\n# second archive"
  });
  assert.equal(aliceSecondSubmitted.statusCode, 201, aliceSecondSubmitted.body.toString("utf8"));
  const aliceSecondSubmissionId = recordId(parseJson(aliceSecondSubmitted));
  assert.notEqual(aliceSecondSubmissionId, aliceSubmissionId);

  const bobSession = await createArchivedSession(origin, bob.cookie.pair, "bob-team");
  const bobSubmitted = await submitRecord(origin, bob.cookie.pair, bobSession);
  assert.equal(bobSubmitted.statusCode, 201, bobSubmitted.body.toString("utf8"));
  const bobReceipt = parseJson(bobSubmitted);
  const bobSubmissionId = recordId(bobReceipt);
  assert.match(bobSubmissionId, /^sub_[a-f0-9]{32}$/);

  const originalReadSubmission = server.submissionStore.readSubmission.bind(server.submissionStore);
  const originalReadRecord = server.submissionStore.readRecord.bind(server.submissionStore);
  let fullSubmissionReads = 0;
  let recordReads = 0;
  server.submissionStore.readSubmission = async (...args) => {
    fullSubmissionReads += 1;
    return originalReadSubmission(...args);
  };
  server.submissionStore.readRecord = async (...args) => {
    recordReads += 1;
    return originalReadRecord(...args);
  };

  const aliceListResponse = await request(origin, {
    requestPath: "/api/v1/records",
    headers: { Cookie: alice.cookie.pair }
  });
  assert.equal(aliceListResponse.statusCode, 200, aliceListResponse.body.toString("utf8"));
  const aliceListPayload = parseJson(aliceListResponse);
  const aliceRecords = recordItems(aliceListPayload);
  assert.equal(aliceRecords.some(item => recordId(item) === aliceSubmissionId), true);
  assert.equal(aliceRecords.some(item => recordId(item) === aliceSecondSubmissionId), true);
  assert.equal(aliceRecords.some(item => recordId(item) === bobSubmissionId), false);
  assert.ok(aliceRecords.every(item => /^[a-f0-9]{64}$/.test(item.recordSha256 || "")));
  assert.ok(aliceRecords.every(item => Number.isSafeInteger(item.recordByteLength) && item.recordByteLength > 0));
  assert.ok(aliceRecords.every(item => item.verification?.status === "verified"));
  assert.ok(aliceRecords.every(item => item.user?.teamName === "辰龙甲队"));
  assert.ok(aliceRecords.every(item => item.verification?.verificationScope?.deterministic?.status === "complete"));
  assert.ok(aliceRecords.every(item => item.verification?.visionStatus === "not_used"));
  assert.ok(aliceRecords.every(item => Array.isArray(item.verification?.reasonCodes)));
  assert.ok(aliceRecords.every(item => !Object.hasOwn(item.verification, "replay")
    && !Object.hasOwn(item.verification, "record")
    && !Object.hasOwn(item.verification, "source")),
  "record-list verification summaries must not expose the full report or raw record metadata");

  const aliceLatestResponse = await request(origin, {
    requestPath: "/api/v1/records?limit=1",
    headers: { Cookie: alice.cookie.pair }
  });
  assert.equal(aliceLatestResponse.statusCode, 200, aliceLatestResponse.body.toString("utf8"));
  const aliceLatestRecords = recordItems(parseJson(aliceLatestResponse));
  assert.equal(aliceLatestRecords.length, 1);
  assert.equal(recordId(aliceLatestRecords[0]), recordId(aliceRecords[0]));
  for (const invalidLimit of ["0", "-1", "2.5", "1&limit=2", "1001"]) {
    assertApiError(await request(origin, {
      requestPath: `/api/v1/records?limit=${invalidLimit}`,
      headers: { Cookie: alice.cookie.pair }
    }), 400, "RECORDS_INVALID_LIMIT");
  }

  const bobListResponse = await request(origin, {
    requestPath: "/api/v1/records",
    headers: { Cookie: bob.cookie.pair }
  });
  assert.equal(bobListResponse.statusCode, 200, bobListResponse.body.toString("utf8"));
  const bobListPayload = parseJson(bobListResponse);
  const bobRecords = recordItems(bobListPayload);
  assert.ok(bobRecords.every(item => item.user?.teamName === "辰龙乙队"));
  assert.equal(bobRecords.some(item => recordId(item) === bobSubmissionId), true);
  assert.equal(bobRecords.some(item => recordId(item) === aliceSubmissionId), false);
  assert.equal(fullSubmissionReads, 0, "record lists must not read complete archived run-record files");

  const crossUserRead = await request(origin, {
    requestPath: `/api/v1/records/${encodeURIComponent(aliceSubmissionId)}`,
    headers: { Cookie: bob.cookie.pair }
  });
  assert.ok([403, 404].includes(crossUserRead.statusCode), crossUserRead.body.toString("utf8"));

  const crossUserSessionRead = await request(origin, {
    requestPath: `/api/v1/sessions/${encodeURIComponent(aliceSession.id)}`,
    headers: {
      Cookie: bob.cookie.pair,
      Authorization: `Bearer ${aliceSession.submitToken}`
    }
  });
  assert.ok([403, 404].includes(crossUserSessionRead.statusCode), crossUserSessionRead.body.toString("utf8"));
  assert.ok(
    ["SESSION_OWNER_MISMATCH", "SESSION_NOT_FOUND"].includes(parseJson(crossUserSessionRead).error?.code),
    crossUserSessionRead.body.toString("utf8")
  );
  const crossUserSubmission = await submitRecord(origin, bob.cookie.pair, aliceSession);
  assert.ok([403, 404].includes(crossUserSubmission.statusCode), crossUserSubmission.body.toString("utf8"));
  assert.ok(
    ["SESSION_OWNER_MISMATCH", "SESSION_NOT_FOUND"].includes(parseJson(crossUserSubmission).error?.code),
    crossUserSubmission.body.toString("utf8")
  );

  assertApiError(await request(origin, {
    requestPath: "/api/v1/admin/records",
    headers: { Cookie: alice.cookie.pair }
  }), 403, "ADMIN_REQUIRED");

  const aliceDraftSession = await createArchivedSession(origin, alice.cookie.pair, "runtime-only-team-id");
  const aliceDraftResponse = await saveDraftRecord(origin, alice.cookie.pair, aliceDraftSession, {
    sourceCode: "car.stop()\n# saved but not submitted"
  });
  assert.equal(aliceDraftResponse.statusCode, 201, aliceDraftResponse.body.toString("utf8"));
  const aliceDraftId = parseJson(aliceDraftResponse).recordId;

  const originalListRecords = server.submissionStore.listRecords.bind(server.submissionStore);
  let adminListOptions = null;
  server.submissionStore.listRecords = async options => {
    if (options?.includeAll) adminListOptions = { ...options };
    return originalListRecords(options);
  };

  const fullSubmissionReadsBeforeAdminList = fullSubmissionReads;
  const adminListResponse = await request(origin, {
    requestPath: "/api/v1/admin/records",
    headers: { Cookie: admin.cookie.pair }
  });
  assert.equal(adminListResponse.statusCode, 200, adminListResponse.body.toString("utf8"));
  const adminPayload = parseJson(adminListResponse);
  const allRecords = recordItems(adminPayload);
  assert.deepEqual(adminListOptions, {
    includeAll: true,
    expectedScope: "single",
    recordState: "submitted",
    includeCapabilityUsage: true,
    includeAutonomyMode: true,
    limit: 1000
  });
  assert.equal(allRecords.some(item => recordId(item) === aliceSubmissionId), true);
  assert.equal(allRecords.some(item => recordId(item) === bobSubmissionId), true);
  assert.equal(allRecords.some(item => recordId(item) === aliceDraftId), false);
  assert.ok(allRecords.every(item => item.recordState === "submitted"));
  assert.equal(allRecords.find(item => recordId(item) === aliceSubmissionId)?.user?.teamName, "辰龙甲队");
  assert.equal(allRecords.find(item => recordId(item) === bobSubmissionId)?.user?.teamName, "辰龙乙队");
  assert.equal(
    fullSubmissionReads,
    fullSubmissionReadsBeforeAdminList,
    "administrator record lists must not read complete archived run-record files"
  );
  const adminDraftDetail = await request(origin, {
    requestPath: `/api/v1/admin/records/${encodeURIComponent(aliceDraftId)}`,
    headers: { Cookie: admin.cookie.pair }
  });
  assertApiError(adminDraftDetail, 404, "RECORD_NOT_FOUND");
  assertApiError(await request(origin, {
    requestPath: "/api/v1/admin/records?scope=ranked",
    headers: { Cookie: admin.cookie.pair }
  }), 400, "RECORDS_INVALID_PAGE");
  const submissionReadsBeforeDetail = fullSubmissionReads;

  const aliceDetailResponse = await request(origin, {
    requestPath: `/api/v1/records/${encodeURIComponent(aliceSubmissionId)}`,
    headers: { Cookie: alice.cookie.pair }
  });
  assert.equal(aliceDetailResponse.statusCode, 200, aliceDetailResponse.body.toString("utf8"));
  const aliceDetailPayload = parseJson(aliceDetailResponse);
  assert.equal(aliceDetailPayload.record.verification.verificationScope.deterministic.status, "complete");
  assert.equal(aliceDetailPayload.record.verification.visionStatus, "not_used");
  assert.equal(aliceDetailPayload.sourceCode, "car.stop()",
    "personal record details must include the exact archived Python source");
  assert.equal(
    fullSubmissionReads,
    submissionReadsBeforeDetail + 3,
    "record detail must retain full archived-record integrity verification across the owner's sessions"
  );
  const aliceReplayRecordResponse = await request(origin, {
    requestPath: `/api/v1/records/${encodeURIComponent(aliceSubmissionId)}/run-record`,
    headers: { Cookie: alice.cookie.pair }
  });
  assert.equal(aliceReplayRecordResponse.statusCode, 200, aliceReplayRecordResponse.body.toString("utf8"));
  assert.match(aliceReplayRecordResponse.headers["content-type"] || "", /^application\/json\b/i);
  assert.match(aliceReplayRecordResponse.headers["cache-control"] || "", /no-store/);
  assert.match(aliceReplayRecordResponse.headers["x-content-sha256"] || "", /^[a-f0-9]{64}$/);
  const replayDigest = crypto.createHash("sha256").update(aliceReplayRecordResponse.body).digest("hex");
  assert.equal(aliceReplayRecordResponse.headers["x-content-sha256"], replayDigest);
  assert.equal(aliceRecords.find(item => recordId(item) === aliceSubmissionId)?.recordSha256, replayDigest);
  const aliceReplayRecord = JSON.parse(aliceReplayRecordResponse.body.toString("utf8"));
  assert.equal(aliceReplayRecord.runId, aliceSession.runId);
  assert.equal(aliceReplayRecord.serverSessionId, aliceSession.id);
  assert.equal(recordReads, 1, "the replay endpoint must read and hash the archived run record exactly once");
  assert.equal(
    fullSubmissionReads,
    submissionReadsBeforeDetail + 3,
    "the replay lookup must not pre-read the complete run record"
  );

  const crossUserReplayRecord = await request(origin, {
    requestPath: `/api/v1/records/${encodeURIComponent(aliceSubmissionId)}/run-record`,
    headers: { Cookie: bob.cookie.pair }
  });
  assert.equal(crossUserReplayRecord.statusCode, 404, crossUserReplayRecord.body.toString("utf8"));
  assertApiError(await request(origin, {
    requestPath: `/api/v1/records/${encodeURIComponent(aliceSubmissionId)}/run-record`
  }), 401, "AUTHENTICATION_REQUIRED");

  const adminDetailResponse = await request(origin, {
    requestPath: `/api/v1/admin/records/${encodeURIComponent(bobSubmissionId)}`,
    headers: { Cookie: admin.cookie.pair }
  });
  assert.equal(adminDetailResponse.statusCode, 200, adminDetailResponse.body.toString("utf8"));
  assert.equal(parseJson(adminDetailResponse).sourceCode, "car.stop()",
    "administrator record details must expose the exact archived Python source for review");

  for (const requestPath of [
    `/api/v1/sessions/${encodeURIComponent(aliceSession.id)}`,
    `/api/v1/sessions/${encodeURIComponent(aliceSession.id)}/submissions/${encodeURIComponent(aliceSubmissionId)}`,
    `/api/v1/sessions/${encodeURIComponent(aliceSession.id)}/submissions/${encodeURIComponent(aliceSubmissionId)}/record`
  ]) {
    const adminArchiveRead = await request(origin, {
      requestPath,
      headers: { Cookie: admin.cookie.pair }
    });
    assert.equal(adminArchiveRead.statusCode, 200, `${requestPath}: ${adminArchiveRead.body.toString("utf8")}`);
  }

  const cookies = [admin.cookie.token, alice.cookie.token, bob.cookie.token];
  [aliceListPayload, bobListPayload, adminPayload, aliceDetailPayload, parseJson(adminDetailResponse)]
    .forEach(payload => assertNoSecrets(payload, [PASSWORD, ...cookies, aliceSession.submitToken, bobSession.submitToken]));

  const anonymousSubmissionRead = await request(origin, {
    requestPath: `/api/v1/sessions/${encodeURIComponent(aliceSession.id)}/submissions/${encodeURIComponent(aliceSubmissionId)}`,
    headers: { Authorization: `Bearer ${aliceSession.submitToken}` }
  });
  assertApiError(anonymousSubmissionRead, 401, "AUTHENTICATION_REQUIRED");
  const anonymousSubmission = await submitRecord(origin, "", aliceSession);
  assertApiError(anonymousSubmission, 401, "AUTHENTICATION_REQUIRED");
});

test("administrators can list users and edit only team and group through a strict serialized API", async t => {
  const { origin, dataDir } = await startServer(t);
  const admin = await registerUser(origin, "users-admin", {
    displayName: "Administrator Alias",
    teamName: "管理队"
  });
  const alice = await registerUser(origin, "users-alice", {
    displayName: "Alice Alias",
    teamName: "原甲队",
    group: "primary"
  });
  const bob = await registerUser(origin, "users-bob", {
    displayName: "Bob Alias",
    teamName: "原乙队",
    group: "junior"
  });
  const aliceSession = await createArchivedSession(origin, alice.cookie.pair, "ignored-client-team");
  const aliceSubmission = await submitRecord(origin, alice.cookie.pair, aliceSession);
  assert.equal(aliceSubmission.statusCode, 201, aliceSubmission.body.toString("utf8"));
  const aliceSubmissionId = recordId(parseJson(aliceSubmission));

  assertApiError(await request(origin, { requestPath: "/api/v1/admin/users" }), 401, "AUTHENTICATION_REQUIRED");
  assertApiError(await request(origin, {
    requestPath: "/api/v1/admin/users",
    headers: { Cookie: alice.cookie.pair }
  }), 403, "ADMIN_REQUIRED");
  assertApiError(await request(origin, {
    requestPath: "/api/v1/admin/users?limit=1",
    headers: { Cookie: admin.cookie.pair }
  }), 400, "ADMIN_USERS_INVALID_QUERY");

  const usersResponse = await request(origin, {
    requestPath: "/api/v1/admin/users",
    headers: { Cookie: admin.cookie.pair }
  });
  assert.equal(usersResponse.statusCode, 200, usersResponse.body.toString("utf8"));
  const usersPayload = parseJson(usersResponse);
  assert.deepEqual(Object.keys(usersPayload).sort(), ["authoritative", "schemaVersion", "users"]);
  assert.equal(usersPayload.schemaVersion, "chenlong.admin-users/v1");
  assert.equal(usersPayload.authoritative, false);
  assert.equal(usersPayload.users.length, 3);
  for (const user of usersPayload.users) {
    assert.deepEqual(Object.keys(user).sort(), [
      "createdAt", "displayName", "group", "id", "officialTeamId", "officialUserId", "role", "teamName", "username"
    ]);
    assert.equal(user.officialUserId, null);
    assert.equal(user.officialTeamId, null);
  }
  assertNoSecrets(usersPayload, [PASSWORD, admin.cookie.token, alice.cookie.token, bob.cookie.token]);
  const administrator = usersPayload.users.find(user => user.id === admin.payload.user.id);
  assert.equal(administrator?.teamName, null);
  assert.equal(administrator?.group, null);

  const alicePath = `/api/v1/admin/users/${alice.payload.user.id}`;
  const absentPath = "/api/v1/admin/users/usr_00000000000000000000000000000000";
  for (const requestPath of [alicePath, absentPath]) {
    assertApiError(await jsonRequest(origin, {
      method: "PATCH",
      requestPath,
      cookie: bob.cookie.pair,
      value: { teamName: "越权队", group: "high" }
    }), 403, "ADMIN_REQUIRED");
  }
  assertApiError(await jsonRequest(origin, {
    method: "PATCH",
    requestPath: alicePath,
    cookie: admin.cookie.pair,
    requestOrigin: "https://attacker.invalid",
    value: { teamName: "跨域队", group: "high" }
  }), 403, "CROSS_ORIGIN_REQUEST");
  assertApiError(await request(origin, {
    method: "PATCH",
    requestPath: alicePath,
    headers: {
      Cookie: admin.cookie.pair,
      Origin: origin,
      "Content-Type": "text/plain",
      "Content-Length": "2"
    },
    body: Buffer.from("{}")
  }), 415, "UNSUPPORTED_MEDIA_TYPE");
  const wrongMethod = await jsonRequest(origin, {
    method: "PUT",
    requestPath: alicePath,
    cookie: admin.cookie.pair,
    value: { teamName: "错误动词", group: "high" }
  });
  assertApiError(wrongMethod, 405, "METHOD_NOT_ALLOWED");
  assert.equal(wrongMethod.headers.allow, "PATCH");
  for (const value of [
    { teamName: "缺分组" },
    { group: "high" }
  ]) {
    assertApiError(await jsonRequest(origin, {
      method: "PATCH",
      requestPath: alicePath,
      cookie: admin.cookie.pair,
      value
    }), 400, "ADMIN_USER_UPDATE_MISSING_FIELD");
  }
  assertApiError(await jsonRequest(origin, {
    method: "PATCH",
    requestPath: alicePath,
    cookie: admin.cookie.pair,
    value: { teamName: "多字段", group: "high", role: "admin" }
  }), 400, "ADMIN_USER_UPDATE_UNKNOWN_FIELD");
  assertApiError(await jsonRequest(origin, {
    method: "PATCH",
    requestPath: alicePath,
    cookie: admin.cookie.pair,
    value: { teamName: "   ", group: "high" }
  }), 400, "INVALID_TEAM_NAME");
  assertApiError(await jsonRequest(origin, {
    method: "PATCH",
    requestPath: alicePath,
    cookie: admin.cookie.pair,
    value: { teamName: "合法队", group: "university" }
  }), 400, "INVALID_GROUP");
  assertApiError(await jsonRequest(origin, {
    method: "PATCH",
    requestPath: absentPath,
    cookie: admin.cookie.pair,
    value: { teamName: "不存在队", group: "high" }
  }), 404, "USER_NOT_FOUND");
  assertApiError(await jsonRequest(origin, {
    method: "PATCH",
    requestPath: `/api/v1/admin/users/${admin.payload.user.id}`,
    cookie: admin.cookie.pair,
    value: { teamName: "不应存在的管理员队伍", group: "high" }
  }), 409, "ADMIN_ACCOUNT_NOT_PARTICIPANT");

  const authFile = path.join(dataDir, "auth", "auth-store.json");
  const before = JSON.parse(await fs.promises.readFile(authFile, "utf8"));
  const beforeById = new Map(before.users.map(user => [user.id, user]));
  const beforeSessions = structuredClone(before.sessions);
  const [aliceUpdatedResponse, bobUpdatedResponse] = await Promise.all([
    jsonRequest(origin, {
      method: "PATCH",
      requestPath: alicePath,
      cookie: admin.cookie.pair,
      value: { teamName: "  Cafe\u0301 甲队  ", group: "high" }
    }),
    jsonRequest(origin, {
      method: "PATCH",
      requestPath: `/api/v1/admin/users/${bob.payload.user.id}`,
      cookie: admin.cookie.pair,
      value: { teamName: "辰龙乙队", group: "primary" }
    })
  ]);
  for (const response of [aliceUpdatedResponse, bobUpdatedResponse]) {
    assert.equal(response.statusCode, 200, response.body.toString("utf8"));
    const payload = parseJson(response);
    assert.deepEqual(Object.keys(payload).sort(), ["authoritative", "changed", "schemaVersion", "user"]);
    assert.equal(payload.schemaVersion, "chenlong.admin-user-update/v1");
    assert.equal(payload.changed, true);
    assert.equal(payload.authoritative, false);
    assert.deepEqual(Object.keys(payload.user).sort(), [
      "createdAt", "displayName", "group", "id", "role", "teamName", "username"
    ], "the PATCH receipt remains the public seven-field projection");
    assertNoSecrets(payload, [PASSWORD, admin.cookie.token, alice.cookie.token, bob.cookie.token]);
  }
  const aliceUpdated = parseJson(aliceUpdatedResponse).user;
  assert.equal(aliceUpdated.teamName, "Café 甲队");
  assert.equal(aliceUpdated.group, "high");
  assert.equal(aliceUpdated.displayName, "Alice Alias");
  assert.equal(aliceUpdated.username, alice.payload.user.username);
  assert.equal(aliceUpdated.role, "user");
  assert.equal(aliceUpdated.createdAt, alice.payload.user.createdAt);

  const after = JSON.parse(await fs.promises.readFile(authFile, "utf8"));
  assert.equal(after.revision, before.revision + 2, "concurrent updates must each commit once");
  assert.deepEqual(after.sessions, beforeSessions, "profile edits must preserve every authentication session");
  for (const changedUser of after.users) {
    const original = beforeById.get(changedUser.id);
    assert.deepEqual(changedUser.passwordHash, original.passwordHash);
    assert.equal(changedUser.username, original.username);
    assert.equal(changedUser.usernameKey, original.usernameKey);
    assert.equal(changedUser.displayName, original.displayName);
    assert.equal(changedUser.role, original.role);
    assert.equal(changedUser.createdAt, original.createdAt);
  }

  const idempotentResponse = await jsonRequest(origin, {
    method: "PATCH",
    requestPath: alicePath,
    cookie: admin.cookie.pair,
    value: { teamName: "Café 甲队", group: "high" }
  });
  assert.equal(idempotentResponse.statusCode, 200, idempotentResponse.body.toString("utf8"));
  assert.equal(parseJson(idempotentResponse).changed, false);
  const afterIdempotent = JSON.parse(await fs.promises.readFile(authFile, "utf8"));
  assert.equal(afterIdempotent.revision, after.revision, "an unchanged update must not write a new revision");
  assert.deepEqual(afterIdempotent, after);

  const meAfterUpdate = await request(origin, {
    requestPath: "/api/v1/auth/me",
    headers: { Cookie: alice.cookie.pair }
  });
  assert.equal(meAfterUpdate.statusCode, 200, meAfterUpdate.body.toString("utf8"));
  assert.equal(parseJson(meAfterUpdate).user.teamName, "Café 甲队");
  assert.equal(parseJson(meAfterUpdate).user.group, "high");
  const loginAfterUpdate = await login(origin, "users-alice");
  assert.equal(loginAfterUpdate.statusCode, 200, loginAfterUpdate.body.toString("utf8"));

  const participantRecords = await request(origin, {
    requestPath: "/api/v1/records",
    headers: { Cookie: alice.cookie.pair }
  });
  assert.equal(participantRecords.statusCode, 200, participantRecords.body.toString("utf8"));
  const participantRecord = recordItems(parseJson(participantRecords))
    .find(record => recordId(record) === aliceSubmissionId);
  assert.equal(participantRecord.user.teamName, "Café 甲队");
  assert.equal(participantRecord.user.group, "high");
  assert.equal(participantRecord.user.displayName, "Alice Alias");
  const adminRecords = await request(origin, {
    requestPath: "/api/v1/admin/records",
    headers: { Cookie: admin.cookie.pair }
  });
  assert.equal(adminRecords.statusCode, 200, adminRecords.body.toString("utf8"));
  const adminRecord = recordItems(parseJson(adminRecords))
    .find(record => recordId(record) === aliceSubmissionId);
  assert.equal(adminRecord.user.teamName, "Café 甲队");
  assert.equal(adminRecord.user.group, "high");
});

test("advanced navigation usage is derived from trusted ledgers and disclosed only to administrators", async t => {
  const { origin, dataDir, server } = await startServer(t);
  const admin = await registerUser(origin, "capability-admin");
  const participant = await registerUser(origin, "capability-user", { teamName: "导航测试队" });

  const containsPrivateMarker = value => {
    if (!value || typeof value !== "object") return false;
    if (Object.hasOwn(value, "capabilityUsage") || Object.hasOwn(value, "actualCapabilityUsage")) return true;
    return Object.values(value).some(containsPrivateMarker);
  };
  const assertParticipantSafe = (value, label) => {
    assert.equal(containsPrivateMarker(value), false, `${label} leaked an administrator-only capability marker`);
  };
  const rewriteArchivedReport = async (sessionId, submissionId, mutate) => {
    const directory = path.join(dataDir, "sessions", sessionId, "submissions", submissionId);
    const reportPath = path.join(directory, "report.json");
    const manifestPath = path.join(directory, "manifest.json");
    const report = JSON.parse(await fs.promises.readFile(reportPath, "utf8"));
    mutate(report);
    const reportBuffer = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
    manifest.report.sha256 = crypto.createHash("sha256").update(reportBuffer).digest("hex");
    manifest.report.byteLength = reportBuffer.length;
    await fs.promises.writeFile(reportPath, reportBuffer);
    await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  };

  const actualSession = await createArchivedSession(origin, participant.cookie.pair, "ignored-team");
  const savedActual = await saveDraftRecord(origin, participant.cookie.pair, actualSession, {
    sourceCode: "print('typed run ledger is the evidence')",
    navigationSensorMethods: ["odometry", "road_state", "map_graph"],
    roadControlMethods: ["follow_road"]
  });
  assert.equal(savedActual.statusCode, 201, savedActual.body.toString("utf8"));
  assertParticipantSafe(parseJson(savedActual), "draft receipt");
  const actualId = parseJson(savedActual).recordId;
  const submittedActual = await jsonRequest(origin, {
    requestPath: `/api/v1/records/${actualId}/submit`,
    cookie: participant.cookie.pair,
    value: {}
  });
  assert.equal(submittedActual.statusCode, 201, submittedActual.body.toString("utf8"));
  assertParticipantSafe(parseJson(submittedActual), "record-submit receipt");

  const decoySession = await createArchivedSession(origin, participant.cookie.pair, "ignored-team");
  const submittedDecoy = await submitRecord(origin, participant.cookie.pair, decoySession, {
    sourceCode: [
      "# robot.odometry(); robot.road_state(); robot.map_graph()",
      "message = 'robot.follow_road(100, 40); robot.take_exit(road_id)'"
    ].join("\n")
  });
  assert.equal(submittedDecoy.statusCode, 201, submittedDecoy.body.toString("utf8"));
  const decoyReceipt = parseJson(submittedDecoy);
  assertParticipantSafe(decoyReceipt, "direct submission receipt");
  const decoyId = recordId(decoyReceipt);

  const legacySession = await createArchivedSession(origin, participant.cookie.pair, "ignored-team");
  const submittedLegacy = await submitRecord(origin, participant.cookie.pair, legacySession, {
    sourceCode: "print('legacy report fixture')",
    navigationSensorMethods: ["road_state"],
    roadControlMethods: ["follow_road"]
  });
  assert.equal(submittedLegacy.statusCode, 201, submittedLegacy.body.toString("utf8"));
  const legacyId = recordId(parseJson(submittedLegacy));
  await rewriteArchivedReport(legacySession.id, legacyId, report => {
    delete report.actualCapabilityUsage;
  });

  const malformedSession = await createArchivedSession(origin, participant.cookie.pair, "ignored-team");
  const submittedMalformed = await submitRecord(origin, participant.cookie.pair, malformedSession, {
    sourceCode: "print('malformed report fixture')",
    navigationSensorMethods: ["odometry"],
    roadControlMethods: ["follow_road"]
  });
  assert.equal(submittedMalformed.statusCode, 201, submittedMalformed.body.toString("utf8"));
  const malformedId = recordId(parseJson(submittedMalformed));
  await rewriteArchivedReport(malformedSession.id, malformedId, report => {
    report.actualCapabilityUsage = {
      schemaVersion: "chenlong.record-capability-usage/v1",
      navigationSensorMethods: ["forged_sensor"],
      roadControlMethods: ["follow_road"]
    };
  });

  const personalListResponse = await request(origin, {
    requestPath: "/api/v1/records",
    headers: { Cookie: participant.cookie.pair }
  });
  assert.equal(personalListResponse.statusCode, 200, personalListResponse.body.toString("utf8"));
  assertParticipantSafe(parseJson(personalListResponse), "personal record list");

  const personalDetailResponse = await request(origin, {
    requestPath: `/api/v1/records/${actualId}`,
    headers: { Cookie: participant.cookie.pair }
  });
  assert.equal(personalDetailResponse.statusCode, 200, personalDetailResponse.body.toString("utf8"));
  assertParticipantSafe(parseJson(personalDetailResponse), "personal record detail");

  const personalReceiptResponse = await request(origin, {
    requestPath: `/api/v1/sessions/${actualSession.id}/submissions/${actualId}`,
    headers: {
      Cookie: participant.cookie.pair,
      Authorization: `Bearer ${actualSession.submitToken}`
    }
  });
  assert.equal(personalReceiptResponse.statusCode, 200, personalReceiptResponse.body.toString("utf8"));
  assertParticipantSafe(parseJson(personalReceiptResponse), "stored submission receipt");

  const runRecordResponse = await request(origin, {
    requestPath: `/api/v1/records/${actualId}/run-record`,
    headers: { Cookie: participant.cookie.pair }
  });
  assert.equal(runRecordResponse.statusCode, 200, runRecordResponse.body.toString("utf8"));
  const runRecord = JSON.parse(runRecordResponse.body.toString("utf8"));
  assertParticipantSafe(runRecord, "run-record payload");
  assert.equal(runRecord.inputs.some(input => input.type === "navigation_query"), true);
  assert.equal(runRecord.inputs.some(input => input.type === "navigation_control"), true);

  const verificationBody = Buffer.from(JSON.stringify(recordForSession(
    actualSession,
    "print('standalone verifier')",
    { navigationSensorMethods: ["odometry"] }
  )));
  const verificationResponse = await request(origin, {
    method: "POST",
    requestPath: "/api/v1/verify-run-record",
    headers: {
      Cookie: participant.cookie.pair,
      Origin: origin,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": verificationBody.length
    },
    body: verificationBody
  });
  assert.equal(verificationResponse.statusCode, 200, verificationResponse.body.toString("utf8"));
  assertParticipantSafe(parseJson(verificationResponse), "standalone verification report");

  const adminListResponse = await request(origin, {
    requestPath: "/api/v1/admin/records",
    headers: { Cookie: admin.cookie.pair }
  });
  assert.equal(adminListResponse.statusCode, 200, adminListResponse.body.toString("utf8"));
  const byId = new Map(recordItems(parseJson(adminListResponse)).map(record => [recordId(record), record]));
  assert.deepEqual(byId.get(actualId)?.capabilityUsage, {
    navigationSensors: true,
    roadControls: true,
    vision: false
  });
  assert.deepEqual(byId.get(decoyId)?.capabilityUsage, {
    navigationSensors: false,
    roadControls: false,
    vision: false
  }, "source comments and strings must never create the marker");
  assert.deepEqual(byId.get(legacyId)?.capabilityUsage, {
    navigationSensors: true,
    roadControls: true,
    vision: false
  }, "a verified legacy report without the summary must derive it from the hash-bound record");
  assert.deepEqual(byId.get(malformedId)?.capabilityUsage, {
    navigationSensors: false,
    roadControls: false,
    vision: false
  }, "a present but malformed report summary must fail closed instead of trusting or falling back");
  assert.equal(server.submissionStore.capabilityUsageCache.size, 1,
    "only the old report should require one cached full-record derivation");

  const secondAdminList = await request(origin, {
    requestPath: "/api/v1/admin/records",
    headers: { Cookie: admin.cookie.pair }
  });
  assert.equal(secondAdminList.statusCode, 200, secondAdminList.body.toString("utf8"));
  assert.equal(server.submissionStore.capabilityUsageCache.size, 1,
    "repeated administrator lists must reuse the bounded legacy derivation cache");

  const adminDetailResponse = await request(origin, {
    requestPath: `/api/v1/admin/records/${actualId}`,
    headers: { Cookie: admin.cookie.pair }
  });
  assert.equal(adminDetailResponse.statusCode, 200, adminDetailResponse.body.toString("utf8"));
  const adminDetail = parseJson(adminDetailResponse);
  assert.deepEqual(adminDetail.record.capabilityUsage, {
    navigationSensors: true,
    roadControls: true,
    vision: false
  });
  assert.deepEqual(adminDetail.verification.actualCapabilityUsage, {
    schemaVersion: "chenlong.record-capability-usage/v2",
    navigationSensorMethods: ["odometry", "road_state", "map_graph"],
    roadControlMethods: ["follow_road"],
    visionMethods: []
  });
});
