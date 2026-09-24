#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");

const scoreApi = require("../packages/score-download.js");
const officialSso = require("../projects/car-python/backend/official-sso.js");

const baseOrigin = new URL(process.env.CHENLONG_LIVE_ORIGIN || "http://127.0.0.1:6190").origin;
const ssoSecret = process.env.CHENLONG_LIVE_SSO_SECRET;
const appKey = process.env.CHENLONG_LIVE_SCORE_APP_KEY;
const appSecret = process.env.CHENLONG_LIVE_SCORE_APP_SECRET;
const privateKeyPath = process.env.CHENLONG_LIVE_SCORE_PRIVATE_KEY_FILE;
if (!ssoSecret || !appKey || !appSecret || !privateKeyPath) {
  throw new Error("live SSO secret, score AppKey/AppSecret, and RSA private key file are required");
}

const suffix = `${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`.slice(-14);
const officialUserId = `QA_USER_${suffix}`;
const officialTeamId = `QA_TEAM_${suffix}`;
const teamName = `官网联调队${suffix}`.slice(0, 32);

function request(targetValue, { method = "GET", headers = {}, body = null, cookie = "" } = {}) {
  const target = new URL(targetValue, baseOrigin);
  const outgoingHeaders = { ...headers };
  if (cookie) outgoingHeaders.Cookie = cookie;
  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const outgoing = transport.request(target, { method, headers: outgoingHeaders, timeout: 30_000 }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        buffer: Buffer.concat(chunks),
      }));
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error(`request timed out: ${target.pathname}`)));
    outgoing.on("error", reject);
    outgoing.end(body || undefined);
  });
}

function json(result, label) {
  try {
    return JSON.parse(result.buffer.toString("utf8"));
  } catch {
    throw new Error(`${label} returned invalid JSON (HTTP ${result.status})`);
  }
}

function expect(result, status, label) {
  if (result.status !== status) {
    throw new Error(`${label}: expected HTTP ${status}, received ${result.status}: ${result.buffer.toString("utf8").slice(0, 500)}`);
  }
}

function cookieFrom(result) {
  const values = result.headers["set-cookie"] || [];
  const list = Array.isArray(values) ? values : [values];
  const selected = list.find(value => String(value).startsWith("chenlong_session="));
  if (!selected) throw new Error("SSO response omitted session cookie");
  return String(selected).split(";", 1)[0];
}

function decryptZip(encrypted, encryptedKey) {
  const privateKey = fs.readFileSync(privateKeyPath, "utf8");
  const key = crypto.privateDecrypt({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256",
  }, Buffer.from(encryptedKey, "base64"));
  assert.equal(key.length, 32);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, encrypted.subarray(0, 16));
  return Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]);
}

