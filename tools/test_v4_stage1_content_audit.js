"use strict";

const assert = require("node:assert/strict");
const {test} = require("node:test");
const {projectRawDetections, letterboxProjection, cameraGeometry, auditCapture,
  auditRun, compareRuns, auditSuite, expectedCheckpoint} = require("./v4_stage1_content_audit.js");
const copy = value => JSON.parse(JSON.stringify(value));
const hash = "a".repeat(64);
const raw = [
  {category: "target", source: "virtual-cv", confidence: 0.9373214, box: {x: 10, y: 70, width: 40, height: 60}},
  {category: "distractor", source: "virtual-cv", confidence: 0.82997, box: {x: 120, y: 200, width: 30, height: 20}},
  {category: "obstacle", source: "virtual-cv", confidence: 0.79999, box: {x: 625, y: 545, width: 40, height: 25}},
  {category: "storage-zone", source: "virtual-cv", confidence: 0.8, box: {x: 230, y: 250, width: 20, height: 90}},
  {category: "cleanup-zone", source: "virtual-cv", confidence: 0.8, box: {x: 310, y: 250, width: 20, height: 90}}
];
const storage = [{category: "storage-zone", source: "storage-ground-pixels", confidence: 1,
  bbox: {x: 230, y: 250, w: 150, h: 60}, pixelCount: 6000}];
const knownProjected = [
  {category: "red-ball", source: "virtual-cv", confidence: 0.9373214, bbox: {x: 10, y: 0, w: 40, h: 50}},
  {category: "blue-ball", source: "virtual-cv", confidence: 0.82997, bbox: {x: 120, y: 120, w: 30, h: 20}},
  {category: "obstacle", source: "virtual-cv", confidence: 0.79999, bbox: {x: 625, y: 465, w: 15, h: 15}},
  {category: "storage-zone", source: "storage-ground-pixels", confidence: 1, bbox: {x: 230, y: 250, w: 150, h: 60}}
];
function capture(index = 0, tick = 0) {
  const params = {category: null, confidence: 0};
  return {requestId: `command-${index}`, frameId: index + 1, tick, params,
    rawDetections: copy(raw), storageDetections: copy(storage), robotDetections: copy(knownProjected),
    bridgeObservation: {frameId: index + 1, tick, width: 640, height: 480, detections: copy(knownProjected)},
    rgbaSha256: hash, cameraPose: {matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 1], worldUnitsToCm: 12.5},
    truthObjects: [
      {id: "red-1", category: "red-ball", centerWorld: [0, 0.22, -4], active: true},
      {id: "blue-1", category: "blue-ball", centerWorld: [0, 0.22, -5], active: true},
      {id: "obstacle-1", category: "obstacle", centerWorld: [0, 0.25, -6], active: true}],
    simulationStepMs: 20, simulationElapsedMs: tick * 20,
    checkpointSignals: [expectedCheckpoint({index: 0, phase: 0}, tick * 20 / 1000),
      expectedCheckpoint({index: 1, phase: 1.7}, tick * 20 / 1000)]};
}
function run(map = "map-03", ordinal = 1) {
  const captures = [capture(0, 0), capture(1, 0), capture(2, 100)];
  return {map, run: ordinal, directory: `${map}/run-${ordinal}`, captures,
    record: {calls: captures.map(c => ({method: "observe", args: copy(c.params), started: {tick: c.tick}, finished: {tick: c.tick},
      outcome: {result: copy(c.bridgeObservation)}}))},
    transcript: captures.map(c => ({request: {requestId: c.requestId, method: "observe", params: copy(c.params)},
      submission: {status: 202}, terminal: {status: "completed", result: copy(c.bridgeObservation)}}))};
}
function suite() { return {runs: ["map-03", "map-05", "map-10"].flatMap(map => [run(map, 1), run(map, 2)])}; }

test("independent fixed letterbox projection preserves counts, exact confidence and source; signs explicitly excluded", () => {
  const source = copy(raw), result = projectRawDetections(source, storage);
  assert.deepEqual(result.expected, knownProjected);
  assert.deepEqual(source, raw);
  assert.equal(result.exclusions.length, 2);
  assert.ok(result.exclusions.every(row => row.excluded_with_reason === "upright_sign_is_not_ground_storage_region"));
  assert.equal(result.mappings[0].rawConfidence, 0.9373214);
});

