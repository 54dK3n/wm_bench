"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { GUANGYANG_ISLAND_CONFIG, GUANGYANG_CHALLENGE_CONFIGS } = require("../competition-core.js");
const { LOCAL_CHALLENGES, createServer } = require("../server.js");
const { canonicalSha256 } = require("../backend/canonical-json.js");
const {
  MAP_CONFIG_SCHEMA_VERSION,
  MAP_LAYOUT_SCHEMA_VERSION,
  MAP_CONFIG_UPDATE_SCHEMA_VERSION,
  MAP_CONFIG_STORE_SCHEMA_VERSION,
  MAP_CONFIG_BINDING_SCHEMA_VERSION,
  MAP_CONFIG_FILENAME,
  GuangyangMapConfigStoreError,
  GuangyangMapConfigStore
} = require("../backend/guangyang-map-config-store.js");

const TASK_ID = GUANGYANG_ISLAND_CONFIG.taskId;
const BASE_CHALLENGE = LOCAL_CHALLENGES[TASK_ID];

async function temporaryDirectory(t, prefix = "chenlong-map-config-") {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.match(path.basename(resolved), new RegExp(`^${prefix}`));
    await fs.promises.rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

function createStore(rootDir, options = {}) {
  return new GuangyangMapConfigStore({
    rootDir,
    baseConfig: GUANGYANG_ISLAND_CONFIG,
    baseChallenge: BASE_CHALLENGE,
    ...options
  });
}

function updateRequest(baseRevision, layout) {
  return {
    schemaVersion: MAP_CONFIG_UPDATE_SCHEMA_VERSION,
    baseRevision,
    layout
  };
}

function changedLayout(original, target = [-9.8, -6.65]) {
  const layout = structuredClone(original);
  layout.targets[0] = target;
  return layout;
}

function assertMapConfigEnvelope(value, revision) {
  assert.deepEqual(Object.keys(value).sort(), [
    "authoritative", "baseMapVersion", "digest", "layout", "mapId", "mapVersion",
    "revision", "schemaVersion", "updatedAt"
  ].sort());
  assert.equal(value.schemaVersion, MAP_CONFIG_SCHEMA_VERSION);
  assert.equal(value.authoritative, false);
  assert.equal(value.mapId, GUANGYANG_ISLAND_CONFIG.mapId);
  assert.equal(value.baseMapVersion, BASE_CHALLENGE.mapVersion);
  assert.equal(value.revision, revision);
  assert.equal(value.digest, canonicalSha256(value.layout));
  assert.match(value.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(value.layout).sort(), [
    "checkpoints", "distractors", "obstacles", "schemaVersion", "storage", "targets"
  ].sort());
  assert.equal(value.layout.schemaVersion, MAP_LAYOUT_SCHEMA_VERSION);
  assert.equal(value.layout.checkpoints.length, 4);
  assert.equal(value.layout.targets.length, 1);
  assert.equal(value.layout.distractors.length, 1);
  assert.equal(value.layout.obstacles.length, 1);
}

test("missing map configuration exposes the frozen original layout as revision zero", async t => {
  const rootDir = await temporaryDirectory(t);
  const store = createStore(rootDir);
  const view = await store.publicConfig();
  assertMapConfigEnvelope(view, 0);
  assert.equal(view.updatedAt, null);
  assert.equal(view.mapVersion, BASE_CHALLENGE.mapVersion);
  assert.equal(fs.existsSync(path.join(rootDir, MAP_CONFIG_FILENAME)), false);

  view.layout.targets[0][0] = 0;
  const unchanged = await store.publicConfig();
  assert.deepEqual(unchanged.layout.targets[0], [-9.8687, -6.7181], "public projections must not mutate store state");

  const snapshot = await store.snapshot();
  assert.deepEqual(Object.keys(snapshot.binding).sort(), [
    "digest", "mapVersion", "revision", "schemaVersion"
  ].sort());
  assert.equal(snapshot.binding.schemaVersion, MAP_CONFIG_BINDING_SCHEMA_VERSION);
  assert.equal(snapshot.challenge.runDefinition, snapshot.runDefinition);
  assert.equal(snapshot.challenge.mapVersion, BASE_CHALLENGE.mapVersion);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.runDefinition));
});

