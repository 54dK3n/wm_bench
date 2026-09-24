#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.resolve(ROOT, "..", "deliverables");
const PORTS = Object.freeze([3000, 6178, 6180, 6190]);

function parseArguments(argv) {
  let output = DEFAULT_OUTPUT;
  let withDependencies = false;
  let keepStage = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--with-dependencies") withDependencies = true;
    else if (argument === "--keep-stage") keepStage = true;
    else if (argument === "--output") {
      output = path.resolve(argv[index + 1] || "");
      index += 1;
    } else {
      throw new TypeError(`unknown argument: ${argument}`);
    }
  }
  return { output, withDependencies, keepStage };
}

function relativePosix(sourcePath) {
  return path.relative(ROOT, sourcePath).split(path.sep).join("/");
}

function excluded(relativePath, withDependencies) {
  if (!relativePath) return false;
  const parts = relativePath.split("/");
  const base = parts.at(-1);
  const insideDependencies = parts.includes("node_modules");
  if (parts.includes(".git")) return true;
  if (parts.includes(".cache") || parts.includes(".rollup.cache") || parts.includes(".vite")) return true;
  if (parts.includes("backups")) return true;
  if (relativePath === "record-backups" || relativePath.startsWith("record-backups/")) return true;
  if (relativePath === ".runtime" || relativePath.startsWith(".runtime/")) return true;
  if (relativePath === "data/legacy-id-map.json") return true;
  if (relativePath === "data/platform-sso-secret.txt") return true;
  if (relativePath === "projects/tmm/.openai") return false;
  if (relativePath.startsWith("projects/tmm/.openai/")
    && relativePath !== "projects/tmm/.openai/hosting.json") return true;
  if (relativePath === "projects/car-python/.runtime/official-sso"
    || relativePath.startsWith("projects/car-python/.runtime/official-sso/")) return true;
  if (relativePath === "projects/blockly-page3/.blockly-data/backups"
    || relativePath.startsWith("projects/blockly-page3/.blockly-data/backups/")) return true;
  for (const directory of ["dist", ".next", ".vinext", "outputs", "work"]) {
    const prefix = `projects/tmm/${directory}`;
    if (relativePath === prefix || relativePath.startsWith(`${prefix}/`)) return true;
  }
  for (const prefix of [
    "projects/tmm/.wrangler/deploy",
    "projects/tmm/.wrangler/registry",
    "projects/tmm/.wrangler/state/v3/cache",
    "projects/tmm/.wrangler/state/v3/do",
    "projects/tmm/.wrangler/state/v3/workflows",
    "projects/tmm/.wrangler/state/v3/v3"
  ]) {
    if (relativePath === prefix || relativePath.startsWith(`${prefix}/`)) return true;
  }
  if (!withDependencies) {
    const dependencyPrefix = "projects/tmm/node_modules";
    if (relativePath === dependencyPrefix || relativePath.startsWith(`${dependencyPrefix}/`)) return true;
  }
  if (!insideDependencies && (
    base === ".npmrc"
    || base === ".yarnrc"
    || base === ".dev.vars"
    || (base.startsWith(".dev.vars.") && base !== ".dev.vars.example")
    || base === ".env"
    || (base.startsWith(".env.") && base !== ".env.example")
    || /\.(?:jks|key|keystore|p12|pem|pfx)$/iu.test(base)
  )) return true;
  if ((!insideDependencies && base === "tsconfig.tsbuildinfo") || base === "Thumbs.db" || base === ".DS_Store") return true;
  if (!insideDependencies && (base.endsWith(".log") || base.endsWith(".tmp"))) return true;
  if (!insideDependencies && (base.endsWith(".lock") || base.includes(".lock.stale-"))) return true;
  if (base.endsWith(".sqlite-wal") || base.endsWith(".sqlite-shm")) return true;
  return false;
}

