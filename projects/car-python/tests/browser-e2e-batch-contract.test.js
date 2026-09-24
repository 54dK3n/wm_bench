"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const toolSource = fs.readFileSync(path.join(root, "tools", "browser-e2e.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("package exposes the isolated real-Chrome five-slot smoke mode", () => {
  assert.equal(packageJson.scripts["test:e2e:batch"], "node tools/browser-e2e.js --batch-smoke");
  assert.match(toolSource, /const BATCH_SMOKE_MODE = process\.argv\.includes\("--batch-smoke"\)/);
  assert.match(toolSource, /if \(BATCH_SMOKE_MODE\) \{[\s\S]*runBatchEvaluationSmoke/);
});

test("batch smoke source is short and independent of private layout coordinates", () => {
  const declaration = /const BATCH_SMOKE_SOURCE = \[([\s\S]*?)\]\.join\("\\n"\);/.exec(toolSource)?.[1] || "";
  assert.match(declaration, /robot\.odometry\(\)/);
  assert.doesNotMatch(
    declaration,
    /robot\.(?:forward|backward|left_angle|right_angle|follow_road|take_exit|approach|grab|release)\s*\(/
  );
  assert.doesNotMatch(declaration, /(?:layout|anchor|worldX|worldZ|position|\bx\b|\bz\b)/i);
});

test("batch smoke retains the serial, privacy, final-score, and owner-discovery assertions", () => {
  for (const required of [
    "assertFiveSlotBatchTraffic",
    "assertFiveSlotCdpRequests",
    "assertBatchPublicResponsePrivacy",
    "testLostBatchDiscoveryAndClose",
    "Page.javascriptDialogOpening",
    "INVALID_TEAM_ID",
    "interactionDefinition",
    "70% 均分 + 30% 最低分"
  ]) {
    assert.ok(toolSource.includes(required), `browser E2E batch contract is missing ${required}`);
  }
  assert.match(toolSource, /await page\.click\("#startCompetitionBatchButton"\)/);
  assert.match(toolSource, /\["valid", "valid", "valid", "valid", "valid"\]/);
  assert.match(toolSource, /sessionStorage\.clear\(\)/);
  assert.match(toolSource, /button\[data-action=\\?"close\\?"\]/);
});

