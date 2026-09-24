#!/usr/bin/env node
"use strict";

// Internal negative/recovery route. It intentionally hits the single required
// Guangyang avoidance object, then recovers to finish both deliveries, all four
// checkpoints and the return objective. It is never bundled into the browser.

const { runRecoveryRoute } = require("./validate-guangyang-safe-route.js");

function compactAction(action) {
  if (action.type === "forward") {
    return `robot.forward(${action.distanceCm.toFixed(4)})  # ${action.label}`;
  }
  if (action.type === "left_angle" || action.type === "right_angle") {
    return `robot.${action.type}(${action.degrees.toFixed(2)})  # ${action.label}`;
  }
  return `robot.${action.type}()  # ${action.label}`;
}

if (require.main === module) {
  const result = runRecoveryRoute();
  console.log(JSON.stringify({
    completed: `${result.taskState.completed}/${result.taskState.total}`,
    finished: result.taskState.finished,
    visitedCheckpointIds: result.taskState.visitedCheckpointIds,
    deliveredPackageIds: result.taskState.deliveredPackageIds,
    avoidanceProgress: result.taskState.avoidanceProgress,
    goalReached: result.taskState.goalReached,
    durationSeconds: result.durationSeconds,
    collisionCount: result.collisions.length,
    collisions: result.collisions,
    ruleViolations: result.ruleViolations,
    score: result.score,
    finalPose: result.finalPose,
    actions: result.actions.map(compactAction)
  }, null, 2));
}

module.exports = { runRecoveryRoute };
