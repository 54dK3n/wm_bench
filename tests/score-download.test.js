"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const scores = require("../packages/score-download.js");
const platform = require("../server.js");

const APP_KEY = "official_web_test";
const APP_SECRET = "official-score-test-secret-1234567890";
const NOW = 1_726_588_800;

function rsaKeys() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

function scoreRow(overrides = {}) {
  return {
    user_id: "official-user-001",
    team_id: "official-team-001",
    team_name: "测试队",
    group_type: "primary",
    score_task1: 60,
    score_task2: 20,
    total_score: 80,
    group_rank: 1,
    promote_status: 1,
    evaluate_finish_time: NOW - 10,
    ...overrides
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request(origin, requestPath, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(requestPath, origin);
    const req = http.request(target, { method, headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function json(result) {
  return JSON.parse(result.body.toString("utf8"));
}

function signedHeaders(body, timestamp = NOW, overrides = {}) {
  const parameters = { AppKey: APP_KEY, Timestamp: String(timestamp) };
  for (const key of Object.keys(body)) parameters[key] = String(body[key]);
  return {
    "content-type": "application/json; charset=utf-8",
    AppKey: APP_KEY,
    Timestamp: String(timestamp),
    Sign: scores.computeRequestSign(parameters, APP_SECRET),
    ...overrides
  };
}

function decryptZip(encrypted, encryptedKey, privateKey) {
  const key = crypto.privateDecrypt({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256"
  }, Buffer.from(encryptedKey, "base64"));
  assert.equal(key.length, 32);
  const iv = encrypted.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]);
}

function decryptEnvelopeWithoutRemovingIv(encrypted, encryptedKey, privateKey) {
  const key = crypto.privateDecrypt({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256"
  }, Buffer.from(encryptedKey, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, encrypted.subarray(0, 16));
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function scoreCsvFromZip(zip) {
  assert.equal(zip.readUInt32LE(0), 0x04034B50);
  assert.equal(zip.readUInt16LE(8), 8);
  const compressedSize = zip.readUInt32LE(18);
  const fileNameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  const name = zip.subarray(30, 30 + fileNameLength).toString("utf8");
  assert.equal(name, "score.csv");
  const start = 30 + fileNameLength + extraLength;
  const csv = zlib.inflateRawSync(zip.subarray(start, start + compressedSize));

  const endOffset = zip.length - 22;
  assert.equal(zip.readUInt32LE(endOffset), 0x06054B50, "ZIP must end with a standard EOCD record");
  assert.equal(zip.readUInt16LE(endOffset + 8), 1, "ZIP must contain one entry on this disk");
  assert.equal(zip.readUInt16LE(endOffset + 10), 1, "ZIP must contain exactly one central-directory entry");
  const centralSize = zip.readUInt32LE(endOffset + 12);
  const centralOffset = zip.readUInt32LE(endOffset + 16);
  assert.equal(centralOffset + centralSize, endOffset);
  assert.equal(zip.readUInt32LE(centralOffset), 0x02014B50, "ZIP central-directory signature is required");
  assert.equal(zip.readUInt32LE(centralOffset + 42), 0, "score.csv local header must start at offset zero");
  const centralNameLength = zip.readUInt16LE(centralOffset + 28);
  const centralName = zip.subarray(centralOffset + 46, centralOffset + 46 + centralNameLength).toString("utf8");
  assert.equal(centralName, "score.csv");
  assert.equal(zip.readUInt32LE(centralOffset + 16), crc32ForTest(csv));
  return csv.toString("utf8");
}

function crc32ForTest(buffer) {
  let value = 0xFFFFFFFF;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xEDB88320 : 0);
  }
  return (value ^ 0xFFFFFFFF) >>> 0;
}

function scoreCsvRows(csv) {
  const lines = csv.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
  const cells = line => line.split(",").map(cell => cell.slice(1, -1).replace(/""/g, '"'));
  const columns = cells(lines[0]);
  return lines.slice(1).map(line => Object.fromEntries(
    cells(line).map((value, index) => [columns[index], value])
  ));
}

async function fixture({ rows = [scoreRow()], source = null, now = NOW, serviceConfig = {} } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "official-score-download-test-"));
  const keys = rsaKeys();
  const calls = [];
  const scoreDataSource = source || {
    async listScoreRows(context) {
      calls.push(context);
      return { rows, snapshotTime: now };
    }
  };
  let origin;
  const service = scores.createScoreDownloadService({
    apps: {
      [APP_KEY]: {
        appSecret: APP_SECRET,
        ipAllowlist: ["127.0.0.1"],
        rsaPublicKey: keys.publicKey
      }
    },
    scoreDataSource,
    runtimeDir: temporary,
    nowSeconds: () => now,
    ...serviceConfig
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const handled = await service.handle(req, res, { pathname: url.pathname, externalOrigin: origin });
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  origin = await listen(server);
  return { temporary, keys, calls, service, server, origin };
}

test("signature canonicalization follows ASCII parameter order and lowercase SHA256", () => {
  const parameters = {
    pull_type: "all",
    Timestamp: "1726588800",
    competition_stage: "preliminary",
    AppKey: "official_web"
  };
  const text = scores.canonicalSignatureText(parameters, "example-secret");
  assert.equal(text,
    "AppKey=official_web&Timestamp=1726588800&competition_stage=preliminary&pull_type=all&AppSecret=example-secret");
  assert.match(scores.computeRequestSign(parameters, "example-secret"), /^[a-f0-9]{64}$/);
});

test("four 25 percent components map to the two official score fields", () => {
  assert.deepEqual(scores.scoreContributions({ task1: 100, task2: 80, task3: 60 }, 92), {
    score_task1: 60,
    score_task2: 23,
    total_score: 83
  });
  assert.deepEqual(scores.scoreContributions({}, null), {
    score_task1: 0,
    score_task2: 0,
    total_score: 0
  });
  assert.deepEqual(scores.scoreContributions({ task1: 66, task2: 66, task3: 66 }, 66), {
    score_task1: 50,
    score_task2: 17,
    total_score: 67
  }, "each official integer field is rounded first and total_score is their exact sum");
});

test("batch download produces a protected token and an AES/RSA decryptable score.csv ZIP", async t => {
  const value = scoreRow({ team_name: "=公式队" });
  const setup = await fixture({ rows: [value] });
  t.after(() => close(setup.server));
  const body = { competition_stage: "preliminary", pull_type: "all" };
  const result = await request(setup.origin, scores.BATCH_PATH, {
    method: "POST",
    headers: signedHeaders(body),
    body: Buffer.from(JSON.stringify(body))
  });
  assert.equal(result.status, 200);
  const payload = json(result);
  assert.equal(payload.code, 200);
  assert.equal(payload.data.total, 1);
  assert.equal(payload.data.expire_time, NOW + scores.DOWNLOAD_TTL_SECONDS);
  assert.equal(setup.calls.length, 1);

  const download = await request(setup.origin, new URL(payload.data.download_url).pathname, {
    headers: { AppKey: APP_KEY }
  });
  assert.equal(download.status, 200);
  assert.equal(download.body.length, payload.data.file_size);
  assert.equal(download.headers["x-content-encryption"], "AES-256-CBC; iv-prefix=16");
  const zip = decryptZip(download.body, payload.data.encrypt_password, setup.keys.privateKey);
  const csv = scoreCsvFromZip(zip);
  assert.ok(csv.startsWith(`\uFEFF${scores.CSV_COLUMNS.map(column => `"${column}"`).join(",")}\r\n`));
  assert.match(csv, /"'=公式队"/);
  assert.match(csv, /"official-user-001","official-team-001"/);

  const incorrectlyDecrypted = decryptEnvelopeWithoutRemovingIv(
    download.body,
    payload.data.encrypt_password,
    setup.keys.privateKey
  );
  assert.equal(incorrectlyDecrypted.indexOf(Buffer.from([0x50, 0x4B, 0x03, 0x04])), 16,
    "decrypting the IV as ciphertext prepends 16 bytes and makes Windows display an empty ZIP");
  assert.deepEqual(incorrectlyDecrypted.subarray(16), zip);

  const noAppKey = await request(setup.origin, new URL(payload.data.download_url).pathname);
  assert.equal(noAppKey.status, 200, "the high-entropy URL is sufficient when the caller IP is allowed");
  const guessed = await request(setup.origin, `${scores.DOWNLOAD_PATH_PREFIX}${"A".repeat(43)}`, {
    headers: { AppKey: APP_KEY }
  });
  assert.equal(guessed.status, 404);
});

test("timestamp, signature, replay and daily limits are enforced before score generation", async t => {
  const setup = await fixture();
  t.after(() => close(setup.server));
  const body = { competition_stage: "preliminary" };
  const expired = await request(setup.origin, scores.BATCH_PATH, {
    method: "POST", headers: signedHeaders(body, NOW - 301), body: Buffer.from(JSON.stringify(body))
  });
  assert.equal(expired.status, 401);
  assert.equal(json(expired).code, 4004);
  const forged = await request(setup.origin, scores.BATCH_PATH, {
    method: "POST", headers: signedHeaders(body, NOW, { Sign: "0".repeat(64) }), body: Buffer.from(JSON.stringify(body))
  });
  assert.equal(forged.status, 401);
  assert.equal(json(forged).code, 4003);
  const uppercase = await request(setup.origin, scores.BATCH_PATH, {
    method: "POST",
    headers: signedHeaders(body, NOW, { Sign: signedHeaders(body).Sign.toUpperCase() }),
    body: Buffer.from(JSON.stringify(body))
  });
  assert.equal(uppercase.status, 401);
  assert.equal(json(uppercase).code, 4003);
  assert.equal(setup.calls.length, 0);

  const first = await request(setup.origin, scores.BATCH_PATH, {
    method: "POST", headers: signedHeaders(body), body: Buffer.from(JSON.stringify(body))
  });
  assert.equal(first.status, 200);
  const replay = await request(setup.origin, scores.BATCH_PATH, {
    method: "POST", headers: signedHeaders(body), body: Buffer.from(JSON.stringify(body))
  });
  assert.equal(replay.status, 401);
  assert.equal(json(replay).code, 4003);
  for (let offset = 1; offset <= 4; offset += 1) {
    const accepted = await request(setup.origin, scores.BATCH_PATH, {
      method: "POST",
      headers: signedHeaders(body, NOW - offset),
      body: Buffer.from(JSON.stringify(body))
    });
    assert.equal(accepted.status, 200);
  }
  const limited = await request(setup.origin, scores.BATCH_PATH, {
    method: "POST",
    headers: signedHeaders(body, NOW - 5),
    body: Buffer.from(JSON.stringify(body))
  });
  assert.equal(limited.status, 429);
  assert.equal(json(limited).code, 4006);
  assert.equal(setup.calls.length, 5);
});

test("increment packages do not consume the five full-package slots and use an independent rate limit", async t => {
  const setup = await fixture({
    serviceConfig: { incrementRateLimit: 2, incrementRateWindowSeconds: 60 }
  });
  t.after(() => close(setup.server));

  for (let offset = 0; offset < 2; offset += 1) {
    const body = {
      competition_stage: "preliminary",
      pull_type: "increment",
      last_update_time: NOW - 100 - offset
    };
    const result = await request(setup.origin, scores.BATCH_PATH, {
      method: "POST",
      headers: signedHeaders(body, NOW - offset),
      body: Buffer.from(JSON.stringify(body))
    });
    assert.equal(result.status, 200);
  }
  const thirdIncrement = {
    competition_stage: "preliminary",
    pull_type: "increment",
    last_update_time: NOW - 102
  };
  const rateLimited = await request(setup.origin, scores.BATCH_PATH, {
    method: "POST",
    headers: signedHeaders(thirdIncrement, NOW - 2),
    body: Buffer.from(JSON.stringify(thirdIncrement))
  });
  assert.equal(rateLimited.status, 429);
  assert.equal(json(rateLimited).code, 4006);
  assert.match(json(rateLimited).message, /增量/);

  const all = { competition_stage: "preliminary", pull_type: "all" };
  for (let offset = 0; offset < scores.DAILY_LIMIT; offset += 1) {
    const accepted = await request(setup.origin, scores.BATCH_PATH, {
      method: "POST",
      headers: signedHeaders(all, NOW - 10 - offset),
      body: Buffer.from(JSON.stringify(all))
    });
    assert.equal(accepted.status, 200,
      "successful increment pulls must not reduce the five available all-package slots");
  }
  const fullLimited = await request(setup.origin, scores.BATCH_PATH, {
    method: "POST",
    headers: signedHeaders(all, NOW - 20),
    body: Buffer.from(JSON.stringify(all))
  });
  assert.equal(fullLimited.status, 429);
  assert.equal(json(fullLimited).code, 4006);
  assert.match(json(fullLimited).message, /全量/);
});

test("failed increment generation still consumes its independent safety rate but no full-package quota", async t => {
  let calls = 0;
  const setup = await fixture({
    source: {
      async listScoreRows() {
        calls += 1;
        throw new Error("snapshot unavailable");
      }
    },
    serviceConfig: { incrementRateLimit: 2, incrementRateWindowSeconds: 60 }
  });
  t.after(() => close(setup.server));

  for (let offset = 0; offset < 2; offset += 1) {
    const body = {
      competition_stage: "preliminary",
      pull_type: "increment",
      last_update_time: NOW - 100 - offset
    };
    const failed = await request(setup.origin, scores.BATCH_PATH, {
      method: "POST",
      headers: signedHeaders(body, NOW - offset),
      body: Buffer.from(JSON.stringify(body))
    });
    assert.equal(failed.status, 503);
  }
  const third = {
    competition_stage: "preliminary",
    pull_type: "increment",
    last_update_time: NOW - 102
  };
  const limited = await request(setup.origin, scores.BATCH_PATH, {
    method: "POST",
    headers: signedHeaders(third, NOW - 2),
    body: Buffer.from(JSON.stringify(third))
  });
  assert.equal(limited.status, 429);
  assert.equal(calls, 2, "the rate limiter stops repeated generation failures before calling the source again");

  const all = { competition_stage: "preliminary", pull_type: "all" };
  const fullAttempt = await request(setup.origin, scores.BATCH_PATH, {
    method: "POST",
    headers: signedHeaders(all, NOW - 10),
    body: Buffer.from(JSON.stringify(all))
  });
  assert.equal(fullAttempt.status, 503,
    "increment rate exhaustion must not turn into exhaustion of the independent all-package quota");
});

test("concurrent identical requests cannot bypass persistent replay protection", async t => {
  const setup = await fixture();
  t.after(() => close(setup.server));
  const body = { competition_stage: "rematch", group_type: "primary", pull_type: "all" };
  const attempts = await Promise.all(Array.from({ length: 20 }, () => request(setup.origin, scores.BATCH_PATH, {
    method: "POST", headers: signedHeaders(body), body: Buffer.from(JSON.stringify(body))
  })));
  assert.equal(attempts.filter(item => item.status === 200).length, 1);
  assert.equal(attempts.filter(item => item.status === 401 && json(item).code === 4003).length, 19);
  assert.equal(setup.calls.length, 1);
});

test("group and incremental filters are applied and more than 50,000 output rows fail closed", async t => {
  const rows = [
    scoreRow({ user_id: "one", team_id: "team-one", evaluate_finish_time: NOW - 100 }),
    scoreRow({ user_id: "two", team_id: "team-two", group_type: "primary_high", evaluate_finish_time: NOW - 10 }),
    scoreRow({ user_id: "three", team_id: "team-three", group_type: "junior", evaluate_finish_time: NOW - 1 })
  ];
  const setup = await fixture({ rows });
  t.after(() => close(setup.server));
  const body = {
    competition_stage: "preliminary",
    group_type: "primary",
    pull_type: "increment",
    last_update_time: NOW - 50
  };
  const result = await request(setup.origin, scores.BATCH_PATH, {
    method: "POST", headers: signedHeaders(body), body: Buffer.from(JSON.stringify(body))
  });
  assert.equal(result.status, 200);
  assert.equal(json(result).data.total, 1);

  const tooMany = await fixture({ rows: Array.from({ length: scores.MAX_EXPORT_ROWS + 1 }, (_, index) => scoreRow({
    user_id: `user-${index}`,
    team_id: `team-${index}`,
    group_rank: index + 1
  })) });
  t.after(() => close(tooMany.server));
  const all = { competition_stage: "preliminary", pull_type: "all" };
  const rejected = await request(tooMany.origin, scores.BATCH_PATH, {
    method: "POST", headers: signedHeaders(all), body: Buffer.from(JSON.stringify(all))
  });
  assert.equal(rejected.status, 503);
  assert.equal(json(rejected).code, 5002);
});

test("team ranking expands multiple unique users without ranking the same team twice", async t => {
  const rows = [
    scoreRow({ user_id: "user-a2", team_id: "team-a", team_name: "甲队", score_task1: 70, score_task2: 20, total_score: 90 }),
    scoreRow({ user_id: "user-a1", team_id: "team-a", team_name: "甲队", score_task1: 70, score_task2: 20, total_score: 90 }),
    scoreRow({ user_id: "user-b1", team_id: "team-b", team_name: "乙队", score_task1: 70, score_task2: 20, total_score: 90 }),
    scoreRow({ user_id: "user-c1", team_id: "team-c", team_name: "丙队", score_task1: 60, score_task2: 20, total_score: 80 })
  ];
  const setup = await fixture({ rows });
  t.after(() => close(setup.server));
  const body = { competition_stage: "preliminary", pull_type: "all" };
  const result = await request(setup.origin, scores.BATCH_PATH, {
    method: "POST", headers: signedHeaders(body), body: Buffer.from(JSON.stringify(body))
  });
  assert.equal(result.status, 200);
  const payload = json(result);
  assert.equal(payload.data.total, 4, "CSV contains one row per official user");
  const download = await request(setup.origin, new URL(payload.data.download_url).pathname, {
    headers: { AppKey: APP_KEY }
  });
  assert.equal(download.status, 200);
  const csvRows = scoreCsvRows(scoreCsvFromZip(
    decryptZip(download.body, payload.data.encrypt_password, setup.keys.privateKey)
  ));
  assert.deepEqual(csvRows.map(row => [row.user_id, row.team_id, row.group_rank]), [
    ["user-a1", "team-a", "1"],
    ["user-a2", "team-a", "1"],
    ["user-b1", "team-b", "1"],
    ["user-c1", "team-c", "3"]
  ]);
  assert.deepEqual(
    csvRows.filter(row => row.team_id === "team-a").map(row => [row.score_task1, row.score_task2, row.total_score]),
    [["70", "20", "90"], ["70", "20", "90"]]
  );
});

test("snapshot data source supports a separate ordered identity mapping interface", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "official-score-source-test-"));
  const snapshotPath = path.join(temporary, "snapshot.json");
  fs.writeFileSync(snapshotPath, JSON.stringify({
    schemaVersion: scores.SNAPSHOT_SCHEMA_VERSION,
    snapshot_time: NOW,
    rows: [{
      ...scoreRow({ user_id: undefined, team_id: undefined }),
      competition_stage: "preliminary",
      local_user_id: "usr_local",
      local_team_id: "team_local"
    }]
  }));
  const source = scores.createJsonScoreDataSource({
    filePath: snapshotPath,
    identityDataSource: {
      async resolveMany(rows, context) {
        assert.equal(context.competitionStage, "preliminary");
        assert.equal(rows[0].local_user_id, "usr_local");
        return [{ user_id: "official-user", team_id: "official-team" }];
      }
    }
  });
  const result = await source.listScoreRows({ competitionStage: "preliminary" });
  assert.equal(result.rows[0].user_id, "official-user");
  assert.equal(result.rows[0].team_id, "official-team");
  assert.equal(result.snapshotTime, NOW);
});

