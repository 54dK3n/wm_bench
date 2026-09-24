"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const {
  clearJsonSessions,
  createArchive,
  createDeliveryManifest,
  excluded,
  installDependencies,
  parseArguments,
  sanitizeSqlite,
  sanitizeWorkshopHostingConfig,
  verifySanitizedState
} = require("../tools/build-delivery.js");
const { validatedRelativePath, verifyExtractedDelivery } = require("../tools/verify-delivery.js");

const root = path.resolve(__dirname, "..");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chenlong-delivery-test-"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("delivery builder omits secrets, historical archives, caches and live write sidecars", () => {
  for (const relativePath of [
    "record-backups",
    "record-backups/old/auth-store.json",
    ".runtime/score-download/replay-state.json",
    "data/legacy-id-map.json",
    "data/platform-sso-secret.txt",
    "projects/tmm/.openai/private-deployment.json",
    "projects/tmm/.dev.vars",
    "projects/tmm/.env.production",
    "projects/tmm/.npmrc",
    "projects/tmm/private.pem",
    "projects/tmm/.git/config",
    "projects/tmm/dist/index.js",
    "projects/tmm/outputs/old.zip",
    "projects/tmm/.wrangler/state/v3/cache/metadata.sqlite",
    "projects/tmm/node_modules/example/.rollup.cache/index.js",
    "projects/tmm/.wrangler/state/v3/v3/d1/empty.sqlite",
    "projects/car-python/.runtime/.chenlong-writer.lock",
    "projects/blockly-page3/.blockly-data/backups/old.json",
    "projects/blockly-page3/.blockly-data/primary-blockly-records.sqlite-wal"
  ]) {
    assert.equal(excluded(relativePath, true), true, `${relativePath} must be excluded`);
  }
  for (const relativePath of [
    "projects/car-python/.runtime/auth/auth-store.json",
    "projects/car-python/.runtime/records/run-records.json",
    "projects/blockly-page3/.blockly-data/primary-blockly-records.sqlite",
    "projects/tmm/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/database.sqlite",
    "projects/tmm/.wrangler/state/v3/r2/miniflare-R2BucketObject/metadata.sqlite",
    "projects/tmm/.openai/hosting.json",
    "projects/tmm/.dev.vars.example",
    "projects/tmm/.env.example",
    "projects/tmm/node_modules/combined-stream/yarn.lock",
    "projects/tmm/node_modules/@tensorflow/tfjs/dist/tsconfig.tsbuildinfo",
    "projects/car-python/vendor/pyodide/pyodide.asm.wasm",
    "projects/tmm/public/models/mobilenet/model.json"
  ]) {
    assert.equal(excluded(relativePath, true), false, `${relativePath} must be retained`);
  }
  assert.equal(excluded("projects/tmm/node_modules/vinext/dist/cli.js", false), true);
  assert.equal(excluded("projects/tmm/node_modules/vinext/dist/cli.js", true), false);
});

test("Windows delivery archive preserves Unicode file names for standard extraction", {
  skip: process.platform !== "win32"
}, () => {
  const stageContainer = temporaryDirectory();
  const outputRoot = temporaryDirectory();
  const extractionRoot = temporaryDirectory();
  try {
    const relativePath = path.join("competition-platform", "projects", "blockly-page3", "指导书.md");
    const sourcePath = path.join(stageContainer, relativePath);
    const zipPath = path.join(outputRoot, "unicode-delivery.zip");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "交付文档\n", "utf8");

    createArchive(stageContainer, zipPath);
    const powershell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
    );
    const result = childProcess.spawnSync(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "Expand-Archive -LiteralPath $env:CHENLONG_TEST_ZIP -DestinationPath $env:CHENLONG_TEST_DEST"
    ], {
      env: {
        ...process.env,
        CHENLONG_TEST_ZIP: zipPath,
        CHENLONG_TEST_DEST: extractionRoot
      },
      encoding: "utf8",
      shell: false
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(path.join(extractionRoot, relativePath), "utf8"), "交付文档\n");
  } finally {
    fs.rmSync(stageContainer, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
});

