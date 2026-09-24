"use strict";

const crypto = require("node:crypto");
const contract = require("../robot-bridge-contract.js");
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash("sha256").update(value).digest();

class RobotBridgeError extends Error {
  constructor(statusCode, code) { super(code); this.statusCode = statusCode; this.code = code; }
}
function error(status, code) { throw new RobotBridgeError(status, code); }
function equalToken(expected, supplied) {
  return typeof supplied === "string" && supplied.length <= 256
    && crypto.timingSafeEqual(expected, hash(supplied));
}
function createRobotBridge({ pollTimeoutMs = 25_000, maxSessions = 128, maxCommands = 10_000 } = {}) {
  for (const [name, value] of Object.entries({ pollTimeoutMs, maxSessions, maxCommands })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  }
  const sessions = new Map();
  function session(id) {
    const value = sessions.get(id);
    if (!value) error(404, "BRIDGE_NOT_FOUND");
    return value;
  }
  function append(s, event) { s.trace.push({ seq: s.trace.length + 1, tick: s.lastTick, ...clone(event) }); }
  function publicCommand(command) {
    const result = { requestId: command.requestId, status: command.status };
    if (Object.prototype.hasOwnProperty.call(command, "result")) result.result = clone(command.result);
    if (command.error) result.error = { code: command.error };
    return result;
  }
  function dispatch(s) {
    if (s.closed || s.active) return null;
    const next = [...s.commands.values()].find(item => item.status === "queued");
    if (!next) return null;
    next.status = "dispatched"; s.active = next.requestId;
    append(s, { type: "dispatch", requestId: next.requestId });
    return clone(next.command);
  }
  function wake(s) {
    if (!s.waiter || s.active) return;
    const command = dispatch(s);
    if (command || s.closed) { const done = s.waiter; s.waiter = null; done({ command }); }
  }
  function closeSession(s) {
    if (s.closed) return;
    s.closed = true;
    for (const command of s.commands.values()) {
      if (!["queued", "dispatched"].includes(command.status)) continue;
      command.status = command.status === "dispatched" ? "unknown" : "cancelled";
      command.error = "CONTROLLER_CLOSED";
      append(s, { type: "terminal", ...publicCommand(command) });
    }
    s.active = null; wake(s);
  }
  return {
    register(ownerId) {
      if (typeof ownerId !== "string" || !ownerId) error(403, "CONTROLLER_AUTH_REQUIRED");
      if ([...sessions.values()].some(s => s.ownerId === ownerId && !s.closed)) error(409, "CONTROLLER_ALREADY_REGISTERED");
      if (sessions.size >= maxSessions) error(429, "BRIDGE_CAPACITY");
      const bridgeId = crypto.randomBytes(16).toString("hex");
      const controllerToken = crypto.randomBytes(32).toString("base64url");
      const clientToken = crypto.randomBytes(32).toString("base64url");
      sessions.set(bridgeId, { ownerId, controllerHash: hash(controllerToken), clientHash: hash(clientToken),
        commands: new Map(), trace: [], active: null, waiter: null, closed: false, lastTick: 0 });
      return { protocolVersion: contract.PROTOCOL_VERSION, bridgeId, controllerToken, clientToken };
    },
    authorizeController(id, ownerId, token) {
      const s = session(id);
      if (s.ownerId !== ownerId || !equalToken(s.controllerHash, token)) error(403, "CONTROLLER_FORBIDDEN");
    },
    authorizeClient(id, token) {
      if (!equalToken(session(id).clientHash, token)) error(403, "CLIENT_FORBIDDEN");
    },
    submit(id, value) {
      const s = session(id);
      if (s.closed) error(409, "BRIDGE_CLOSED");
      let normalized;
      try { normalized = contract.normalizeCommand(value); } catch (failure) {
        // Rejected values may contain credentials or arbitrary data. Retain only
        // validated identifiers and parameter names, never their unknown values.
        const safeMethod = typeof value?.method === "string" && /^[a-z_]{1,64}$/.test(value.method) ? value.method : null;
        let safeId = null;
        try { safeId = contract.requestId(value?.requestId); } catch (_error) { /* invalid identifier */ }
        append(s, { type: "rejected", requestId: safeId, method: safeMethod,
          code: failure.code || "INVALID_PARAMS" });
        error(400, failure.code || "INVALID_PARAMS");
      }
      const old = s.commands.get(normalized.requestId);
      if (old) {
        if (JSON.stringify(old.command) !== JSON.stringify(normalized)) {
          append(s, { type: "rejected", requestId: normalized.requestId, code: "REQUEST_ID_REUSED" });
          error(409, "REQUEST_ID_REUSED");
        }
        return publicCommand(old);
      }
      if (s.commands.size >= maxCommands) error(429, "COMMAND_CAPACITY");
      const command = { requestId: normalized.requestId, command: normalized, status: "queued" };
      s.commands.set(command.requestId, command);
      append(s, { type: "request", ...normalized }); wake(s);
      return publicCommand(command);
    },
    status(id, requestId) {
      const command = session(id).commands.get(requestId);
      if (!command) error(404, "COMMAND_NOT_FOUND");
      return publicCommand(command);
    },
    next(id, signal) {
      const s = session(id);
      if (s.closed) error(409, "BRIDGE_CLOSED");
      if (s.waiter) error(409, "CONTROLLER_POLL_PENDING");
      if (s.active) return Promise.resolve({ command: null });
      const command = dispatch(s);
      if (command) return Promise.resolve({ command });
      return new Promise(resolve => {
        const done = result => {
          clearTimeout(timer); signal?.removeEventListener("abort", cancelled);
          if (s.waiter === done) s.waiter = null;
          resolve(result);
        };
        const cancelled = () => done({ command: null });
        const timer = setTimeout(cancelled, pollTimeoutMs);
        s.waiter = done;
        if (signal?.aborted) cancelled(); else signal?.addEventListener("abort", cancelled, { once: true });
      });
    },
    complete(id, value) {
      const s = session(id);
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some(key => !["requestId", "result", "error", "tick"].includes(key))
        || (Object.prototype.hasOwnProperty.call(value, "result") === Object.prototype.hasOwnProperty.call(value, "error"))) {
        error(400, "INVALID_CONTROLLER_RESPONSE");
      }
      const command = s.commands.get(value.requestId);
      if (!command || command.status !== "dispatched" || s.active !== value.requestId) error(409, "COMMAND_NOT_ACTIVE");
      try {
        if (!Number.isSafeInteger(value.tick) || value.tick < s.lastTick) throw new Error("invalid tick");
        if (Object.prototype.hasOwnProperty.call(value, "error")) {
          if (!contract.ERROR_CODES.includes(value.error?.code)) throw new Error("unknown error");
          command.error = value.error.code; command.status = "failed";
        } else {
          command.result = contract.sanitizeResponse(command.command.method, value.result);
          if (command.result && typeof command.result === "object"
            && Object.prototype.hasOwnProperty.call(command.result, "tick") && command.result.tick !== value.tick) {
            delete command.result;
            throw new Error("result tick mismatch");
          }
          command.status = "completed";
        }
        s.lastTick = value.tick;
      } catch (_error) {
        command.status = "unknown"; command.error = "INVALID_CONTROLLER_RESPONSE";
      }
      s.active = null;
      append(s, { type: "terminal", ...publicCommand(command) });
      // An invalid response leaves physical outcome uncertain. Do not dispatch
      // another action into that uncertainty or silently retry the first action.
      if (command.status === "unknown") closeSession(s); else wake(s);
      return publicCommand(command);
    },
    trace(id) { return { protocolVersion: contract.PROTOCOL_VERSION, events: clone(session(id).trace) }; },
    closeController(id) { closeSession(session(id)); return { closed: true }; },
    close() { for (const s of sessions.values()) closeSession(s); }
  };
}
module.exports = { createRobotBridge, RobotBridgeError };
