"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runRoute } = require("../tools/validate-guangyang-safe-route.js");

test("the internal Guangyang acceptance route completes all eight units without rule or collision violations", () => {
  const result = runRoute();

  assert.equal(result.taskState.completed, 8);
  assert.equal(result.taskState.total, 8);
  assert.equal(result.taskState.finished, true);
  assert.equal(result.taskState.goalReached, true);
  assert.equal(result.taskState.avoidanceProgress.completed, 1);
  assert.deepEqual(result.taskState.avoidanceProgress.failedObjectIds, []);
  assert.equal(result.collisions.length, 0);
  assert.deepEqual(result.ruleViolations, []);
  assert.ok(result.durationSeconds < 180, "the conservative no-violation route should remain efficient");
  assert.ok(result.actions
    .filter(action => action.type === "left_angle" || action.type === "right_angle")
    .every(action => action.degrees >= 1), "all route turns must be accepted by the public Python API");
  for (const action of result.actions.filter(action => action.type === "forward")) {
    assert.ok(Number.isFinite(action.distanceCm) && action.distanceCm >= 0.1 && action.distanceCm <= 500,
      "every generated drive must be a valid one-argument centimeter command");
    assert.ok(Math.abs(action.distanceCm - action.seconds * action.speedPercent / 100 * 2.5
      * 100 / 8) < 1e-9, "centimeter output must preserve the internally validated world displacement");
  }
  assert.equal(result.score.ruleScore, 25);
  assert.ok(result.score.score >= 98.8, "the off-road removal route should retain at least 98.8 / 100 points");
  assert.equal(result.offroadRemoval.clearance.outsideRoads, true);
});