test("RSA keys smaller than 2048 bits and missing identity/score configuration fail closed", async () => {
  const weak = crypto.generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  assert.throws(() => scores.createScoreDownloadService({
    apps: {
      [APP_KEY]: {
        appSecret: APP_SECRET,
        ipAllowlist: ["127.0.0.1"],
        rsaPublicKey: weak.publicKey
      }
    }
  }), /RSA-2048/);
});

test("the unified gateway exposes the official batch route without a participant session", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "official-score-gateway-test-"));
  const keys = rsaKeys();
  const service = scores.createScoreDownloadService({
    apps: {
      [APP_KEY]: {
        appSecret: APP_SECRET,
        ipAllowlist: ["127.0.0.1"],
        rsaPublicKey: keys.publicKey
      }
    },
    scoreDataSource: { async listScoreRows() { return { rows: [scoreRow()], snapshotTime: NOW }; } },
    runtimeDir: temporary,
    nowSeconds: () => NOW
  });
  const server = platform.createServer({
    secret: "platform-score-route-test-secret-123456789",
    scoreDownloadService: service
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const body = { competition_stage: "preliminary", pull_type: "all" };
  const result = await request(origin, scores.BATCH_PATH, {
    method: "POST",
    headers: signedHeaders(body),
    body: Buffer.from(JSON.stringify(body))
  });
  assert.equal(result.status, 200);
  assert.equal(json(result).data.total, 1);
});

