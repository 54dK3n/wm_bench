"use strict";

// Trusted driver boundary only. The frozen bridge owns normalization, command
// state and response validation; this guard neither sends nor replays commands.
const crypto = require('node:crypto');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class MonitorGuardError extends Error {
  constructor(code) { super(code); this.name = 'MonitorGuardError'; this.code = code; }
}

class MonitorGuard {
  constructor(bridge, diagnostics) {
    this.bridge = bridge; this.diagnostics = diagnostics;
    this.registrations = new Map(); this.generation = 0; this.binding = null;
    this.waiters = new Set(); this.paused = false; this.disposed = false;
    this.pauseCount = 0; this.pauseDispatches = null; this.closedAll = false;
    this.original = Object.fromEntries(['register', 'authorizeClient', 'next', 'complete', 'closeController', 'close', 'trace', 'status']
      .map(name => [name, bridge[name].bind(bridge)]));

    bridge.register = (...args) => {
      const value = this.original.register(...args);
      const entry = {generation: ++this.generation, closed: false, controllerError: false};
      this.registrations.set(value.bridgeId, entry);
      if (this.binding && value.bridgeId !== this.binding.id) this.binding.replaced = true;
      return value;
    };
    bridge.next = (id, signal) => this.next(id, signal);
    bridge.complete = (id, value) => {
      try {
        const result = this.original.complete(id, value);
        if (result.status !== 'completed') {
          const entry = this.registrations.get(id); if (entry) entry.controllerError = true;
        }
        return result;
      } catch (error) {
        const entry = this.registrations.get(id); if (entry) entry.controllerError = true;
        throw error;
      }
    };
    bridge.closeController = id => {
      const result = this.original.closeController(id);
      const entry = this.registrations.get(id); if (entry) entry.closed = true;
      return result;
    };
    bridge.close = () => {
      this.closedAll = true;
      for (const entry of this.registrations.values()) entry.closed = true;
      return this.original.close();
    };
  }

  event(type, details = {}) {
    try { this.diagnostics?.event(type, details); } catch { /* Never change bridge outcomes for logging. */ }
  }
  fail(code) { throw new MonitorGuardError(code); }

  bind(capability) {
    if (this.binding) {
      const previous = this.registrations.get(this.binding.id);
      if (!previous?.closed || capability?.bridgeId === this.binding.id || this.closedAll) this.fail('MONITOR_ALREADY_BOUND');
      const trace = this.original.trace(this.binding.id);
      for (const event of trace.events) {
        if (event.type !== 'request') continue;
        if (['queued', 'dispatched'].includes(this.original.status(this.binding.id, event.requestId).status)) {
          this.fail('MONITOR_PREVIOUS_CONTROLLER_UNSETTLED');
        }
      }
    }
    const entry = this.registrations.get(capability?.bridgeId);
    if (!entry || entry.closed || this.closedAll) this.fail('MONITOR_CONTROLLER_IDENTITY_UNKNOWN');
    // Existing capability authentication, not a new endpoint or robot permission.
    this.original.authorizeClient(capability.bridgeId, capability.clientToken);
    const bridgeRef = crypto.createHash('sha256').update(capability.bridgeId).digest('hex');
    this.binding = {id: capability.bridgeId, generation: entry.generation, bridgeRef, replaced: false};
    // A later independent --runs trial has new capability authentication and a
    // closed original session. This does not resume or recycle the old task.
    this.paused = false; this.disposed = false; this.pauseCount = 0; this.pauseDispatches = null;
    return {bridgeRef, controllerGeneration: entry.generation};
  }

  async next(id, signal) {
    if (signal?.aborted) return {command: null};
    if (this.paused || this.disposed) {
      // Do not invoke original next: it can immediately dispatch a queued action.
      await sleep(50);
      return {command: null};
    }
    const abort = new AbortController();
    const forwardAbort = () => abort.abort();
    signal?.addEventListener('abort', forwardAbort, {once: true});
    if (signal?.aborted) abort.abort();
    const waiter = {id, abort}; this.waiters.add(waiter);
    try { return await this.original.next(id, abort.signal); }
    finally { this.waiters.delete(waiter); signal?.removeEventListener('abort', forwardAbort); }
  }