test("YOLO color appearance takes precedence; arbitrary taught sources do not become detector evidence", () => {
  const items = [
    {...raw[0], source: "yolo", category: "obstacle", colorClass: "red"},
    {...raw[0], source: "yolo", category: "sports ball", colorClass: "blue"},
    {...raw[0], source: "yolo", category: "obstacle"},
    {...raw[0], source: "template", category: "target"}];
  const result = projectRawDetections(items, []);
  assert.deepEqual(result.expected.map(row => [row.category, row.source]), [["red-ball", "yolo"], ["blue-ball", "yolo"], ["obstacle", "yolo"]]);
  assert.equal(result.exclusions[0].excluded_with_reason, "not_a_supported_raw_pixel_detector_source");
});

test("projection clipping is exact and cannot create zero-area boxes", () => {
  assert.deepEqual(letterboxProjection({x: -2, y: 78, width: 7, height: 7}), {x: 0, y: 0, w: 5, h: 5});
  assert.equal(letterboxProjection({x: 700, y: 80, width: 10, height: 10}), null);
  assert.equal(letterboxProjection({x: 0, y: 20, width: 10, height: 10}), null);
  assert.throws(() => letterboxProjection({x: 0, y: 0, width: 0, height: 10}), /empty/);
});

test("filter is applied after complete independent projection with unchanged equality threshold", () => {
  assert.deepEqual(projectRawDetections(raw, storage, {category: "blue-ball", confidence: 0.82997}).expected, [knownProjected[1]]);
  assert.deepEqual(projectRawDetections(raw, storage, {category: "blue-ball", confidence: 0.82997001}).expected, []);
  assert.throws(() => projectRawDetections(raw, storage, {truth: true}), /unknown/);
});

test("canonical counts and every bridge field are checked independently", () => {
  assert.equal(auditCapture(capture()).allPass, true);
  for (const mutate of [
    c => c.bridgeObservation.detections.splice(0, 1),
    c => { c.bridgeObservation.detections[0].category = "blue-ball"; },
    c => { c.bridgeObservation.detections[0].bbox.y++; },
    c => { c.bridgeObservation.detections[0].confidence = 0.94; },
    c => { c.bridgeObservation.detections[0].source = "yolo"; },
    c => { c.bridgeObservation.detections[0].distanceCm = 50; },
    c => { c.robotDetections[0].confidence = 0.94; },
    c => { c.bridgeObservation.frameId++; }
  ]) { const value = capture(); mutate(value); assert.equal(auditCapture(value).allPass, false); }
});

test("old all-filtered adapter cannot pass from valid frame metadata", () => {
  const value = capture(); value.bridgeObservation.detections = [copy(knownProjected[3])];
  const report = auditCapture(value);
  assert.equal(report.allPass, false);
  assert.equal(report.failures.filter(row => row.code === "EXPECTED_CLASS_MISSING").length, 3);
  assert.ok(report.failures.some(row => row.code === "BRIDGE_CONTENT_MISMATCH"));
});

test("camera range uses actual camera origin and horizontal axes, not robot origin", () => {
  const value = capture(); value.cameraPose.matrixWorld[12] = 1; value.cameraPose.matrixWorld[14] = 2;
  assert.deepEqual(cameraGeometry(value.cameraPose, [1, 0, -2]), {cameraWorld: [1, 0.5, 2], forwardCm: 50,
    rightCm: 0, rangeCm: 50, bearingDeg: 0});
});

test("fixed inclusive range/bearing eligibility and inactive/behind exclusions", () => {
  const value = capture();
  value.truthObjects = [
    {id: "min", category: "red-ball", centerWorld: [0, 0, -2.4], active: true},
    {id: "max", category: "red-ball", centerWorld: [0, 0, -6.8], active: true},
    {id: "close", category: "red-ball", centerWorld: [0, 0, -2.399], active: true},
    {id: "far", category: "red-ball", centerWorld: [0, 0, -6.801], active: true},
    {id: "off-axis", category: "red-ball", centerWorld: [3, 0, -4], active: true},
    {id: "behind", category: "red-ball", centerWorld: [0, 0, 4], active: true},
    {id: "held", category: "red-ball", centerWorld: [0, 0, -4], active: false}];
  const report = auditCapture(value);
  assert.equal(report.allPass, true);
  assert.deepEqual(report.truth.rows.filter(row => row.eligible).map(row => row.id), ["min", "max"]);
  assert.deepEqual(report.truth.counts["red-ball"], {expected: 2, detected: 2, misses: 0});
});

test("class-presence audit never adds an unrequested bbox-center or instance recall gate", () => {
  const value = capture(); value.truthObjects.push({...value.truthObjects[0], id: "red-2"});
  const report = auditCapture(value);
  assert.equal(report.allPass, true); // deliberately unrelated fixture boxes
  assert.equal(report.truth.counts["red-ball"].detected, 2);
  assert.deepEqual(report.truth.ambiguousInstanceCounts, [{category: "red-ball", eligibleObjects: 2,
    bridgeDetections: 1, explanation: "category present; individual-object recall cannot be established"}]);
});

