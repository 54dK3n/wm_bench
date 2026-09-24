#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { ReplayPlayer, SCHEMA_VERSION, DETERMINISTIC_LEGACY_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION } = require("../competition-core.js");
const { recomputeVisionQueries } = require("../backend/vision-recompute.js");
const { deriveRecordCapabilityUsage } = require("../backend/record-capability-usage.js");

const REPORT_SCHEMA_VERSION = "chenlong.verification-report/v1";
const MAX_RECORD_BYTES = 40 * 1024 * 1024;
const MAX_REPORT_DIAGNOSTICS = 200;
const MAX_REPORT_MISMATCHES = 200;
const MAX_REPORT_BYTES = 512 * 1024;
const RESULT_FIELDS = [
  "score", "taskScore", "ruleScore", "autonomousScore", "efficiencyScore", "ruleDeduction",
  "eventDeduction", "durationDeduction", "durationSeconds", "completedTasks", "totalTasks",
  "taskValid", "taskFinished", "reason", "simulationTick"
];

class CliInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CliInputError";
    this.code = code;
  }
}

function truncateText(value, maximum = 1000) {
  const text = String(value ?? "");
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
}

function safeReportValue(value, depth = 0, budget = { remaining: 100000 }) {
  if (budget.remaining <= 0) return "[report budget exhausted]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    const text = truncateText(value, Math.min(500, budget.remaining));
    budget.remaining -= text.length;
    return text;
  }
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) {
    const output = [];
    for (let index = 0; index < Math.min(20, value.length) && budget.remaining > 0; index += 1) {
      budget.remaining -= 1;
      output.push(safeReportValue(value[index], depth + 1, budget));
    }
    return output;
  }
  if (!value || typeof value !== "object") return truncateText(value, 100);
  const output = Object.create(null);
  let keyCount = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (keyCount >= 40 || budget.remaining <= 0) break;
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    const safeKey = truncateText(key, Math.min(100, budget.remaining));
    budget.remaining -= safeKey.length + 1;
    output[safeKey] = safeReportValue(value[key], depth + 1, budget);
    keyCount += 1;
  }
  return output;
}

function compactResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const compact = {};
  RESULT_FIELDS.forEach(field => {
    if (Object.prototype.hasOwnProperty.call(result, field)) compact[field] = safeReportValue(result[field]);
  });
  return compact;
}

function recordSummary(record) {
  const summary = {};
  ["schemaVersion", "runId", "teamId", "taskId", "mapId", "mapVersion", "ruleVersion"].forEach(field => {
    const value = record?.[field];
    if (["string", "number", "boolean"].includes(typeof value)) summary[field] = truncateText(value, 256);
    else if (value !== undefined && value !== null) summary[field] = "[invalid metadata]";
  });
  summary.inputCount = Array.isArray(record?.inputs) ? record.inputs.length : null;
  summary.sampleCount = Array.isArray(record?.samples) ? record.samples.length : null;
  summary.eventCount = Array.isArray(record?.events) ? record.events.length : null;
  summary.visionFrameCount = Array.isArray(record?.visionFrames) ? record.visionFrames.length : null;
  return summary;
}

function usableLegacyTelemetry(record) {
  if (!Array.isArray(record?.samples) || record.samples.length < 1) return false;
  let previousTime = -Infinity;
  let previousTick = -Infinity;
  return record.samples.every(sample => {
    if (!sample || typeof sample !== "object" || Array.isArray(sample)) return false;
    const required = ["t", "x", "z", "heading", "speed", "steering"];
    if (!required.every(field => typeof sample[field] === "number" && Number.isFinite(sample[field]))) return false;
    if (sample.t < 0 || sample.t < previousTime) return false;
    previousTime = sample.t;
    const tick = sample.tick ?? sample.simulationTick;
    if (tick === undefined) return true;
    if (!Number.isSafeInteger(tick) || tick < 0 || tick < previousTick) return false;
    previousTick = tick;
    return true;
  });
}

const DETERMINISTIC_VERIFICATION_DOMAINS = Object.freeze([
  "control_inputs",
  "navigation_sensors",
  "navigation_controls",
  "physics",
  "interactions",
  "task",
  "rules",
  "score"
]);

function deterministicRecomputationComplete(analysis) {
  const naturallyTerminated = ["completed", "timeout"].includes(analysis?.recomputedResult?.reason);
  return Boolean(analysis?.taskRecomputed)
    && Boolean(analysis?.rulesRecomputed)
    && Boolean(analysis?.interactionsRecomputed)
    && Boolean(analysis?.manualControlRecomputed)
    && analysis?.navigationQueriesRecomputed !== false
    && analysis?.navigationControlsRecomputed !== false
    && Boolean(analysis?.externalEventsRecomputed)
    && (naturallyTerminated || Boolean(analysis?.externalTerminationRecomputed))
    && Boolean(analysis?.scoreRecomputed);
}