  pause(reason = 'monitor_connection_unavailable') {
    // This is synchronous. Frozen bridge next's abort listener clears its waiter
    // synchronously; submit/complete's internal wake cannot dispatch thereafter.
    // It must also be safe in a socket callback or terminal cleanup: a second
    // fault still closes dispatch even though the recovery allowance is spent.
    const alreadyPaused = this.paused;
    this.paused = true; this.pauseCount += alreadyPaused ? 0 : 1;
    for (const waiter of this.waiters) waiter.abort.abort();
    if (!alreadyPaused) this.pauseDispatches = null;
    try {
      if (this.binding && this.pauseDispatches === null) {
        this.pauseDispatches = this.original.trace(this.binding.id).events.filter(event => event.type === 'dispatch').length;
      }
      const state = this.check();
      this.event('monitor_bridge_paused', {reason, ...state});
      return state;
    } catch (error) {
      this.event('monitor_bridge_paused', {reason, stateUnavailable: error.code || error.name});
      return null;
    }
  }

  check({settled = false, maxTick = Infinity} = {}) {
    const binding = this.binding;
    if (!binding) this.fail('MONITOR_NOT_BOUND');
    const entry = this.registrations.get(binding.id);
    if (!entry || entry.generation !== binding.generation || binding.replaced) this.fail('MONITOR_CONTROLLER_IDENTITY_CHANGED');
    if (this.closedAll || entry.closed) this.fail('MONITOR_CONTROLLER_CLOSED');
    if (entry.controllerError) this.fail('MONITOR_CONTROLLER_ERROR');
    // Native trace plus same-request status are available even with no CDP page.
    const trace = this.original.trace(binding.id);
    const requests = new Map(); let tick = 0, dispatches = 0, terminals = 0;
    for (const event of trace.events) {
      if (Number.isSafeInteger(event.tick)) tick = Math.max(tick, event.tick);
      if (event.type === 'request') requests.set(event.requestId, event.method);
      if (event.type === 'dispatch') dispatches += 1;
      if (event.type === 'terminal') {
        terminals += 1;
        if (event.status !== 'completed') this.fail('MONITOR_COMMAND_OUTCOME_UNSAFE');
      }
    }
    if (this.paused && this.pauseDispatches !== null && dispatches !== this.pauseDispatches) this.fail('MONITOR_DISPATCH_DURING_PAUSE');
    const inFlight = [], queued = [];
    for (const requestId of requests.keys()) {
      const status = this.original.status(binding.id, requestId);
      if (status.status === 'dispatched') inFlight.push(requestId);
      else if (status.status === 'queued') queued.push(requestId);
      else if (status.status !== 'completed') this.fail('MONITOR_COMMAND_OUTCOME_UNSAFE');
    }
    if (inFlight.length > 1) this.fail('MONITOR_MULTIPLE_IN_FLIGHT_COMMANDS');
    if (tick >= maxTick) this.fail('MONITOR_SIMULATION_LIMIT');
    if (settled && inFlight.length) this.fail('MONITOR_IN_FLIGHT_UNRESOLVED');
    return {bridgeRef: binding.bridgeRef, controllerGeneration: binding.generation,
      tick, inFlight, queued, requests: requests.size, dispatches, terminals};
  }

  async waitSettled(deadline, maxTick = Infinity) {
    if (!this.paused || this.disposed) this.fail('MONITOR_NOT_PAUSED');
    if (!Number.isFinite(deadline)) this.fail('MONITOR_INVALID_DEADLINE');
    while (true) {
      if (Date.now() >= deadline) this.fail('MONITOR_RECOVERY_DEADLINE');
      const state = this.check({maxTick});
      if (!state.inFlight.length) return this.check({settled: true, maxTick});
      await sleep(Math.min(20, Math.max(1, deadline - Date.now())));
    }
  }

  resume() {
    if (!this.paused || this.disposed) this.fail('MONITOR_NOT_PAUSED');
    const state = this.check({settled: true});
    this.paused = false;
    this.event('monitor_bridge_resumed', state);
    return state;
  }

  dispose(reason = 'monitor_terminal') {
    this.disposed = true; this.paused = true;
    for (const waiter of this.waiters) waiter.abort.abort();
    this.event('monitor_bridge_dispatch_disabled', {reason});
  }
}

module.exports = {MonitorGuard, MonitorGuardError};
