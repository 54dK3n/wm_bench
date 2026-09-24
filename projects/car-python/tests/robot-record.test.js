"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../competition-core.js");
const {RobotRunRecorder, MANAGEMENT_FIELDS, withBridgeCalls} = require("../robot-record.js");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const unlimited = {timeLimitSeconds: null, visionEvidenceLimitBytes: null, visionEvidenceFrameLimit: null};
function definition() {
  return {
    schemaVersion: core.SIMULATION_SCHEMA_VERSION, stepMs: 20, seed: 123,
    initialPose: {x: 0, z: 0, heading: 0},
    vehicle: {version: core.VEHICLE_MODEL_VERSION, radius: 0.2, collisionSkin: 0.01, maxLinearSpeed: 2, maxAngularSpeed: 4},
    world: {bounds: {minX: -5, maxX: 5, minZ: -5, maxZ: 5}, colliders: []}
  };
}
function session({runtime = unlimited, epoch = 1000, metadata = {}, config = {}} = {}) {
  return core.createSession({taskId: "fixture", mapId: "fixture", timeLimitSeconds: 600, rules: {}, ...config}, {
    simulationDefinition: definition(), sourceCode: "robot.odometry()", ...metadata
  }, {now: () => epoch, ...(runtime === undefined ? {} : {robotRuntime: runtime})});
}
function telemetry(tick = 0) { return {tick, x: 0, z: 0, heading: 0, speed: 0, steering: 0}; }
function competitionSession(config = {}) {
  return core.createSession({taskId: "fixture", timeLimitSeconds: 600, rules: {}, ...config},
    {simulationDefinition: definition()}, {now: () => 0});
}

test("explicit robot runtime supports null limits; competition defaults stay frozen", () => {
  const old = competitionSession();
  assert.equal(old.robotRuntime, null);
  assert.equal(old.timeLimitMs, 600000);
  assert.equal(old.recorder.visionEvidenceLimitBytes, 20 * 1024 * 1024);
  assert.equal(old.recorder.visionEvidenceFrameLimit, 1000);
  assert.equal("robotRuntime" in old.recorder.record.runDefinition, false);
  const demo = session();
  assert.equal(demo.timeLimitMs, Infinity);
  assert.equal(demo.recorder.maxElapsedMs, Infinity);
  assert.equal(demo.recorder.record.runDefinition.timeLimitTicks, null);
  assert.deepEqual(demo.recorder.record.runDefinition.robotRuntime, {...unlimited, navigationQueryLimit: null, navigationControlLimit: null});
  assert.equal(demo.recorder.visionEvidenceLimitBytes, null);
  assert.equal(demo.recorder.visionEvidenceFrameLimit, null);
  demo.sample(telemetry(50001));
  assert.equal(demo.status, "running", "past the old 50000-tick replay horizon without advancing physical simulation");
  assert.equal(demo.elapsedMs(), 1000020);
});

test("finite robot limits and omitted settings retain explicit semantics", () => {
  const inherited = session({runtime: {}});
  assert.equal(inherited.timeLimitMs, 600000);
  assert.equal(inherited.recorder.visionEvidenceLimitBytes, 20 * 1024 * 1024);
  const limited = session({runtime: {timeLimitSeconds: 0.1}});
  limited.sample(telemetry(5));
  assert.equal(limited.status, "timeout");
  assert.equal(limited.recorder.record.runDefinition.timeLimitTicks, 5);
  for (const runtime of [null, [], {unknown: null}, {timeLimitSeconds: 0}, {timeLimitSeconds: "10"},
    {timeLimitSeconds: Infinity}, {visionEvidenceLimitBytes: -1}, {visionEvidenceFrameLimit: 1.5}]) {
    assert.throws(() => session({runtime}), /robotRuntime/);
  }
});

test("robot evidence has configurable total byte and frame limits, PNG validation unchanged", () => {
  const bytes = Buffer.from(PNG, "base64").length;
  const bounded = session({runtime: {visionEvidenceLimitBytes: bytes, visionEvidenceFrameLimit: 10}});
  bounded.addVisionEvidence({pngBase64: PNG, frameId: 1});
  assert.throws(() => bounded.addVisionEvidence({pngBase64: PNG, frameId: 2}), /byte vision evidence limit/);
  const countBounded = session({runtime: {visionEvidenceLimitBytes: null, visionEvidenceFrameLimit: 1}});
  countBounded.addVisionEvidence({pngBase64: PNG, frameId: 1});
  assert.throws(() => countBounded.addVisionEvidence({pngBase64: PNG, frameId: 2}), /1 vision frame limit/);
  const open = session();
  for (let index = 0; index < 1001; index++) open.addVisionEvidence({pngBase64: PNG, frameId: index});
  assert.equal(open.recorder.record.visionFrames.length, 1001);
  open.recorder.visionBytes = 20 * 1024 * 1024; // counter-boundary unit test, no simulated image allocation
  assert.doesNotThrow(() => open.addVisionEvidence({pngBase64: PNG, frameId: 1001}));
  assert.throws(() => open.addVisionEvidence({pngBase64: "not-png"}), /PNG|base64/);
  const old = competitionSession();
  old.recorder.visionBytes = 20 * 1024 * 1024;
  assert.throws(() => old.addVisionEvidence({pngBase64: PNG, frameId: 1}), /20971520 byte/);
});

