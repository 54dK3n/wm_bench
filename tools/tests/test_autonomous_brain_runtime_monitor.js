"use strict";
// Controlled Chrome and child-process checks of driver recovery. The page and
// decision producer are fixtures; these are not a model API or robot demo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const test = require('node:test');
const {DriverDiagnostics, observeBridge} = require('../autonomous_brain_diagnostics.js');
const {MonitorGuard} = require('../autonomous_brain_monitor.js');
const {Cdp, RunningMonitor, chromePath, runBrain} = require('../autonomous_brain_driver.js');
const platform = path.resolve(__dirname, '../../workspaces/guangyang-platform/projects/car-python');
const {createRobotBridge} = require(path.join(platform, 'backend/robot-bridge.js'));
const contract = require(path.join(platform, 'robot-bridge-contract.js'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!await predicate()) {assert.ok(Date.now() < end, message); await sleep(20);}
}
const cdpFailure = message => Object.assign(new Error(message), {code: 'CDP_UNAVAILABLE'});
function events(file) {return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-running-monitor-'));
  const profile = path.join(dir, 'profile'); fs.mkdirSync(profile);
  const diagnostics = new DriverDiagnostics(dir);
  const bridge = createRobotBridge({pollTimeoutMs: 20});
  const bridgeDiagnostics = observeBridge(bridge, diagnostics); bridgeDiagnostics.setDirectory(dir);
  const guard = new MonitorGuard(bridge, diagnostics);
  const capability = bridge.register('controlled-monitor-owner');
  const browser = spawn(chromePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'],
    {stdio: ['ignore', 'ignore', 'pipe']});
  browser.stderr.on('data', bytes => diagnostics.stderr(bytes));
  let connection, monitor;
  t.after(async () => {
    guard.dispose('test_cleanup'); bridge.close(); connection?.client.close();
    if (browser.exitCode === null) {
      browser.kill('SIGTERM');
      await Promise.race([new Promise(resolve => browser.once('exit', resolve)), sleep(3000)]);
      if (browser.exitCode === null) browser.kill('SIGKILL');
    }
    fs.rmSync(dir, {recursive: true, force: true});
  });
  const endpointFile = path.join(profile, 'DevToolsActivePort');
  await until(() => {assert.equal(browser.exitCode, null); return fs.existsSync(endpointFile);}, 'Chrome did not start', 20000);
  const [port, suffix] = fs.readFileSync(endpointFile, 'utf8').trim().split(/\r?\n/);
  const endpoint = `ws://127.0.0.1:${port}${suffix}`;
  const client = new Cdp(diagnostics); await client.connect(endpoint);
  const {targetInfos} = await client.send('Target.getTargets');
  const targetId = targetInfos.find(target => target.type === 'page').targetId;
  const {sessionId} = await client.send('Target.attachToTarget', {targetId, flatten: true});
  connection = {client, sessionId};
  const evaluate = async (expression, timeoutMs = 2000) => {
    const reply = await connection.client.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, connection.sessionId, timeoutMs);
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    return reply.result.value;
  };
  await evaluate(`globalThis.competitionSession={status:'running',recorder:{record:{runId:'controlled-original-run'}}};
    globalThis.realtimeRun={}; globalThis.deterministicSimulator={tick:0};
    globalThis.fixtureState={running:true,healthy:true,tick:0,errors:[]};
    globalThis.startCount=0;globalThis.stopCount=0;
    globalThis.RobotBackend={status(){return {...fixtureState}},start(){startCount++},stop(){stopCount++}}; true`);
  monitor = new RunningMonitor({endpoint, targetId, getConnection: () => connection,
    setConnection: value => {connection = value;}, browser, guard, diagnostics,
    maxSimulationSeconds: 1200, recoveryTimeoutMs: 2500, readTimeoutMs: 1000, ...options});
  await monitor.bind(capability);
  return {dir, browser, endpoint, targetId, capability, bridge, guard, monitor, diagnostics, bridgeDiagnostics,
    evaluate, get connection() {return connection;},
    async disconnect() {connection.client.socket.close(); await until(() => !connection.client.available, 'CDP stayed open');}};
}

