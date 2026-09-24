"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { deflateSync } = require("node:zlib");
const {
  CompetitionSession,
  CAMERA_DEFINITION_HASH,
  DETECTOR_DEFINITION_HASH
} = require("../competition-core.js");
const {
  MAX_VISION_RECOMPUTE_FRAMES,
  MAX_VISION_RECOMPUTE_DECOMPRESSED_BYTES,
  recomputeVisionQueries
} = require("../backend/vision-recompute.js");
const { verifyRecord } = require("../tools/verify-run-record.js");

const CLI_PATH = path.resolve(__dirname, "../tools/verify-run-record.js");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let entry = value;
  for (let bit = 0; bit < 8; bit += 1) entry = (entry >>> 1) ^ (entry & 1 ? 0xedb88320 : 0);
  return entry >>> 0;
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return output;
}

function targetPng() {
  const width = 640;
  const height = 480;
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * 4;
      const target = x >= 180 && x < 460 && y >= 100 && y < 380;
      raw[pixel] = target ? 235 : 18;
      raw[pixel + 1] = target ? 35 : 28;
      raw[pixel + 2] = target ? 30 : 42;
      raw[pixel + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND")
  ]);
}

const TARGET_PNG = targetPng();
const TARGET_PNG_BASE64 = TARGET_PNG.toString("base64");

const GOLDEN_RESULTS = Object.freeze({
  sees: true,
  count: 1,
  detect: [{
    "类别": "target",
    "名称": "红球",
    "目标物": "红球",
    "置信度": 0.94,
    "距离厘米": 14,
    "方位": "中间",
    "已稳定": true,
    "接近夹取距离": true
  }],
  near: true,
  centered: true,
  direction: "中间",
  distance_to: 14,
  observe: [{
    category: "target",
    categoryLabel: "目标物",
    name: "红球",
    label: "红球",
    direction: "中间",
    bearingDeg: 0,
    distanceCm: 14,
    confidence: 0.94,
    near: true,
    stable: true
  }]
});

function simulationDefinition() {
  return {
    schemaVersion: "chenlong.simulation/v1",
    stepMs: 20,
    seed: 123,
    initialPose: { x: 0, z: 0, heading: -Math.PI / 2 },
    vehicle: {
      version: "chenlong.vehicle/v1",
      radius: 0.2,
      collisionSkin: 0.01,
      maxLinearSpeed: 2,
      maxAngularSpeed: 4
    },
    world: { bounds: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 }, colliders: [] }
  };
}

function createVisionRecord({ frameCount = 1, methods = Object.keys(GOLDEN_RESULTS) } = {}) {
  const simulation = simulationDefinition();
  const session = new CompetitionSession({
    taskId: "server-vision-golden",
    mapId: "server-vision-map",
    mapVersion: "1",
    ruleVersion: "1",
    timeLimitSeconds: 2,
    task: { id: "vision-reach", type: "reach", goal: [0, 0], goalRadius: 0.1 },
    rules: {
      vehicleRadius: 0.2,
      roads: [{ id: "wide-road", width: 4, points: [[-2, 0], [2, 0]] }],
      trafficLights: [], speedZones: [], prohibitedZones: []
    },
    scoring: { efficiency: { targetSeconds: 1, maxSeconds: 2 } }
  }, {
    runId: `vision-run-${frameCount}-${methods.length}`,
    teamId: "vision-test",
    simulationDefinition: simulation
  }, { now: () => 0, sampleIntervalMs: 20 });

  for (let index = 0; index < frameCount; index += 1) {
    const frameId = `frame-${index + 1}`;
    session.addVisionEvidence({
      evidenceId: `evidence-${index + 1}`,
      frameId,
      width: 640,
      height: 480,
      payloadBase64: TARGET_PNG_BASE64
    });
    const method = frameCount === 1 ? methods[index % methods.length] : methods[0];
    const target = method === "observe" ? "目标物" : "红球";
    session.addVisionQuery(method, [target, 0.6], clone(GOLDEN_RESULTS[method]), frameId);
  }
  if (frameCount === 1 && methods.length > 1) {
    const frameId = "frame-1";
    for (const method of methods.slice(1)) {
      const target = method === "observe" ? "目标物" : "红球";
      session.addVisionQuery(method, [target, 0.6], clone(GOLDEN_RESULTS[method]), frameId);
    }
  }

  const outcome = session.sample({
    tick: 0,
    x: 0,
    z: 0,
    heading: -Math.PI / 2,
    speed: 0,
    steering: 0,
    cameraFrameId: frameCount ? `frame-${frameCount}` : null
  }, { forceRecord: true });
  assert.ok(outcome.record, "the fixture must complete at its initial reach goal");
  return outcome.record;
}

function updateEvidenceDigest(evidence, bytes) {
  evidence.pngBase64 = bytes.toString("base64");
  evidence.byteLength = bytes.length;
  evidence.sha256 = createHash("sha256").update(bytes).digest("hex");
}