test("an explicitly configured score snapshot takes precedence over live child services", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "official-score-snapshot-gateway-test-"));
  const snapshotPath = path.join(temporary, "snapshot.json");
  const keys = rsaKeys();
  fs.writeFileSync(snapshotPath, JSON.stringify({
    schemaVersion: scores.SNAPSHOT_SCHEMA_VERSION,
    snapshot_time: NOW,
    rows: [{ ...scoreRow(), competition_stage: "rematch" }]
  }));
  const server = platform.createServer({
    secret: "platform-score-snapshot-test-secret-123456789",
    authStorePath: path.join(temporary, "intentionally-absent-auth-store.json"),
    scoreDownload: {
      apps: {
        [APP_KEY]: {
          appSecret: APP_SECRET,
          ipAllowlist: ["127.0.0.1"],
          rsaPublicKey: keys.publicKey
        }
      },
      snapshotPath,
      runtimeDir: path.join(temporary, "runtime"),
      nowSeconds: () => NOW
    }
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const body = { competition_stage: "rematch", pull_type: "all" };
  const result = await request(origin, scores.BATCH_PATH, {
    method: "POST", headers: signedHeaders(body), body: Buffer.from(JSON.stringify(body))
  });
  assert.equal(result.status, 200);
  assert.equal(json(result).data.total, 1);
});