function verificationStatus(record, player, verification, analysis, visionRecompute) {
  if (record?.schemaVersion === LEGACY_SCHEMA_VERSION && player.mode === "telemetry") {
    const expectedFallbackOnly = verification.diagnostics.length === 1
      && /legacy telemetry playback/i.test(verification.diagnostics[0]);
    return usableLegacyTelemetry(record) && expectedFallbackOnly ? "partial" : "invalid";
  }
  if (record?.schemaVersion === DETERMINISTIC_LEGACY_SCHEMA_VERSION) {
    return verification.ok ? "partial" : "invalid";
  }
  if (record?.schemaVersion !== SCHEMA_VERSION || !verification.ok
    || visionRecompute?.outcome === "invalid") return "invalid";
  const recordedResultComplete = record.result && typeof record.result === "object" && !Array.isArray(record.result)
    && RESULT_FIELDS.every(field => Object.prototype.hasOwnProperty.call(record.result, field));
  return deterministicRecomputationComplete(analysis) && recordedResultComplete ? "verified" : "partial";
}

function reasonCodesFor(record, player, verification, analysis, visionRecompute, status) {
  const reasons = [];
  if (record?.schemaVersion === LEGACY_SCHEMA_VERSION) reasons.push("legacy_telemetry_only");
  else if (record?.schemaVersion === DETERMINISTIC_LEGACY_SCHEMA_VERSION) reasons.push("legacy_vehicle_replay_only");
  else if (record?.schemaVersion !== SCHEMA_VERSION) reasons.push("unsupported_record_schema");
  if (!verification.ok && record?.schemaVersion !== LEGACY_SCHEMA_VERSION) reasons.push("verification_failed");
  if (status === "invalid" && record?.schemaVersion === LEGACY_SCHEMA_VERSION) reasons.push("legacy_telemetry_invalid");
  if (record?.schemaVersion === SCHEMA_VERSION && !deterministicRecomputationComplete(analysis)) {
    reasons.push("recomputation_incomplete");
  }
  // Auxiliary approach traces describe a high-level motion helper.  Its
  // resulting drive/turn inputs are replayed separately; only public pixel
  // query results take part in semantic vision recomputation.
  const visionQueryCount = Number(visionRecompute?.queryCount) || 0;
  if (visionQueryCount && visionRecompute?.visionStatus !== "matched") {
    reasons.push("vision_detections_not_recomputed");
  }
  if (Array.isArray(visionRecompute?.reasonCodes)) reasons.push(...visionRecompute.reasonCodes);
  if (record?.schemaVersion === SCHEMA_VERSION && !analysis.scoreRecomputed) reasons.push("score_not_recomputed");
  if (record?.schemaVersion === SCHEMA_VERSION && !analysis.externalTerminationRecomputed
    && !["completed", "timeout"].includes(analysis.recomputedResult?.reason)) {
    reasons.push("external_termination_not_recomputed");
  }
  if (record?.schemaVersion === SCHEMA_VERSION) {
    const resultObject = record.result && typeof record.result === "object" && !Array.isArray(record.result);
    if (!resultObject) reasons.push("recorded_result_missing");
    else if (!RESULT_FIELDS.every(field => Object.prototype.hasOwnProperty.call(record.result, field))) {
      reasons.push("recorded_result_incomplete");
    }
  }
  if (status === "invalid" && !reasons.length) reasons.push("invalid_record");
  return [...new Set(reasons)];
}