test("task completion and rule diagnostics do not stop robot sessions or rewrite explicit end reason", () => {
  const config = {task: {type: "reach", goal: [0, 0], goalRadius: 0.5}};
  const demo = session({config});
  demo.addViolation("collision", {colliderId: "fixture-obstacle"});
  demo.sample(telemetry());
  assert.equal(demo.task.finished, true);
  assert.equal(demo.status, "running");
  assert.equal(demo.recorder.record.events.some(item => item.type === "violation"), true);
  demo.finish("stopped");
  assert.equal(demo.status, "stopped");
  const old = competitionSession(config);
  old.sample(telemetry());
  assert.equal(old.status, "completed");
});

function recordedRun({epoch = 1000, id = "first", frameId = 1, distance = 61} = {}) {
  const current = session({epoch, metadata: {runId: id, serverSessionId: id, challengeDigest: id, teamId: id}});
  const audit = new RobotRunRecorder({session: current, envelope: {serverRunId: id, startedWallClock: epoch}});
  current.sample(telemetry(), {forceRecord: true});
  let token = audit.beginCall("observe", [null, 0]);
  current.addVisionEvidence({pngBase64: PNG, frameId});
  const observed = [{category: "red", distanceCm: distance, bearingDeg: -2.1, confidence: 0.83}];
  current.addVisionQuery("observe", [null, 0], observed, frameId);
  audit.endCall(token, {result: observed});
  token = audit.beginCall("grab", []);
  audit.endCall(token, {result: {accepted: false, reason: "out_of_range"}});
  token = audit.beginCall("not_a_method", ["rejected"]);
  audit.endCall(token, {error: {name: "TypeError", message: "unsupported robot API method", code: "UNKNOWN_METHOD"}});
  token = audit.beginCall("holding", []);
  audit.endCall(token, {result: null});
  token = audit.beginCall("stop", []);
  audit.endCall(token, {result: undefined});
  current.sample(telemetry(5));
  current.finish("stopped");
  return {current, audit, output: audit.finish()};
}

test("equal complete public traces produce byte-identical records despite all management IDs and wall clocks", () => {
  const first = recordedRun();
  const second = recordedRun({epoch: 9999999, id: "second"});
  assert.equal(JSON.stringify(first.output.record), JSON.stringify(second.output.record));
  assert.notDeepEqual(first.output.envelope, second.output.envelope);
  const native = {...first.current.recorder.record};
  MANAGEMENT_FIELDS.forEach(key => delete native[key]);
  assert.deepEqual(first.output.record.native, native, "all native fields, arrays, PNG payloads and results are retained");
  for (const key of MANAGEMENT_FIELDS) assert.equal(key in first.output.record.native, false);
  assert.equal(first.output.record.native.visionFrames[0].pngBase64, PNG);
  assert.equal(first.output.record.native.visionFrames[0].frameId, 1);
  assert.equal(first.output.record.complete, true);
  const changedFrame = recordedRun({frameId: 2});
  const changedDetection = recordedRun({distance: 62});
  assert.notDeepEqual(first.output.record, changedFrame.output.record);
  assert.notDeepEqual(first.output.record, changedDetection.output.record);
});

test("every API call including rejection, exceptions, null and undefined results remains in the ledger", () => {
  const {output} = recordedRun();
  const {calls, ledger, native} = output.record;
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[1].outcome.result, {accepted: false, reason: "out_of_range"});
  assert.equal(calls[2].outcome.status, "error");
  assert.equal(calls[2].outcome.error.code, "UNKNOWN_METHOD");
  assert.deepEqual(calls[3].outcome, {status: "returned", resultDefined: true, result: null});
  assert.deepEqual(calls[4].outcome, {status: "returned", resultDefined: false, result: null});
  assert.deepEqual(ledger.map(item => item.seq), Array.from({length: ledger.length}, (_, index) => index + 1));
  assert.equal(ledger.every(item => Number.isSafeInteger(item.tick)), true);
  const nativeEntries = ledger.filter(item => item.kind === "native");
  assert.equal(nativeEntries.length, native.inputs.length + native.events.length + native.samples.length + native.visionFrames.length);
  nativeEntries.forEach(item => assert.equal(native[item.collection][item.index].seq, item.nativeSeq));
  assert.equal(ledger.filter(item => item.kind === "api_call_start").length, 5);
  assert.equal(ledger.filter(item => item.kind === "api_call_end").length, 5);
});

