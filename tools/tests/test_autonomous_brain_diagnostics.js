"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const {DriverDiagnostics, observeBridge} = require('../autonomous_brain_diagnostics.js');
const {Cdp, stopForChunkedExport, persistPageExport} = require('../autonomous_brain_driver.js');
const platform = path.resolve(__dirname, '../../workspaces/guangyang-platform/projects/car-python');
const {createRobotBridge} = require(path.join(platform, 'backend/robot-bridge.js'));
const contract = require(path.join(platform, 'robot-bridge-contract.js'));

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-diagnostics-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const log = new DriverDiagnostics(dir, options), bridge = createRobotBridge({pollTimeoutMs: 5});
  const methods = [...contract.METHODS];
  const monitor = observeBridge(bridge, log, options); monitor.setDirectory(dir);
  const credentials = bridge.register('controlled-test-owner');
  t.after(() => bridge.close());
  assert.deepEqual(contract.METHODS, methods, 'trusted diagnostic observer adds no robot method');
  return {dir, log, bridge, monitor, ...credentials};
}
function readTrace(dir) {return JSON.parse(fs.readFileSync(path.join(dir, 'server-bridge-trace.json')));}
function logEvents(dir) {return fs.readFileSync(path.join(dir, 'driver-diagnostics.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));}
function command(id, method = 'forward', params = {distanceCm: 10}) {
  return contract.normalizeCommand({requestId: id, method, params});
}

test('real frozen bridge invalid controller result is retained independently and never redispatched', async t => {
  const s = setup(t);
  s.bridge.submit(s.bridgeId, command('move-1')); await s.bridge.next(s.bridgeId);
  s.bridge.submit(s.bridgeId, command('move-2'));
  const terminal = s.bridge.complete(s.bridgeId, {requestId: 'move-1', tick: 8,
    result: {completed: 'invalid', client_token: s.clientToken}});
  assert.equal(terminal.status, 'unknown');
  const trace = readTrace(s.dir);
  assert.equal(trace.stage, 'invalid_controller_response');
  assert.equal(trace.complete, true);
  assert.equal(trace.events.filter(event => event.type === 'dispatch').length, 1);
  assert.equal(trace.events.find(event => event.requestId === 'move-2' && event.type === 'terminal').status, 'cancelled');
  assert.ok(logEvents(s.dir).some(event => event.type === 'controller_outcome_unknown' && event.requestId === 'move-1'));
  assert.equal(JSON.stringify(trace).includes(s.clientToken), false);
  assert.throws(() => s.bridge.submit(s.bridgeId, command('move-3')), {code: 'BRIDGE_CLOSED'});
});

test('malformed response envelope and explicit close retain separate structured causes', async t => {
  const s = setup(t);
  s.bridge.submit(s.bridgeId, command('move-1')); await s.bridge.next(s.bridgeId);
  assert.throws(() => s.bridge.complete(s.bridgeId, {requestId: 'move-1', password: s.controllerToken}), {code: 'INVALID_CONTROLLER_RESPONSE'});
  s.bridge.closeController(s.bridgeId);
  const events = logEvents(s.dir), trace = readTrace(s.dir);
  assert.ok(events.some(event => event.type === 'controller_response_rejected' && event.code === 'INVALID_CONTROLLER_RESPONSE'));
  assert.ok(events.some(event => event.type === 'controller_close_requested' && event.reason === 'explicit_close_endpoint'));
  assert.equal(trace.events.at(-1).status, 'unknown');
  assert.equal(trace.events.at(-1).error.code, 'CONTROLLER_CLOSED');
  assert.equal(JSON.stringify(events).includes(s.controllerToken), false);
});

test('page/CDP unavailable cannot prevent in-process trace persistence or invent complete physical evidence', async t => {
  const s = setup(t);
  s.bridge.submit(s.bridgeId, command('turn-1', 'turn', {angleDeg: 30})); await s.bridge.next(s.bridgeId);
  const cdp = new Cdp(s.log); // no page or connected transport
  const evaluate = () => cdp.send('Runtime.evaluate');
  s.monitor.snapshot('brain_ended_before_page_stop');
  await assert.rejects(stopForChunkedExport(evaluate, 20), {code: 'CDP_UNAVAILABLE'});
  const exported = await persistPageExport(evaluate, s.dir, {diagnosticTimeoutMs: 20});
  s.bridge.closeController(s.bridgeId); s.monitor.snapshot('before_server_destroy');
  assert.equal(exported.complete, false); assert.deepEqual(exported.completedDatasets, []);
  assert.equal(exported.failures.length, 5);
  assert.equal(fs.existsSync(path.join(s.dir, 'record.json.gz')), false);
  const trace = readTrace(s.dir);
  assert.equal(trace.events.at(-1).status, 'unknown');
  assert.equal(trace.events.filter(event => event.type === 'dispatch').length, 1);
});

test('small envelope has an independent budget before expired or slow bulk exports', async t => {
  for (const expireBefore of [true, false]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-budget-test-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const calls = [];
    const context = vm.createContext({__brainEvaluationCaptures: [], RobotBackend: {stop: async () => ({
      record: {native: {samples: [], visionFrames: []}}, sensorAudit: [], envelope: {controllerErrors: ['bounded-test']}})}});
    const evaluate = async expression => {calls.push(expression); return JSON.parse(JSON.stringify(await vm.runInContext(expression, context)));};
    await stopForChunkedExport(evaluate);
    const deadline = Date.now() + (expireBefore ? -1 : 10);
    const limited = async expression => {
      if (expression.includes('.open("record")')) await new Promise(resolve => setTimeout(resolve, 30));
      return evaluate(expression);
    };
    const exported = await persistPageExport(limited, dir, {deadline, diagnosticTimeoutMs: 1000});
    assert.equal(exported.complete, false);
    assert.ok(exported.evidence.envelope);
    assert.equal(calls.find(expression => expression.includes('.open(')), '__brainChunkedExport.open("envelope")');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'envelope.json'))).controllerErrors, ['bounded-test']);
    assert.equal(exported.evidence.record, undefined);
  }
});