function sanitizeWorkshopHostingConfig(stageRoot, sourceRoot = ROOT) {
  const hostingPath = path.join(sourceRoot, "projects", "tmm", ".openai", "hosting.json");
  const stagedHostingPath = path.join(stageRoot, "projects", "tmm", ".openai", "hosting.json");
  const configPath = path.join(stageRoot, "projects", "tmm", "vite.config.ts");
  const hosting = JSON.parse(fs.readFileSync(hostingPath, "utf8"));
  for (const key of ["d1", "r2"]) {
    if (typeof hosting[key] !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(hosting[key])) {
      throw new Error(`invalid workshop ${key} binding in .openai/hosting.json`);
    }
  }
  let config = fs.readFileSync(configPath, "utf8");
  const importPattern = /^import hostingConfig from ["']\.\/\.openai\/hosting\.json["'];\r?\n/mu;
  const bindingPattern = /^const \{ d1, r2 \} = hostingConfig;$/mu;
  if ((config.match(importPattern) || []).length !== 1 || (config.match(bindingPattern) || []).length !== 1) {
    throw new Error("workshop vite.config.ts hosting integration changed; refusing to build an incomplete delivery");
  }
  const publicBindings = Object.freeze({ d1: hosting.d1, r2: hosting.r2 });
  // The Sites build plugin requires this file even for the local production
  // preview. Retain only the public binding names and remove the account-bound
  // project identifier before the delivery manifest is created.
  fs.mkdirSync(path.dirname(stagedHostingPath), { recursive: true });
  writeJson(stagedHostingPath, publicBindings);
  return publicBindings;
}

function portIsOpen(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = open => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function assertServicesStopped() {
  const checks = await Promise.all(PORTS.map(async port => ({ port, open: await portIsOpen(port) })));
  const openPorts = checks.filter(item => item.open).map(item => item.port);
  if (openPorts.length) {
    throw new Error(`stop the competition services before packaging; open ports: ${openPorts.join(", ")}`);
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function clearJsonSessions(stageRoot) {
  const pythonPath = path.join(stageRoot, "projects", "car-python", ".runtime", "auth", "auth-store.json");
  const python = JSON.parse(fs.readFileSync(pythonPath, "utf8"));
  const pythonSessionCount = Array.isArray(python.sessions) ? python.sessions.length : 0;
  python.sessions = [];
  if (Number.isSafeInteger(python.revision)) python.revision += 1;
  writeJson(pythonPath, python);

  const blocklyPath = path.join(stageRoot, "projects", "blockly-page3", ".blockly-data", "primary-blockly-store.json");
  const blockly = JSON.parse(fs.readFileSync(blocklyPath, "utf8"));
  const blocklySessionCount = Array.isArray(blockly.sessions) ? blockly.sessions.length : 0;
  blockly.sessions = [];
  writeJson(blocklyPath, blockly);
  return {
    pythonSessionCount,
    blocklySessionCount,
    pythonUserCount: Array.isArray(python.users) ? python.users.length : 0,
    pythonTeamCount: Array.isArray(python.teams) ? python.teams.length : 0,
    blocklyUserCount: Array.isArray(blockly.users) ? blockly.users.length : 0,
    blocklyTeamCount: Array.isArray(blockly.teams) ? blockly.teams.length : 0
  };
}

function sqliteFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".sqlite")) files.push(fullPath);
    }
  };
  walk(directory);
  return files;
}

function removeSqliteSidecars(filePaths) {
  for (const filePath of filePaths) {
    for (const suffix of ["-wal", "-shm"]) {
      const sidecarPath = `${filePath}${suffix}`;
      if (fs.existsSync(sidecarPath)) fs.rmSync(sidecarPath, { force: true });
    }
  }
}

function checkpointSourceDatabases() {
  const roots = [
    path.join(ROOT, "projects", "blockly-page3", ".blockly-data"),
    path.join(ROOT, "projects", "tmm", ".wrangler", "state", "v3", "d1"),
    path.join(ROOT, "projects", "tmm", ".wrangler", "state", "v3", "r2")
  ];
  for (const filePath of roots.flatMap(sqliteFiles)) {
    const database = new DatabaseSync(filePath);
    try {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      database.close();
    }
  }
}

function tableExists(database, tableName) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function sanitizeSqlite(stageRoot) {
  const roots = [
    path.join(stageRoot, "projects", "blockly-page3", ".blockly-data"),
    path.join(stageRoot, "projects", "tmm", ".wrangler", "state", "v3", "d1"),
    path.join(stageRoot, "projects", "tmm", ".wrangler", "state", "v3", "r2")
  ];
  let workshopParticipantSessions = 0;
  let workshopAdminSessions = 0;
  for (const filePath of roots.flatMap(sqliteFiles)) {
    const database = new DatabaseSync(filePath);
    try {
      if (tableExists(database, "competition_sessions")) {
        workshopParticipantSessions += Number(database.prepare("SELECT COUNT(*) AS total FROM competition_sessions").get().total);
        database.exec("DELETE FROM competition_sessions");
      }
      if (tableExists(database, "competition_admin_sessions")) {
        workshopAdminSessions += Number(database.prepare("SELECT COUNT(*) AS total FROM competition_admin_sessions").get().total);
        database.exec("DELETE FROM competition_admin_sessions");
      }
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      database.close();
    }
  }
  removeSqliteSidecars(roots.flatMap(sqliteFiles));
  return { workshopParticipantSessions, workshopAdminSessions };
}

function removeStageCaches(stageRoot) {
  const dependencyRoot = path.join(stageRoot, "projects", "tmm", "node_modules");
  if (!fs.existsSync(dependencyRoot)) return;
  const cacheNames = new Set([".cache", ".rollup.cache", ".vite"]);
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = path.join(directory, entry.name);
      if (cacheNames.has(entry.name)) fs.rmSync(target, { recursive: true, force: true });
      else walk(target);
    }
  };
  walk(dependencyRoot);
}

