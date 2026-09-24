"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const CompetitionCore = require("../competition-core.js");
const { LOCAL_CHALLENGES } = require("../server.js");
const { canonicalJson, canonicalSha256 } = require("../backend/canonical-json.js");
const {
  GuangyangMapConfigStore,
  MAP_CONFIG_SCHEMA_VERSION,
  MAP_LAYOUT_SCHEMA_VERSION,
  MAP_CONFIG_UPDATE_SCHEMA_VERSION,
  MAP_CONFIG_BINDING_SCHEMA_VERSION
} = require("../backend/guangyang-map-config-store.js");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const baseConfig = CompetitionCore.GUANGYANG_ISLAND_CONFIG;
const baseChallenge = LOCAL_CHALLENGES[baseConfig.taskId];

function functionSource(name) {
  const functionStart = app.indexOf(`function ${name}(`);
  assert.ok(functionStart >= 0, `missing function ${name}`);
  const start = app.slice(Math.max(0, functionStart - 6), functionStart) === "async "
    ? functionStart - 6
    : functionStart;
  const remaining = app.slice(start + 1);
  const nextDeclaration = /\n(?:async\s+)?function\s+/.exec(remaining);
  const end = nextDeclaration ? start + 1 + nextDeclaration.index : app.length;
  return app.slice(start, end);
}

function clientContractContext() {
  const context = vm.createContext({
    CompetitionCore,
    structuredClone,
    TextEncoder,
    crypto: crypto.webcrypto,
    GUANGYANG_CONFIG: baseConfig,
    GUANGYANG_RUNTIME_CONFIG: baseConfig,
    GUANGYANG_CONFIG_BY_TASK_ID: Object.fromEntries(
      CompetitionCore.GUANGYANG_CHALLENGE_CONFIGS.map(config => [config.taskId, config])
    ),
    SESSION_SCHEMA_VERSION: "chenlong.local-session/v1",
    AI_AUTONOMY_SESSION_MODE: "ai",
    PUBLISHED_MAP_CONFIG_SCHEMA_VERSION: MAP_CONFIG_SCHEMA_VERSION,
    PUBLISHED_MAP_LAYOUT_SCHEMA_VERSION: MAP_LAYOUT_SCHEMA_VERSION,
    PUBLISHED_MAP_BINDING_SCHEMA_VERSION: MAP_CONFIG_BINDING_SCHEMA_VERSION
  });
  vm.runInContext([
    "const globalThis = this;",
    functionSource("jsonStructuresEqual"),
    functionSource("canonicalJsonForMapConfig"),
    functionSource("normalizePublishedMapPoint"),
    functionSource("expectedPublishedMapVersion"),
    functionSource("normalizePublishedMapLayout"),
    functionSource("normalizePublishedMapConfigEnvelope"),
    functionSource("normalizePublishedMapBinding"),
    functionSource("guangyangConfigForTaskId"),
    functionSource("guangyangObjectOverlayFromLayout"),
    functionSource("publishedLayoutFromRunDefinition"),
    functionSource("validateFrozenGuangyangRunDefinition"),
    functionSource("guangyangConfigFromFrozenRunDefinition"),
    functionSource("normalizeServerSession"),
    `async function sha256Hex(buffer) {
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    }`,
    functionSource("publishedMapLayoutDigest"),
    functionSource("assertPublishedMapDigest")
  ].join("\n"), context);
  return context;
}

async function temporaryStore(t, { config = baseConfig, challenge = baseChallenge } = {}) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chenlong-map-client-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.promises.rm(resolved, { recursive: true, force: true });
  });
  const store = new GuangyangMapConfigStore({
    rootDir: directory,
    baseConfig: config,
    baseChallenge: challenge
  });
  await store.ready;
  return store;
}

