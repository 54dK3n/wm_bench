"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const backend = require("../server.js");
// Deliberately use the Python-local copy: the standalone delivery package must
// not depend on the unified platform repository layout.
const serviceAuth = require("../backend/platform-service-auth.js");

const SECRET = "python-internal-score-test-secret-123456789";
const NOW_MS = 1_800_000_000_000;
const REQUEST_PATH = "/api/v1/internal/platform/score-records?page=1&pageSize=1000";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function request(origin, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(requestPath, origin), { headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
  });
}

test("Python exposes submitted summaries only to a signed loopback platform service request", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "python-platform-score-test-"));
  const server = backend.createServer({
    dataDir: temporary,
    platformServiceSecret: SECRET,
    now: () => NOW_MS
  });
  const origin = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const denied = await request(origin, REQUEST_PATH);
  assert.equal(denied.status, 403);
  const authentication = serviceAuth.signServiceRequest(SECRET, REQUEST_PATH, {
    nowSeconds: NOW_MS / 1000
  });
  const accepted = await request(origin, REQUEST_PATH, {
    [serviceAuth.SERVICE_HEADER]: authentication
  });
  assert.equal(accepted.status, 200);
  const payload = JSON.parse(accepted.body.toString("utf8"));
  assert.deepEqual(payload.records, []);
  assert.equal(payload.pagination.total, 0);
  const replay = await request(origin, REQUEST_PATH, {
    [serviceAuth.SERVICE_HEADER]: authentication
  });
  assert.equal(replay.status, 403);
});

test("internal score pagination serves the complete bounded best-score aggregate", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "python-platform-score-capacity-test-"));
  const server = backend.createServer({
    dataDir: temporary,
    platformServiceSecret: SECRET,
    now: () => NOW_MS
  });
  const records = Array.from({ length: 6_000 }, (_value, index) => ({
    recordState: "submitted",
    ownerUserId: `usr_${index.toString(16).padStart(32, "0")}`,
    teamId: `usr_${index.toString(16).padStart(32, "0")}`,
    taskId: `R2-GYI-MVP-0${(index % 3) + 1}`,
    score: 100,
    submittedAt: new Date((NOW_MS - index * 1_000)).toISOString(),
    latestSubmittedAt: new Date((NOW_MS - index * 1_000)).toISOString()
  }));
  server.submissionStore.listBestSubmittedRecords = async () => records;
  const origin = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));

  for (const page of [1, 6]) {
    const requestPath = `/api/v1/internal/platform/score-records?page=${page}&pageSize=1000`;
    const authentication = serviceAuth.signServiceRequest(SECRET, requestPath, {
      nowSeconds: NOW_MS / 1000
    });
    const result = await request(origin, requestPath, {
      [serviceAuth.SERVICE_HEADER]: authentication
    });
    assert.equal(result.status, 200);
    const payload = JSON.parse(result.body.toString("utf8"));
    assert.equal(payload.records.length, 1_000);
    assert.equal(payload.pagination.total, 6_000);
    assert.equal(payload.pagination.totalPages, 6);
    assert.equal(payload.pagination.page, page);
  }
});
