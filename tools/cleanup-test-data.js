"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_error) {
  DatabaseSync = null;
}

const PLATFORM_ROOT = path.resolve(__dirname, "..");
const BLOCKLY_DATABASE_SCHEMA = "chenlong.blockly-record-database/v1";
const BLOCKLY_DATABASE_FILE = "primary-blockly-records.sqlite";
const TEST_USERNAME_PREFIXES = Object.freeze(["accept_", "mate_", "live_user_", "qa_"]);
const TEST_PROGRAM_MARKERS = Object.freeze(["统一平台联调验收记录（非参赛程序）"]);

function cleanupPaths(platformRoot = PLATFORM_ROOT) {
  const root = path.resolve(platformRoot);
  const pythonRuntime = path.join(root, "projects", "car-python", ".runtime");
  const blocklyData = path.join(root, "projects", "blockly-page3", ".blockly-data");
  return Object.freeze({
    platformRoot: root,
    backupRoot: path.join(root, "record-backups"),
    authPath: path.join(pythonRuntime, "auth", "auth-store.json"),
    pythonSessionsPath: path.join(pythonRuntime, "sessions"),
    pythonLockPath: path.join(pythonRuntime, ".chenlong-writer.lock"),
    blocklyPath: path.join(blocklyData, "primary-blockly-store.json"),
    blocklyDatabasePath: path.join(blocklyData, BLOCKLY_DATABASE_FILE),
    blocklyLockPath: path.join(blocklyData, ".primary-blockly-store.writer.lock")
  });
}

const DEFAULT_PATHS = cleanupPaths();

