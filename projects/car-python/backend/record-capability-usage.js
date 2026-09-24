"use strict";

const CAPABILITY_USAGE_SCHEMA_VERSION = "chenlong.record-capability-usage/v2";
const LEGACY_CAPABILITY_USAGE_SCHEMA_VERSION = "chenlong.record-capability-usage/v1";
const NAVIGATION_SENSOR_METHODS = Object.freeze(["odometry", "road_state", "map_graph", "mission", "task_state", "release_preview"]);
const ROAD_CONTROL_METHODS = Object.freeze(["follow_road", "take_exit"]);
const VISION_METHODS = Object.freeze(["sees", "count", "detect", "near", "centered", "direction", "distance_to", "approach", "observe"]);
const NAVIGATION_SENSOR_METHOD_SET = new Set(NAVIGATION_SENSOR_METHODS);
const ROAD_CONTROL_METHOD_SET = new Set(ROAD_CONTROL_METHODS);
const VISION_METHOD_SET = new Set(VISION_METHODS);
const LEGACY_CAPABILITY_USAGE_KEYS = Object.freeze([
  "schemaVersion",
  "navigationSensorMethods",
  "roadControlMethods"
]);
const CAPABILITY_USAGE_KEYS = Object.freeze([
  ...LEGACY_CAPABILITY_USAGE_KEYS,
  "visionMethods"
]);

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function orderedMethods(found, supported) {
  return supported.filter(method => found.has(method));
}

// This deliberately inspects only typed ledger entries. Source code, comments,
// string literals, diagnostics, and other free-form text are never considered.
// The caller is responsible for establishing that the run record was replayed
// successfully before treating this summary as trusted evidence.
function deriveRecordCapabilityUsage(record) {
  const navigationSensors = new Set();
  const roadControls = new Set();
  const vision = new Set();
  if (Array.isArray(record?.inputs)) {
    for (const input of record.inputs) {
      if (!input || typeof input !== "object" || Array.isArray(input)) continue;
      if (input.type === "navigation_query" && NAVIGATION_SENSOR_METHOD_SET.has(input.method)) {
        navigationSensors.add(input.method);
      } else if (input.type === "navigation_control" && ROAD_CONTROL_METHOD_SET.has(input.method)) {
        roadControls.add(input.method);
      } else if (input.type === "vision_query" && VISION_METHOD_SET.has(input.method)) {
        vision.add(input.method);
      }
    }
  }
  return {
    schemaVersion: CAPABILITY_USAGE_SCHEMA_VERSION,
    navigationSensorMethods: orderedMethods(navigationSensors, NAVIGATION_SENSOR_METHODS),
    roadControlMethods: orderedMethods(roadControls, ROAD_CONTROL_METHODS),
    visionMethods: orderedMethods(vision, VISION_METHODS)
  };
}

function validateRecordCapabilityUsage(value) {
  const legacy = value?.schemaVersion === LEGACY_CAPABILITY_USAGE_SCHEMA_VERSION;
  if (!hasExactKeys(value, legacy ? LEGACY_CAPABILITY_USAGE_KEYS : CAPABILITY_USAGE_KEYS)
    || (value.schemaVersion !== CAPABILITY_USAGE_SCHEMA_VERSION && !legacy)
    || !Array.isArray(value.navigationSensorMethods)
    || !Array.isArray(value.roadControlMethods)
    || (!legacy && !Array.isArray(value.visionMethods))) return null;
  const expectedSensors = orderedMethods(new Set(value.navigationSensorMethods), NAVIGATION_SENSOR_METHODS);
  const expectedControls = orderedMethods(new Set(value.roadControlMethods), ROAD_CONTROL_METHODS);
  const suppliedVision = legacy ? [] : value.visionMethods;
  const expectedVision = orderedMethods(new Set(suppliedVision), VISION_METHODS);
  if (expectedSensors.length !== value.navigationSensorMethods.length
    || expectedControls.length !== value.roadControlMethods.length
    || expectedVision.length !== suppliedVision.length
    || expectedSensors.some((method, index) => method !== value.navigationSensorMethods[index])
    || expectedControls.some((method, index) => method !== value.roadControlMethods[index])
    || expectedVision.some((method, index) => method !== suppliedVision[index])) return null;
  return {
    schemaVersion: CAPABILITY_USAGE_SCHEMA_VERSION,
    navigationSensorMethods: expectedSensors,
    roadControlMethods: expectedControls,
    visionMethods: expectedVision
  };
}

function emptyAdminCapabilityUsage() {
  return { navigationSensors: false, roadControls: false, vision: false };
}

function adminCapabilityUsage(value) {
  const usage = validateRecordCapabilityUsage(value);
  if (!usage) return emptyAdminCapabilityUsage();
  return {
    navigationSensors: usage.navigationSensorMethods.length > 0,
    roadControls: usage.roadControlMethods.length > 0,
    vision: usage.visionMethods.length > 0
  };
}

function reportAllowsCapabilityUsage(report) {
  return report?.schemaVersion === "chenlong.verification-report/v1"
    && ["verified", "partial"].includes(report.status)
    && report.record?.schemaVersion === "chenlong.run-record/v4"
    && report.replay?.verified === true
    && report.capabilities?.navigationQueriesRecomputed === true
    && report.capabilities?.navigationControlsRecomputed === true;
}

function capabilityUsageFromReport(report) {
  if (!reportAllowsCapabilityUsage(report)) {
    return { present: true, usage: emptyAdminCapabilityUsage() };
  }
  if (!Object.prototype.hasOwnProperty.call(report, "actualCapabilityUsage")) {
    return { present: false, usage: null };
  }
  const validated = validateRecordCapabilityUsage(report.actualCapabilityUsage);
  // v2 adds visual-perception evidence. Do not display that new marker from
  // a report unless its recorded frames were actually recomputed. v1 cannot
  // claim visual use, so it remains compatible with verified historical runs.
  if (validated?.visionMethods.length
    && report.capabilities?.visionDetectionsRecomputed !== true) {
    return { present: true, usage: emptyAdminCapabilityUsage() };
  }
  return {
    present: true,
    usage: validated ? adminCapabilityUsage(validated) : emptyAdminCapabilityUsage()
  };
}

module.exports = {
  CAPABILITY_USAGE_SCHEMA_VERSION,
  NAVIGATION_SENSOR_METHODS,
  ROAD_CONTROL_METHODS,
  VISION_METHODS,
  deriveRecordCapabilityUsage,
  validateRecordCapabilityUsage,
  emptyAdminCapabilityUsage,
  adminCapabilityUsage,
  reportAllowsCapabilityUsage,
  capabilityUsageFromReport
};
