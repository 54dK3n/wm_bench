"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { parseRecord, verifyRecord } = require("./verify-run-record.js");
const { canonicalSha256 } = require("../backend/canonical-json.js");

function safeText(value, maximum = 2000) {
  const text = String(value ?? "verification failed");
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
}

function recordMetadata(record, report) {
  const output = {};
  const limits = {
    schemaVersion: 64,
    runId: 256,
    serverSessionId: 64,
    challengeDigest: 64,
    teamId: 64,
    taskId: 128,
    mapId: 128,
    mapVersion: 128,
    ruleVersion: 128
  };
  Object.entries(limits).forEach(([field, maximum]) => {
    const value = record?.[field];
    output[field] = typeof value === "string" && value.length <= maximum ? value : null;
  });
  try {
    output.runDefinitionDigest = canonicalSha256(record?.runDefinition);
  } catch (_error) {
    output.runDefinitionDigest = null;
  }
  try {
    output.sourceCodeDigest = typeof record?.sourceCode === "string"
      ? canonicalSha256(record.sourceCode)
      : null;
  } catch (_error) {
    output.sourceCodeDigest = null;
  }
  const verifiedEvents = report?.status === "verified" && Array.isArray(record?.events)
    ? record.events
    : [];
  output.verifiedCollisionCount = verifiedEvents.filter(event => (
    event?.type === "violation" && event?.violationType === "collision"
  )).length;
  output.verifiedOutOfBoundsCount = verifiedEvents.filter(event => (
    event?.type === "violation" && event?.violationType === "off_road"
  )).length;
  return output;
}

try {
  const payload = workerData?.payload ?? workerData;
  const trustedRunDefinition = workerData?.trustedRunDefinition ?? null;
  const buffer = Buffer.from(payload);
  const record = parseRecord(buffer);
  const verificationRecord = trustedRunDefinition && typeof trustedRunDefinition === "object"
    ? {
        ...record,
        runDefinition: trustedRunDefinition,
        simulationDefinition: trustedRunDefinition.simulationDefinition ?? null,
        interactionDefinition: trustedRunDefinition.interactionDefinition ?? null,
        taskDefinition: trustedRunDefinition.taskDefinition ?? null,
        ruleDefinition: trustedRunDefinition.ruleDefinition ?? null,
        scoringDefinition: trustedRunDefinition.scoringDefinition ?? null
      }
    : record;
  const report = verifyRecord(verificationRecord, { source: trustedRunDefinition ? "session-api" : "http-api" });
  parentPort.postMessage({ ok: true, report, recordMetadata: recordMetadata(record, report) });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      code: typeof error?.code === "string" ? error.code : "VERIFY_FAILED",
      message: safeText(error?.message || error)
    }
  });
}
