"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const scoring = require(path.join(root, "guangyang-scoring.js"));
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("Blockly uses the frozen Guangyang road geometry with the whole vehicle footprint", () => {
  assert.equal(scoring.ROADS.length, 26);
  assert.deepEqual(scoring.roadMatch(-2.4865, -7.6757), {
    onRoad: true,
    roadId: "parking-connector",
    clearance: 0.585
  });
  assert.equal(scoring.roadMatch(0, 0).onRoad, false);
  assert.equal(scoring.roadMatch(-2.4865, -5.4826).onRoad, true, "junctions remain drivable");
});

test("Blockly score weights, off-road deductions and efficiency match the Python challenge", () => {
  assert.deepEqual(
    scoring.scoreRun({ completed: true, checkpointCount: 4, checkpointTotal: 4, taskCompleted: 8, taskTotal: 8, durationMs: 120000 }),
    {
      task: 40, rule: 25, autonomous: 15, efficiency: 20, total: 100,
      ruleDeduction: 0, taskCompleted: 8, taskTotal: 8,
      collisionCount: 0, offRoadEpisodes: 0, offRoadDurationMs: 0
    }
  );
  assert.deepEqual(
    scoring.scoreRun({
      completed: true, checkpointCount: 4, checkpointTotal: 4, taskCompleted: 8, taskTotal: 8,
      collisionCount: 1, offRoadEpisodes: 1, offRoadDurationMs: 2000, durationMs: 120000
    }),
    {
      task: 40, rule: 20, autonomous: 15, efficiency: 20, total: 95,
      ruleDeduction: 5, taskCompleted: 8, taskTotal: 8,
      collisionCount: 1, offRoadEpisodes: 1, offRoadDurationMs: 2000
    }
  );
  const unfinished = scoring.scoreRun({ completed: false, checkpointCount: 2, checkpointTotal: 4, taskCompleted: 2, taskTotal: 8, durationMs: 10000 });
  assert.equal(unfinished.task, 10);
  assert.equal(unfinished.efficiency, 0);
  assert.equal(unfinished.total, 50);
});

test("Blockly composite task units match Python for all three tasks", () => {
  for (const [checkpointTotal, objectTotal, expectedTotal] of [[4, 1, 8], [6, 2, 13], [8, 3, 18]]) {
    const finished = scoring.compositeTaskProgress({
      checkpointCount: checkpointTotal,
      checkpointTotal,
      targetDeliveredCount: objectTotal,
      targetTotal: objectTotal,
      distractorClearedCount: objectTotal,
      distractorTotal: objectTotal,
      obstacleTotal: objectTotal,
      goalReached: true
    });
    assert.equal(finished.total, expectedTotal);
    assert.equal(finished.completed, expectedTotal);
    assert.equal(finished.finished, true);

    const collided = scoring.compositeTaskProgress({
      ...finished,
      failedObstacleCount: 1
    });
    assert.equal(collided.completed, expectedTotal - 1);
    assert.equal(collided.finished, false);
  }
  assert.ok(scoring.roadEdgeClearance(-15, -9, 0.28) >= 0.2, "an off-road package can clear every road edge");
  assert.ok(scoring.roadEdgeClearance(-2.4865, -5.4826, 0.28) < 0.2, "a package on the road is not cleared");
});

test("every simulated run restores the mission, objects and robot before execution", () => {
  assert.match(appSource, /if \(target === "sim"\) \{[\s\S]*?restoreMissionBaseline\(\);[\s\S]*?resetRobot\(\);[\s\S]*?rebuildSceneObjects\(\);[\s\S]*?initializeMissionAttempt\(\);[\s\S]*?\}\s*const context = createRunContext/);
  assert.doesNotMatch(appSource, /任务已经完成，请点击重置再次挑战/);
  assert.match(appSource, /任务、小车和物品已恢复到起点，开始本次运行/);
});

test("a blocked frame records collision evidence before it can complete the task", () => {
  assert.match(appSource, /const blocked = availableDistance[\s\S]*?if \(blocked\) \{[\s\S]*?primaryBlockedMoveCount\+\+[\s\S]*?failedObstacleIds[\s\S]*?if \(actualDistance > PHYSICS_EPSILON\) \{[\s\S]*?syncRobot/);
});

test("browser and server share one scoring implementation and persist road evidence", () => {
  assert.match(htmlSource, /guangyang-scoring\.js\?v=20260827-002[\s\S]*guangyang-map-config\.js\?v=20260827-001[\s\S]*app\.js\?v=\d{8}-\d{3}/);
  assert.match(serverSource, /require\("\.\/guangyang-scoring\.js"\)/);
  assert.match(appSource, /samplePrimaryRoadRule\(dt\)/);
  assert.match(appSource, /offRoadEpisodes: Math\.min\(99, primaryOffRoadEpisodes\)/);
  assert.match(serverSource, /"offRoadEpisodes", "offRoadDurationMs"/);
  assert.match(serverSource, /compositeTaskProgress/);
  assert.match(appSource, /mapRevision: activeMission\.mapRevision/);
  assert.match(serverSource, /mapVersion\(body\.taskId, body\.mapRevision, body\.mapDigest\)/);
});
