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
const secret = "blockly-platform-integration-secret-1234567890";

const userA = Object.freeze({
  id: "usr_11111111111111111111111111111111",
  username: "platform_a",
  displayName: "平台甲",
  role: "user",
  teamId: "tea_11111111111111111111111111111111",
  teamName: "平台甲队",
  group: "primary_low",
  createdAt: "2026-08-28T00:00:00.000Z"
});

const userB = Object.freeze({
  id: "usr_22222222222222222222222222222222",
  username: "platform_b",
  displayName: "平台乙",
  role: "user",
  teamId: "tea_22222222222222222222222222222222",
  teamName: "平台乙队",
  group: "junior",
  createdAt: "2026-08-28T00:00:00.000Z"
});

const administrator = Object.freeze({
  id: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  username: "platform_admin",
  displayName: "平台管理员",
  role: "admin",
  teamId: null,
  teamName: null,
  group: null,
  createdAt: "2026-08-28T00:00:00.000Z"
});

function canonicalDigest(value) {
  return crypto.createHash("sha256").update(contract.canonicalJson(value), "utf8").digest("hex");
}

function platformMaps() {
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
      updatedAt: index === 0 ? null : "2026-08-28T00:00:00.000Z",
      layout
    };
  });
}

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
  assert.ok(value, "认证响应必须设置 Cookie");
  return value.split(";", 1)[0];
}

function recordBody(map, overrides = {}) {
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
    durationMs: 12000,
    programCode: "await robot.forward(50)",
    workspaceXml: JSON.stringify({ blocks: [{ type: "robot_forward_cm" }] }),
    executionTrace: ["mission", "road_state"],
    ...overrides
  };
}

