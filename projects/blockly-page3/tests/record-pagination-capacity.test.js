"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const contract = require(path.join(root, "..", "..", "packages", "platform-contract.js"));
const secret = "blockly-record-pagination-secret-1234567890";

const student = Object.freeze({
  id: "usr_11111111111111111111111111111111",
  username: "pagination_student",
  displayName: "分页学生",
  role: "user",
  teamId: "tea_11111111111111111111111111111111",
  teamName: "分页容量队",
  group: "primary_low",
  createdAt: "2026-08-28T00:00:00.000Z"
});

const administrator = Object.freeze({
  id: "usr_22222222222222222222222222222222",
  username: "pagination_admin",
  displayName: "分页管理员",
  role: "admin",
  teamId: null,
  teamName: null,
  group: null,
  createdAt: "2026-08-28T00:00:00.000Z"
});

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

function storedRecord(index) {
  const createdAt = new Date(Date.parse("2026-08-28T00:00:00.000Z") + index * 1_000).toISOString();
  return {
    id: `run_${index.toString(16).padStart(32, "0")}`,
    ownerUserId: student.id,
    ownerUsername: student.username,
    ownerDisplayName: student.displayName,
    ownerTeamId: student.teamId,
    ownerTeamName: student.teamName,
    ownerGroup: student.group,
    taskId: `GYI-PRIMARY-0${(index % 3) + 1}`,
    taskName: `广阳岛综合任务${(index % 3) + 1}`,
    score: index % 101,
    completed: index % 2 === 0,
    checkpointCount: 4,
    checkpointTotal: 4,
    taskCompleted: 4,
    taskTotal: 4,
    targetDeliveredCount: 1,
    distractorClearedCount: 1,
    failedObstacleCount: 0,
    goalReached: true,
    mapRevision: 1,
    mapDigest: "a".repeat(64),
    recordState: "submitted",
    savedAt: createdAt,
    submittedAt: createdAt,
    createdAt,
    durationMs: 10_000 + index,
    programCode: `await robot.forward(${index % 500})`,
    workspaceXml: JSON.stringify({ index }),
    scoreBreakdown: {},
    executionTrace: index % 2 ? ["mission", "road_state"] : []
  };
}

test("500-per-page reads collect all 1500 personal and admin records without legacy overfetch", { timeout: 20_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-record-pagination-"));
  const storePath = path.join(dataDir, "primary-blockly-store.json");
  fs.writeFileSync(storePath, `${JSON.stringify({
    schemaVersion: "chenlong.blockly-primary-store/v6",
    users: [],
    teams: [],
    sessions: [],
    records: Array.from({ length: 1_500 }, (_, index) => storedRecord(index)),
    mapConfigs: {},
    defaultAdminConfigured: true
  })}\n`, "utf8");
  const port = 44000 + Math.floor(Math.random() * 8_000);
  const origin = `http://127.0.0.1:${port}`;
  const child = childProcess.spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      BLOCKLY_PUBLIC_ORIGIN: origin,
      BLOCKLY_DATA_DIR: dataDir,
      PLATFORM_SSO_SECRET: secret
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForListening(child);
    const studentHeader = contract.signPrincipal(secret, "blockly", student);
    const adminHeader = contract.signPrincipal(secret, "blockly", administrator);
    const get = async (route, principal) => {
      const response = await fetch(`${origin}${route}`, {
        headers: { [contract.PRINCIPAL_HEADER]: principal }
      });
      return { status: response.status, payload: await response.json().catch(() => null) };
    };

    const legacy = await get("/api/records", studentHeader);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.payload.records.length, 1_000);
    assert.deepEqual(legacy.payload.pagination, {
      page: 1,
      pageSize: 1_000,
      total: 1_500,
      totalPages: 2,
      returned: 1_000,
      hasPrevious: false,
      hasNext: true,
      truncated: true
    });

    const defaultPage = await get("/api/records?page=1", studentHeader);
    assert.equal(defaultPage.status, 200);
    assert.equal(defaultPage.payload.records.length, 250);
    assert.equal(defaultPage.payload.pagination.pageSize, 250);

    const pages = await Promise.all([1, 2, 3].map(page => get(`/api/records?page=${page}&pageSize=500`, studentHeader)));
    assert.ok(pages.every(result => result.status === 200));
    assert.ok(pages.every(result => result.payload.records.length === 500));
    const personalIds = pages.flatMap(result => result.payload.records.map(record => record.id));
    assert.equal(new Set(personalIds).size, 1_500);
    assert.equal(personalIds[0], storedRecord(1_499).id);
    assert.equal(personalIds.at(-1), storedRecord(0).id);
    assert.equal(pages[2].payload.pagination.hasNext, false);

    const adminPages = await Promise.all([1, 2, 3].map(page => get(`/api/admin/records?page=${page}&pageSize=500`, adminHeader)));
    assert.ok(adminPages.every(result => result.status === 200));
    const adminRecords = adminPages.flatMap(result => result.payload.records);
    assert.equal(adminRecords.length, 1_500);
    assert.equal(new Set(adminRecords.map(record => record.id)).size, 1_500);
    assert.ok(adminRecords.every(record => record.user?.teamName === student.teamName));
    assert.ok(adminRecords.every(record => record.user?.group === "primary"),
      "旧分页记录中的小学低年级值必须在迁移后统一为小学组");

    const malformedQueries = [
      "page=0", "page=-1", "page=1.5", "page=x", "page=1000001", "page=1&page=2",
      "pageSize=0", "pageSize=-1", "pageSize=1.5", "pageSize=x", "pageSize=1001", "pageSize=1&pageSize=2"
    ];
    for (const query of malformedQueries) {
      const [personal, admin] = await Promise.all([
        get(`/api/records?${query}`, studentHeader),
        get(`/api/admin/records?${query}`, adminHeader)
      ]);
      assert.equal(personal.status, 400, query);
      assert.equal(personal.payload.error.code, "INVALID_PAGINATION", query);
      assert.equal(admin.status, 400, query);
      assert.equal(admin.payload.error.code, "INVALID_PAGINATION", query);
    }
  } finally {
    child.kill();
    await new Promise(resolve => child.once("exit", resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("record clients follow every server page before local filtering, highest-score aggregation and display", () => {
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const admin = fs.readFileSync(path.join(root, "admin.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(app, /primaryRequestAllRecordPages[\s\S]*?pageSize=1000[\s\S]*?pagination\.hasNext/);
  assert.match(app, /PRIMARY_SCORE_SUMMARIES\.buildSubmittedTaskScores\(\s*records,/);
  assert.match(app, /PRIMARY_RECORD_PAGE_SIZE = 20/);
  assert.match(html, /id="primaryRecordsPrevious"[\s\S]*?id="primaryRecordsNext"/);
  assert.match(admin, /requestAllRecordPages[\s\S]*?pageSize=1000[\s\S]*?pagination\.hasNext/);
  assert.match(admin, /state\.records = payload\.records/);
});
