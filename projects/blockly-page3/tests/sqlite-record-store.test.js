"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BlocklyRecordStore,
  DATABASE_SCHEMA_VERSION,
  DATABASE_FILE_NAME,
  PARTICIPANT_GROUP_MIGRATION_VERSION
} = require("../blockly-record-store.js");

function threeGroup(value) {
  return ["primary", "primary_low", "primary_high"].includes(value) ? "primary" : value;
}

function hexId(prefix, value) {
  return `${prefix}_${value.toString(16).padStart(32, "0")}`;
}

function capacityRecord(userNumber, recordNumber, globalNumber) {
  const createdAt = new Date(Date.parse("2026-08-28T00:00:00.000Z") + globalNumber * 10).toISOString();
  const submitted = recordNumber % 2 === 0;
  return {
    id: hexId("run", globalNumber + 1),
    ownerUserId: hexId("usr", userNumber + 1),
    ownerUsername: `capacity_${userNumber + 1}`,
    ownerDisplayName: `容量用户${userNumber + 1}`,
    ownerTeamId: hexId("tea", userNumber + 1),
    ownerTeamName: `容量队伍${userNumber + 1}`,
    ownerGroup: ["primary_low", "primary_high", "junior", "high"][userNumber % 4],
    taskId: `GYI-PRIMARY-0${(recordNumber % 3) + 1}`,
    taskName: `广阳岛综合任务${(recordNumber % 3) + 1}`,
    score: (userNumber + recordNumber) % 101,
    recordState: submitted ? "submitted" : "saved",
    savedAt: createdAt,
    submittedAt: submitted ? createdAt : null,
    createdAt,
    programCode: `await robot.forward(${10 + recordNumber})`,
    workspaceXml: JSON.stringify({ userNumber, recordNumber }),
    executionTrace: recordNumber % 2 ? ["mission"] : []
  };
}