// A real separate process with one explicitly synthetic decision lifecycle.
// It submits one real frozen-bridge command, then only reads that request ID.
function childExecutable(dir) {
  const file = path.join(dir, 'controlled-child');
  fs.writeFileSync(file, `#!${process.execPath}
const fs=require('node:fs');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);
process.stdin.on('end',async()=>{try{
  const c=JSON.parse(input), out=${JSON.stringify(path.join(dir, 'child-events.jsonl'))};
  const log=(event)=>fs.appendFileSync(out,JSON.stringify({event,pid:process.pid})+'\\n');
  const post=async(route,body)=>{const r=await fetch(c.origin+route,{method:'POST',headers:{'content-type':'application/json','x-robot-bridge-client':c.client_token},body:JSON.stringify(body)});if(!r.ok)throw Error('fixture HTTP '+r.status);return r.json()};
  log('model_started');await post('/event',{event:'model_started'});log('model_finished');
  await post('/event',{event:'action_boundary'});log('dispatch');
  const route='/api/v1/robot-bridge/'+c.bridge_id+'/commands', requestId='controlled-move-1';
  let result=await post(route,{requestId,method:'forward',params:{distanceCm:10}});
  while(['queued','dispatched'].includes(result.status)){
    await new Promise(r=>setTimeout(r,20));const r=await fetch(c.origin+route+'/'+requestId,{headers:{'x-robot-bridge-client':c.client_token}});result=await r.json();
  }
  log('terminal_'+result.status);await post('/event',{event:'child_complete'});process.exitCode=result.status==='completed'?0:3;
}catch(error){process.stderr.write(String(error));process.exitCode=4;}});
`, {mode: 0o700});
  return file;
}

for (const phase of ['model_request', 'action_boundary', 'in_flight']) {
  test(`running recovery preserves the same real child during ${phase}, without a second command`, {timeout: 30000}, async t => {
    const f = await fixture(t); let injected = false, controllerDone = false;
    let statusReads = 0, submitted = 0, childPid, disconnectCount = 0;
    const submittedWhilePaused = [];
    const inject = async () => {if (!injected) {injected = true; disconnectCount++; await f.disconnect();}};
    const server = http.createServer(async (request, response) => {
      try {
        const buffers = []; for await (const chunk of request) buffers.push(chunk);
        const body = buffers.length ? JSON.parse(Buffer.concat(buffers)) : null;
        let value;
        if (request.url === '/event') {
          if ((phase === 'model_request' && body.event === 'model_started') ||
              (phase === 'action_boundary' && body.event === 'action_boundary')) {
            await inject();
            // In the decision phase the original request remains unfinished.
            // At the action boundary submit immediately: the server gate must
            // queue it until verification rather than relying on fixture sleep.
            if (phase === 'model_request') await sleep(1400);
          }
          if (body.event === 'child_complete') {
            await until(() => events(f.diagnostics.file).some(row => row.type === 'monitor_bridge_resumed'), 'recovery did not resume');
          }
          value = {ok: true};
        } else {
          f.bridge.authorizeClient(f.capability.bridgeId, request.headers['x-robot-bridge-client']);
          if (request.method === 'POST') {
            submitted++; submittedWhilePaused.push(f.guard.paused);
            value = f.bridge.submit(f.capability.bridgeId, body);
          }
          else {statusReads++; value = f.bridge.status(f.capability.bridgeId, request.url.split('/').at(-1));}
        }
        response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify(value));
      } catch (error) {response.writeHead(500); response.end(JSON.stringify({error: error.code || error.message}));}
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {controllerDone = true; server.closeAllConnections(); server.close();});
    const controller = (async () => {
      while (!controllerDone) {
        const {command} = await f.bridge.next(f.capability.bridgeId);
        if (!command) continue;
        assert.equal(f.guard.paused, false, 'controller must not receive a new command during the monitoring gap');
        f.diagnostics.event('fixture_command_dispatched', {requestId: command.requestId});
        assert.deepEqual(command, contract.normalizeCommand({requestId: 'controlled-move-1', method: 'forward', params: {distanceCm: 10}}));
        if (phase === 'in_flight') {await inject(); await sleep(1400);}
        f.bridge.complete(f.capability.bridgeId, {requestId: command.requestId, tick: 0, result: {completed: true}});
      }
    })();
    const result = await runBrain({python: childExecutable(f.dir), task: 'controlled fixture, not a competition task',
      maxRounds: 200, maxSimulationSeconds: 1200, wallTimeoutSeconds: 10},
      f.dir, f.capability, `http://127.0.0.1:${server.address().port}`, f.evaluate, f.monitor);
    controllerDone = true; await controller;
    assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(result.interrupted, null);
    const childEvents = events(path.join(f.dir, 'child-events.jsonl'));
    assert.deepEqual(childEvents.map(row => row.event), ['model_started', 'model_finished', 'dispatch', 'terminal_completed']);
    childPid = childEvents[0].pid; assert.ok(childEvents.every(row => row.pid === childPid));
    assert.equal(disconnectCount, 1); assert.equal(submitted, 1);
    const trace = f.bridge.trace(f.capability.bridgeId).events;
    assert.equal(trace.filter(row => row.type === 'request').length, 1);
    assert.equal(trace.filter(row => row.type === 'dispatch').length, 1);
    assert.equal(trace.filter(row => row.type === 'terminal').length, 1);
    if (phase === 'in_flight') assert.ok(statusReads > 0, 'existing in-flight request is polled, never resubmitted');
    const diagnosticEvents = events(f.diagnostics.file);
    assert.equal(diagnosticEvents.filter(row => row.type === 'monitor_bridge_resumed').length, 1);
    assert.equal(result.monitorRecovery.status, 'degraded_verified_recovered');
    if (phase === 'action_boundary') {
      assert.deepEqual(submittedWhilePaused, [true]);
      assert.deepEqual(result.monitorRecovery.before.queued, ['controlled-move-1']);
      assert.ok(diagnosticEvents.findIndex(row => row.type === 'monitor_bridge_resumed') <
        diagnosticEvents.findIndex(row => row.type === 'fixture_command_dispatched'));
    }
    if (phase === 'in_flight') {
      assert.deepEqual(result.monitorRecovery.before.inFlight, ['controlled-move-1']);
      assert.deepEqual(result.monitorRecovery.after.inFlight, []);
    }
    assert.deepEqual(await f.evaluate('({startCount,stopCount})'), {startCount: 0, stopCount: 0});
    assert.equal((await f.monitor.read()).status, 'running');
    await f.disconnect();
    await assert.rejects(f.monitor.recover(cdpFailure('controlled second disconnect')));
    assert.equal(diagnosticEvents.filter(row => row.type === 'monitor_bridge_resumed').length, 1);
  });
}