function singleSessionPayload(snapshot) {
  const { runDefinition: _privateDefinition, ...challenge } = snapshot.challenge;
  return {
    schemaVersion: "chenlong.local-session/v1",
    authoritative: false,
    sessionId: `ses_${"1".repeat(32)}`,
    runId: `run_${"2".repeat(32)}`,
    teamId: `tea_${"3".repeat(32)}`,
    challenge: { ...challenge, sessionMode: "standard" },
    challengeDigest: "4".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    submitToken: "t".repeat(43),
    mapConfig: snapshot.binding,
    runDefinition: snapshot.runDefinition
  };
}

test("participant accepts the exact revision-zero public map and verifies its canonical digest", async t => {
  const store = await temporaryStore(t);
  const snapshot = await store.snapshot();
  const payload = await store.publicConfig();
  const context = clientContractContext();
  const normalized = context.normalizePublishedMapConfigEnvelope(structuredClone(payload));

  assert.equal(normalized.revision, 0);
  assert.equal(normalized.updatedAt, null);
  assert.equal(normalized.mapVersion, baseChallenge.mapVersion);
  const hostLayout = JSON.parse(JSON.stringify(normalized.layout));
  assert.equal(context.canonicalJsonForMapConfig(normalized.layout), canonicalJson(hostLayout));
  assert.equal(await context.publishedMapLayoutDigest(normalized.layout), snapshot.digest);
  await context.assertPublishedMapDigest(normalized.layout, normalized.digest);

  await assert.rejects(
    context.assertPublishedMapDigest(
      { ...structuredClone(normalized.layout), targets: [[normalized.layout.targets[0][0] + 0.01, normalized.layout.targets[0][1]]] },
      normalized.digest
    ),
    /完整性校验失败/
  );
});

test("participant rejects extra fields and revision/version mismatches in public map envelopes", async t => {
  const store = await temporaryStore(t);
  const payload = await store.publicConfig();
  const context = clientContractContext();

  assert.throws(
    () => context.normalizePublishedMapConfigEnvelope({ ...structuredClone(payload), unexpected: true }),
    /响应不兼容/
  );
  assert.throws(
    () => context.normalizePublishedMapConfigEnvelope({ ...structuredClone(payload), mapVersion: "wrong" }),
    /响应不兼容/
  );
  assert.throws(
    () => context.normalizePublishedMapConfigEnvelope({ ...structuredClone(payload), revision: -1 }),
    /响应不兼容/
  );
  const stringCoordinate = structuredClone(payload);
  stringCoordinate.layout.targets = stringCoordinate.layout.targets.map(point => point.map(String));
  assert.throws(
    () => context.normalizePublishedMapConfigEnvelope(stringCoordinate),
    /目标物 1坐标不兼容/
  );
  assert.throws(
    () => context.normalizePublishedMapConfigEnvelope({
      ...structuredClone(payload),
      revision: 1,
      updatedAt: "2026-08-21 00:00:00Z",
      digest: "a".repeat(64),
      mapVersion: `${baseChallenge.mapVersion}@map-r1-${"a".repeat(12)}`
    }),
    /响应不兼容/
  );
});

test("participant keeps each Guangyang challenge map and frozen session definition separate", async t => {
  const challengeTwoConfig = CompetitionCore.GUANGYANG_CHALLENGE_CONFIGS[1];
  const challengeTwo = LOCAL_CHALLENGES[challengeTwoConfig.taskId];
  const store = await temporaryStore(t, { config: challengeTwoConfig, challenge: challengeTwo });
  const baseline = await store.publicConfig();
  await store.update({
    schemaVersion: MAP_CONFIG_UPDATE_SCHEMA_VERSION,
    baseRevision: 0,
    layout: { ...structuredClone(baseline.layout), targets: [[-9.8, -6.65], ...baseline.layout.targets.slice(1)] }
  });
  const snapshot = await store.snapshot();
  const context = clientContractContext();
  const normalizedMap = context.normalizePublishedMapConfigEnvelope(
    structuredClone(await store.publicConfig()),
    challengeTwoConfig
  );
  assert.equal(normalizedMap.mapVersion, snapshot.binding.mapVersion);
  assert.equal(normalizedMap.revision, 1);
  const session = context.normalizeServerSession(
    singleSessionPayload(snapshot),
    challengeTwoConfig
  );
  assert.equal(session.challenge.taskId, challengeTwoConfig.taskId);
  assert.equal(session.challenge.displayName, "广阳岛综合任务2");
  assert.equal(session.runDefinition.timeLimitTicks, 600 * 50);
  assert.deepEqual(Array.from(session.mapLayout.targets[0]), [-9.8, -6.65]);
});