test("legacy single-object map publication migrates in memory to the multi-object layout", async t => {
  const rootDir = await temporaryDirectory(t, "chenlong-map-config-legacy-");
  const legacyLayout = {
    schemaVersion: "chenlong.guangyang-map-layout/v1",
    checkpoints: [[-2.4865, -2.4556], [7.1815, -3.2587], [6.471, 0.4479], [4.4324, 6.8726]],
    target: [-9.8687, -6.7181],
    storage: [-10.7336, -8.0772],
    distractor: [-8.0772, 5.4826],
    obstacle: [-10.9498, 2.0849]
  };
  const stored = {
    schemaVersion: MAP_CONFIG_STORE_SCHEMA_VERSION,
    revision: 1,
    updatedAt: "2026-08-22T00:00:00.000Z",
    digest: canonicalSha256(legacyLayout),
    layout: legacyLayout
  };
  await fs.promises.writeFile(path.join(rootDir, MAP_CONFIG_FILENAME), `${JSON.stringify(stored)}\n`, "utf8");
  const store = createStore(rootDir);
  const published = await store.publicConfig();
  assert.equal(published.revision, 1);
  assert.equal(published.layout.schemaVersion, MAP_LAYOUT_SCHEMA_VERSION);
  assert.deepEqual(published.layout.targets, [legacyLayout.target]);
  assert.deepEqual(published.layout.distractors, [legacyLayout.distractor]);
  assert.deepEqual(published.layout.obstacles, [legacyLayout.obstacle]);
  assert.notEqual(published.digest, stored.digest, "the public v2 digest must bind the upgraded layout");
});

