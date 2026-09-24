"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { gunzipSync } = require("node:zlib");

const {
  ReplayPlayer: ProductionReplayPlayer,
  geometry: ProductionGeometry
} = require("../competition-core.js");
const PersonalScoreRules = require("../admin-team-scores.js");

const appSource = fs.readFileSync(path.resolve(__dirname, "../app.js"), "utf8");

function loadLatestArchivedV4Record({ requireMovement = false } = {}) {
  const sessionsRoot = path.resolve(__dirname, "../.runtime/sessions");
  if (!fs.existsSync(sessionsRoot)) return null;
  const candidates = [];
  const visit = directory => {
    fs.readdirSync(directory, { withFileTypes: true }).forEach(entry => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile() && entry.name === "record.json") {
        candidates.push({ absolutePath, modifiedAt: fs.statSync(absolutePath).mtimeMs });
      }
    });
  };
  visit(sessionsRoot);
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const candidate of candidates) {
    try {
      const record = JSON.parse(fs.readFileSync(candidate.absolutePath, "utf8"));
      const submissionId = path.basename(path.dirname(candidate.absolutePath));
      if (record?.schemaVersion === "chenlong.run-record/v4"
        && /^sub_[a-f0-9]{32}$/.test(submissionId)) {
        if (requireMovement) {
          const frames = new ProductionReplayPlayer(record).trajectory();
          const firstFrame = frames[0];
          const hasMovement = frames.some((frame, index) => (
            index > 0
            && (frame.x !== firstFrame?.x || frame.z !== firstFrame?.z)
          ));
          if (!hasMovement) continue;
        }
        return { record, submissionId };
      }
    } catch {
      // Ignore a concurrently written or unrelated archive and try the next one.
    }
  }
  return null;
}

function sourceLine(pattern, description) {
  const match = appSource.match(pattern);
  assert.ok(match, `missing ${description}`);
  return match[0];
}

