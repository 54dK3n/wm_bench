#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const JSZip = require(path.join(__dirname, "..", "projects", "tmm", "node_modules", "jszip"));

const baseOrigin = new URL(process.env.CHENLONG_LIVE_ORIGIN || "http://127.0.0.1:6190").origin;
const browserOrigin = new URL(process.env.CHENLONG_LIVE_REQUEST_ORIGIN || baseOrigin).origin;
const adminUsername = process.env.CHENLONG_LIVE_ADMIN || "qwer";
const adminPassword = process.env.CHENLONG_LIVE_ADMIN_PASSWORD;
if (!adminPassword) throw new Error("CHENLONG_LIVE_ADMIN_PASSWORD is required");

const suffix = `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`.slice(-12);
const participantPassword = `Qa-${crypto.randomBytes(18).toString("base64url")}!9`;
const groups = Object.freeze(["primary", "junior", "high"]);

function request(requestPath, {
  method = "GET", cookie = "", body = null, origin = null, accept = "application/json",
} = {}) {
  const target = new URL(requestPath, baseOrigin);
  const encoded = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
  const headers = { Accept: accept };
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (encoded) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = encoded.length;
  }
  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const outgoing = transport.request(target, { method, headers, timeout: 30_000 }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        buffer: Buffer.concat(chunks),
      }));
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error(`request timed out: ${requestPath}`)));
    outgoing.on("error", reject);
    outgoing.end(encoded || undefined);
  });
}

function payload(result, label) {
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

function sessionCookie(result) {
  const values = result.headers["set-cookie"] || [];
  const list = Array.isArray(values) ? values : [values];
  const selected = list.find(value => String(value).startsWith("chenlong_session="));
  if (!selected) throw new Error("authentication response omitted chenlong_session cookie");
  return String(selected).split(";", 1)[0];
}

async function register({ username, group, teamName = null, inviteCode = null }) {
  const body = {
    username,
    password: participantPassword,
    group,
    teamAction: inviteCode ? "join" : "create",
    ...(inviteCode ? { inviteCode } : { teamName }),
  };
  const result = await request("/api/v1/auth/register", {
    method: "POST",
    origin: browserOrigin,
    body,
  });
  expect(result, 201, `register ${username}`);
  const cookie = sessionCookie(result);
  const registered = payload(result, `register ${username}`);
  // The public authentication response deliberately omits the internal team
  // id.  Read the unified participant profile instead of assuming a private
  // field is exposed by registration.
  const profileResult = await request("/api/platform/me", { cookie });
  expect(profileResult, 200, `platform identity after registering ${username}`);
  const profile = payload(profileResult, `platform identity after registering ${username}`).user;
  return {
    cookie,
    ...registered,
    user: { ...registered.user, teamId: profile.teamId },
  };
}

async function login(username, password) {
  const result = await request("/api/v1/auth/login", {
    method: "POST",
    origin: browserOrigin,
    body: { username, password },
  });
  expect(result, 200, `login ${username}`);
  return { cookie: sessionCookie(result), ...payload(result, `login ${username}`) };
}

async function createSubmittedRecord(participant, map, sequence) {
  const programCode = [
    `// qa_${suffix}: real multi-account acceptance ${sequence}`,
    "await robot.forward(50);",
    "await robot.turnAngle(\"left\", 90);",
  ].join("\n");
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
      blockedMoves: sequence % 2,
      offRoadEpisodes: 0,
      offRoadDurationMs: 0,
      durationMs: 1_000 + sequence * 100,
      programCode,
      workspaceXml: `<xml xmlns="https://developers.google.com/blockly/xml"><variables><variable id="qa">qa_${suffix}</variable></variables></xml>`,
      executionTrace: [],
    },
  });
  expect(saved, 201, `save Blockly record ${participant.user.username}`);
  const record = payload(saved, "save Blockly record").record;
  const submitted = await request(`/blockly/api/records/${encodeURIComponent(record.id)}/submit`, {
    method: "POST",
    cookie: participant.cookie,
    origin: browserOrigin,
    body: {},
  });
  expect(submitted, 200, `submit Blockly record ${record.id}`);
  assert.equal(payload(submitted, "submit Blockly record").record.recordState, "submitted");
  return record.id;
}

