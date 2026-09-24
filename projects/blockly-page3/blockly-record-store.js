"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_error) {
  throw new Error("Blockly 可扩展记录存储需要 Node.js 22.5 或更高版本（内置 node:sqlite）。");
}

const DATABASE_SCHEMA_VERSION = "chenlong.blockly-record-database/v1";
const DATABASE_FILE_NAME = "primary-blockly-records.sqlite";
const DATABASE_ID_PATTERN = /^bdb_[a-f0-9]{32}$/;
const RECORD_ID_PATTERN = /^run_[a-f0-9]{32}$/;
const RECORD_STATES = new Set(["saved", "submitted"]);
const PARTICIPANT_GROUP_MIGRATION_VERSION = "chenlong.blockly-participant-groups/primary-junior-high-v1";
const MIGRATED_PARTICIPANT_GROUPS = new Set(["primary", "junior", "high"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timestampMilliseconds(value, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError("Blockly 记录时间格式无效。");
  return Math.trunc(result);
}

function serializedRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)
    || !RECORD_ID_PATTERN.test(record.id)
    || typeof record.ownerUserId !== "string" || !record.ownerUserId
    || typeof record.taskId !== "string" || !record.taskId
    || !RECORD_STATES.has(record.recordState)) {
    throw new TypeError("Blockly 记录格式无效，无法写入记录数据库。");
  }
  const payload = JSON.stringify(record);
  return {
    id: record.id,
    ownerUserId: record.ownerUserId,
    ownerTeamId: typeof record.ownerTeamId === "string" && record.ownerTeamId ? record.ownerTeamId : null,
    taskId: record.taskId,
    recordState: record.recordState,
    score: Number.isFinite(record.score) ? record.score : null,
    submittedAt: record.recordState === "submitted" ? record.submittedAt : null,
    submittedAtMs: record.recordState === "submitted"
      ? timestampMilliseconds(record.submittedAt || record.createdAt)
      : null,
    createdAt: record.createdAt,
    createdAtMs: timestampMilliseconds(record.createdAt),
    payload,
    payloadSha256: sha256(payload)
  };
}

function parsedRecord(row) {
  if (!row || typeof row.payload_json !== "string") return null;
  const value = JSON.parse(row.payload_json);
  if (!value || typeof value !== "object" || value.id !== row.id) {
    throw new Error("Blockly 记录数据库包含损坏的数据。");
  }
  return value;
}

function fsyncFile(filePath) {
  // Windows rejects fsync on a descriptor opened read-only.  The backup is
  // already an exclusive copy, so opening it read/write here is safe and lets
  // us force the bytes to disk before the legacy JSON is compacted.
  const descriptor = fs.openSync(filePath, "r+");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function safeLegacyBackup(legacyStorePath, digest) {
  if (!legacyStorePath || !fs.existsSync(legacyStorePath)) return null;
  const directory = path.dirname(legacyStorePath);
  const extension = path.extname(legacyStorePath);
  const base = path.basename(legacyStorePath, extension);
  const backupPath = path.join(directory, `${base}.pre-sqlite-${digest.slice(0, 16)}${extension || ".json"}`);
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(legacyStorePath, backupPath, fs.constants.COPYFILE_EXCL);
    fsyncFile(backupPath);
  } else if (sha256(fs.readFileSync(backupPath)) !== digest) {
    throw new Error("Blockly 旧记录备份文件已存在但内容不一致，请先人工核查。");
  }
  return backupPath;
}