test('CDP WebSocket close rejects pending request promptly without sending again', async t => {
  const s = setup(t); let socket;
  class ControlledSocket extends EventTarget {
    constructor() {super(); socket = this; this.sent = []; queueMicrotask(() => this.dispatchEvent(new Event('open')));}
    send(text) {this.sent.push(JSON.parse(text));}
    close() {const event = new Event('close'); event.code = 1006; event.reason = 'controlled-close'; this.dispatchEvent(event);}
  }
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = ControlledSocket;
  t.after(() => {globalThis.WebSocket = originalSocket;});
  const cdp = new Cdp(s.log); await cdp.connect('ws://127.0.0.1/controlled-test');
  const pending = cdp.send('Runtime.evaluate', {}, 'test-session', 60000);
  socket.close();
  await assert.rejects(pending, {code: 'CDP_UNAVAILABLE'});
  await assert.rejects(cdp.send('Runtime.evaluate'), {code: 'CDP_UNAVAILABLE'});
  assert.equal(socket.sent.length, 1);
  assert.ok(logEvents(s.dir).some(event => event.type === 'cdp_websocket_closed' && event.code === 1006));
});

test('stderr is bounded and secrets split over input chunks or URLs remain redacted', t => {
  const secret = 'synthetic-only-credential-for-test';
  const s = setup(t, {secrets: [secret], maxBytes: 8192, stderrBytes: 2048, maxTraceBytes: 300});
  s.log.stderr(Buffer.from('Authorization: Bearer synthe'));
  s.log.stderr(Buffer.from('tic-only-credential-for-test\nhttps://account:password@example.invalid/?token=abc\n'));
  s.log.event('controlled', {client_token: s.clientToken, password: secret, accessToken: 'synthetic-access', 'set-cookie': 'synthetic-session'});
  for (let i = 0; i < 100; i++) s.log.stderr(Buffer.from('ordinary stderr '.repeat(20) + '\n'));
  s.log.flushStderr();
  const content = fs.readFileSync(s.log.file, 'utf8');
  assert.equal(content.includes(secret), false); assert.equal(content.includes(s.clientToken), false);
  assert.equal(content.includes('synthetic-access'), false); assert.equal(content.includes('synthetic-session'), false);
  assert.equal(content.includes('account:password'), false); assert.equal(content.includes('token=abc'), false);
  assert.ok(Buffer.byteLength(content) <= 9000);
  assert.ok(logEvents(s.dir).some(event => event.type === 'browser_stderr_limit_reached'));
  for (let i = 0; i < 10; i++) s.bridge.submit(s.bridgeId, command(`move-${i}`));
  s.monitor.snapshot('bounded_trace');
  assert.equal(readTrace(s.dir).complete, false, 'bounded tail is explicitly incomplete');
});
