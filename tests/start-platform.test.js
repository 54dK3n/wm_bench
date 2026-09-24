"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const starter = require("../tools/start-platform.js");

test("one-click launcher resolves every child application inside the platform projects directory", () => {
  assert.equal(starter.PROJECTS_ROOT, path.join(starter.PLATFORM_ROOT, "projects"));
  assert.equal(starter.PROJECTS.find(project => project.name === "Python").cwd,
    path.join(starter.PROJECTS_ROOT, "car-python"));
  assert.equal(starter.PROJECTS.find(project => project.name === "Blockly").cwd,
    path.join(starter.PROJECTS_ROOT, "blockly-page3"));
  assert.equal(starter.PROJECTS.find(project => project.name === "识物工坊").cwd,
    path.join(starter.PROJECTS_ROOT, "tmm"));
});

test("one-click launcher persists and reuses one sufficiently strong platform secret", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "competition-platform-secret-"));
  const secretPath = path.join(temporary, "data", "secret.txt");
  try {
    const first = starter.persistentSecret(secretPath);
    const second = starter.persistentSecret(secretPath);
    assert.equal(second, first);
    assert.ok(Buffer.byteLength(first, "utf8") >= 32);
    assert.equal(fs.readdirSync(path.dirname(secretPath)).length, 1);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("one-click launcher gives both federated services and gateway the same secret", () => {
  const secret = "launcher-test-secret-12345678901234567890";
  const blockly = starter.PROJECTS.find(project => project.name === "Blockly");
  const workshop = starter.PROJECTS.find(project => project.name === "识物工坊");
  const gateway = starter.PROJECTS.find(project => project.gateway);
  assert.equal(starter.environmentFor(blockly, secret).PLATFORM_SSO_SECRET, secret);
  assert.equal(starter.environmentFor(workshop, secret).PLATFORM_SSO_SECRET, secret);
  assert.equal(starter.environmentFor(gateway, secret).CHENLONG_PLATFORM_SSO_SECRET, secret);
  assert.match(starter.federationKeyId(secret), /^[a-f0-9]{16}$/);
});

test("one-click launcher exposes only the gateway when a container bind host is configured", () => {
  const secret = "launcher-test-secret-12345678901234567890";
  const python = starter.PROJECTS.find(project => project.name === "Python");
  const blockly = starter.PROJECTS.find(project => project.name === "Blockly");
  const workshop = starter.PROJECTS.find(project => project.name === "识物工坊");
  const gateway = starter.PROJECTS.find(project => project.gateway);
  const sourceEnvironment = { CHENLONG_PLATFORM_BIND_HOST: "0.0.0.0" };
  assert.equal(starter.environmentFor(gateway, secret, sourceEnvironment).HOST, "0.0.0.0");
  assert.equal(starter.environmentFor(python, secret, sourceEnvironment).HOST, "127.0.0.1");
  assert.equal(starter.environmentFor(blockly, secret, sourceEnvironment).HOST, "127.0.0.1");
  assert.equal(starter.environmentFor(workshop, secret, sourceEnvironment).HOST, "127.0.0.1");
  assert.throws(() => starter.normalizedGatewayBindHost("example.com"), /只允许/);
});

test("one-click launcher maps the unified HTTPS origin into Python and forces Secure cookies", () => {
  const python = starter.PROJECTS.find(project => project.name === "Python");
  const blockly = starter.PROJECTS.find(project => project.name === "Blockly");
  const sourceEnvironment = {
    CHENLONG_PLATFORM_PUBLIC_ORIGIN: "https://contest.example.test",
    CHENLONG_OFFICIAL_SSO_SECRET: "official-launcher-secret-32-bytes"
  };
  const env = starter.environmentFor(python, "launcher-test-secret-12345678901234567890", {
    ...sourceEnvironment
  });
  assert.equal(env.CHENLONG_PUBLIC_ORIGIN, "https://contest.example.test");
  assert.equal(env.CHENLONG_SECURE_COOKIES, "true");
  assert.equal(
    starter.environmentFor(blockly, "launcher-test-secret-12345678901234567890", sourceEnvironment)
      .BLOCKLY_PUBLIC_ORIGIN,
    "https://contest.example.test"
  );
});

test("one-click launcher refuses insecure official SSO unless isolated test mode is explicit", () => {
  const python = starter.PROJECTS.find(project => project.name === "Python");
  assert.throws(() => starter.environmentFor(
    python,
    "launcher-test-secret-12345678901234567890",
    { CHENLONG_OFFICIAL_SSO_SECRET: "official-launcher-secret-32-bytes" }
  ), /必须配置 HTTPS/);
  const testEnv = starter.environmentFor(
    python,
    "launcher-test-secret-12345678901234567890",
    {
      CHENLONG_OFFICIAL_SSO_SECRET: "official-launcher-secret-32-bytes",
      CHENLONG_OFFICIAL_SSO_ALLOW_INSECURE_TEST_MODE: "true"
    }
  );
  assert.equal(testEnv.CHENLONG_SECURE_COOKIES, undefined);
});

test("one-click launcher builds the workshop then runs its Cloudflare production preview", () => {
  const workshop = starter.PROJECTS.find(project => project.name === "识物工坊");
  assert.equal(workshop.health, "/api/competition/health");
  assert.equal(workshop.marker, "workshop-competition");
  assert.equal(workshop.command, process.execPath);
  assert.match(workshop.args[0].replace(/\\/g, "/"), /node_modules\/vite\/bin\/vite\.js$/);
  assert.deepEqual(workshop.args.slice(1), ["preview", "--host", "127.0.0.1", "--port", "3000", "--strictPort"]);
  assert.equal(workshop.prepare.command, process.execPath);
  assert.match(workshop.prepare.args[0].replace(/\\/g, "/"), /node_modules\/vinext\/dist\/cli\.js$/);
  assert.equal(workshop.prepare.args[1], "build");
});

test("prebuilt workshop runtime receives the generated secret without putting it in the image", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "competition-platform-workshop-config-"));
  const configPath = path.join(temporary, "wrangler.json");
  const secret = "runtime-only-workshop-secret-12345678901234567890";
  fs.writeFileSync(configPath, JSON.stringify({
    vars: {},
    d1_databases: [{ binding: "DB" }],
    r2_buckets: [{ binding: "COMPETITION_STORAGE" }]
  }));
  try {
    starter.injectWorkshopRuntimeSecret(secret, configPath);
    const configured = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(configured.vars.PLATFORM_SSO_SECRET, secret);
    assert.deepEqual(configured.d1_databases, [{ binding: "DB" }]);
    assert.deepEqual(configured.r2_buckets, [{ binding: "COMPETITION_STORAGE" }]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("one-click launcher archives only a verified stale Python writer lock", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "competition-platform-lock-"));
  const lockPath = path.join(temporary, ".chenlong-writer.lock");
  fs.writeFileSync(lockPath, JSON.stringify({
    schemaVersion: "chenlong.data-directory-writer-lock/v1",
    pid: 2_000_000_000,
    token: "test",
    createdAt: new Date().toISOString()
  }));
  try {
    const archived = starter.archiveStalePythonLock(lockPath);
    assert.ok(archived);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(archived), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