class BlocklyRecordStore {
  constructor({ dataDir, databasePath = null } = {}) {
    if (typeof dataDir !== "string" || !dataDir) throw new TypeError("Blockly 数据目录不能为空。");
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.databasePath = path.resolve(databasePath || path.join(this.dataDir, DATABASE_FILE_NAME));
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = FULL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    const metadataTable = this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata' LIMIT 1"
    ).get();
    const recordsTable = this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'records' LIMIT 1"
    ).get();
    if (recordsTable && !metadataTable) {
      this.database.close();
      throw new Error("Blockly 记录数据库缺少版本信息，服务已停止以避免覆盖未知数据。");
    }
    if (metadataTable) {
      const version = this.database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion' LIMIT 1").get();
      if (!version || version.value !== DATABASE_SCHEMA_VERSION) {
        this.database.close();
        throw new Error("Blockly 记录数据库版本不兼容，服务已停止以避免错误迁移。");
      }
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY NOT NULL,
        owner_user_id TEXT NOT NULL,
        owner_team_id TEXT,
        task_id TEXT NOT NULL,
        record_state TEXT NOT NULL CHECK (record_state IN ('saved', 'submitted')),
        score REAL,
        submitted_at TEXT,
        submitted_at_ms INTEGER,
        created_at TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS records_owner_created_idx
        ON records(owner_user_id, created_at_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS records_owner_state_submitted_idx
        ON records(owner_user_id, record_state, submitted_at_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS records_team_task_state_submitted_idx
        ON records(owner_team_id, task_id, record_state, submitted_at_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS records_state_submitted_idx
        ON records(record_state, submitted_at_ms DESC, id DESC);
    `);
    this.database.prepare(`
      INSERT INTO metadata (key, value) VALUES ('schemaVersion', ?)
      ON CONFLICT(key) DO NOTHING
    `).run(DATABASE_SCHEMA_VERSION);
    let databaseIdentity = this.database.prepare(
      "SELECT value FROM metadata WHERE key = 'databaseId' LIMIT 1"
    ).get();
    if (!databaseIdentity) {
      const generatedDatabaseId = `bdb_${crypto.randomBytes(16).toString("hex")}`;
      this.database.prepare(`
        INSERT INTO metadata (key, value) VALUES ('databaseId', ?)
        ON CONFLICT(key) DO NOTHING
      `).run(generatedDatabaseId);
      databaseIdentity = this.database.prepare(
        "SELECT value FROM metadata WHERE key = 'databaseId' LIMIT 1"
      ).get();
    }
    if (!databaseIdentity || !DATABASE_ID_PATTERN.test(databaseIdentity.value)) {
      this.database.close();
      throw new Error("Blockly 记录数据库身份信息无效，服务已停止以避免绑定错误数据。");
    }
    this.databaseId = databaseIdentity.value;
    this.statements = {
      insert: this.database.prepare(`
        INSERT INTO records (
          id, owner_user_id, owner_team_id, task_id, record_state, score,
          submitted_at, submitted_at_ms, created_at, created_at_ms,
          payload_json, payload_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      byId: this.database.prepare("SELECT id, payload_json FROM records WHERE id = ? LIMIT 1"),
      migrationById: this.database.prepare("SELECT payload_sha256 FROM records WHERE id = ? LIMIT 1"),
      countAll: this.database.prepare("SELECT COUNT(*) AS count FROM records"),
      updateSubmission: this.database.prepare(`
        UPDATE records SET record_state = 'submitted', submitted_at = ?, submitted_at_ms = ?,
          payload_json = ?, payload_sha256 = ?
        WHERE id = ? AND owner_user_id = ? AND record_state = 'saved'
      `)
    };
  }

  descriptor(migration = null) {
    return Object.freeze({
      schemaVersion: DATABASE_SCHEMA_VERSION,
      databaseFile: path.basename(this.databasePath),
      databaseId: this.databaseId,
      migratedAt: migration?.migratedAt || null,
      legacyBackup: migration?.backupPath ? path.basename(migration.backupPath) : null,
      legacyRecordCount: Number.isSafeInteger(migration?.recordCount) ? migration.recordCount : null
    });
  }

  bindDescriptor(descriptor, { allowLegacyBinding = false } = {}) {
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      throw new Error("Blockly 核心文件缺少记录数据库绑定信息。");
    }
    if (Object.hasOwn(descriptor, "databaseId")) {
      if (!DATABASE_ID_PATTERN.test(descriptor.databaseId) || descriptor.databaseId !== this.databaseId) {
        throw new Error("Blockly 记录数据库身份与核心文件不匹配；服务已停止，请恢复成套备份。");
      }
      return Object.freeze({ descriptor, upgraded: false });
    }
    if (!allowLegacyBinding) {
      throw new Error("Blockly 核心文件尚未绑定记录数据库；服务已停止以避免误用数据。");
    }

    if (Number.isSafeInteger(descriptor.legacyRecordCount)) {
      const imported = this.database.prepare(
        "SELECT value FROM metadata WHERE key = 'legacyImport' LIMIT 1"
      ).get();
      let metadata = null;
      try { metadata = imported ? JSON.parse(imported.value) : null; } catch (_error) {}
      if (!metadata || metadata.recordCount !== descriptor.legacyRecordCount
        || (descriptor.migratedAt && metadata.migratedAt !== descriptor.migratedAt)) {
        throw new Error("Blockly 旧版核心文件与记录数据库迁移信息不一致，不能自动绑定。");
      }
    }
    return Object.freeze({
      descriptor: Object.freeze({ ...descriptor, databaseId: this.databaseId }),
      upgraded: true
    });
  }

  count() {
    return Number(this.statements.countAll.get().count);
  }

  insert(record) {
    const value = serializedRecord(record);
    this.statements.insert.run(
      value.id, value.ownerUserId, value.ownerTeamId, value.taskId, value.recordState,
      value.score, value.submittedAt, value.submittedAtMs, value.createdAt,
      value.createdAtMs, value.payload, value.payloadSha256
    );
    return record;
  }

  importLegacyRecords(records, { legacyStorePath = null } = {}) {
    if (!Array.isArray(records)) throw new TypeError("Blockly 旧记录列表格式无效。");
    if (records.length === 0) return null;
    const legacyBytes = legacyStorePath && fs.existsSync(legacyStorePath)
      ? fs.readFileSync(legacyStorePath)
      : Buffer.from(JSON.stringify(records));
    const legacyDigest = sha256(legacyBytes);
    const backupPath = safeLegacyBackup(legacyStorePath, legacyDigest);
    const migratedAt = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        const value = serializedRecord(record);
        const existing = this.statements.migrationById.get(value.id);
        if (existing) {
          if (existing.payload_sha256 !== value.payloadSha256) {
            throw new Error(`Blockly 记录 ${value.id} 与数据库中同名记录内容不一致。`);
          }
          continue;
        }
        this.statements.insert.run(
          value.id, value.ownerUserId, value.ownerTeamId, value.taskId, value.recordState,
          value.score, value.submittedAt, value.submittedAtMs, value.createdAt,
          value.createdAtMs, value.payload, value.payloadSha256
        );
      }
      this.database.prepare(`
        INSERT INTO metadata (key, value) VALUES ('legacyImport', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(JSON.stringify({ digest: legacyDigest, recordCount: records.length, migratedAt }));
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch (_rollbackError) {}
      throw error;
    }
    for (const record of records) {
      if (!this.statements.migrationById.get(record.id)) {
        throw new Error(`Blockly 记录 ${record.id} 迁移校验失败。`);
      }
    }
    return Object.freeze({ backupPath, migratedAt, recordCount: records.length, legacyDigest });
  }

  migrateParticipantGroups(canonicalGroup) {
    if (typeof canonicalGroup !== "function") {
      throw new TypeError("Blockly 记录分组迁移需要规范化函数。");
    }
    const existing = this.database.prepare(
      "SELECT value FROM metadata WHERE key = 'participantGroupMigration' LIMIT 1"
    ).get();
    if (existing?.value === PARTICIPANT_GROUP_MIGRATION_VERSION) {
      return Object.freeze({ changed: 0, skipped: true, version: PARTICIPANT_GROUP_MIGRATION_VERSION });
    }
    const rows = this.database.prepare("SELECT id, payload_json FROM records ORDER BY id").all();
    const update = this.database.prepare(
      "UPDATE records SET payload_json = ?, payload_sha256 = ? WHERE id = ?"
    );
    const writeMarker = this.database.prepare(`
      INSERT INTO metadata (key, value) VALUES ('participantGroupMigration', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    let changed = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const record = parsedRecord(row);
        if (record.ownerGroup === null || record.ownerGroup === undefined) continue;
        const normalized = canonicalGroup(record.ownerGroup);
        if (!MIGRATED_PARTICIPANT_GROUPS.has(normalized)) {
          throw new Error("Blockly 记录分组规范化结果无效。");
        }
        if (record.ownerGroup === normalized) continue;
        const payload = JSON.stringify({ ...record, ownerGroup: normalized });
        update.run(payload, sha256(payload), record.id);
        changed += 1;
      }
      writeMarker.run(PARTICIPANT_GROUP_MIGRATION_VERSION);
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch (_rollbackError) {}
      throw error;
    }
    return Object.freeze({ changed, skipped: false, version: PARTICIPANT_GROUP_MIGRATION_VERSION });
  }

  findById(id, { ownerUserId = null, submittedOnly = false } = {}) {
    const row = this.statements.byId.get(id);
    const record = parsedRecord(row);
    if (!record || (ownerUserId && record.ownerUserId !== ownerUserId)
      || (submittedOnly && record.recordState !== "submitted")) return null;
    return record;
  }

  submit(id, ownerUserId, submittedAt) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const record = this.findById(id, { ownerUserId });
      if (!record) {
        this.database.exec("ROLLBACK");
        return null;
      }
      if (record.recordState === "submitted") {
        this.database.exec("COMMIT");
        return { record, duplicate: true };
      }
      record.recordState = "submitted";
      record.submittedAt = submittedAt;
      const payload = JSON.stringify(record);
      const result = this.statements.updateSubmission.run(
        submittedAt,
        timestampMilliseconds(submittedAt),
        payload,
        sha256(payload),
        id,
        ownerUserId
      );
      if (Number(result.changes) !== 1) throw new Error("Blockly 记录提交状态更新冲突。");
      this.database.exec("COMMIT");
      return { record, duplicate: false };
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch (_rollbackError) {}
      throw error;
    }
  }

  page({ ownerUserId = null, recordState = null, page = 1, pageSize = 250 } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new RangeError("Blockly 记录分页参数无效。");
    }
    const clauses = [];
    const parameters = [];
    if (ownerUserId) { clauses.push("owner_user_id = ?"); parameters.push(ownerUserId); }
    if (recordState) {
      if (!RECORD_STATES.has(recordState)) throw new TypeError("Blockly 记录状态无效。");
      clauses.push("record_state = ?");
      parameters.push(recordState);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = Number(this.database.prepare(`SELECT COUNT(*) AS count FROM records ${where}`).get(...parameters).count);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;
    const order = recordState === "submitted" && !ownerUserId
      ? "submitted_at_ms DESC, id DESC"
      : "created_at_ms DESC, id DESC";
    const rows = offset >= total ? [] : this.database.prepare(`
      SELECT id, payload_json FROM records ${where}
      ORDER BY ${order} LIMIT ? OFFSET ?
    `).all(...parameters, pageSize, offset);
    const records = rows.map(parsedRecord);
    return {
      records,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        returned: records.length,
        hasPrevious: page > 1,
        hasNext: offset + records.length < total
      }
    };
  }

  all({ recordState = null } = {}) {
    if (recordState && !RECORD_STATES.has(recordState)) throw new TypeError("Blockly 记录状态无效。");
    const where = recordState ? "WHERE record_state = ?" : "";
    const parameters = recordState ? [recordState] : [];
    const order = recordState === "submitted" ? "submitted_at_ms DESC, id DESC" : "created_at_ms DESC, id DESC";
    return this.database.prepare(`SELECT id, payload_json FROM records ${where} ORDER BY ${order}`)
      .all(...parameters).map(parsedRecord);
  }

  submittedStatsByOwner() {
    const result = new Map();
    const rows = this.database.prepare(`
      SELECT owner_user_id, COUNT(*) AS count, MAX(score) AS highest_score
      FROM records WHERE record_state = 'submitted' GROUP BY owner_user_id
    `).all();
    for (const row of rows) {
      result.set(row.owner_user_id, {
        count: Number(row.count),
        highestScore: Number.isFinite(row.highest_score) ? row.highest_score : null
      });
    }
    return result;
  }

  bestSubmittedTeamTaskScores() {
    const rows = this.database.prepare(`
      SELECT id, owner_user_id, owner_team_id, task_id, score, submitted_at
      FROM (
        SELECT id, owner_user_id, owner_team_id, task_id, score, submitted_at,
          ROW_NUMBER() OVER (
            PARTITION BY
              CASE
                WHEN owner_team_id IS NULL THEN 'user:' || owner_user_id
                ELSE 'team:' || owner_team_id
              END,
              task_id
            ORDER BY score DESC, submitted_at_ms DESC, id ASC
          ) AS score_rank
        FROM records
        WHERE record_state = 'submitted'
          AND score IS NOT NULL AND score >= 0 AND score <= 100
      )
      WHERE score_rank = 1
      ORDER BY submitted_at DESC, id ASC
    `).all();
    return rows.map(row => Object.freeze({
      id: row.id,
      ownerUserId: row.owner_user_id,
      teamId: row.owner_team_id,
      taskId: row.task_id,
      score: Number(row.score),
      recordState: "submitted",
      submittedAt: row.submitted_at
    }));
  }

  latestOwnerSnapshots(excludedOwnerIds = new Set()) {
    const rows = this.database.prepare(`
      SELECT id, payload_json FROM (
        SELECT id, owner_user_id, payload_json,
          ROW_NUMBER() OVER (PARTITION BY owner_user_id ORDER BY created_at_ms DESC, id DESC) AS owner_row
        FROM records
      ) WHERE owner_row = 1
    `).all();
    return rows.map(parsedRecord).filter(record => !excludedOwnerIds.has(record.ownerUserId));
  }

  queryByTeamTaskState({ ownerTeamId, taskId, recordState = "submitted", limit = 100 } = {}) {
    if (typeof ownerTeamId !== "string" || !ownerTeamId || typeof taskId !== "string" || !taskId
      || !RECORD_STATES.has(recordState) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError("Blockly 队伍任务记录查询参数无效。");
    }
    return this.database.prepare(`
      SELECT id, payload_json FROM records
      WHERE owner_team_id = ? AND task_id = ? AND record_state = ?
      ORDER BY submitted_at_ms DESC, created_at_ms DESC, id DESC LIMIT ?
    `).all(ownerTeamId, taskId, recordState, limit).map(parsedRecord);
  }

  close() {
    if (!this.database) return;
    this.database.close();
    this.database = null;
  }
}

module.exports = Object.freeze({
  BlocklyRecordStore,
  DATABASE_SCHEMA_VERSION,
  DATABASE_FILE_NAME,
  DATABASE_ID_PATTERN,
  PARTICIPANT_GROUP_MIGRATION_VERSION
});
