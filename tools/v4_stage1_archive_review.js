#!/usr/bin/env node
"use strict";
// Recompute archive integrity and sensor-boundary evidence. Never writes the
// original acceptance archive or provides its evaluation truth to a robot.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const helper = require("./v4_stage1_acceptance.js");
const VERSION = "wm-v4-stage1-archive-review/v1";
const ROOT = path.resolve(__dirname, "..");
const BASE = path.join(ROOT, "artifacts/inloop/v4/stage-1/acceptance-01");
const PLATFORM = path.join(ROOT, "workspaces/guangyang-platform/projects/car-python");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
function counts(items) {
  const result = {};
  for (const item of items) result[item.category] = (result[item.category] || 0) + 1;
  return result;
}
function main() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 2, "Usage: node tools/v4_stage1_archive_review.js --out <new-json-file>");
  assert.equal(args[0], "--out");
  const output = path.resolve(args[1]);
  assert.equal(fs.existsSync(output), false, "Never overwrite existing evidence");
  const manifest = read(path.join(BASE, "manifest.json"));
  const contract = require(path.join(PLATFORM, "robot-bridge-contract.js"));
  const sourceChecks = Object.entries(manifest.platform).map(([file, expectedSha256]) => {
    const actualSha256 = sha(fs.readFileSync(path.join(PLATFORM, file)));
    return {file, expectedSha256, actualSha256, equal: expectedSha256 === actualSha256};
  });
  const driverSha256 = sha(fs.readFileSync(path.join(ROOT, manifest.driver.file)));
  const brainScriptSha256 = sha(helper.brainScript.toString());
  const trials = [];
  const comparisons = [];
  for (const map of ["map-03", "map-05", "map-10"]) {
    const buffers = [];
    for (let run = 1; run <= 2; run++) {
      const directory = `${map}-run-${run}`;
      const bytes = fs.readFileSync(path.join(BASE, directory, "record.json"));
      buffers.push(bytes);
      const record = JSON.parse(bytes);
      const transcript = read(path.join(BASE, directory, "http-transcript.json"));
      const evaluation = read(path.join(BASE, directory, "evaluation.json"));
      const observations = record.calls.filter(call => call.method === "observe").map(call => {
        const bridge = call.outcome.result;
        const native = record.native.inputs.filter(input => input.type === "vision_query"
          && input.method === "observe" && input.frameId === bridge.frameId);
        assert.equal(native.length, 1, "Every observed frame must have exactly one native query");
        return {frameId: bridge.frameId, tick: bridge.tick,
          nativeInputSeq: native[0].seq, bridgeCallSeq: call.seq,
          nativeQueryCount: native[0].result.length, nativeQueryCategories: counts(native[0].result),
          bridgeDetectionCount: bridge.detections.length, bridgeCategories: counts(bridge.detections),
          nativeNonemptyBridgeEmpty: native[0].result.length > 0 && bridge.detections.length === 0};
      });
      let allowedOutputsWithinSchema = true;
      for (const call of record.calls) {
        if (call.outcome.status !== "returned") continue;
        try { assert.deepEqual(call.outcome.result, contract.sanitizeResponse(call.method, call.outcome.result)); }
        catch (_) { allowedOutputsWithinSchema = false; }
      }
      trials.push({map, run, directory, recordSha256: sha(bytes),
        expectedRecordSha256: evaluation.evidence.recordSha256,
        recordSha256Matches: sha(bytes) === evaluation.evidence.recordSha256,
        recordAudit: helper.auditRecord(record, transcript, manifest.rejectedMethods),
        allowedOutputsWithinSchema,
        deniedMethods: record.bridgeCalls.filter(event => event.type === "rejected").map(event => ({method: event.method, code: event.code, tick: event.tick})),
        scopeChecksPass: evaluation.scopeChecks.every(check => check.status === 403
          && check.body.error.code === "CLIENT_CAPABILITY_SCOPE"), observations});
    }
    comparisons.push({map, byteEqual: buffers[0].equals(buffers[1]),
      firstDifference: helper.firstDifference(JSON.parse(buffers[0]), JSON.parse(buffers[1]))});
  }
  const report = {schema: VERSION, sourceArchive: path.relative(ROOT, BASE),
    reviewer: {file: path.relative(ROOT, __filename), sha256: sha(fs.readFileSync(__filename))},
    originalAcceptanceManifestSha256: sha(fs.readFileSync(path.join(BASE, "manifest.json"))),
    originalDriverMatches: driverSha256 === manifest.driver.sha256,
    originalDriverSha256: driverSha256,
    originalBrainMatches: brainScriptSha256 === manifest.brainScriptSha256,
    originalBrainSha256: brainScriptSha256,
    sourceChecks, comparisons, trials,
    totalObservationFrames: trials.reduce((sum, trial) => sum + trial.observations.length, 0),
    nativeNonemptyBridgeEmptyFrames: trials.reduce((sum, trial) => sum + trial.observations.filter(frame => frame.nativeNonemptyBridgeEmpty).length, 0),
    interpretation: "Record equality and whitelist checks pass, but existing real simulation records already show nonempty native pixel-derived queries discarded by the bridge. This is not evidence of an empty scene. The offline sensor probe isolates the adapter failure. Native storage-zone is an older upright-sign detector and is not interchangeable with the new green ground-region detector.",
    stage1Decision: "blocked-do-not-enter-stage2"};
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", {flag: "wx"});
  console.log(JSON.stringify({out: output, comparisonsEqual: comparisons.filter(row => row.byteEqual).length,
    sourceChecksEqual: sourceChecks.filter(row => row.equal).length,
    observationFrames: report.totalObservationFrames,
    nativeNonemptyBridgeEmptyFrames: report.nativeNonemptyBridgeEmptyFrames}));
  return report;
}
module.exports = {main, VERSION};
if (require.main === module) main();