function csvFromZip(zip) {
  assert.equal(zip.readUInt32LE(0), 0x04034B50);
  assert.equal(zip.readUInt16LE(8), 8);
  const compressedSize = zip.readUInt32LE(18);
  const fileNameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  assert.equal(zip.subarray(30, 30 + fileNameLength).toString("utf8"), "score.csv");
  const start = 30 + fileNameLength + extraLength;
  return zlib.inflateRawSync(zip.subarray(start, start + compressedSize)).toString("utf8");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/u, "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      if (cell.endsWith("\r")) cell = cell.slice(0, -1);
      row.push(cell);
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  assert.equal(quoted, false, "score.csv contains an unterminated quoted field");
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function main() {
  const parameters = {
    user_id: officialUserId,
    team_id: officialTeamId,
    group_type: "primary",
    team_name: teamName,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  parameters.sign = officialSso.calculateSsoSignature(parameters, ssoSecret);
  const query = new URLSearchParams(parameters).toString();
  const first = await request(`/sso/jump?${query}`);
  expect(first, 302, "official SSO jump");
  assert.equal(first.headers.location, "/portal.html");
  const cookie = cookieFrom(first);
  const replay = await request(`/sso/jump?${query}`);
  expect(replay, 409, "official SSO replay protection");
  assert.match(replay.buffer.toString("utf8"), /1005/u);

  const me = await request("/api/platform/me", { cookie });
  expect(me, 200, "SSO platform identity");
  assert.equal(json(me, "SSO identity").user.group, "primary");

  const pythonSessionBody = Buffer.from(JSON.stringify({
    taskId: "R2-GYI-MVP-01",
    mode: "standard",
  }), "utf8");
  const pythonSession = await request("/python/api/v1/sessions", {
    method: "POST",
    cookie,
    headers: {
      Origin: new URL(process.env.CHENLONG_LIVE_REQUEST_ORIGIN || baseOrigin).origin,
      "Content-Type": "application/json",
      "Content-Length": String(pythonSessionBody.length),
    },
    body: pythonSessionBody,
  });
  expect(pythonSession, 201, "SSO user Python run session");
  const pythonSessionReceipt = json(pythonSession, "Python run session");
  assert.match(pythonSessionReceipt.sessionId, /^ses_[a-f0-9]{32}$/u);
  assert.match(pythonSessionReceipt.submitToken, /^[A-Za-z0-9_-]{32,}$/u);
  assert.equal(pythonSessionReceipt.challenge.taskId, "R2-GYI-MVP-01");

  const mapsResult = await request("/blockly/api/maps", { cookie });
  expect(mapsResult, 200, "SSO team maps");
  const map = json(mapsResult, "SSO team maps").maps[0];
  const recordBody = Buffer.from(JSON.stringify({
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
    durationMs: 1_000,
    programCode: `// qa_${suffix}: official API live test\nawait robot.forward(50);`,
    workspaceXml: "<xml xmlns=\"https://developers.google.com/blockly/xml\"></xml>",
    executionTrace: [],
  }), "utf8");
  const saved = await request("/blockly/api/records", {
    method: "POST",
    cookie,
    headers: {
      Origin: new URL(process.env.CHENLONG_LIVE_REQUEST_ORIGIN || baseOrigin).origin,
      "Content-Type": "application/json",
      "Content-Length": String(recordBody.length),
    },
    body: recordBody,
  });
  expect(saved, 201, "SSO user record save");
  const recordId = json(saved, "record save").record.id;
  const emptyBody = Buffer.from("{}", "utf8");
  const submitted = await request(`/blockly/api/records/${encodeURIComponent(recordId)}/submit`, {
    method: "POST",
    cookie,
    headers: {
      Origin: new URL(process.env.CHENLONG_LIVE_REQUEST_ORIGIN || baseOrigin).origin,
      "Content-Type": "application/json",
      "Content-Length": String(emptyBody.length),
    },
    body: emptyBody,
  });
  expect(submitted, 200, "SSO user record submit");

  const scoreBody = { competition_stage: "preliminary", pull_type: "all" };
  const encodedScoreBody = Buffer.from(JSON.stringify(scoreBody), "utf8");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signParameters = { AppKey: appKey, Timestamp: timestamp };
  for (const [key, value] of Object.entries(scoreBody)) signParameters[key] = String(value);
  const scoreResponse = await request("/v1/score/batch-download", {
    method: "POST",
    headers: {
      AppKey: appKey,
      Timestamp: timestamp,
      Sign: scoreApi.computeRequestSign(signParameters, appSecret),
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(encodedScoreBody.length),
    },
    body: encodedScoreBody,
  });
  expect(scoreResponse, 200, "official score package request");
  const scoreReceipt = json(scoreResponse, "official score package request");
  assert.equal(scoreReceipt.code, 200);
  const download = await request(scoreReceipt.data.download_url);
  expect(download, 200, "official encrypted score download");
  const csv = csvFromZip(decryptZip(download.buffer, scoreReceipt.data.encrypt_password));
  const csvRows = parseCsv(csv);
  const expectedColumns = [
    "user_id", "team_id", "team_name", "group_type", "score_task1",
    "score_task2", "total_score", "group_rank", "promote_status",
    "evaluate_finish_time",
  ];
  assert.deepEqual(csvRows[0], expectedColumns);
  assert.ok(csvRows.slice(1).every(row => row.length === expectedColumns.length));
  const officialRowValues = csvRows.slice(1).find(row => row[0] === officialUserId);
  assert.ok(officialRowValues, "score.csv omitted the SSO user");
  const officialRow = Object.fromEntries(expectedColumns.map((column, index) => [column, officialRowValues[index]]));
  assert.equal(officialRow.team_id, officialTeamId);
  assert.equal(officialRow.team_name, teamName);
  assert.equal(officialRow.group_type, "primary");
  for (const field of ["score_task1", "score_task2", "total_score", "group_rank", "promote_status", "evaluate_finish_time"]) {
    assert.match(officialRow[field], /^\d+$/u, `${field} must be an integer`);
  }
  assert.equal(Number(officialRow.total_score), Number(officialRow.score_task1) + Number(officialRow.score_task2));
  assert.ok(Number(officialRow.group_rank) >= 1);
  assert.ok([0, 1].includes(Number(officialRow.promote_status)));
  assert.ok(Number(officialRow.evaluate_finish_time) <= scoreReceipt.data.snapshot_time);

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    officialUserId,
    officialTeamId,
    ssoReplayRejected: true,
    pythonRunSessionCreated: true,
    submittedRecordId: recordId,
    scoreRows: scoreReceipt.data.total,
    encryptedBytes: download.buffer.length,
    csvContractValidated: true,
  }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`official API live acceptance failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