test("explicit native budget failures remain visible as API errors; robot query defaults are unbounded", () => {
  const open = session();
  open.recorder.navigationQueryCount = 1000;
  assert.doesNotThrow(() => open.addNavigationQuery("odometry"));
  const current = session({runtime: {navigationQueryLimit: 1000}});
  const audit = new RobotRunRecorder({session: current});
  current.recorder.navigationQueryCount = 1000;
  const token = audit.beginCall("odometry", []);
  try {
    current.addNavigationQuery("odometry");
    assert.fail("query budget must still reject");
  } catch (error) {
    audit.endCall(token, {error: {name: error.name, message: error.message}});
  }
  assert.match(audit.export().record.calls[0].outcome.error.message, /1000 navigation query limit/);
});

test("robot control budget defaults are unbounded while optional explicit action limits apply", () => {
  const metadata = {runDefinition: {navigationControlDefinition: core.NAVIGATION_CONTROL_DEFINITION}};
  const open = session({metadata});
  open.recorder.navigationControlCount = 300;
  assert.doesNotThrow(() => open.recorder.beginNavigationControl("take_exit", {roadId: "fixture-road"}, {tick: 0}, 0));
  const limited = session({metadata, runtime: {navigationControlLimit: 301}});
  limited.recorder.navigationControlCount = 300;
  assert.doesNotThrow(() => limited.recorder.beginNavigationControl("take_exit", {roadId: "fixture-road"}, {tick: 0}, 0));
  assert.throws(() => limited.recorder.beginNavigationControl("take_exit", {roadId: "fixture-road"}, {tick: 0}, 0), /301 navigation control limit/);
});

test("event tick is the authoritative simulation tick even at a fractional configured time boundary", () => {
  const current = session({runtime: {timeLimitSeconds: 0.01}});
  const audit = new RobotRunRecorder({session: current});
  current.sample(telemetry(1));
  const output = audit.finish();
  assert.equal(output.record.native.events.at(-1).tick, 1);
  assert.equal(output.record.native.events.at(-1).t, 10);
  assert.equal(output.record.ledger.at(-1).tick, 1);
});

test("record validation catches missing sequence, fractional tick and lossy JSON", () => {
  assert.throws(() => new RobotRunRecorder({session: competitionSession()}), /explicit robotRuntime/);
  const current = session();
  const audit = new RobotRunRecorder({session: current});
  assert.throws(() => audit.beginCall("observe", [Infinity]), /finite JSON/);
  const token = audit.beginCall("observe", []);
  assert.throws(() => audit.beginCall("observe", []), /serialized/);
  assert.throws(() => audit.endCall(token + 1, {}), /not pending/);
  assert.throws(() => audit.endCall(token, {result: 1, error: "both"}), /not both/);
  assert.throws(() => audit.finish(), /unanswered/);
  audit.endCall(token, {});
  assert.throws(() => audit.finish(), /native session/);
  current.recorder.record.events.push({seq: 99, type: "tampered", t: 0});
  assert.throws(() => audit.export(), /sequence/);
  const other = session();
  const second = new RobotRunRecorder({session: other});
  other.recorder.record.events.push({seq: 2, type: "fractional", t: 1});
  assert.throws(() => second.export(), /not on a simulation tick/);
});

test("sealed exports are isolated; server trace assembly preserves every supplied field", () => {
  const {audit, current, output} = recordedRun();
  current.recorder.record.events[0].type = "mutated";
  output.record.calls[0].args[0] = "mutated";
  const sealed = audit.export();
  assert.equal(sealed.record.native.events[0].type, "run_started");
  assert.equal(sealed.record.calls[0].args[0], null);
  assert.throws(() => audit.beginCall("observe", []), /finished/);
  const serverCalls = [{seq: 1, tick: 0, method: "forbidden", args: [], error: {code: "DENIED"}, accepted: false}];
  const assembled = withBridgeCalls(sealed.record, serverCalls);
  assert.deepEqual(assembled.bridgeCalls, serverCalls);
  assert.deepEqual(sealed.record.bridgeCalls, []);
  assert.throws(() => withBridgeCalls(assembled, serverCalls), /already/);
  assert.throws(() => withBridgeCalls(sealed.record, [{elapsed: NaN}]), /finite JSON/);
});