function parseArguments(argv) {
  const apply = argv.includes("--apply");
  const includeAdmin = argv.includes("--include-admin");
  const archiveIndex = argv.indexOf("--archive");
  const archive = archiveIndex >= 0 ? argv[archiveIndex + 1] : null;
  const beforeIndex = argv.indexOf("--before");
  const beforeDate = beforeIndex >= 0 ? argv[beforeIndex + 1] : null;
  if (apply && !archive) throw new TypeError("--apply requires --archive <directory>");
  if (archiveIndex >= 0 && (!archive || archive.startsWith("--"))) {
    throw new TypeError("--archive requires a directory");
  }
  if (beforeIndex >= 0 && (!beforeDate || beforeDate.startsWith("--"))) {
    throw new TypeError("--before requires YYYY-MM-DD");
  }
  if (beforeDate !== null && !/^\d{4}-\d{2}-\d{2}$/u.test(beforeDate)) {
    throw new TypeError("--before must use YYYY-MM-DD");
  }
  return { apply, archive: archive ? path.resolve(archive) : null, beforeDate, includeAdmin };
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function isTestUsername(value) {
  const username = String(value || "").trim().toLowerCase();
  return TEST_USERNAME_PREFIXES.some(prefix => username.startsWith(prefix));
}

function isTestOfficialId(value) {
  return String(value || "").trim().toLowerCase().startsWith("qa_");
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function assertNoLiveWriter(lockPath) {
  if (!fs.existsSync(lockPath)) return;
  let lock = null;
  try {
    lock = loadJson(lockPath);
  } catch {
    throw new Error(`unreadable writer lock: ${lockPath}`);
  }
  if (processIsAlive(Number(lock.pid))) {
    throw new Error(`writer process ${lock.pid} is still active: ${lockPath}`);
  }
}

function assertServicesStopped(paths) {
  assertNoLiveWriter(paths.pythonLockPath);
  assertNoLiveWriter(paths.blocklyLockPath);
}

function selectedDate(value) {
  return String(
    value?.submittedAt || value?.savedAt || value?.updatedAt || value?.createdAt || ""
  ).slice(0, 10);
}

function ownerIsAdmin(record, adminUserIds, adminUsernames) {
  return adminUserIds.has(record?.ownerUserId)
    || adminUsernames.has(String(record?.ownerUsername || "").trim().toLowerCase());
}

function shouldRemoveRecord(record, context) {
  if (ownerIsAdmin(record, context.adminUserIds, context.adminUsernames) && !context.includeAdmin) {
    return false;
  }
  const ownerUsername = String(record?.ownerUsername || "").trim().toLowerCase();
  const programCode = String(record?.programCode || "");
  const recordDate = selectedDate(record);
  return context.removedUserIds.has(record?.ownerUserId)
    || context.removedUsernames.has(ownerUsername)
    || TEST_PROGRAM_MARKERS.some(marker => programCode.includes(marker))
    || (context.beforeDate !== null && recordDate !== "" && recordDate < context.beforeDate);
}

function readBlocklySqliteRecords(databasePath, blockly) {
  if (!fs.existsSync(databasePath)) return [];
  if (!DatabaseSync) throw new Error("Node.js 22.5 or newer is required to inspect Blockly SQLite data");
  if (!blockly.recordStorage || blockly.recordStorage.databaseFile !== BLOCKLY_DATABASE_FILE) {
    throw new Error("Blockly SQLite exists but the core store is not safely bound to it");
  }
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA query_only = ON");
    const version = database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion' LIMIT 1").get();
    const databaseId = database.prepare("SELECT value FROM metadata WHERE key = 'databaseId' LIMIT 1").get();
    if (!version || version.value !== BLOCKLY_DATABASE_SCHEMA
      || !databaseId || databaseId.value !== blockly.recordStorage.databaseId) {
      throw new Error("Blockly record database identity does not match the core store");
    }
    return database.prepare(`
      SELECT id, owner_user_id, payload_json, payload_sha256
      FROM records ORDER BY created_at_ms ASC, id ASC
    `).all().map(row => {
      const record = JSON.parse(row.payload_json);
      const digest = crypto.createHash("sha256").update(row.payload_json, "utf8").digest("hex");
      if (!record || record.id !== row.id || record.ownerUserId !== row.owner_user_id
        || digest !== row.payload_sha256) {
        throw new Error(`Blockly record ${row.id} failed its integrity check`);
      }
      return { record, payloadSha256: row.payload_sha256 };
    });
  } finally {
    database.close();
  }
}

function collectCleanupPlan({ beforeDate = null, includeAdmin = false, paths = DEFAULT_PATHS } = {}) {
  const auth = loadJson(paths.authPath);
  const blockly = loadJson(paths.blocklyPath);
  const legacyBlocklyRecords = Array.isArray(blockly.records) ? blockly.records : null;
  const hasSqlite = fs.existsSync(paths.blocklyDatabasePath);
  if (legacyBlocklyRecords && hasSqlite) {
    throw new Error("Blockly legacy JSON records and SQLite coexist; start and stop Blockly once to finish migration before cleanup");
  }
  if (!legacyBlocklyRecords && !hasSqlite) {
    throw new Error("Blockly core store references SQLite but the record database is missing");
  }

  const removableAccount = user => (includeAdmin || user.role !== "admin")
    && (isTestUsername(user.username) || isTestOfficialId(user.officialUserId));
  const removedAuthUsers = auth.users.filter(removableAccount);
  const removedBlocklyUsers = blockly.users.filter(removableAccount);
  const removedUserIds = new Set([
    ...removedAuthUsers.map(user => user.id),
    ...removedBlocklyUsers.map(user => user.id)
  ]);
  const adminUserIds = new Set([
    ...auth.users.filter(user => user.role === "admin").map(user => user.id),
    ...blockly.users.filter(user => user.role === "admin").map(user => user.id)
  ]);
  const adminUsernames = new Set([
    ...auth.users.filter(user => user.role === "admin").map(user => String(user.username).toLowerCase()),
    ...blockly.users.filter(user => user.role === "admin").map(user => String(user.username).toLowerCase())
  ]);
  const removedUsernames = new Set([
    ...removedAuthUsers.map(user => String(user.username).toLowerCase()),
    ...removedBlocklyUsers.map(user => String(user.username).toLowerCase())
  ]);

  const remainingAuthUsers = auth.users.filter(user => !removedUserIds.has(user.id));
  const remainingBlocklyUsers = blockly.users.filter(user => !removedUserIds.has(user.id));
  const referencedAuthTeams = new Set(remainingAuthUsers.map(user => user.teamId).filter(Boolean));
  const referencedBlocklyTeams = new Set(remainingBlocklyUsers.map(user => user.teamId).filter(Boolean));
  const candidateAuthTeams = new Set(removedAuthUsers.map(user => user.teamId).filter(Boolean));
  const candidateBlocklyTeams = new Set(removedBlocklyUsers.map(user => user.teamId).filter(Boolean));
  const removedAuthTeams = auth.teams.filter(team => (
    candidateAuthTeams.has(team.id) && !referencedAuthTeams.has(team.id)
  ));
  const removedBlocklyTeams = blockly.teams.filter(team => (
    candidateBlocklyTeams.has(team.id) && !referencedBlocklyTeams.has(team.id)
  ));
  const removedAuthSessions = auth.sessions.filter(session => removedUserIds.has(session.userId));
  const removedBlocklySessions = blockly.sessions.filter(session => removedUserIds.has(session.userId));
  const recordContext = {
    adminUserIds, adminUsernames, removedUserIds, removedUsernames, includeAdmin, beforeDate
  };
  const removedBlocklyJsonRecords = legacyBlocklyRecords
    ? legacyBlocklyRecords.filter(record => shouldRemoveRecord(record, recordContext))
    : [];
  const sqliteRecords = hasSqlite ? readBlocklySqliteRecords(paths.blocklyDatabasePath, blockly) : [];
  const removedBlocklySqliteRecords = sqliteRecords.filter(item => (
    shouldRemoveRecord(item.record, recordContext)
  ));

  const pythonSessionDirectories = [];
  const pythonSessionFingerprints = new Map();
  if (fs.existsSync(paths.pythonSessionsPath)) {
    for (const entry of fs.readdirSync(paths.pythonSessionsPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.join(paths.pythonSessionsPath, entry.name);
      const sessionPath = path.join(directory, "session.json");
      if (!fs.existsSync(sessionPath)) continue;
      try {
        const session = loadJson(sessionPath);
        const adminOwner = ownerIsAdmin(session, adminUserIds, adminUsernames);
        if (adminOwner && !includeAdmin) continue;
        const sessionDate = selectedDate(session);
        if (
          removedUserIds.has(session.ownerUserId)
          || removedUserIds.has(session.teamId)
          || removedUsernames.has(String(session.ownerUsername || "").toLowerCase())
          || (includeAdmin && adminOwner)
          || (beforeDate !== null && sessionDate !== "" && sessionDate < beforeDate)
        ) {
          pythonSessionDirectories.push(directory);
          pythonSessionFingerprints.set(directory, sha256File(sessionPath));
        }
      } catch {
        // Corrupt formal data is deliberately left in place for manual inspection.
      }
    }
  }

  const sqliteFiles = [
    paths.blocklyDatabasePath,
    `${paths.blocklyDatabasePath}-wal`,
    `${paths.blocklyDatabasePath}-shm`
  ];
  const fingerprints = new Map([
    [paths.authPath, sha256File(paths.authPath)],
    [paths.blocklyPath, sha256File(paths.blocklyPath)]
  ]);
  for (const filePath of sqliteFiles) {
    fingerprints.set(filePath, fs.existsSync(filePath) ? sha256File(filePath) : null);
  }

  return {
    paths,
    auth,
    blockly,
    beforeDate,
    includeAdmin,
    removedAuthUsers,
    removedBlocklyUsers,
    removedAuthTeams,
    removedBlocklyTeams,
    removedAuthSessions,
    removedBlocklySessions,
    removedBlocklyJsonRecords,
    removedBlocklySqliteRecords,
    blocklySqliteRecordCount: sqliteRecords.length,
    removedUserIds,
    removedBlocklyJsonRecordIds: new Set(removedBlocklyJsonRecords.map(record => record.id)),
    pythonSessionDirectories,
    pythonSessionFingerprints,
    fingerprints
  };
}

function assertArchiveReady(archivePath, paths) {
  const backupRoot = path.resolve(paths.backupRoot);
  const resolved = path.resolve(archivePath);
  const relative = path.relative(backupRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("archive must be a child directory of record-backups");
  }
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(resolved).length !== 0) {
      throw new Error("archive directory must be new or empty");
    }
  }
  return resolved;
}

