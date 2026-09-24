"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const contract = require("../packages/platform-contract.js");
const internalAuth = require("../packages/internal-service-auth.js");
const liveScores = require("../packages/live-score-source.js");

const SECRET = "live-score-source-test-secret-123456789";
const NOW = 1_800_000_000;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function sendJson(response, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(200, { "content-type": "application/json", "content-length": body.length });
  response.end(body);
}

test("internal score service signatures are path-bound, short-lived and replay protected", () => {
  const requestPath = "/api/v1/internal/platform/score-records?page=1&pageSize=1000";
  const replay = new internalAuth.ServiceReplayWindow({ nowSeconds: () => NOW });
  const value = internalAuth.signServiceRequest(SECRET, requestPath, { nowSeconds: NOW });
  assert.deepEqual(
    Object.keys(internalAuth.verifyServiceRequest(value, SECRET, requestPath, replay, { nowSeconds: NOW })),
    ["timestamp", "nonce"]
  );
  assert.throws(
    () => internalAuth.verifyServiceRequest(value, SECRET, requestPath, replay, { nowSeconds: NOW }),
    /already used/
  );
  assert.throws(() => internalAuth.verifyServiceRequest(
    internalAuth.signServiceRequest(SECRET, requestPath, { nowSeconds: NOW - 31 }),
    SECRET,
    requestPath,
    new internalAuth.ServiceReplayWindow({ nowSeconds: () => NOW }),
    { nowSeconds: NOW }
  ), /expired/);
  assert.throws(() => internalAuth.verifyServiceRequest(
    internalAuth.signServiceRequest(SECRET, requestPath, { nowSeconds: NOW }),
    SECRET,
    `${requestPath}&page=2`,
    new internalAuth.ServiceReplayWindow({ nowSeconds: () => NOW }),
    { nowSeconds: NOW }
  ), /invalid/);
  assert.equal(internalAuth.loopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(internalAuth.loopbackAddress("203.0.113.1"), false);
});

test("live rows use official SSO identities and current best Python, Blockly and workshop scores", () => {
  const teamId = "tea_cccccccccccccccccccccccccccccccc";
  const baseUser = {
    teamId,
    teamName: "官网一队",
    group: "primary_high",
    role: "user"
  };
  const authStore = {
    schemaVersion: "chenlong.auth-store/v5",
    users: [
      { ...baseUser, id: "usr_11111111111111111111111111111111", officialUserId: "U-1", officialTeamId: "T-1" },
      { ...baseUser, id: "usr_22222222222222222222222222222222", officialUserId: "U-2", officialTeamId: "T-1" },
      { ...baseUser, id: "usr_33333333333333333333333333333333", officialUserId: null, officialTeamId: null }
    ],
    teams: [{ id: teamId, teamName: "官网一队", officialTeamId: "T-1" }]
  };
  const rows = liveScores.buildLiveRows({
    authStore,
    competitionStage: "preliminary",
    promotions: new Map([["T-1", 1]]),
    pythonRecords: [
      // Real Python run summaries may carry the owner user id in teamId.
      // ownerUserId must therefore win when resolving the actual team.
      { recordState: "submitted", ownerUserId: authStore.users[0].id, teamId: authStore.users[0].id, taskId: "R2-GYI-MVP-01", score: 80, submittedAt: "2026-08-28T10:00:00.000Z" },
      { recordState: "submitted", ownerUserId: authStore.users[1].id, teamId, taskId: "R2-GYI-MVP-02", score: 60, submittedAt: "2026-08-28T10:01:00.000Z" }
    ],
    blocklyRecords: [
      { recordState: "submitted", ownerUserId: authStore.users[0].id, teamId, taskId: "GYI-PRIMARY-01", score: 90, submittedAt: "2026-08-28T10:02:00.000Z" },
      { recordState: "submitted", ownerUserId: authStore.users[0].id, teamId, taskId: "GYI-PRIMARY-03", score: 70, submittedAt: "2026-08-28T10:03:00.000Z" }
    ],
    workshopOverview: {
      leaderboards: {
        primary: [{ teamId, status: "scored", scoreMicros: 920000, scoredAt: 1_800_000_000 }]
      }
    }
  });
  assert.equal(rows.length, 2, "only SSO-mapped users are exported");
  assert.deepEqual(rows.map(row => row.user_id), ["U-1", "U-2"]);
  assert.ok(rows.every(row => row.team_id === "T-1" && row.group_type === "primary"));
  assert.ok(rows.every(row => row.score_task1 === 55));
  assert.ok(rows.every(row => row.score_task2 === 23));
  assert.ok(rows.every(row => row.total_score === 78 && row.promote_status === 1));
  assert.ok(rows.every(row => row.evaluate_finish_time === 1_800_000_000));
});

test("Python and Blockly submissions stay with their immutable submission-time team after an SSO transfer", () => {
  const oldTeamId = "tea_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const newTeamId = "tea_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const movedUserId = "usr_11111111111111111111111111111111";
  const oldMemberId = "usr_22222222222222222222222222222222";
  const authStore = {
    schemaVersion: "chenlong.auth-store/v5",
    users: [
      {
        id: movedUserId,
        teamId: newTeamId,
        group: "junior",
        role: "user",
        officialUserId: "MOVED-U",
        officialTeamId: "NEW-T"
      },
      {
        id: oldMemberId,
        teamId: oldTeamId,
        group: "junior",
        role: "user",
        officialUserId: "OLD-MEMBER-U",
        officialTeamId: "OLD-T"
      }
    ],
    teams: [
      { id: oldTeamId, teamName: "原队伍", officialTeamId: "OLD-T" },
      { id: newTeamId, teamName: "新队伍", officialTeamId: "NEW-T" }
    ]
  };
  const rows = liveScores.buildLiveRows({
    authStore,
    competitionStage: "preliminary",
    promotions: new Map(),
    pythonRecords: [
      {
        recordState: "submitted",
        ownerUserId: movedUserId,
        teamId: oldTeamId,
        taskId: "R2-GYI-MVP-01",
        score: 100,
        submittedAt: NOW - 30
      },
      {
        recordState: "submitted",
        ownerUserId: movedUserId,
        teamId: movedUserId,
        taskId: "R2-GYI-MVP-03",
        score: 60,
        submittedAt: NOW - 10
      }
    ],
    blocklyRecords: [{
      recordState: "submitted",
      ownerUserId: movedUserId,
      teamId: oldTeamId,
      taskId: "GYI-PRIMARY-02",
      score: 80,
      submittedAt: NOW - 20
    }],
    workshopOverview: { leaderboards: {} }
  });
  const oldTeam = rows.find(row => row.team_id === "OLD-T");
  const newTeam = rows.find(row => row.team_id === "NEW-T");
  assert.equal(oldTeam.score_task1, 45,
    "the old team's Python task 1 and Blockly task 2 scores remain with the submitted team");
  assert.equal(newTeam.score_task1, 15,
    "only the legacy owner-id record falls back to the moved user's current team");
});

test("live source reads all three running services with service/admin authentication", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "live-score-source-network-test-"));
  const authStorePath = path.join(temporary, "auth-store.json");
  const promotionPath = path.join(temporary, "promotions.json");
  const userId = "usr_11111111111111111111111111111111";
  const teamId = "tea_cccccccccccccccccccccccccccccccc";
  fs.writeFileSync(authStorePath, JSON.stringify({
    schemaVersion: "chenlong.auth-store/v5",
    users: [{
      id: userId,
      teamId,
      teamName: "网络测试队",
      group: "junior",
      role: "user",
      officialUserId: "OFFICIAL-U",
      officialTeamId: "OFFICIAL-T"
    }],
    teams: [{ id: teamId, teamName: "网络测试队", officialTeamId: "OFFICIAL-T" }],
    sessions: []
  }));
  fs.writeFileSync(promotionPath, JSON.stringify({
    schemaVersion: "chenlong.official-promotions/v1",
    stages: { preliminary: { "OFFICIAL-T": 1 }, rematch: {} }
  }));
  const replay = new internalAuth.ServiceReplayWindow();
  let pythonReads = 0;
  let blocklyReads = 0;
  let workshopReads = 0;
  const python = http.createServer((request, response) => {
    internalAuth.verifyServiceRequest(
      request.headers[internalAuth.SERVICE_HEADER],
      SECRET,
      request.url,
      replay,
      { nowSeconds: Math.floor(Date.now() / 1000) }
    );
    pythonReads += 1;
    if (pythonReads === 1) {
      const current = JSON.parse(fs.readFileSync(authStorePath, "utf8"));
      current.sessions = [{ id: "unrelated-login-session", expiresAt: NOW + 600 }];
      fs.writeFileSync(authStorePath, JSON.stringify(current));
    }
    sendJson(response, {
      records: [{
        recordState: "submitted", ownerUserId: userId, teamId: userId,
        taskId: "R2-GYI-MVP-01", score: pythonReads === 1 ? 10 : 100, submittedAt: NOW - 30
      }],
      pagination: { page: 1, pageSize: 1000, total: 1, totalPages: 1 }
    });
  });
  const blockly = http.createServer((request, response) => {
    contract.verifyPrincipal(request.headers[contract.PRINCIPAL_HEADER], SECRET, "blockly");
    blocklyReads += 1;
    sendJson(response, {
      records: [{ recordState: "submitted", ownerUserId: userId, teamId, taskId: "GYI-PRIMARY-02", score: 80, submittedAt: NOW - 20 }],
      pagination: { page: 1, pageSize: 1000, total: 1, totalPages: 1 }
    });
  });
  const workshop = http.createServer((request, response) => {
    contract.verifyPrincipal(request.headers[contract.PRINCIPAL_HEADER], SECRET, "workshop");
    workshopReads += 1;
    sendJson(response, {
      leaderboards: { junior: [{ teamId, status: "scored", scoreMicros: 800000, scoredAt: NOW - 10 }] }
    });
  });
  const [pythonOrigin, blocklyOrigin, workshopOrigin] = await Promise.all([
    listen(python), listen(blockly), listen(workshop)
  ]);
  t.after(() => Promise.all([python, blockly, workshop].map(server => new Promise(resolve => server.close(resolve)))));
  const source = liveScores.createLiveScoreDataSource({
    upstreams: { python: pythonOrigin, blockly: blocklyOrigin, workshop: workshopOrigin },
    secret: SECRET,
    authStorePath,
    promotionFile: promotionPath,
    nowSeconds: () => NOW
  });
  const snapshot = await source.listScoreRows({
    competitionStage: "preliminary",
    pullType: "all",
    snapshotTime: NOW,
    maximumRows: 50_001
  });
  assert.equal(snapshot.rows.length, 1);
  assert.deepEqual({
    user: snapshot.rows[0].user_id,
    team: snapshot.rows[0].team_id,
    programming: snapshot.rows[0].score_task1,
    workshop: snapshot.rows[0].score_task2,
    total: snapshot.rows[0].total_score
  }, {
    user: "OFFICIAL-U",
    team: "OFFICIAL-T",
    programming: 45,
    workshop: 20,
    total: 65
  });
  assert.equal(snapshot.rows[0].promote_status, 1);
  assert.equal(JSON.parse(fs.readFileSync(authStorePath, "utf8")).sessions.length, 1,
    "an unrelated login occurred during capture without invalidating score identity stability");
  assert.equal(pythonReads, 4, "a changing first read is retried until two complete snapshots match");
  assert.equal(blocklyReads, 2);
  assert.equal(workshopReads, 2);
  await assert.rejects(() => source.listScoreRows({
    competitionStage: "rematch", pullType: "all", snapshotTime: NOW, maximumRows: 50_001
  }), /not configured for rematch/);
  await assert.rejects(() => source.listScoreRows({
    competitionStage: "preliminary", pullType: "increment", snapshotTime: NOW, maximumRows: 50_001
  }), /cannot authoritatively track incremental/);

  const missingPromotionSource = liveScores.createLiveScoreDataSource({
    upstreams: { python: pythonOrigin, blockly: blocklyOrigin, workshop: workshopOrigin },
    secret: SECRET,
    authStorePath,
    promotionFile: "",
    nowSeconds: () => NOW
  });
  await assert.rejects(() => missingPromotionSource.listScoreRows({
    competitionStage: "preliminary", pullType: "all", snapshotTime: NOW, maximumRows: 50_001
  }), /requires an authoritative promotion status file/);
});