test('recovery rejects stopped, unhealthy, changed or exhausted original sessions', {timeout: 120000}, async t => {
  const cases = [
    ['backend stopped', async f => f.evaluate("fixtureState.running=false;competitionSession.status='finished'")],
    ['backend unhealthy', async f => f.evaluate('fixtureState.healthy=false')],
    ['controller errors', async f => f.evaluate("fixtureState.errors.push({controllerError:'controlled error'})")],
    ['simulation budget', async f => f.evaluate('fixtureState.tick=60000;deterministicSimulator.tick=60000')],
    ['different run', async f => f.evaluate("competitionSession.recorder.record.runId='replacement-run'")],
    ['same ID replacement session', async f => f.evaluate("competitionSession={status:'running',recorder:{record:{runId:'controlled-original-run'}}}")],
    ['controller replaced', async f => {f.bridge.register('different-controlled-owner');}],
    ['controller closed', async f => {f.bridge.closeController(f.capability.bridgeId);}],
    ['original target lost', async f => {await f.connection.client.send('Target.closeTarget', {targetId: f.targetId});}],
    ['browser exited', async f => {f.browser.kill('SIGTERM'); await new Promise(resolve => f.browser.once('exit', resolve));}],
  ];
  for (const [name, mutate] of cases) await t.test(name, async t => {
    const f = await fixture(t); await mutate(f);
    await f.disconnect();
    await assert.rejects(f.monitor.recover(cdpFailure(`controlled ${name}`)));
    assert.equal(events(f.diagnostics.file).filter(row => row.type === 'monitor_bridge_resumed').length, 0);
    f.bridgeDiagnostics.snapshot('controlled_failed_runtime_recovery');
    assert.equal(fs.existsSync(path.join(f.dir, 'server-bridge-trace.json')), true);
  });
});

