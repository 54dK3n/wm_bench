"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createRobotBridge } = require("../backend/robot-bridge.js");
const C = require("../robot-bridge-contract.js");
const { createServer } = require("../server.js");

const command = (requestId, method = "forward", params = { distanceCm: 5 }) => ({ requestId, method, params });
function setup() {
  const bridge = createRobotBridge({ pollTimeoutMs: 5 });
  const credentials = bridge.register("owner");
  return { bridge, ...credentials };
}

test("contract rejects non-whitelisted APIs, extra parameters and invalid numeric types", () => {
  for (const method of ["mission", "map_graph", "road_state", "release_preview", "task_state", "approach", "__proto__"]) {
    assert.throws(() => C.normalizeCommand(command("a", method, {})), { code: "METHOD_NOT_ALLOWED" });
  }
  for (const params of [{ distanceCm: 5, roadId: "secret" }, { distanceCm: true }, { distanceCm: NaN },
    { distanceCm: Infinity }, { distanceCm: 0 }, { distanceCm: 501 }, { distanceCm: 5, speed: 101 }]) {
    assert.throws(() => C.normalizeCommand(command("a", "forward", params)));
  }
  assert.throws(() => C.normalizeCommand(command("a", "follow_road", { distanceCm: 5 })));
  assert.throws(() => C.normalizeCommand(command("a", "turn", { angleDeg: 0 })));
  assert.deepEqual(C.normalizeCommand(command("a", "take_exit", { angleDeg: 0, speed: 30 })),
    command("a", "take_exit", { angleDeg: 0, speed: 30 }));
});

test("explicit response projection never reads hidden truth fields", () => {
  const value = { onRoad: true, lateralOffsetCm: 2, headingErrorDeg: 1, leftClearanceCm: 15,
    rightClearanceCm: 11, frontClearanceCm: null, atJunction: true, atNode: true,
    exits: [{ angleDeg: 90, roadId: "hidden" }], tick: 12 };
  for (const key of ["roadId", "roadProgressCm", "nodeId", "worldPose", "objectId"]) {
    Object.defineProperty(value, key, { enumerable: true, get() { throw new Error("truth read"); } });
  }
  const result = C.sanitizeResponse("local_road", value);
  assert.deepEqual(result.exits, [{ angleDeg: 90 }]);
  assert.equal(Object.hasOwn(result, "roadId"), false);
  assert.deepEqual(C.sanitizeResponse("take_exit", { accepted: true, stoppedBy: "entered_road",
    distanceCm: 25, elapsedTicks: 30, roadId: "hidden" }),
  { accepted: true, stoppedBy: "entered_road", distanceCm: 25, elapsedTicks: 30 });
  assert.deepEqual(C.sanitizeResponse("grab", { completed: true, packageId: "hidden", forward: 1 }), { completed: true });
});

test("observe accepts source-image boxes only and removes all range and identity fields", () => {
  const v = { frameId: 7, tick: 20, width: 640, height: 480,
    detections: [{ category: "storage-zone", confidence: 0.8, source: "storage-ground-pixels", bbox: { x: 5, y: 3, w: 10, h: 20 },
      distanceCm: 66, bearingDeg: 30, objectId: "hidden" }], world: {} };
  const result = C.sanitizeResponse("observe", v);
  assert.deepEqual(Object.keys(result.detections[0]), ["category", "confidence", "bbox", "source"]);
  assert.equal(result.detections[0].source, "storage-ground-pixels");
  assert.throws(() => C.sanitizeResponse("observe", { ...v, height: 640 }));
  v.detections[0].bbox.y = 479;
  assert.throws(() => C.sanitizeResponse("observe", v));
});

test("observe preserves real detector provenance and rejects missing or unrecognized sources", () => {
  const v = { frameId: 7, tick: 20, width: 640, height: 480,
    detections: [{ category: "red-ball", confidence: 0.8, source: "virtual-cv", bbox: { x: 5, y: 3, w: 10, h: 20 } }] };
  for (const source of ["virtual-cv", "yolo", "storage-ground-pixels"]) {
    v.detections[0].source = source;
    assert.equal(C.sanitizeResponse("observe", v).detections[0].source, source);
  }
  for (const source of [undefined, "teaching", "truth", ""]) {
    v.detections[0].source = source;
    assert.throws(() => C.sanitizeResponse("observe", v));
  }
});

test("camera mount comes from runtime rig conversion, without world transform", () => {
  const mount = { forwardCm: 5.375, rightCm: 0, upCm: 8.0625, pitchDeg: -8 };
  assert.deepEqual(C.sanitizeResponse("camera_parameters", { ...C.CAMERA_PARAMETERS, mount, matrixWorld: [99] }),
    { ...C.CAMERA_PARAMETERS, mount });
});

