"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  ftruncateSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  SCHEMA_VERSION,
  DETERMINISTIC_LEGACY_SCHEMA_VERSION,
  LEGACY_SCHEMA_VERSION,
  INTERACTION_SCHEMA_VERSION,
  VISION_EVIDENCE_SCHEMA_VERSION
} = require("../competition-core.js");
const {
  MAX_RECORD_BYTES,
  MAX_REPORT_BYTES,
  REPORT_SCHEMA_VERSION,
  serializeReport
} = require("../tools/verify-run-record.js");

const CLI_PATH = path.resolve(__dirname, "../tools/verify-run-record.js");
const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function simulationDefinition() {
  return {
    schemaVersion: "chenlong.simulation/v1",
    stepMs: 20,
    seed: 0x12345678,
    initialPose: { x: 0, z: 0, heading: -Math.PI / 2 },
    vehicle: {
      version: "chenlong.vehicle/v1",
      radius: 0.2,
      collisionSkin: 0.01,
      maxLinearSpeed: 2,
      maxAngularSpeed: 4
    },
    world: {
      bounds: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 },
      colliders: []
    }
  };
}

function ruleDefinition() {
  return {
    vehicleRadius: 0.2,
    roads: [{ id: "wide-road", width: 4, points: [[-2, 0], [2, 0]] }],
    trafficLights: [],
    speedZones: [],
    prohibitedZones: []
  };
}

function idleSample(seq, tick = 0, extras = {}) {
  return {
    seq,
    tick,
    t: tick * 20,
    x: 0,
    z: 0,
    heading: -Math.PI / 2,
    speed: 0,
    steering: 0,
    holding: null,
    cameraFrameId: null,
    ...extras
  };
}

function verifiedV4Record() {
  const simulation = simulationDefinition();
  const interaction = {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    bounds: clone(simulation.world.bounds),
    packageRadius: 0.2,
    grab: { minForward: 0.1, maxForward: 1.2, maxLateral: 0.25, maxDistance: 1.2 },
    release: { forwardOffset: 1, lateralOffset: 0, stackSnapDistance: 0.1 },
    packages: [{ id: "box-a", role: "target", x: 0.8, z: 0, stackLevel: 0 }]
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: "cli-v4-verified",
    runDefinition: {
      simulationDefinition: simulation,
      interactionDefinition: interaction,
      taskDefinition: {
        id: "cli-delivery",
        version: "1",
        type: "delivery",
        goal: [1, 0],
        deliveryRadius: 0.05,
        requiredPackageIds: ["box-a"]
      },
      ruleDefinition: ruleDefinition(),
      scoringDefinition: {
        efficiency: { targetSeconds: 1, maxSeconds: 2 },
        autonomous: { penaltyPerIntervention: 3 }
      },
      timeLimitTicks: 11
    },
    randomSeed: simulation.seed,
    simulationEndTick: 10,
    inputs: [
      { seq: 3, t: 0, tick: 0, type: "package_grab", intent: {}, stateRevision: 1 },
      { seq: 5, t: 200, tick: 10, type: "package_release", intent: {}, stateRevision: 2 }
    ],
    visionFrames: [],
    samples: [idleSample(2), idleSample(7, 10)],
    events: [
      { seq: 1, t: 0, type: "run_started" },
      {
        seq: 4,
        t: 0,
        type: "package_grabbed",
        interactionType: "package_grab",
        accepted: true,
        reason: "grabbed",
        packageId: "box-a",
        objectRole: "target",
        position: [0.8, 0],
        stackLevel: 0
      },
      {
        seq: 6,
        t: 200,
        type: "package_released",
        interactionType: "package_release",
        accepted: true,
        reason: "released",
        packageId: "box-a",
        objectRole: "target",
        position: [1, 0],
        stackLevel: 0
      },
      { seq: 8, t: 200, type: "package_delivered", packageId: "box-a" },
      { seq: 9, t: 200, type: "task_completed", completed: 1, total: 1 },
      { seq: 10, t: 200, type: "run_finished", reason: "completed", score: 60 }
    ],
    result: {
      score: 60,
      taskScore: 25,
      ruleScore: 15,
      autonomousScore: 10,
      efficiencyScore: 10,
      ruleDeduction: 0,
      eventDeduction: 0,
      durationDeduction: 0,
      durationSeconds: 0.2,
      completedTasks: 1,
      totalTasks: 1,
      taskValid: true,
      taskFinished: true,
      reason: "completed",
      simulationTick: 10
    }
  };
}

