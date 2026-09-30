"use strict";

// Controlled bridge tests only; these are not competition or model runs.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const {MonitorGuard} = require('../autonomous_brain_monitor.js');
const {createRobotBridge} = require(path.resolve(__dirname,
  '../../workspaces/guangyang-platform/projects/car-python/backend/robot-bridge.js'));
const contract = require(path.resolve(__dirname,
  '../../workspaces/guangyang-platform/projects/car-python/robot-bridge-contract.js'));

function setup(t) {
  const events = [], bridge = createRobotBridge({pollTimeoutMs: 30});
  const methods = [...contract.METHODS];
  const guard = new MonitorGuard(bridge, {event(type, details) {events.push({type, ...details});}});
  const capability = bridge.register('controlled-owner');
  const identity = guard.bind(capability);
  t.after(() => {guard.dispose(); bridge.close();});
  assert.deepEqual(contract.METHODS, methods);
  return {bridge, guard, capability, id: capability.bridgeId, identity, events};
}
const move = requestId => contract.normalizeCommand({requestId, method: 'forward', params: {distanceCm: 10}});
function finish(s, requestId, tick = 20) {
  return s.bridge.complete(s.id, {requestId, tick, result: {completed: true}});
}

test('pause clears an already pending frozen next waiter before submit wake; resume dispatches same queued ID once', async t => {
  const s = setup(t);
  const pending = s.bridge.next(s.id);
  const paused = s.guard.pause('controlled-cdp-loss');
  assert.equal(paused.dispatches, 0);
  assert.deepEqual(await pending, {command: null});
  s.bridge.submit(s.id, move('motion-1'));
  assert.equal(s.bridge.status(s.id, 'motion-1').status, 'queued');
  assert.deepEqual(await s.bridge.next(s.id), {command: null});
  assert.deepEqual((await s.guard.waitSettled(Date.now() + 500, 60000)).queued, ['motion-1']);
  s.guard.resume();
  assert.equal((await s.bridge.next(s.id)).command.requestId, 'motion-1');
  finish(s, 'motion-1');
  assert.equal(s.guard.check().dispatches, 1);
  assert.equal(s.guard.check().requests, 1);
  // Recovery policy is outside this guard; another fault must still close its
  // command boundary synchronously rather than throwing before it can pause.
  assert.equal(s.guard.pause().dispatches, 1);
  s.bridge.submit(s.id, move('motion-2'));
  assert.deepEqual(await s.bridge.next(s.id), {command: null});
});

test('in-flight settlement during pause cannot internally wake and dispatch the next queued motion', async t => {
  const s = setup(t);
  s.bridge.submit(s.id, move('motion-1'));
  await s.bridge.next(s.id);
  s.bridge.submit(s.id, move('motion-2'));
  s.guard.pause();
  assert.deepEqual(s.guard.check().inFlight, ['motion-1']);
  assert.throws(() => s.guard.resume(), {code: 'MONITOR_IN_FLIGHT_UNRESOLVED'});
  const result = s.guard.waitSettled(Date.now() + 500, 60000);
  setTimeout(() => finish(s, 'motion-1'), 20);
  const settled = await result;
  assert.deepEqual(settled.inFlight, []);
  assert.deepEqual(settled.queued, ['motion-2']);
  assert.equal(settled.dispatches, 1);
  assert.equal(settled.terminals, 1);
  s.guard.resume();
  assert.equal((await s.bridge.next(s.id)).command.requestId, 'motion-2');
  finish(s, 'motion-2', 40);
  const rows = s.bridge.trace(s.id).events;
  for (const id of ['motion-1', 'motion-2']) {
    assert.equal(rows.filter(row => row.type === 'request' && row.requestId === id).length, 1);
    assert.equal(rows.filter(row => row.type === 'dispatch' && row.requestId === id).length, 1);
  }
});

test('unknown or failed frozen controller response rejects recovery without resubmission', async t => {
  for (const response of [{result: {completed: 'invalid'}}, {error: {code: 'ACTION_FAILED'}}]) {
    const s = setup(t);
    s.bridge.submit(s.id, move('motion-1')); await s.bridge.next(s.id); s.guard.pause();
    s.bridge.complete(s.id, {requestId: 'motion-1', tick: 20, ...response});
    assert.throws(() => s.guard.check(), {code: 'MONITOR_CONTROLLER_ERROR'});
    await assert.rejects(s.guard.waitSettled(Date.now() + 100, 60000), {code: 'MONITOR_CONTROLLER_ERROR'});
    assert.equal(s.bridge.trace(s.id).events.filter(row => row.type === 'request').length, 1);
    assert.equal(s.bridge.trace(s.id).events.filter(row => row.type === 'dispatch').length, 1);
  }
});