test("server recomputes all frozen public vision methods from one real 640x480 PNG", () => {
  const record = createVisionRecord();
  const vision = recomputeVisionQueries(record);

  assert.equal(vision.outcome, "matched");
  assert.equal(vision.visionStatus, "matched");
  assert.equal(vision.queryCount, 8);
  assert.equal(vision.supportedQueryCount, 8);
  assert.equal(vision.uniqueEvidenceCount, 1);
  assert.equal(vision.decodedFrameCount, 1);
  assert.deepEqual(vision.reasonCodes, []);
  assert.deepEqual(vision.mismatches, []);

  const report = verifyRecord(record, { source: "vision-golden" });
  assert.equal(report.status, "verified");
  assert.equal(report.authoritative, false);
  assert.equal(report.replay.verified, true);
  assert.equal(report.visionStatus, "matched");
  assert.equal(report.verificationScope.vision, "matched");
  assert.equal(report.capabilities.visionDetectionsRecomputed, true);
  assert.equal(report.capabilities.visionDecodedFrameCount, 1);
  assert.equal(report.capabilities.recomputationComplete, true);
  assert.deepEqual(report.actualCapabilityUsage, {
    schemaVersion: "chenlong.record-capability-usage/v2",
    navigationSensorMethods: [],
    roadControlMethods: [],
    visionMethods: ["sees", "count", "detect", "near", "centered", "direction", "distance_to", "observe"]
  }, "the administrator-only visual marker is derived from real, recomputed frame queries");
  assert.deepEqual(report.reasonCodes, []);

  const cli = spawnSync(process.execPath, [CLI_PATH, "-"], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    input: JSON.stringify(record),
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.equal(cli.stderr, "");
  const cliReport = JSON.parse(cli.stdout);
  assert.equal(cliReport.status, "verified");
  assert.equal(cliReport.visionStatus, "matched");
  assert.equal(cliReport.capabilities.visionDetectionsRecomputed, true);
  assert.equal(cliReport.actualCapabilityUsage.visionMethods.includes("observe"), true);
  assert.equal(cliReport.authoritative, false);
});

test("a bound query-result mismatch makes the whole report invalid with a concrete mismatch", () => {
  const record = createVisionRecord({ methods: ["distance_to"] });
  record.inputs.find(input => input.type === "vision_query").result = 999;

  const report = verifyRecord(record);
  assert.equal(report.status, "invalid");
  assert.equal(report.authoritative, false);
  assert.equal(report.replay.verified, false);
  assert.equal(report.visionStatus, "not_recomputed");
  assert.deepEqual(report.actualCapabilityUsage, {
    schemaVersion: "chenlong.record-capability-usage/v2",
    navigationSensorMethods: [],
    roadControlMethods: [],
    visionMethods: []
  }, "a mismatched frame must never create an administrator visual marker");
  assert.ok(report.reasonCodes.includes("vision_query_result_mismatch"));
  assert.ok(report.replay.mismatches.some(item => item.field === "vision_query.result"
    && item.expected === 14 && item.actual === 999));
});

test("bound evidence must exist and carry the frozen camera and detector hashes", () => {
  const missing = createVisionRecord({ methods: ["sees"] });
  missing.visionFrames = [];
  const missingReport = verifyRecord(missing);
  assert.equal(missingReport.status, "invalid");
  assert.ok(missingReport.reasonCodes.includes("vision_evidence_missing"));

  for (const field of ["cameraDefinitionHash", "detectorDefinitionHash"]) {
    const tampered = createVisionRecord({ methods: ["sees"] });
    tampered.visionFrames[0][field] = "0".repeat(64);
    const result = recomputeVisionQueries(tampered);
    assert.equal(result.outcome, "invalid");
    assert.ok(result.reasonCodes.includes("vision_evidence_definition_mismatch"));
  }
  const valid = createVisionRecord({ methods: ["sees"] }).visionFrames[0];
  assert.equal(valid.cameraDefinitionHash, CAMERA_DEFINITION_HASH);
  assert.equal(valid.detectorDefinitionHash, DETECTOR_DEFINITION_HASH);
});

test("a bound record with a modified vision definition is invalid before PNG decoding", () => {
  const record = createVisionRecord({ methods: ["sees"] });
  record.runDefinition.visionDefinition.version = "tampered";

  const vision = recomputeVisionQueries(record);
  assert.equal(vision.outcome, "invalid");
  assert.equal(vision.attempted, false);
  assert.equal(vision.decodedFrameCount, 0);
  assert.ok(vision.reasonCodes.includes("vision_definition_mismatch"));

  const report = verifyRecord(record);
  assert.equal(report.status, "invalid");
  assert.equal(report.authoritative, false);
  assert.ok(report.reasonCodes.includes("vision_definition_mismatch"));
});

test("a generically valid but non-RGBA camera PNG is invalid for bound recomputation", () => {
  const record = createVisionRecord({ methods: ["sees"] });
  const bytes = Buffer.from(record.visionFrames[0].pngBase64, "base64");
  bytes[25] = 2;
  const ihdrCrc = crc32(bytes.subarray(12, 29));
  bytes.writeUInt32BE(ihdrCrc, 29);
  updateEvidenceDigest(record.visionFrames[0], bytes);

  const report = verifyRecord(record);
  assert.equal(report.status, "invalid");
  assert.ok(report.reasonCodes.includes("vision_png_invalid"));
  assert.match(report.replay.diagnostics.join("\n"), /color type must be 6/);
});

test("old v4 records stay visually unrecomputed while auxiliary approach traces are excluded from semantic queries", () => {
  const legacy = createVisionRecord({ methods: ["sees"] });
  delete legacy.runDefinition.visionDefinition;
  delete legacy.visionFrames[0].cameraDefinitionHash;
  delete legacy.visionFrames[0].detectorDefinitionHash;
  const legacyReport = verifyRecord(legacy);
  assert.equal(legacyReport.status, "verified");
  assert.equal(legacyReport.visionStatus, "not_recomputed");
  assert.deepEqual(legacyReport.reasonCodes, ["vision_detections_not_recomputed"]);

  const auxiliary = createVisionRecord({ methods: ["sees"] });
  const query = auxiliary.inputs.find(input => input.type === "vision_query");
  query.method = "approach_step";
  query.result = { decision: "control" };
  const auxiliaryReport = verifyRecord(auxiliary);
  assert.equal(auxiliaryReport.status, "verified");
  assert.equal(auxiliaryReport.visionStatus, "not_used");
  assert.equal(auxiliaryReport.capabilities.visionQueryCount, 0);
  assert.equal(auxiliaryReport.capabilities.visionDetectionsRecomputed, false);
  assert.deepEqual(auxiliaryReport.reasonCodes, []);
});

test("non-v4 records never enter the semantic vision recomputation path", () => {
  const record = createVisionRecord({ methods: ["sees"] });
  record.schemaVersion = "chenlong.run-record/v3";
  record.inputs.find(input => input.type === "vision_query").result = false;

  const result = recomputeVisionQueries(record);
  assert.equal(result.outcome, "not_recomputed");
  assert.equal(result.attempted, false);
  assert.equal(result.supportedQueryCount, 0);
  assert.equal(result.decodedFrameCount, 0);
  assert.deepEqual(result.reasonCodes, []);
});

test("an auxiliary approach trace cannot hide a mismatch in a supported query", () => {
  const record = createVisionRecord();
  const queries = record.inputs.filter(input => input.type === "vision_query");
  queries[0].method = "approach_step";
  queries[0].result = { decision: "control" };
  const supported = queries.find(input => input.method === "distance_to");
  supported.result = 999;

  const vision = recomputeVisionQueries(record);
  assert.equal(vision.outcome, "invalid");
  assert.equal(vision.supportedQueryCount, 7);
  assert.equal(vision.reasonCodes.includes("vision_query_method_not_supported"), false);
  assert.ok(vision.reasonCodes.includes("vision_query_result_mismatch"));

  const report = verifyRecord(record);
  assert.equal(report.status, "invalid");
  assert.equal(report.replay.verified, false);
  assert.ok(report.replay.mismatches.some(item => item.method === "distance_to"
    && item.expected === 14 && item.actual === 999));
});

test("more than 64 referenced frames fails closed to not_recomputed without decoding", () => {
  const record = createVisionRecord({
    frameCount: MAX_VISION_RECOMPUTE_FRAMES + 1,
    methods: ["sees"]
  });
  const result = recomputeVisionQueries(record);
  assert.equal(result.outcome, "not_recomputed");
  assert.equal(result.visionStatus, "not_recomputed");
  assert.equal(result.uniqueEvidenceCount, 65);
  assert.equal(result.decodedFrameCount, 0);
  assert.equal(result.decompressedBytes, 0);
  assert.ok(result.reasonCodes.includes("vision_recompute_budget_exceeded"));
  assert.ok(65 * 1_229_280 < MAX_VISION_RECOMPUTE_DECOMPRESSED_BYTES,
    "the frame-count ceiling must independently protect CPU even below the 80 MiB byte ceiling");

  const report = verifyRecord(record);
  assert.equal(report.status, "verified");
  assert.equal(report.visionStatus, "not_recomputed");
  assert.equal(report.capabilities.recomputationComplete, false);
  assert.deepEqual(report.actualCapabilityUsage.visionMethods, [],
    "an incomplete vision recomputation fails closed for the capability marker");
  assert.ok(report.reasonCodes.includes("vision_recompute_budget_exceeded"));
});
