"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const contract = require("../packages/platform-contract.js");

const secret = "strict-platform-test-secret-1234567890";
const user = {
  id: "usr_0123456789abcdef0123456789abcdef",
  username: "test1",
  displayName: "测试用户",
  role: "user",
  teamId: "tea_0123456789abcdef0123456789abcdef",
  teamName: "测试队",
  group: "primary",
  createdAt: "2026-08-28T00:00:00.000Z"
};

test("signed platform principals are audience-bound and expire", () => {
  const signed = contract.signPrincipal(secret, "blockly", user, { now: 1_000_000, ttlMs: 10_000 });
  assert.deepEqual(contract.verifyPrincipal(signed, secret, "blockly", { now: 1_005_000 }).user, user);
  assert.throws(() => contract.verifyPrincipal(signed, secret, "workshop", { now: 1_005_000 }));
  assert.throws(() => contract.verifyPrincipal(signed, secret, "blockly", { now: 1_010_000 }));
  assert.throws(() => contract.verifyPrincipal(`${signed.slice(0, -1)}A`, secret, "blockly", { now: 1_005_000 }));
});

test("map bundles and task mappings are fixed across Python and Blockly", () => {
  const maps = [1, 2, 3].map(index => ({
    taskId: `GYI-PRIMARY-0${index}`,
    revision: 0,
    digest: "a".repeat(64),
    layout: { schemaVersion: "chenlong.guangyang-map-layout/v2" }
  }));
  const signed = contract.signMapBundle(secret, maps, { now: 2_000_000 });
  assert.equal(contract.verifyMapBundle(signed, secret, { now: 2_001_000 }).maps.length, 3);
  assert.equal(contract.platformTaskId("R2-GYI-MVP-02"), "task2");
  assert.equal(contract.platformTaskId("GYI-PRIMARY-03"), "task3");
  assert.equal(contract.divisionForGroup("primary"), "primary");
  assert.equal(contract.divisionForGroup("primary_low"), "primary");
  assert.equal(contract.divisionForGroup("primary_high"), "primary");
  assert.equal(contract.divisionForGroup("high"), "senior");
  assert.equal(contract.canonicalParticipantGroup("小学组"), "primary");
  assert.equal(contract.canonicalParticipantGroup("小学组（1-3年级）"), "primary");
  assert.equal(contract.canonicalParticipantGroup("小学组（4-6年级）"), "primary");
});