test("a package created by one allowed host can be downloaded by another allowed host", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "official-score-ip-test-"));
  const keys = rsaKeys();
  let origin;
  const service = scores.createScoreDownloadService({
    apps: {
      [APP_KEY]: {
        appSecret: APP_SECRET,
        ipAllowlist: ["203.0.113.10", "203.0.113.11"],
        rsaPublicKey: keys.publicKey
      }
    },
    trustedProxyIps: ["127.0.0.1"],
    scoreDataSource: { async listScoreRows() { return { rows: [scoreRow()], snapshotTime: NOW }; } },
    runtimeDir: temporary,
    nowSeconds: () => NOW
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    await service.handle(req, res, { pathname: url.pathname, externalOrigin: origin });
  });
  origin = await listen(server);
  t.after(() => close(server));
  const body = { competition_stage: "preliminary" };
  const created = await request(origin, scores.BATCH_PATH, {
    method: "POST",
    headers: { ...signedHeaders(body), "X-Forwarded-For": "203.0.113.10" },
    body: Buffer.from(JSON.stringify(body))
  });
  assert.equal(created.status, 200);
  const pathname = new URL(json(created).data.download_url).pathname;
  const secondAllowedHost = await request(origin, pathname, {
    headers: { "X-Forwarded-For": "203.0.113.11" }
  });
  assert.equal(secondAllowedHost.status, 200);
  const creatingHost = await request(origin, pathname, {
    headers: { AppKey: APP_KEY, "X-Forwarded-For": "203.0.113.10" }
  });
  assert.equal(creatingHost.status, 200);
  const outsideAllowlist = await request(origin, pathname, {
    headers: { "X-Forwarded-For": "203.0.113.12" }
  });
  assert.equal(outsideAllowlist.status, 403);
  assert.equal(json(outsideAllowlist).code, 4005);
  const mismatchedOptionalAppKey = await request(origin, pathname, {
    headers: { AppKey: "another-official-app", "X-Forwarded-For": "203.0.113.11" }
  });
  assert.equal(mismatchedOptionalAppKey.status, 404);
});

