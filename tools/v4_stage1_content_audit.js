"use strict";

// Evaluation only. No platform implementation is imported and none of these
// truth-bearing structures may be passed to the robot client or planner.
const {isDeepStrictEqual} = require("node:util");

const VERSION = "wm-v4-stage1-content-audit/v1";
const CATEGORIES = Object.freeze(["red-ball", "blue-ball", "obstacle", "storage-zone"]);
const TRUTH_CATEGORIES = Object.freeze(CATEGORIES.slice(0, 3));
const APPEARANCE = Object.freeze({target: "red-ball", distractor: "blue-ball", obstacle: "obstacle"});
const RULES = Object.freeze({
  projection: "640x640 detector letterbox -> 640x480 source; scale=1,padX=0,padY=80; clip to source bounds",
  virtualAppearance: APPEARANCE,
  realAppearance: "yolo: red/blue colorClass takes precedence, otherwise category obstacle",
  storage: "independent source-camera ground pixels; old upright storage/cleanup signs excluded",
  equality: "exact ordered detections, category, bbox, confidence and unchanged source; no tolerance or rounding",
  expected: "active true red/blue/obstacle, camera planar range inclusive 30..85 cm and abs(horizontal bearing)<=30 degrees",
  detected: "for each eligible truth object, at least one bridge detection of its category in that frame",
  instanceLimitation: "Class presence is not instance recall. One output may witness multiple eligible same-class objects; those frames are explicitly listed.",
  coverage: "across the complete suite each of four output classes must have a nonzero count; a truth class with no eligible objects is explicitly not verified, without an additional gate",
  checkpoints: "C-ENV-001: exact camera-render checkpoint fields recomputed with time=tick*stepMs/1000; paired fields and RGBA hashes equal"
});