test("single-session client binds the exact server run definition and fails closed on malformed definitions", async t => {
  const store = await temporaryStore(t);
  const initial = await store.publicConfig();
  await store.update({
    schemaVersion: MAP_CONFIG_UPDATE_SCHEMA_VERSION,
    baseRevision: 0,
    layout: { ...structuredClone(initial.layout), targets: [[-9.8, -6.65]] }
  });
  const snapshot = await store.snapshot();
  const context = clientContractContext();
  const payload = singleSessionPayload(snapshot);
  const normalized = context.normalizeServerSession(
    structuredClone(payload),
    baseConfig
  );

  assert.deepEqual(normalized.mapConfig, snapshot.binding);
  assert.deepEqual(normalized.runDefinition, snapshot.runDefinition);
  assert.equal(normalized.mapConfig.revision, 1);
  assert.deepEqual(Array.from(normalized.mapLayout.targets[0]), [-9.8, -6.65]);
  await context.assertPublishedMapDigest(normalized.mapLayout, normalized.mapConfig.digest);

  const config = context.guangyangConfigFromFrozenRunDefinition(
    normalized.runDefinition,
    normalized.challenge,
    normalized.mapConfig
  );
  const session = CompetitionCore.createSession(config, {
    teamId: normalized.teamId,
    runId: normalized.runId,
    serverSessionId: normalized.sessionId,
    challengeDigest: normalized.challengeDigest,
    sourceCode: "robot.forward(1)",
    runDefinition: normalized.runDefinition,
    simulationDefinition: normalized.runDefinition.simulationDefinition,
    interactionDefinition: normalized.runDefinition.interactionDefinition
  }, { now: () => 0 });
  assert.equal(
    canonicalSha256(session.recorder.export().runDefinition),
    canonicalSha256(snapshot.runDefinition),
    "the browser recorder must retain the byte-canonical frozen server definition"
  );

  const extraDefinition = structuredClone(payload);
  extraDefinition.runDefinition.unexpected = true;
  assert.throws(
    () => context.normalizeServerSession(extraDefinition, baseConfig),
    /冻结运行定义不兼容/
  );

  const wrongBinding = structuredClone(payload);
  wrongBinding.mapConfig.mapVersion = "wrong";
  assert.throws(
    () => context.normalizeServerSession(wrongBinding, baseConfig),
    /地图版本绑定不兼容/
  );
});

test("AI autonomy sessions require the non-disclosing navigation contract", async t => {
  const store = await temporaryStore(t);
  const snapshot = await store.snapshot();
  const context = clientContractContext();
  const payload = singleSessionPayload(snapshot);
  payload.challenge.sessionMode = "ai";
  payload.runDefinition = {
    ...payload.runDefinition,
    navigationDefinition: CompetitionCore.NAVIGATION_DEFINITION
  };

  const normalized = context.normalizeServerSession(
    structuredClone(payload),
    baseConfig,
    true
  );
  assert.equal(normalized.aiAutonomyMode, true);
  assert.deepEqual(normalized.runDefinition.navigationDefinition, CompetitionCore.NAVIGATION_DEFINITION);
  assert.throws(
    () => context.normalizeServerSession(structuredClone(payload), baseConfig, false),
    /AI 自主模式与当前选择不一致/
  );
});