test("C-ENV-001 checks phase and every render animation output, including wall-time corruption", () => {
  assert.equal(auditCapture(capture(2, 321)).checkpoint.allPass, true);
  for (const field of ["phase", "ringRotationZ", "ringOpacity", "beamOpacity", "coreY", "coreRotationY"]) {
    const value = capture(2, 321); value.checkpointSignals[0][field] += 0.0000001;
    assert.equal(auditCapture(value).allPass, false, field);
  }
  const value = capture(); value.simulationElapsedMs = 1;
  assert.equal(auditCapture(value).allPass, false);
});

test("record and HTTP bindings cover every observe and refuse reused/dropped evidence", () => {
  assert.equal(auditRun(run()).allPass, true);
  for (const mutate of [
    r => r.captures.pop(),
    r => { r.captures[1].requestId = r.captures[0].requestId; },
    r => { r.captures[1].frameId = r.captures[0].frameId; },
    r => { r.record.calls[0].outcome.result.detections[0].confidence = 0; },
    r => { r.transcript[0].request.requestId = "wrong"; },
    r => { r.record.calls[0].finished.tick = 1; },
    r => { r.directory = "/private/artifacts"; },
    r => { delete r.transcript; }
  ]) { const value = run(); mutate(value); assert.equal(auditRun(value).allPass, false); }
});

test("each observe RGBA hash and checkpoint state are compared between runs", () => {
  const left = run(), right = run("map-03", 2);
  assert.equal(compareRuns(left, right).allPass, true);
  right.captures[1].rgbaSha256 = "b".repeat(64);
  const report = compareRuns(left, right);
  assert.equal(report.allPass, false);
  assert.equal(report.failures[0].code, "PAIRED_RGBA_MISMATCH");
  right.captures[1].rgbaSha256 = hash; right.captures[2].checkpointSignals[0].phase++;
  assert.equal(compareRuns(left, right).allPass, false);
});

test("same tick cannot hide pixel changes behind identical detections", () => {
  const value = run(); value.captures[1].rgbaSha256 = "b".repeat(64);
  assert.ok(auditRun(value).failures.some(row => row.code === "C-ENV-001_STATIONARY_FRAME_CHANGED"));
});

test("complete six-run fixture passes with reproducible totals and relative report paths", () => {
  const report = auditSuite(suite());
  assert.equal(report.allPass, true);
  assert.equal(report.comparisons.length, 3);
  assert.deepEqual(report.outputCounts, {"red-ball": 18, "blue-ball": 18, obstacle: 18, "storage-zone": 18});
  assert.deepEqual(report.truthCounts["red-ball"], {expected: 18, detected: 18, misses: 0});
  assert.equal(report.checkpoint.stationaryPairs.length, 6);
  assert.equal(report.checkpoint.signalSamples, 36);
});

test("zero class totals and absent checkpoint evidence fail; zero eligible truth is explicitly unverified", () => {
  const value = suite();
  for (const trial of value.runs) for (const c of trial.captures) {
    c.bridgeObservation.detections = []; c.rawDetections = []; c.storageDetections = []; c.robotDetections = [];
    c.truthObjects = []; c.checkpointSignals = [];
  }
  const report = auditSuite(value);
  assert.equal(report.allPass, false);
  assert.equal(report.failures.filter(row => row.code === "ZERO_CLASS_OUTPUT").length, 4);
  assert.deepEqual(Object.values(report.truthCoverage), Array(3).fill("not_verified_no_eligible_objects"));
  assert.ok(report.failures.some(row => row.code === "C-ENV-001_NO_CHECKPOINT_SIGNALS"));
  assert.equal(auditSuite({runs: [run()]}).allPass, false);
});

test("no eligible truth adds no invented acceptance threshold", () => {
  const value = suite();
  for (const trial of value.runs) for (const c of trial.captures) c.truthObjects = [];
  const report = auditSuite(value);
  assert.equal(report.allPass, true);
  assert.deepEqual(Object.values(report.truthCoverage), Array(3).fill("not_verified_no_eligible_objects"));
});

test("malformed evidence yields explicit failures and does not invent sensor data", () => {
  const value = capture(); delete value.rgbaSha256; value.rawDetections[0].confidence = NaN;
  const report = auditCapture(value);
  assert.equal(report.allPass, false);
  assert.ok(report.failures.some(row => row.code === "CAPTURE_SCHEMA"));
  assert.ok(report.failures.some(row => row.code === "RAW_PROJECTION"));
});