function verifiedV4RecordWithVisionQuery() {
  const record = verifiedV4Record();
  const bytes = Buffer.from(ONE_PIXEL_PNG_BASE64, "base64");
  const shiftSequence = item => {
    if (item.seq >= 3) item.seq += 2;
  };
  record.runId = "cli-v4-vision-strip-gap";
  record.sourceCode = 'robot.observe("目标物")';
  record.inputs.forEach(shiftSequence);
  record.samples.forEach(shiftSequence);
  record.events.forEach(shiftSequence);
  record.samples[0].cameraFrameId = "frame-1";
  record.visionFrames = [{
    schemaVersion: VISION_EVIDENCE_SCHEMA_VERSION,
    seq: 3,
    t: 0,
    evidenceId: "evidence-1",
    frameId: "frame-1",
    tick: 0,
    stateRevision: 0,
    mimeType: "image/png",
    width: 1,
    height: 1,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    pngBase64: ONE_PIXEL_PNG_BASE64
  }];
  record.inputs.unshift({
    seq: 4,
    t: 0,
    tick: 0,
    type: "vision_query",
    method: "observe",
    args: ["目标物"],
    result: [],
    frameId: "frame-1",
    evidenceId: "evidence-1"
  });
  return record;
}

function deterministicV3Record() {
  const simulation = simulationDefinition();
  return {
    schemaVersion: DETERMINISTIC_LEGACY_SCHEMA_VERSION,
    runId: "cli-v3-partial",
    simulationDefinition: simulation,
    randomSeed: simulation.seed,
    taskDefinition: { id: "v3-reach", type: "reach", goal: [0, 0], goalRadius: 0.1 },
    ruleDefinition: ruleDefinition(),
    scoringDefinition: {},
    inputs: [],
    samples: [idleSample(1)],
    events: [],
    result: {}
  };
}

function telemetryV2Record() {
  return {
    schemaVersion: LEGACY_SCHEMA_VERSION,
    runId: "cli-v2-partial",
    samples: [
      { seq: 1, t: 0, x: 0, z: 0, heading: 0, speed: 0, steering: 0 },
      { seq: 2, t: 100, x: 0, z: -0.1, heading: 0, speed: 1, steering: 0 }
    ],
    events: [],
    result: { score: 10, reason: "program_finished" }
  };
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    input: options.input,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  });
}

function parseSingleReport(result, expectedExitCode) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.equal(result.status, expectedExitCode, result.stderr || result.stdout);
  assert.equal(result.stderr, "", "the machine-readable CLI must keep stderr empty");
  const text = result.stdout.trim();
  assert.notEqual(text, "");
  let report;
  assert.doesNotThrow(() => { report = JSON.parse(text); }, `stdout was not one JSON document: ${text}`);
  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(report.authoritative, false);
  return report;
}

