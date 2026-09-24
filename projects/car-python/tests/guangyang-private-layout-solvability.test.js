"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const CompetitionCore = require("../competition-core.js");
const {
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION,
  GUANGYANG_RANKED_LAYOUT_FORM_V2,
  createGuangyangInteractionDefinition
} = require("../backend/guangyang-private-layout-catalog.js");
const {
  REPORT_SCHEMA_VERSION,
  publicReport,
  runPrivateLayoutRoute,
  validateAllPrivateLayoutRoutes
} = require("../tools/validate-guangyang-private-layout-solvability.js");

const ROOT = path.resolve(__dirname, "..");
let cachedValidation = null;

function validation() {
  cachedValidation ||= validateAllPrivateLayoutRoutes(GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2);
  return cachedValidation;
}

test("all 198 frozen v2 Guangyang layouts have a complete no-violation task/v5 reference route", () => {
  const accepted = validation();
  assert.equal(accepted.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(accepted.status, "ok");
  assert.equal(accepted.catalogVersion, GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION);
  assert.equal(accepted.layoutCount, GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2.layouts.length);
  assert.equal(accepted.layoutCount, 198);
  assert.equal(accepted.completedUnitsPerLayout, "8/8");
  assert.equal(accepted.zeroCollisionLayouts, 198);
  assert.equal(accepted.zeroViolationLayouts, 198);
  assert.ok(accepted.maximumDurationSeconds < 600);
  assert.ok(accepted.minimumScore >= 95.7);

  for (const result of accepted.results) {
    const expectedInteraction = createGuangyangInteractionDefinition(result.layoutId, {
      catalog: GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2
    });
    assert.deepEqual(result.interactionDefinition, expectedInteraction,
      `${result.layoutId} uses the catalog interaction definition without substitutions`);
    assert.equal(result.taskDefinition.schemaVersion, CompetitionCore.ROAD_CLEARANCE_TASK_SCHEMA_VERSION);
    assert.equal(result.taskDefinition.id, CompetitionCore.GUANGYANG_ISLAND_CONFIG.taskId);
    assert.equal(result.taskDefinition.version, CompetitionCore.GUANGYANG_ISLAND_CONFIG.taskVersion);
    assert.deepEqual(result.taskDefinition.placementGeometry.roads,
      CompetitionCore.GUANGYANG_ISLAND_CONFIG.rules.roads.map(road => ({
        id: road.id,
        width: road.width,
        points: road.points
      })));

    assert.equal(result.taskState.completed, 8);
    assert.equal(result.taskState.total, 8);
    assert.equal(result.taskState.finished, true);
    assert.equal(result.taskState.goalReached, true);
    assert.deepEqual(result.taskState.visitedCheckpointIds,
      CompetitionCore.GUANGYANG_ISLAND_CONFIG.checkpoints.map(item => item.id));
    assert.deepEqual([...result.taskState.deliveredPackageIds].sort(), [
      "guangyang-distractor-1", "guangyang-target-1"
    ]);
    assert.equal(result.taskState.avoidanceProgress.completed, 1);
    assert.deepEqual(result.taskState.avoidanceProgress.failedObjectIds, []);
    assert.deepEqual(result.collisions, []);
    assert.deepEqual(result.ruleViolations, []);
    assert.ok(result.durationSeconds < 600);
    assert.ok(Math.hypot(
      result.finalPose.x - CompetitionCore.GUANGYANG_ISLAND_CONFIG.goal[0],
      result.finalPose.z - CompetitionCore.GUANGYANG_ISLAND_CONFIG.goal[1]
    ) <= result.taskDefinition.goalRadius);

    const distractorDelivery = result.taskDefinition.deliveries
      .find(item => item.objectRole === "distractor");
    assert.equal(distractorDelivery.placementRule, "road-edge-clearance");
    assert.equal(result.offroadRemoval.clearance.outsideRoads, true);
    assert.ok(result.offroadRemoval.clearance.clearance + 1e-7
      >= distractorDelivery.minimumRoadEdgeClearance);
    assert.equal(CompetitionCore.geometry.nearestRoad(
      [result.offroadRemoval.releasePose.x, result.offroadRemoval.releasePose.z],
      CompetitionCore.GUANGYANG_ISLAND_CONFIG.roads,
      CompetitionCore.GUANGYANG_ISLAND_CONFIG.rules.vehicleRadius
    ).onRoad, true, "the car stays fully on a road while removing the distractor");

    assert.equal(result.score.taskFinished, true);
    assert.equal(result.score.completedTasks, 8);
    assert.equal(result.score.ruleScore, 25);
    assert.equal(result.score.autonomousScore, 15);
    assert.ok(result.score.score >= 95.7);
    assert.ok(result.actions.some(action => action.type === "grab"));
    assert.ok(result.actions.some(action => action.type === "release"));
    result.actions.forEach(action => {
      if (action.type === "forward") {
        assert.ok(action.seconds > 0 && action.seconds <= 500);
        assert.ok(action.speedPercent >= 10 && action.speedPercent <= 100);
      } else if (action.type === "left_angle" || action.type === "right_angle") {
        assert.ok(action.degrees >= 1 && action.degrees <= 360);
      } else {
        assert.ok(action.type === "grab" || action.type === "release");
      }
    });
  }
});

test("the private reference planner is deterministic across the five ranked difficulty strata", () => {
  const first = validation();
  const rankedResults = first.results.filter(result => (
    GUANGYANG_RANKED_LAYOUT_FORM_V2.includes(result.layoutId)
  ));
  assert.equal(rankedResults.length, 5);
  for (const expected of rankedResults) {
    const repeated = runPrivateLayoutRoute(expected.layoutId, {
      catalog: GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2
    });
    const actionProjection = result => result.actions.map(action => ({
      type: action.type,
      seconds: action.seconds,
      speedPercent: action.speedPercent,
      degrees: action.degrees,
      packageId: action.packageId,
      endPose: action.endPose,
      interactionPose: action.pose,
      outcomePosition: action.outcome?.position
    }));
    assert.deepEqual(actionProjection(repeated), actionProjection(expected),
      `${expected.layoutId} generates the same public action sequence`);
    assert.equal(repeated.durationSeconds, expected.durationSeconds);
    assert.equal(repeated.distanceMeters, expected.distanceMeters);
    assert.deepEqual(repeated.finalPose, expected.finalPose);
    assert.deepEqual(repeated.packageState, expected.packageState);
    assert.deepEqual(repeated.taskState, expected.taskState);
    assert.deepEqual(repeated.score, expected.score);
  }
});

test("solvability report exposes aggregate v2 acceptance only, never private routes or coordinates", () => {
  const report = publicReport(validation());
  assert.deepEqual(Object.keys(report), [
    "schemaVersion", "status", "catalogVersion", "layoutCount",
    "enumeratedAnchorAssignments", "strictRejectedAssignments",
    "rankedFormLayoutCount", "practicePoolLayoutCount", "completedUnitsPerLayout",
    "maximumDurationSeconds", "minimumScore", "zeroCollisionLayouts",
    "zeroViolationLayouts", "distributions", "checks", "privacy"
  ]);
  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(report.status, "ok");
  assert.equal(report.catalogVersion, GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION);
  assert.equal(report.layoutCount, 198);
  assert.equal(report.enumeratedAnchorAssignments, 216);
  assert.equal(report.strictRejectedAssignments, 18);
  assert.equal(report.rankedFormLayoutCount, 5);
  assert.equal(report.practicePoolLayoutCount, 193);
  assert.equal(report.completedUnitsPerLayout, "8/8");
  assert.equal(report.zeroCollisionLayouts, 198);
  assert.equal(report.zeroViolationLayouts, 198);
  assert.ok(report.maximumDurationSeconds < 600);
  assert.ok(report.minimumScore >= 95.7);
  assert.deepEqual(report.distributions, {
    durationSeconds: {
      min: 95.98, p10: 118.33, p25: 132.315, p50: 151.29,
      p75: 172.135, p90: 186.332, max: 223.04
    },
    score: { min: 95.7, p10: 97.2, p25: 97.8, p50: 98.7, p75: 99.5, p90: 100, max: 100 },
    distanceMeters: {
      min: 62.595, p10: 77.804, p25: 88.537, p50: 101.76,
      p75: 117.6, p90: 127.869, max: 153.675
    },
    actionCount: { min: 43, p10: 46.4, p25: 49, p50: 55, p75: 60, p90: 65, max: 77 }
  });
  assert.deepEqual(report.checks, {
    frozenExpandedCatalog: true,
    rankedPracticeDisjoint: true,
    realTaskV5: true,
    realInteractionAndRules: true,
    publicActionRanges: true,
    orderedCheckpointsAndReturn: true,
    targetStored: true,
    distractorBeyondEveryRoadEdge: true,
    specifiedObstacleAvoided: true,
    underCompetitionTimeLimit: true
  });
  const serialized = JSON.stringify(report);
  for (const forbidden of [
    "results", "actions", "interactionDefinition", "taskDefinition", "layoutId",
    "anchorId", "sourcePosition", "releasePose", "packagePosition", "finalPose"
  ]) {
    assert.equal(serialized.includes(forbidden), false, `aggregate report omits ${forbidden}`);
  }
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2.layouts.forEach(layout => {
    assert.equal(serialized.includes(layout.id), false);
  });
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2.anchors.forEach(anchor => {
    assert.equal(serialized.includes(anchor.id), false);
  });
});

test("private full-coordinate planner is absent from every browser-delivered static asset", () => {
  const browserStaticFiles = [
    "index.html", "styles.css", "app.js", "competition-core.js", "python-worker.js",
    "vision.js", "vision-pixel-core.js", "auth.js", "auth-guard.js", "records.js", "admin.js"
  ];
  const staticSource = browserStaticFiles
    .map(file => fs.readFileSync(path.join(ROOT, file), "utf8"))
    .join("\n");
  assert.equal(staticSource.includes("validate-guangyang-private-layout-solvability"), false);
  assert.equal(staticSource.includes(REPORT_SCHEMA_VERSION), false);
});
