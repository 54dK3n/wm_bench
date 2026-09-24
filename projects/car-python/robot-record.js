(function attachRobotRecord(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RobotRecord = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createRobotRecord() {
  "use strict";

  const SCHEMA_VERSION = "guangyang.robot-record/v1";
  const ENVELOPE_SCHEMA_VERSION = "guangyang.robot-record-envelope/v1";
  const MANAGEMENT_FIELDS = Object.freeze([
    "runId", "serverSessionId", "challengeDigest", "teamId", "clientStartedAt", "clientEndedAt"
  ]);
  const COLLECTIONS = Object.freeze(["inputs", "events", "samples", "visionFrames"]);

  // A record must remain JSON data. Reject values which JSON.stringify would
  // silently erase or coerce, rather than reporting two lossy exports as equal.
  function copyJson(value, path = "value") {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map((item, index) => copyJson(item, `${path}[${index}]`));
    if (value && typeof value === "object"
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyJson(item, `${path}.${key}`)]));
    }
    throw new TypeError(`${path} must contain only finite JSON data`);
  }

  function integer(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
    return value;
  }

  /**
   * Evaluation-only record, never a robot sensor. Wrap EVERY dispatch, before
   * method validation, so unknown methods, rejected actions and thrown failures
   * are recorded too. The caller must serialize dispatch and freeze/reset the
   * renderer/camera at simulation ticks; this recorder never hides upstream
   * nondeterminism. Native records retain their original schema and every data
   * field, except the six named management fields moved into the envelope.
   *
   * const audit = new RobotRecord.RobotRunRecorder({session, envelope});
   * const token = audit.beginCall(method, args);
   * audit.endCall(token, {result}); // or {error: {name, message, ...}}
   * session.finish(reason);        // caller owns session lifecycle
   * const {envelope, record} = audit.finish();
   *
   * Calls preserve args/results without rounding. An undefined successful
   * return is represented by resultDefined:false, not silently discarded.
   * Error payloads are explicit JSON, not wall-clock dependent JS stacks.
   */
  class RobotRunRecorder {
    constructor({session, envelope = {}} = {}) {
      if (!session?.robotRuntime || !session?.simulationDefinition || !session?.recorder?.record) {
        throw new TypeError("robot recorder requires a deterministic session with explicit robotRuntime options");
      }
      this.session = session;
      this.stepMs = session.simulationDefinition.stepMs;
      if (!Number.isFinite(this.stepMs) || this.stepMs <= 0) throw new TypeError("simulation stepMs must be positive");
      this.envelope = copyJson(envelope, "envelope");
      this.calls = [];
      this.ledger = [];
      this.cursors = Object.fromEntries(COLLECTIONS.map(key => [key, 0]));
      this.nativeSequence = 0;
      this.activeCall = null;
      this.closed = false;
      this.sealedExport = null;
      this.syncNative();
    }

    clock() {
      return {
        tick: integer(this.session.simulationTick, "session tick"),
        stateRevision: integer(this.session.stateRevision, "session stateRevision")
      };
    }

    append(entry) {
      this.ledger.push({seq: this.ledger.length + 1, ...entry});
    }

    nativeTick(item) {
      if (item.tick !== undefined) return integer(item.tick, "native tick");
      if (typeof item.t !== "number" || !Number.isFinite(item.t) || item.t < 0) {
        throw new TypeError("native item without a tick requires a simulation timestamp");
      }
      const tick = Math.round(item.t / this.stepMs);
      // Native elapsed milliseconds are rounded to 0.001ms by RunRecorder.
      if (Math.abs(item.t - tick * this.stepMs) > 0.0005001) {
        throw new TypeError("native timestamp is not on a simulation tick");
      }
      return integer(tick, "native derived tick");
    }

    syncNative() {
      const native = this.session.recorder.record;
      const pending = [];
      for (const collection of COLLECTIONS) {
        const items = native[collection];
        if (!Array.isArray(items) || items.length < this.cursors[collection]) {
          throw new Error(`native ${collection} ledger was replaced or truncated`);
        }
        for (let index = this.cursors[collection]; index < items.length; index += 1) {
          pending.push({collection, index, item: items[index]});
        }
      }
      pending.sort((left, right) => left.item.seq - right.item.seq);
      let expected = this.nativeSequence + 1;
      const entries = pending.map(({collection, index, item}) => {
        if (item.seq !== expected++) throw new Error("native sequence must be complete, unique and contiguous");
        const tick = this.nativeTick(item);
        if (tick > this.clock().tick) throw new Error("native ledger contains a future tick");
        return {
          kind: "native", tick,
          stateRevision: item.stateRevision === undefined ? null : integer(item.stateRevision, "native stateRevision"),
          collection, index, nativeSeq: item.seq
        };
      });
      entries.forEach(entry => this.append(entry));
      this.nativeSequence += entries.length;
      COLLECTIONS.forEach(collection => { this.cursors[collection] = native[collection].length; });
    }

    beginCall(method, args = []) {
      if (this.closed) throw new Error("robot record is already finished");
      if (this.activeCall !== null) throw new Error("robot API calls must be serialized");
      if (typeof method !== "string" || !method.length) throw new TypeError("API method must be a non-empty string");
      const copiedArgs = copyJson(args, "args");
      this.syncNative();
      const call = {
        seq: this.calls.length + 1, method, args: copiedArgs,
        started: this.clock(), finished: null, outcome: null
      };
      this.calls.push(call);
      this.activeCall = call.seq;
      this.append({kind: "api_call_start", callSeq: call.seq, ...call.started});
      return call.seq;
    }

    endCall(token, response = {}) {
      if (this.closed) throw new Error("robot record is already finished");
      if (this.activeCall === null || token !== this.activeCall) throw new Error("API call token is not pending");
      if (!response || typeof response !== "object" || Array.isArray(response)) throw new TypeError("response must be an object");
      const hasError = Object.prototype.hasOwnProperty.call(response, "error");
      if (hasError && Object.prototype.hasOwnProperty.call(response, "result")) {
        throw new TypeError("response must contain a result or an error, not both");
      }
      const outcome = hasError
        ? {status: "error", error: copyJson(response.error, "error")}
        : {status: "returned", resultDefined: response.result !== undefined,
          result: response.result === undefined ? null : copyJson(response.result, "result")};
      this.syncNative();
      const call = this.calls[token - 1];
      call.finished = this.clock();
      if (call.finished.tick < call.started.tick) throw new Error("API call moved the simulation tick backwards");
      call.outcome = outcome;
      this.append({kind: "api_call_end", callSeq: token, ...call.finished});
      this.activeCall = null;
      return copyJson(call);
    }

    export() {
      if (this.sealedExport) return copyJson(this.sealedExport);
      this.syncNative();
      const native = copyJson(this.session.recorder.record, "native");
      const management = {};
      for (const key of MANAGEMENT_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(native, key)) {
          management[key] = native[key];
          delete native[key];
        }
      }
      return {
        envelope: {
          schemaVersion: ENVELOPE_SCHEMA_VERSION,
          metadata: copyJson(this.envelope), management
        },
        record: {
          schemaVersion: SCHEMA_VERSION,
          complete: this.closed,
          clock: {stepMs: this.stepMs},
          runtime: copyJson(this.session.robotRuntime),
          native, calls: copyJson(this.calls), ledger: copyJson(this.ledger), bridgeCalls: []
        }
      };
    }

    finish() {
      if (this.activeCall !== null) throw new Error("cannot finish with an unanswered API call");
      if (this.session.status === "running") throw new Error("finish the native session before sealing its robot record");
      this.closed = true;
      this.sealedExport = this.export();
      return copyJson(this.sealedExport);
    }
  }

  // Server-side denials never reach the browser. The evaluation exporter can
  // attach its full deterministic server trace after the session is sealed.
  // No fields are filtered here: caller-owned trace schema must keep wall-clock
  // and authentication/run identifiers in the separate envelope.
  function withBridgeCalls(record, calls) {
    if (record?.schemaVersion !== SCHEMA_VERSION) throw new TypeError("unsupported robot record schema");
    if (!Array.isArray(calls)) throw new TypeError("bridgeCalls must be an array");
    if (!Array.isArray(record.bridgeCalls) || record.bridgeCalls.length) {
      throw new Error("bridgeCalls has already been attached or is missing");
    }
    return {...copyJson(record), bridgeCalls: copyJson(calls, "bridgeCalls")};
  }

  return {SCHEMA_VERSION, ENVELOPE_SCHEMA_VERSION, MANAGEMENT_FIELDS, RobotRunRecorder, withBridgeCalls};
});