function encodeFloat32(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

async function createWorkshopModel() {
  const embeddingSize = 1280;
  const hiddenUnits = 100;
  const classCount = 2;
  const kernelOne = new Float32Array(embeddingSize * hiddenUnits);
  const biasOne = new Float32Array(hiddenUnits);
  const kernelTwo = new Float32Array(hiddenUnits * classCount);
  const biasTwo = new Float32Array(classCount);
  biasOne[0] = 1;
  kernelTwo[0] = 1;
  kernelTwo[1] = -1;
  const zip = new JSZip();
  zip.file("model.json", JSON.stringify({
    modelTopology: { class_name: "Sequential", config: { layers: [] } },
    weightsManifest: [{
      paths: ["weights.bin"],
      weights: [
        { name: "dense/kernel", shape: [embeddingSize, hiddenUnits], dtype: "float32" },
        { name: "dense/bias", shape: [hiddenUnits], dtype: "float32" },
        { name: "dense_1/kernel", shape: [hiddenUnits, classCount], dtype: "float32" },
        { name: "dense_1/bias", shape: [classCount], dtype: "float32" },
      ],
    }],
  }));
  zip.file("weights.bin", encodeFloat32([
    ...kernelOne, ...biasOne, ...kernelTwo, ...biasTwo,
  ]), { binary: true, compression: "STORE" });
  zip.file("metadata.json", JSON.stringify({
    format: "tm-object-classifier",
    formatVersion: 1,
    name: `QA识物模型${suffix}`,
    createdAt: new Date().toISOString(),
    imageSize: 224,
    labels: [
      { id: "qa-orange", name: "橙子", color: "#3157D5" },
      { id: "qa-other", name: "非橙子", color: "#F47A5A" },
    ],
    featureExtractor: "MobileNet v2 alpha 0.5 embedding",
    prediction: { confidenceThreshold: 0.65, marginThreshold: 0.12 },
  }));
  return Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

async function submitWorkshopModel(participant) {
  const model = await createWorkshopModel();
  const form = new FormData();
  form.append("model", new Blob([model], { type: "application/zip" }), `qa_${suffix}.zip`);
  const response = await fetch(new URL("/api/competition/submissions", baseOrigin), {
    method: "POST",
    headers: {
      Cookie: participant.cookie,
      Origin: browserOrigin,
      "Idempotency-Key": `qa_${suffix}_${crypto.randomBytes(8).toString("hex")}`,
    },
    body: form,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const result = { status: response.status, headers: Object.fromEntries(response.headers), buffer };
  expect(result, 201, "submit workshop model");
  const submission = payload(result, "submit workshop model").submission;
  assert.match(submission.id, /^[0-9a-f-]{36}$/u);
  return submission.id;
}

async function main() {
  const health = await request("/api/health");
  expect(health, 200, "platform health");
  assert.equal(payload(health, "platform health").capacity.maxAccounts, 2_000);

  const participants = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const username = `qa_${group}_${suffix}`.slice(0, 32);
    const created = await register({
      username,
      group,
      teamName: `QA${index + 1}队${suffix}`.slice(0, 32),
    });
    assert.equal(created.user.group, group);
    assert.match(created.user.teamId, /^tea_[a-f0-9]{32}$/u);
    participants.push(created);
  }

  const teammate = await register({
    username: `qa_mate_${suffix}`.slice(0, 32),
    group: "primary",
    inviteCode: participants[0].teamInviteCode,
  });
  assert.equal(teammate.user.teamId, participants[0].user.teamId);
  assert.equal(teammate.user.group, "primary");
  participants.push(teammate);

  const recordIds = [];
  for (let index = 0; index < participants.length; index += 1) {
    const participant = participants[index];
    const me = await request("/api/platform/me", { cookie: participant.cookie });
    expect(me, 200, `platform identity ${participant.user.username}`);
    assert.equal(payload(me, "platform identity").user.group, participant.user.group);

    const blocklyMe = await request("/blockly/api/auth/me", { cookie: participant.cookie });
    expect(blocklyMe, 200, `Blockly identity ${participant.user.username}`);
    const workshopMe = await request("/api/competition/me", { cookie: participant.cookie });
    expect(workshopMe, 200, `workshop identity ${participant.user.username}`);

    const mapsResult = await request("/blockly/api/maps", { cookie: participant.cookie });
    expect(mapsResult, 200, `maps ${participant.user.username}`);
    const maps = payload(mapsResult, "maps").maps;
    assert.equal(maps.length, 3);
    const map = maps[index % maps.length];
    recordIds.push(await createSubmittedRecord(participant, map, index));
  }
  const workshopSubmissionId = await submitWorkshopModel(participants[0]);

  const admin = await login(adminUsername, adminPassword);
  assert.equal(admin.user.role, "admin");
  let usersResult = await request("/api/platform/admin/users", { cookie: admin.cookie });
  expect(usersResult, 200, "admin users");
  let users = payload(usersResult, "admin users").users;
  for (const participant of participants) {
    assert.ok(users.some(user => user.id === participant.user.id && user.group === participant.user.group));
  }

  const renamedTeam = `QA同步队${suffix}`.slice(0, 32);
  const update = await request(`/api/platform/admin/users/${encodeURIComponent(participants[0].user.id)}`, {
    method: "PATCH",
    cookie: admin.cookie,
    origin: browserOrigin,
    body: { teamName: renamedTeam, group: "junior" },
  });
  expect(update, 200, "admin team-wide update");
  usersResult = await request("/api/platform/admin/users", { cookie: admin.cookie });
  users = payload(usersResult, "admin users after update").users;
  const teamMembers = users.filter(user => user.teamId === participants[0].user.teamId);
  assert.equal(teamMembers.length, 2);
  assert.ok(teamMembers.every(user => user.teamName === renamedTeam && user.group === "junior"));

  const records = await request("/blockly/api/admin/records?page=1&pageSize=100", { cookie: admin.cookie });
  expect(records, 200, "admin Blockly records");
  const recordPayload = payload(records, "admin Blockly records");
  const adminRecords = recordPayload.records || recordPayload.items || [];
  for (const recordId of recordIds) assert.ok(adminRecords.some(record => record.id === recordId));

  const overview = await request("/api/platform/admin/overview?page=1", { cookie: admin.cookie });
  expect(overview, 200, "admin score overview");
  assert.equal(payload(overview, "admin score overview").pagination.pageSize, 15);
  const exported = await request("/api/platform/admin/export", { cookie: admin.cookie });
  expect(exported, 200, "admin CSV export");
  assert.match(String(exported.headers["content-type"] || ""), /text\/csv/u);
  assert.match(exported.buffer.toString("utf8"), new RegExp(renamedTeam, "u"));
  const workshopAdmin = await request("/api/competition/admin/overview", { cookie: admin.cookie });
  expect(workshopAdmin, 200, "admin workshop overview");
  const workshopRows = Object.values(payload(workshopAdmin, "admin workshop overview").leaderboards || {}).flat();
  assert.ok(workshopRows.some(row => row.submissionId === workshopSubmissionId));

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    accountPrefix: `qa_*_${suffix}`,
    groupsRegistered: groups,
    accountsCreated: participants.length,
    recordsSubmitted: recordIds.length,
    workshopSubmissions: 1,
    teamSynchronizationChecked: true,
    cleanup: "node tools/cleanup-test-data.js --apply --archive <record-backups child>",
  }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`multi-account live acceptance failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