function functionSource(name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(appSource);
  assert.ok(declaration, `missing function ${name}`);
  const start = declaration.index;
  const signatureEnd = appSource.indexOf(") {", start + declaration[0].length);
  const openingBrace = signatureEnd < 0 ? -1 : signatureEnd + 2;
  assert.ok(openingBrace >= 0, `missing body for ${name}`);

  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingBrace; index < appSource.length; index += 1) {
    const character = appSource[index];
    const next = appSource[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return appSource.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated function ${name}`);
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  toggle(name, force) {
    const active = force === undefined ? !this.values.has(name) : Boolean(force);
    if (active) this.values.add(name);
    else this.values.delete(name);
    return active;
  }

  contains(name) {
    return this.values.has(name);
  }

  remove(name) {
    this.values.delete(name);
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.disabled = this.tagName === "BUTTON";
    this.hidden = false;
    this.open = false;
    this.textContent = "";
    this.value = "";
    this.title = "";
    this.href = "";
    this.download = "";
    this.clicked = 0;
    this.focused = 0;
    this.removed = false;
    this.parentElement = { setAttribute: (name, value) => this.attributes.set(`parent:${name}`, value) };
    this.span = tagName === "button" ? new FakeElement("span") : null;
    this.icon = tagName === "button" ? new FakeElement("i") : null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  listenerCount(type) {
    return (this.listeners.get(type) || []).length;
  }

  click() {
    if (this.disabled) return [];
    this.clicked += 1;
    const event = {
      type: "click",
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      }
    };
    this.lastEvent = event;
    return (this.listeners.get("click") || []).map(listener => listener.call(this, event));
  }

  querySelector(selector) {
    if (selector === "span") return this.span;
    if (selector === "i, svg") return this.icon;
    return null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  remove() {
    this.removed = true;
  }

  focus() {
    this.focused += 1;
  }
}

function createHarness({
  withRecord = true,
  withSession = true,
  submissionGate = null,
  submissionFailure = false,
  recordOverride = null,
  replayPlayerClass = null,
  runActive = false,
  activeCompetitionConfig = null,
  archiveSummary = null,
  archiveListGate = null,
  archiveRecordGate = null,
  archiveListFailure = false,
  archiveRecordFailure = false,
  archiveResponseDigest = null,
  archiveRecordStatus = null,
  replaySleepGate = null
} = {}) {
  const buttons = Object.fromEntries([
    "#replayRunRecordButton",
    "#exportRunRecordButton",
    "#verifyRunRecordButton",
    "#submitRunRecordButton"
  ].map(selector => [selector, new FakeElement("button")]));
  const elements = {
    ...buttons,
    "#recordsNavLink": new FakeElement("button"),
    "#competitionRecordsDialog": new FakeElement("dialog"),
    "#closeCompetitionRecordsButton": new FakeElement("button"),
    "#pendingCompetitionRecord": new FakeElement("section"),
    "#pendingCompetitionRecordTitle": new FakeElement("h3"),
    "#pendingCompetitionRecordSummary": new FakeElement("p"),
    "#submitPendingRunRecordButton": new FakeElement("button"),
    "#refreshCompetitionRecordsButton": new FakeElement("button"),
    "#competitionRecordsStatus": new FakeElement("p"),
    "#competitionRecordsList": new FakeElement("div"),
    "#pythonEditor": new FakeElement("textarea"),
    "#competitionLatestEvent": new FakeElement(),
    "#competitionVerifierHealth": new FakeElement(),
    "#competitionVerifierResult": new FakeElement(),
    "#competitionSubmissionResult": new FakeElement(),
    "#competitionRecordActionStatus": new FakeElement()
  };
  for (const selector of [
    "#recordsNavLink",
    "#closeCompetitionRecordsButton",
    "#submitPendingRunRecordButton",
    "#refreshCompetitionRecordsButton"
  ]) elements[selector].disabled = false;
  elements["#recordsNavLink"].setAttribute("aria-expanded", "false");
  elements["#pendingCompetitionRecord"].dataset.recordState = "empty";
  elements["#submitPendingRunRecordButton"].hidden = true;
  elements["#pythonEditor"].value = "# unsaved editor sentinel";
  const anchors = [];
  const blobs = [];
  const revokedUrls = [];
  const appended = [];
  const statuses = [];
  const logs = [];
  const replayCalls = [];
  const requests = [];
  const navigations = [];
  const authenticationRedirects = [];
  let draftSaved = false;
  let savedRecordSubmitted = false;
  let submitted = false;

  const record = Object.freeze(recordOverride || {
    schemaVersion: "chenlong.run-record/v4",
    runId: "run_click_regression",
    serverSessionId: "ses_11111111111111111111111111111111",
    challengeDigest: "a".repeat(64)
  });
  const serverSession = Object.freeze({
    sessionId: record.serverSessionId,
    runId: record.runId,
    challengeDigest: record.challengeDigest,
    submitToken: "t".repeat(43),
    expiresAt: "2099-01-01T00:00:00.000Z"
  });
  const archivedRecordBytes = Buffer.from(JSON.stringify(record), "utf8");
  const archivedRecordDigest = crypto.createHash("sha256").update(archivedRecordBytes).digest("hex");
  const hydratedArchiveSummary = archiveSummary
    ? Object.freeze({
        ...archiveSummary,
        recordSha256: archiveSummary.recordSha256 || archivedRecordDigest,
        recordByteLength: archiveSummary.recordByteLength || archivedRecordBytes.byteLength
      })
    : null;

  class FakeBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.type = options?.type;
      this.native = new globalThis.Blob(parts, options);
      blobs.push(this);
    }

    stream() {
      return this.native.stream();
    }
  }

  class FakeReplayPlayer {
    constructor(value) {
      replayCalls.push(["construct", value]);
      this.mode = "deterministic";
    }

    trajectory() {
      replayCalls.push(["trajectory"]);
      return [{
        x: 1,
        z: 2,
        heading: 0.5,
        linearSpeed: 0,
        angularSpeed: 0,
        elapsedMs: 0
      }];
    }

    verify() {
      replayCalls.push(["verify"]);
      return { ok: true, mismatches: [], diagnostics: [] };
    }
  }

  const document = {
    querySelector(selector) {
      return elements[selector] || null;
    },
    createElement(tagName) {
      const element = new FakeElement(tagName);
      if (tagName === "a") anchors.push(element);
      return element;
    },
    body: {
      append(element) {
        appended.push(element);
      }
    }
  };

  const verification = Object.freeze({
    schemaVersion: "chenlong.verification-report/v1",
    status: "verified",
    reasonCodes: [],
    authoritative: false,
    visionStatus: "not_used",
    verificationScope: {
      deterministic: {
        status: "complete",
        domains: ["control_inputs", "physics", "interactions", "task", "rules", "score"]
      },
      vision: "not_used"
    },
    capabilities: {
      deterministicRecomputationComplete: true,
      recomputationComplete: true
    },
    replay: { mismatchCount: 0 }
  });
  async function requestEndpoint(endpoint, options, _timeoutMs, signal) {
    requests.push({ endpoint, options, signal, transport: "requestVerificationEndpoint" });
    if (/^\/api\/v1\/records\?limit=(?:1|12|1000)$/.test(endpoint)) {
      if (archiveListGate) await archiveListGate;
      if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
      if (archiveListFailure) throw new Error("比赛存档列表暂不可用");
      return {
        response: { ok: true, status: 200 },
        payload: {
          schemaVersion: "chenlong.records/v1",
          authoritative: false,
          records: hydratedArchiveSummary
            ? [hydratedArchiveSummary]
            : savedRecordSubmitted ? [{
                id: "sub_11111111111111111111111111111111",
                submissionId: "sub_11111111111111111111111111111111",
                runId: record.runId,
                taskName: record.taskName || "广阳岛综合巡检",
                score: record.result?.score || 0,
                recordState: "submitted",
                status: "verified",
                savedAt: "2026-08-20T00:00:00.000Z",
                submittedAt: "2026-08-20T00:00:01.000Z",
                receivedAt: "2026-08-20T00:00:01.000Z",
                verification
              }]
            : submitted ? [{
                id: "sub_22222222222222222222222222222222",
                submissionId: "sub_22222222222222222222222222222222",
                runId: record.runId,
                taskName: record.taskName || "广阳岛综合巡检",
                score: record.result?.score || 0,
                recordState: "submitted",
                status: "verified",
                savedAt: "2026-08-20T00:00:00.000Z",
                submittedAt: "2026-08-20T00:00:01.000Z",
                receivedAt: "2026-08-20T00:00:00.000Z",
                verification
              }] : draftSaved ? [{
                id: "sub_11111111111111111111111111111111",
                submissionId: null,
                runId: record.runId,
                taskName: record.taskName || "广阳岛综合巡检",
                score: record.result?.score || 0,
                recordState: "saved",
                status: "pending",
                savedAt: "2026-08-20T00:00:00.000Z",
                submittedAt: null,
                verification: null
              }] : []
        }
      };
    }
    if (endpoint === "/api/v1/verify-run-record") {
      return { response: { ok: true, status: 200 }, payload: verification };
    }
    if (endpoint === `/api/v1/sessions/${serverSession.sessionId}/drafts`) {
      draftSaved = true;
      return {
        response: { ok: true, status: 201 },
        payload: {
          schemaVersion: "chenlong.record-draft-receipt/v1",
          recordId: "sub_11111111111111111111111111111111",
          sessionId: serverSession.sessionId,
          savedAt: "2026-08-20T00:00:00.000Z",
          duplicate: false,
          recordState: "saved",
          authoritative: false
        }
      };
    }
    if (endpoint === "/api/v1/records/sub_11111111111111111111111111111111/submit") {
      savedRecordSubmitted = true;
      return {
        response: { ok: true, status: 201 },
        payload: {
          schemaVersion: "chenlong.record-submit-receipt/v1",
          recordId: "sub_11111111111111111111111111111111",
          submissionId: "sub_11111111111111111111111111111111",
          submittedAt: "2026-08-20T00:00:01.000Z",
          duplicate: false,
          recordState: "submitted",
          authoritative: false,
          verification
        }
      };
    }
    assert.equal(endpoint, `/api/v1/sessions/${serverSession.sessionId}/submissions`);
    if (submissionGate) await submissionGate;
    if (submissionFailure) throw new Error("submission unavailable");
    submitted = true;
    return {
      response: { ok: true, status: 201 },
      payload: {
        schemaVersion: "chenlong.submission-receipt/v1",
        submissionId: "sub_22222222222222222222222222222222",
        sessionId: serverSession.sessionId,
        challengeDigest: serverSession.challengeDigest,
        duplicate: false,
        authoritative: false,
        verification
      }
    };
  }

  async function fetchEndpoint(endpoint, options) {
    requests.push({ endpoint, options, transport: "fetch" });
    const expectedSubmissionId = hydratedArchiveSummary?.submissionId || hydratedArchiveSummary?.id;
    assert.equal(endpoint, `/api/v1/records/${expectedSubmissionId}/run-record`);
    if (archiveRecordGate) await archiveRecordGate;
    if (options?.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    const failureStatus = archiveRecordStatus || (archiveRecordFailure ? 503 : 0);
    const responsePayload = failureStatus
      ? { error: { message: "后台原始运行记录暂不可用" } }
      : record;
    const bytes = Buffer.from(JSON.stringify(responsePayload), "utf8");
    const responseSha256 = archiveResponseDigest === null
      ? crypto.createHash("sha256").update(bytes).digest("hex")
      : archiveResponseDigest;
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return {
      ok: !failureStatus,
      status: failureStatus || 200,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-length") return String(bytes.byteLength);
          if (name.toLowerCase() === "x-content-sha256") return responseSha256;
          return null;
        }
      },
      body: null,
      async arrayBuffer() { return arrayBuffer; }
    };
  }

  const context = vm.createContext({
    AbortController,
    Blob: FakeBlob,
    CompressionStream,
    DOMException,
    CompetitionCore: {
      ReplayPlayer: replayPlayerClass || FakeReplayPlayer,
      SCHEMA_VERSION: "chenlong.run-record/v4",
      COMPETITION_SCORE_MAXIMUM: 100,
      GUANGYANG_CHALLENGE_CONFIGS: [1, 2, 3].map(index => ({ taskId: `R2-GYI-MVP-0${index}` }))
    },
    ChenlongAdminTeamScores: PersonalScoreRules,
    crypto: crypto.webcrypto,
    chenlongRedirectToLogin(reason) { authenticationRedirects.push(reason); },
    URL: {
      createObjectURL(blob) {
        assert.ok(blobs.includes(blob));
        return `blob:click-test-${blobs.indexOf(blob)}`;
      },
      revokeObjectURL(value) {
        revokedUrls.push(value);
      }
    },
    __appended: appended,
    __activeCompetitionConfig: activeCompetitionConfig,
    __logs: logs,
    __record: withRecord ? record : null,
    __replayCalls: replayCalls,
    __request: requestEndpoint,
    __replaySleepGate: replaySleepGate,
    __runActive: runActive,
    __serverSession: withSession ? serverSession : null,
    __statuses: statuses,
    clearTimeout() {},
    document,
    encodeURIComponent,
    fetch: fetchEndpoint,
    Response,
    setTimeout(callback, delay = 0) {
      if (delay === 0) callback();
      return 1;
    },
    window: {
      lucide: { createIcons() {} },
      location: { assign(value) { navigations.push(value); } }
    },
    TextDecoder,
    TextEncoder
  });

  const declarations = [
    ["replayRunRecordButton", "#replayRunRecordButton"],
    ["exportRunRecordButton", "#exportRunRecordButton"],
    ["verifyRunRecordButton", "#verifyRunRecordButton"],
    ["submitRunRecordButton", "#submitRunRecordButton"],
    ["competitionLatestEvent", "#competitionLatestEvent"],
    ["competitionVerifierHealth", "#competitionVerifierHealth"],
    ["competitionVerifierResult", "#competitionVerifierResult"],
    ["competitionSubmissionResult", "#competitionSubmissionResult"],
    ["competitionRecordActionStatus", "#competitionRecordActionStatus"],
    ["recordsNavLink", "#recordsNavLink"],
    ["competitionRecordsDialog", "#competitionRecordsDialog"],
    ["closeCompetitionRecordsButton", "#closeCompetitionRecordsButton"],
    ["pendingCompetitionRecord", "#pendingCompetitionRecord"],
    ["pendingCompetitionRecordTitle", "#pendingCompetitionRecordTitle"],
    ["pendingCompetitionRecordSummary", "#pendingCompetitionRecordSummary"],
    ["submitPendingRunRecordButton", "#submitPendingRunRecordButton"],
    ["refreshCompetitionRecordsButton", "#refreshCompetitionRecordsButton"],
    ["competitionRecordsStatus", "#competitionRecordsStatus"],
    ["competitionRecordsList", "#competitionRecordsList"],
    ["competitionTaskHighScores", "#competitionTaskHighScores"]
  ].map(([name, selector]) => sourceLine(
    new RegExp(`const\\s+${name}\\s*=\\s*document\\.querySelector\\(["']${selector}["']\\);`),
    `${name} DOM lookup`
  ));
  const productionFunctions = [
    "setVerificationServiceHealth",
    "setCompetitionVerificationResult",
    "setCompetitionRecordActionStatus",
    "updateServerVerificationButton",
    "recordMatchesCompetitionServerSession",
    "recordMatchesActiveServerSession",
    "normalizeRecordServiceError",
    "formatUploadByteLength",
    "prepareCompetitionRecordUpload",
    "validateCompetitionDraftReceipt",
    "saveCompetitionRecordDraft",
    "setCompetitionSubmissionResult",
    "updateCompetitionSubmissionButton",
    "extractVerificationReport",
    "verificationScopeSummary",
    "verificationStatusLabel",
    "verificationReportMessage",
    "explainMissingCompetitionRecord",
    "handleCompetitionAuthenticationFailure",
    "readBoundedResponseBytes",
    "readBoundedResponseText",
    "sha256Hex",
    "requestArchivedRunRecord",
    "loadLatestArchivedCompetitionRecord",
    "cancelArchivedCompetitionRecordLoad",
    "ensureLatestCompetitionRecord",
    "verifyLatestCompetitionRecordOnServer",
    "performLatestCompetitionRecordSubmission",
    "submitLatestCompetitionRecord",
    "competitionRecordAlreadyArchived",
    "competitionRecordStatusLabel",
    "formatCompetitionRecordTime",
    "renderPendingCompetitionRecord",
    "submitSavedCompetitionRecord",
    "renderCompetitionTaskHighScores",
    "renderCompetitionRecordsList",
    "loadCompetitionRecordsPreview",
    "closeCompetitionRecords",
    "openCompetitionRecords",
    "submitPendingCompetitionRecord",
    "commitCompetitionRecord",
    "exportLatestCompetitionRecord",
    "setReplayButtonState",
    "stopCompetitionReplay",
    "applyReplayPackageFrame",
    "replayLatestCompetitionRecord"
  ].map(functionSource);
  const bindings = [
    "exportRunRecordButton",
    "replayRunRecordButton",
    "verifyRunRecordButton",
    "submitRunRecordButton"
  ].map(name => sourceLine(
    new RegExp(`${name}\\?\\.addEventListener\\(["']click["'],\\s*[A-Za-z0-9_]+\\);`),
    `${name} click listener`
  ));
  bindings.push(sourceLine(
    /recordsNavLink\?\.addEventListener\(["']click["'],\s*openCompetitionRecords\);/,
    "recordsNavLink click listener"
  ));
  for (const [name, handler] of [
    ["closeCompetitionRecordsButton", "closeCompetitionRecords"],
    ["submitPendingRunRecordButton", "submitPendingCompetitionRecord"],
    ["refreshCompetitionRecordsButton", "loadCompetitionRecordsPreview"]
  ]) {
    bindings.push(sourceLine(
      new RegExp(`${name}\\?\\.addEventListener\\(["']click["'],\\s*${handler}\\);`),
      `${name} click listener`
    ));
  }

  const harnessSource = `
    "use strict";
    ${declarations.join("\n")}
    let latestCompetitionRecord = __record;
    let activeCompetitionServerSession = __serverSession;
    let latestCompetitionSubmissionReceipt = null;
    let latestCompetitionDraftRecordId = null;
    let serverVerificationRequestSerial = 0;
    let serverVerificationInFlight = false;
    let serverVerificationAbortController = null;
    let competitionSubmissionRequestSerial = 0;
    let competitionSubmissionInFlight = false;
    let competitionSubmissionAbortController = null;
    let competitionSubmissionOperation = null;
    const competitionDraftSaveOperations = new WeakMap();
    const pendingCompetitionDraftSaveOperations = new Set();
    const competitionRecordSubmitOperations = new Map();
    let competitionRecordsRequestSerial = 0;
    let competitionRecordsAbortController = null;
    let competitionRunStartPending = false;
    let replayRecordLoading = false;
    let archivedReplayLoadPromise = null;
    let archivedRecordLoadAbortController = null;
    let archivedRecordLoadGeneration = 0;
    let replayRecordLoadOperation = null;
    let replayPlayer = null;
    let replayRunning = false;
    let replayStopRequested = false;
    let running = __runActive;
    let activeMission = __activeCompetitionConfig
      ? { competition: { config: __activeCompetitionConfig } }
      : {};
    let missionAttempt = {
      taskEngine: {
        noteCollision(colliderId) {
          __replayCalls.push(["noteCollision", colliderId]);
          return true;
        }
      }
    };
    let robotPose = { x: 0, z: 0, heading: 0 };
    let robotLinearSpeed = 0;
    let robotSteering = 0;
    let heldPackageId = null;
    let heldPackageMesh = null;
    const packageMeshes = [];
    const obstacleMeshes = [];
    const robotClaw = null;
    const robotArm = null;
    const scene = { add(mesh) { mesh.parent = scene; } };
    const PHYSICS_EPSILON = 1e-9;
    const RUN_RECORD_VERIFICATION_ENDPOINT = "/api/v1/verify-run-record";
    const PERSONAL_RECORDS_ENDPOINT = "/api/v1/records";
    const GUANGYANG_CHALLENGE_CONFIGS = globalThis.CompetitionCore.GUANGYANG_CHALLENGE_CONFIGS;
    const PERSONAL_SCORE_RULES = globalThis.ChenlongAdminTeamScores;
    const COMPETITION_SCORE_MAXIMUM = globalThis.CompetitionCore.COMPETITION_SCORE_MAXIMUM;
    const RUN_RECORD_VERIFICATION_TIMEOUT_MS = 30000;
    const MAX_ARCHIVED_REPLAY_RESPONSE_BYTES = 40 * 1024 * 1024;
    const RUN_RECORD_COMPRESSION_THRESHOLD_BYTES = 128 * 1024;
    const SUBMISSION_RECEIPT_SCHEMA_VERSION = "chenlong.submission-receipt/v1";
    const RECORD_DRAFT_RECEIPT_SCHEMA_VERSION = "chenlong.record-draft-receipt/v1";
    const RECORD_SUBMIT_RECEIPT_SCHEMA_VERSION = "chenlong.record-submit-receipt/v1";
    const PACKAGE_STACK_STEP = 0.35;
    function requestVerificationEndpoint(endpoint, options, timeoutMs, signal) {
      return __request(endpoint, options, timeoutMs, signal);
    }
    function probeVerificationService() { __logs.push(["probe"]); }
    function addLog(message, important = false) { __logs.push([message, important]); }
    function setStatus(message) { __statuses.push(message); }
    function clearCompetitionTimers() { __logs.push(["clearTimers"]); }
    function resetCompetitionVerificationResult() { __logs.push(["resetVerification"]); }
    function resetCompetitionSubmissionState(options) { __logs.push(["resetSubmission", options]); }
    function renderCompetitionHud() { __logs.push(["renderHud"]); }
    function restoreMissionBaseline() { __replayCalls.push(["restore"]); }
    function guangyangMissionFromFrozenRecord() { return null; }
    function resetRobot() { __replayCalls.push(["resetRobot"]); }
    function rebuildSceneObjects() { __replayCalls.push(["rebuildScene"]); }
    function initializeMissionAttempt() {
      missionAttempt = {
        taskEngine: {
          noteCollision(colliderId) {
            __replayCalls.push(["noteCollision", colliderId]);
            return true;
          }
        }
      };
      __replayCalls.push(["initializeMission"]);
    }
    function resetTrajectory() { __replayCalls.push(["resetTrajectory"]); }
    function clearActionLog() { __replayCalls.push(["clearLog"]); }
    function setCameraMode(mode) { __replayCalls.push(["cameraMode", mode]); }
    function syncRobot() {
      __replayCalls.push(["syncRobot", {
        x: robotPose.x,
        z: robotPose.z,
        heading: robotPose.heading
      }]);
    }
    function evaluateMissionProgress() { __replayCalls.push(["evaluate"]); }
    function spinDriveWheels() { __replayCalls.push(["spinDrive"]); }
    function spinTurnWheels() { __replayCalls.push(["spinTurn"]); }
    function addTrajectoryPoint() { __replayCalls.push(["trajectoryPoint"]); }
    function updateRobotTelemetry() { __replayCalls.push(["telemetry"]); }
    function ensureMissionPackages() { return activeMission.packages || []; }
    function packageStackKey(x, z) { return x + ":" + z; }
    function packageStackLevelForIndex() { return 0; }
    function currentPackageBaseY() { return 0; }
    function addPackageMarker(record, stackLevel, index) {
      packageMeshes.push({
        visible: true,
        parent: scene,
        userData: { packageId: record.id, stackLevel, packageIndex: index },
        position: { set() {} },
        rotation: { set() {} },
        scale: { set() {}, setScalar() {} },
        removeFromParent() { this.parent = null; }
      });
    }
    function rebuildRobotCollisionShapes() { __replayCalls.push(["rebuildCollisions"]); }
    function markSceneShadowDirty() { __replayCalls.push(["shadowDirty"]); }
    function sleep(delay) {
      __replayCalls.push(["sleep", delay]);
      return __replaySleepGate || Promise.resolve();
    }
    ${productionFunctions.join("\n")}
    exportRunRecordButton.disabled = false;
    replayRunRecordButton.disabled = false;
    updateServerVerificationButton();
    updateCompetitionSubmissionButton();
    ${bindings.join("\n")}
  `;
  vm.runInContext(harnessSource, context, { filename: "app-button-harness.js" });

  return {
    anchors,
    appended,
    authenticationRedirects,
    blobs,
    buttons,
    context,
    elements,
    logs,
    navigations,
    record,
    replayCalls,
    requests,
    revokedUrls,
    serverSession,
    statuses
  };
}

async function clickAndWait(button) {
  const results = button.click();
  await Promise.all(results.filter(value => value && typeof value.then === "function"));
}

test("blocked competition release keeps the held object and closed gripper", () => {
  const classifierSource = functionSource("classifyCompetitionReleaseResult");
  const classify = vm.runInNewContext(`${classifierSource}; classifyCompetitionReleaseResult`, Object.create(null));
  assert.equal(classify(null, true), "local");
  assert.equal(classify({ accepted: true }, true), "accepted");
  assert.equal(classify({ accepted: false, reason: "blocked" }, true), "blocked-held");
  assert.equal(classify({ accepted: false, reason: "blocked" }, false), "empty");
  assert.equal(classify({ accepted: false, reason: "invalid_drop" }, true), "rejected-held");

  const robotApi = functionSource("makeSimRobotApi");
  assert.match(robotApi, /classifyCompetitionReleaseResult\(interactionResult,\s*isHoldingPackage\(\)\)/);
  assert.match(robotApi, /releaseState\s*===\s*["']blocked-held["'][\s\S]*放置点被障碍占用/);
  assert.match(robotApi, /夹爪继续持有[\s\S]*liftArmToCarryPosition[\s\S]*settleGripperVisual\(true\)/);
  assert.match(robotApi, /competitionSession\?\.status\s*!==\s*["']running["'][\s\S]{0,120}settleGripperVisual\(isHoldingPackage\(\)\)/);
  const blockedBranchIndex = robotApi.indexOf('releaseState === "blocked-held"');
  assert.ok(
    blockedBranchIndex >= 0 && blockedBranchIndex < robotApi.indexOf("animateGripper(false)", blockedBranchIndex),
    "blocked releases must return before the normal gripper-opening path"
  );
});

test("Guangyang task builder preserves v2 compatibility and builds v5 road-clearance removal", () => {
  const builderSource = functionSource("buildGuangyangCompositeTask");
  const builder = vm.runInNewContext(
    `${builderSource}; buildGuangyangCompositeTask`,
    { normalizeGuangyangObjectRole: value => String(value || "") }
  );
  const overlay = {
    objects: [
      { id: "target-a", role: "target", position: [0, 0], radius: 0.28 },
      { id: "distractor-a", role: "distractor", position: [1, 0], radius: 0.28 },
      { id: "obstacle-a", role: "obstacle", position: [2, 0], radius: 0.52 }
    ],
    zones: [
      { id: "storage-a", role: "storage", position: [3, 0], radius: 0.95 },
      { id: "cleanup-a", role: "cleanup", position: [4, 0], radius: 0.95 }
    ]
  };
  const v2 = builder({ task: { type: "composite", schemaVersion: "chenlong.task/v2" } }, overlay);
  assert.equal(v2.schemaVersion, "chenlong.task/v2");
  assert.equal(Object.prototype.hasOwnProperty.call(v2, "avoidanceObjectIds"), false);

  const v3 = builder({ task: { type: "composite", schemaVersion: "chenlong.task/v3" } }, overlay);
  assert.equal(v3.schemaVersion, "chenlong.task/v3");
  assert.deepEqual(JSON.parse(JSON.stringify(v3.avoidanceObjectIds)), ["obstacle-a"]);

  const roads = [{ id: "road-a", width: 2, points: [[0, 0], [5, 0]] }];
  const v5 = builder({ roads, task: { type: "composite", schemaVersion: "chenlong.task/v5" } }, overlay);
  assert.equal(v5.schemaVersion, "chenlong.task/v5");
  assert.deepEqual(JSON.parse(JSON.stringify(v5.avoidanceObjectIds)), ["obstacle-a"]);
  assert.deepEqual(JSON.parse(JSON.stringify(v5.placementGeometry)), { roads });
  const removal = v5.deliveries.find(item => item.objectRole === "distractor");
  assert.equal(removal.placementRule, "road-edge-clearance");
  assert.equal(removal.minimumRoadEdgeClearance, 0.2);
  assert.equal(removal.objectRadius, 0.28);
  assert.equal(Object.prototype.hasOwnProperty.call(removal, "destination"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(removal, "radius"), false);
});

test("same-map distractor training derives its completion rule from formal task v5", () => {
  const completionBuilderSource = functionSource("buildGuangyangRoadClearanceTrainingCompletion");
  const completionBuilder = vm.runInNewContext(
    `${completionBuilderSource}; buildGuangyangRoadClearanceTrainingCompletion`,
    { structuredClone }
  );
  const roads = [{ id: "road-a", width: 2, points: [[-5, 0], [5, 0]] }];
  const config = {
    task: {
      schemaVersion: "chenlong.task/v5",
      deliveries: [{
        id: "remove-distractor",
        objectRole: "distractor",
        destinationRole: "offroad-removal",
        placementRule: "road-edge-clearance",
        objectRadius: 0.28,
        minimumRoadEdgeClearance: 0.2,
        requiredPackageIds: ["distractor-a"]
      }],
      placementGeometry: { roads }
    }
  };
  const completion = completionBuilder({ id: "distractor-a" }, config);
  assert.deepEqual(JSON.parse(JSON.stringify(completion)), {
    type: "offroad-removal",
    placementRule: "road-edge-clearance",
    objectRadius: 0.28,
    minimumRoadEdgeClearance: 0.2,
    placementGeometry: { roads },
    requiredPackageIds: ["distractor-a"]
  });
  assert.equal(Object.prototype.hasOwnProperty.call(completion, "destination"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(completion, "radius"), false);
  completion.placementGeometry.roads[0].width = 9;
  assert.equal(config.task.placementGeometry.roads[0].width, 2, "training must clone the frozen formal geometry");
  assert.throws(
    () => completionBuilder({ id: "distractor-a" }, {
      task: { ...config.task, schemaVersion: "chenlong.task/v4" }
    }),
    /缺少正式 v5 道路边界判定/
  );
  assert.throws(
    () => completionBuilder({ id: "distractor-a" }, {
      task: {
        ...config.task,
        deliveries: [{
          ...config.task.deliveries[0],
          placementRule: "fixed-offroad-zone",
          destination: [4, 4],
          radius: 0.8
        }]
      }
    }),
    /缺少正式 v5 道路边界判定/
  );
});

test("same-map off-road training never reaches TaskEngine and requires grab then release", () => {
  let taskEngineConstructionCount = 0;
  const createEngineSource = functionSource("createMissionTaskEngine");
  const createEngine = vm.runInNewContext(
    `${createEngineSource}; createMissionTaskEngine`,
    {
      CompetitionCore: {
        TaskEngine: class {
          constructor() {
            taskEngineConstructionCount += 1;
          }
        }
      }
    }
  );
  assert.equal(createEngine({ type: "offroad-removal" }, [], []), null);
  assert.equal(taskEngineConstructionCount, 0, "training-only completion type must not reach TaskEngine");

  const packages = [{ id: "distractor-a", x: 0, z: 2, radius: 0.28 }];
  const missionAttempt = {
    spec: {
      type: "offroad-removal",
      placementRule: "road-edge-clearance",
      objectRadius: 0.28,
      minimumRoadEdgeClearance: 0.2,
      placementGeometry: {
        roads: [{ id: "road-a", width: 2, points: [[-5, 0], [5, 0]] }]
      }
    },
    requiredPackageIds: new Set(["distractor-a"]),
    deliveredPackageIds: new Set(),
    roadClearanceHandledPackageIds: new Set(),
    completed: false
  };
  const evaluatorContext = vm.createContext({
    CompetitionCore: { geometry: ProductionGeometry },
    PHYSICS_EPSILON: 1e-9,
    missionAttempt,
    heldPackageId: null,
    competitionSession: null,
    replayRunning: false,
    activeMission: { packageRadius: 0.28 },
    PACKAGE_RADIUS: 0.28,
    isCompetitionMission: () => false,
    ensureMissionPackages: () => packages,
    renderMissionProgress: () => {},
    addLog: () => {},
    completeMissionAttempt: () => { throw new Error("allowComplete:false must not finish the harness"); }
  });
  const evaluatorSource = functionSource("evaluateMissionProgress");
  vm.runInContext(`${evaluatorSource}; globalThis.evaluateTrainingProgress = evaluateMissionProgress;`, evaluatorContext);
  const evaluate = () => vm.runInContext(
    "evaluateTrainingProgress({ allowComplete: false, announce: false })",
    evaluatorContext
  );

  assert.equal(evaluate(), false, "an object pushed or initially placed outside must not complete training");
  assert.equal(missionAttempt.deliveredPackageIds.size, 0);
  assert.equal(missionAttempt.roadClearanceHandledPackageIds.size, 0);

  packages[0].z = 0;
  evaluatorContext.heldPackageId = "distractor-a";
  assert.equal(evaluate(), false, "a currently held object must not count as released");
  assert.deepEqual([...missionAttempt.roadClearanceHandledPackageIds], ["distractor-a"]);

  evaluatorContext.heldPackageId = null;
  assert.equal(evaluate(), false, "releasing back onto the road must not complete training");
  assert.equal(missionAttempt.deliveredPackageIds.size, 0);

  evaluatorContext.heldPackageId = "distractor-a";
  packages[0].z = 2;
  assert.equal(evaluate(), false, "moving outside while still held must not complete training");
  evaluatorContext.heldPackageId = null;
  assert.equal(evaluate(), true, "a handled object released fully beyond every road edge must complete training");
  assert.deepEqual([...missionAttempt.deliveredPackageIds], ["distractor-a"]);
});

test("all four run-record buttons bind one live click listener", () => {
  const { buttons } = createHarness();
  for (const [selector, button] of Object.entries(buttons)) {
    assert.equal(button.listenerCount("click"), 1, `${selector} must bind exactly one click listener`);
    assert.equal(button.disabled, false, `${selector} must be enabled for a ready bound record`);
  }
});

test("buttons explain missing run prerequisites instead of ignoring clicks", async () => {
  const harness = createHarness({ withRecord: false, withSession: false });
  for (const button of Object.values(harness.buttons)) await clickAndWait(button);
  assert.equal(harness.requests.length, 4,
    "each independent action must check the user's backend archive after a refresh");
  assert.ok(harness.requests.every(request => request.endpoint === "/api/v1/records?limit=1"));
  assert.equal(harness.statuses.length, 8);
  assert.match(harness.statuses[0], /正在读取.*最近一次比赛存档/);
  assert.match(harness.statuses[1], /暂无可回放/);
  assert.match(harness.statuses[2], /正在读取.*以便导出/);
  assert.match(harness.statuses[3], /暂无可导出/);
  assert.match(harness.statuses[4], /正在读取.*以便校验/);
  assert.match(harness.statuses[5], /暂无可校验/);
  assert.match(harness.statuses[6], /正在读取.*以便提交/);
  assert.match(harness.statuses[7], /暂无可提交/);
  assert.match(harness.elements["#competitionVerifierResult"].textContent, /没有可校验的运行记录/);
  assert.match(harness.elements["#competitionSubmissionResult"].textContent, /没有可提交的运行记录/);
  assert.equal(harness.elements["#competitionRecordActionStatus"].dataset.status, "warning");
  assert.match(harness.elements["#competitionRecordActionStatus"].textContent, /提交未执行.*暂无运行记录/);
});

test("export click downloads the exact latest record and revokes its object URL", async () => {
  const harness = createHarness();
  await clickAndWait(harness.buttons["#exportRunRecordButton"]);
  assert.equal(harness.blobs.length, 1);
  assert.equal(harness.blobs[0].type, "application/json;charset=utf-8");
  assert.deepEqual(JSON.parse(harness.blobs[0].parts.join("")), harness.record);
  assert.equal(harness.anchors.length, 1);
  assert.equal(harness.anchors[0].download, `${harness.record.runId}.json`);
  assert.equal(harness.anchors[0].clicked, 1);
  assert.equal(harness.anchors[0].removed, true);
  assert.deepEqual(harness.appended, harness.anchors);
  assert.deepEqual(harness.revokedUrls, [harness.anchors[0].href]);
  assert.equal(harness.elements["#competitionRecordActionStatus"].dataset.status, "success");
  assert.match(harness.elements["#competitionRecordActionStatus"].textContent, new RegExp(harness.record.runId));
});

test("replay click constructs the real player path and reaches the completed status", async () => {
  const harness = createHarness();
  await clickAndWait(harness.buttons["#replayRunRecordButton"]);
  assert.equal(harness.replayCalls.some(([name, value]) => name === "construct" && value === harness.record), true);
  assert.equal(harness.replayCalls.some(([name]) => name === "trajectory"), true);
  assert.equal(harness.replayCalls.some(([name]) => name === "verify"), true);
  assert.equal(harness.replayCalls.some(([name]) => name === "syncRobot"), true);
  assert.equal(harness.statuses.at(-1), "确定性回放完成");
  assert.equal(harness.elements["#competitionRecordActionStatus"].dataset.status, "success");
  assert.equal(harness.elements["#competitionRecordActionStatus"].textContent, "确定性回放完成");
  assert.equal(harness.buttons["#replayRunRecordButton"].classList.contains("is-running"), false);
  assert.equal(harness.buttons["#replayRunRecordButton"].disabled, false);
});

test("replay feeds a recomputed avoidance collision into the page task engine before rendering progress", async () => {
  class CollisionReplayPlayer {
    constructor() {
      this.mode = "deterministic";
    }

    trajectory() {
      return [{
        x: -10.95,
        z: 2.08,
        heading: 0,
        linearSpeed: 0,
        angularSpeed: 0,
        elapsedMs: 20,
        collision: { colliderId: "object:guangyang-obstacle-1" }
      }];
    }

    verify() {
      return { ok: true, mismatches: [], diagnostics: [] };
    }
  }

  const harness = createHarness({ replayPlayerClass: CollisionReplayPlayer });
  await clickAndWait(harness.buttons["#replayRunRecordButton"]);

  const collisionIndex = harness.replayCalls.findIndex(([name, colliderId]) => (
    name === "noteCollision" && colliderId === "object:guangyang-obstacle-1"
  ));
  const progressIndex = harness.replayCalls.findIndex(([name]) => name === "evaluate");
  assert.ok(collisionIndex >= 0, "the replayed collision must reach TaskEngine.noteCollision");
  assert.ok(progressIndex > collisionIndex,
    "the failed avoidance state must be applied before the replay HUD evaluates progress");
});

test("a map-bound record refuses to replay outside its competition map", async () => {
  const record = Object.freeze({
    schemaVersion: "chenlong.run-record/v4",
    runId: "run_wrong_scene_regression",
    serverSessionId: "ses_12121212121212121212121212121212",
    challengeDigest: "c".repeat(64),
    mapId: "guangyang-island",
    mapVersion: "2026.08"
  });
  const harness = createHarness({
    recordOverride: record,
    withSession: false,
    activeCompetitionConfig: null
  });

  await clickAndWait(harness.buttons["#replayRunRecordButton"]);

  assert.equal(harness.replayCalls.some(([name]) => name === "construct"), false,
    "the replay engine must not start after the user has left the record's map");
  assert.equal(vm.runInContext("replayRunning", harness.context), false);
  assert.match(harness.statuses.at(-1), /请先切回这份记录对应版本的比赛地图/);
  assert.equal(harness.buttons["#replayRunRecordButton"].disabled, false);
});

test("an archived record refuses to render through a different task-version HUD", async () => {
  const record = Object.freeze({
    schemaVersion: "chenlong.run-record/v4",
    runId: "run_old_task_version_regression",
    serverSessionId: "ses_34343434343434343434343434343434",
    challengeDigest: "d".repeat(64),
    mapId: "guangyang-island",
    mapVersion: "2026.08-source-map.4",
    taskId: "guangyang-composite",
    taskDefinition: {
      id: "guangyang-composite",
      version: "2026.08-object-composite.2"
    }
  });
  const harness = createHarness({
    recordOverride: record,
    withSession: false,
    activeCompetitionConfig: {
      mapId: record.mapId,
      mapVersion: record.mapVersion,
      taskId: record.taskId,
      taskVersion: "2026.08-object-composite.3"
    }
  });

  await clickAndWait(harness.buttons["#replayRunRecordButton"]);

  assert.equal(harness.replayCalls.some(([name]) => name === "construct"), false,
    "the replay engine must not combine an archived task with the current task HUD");
  assert.equal(vm.runInContext("replayRunning", harness.context), false);
  assert.match(harness.statuses.at(-1), /旧版任务规则/);
  assert.match(harness.elements["#competitionRecordActionStatus"].textContent, /任务版本与当前任务不一致/);
  assert.equal(harness.buttons["#replayRunRecordButton"].disabled, false);
});

test("replay click drives multiple visible frames through the production v4 ReplayPlayer", async t => {
  const archive = loadLatestArchivedV4Record({ requireMovement: true });
  if (!archive) {
    t.skip("no local v4 submission archive is available");
    return;
  }
  const archivedRecord = archive.record;
  const expectedFrames = new ProductionReplayPlayer(archivedRecord).trajectory();
  assert.ok(expectedFrames.length > 2, "the archived fixture must exercise a multi-frame replay");
  assert.ok(expectedFrames.some((frame, index) => (
    index > 0
    && (frame.x !== expectedFrames[0].x || frame.z !== expectedFrames[0].z)
  )), "the archived fixture must contain visible vehicle movement");

  const harness = createHarness({
    recordOverride: archivedRecord,
    replayPlayerClass: ProductionReplayPlayer,
    withSession: false,
    activeCompetitionConfig: {
      mapId: archivedRecord.mapId,
      mapVersion: archivedRecord.mapVersion,
      taskId: archivedRecord.taskId
        || archivedRecord.taskDefinition?.id
        || archivedRecord.runDefinition?.taskDefinition?.id,
      taskVersion: archivedRecord.taskVersion
        || archivedRecord.taskDefinition?.version
        || archivedRecord.runDefinition?.taskDefinition?.version
    }
  });
  await clickAndWait(harness.buttons["#replayRunRecordButton"]);

  const renderedPoses = harness.replayCalls
    .filter(([name]) => name === "syncRobot")
    .map(([, pose]) => `${pose.x}:${pose.z}:${pose.heading}`);
  assert.equal(renderedPoses.length, expectedFrames.length,
    "every production replay frame must reach the scene synchronization path");
  assert.ok(new Set(renderedPoses).size > 1, "replay must render more than one vehicle pose");
  const delays = harness.replayCalls
    .filter(([name]) => name === "sleep")
    .map(([, delay]) => delay);
  assert.ok(delays.length > 0, "a real replay must yield between timed frames");
  assert.ok(delays.every(delay => delay > 0 && delay <= 80));
  assert.match(harness.statuses.at(-1), /回放完成/);
  assert.equal(harness.buttons["#replayRunRecordButton"].classList.contains("is-running"), false);
  assert.equal(harness.buttons["#replayRunRecordButton"].disabled, false);
});

test("replay click restores the latest archived v4 record after page memory is lost", async t => {
  const archive = loadLatestArchivedV4Record();
  if (!archive) {
    t.skip("no local v4 submission archive is available");
    return;
  }
  const archivedRecord = archive.record;
  const expectedFrames = new ProductionReplayPlayer(archivedRecord).trajectory();
  const archiveSummary = {
    submissionId: archive.submissionId,
    sessionId: archivedRecord.serverSessionId,
    runId: archivedRecord.runId,
    challengeDigest: archivedRecord.challengeDigest
  };
  const harness = createHarness({
    withRecord: false,
    withSession: false,
    recordOverride: archivedRecord,
    replayPlayerClass: ProductionReplayPlayer,
    archiveSummary,
    activeCompetitionConfig: {
      mapId: archivedRecord.mapId,
      mapVersion: archivedRecord.mapVersion,
      taskId: archivedRecord.taskId
        || archivedRecord.taskDefinition?.id
        || archivedRecord.runDefinition?.taskDefinition?.id,
      taskVersion: archivedRecord.taskVersion
        || archivedRecord.taskDefinition?.version
        || archivedRecord.runDefinition?.taskDefinition?.version
    }
  });

  await clickAndWait(harness.buttons["#replayRunRecordButton"]);

  assert.deepEqual(
    harness.requests.map(({ endpoint, transport }) => ({ endpoint, transport })),
    [
      { endpoint: "/api/v1/records?limit=1", transport: "requestVerificationEndpoint" },
      {
        endpoint: `/api/v1/records/${archive.submissionId}/run-record`,
        transport: "fetch"
      }
    ]
  );
  assert.equal(
    vm.runInContext("latestCompetitionRecord.runId", harness.context),
    archivedRecord.runId,
    "the raw archive must repopulate the page's volatile latest-record state"
  );
  assert.equal(
    vm.runInContext("latestCompetitionSubmissionReceipt.submissionId", harness.context),
    archive.submissionId
  );
  assert.equal(
    harness.replayCalls.filter(([name]) => name === "syncRobot").length,
    expectedFrames.length,
    "the recovered archive must immediately continue into real frame playback"
  );
  assert.equal(
    harness.replayCalls.some(([name, mode]) => name === "cameraMode" && mode === "follow"),
    true,
    "replay must select a camera mode that visibly follows the vehicle"
  );
  assert.match(harness.statuses.at(-1), /回放完成/);
  assert.equal(harness.buttons["#replayRunRecordButton"].attributes.get("aria-busy"), "false");
  assert.equal(harness.buttons["#replayRunRecordButton"].disabled, false);
  assert.equal(harness.buttons["#exportRunRecordButton"].disabled, false);
  assert.equal(harness.buttons["#verifyRunRecordButton"].disabled, false);
  assert.equal(harness.buttons["#submitRunRecordButton"].disabled, false,
    "an archived record stays clickable so the user gets an explicit already-saved result");
});

test("export, verify, and submit restore the archived record independently after refresh", async t => {
  const archivedRecord = Object.freeze({
    schemaVersion: "chenlong.run-record/v4",
    runId: "run_archived_button_hydration",
    serverSessionId: "ses_33333333333333333333333333333333",
    challengeDigest: "b".repeat(64)
  });
  const archiveSummary = Object.freeze({
    submissionId: "sub_44444444444444444444444444444444",
    sessionId: archivedRecord.serverSessionId,
    runId: archivedRecord.runId,
    challengeDigest: archivedRecord.challengeDigest
  });

  await t.test("export", async () => {
    const harness = createHarness({
      withRecord: false,
      withSession: false,
      recordOverride: archivedRecord,
      archiveSummary
    });
    await clickAndWait(harness.buttons["#exportRunRecordButton"]);
    assert.deepEqual(harness.requests.map(request => request.endpoint), [
      "/api/v1/records?limit=1",
      `/api/v1/records/${archiveSummary.submissionId}/run-record`
    ]);
    assert.equal(harness.blobs.length, 1);
    assert.equal(JSON.parse(harness.blobs[0].parts.join("")).runId, archivedRecord.runId);
    assert.equal(vm.runInContext("latestCompetitionRecord.runId", harness.context), archivedRecord.runId);
  });

  await t.test("verify", async () => {
    const harness = createHarness({
      withRecord: false,
      withSession: false,
      recordOverride: archivedRecord,
      archiveSummary
    });
    await clickAndWait(harness.buttons["#verifyRunRecordButton"]);
    assert.deepEqual(harness.requests.map(request => request.endpoint), [
      "/api/v1/records?limit=1",
      `/api/v1/records/${archiveSummary.submissionId}/run-record`,
      "/api/v1/verify-run-record"
    ]);
    assert.equal(harness.elements["#competitionVerifierResult"].dataset.status, "verified");
  });

  await t.test("submit", async () => {
    const harness = createHarness({
      withRecord: false,
      withSession: false,
      recordOverride: archivedRecord,
      archiveSummary
    });
    await clickAndWait(harness.buttons["#submitRunRecordButton"]);
    assert.deepEqual(harness.requests.map(request => request.endpoint), [
      "/api/v1/records?limit=1",
      `/api/v1/records/${archiveSummary.submissionId}/run-record`
    ], "an already archived record must not be posted as a duplicate submission");
    assert.equal(
      vm.runInContext("latestCompetitionSubmissionReceipt.submissionId", harness.context),
      archiveSummary.submissionId
    );
    assert.match(harness.statuses.at(-1), /已经存档，无需重复提交/);
  });
});

test("an invalid archived trajectory never contaminates volatile page state", async () => {
  const archivedRecord = Object.freeze({
    schemaVersion: "chenlong.run-record/v4",
    runId: "run_empty_archived_trajectory",
    serverSessionId: "ses_55555555555555555555555555555555",
    challengeDigest: "c".repeat(64)
  });
  const archiveSummary = Object.freeze({
    submissionId: "sub_66666666666666666666666666666666",
    sessionId: archivedRecord.serverSessionId,
    runId: archivedRecord.runId,
    challengeDigest: archivedRecord.challengeDigest
  });
  class EmptyReplayPlayer {
    trajectory() { return []; }
  }
  const harness = createHarness({
    withRecord: false,
    withSession: false,
    recordOverride: archivedRecord,
    replayPlayerClass: EmptyReplayPlayer,
    archiveSummary
  });

  await clickAndWait(harness.buttons["#exportRunRecordButton"]);

  assert.equal(vm.runInContext("latestCompetitionRecord", harness.context), null);
  assert.equal(vm.runInContext("latestCompetitionSubmissionReceipt", harness.context), null);
  assert.equal(harness.blobs.length, 0);
  assert.match(harness.statuses.at(-1), /后台存档读取失败.*没有可回放轨迹/);
});

test("an archived record is rejected before hydration when its response bytes fail SHA-256 verification", async () => {
  const archivedRecord = Object.freeze({
    schemaVersion: "chenlong.run-record/v4",
    runId: "run_archived_digest_mismatch",
    serverSessionId: "ses_77777777777777777777777777777777",
    challengeDigest: "d".repeat(64)
  });
  const forgedDigest = "f".repeat(64);
  const archiveSummary = Object.freeze({
    submissionId: "sub_88888888888888888888888888888888",
    sessionId: archivedRecord.serverSessionId,
    runId: archivedRecord.runId,
    challengeDigest: archivedRecord.challengeDigest,
    recordSha256: forgedDigest
  });
  const harness = createHarness({
    withRecord: false,
    withSession: false,
    recordOverride: archivedRecord,
    archiveSummary,
    archiveResponseDigest: forgedDigest
  });

  await clickAndWait(harness.buttons["#exportRunRecordButton"]);

  assert.equal(vm.runInContext("latestCompetitionRecord", harness.context), null);
  assert.equal(vm.runInContext("latestCompetitionSubmissionReceipt", harness.context), null);
  assert.equal(harness.blobs.length, 0);
  assert.match(harness.statuses.at(-1), /\u5b8c\u6574\u6027\u6821\u9a8c\u5931\u8d25/);
});

test("an expired login during archived replay redirects through the shared auth guard", async () => {
  const archivedRecord = Object.freeze({
    schemaVersion: "chenlong.run-record/v4",
    runId: "run_archived_auth_expired",
    serverSessionId: "ses_99999999999999999999999999999999",
    challengeDigest: "e".repeat(64)
  });
  const harness = createHarness({
    withRecord: false,
    withSession: false,
    recordOverride: archivedRecord,
    archiveSummary: {
      submissionId: "sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sessionId: archivedRecord.serverSessionId,
      runId: archivedRecord.runId,
      challengeDigest: archivedRecord.challengeDigest
    },
    archiveRecordStatus: 401
  });

  await clickAndWait(harness.buttons["#replayRunRecordButton"]);

  assert.deepEqual(harness.authenticationRedirects, ["authentication-required"]);
  assert.equal(vm.runInContext("latestCompetitionRecord", harness.context), null);
  assert.equal(harness.replayCalls.some(([name]) => name === "syncRobot"), false);
});

test("archived replay load failure stays visible and restores the replay button", async () => {
  const harness = createHarness({
    withRecord: false,
    withSession: false,
    archiveListFailure: true
  });
  const replayButton = harness.buttons["#replayRunRecordButton"];

  await clickAndWait(replayButton);

  assert.deepEqual(harness.requests.map(request => request.endpoint), ["/api/v1/records?limit=1"]);
  assert.match(harness.statuses.at(-1), /后台存档读取失败.*比赛存档列表暂不可用/);
  assert.equal(harness.logs.some(([message]) => /回放准备失败.*比赛存档列表暂不可用/.test(message)), true);
  assert.equal(vm.runInContext("latestCompetitionRecord", harness.context), null);
  assert.equal(vm.runInContext("replayRecordLoading", harness.context), false);
  assert.equal(replayButton.attributes.get("aria-busy"), "false");
  assert.equal(replayButton.disabled, false);
  assert.equal(replayButton.span.textContent, "回放本次运行");
  assert.equal(replayButton.classList.contains("is-running"), false);
});

test("raw archived-record failure does not enter playback or leave a stuck button", async t => {
  const archive = loadLatestArchivedV4Record();
  if (!archive) {
    t.skip("no local v4 submission archive is available");
    return;
  }
  const record = archive.record;
  const harness = createHarness({
    withRecord: false,
    withSession: false,
    recordOverride: record,
    replayPlayerClass: ProductionReplayPlayer,
    archiveSummary: {
      submissionId: archive.submissionId,
      sessionId: record.serverSessionId,
      runId: record.runId,
      challengeDigest: record.challengeDigest
    },
    archiveRecordFailure: true
  });
  const replayButton = harness.buttons["#replayRunRecordButton"];

  await clickAndWait(replayButton);

  assert.equal(harness.requests.length, 2);
  assert.match(harness.statuses.at(-1), /后台存档读取失败.*后台原始运行记录暂不可用/);
  assert.equal(harness.replayCalls.some(([name]) => name === "syncRobot"), false);
  assert.equal(vm.runInContext("latestCompetitionRecord", harness.context), null);
  assert.equal(replayButton.attributes.get("aria-busy"), "false");
  assert.equal(replayButton.disabled, false);
  assert.equal(replayButton.span.textContent, "回放本次运行");
});

test("archive loading keeps replay clickable so a second click cancels the shared request", async () => {
  let releaseArchiveList;
  const archiveListGate = new Promise(resolve => { releaseArchiveList = resolve; });
  const harness = createHarness({
    withRecord: false,
    withSession: false,
    archiveListGate
  });
  const replayButton = harness.buttons["#replayRunRecordButton"];

  const pendingClick = replayButton.click();
  assert.equal(vm.runInContext("replayRecordLoading", harness.context), true);
  assert.equal(replayButton.disabled, false);
  assert.equal(replayButton.attributes.get("aria-busy"), "true");
  assert.equal(replayButton.span.textContent, "取消载入");
  const cancelClick = replayButton.click();
  assert.equal(replayButton.clicked, 2);
  assert.equal(harness.requests.length, 1);
  assert.equal(vm.runInContext("replayRecordLoading", harness.context), false);
  assert.equal(replayButton.attributes.get("aria-busy"), "false");
  assert.equal(replayButton.span.textContent, "回放本次运行");
  assert.equal(harness.statuses.at(-1), "已取消后台存档载入");

  releaseArchiveList();
  await Promise.all([...pendingClick, ...cancelClick].filter(value => value && typeof value.then === "function"));

  assert.equal(harness.requests.length, 1);
  assert.equal(vm.runInContext("replayRecordLoading", harness.context), false);
  assert.equal(replayButton.attributes.get("aria-busy"), "false");
  assert.equal(replayButton.disabled, false);
  assert.equal(replayButton.span.textContent, "回放本次运行");
  assert.equal(vm.runInContext("latestCompetitionRecord", harness.context), null,
    "a canceled list request must not publish a late archive");
  assert.equal(harness.statuses.at(-1), "已取消后台存档载入");
});

test("the Stop path cancels an in-flight raw archive without publishing it late", async () => {
  let releaseArchiveRecord;
  const archiveRecordGate = new Promise(resolve => { releaseArchiveRecord = resolve; });
  const archivedRecord = Object.freeze({
    schemaVersion: "chenlong.run-record/v4",
    runId: "run_stop_archive_race",
    serverSessionId: "ses_77777777777777777777777777777777",
    challengeDigest: "d".repeat(64)
  });
  const archiveSummary = Object.freeze({
    submissionId: "sub_88888888888888888888888888888888",
    sessionId: archivedRecord.serverSessionId,
    runId: archivedRecord.runId,
    challengeDigest: archivedRecord.challengeDigest
  });
  const harness = createHarness({
    withRecord: false,
    withSession: false,
    recordOverride: archivedRecord,
    archiveSummary,
    archiveRecordGate
  });

  const pendingReplay = harness.buttons["#replayRunRecordButton"].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.requests.length, 2, "the raw-record request must be in flight");
  assert.equal(vm.runInContext("replayRecordLoading", harness.context), true);

  const canceled = vm.runInContext("stopCompetitionReplay()", harness.context);
  assert.equal(canceled, true);
  assert.equal(harness.requests[1].options.signal.aborted, true);
  assert.equal(vm.runInContext("replayRecordLoading", harness.context), false);
  assert.equal(harness.buttons["#replayRunRecordButton"].attributes.get("aria-busy"), "false");

  releaseArchiveRecord();
  await Promise.all(pendingReplay.filter(value => value && typeof value.then === "function"));
  assert.equal(vm.runInContext("latestCompetitionRecord", harness.context), null);
  assert.equal(vm.runInContext("latestCompetitionSubmissionReceipt", harness.context), null);
  assert.equal(harness.replayCalls.some(([name]) => name === "syncRobot"), false);
});

test("a new-run cancellation path aborts archive hydration started by another record action", async () => {
  const startSource = functionSource("startCompetitionRun");
  const cancelIndex = startSource.indexOf("stopCompetitionReplay({ restoreButton: false })");
  const clearIndex = startSource.indexOf("latestCompetitionRecord = null");
  assert.ok(cancelIndex >= 0 && cancelIndex < clearIndex,
    "a new competition run must cancel shared archive I/O before clearing volatile record state");
  assert.match(
    startSource,
    /setCompetitionRecordActionStatus\(\s*["']record["'],\s*["']idle["'],[\s\S]*?比赛运行中/,
    "a new run must replace stale replay/export/verification feedback"
  );
  assert.match(
    startSource,
    /expectedRunToken\s*!==\s*runToken[\s\S]*?setCompetitionRecordActionStatus\(\s*["']record["'],\s*["']warning["'],\s*["']比赛场次准备已取消["']\s*\)/,
    "a canceled session preparation must replace the temporary running feedback"
  );
  assert.match(functionSource("runProgram"),
    /replayRecordLoading\s*\|\|\s*archivedReplayLoadPromise\s*\|\|\s*replayRecordLoadOperation/);

  let releaseArchiveRecord;
  const archiveRecordGate = new Promise(resolve => { releaseArchiveRecord = resolve; });
  const archivedRecord = Object.freeze({
    schemaVersion: "chenlong.run-record/v4",
    runId: "run_new_run_archive_race",
    serverSessionId: "ses_99999999999999999999999999999999",
    challengeDigest: "e".repeat(64)
  });
  const archiveSummary = Object.freeze({
    submissionId: "sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sessionId: archivedRecord.serverSessionId,
    runId: archivedRecord.runId,
    challengeDigest: archivedRecord.challengeDigest
  });
  const harness = createHarness({
    withRecord: false,
    withSession: false,
    recordOverride: archivedRecord,
    archiveSummary,
    archiveRecordGate
  });

  const pendingExport = harness.buttons["#exportRunRecordButton"].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext("replayRecordLoading", harness.context), false,
    "non-replay hydration must still use the shared cancellable archive operation");
  assert.equal(harness.requests.length, 2);
  assert.equal(vm.runInContext("stopCompetitionReplay({ restoreButton: false })", harness.context), true);
  assert.equal(harness.requests[1].options.signal.aborted, true);

  releaseArchiveRecord();
  await Promise.all(pendingExport.filter(value => value && typeof value.then === "function"));
  assert.equal(vm.runInContext("latestCompetitionRecord", harness.context), null);
  assert.equal(harness.blobs.length, 0, "a canceled export must not download a late archive");
});

test("a second replay click stops an in-progress real v4 playback and restores controls", async t => {
  const archive = loadLatestArchivedV4Record();
  if (!archive) {
    t.skip("no local v4 submission archive is available");
    return;
  }
  let releaseReplaySleep;
  const replaySleepGate = new Promise(resolve => { releaseReplaySleep = resolve; });
  const harness = createHarness({
    recordOverride: archive.record,
    replayPlayerClass: ProductionReplayPlayer,
    withSession: false,
    activeCompetitionConfig: {
      mapId: archive.record.mapId,
      mapVersion: archive.record.mapVersion,
      taskId: archive.record.taskId || archive.record.taskDefinition?.id,
      taskVersion: archive.record.taskVersion || archive.record.taskDefinition?.version
    },
    replaySleepGate
  });
  const replayButton = harness.buttons["#replayRunRecordButton"];

  const playbackClick = replayButton.click();
  assert.equal(vm.runInContext("replayRunning", harness.context), true);
  assert.equal(replayButton.disabled, false, "the active replay button must remain clickable as a stop control");
  assert.equal(replayButton.attributes.get("aria-pressed"), "true");
  assert.equal(replayButton.span.textContent, "停止回放");
  assert.equal(replayButton.classList.contains("is-running"), true);

  const stopClick = replayButton.click();
  assert.equal(vm.runInContext("replayStopRequested", harness.context), true);
  releaseReplaySleep();
  await Promise.all([...playbackClick, ...stopClick].filter(value => value && typeof value.then === "function"));

  assert.equal(harness.statuses.at(-1), "回放已停止");
  assert.equal(vm.runInContext("replayRunning", harness.context), false);
  assert.equal(vm.runInContext("replayStopRequested", harness.context), false);
  assert.equal(replayButton.disabled, false);
  assert.equal(replayButton.attributes.get("aria-pressed"), "false");
  assert.equal(replayButton.span.textContent, "回放本次运行");
  assert.equal(replayButton.classList.contains("is-running"), false);
});

test("verify click posts the latest record and renders the verified state", async () => {
  const harness = createHarness();
  await clickAndWait(harness.buttons["#verifyRunRecordButton"]);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].endpoint, "/api/v1/verify-run-record");
  assert.equal(harness.requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(harness.requests[0].options.body), harness.record);
  assert.equal(harness.elements["#competitionVerifierResult"].dataset.status, "verified");
  assert.equal(harness.elements["#competitionRecordActionStatus"].dataset.status, "success");
  assert.match(harness.elements["#competitionRecordActionStatus"].textContent, /服务端校验完成.*确定性校验通过/);
  assert.match(harness.elements["#competitionVerifierResult"].textContent, /verified/);
  const limitedVisionMessage = vm.runInContext(`verificationReportMessage({
    status: "verified",
    reasonCodes: ["vision_detections_not_recomputed"],
    authoritative: false,
    replay: { mismatchCount: 0 }
  })`, harness.context);
  assert.match(limitedVisionMessage, /确定性校验通过.*视觉识别结果未重算/);
  assert.doesNotMatch(limitedVisionMessage, /vision_detections_not_recomputed/);
  assert.equal(vm.runInContext(`verificationStatusLabel("partial", {
    verificationScope: { deterministic: { status: "incomplete" } }
  })`, harness.context), "确定性校验不完整");
  assert.equal(
    vm.runInContext("verificationStatusLabel('partial', {})", harness.context),
    "旧版校验不完整",
    "a partial legacy report without an explicit scope must not claim deterministic coverage"
  );
  const scopeOnlyVisionMessage = vm.runInContext(`verificationReportMessage({
    status: "verified",
    reasonCodes: [],
    visionStatus: "not_recomputed",
    verificationScope: { deterministic: { status: "complete" }, vision: "not_recomputed" },
    replay: { mismatchCount: 0 }
  })`, harness.context);
  assert.match(scopeOnlyVisionMessage, /确定性校验通过.*视觉识别结果未重算/);
  assert.equal(harness.buttons["#verifyRunRecordButton"].attributes.get("aria-busy"), "false");
  assert.equal(harness.buttons["#verifyRunRecordButton"].disabled, false);
});

test("submit click uses the bound session token and seals the successful receipt state", async () => {
  const harness = createHarness();
  await clickAndWait(harness.buttons["#submitRunRecordButton"]);
  assert.equal(harness.requests.length, 1);
  assert.equal(
    harness.requests[0].endpoint,
    `/api/v1/sessions/${harness.serverSession.sessionId}/submissions`
  );
  assert.equal(harness.requests[0].options.method, "POST");
  assert.equal(harness.requests[0].options.headers.Authorization, `Bearer ${harness.serverSession.submitToken}`);
  assert.deepEqual(JSON.parse(harness.requests[0].options.body), harness.record);
  assert.equal(harness.elements["#competitionSubmissionResult"].dataset.status, "verified");
  assert.match(harness.elements["#competitionSubmissionResult"].textContent, /22222222.*verified/);
  assert.equal(
    vm.runInContext("latestCompetitionSubmissionReceipt.submissionId", harness.context),
    "sub_22222222222222222222222222222222"
  );
  assert.equal(harness.buttons["#submitRunRecordButton"].attributes.get("aria-busy"), "false");
  assert.equal(harness.buttons["#submitRunRecordButton"].disabled, false,
    "a stored record stays clickable so a repeated click can explain that it is already saved");
  const requestCount = harness.requests.length;
  await clickAndWait(harness.buttons["#submitRunRecordButton"]);
  assert.equal(harness.requests.length, requestCount, "a repeated click must not create a duplicate request");
  assert.equal(harness.elements["#competitionRecordActionStatus"].dataset.status, "success");
  assert.match(harness.elements["#competitionRecordActionStatus"].textContent, /已存在.*无需重复提交/);
});

test("finishing a server-bound run auto-saves one draft without formally submitting it", async () => {
  const harness = createHarness();
  vm.runInContext(
    "latestCompetitionRecord = null; latestCompetitionSubmissionReceipt = null; "
      + "setCompetitionRecordActionStatus('replay', 'warning', '旧回放错误'); commitCompetitionRecord(__record);",
    harness.context
  );
  await new Promise(resolve => setImmediate(resolve));
  const draftRequests = harness.requests.filter(request => /\/drafts$/.test(request.endpoint));
  assert.equal(draftRequests.length, 1, "finishing the run must auto-save exactly one draft");
  assert.equal(
    draftRequests[0].endpoint,
    `/api/v1/sessions/${harness.serverSession.sessionId}/drafts`
  );
  assert.equal(
    draftRequests[0].options.headers.Authorization,
    `Bearer ${harness.serverSession.submitToken}`
  );
  assert.deepEqual(JSON.parse(draftRequests[0].options.body), harness.record);
  assert.equal(harness.requests.filter(request => /\/submissions$/.test(request.endpoint)).length, 0,
    "auto-save must not create a formal submission");
  assert.equal(
    vm.runInContext("latestCompetitionSubmissionReceipt", harness.context),
    null,
    "a receipt may only exist after an explicit submit click"
  );
  assert.equal(harness.elements["#competitionRecordActionStatus"].dataset.action, "record");
  assert.equal(harness.elements["#competitionRecordActionStatus"].dataset.status, "success");
  assert.match(harness.elements["#competitionRecordActionStatus"].textContent, /已自动保存.*继续运行.*逐条提交/);
  assert.doesNotMatch(harness.elements["#competitionRecordActionStatus"].textContent, /旧回放错误/);
  await clickAndWait(harness.elements["#recordsNavLink"]);
  await new Promise(resolve => setImmediate(resolve));
  const savedItem = harness.elements["#competitionRecordsList"].children[0];
  assert.ok(savedItem, harness.elements["#competitionRecordsStatus"].textContent);
  assert.equal(savedItem.dataset.recordId, "sub_11111111111111111111111111111111");
  assert.equal(savedItem.children[2].children[0].textContent, "未提交");
  assert.equal(savedItem.children[3].disabled, false);
});

test("large auto-saved records are gzip compressed before they reach the public proxy", async () => {
  const record = {
    schemaVersion: "chenlong.run-record/v4",
    runId: "run_compressed_draft",
    serverSessionId: "ses_11111111111111111111111111111111",
    challengeDigest: "a".repeat(64),
    repeatedEvidence: "x".repeat(256 * 1024)
  };
  const harness = createHarness({ recordOverride: record });
  vm.runInContext(
    "latestCompetitionRecord = null; commitCompetitionRecord(__record);",
    harness.context
  );
  await vm.runInContext(
    "Promise.all([...pendingCompetitionDraftSaveOperations].map(operation => operation.promise))",
    harness.context
  );
  const request = harness.requests.find(item => /\/drafts$/.test(item.endpoint));
  assert.ok(request, "the compressed draft request must be sent");
  assert.equal(request.options.headers["Content-Encoding"], "gzip");
  const decoded = JSON.parse(gunzipSync(Buffer.from(request.options.body)).toString("utf8"));
  assert.deepEqual(decoded, record);
  assert.ok(request.options.body.byteLength < Buffer.byteLength(JSON.stringify(record), "utf8"));
});

test("submitting the latest auto-saved record from My Records synchronizes the workbench receipt", async () => {
  const harness = createHarness();
  vm.runInContext(
    "latestCompetitionRecord = null; latestCompetitionSubmissionReceipt = null; commitCompetitionRecord(__record);",
    harness.context
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    vm.runInContext("latestCompetitionDraftRecordId", harness.context),
    "sub_11111111111111111111111111111111"
  );

  const submitted = await vm.runInContext(
    "submitSavedCompetitionRecord('sub_11111111111111111111111111111111')",
    harness.context
  );
  assert.equal(submitted, true);
  assert.equal(
    vm.runInContext("latestCompetitionSubmissionReceipt.recordRef === latestCompetitionRecord", harness.context),
    true
  );
  assert.equal(harness.elements["#competitionSubmissionResult"].dataset.status, "verified");
  assert.match(harness.elements["#competitionSubmissionResult"].textContent, /已正式提交.*11111111.*verified/);
  assert.equal(harness.elements["#competitionRecordActionStatus"].dataset.status, "success");
  assert.match(harness.elements["#competitionRecordActionStatus"].textContent, /本次运行记录已正式提交/);
});

test("opening and closing My Records preserves the editor without navigating or submitting", async () => {
  const opener = functionSource("openCompetitionRecords");
  assert.match(opener, /event\?\.preventDefault\?\.\(\)/);
  assert.match(opener, /competitionRecordsDialog\.showModal\(\)/);
  assert.doesNotMatch(opener, /submitLatestCompetitionRecord\s*\(/,
    "opening the records dialog must not double as submission consent");
  assert.doesNotMatch(opener, /location\.(?:assign|replace)|recordsNavLink\.href/);

  const harness = createHarness();
  const editorSource = harness.elements["#pythonEditor"].value;
  vm.runInContext(
    "latestCompetitionRecord = null; latestCompetitionSubmissionReceipt = null; commitCompetitionRecord(__record);",
    harness.context
  );
  const recordsButton = harness.elements["#recordsNavLink"];
  await clickAndWait(recordsButton);

  assert.equal(recordsButton.lastEvent.defaultPrevented, true);
  assert.equal(harness.elements["#competitionRecordsDialog"].open, true);
  assert.equal(recordsButton.getAttribute("aria-expanded"), "true");
  assert.equal(harness.elements["#pendingCompetitionRecord"].dataset.recordState, "pending");
  assert.equal(harness.elements["#submitPendingRunRecordButton"].hidden, false);
  assert.deepEqual(harness.navigations, []);
  assert.equal(harness.requests.filter(request => /\/submissions$/.test(request.endpoint)).length, 0,
    "opening the records dialog must not double as submission consent");
  assert.equal(harness.elements["#pythonEditor"].value, editorSource);

  await clickAndWait(harness.elements["#closeCompetitionRecordsButton"]);
  assert.equal(harness.elements["#competitionRecordsDialog"].open, false);
  assert.equal(recordsButton.getAttribute("aria-expanded"), "false");
  assert.equal(recordsButton.focused, 1, "closing the dialog must restore focus to its trigger");
  assert.equal(harness.elements["#pythonEditor"].value, editorSource);
  assert.deepEqual(harness.navigations, []);
});

test("My Records keeps a verified archive green while disclosing that vision was not recomputed", async () => {
  const harness = createHarness({
    archiveSummary: {
      submissionId: "sub_33333333333333333333333333333333",
      taskName: "视觉范围回归记录",
      score: 58.5,
      status: "verified",
      receivedAt: "2026-08-20T01:02:03.000Z",
      verification: {
        status: "verified",
        reasonCodes: ["vision_detections_not_recomputed"],
        visionStatus: "not_recomputed",
        verificationScope: {
          deterministic: { status: "complete" },
          vision: "not_recomputed"
        }
      }
    }
  });
  await clickAndWait(harness.elements["#recordsNavLink"]);
  await new Promise(resolve => setImmediate(resolve));
  const item = harness.elements["#competitionRecordsList"].children[0];
  const statusGroup = item.children[2];
  assert.equal(statusGroup.children[0].dataset.status, "verified");
  assert.equal(statusGroup.children[0].textContent, "确定性校验通过");
  assert.equal(statusGroup.children[1].textContent, "视觉未重算");
});

test("an auto-saved record submits exactly once from its own record action and updates its live status", async () => {
  const harness = createHarness();
  vm.runInContext(
    "latestCompetitionRecord = null; latestCompetitionSubmissionReceipt = null; commitCompetitionRecord(__record);",
    harness.context
  );
  await new Promise(resolve => setImmediate(resolve));
  await clickAndWait(harness.elements["#recordsNavLink"]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.requests.filter(request => /\/submissions$/.test(request.endpoint)).length, 0);

  const savedItem = harness.elements["#competitionRecordsList"].children[0];
  const submitAction = savedItem.children[3];
  assert.equal(submitAction.disabled, false);
  submitAction.click();
  await new Promise(resolve => setImmediate(resolve));

  const recordSubmitRequests = harness.requests.filter(
    request => request.endpoint === "/api/v1/records/sub_11111111111111111111111111111111/submit"
  );
  assert.equal(recordSubmitRequests.length, 1, "one record action must create exactly one formal submission request");
  assert.equal(recordSubmitRequests[0].options.headers["Content-Type"], "application/json");
  assert.equal(recordSubmitRequests[0].options.body, "{}");
  assert.equal(
    vm.runInContext("latestCompetitionSubmissionReceipt.submissionId", harness.context),
    "sub_11111111111111111111111111111111",
    "submitting the current auto-saved record must update the workbench rather than leave it stale"
  );
  assert.match(harness.elements["#competitionSubmissionResult"].textContent, /已正式提交.*verified/);
  const refreshedItem = harness.elements["#competitionRecordsList"].children[0];
  assert.equal(refreshedItem.dataset.recordId, "sub_11111111111111111111111111111111");
  assert.equal(refreshedItem.children[2].children[0].textContent, "确定性校验通过");
  assert.equal(refreshedItem.children[3].disabled, true);
  assert.equal(refreshedItem.children[3].children[1].textContent, "已提交");
});

test("My Records uses an in-page dialog and never assigns a new workbench location", () => {
  const opener = functionSource("openCompetitionRecords");
  assert.match(opener, /competitionRecordsDialog\.showModal\(\)/);
  assert.doesNotMatch(opener, /location\.(?:assign|replace)|recordsNavLink\.href/);
  assert.doesNotMatch(opener, /pythonEditor\.value\s*=/,
    "opening records must preserve the unsaved editor buffer");
});
