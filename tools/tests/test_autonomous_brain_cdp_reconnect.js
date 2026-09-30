"use strict";
// Controlled real-browser transport test, not a robot task or LLM demo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const test = require('node:test');
const {DriverDiagnostics} = require('../autonomous_brain_diagnostics.js');
const {Cdp, reconnectForExport, chromePath, stopForChunkedExport, persistPageExport} = require('../autonomous_brain_driver.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real Chrome: closed CDP socket preserves original page and reconnect exports without starting or executing', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cdp-reconnect-test-'));
  const profile = path.join(dir, 'profile'); fs.mkdirSync(profile);
  const diagnostics = new DriverDiagnostics(dir);
  const browser = spawn(chromePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'],
    {stdio: ['ignore', 'ignore', 'pipe']});
  browser.stderr.on('data', bytes => diagnostics.stderr(bytes));
  let first, recovered;
  t.after(async () => {
    first?.close(); recovered?.client.close();
    if (browser.exitCode === null) {
      browser.kill('SIGTERM');
      await Promise.race([new Promise(resolve => browser.once('exit', resolve)), sleep(3000)]);
      if (browser.exitCode === null) browser.kill('SIGKILL');
    }
    fs.rmSync(dir, {recursive: true, force: true});
  });
  const deadline = Date.now() + 20000, endpointFile = path.join(profile, 'DevToolsActivePort');
  while (!fs.existsSync(endpointFile)) {
    assert.equal(browser.exitCode, null, 'test browser exited before DevTools');
    assert.ok(Date.now() < deadline, 'test browser DevTools timeout'); await sleep(50);
  }
  const [port, suffix] = fs.readFileSync(endpointFile, 'utf8').trim().split(/\r?\n/);
  const endpoint = `ws://127.0.0.1:${port}${suffix}`;
  first = new Cdp(diagnostics); await first.connect(endpoint);
  const {targetInfos} = await first.send('Target.getTargets');
  const targetId = targetInfos.find(target => target.type === 'page').targetId;
  const {sessionId} = await first.send('Target.attachToTarget', {targetId, flatten: true});
  await first.send('Runtime.evaluate', {expression: `globalThis.samePageMarker='original-controlled-page';
    globalThis.startCount=0;globalThis.motionCount=0;globalThis.stopCount=0;
    globalThis.__brainEvaluationCaptures=[];
    globalThis.RobotBackend={start(){startCount++;},status(){return {running:true,healthy:false,tick:4,
      errors:[{controllerError:'controlled transport failure'}]};},stop(){stopCount++;
      return {record:{native:{samples:[],visionFrames:[]}},sensorAudit:[],envelope:{controllerErrors:['controlled transport failure']}};}};
    true`, returnByValue: true}, sessionId);
  // Disconnect only the real CDP WebSocket; do not close the page or browser.
  first.close(); assert.equal(first.available, false); assert.equal(browser.exitCode, null);
  const commands = [], originalSend = Cdp.prototype.send;
  t.mock.method(Cdp.prototype, 'send', function(method, params, ...rest) {
    commands.push({method, params}); return originalSend.call(this, method, params, ...rest);
  });
  recovered = await reconnectForExport({endpoint, targetId, previous: first, diagnostics, timeoutMs: 5000});
  assert.deepEqual(recovered.status.errors, [{controllerError: 'controlled transport failure'}]);
  assert.equal(recovered.status.tick, 4);
  assert.deepEqual(commands.map(row => row.method), ['Target.getTargets', 'Target.attachToTarget', 'Runtime.enable', 'Runtime.evaluate']);
  const evaluate = async (expression, timeoutMs) => {
    const reply = await recovered.client.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, recovered.sessionId, timeoutMs);
    assert.equal(reply.exceptionDetails, undefined); return reply.result.value;
  };
  await stopForChunkedExport(evaluate, 2000);
  const exported = await persistPageExport(evaluate, dir, {deadline: Date.now()+2000});
  assert.equal(exported.complete, true);
  assert.deepEqual(await evaluate('({marker:samePageMarker,startCount,motionCount,stopCount})'),
    {marker: 'original-controlled-page', startCount: 0, motionCount: 0, stopCount: 1});
  assert.equal(commands.some(row => ['Target.createTarget', 'Page.navigate'].includes(row.method)), false);
  assert.equal(commands.some(row => row.params?.expression?.includes('RobotBackend.start(')), false);
  // A missing original page fails closed; it does not substitute a new target.
  await recovered.client.send('Target.closeTarget', {targetId});
  const before = commands.length;
  await assert.rejects(reconnectForExport({endpoint, targetId, previous: recovered.client, diagnostics, timeoutMs: 2000}), /original CDP page target unavailable/);
  assert.deepEqual(commands.slice(before).map(row => row.method), ['Target.getTargets']);
});

test('export reconnect has one bounded connect attempt and logs detailed errors after redaction', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cdp-bound-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const secret = 'synthetic-cdp-error-secret', diagnostics = new DriverDiagnostics(dir, {secrets: [secret]});
  const original = globalThis.WebSocket; let created = 0;
  class NeverOpen extends EventTarget {
    constructor() {super(); created++;}
    close() {const event = new Event('close'); event.code = 1006; this.dispatchEvent(event);}
  }
  globalThis.WebSocket = NeverOpen; t.after(() => {globalThis.WebSocket = original;});
  const previous = new Cdp(diagnostics), started = Date.now();
  await assert.rejects(reconnectForExport({endpoint:'ws://127.0.0.1/test',targetId:'original',previous,diagnostics,timeoutMs:25}), /CDP connection/);
  assert.equal(created, 1); assert.ok(Date.now()-started < 1000);
  const failureClient = new Cdp(diagnostics);
  const connecting = failureClient.connect('ws://127.0.0.1/test');
  const event = new Event('error'); event.message = `token=${secret}`;
  event.error = Object.assign(new Error(`local socket ${secret}`), {code: 'TEST_SOCKET_ERROR', cause: {code:'ECONNRESET',message:`Bearer ${secret}`}});
  failureClient.socket.dispatchEvent(event);
  await assert.rejects(connecting, /CDP connection failed/);
  const content = fs.readFileSync(diagnostics.file, 'utf8');
  assert.equal(content.includes(secret), false);
  assert.ok(content.includes('TEST_SOCKET_ERROR')); assert.ok(content.includes('ECONNRESET'));
});