function writeFixture(t, name, contents) {
  const directory = mkdtempSync(path.join(tmpdir(), "chenlong-run-verifier-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, name);
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

test("verify-run-record accepts a fully recomputable v4 file and emits one non-authoritative JSON report", t => {
  const file = writeFixture(t, "verified-v4.json", verifiedV4Record());
  const report = parseSingleReport(runCli([file]), 0);

  assert.equal(report.status, "verified");
  assert.equal(report.source, file);
  assert.equal(report.record.schemaVersion, SCHEMA_VERSION);
  assert.equal(report.replay.verified, true);
  assert.equal(report.capabilities.scoreRecomputed, true);
  assert.equal(report.capabilities.deterministicRecomputationComplete, true);
  assert.equal(report.capabilities.recomputationComplete, true);
  assert.equal(report.visionStatus, "not_used");
  assert.deepEqual(report.verificationScope, {
    deterministic: {
      status: "complete",
      domains: [
        "control_inputs", "navigation_sensors", "navigation_controls",
        "physics", "interactions", "task", "rules", "score"
      ]
    },
    vision: "not_used"
  });
  assert.deepEqual(report.resultComparison, {
    recordedPresent: true,
    complete: true,
    matched: true,
    mismatchCount: 0
  });
  assert.equal(report.recomputedResult.score, 60);
});

test("a recomputable v4 with a missing or incomplete recorded result stays partial", () => {
  const cases = [
    [null, false, "recorded_result_missing"],
    [{}, true, "recorded_result_incomplete"],
    [{ score: 60 }, true, "recorded_result_incomplete"]
  ];

  for (const [recordedResult, recordedPresent, reasonCode] of cases) {
    const record = verifiedV4Record();
    record.result = recordedResult;
    const report = parseSingleReport(runCli(["-"], { input: JSON.stringify(record) }), 2);

    assert.equal(report.status, "partial");
    assert.equal(report.replay.verified, true);
    assert.equal(report.capabilities.deterministicRecomputationComplete, true);
    assert.equal(report.capabilities.recomputationComplete, true);
    assert.equal(report.capabilities.scoreRecomputed, true);
    assert.deepEqual(report.resultComparison, {
      recordedPresent,
      complete: false,
      matched: null,
      mismatchCount: 0
    });
    assert.ok(report.reasonCodes.includes(reasonCode));
  }
});

test("semantic vision v4 is verified for deterministic scope while disclosing the vision limitation", () => {
  const input = JSON.stringify(verifiedV4RecordWithVisionQuery());
  const regular = parseSingleReport(runCli(["-"], { input }), 0);
  const allowed = parseSingleReport(runCli(["--allow-partial", "-"], { input }), 0);

  for (const report of [regular, allowed]) {
    assert.equal(report.status, "verified");
    assert.equal(report.source, "-");
    assert.equal(report.replay.verified, true);
    assert.equal(report.capabilities.visionEvidenceVerified, true);
    assert.equal(report.capabilities.visionDetectionsRecomputed, false);
    assert.equal(report.capabilities.deterministicRecomputationComplete, true);
    assert.equal(report.capabilities.recomputationComplete, false);
    assert.equal(report.visionStatus, "not_recomputed");
    assert.equal(report.verificationScope.deterministic.status, "complete");
    assert.equal(report.verificationScope.vision, "not_recomputed");
    assert.deepEqual(report.reasonCodes, ["vision_detections_not_recomputed"]);
  }
  assert.deepEqual(allowed, regular, "--allow-partial must not weaken or rewrite the verification report");
});

test("stripping an honest vision ledger cannot upgrade the deterministic verification status", () => {
  const record = verifiedV4RecordWithVisionQuery();
  const withVision = parseSingleReport(runCli(["-"], { input: JSON.stringify(record) }), 0);
  assert.equal(withVision.status, "verified");
  assert.equal(withVision.replay.verified, true);
  assert.equal(withVision.resultComparison.complete, true);
  assert.equal(withVision.resultComparison.matched, true);
  assert.equal(withVision.capabilities.visionQueryCount, 1);
  assert.equal(withVision.capabilities.deterministicRecomputationComplete, true);
  assert.equal(withVision.capabilities.recomputationComplete, false);
  assert.equal(withVision.visionStatus, "not_recomputed");
  assert.ok(withVision.reasonCodes.includes("vision_detections_not_recomputed"));

  const stripped = clone(record);
  stripped.inputs = stripped.inputs.filter(input => input.type !== "vision_query");
  stripped.visionFrames = [];
  const withoutVision = parseSingleReport(runCli(["-"], { input: JSON.stringify(stripped) }), 0);
  assert.equal(withoutVision.status, "verified");
  assert.equal(withoutVision.replay.verified, true);
  assert.equal(withoutVision.resultComparison.complete, true);
  assert.equal(withoutVision.resultComparison.matched, true);
  assert.equal(withoutVision.capabilities.visionQueryCount, 0);
  assert.equal(withoutVision.capabilities.deterministicRecomputationComplete, true);
  assert.equal(withoutVision.capabilities.recomputationComplete, true);
  assert.equal(withoutVision.visionStatus, "not_used");
  assert.equal(withoutVision.reasonCodes.includes("vision_detections_not_recomputed"), false);
  assert.match(stripped.sourceCode, /robot\.observe/,
    "source text still mentions vision, but it is not an authenticated execution ledger");

  const renumbered = clone(stripped);
  const timeline = [
    ...renumbered.inputs,
    ...renumbered.visionFrames,
    ...renumbered.samples,
    ...renumbered.events
  ].sort((left, right) => left.seq - right.seq);
  timeline.forEach((item, index) => { item.seq = index + 1; });
  const withoutVisionAndGaps = parseSingleReport(
    runCli(["-"], { input: JSON.stringify(renumbered) }),
    0
  );
  assert.equal(withoutVisionAndGaps.status, "verified",
    "requiring contiguous sequence numbers can catch accidental deletion but not deliberate ledger stripping");
  assert.equal(withoutVisionAndGaps.replay.verified, true);
});

test("valid v3 and v2 records remain explicitly partial", () => {
  for (const record of [deterministicV3Record(), telemetryV2Record()]) {
    const report = parseSingleReport(runCli(["-"], { input: JSON.stringify(record) }), 2);
    assert.equal(report.status, "partial");
    assert.equal(report.record.schemaVersion, record.schemaVersion);
    assert.equal(report.capabilities.recomputationComplete, false);
  }
});

test("a forged v4 sample is invalid even though the score can still be recomputed", t => {
  const tampered = verifiedV4Record();
  tampered.samples.at(-1).x = 1.5;
  const file = writeFixture(t, "tampered-v4.json", tampered);
  const report = parseSingleReport(runCli([file]), 1);

  assert.equal(report.status, "invalid");
  assert.equal(report.replay.verified, false);
  assert.ok(report.replay.mismatchCount > 0);
  assert.equal(report.capabilities.scoreRecomputed, true);
});

test("malformed JSON and non-object roots are input errors with exit code 64", t => {
  const malformed = writeFixture(t, "malformed.json", "{ not-json");
  const malformedReport = parseSingleReport(runCli([malformed]), 64);
  assert.equal(malformedReport.status, "error");
  assert.equal(malformedReport.error.code, "INVALID_JSON");

  const root = parseSingleReport(runCli(["-"], { input: "[]" }), 64);
  assert.equal(root.status, "error");
  assert.equal(root.error.code, "INVALID_ROOT");
});

test("stdin must be strict UTF-8 before JSON parsing", () => {
  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  const report = parseSingleReport(runCli(["-"], { input: invalidUtf8 }), 64);

  assert.equal(report.status, "error");
  assert.equal(report.source, "-");
  assert.equal(report.error.code, "INVALID_UTF8");
});

test("legacy telemetry with decreasing timestamps is invalid rather than partial", () => {
  const record = telemetryV2Record();
  record.samples[1].t = -1;
  const report = parseSingleReport(runCli(["-"], { input: JSON.stringify(record) }), 1);

  assert.equal(report.status, "invalid");
  assert.equal(report.record.schemaVersion, LEGACY_SCHEMA_VERSION);
});

test("missing paths and command-line usage errors return one JSON error and exit code 64", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "chenlong-run-verifier-missing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const missing = path.join(directory, "does-not-exist.json");
  const cases = [
    [runCli([missing]), "READ_FAILED"],
    [runCli([]), "MISSING_INPUT"],
    [runCli(["--not-an-option"]), "UNKNOWN_OPTION"],
    [runCli([missing, missing]), "TOO_MANY_INPUTS"]
  ];

  for (const [result, code] of cases) {
    const report = parseSingleReport(result, 64);
    assert.equal(report.status, "error");
    assert.equal(report.error.code, code);
  }
});

test("a path larger than the bounded input budget is rejected before JSON parsing", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "chenlong-run-verifier-large-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "oversized.json");
  const descriptor = openSync(file, "w");
  try {
    ftruncateSync(descriptor, MAX_RECORD_BYTES + 1);
  } finally {
    closeSync(descriptor);
  }

  const report = parseSingleReport(runCli([file]), 64);
  assert.equal(report.status, "error");
  assert.equal(report.error.code, "INPUT_TOO_LARGE");
});

test("serializeReport bounds oversized diagnostics while preserving one valid JSON report", () => {
  const oversized = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: "invalid",
    reasonCodes: ["verification_failed"],
    authoritative: false,
    source: "synthetic-test",
    replay: {
      mode: "deterministic",
      verified: false,
      replayable: false,
      diagnosticCount: 1000,
      mismatchCount: 1000,
      diagnostics: Array.from({ length: 1000 }, (_, index) => `${index}:${"诊断".repeat(2000)}`),
      mismatches: Array.from({ length: 1000 }, (_, index) => ({
        index,
        expected: "x".repeat(2000),
        actual: "y".repeat(2000)
      })),
      reportTruncated: false
    }
  };

  const output = serializeReport(oversized);
  assert.ok(Buffer.byteLength(output, "utf8") <= MAX_REPORT_BYTES);
  const parsed = JSON.parse(output);
  assert.equal(parsed.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(parsed.status, "invalid");
  assert.equal(parsed.authoritative, false);
  assert.equal(parsed.replay.reportTruncated, true);
  assert.deepEqual(parsed.replay.diagnostics, []);
  assert.deepEqual(parsed.replay.mismatches, []);
});