test("delivery hosting settings retain only public bindings required by the local build", () => {
  const sourceRoot = temporaryDirectory();
  const stageRoot = temporaryDirectory();
  try {
    writeJson(path.join(sourceRoot, "projects", "tmm", ".openai", "hosting.json"), {
      project_id: "must-not-leak",
      d1: "DB",
      r2: "COMPETITION_STORAGE"
    });
    const configPath = path.join(stageRoot, "projects", "tmm", "vite.config.ts");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, [
      "import { defineConfig } from \"vite\";",
      "import hostingConfig from \"./.openai/hosting.json\";",
      "const { d1, r2 } = hostingConfig;",
      "export default defineConfig({});",
      ""
    ].join("\n"), "utf8");

    assert.deepEqual(sanitizeWorkshopHostingConfig(stageRoot, sourceRoot), {
      d1: "DB",
      r2: "COMPETITION_STORAGE"
    });
    const stagedConfig = fs.readFileSync(configPath, "utf8");
    assert.match(stagedConfig, /\.\/\.openai\/hosting\.json/u);
    const stagedHosting = JSON.parse(fs.readFileSync(
      path.join(stageRoot, "projects", "tmm", ".openai", "hosting.json"),
      "utf8"
    ));
    assert.deepEqual(stagedHosting, { d1: "DB", r2: "COMPETITION_STORAGE" });
    assert.doesNotMatch(JSON.stringify(stagedHosting), /project_id|must-not-leak/u);
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
});

test("delivery clears sessions while retaining identities and durable SQLite rows", () => {
  const stageRoot = temporaryDirectory();
  try {
    const pythonPath = path.join(stageRoot, "projects", "car-python", ".runtime", "auth", "auth-store.json");
    const blocklyPath = path.join(stageRoot, "projects", "blockly-page3", ".blockly-data", "primary-blockly-store.json");
    writeJson(pythonPath, {
      revision: 7,
      users: [{ id: "user-1" }],
      teams: [{ id: "team-1" }],
      sessions: [{ id: "python-session" }]
    });
    writeJson(blocklyPath, {
      users: [{ id: "user-1" }],
      teams: [{ id: "team-1" }],
      sessions: [{ id: "blockly-session" }]
    });
    writeJson(path.join(stageRoot, "projects", "tmm", ".openai", "hosting.json"), {
      d1: "DB",
      r2: "COMPETITION_STORAGE"
    });
    const databasePath = path.join(
      stageRoot,
      "projects", "tmm", ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject", "database.sqlite"
    );
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec(`
      CREATE TABLE competition_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE competition_admin_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE competition_teams (id TEXT PRIMARY KEY);
      INSERT INTO competition_sessions VALUES ('participant-session');
      INSERT INTO competition_admin_sessions VALUES ('admin-session');
      INSERT INTO competition_teams VALUES ('team-1');
    `);
    database.close();

    assert.deepEqual(clearJsonSessions(stageRoot), {
      pythonSessionCount: 1,
      blocklySessionCount: 1,
      pythonUserCount: 1,
      pythonTeamCount: 1,
      blocklyUserCount: 1,
      blocklyTeamCount: 1
    });
    assert.deepEqual(sanitizeSqlite(stageRoot), {
      workshopParticipantSessions: 1,
      workshopAdminSessions: 1
    });
    verifySanitizedState(stageRoot);

    assert.equal(JSON.parse(fs.readFileSync(pythonPath, "utf8")).sessions.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(pythonPath, "utf8")).revision, 8);
    assert.equal(JSON.parse(fs.readFileSync(blocklyPath, "utf8")).sessions.length, 0);
    const retainedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(retainedDatabase.prepare("SELECT COUNT(*) AS total FROM competition_sessions").get().total, 0);
    assert.equal(retainedDatabase.prepare("SELECT COUNT(*) AS total FROM competition_admin_sessions").get().total, 0);
    assert.equal(retainedDatabase.prepare("SELECT COUNT(*) AS total FROM competition_teams").get().total, 1);
    retainedDatabase.close();
    verifySanitizedState(stageRoot);
    assert.equal(fs.existsSync(`${databasePath}-wal`), false);
    assert.equal(fs.existsSync(`${databasePath}-shm`), false);
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
});

