"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { GUANGYANG_CHALLENGE_CONFIGS } = require("../competition-core.js");
const {
  MAP_POOL_COUNTS,
  variantId,
  variantNumber,
  buildInitialMapPoolLayouts,
  assignedVariantId
} = require("../backend/guangyang-map-pool.js");
const {
  defaultLayout,
  mapGeometry,
  normalizeLayout
} = require("../backend/guangyang-map-config-store.js");

test("three challenge map pools freeze exactly 8, 10, and 12 distinct valid layouts", () => {
  assert.deepEqual(Object.values(MAP_POOL_COUNTS), [8, 10, 12]);
  for (const config of GUANGYANG_CHALLENGE_CONFIGS) {
    const layouts = buildInitialMapPoolLayouts(config);
    assert.equal(layouts.length, MAP_POOL_COUNTS[config.taskId]);
    assert.equal(new Set(layouts.map(JSON.stringify)).size, layouts.length);
    assert.deepEqual(layouts[0], normalizeLayout(defaultLayout(config), mapGeometry(config)),
      "map-01 must preserve the previously published challenge default");
    assert.ok(Object.isFrozen(layouts));
  }
});

test("variant identifiers are strict and reversible", () => {
  assert.equal(variantId(1), "map-01");
  assert.equal(variantId(12), "map-12");
  assert.equal(variantNumber("map-08"), 8);
  assert.throws(() => variantId(0));
  assert.throws(() => variantNumber("map-00"));
  assert.throws(() => variantNumber("map-21"));
});

test("team assignment is stable for every task and remains inside its frozen pool", () => {
  const teams = Array.from({ length: 200 }, (_item, index) => (
    `tea_${(index + 1).toString(16).padStart(32, "0")}`
  ));
  for (const config of GUANGYANG_CHALLENGE_CONFIGS) {
    const assigned = teams.map(teamId => assignedVariantId(config.taskId, teamId));
    assert.deepEqual(assigned, teams.map(teamId => assignedVariantId(config.taskId, teamId)),
      "the same internal team id must never reroll");
    assigned.forEach(id => {
      assert.ok(variantNumber(id) >= 1);
      assert.ok(variantNumber(id) <= MAP_POOL_COUNTS[config.taskId]);
    });
    assert.ok(new Set(assigned).size >= Math.floor(MAP_POOL_COUNTS[config.taskId] * 0.75),
      "a representative team set should be spread across most variants");
  }
});
