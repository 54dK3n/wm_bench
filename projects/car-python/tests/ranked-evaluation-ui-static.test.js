"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const recordsHtml = fs.readFileSync(path.join(root, "records.html"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin.html"), "utf8");
const accountCss = fs.readFileSync(path.join(root, "account.css"), "utf8");
const recordsScript = fs.readFileSync(path.join(root, "records.js"), "utf8");
const adminScript = fs.readFileSync(path.join(root, "admin.js"), "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing start marker ${start}`);
  assert.ok(endIndex > startIndex, `missing end marker ${end}`);
  return source.slice(startIndex, endIndex);
}

function functionSource(name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(app);
  assert.ok(declaration, `missing function ${name}`);
  const start = declaration.index;
  const signatureEnd = app.indexOf(") {", start + declaration[0].length);
  const bodyStart = signatureEnd < 0 ? -1 : signatureEnd + 2;
  assert.ok(bodyStart >= 0, `missing body for ${name}`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < app.length; index += 1) {
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
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return app.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

test("the existing five-run workflow is unmistakably practice-only and keeps its policy", () => {
  const practice = between(indexHtml, 'id="competitionBatchPanel"', 'class="competition-hud-meta"');
  assert.match(practice, /练习五局（本地参考，不入榜）/);
  assert.match(practice, /所有结果均为本地参考且不进入筛选排名/);
  assert.match(practice, /20 次练习五局机会/);
  assert.match(practice, /关闭不会返还次数/);
  assert.match(practice, /authoritative: false/);
  assert.doesNotMatch(practice, /五局评测机会|可审计多局评测|自动评测 5 局/);
  assert.doesNotMatch(app, /五局评测|未完成批次|评测批次/);
});

test("the ranked five-run scaffold states the irreversible second-confirmation policy", () => {
  const rankedPanel = between(indexHtml, 'id="rankedEvaluationPanel"', 'id="competitionBatchPanel"');
  const confirmation = between(indexHtml, 'id="rankedEvaluationConfirmDialog"', '<script src="./app.js');
  assert.match(rankedPanel, /筛选五局（本地参考）/);
  assert.match(rankedPanel, /本赛季仅 1 次/);
  assert.match(rankedPanel, /点击创建前必须二次确认/);
  assert.match(rankedPanel, /源码与队伍立即锁定/);
  assert.match(rankedPanel, /关闭、过期、异常或缺局均按 0 分计入/);
  assert.match(rankedPanel, /不能换卷重来/);
  assert.match(rankedPanel, /当前账号恢复源码和进度/);
  assert.match(rankedPanel, /隐藏练习与单局手动操作/);
  assert.match(rankedPanel, /五局严格按顺序完成/);
  assert.match(rankedPanel, /authoritative: false/);
  assert.match(rankedPanel, /服务器截止/);
  assert.match(rankedPanel, /id="rankedEvaluationDeadline"/);
  assert.match(rankedPanel, /id="startRankedEvaluationButton"[^>]*disabled/);
  assert.match(confirmation, /唯一一次筛选机会/);
  assert.match(confirmation, /不能重新创建第二次/);
  assert.match(confirmation, /id="confirmRankedEvaluationButton"[^>]*disabled/);
  assert.match(styles, /data-ranked-active="true"\]\s+#competitionBatchPanel/);
  assert.match(styles, /data-ranked-active="true"\]\s+\.competition-record-actions/);
});

test("personal and administrator landing pages stay focused on ordinary single-run records", () => {
  const admin = between(adminHtml, 'id="adminRankedEvaluationSection"', 'class="archive-results-section"');

  assert.doesNotMatch(recordsHtml, /personalRankedEvaluationSection|我的筛选五局|refreshPersonalRankingButton/);
  assert.doesNotMatch(recordsScript, /ranked-evaluation|loadPersonalRanking|personalRanking/);
  assert.match(recordsHtml, /每次普通运行结束后都会自动保存/);
  assert.match(recordsHtml, /id="personalRunRecordsTitle">单次运行评分/);
  assert.match(recordsHtml, /id="metricPending"/);
  assert.match(recordsHtml, /<option value="saved">待提交<\/option>/);
  assert.match(recordsScript, /recordState\s*===\s*"saved"/);
  assert.match(recordsScript, /\/submit/);

  assert.match(admin, /筛选五局排名/);
  assert.match(adminHtml, /id="adminRankedEvaluationSection"[^>]*\bhidden\b[^>]*\binert\b/);
  assert.match(admin, /一账号一行/);
  assert.match(admin, /完全相同的排名指标并列/);
  assert.match(admin, /总分 \/ 100/);
  assert.match(admin, /完成局 \/ 5/);
  assert.match(admin, /有效局 \/ 5/);
  assert.match(admin, /最低分 \/ 100/);
  assert.match(admin, /authoritative: false/);
  assert.match(admin, /筛选只缩小结果，不会在浏览器中重排名/);
  assert.match(admin, /id="refreshAdminRankingButton"[^>]*disabled/);

  assert.match(recordsHtml, /id="recordsTableBody"/);
  assert.match(recordsHtml, /id="recordDetailDialog"/);
  assert.match(adminHtml, /id="adminRunRecordsTitle">正式提交记录/);
  assert.match(adminHtml, /id="adminRecordsTableBody"/);
  assert.match(adminHtml, /id="adminRecordDetailDialog"/);
  assert.match(accountCss, /\.evaluation-results-section/);
  assert.match(accountCss, /\.evaluation-ranking-toolbar/);
});

test("ranked page recovery is read-only until the owner explicitly continues", () => {
  const restore = functionSource("restoreRankedEvaluationFromServer");
  assert.match(restore, /\$\{RANKED_EVALUATION_ENDPOINT\}\/me/);
  assert.match(restore, /method:\s*"GET"/);
  assert.doesNotMatch(restore, /leaseCurrentRankedEvaluationSlot\s*\(|runRankedEvaluationSequence\s*\(|runProgram\s*\(/);
  assert.match(app, /startRankedEvaluationButton\?\.addEventListener\("click",\s*openRankedEvaluationConfirmation\)/);
  assert.match(app, /recoverRankedEvaluationButton\?\.addEventListener\("click",\s*recoverOrContinueRankedEvaluation\)/);
  assert.match(app, /confirmRankedEvaluationButton\?\.addEventListener\("click",\s*createConfirmedRankedEvaluation\)/);
  assert.match(app, /await restoreRankedEvaluationFromServer\(\)/);
  assert.match(app, /rankedEvaluationReady && !rankedEvaluationIsOpen\(\)[\s\S]*!rankedEvaluationReservationIncomplete/);
});

test("only the exact interrupted reservation response re-enables original-input creation", async () => {
  const makeContext = initialError => {
    const storage = new Map();
    const posts = [];
    const startLabel = { textContent: "" };
    const confirmLabel = { textContent: "" };
    const context = vm.createContext({
      rankedEvaluationRestorePending: false,
      rankedEvaluationOperation: null,
      rankedEvaluationReady: false,
      rankedEvaluationReservationIncomplete: false,
      rankedEvaluationInterruptedCreate: null,
      pendingRankedEvaluationConfirmation: null,
      rankedEvaluationRequestSerial: 0,
      rankedEvaluationAbortController: null,
      activeRankedEvaluation: null,
      activeMission: { environment: "guangyang", objectTraining: false, competition: { enabled: true, config: {} } },
      pythonReady: true,
      running: false,
      competitionRunStartPending: false,
      competitionBatchOperation: null,
      pythonEditor: { value: "original source", focus() {} },
      competitionTeamIdInput: { value: "team-a", focus() {} },
      rankedEvaluationPanel: { dataset: {} },
      competitionHud: null,
      rankedEvaluationOpportunity: null,
      rankedEvaluationProgress: null,
      rankedEvaluationScore: null,
      rankedEvaluationDeadline: null,
      startRankedEvaluationButton: {
        hidden: false, disabled: true,
        querySelector() { return startLabel; }
      },
      recoverRankedEvaluationButton: null,
      stopRankedEvaluationButton: null,
      confirmRankedEvaluationButton: { disabled: true, querySelector() { return confirmLabel; } },
      rankedEvaluationConfirmDialog: {
        open: false,
        showCount: 0,
        showModal() { this.open = true; this.showCount += 1; },
        close() { this.open = false; },
        removeAttribute() { this.open = false; }
      },
      document: { body: { classList: { toggle() {} } } },
      sessionStorage: {
        getItem(key) { return storage.has(key) ? storage.get(key) : null; },
        setItem(key, value) { storage.set(key, value); },
        removeItem(key) { storage.delete(key); }
      },
      RANKED_EVALUATION_PENDING_CREATE_STORAGE_KEY: "pending-ranked",
      RANKED_EVALUATION_PENDING_CREATE_SCHEMA_VERSION: "chenlong.ranked-pending-create/v1",
      RANKED_EVALUATION_ENDPOINT: "/ranked",
      MAX_RANKED_SOURCE_BYTES: 128 * 1024,
      TextEncoder,
      AbortController,
      rankedEvaluationIsOpen() { return false; },
      rankedEvaluationLocksWorkspace() { return false; },
      competitionBatchIsOpen() { return false; },
      setCompetitionBatchSourceLock() {},
      renderCompetitionBatchPanel() {},
      rankedIsoTimestampIsValid() { return false; },
      setRankedEvaluationStatus(_state, message) { context.lastStatus = message; },
      rankedEvaluationErrorMessage(error) { return String(error?.message || "error"); },
      isCompetitionMission() { return true; },
      currentCompetitionTeamId() { return context.competitionTeamIdInput.value; },
      setStatus() {},
      loadMission() {},
      updateLineNumbers() {},
      renderPythonHighlight() {},
      persistPythonDraft() {},
      async competitionBatchSourceDigest() { return "digest"; },
      hydrateRankedOwnerEvaluation() {},
      continueRankedEvaluation() {},
      async requestRankedEvaluation(_endpoint, options, kind) {
        if (kind === "me") throw initialError;
        posts.push(JSON.parse(options.body));
        return {
          evaluation: {
            lockedSource: "original source",
            lockedTeamId: "team-a",
            batch: { sourceDigest: "digest" }
          }
        };
      }
    });
    vm.runInContext([
      functionSource("normalizeCompetitionBatchTeamId"),
      functionSource("competitionBatchHasExactKeys"),
      functionSource("rankedSourceFitsByteLimit"),
      functionSource("rankedEvaluationReservationIsIncomplete"),
      functionSource("rememberRankedEvaluationPendingCreate"),
      functionSource("clearRankedEvaluationPendingCreate"),
      functionSource("readRankedEvaluationPendingCreate"),
      functionSource("restoreRankedEvaluationInterruptedDraft"),
      functionSource("renderRankedEvaluationPanel"),
      functionSource("restoreRankedEvaluationFromServer"),
      functionSource("closeRankedEvaluationConfirmation"),
      functionSource("openRankedEvaluationConfirmation"),
      functionSource("createConfirmedRankedEvaluation"),
      "this.remember = rememberRankedEvaluationPendingCreate;",
      "this.restore = restoreRankedEvaluationFromServer;",
      "this.openConfirmation = openRankedEvaluationConfirmation;",
      "this.confirmCreation = createConfirmedRankedEvaluation;"
    ].join("\n"), context);
    return { context, posts, storage };
  };

  const interrupted = makeContext({
    status: 503,
    code: "RANKED_ATTEMPT_RESERVATION_INCOMPLETE",
    message: "internal reservation detail must not be shown"
  });
  interrupted.context.remember("original source", "team-a");
  interrupted.context.pythonEditor.value = "changed source";
  interrupted.context.competitionTeamIdInput.value = "changed-team";
  await interrupted.context.restore();
  assert.equal(interrupted.context.startRankedEvaluationButton.disabled, false);
  assert.equal(interrupted.context.pythonEditor.value, "original source");
  assert.equal(interrupted.context.competitionTeamIdInput.value, "team-a");
  assert.match(interrupted.context.lastStatus, /创建中断/);

  interrupted.context.openConfirmation();
  assert.equal(interrupted.posts.length, 0, "opening the second confirmation never creates the attempt");
  assert.equal(interrupted.context.rankedEvaluationConfirmDialog.showCount, 1);
  assert.equal(interrupted.context.confirmRankedEvaluationButton.disabled, false);
  await interrupted.context.confirmCreation();
  assert.deepEqual(interrupted.posts, [{ source: "original source", teamId: "team-a" }]);
  assert.equal(interrupted.storage.has("pending-ranked"), false, "successful recovery clears the tab-local draft");

  const storageFailure = makeContext({
    status: 503,
    code: "RANKED_ATTEMPT_RESERVATION_INCOMPLETE",
    message: "reservation incomplete"
  });
  storageFailure.context.remember("original source", "team-a");
  await storageFailure.context.restore();
  storageFailure.context.openConfirmation();
  storageFailure.context.sessionStorage.setItem = () => { throw new Error("quota exceeded"); };
  await storageFailure.context.confirmCreation();
  assert.equal(storageFailure.posts.length, 0, "failed tab-local persistence must prevent the one-shot POST");
  assert.equal(storageFailure.context.activeRankedEvaluation, null);
  assert.match(storageFailure.context.lastStatus, /创建请求未发送/);

  const genericFailure = makeContext({ status: 500, code: "INTERNAL_ERROR", message: "private detail" });
  await genericFailure.context.restore();
  assert.equal(genericFailure.context.startRankedEvaluationButton.disabled, true);
  assert.equal(genericFailure.posts.length, 0);
  assert.doesNotMatch(genericFailure.context.lastStatus, /重新二次确认/);
});

test("ranked confirmation enforces the frozen UTF-8 source byte limit before creation", () => {
  const context = vm.createContext({ MAX_RANKED_SOURCE_BYTES: 8, TextEncoder });
  vm.runInContext(
    `${functionSource("rankedSourceFitsByteLimit")}; this.fits = rankedSourceFitsByteLimit;`,
    context
  );
  assert.equal(context.fits("12345678"), true);
  assert.equal(context.fits("广阳岛"), false, "three Chinese characters exceed an eight-byte UTF-8 limit");
  const confirmation = functionSource("openRankedEvaluationConfirmation");
  assert.match(confirmation, /rankedSourceFitsByteLimit\(source\)/);
  assert.match(confirmation, /UTF-8/);
  assert.match(confirmation, /不会占用本赛季机会/);
});

test("ranked deadline and evidence failures use bounded Chinese guidance", () => {
  const mapper = functionSource("rankedEvaluationErrorMessage");
  for (const code of [
    "SUBMISSION_DEADLINE_EXPIRED", "RANKED_SUBMISSION_OUTSIDE_WINDOW",
    "BATCH_RECEIPT_EVIDENCE_CORRUPTED", "BATCH_FINALIZATION_EVIDENCE_CONFLICT",
    "SESSION_SCOPE_LIMIT_REACHED"
  ]) assert.match(mapper, new RegExp(code));
  assert.match(mapper, /已过服务器截止/);
  assert.match(mapper, /归档证据异常/);
  assert.match(mapper, /管理员处理/);
  assert.equal(
    vm.runInNewContext(`(${mapper})({ code: "SESSION_SCOPE_LIMIT_REACHED" })`),
    "当前筛选运行名额已满，请稍后重试；不会额外占用机会。"
  );
});

test("ranked creation and open phases keep practice and manual lifecycle controls locked", () => {
  assert.match(functionSource("rankedEvaluationLocksWorkspace"), /uiState\s*===\s*"creating"/);
  assert.match(functionSource("rankedEvaluationLocksWorkspace"), /rankedEvaluationReservationIncomplete/);
  assert.match(functionSource("setCompetitionBatchSourceLock"), /rankedEvaluationLocksWorkspace\(\)/);
  assert.match(functionSource("renderCompetitionBatchPanel"), /rankedEvaluationLocksWorkspace/);
  assert.match(functionSource("startOrContinueCompetitionBatch"), /rankedEvaluationLocksWorkspace/);
  assert.match(functionSource("loadMission"), /managedFiveRunIsOpen\(\)[\s\S]*rankedEvaluationLocksWorkspace\(\)/);
  assert.match(functionSource("loadExample"), /managedFiveRunIsOpen\(\)[\s\S]*rankedEvaluationLocksWorkspace\(\)/);
  assert.match(functionSource("runProgram"), /managedFiveRunIsOpen\(\)[\s\S]*rankedEvaluationLocksWorkspace\(\)[\s\S]*!fiveRunManaged/);
  assert.match(styles, /body\.is-ranked-evaluation-active\s+#runButton/);
});

test("every ranked owner response requires the same eleven-key timestamped projection", () => {
  const projection = functionSource("normalizeRankedEvaluationProjection");
  const response = functionSource("normalizeRankedEvaluationResponse");
  assert.match(projection, /"createdAt",\s*"expiresAt"/);
  assert.match(projection, /rankedIsoTimestampIsValid\(value\.createdAt\)/);
  assert.match(projection, /rankedIsoTimestampIsValid\(value\.expiresAt\)/);
  assert.match(projection, /Date\.parse\(value\.expiresAt\)\s*<=\s*Date\.parse\(value\.createdAt\)/);
  assert.match(response, /normalizeRankedEvaluationProjection\(payload\.evaluation,\s*\{\s*owner:\s*true\s*\}\)/);
  assert.doesNotMatch(recordsScript, /ranked-evaluation|evaluation\.expiresAt/);
  assert.match(adminScript, /validIsoTimestamp\(value\.createdAt\)/);
});

test("ranked runs use only the ranked lease and ranked submission chain for all five slots", async () => {
  const calls = [];
  const active = {
    batch: { phase: "open", nextSlotIndex: 1 },
    lease: null,
    pendingRecord: null,
    currentScore: null,
    stopRequested: false,
    fatal: false
  };
  const context = vm.createContext({
    activeRankedEvaluation: active,
    latestCompetitionRecord: null,
    rankedEvaluationIsOpen(batch = active.batch) {
      return batch?.phase === "open" && Number.isSafeInteger(batch.nextSlotIndex);
    },
    async leaseCurrentRankedEvaluationSlot() {
      const slotIndex = active.batch.nextSlotIndex;
      const lease = {
        slotIndex,
        session: {
          runId: `run-${slotIndex}`,
          sessionId: `session-${slotIndex}`,
          challengeDigest: `digest-${slotIndex}`
        }
      };
      active.lease = lease;
      calls.push(["ranked-lease", slotIndex]);
      return lease;
    },
    async runProgram(options) {
      assert.equal(options?.rankedManaged, true);
      assert.deepEqual(Object.keys(options || {}), ["rankedManaged"]);
      const { session, slotIndex } = active.lease;
      context.latestCompetitionRecord = {
        runId: session.runId,
        serverSessionId: session.sessionId,
        challengeDigest: session.challengeDigest,
        result: { score: slotIndex }
      };
      calls.push(["ranked-run", slotIndex]);
    },
    async submitCurrentRankedEvaluationSlot() {
      const slotIndex = active.lease.slotIndex;
      calls.push(["ranked-submission", slotIndex]);
      active.lease = null;
      if (slotIndex === 5) {
        active.batch = { phase: "finalized", nextSlotIndex: null };
      } else {
        active.batch = { phase: "open", nextSlotIndex: slotIndex + 1 };
      }
    },
    async closeActiveRankedEvaluation() { assert.fail("normal five-slot completion must not close early"); },
    async refreshFinalizedRankedEvaluation() { calls.push(["ranked-result", 5]); },
    rankedEvaluationErrorMessage(error) { throw error; },
    setRankedEvaluationStatus() {},
    renderRankedEvaluationPanel() {},
    setStatus() {},
    addLog() {}
  });
  vm.runInContext(
    `${functionSource("runRankedEvaluationSequence")}; this.runRanked = runRankedEvaluationSequence;`,
    context
  );
  await context.runRanked();
  assert.deepEqual(calls.filter(([kind]) => kind === "ranked-lease").map(([, slot]) => slot), [1, 2, 3, 4, 5]);
  assert.deepEqual(calls.filter(([kind]) => kind === "ranked-run").map(([, slot]) => slot), [1, 2, 3, 4, 5]);
  assert.deepEqual(calls.filter(([kind]) => kind === "ranked-submission").map(([, slot]) => slot), [1, 2, 3, 4, 5]);
  assert.equal(calls.some(([kind]) => /ordinary|practice|session-create/.test(kind)), false);

  const start = functionSource("startCompetitionRun");
  assert.match(start, /const rankedManaged\s*=\s*rankedEvaluationIsOpen\(\)/);
  assert.match(start, /const managedActive\s*=\s*rankedManaged\s*\?\s*activeRankedEvaluation/);
  assert.match(start, /const serverSession\s*=\s*batchLease\s*\?\s*null\s*:\s*await createCompetitionServerSession/);
  assert.match(functionSource("leaseCurrentRankedEvaluationSlot"), /current-slot\/lease/);
  assert.match(functionSource("submitCurrentRankedEvaluationSlot"), /\/slots\/\$\{slotIndex\}\/sessions\/\$\{encodeURIComponent\(lease\.session\.sessionId\)\}\/submissions/);
});

test("ranked lease strongly binds current slot, session, and the exact run definition", () => {
  const now = Date.now();
  const layout = {
    schemaVersion: "chenlong.guangyang-layout-selection/v1",
    catalogVersion: "catalog-v2",
    mapId: "map-a",
    mapVersion: "v1",
    slotIndex: 1,
    sequenceLength: 5,
    layoutCommitment: "a".repeat(64)
  };
  const session = {
    schemaVersion: "chenlong.local-session/v1",
    sessionId: `ses_${"1".repeat(32)}`,
    runId: `run_${"2".repeat(32)}`,
    teamId: "team-a",
    challenge: {
      taskId: "task-a", taskVersion: "v1", mapId: "map-a", mapVersion: "v1",
      ruleVersion: "v1", displayName: "challenge", timeLimitSeconds: 600
    },
    challengeDigest: "b".repeat(64),
    createdAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    status: "open",
    submissionCount: 0,
    maxSubmissions: 5,
    authoritative: false,
    ownerUserId: `usr_${"3".repeat(32)}`
  };
  const lease = {
    schemaVersion: "chenlong.ranked-slot-lease/v1",
    authoritative: false,
    recovered: false,
    competitionId: "competition-a",
    batchId: `bat_${"4".repeat(32)}`,
    slotIndex: 1,
    layout: { ...layout },
    session,
    runDefinition: {
      visionDefinition: {},
      navigationDefinition: {},
      navigationControlDefinition: {},
      simulationDefinition: { schemaVersion: "chenlong.simulation/v1", stepMs: 20 },
      interactionDefinition: {
        schemaVersion: "chenlong.package-interaction/v2",
        packages: [
          { id: "target", x: 1, z: 1, stackLevel: 0, role: "target", radius: 0.2 },
          { id: "distractor", x: 2, z: 2, stackLevel: 0, role: "distractor", radius: 0.2 },
          { id: "obstacle", x: 3, z: 3, stackLevel: 0, role: "obstacle", radius: 0.2 }
        ]
      },
      taskDefinition: { schemaVersion: "chenlong.task/v5", id: "task-a", version: "v1" },
      ruleDefinition: {},
      scoringDefinition: {},
      timeLimitTicks: 30_000
    }
  };
  const context = vm.createContext({
    RANKED_SLOT_LEASE_SCHEMA_VERSION: "chenlong.ranked-slot-lease/v1",
    RANKED_COMPETITION_ID: "competition-a",
    SESSION_SCHEMA_VERSION: "chenlong.local-session/v1",
    RANKED_CURRENT_SLOT_KEYS: Object.freeze(Object.keys(layout)),
    GUANGYANG_RUNTIME_CONFIG: {
      taskId: "task-a", taskVersion: "v1", mapId: "map-a", mapVersion: "v1", ruleVersion: "v1"
    },
    Date, Set, Number,
    normalizeRankedEvaluationResponse(payload) { return payload; }
  });
  vm.runInContext(
    `${functionSource("competitionBatchHasExactKeys")};\n`
      + `${functionSource("rankedIsoTimestampIsValid")};\n`
      + `${functionSource("normalizeRankedLeaseResponse")};\n`
      + "this.normalizeLease = normalizeRankedLeaseResponse;",
    context
  );
  const payload = { evaluation: { currentSlot: { ...layout } }, lease };
  assert.doesNotThrow(() => context.normalizeLease(payload, lease.batchId, 1, "team-a"));
  const drifted = structuredClone(payload);
  drifted.lease.layout.layoutCommitment = "c".repeat(64);
  assert.throws(() => context.normalizeLease(drifted, lease.batchId, 1, "team-a"), /租约不兼容/);
  const leaked = structuredClone(payload);
  leaked.lease.session.futureLayout = { slotIndex: 2 };
  assert.throws(() => context.normalizeLease(leaked, lease.batchId, 1, "team-a"), /租约不兼容/);
  const futureRunDefinition = structuredClone(payload);
  futureRunDefinition.lease.runDefinition.futureLayouts = [];
  assert.throws(() => context.normalizeLease(futureRunDefinition, lease.batchId, 1, "team-a"), /租约不兼容/);
  const mismatchedTask = structuredClone(payload);
  mismatchedTask.lease.runDefinition.taskDefinition.version = "v2";
  assert.throws(() => context.normalizeLease(mismatchedTask, lease.batchId, 1, "team-a"), /租约不兼容/);
  const mismatchedDeadline = structuredClone(payload);
  mismatchedDeadline.lease.runDefinition.timeLimitTicks -= 1;
  assert.throws(() => context.normalizeLease(mismatchedDeadline, lease.batchId, 1, "team-a"), /租约不兼容/);
});

test("ranked result tables expose only human-readable aggregate columns", () => {
  const adminHead = between(adminHtml, '<table class="record-table evaluation-table admin-ranking-table">', "</thead>");
  for (const head of [adminHead]) {
    assert.doesNotMatch(head, /源码|摘要|布局|场次|批次编号|session|source|digest|commitment|slot/i);
  }
});