test("legacy JSON migration is backed up, transactional, indexed and idempotent", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-sqlite-migration-"));
  const legacyPath = path.join(dataDir, "primary-blockly-store.json");
  const records = Array.from({ length: 12 }, (_, index) => capacityRecord(0, index, index));
  const legacyBytes = Buffer.from(`${JSON.stringify({ schemaVersion: "chenlong.blockly-primary-store/v7", records })}\n`);
  fs.writeFileSync(legacyPath, legacyBytes);
  const store = new BlocklyRecordStore({ dataDir });
  try {
    const migration = store.importLegacyRecords(records, { legacyStorePath: legacyPath });
    assert.equal(migration.recordCount, records.length);
    assert.ok(migration.backupPath && fs.existsSync(migration.backupPath));
    assert.deepEqual(fs.readFileSync(migration.backupPath), legacyBytes);
    assert.equal(store.count(), 12);
    assert.equal(store.descriptor(migration).schemaVersion, DATABASE_SCHEMA_VERSION);
    assert.equal(store.descriptor(migration).databaseFile, DATABASE_FILE_NAME);

    const again = store.importLegacyRecords(records, { legacyStorePath: legacyPath });
    assert.equal(again.recordCount, records.length);
    assert.equal(store.count(), 12, "重复启动迁移不能复制记录");
    assert.throws(() => store.importLegacyRecords([{ ...records[0], score: 99 }], { legacyStorePath: legacyPath }),
      /同名记录内容不一致/);

    const indexes = new Set(store.database.prepare("PRAGMA index_list('records')").all().map(row => row.name));
    assert.ok(indexes.has("records_owner_created_idx"));
    assert.ok(indexes.has("records_owner_state_submitted_idx"));
    assert.ok(indexes.has("records_team_task_state_submitted_idx"));
    assert.ok(indexes.has("records_state_submitted_idx"));
  } finally {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("record payload migration merges both historical primary groups transactionally and idempotently", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-group-migration-"));
  const store = new BlocklyRecordStore({ dataDir });
  try {
    const records = ["primary_low", "primary_high", "junior", "high"].map((group, index) => ({
      ...capacityRecord(index, 0, index),
      ownerGroup: group
    }));
    records.forEach(record => store.insert(record));
    const migration = store.migrateParticipantGroups(threeGroup);
    assert.deepEqual(migration, {
      changed: 2,
      skipped: false,
      version: PARTICIPANT_GROUP_MIGRATION_VERSION
    });
    assert.deepEqual(store.all().map(record => record.ownerGroup).sort(), ["high", "junior", "primary", "primary"]);
    const marker = store.database.prepare(
      "SELECT value FROM metadata WHERE key = 'participantGroupMigration'"
    ).get();
    assert.equal(marker.value, PARTICIPANT_GROUP_MIGRATION_VERSION);
    assert.deepEqual(store.migrateParticipantGroups(threeGroup), {
      changed: 0,
      skipped: true,
      version: PARTICIPANT_GROUP_MIGRATION_VERSION
    });
  } finally {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("2000 accounts with repeated records keep indexed owner, team, task and state reads bounded", { timeout: 30_000 }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blockly-sqlite-capacity-"));
  const legacyPath = path.join(dataDir, "primary-blockly-store.json");
  const accountCount = 2_000;
  const recordsPerAccount = 12;
  const records = [];
  for (let userNumber = 0; userNumber < accountCount; userNumber += 1) {
    for (let recordNumber = 0; recordNumber < recordsPerAccount; recordNumber += 1) {
      records.push(capacityRecord(userNumber, recordNumber, records.length));
    }
  }
  fs.writeFileSync(legacyPath, JSON.stringify({ schemaVersion: "chenlong.blockly-primary-store/v7", records }));
  const startedAt = Date.now();
  let store = new BlocklyRecordStore({ dataDir });
  try {
    store.importLegacyRecords(records, { legacyStorePath: legacyPath });
    assert.equal(store.count(), accountCount * recordsPerAccount);
    assert.ok(Date.now() - startedAt < 20_000, "24,000 条旧记录应在启动期限内完成一次性事务迁移");

    const owner = hexId("usr", 1_501);
    const ownerPage = store.page({ ownerUserId: owner, page: 1, pageSize: 250 });
    assert.equal(ownerPage.pagination.total, recordsPerAccount);
    assert.equal(ownerPage.records.length, recordsPerAccount);
    assert.ok(ownerPage.records.every(record => record.ownerUserId === owner));

    const teamRows = store.queryByTeamTaskState({
      ownerTeamId: hexId("tea", 1_501),
      taskId: "GYI-PRIMARY-01",
      recordState: "submitted"
    });
    assert.equal(teamRows.length, 2);
    assert.ok(teamRows.every(record => record.ownerTeamId === hexId("tea", 1_501)
      && record.taskId === "GYI-PRIMARY-01" && record.recordState === "submitted"));

    const stats = store.submittedStatsByOwner();
    assert.equal(stats.size, accountCount);
    assert.equal(stats.get(owner).count, recordsPerAccount / 2);

    const teamTaskScores = store.bestSubmittedTeamTaskScores();
    assert.equal(teamTaskScores.length, accountCount * 3,
      "24,000 条原始记录只能生成每队每任务一条最高分聚合");
    assert.ok(teamTaskScores.every(record => record.recordState === "submitted"
      && Number.isFinite(record.score) && record.score >= 0 && record.score <= 100));
    const ownerTeamScores = teamTaskScores.filter(record => record.teamId === hexId("tea", 1_501));
    assert.equal(ownerTeamScores.length, 3);
    assert.deepEqual(new Set(ownerTeamScores.map(record => record.taskId)), new Set([
      "GYI-PRIMARY-01", "GYI-PRIMARY-02", "GYI-PRIMARY-03"
    ]));

    const submittedPage = store.page({ recordState: "submitted", page: 15, pageSize: 1_000 });
    assert.equal(submittedPage.pagination.total, accountCount * recordsPerAccount / 2);
    assert.equal(submittedPage.records.length, 0, "超出末页保持兼容的空页语义");

    store.close();
    store = new BlocklyRecordStore({ dataDir });
    assert.equal(store.count(), accountCount * recordsPerAccount, "重启后记录数量必须保持一致");
    assert.equal(store.page({ ownerUserId: owner, page: 1, pageSize: 20 }).records.length, recordsPerAccount);
  } finally {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