function assertPlanFresh(plan) {
  for (const [filePath, digest] of plan.fingerprints) {
    const exists = fs.existsSync(filePath);
    if ((digest === null && exists) || (digest !== null && (!exists || sha256File(filePath) !== digest))) {
      throw new Error(`cleanup source changed after planning: ${filePath}`);
    }
  }
  for (const [directory, digest] of plan.pythonSessionFingerprints) {
    const sessionPath = path.join(directory, "session.json");
    if (!fs.existsSync(sessionPath) || sha256File(sessionPath) !== digest) {
      throw new Error(`Python session changed after planning: ${directory}`);
    }
  }
}

function copyFileExclusive(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function performFullBackup(plan, archivePath) {
  const fullBackup = path.join(archivePath, "full-backup");
  const mappings = [];
  const addFile = (source, relative) => {
    if (!fs.existsSync(source)) return;
    const destination = path.join(fullBackup, relative);
    copyFileExclusive(source, destination);
    mappings.push({ source, destination });
  };
  addFile(plan.paths.authPath, path.join("car-python", "auth-store.json"));
  addFile(plan.paths.blocklyPath, path.join("blockly", "primary-blockly-store.json"));
  addFile(plan.paths.blocklyDatabasePath, path.join("blockly", BLOCKLY_DATABASE_FILE));
  addFile(`${plan.paths.blocklyDatabasePath}-wal`, path.join("blockly", `${BLOCKLY_DATABASE_FILE}-wal`));
  addFile(`${plan.paths.blocklyDatabasePath}-shm`, path.join("blockly", `${BLOCKLY_DATABASE_FILE}-shm`));
  if (fs.existsSync(plan.paths.pythonSessionsPath)) {
    const destination = path.join(fullBackup, "car-python", "sessions");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(plan.paths.pythonSessionsPath, destination, {
      recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true
    });
  }
  const manifest = {
    schemaVersion: "chenlong.cleanup-backup/v1",
    generatedAt: new Date().toISOString(),
    files: mappings.map(item => ({
      source: path.relative(plan.paths.platformRoot, item.source),
      backup: path.relative(archivePath, item.destination),
      sha256: sha256File(item.destination)
    }))
  };
  fs.writeFileSync(path.join(fullBackup, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8", flag: "wx", mode: 0o600
  });
  return { fullBackup, mappings };
}

function writeJsonExclusive(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8", flag: "wx", mode: 0o600
  });
}