test("old records can rebuild their frozen map without weakening new-session runtime checks", async t => {
  const store = await temporaryStore(t);
  const snapshot = await store.snapshot();
  const context = clientContractContext();
  const legacyDefinition = structuredClone(snapshot.runDefinition);
  legacyDefinition.navigationDefinition = {
    ...legacyDefinition.navigationDefinition,
    schemaVersion: "chenlong.navigation/v1"
  };
  delete legacyDefinition.navigationControlDefinition;

  assert.doesNotThrow(() => context.guangyangConfigFromFrozenRunDefinition(
    legacyDefinition,
    singleSessionPayload(snapshot).challenge,
    null,
    { requireCurrentRuntime: false }
  ));

  const issuedSession = singleSessionPayload(snapshot);
  issuedSession.runDefinition = legacyDefinition;
  assert.throws(
    () => context.normalizeServerSession(issuedSession, baseConfig),
    /冻结运行定义不兼容/
  );
  assert.match(
    functionSource("guangyangMissionFromFrozenRecord"),
    /requireCurrentRuntime:\s*false/
  );
});

test("participant scene, scoring, collision and replay all consume frozen or published definitions", () => {
  const fetcher = functionSource("refreshPublishedGuangyangMap");
  const verifier = functionSource("verifyAndCacheSingleSessionMap");
  const starter = functionSource("startCompetitionRun");
  const installer = functionSource("installGuangyangMissionSnapshot");
  const missionBuilder = functionSource("guangyangMissionFromConfig");
  const replay = functionSource("replayLatestCompetitionRecord");

  assert.match(app, /const PUBLISHED_MAP_CONFIG_ENDPOINT\s*=\s*"\/api\/v1\/map-config"/);
  assert.match(fetcher, /normalizePublishedMapConfigEnvelope\(payload,\s*taskConfig\)/);
  assert.match(fetcher, /await assertPublishedMapDigest\(mapConfig\.layout,\s*mapConfig\.digest\)/);
  assert.match(verifier, /await assertPublishedMapDigest\(session\.mapLayout,\s*session\.mapConfig\.digest\)/);
  assert.match(starter, /const frozenMission\s*=\s*guangyangMissionFromConfig\(frozenConfig\)/);
  assert.match(starter, /frozenMission\.aiAutonomyMode\s*=\s*serverSession\.aiAutonomyMode\s*===\s*true/);
  assert.match(starter, /installGuangyangMissionSnapshot\(frozenMission,\s*\{\s*preserveCamera:\s*true\s*\}\)/);
  assert.match(installer, /\{\s*announce\s*=\s*false,\s*preserveCamera\s*=\s*false\s*\}/);
  assert.match(installer, /if\s*\(!preserveCamera\)\s*setCameraMode\(/,
    "starting a run must preserve the participant's current orbit, zoom and view mode");
  assert.match(starter, /new globalThis\.CompetitionCore\.DeterministicSimulator\([\s\S]*serverSession\.runDefinition\.simulationDefinition/);
  assert.match(starter, /runDefinition:\s*serverSession\.runDefinition/);
  assert.match(starter, /jsonStructuresEqual\(createdRunDefinition,\s*serverSession\.runDefinition\)/);
  assert.match(missionBuilder, /mission\.objectObstacles\s*=\s*overlay\.objects/);
  assert.match(missionBuilder, /mission\.packages\s*=\s*overlay\.objects/);
  assert.match(missionBuilder, /mission\.completion\s*=\s*\{/);
  assert.match(missionBuilder, /mission\.competition\s*=\s*\{\s*enabled:\s*true,\s*config\s*\}/);
  assert.match(replay, /guangyangMissionFromFrozenRecord\(latestCompetitionRecord\)/);
  assert.match(replay, /installGuangyangMissionSnapshot\(frozenReplayMission\)/);
});

test("a slow map GET cannot roll back a newer session binding or create a same-revision fork", async t => {
  const store = await temporaryStore(t);
  const baseline = await store.publicConfig();
  const oldDigest = "a".repeat(64);
  const newDigest = "b".repeat(64);
  const oldEnvelope = {
    ...structuredClone(baseline),
    revision: 1,
    updatedAt: "2026-08-21T00:00:00.000Z",
    digest: oldDigest,
    mapVersion: `${baseChallenge.mapVersion}@map-r1-${oldDigest.slice(0, 12)}`
  };
  const newEnvelope = {
    ...structuredClone(baseline),
    revision: 2,
    updatedAt: "2026-08-21T00:01:00.000Z",
    digest: newDigest,
    mapVersion: `${baseChallenge.mapVersion}@map-r2-${newDigest.slice(0, 12)}`
  };
  let releaseGet;
  const getGate = new Promise(resolve => { releaseGet = resolve; });
  const context = clientContractContext();
  Object.assign(context, {
    PUBLISHED_MAP_CONFIG_ENDPOINT: "/api/v1/map-config",
    COMPETITION_SESSION_TIMEOUT_MS: 2500,
    chenlongAuthReady: Promise.resolve({ id: `usr_${"3".repeat(32)}` }),
    requestVerificationEndpoint: async () => {
      await getGate;
      return { response: { ok: true, status: 200 }, payload: structuredClone(oldEnvelope) };
    },
    normalizeRecordServiceError: () => new Error("request failed"),
    assertPublishedMapDigest: async () => true,
    guangyangConfigFromPublishedMap: value => value,
    guangyangMissionFromConfig: value => ({ value }),
    officialGuangyangSceneCanRefresh: () => false,
    installGuangyangMissionSnapshot: () => { throw new Error("stale map must not be installed"); }
  });
  vm.runInContext([
    "let publishedGuangyangMapConfig = null;",
    "let publishedGuangyangMission = null;",
    "let publishedMapConfigRequest = null;",
    "let publishedMapConfigRequestSerial = 0;",
    "const publishedGuangyangMapConfigs = new Map();",
    "const publishedGuangyangMissions = new Map();",
    "const publishedMapConfigRequests = new Map();",
    "const publishedMapConfigRequestSerials = new Map();",
    "function activeGuangyangChallengeConfig() { return GUANGYANG_RUNTIME_CONFIG; }",
    "function guangyangConfigForTaskId() { return GUANGYANG_RUNTIME_CONFIG; }",
    "function publishedMapConfigEndpoint() { return PUBLISHED_MAP_CONFIG_ENDPOINT; }",
    "function cachePublishedGuangyangMission(taskId, mapConfig, mission) { publishedGuangyangMapConfigs.set(taskId, mapConfig); publishedGuangyangMissions.set(taskId, mission); publishedGuangyangMapConfig = mapConfig; publishedGuangyangMission = mission; }",
    functionSource("refreshPublishedGuangyangMap")
  ].join("\n"), context);

  const pendingOldGet = context.refreshPublishedGuangyangMap();
  vm.runInContext(
    `publishedGuangyangMapConfigs.set(${JSON.stringify(baseConfig.taskId)}, ${JSON.stringify(newEnvelope)});
     publishedGuangyangMissions.set(${JSON.stringify(baseConfig.taskId)}, { marker: "new-session-map" });
     publishedGuangyangMapConfig = ${JSON.stringify(newEnvelope)};
     publishedGuangyangMission = { marker: "new-session-map" };`,
    context
  );
  releaseGet();
  await pendingOldGet;
  assert.equal(vm.runInContext(`publishedGuangyangMapConfigs.get(${JSON.stringify(baseConfig.taskId)}).revision`, context), 2);
  assert.equal(vm.runInContext(`publishedGuangyangMissions.get(${JSON.stringify(baseConfig.taskId)}).marker`, context), "new-session-map");

  assert.match(
    functionSource("verifyAndCacheSingleSessionMap"),
    /session\.mapConfig\.revision\s*<\s*previous\.revision[\s\S]*早于当前已发布地图/
  );
  assert.match(
    functionSource("refreshPublishedGuangyangMap"),
    /mapConfig\.revision\s*===\s*previous\.revision[\s\S]*相同版本的内容冲突/
  );
});