test("published layouts persist atomically, bind every scoring coordinate, and survive restart", async t => {
  const rootDir = await temporaryDirectory(t);
  const now = Date.parse("2026-08-21T08:09:10.123Z");
  let store = createStore(rootDir, { now: () => now });
  const original = await store.publicConfig();
  const layout = changedLayout(original.layout);
  layout.checkpoints[0] = [-2.4865, -2.4];
  layout.storage = [-10.65, -8.02];
  layout.distractors[0] = [-8, 5.4];
  layout.obstacles[0] = [-10.85, 2.1];

  const published = await store.update(updateRequest(0, layout));
  assertMapConfigEnvelope(published, 1);
  assert.equal(published.updatedAt, "2026-08-21T08:09:10.123Z");
  assert.equal(
    published.mapVersion,
    `${BASE_CHALLENGE.mapVersion}@map-r1-${published.digest.slice(0, 12)}`
  );
  const snapshot = await store.snapshot();
  assert.deepEqual(
    snapshot.runDefinition.taskDefinition.checkpoints.map(item => item.position),
    published.layout.checkpoints
  );
  assert.deepEqual(
    snapshot.runDefinition.interactionDefinition.packages.map(item => [item.role, item.x, item.z]),
    [
      ["target", ...published.layout.targets[0]],
      ["distractor", ...published.layout.distractors[0]],
      ["obstacle", ...published.layout.obstacles[0]]
    ]
  );
  const targetDelivery = snapshot.runDefinition.taskDefinition.deliveries.find(
    item => item.objectRole === "target" && item.destinationRole === "storage"
  );
  assert.deepEqual(targetDelivery.destination, published.layout.storage);
  assert.deepEqual(snapshot.runDefinition.taskDefinition.goal, BASE_CHALLENGE.runDefinition.taskDefinition.goal);
  assert.notEqual(snapshot.runDefinition, BASE_CHALLENGE.runDefinition);

  const stored = JSON.parse(await fs.promises.readFile(path.join(rootDir, MAP_CONFIG_FILENAME), "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["digest", "layout", "revision", "schemaVersion", "updatedAt"].sort());
  assert.equal(stored.schemaVersion, MAP_CONFIG_STORE_SCHEMA_VERSION);
  assert.equal(stored.digest, canonicalSha256(stored.layout));

  store = createStore(rootDir);
  const restored = await store.publicConfig();
  assert.deepEqual(restored, published);
});

test("map publication is optimistic-concurrent and keeps already captured revisions immutable", async t => {
  const rootDir = await temporaryDirectory(t);
  const store = createStore(rootDir);
  const initial = await store.publicConfig();
  const captured = await store.snapshot();
  const left = changedLayout(initial.layout, [-9.8, -6.65]);
  const right = changedLayout(initial.layout, [-9.76, -6.61]);
  const attempts = await Promise.allSettled([
    store.update(updateRequest(0, left)),
    store.update(updateRequest(0, right))
  ]);
  assert.equal(attempts.filter(item => item.status === "fulfilled").length, 1);
  const rejected = attempts.find(item => item.status === "rejected");
  assert.ok(rejected.reason instanceof GuangyangMapConfigStoreError);
  assert.equal(rejected.reason.statusCode, 409);
  assert.equal(rejected.reason.code, "MAP_CONFIG_REVISION_CONFLICT");
  assert.equal((await store.publicConfig()).revision, 1);
  assert.equal(captured.revision, 0);
  assert.equal(captured.mapVersion, BASE_CHALLENGE.mapVersion);
  assert.deepEqual(
    captured.runDefinition.interactionDefinition.packages.find(item => item.role === "target"),
    BASE_CHALLENGE.runDefinition.interactionDefinition.packages.find(item => item.role === "target")
  );
});

test("strict map validation rejects malformed, unreachable, overlapping, and out-of-bounds layouts", async t => {
  const rootDir = await temporaryDirectory(t);
  const store = createStore(rootDir);
  const initial = await store.publicConfig();
  const cases = [
    {
      code: "MAP_CONFIG_INVALID_UPDATE",
      request: { ...updateRequest(0, initial.layout), extra: true }
    },
    {
      code: "MAP_CONFIG_INVALID_LAYOUT",
      request: updateRequest(0, { ...initial.layout, extra: true })
    },
    {
      code: "MAP_CONFIG_INVALID_CHECKPOINTS",
      request: updateRequest(0, { ...initial.layout, checkpoints: initial.layout.checkpoints.slice(0, 3) })
    },
    {
      code: "MAP_CONFIG_INVALID_POSITION",
      request: updateRequest(0, { ...initial.layout, targets: [[1]] })
    },
    {
      code: "MAP_CONFIG_OUT_OF_BOUNDS",
      request: updateRequest(0, { ...initial.layout, targets: [[20, 0]] })
    },
    {
      code: "MAP_CONFIG_NOT_ROAD_REACHABLE",
      request: updateRequest(0, { ...initial.layout, checkpoints: [[18, 10], ...initial.layout.checkpoints.slice(1)] })
    },
    {
      code: "MAP_CONFIG_OBJECTS_OVERLAP",
      request: updateRequest(0, { ...initial.layout, distractors: [[...initial.layout.targets[0]]] })
    },
    {
      code: "MAP_CONFIG_CHECKPOINTS_OVERLAP",
      request: updateRequest(0, {
        ...initial.layout,
        checkpoints: [initial.layout.checkpoints[0], initial.layout.checkpoints[0], ...initial.layout.checkpoints.slice(2)]
      })
    }
  ];
  for (const entry of cases) {
    await assert.rejects(
      () => store.update(entry.request),
      error => error instanceof GuangyangMapConfigStoreError
        && error.statusCode === 422
        && error.code === entry.code,
      entry.code
    );
  }
  assert.equal((await store.publicConfig()).revision, 0);
  assert.equal(fs.existsSync(path.join(rootDir, MAP_CONFIG_FILENAME)), false);
});

test("a damaged published map fails synchronously before the server can start", async t => {
  const dataDir = await temporaryDirectory(t, "chenlong-map-config-corrupt-");
  const rootDir = path.join(dataDir, "map-config", GUANGYANG_ISLAND_CONFIG.mapId);
  const store = createStore(rootDir);
  const initial = await store.publicConfig();
  await store.update(updateRequest(0, changedLayout(initial.layout)));
  const filePath = path.join(rootDir, MAP_CONFIG_FILENAME);
  const stored = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  stored.digest = "0".repeat(64);
  await fs.promises.writeFile(filePath, `${JSON.stringify(stored)}\n`);

  assert.throws(
    () => createStore(rootDir),
    error => error instanceof GuangyangMapConfigStoreError
      && error.statusCode === 500
      && error.code === "MAP_CONFIG_CORRUPTED"
  );
  assert.throws(
    () => createServer({ dataDir }),
    error => error instanceof GuangyangMapConfigStoreError
      && error.code === "MAP_CONFIG_CORRUPTED"
  );
  assert.equal(fs.existsSync(path.join(dataDir, ".chenlong-writer.lock")), false);
});

function collectResponse(response, resolve, reject) {
  const chunks = [];
  response.on("data", chunk => chunks.push(chunk));
  response.once("error", reject);
  response.once("end", () => resolve({
    statusCode: response.statusCode,
    headers: response.headers,
    body: Buffer.concat(chunks)
  }));
}

function request(origin, { method = "GET", requestPath = "/", cookie, requestOrigin, value, headers = {} } = {}) {
  const target = new URL(origin);
  const body = value === undefined ? null : Buffer.from(JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: target.hostname,
      port: target.port,
      method,
      path: requestPath,
      headers: {
        Connection: "close",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(requestOrigin ? { Origin: requestOrigin } : {}),
        ...(body ? {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": body.length
        } : {}),
        ...headers
      }
    }, response => collectResponse(response, resolve, reject));
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

function parseJson(response) {
  assert.match(response.headers["content-type"] || "", /^application\/json\b/i);
  return JSON.parse(response.body.toString("utf8"));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  server.closeAllConnections?.();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}

async function register(origin, username) {
  const response = await request(origin, {
    method: "POST",
    requestPath: "/api/v1/auth/register",
    requestOrigin: origin,
    value: {
      username,
      password: "Map-Config-Test-Password-2026!",
      teamName: `${username}-team`,
      group: "primary"
    }
  });
  assert.equal(response.statusCode, 201, response.body.toString("utf8"));
  const setCookie = Array.isArray(response.headers["set-cookie"])
    ? response.headers["set-cookie"][0]
    : response.headers["set-cookie"];
  return { cookie: setCookie.split(";", 1)[0], user: parseJson(response).user };
}

test("admin publication is protected and new single sessions freeze the published revision", async t => {
  const dataDir = await temporaryDirectory(t, "chenlong-map-config-api-");
  let server = createServer({ dataDir });
  let origin = await listen(server);
  let closed = false;
  t.after(async () => {
    if (!closed) await close(server);
  });
  const admin = await register(origin, "map-admin");
  const participant = await register(origin, "map-user");
  assert.equal(admin.user.role, "admin");
  assert.equal(participant.user.role, "user");

  const unauthenticated = await request(origin, { requestPath: "/api/v1/map-config" });
  assert.equal(unauthenticated.statusCode, 401);
  const mapPoolsResponse = await request(origin, {
    requestPath: "/api/v1/admin/map-pools",
    cookie: admin.cookie
  });
  assert.equal(mapPoolsResponse.statusCode, 200);
  const assignment = parseJson(mapPoolsResponse).assignments
    .find(item => item.teamName === "map-user-team");
  assert.ok(assignment);
  const assignedMapId = assignment.maps.find(item => item.taskId === TASK_ID).variantId;
  const assignedAdminPath = `/api/v1/admin/map-config/${TASK_ID}/${assignedMapId}`;
  const initialResponse = await request(origin, {
    requestPath: assignedAdminPath,
    cookie: admin.cookie
  });
  assert.equal(initialResponse.statusCode, 200);
  const initial = parseJson(initialResponse);
  assertMapConfigEnvelope(initial, 0);

  const forbiddenRead = await request(origin, {
    requestPath: assignedAdminPath,
    cookie: participant.cookie
  });
  assert.equal(forbiddenRead.statusCode, 403);
  const crossOrigin = await request(origin, {
    method: "PUT",
    requestPath: assignedAdminPath,
    cookie: admin.cookie,
    requestOrigin: "https://attacker.invalid",
    value: updateRequest(0, changedLayout(initial.layout))
  });
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal(parseJson(crossOrigin).error.code, "CROSS_ORIGIN_REQUEST");

  const firstTarget = [initial.layout.targets[0][0] + 0.01, initial.layout.targets[0][1]];
  const firstLayout = changedLayout(initial.layout, firstTarget);
  const firstPublishResponse = await request(origin, {
    method: "PUT",
    requestPath: assignedAdminPath,
    cookie: admin.cookie,
    requestOrigin: origin,
    value: updateRequest(0, firstLayout)
  });
  assert.equal(firstPublishResponse.statusCode, 200, firstPublishResponse.body.toString("utf8"));
  const firstPublished = parseJson(firstPublishResponse);
  assertMapConfigEnvelope(firstPublished, 1);

  const participantRead = await request(origin, {
    requestPath: "/api/v1/map-config",
    cookie: participant.cookie
  });
  assert.equal(participantRead.statusCode, 200);
  assert.deepEqual(parseJson(participantRead), firstPublished);

  const userCannotWrite = await request(origin, {
    method: "PUT",
    requestPath: assignedAdminPath,
    cookie: participant.cookie,
    requestOrigin: origin,
    value: updateRequest(1, firstLayout)
  });
  assert.equal(userCannotWrite.statusCode, 403);

  const firstSessionResponse = await request(origin, {
    method: "POST",
    requestPath: "/api/v1/sessions",
    cookie: participant.cookie,
    requestOrigin: origin,
    value: { taskId: TASK_ID }
  });
  assert.equal(firstSessionResponse.statusCode, 201, firstSessionResponse.body.toString("utf8"));
  const firstSession = parseJson(firstSessionResponse);
  assert.deepEqual(Object.keys(firstSession.mapConfig).sort(), [
    "digest", "mapVersion", "revision", "schemaVersion"
  ].sort());
  assert.equal(firstSession.mapConfig.schemaVersion, MAP_CONFIG_BINDING_SCHEMA_VERSION);
  assert.equal(firstSession.mapConfig.revision, 1);
  assert.equal(firstSession.mapConfig.digest, firstPublished.digest);
  assert.equal(firstSession.challenge.mapVersion, firstPublished.mapVersion);
  assert.deepEqual(
    firstSession.runDefinition.interactionDefinition.packages.find(item => item.role === "target"),
    {
      ...BASE_CHALLENGE.runDefinition.interactionDefinition.packages.find(item => item.role === "target"),
      x: firstPublished.layout.targets[0][0],
      z: firstPublished.layout.targets[0][1]
    }
  );

  const secondTarget = [firstTarget[0] + 0.01, firstTarget[1]];
  const secondLayout = changedLayout(firstPublished.layout, secondTarget);
  const secondPublishResponse = await request(origin, {
    method: "PUT",
    requestPath: assignedAdminPath,
    cookie: admin.cookie,
    requestOrigin: origin,
    value: updateRequest(1, secondLayout)
  });
  assert.equal(secondPublishResponse.statusCode, 200);
  const secondPublished = parseJson(secondPublishResponse);
  assert.equal(secondPublished.revision, 2);
  const storedFirstSession = await server.submissionStore.readSession(firstSession.sessionId);
  assert.equal(storedFirstSession.challenge.mapVersion, firstPublished.mapVersion);
  assert.equal(
    storedFirstSession.challenge.runDefinition.interactionDefinition.packages.find(item => item.role === "target").x,
    firstPublished.layout.targets[0][0],
    "an administrator update must not rewrite an already-created session"
  );

  await close(server);
  closed = true;
  server = createServer({ dataDir });
  origin = await listen(server);
  closed = false;
  const afterRestart = await request(origin, {
    requestPath: "/api/v1/map-config",
    cookie: participant.cookie
  });
  assert.equal(afterRestart.statusCode, 200);
  assert.deepEqual(parseJson(afterRestart), secondPublished);
});

test("three Guangyang challenges publish and freeze independent maps", async t => {
  const dataDir = await temporaryDirectory(t, "chenlong-three-guangyang-challenges-");
  const server = createServer({ dataDir });
  const origin = await listen(server);
  t.after(() => close(server));
  const admin = await register(origin, "three-map-admin");
  const participant = await register(origin, "three-map-user");
  const [, challengeTwo, challengeThree] = GUANGYANG_CHALLENGE_CONFIGS;

  assert.deepEqual(
    GUANGYANG_CHALLENGE_CONFIGS.map(item => item.displayName),
    ["广阳岛综合任务1", "广阳岛综合任务2", "广阳岛综合任务3"]
  );
  assert.equal(challengeTwo.timeLimitSeconds, 600);
  assert.equal(challengeThree.timeLimitSeconds, 600);
  assert.deepEqual(
    GUANGYANG_CHALLENGE_CONFIGS.map(item => ({
      checkpoints: item.checkpoints.length,
      targets: item.objectTaskOverlay.objects.filter(object => object.role === "target").length,
      distractors: item.objectTaskOverlay.objects.filter(object => object.role === "distractor").length,
      obstacles: item.objectTaskOverlay.objects.filter(object => object.role === "obstacle").length
    })),
    [
      { checkpoints: 4, targets: 1, distractors: 1, obstacles: 1 },
      { checkpoints: 6, targets: 2, distractors: 2, obstacles: 2 },
      { checkpoints: 8, targets: 3, distractors: 3, obstacles: 3 }
    ]
  );

  const poolsResponse = await request(origin, {
    requestPath: "/api/v1/admin/map-pools",
    cookie: admin.cookie
  });
  assert.equal(poolsResponse.statusCode, 200, poolsResponse.body.toString("utf8"));
  const pools = parseJson(poolsResponse);
  assert.deepEqual(pools.pools.map(pool => pool.variantCount), [8, 10, 12]);
  const participantAssignment = pools.assignments.find(item => item.teamName === "three-map-user-team");
  assert.ok(participantAssignment);
  const assignedVariant = taskId => participantAssignment.maps.find(item => item.taskId === taskId).variantId;

  const readPublished = async (taskId, mapVariant = "map-01") => {
    const response = await request(origin, {
      requestPath: `/api/v1/admin/map-config/${taskId}/${mapVariant}`,
      cookie: admin.cookie
    });
    assert.equal(response.statusCode, 200, response.body.toString("utf8"));
    return parseJson(response);
  };
  const publish = async (taskId, mapVariant, envelope, layout) => {
    const response = await request(origin, {
      method: "PUT",
      requestPath: `/api/v1/admin/map-config/${taskId}/${mapVariant}`,
      cookie: admin.cookie,
      requestOrigin: origin,
      value: updateRequest(envelope.revision, layout)
    });
    assert.equal(response.statusCode, 200, response.body.toString("utf8"));
    return parseJson(response);
  };

  const initialOne = await readPublished(TASK_ID, assignedVariant(TASK_ID));
  const initialTwo = await readPublished(challengeTwo.taskId, assignedVariant(challengeTwo.taskId));
  const initialThree = await readPublished(challengeThree.taskId, assignedVariant(challengeThree.taskId));
  assert.equal(initialOne.revision, 0);
  assert.equal(initialTwo.revision, 0);
  assert.equal(initialThree.revision, 0);

  const publishedTwo = await publish(
    challengeTwo.taskId,
    assignedVariant(challengeTwo.taskId),
    initialTwo,
    changedLayout(initialTwo.layout, [initialTwo.layout.targets[0][0] + 0.01, initialTwo.layout.targets[0][1]])
  );
  const publishedThree = await publish(
    challengeThree.taskId,
    assignedVariant(challengeThree.taskId),
    initialThree,
    changedLayout(initialThree.layout, [initialThree.layout.targets[0][0] + 0.01, initialThree.layout.targets[0][1]])
  );
  assert.equal((await readPublished(TASK_ID, assignedVariant(TASK_ID))).revision, 0,
    "challenge 1 assigned map must remain independent");
  assert.equal(publishedTwo.revision, 1);
  assert.equal(publishedThree.revision, 1);
  assert.notEqual(publishedTwo.digest, publishedThree.digest);

  for (const [config, published] of [[challengeTwo, publishedTwo], [challengeThree, publishedThree]]) {
    const participantMap = await request(origin, {
      requestPath: `/api/v1/map-config/${config.taskId}`,
      cookie: participant.cookie
    });
    assert.equal(participantMap.statusCode, 200);
    assert.deepEqual(parseJson(participantMap), published);
    const created = await request(origin, {
      method: "POST",
      requestPath: "/api/v1/sessions",
      cookie: participant.cookie,
      requestOrigin: origin,
      value: { taskId: config.taskId, mode: "ai" }
    });
    assert.equal(created.statusCode, 201, created.body.toString("utf8"));
    const session = parseJson(created);
    assert.equal(session.challenge.taskId, config.taskId);
    assert.equal(session.challenge.displayName, config.displayName);
    assert.equal(session.mapConfig.digest, published.digest);
    assert.equal(session.runDefinition.taskDefinition.id, config.taskId);
    assert.deepEqual(
      session.runDefinition.interactionDefinition.packages.find(item => item.role === "target").x,
      published.layout.targets[0][0]
    );
  }
});
