"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const pixelCore = require("../vision-pixel-core.js");
const {
  CAMERA_DEFINITION,
  CAMERA_DEFINITION_HASH,
  DETECTOR_DEFINITION,
  DETECTOR_DEFINITION_HASH,
  QUERY_DEFINITION,
  QUERY_DEFINITION_HASH,
  VISION_DEFINITION,
  VISION_DEFINITION_HASH,
  NAVIGATION_CONTROL_DEFINITION,
  GUANGYANG_ISLAND_CONFIG,
  normalizeVisionDefinition,
  normalizeNavigationControlDefinition
} = require("../competition-core.js");
const { canonicalSha256 } = require("../backend/canonical-json.js");

test("competition core exports one deeply frozen virtual-vision contract with canonical hashes", () => {
  assert.deepEqual(CAMERA_DEFINITION, pixelCore.CAMERA_DEFINITION);
  assert.deepEqual(DETECTOR_DEFINITION, pixelCore.DETECTOR_DEFINITION);
  assert.deepEqual(QUERY_DEFINITION, pixelCore.QUERY_DEFINITION);
  assert.deepEqual(VISION_DEFINITION, pixelCore.VISION_DEFINITION);
  assert.equal(CAMERA_DEFINITION_HASH, canonicalSha256(CAMERA_DEFINITION));
  assert.equal(DETECTOR_DEFINITION_HASH, canonicalSha256(DETECTOR_DEFINITION));
  assert.equal(QUERY_DEFINITION_HASH, canonicalSha256(QUERY_DEFINITION));
  assert.equal(VISION_DEFINITION_HASH, canonicalSha256(VISION_DEFINITION));
  assert.deepEqual(normalizeVisionDefinition(JSON.parse(JSON.stringify(VISION_DEFINITION))), VISION_DEFINITION);
  assert.equal(Object.isFrozen(VISION_DEFINITION), true);
  assert.equal(Object.isFrozen(VISION_DEFINITION.cameraDefinition), true);
  assert.equal(VISION_DEFINITION.detectorDefinition.version, "v2");
  assert.equal(JSON.stringify(VISION_DEFINITION).includes("trainingScene"), false);
});

test("the Guangyang server challenge publishes exactly the shared vision definition", () => {
  const { LOCAL_CHALLENGES } = require("../server.js");
  const challenge = LOCAL_CHALLENGES[GUANGYANG_ISLAND_CONFIG.taskId];
  assert.deepEqual(challenge.runDefinition.visionDefinition, VISION_DEFINITION);
  assert.equal(
    canonicalSha256(challenge.runDefinition.visionDefinition),
    VISION_DEFINITION_HASH
  );
  assert.deepEqual(challenge.runDefinition.navigationControlDefinition, NAVIGATION_CONTROL_DEFINITION);
  assert.deepEqual(
    normalizeNavigationControlDefinition(challenge.runDefinition.navigationControlDefinition),
    NAVIGATION_CONTROL_DEFINITION
  );
  assert.equal(challenge.runDefinition.navigationControlDefinition.schemaVersion,
    "chenlong.navigation-control/v8");
});