function demand(condition, message) { if (!condition) throw new Error(message); }
function object(value, label) {
  demand(value !== null && typeof value === "object" && !Array.isArray(value), `${label}: object required`);
}
function finite(value, label) { demand(typeof value === "number" && Number.isFinite(value), `${label}: finite number required`); }
function integer(value, label) { demand(Number.isSafeInteger(value) && value >= 0, `${label}: nonnegative integer required`); }
function exactKeys(value, keys, label) {
  object(value, label);
  demand(isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()), `${label}: unexpected or missing fields`);
}
function confidence(value, label) { finite(value, label); demand(value >= 0 && value <= 1, `${label}: out of range`); }
function emptyCounts() { return Object.fromEntries(CATEGORIES.map(category => [category, 0])); }
function truthCounts() { return Object.fromEntries(TRUTH_CATEGORIES.map(category => [category, {expected: 0, detected: 0, misses: 0}])); }
function increment(counts, items) { for (const item of items) if (Object.hasOwn(counts, item?.category)) counts[item.category]++; }
function difference(left, right, pointer = "") {
  if (Object.is(left, right)) return null;
  if (!left || !right || typeof left !== "object" || typeof right !== "object"
      || Array.isArray(left) !== Array.isArray(right)) return {path: pointer || "/", left, right};
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const key of keys) {
    const here = `${pointer}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return {path: here, reason: "missing_field",
      leftPresent: Object.hasOwn(left, key), rightPresent: Object.hasOwn(right, key)};
    const result = difference(left[key], right[key], here);
    if (result) return result;
  }
  return null;
}

function sourceBox(box, label) {
  exactKeys(box, ["x", "y", "w", "h"], label);
  for (const key of ["x", "y", "w", "h"]) finite(box[key], `${label}.${key}`);
  demand(box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0
    && box.x + box.w <= 640 && box.y + box.h <= 480, `${label}: invalid source bounds`);
  return {...box};
}

function letterboxProjection(box) {
  object(box, "raw.box");
  for (const key of ["x", "y", "width", "height"]) finite(box[key], `raw.box.${key}`);
  demand(box.width > 0 && box.height > 0, "raw.box: empty extent");
  const x = Math.max(0, box.x), y = Math.max(0, box.y - 80);
  const right = Math.min(640, box.x + box.width), bottom = Math.min(480, box.y + box.height - 80);
  return right > x && bottom > y ? {x, y, w: right - x, h: bottom - y} : null;
}

function validateParams(params) {
  object(params, "params");
  demand(Object.keys(params).every(key => ["category", "confidence"].includes(key)), "params: unknown field");
  demand(params.category === undefined || params.category === null || CATEGORIES.includes(params.category), "params.category: invalid");
  if (params.confidence !== undefined) confidence(params.confidence, "params.confidence");
}

// Independent oracle: never use robotDetections or the bridge projection helper
// as the expected answer. Raw source identity is carried without relabeling.
function projectRawDetections(rawDetections, storageDetections, params = {}) {
  demand(Array.isArray(rawDetections), "rawDetections: array required");
  demand(Array.isArray(storageDetections), "storageDetections: array required");
  validateParams(params);
  const canonical = [], exclusions = [], mappings = [];
  rawDetections.forEach((item, rawIndex) => {
    object(item, `rawDetections[${rawIndex}]`);
    demand(typeof item.source === "string" && item.source.length > 0, `rawDetections[${rawIndex}].source missing`);
    let category = null, reason = null;
    if (item.source === "virtual-cv") {
      category = APPEARANCE[item.category] || null;
      reason = ["storage-zone", "cleanup-zone"].includes(item.category)
        ? "upright_sign_is_not_ground_storage_region" : "unmapped_virtual_pixel_class";
    } else if (item.source === "yolo") {
      category = item.colorClass === "red" ? "red-ball" : item.colorClass === "blue" ? "blue-ball"
        : item.category === "obstacle" ? "obstacle" : null;
      reason = "no_supported_appearance_class";
    } else reason = "not_a_supported_raw_pixel_detector_source";
    if (!category) { exclusions.push({rawIndex, source: item.source, category: item.category ?? null, excluded_with_reason: reason}); return; }
    confidence(item.confidence, `rawDetections[${rawIndex}].confidence`);
    const bbox = letterboxProjection(item.box);
    if (!bbox) { exclusions.push({rawIndex, source: item.source, category: item.category, excluded_with_reason: "bbox_outside_source_frame"}); return; }
    const projected = {category, confidence: item.confidence, bbox, source: item.source};
    mappings.push({origin: "rawDetections", rawIndex, rawCategory: item.category, rawSource: item.source,
      rawBox: {...item.box}, rawConfidence: item.confidence, projectedIndex: canonical.length, projected});
    canonical.push(projected);
  });
  storageDetections.forEach((item, rawIndex) => {
    object(item, `storageDetections[${rawIndex}]`);
    demand(item.category === "storage-zone", "ground detector returned non-storage class");
    demand(item.source === "storage-ground-pixels", "ground detector source changed or missing");
    confidence(item.confidence, `storageDetections[${rawIndex}].confidence`);
    const bbox = sourceBox(item.bbox, `storageDetections[${rawIndex}].bbox`);
    const projected = {category: item.category, confidence: item.confidence, bbox, source: item.source};
    mappings.push({origin: "storageDetections", rawIndex, rawCategory: item.category, rawSource: item.source,
      rawBox: {...item.bbox}, rawConfidence: item.confidence, projectedIndex: canonical.length, projected});
    canonical.push(projected);
  });
  const expected = canonical.filter(item => (!params.category || item.category === params.category)
    && item.confidence >= (params.confidence ?? 0));
  return {canonical, expected, exclusions, mappings};
}

function validateObservation(observation, frameId, tick) {
  exactKeys(observation, ["frameId", "tick", "width", "height", "detections"], "bridgeObservation");
  demand(observation.frameId === frameId && observation.tick === tick, "bridge/capture frameId or tick mismatch");
  demand(observation.width === 640 && observation.height === 480, "bridge frame dimensions changed");
  demand(Array.isArray(observation.detections), "bridge detections missing");
  observation.detections.forEach((item, index) => {
    exactKeys(item, ["category", "confidence", "bbox", "source"], `bridge detection ${index}`);
    demand(CATEGORIES.includes(item.category), "bridge category outside whitelist");
    confidence(item.confidence, `bridge detection ${index}.confidence`);
    sourceBox(item.bbox, `bridge detection ${index}.bbox`);
    demand(["virtual-cv", "yolo", "storage-ground-pixels"].includes(item.source), "bridge source outside whitelist");
  });
}

function cameraGeometry(cameraPose, centerWorld) {
  object(cameraPose, "cameraPose");
  demand(Array.isArray(cameraPose.matrixWorld) && cameraPose.matrixWorld.length === 16, "cameraPose.matrixWorld: 16 entries required");
  cameraPose.matrixWorld.forEach((value, index) => finite(value, `cameraPose.matrixWorld[${index}]`));
  demand(cameraPose.worldUnitsToCm === 12.5, "camera world-unit calibration changed");
  demand(Array.isArray(centerWorld) && centerWorld.length === 3, "truth centerWorld: xyz required");
  centerWorld.forEach((value, index) => finite(value, `centerWorld[${index}]`));
  const m = cameraPose.matrixWorld;
  const forwardNorm = Math.hypot(m[8], m[10]), rightNorm = Math.hypot(m[0], m[2]);
  demand(forwardNorm > 0 && rightNorm > 0, "camera planar axes degenerate");
  const dx = centerWorld[0] - m[12], dz = centerWorld[2] - m[14];
  const forwardCm = -(dx * m[8] + dz * m[10]) / forwardNorm * 12.5;
  const rightCm = (dx * m[0] + dz * m[2]) / rightNorm * 12.5;
  return {cameraWorld: [m[12], m[13], m[14]], forwardCm, rightCm,
    rangeCm: Math.hypot(forwardCm, rightCm), bearingDeg: Math.atan2(rightCm, forwardCm) * 180 / Math.PI};
}

function auditTruth(capture) {
  demand(Array.isArray(capture.truthObjects), "truthObjects: array required");
  const counts = truthCounts(), rows = [], seenIds = new Set();
  const outputCounts = emptyCounts(); increment(outputCounts, capture.bridgeObservation.detections);
  for (const item of capture.truthObjects) {
    object(item, "truth object");
    demand(typeof item.id === "string" && item.id.length > 0 && !seenIds.has(item.id), "truth object id missing or duplicated");
    seenIds.add(item.id);
    demand(TRUTH_CATEGORIES.includes(item.category), "truth object unsupported category");
    demand(typeof item.active === "boolean", "truth object active flag missing");
    const geometry = cameraGeometry(capture.cameraPose, item.centerWorld);
    const eligible = item.active && geometry.rangeCm >= 30 && geometry.rangeCm <= 85 && Math.abs(geometry.bearingDeg) <= 30;
    const detected = eligible ? outputCounts[item.category] > 0 : null;
    if (eligible) { counts[item.category].expected++; counts[item.category][detected ? "detected" : "misses"]++; }
    rows.push({id: item.id, category: item.category, active: item.active, centerWorld: [...item.centerWorld], ...geometry,
      eligible, detected, classOnlyEvidence: true, matchingBridgeIndices: capture.bridgeObservation.detections
        .map((detection, index) => detection.category === item.category ? index : null).filter(index => index !== null)});
  }
  const ambiguousInstanceCounts = TRUTH_CATEGORIES.filter(category => counts[category].expected > 1
    && outputCounts[category] > 0 && outputCounts[category] < counts[category].expected)
    .map(category => ({category, eligibleObjects: counts[category].expected, bridgeDetections: outputCounts[category],
      explanation: "category present; individual-object recall cannot be established"}));
  return {counts, rows, ambiguousInstanceCounts};
}

function expectedCheckpoint(signal, time) {
  const wave = (Math.sin(time * 2.4 + signal.phase) + 1) / 2;
  return {index: signal.index, phase: signal.index * 1.7,
    ringRotationZ: time * 0.55 + signal.phase, ringOpacity: 0.56 + wave * 0.34,
    beamOpacity: 0.045 + wave * 0.075, coreY: 0.36 + wave * 0.12,
    coreRotationY: time * 1.2 + signal.phase};
}

function auditCheckpoint(capture) {
  finite(capture.simulationStepMs, "simulationStepMs");
  demand(capture.simulationStepMs > 0, "simulationStepMs must be positive");
  demand(capture.simulationElapsedMs === capture.tick * capture.simulationStepMs, "checkpoint elapsed time is not tick*stepMs");
  demand(Array.isArray(capture.checkpointSignals), "checkpointSignals: array required");
  const time = capture.simulationElapsedMs / 1000, seen = new Set();
  const rows = capture.checkpointSignals.map(signal => {
    exactKeys(signal, ["index", "phase", "ringRotationZ", "ringOpacity", "beamOpacity", "coreY", "coreRotationY"], "checkpoint signal");
    integer(signal.index, "checkpoint index");
    demand(!seen.has(signal.index), "duplicate checkpoint index"); seen.add(signal.index);
    for (const key of Object.keys(signal)) finite(signal[key], `checkpoint.${key}`);
    const expected = expectedCheckpoint(signal, time), firstDifference = difference(expected, signal);
    return {index: signal.index, expected, actual: {...signal}, exactMatch: firstDifference === null, firstDifference};
  });
  return {caseId: "C-ENV-001", tick: capture.tick, simulationElapsedMs: capture.simulationElapsedMs,
    timeSeconds: time, rows, allPass: rows.every(row => row.exactMatch)};
}

function auditCapture(capture) {
  const failures = [], result = {frameId: capture?.frameId ?? null, tick: capture?.tick ?? null,
    requestId: capture?.requestId ?? null, outputCounts: emptyCounts(), failures};
  const attempt = (code, operation) => { try { return operation(); } catch (error) { failures.push({code, message: error.message}); return null; } };
  const valid = attempt("CAPTURE_SCHEMA", () => {
    object(capture, "capture"); integer(capture.frameId, "frameId"); integer(capture.tick, "tick");
    demand(typeof capture.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(capture.requestId), "requestId missing or invalid");
    demand(typeof capture.rgbaSha256 === "string" && /^[a-f0-9]{64}$/.test(capture.rgbaSha256), "RGBA SHA256 missing or invalid");
    validateObservation(capture.bridgeObservation, capture.frameId, capture.tick); return true;
  });
  result.projection = attempt("RAW_PROJECTION", () => projectRawDetections(capture.rawDetections, capture.storageDetections, capture.params));
  if (valid) {
    increment(result.outputCounts, capture.bridgeObservation.detections);
    if (result.projection) {
      result.bridgeDifference = difference(result.projection.expected, capture.bridgeObservation.detections);
      if (result.bridgeDifference) failures.push({code: "BRIDGE_CONTENT_MISMATCH", firstDifference: result.bridgeDifference});
      if (capture.robotDetections !== undefined && !isDeepStrictEqual(capture.robotDetections, result.projection.canonical)) {
        failures.push({code: "CANONICAL_CONTENT_MISMATCH", firstDifference: difference(result.projection.canonical, capture.robotDetections)});
      }
    }
    result.truth = attempt("TRUTH_SCHEMA", () => auditTruth(capture));
    if (result.truth) for (const row of result.truth.rows) if (row.eligible && !row.detected) {
      failures.push({code: "EXPECTED_CLASS_MISSING", id: row.id, category: row.category, rangeCm: row.rangeCm, bearingDeg: row.bearingDeg});
    }
  }
  result.checkpoint = attempt("CHECKPOINT_SCHEMA", () => auditCheckpoint(capture));
  if (result.checkpoint && !result.checkpoint.allPass) failures.push({code: "C-ENV-001_PHASE_MISMATCH"});
  result.allPass = failures.length === 0;
  return result;
}

function auditRun(run) {
  const failures = [], captures = Array.isArray(run?.captures) ? run.captures : [];
  const check = (condition, code, details = {}) => { if (!condition) failures.push({code, ...details}); };
  check(captures.length > 0, "NO_OBSERVATIONS");
  check(typeof run?.directory === "string" && run.directory.length > 0 && !/^(?:\/|[A-Za-z]:)/.test(run.directory)
    && !run.directory.split(/[\\/]/).includes(".."), "REPORT_DIRECTORY_NOT_RELATIVE");
  const rows = captures.map(auditCapture), outputCounts = emptyCounts(), counts = truthCounts();
  for (const row of rows) {
    for (const category of CATEGORIES) outputCounts[category] += row.outputCounts[category];
    for (const category of TRUTH_CATEGORIES) for (const key of ["expected", "detected", "misses"]) {
      counts[category][key] += row.truth?.counts[category][key] || 0;
    }
  }
  check(new Set(captures.map(item => item.requestId)).size === captures.length, "DUPLICATE_CAPTURE_REQUEST");
  check(new Set(captures.map(item => item.frameId)).size === captures.length, "DUPLICATE_CAPTURE_FRAME");
  const calls = Array.isArray(run?.record?.calls) ? run.record.calls.filter(call => call.method === "observe") : [];
  const transcript = Array.isArray(run?.transcript) ? run.transcript.filter(entry => entry.request?.method === "observe"
    && entry.submission?.status < 400) : [];
  check(Array.isArray(run?.record?.calls), "RECORD_CALLS_MISSING");
  check(Array.isArray(run?.transcript), "HTTP_TRANSCRIPT_MISSING");
  check(calls.length === captures.length, "RECORD_OBSERVE_COVERAGE", {recordObserves: calls.length, captures: captures.length});
  check(transcript.length === captures.length, "HTTP_OBSERVE_COVERAGE", {httpObserves: transcript.length, captures: captures.length});
  captures.forEach((capture, index) => {
    const call = calls[index], entry = transcript[index];
    check(isDeepStrictEqual(call?.outcome?.result, capture.bridgeObservation)
      && isDeepStrictEqual(call?.args, capture.params), "RECORD_CAPTURE_BINDING", {index});
    check(entry?.request?.requestId === capture.requestId && isDeepStrictEqual(entry?.request?.params, capture.params)
      && isDeepStrictEqual(entry?.terminal?.result, capture.bridgeObservation), "HTTP_CAPTURE_BINDING", {index});
    check(call?.started?.tick === capture.tick && call?.finished?.tick === capture.tick, "OBSERVE_TICK_BINDING", {index});
  });
  const checkpointRows = rows.flatMap(row => row.checkpoint?.rows || []);
  const tickGroups = new Map();
  captures.forEach((capture, index) => { if (!tickGroups.has(capture.tick)) tickGroups.set(capture.tick, []); tickGroups.get(capture.tick).push(index); });
  const stationaryPairs = [];
  for (const [tick, indices] of tickGroups) for (let index = 1; index < indices.length; index++) {
    const left = captures[indices[0]], right = captures[indices[index]];
    // Same tick alone need not mean same pose in malformed evidence; retain the
    // camera matrix as part of the stationary-frame witness.
    if (isDeepStrictEqual(left.cameraPose, right.cameraPose)) {
      const equal = left.rgbaSha256 === right.rgbaSha256 && isDeepStrictEqual(left.checkpointSignals, right.checkpointSignals);
      stationaryPairs.push({tick, leftRequestId: left.requestId, rightRequestId: right.requestId, equal});
      check(equal, "C-ENV-001_STATIONARY_FRAME_CHANGED", {tick, leftRequestId: left.requestId, rightRequestId: right.requestId});
    }
  }
  return {schema: VERSION, map: run?.map ?? null, run: run?.run ?? null, directory: run?.directory ?? null,
    observations: captures.length, outputCounts, truthCounts: counts, rows, failures,
    checkpoint: {caseId: "C-ENV-001", signalSamples: checkpointRows.length, distinctTicks: tickGroups.size, stationaryPairs},
    allPass: failures.length === 0 && rows.every(row => row.allPass)};
}

function compareRuns(left, right) {
  const failures = [], leftCaptures = left?.captures || [], rightCaptures = right?.captures || [];
  if (leftCaptures.length !== rightCaptures.length || leftCaptures.length === 0) failures.push({code: "PAIR_OBSERVATION_COUNT"});
  const rows = Array.from({length: Math.max(leftCaptures.length, rightCaptures.length)}, (_, index) => {
    const a = leftCaptures[index], b = rightCaptures[index], row = {index, leftRequestId: a?.requestId ?? null, rightRequestId: b?.requestId ?? null};
    for (const field of ["requestId", "frameId", "tick", "rgbaSha256", "checkpointSignals", "simulationStepMs", "simulationElapsedMs"]) {
      const equal = a !== undefined && b !== undefined && Object.hasOwn(a, field) && Object.hasOwn(b, field)
        && isDeepStrictEqual(a[field], b[field]);
      row[`${field}Equal`] = equal;
      if (!equal) failures.push({code: field === "rgbaSha256" ? "PAIRED_RGBA_MISMATCH" : "PAIRED_CAPTURE_MISMATCH", index, field,
        left: a?.[field] ?? null, right: b?.[field] ?? null});
    }
    row.leftRgbaSha256 = a?.rgbaSha256 ?? null; row.rightRgbaSha256 = b?.rgbaSha256 ?? null;
    return row;
  });
  return {map: left?.map ?? null, left: left?.directory ?? null, right: right?.directory ?? null,
    observations: rows.length, rows, failures, allPass: failures.length === 0};
}

function auditSuite({runs}) {
  demand(Array.isArray(runs), "runs: array required");
  const reports = runs.map(auditRun), failures = [], outputCounts = emptyCounts(), counts = truthCounts();
  for (const report of reports) {
    for (const category of CATEGORIES) outputCounts[category] += report.outputCounts[category];
    for (const category of TRUTH_CATEGORIES) for (const key of ["expected", "detected", "misses"]) counts[category][key] += report.truthCounts[category][key];
  }
  for (const category of CATEGORIES) if (outputCounts[category] === 0) failures.push({code: "ZERO_CLASS_OUTPUT", category});
  const truthCoverage = Object.fromEntries(TRUTH_CATEGORIES.map(category => [category,
    counts[category].expected === 0 ? "not_verified_no_eligible_objects" : "observed_eligible_objects"]));
  const byMap = new Map();
  for (const run of runs) { if (!byMap.has(run.map)) byMap.set(run.map, []); byMap.get(run.map).push(run); }
  if (byMap.size !== 3 || [...byMap.values()].some(group => group.length !== 2)) failures.push({code: "REQUIRES_THREE_LAYOUTS_TWO_RUNS"});
  const comparisons = [...byMap.values()].filter(group => group.length >= 2).flatMap(group => group.slice(1).map(run => compareRuns(group[0], run)));
  const checkpoint = {caseId: "C-ENV-001", signalSamples: reports.reduce((sum, row) => sum + row.checkpoint.signalSamples, 0),
    runsWithTickProgress: reports.filter(row => row.checkpoint.distinctTicks >= 2).length,
    stationaryPairs: reports.flatMap(row => row.checkpoint.stationaryPairs.map(pair => ({map: row.map, run: row.run, ...pair})))};
  if (checkpoint.signalSamples === 0) failures.push({code: "C-ENV-001_NO_CHECKPOINT_SIGNALS"});
  if (reports.length && checkpoint.runsWithTickProgress !== reports.length) failures.push({code: "C-ENV-001_NO_TICK_PROGRESS"});
  if (reports.some(row => row.checkpoint.stationaryPairs.length === 0)) failures.push({code: "C-ENV-001_NO_STATIONARY_REPEAT"});
  return {schema: VERSION, evaluationOnly: true, rules: RULES, outputCounts, truthCounts: counts, truthCoverage,
    runs: reports, comparisons, checkpoint, failures,
    allPass: failures.length === 0 && reports.every(row => row.allPass) && comparisons.every(row => row.allPass)};
}

module.exports = {VERSION, CATEGORIES, TRUTH_CATEGORIES, RULES, difference, letterboxProjection,
  projectRawDetections, cameraGeometry, auditTruth, expectedCheckpoint, auditCheckpoint,
  auditCapture, auditRun, compareRuns, auditSuite};