test("serial dispatch and request ID retries execute once, including lost result HTTP replies", async () => {
  const { bridge, bridgeId } = setup();
  bridge.submit(bridgeId, command("a")); bridge.submit(bridgeId, command("b"));
  assert.equal((await bridge.next(bridgeId)).command.requestId, "a");
  assert.deepEqual(await bridge.next(bridgeId), { command: null });
  assert.equal(bridge.submit(bridgeId, command("a")).status, "dispatched");
  assert.throws(() => bridge.submit(bridgeId, command("a", "backward")), { code: "REQUEST_ID_REUSED" });
  bridge.complete(bridgeId, { requestId: "a", tick: 5, result: { completed: true } });
  assert.equal(bridge.submit(bridgeId, command("a")).status, "completed");
  assert.equal((await bridge.next(bridgeId)).command.requestId, "b");
  assert.throws(() => bridge.complete(bridgeId, { requestId: "a", tick: 5, result: { completed: true } }),
    { code: "COMMAND_NOT_ACTIVE" });
  bridge.close();
});

test("long polling wakes once and polling timeout never repeats a dispatched action", async () => {
  const { bridge, bridgeId } = setup();
  assert.deepEqual(await bridge.next(bridgeId), { command: null });
  const next = bridge.next(bridgeId);
  bridge.submit(bridgeId, command("a"));
  assert.equal((await next).command.requestId, "a");
  assert.deepEqual(await bridge.next(bridgeId), { command: null });
  bridge.closeController(bridgeId);
  assert.equal(bridge.status(bridgeId, "a").status, "unknown");
  assert.throws(() => bridge.submit(bridgeId, command("a")), { code: "BRIDGE_CLOSED" });
});

test("controller loss cancels queued commands and preserves unknown physical outcome", async () => {
  const { bridge, bridgeId } = setup();
  bridge.submit(bridgeId, command("a")); bridge.submit(bridgeId, command("b"));
  await bridge.next(bridgeId); bridge.closeController(bridgeId);
  assert.equal(bridge.status(bridgeId, "a").status, "unknown");
  assert.equal(bridge.status(bridgeId, "b").status, "cancelled");
});

test("malformed response cannot leak truth or permit continued motion", async () => {
  const { bridge, bridgeId } = setup();
  bridge.submit(bridgeId, command("a", "odometry", {})); bridge.submit(bridgeId, command("b"));
  await bridge.next(bridgeId);
  const result = bridge.complete(bridgeId, { requestId: "a", tick: 4,
    result: { forwardCm: 0, rightCm: 0, headingDeg: 0, distanceCm: 0, tick: 5, worldPose: [1, 2] } });
  assert.equal(result.status, "unknown"); assert.equal(Object.hasOwn(result, "result"), false);
  assert.equal(bridge.status(bridgeId, "b").status, "cancelled");
  assert.equal(JSON.stringify(bridge.trace(bridgeId)).includes("worldPose"), false);
});

test("trace records rejection and last completed simulation tick, never credentials or wall time", async () => {
  const { bridge, bridgeId, clientToken, controllerToken } = setup();
  bridge.submit(bridgeId, command("a")); await bridge.next(bridgeId);
  bridge.complete(bridgeId, { requestId: "a", tick: 21, result: { completed: true } });
  assert.throws(() => bridge.submit(bridgeId, command("b", "mission", { password: "DO_NOT_COPY" })));
  const trace = bridge.trace(bridgeId), serialized = JSON.stringify(trace);
  assert.equal(trace.events.at(-1).type, "rejected"); assert.equal(trace.events.at(-1).tick, 21);
  for (const secret of [bridgeId, clientToken, controllerToken, "DO_NOT_COPY", "Date", "wall", "owner"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("rejected legacy method names containing digits stay attributable in the trace", () => {
  const { bridge, bridgeId } = setup();
  for (const [id, method] of [["a", "left_90"], ["b", "right_90"], ["c", "Mission"]]) {
    assert.throws(() => bridge.submit(bridgeId, command(id, method, {})));
  }
  assert.deepEqual(bridge.trace(bridgeId).events.map(event => event.method), ["left_90", "right_90", null]);
});

test("sensor classes are appearance-based and the gripper reports possession only", () => {
  assert.deepEqual([...C.CATEGORIES], ["red-ball", "blue-ball", "obstacle", "storage-zone"]);
  for (const category of ["target", "distractor", "cleanup-zone"]) {
    assert.throws(() => C.normalizeCommand(command("a", "observe", { category })), { code: "INVALID_PARAMS" });
  }
  assert.deepEqual(C.sanitizeResponse("holding", { holding: true, category: "target" }), { holding: true });
  for (const value of [null, "target", { holding: "target" }]) assert.throws(() => C.sanitizeResponse("holding", value));
});

test("controller and client credentials are non-interchangeable and owner-bound", () => {
  const { bridge, bridgeId, clientToken, controllerToken } = setup();
  bridge.authorizeClient(bridgeId, clientToken); bridge.authorizeController(bridgeId, "owner", controllerToken);
  assert.throws(() => bridge.authorizeClient(bridgeId, controllerToken));
  assert.throws(() => bridge.authorizeController(bridgeId, "owner", clientToken));
  assert.throws(() => bridge.authorizeController(bridgeId, "other", controllerToken));
});

async function httpFixture(t, enabled = true) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "robot-bridge-test-"));
  const server = createServer({ dataDir, robotBridgeEnabled: enabled, robotBridge: { pollTimeoutMs: 5 } });
  await Promise.all([server.authStore.ready, server.submissionStore.ready, server.batchStore.ready,
    server.rankedBatchStore.ready, ...[...server.mapConfigStores.values()].map(store => store.ready)]);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const req = (route, { method = "GET", value, headers = {} } = {}) => new Promise((resolve, reject) => {
    const body = value === undefined ? undefined : JSON.stringify(value);
    const request = http.request(origin + route, { method, headers: { Connection: "close", Origin: origin,
      ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }), ...headers } }, response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", part => { text += part; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }));
    });
    request.on("error", reject); request.end(body);
  });
  return { req, server, origin };
}

