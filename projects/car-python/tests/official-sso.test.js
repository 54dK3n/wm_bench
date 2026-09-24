"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  OfficialSsoReplayStore,
  calculateSsoSignature,
  canonicalSsoPayload,
  verifySsoRequest
} = require("../backend/official-sso.js");

const SECRET = "official-sso-test-secret-32-bytes-long";
const NOW = 1_800_000_000_000;

async function temporaryRoot(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chenlong-official-sso-"));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.match(path.basename(resolved), /^chenlong-official-sso-/);
    await fs.promises.rm(resolved, { recursive: true, force: true });
  });
  return root;
}

function signedParameters(overrides = {}) {
  const parameters = {
    user_id: "U10086",
    team_id: "T20260100",
    group_type: "primary_high",
    team_name: "实验二小一队",
    timestamp: String(Math.floor(NOW / 1000)),
    ...overrides
  };
  return { ...parameters, sign: calculateSsoSignature(parameters, SECRET) };
}

function jumpUrl(parameters, entries = Object.entries(parameters)) {
  return `/api/v1/auth/sso/jump?${entries.map(([key, value]) => (
    `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
  )).join("&")}`;
}

function assertSsoCode(operation, code) {
  assert.throws(operation, error => error?.code === String(code));
}

test("official SSO signs decoded Unicode values in ASCII key order", () => {
  const parameters = signedParameters();
  assert.equal(
    canonicalSsoPayload(parameters),
    "group_type=primary_high&team_id=T20260100&team_name=实验二小一队&timestamp=1800000000&user_id=U10086"
  );
  const shuffled = [
    ["sign", parameters.sign],
    ["team_name", parameters.team_name],
    ["timestamp", parameters.timestamp],
    ["user_id", parameters.user_id],
    ["group_type", parameters.group_type],
    ["team_id", parameters.team_id]
  ];
  assert.deepEqual(verifySsoRequest(jumpUrl(parameters, shuffled), SECRET, NOW), {
    ...parameters,
    group_type: "primary"
  });
});

test("official SSO accepts the canonical elementary group and both legacy elementary values", () => {
  for (const group_type of ["primary", "primary_low", "primary_high"]) {
    const parameters = signedParameters({ group_type });
    const verified = verifySsoRequest(jumpUrl(parameters), SECRET, NOW);
    assert.equal(verified.group_type, "primary");
    assert.equal(calculateSsoSignature(parameters, SECRET), parameters.sign,
      "normalization must happen only after the original signed value is verified");
  }
});

test("official SSO has a fixed interoperability vector for the supplied contract example", () => {
  const business = {
    user_id: "U10086",
    team_id: "T20260100",
    group_type: "primary_high",
    team_name: "实验二小一队",
    timestamp: "1726590000",
  };
  assert.equal(
    calculateSsoSignature(business, "RaceJump@2026#Secret"),
    "e4c9060a5bb1a25e11d3cc70b7aeac1917fda4a83e9036c3923ae032c05ba2f3",
  );
});

test("official SSO rejects missing, duplicate, extra, empty, and malformed query parameters", () => {
  const parameters = signedParameters();
  assertSsoCode(() => verifySsoRequest(jumpUrl(parameters, Object.entries(parameters).slice(1)), SECRET, NOW), 1001);
  assertSsoCode(() => verifySsoRequest(`${jumpUrl(parameters)}&user_id=duplicate`, SECRET, NOW), 1001);
  assertSsoCode(() => verifySsoRequest(`${jumpUrl(parameters)}&extra=value`, SECRET, NOW), 1001);
  assertSsoCode(() => verifySsoRequest(jumpUrl({ ...parameters, team_id: "" }), SECRET, NOW), 1001);
  assertSsoCode(() => verifySsoRequest("/api/v1/auth/sso/jump?user_id=%ZZ", SECRET, NOW), 1001);
});

test("official SSO enforces a ten-digit five-minute timestamp and timing-safe SHA256 value", () => {
  const expired = signedParameters({ timestamp: String(Math.floor(NOW / 1000) - 301) });
  assertSsoCode(() => verifySsoRequest(jumpUrl(expired), SECRET, NOW), 1002);
  const future = signedParameters({ timestamp: String(Math.floor(NOW / 1000) + 301) });
  assertSsoCode(() => verifySsoRequest(jumpUrl(future), SECRET, NOW), 1002);
  const malformedTime = signedParameters({ timestamp: "123" });
  assertSsoCode(() => verifySsoRequest(jumpUrl(malformedTime), SECRET, NOW), 1002);
  const wrong = { ...signedParameters(), sign: "0".repeat(64) };
  assertSsoCode(() => verifySsoRequest(jumpUrl(wrong), SECRET, NOW), 1003);
  const uppercase = { ...signedParameters() };
  uppercase.sign = uppercase.sign.toUpperCase();
  assertSsoCode(() => verifySsoRequest(jumpUrl(uppercase), SECRET, NOW), 1003);
  const unauthorized = signedParameters({ group_type: "teacher" });
  assertSsoCode(() => verifySsoRequest(jumpUrl(unauthorized), SECRET, NOW), 1004);
});

test("official SSO replay protection is persistent and audit records omit sign and secret", async t => {
  const rootDir = await temporaryRoot(t);
  const parameters = signedParameters();
  const first = new OfficialSsoReplayStore({ rootDir, now: () => NOW });
  assert.equal(await first.consume(parameters, async () => "accepted"), "accepted");
  await assert.rejects(first.consume(parameters, async () => "replayed"), error => error?.code === "1005");

  const reloaded = new OfficialSsoReplayStore({ rootDir, now: () => NOW });
  await assert.rejects(reloaded.consume(parameters, async () => "replayed"), error => error?.code === "1005");
  await reloaded.audit({
    userId: parameters.user_id,
    sourceTimestamp: parameters.timestamp,
    ip: "203.0.113.8",
    result: "failure",
    code: "1005"
  });
  const audit = await fs.promises.readFile(path.join(rootDir, "official-sso-audit.jsonl"), "utf8");
  assert.match(audit, /U10086/);
  assert.match(audit, /203\.0\.113\.8/);
  assert.doesNotMatch(audit, new RegExp(parameters.sign, "i"));
  assert.doesNotMatch(audit, new RegExp(SECRET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("official SSO audit logs rotate within a bounded file budget", async t => {
  const rootDir = await temporaryRoot(t);
  const maxAuditBytes = 420;
  const store = new OfficialSsoReplayStore({
    rootDir,
    now: () => NOW,
    maxAuditBytes,
    maxAuditFiles: 2
  });
  for (let index = 0; index < 12; index += 1) {
    await store.audit({
      userId: `rotation-user-${index}`,
      sourceTimestamp: String(Math.floor(NOW / 1000)),
      ip: "203.0.113.8",
      result: index % 2 ? "success" : "failure",
      code: index % 2 ? null : "1003"
    });
  }
  const auditFiles = (await fs.promises.readdir(rootDir))
    .filter(name => /^official-sso-audit(?:\.1)?\.jsonl$/.test(name))
    .sort();
  assert.deepEqual(auditFiles, ["official-sso-audit.1.jsonl", "official-sso-audit.jsonl"]);
  for (const name of auditFiles) {
    assert.ok((await fs.promises.stat(path.join(rootDir, name))).size <= maxAuditBytes);
  }
  assert.equal(fs.existsSync(path.join(rootDir, "official-sso-audit.2.jsonl")), false);
});

test("future-dated SSO URLs stay consumed for their entire validity window", async t => {
  const directory = await temporaryRoot(t);
  let clock = NOW;
  const store = new OfficialSsoReplayStore({ rootDir: directory, now: () => clock });
  const parameters = signedParameters({
    timestamp: String(Math.floor(NOW / 1000) + 300),
  });

  verifySsoRequest(jumpUrl(parameters), SECRET, clock);
  await store.consume(parameters, async () => "first");
  clock += 301_000;
  verifySsoRequest(jumpUrl(parameters), SECRET, clock);
  await assert.rejects(
    store.consume(parameters, async () => "replayed"),
    error => error?.code === "1005",
  );
});

test("a verified SSO link stays consumed when downstream account mapping fails", async t => {
  const rootDir = await temporaryRoot(t);
  const parameters = signedParameters({ user_id: "U-FAILED-ONCE" });
  const store = new OfficialSsoReplayStore({ rootDir, now: () => NOW });
  await assert.rejects(
    store.consume(parameters, async () => { throw new Error("mapping failed"); }),
    /mapping failed/
  );
  await assert.rejects(
    store.consume(parameters, async () => "must not run"),
    error => error?.code === "1005"
  );
});
