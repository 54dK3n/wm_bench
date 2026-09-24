"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runRecoveryRoute } = require("../tools/validate-guangyang-recovery-route.js");

test("the internal Guangyang recovery route loses only avoidance and completes every recoverable objective", () => {
  const result = runRecoveryRoute();
  const task = result.taskState;

  assert.equal(task.completed, 7);
  assert.equal(task.total, 8);
  assert.equal(task.finished, false);
  assert.equal(task.goalReached, true);
  assert.deepEqual(task.visitedCheckpointIds, [
    "checkpoint-ds-lake",
    "checkpoint-egret",
    "checkpoint-rapeseed",
    "checkpoint-camp"
  ]);
  assert.deepEqual([...task.deliveredPackageIds].sort(), [
    "guangyang-distractor-1",
    "guangyang-target-1"
  ]);
  assert.deepEqual(task.avoidanceProgress.requiredObjectIds, ["guangyang-obstacle-1"]);
  assert.deepEqual(task.avoidanceProgress.failedObjectIds, ["guangyang-obstacle-1"]);
  assert.equal(task.avoidanceProgress.completed, 0);
  assert.equal(task.avoidanceProgress.finished, false);

  assert.equal(result.collisions.length, 1);
  assert.equal(result.collisions[0].colliderId, "object:guangyang-obstacle-1");
  assert.deepEqual(
    result.ruleViolations.filter(item => item.type === "collision").map(item => item.colliderId),
    ["object:guangyang-obstacle-1"]
  );
  assert.deepEqual(result.ruleViolations.filter(item => item.type !== "collision"), []);
  assert.ok(result.actions
    .filter(action => action.type === "left_angle" || action.type === "right_angle")
    .every(action => action.degrees >= 1), "all route turns must be accepted by the public Python API");
  for (const action of result.actions.filter(action => action.type === "forward")) {
    assert.ok(Number.isFinite(action.distanceCm) && action.distanceCm >= 0.1 && action.distanceCm <= 500,
      "every generated recovery drive must be a valid one-argument centimeter command");
    assert.ok(Math.abs(action.distanceCm - action.seconds * action.speedPercent / 100 * 2.5
      * 100 / 8) < 1e-9, "centimeter output must preserve the internally validated world displacement");
  }
  assert.equal(result.score.completedTasks, 7);
  assert.equal(result.score.taskFinished, false);
  assert.equal(result.score.taskScore, 35);
  assert.equal(result.score.ruleScore, 23.3);
  assert.equal(result.score.autonomousScore, 15);
});