test("HTTP bridge defaults disabled", async t => {
  const { req } = await httpFixture(t, false);
  const response = await req("/api/v1/robot-bridge/controllers", { method: "POST", value: {} });
  assert.equal(response.status, 404); assert.equal(response.body.error.code, "BRIDGE_DISABLED");
});

test("HTTP registration requires login; capabilities cannot access controller/admin/record routes", async t => {
  const { req, origin } = await httpFixture(t);
  const base = "/api/v1/robot-bridge";
  assert.equal((await req(`${base}/controllers`, { method: "POST", value: {} })).status, 401);
  const registration = await req("/api/v1/auth/register", { method: "POST", value: {
    username: "bridge-test-user", password: "Bridge-Only-Test-Password-2026!", teamName: "Bridge tests", group: "primary" } });
  assert.equal(registration.status, 201);
  const cookie = registration.headers["set-cookie"][0].split(";")[0];
  const registered = await req(`${base}/controllers`, { method: "POST", value: {}, headers: { Cookie: cookie } });
  assert.equal(registered.status, 201);
  const { bridgeId, clientToken, controllerToken } = registered.body;
  const ch = { "X-Robot-Bridge-Client": clientToken };
  const ah = { Cookie: cookie, "X-Robot-Bridge-Controller": controllerToken };
  assert.equal((await req(`${base}/controllers/${bridgeId}/next`, { headers: ch })).status, 403);
  for (const route of ["/api/v1/admin/users", "/api/v1/sessions", "/api/v1/records", "/app.js"]) {
    assert.equal((await req(route, { headers: ch })).status, 403);
  }
  assert.equal((await req(`${base}/${bridgeId}/trace`, { headers: { "X-Robot-Bridge-Client": controllerToken } })).status, 403);
  assert.equal((await req(`${base}/${bridgeId}/commands`, { method: "POST", value: command("a"),
    headers: { ...ch, Origin: "http://different.invalid" } })).status, 403);
  assert.equal((await req(`${base}/${bridgeId}/commands`, { method: "POST", value: command("a"), headers: ch })).status, 202);
  const dispatched = await req(`${base}/controllers/${bridgeId}/next`, { headers: ah });
  assert.deepEqual(dispatched.body.command, command("a"));
  assert.equal((await req(`${base}/controllers/${bridgeId}/results`, { method: "POST", headers: ah,
    value: { requestId: "a", tick: 10, result: { completed: true, world: "hidden" } } })).status, 200);
  const result = await req(`${base}/${bridgeId}/commands/a`, { headers: ch });
  assert.deepEqual(result.body.result, { completed: true });
  assert.equal(result.body.status, "completed");
  assert.equal((await req(`${base}/${bridgeId}/commands`, { method: "POST", value: command("bad", "mission", {}), headers: ch })).status, 400);
  const trace = await req(`${base}/${bridgeId}/trace`, { headers: ch });
  assert.equal(trace.body.events.at(-1).type, "rejected");
  assert.equal(trace.body.events.at(-1).tick, 10);
  assert.equal(JSON.stringify(trace.body).includes("hidden"), false);
  assert.equal(trace.headers["access-control-allow-origin"], undefined);
  assert.ok(origin.startsWith("http://127.0.0.1:"));
});