test("IPv4 and IPv6 CIDR allowlists accept only addresses inside the configured ranges", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "official-score-cidr-test-"));
  const keys = rsaKeys();
  let origin;
  const service = scores.createScoreDownloadService({
    apps: {
      [APP_KEY]: {
        appSecret: APP_SECRET,
        ipAllowlist: ["203.0.113.10/29", "2001:db8:abcd::1/48"],
        rsaPublicKey: keys.publicKey
      }
    },
    trustedProxyIps: ["127.0.0.1"],
    scoreDataSource: { async listScoreRows() { return { rows: [scoreRow()], snapshotTime: NOW }; } },
    runtimeDir: temporary,
    nowSeconds: () => NOW
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    await service.handle(req, res, { pathname: url.pathname, externalOrigin: origin });
  });
  origin = await listen(server);
  t.after(() => close(server));
  const body = { competition_stage: "preliminary" };
  const created = await request(origin, scores.BATCH_PATH, {
    method: "POST",
    headers: { ...signedHeaders(body), "X-Forwarded-For": "203.0.113.14" },
    body: Buffer.from(JSON.stringify(body))
  });
  assert.equal(created.status, 200);
  const pathname = new URL(json(created).data.download_url).pathname;
  const allowedIpv6 = await request(origin, pathname, {
    headers: { "X-Forwarded-For": "2001:db8:abcd:ffff::42" }
  });
  assert.equal(allowedIpv6.status, 200);
  for (const address of ["203.0.113.16", "2001:db8:abce::1"]) {
    const denied = await request(origin, pathname, { headers: { "X-Forwarded-For": address } });
    assert.equal(denied.status, 403);
    assert.equal(json(denied).code, 4005);
  }
});