test("dependency-complete delivery uses clean npm ci and rejects inherited node_modules", () => {
  const stageRoot = temporaryDirectory();
  try {
    const projectRoot = path.join(stageRoot, "projects", "tmm");
    writeJson(path.join(projectRoot, "package.json"), { private: true });
    writeJson(path.join(projectRoot, "package-lock.json"), { lockfileVersion: 3 });
    fs.mkdirSync(path.join(projectRoot, "node_modules"), { recursive: true });
    assert.throws(() => installDependencies(stageRoot, () => ({ status: 0 })), /must be absent/u);
    fs.rmSync(path.join(projectRoot, "node_modules"), { recursive: true, force: true });

    let invocation;
    installDependencies(stageRoot, (command, argumentsList, options) => {
      invocation = { command, argumentsList, options };
      for (const packageName of ["vinext", "vite", "wrangler"]) {
        writeJson(path.join(projectRoot, "node_modules", packageName, "package.json"), { name: packageName });
      }
      fs.mkdirSync(path.join(projectRoot, "node_modules", ".cache"), { recursive: true });
      return { status: 0 };
    });
    if (process.platform === "win32") {
      assert.equal(invocation.command.toLowerCase(), (process.env.ComSpec || "cmd.exe").toLowerCase());
      assert.deepEqual(invocation.argumentsList, [
        "/d", "/s", "/c", "npm.cmd", "ci", "--include=dev", "--no-audit", "--no-fund"
      ]);
    } else {
      assert.equal(invocation.command, "npm");
      assert.deepEqual(invocation.argumentsList, ["ci", "--include=dev", "--no-audit", "--no-fund"]);
    }
    assert.equal(invocation.options.cwd, projectRoot);
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.env.NODE_ENV, "development");
    assert.equal(fs.existsSync(path.join(projectRoot, "node_modules", ".cache")), false);
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
});

test("delivery manifest verifies every file and rejects tampering and traversal", () => {
  const stageRoot = temporaryDirectory();
  try {
    writeJson(path.join(stageRoot, "projects", "car-python", ".runtime", "auth", "auth-store.json"), {
      revision: 1,
      users: [{ id: "user-1" }],
      teams: [{ id: "team-1" }],
      sessions: []
    });
    writeJson(path.join(stageRoot, "projects", "blockly-page3", ".blockly-data", "primary-blockly-store.json"), {
      users: [{ id: "user-1" }],
      teams: [{ id: "team-1" }],
      sessions: []
    });
    writeJson(path.join(stageRoot, "DELIVERY-SNAPSHOT.json"), {
      schemaVersion: "chenlong.delivery-snapshot/v1",
      createdAt: "2026-08-28T00:00:00.000Z",
      sourceRoot: "redacted",
      includesDependencies: false
    });
    writeJson(path.join(stageRoot, "projects", "tmm", ".openai", "hosting.json"), {
      d1: "DB",
      r2: "COMPETITION_STORAGE"
    });
    const payloadPath = path.join(stageRoot, "README.txt");
    fs.writeFileSync(payloadPath, "verified payload\n", "utf8");
    createDeliveryManifest(stageRoot, "2026-08-28T00:00:00.000Z");

    const result = verifyExtractedDelivery(stageRoot);
    assert.ok(result.fileCount >= 4);
    assert.equal(result.includesDependencies, false);

    fs.writeFileSync(payloadPath, "tampered payload\n", "utf8");
    assert.throws(() => verifyExtractedDelivery(stageRoot), /size mismatch|SHA256 mismatch/u);

    const manifestPath = path.join(stageRoot, "DELIVERY-MANIFEST.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.files[0].path = "../escape.txt";
    writeJson(manifestPath, manifest);
    assert.throws(() => verifyExtractedDelivery(stageRoot), /non-canonical manifest path/u);
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
});

test("manifest paths reject absolute, Windows and control-character forms", () => {
  for (const value of ["../file", "folder/../file", "/absolute", "C:/absolute", "folder\\file", "folder//file", "line\nfile"]) {
    assert.throws(() => validatedRelativePath(value), /path/u);
  }
  assert.equal(validatedRelativePath("projects/tmm/package.json"), "projects/tmm/package.json");
});

test("delivery entry points and official interface references are present", () => {
  for (const relativePath of [
    "DELIVERY.md",
    "START-WINDOWS.cmd",
    "INSTALL-DEPENDENCIES.cmd",
    "VERIFY-WINDOWS.cmd",
    "deploy/nginx/competition-platform.conf",
    "tools/verify-delivery.js",
    "docs/official-api-specs/sso_jump_api.md",
    "docs/official-api-specs/get_all_scores_api.md",
    "docs/official-api-specs/scores.md"
  ]) {
    assert.ok(fs.statSync(path.join(root, relativePath)).size > 0, `${relativePath} must exist`);
  }
  assert.deepEqual(parseArguments(["--with-dependencies", "--output", "./out"]), {
    output: path.resolve("./out"),
    withDependencies: true,
    keepStage: false
  });
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.engines.node, ">=22.13");
  assert.equal(packageJson.scripts["delivery:verify"], "node tools/verify-delivery.js");
  assert.match(packageJson.scripts.check, /tools\/verify-delivery\.js/u);
});