function verifyRecord(record, options = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new CliInputError("INVALID_ROOT", "run record JSON root must be an object");
  }
  const player = new ReplayPlayer(record);
  const verification = player.verify();
  const analysis = player.analysis();
  const visionRecompute = recomputeVisionQueries(record);
  const effectiveVerification = {
    ...verification,
    ok: Boolean(verification.ok) && visionRecompute.outcome !== "invalid",
    diagnostics: [
      ...verification.diagnostics,
      ...(Array.isArray(visionRecompute.diagnostics) ? visionRecompute.diagnostics : [])
    ],
    mismatches: [
      ...verification.mismatches,
      ...(Array.isArray(visionRecompute.mismatches) ? visionRecompute.mismatches : [])
    ]
  };
  const status = verificationStatus(record, player, effectiveVerification, analysis, visionRecompute);
  const reasonCodes = reasonCodesFor(record, player, effectiveVerification, analysis, visionRecompute, status);
  const deterministicComplete = deterministicRecomputationComplete(analysis);
  const visionStatus = visionRecompute.visionStatus;
  const recomputationComplete = deterministicComplete
    && Boolean(analysis.visionEvidenceVerified)
    && (visionRecompute.queryCount === 0 || visionStatus === "matched");
  const diagnosticCount = verification.diagnostics.length + Number(visionRecompute.diagnosticCount || 0);
  const mismatchCount = verification.mismatches.length + Number(visionRecompute.mismatchCount || 0);
  const diagnostics = effectiveVerification.diagnostics.slice(0, MAX_REPORT_DIAGNOSTICS)
    .map(item => truncateText(item, 2000));
  const reportBudget = { remaining: 100000 };
  const mismatches = effectiveVerification.mismatches.slice(0, MAX_REPORT_MISMATCHES)
    .map(item => safeReportValue(item, 0, reportBudget));
  const resultObject = record.result && typeof record.result === "object" && !Array.isArray(record.result);
  const resultComplete = Boolean(resultObject)
    && RESULT_FIELDS.every(field => Object.prototype.hasOwnProperty.call(record.result, field));
  const resultMismatchCount = Array.isArray(analysis.resultMismatches) ? analysis.resultMismatches.length : 0;
  const capabilityLedgerTrusted = record.schemaVersion === SCHEMA_VERSION
    && Boolean(effectiveVerification.ok)
    && analysis.navigationQueriesRecomputed !== false
    && analysis.navigationControlsRecomputed !== false
    // A visual-perception marker is only meaningful when every public vision
    // query in the typed ledger has been recomputed from its hash-bound frame.
    // When that check is incomplete or mismatched, fail closed for the whole
    // capability summary rather than rewarding an unverifiable claim.
    && (visionRecompute.queryCount === 0 || visionStatus === "matched");
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status,
    reasonCodes,
    authoritative: false,
    source: options.source ? truncateText(options.source, 512) : null,
    visionStatus,
    verificationScope: {
      deterministic: {
        status: deterministicComplete ? "complete" : "incomplete",
        domains: [...DETERMINISTIC_VERIFICATION_DOMAINS]
      },
      vision: visionStatus
    },
    record: recordSummary(record),
    replay: {
      mode: player.mode,
      verified: Boolean(effectiveVerification.ok),
      replayable: Boolean(verification.replayable),
      diagnosticCount,
      mismatchCount,
      diagnostics,
      mismatches,
      reportTruncated: diagnosticCount > MAX_REPORT_DIAGNOSTICS || mismatchCount > MAX_REPORT_MISMATCHES
    },
    capabilities: {
      taskRecomputed: Boolean(analysis.taskRecomputed),
      rulesRecomputed: Boolean(analysis.rulesRecomputed),
      interactionsRecomputed: Boolean(analysis.interactionsRecomputed),
      manualControlRecomputed: Boolean(analysis.manualControlRecomputed),
      navigationQueriesRecomputed: analysis.navigationQueriesRecomputed !== false,
      navigationControlsRecomputed: analysis.navigationControlsRecomputed !== false,
      externalTerminationRecomputed: Boolean(analysis.externalTerminationRecomputed),
      externalEventsRecomputed: Boolean(analysis.externalEventsRecomputed),
      visionEvidenceVerified: Boolean(analysis.visionEvidenceVerified),
      visionDetectionsRecomputed: visionStatus === "matched",
      visionQueryCount: visionRecompute.queryCount,
      visionRecomputeAttempted: Boolean(visionRecompute.attempted),
      visionSupportedQueryCount: Number(visionRecompute.supportedQueryCount) || 0,
      visionUniqueEvidenceCount: Number(visionRecompute.uniqueEvidenceCount) || 0,
      visionDecodedFrameCount: Number(visionRecompute.decodedFrameCount) || 0,
      visionDecompressedBytes: Number(visionRecompute.decompressedBytes) || 0,
      scoreRecomputed: Boolean(analysis.scoreRecomputed),
      deterministicRecomputationComplete: deterministicComplete,
      recomputationComplete
    },
    resultComparison: {
      recordedPresent: Boolean(resultObject),
      complete: resultComplete,
      matched: resultComplete ? resultMismatchCount === 0 : null,
      mismatchCount: resultMismatchCount
    },
    recomputedResult: compactResult(analysis.recomputedResult),
    recordedResult: compactResult(record.result)
  };
  report.actualCapabilityUsage = deriveRecordCapabilityUsage(capabilityLedgerTrusted ? record : null);
  return report;
}