test("platform SSO exclusively authenticates signed principals and isolates owners", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-platform-"));
  const port = 34000 + Math.floor(Math.random() * 9000);
  const origin = `http://127.0.0.1:${port}`;
  const child = childProcess.spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      BLOCKLY_PUBLIC_ORIGIN: origin,
      BLOCKLY_DATA_DIR: dataDir,
      PLATFORM_SSO_SECRET: secret,
      BLOCKLY_ENABLE_LOCAL_AUTH: "true",
      BLOCKLY_BOOTSTRAP_ADMIN_USERNAME: "must_not_be_created",
      BLOCKLY_BOOTSTRAP_ADMIN_PASSWORD: "Must-Not-Be-Created-12345"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForListening(child);
    const request = async (route, { method = "GET", cookie = "", body, headers = {} } = {}) => {
      const response = await fetch(`${origin}${route}`, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body !== undefined ? { Origin: origin, "Content-Type": "application/json" } : {}),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { response, payload: await response.json().catch(() => null) };
    };

    const maps = platformMaps();
    const signedMaps = contract.signMapBundle(secret, maps);
    const signedA = contract.signPrincipal(secret, "blockly", userA);
    const signedB = contract.signPrincipal(secret, "blockly", userB);
    const signedAdmin = contract.signPrincipal(secret, "blockly", administrator);
    const platformHeadersA = {
      [contract.PRINCIPAL_HEADER]: signedA,
      [contract.MAP_BUNDLE_HEADER]: signedMaps
    };

    const health = await request("/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.payload.authentication.mode, "platform");

    for (const [route, body] of [
      ["/api/auth/login", { username: "must_not_be_created", password: "Must-Not-Be-Created-12345" }],
      ["/api/auth/register", {
        username: "platform_local_user",
        password: "Platform-Local-User-12345",
        teamAction: "create",
        teamName: "平台模式本地队伍"
      }],
      ["/api/auth/logout", {}]
    ]) {
      const localAuth = await request(route, { method: "POST", body });
      assert.equal(localAuth.response.status, 403, `${route} 在平台模式必须禁用`);
      assert.equal(localAuth.payload.error.code, "LOCAL_AUTH_DISABLED");
      assert.equal(localAuth.response.headers.get("set-cookie"), null);
    }

    const cookieFallback = await request("/api/auth/me", {
      cookie: `chenlong_blockly_session=${"a".repeat(43)}`
    });
    assert.equal(cookieFallback.response.status, 401);
    assert.equal(cookieFallback.payload.error.code, "PLATFORM_AUTHENTICATION_REQUIRED");

    const me = await request("/api/auth/me", { headers: { [contract.PRINCIPAL_HEADER]: signedA } });
    assert.equal(me.response.status, 200);
    assert.equal(me.payload.user.username, userA.username);
    assert.equal(me.payload.user.teamName, userA.teamName);
    assert.equal(me.payload.user.group, "primary", "平台历史小学分组必须在边界统一为小学组");

    const tampered = `${signedA.slice(0, -1)}${signedA.endsWith("A") ? "B" : "A"}`;
    const forged = await request("/api/auth/me", { headers: { [contract.PRINCIPAL_HEADER]: tampered } });
    assert.equal(forged.response.status, 401);
    assert.equal(forged.payload.error.code, "INVALID_PLATFORM_PRINCIPAL");

    const expired = contract.signPrincipal(secret, "blockly", userA, {
      now: Date.now() - 20_000,
      ttlMs: 1_000
    });
    const expiredResult = await request("/api/auth/me", { headers: { [contract.PRINCIPAL_HEADER]: expired } });
    assert.equal(expiredResult.response.status, 401);

    const wrongAudience = contract.signPrincipal(secret, "workshop", userA);
    const wrongAudienceResult = await request("/api/auth/me", {
      headers: { [contract.PRINCIPAL_HEADER]: wrongAudience }
    });
    assert.equal(wrongAudienceResult.response.status, 401);

    const missingMaps = await request("/api/maps", { headers: { [contract.PRINCIPAL_HEADER]: signedA } });
    assert.equal(missingMaps.response.status, 400);
    assert.equal(missingMaps.payload.error.code, "INVALID_PLATFORM_MAP_BUNDLE");

    const published = await request("/api/maps", { headers: platformHeadersA });
    assert.equal(published.response.status, 200, JSON.stringify(published.payload));
    assert.deepEqual(published.payload.maps.map(map => map.taskId), [
      "GYI-PRIMARY-01", "GYI-PRIMARY-02", "GYI-PRIMARY-03"
    ]);
    assert.ok(published.payload.maps.every(map => map.revision === 0));
    assert.ok(published.payload.maps.every(map => map.layout.schemaVersion === "chenlong.guangyang-map-layout/v2"));

    const duplicateBundle = contract.signMapBundle(secret, [maps[0], maps[0], maps[2]]);
    const duplicate = await request("/api/maps", {
      headers: {
        [contract.PRINCIPAL_HEADER]: signedA,
        [contract.MAP_BUNDLE_HEADER]: duplicateBundle
      }
    });
    assert.equal(duplicate.response.status, 400);

    const badDigestMaps = structuredClone(maps);
    badDigestMaps[0].digest = "a".repeat(64);
    const badDigest = await request("/api/maps", {
      headers: {
        [contract.PRINCIPAL_HEADER]: signedA,
        [contract.MAP_BUNDLE_HEADER]: contract.signMapBundle(secret, badDigestMaps)
      }
    });
    assert.equal(badDigest.response.status, 400);

    const noOriginResponse = await fetch(`${origin}/api/records`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...platformHeadersA
      },
      body: JSON.stringify(recordBody(maps[0]))
    });
    assert.equal(noOriginResponse.status, 403, "平台身份不能绕过原有 Origin 防护");

    const saved = await request("/api/records", {
      method: "POST",
      headers: platformHeadersA,
      body: recordBody(maps[0])
    });
    assert.equal(saved.response.status, 201, JSON.stringify(saved.payload));
    assert.equal(saved.payload.record.mapRevision, 0);
    const recordId = saved.payload.record.id;

    const ownRecords = await request("/api/records", {
      headers: { [contract.PRINCIPAL_HEADER]: signedA }
    });
    assert.equal(ownRecords.response.status, 200);
    assert.deepEqual(ownRecords.payload.records.map(record => record.id), [recordId]);

    const otherRecords = await request("/api/records", {
      headers: { [contract.PRINCIPAL_HEADER]: signedB }
    });
    assert.equal(otherRecords.response.status, 200);
    assert.deepEqual(otherRecords.payload.records, []);

    const otherDetail = await request(`/api/records/${recordId}`, {
      headers: { [contract.PRINCIPAL_HEADER]: signedB }
    });
    assert.equal(otherDetail.response.status, 404);
    const otherSubmit = await request(`/api/records/${recordId}/submit`, {
      method: "POST",
      headers: { [contract.PRINCIPAL_HEADER]: signedB },
      body: {}
    });
    assert.equal(otherSubmit.response.status, 404);

    const submitted = await request(`/api/records/${recordId}/submit`, {
      method: "POST",
      headers: { [contract.PRINCIPAL_HEADER]: signedA },
      body: {}
    });
    assert.equal(submitted.response.status, 200);
    assert.equal(submitted.payload.record.recordState, "submitted");

    const adminHeaders = { [contract.PRINCIPAL_HEADER]: signedAdmin };
    const adminRecords = await request("/api/admin/records", { headers: adminHeaders });
    assert.equal(adminRecords.response.status, 200);
    assert.equal(adminRecords.payload.records.length, 1);
    assert.deepEqual(adminRecords.payload.records[0].user, {
      id: userA.id,
      username: userA.username,
      displayName: userA.displayName,
      teamId: userA.teamId,
      teamName: userA.teamName,
      group: "primary",
      role: "user",
      createdAt: saved.payload.record.createdAt
    });
    const teamTaskScores = await request("/api/admin/team-task-scores", { headers: adminHeaders });
    assert.equal(teamTaskScores.response.status, 200);
    assert.equal(teamTaskScores.payload.schemaVersion, "chenlong.blockly-team-task-scores/v1");
    assert.deepEqual(teamTaskScores.payload.records, [{
      id: recordId,
      ownerUserId: userA.id,
      teamId: userA.teamId,
      taskId: maps[0].taskId,
      score: submitted.payload.record.score,
      recordState: "submitted",
      submittedAt: submitted.payload.record.submittedAt
    }]);
    const deniedTeamTaskScores = await request("/api/admin/team-task-scores", {
      headers: { [contract.PRINCIPAL_HEADER]: signedA }
    });
    assert.equal(deniedTeamTaskScores.response.status, 403);
    const adminUsers = await request("/api/admin/users", { headers: adminHeaders });
    assert.ok(adminUsers.payload.users.some(user => user.id === userA.id
      && user.teamId === userA.teamId && user.teamName === userA.teamName && user.recordCount === 1));

    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "primary-blockly-store.json"), "utf8"));
    assert.equal(stored.schemaVersion, "chenlong.blockly-primary-store/v8");
    assert.equal(Object.hasOwn(stored, "records"), false);
    const recordDatabase = new DatabaseSync(path.join(dataDir, stored.recordStorage.databaseFile), { readOnly: true });
    const storedRow = recordDatabase.prepare("SELECT payload_json FROM records WHERE id = ?").get(recordId);
    recordDatabase.close();
    const storedRecord = JSON.parse(storedRow.payload_json);
    assert.equal(storedRecord.ownerUsername, userA.username);
    assert.equal(storedRecord.ownerDisplayName, userA.displayName);
    assert.equal(storedRecord.ownerTeamId, userA.teamId);
    assert.equal(storedRecord.ownerTeamName, userA.teamName);
    assert.equal(storedRecord.ownerGroup, "primary");
    assert.equal(storedRecord.mapLayout.schemaVersion, "chenlong.guangyang-map-layout/v2");
    assert.equal(stored.users.some(user => user.username === "must_not_be_created"), false,
      "平台模式即使误设本地认证环境变量也不能初始化本地管理员");
  } finally {
    child.kill();
    await new Promise(resolve => child.once("exit", resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("client map validation accepts Python base revision zero and canonical v2 layouts", () => {
  const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.match(appSource, /config\.revision < 0/);
  assert.doesNotMatch(appSource, /config\.revision < 1/);
  const map = platformMaps()[0];
  const normalized = mapRules.normalizeLayout(map.taskId, map.layout);
  assert.deepEqual(normalized, mapRules.defaultLayout(map.taskId));
});