function stageJson(filePath, value) {
  const temporary = `${filePath}.cleanup-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8", flag: "wx", mode: 0o600
  });
  return temporary;
}

function deleteSqliteRecords(plan) {
  if (plan.removedBlocklySqliteRecords.length === 0) return;
  const database = new DatabaseSync(plan.paths.blocklyDatabasePath);
  try {
    const version = database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion' LIMIT 1").get();
    if (!version || version.value !== BLOCKLY_DATABASE_SCHEMA) throw new Error("Blockly database version changed");
    const remove = database.prepare("DELETE FROM records WHERE id = ? AND payload_sha256 = ?");
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const item of plan.removedBlocklySqliteRecords) {
        const result = remove.run(item.record.id, item.payloadSha256);
        if (Number(result.changes) !== 1) {
          throw new Error(`Blockly record changed before cleanup: ${item.record.id}`);
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch (_rollbackError) {}
      throw error;
    }
  } finally {
    database.close();
  }
}

function restoreFiles(backup, plan, movedSessions) {
  for (const { source, destination } of backup.mappings) {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.copyFileSync(destination, source);
  }
  const backedUpSources = new Set(backup.mappings.map(item => item.source));
  for (const sidecar of [`${plan.paths.blocklyDatabasePath}-wal`, `${plan.paths.blocklyDatabasePath}-shm`]) {
    if (!backedUpSources.has(sidecar) && fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
  }
  for (const { source, destination } of movedSessions.reverse()) {
    if (!fs.existsSync(source) && fs.existsSync(destination)) fs.renameSync(destination, source);
  }
}

function applyCleanup(plan, archivePath) {
  assertServicesStopped(plan.paths);
  assertPlanFresh(plan);
  const archive = assertArchiveReady(archivePath, plan.paths);
  fs.mkdirSync(archive, { recursive: true });

  const removedSessionRoot = path.join(archive, "removed", "python-sessions");
  for (const directory of plan.pythonSessionDirectories) {
    const destination = path.join(removedSessionRoot, path.basename(directory));
    if (fs.existsSync(destination)) throw new Error(`archive collision: ${destination}`);
  }

  const backup = performFullBackup(plan, archive);
  const removedPayload = {
    schemaVersion: "chenlong.cleanup-removed-data/v2",
    generatedAt: new Date().toISOString(),
    options: { beforeDate: plan.beforeDate, includeAdmin: plan.includeAdmin },
    authUsers: plan.removedAuthUsers,
    authTeams: plan.removedAuthTeams,
    authSessions: plan.removedAuthSessions,
    blocklyUsers: plan.removedBlocklyUsers,
    blocklyTeams: plan.removedBlocklyTeams,
    blocklySessions: plan.removedBlocklySessions,
    blocklyJsonRecords: plan.removedBlocklyJsonRecords,
    blocklySqliteRecords: plan.removedBlocklySqliteRecords.map(item => item.record)
  };
  writeJsonExclusive(path.join(archive, "removed-test-data.json"), removedPayload);

  const auth = {
    ...plan.auth,
    revision: Number.isSafeInteger(plan.auth.revision) ? plan.auth.revision + 1 : plan.auth.revision,
    users: plan.auth.users.filter(user => !plan.removedUserIds.has(user.id)),
    teams: plan.auth.teams.filter(team => !plan.removedAuthTeams.some(removed => removed.id === team.id)),
    sessions: plan.auth.sessions.filter(session => !plan.removedUserIds.has(session.userId))
  };
  const blockly = {
    ...plan.blockly,
    users: plan.blockly.users.filter(user => !plan.removedUserIds.has(user.id)),
    teams: plan.blockly.teams.filter(team => !plan.removedBlocklyTeams.some(removed => removed.id === team.id)),
    sessions: plan.blockly.sessions.filter(session => !plan.removedUserIds.has(session.userId))
  };
  if (Array.isArray(plan.blockly.records)) {
    blockly.records = plan.blockly.records.filter(record => !plan.removedBlocklyJsonRecordIds.has(record.id));
  } else if (blockly.recordStorage) {
    blockly.recordStorage = {
      ...blockly.recordStorage,
      // The service uses this value as a lower-bound corruption guard.  An
      // intentional, fully archived cleanup must reset the bound to the exact
      // post-cleanup count or the next startup would correctly refuse to open.
      legacyRecordCount: plan.blocklySqliteRecordCount - plan.removedBlocklySqliteRecords.length
    };
  }

  const staged = [stageJson(plan.paths.authPath, auth), stageJson(plan.paths.blocklyPath, blockly)];
  const movedSessions = [];
  try {
    deleteSqliteRecords(plan);
    fs.renameSync(staged[0], plan.paths.authPath);
    fs.renameSync(staged[1], plan.paths.blocklyPath);
    fs.mkdirSync(removedSessionRoot, { recursive: true });
    for (const directory of plan.pythonSessionDirectories) {
      const destination = path.join(removedSessionRoot, path.basename(directory));
      fs.renameSync(directory, destination);
      movedSessions.push({ source: directory, destination });
    }
    writeJsonExclusive(path.join(archive, "cleanup-result.json"), {
      schemaVersion: "chenlong.cleanup-result/v1",
      completedAt: new Date().toISOString(),
      ...summary(plan)
    });
  } catch (error) {
    try { restoreFiles(backup, plan, movedSessions); } catch (restoreError) {
      error.message += `; automatic restore also failed: ${restoreError.message}`;
    }
    throw error;
  } finally {
    for (const temporary of staged) {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }
}

function summary(plan) {
  return {
    authUsers: plan.removedAuthUsers.length,
    blocklyUsers: plan.removedBlocklyUsers.length,
    authTeams: plan.removedAuthTeams.length,
    blocklyTeams: plan.removedBlocklyTeams.length,
    authSessions: plan.removedAuthSessions.length,
    blocklySessions: plan.removedBlocklySessions.length,
    blocklyJsonRecords: plan.removedBlocklyJsonRecords.length,
    blocklySqliteRecords: plan.removedBlocklySqliteRecords.length,
    blocklyRecords: plan.removedBlocklyJsonRecords.length + plan.removedBlocklySqliteRecords.length,
    pythonSessions: plan.pythonSessionDirectories.length
  };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.apply) assertServicesStopped(DEFAULT_PATHS);
  const plan = collectCleanupPlan({
    beforeDate: options.beforeDate,
    includeAdmin: options.includeAdmin,
    paths: DEFAULT_PATHS
  });
  if (options.apply) applyCleanup(plan, options.archive);
  process.stdout.write(`${JSON.stringify({
    mode: options.apply ? "applied" : "dry-run",
    beforeDate: options.beforeDate,
    includeAdmin: options.includeAdmin,
    ...summary(plan)
  }, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = Object.freeze({
  BLOCKLY_DATABASE_SCHEMA,
  BLOCKLY_DATABASE_FILE,
  TEST_USERNAME_PREFIXES,
  TEST_PROGRAM_MARKERS,
  cleanupPaths,
  parseArguments,
  collectCleanupPlan,
  applyCleanup,
  summary
});