test('explicit idle close, server close, replacement registration, and bad capability fail closed', t => {
  const idle = setup(t); idle.guard.pause(); idle.bridge.closeController(idle.id);
  assert.throws(() => idle.guard.check(), {code: 'MONITOR_CONTROLLER_CLOSED'});
  const server = setup(t); server.guard.pause(); server.bridge.close();
  assert.throws(() => server.guard.check(), {code: 'MONITOR_CONTROLLER_CLOSED'});
  const replaced = setup(t); replaced.guard.pause(); replaced.bridge.register('different-controlled-owner');
  assert.throws(() => replaced.guard.check(), {code: 'MONITOR_CONTROLLER_IDENTITY_CHANGED'});
  const bridge = createRobotBridge(), guard = new MonitorGuard(bridge);
  const cap = bridge.register('owner');
  assert.throws(() => guard.bind({...cap, clientToken: 'invalid-token'}), {code: 'CLIENT_FORBIDDEN'});
  guard.dispose(); bridge.close();
});

test('current tick at budget and unresolved in-flight deadline stop; dispose leaves commands unredispatched', async t => {
  const s = setup(t);
  s.bridge.submit(s.id, move('motion-1')); await s.bridge.next(s.id); finish(s, 'motion-1', 60000);
  s.guard.pause();
  assert.throws(() => s.guard.check({maxTick: 60000}), {code: 'MONITOR_SIMULATION_LIMIT'});
  const stuck = setup(t);
  stuck.bridge.submit(stuck.id, move('motion-1')); await stuck.bridge.next(stuck.id); stuck.guard.pause();
  const started = Date.now();
  await assert.rejects(stuck.guard.waitSettled(Date.now() + 60, 60000), {code: 'MONITOR_RECOVERY_DEADLINE'});
  assert.ok(Date.now() - started < 500);
  stuck.guard.dispose('controlled-timeout');
  assert.deepEqual(await stuck.bridge.next(stuck.id), {command: null});
  assert.equal(stuck.bridge.status(stuck.id, 'motion-1').status, 'dispatched');
  assert.equal(stuck.bridge.trace(stuck.id).events.filter(row => row.type === 'dispatch').length, 1);
  assert.throws(() => stuck.guard.resume(), {code: 'MONITOR_NOT_PAUSED'});
});

test('native trace detects an internally closed unknown outcome even when complete observer is bypassed', async t => {
  const s = setup(t);
  s.bridge.submit(s.id, move('motion-1')); await s.bridge.next(s.id); s.guard.pause();
  s.guard.original.complete(s.id, {requestId: 'motion-1', tick: 10, result: {completed: 'invalid'}});
  assert.throws(() => s.guard.check(), {code: 'MONITOR_COMMAND_OUTCOME_UNSAFE'});
});

test('safe identity snapshots and guard events contain neither capability nor owner values', t => {
  const s = setup(t); s.guard.pause(); s.guard.resume();
  const text = JSON.stringify({identity: s.identity, state: s.guard.check(), events: s.events});
  for (const value of [s.capability.bridgeId, s.capability.clientToken, s.capability.controllerToken, 'controlled-owner']) {
    assert.equal(text.includes(value), false);
  }
  assert.match(s.identity.bridgeRef, /^[a-f0-9]{64}$/);
  assert.equal(s.identity.controllerGeneration, 1);
});

test('pause and dispose stay nonthrowing at an unhealthy or unbound callback boundary', t => {
  const bridge = createRobotBridge(), guard = new MonitorGuard(bridge, {event() {throw new Error('logging unavailable');}});
  assert.doesNotThrow(() => guard.pause());
  assert.equal(guard.paused, true);
  assert.doesNotThrow(() => guard.dispose());
  bridge.close();
  const s = setup(t); s.bridge.closeController(s.id);
  assert.doesNotThrow(() => s.guard.pause());
  assert.equal(s.guard.paused, true);
  assert.throws(() => s.guard.check(), {code: 'MONITOR_CONTROLLER_CLOSED'});
});

test('a fresh independent trial can bind only after the old controller is closed', async t => {
  const s = setup(t);
  const early = s.bridge.register('other-owner');
  assert.throws(() => s.guard.bind(early), {code: 'MONITOR_ALREADY_BOUND'});
  s.guard.pause(); s.bridge.closeController(s.id);
  const identity = s.guard.bind(early);
  assert.equal(identity.controllerGeneration, 2);
  assert.notEqual(identity.bridgeRef, s.identity.bridgeRef);
  s.bridge.submit(early.bridgeId, move('new-trial-motion-1'));
  assert.equal((await s.bridge.next(early.bridgeId)).command.requestId, 'new-trial-motion-1');
  assert.equal(s.guard.check().requests, 1);
  assert.equal(s.bridge.trace(s.id).events.length, 0);
});
