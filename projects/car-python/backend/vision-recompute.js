"use strict";

const { createHash } = require("node:crypto");
const { canonicalSha256 } = require("./canonical-json.js");
const {
  EXPECTED_SCANLINE_BYTES,
  decodeStrictVisionPng
} = require("./strict-png.js");
const {
  CAMERA_DEFINITION_HASH,
  DETECTOR_DEFINITION_HASH,
  LEGACY_QUERY_DEFINITION,
  LEGACY_VISION_DEFINITION,
  LEGACY_VISION_DEFINITION_HASH,
  QUERY_DEFINITION,
  VISION_DEFINITION,
  VISION_DEFINITION_HASH,
  prepareVirtualFrame,
  detectVirtualPixels,
  projectQuery
} = require("../vision-pixel-core.js");

const MAX_VISION_RECOMPUTE_FRAMES = 64;
const MAX_VISION_RECOMPUTE_DECOMPRESSED_BYTES = 80 * 1024 * 1024;
const MAX_VISION_RECOMPUTE_DETAILS = 200;
const RUN_RECORD_SCHEMA_VERSION = "chenlong.run-record/v4";
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
// approach() is a high-level motion helper.  Its individual frame decisions
// are recorded for audit as approach/approach_step inputs, while the resulting
// turns and drives are replayed by the deterministic simulator.  They are not
// public pixel-query projections, so only the underlying public queries (for
// example observe()) belong in semantic vision recomputation.
const AUXILIARY_VISION_TRACE_METHODS = new Set(["approach", "approach_step"]);

function exactJsonEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => exactJsonEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && exactJsonEqual(left[key], right[key]));
}

