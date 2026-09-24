(function publish(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RobotBridgeContract = api;
})(typeof globalThis === "object" ? globalThis : this, function contract() {
  "use strict";
  const PROTOCOL_VERSION = "chenlong.robot-bridge/v1";
  const METHODS = Object.freeze(["observe", "camera_parameters", "odometry", "local_road", "holding",
    "grab", "release", "forward", "backward", "turn", "follow_road", "take_exit"]);
  const CATEGORIES = Object.freeze(["target", "distractor", "obstacle", "storage-zone", "cleanup-zone"]);
  const STOP_REASONS = Object.freeze(["max_distance", "junction", "road_end", "front_clearance", "off_road",
    "wrong_way", "entered_road", "not_at_junction", "invalid_exit", "collision", "safety_limit", "time_limit"]);
  const ERROR_CODES = Object.freeze(["ACTION_FAILED", "NOT_RUNNING", "INVALID_EXIT", "AMBIGUOUS_EXIT",
    "STALE_SENSOR", "TIME_LIMIT", "CONTROLLER_CLOSED", "INVALID_CONTROLLER_RESPONSE"]);
  const CAMERA_PARAMETERS = Object.freeze({ width: 640, height: 480,
    fx: 240 / Math.tan(Math.PI / 6), fy: 240 / Math.tan(Math.PI / 6), cx: 320, cy: 240,
    verticalFovDeg: 60 });
  class ContractError extends Error {
    constructor(code) { super(code); this.name = "RobotBridgeContractError"; this.code = code; }
  }
  function fail(code = "INVALID_RESPONSE") { throw new ContractError(code); }
  function object(value, code = "INVALID_RESPONSE") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
    return value;
  }
  function exactKeys(value, allowed, required = allowed) {
    object(value, "INVALID_PARAMS");
    if (Object.keys(value).some(key => !allowed.includes(key))
      || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) fail("INVALID_PARAMS");
  }
  function number(value, min = -Infinity, max = Infinity, code = "INVALID_RESPONSE") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(code);
    return value;
  }
  function integer(value, min = 0) {
    if (!Number.isSafeInteger(value) || value < min) fail();
    return value;
  }
  function boolean(value) { if (typeof value !== "boolean") fail(); return value; }
  function nullableNumber(value) { return value === null ? null : number(value); }
  function requestId(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail("INVALID_REQUEST_ID");
    return value;
  }
  function normalizeCommand(value) {
    exactKeys(value, ["requestId", "method", "params"]);
    const id = requestId(value.requestId);
    if (!METHODS.includes(value.method)) fail("METHOD_NOT_ALLOWED");
    const p = object(value.params, "INVALID_PARAMS");
    const result = {};
    if (value.method === "observe") {
      exactKeys(p, ["category", "confidence"], []);
      if (p.category !== undefined) {
        if (p.category !== null && !CATEGORIES.includes(p.category)) fail("INVALID_PARAMS");
        result.category = p.category;
      }
      if (p.confidence !== undefined) result.confidence = number(p.confidence, 0, 1, "INVALID_PARAMS");
    } else if (["forward", "backward", "follow_road", "turn", "take_exit"].includes(value.method)) {
      const key = ["turn", "take_exit"].includes(value.method) ? "angleDeg" : "distanceCm";
      exactKeys(p, [key, "speed"], [key]);
      const min = key === "angleDeg" ? (value.method === "turn" ? -360 : -180)
        : value.method === "follow_road" ? 10 : 0.1;
      const max = key === "angleDeg" ? (value.method === "turn" ? 360 : 180) : 500;
      result[key] = number(p[key], min, max, "INVALID_PARAMS");
      if (value.method === "turn" && Math.abs(p[key]) < 1) fail("INVALID_PARAMS");
      if (p.speed !== undefined) result.speed = number(p.speed, 10, 100, "INVALID_PARAMS");
    } else exactKeys(p, []);
    return { requestId: id, method: value.method, params: result };
  }
  // Explicit construction is deliberate: neither object spread nor JSON cloning
  // may expose future sensor fields such as road IDs, world poses or package IDs.
  function sanitizeResponse(method, value) {
    if (!METHODS.includes(method)) fail("METHOD_NOT_ALLOWED");
    if (method === "holding") {
      if (value !== null && !["target", "distractor", "obstacle"].includes(value)) fail();
      return value;
    }
    const v = object(value);
    if (method === "observe") {
      if (v.width !== 640 || v.height !== 480 || !Array.isArray(v.detections)) fail();
      return { frameId: integer(v.frameId), tick: integer(v.tick), width: 640, height: 480,
        detections: v.detections.map(item => {
          object(item); if (!CATEGORIES.includes(item.category)) fail();
          const b = object(item.bbox);
          const x = number(b.x, 0, 640), y = number(b.y, 0, 480);
          const w = number(b.w, 0, 640 - x), h = number(b.h, 0, 480 - y);
          if (w === 0 || h === 0) fail();
          return { category: item.category, confidence: number(item.confidence, 0, 1), bbox: { x, y, w, h } };
        }) };
    }
    if (method === "camera_parameters") {
      for (const key of ["width", "height", "fx", "fy", "cx", "cy", "verticalFovDeg"]) {
        if (v[key] !== CAMERA_PARAMETERS[key]) fail();
      }
      const mount = object(v.mount);
      return { ...CAMERA_PARAMETERS, mount: { forwardCm: number(mount.forwardCm, 0),
        rightCm: number(mount.rightCm), upCm: number(mount.upCm, 0), pitchDeg: number(mount.pitchDeg, -180, 180) } };
    }
    if (method === "odometry") return { forwardCm: number(v.forwardCm), rightCm: number(v.rightCm),
      headingDeg: number(v.headingDeg), distanceCm: number(v.distanceCm, 0), tick: integer(v.tick) };
    if (method === "local_road") {
      if (!Array.isArray(v.exits)) fail();
      return { onRoad: boolean(v.onRoad), lateralOffsetCm: nullableNumber(v.lateralOffsetCm),
        headingErrorDeg: nullableNumber(v.headingErrorDeg), leftClearanceCm: nullableNumber(v.leftClearanceCm),
        rightClearanceCm: nullableNumber(v.rightClearanceCm), frontClearanceCm: nullableNumber(v.frontClearanceCm),
        atJunction: boolean(v.atJunction), atNode: boolean(v.atNode),
        exits: v.exits.map(exit => ({ angleDeg: number(object(exit).angleDeg, -180, 180) })), tick: integer(v.tick) };
    }
    if (["follow_road", "take_exit"].includes(method)) {
      if (!STOP_REASONS.includes(v.stoppedBy)) fail();
      return { accepted: boolean(v.accepted), stoppedBy: v.stoppedBy,
        distanceCm: number(v.distanceCm, 0), elapsedTicks: integer(v.elapsedTicks) };
    }
    if (v.completed !== true) fail();
    return { completed: true };
  }
  return Object.freeze({ PROTOCOL_VERSION, METHODS, CATEGORIES, CAMERA_PARAMETERS, ERROR_CODES,
    ContractError, normalizeCommand, sanitizeResponse, requestId });
});