function installDependencies(stageRoot, spawnSync = childProcess.spawnSync) {
  const projectRoot = path.join(stageRoot, "projects", "tmm");
  const dependencyRoot = path.join(projectRoot, "node_modules");
  if (fs.existsSync(dependencyRoot)) {
    throw new Error("staged workshop node_modules must be absent before npm ci");
  }
  for (const fileName of ["package.json", "package-lock.json"]) {
    if (!fs.existsSync(path.join(projectRoot, fileName))) {
      throw new Error(`staged workshop is missing ${fileName}`);
    }
  }
  const npmArguments = ["ci", "--include=dev", "--no-audit", "--no-fund"];
  const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
  const argumentsList = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm.cmd", ...npmArguments]
    : npmArguments;
  const result = spawnSync(command, argumentsList, {
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: "development" },
    stdio: "inherit",
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ci failed with exit code ${result.status}`);
  for (const packageName of ["vinext", "vite", "wrangler"]) {
    if (!fs.existsSync(path.join(dependencyRoot, packageName, "package.json"))) {
      throw new Error(`npm ci completed without required delivery dependency: ${packageName}`);
    }
  }
  removeStageCaches(stageRoot);
}

function allFiles(directory) {
  const files = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`delivery cannot contain symbolic links: ${fullPath}`);
      if (stat.isDirectory()) walk(fullPath);
      else if (stat.isFile()) files.push(fullPath);
    }
  };
  walk(directory);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function createArchive(stageContainer, zipPath, spawn = childProcess.spawnSync) {
  if (process.platform === "win32") {
    // bsdtar on Windows writes non-ASCII entry names using the active console
    // code page. That makes files such as `指导书.md` extract under a corrupted
    // name in Explorer and Expand-Archive. The .NET ZIP implementation sets the
    // UTF-8 filename flag explicitly, so every standard Windows extractor sees
    // the exact manifest path.
    const powershell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
    );
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      "[System.IO.Compression.ZipFile]::CreateFromDirectory(",
      "  $env:CHENLONG_DELIVERY_ARCHIVE_SOURCE,",
      "  $env:CHENLONG_DELIVERY_ARCHIVE_TARGET,",
      "  [System.IO.Compression.CompressionLevel]::Optimal,",
      "  $false,",
      "  [System.Text.Encoding]::UTF8",
      ")"
    ].join("\n");
    const result = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      env: {
        ...process.env,
        CHENLONG_DELIVERY_ARCHIVE_SOURCE: stageContainer,
        CHENLONG_DELIVERY_ARCHIVE_TARGET: zipPath
      },
      stdio: "inherit",
      shell: false
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`archive creation failed with exit code ${result.status}`);
    return;
  }
  const result = spawn("tar", ["-a", "-c", "-f", zipPath, "competition-platform"], {
    cwd: stageContainer,
    stdio: "inherit",
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`archive creation failed with exit code ${result.status}`);
}

function verifySanitizedState(stageRoot) {
  const hostingPath = path.join(stageRoot, "projects", "tmm", ".openai", "hosting.json");
  const hosting = JSON.parse(fs.readFileSync(hostingPath, "utf8"));
  if (Object.keys(hosting).sort().join(",") !== "d1,r2"
    || typeof hosting.d1 !== "string" || typeof hosting.r2 !== "string") {
    throw new Error("delivery workshop hosting configuration contains deployment metadata");
  }
  const jsonStores = [
    path.join(stageRoot, "projects", "car-python", ".runtime", "auth", "auth-store.json"),
    path.join(stageRoot, "projects", "blockly-page3", ".blockly-data", "primary-blockly-store.json")
  ];
  for (const filePath of jsonStores) {
    const store = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(store.sessions) || store.sessions.length !== 0) {
      throw new Error(`delivery session sanitization failed: ${filePath}`);
    }
  }
  const sqliteRoots = [
    path.join(stageRoot, "projects", "blockly-page3", ".blockly-data"),
    path.join(stageRoot, "projects", "tmm", ".wrangler", "state", "v3", "d1"),
    path.join(stageRoot, "projects", "tmm", ".wrangler", "state", "v3", "r2")
  ];
  const databases = sqliteRoots.flatMap(sqliteFiles);
  for (const filePath of databases) {
    const database = new DatabaseSync(filePath, { readOnly: true });
    try {
      for (const tableName of ["competition_sessions", "competition_admin_sessions"]) {
        if (tableExists(database, tableName)) {
          const total = Number(database.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total);
          if (total !== 0) throw new Error(`delivery still contains ${total} rows in ${tableName}: ${filePath}`);
        }
      }
    } finally {
      database.close();
    }
  }
  // Opening a WAL-mode database read-only can still recreate an empty -shm
  // sidecar. All databases are closed and were checkpointed before this check,
  // so remove those transient files before enforcing the delivery policy.
  removeSqliteSidecars(databases);
  for (const filePath of allFiles(stageRoot)) {
    const relativePath = path.relative(stageRoot, filePath).split(path.sep).join("/");
    if (excluded(relativePath, true)) {
      throw new Error(`delivery policy rejected staged file: ${relativePath}`);
    }
  }
}

function createDeliveryManifest(stageRoot, createdAt) {
  const manifestPath = path.join(stageRoot, "DELIVERY-MANIFEST.json");
  const entries = allFiles(stageRoot)
    .filter(filePath => filePath !== manifestPath)
    .map(filePath => ({
      path: path.relative(stageRoot, filePath).split(path.sep).join("/"),
      size: fs.statSync(filePath).size,
      sha256: sha256(filePath)
    }));
  const manifest = {
    schemaVersion: "chenlong.delivery-manifest/v1",
    createdAt,
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    files: entries
  };
  writeJson(manifestPath, manifest);
  return manifest;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.withDependencies && (os.platform() !== "win32" || os.arch() !== "x64")) {
    throw new Error("the dependency-complete Windows delivery must be built on Windows x64");
  }
  await assertServicesStopped();
  checkpointSourceDatabases();
  fs.mkdirSync(options.output, { recursive: true });
  const stamp = timestamp();
  const suffix = options.withDependencies ? "windows-x64" : "source";
  const baseName = `competition-platform-delivery-${suffix}-${stamp}`;
  const stageContainer = path.join(options.output, `.stage-${baseName}`);
  const stageRoot = path.join(stageContainer, "competition-platform");
  const zipPath = path.join(options.output, `${baseName}.zip`);
  const checksumPath = `${zipPath}.sha256`;
  if (fs.existsSync(stageContainer) || fs.existsSync(zipPath) || fs.existsSync(checksumPath)) {
    throw new Error(`delivery output already exists: ${baseName}`);
  }
  fs.mkdirSync(stageContainer, { recursive: false });
  try {
    fs.cpSync(ROOT, stageRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      filter: sourcePath => !excluded(relativePosix(sourcePath), false)
    });
    const workshopBindings = sanitizeWorkshopHostingConfig(stageRoot);
    const jsonSnapshot = clearJsonSessions(stageRoot);
    const sqliteSnapshot = sanitizeSqlite(stageRoot);
    if (options.withDependencies) installDependencies(stageRoot);
    const snapshot = {
      schemaVersion: "chenlong.delivery-snapshot/v1",
      createdAt: new Date().toISOString(),
      sourceRoot: "redacted",
      platform: `${os.platform()}-${os.arch()}`,
      nodeVersion: process.versions.node,
      includesDependencies: options.withDependencies,
      workshopBindings,
      activeSessionsRemoved: {
        python: jsonSnapshot.pythonSessionCount,
        blockly: jsonSnapshot.blocklySessionCount,
        workshopParticipants: sqliteSnapshot.workshopParticipantSessions,
        workshopAdministrators: sqliteSnapshot.workshopAdminSessions
      },
      retainedIdentityCounts: {
        pythonUsers: jsonSnapshot.pythonUserCount,
        pythonTeams: jsonSnapshot.pythonTeamCount,
        blocklyUsers: jsonSnapshot.blocklyUserCount,
        blocklyTeams: jsonSnapshot.blocklyTeamCount
      },
      omitted: [
        "record-backups",
        "legacy identity migration map",
        "deployment secrets",
        "Sites project metadata",
        "official SSO audit and replay state",
        "build caches and prior outputs",
        "writer locks and SQLite WAL/SHM"
      ]
    };
    writeJson(path.join(stageRoot, "DELIVERY-SNAPSHOT.json"), snapshot);
    verifySanitizedState(stageRoot);
    const manifest = createDeliveryManifest(stageRoot, snapshot.createdAt);
    createArchive(stageContainer, zipPath);
    const zipHash = sha256(zipPath);
    fs.writeFileSync(checksumPath, `${zipHash}  ${path.basename(zipPath)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      status: "created",
      zipPath,
      checksumPath,
      sha256: zipHash,
      archiveBytes: fs.statSync(zipPath).size,
      fileCount: manifest.fileCount,
      payloadBytes: manifest.totalBytes,
      includesDependencies: options.withDependencies
    }, null, 2)}\n`);
  } finally {
    if (!options.keepStage && fs.existsSync(stageContainer)) fs.rmSync(stageContainer, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`delivery build failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  clearJsonSessions,
  createArchive,
  createDeliveryManifest,
  excluded,
  installDependencies,
  parseArguments,
  sanitizeSqlite,
  sanitizeWorkshopHostingConfig,
  verifySanitizedState
};
