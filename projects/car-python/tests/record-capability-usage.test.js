"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CAPABILITY_USAGE_SCHEMA_VERSION,
  deriveRecordCapabilityUsage,
  validateRecordCapabilityUsage,
  capabilityUsageFromReport
} = require("../backend/record-capability-usage.js");

function trustedReport(overrides = {}) {
  return {
    schemaVersion: "chenlong.verification-report/v1",
    status: "verified",
    record: { schemaVersion: "chenlong.run-record/v4" },
    replay: { verified: true },
    capabilities: {
      navigationQueriesRecomputed: true,
      navigationControlsRecomputed: true,
      visionDetectionsRecomputed: true
    },
    ...overrides
  };
}

test("capability usage is derived only from supported typed input ledger entries", () => {
  const usage = deriveRecordCapabilityUsage({
    sourceCode: [
      "# robot.mission(); robot.task_state(); robot.odometry(); robot.road_state(); robot.map_graph()",
      "text = 'robot.follow_road(100, 40); robot.take_exit(road_id)'"
    ].join("\n"),
    diagnostics: "navigation_query follow_road",
    inputs: [
      { type: "navigation_control", method: "take_exit" },
      { type: "navigation_query", method: "map_graph" },
      { type: "navigation_query", method: "odometry" },
      { type: "navigation_control", method: "follow_road" },
      { type: "navigation_query", method: "road_state" },
      { type: "navigation_query", method: "mission" },
      { type: "navigation_query", method: "task_state" },
      { type: "navigation_query", method: "odometry" },
      { type: "vision_query", method: "road_state" },
      { type: "vision_query", method: "observe" },
      { type: "vision_query", method: "approach" },
      { type: "navigation_query", method: "forged_sensor" },
      { type: "navigation_control", method: "forged_control" }
    ]
  });
  assert.deepEqual(usage, {
    schemaVersion: CAPABILITY_USAGE_SCHEMA_VERSION,
    navigationSensorMethods: ["odometry", "road_state", "map_graph", "mission", "task_state"],
    roadControlMethods: ["follow_road", "take_exit"],
    visionMethods: ["approach", "observe"]
  });

  assert.deepEqual(deriveRecordCapabilityUsage({
    sourceCode: "robot.odometry(); robot.follow_road(100, 40)",
    inputs: []
  }), {
    schemaVersion: CAPABILITY_USAGE_SCHEMA_VERSION,
    navigationSensorMethods: [],
    roadControlMethods: [],
    visionMethods: []
  });
});

test("capability report summaries validate exactly and malformed evidence fails closed", () => {
  const valid = {
    schemaVersion: CAPABILITY_USAGE_SCHEMA_VERSION,
    navigationSensorMethods: ["odometry", "map_graph", "mission"],
    roadControlMethods: ["take_exit"],
    visionMethods: ["observe"]
  };
  assert.deepEqual(validateRecordCapabilityUsage(valid), valid);
  assert.deepEqual(validateRecordCapabilityUsage({
    schemaVersion: "chenlong.record-capability-usage/v1",
    navigationSensorMethods: ["odometry"],
    roadControlMethods: ["follow_road"]
  }), {
    schemaVersion: CAPABILITY_USAGE_SCHEMA_VERSION,
    navigationSensorMethods: ["odometry"],
    roadControlMethods: ["follow_road"],
    visionMethods: []
  }, "verified historical summaries remain compatible but cannot claim visual perception");
  for (const malformed of [
    { ...valid, extra: true },
    { ...valid, schemaVersion: "tampered" },
    { ...valid, navigationSensorMethods: ["map_graph", "odometry"] },
    { ...valid, navigationSensorMethods: ["odometry", "odometry"] },
    { ...valid, roadControlMethods: ["forged"] },
    { ...valid, visionMethods: ["forged"] }
  ]) {
    assert.equal(validateRecordCapabilityUsage(malformed), null);
    assert.deepEqual(capabilityUsageFromReport(trustedReport({ actualCapabilityUsage: malformed })), {
      present: true,
      usage: { navigationSensors: false, roadControls: false, vision: false }
    });
  }

  assert.deepEqual(capabilityUsageFromReport(trustedReport({ actualCapabilityUsage: valid })), {
    present: true,
    usage: { navigationSensors: true, roadControls: true, vision: true }
  });
  assert.deepEqual(capabilityUsageFromReport(trustedReport()), {
    present: false,
    usage: null
  }, "only an absent field on an otherwise trusted old report may use record fallback");
  assert.deepEqual(capabilityUsageFromReport(trustedReport({ status: "invalid" })), {
    present: true,
    usage: { navigationSensors: false, roadControls: false, vision: false }
  });
  assert.deepEqual(capabilityUsageFromReport(trustedReport({
    replay: { verified: false },
    actualCapabilityUsage: valid
  })), {
    present: true,
    usage: { navigationSensors: false, roadControls: false, vision: false }
  });
  assert.deepEqual(capabilityUsageFromReport(trustedReport({
    capabilities: {
      navigationQueriesRecomputed: true,
      navigationControlsRecomputed: true,
      visionDetectionsRecomputed: false
    },
    actualCapabilityUsage: valid
  })), {
    present: true,
    usage: { navigationSensors: false, roadControls: false, vision: false }
  }, "a visual marker requires hash-bound pixel recomputation");
});