test('runBrain stops a real child on a stopped backend and preserves the unfinished decision', {timeout: 30000}, async t => {
  const f = await fixture(t);
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume fixture event only. */ }
    await f.evaluate("fixtureState.running=false;competitionSession.status='finished'");
    // The synthetic model operation stays pending. Production runBrain must
    // stop the same child; no replacement call or fabricated finished row.
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {server.closeAllConnections(); server.close();});
  const result = await runBrain({python: childExecutable(f.dir), task: 'controlled stopped-backend fixture',
    maxRounds: 200, maxSimulationSeconds: 1200, wallTimeoutSeconds: 10},
    f.dir, f.capability, `http://127.0.0.1:${server.address().port}`, f.evaluate, f.monitor);
  assert.equal(result.signal, 'SIGTERM');
  assert.match(result.interrupted, /backend_stopped/);
  assert.equal(result.monitorRecovery.recovered, false);
  assert.deepEqual(events(path.join(f.dir, 'child-events.jsonl')).map(row => row.event), ['model_started']);
  assert.equal(f.bridge.trace(f.capability.bridgeId).events.filter(row => row.type === 'dispatch').length, 0);
  f.bridgeDiagnostics.snapshot('controlled_stopped_backend');
  assert.equal(fs.existsSync(path.join(f.dir, 'server-bridge-trace.json')), true);
});

test('unresolved or unknown in-flight outcome never dispatches queued follow-up', {timeout: 30000}, async t => {
  for (const unknown of [false, true]) await t.test(unknown ? 'unknown receipt' : 'deadline before terminal', async t => {
    const f = await fixture(t, {recoveryTimeoutMs: 150});
    f.bridge.submit(f.capability.bridgeId, contract.normalizeCommand({requestId: 'move-1', method: 'forward', params: {distanceCm: 10}}));
    await f.bridge.next(f.capability.bridgeId);
    f.bridge.submit(f.capability.bridgeId, contract.normalizeCommand({requestId: 'move-2', method: 'forward', params: {distanceCm: 10}}));
    if (unknown) f.bridge.complete(f.capability.bridgeId, {requestId: 'move-1', tick: 0, result: {completed: 'invalid'}});
    await f.disconnect(); const started = Date.now();
    await assert.rejects(f.monitor.recover(cdpFailure('controlled in-flight disconnect')));
    assert.ok(Date.now() - started < 2000, 'recovery must have one finite total deadline');
    const trace = f.bridge.trace(f.capability.bridgeId).events;
    assert.equal(trace.filter(row => row.type === 'request').length, 2);
    assert.equal(trace.filter(row => row.type === 'dispatch').length, 1);
    assert.equal(trace.filter(row => row.type === 'dispatch' && row.requestId === 'move-2').length, 0);
    f.bridgeDiagnostics.snapshot('controlled_outcome_unresolved');
    assert.equal(fs.existsSync(path.join(f.dir, 'server-bridge-trace.json')), true);
  });
});

test('permanent transport failure has one bounded original-endpoint attempt and retains diagnostics', {timeout: 30000}, async t => {
  const f = await fixture(t, {recoveryTimeoutMs: 80});
  await f.disconnect();
  const OriginalSocket = globalThis.WebSocket; let created = 0;
  class NeverConnect extends EventTarget {
    constructor(url) {super(); created++; assert.equal(url, f.endpoint);}
    close() {const event = new Event('close'); event.code = 1006; this.dispatchEvent(event);}
  }
  globalThis.WebSocket = NeverConnect; t.after(() => {globalThis.WebSocket = OriginalSocket;});
  const started = Date.now();
  await assert.rejects(f.monitor.recover(cdpFailure('controlled permanent disconnect')));
  assert.equal(created, 1); assert.ok(Date.now() - started < 2000);
  assert.equal(events(f.diagnostics.file).filter(row => row.type === 'monitor_bridge_resumed').length, 0);
  f.bridgeDiagnostics.snapshot('controlled_permanent_disconnect');
  assert.equal(fs.existsSync(path.join(f.dir, 'server-bridge-trace.json')), true);
});