test("invalid CIDR allowlist rules fail closed during startup", () => {
  const keys = rsaKeys();
  for (const invalidRule of ["203.0.113.10/33", "2001:db8::/129", "203.0.113.10/not-a-prefix", "203.0.113.10/24/1"]) {
    assert.throws(() => scores.createScoreDownloadService({
      apps: {
        [APP_KEY]: {
          appSecret: APP_SECRET,
          ipAllowlist: [invalidRule],
          rsaPublicKey: keys.publicKey
        }
      }
    }), /invalid IP address or CIDR range/);
  }
});

test("an untrusted direct client cannot spoof an allowed score API source with X-Forwarded-For", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "official-score-proxy-spoof-test-"));
  const keys = rsaKeys();
  let origin;
  const service = scores.createScoreDownloadService({
    apps: {
      [APP_KEY]: {
        appSecret: APP_SECRET,
        ipAllowlist: ["203.0.113.10"],
        rsaPublicKey: keys.publicKey
      }
    },
    scoreDataSource: { async listScoreRows() { return { rows: [scoreRow()], snapshotTime: NOW }; } },
    runtimeDir: temporary,
    nowSeconds: () => NOW
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    await service.handle(req, res, { pathname: url.pathname, externalOrigin: origin });
  });
  origin = await listen(server);
  t.after(() => close(server));

  const body = { competition_stage: "preliminary" };
  const response = await request(origin, scores.BATCH_PATH, {
    method: "POST",
    headers: { ...signedHeaders(body), "X-Forwarded-For": "203.0.113.10" },
    body: Buffer.from(JSON.stringify(body))
  });
  assert.equal(response.status, 403);
  assert.equal(json(response).code, 4005);
});