function parseArguments(argv) {
  let allowPartial = false;
  let source = null;
  for (const argument of argv) {
    if (argument === "--allow-partial") {
      allowPartial = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") return { help: true, allowPartial, source };
    if (argument.startsWith("-") && argument !== "-") {
      throw new CliInputError("UNKNOWN_OPTION", `unknown option: ${argument}`);
    }
    if (source !== null) throw new CliInputError("TOO_MANY_INPUTS", "provide exactly one run record path or '-' for stdin");
    source = argument;
  }
  if (source === null) throw new CliInputError("MISSING_INPUT", "provide a run record path or '-' for stdin");
  return { help: false, allowPartial, source };
}

async function readStreamLimited(stream, limit = MAX_RECORD_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new CliInputError("INPUT_TOO_LARGE", `run record exceeds the ${limit} byte input limit`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

async function readSource(source) {
  if (source === "-") return readStreamLimited(process.stdin);
  let handle;
  try {
    handle = await fs.promises.open(path.resolve(source), "r");
    const stat = await handle.stat();
    if (!stat.isFile()) throw new CliInputError("NOT_A_FILE", "run record path must point to a regular file");
    if (stat.size > MAX_RECORD_BYTES) {
      throw new CliInputError("INPUT_TOO_LARGE", `run record exceeds the ${MAX_RECORD_BYTES} byte input limit`);
    }
    return await readStreamLimited(handle.createReadStream({ autoClose: false }));
  } catch (error) {
    if (error instanceof CliInputError) throw error;
    throw new CliInputError("READ_FAILED", `could not read run record: ${error.message}`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseRecord(buffer) {
  if (!buffer.length) throw new CliInputError("EMPTY_INPUT", "run record input is empty");
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (_error) {
    throw new CliInputError("INVALID_UTF8", "run record must be valid UTF-8 text");
  }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  let record;
  try {
    record = JSON.parse(source);
  } catch (error) {
    throw new CliInputError("INVALID_JSON", `run record is not valid JSON: ${error.message}`);
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new CliInputError("INVALID_ROOT", "run record JSON root must be an object");
  }
  return record;
}

function errorReport(error, source = null) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: "error",
    authoritative: false,
    source: source ? truncateText(source, 512) : null,
    error: {
      code: error?.code || "VERIFY_FAILED",
      message: truncateText(error?.message || error, 2000)
    }
  };
}

function serializeReport(report) {
  let json = JSON.stringify(report, null, 2);
  if (Buffer.byteLength(json, "utf8") <= MAX_REPORT_BYTES) return `${json}\n`;
  const compact = {
    ...report,
    replay: report.replay ? {
      ...report.replay,
      diagnostics: [],
      mismatches: [],
      reportTruncated: true
    } : undefined
  };
  json = JSON.stringify(compact, null, 2);
  if (Buffer.byteLength(json, "utf8") <= MAX_REPORT_BYTES) return `${json}\n`;
  return `${JSON.stringify({
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: report.status || "error",
    reasonCodes: Array.isArray(report.reasonCodes) ? report.reasonCodes.slice(0, 20) : [],
    authoritative: false,
    source: report.source ? truncateText(report.source, 256) : null,
    actualCapabilityUsage: report.actualCapabilityUsage,
    replay: report.replay ? {
      mode: report.replay.mode,
      verified: report.replay.verified,
      replayable: report.replay.replayable,
      diagnosticCount: report.replay.diagnosticCount,
      mismatchCount: report.replay.mismatchCount,
      diagnostics: [],
      mismatches: [],
      reportTruncated: true
    } : undefined,
    error: report.error ? safeReportValue(report.error) : undefined
  }, null, 2)}\n`;
}

function exitCodeFor(report, allowPartial = false) {
  if (report.status === "verified") return 0;
  if (report.status === "partial") return allowPartial ? 0 : 2;
  if (report.status === "invalid") return 1;
  return 64;
}

async function main(argv = process.argv.slice(2)) {
  let parsed = null;
  try {
    parsed = parseArguments(argv);
    if (parsed.help) {
      process.stdout.write("Usage: node tools/verify-run-record.js <record.json|-> [--allow-partial]\n");
      return 0;
    }
    const buffer = await readSource(parsed.source);
    const record = parseRecord(buffer);
    const report = verifyRecord(record, { source: parsed.source });
    process.stdout.write(serializeReport(report));
    return exitCodeFor(report, parsed.allowPartial);
  } catch (error) {
    const report = errorReport(error, parsed?.source || null);
    process.stdout.write(serializeReport(report));
    return 64;
  }
}

if (require.main === module) {
  main().then(code => {
    process.exitCode = code;
  }, error => {
    process.stdout.write(serializeReport(errorReport(error)));
    process.exitCode = 64;
  });
}

module.exports = {
  REPORT_SCHEMA_VERSION,
  MAX_RECORD_BYTES,
  MAX_REPORT_BYTES,
  verifyRecord,
  parseArguments,
  parseRecord,
  exitCodeFor,
  serializeReport,
  main
};
