#!/usr/bin/env node
"use strict";
// Offline evaluator: no browser, bridge, model, or network access.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const audit = require("./v4_stage1_content_audit.js");
const {auditRecord, firstDifference} = require("./v4_stage1_acceptance.js");
const ROOT = path.resolve(__dirname, "..");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function main(argv = process.argv.slice(2)) {
  assert.equal(argv.length, 4, "Usage: --input <acceptance-directory> --out <new-json-file>");
  assert.equal(argv[0], "--input"); assert.equal(argv[2], "--out");
  const input = path.resolve(argv[1]), output = path.resolve(argv[3]);
  assert.ok(!fs.existsSync(output), "Never overwrite a report");
  const inputs = [];
  const load = file => { const bytes = fs.readFileSync(file); inputs.push({file: path.relative(ROOT, file), sha256: sha(bytes)}); return JSON.parse(bytes); };
  const original = load(path.join(input, "acceptance.json"));
  const manifest = load(path.join(input, "manifest.json"));
  assert.equal(sha(fs.readFileSync(path.join(ROOT, manifest.evaluator.file))), manifest.evaluator.sha256,
    "Use the evaluator revision recorded by the run");
  const runs = original.trials.map(trial => {
    const directory = path.join(input, trial.directory);
    return {map: trial.map, run: trial.run, directory: path.relative(ROOT, directory),
      captures: load(path.join(directory, "captures.json")), record: load(path.join(directory, "record.json")),
      transcript: load(path.join(directory, "http-transcript.json"))};
  });
  const content = audit.auditSuite({runs});
  const contentExact = firstDifference(content, load(path.join(input, "content-audit.json"))) === null;
  const records = runs.map(run => ({map: run.map, run: run.run,
    ...auditRecord(run.record, run.transcript, manifest.rejectedMethods)}));
  // Rebuild pairs from actual runs; never let a missing saved pair evade the
  // record gate. This is the same first-run-versus-later-runs policy as driver.
  const byMap = new Map();
  for (const run of runs) { if (!byMap.has(run.map)) byMap.set(run.map, []); byMap.get(run.map).push(run); }
  const comparisons = [...byMap.values()].flatMap(group => group.slice(1).map(right => {
    const left = group[0], first = firstDifference(left.record, right.record);
    const a = fs.readFileSync(path.join(ROOT, left.directory, "record.json"));
    const b = fs.readFileSync(path.join(ROOT, right.directory, "record.json"));
    return {map: left.map, left: path.basename(left.directory), right: path.basename(right.directory),
      equalEveryField: first === null, firstDifference: first, byteEqual: a.equals(b)};
  }));
  const comparisonsExact = firstDifference(comparisons.map(({byteEqual, ...pair}) => pair), original.comparisons) === null;
  const execution = original.trials.map((trial, index) => {
    const saved = load(path.join(input, trial.directory, "evaluation.json"));
    const savedTrialExact = firstDifference(saved, trial) === null;
    const recordAuditExact = firstDifference(records[index], {map: trial.map, run: trial.run, ...trial.recordAudit}) === null;
    const allPass = !saved.error && !saved.stopError && !saved.evidenceError && records[index].allPass === true
      && content.runs[index].allPass === true && saved.controllerErrors?.length === 0 && saved.pageErrors?.length === 0;
    return {map: trial.map, run: trial.run, savedTrialExact, recordAuditExact, allPass,
      verdictExact: allPass === trial.allPass, error: saved.error ?? null, stopError: saved.stopError ?? null,
      evidenceError: saved.evidenceError ?? null, controllerErrors: saved.controllerErrors ?? null, pageErrors: saved.pageErrors ?? null};
  });
  // Execution errors and source-integrity checks are recorded observations of
  // the original run, not facts that an offline evaluator can re-run. Include
  // every original driver gate, and expose its input and outcome explicitly.
  const gates = {statusComplete: original.status === "complete",
    expectedTrialCount: original.trials.length === original.maps.length * original.runsPerMap,
    trialsPass: execution.every(row => row.allPass), recordsPaired: comparisons.every(row => row.equalEveryField),
    contentPass: content.allPass === true, driverUnchanged: original.driverUnchanged,
    evaluatorUnchanged: original.evaluatorUnchanged,
    frozenSourcesUnchanged: Object.values(original.frozenSourcesUnchanged).every(Boolean)};
  const allPass = Object.values(gates).every(Boolean);
  const executionExact = execution.every(row => row.savedTrialExact && row.recordAuditExact && row.verdictExact);
  const report = {version: "wm-v4-stage1-recompute/v2", input: path.relative(ROOT, input), inputs,
    contentExact, comparisonsExact, executionExact, matchesOriginalVerdict: allPass === original.allPass, allPass, gates,
    outputCounts: content.outputCounts, truthCounts: content.truthCounts,
    observations: content.runs.reduce((sum, run) => sum + run.observations, 0),
    records, comparisons, execution, contentFailures: content.failures,
    failedObservationCount: content.runs.reduce((sum, run) => sum + run.rows.filter(row => !row.allPass).length, 0)};
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", {flag: "wx"});
  // A faithfully reproduced FAIL is a successful recomputation, not an
  // acceptance PASS. Keep these two decisions explicit in the report.
  process.exitCode = contentExact && comparisonsExact && executionExact && report.matchesOriginalVerdict ? 0 : 1;
  console.log(JSON.stringify({report: path.relative(ROOT, output), contentExact, comparisonsExact, executionExact,
    matchesOriginalVerdict: report.matchesOriginalVerdict, acceptancePass: allPass}));
  return report;
}
module.exports = {main};
if (require.main === module) main();