test("incremental frozen snapshots must explicitly cover identity and promotion changes", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "official-score-increment-snapshot-test-"));
  const snapshotPath = path.join(temporary, "snapshot.json");
  const writeSnapshot = incrementalComplete => fs.writeFileSync(snapshotPath, JSON.stringify({
    schemaVersion: scores.SNAPSHOT_SCHEMA_VERSION,
    snapshot_time: NOW,
    incremental_complete: incrementalComplete,
    rows: [{
      ...scoreRow({
        team_name: "更新后的队名",
        promote_status: 1,
        evaluate_finish_time: NOW - 1
      }),
      competition_stage: "preliminary"
    }]
  }));
  writeSnapshot(false);
  const keys = rsaKeys();
  let origin;
  const service = scores.createScoreDownloadService({
    apps: {
      [APP_KEY]: {
        appSecret: APP_SECRET,
        ipAllowlist: ["127.0.0.1"],
        rsaPublicKey: keys.publicKey
      }
    },
    snapshotPath,
    runtimeDir: path.join(temporary, "runtime"),
    nowSeconds: () => NOW
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    await service.handle(req, res, { pathname: url.pathname, externalOrigin: origin });
  });
  origin = await listen(server);
  t.after(() => close(server));
  const firstBody = {
    competition_stage: "preliminary",
    pull_type: "increment",
    last_update_time: NOW - 2
  };
  const rejected = await request(origin, scores.BATCH_PATH, {
    method: "POST", headers: signedHeaders(firstBody), body: Buffer.from(JSON.stringify(firstBody))
  });
  assert.equal(rejected.status, 503);
  assert.match(json(rejected).message, /权威增量/);

  writeSnapshot(true);
  const acceptedBody = { ...firstBody, last_update_time: NOW - 3 };
  const accepted = await request(origin, scores.BATCH_PATH, {
    method: "POST",
    headers: signedHeaders(acceptedBody, NOW - 1),
    body: Buffer.from(JSON.stringify(acceptedBody))
  });
  assert.equal(accepted.status, 200);
  assert.equal(json(accepted).data.total, 1,
    "a recent identity/promotion-only snapshot revision is included by evaluate_finish_time");
});

test("failed score generation releases the daily package slot but keeps replay protection", async t => {
  const setup = await fixture({
    source: { async listScoreRows() { throw new Error("snapshot unavailable"); } }
  });
  t.after(() => close(setup.server));
  const body = { competition_stage: "preliminary" };
  for (let offset = 0; offset < 7; offset += 1) {
    const failed = await request(setup.origin, scores.BATCH_PATH, {
      method: "POST",
      headers: signedHeaders(body, NOW - offset),
      body: Buffer.from(JSON.stringify(body))
    });
    assert.equal(failed.status, 503);
    assert.equal(json(failed).code, 5002);
  }
  const replay = await request(setup.origin, scores.BATCH_PATH, {
    method: "POST",
    headers: signedHeaders(body),
    body: Buffer.from(JSON.stringify(body))
  });
  assert.equal(replay.status, 401);
  assert.equal(json(replay).code, 4003);
});