function canonicalPngBytes(evidence) {
  const payload = evidence?.pngBase64 ?? evidence?.payloadBase64
    ?? evidence?.payload ?? evidence?.dataUrl;
  if (typeof payload !== "string") throw new TypeError("vision evidence PNG payload must be a base64 string");
  const source = payload.startsWith(PNG_DATA_URL_PREFIX) ? payload.slice(PNG_DATA_URL_PREFIX.length) : payload;
  if (!source || source.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(source)) {
    throw new TypeError("vision evidence PNG payload is not canonical base64");
  }
  const bytes = Buffer.from(source, "base64");
  if (bytes.toString("base64") !== source) throw new TypeError("vision evidence PNG payload is not canonical base64");
  if (evidence.byteLength !== undefined && evidence.byteLength !== bytes.length) {
    throw new TypeError("vision evidence byteLength does not match its PNG payload");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const recordedDigest = evidence.sha256 ?? evidence.pixelSha256;
  if (typeof recordedDigest !== "string" || recordedDigest.toLowerCase() !== digest) {
    throw new TypeError("vision evidence SHA-256 does not match its PNG payload");
  }
  return bytes;
}

function baseResult(queryCount) {
  return {
    visionStatus: queryCount ? "not_recomputed" : "not_used",
    outcome: queryCount ? "not_recomputed" : "not_used",
    attempted: false,
    queryCount,
    supportedQueryCount: 0,
    uniqueEvidenceCount: 0,
    decodedFrameCount: 0,
    decompressedBytes: 0,
    reasonCodes: [],
    diagnosticCount: 0,
    mismatchCount: 0,
    diagnostics: [],
    mismatches: []
  };
}

function pushBounded(output, value) {
  if (output.length < MAX_VISION_RECOMPUTE_DETAILS) output.push(value);
}

function addDiagnostic(result, message) {
  result.diagnosticCount += 1;
  pushBounded(result.diagnostics, String(message));
}

function addMismatch(result, mismatch) {
  result.mismatchCount += 1;
  pushBounded(result.mismatches, mismatch);
}

function addReason(result, reason) {
  if (!result.reasonCodes.includes(reason)) result.reasonCodes.push(reason);
}

function invalidResult(result, reason, diagnostic = null) {
  result.visionStatus = "not_recomputed";
  result.outcome = "invalid";
  addReason(result, reason);
  if (diagnostic) addDiagnostic(result, diagnostic);
  return result;
}

function supportedDefinition(record) {
  const definition = record?.runDefinition?.visionDefinition;
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return null;
  try {
    const digest = canonicalSha256(definition);
    if (digest === VISION_DEFINITION_HASH && exactJsonEqual(definition, VISION_DEFINITION)) {
      return { visionDefinition: VISION_DEFINITION, queryDefinition: QUERY_DEFINITION };
    }
    if (digest === LEGACY_VISION_DEFINITION_HASH
      && exactJsonEqual(definition, LEGACY_VISION_DEFINITION)) {
      return { visionDefinition: LEGACY_VISION_DEFINITION, queryDefinition: LEGACY_QUERY_DEFINITION };
    }
    return null;
  } catch (_error) {
    return null;
  }
}

function evidenceIdentity(value) {
  if (typeof value === "string" && value.trim() && value.length <= 128) return value;
  return null;
}

function recomputeVisionQueries(record) {
  const recordedQueries = Array.isArray(record?.inputs)
    ? record.inputs.map((input, inputIndex) => ({ input, inputIndex }))
      .filter(item => item.input?.type === "vision_query")
    : [];
  const queries = recordedQueries.filter(({ input }) => (
    !AUXILIARY_VISION_TRACE_METHODS.has(input?.method)
  ));
  const result = baseResult(queries.length);
  if (!queries.length) return result;
  if (record?.schemaVersion !== RUN_RECORD_SCHEMA_VERSION) return result;

  const hasVisionDefinition = Boolean(record?.runDefinition
    && typeof record.runDefinition === "object"
    && !Array.isArray(record.runDefinition)
    && Object.prototype.hasOwnProperty.call(record.runDefinition, "visionDefinition"));
  if (!hasVisionDefinition) return result;
  const definition = supportedDefinition(record);
  if (!definition) {
    return invalidResult(
      result,
      "vision_definition_mismatch",
      "runDefinition.visionDefinition does not match the frozen server vision definition"
    );
  }

  const unsupported = queries.filter(({ input }) => (
    typeof input.method !== "string" || !definition.queryDefinition.methods.includes(input.method)
  ));
  const supported = queries.filter(({ input }) => (
    typeof input.method === "string" && definition.queryDefinition.methods.includes(input.method)
  ));
  result.supportedQueryCount = supported.length;
  if (unsupported.length) {
    addReason(result, "vision_query_method_not_supported");
    const methods = [...new Set(unsupported.map(({ input }) => String(input?.method ?? "missing")))];
    addDiagnostic(result, `vision query methods are not server-recomputable: ${methods.join(", ")}`);
  }
  if (!supported.length) return result;

  const referencedIds = [];
  const referencedIdSet = new Set();
  supported.forEach(({ input }) => {
    const evidenceId = evidenceIdentity(input.evidenceId);
    if (evidenceId !== null && !referencedIdSet.has(evidenceId)) {
      referencedIdSet.add(evidenceId);
      referencedIds.push(evidenceId);
    }
  });
  result.uniqueEvidenceCount = referencedIds.length;
  const decompressedBudget = referencedIds.length * EXPECTED_SCANLINE_BYTES;
  if (referencedIds.length > MAX_VISION_RECOMPUTE_FRAMES
    || decompressedBudget > MAX_VISION_RECOMPUTE_DECOMPRESSED_BYTES) {
    addReason(result, "vision_recompute_budget_exceeded");
    addDiagnostic(result,
      `vision recomputation requires ${referencedIds.length} unique frames and ${decompressedBudget} decompressed bytes`);
    return result;
  }

  result.attempted = true;
  const evidenceById = new Map();
  const duplicateEvidenceIds = new Set();
  if (Array.isArray(record.visionFrames)) {
    record.visionFrames.forEach(evidence => {
      const evidenceId = evidenceIdentity(evidence?.evidenceId);
      if (evidenceId === null || !referencedIdSet.has(evidenceId)) return;
      if (evidenceById.has(evidenceId)) duplicateEvidenceIds.add(evidenceId);
      else evidenceById.set(evidenceId, evidence);
    });
  }
  duplicateEvidenceIds.forEach(evidenceId => {
    invalidResult(result, "vision_evidence_missing", `vision evidence ${evidenceId} is duplicated`);
  });

  const detectionsByEvidenceId = new Map();
  for (const evidenceId of referencedIds) {
    if (duplicateEvidenceIds.has(evidenceId)) continue;
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) {
      invalidResult(result, "vision_evidence_missing", `vision query references missing evidence ${evidenceId}`);
      continue;
    }
    if (String(evidence.cameraDefinitionHash || "").toLowerCase() !== CAMERA_DEFINITION_HASH
      || String(evidence.detectorDefinitionHash || "").toLowerCase() !== DETECTOR_DEFINITION_HASH) {
      invalidResult(
        result,
        "vision_evidence_definition_mismatch",
        `vision evidence ${evidenceId} does not match the frozen camera and detector hashes`
      );
      continue;
    }
    try {
      const png = canonicalPngBytes(evidence);
      const decoded = decodeStrictVisionPng(png);
      const frame = prepareVirtualFrame(decoded.rgba, { frameId: evidence.frameId });
      detectionsByEvidenceId.set(evidenceId, detectVirtualPixels(frame));
      result.decodedFrameCount += 1;
      result.decompressedBytes += EXPECTED_SCANLINE_BYTES;
    } catch (error) {
      invalidResult(result, "vision_png_invalid", `vision evidence ${evidenceId} cannot be decoded: ${error?.message || error}`);
    }
  }

  for (const { input, inputIndex } of supported) {
    const evidenceId = evidenceIdentity(input.evidenceId);
    const evidence = evidenceId === null ? null : evidenceById.get(evidenceId);
    const detections = evidenceId === null ? null : detectionsByEvidenceId.get(evidenceId);
    if (!evidenceId || !evidence || !detections) {
      if (!evidenceId) invalidResult(result, "vision_evidence_missing", `vision query input ${inputIndex} has no evidenceId`);
      continue;
    }
    if (evidence.frameId !== input.frameId) {
      invalidResult(result, "vision_evidence_missing", `vision query input ${inputIndex} frameId does not match ${evidenceId}`);
      continue;
    }
    let expected;
    try {
      expected = projectQuery(input.method, input.args, detections, definition.queryDefinition);
    } catch (error) {
      invalidResult(result, "vision_query_projection_failed",
        `vision query input ${inputIndex} cannot be projected: ${error?.message || error}`);
      continue;
    }
    if (!exactJsonEqual(input.result, expected)) {
      result.visionStatus = "not_recomputed";
      result.outcome = "invalid";
      addReason(result, "vision_query_result_mismatch");
      addDiagnostic(result, `vision query input ${inputIndex} result does not match server recomputation`);
      addMismatch(result, {
        inputIndex,
        seq: Number.isSafeInteger(input.seq) ? input.seq : null,
        field: "vision_query.result",
        method: input.method,
        evidenceId,
        expected,
        actual: input.result
      });
    }
  }

  if (result.outcome === "invalid") return result;
  if (unsupported.length) return result;
  result.visionStatus = "matched";
  result.outcome = "matched";
  return result;
}

module.exports = {
  MAX_VISION_RECOMPUTE_FRAMES,
  MAX_VISION_RECOMPUTE_DECOMPRESSED_BYTES,
  MAX_VISION_RECOMPUTE_DETAILS,
  exactJsonEqual,
  recomputeVisionQueries
};
