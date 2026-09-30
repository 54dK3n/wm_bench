"use strict";

// Trusted driver-only observations. This never exposes an endpoint or a new
// robot capability and never submits/retries a command.
const fs = require('node:fs');
const path = require('node:path');

class DriverDiagnostics {
  constructor(directory, {secrets = [], maxBytes = 2 * 1024 * 1024, stderrBytes = 256 * 1024} = {}) {
    this.file = path.join(directory, 'driver-diagnostics.jsonl');
    fs.writeFileSync(this.file, '', {flag: 'wx'});
    this.secrets = new Set(); secrets.forEach(value => this.addSecret(value));
    this.maxBytes = maxBytes; this.bytes = 0; this.stderrBytes = stderrBytes;
    this.stderrUsed = 0; this.stderrPending = ''; this.phase = 'startup';
  }
  addSecret(value) {if (typeof value === 'string' && value.length >= 4) this.secrets.add(value);}
  redact(value) {
    let text = String(value);
    for (const secret of this.secrets) text = text.split(secret).join('<redacted>');
    return text.replace(/(https?:\/\/)[^\s/]*@/gi, '$1<redacted>@')
      .replace(/([?&](?:token|key|password|secret|auth)[^=\s]*=)[^\s&#]*/gi, '$1<redacted>')
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer <redacted>')
      .replace(/((?:authorization|api[_-]?key|(?:client|controller|access|refresh|session)[_-]?token|password|secret|token|(?:set-)?cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1<redacted>');
  }
  safe(value) {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map(item => this.safe(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, /^(authorization|api[_-]?key|(?:client|controller|access|refresh|session)[_-]?token|password|secret|token|(?:set-)?cookie)$/i.test(key) ? '<redacted>' : this.safe(item)]));
    return value;
  }
  event(type, details = {}) {
    if (this.bytes >= this.maxBytes) return;
    const line = JSON.stringify(this.safe({time: new Date().toISOString(), phase: this.phase, type, ...details})) + '\n';
    const bytes = Buffer.byteLength(line);
    try {
      if (this.bytes + bytes > this.maxBytes) {
        fs.appendFileSync(this.file, JSON.stringify({type: 'diagnostics_limit_reached', maxBytes: this.maxBytes}) + '\n');
        this.bytes = this.maxBytes;
      } else {fs.appendFileSync(this.file, line); this.bytes += bytes;}
    } catch { /* Diagnostics must never alter bridge command outcomes. */ }
  }
  stderr(chunk) {
    if (this.stderrUsed >= this.stderrBytes) return;
    this.stderrPending += chunk.toString('utf8');
    let end;
    while ((end = this.stderrPending.indexOf('\n')) >= 0) {
      this.stderrLine(this.stderrPending.slice(0, end));
      this.stderrPending = this.stderrPending.slice(end + 1);
    }
    // Do not split an unknown-length secret over separate output records.
    if (this.stderrPending.length > 65536) {this.stderrPending = ''; this.stderrLine('<overlong stderr line omitted>');}
  }
  stderrLine(line) {
    if (this.stderrUsed >= this.stderrBytes) return;
    const safe = this.redact(line);
    if (safe.length > 8192) {this.event('browser_stderr', {message: '<overlong stderr line omitted>'}); this.stderrUsed += 8192;}
    else {this.event('browser_stderr', {message: safe}); this.stderrUsed += Buffer.byteLength(safe);}
    if (this.stderrUsed >= this.stderrBytes) this.event('browser_stderr_limit_reached', {maxBytes: this.stderrBytes});
  }
  flushStderr() {if (this.stderrPending) this.stderrLine(this.stderrPending); this.stderrPending = '';}
}

function observeBridge(bridge, diagnostics, {maxTraceBytes = 32 * 1024 * 1024} = {}) {
  const sessions = new Map(); let directory = null, currentId = null;
  function snapshot(stage) {
    if (!directory) return;
    for (const [id, label] of currentId ? [[currentId, sessions.get(currentId)]] : []) {
      try {
        const trace = bridge.trace(id), retained = []; let bytes = 0;
        // Keep the terminal tail when a diagnostic bound is reached. Explicitly
        // incomplete trace must never be accepted as a physical record.
        for (let index = trace.events.length - 1; index >= 0; index--) {
          const event = JSON.stringify(diagnostics.safe(trace.events[index]));
          if (bytes + Buffer.byteLength(event) > maxTraceBytes) break;
          retained.push(JSON.parse(event)); bytes += Buffer.byteLength(event);
        }
        retained.reverse();
        const value = {evaluationOnly: true, source: 'server.robotBridge.trace (in process)',
          stage, session: label, complete: retained.length === trace.events.length,
          totalEvents: trace.events.length, retainedEvents: retained.length,
          protocolVersion: trace.protocolVersion, events: retained,
          note: 'Diagnostic bridge trace is not the simulator physical record.'};
        fs.writeFileSync(path.join(directory, 'server-bridge-trace.json'), JSON.stringify(value, null, 2) + '\n');
        diagnostics.event('bridge_trace_saved', {stage, session: label, totalEvents: value.totalEvents,
          retainedEvents: retained.length, complete: value.complete,
          tick: retained.at(-1)?.tick ?? null, requestId: retained.at(-1)?.requestId ?? null});
      } catch (error) {diagnostics.event('bridge_trace_error', {stage, code: error.code || error.name});}
    }
  }
  const register = bridge.register.bind(bridge);
  bridge.register = (...args) => {
    const result = register(...args);
    diagnostics.addSecret(result.controllerToken); diagnostics.addSecret(result.clientToken);
    sessions.set(result.bridgeId, `controller-${sessions.size + 1}`);
    currentId = result.bridgeId;
    diagnostics.event('controller_registered', {session: sessions.get(result.bridgeId)});
    return result;
  };
  const complete = bridge.complete.bind(bridge);
  bridge.complete = (id, value) => {
    try {
      const result = complete(id, value);
      if (result.status === 'unknown') {
        diagnostics.event('controller_outcome_unknown', {session: sessions.get(id), requestId: result.requestId,
          code: result.error?.code, tick: Number.isSafeInteger(value?.tick) ? value.tick : null,
          reason: 'bridge rejected terminal response; outcome unknown; controller closed'});
        snapshot('invalid_controller_response');
      }
      return result;
    } catch (error) {
      // Unvalidated controller bodies can contain arbitrary values; never log them.
      diagnostics.event('controller_response_rejected', {session: sessions.get(id), code: error.code || error.name});
      snapshot('controller_response_rejected'); throw error;
    }
  };
  const closeController = bridge.closeController.bind(bridge);
  bridge.closeController = id => {
    diagnostics.event('controller_close_requested', {session: sessions.get(id), reason: 'explicit_close_endpoint'});
    const result = closeController(id); snapshot('explicit_controller_close'); return result;
  };
  const close = bridge.close.bind(bridge);
  bridge.close = () => {snapshot('before_server_bridge_close'); const result = close();
    diagnostics.event('bridge_server_closed', {reason: 'server_lifecycle_close'}); snapshot('after_server_bridge_close'); return result;};
  return {setDirectory(value) {directory = value; currentId = null;}, snapshot};
}

module.exports = {DriverDiagnostics, observeBridge};
