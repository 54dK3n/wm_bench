"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");

function functionSource(name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(app);
  assert.ok(declaration, `missing function ${name}`);
  const start = declaration.index;
  const signatureEnd = app.indexOf(") {", start + declaration[0].length);
  const openingBrace = signatureEnd < 0 ? -1 : signatureEnd + 2;
  assert.ok(openingBrace >= 0, `missing body for ${name}`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingBrace; index < app.length; index += 1) {
    const character = app[index];
    const next = app[index + 1];
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
      if (depth === 0) return app.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated function ${name}`);
}

function openSummary(finalizedCount = 0) {
  return {
    slotCount: 5,
    finalizedCount,
    pendingCount: 5 - finalizedCount,
    validCount: finalizedCount,
    invalidCount: 0,
    timeoutCount: 0,
    missingCount: 0,
    completedCount: finalizedCount,
    minScore: 0,
    meanScore: 0,
    batchScore: 0,
    collisionCount: 0,
    outOfBoundsCount: 0
  };
}

function openCandidate(index, sourceDigest = "a".repeat(64)) {
  return {
    batchId: `bat_${String(index).padStart(32, "0")}`,
    createdAt: `2026-08-21T0${index}:00:00.000Z`,
    expiresAt: `2026-08-21T1${index}:00:00.000Z`,
    nextSlotIndex: index,
    sourceDigest,
    summary: openSummary(index - 1)
  };
}

test("five-run panel is non-technical, score-scaled to 100, and honest about its audit boundary", () => {
  const panel = /<section id="competitionBatchPanel"[\s\S]*?<\/section>/.exec(html)?.[0] || "";
  assert.match(panel, /练习五局 · 同图多布局/);
  assert.match(panel, /练习五局（本地参考，不入榜）/);
  assert.match(panel, /不进入筛选排名/);
  assert.match(panel, /当前局在本地浏览器中运行，可被技术手段检查/);
  assert.match(panel, /不会提前下发未来局布局/);
  assert.match(panel, /非强反作弊/);
  assert.match(panel, /五局均分[\s\S]*最低分[\s\S]*70\/30 总分/);
  assert.equal((panel.match(/\/ 100/g) || []).length, 4);
  assert.match(panel, /最多同时保留 2 个未完成练习/);
  assert.match(panel, /最多有 20 次练习五局机会/);
  assert.match(panel, /关闭不会返还次数/);
  assert.match(panel, /系统不会自动删除/);
  assert.doesNotMatch(panel, /绝对保密|隐藏局|布局名|seed|坐标|路线建议|自动寻路|route_to|go_to|pathfind/i);
  assert.match(css, /\.competition-hud\[data-batch-active="true"\][\s\S]*\.competition-record-actions/);
});

test("one click runs five slots strictly as lease, run, verified submit before the next lease", async () => {
  const events = [];
  const slots = Array.from({ length: 5 }, (_, index) => ({
    slotIndex: index + 1,
    final: false,
    status: "pending",
    score: 0,
    completed: false
  }));
  const active = {
    batch: { phase: "open", nextSlotIndex: 1, slots },
    lease: null,
    pendingRecord: null,
    stopBatchRequested: false,
    uiState: "leasing"
  };
  const context = vm.createContext({
    activeCompetitionBatch: active,
    latestCompetitionRecord: null,
    COMPETITION_BATCH_SLOT_COUNT: 5,
    competitionBatchIsOpen(batch = active.batch) {
      return batch.phase === "open" && Number.isSafeInteger(batch.nextSlotIndex);
    },
    async leaseCurrentCompetitionBatchSlot() {
      const slotIndex = active.batch.nextSlotIndex;
      events.push(`lease:${slotIndex}`);
      active.lease = {
        slotIndex,
        session: {
          runId: `run-${slotIndex}`,
          sessionId: `session-${slotIndex}`,
          challengeDigest: `challenge-${slotIndex}`
        }
      };
      return active.lease;
    },
    async runProgram(options) {
      assert.equal(options.batchManaged, true);
      const { slotIndex, session } = active.lease;
      events.push(`run:${slotIndex}`);
      context.latestCompetitionRecord = {
        runId: session.runId,
        serverSessionId: session.sessionId,
        challengeDigest: session.challengeDigest,
        result: { score: 10 + slotIndex }
      };
    },
    async submitCurrentCompetitionBatchSlot(record) {
      const slotIndex = active.lease.slotIndex;
      events.push(`submit:${slotIndex}`);
      assert.equal(record.runId, `run-${slotIndex}`);
      active.batch.slots[slotIndex - 1] = {
        slotIndex,
        final: true,
        status: "valid",
        score: record.result.score,
        completed: true
      };
      active.lease = null;
      if (slotIndex === 5) {
        active.batch.phase = "finalized";
        active.batch.nextSlotIndex = null;
      } else {
        active.batch.nextSlotIndex += 1;
      }
    },
    async closeActiveCompetitionBatch() { events.push("close"); },
    finishCompetitionBatchUi() { events.push("finished"); active.uiState = "finalized"; },
    setCompetitionBatchStatus() {},
    renderCompetitionBatchPanel() {}
  });
  vm.runInContext(`${functionSource("runCompetitionBatchSequence")}; this.runSequence = runCompetitionBatchSequence;`, context);
  await context.runSequence();
  assert.deepEqual(events, [
    "lease:1", "run:1", "submit:1",
    "lease:2", "run:2", "submit:2",
    "lease:3", "run:3", "submit:3",
    "lease:4", "run:4", "submit:4",
    "lease:5", "run:5", "submit:5",
    "finished"
  ]);
});

test("a restored not-yet-bound slot still leases with the locked team id", async () => {
  const batch = {
    batchId: "bat_11111111111111111111111111111111",
    phase: "open",
    nextSlotIndex: 3
  };
  const active = {
    batch,
    teamId: "locked-team",
    restoredFromPage: true,
    currentScore: null
  };
  let requestBody = null;
  let normalizedTeamId = null;
  const lease = {
    slotIndex: 3,
    session: { teamId: "locked-team" },
    runDefinition: { interactionDefinition: { packages: [] } }
  };
  const context = vm.createContext({
    activeCompetitionBatch: active,
    competitionTeamIdInput: null,
    COMPETITION_BATCH_SLOT_COUNT: 5,
    COMPETITION_BATCH_ENDPOINT: "/api/v1/evaluation-batches",
    RUN_RECORD_VERIFICATION_TIMEOUT_MS: 30000,
    competitionBatchIsOpen(value = active.batch) {
      return value.phase === "open" && Number.isSafeInteger(value.nextSlotIndex);
    },
    currentCompetitionTeamId() { return "changed-after-refresh"; },
    normalizeCompetitionBatchTeamId(value) { return value; },
    setCompetitionBatchStatus() {},
    renderCompetitionBatchPanel() {},
    async requestVerificationEndpoint(_endpoint, options) {
      requestBody = JSON.parse(options.body);
      return { response: { ok: true, status: 201 }, payload: {} };
    },
    normalizeCompetitionBatchLease(_payload, _batchId, _slotIndex, teamId) {
      normalizedTeamId = teamId;
      return { envelope: { batch, currentSlot: { slotIndex: 3 } }, lease };
    },
    applyCompetitionBatchLeaseScene() {},
    persistCompetitionBatchRecovery() {},
    encodeURIComponent
  });
  vm.runInContext(`${functionSource("leaseCurrentCompetitionBatchSlot")}; this.leaseSlot = leaseCurrentCompetitionBatchSlot;`, context);
  await context.leaseSlot();
  assert.deepEqual(requestBody, { slotIndex: 3, teamId: "locked-team" });
  assert.equal(normalizedTeamId, "locked-team");
});

test("refresh recovery waits for an explicit continue and never auto-runs a slot", () => {
  const source = functionSource("restoreCompetitionBatchFromPage");
  assert.match(source, /uiState:\s*envelope\.batch\.phase\s*===\s*"finalized"\s*\?\s*"finalized"\s*:\s*"recovery"/);
  assert.match(source, /请点击“继续当前练习五局”/);
  assert.doesNotMatch(source, /continueCompetitionBatch\s*\(|runCompetitionBatchSequence\s*\(|runProgram\s*\(/);
  assert.match(source, /competitionBatchSourceDigest\(recovery\.source\)/);
  const storage = `${functionSource("persistCompetitionBatchRecovery")}\n${functionSource("readCompetitionBatchRecovery")}`;
  assert.match(storage, /sessionStorage/);
  assert.doesNotMatch(storage, /localStorage|submitToken|runDefinition|interactionDefinition/);
});

test("batch source, scene, submit, and stop paths stay fail-closed", () => {
  const run = functionSource("runProgram");
  assert.match(run, /const rankedManaged\s*=\s*options\?\.rankedManaged\s*===\s*true/);
  assert.match(run, /const fiveRunManaged\s*=\s*batchManaged\s*\|\|\s*rankedManaged/);
  assert.match(run, /managedFiveRunIsOpen\(\)[\s\S]*!fiveRunManaged/);
  assert.match(run, /fiveRunManaged\s*\?\s*String\(managedActive\?\.source/);
  assert.match(functionSource("loadMission"), /managedFiveRunIsOpen\(\)[\s\S]*!options\.batchInternal/);
  assert.match(functionSource("loadExample"), /managedFiveRunIsOpen\(\)/);

  const scene = functionSource("applyCompetitionBatchLeaseScene");
  assert.match(scene, /lease\?\.runDefinition\?\.interactionDefinition\?\.packages/);
  assert.match(scene, /item\.role\s*===\s*"target"\s*\|\|\s*item\.role\s*===\s*"distractor"/);
  assert.match(scene, /item\.role\s*===\s*"obstacle"/);

  const submit = functionSource("submitCurrentCompetitionBatchSlot");
  assert.match(submit, /\/slots\/\$\{slotIndex\}\/sessions\/\$\{encodeURIComponent\(lease\.session\.sessionId\)\}\/submissions/);
  assert.match(submit, /headers:\s*\{\s*"Content-Type":\s*"application\/json"\s*\}/);
  assert.doesNotMatch(submit, /Authorization|Bearer|submitToken/);
  assert.match(submit, /if\s*\(!finalizedSlot\?\.final\s*\|\|\s*finalizedSlot\.status\s*===\s*"pending"\)/);

  const stop = functionSource("requestStopCompetitionBatch");
  assert.match(stop, /window\.confirm/);
  assert.match(stop, /missing \/ 0 分/);
  assert.match(stop, /stopBatchRequested\s*=\s*true/);
  const close = functionSource("closeActiveCompetitionBatch");
  assert.match(close, /\/close/);
  assert.match(close, /body:\s*"\{\}"/);
});

test("open-batch discovery accepts only the bounded versioned public projection", () => {
  const context = vm.createContext({
    BATCH_OPEN_LIST_SCHEMA_VERSION: "chenlong.open-batch-list/v1",
    COMPETITION_BATCH_DISCOVERY_LIMIT: 2,
    COMPETITION_BATCH_DISCOVERY_ORDER: "createdAt-desc,batchId-asc",
    COMPETITION_BATCH_SLOT_COUNT: 5,
    COMPETITION_SCORE_MAXIMUM: 100,
    Set,
    Date
  });
  vm.runInContext(
    `${functionSource("competitionBatchHasExactKeys")};\n`
      + `${functionSource("normalizeCompetitionBatchOpenList")};\n`
      + "this.normalizeOpenList = normalizeCompetitionBatchOpenList;",
    context
  );
  const payload = {
    schemaVersion: "chenlong.open-batch-list/v1",
    authoritative: false,
    phase: "open",
    limit: 2,
    order: "createdAt-desc,batchId-asc",
    batches: [openCandidate(2, "b".repeat(64)), openCandidate(1)]
  };
  assert.doesNotThrow(() => context.normalizeOpenList(payload));

  const leakedLayout = structuredClone(payload);
  leakedLayout.batches[0].layout = { x: 1, z: 2 };
  assert.throws(() => context.normalizeOpenList(leakedLayout), /公开进度不兼容/);
  const leakedSession = structuredClone(payload);
  leakedSession.batches[0].sessionId = "ses_secret";
  assert.throws(() => context.normalizeOpenList(leakedSession), /公开进度不兼容/);
  const leakedSource = structuredClone(payload);
  leakedSource.batches[0].source = "car.stop()";
  assert.throws(() => context.normalizeOpenList(leakedSource), /公开进度不兼容/);
});

test("cross-tab discovery lists at most two choices and never selects or runs one automatically", async () => {
  const digest = "a".repeat(64);
  const statuses = [];
  let listRequests = 0;
  const context = vm.createContext({
    competitionBatchDiscoveryInFlight: false,
    activeCompetitionBatch: null,
    competitionBatchDiscoveryCandidates: [],
    competitionBatchDiscoveryRequired: true,
    competitionBatchCreateOutcomeUnknown: null,
    pythonEditor: { value: "car.stop()" },
    COMPETITION_BATCH_DISCOVERY_LIMIT: 2,
    requestCompetitionBatchOpenList: async () => {
      listRequests += 1;
      return { batches: [openCandidate(2, "b".repeat(64)), openCandidate(1, digest)] };
    },
    competitionBatchSourceDigest: async () => digest,
    setCompetitionBatchStatus(status, message) { statuses.push([status, message]); },
    renderCompetitionBatchPanel() {}
  });
  vm.runInContext(
    `${functionSource("discoverOpenCompetitionBatches")}; this.discover = discoverOpenCompetitionBatches;`,
    context
  );
  const result = await context.discover({ required: true });
  assert.equal(result.ok, true);
  assert.equal(listRequests, 1);
  assert.equal(context.competitionBatchDiscoveryCandidates.length, 2);
  assert.equal(context.competitionBatchDiscoveryCandidates.filter(item => item.sourceMatches).length, 1);
  assert.equal(context.activeCompetitionBatch, null);
  assert.match(statuses.at(-1)[1], /请选择“恢复练习”/);
  const source = functionSource("discoverOpenCompetitionBatches");
  assert.doesNotMatch(source, /recoverDiscoveredCompetitionBatch\s*\(|leaseCurrentCompetitionBatchSlot\s*\(|runProgram\s*\(/);
});

test("an empty discovery cannot unlock an unknown create outcome or its original source", async () => {
  const unknown = {
    source: "car.stop()\n# source A",
    teamId: "team-a",
    sourceDigest: "a".repeat(64)
  };
  const statuses = [];
  const pythonEditor = {
    value: unknown.source,
    readOnly: false,
    setAttribute() {},
    classList: { toggle() {} }
  };
  const context = vm.createContext({
    competitionBatchDiscoveryInFlight: false,
    activeCompetitionBatch: null,
    competitionBatchDiscoveryCandidates: [],
    competitionBatchDiscoveryRequired: true,
    competitionBatchCreateOutcomeUnknown: unknown,
    competitionBatchPanel: { dataset: {} },
    competitionHud: null,
    competitionBatchSlot: null,
    competitionBatchState: null,
    competitionBatchCurrentScore: null,
    competitionBatchMeanScore: null,
    competitionBatchMinimumScore: null,
    competitionBatchScore: null,
    startCompetitionBatchButton: null,
    stopCompetitionBatchButton: null,
    competitionBatchStatus: null,
    competitionBatchSourceState: null,
    loadExampleButton: null,
    guangyangTrainingButton: null,
    exitGuangyangTrainingButton: null,
    competitionTeamIdInput: null,
    runButton: null,
    running: false,
    pythonReady: true,
    competitionBatchOperation: null,
    competitionRunStartPending: false,
    pythonEditor,
    guangyangAiAutonomyModeButton: null,
    document: { querySelector() { return null; } },
    COMPETITION_BATCH_DISCOVERY_LIMIT: 2,
    competitionBatchIsOpen() { return false; },
    requestCompetitionBatchOpenList: async () => ({ batches: [] }),
    competitionBatchSourceDigest: async () => unknown.sourceDigest,
    setCompetitionBatchStatus(status, message) { statuses.push([status, message]); },
    renderCompetitionBatchDiscovery() {}
  });
  vm.runInContext(
    `${functionSource("setCompetitionBatchSourceLock")};\n`
      + `${functionSource("renderCompetitionBatchPanel")};\n`
      + `${functionSource("discoverOpenCompetitionBatches")};\n`
      + "this.discover = discoverOpenCompetitionBatches;",
    context
  );
  const result = await context.discover({
    source: unknown.source,
    sourceDigest: unknown.sourceDigest,
    required: true
  });
  assert.equal(result.ok, true);
  assert.equal(context.competitionBatchCreateOutcomeUnknown, unknown);
  assert.equal(context.competitionBatchDiscoveryRequired, false);
  assert.equal(pythonEditor.readOnly, true);
  assert.match(statuses.at(-1)[1], /原源码安全重试创建/);
  assert.doesNotMatch(statuses.at(-1)[1], /已确认可以安全重试|批次不存在/);
});

test("pending create survives refresh, locks before digest resolves, ignores early clicks, and retries only source A", async () => {
  const sourceA = "car.stop()\n# pending source A";
  const sourceB = "car.stop()\n# edited source B";
  const sourceDigest = "d".repeat(64);
  const storageValues = new Map();
  const sessionStorage = {
    getItem(key) { return storageValues.has(key) ? storageValues.get(key) : null; },
    setItem(key, value) { storageValues.set(key, String(value)); },
    removeItem(key) { storageValues.delete(key); }
  };
  let resolveDigest;
  const pendingDigest = new Promise(resolve => { resolveDigest = resolve; });
  let digestCalls = 0;
  let openListRequests = 0;
  const postedSources = [];
  let continues = 0;
  let context;
  const pythonEditor = {
    value: sourceB,
    readOnly: false,
    setAttribute() {},
    classList: { toggle() {} }
  };
  const startButtonLabel = { textContent: "" };
  const startButton = {
    hidden: false,
    disabled: false,
    querySelector() { return startButtonLabel; }
  };
  const isOpen = batch => {
    const value = batch === undefined ? context.activeCompetitionBatch?.batch : batch;
    return value?.phase === "open" && Number.isSafeInteger(value.nextSlotIndex);
  };
  context = vm.createContext({
    sessionStorage,
    COMPETITION_BATCH_RECOVERY_STORAGE_KEY: "chenlongCompetitionBatch/v1",
    MAX_PYTHON_DRAFT_LENGTH: 128 * 1024,
    COMPETITION_BATCH_ENDPOINT: "/api/v1/evaluation-batches",
    COMPETITION_BATCH_SLOT_COUNT: 5,
    COMPETITION_BATCH_DISCOVERY_LIMIT: 2,
    competitionBatchRestorePending: false,
    competitionBatchDiscoveryInFlight: false,
    competitionBatchDiscoveryRequired: false,
    competitionBatchDiscoveryCandidates: [],
    competitionBatchCreateOutcomeUnknown: null,
    competitionBatchOperation: null,
    competitionBatchRequestSerial: 0,
    competitionBatchAbortController: null,
    competitionRunStartPending: false,
    activeCompetitionBatch: null,
    running: false,
    pythonReady: true,
    activeMission: { environment: "guangyang", objectTraining: false },
    pythonEditor,
    competitionTeamIdInput: { value: "team-b", disabled: false, focus() {} },
    competitionBatchPanel: { dataset: {} },
    competitionHud: null,
    competitionBatchSourceState: null,
    competitionBatchSlot: null,
    competitionBatchState: null,
    competitionBatchCurrentScore: null,
    competitionBatchMeanScore: null,
    competitionBatchMinimumScore: null,
    competitionBatchScore: null,
    startCompetitionBatchButton: startButton,
    stopCompetitionBatchButton: null,
    loadExampleButton: null,
    guangyangTrainingButton: null,
    guangyangAiAutonomyModeButton: null,
    exitGuangyangTrainingButton: null,
    runButton: null,
    document: { querySelector() { return null; } },
    AbortController,
    normalizeCompetitionBatchTeamId(value) { return String(value); },
    competitionBatchIsOpen: isOpen,
    isCompetitionMission() { return true; },
    currentCompetitionTeamId() { return "team-b"; },
    competitionBatchSourceDigest: async source => {
      assert.equal(source, sourceA);
      digestCalls += 1;
      return digestCalls === 1 ? pendingDigest : sourceDigest;
    },
    requestCompetitionBatchOpenList: async () => {
      openListRequests += 1;
      return { batches: [] };
    },
    requestCompetitionBatch: async (_endpoint, options) => {
      const submittedSource = JSON.parse(options.body).source;
      postedSources.push(submittedSource);
      assert.equal(submittedSource, sourceA);
      const pendingAtRequest = JSON.parse(sessionStorage.getItem("chenlongCompetitionBatch/v1"));
      assert.equal(pendingAtRequest.pendingCreate.source, sourceA);
      return {
        batch: {
          batchId: "bat_22222222222222222222222222222222",
          sourceDigest,
          phase: "open",
          nextSlotIndex: 1
        },
        currentSlot: { slotIndex: 1 }
      };
    },
    loadMission() { assert.fail("pending restore already uses Guangyang"); },
    updateLineNumbers() {},
    renderPythonHighlight() {},
    persistPythonDraft() {},
    setCompetitionBatchStatus() {},
    setStatus() {},
    competitionBatchErrorMessage(error) { return String(error?.message || "error"); },
    renderCompetitionBatchDiscovery() {},
    continueCompetitionBatch() { continues += 1; }
  });
  vm.runInContext(
    `${functionSource("competitionBatchHasExactKeys")};\n`
      + `${functionSource("persistCompetitionBatchPendingCreate")};\n`
      + `${functionSource("clearCompetitionBatchRecoveryStorage")};\n`
      + `${functionSource("persistCompetitionBatchRecovery")};\n`
      + `${functionSource("readCompetitionBatchRecovery")};\n`
      + `${functionSource("setCompetitionBatchSourceLock")};\n`
      + `${functionSource("renderCompetitionBatchPanel")};\n`
      + `${functionSource("discoverOpenCompetitionBatches")};\n`
      + `${functionSource("restoreCompetitionBatchFromPage")};\n`
      + `${functionSource("startOrContinueCompetitionBatch")};\n`
      + "this.persistPending = persistCompetitionBatchPendingCreate;"
      + "this.restore = restoreCompetitionBatchFromPage;"
      + "this.startBatch = startOrContinueCompetitionBatch;",
    context
  );

  assert.equal(context.persistPending({ source: sourceA, teamId: "team-a", sourceDigest }), true);
  const storedPending = JSON.parse(sessionStorage.getItem("chenlongCompetitionBatch/v1"));
  assert.deepEqual(storedPending.pendingCreate, { source: sourceA, teamId: "team-a", sourceDigest });

  const restoreOperation = context.restore();
  assert.equal(context.competitionBatchRestorePending, true);
  assert.equal(context.competitionBatchCreateOutcomeUnknown.source, sourceA);
  assert.equal(pythonEditor.value, sourceA);
  assert.equal(pythonEditor.readOnly, true);
  assert.equal(startButton.disabled, true);
  await context.startBatch();
  assert.deepEqual(postedSources, [], "a click during digest validation cannot send create");

  pythonEditor.value = sourceB;
  resolveDigest(sourceDigest);
  await restoreOperation;
  assert.equal(openListRequests, 1);
  assert.equal(context.competitionBatchCreateOutcomeUnknown.source, sourceA);
  assert.equal(pythonEditor.readOnly, true);
  assert.equal(startButton.disabled, false);
  assert.ok(JSON.parse(sessionStorage.getItem("chenlongCompetitionBatch/v1")).pendingCreate);

  await context.startBatch();
  assert.deepEqual(postedSources, [sourceA]);
  assert.equal(pythonEditor.value, sourceA);
  assert.equal(context.competitionBatchCreateOutcomeUnknown, null);
  assert.equal(context.activeCompetitionBatch.probeBoundTeamFirst, true);
  assert.equal(continues, 1);
  const storedRecovery = JSON.parse(sessionStorage.getItem("chenlongCompetitionBatch/v1"));
  assert.equal(storedRecovery.batchId, "bat_22222222222222222222222222222222");
  assert.equal(Object.prototype.hasOwnProperty.call(storedRecovery, "pendingCreate"), false);
});

test("without valid session recovery, page initialization explicitly discovers open batches", async () => {
  let discoveries = 0;
  const context = vm.createContext({
    competitionBatchRestorePending: false,
    activeCompetitionBatch: null,
    pythonEditor: { value: "draft" },
    readCompetitionBatchRecovery() { return null; },
    async discoverOpenCompetitionBatches() { discoveries += 1; }
  });
  vm.runInContext(
    `${functionSource("restoreCompetitionBatchFromPage")}; this.restore = restoreCompetitionBatchFromPage;`,
    context
  );
  await context.restore();
  assert.equal(discoveries, 1);
  assert.equal(context.activeCompetitionBatch, null);
});

test("explicit cross-tab recovery only prepares a continue prompt and marks team id as unknown", async () => {
  const digest = "a".repeat(64);
  const candidate = openCandidate(1, digest);
  let detailRequests = 0;
  let persisted = 0;
  const context = vm.createContext({
    competitionBatchDiscoveryInFlight: false,
    activeCompetitionBatch: null,
    competitionBatchOperation: null,
    competitionBatchDiscoveryCandidates: [{ ...candidate, sourceMatches: true }],
    competitionBatchDiscoveryRequired: false,
    competitionBatchCreateOutcomeUnknown: null,
    pythonEditor: { value: "car.stop()" },
    competitionTeamIdInput: null,
    activeMission: { environment: "guangyang", objectTraining: false },
    COMPETITION_BATCH_ENDPOINT: "/api/v1/evaluation-batches",
    COMPETITION_BATCH_SLOT_COUNT: 5,
    currentCompetitionTeamId() { return "current-team"; },
    normalizeCompetitionBatchTeamId(value) { return value; },
    competitionBatchSourceDigest: async () => digest,
    requestCompetitionBatch: async endpoint => {
      detailRequests += 1;
      assert.match(endpoint, new RegExp(`${candidate.batchId}$`));
      return {
        batch: {
          batchId: candidate.batchId,
          sourceDigest: digest,
          phase: "open",
          nextSlotIndex: 1
        },
        currentSlot: { slotIndex: 1 }
      };
    },
    loadMission() { assert.fail("already on Guangyang mission"); },
    updateLineNumbers() {},
    renderPythonHighlight() {},
    persistPythonDraft() {},
    persistCompetitionBatchRecovery() { persisted += 1; },
    setCompetitionBatchStatus() {},
    renderCompetitionBatchPanel() {},
    encodeURIComponent
  });
  vm.runInContext(
    `${functionSource("recoverDiscoveredCompetitionBatch")}; this.recover = recoverDiscoveredCompetitionBatch;`,
    context
  );
  await context.recover(0);
  assert.equal(detailRequests, 1);
  assert.equal(persisted, 1);
  assert.equal(context.activeCompetitionBatch.uiState, "recovery");
  assert.equal(context.activeCompetitionBatch.probeBoundTeamFirst, true);
  assert.equal(context.activeCompetitionBatch.lease, null);
});

test("cross-tab lease first recovers without guessing team id, then uses current id only for an unbound slot", async () => {
  async function runCase(responses, expectedBodies, returnedTeamId) {
    const batch = {
      batchId: "bat_11111111111111111111111111111111",
      sourceDigest: "a".repeat(64),
      phase: "open",
      nextSlotIndex: 2
    };
    const active = {
      batch,
      teamId: "current-team",
      probeBoundTeamFirst: true
    };
    const bodies = [];
    const lease = {
      slotIndex: 2,
      session: { teamId: returnedTeamId },
      runDefinition: { interactionDefinition: { packages: [] } }
    };
    const context = vm.createContext({
      activeCompetitionBatch: active,
      competitionTeamIdInput: { value: "current-team" },
      COMPETITION_BATCH_SLOT_COUNT: 5,
      COMPETITION_BATCH_ENDPOINT: "/api/v1/evaluation-batches",
      RUN_RECORD_VERIFICATION_TIMEOUT_MS: 30000,
      competitionBatchIsOpen(value = active.batch) {
        return value.phase === "open" && Number.isSafeInteger(value.nextSlotIndex);
      },
      currentCompetitionTeamId() { return "current-team"; },
      normalizeCompetitionBatchTeamId(value) { return value; },
      setCompetitionBatchStatus() {},
      renderCompetitionBatchPanel() {},
      async requestVerificationEndpoint(_endpoint, options) {
        bodies.push(JSON.parse(options.body));
        return responses.shift();
      },
      normalizeCompetitionBatchLease(_payload, _batchId, _slotIndex, expectedTeamId) {
        assert.equal(expectedTeamId, expectedBodies.length === 1 ? "" : "current-team");
        return { envelope: { batch, currentSlot: { slotIndex: 2 } }, lease };
      },
      applyCompetitionBatchLeaseScene() {},
      persistCompetitionBatchRecovery() {},
      encodeURIComponent
    });
    vm.runInContext(
      `${functionSource("leaseCurrentCompetitionBatchSlot")}; this.leaseSlot = leaseCurrentCompetitionBatchSlot;`,
      context
    );
    await context.leaseSlot();
    assert.deepEqual(bodies, expectedBodies);
    assert.equal(active.teamId, returnedTeamId);
    assert.equal(active.probeBoundTeamFirst, false);
  }

  await runCase(
    [{ response: { ok: true, status: 200 }, payload: {} }],
    [{ slotIndex: 2 }],
    "original-custom-team"
  );
  await runCase(
    [
      {
        response: { ok: false, status: 400 },
        payload: { error: { code: "INVALID_TEAM_ID", message: "team required" } }
      },
      { response: { ok: true, status: 201 }, payload: {} }
    ],
    [{ slotIndex: 2 }, { slotIndex: 2, teamId: "current-team" }],
    "current-team"
  );
});

test("after an empty race-prone discovery, explicit retry posts source A again and can never create edited source B", async () => {
  const sourceA = "car.stop()\n# source A";
  const sourceB = "car.stop()\n# source B";
  const postedSources = [];
  let discoveries = 0;
  let continues = 0;
  const digest = "c".repeat(64);
  const context = vm.createContext({
    competitionBatchOperation: null,
    competitionBatchDiscoveryInFlight: false,
    competitionBatchRestorePending: false,
    running: false,
    competitionRunStartPending: false,
    activeCompetitionBatch: null,
    competitionBatchCreateOutcomeUnknown: null,
    competitionBatchDiscoveryRequired: false,
    competitionBatchDiscoveryCandidates: [],
    activeMission: { environment: "guangyang", objectTraining: false },
    pythonEditor: { value: sourceA },
    pythonReady: true,
    competitionBatchRequestSerial: 0,
    competitionBatchAbortController: null,
    competitionTeamIdInput: null,
    COMPETITION_BATCH_ENDPOINT: "/api/v1/evaluation-batches",
    AbortController,
    isCompetitionMission() { return true; },
    competitionBatchIsOpen() { return false; },
    currentCompetitionTeamId() { return "team-a"; },
    normalizeCompetitionBatchTeamId(value) { return value; },
    competitionBatchSourceDigest: async source => {
      assert.equal(source, sourceA);
      return digest;
    },
    updateLineNumbers() {},
    renderPythonHighlight() {},
    persistPythonDraft() {},
    persistCompetitionBatchRecovery() {},
    persistCompetitionBatchPendingCreate() { return true; },
    setCompetitionBatchStatus() {},
    setCompetitionBatchSourceLock() {},
    renderCompetitionBatchPanel() {},
    setStatus() {},
    requestCompetitionBatch: async (_endpoint, options) => {
      postedSources.push(JSON.parse(options.body).source);
      if (postedSources.length === 1) throw new TypeError("connection lost");
      return {
        batch: {
          batchId: "bat_11111111111111111111111111111111",
          sourceDigest: digest,
          phase: "open",
          nextSlotIndex: 1
        },
        currentSlot: { slotIndex: 1 }
      };
    },
    discoverOpenCompetitionBatches: async options => {
      discoveries += 1;
      assert.equal(options.sourceDigest, digest);
      return { ok: false, candidates: [] };
    },
    continueCompetitionBatch() { continues += 1; }
  });
  vm.runInContext(
    `${functionSource("startOrContinueCompetitionBatch")}; this.startBatch = startOrContinueCompetitionBatch;`,
    context
  );
  await context.startBatch();
  assert.deepEqual(postedSources, [sourceA]);
  assert.equal(discoveries, 1);
  assert.equal(context.competitionBatchCreateOutcomeUnknown.sourceDigest, digest);
  context.pythonEditor.value = sourceB;
  await context.startBatch();
  assert.deepEqual(postedSources, [sourceA, sourceA]);
  assert.equal(discoveries, 1);
  assert.equal(context.activeCompetitionBatch.source, sourceA);
  assert.equal(context.activeCompetitionBatch.probeBoundTeamFirst, true);
  assert.equal(context.competitionBatchCreateOutcomeUnknown, null);
  assert.equal(continues, 1);
});

test("lost batches close only after per-item confirmation and use the existing close endpoint", async () => {
  const candidate = openCandidate(1);
  let confirmed = false;
  let closeRequests = 0;
  let refreshes = 0;
  const context = vm.createContext({
    competitionBatchDiscoveryInFlight: false,
    competitionBatchCreateOutcomeUnknown: null,
    activeCompetitionBatch: null,
    competitionBatchOperation: null,
    competitionBatchDiscoveryCandidates: [{ ...candidate, sourceMatches: false }],
    pythonEditor: { value: "different source" },
    COMPETITION_BATCH_ENDPOINT: "/api/v1/evaluation-batches",
    window: { confirm() { return confirmed; } },
    setCompetitionBatchStatus() {},
    renderCompetitionBatchPanel() {},
    requestCompetitionBatch: async (endpoint, options) => {
      closeRequests += 1;
      assert.match(endpoint, new RegExp(`${candidate.batchId}/close$`));
      assert.equal(options.body, "{}");
    },
    discoverOpenCompetitionBatches: async () => { refreshes += 1; },
    competitionBatchErrorMessage() { return "error"; },
    encodeURIComponent
  });
  vm.runInContext(
    `${functionSource("closeDiscoveredCompetitionBatch")}; this.closeLost = closeDiscoveredCompetitionBatch;`,
    context
  );
  await context.closeLost(0);
  assert.equal(closeRequests, 0);
  confirmed = true;
  await context.closeLost(0);
  assert.equal(closeRequests, 1);
  assert.equal(refreshes, 1);
});

test("quota errors distinguish unfinished slots from the non-refundable 20-evaluation policy", () => {
  const context = vm.createContext({});
  vm.runInContext(
    `${functionSource("competitionBatchErrorMessage")}; this.message = competitionBatchErrorMessage;`,
    context
  );
  assert.match(context.message({ code: "OWNER_OPEN_BATCH_LIMIT_REACHED" }), /2 个未完成练习/);
  assert.match(context.message({ code: "OWNER_OPEN_BATCH_LIMIT_REACHED" }), /逐个确认关闭/);
  assert.match(context.message({ code: "OWNER_BATCH_RETENTION_LIMIT_REACHED" }), /20 次练习五局机会/);
  assert.match(context.message({ code: "OWNER_BATCH_RETENTION_LIMIT_REACHED" }), /不会返还次数/);
  assert.match(context.message({ code: "SESSION_LIMIT_REACHED" }), /当前可运行场次数已满/);
  assert.equal(
    context.message({ code: "SESSION_SCOPE_LIMIT_REACHED" }),
    "当前练习运行名额已满，请稍后重试；不会额外占用机会。"
  );
  assert.match(context.message({ code: "SESSION_ARCHIVE_FULL" }), /比赛存档空间已满/);
  assert.match(context.message({ code: "ARCHIVE_STORAGE_FULL" }), /比赛存档空间已满/);

  assert.match(app, /evaluation-batches`\}\?phase=open|COMPETITION_BATCH_ENDPOINT\}\?phase=open/);
  const discoveryRenderer = functionSource("renderCompetitionBatchDiscovery");
  assert.doesNotMatch(discoveryRenderer, /candidate\.batchId|candidate\.sourceDigest|layout|session|runDefinition/);
});
