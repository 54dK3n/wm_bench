(function attachCompetitionCore(root, factory) {
  const visionPixelCore = typeof module === "object" && module.exports
    ? require("./vision-pixel-core.js")
    : root?.CarVisionPixelCore ?? null;
  const api = factory(visionPixelCore);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CompetitionCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCompetitionCore(visionPixelCore) {
  "use strict";

  const SCHEMA_VERSION = "chenlong.run-record/v4";
  const DETERMINISTIC_LEGACY_SCHEMA_VERSION = "chenlong.run-record/v3";
  const LEGACY_SCHEMA_VERSION = "chenlong.run-record/v2";
  const SIMULATION_SCHEMA_VERSION = "chenlong.simulation/v1";
  const VEHICLE_MODEL_VERSION = "chenlong.vehicle/v1";
  const LEGACY_INTERACTION_SCHEMA_VERSION = "chenlong.package-interaction/v1";
  const INTERACTION_SCHEMA_VERSION = "chenlong.package-interaction/v2";
  const LEGACY_TASK_SCHEMA_VERSION = "chenlong.task/v1";
  const PREVIOUS_TASK_SCHEMA_VERSION = "chenlong.task/v2";
  const TASK_SCHEMA_VERSION = "chenlong.task/v3";
  const OFFROAD_TASK_SCHEMA_VERSION = "chenlong.task/v4";
  const ROAD_CLEARANCE_TASK_SCHEMA_VERSION = "chenlong.task/v5";
  const VISION_EVIDENCE_SCHEMA_VERSION = "chenlong.vision-evidence/v1";
  const LEGACY_NAVIGATION_DEFINITION_SCHEMA_VERSION = "chenlong.navigation/v1";
  const PREVIOUS_NAVIGATION_DEFINITION_SCHEMA_VERSION = "chenlong.navigation/v2";
  const MISSION_NAVIGATION_DEFINITION_SCHEMA_VERSION = "chenlong.navigation/v3";
  const RELEASE_PREVIEW_NAVIGATION_DEFINITION_SCHEMA_VERSION = "chenlong.navigation/v4";
  const PREVIOUS_CURRENT_NAVIGATION_DEFINITION_SCHEMA_VERSION = "chenlong.navigation/v5";
  const NAVIGATION_DEFINITION_SCHEMA_VERSION = "chenlong.navigation/v6";
  const ROAD_GRAPH_SCHEMA_VERSION = "chenlong.road-graph/v1";
  const LEGACY_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION = "chenlong.navigation-control/v1";
  const PREVIOUS_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION = "chenlong.navigation-control/v2";
  const RELEASE_PREVIEW_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION = "chenlong.navigation-control/v3";
  const PREVIOUS_CURRENT_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION = "chenlong.navigation-control/v4";
  const PREVIOUS_SAFE_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION = "chenlong.navigation-control/v5";
  const PREVIOUS_EXIT_SAFE_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION = "chenlong.navigation-control/v6";
  const PREVIOUS_UNIT_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION = "chenlong.navigation-control/v7";
  const NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION = "chenlong.navigation-control/v8";
  const NAVIGATION_MISSION_SCHEMA_VERSION = "chenlong.navigation-mission/v1";
  const TASK_STATE_SCHEMA_VERSION = "chenlong.task-state/v1";
  const RELEASE_PREVIEW_SCHEMA_VERSION = "chenlong.release-preview/v1";
  const COMPETITION_SCORE_MAXIMUM = 100;
  const GUANGYANG_SCORE_WEIGHTS = deepFreeze({
    task: 40,
    rules: 25,
    autonomous: 15,
    efficiency: 20
  });
  const CAMERA_DEFINITION = visionPixelCore?.CAMERA_DEFINITION
    ? deepFreeze(clone(visionPixelCore.CAMERA_DEFINITION)) : null;
  const DETECTOR_DEFINITION = visionPixelCore?.DETECTOR_DEFINITION
    ? deepFreeze(clone(visionPixelCore.DETECTOR_DEFINITION)) : null;
  const QUERY_DEFINITION = visionPixelCore?.QUERY_DEFINITION
    ? deepFreeze(clone(visionPixelCore.QUERY_DEFINITION)) : null;
  const VISION_DEFINITION = visionPixelCore?.VISION_DEFINITION
    ? deepFreeze(clone(visionPixelCore.VISION_DEFINITION)) : null;
  const LEGACY_VISION_DEFINITION = visionPixelCore?.LEGACY_VISION_DEFINITION
    ? deepFreeze(clone(visionPixelCore.LEGACY_VISION_DEFINITION)) : null;
  const CAMERA_DEFINITION_HASH = visionPixelCore?.CAMERA_DEFINITION_HASH ?? null;
  const DETECTOR_DEFINITION_HASH = visionPixelCore?.DETECTOR_DEFINITION_HASH ?? null;
  const QUERY_DEFINITION_HASH = visionPixelCore?.QUERY_DEFINITION_HASH ?? null;
  const VISION_DEFINITION_HASH = visionPixelCore?.VISION_DEFINITION_HASH ?? null;
  const LEGACY_VISION_DEFINITION_HASH = visionPixelCore?.LEGACY_VISION_DEFINITION_HASH ?? null;
  const LEGACY_NAVIGATION_DEFINITION = deepFreeze({
    schemaVersion: LEGACY_NAVIGATION_DEFINITION_SCHEMA_VERSION,
    coordinateFrame: "initial-vehicle-pose",
    distanceUnit: "centimeter",
    angleUnit: "degree",
    methods: {
      odometry: {
        fields: ["forwardCm", "rightCm", "headingDeg", "distanceCm", "tick"]
      },
      road_state: {
        fields: [
          "onRoad", "roadId", "roadIds", "lateralOffsetCm", "headingErrorDeg",
          "leftClearanceCm", "rightClearanceCm", "atJunction", "tick"
        ]
      }
    }
  });
  const PREVIOUS_NAVIGATION_DEFINITION = deepFreeze({
    schemaVersion: PREVIOUS_NAVIGATION_DEFINITION_SCHEMA_VERSION,
    coordinateFrame: "initial-vehicle-pose",
    distanceUnit: "centimeter",
    angleUnit: "degree",
    roadTopology: {
      graphSchemaVersion: ROAD_GRAPH_SCHEMA_VERSION,
      endpointSnapDigits: 6,
      junctionRadiusCm: 125,
      straightTurnLimitDeg: 30,
      backTurnLimitDeg: 150
    },
    methods: {
      odometry: {
        fields: ["forwardCm", "rightCm", "headingDeg", "distanceCm", "tick"]
      },
      road_state: {
        fields: [
          "onRoad", "roadId", "roadIds", "lateralOffsetCm", "headingErrorDeg",
          "leftClearanceCm", "rightClearanceCm", "frontClearanceCm", "atJunction", "junctionId", "exits", "tick"
        ]
      },
      map_graph: {
        fields: ["schemaVersion", "nodes", "edges"]
      }
    }
  });
  const LEGACY_NAVIGATION_CONTROL_DEFINITION = deepFreeze({
    schemaVersion: LEGACY_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    navigationSchemaVersion: PREVIOUS_NAVIGATION_DEFINITION_SCHEMA_VERSION,
    distanceUnit: "centimeter",
    speedUnit: "percent",
    actionLimit: 300,
    controller: {
      lookaheadCm: 20,
      headingToleranceDeg: 1,
      exitEntryCm: 25,
      takeExitSpeed: 30,
      maxActionTicks: 5000
    },
    methods: {
      follow_road: {
        args: ["maxCm", "speed"],
        resultFields: ["accepted", "stoppedBy", "roadId", "distanceCm", "elapsedTicks"]
      },
      take_exit: {
        args: ["roadId"],
        resultFields: ["accepted", "stoppedBy", "roadId", "distanceCm", "elapsedTicks"]
      }
    }
  });
  const MISSION_NAVIGATION_DEFINITION = deepFreeze({
    ...clone(PREVIOUS_NAVIGATION_DEFINITION),
    schemaVersion: MISSION_NAVIGATION_DEFINITION_SCHEMA_VERSION,
    methods: {
      ...clone(PREVIOUS_NAVIGATION_DEFINITION.methods),
      road_state: {
        fields: [
          "onRoad", "roadId", "roadIds", "lateralOffsetCm", "headingErrorDeg",
          "leftClearanceCm", "rightClearanceCm", "frontClearanceCm", "atJunction", "junctionId", "exits",
          "roadProgressCm", "fromNodeId", "toNodeId", "atNode", "nodeId", "tick"
        ]
      },
      mission: {
        fields: ["schemaVersion", "mapId", "mapVersion", "start", "storage", "checkpoints", "return"]
      },
      task_state: {
        fields: [
          "schemaVersion", "completed", "total", "status", "nextCheckpointId", "targetDelivered",
          "distractorCleared", "avoidanceStatus", "goalReached", "tick"
        ]
      }
    }
  });
  const RELEASE_PREVIEW_NAVIGATION_DEFINITION = deepFreeze({
    ...clone(MISSION_NAVIGATION_DEFINITION),
    schemaVersion: RELEASE_PREVIEW_NAVIGATION_DEFINITION_SCHEMA_VERSION,
    methods: {
      ...clone(MISSION_NAVIGATION_DEFINITION.methods),
      release_preview: {
        fields: [
          "schemaVersion", "holding", "releaseAccepted", "releaseReason", "wouldCompleteDelivery",
          "roadClearanceCm", "requiredRoadClearanceCm", "tick"
        ]
      }
    }
  });
  const PREVIOUS_CURRENT_NAVIGATION_DEFINITION = deepFreeze({
    ...clone(RELEASE_PREVIEW_NAVIGATION_DEFINITION),
    schemaVersion: PREVIOUS_CURRENT_NAVIGATION_DEFINITION_SCHEMA_VERSION,
    objectAnchorDisclosure: "none",
    methods: {
      ...clone(RELEASE_PREVIEW_NAVIGATION_DEFINITION.methods),
      mission: {
        fields: [
          "schemaVersion", "mapId", "mapVersion", "start", "storage", "checkpoints", "return", "objects"
        ]
      }
    }
  });
  // v6 makes every centimeter-valued topology setting respect rules.unitsPerMeter.
  // v5 is retained above so already archived records keep their exact old replay.
  const NAVIGATION_DEFINITION = deepFreeze({
    ...clone(PREVIOUS_CURRENT_NAVIGATION_DEFINITION),
    schemaVersion: NAVIGATION_DEFINITION_SCHEMA_VERSION
  });
  const PREVIOUS_PUBLIC_NAVIGATION_DEFINITION = deepFreeze({
    ...clone(PREVIOUS_CURRENT_NAVIGATION_DEFINITION),
    objectAnchorDisclosure: "road-anchor"
  });
  // This is only embedded into normal, administrator-published single sessions.
  // It gives route-level task anchors (road + progress) rather than world coordinates.
  const PUBLIC_NAVIGATION_DEFINITION = deepFreeze({
    ...clone(NAVIGATION_DEFINITION),
    objectAnchorDisclosure: "road-anchor"
  });
  const PREVIOUS_NAVIGATION_CONTROL_DEFINITION = deepFreeze({
    ...clone(LEGACY_NAVIGATION_CONTROL_DEFINITION),
    schemaVersion: PREVIOUS_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    navigationSchemaVersion: MISSION_NAVIGATION_DEFINITION_SCHEMA_VERSION
  });
  const RELEASE_PREVIEW_NAVIGATION_CONTROL_DEFINITION = deepFreeze({
    ...clone(PREVIOUS_NAVIGATION_CONTROL_DEFINITION),
    schemaVersion: RELEASE_PREVIEW_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    navigationSchemaVersion: RELEASE_PREVIEW_NAVIGATION_DEFINITION_SCHEMA_VERSION
  });
  // v4 is retained exactly for replaying records created before opt-in
  // speed-limit-aware road following was introduced.
  const PREVIOUS_CURRENT_NAVIGATION_CONTROL_DEFINITION = deepFreeze({
    ...clone(RELEASE_PREVIEW_NAVIGATION_CONTROL_DEFINITION),
    schemaVersion: PREVIOUS_CURRENT_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    navigationSchemaVersion: PREVIOUS_CURRENT_NAVIGATION_DEFINITION_SCHEMA_VERSION
  });
  const PREVIOUS_SAFE_NAVIGATION_CONTROL_DEFINITION = deepFreeze({
    ...clone(PREVIOUS_CURRENT_NAVIGATION_CONTROL_DEFINITION),
    schemaVersion: PREVIOUS_SAFE_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    methods: {
      ...clone(PREVIOUS_CURRENT_NAVIGATION_CONTROL_DEFINITION.methods),
      follow_road: {
        args: ["maxCm", "speed", "obeySpeedLimit"],
        resultFields: ["accepted", "stoppedBy", "roadId", "distanceCm", "elapsedTicks"]
      }
    }
  });
  // v6 is retained exactly for records created before the controller learned
  // how to cross a road whose two endpoint approach radii overlap.
  const PREVIOUS_EXIT_SAFE_NAVIGATION_CONTROL_DEFINITION = deepFreeze({
    ...clone(PREVIOUS_SAFE_NAVIGATION_CONTROL_DEFINITION),
    schemaVersion: PREVIOUS_EXIT_SAFE_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    methods: {
      ...clone(PREVIOUS_SAFE_NAVIGATION_CONTROL_DEFINITION.methods),
      take_exit: {
        args: ["roadId", "speed", "obeySpeedLimit"],
        resultFields: ["accepted", "stoppedBy", "roadId", "distanceCm", "elapsedTicks"]
      }
    }
  });
  const PREVIOUS_UNIT_NAVIGATION_CONTROL_DEFINITION = deepFreeze({
    ...clone(PREVIOUS_EXIT_SAFE_NAVIGATION_CONTROL_DEFINITION),
    schemaVersion: PREVIOUS_UNIT_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    navigationSchemaVersion: PREVIOUS_CURRENT_NAVIGATION_DEFINITION_SCHEMA_VERSION,
    controller: {
      ...clone(PREVIOUS_EXIT_SAFE_NAVIGATION_CONTROL_DEFINITION.controller),
      // On a very short edge the two 125cm node approach circles can overlap.
      // v7 follows that edge to its actual selected endpoint so road_state
      // exposes the correct node/exits rather than the entry-side node.
      shortEdgeNodeArrival: true
    }
  });
  const NAVIGATION_CONTROL_DEFINITION = deepFreeze({
    ...clone(PREVIOUS_UNIT_NAVIGATION_CONTROL_DEFINITION),
    schemaVersion: NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_DEFINITION_SCHEMA_VERSION
  });
  const DEFAULT_FIXED_STEP_MS = 20;
  const DEFAULT_SAMPLE_INTERVAL_MS = 100;
  const MAX_REPLAY_INPUTS = 10000;
  const MAX_REPLAY_SAMPLES = 50000;
  const MAX_REPLAY_EVENTS = 50000;
  const MAX_SIMULATION_COMMAND_TICKS = 50000;
  const MAX_REPLAY_TICKS = 50000;
  const MAX_SIMULATION_COLLIDERS = 1000;
  const MAX_SIMULATION_WORK = 10000000;
  const MAX_REPLAY_ANALYSIS_WORK = 10000000;
  const MAX_INTERACTION_PACKAGES = 1000;
  const MAX_VISION_FRAMES = 1000;
  const MAX_VISION_FRAME_BYTES = 2 * 1024 * 1024;
  const MAX_VISION_TOTAL_BYTES = 20 * 1024 * 1024;
  const MAX_VISION_DIMENSION = 4096;
  const MAX_NAVIGATION_QUERIES = 1000;
  const MAX_NAVIGATION_CONTROLS = 300;
  const MAX_NAVIGATION_ROADS = 1000;
  const MAX_NAVIGATION_ROAD_POINTS = 10000;
  const RUN_END_REASONS = new Set([
    "completed", "timeout", "program_finished", "program_error", "stopped", "reset", "restarted",
    "mission_changed", "client_watchdog", "worker_error", "cancelled", "finished"
  ]);
  const MAX_SIMULATION_COORDINATE = 1000000;
  const MAX_SIMULATION_SPEED = 1000;
  const EPSILON = 1e-9;
  const INTERACTION_OBJECT_ROLES = new Set(["target", "distractor", "obstacle"]);
  const LEGACY_COMPOSITE_DESTINATION_BY_ROLE = Object.freeze({ target: "storage", distractor: "cleanup" });
  const OFFROAD_COMPOSITE_DESTINATION_BY_ROLE = Object.freeze({ target: "storage", distractor: "offroad-removal" });
  const COMPOSITE_TASK_SCHEMA_VERSIONS = new Set([
    PREVIOUS_TASK_SCHEMA_VERSION,
    TASK_SCHEMA_VERSION,
    OFFROAD_TASK_SCHEMA_VERSION,
    ROAD_CLEARANCE_TASK_SCHEMA_VERSION
  ]);
  const AVOIDANCE_TASK_SCHEMA_VERSIONS = new Set([
    TASK_SCHEMA_VERSION,
    OFFROAD_TASK_SCHEMA_VERSION,
    ROAD_CLEARANCE_TASK_SCHEMA_VERSION
  ]);

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  function round(value, digits = 3) {
    const factor = 10 ** digits;
    return Math.round((Number(value) || 0) * factor) / factor;
  }

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  }

  function exactJsonEqual(left, right) {
    if (left === right) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
      return Array.isArray(left) && Array.isArray(right) && left.length === right.length
        && left.every((value, index) => exactJsonEqual(value, right[index]));
    }
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index]
        && exactJsonEqual(left[key], right[key]));
  }

  function normalizeVisionDefinition(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("vision definition must be an object");
    }
    if (!VISION_DEFINITION) {
      throw new TypeError("vision definition support is unavailable in this runtime");
    }
    if (exactJsonEqual(input, VISION_DEFINITION)) return clone(VISION_DEFINITION);
    if (LEGACY_VISION_DEFINITION && exactJsonEqual(input, LEGACY_VISION_DEFINITION)) {
      return clone(LEGACY_VISION_DEFINITION);
    }
    throw new TypeError("vision definition does not match a supported frozen virtual vision contract");
  }

  function normalizeNavigationDefinition(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("navigation definition must be an object");
    }
    if (exactJsonEqual(input, LEGACY_NAVIGATION_DEFINITION)) return clone(LEGACY_NAVIGATION_DEFINITION);
    if (exactJsonEqual(input, PREVIOUS_NAVIGATION_DEFINITION)) return clone(PREVIOUS_NAVIGATION_DEFINITION);
    if (exactJsonEqual(input, MISSION_NAVIGATION_DEFINITION)) return clone(MISSION_NAVIGATION_DEFINITION);
    if (exactJsonEqual(input, RELEASE_PREVIEW_NAVIGATION_DEFINITION)) return clone(RELEASE_PREVIEW_NAVIGATION_DEFINITION);
    if (exactJsonEqual(input, PREVIOUS_CURRENT_NAVIGATION_DEFINITION)) {
      return clone(PREVIOUS_CURRENT_NAVIGATION_DEFINITION);
    }
    if (exactJsonEqual(input, PREVIOUS_PUBLIC_NAVIGATION_DEFINITION)) {
      return clone(PREVIOUS_PUBLIC_NAVIGATION_DEFINITION);
    }
    if (exactJsonEqual(input, NAVIGATION_DEFINITION)) return clone(NAVIGATION_DEFINITION);
    if (exactJsonEqual(input, PUBLIC_NAVIGATION_DEFINITION)) return clone(PUBLIC_NAVIGATION_DEFINITION);
    throw new TypeError("navigation definition does not match a supported frozen navigation sensor contract");
  }

  function navigationSupportsRoadTopology(definition) {
    return definition?.schemaVersion === PREVIOUS_NAVIGATION_DEFINITION_SCHEMA_VERSION
      || definition?.schemaVersion === MISSION_NAVIGATION_DEFINITION_SCHEMA_VERSION
      || definition?.schemaVersion === RELEASE_PREVIEW_NAVIGATION_DEFINITION_SCHEMA_VERSION
      || definition?.schemaVersion === PREVIOUS_CURRENT_NAVIGATION_DEFINITION_SCHEMA_VERSION
      || definition?.schemaVersion === NAVIGATION_DEFINITION_SCHEMA_VERSION;
  }

  function navigationSupportsMissionQueries(definition) {
    return definition?.schemaVersion === MISSION_NAVIGATION_DEFINITION_SCHEMA_VERSION
      || definition?.schemaVersion === RELEASE_PREVIEW_NAVIGATION_DEFINITION_SCHEMA_VERSION
      || definition?.schemaVersion === PREVIOUS_CURRENT_NAVIGATION_DEFINITION_SCHEMA_VERSION
      || definition?.schemaVersion === NAVIGATION_DEFINITION_SCHEMA_VERSION;
  }

  function navigationSupportsReleasePreview(definition) {
    return definition?.schemaVersion === RELEASE_PREVIEW_NAVIGATION_DEFINITION_SCHEMA_VERSION
      || definition?.schemaVersion === PREVIOUS_CURRENT_NAVIGATION_DEFINITION_SCHEMA_VERSION
      || definition?.schemaVersion === NAVIGATION_DEFINITION_SCHEMA_VERSION;
  }

  function normalizeNavigationControlDefinition(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("navigation control definition must be an object");
    }
    if (exactJsonEqual(input, LEGACY_NAVIGATION_CONTROL_DEFINITION)) {
      return clone(LEGACY_NAVIGATION_CONTROL_DEFINITION);
    }
    if (exactJsonEqual(input, PREVIOUS_NAVIGATION_CONTROL_DEFINITION)) {
      return clone(PREVIOUS_NAVIGATION_CONTROL_DEFINITION);
    }
    if (exactJsonEqual(input, RELEASE_PREVIEW_NAVIGATION_CONTROL_DEFINITION)) {
      return clone(RELEASE_PREVIEW_NAVIGATION_CONTROL_DEFINITION);
    }
    if (exactJsonEqual(input, PREVIOUS_CURRENT_NAVIGATION_CONTROL_DEFINITION)) {
      return clone(PREVIOUS_CURRENT_NAVIGATION_CONTROL_DEFINITION);
    }
    if (exactJsonEqual(input, PREVIOUS_SAFE_NAVIGATION_CONTROL_DEFINITION)) {
      return clone(PREVIOUS_SAFE_NAVIGATION_CONTROL_DEFINITION);
    }
    if (exactJsonEqual(input, PREVIOUS_EXIT_SAFE_NAVIGATION_CONTROL_DEFINITION)) {
      return clone(PREVIOUS_EXIT_SAFE_NAVIGATION_CONTROL_DEFINITION);
    }
    if (exactJsonEqual(input, PREVIOUS_UNIT_NAVIGATION_CONTROL_DEFINITION)) {
      return clone(PREVIOUS_UNIT_NAVIGATION_CONTROL_DEFINITION);
    }
    if (exactJsonEqual(input, NAVIGATION_CONTROL_DEFINITION)) return clone(NAVIGATION_CONTROL_DEFINITION);
    throw new TypeError("navigation control definition does not match the frozen local road control contract");
  }

  function normalizeNavigationControlAction(method, args = {}, definition = NAVIGATION_CONTROL_DEFINITION) {
    const controlDefinition = normalizeNavigationControlDefinition(definition);
    const normalizedMethod = String(method || "").trim();
    if (!Object.prototype.hasOwnProperty.call(controlDefinition.methods, normalizedMethod)) {
      throw new TypeError(`unsupported navigation control: ${normalizedMethod || "missing"}`);
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new TypeError(`navigation control ${normalizedMethod} args must be an object`);
    }
    if (normalizedMethod === "follow_road") {
      const supportsSpeedLimitFollowing = controlDefinition.schemaVersion === PREVIOUS_SAFE_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION
        || controlDefinition.schemaVersion === PREVIOUS_EXIT_SAFE_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION
        || controlDefinition.schemaVersion === PREVIOUS_UNIT_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION
        || controlDefinition.schemaVersion === NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION;
      const allowed = new Set(supportsSpeedLimitFollowing
        ? ["maxCm", "speed", "obeySpeedLimit"]
        : ["maxCm", "speed"]);
      if (Object.keys(args).some(key => !allowed.has(key))) {
        throw new TypeError("follow_road args contain unsupported fields");
      }
      const maxCm = Number(args.maxCm);
      const speed = Number(args.speed);
      if (!Number.isFinite(maxCm) || maxCm < 10 - EPSILON || maxCm > 500 + EPSILON) {
        throw new RangeError("follow_road maxCm must be between 10 and 500 centimeters");
      }
      if (!Number.isFinite(speed) || speed < 10 - EPSILON || speed > 100 + EPSILON) {
        throw new RangeError("follow_road speed must be between 10 and 100 percent");
      }
      const obeySpeedLimit = args.obeySpeedLimit;
      if (supportsSpeedLimitFollowing && obeySpeedLimit !== undefined && typeof obeySpeedLimit !== "boolean") {
        throw new TypeError("follow_road obeySpeedLimit must be boolean when provided");
      }
      return {
        method: normalizedMethod,
        args: {
          maxCm: navigationRounded(maxCm),
          speed: navigationRounded(speed),
          ...(supportsSpeedLimitFollowing ? { obeySpeedLimit: Boolean(obeySpeedLimit) } : {})
        }
      };
    }
    const supportsSpeedLimitExit = controlDefinition.schemaVersion === PREVIOUS_EXIT_SAFE_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION
      || controlDefinition.schemaVersion === PREVIOUS_UNIT_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION
      || controlDefinition.schemaVersion === NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION;
    const allowed = new Set(supportsSpeedLimitExit
      ? ["roadId", "speed", "obeySpeedLimit"] : ["roadId"]);
    if (Object.keys(args).some(key => !allowed.has(key))) {
      throw new TypeError("take_exit args contain unsupported fields");
    }
    const roadId = String(args.roadId || "").trim();
    if (!roadId || roadId.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(roadId)) {
      throw new TypeError("take_exit roadId must be 1-128 printable characters");
    }
    const speed = args.speed === undefined ? controlDefinition.controller.takeExitSpeed : Number(args.speed);
    if (!Number.isFinite(speed) || speed < 10 - EPSILON || speed > 100 + EPSILON) {
      throw new RangeError("take_exit speed must be between 10 and 100 percent");
    }
    const obeySpeedLimit = args.obeySpeedLimit;
    if (supportsSpeedLimitExit && obeySpeedLimit !== undefined && typeof obeySpeedLimit !== "boolean") {
      throw new TypeError("take_exit obeySpeedLimit must be boolean when provided");
    }
    return {
      method: normalizedMethod,
      args: {
        roadId,
        ...(supportsSpeedLimitExit
          ? { speed: navigationRounded(speed), obeySpeedLimit: Boolean(obeySpeedLimit) }
          : {})
      }
    };
  }

  const NAVIGATION_CONTROL_STOP_REASONS = new Set([
    "max_distance", "junction", "road_end", "front_clearance", "off_road", "wrong_way",
    "entered_road", "not_at_junction", "invalid_exit", "collision", "safety_limit", "time_limit"
  ]);

  function normalizeNavigationControlResult(input = {}, definition = NAVIGATION_CONTROL_DEFINITION) {
    const controlDefinition = normalizeNavigationControlDefinition(definition);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("navigation control result must be an object");
    }
    const fields = ["accepted", "stoppedBy", "roadId", "distanceCm", "elapsedTicks"];
    const keys = Object.keys(input).sort();
    if (keys.length !== fields.length || fields.some(field => !keys.includes(field))) {
      throw new TypeError("navigation control result has an invalid shape");
    }
    if (typeof input.accepted !== "boolean") {
      throw new TypeError("navigation control result accepted must be boolean");
    }
    const stoppedBy = String(input.stoppedBy || "");
    if (!NAVIGATION_CONTROL_STOP_REASONS.has(stoppedBy)) {
      throw new TypeError("navigation control result stoppedBy is invalid");
    }
    const roadId = input.roadId === null ? null : String(input.roadId || "").trim();
    if (roadId !== null && (!roadId || roadId.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(roadId))) {
      throw new TypeError("navigation control result roadId must be null or 1-128 printable characters");
    }
    const distanceCm = Number(input.distanceCm);
    if (!Number.isFinite(distanceCm) || distanceCm < 0) {
      throw new TypeError("navigation control result distanceCm must be non-negative and finite");
    }
    const elapsedTicks = Number(input.elapsedTicks);
    if (!Number.isSafeInteger(elapsedTicks) || elapsedTicks < 0
      || elapsedTicks > controlDefinition.controller.maxActionTicks) {
      throw new TypeError("navigation control result elapsedTicks is outside the action safety limit");
    }
    const rejected = new Set(["not_at_junction", "invalid_exit", "off_road", "wrong_way"]);
    if (input.accepted === rejected.has(stoppedBy)) {
      throw new TypeError("navigation control result accepted does not match stoppedBy");
    }
    return {
      accepted: input.accepted,
      stoppedBy,
      roadId,
      distanceCm: navigationRounded(distanceCm),
      elapsedTicks
    };
  }

  function normalizeSignedAngle(angle) {
    const value = Number(angle);
    if (!Number.isFinite(value)) throw new TypeError("navigation angle must be finite");
    const normalized = ((value + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    return normalized >= Math.PI - EPSILON ? -Math.PI : normalized;
  }

  function navigationRounded(value, digits = 1) {
    const normalized = round(value, digits);
    return Object.is(normalized, -0) ? 0 : normalized;
  }

  // Guangyang keeps eight fine-grained simulation units per physical metre so
  // the imported map, collision geometry and existing routes retain their
  // precision. Public navigation APIs must never expose those internal units:
  // all distances read from or supplied to student code are centimetres.
  function navigationWorldUnitsPerMeter(rules = {}) {
    const value = Number(rules?.unitsPerMeter);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  function navigationWorldToCm(value, rules = {}) {
    return Number(value) * 100 / navigationWorldUnitsPerMeter(rules);
  }

  function navigationCmToWorld(value, rules = {}) {
    return Number(value) * navigationWorldUnitsPerMeter(rules) / 100;
  }

  function navigationContractCmToWorld(value, rules = {}, definition = NAVIGATION_DEFINITION) {
    return definition?.schemaVersion === NAVIGATION_DEFINITION_SCHEMA_VERSION
      ? navigationCmToWorld(value, rules)
      : Number(value) / 100;
  }

  function navigationJunctionRadiusWorld(rules = {}, definition = NAVIGATION_DEFINITION) {
    const mapRadius = Number(rules?.navigationJunctionRadiusCm);
    // navigationJunctionRadiusCm was introduced together with v6 so a map can
    // express the old internal radius using real physical centimetres.  Never
    // feed that new override into a frozen v1-v5 contract: those definitions
    // intentionally interpret their own 125 value using the legacy scale.
    const radiusCm = definition?.schemaVersion === NAVIGATION_DEFINITION_SCHEMA_VERSION
      && Number.isFinite(mapRadius) && mapRadius > 0
      ? mapRadius
      : definition.roadTopology.junctionRadiusCm;
    return navigationContractCmToWorld(radiusCm, rules, definition);
  }

  function navigationTextCompare(left, right) {
    const a = String(left);
    const b = String(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function normalizeNavigationPose(input, label) {
    const x = Number(input?.x);
    const z = Number(input?.z);
    const heading = Number(input?.heading);
    if (![x, z, heading].every(Number.isFinite)) {
      throw new TypeError(`${label} requires finite x, z and heading values`);
    }
    return { x, z, heading };
  }

  const navigationTopologyInstances = new WeakSet();
  const navigationTopologyHandles = new WeakMap();

  function navigationTopologyPoint(input, label) {
    if (!Array.isArray(input) || input.length < 2) {
      throw new TypeError(`${label} must be an [x, z] point`);
    }
    const x = Number(input[0]);
    const z = Number(input[1]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      throw new TypeError(`${label} must contain finite coordinates`);
    }
    return [x, z];
  }

  function navigationEndpointKey(point, digits) {
    const normalizeCoordinate = value => {
      const snapped = navigationRounded(value, digits);
      return (Object.is(snapped, -0) ? 0 : snapped).toFixed(digits);
    };
    return `${normalizeCoordinate(point[0])},${normalizeCoordinate(point[1])}`;
  }

  function navigationNodeId(endpoint) {
    return `node:${encodeURIComponent(endpoint.roadId)}:${endpoint.side}`;
  }

  function buildNavigationTopology(rules = {}, navigationDefinition = NAVIGATION_DEFINITION) {
    const definition = normalizeNavigationDefinition(navigationDefinition);
    if (!navigationSupportsRoadTopology(definition)) {
      throw new TypeError("road topology requires the navigation v2 or v3 contract");
    }
    const roads = Array.isArray(rules?.roads) ? rules.roads : [];
    if (!roads.length) throw new Error("navigation road topology requires a drivable road network");
    if (roads.length > MAX_NAVIGATION_ROADS) {
      throw new RangeError(`navigation road topology exceeds the ${MAX_NAVIGATION_ROADS} road limit`);
    }
    const endpointSnapDigits = definition.roadTopology.endpointSnapDigits;
    const ids = new Set();
    const endpointGroups = new Map();
    let pointCount = 0;
    const records = roads.map((road, roadIndex) => {
      if (!road || typeof road !== "object" || Array.isArray(road)) {
        throw new TypeError(`navigation road ${roadIndex} must be an object`);
      }
      const roadId = String(road.id || "").trim();
      if (!roadId || roadId.length > 128 || ids.has(roadId)) {
        throw new TypeError(`navigation road id must be non-empty and unique: ${roadId || "empty"}`);
      }
      ids.add(roadId);
      if (!Array.isArray(road.points) || road.points.length < 2) {
        throw new TypeError(`navigation road ${roadId} requires at least two points`);
      }
      pointCount += road.points.length;
      if (pointCount > MAX_NAVIGATION_ROAD_POINTS) {
        throw new RangeError(`navigation road topology exceeds the ${MAX_NAVIGATION_ROAD_POINTS} point limit`);
      }
      const points = road.points.map((point, pointIndex) => (
        navigationTopologyPoint(point, `navigation road ${roadId} point ${pointIndex}`)
      ));
      let length = 0;
      const segmentLengths = [];
      const cumulativeLengths = [0];
      for (let index = 0; index < points.length - 1; index += 1) {
        const segmentLength = Math.hypot(
          points[index + 1][0] - points[index][0],
          points[index + 1][1] - points[index][1]
        );
        segmentLengths.push(segmentLength);
        length += segmentLength;
        cumulativeLengths.push(length);
      }
      if (length <= EPSILON) throw new TypeError(`navigation road ${roadId} must have positive length`);
      const startKey = navigationEndpointKey(points[0], endpointSnapDigits);
      const endKey = navigationEndpointKey(points[points.length - 1], endpointSnapDigits);
      if (startKey === endKey) {
        throw new TypeError(`navigation road ${roadId} cannot form a snapped topology self-loop`);
      }
      const record = {
        road,
        roadId,
        points,
        length,
        segmentLengths,
        cumulativeLengths,
        startKey,
        endKey,
        oneWay: Boolean(road.oneWay)
      };
      [["start", startKey, points[0]], ["end", endKey, points[points.length - 1]]]
        .forEach(([side, key, point]) => {
          const group = endpointGroups.get(key) || { key, endpoints: [] };
          group.endpoints.push({ roadId, side, point, record });
          endpointGroups.set(key, group);
        });
      return record;
    });

    const nodeByEndpointKey = new Map();
    const internalNodes = [...endpointGroups.values()].map(group => {
      group.endpoints.sort((left, right) => navigationTextCompare(left.roadId, right.roadId)
        || navigationTextCompare(left.side, right.side));
      const roadIds = [...new Set(group.endpoints.map(endpoint => endpoint.roadId))].sort();
      const nodeId = navigationNodeId(group.endpoints[0]);
      const point = group.endpoints.reduce((sum, endpoint) => [
        sum[0] + endpoint.point[0], sum[1] + endpoint.point[1]
      ], [0, 0]).map(value => value / group.endpoints.length);
      const node = { nodeId, roadIds, point, endpoints: group.endpoints };
      nodeByEndpointKey.set(group.key, node);
      return node;
    }).sort((left, right) => navigationTextCompare(left.nodeId, right.nodeId));

    const nodes = internalNodes.map(node => ({ nodeId: node.nodeId, roadIds: [...node.roadIds] }));
    const edges = records.map(record => ({
      roadId: record.roadId,
      fromNodeId: nodeByEndpointKey.get(record.startKey).nodeId,
      toNodeId: nodeByEndpointKey.get(record.endKey).nodeId,
      lengthCm: navigationRounded(navigationWorldToCm(record.length, rules)),
      oneWay: record.oneWay
    })).sort((left, right) => navigationTextCompare(left.roadId, right.roadId));
    const topology = {
      navigationSchemaVersion: definition.schemaVersion,
      graph: deepFreeze({ schemaVersion: ROAD_GRAPH_SCHEMA_VERSION, nodes, edges }),
      junctions: internalNodes.filter(node => node.roadIds.length >= 3),
      nodesById: new Map(internalNodes.map(node => [node.nodeId, node])),
      recordsById: new Map(records.map(record => [record.roadId, record]))
    };
    navigationTopologyInstances.add(topology);
    return topology;
  }

  function createNavigationTopologyContext(rules = {}, navigationDefinition = NAVIGATION_DEFINITION) {
    const topology = buildNavigationTopology(rules, navigationDefinition);
    const handle = Object.freeze(Object.create(null));
    navigationTopologyHandles.set(handle, topology);
    return handle;
  }

  function resolveNavigationTopology(state, rules, navigationDefinition) {
    if (state?.roadTopology && navigationTopologyInstances.has(state.roadTopology)
      && state.roadTopology.navigationSchemaVersion === navigationDefinition.schemaVersion) {
      return state.roadTopology;
    }
    const handled = state?.roadTopology && navigationTopologyHandles.get(state.roadTopology);
    if (handled && handled.navigationSchemaVersion === navigationDefinition.schemaVersion) return handled;
    return buildNavigationTopology(rules, navigationDefinition);
  }

  function navigationEndpointTangent(endpoint) {
    const points = endpoint.record.points;
    const originIndex = endpoint.side === "start" ? 0 : points.length - 1;
    const step = endpoint.side === "start" ? 1 : -1;
    const origin = points[originIndex];
    for (let index = originIndex + step; index >= 0 && index < points.length; index += step) {
      const dx = points[index][0] - origin[0];
      const dz = points[index][1] - origin[1];
      const length = Math.hypot(dx, dz);
      if (length > EPSILON) return [dx / length, dz / length];
    }
    return null;
  }

  function navigationJunctionProjection(topology, selectedRoadId, pose, definition, rules = {}) {
    const radius = navigationJunctionRadiusWorld(rules, definition);
    const vehicleForward = [-Math.sin(pose.heading), -Math.cos(pose.heading)];
    const junction = topology.junctions
      .filter(node => node.roadIds.includes(selectedRoadId))
      .map(node => {
        const endpoint = node.endpoints.find(candidate => candidate.roadId === selectedRoadId);
        const outward = endpoint ? navigationEndpointTangent(endpoint) : null;
        return {
          node,
          distance: Math.hypot(pose.x - node.point[0], pose.z - node.point[1]),
          ahead: Boolean(outward
            && outward[0] * vehicleForward[0] + outward[1] * vehicleForward[1] < -EPSILON)
        };
      })
      .filter(candidate => candidate.distance <= radius + EPSILON)
      .sort((left, right) => Number(right.ahead) - Number(left.ahead)
        || left.distance - right.distance
        || navigationTextCompare(left.node.nodeId, right.node.nodeId))[0]?.node || null;
    if (!junction) return { junctionId: null, exits: [] };
    const exitsByRoad = new Map();
    junction.endpoints.forEach(endpoint => {
      if (endpoint.record.oneWay && endpoint.side !== "start") return;
      const tangent = navigationEndpointTangent(endpoint);
      if (!tangent) return;
      const exitHeading = Math.atan2(-tangent[0], -tangent[1]);
      const turnDeg = navigationRounded(normalizeSignedAngle(exitHeading - pose.heading) * 180 / Math.PI);
      const absoluteTurn = Math.abs(turnDeg);
      const direction = absoluteTurn <= definition.roadTopology.straightTurnLimitDeg + EPSILON
        ? "straight"
        : absoluteTurn >= definition.roadTopology.backTurnLimitDeg - EPSILON
          ? "back"
          : turnDeg > 0 ? "left" : "right";
      const exit = { roadId: endpoint.roadId, direction, turnDeg };
      const previous = exitsByRoad.get(endpoint.roadId);
      if (!previous || Math.abs(exit.turnDeg) < Math.abs(previous.turnDeg) - EPSILON
        || (Math.abs(exit.turnDeg - previous.turnDeg) <= EPSILON
          && navigationTextCompare(exit.direction, previous.direction) < 0)) {
        exitsByRoad.set(endpoint.roadId, exit);
      }
    });
    return {
      junctionId: junction.nodeId,
      exits: [...exitsByRoad.values()].sort((left, right) => right.turnDeg - left.turnDeg
        || navigationTextCompare(left.roadId, right.roadId))
    };
  }

  function navigationNodeProjection(topology, selectedRoadId, pose, definition, rules = {}) {
    const radius = navigationJunctionRadiusWorld(rules, definition);
    const vehicleForward = [-Math.sin(pose.heading), -Math.cos(pose.heading)];
    const node = [...topology.nodesById.values()]
      .filter(candidate => candidate.roadIds.includes(selectedRoadId))
      .map(candidate => {
        const endpoint = candidate.endpoints.find(item => item.roadId === selectedRoadId);
        const outward = endpoint ? navigationEndpointTangent(endpoint) : null;
        return {
          node: candidate,
          distance: Math.hypot(pose.x - candidate.point[0], pose.z - candidate.point[1]),
          ahead: Boolean(outward
            && outward[0] * vehicleForward[0] + outward[1] * vehicleForward[1] < -EPSILON)
        };
      })
      .filter(candidate => candidate.distance <= radius + EPSILON)
      .sort((left, right) => Number(right.ahead) - Number(left.ahead)
        || left.distance - right.distance
        || navigationTextCompare(left.node.nodeId, right.node.nodeId))[0]?.node || null;
    if (!node) return { nodeId: null, exits: [] };
    const exitsByRoad = new Map();
    node.endpoints.forEach(endpoint => {
      if (endpoint.record.oneWay && endpoint.side !== "start") return;
      const tangent = navigationEndpointTangent(endpoint);
      if (!tangent) return;
      const exitHeading = Math.atan2(-tangent[0], -tangent[1]);
      const turnDeg = navigationRounded(normalizeSignedAngle(exitHeading - pose.heading) * 180 / Math.PI);
      const absoluteTurn = Math.abs(turnDeg);
      const direction = absoluteTurn <= definition.roadTopology.straightTurnLimitDeg + EPSILON
        ? "straight"
        : absoluteTurn >= definition.roadTopology.backTurnLimitDeg - EPSILON
          ? "back"
          : turnDeg > 0 ? "left" : "right";
      const exit = { roadId: endpoint.roadId, direction, turnDeg };
      const previous = exitsByRoad.get(endpoint.roadId);
      if (!previous || Math.abs(exit.turnDeg) < Math.abs(previous.turnDeg) - EPSILON
        || (Math.abs(exit.turnDeg - previous.turnDeg) <= EPSILON
          && navigationTextCompare(exit.direction, previous.direction) < 0)) {
        exitsByRoad.set(endpoint.roadId, exit);
      }
    });
    return {
      nodeId: node.nodeId,
      exits: [...exitsByRoad.values()].sort((left, right) => right.turnDeg - left.turnDeg
        || navigationTextCompare(left.roadId, right.roadId))
    };
  }

  function navigationFrontClearance(pose, world, vehicleRadius, rules = {}) {
    if (!world || typeof world !== "object" || Array.isArray(world)) return null;
    const normalizedWorld = normalizeSimulationWorld(world);
    const radius = Math.max(0, Number(vehicleRadius) || 0);
    const forwardX = -Math.sin(pose.heading);
    const forwardZ = -Math.cos(pose.heading);
    const hit = simulationClearanceHitAlongRay(
      normalizedWorld,
      radius,
      pose.x,
      pose.z,
      forwardX,
      forwardZ
    );
    const maximumDistance = navigationCmToWorld(500, rules);
    if (!Number.isFinite(hit.distance) || hit.distance > maximumDistance + EPSILON) return null;
    return navigationRounded(navigationWorldToCm(clamp(hit.distance, 0, maximumDistance), rules));
  }

  function roadCandidateForHeading(match, heading) {
    let tangent = Array.isArray(match?.tangent) ? [...match.tangent] : [0, 0];
    const tangentLength = Math.hypot(tangent[0], tangent[1]);
    if (tangentLength <= EPSILON) {
      return { match, tangent: [0, 0], headingError: Infinity };
    }
    tangent = [tangent[0] / tangentLength, tangent[1] / tangentLength];
    const vehicleForward = [-Math.sin(heading), -Math.cos(heading)];
    if (!match.road?.oneWay && tangent[0] * vehicleForward[0] + tangent[1] * vehicleForward[1] < 0) {
      tangent = [-tangent[0], -tangent[1]];
    }
    const roadHeading = Math.atan2(-tangent[0], -tangent[1]);
    return {
      match,
      tangent,
      headingError: normalizeSignedAngle(roadHeading - heading)
    };
  }

  function navigationAnchorForPoint(id, point, topology, rules) {
    if (!Array.isArray(point) || point.length < 2 || !point.every(Number.isFinite)) {
      throw new TypeError(`navigation mission anchor ${id} requires a finite [x, z] point`);
    }
    const roads = Array.isArray(rules?.roads) ? rules.roads : [];
    const matches = roads.map(road => {
      const projected = distanceToPolyline(point, road?.points);
      return { road, ...projected };
    }).filter(candidate => candidate.road && Number.isFinite(candidate.distance))
      .sort((left, right) => left.distance - right.distance
        || navigationTextCompare(left.road.id || "", right.road.id || ""));
    const selected = matches[0];
    const record = selected && topology.recordsById.get(String(selected.road.id || ""));
    if (!selected || !record) throw new Error(`navigation mission anchor ${id} cannot resolve a road`);
    const segmentIndex = Math.max(0, selected.segmentIndex);
    const segmentLength = record.segmentLengths[segmentIndex] || 0;
    const progress = (record.cumulativeLengths[segmentIndex] || 0) + clamp(selected.t, 0, 1) * segmentLength;
    return {
      id: String(id),
      roadId: record.roadId,
      progressCm: navigationRounded(navigationWorldToCm(progress, rules))
    };
  }

  function projectNavigationMission(state, navigationDefinition, topology) {
    if (!navigationSupportsMissionQueries(navigationDefinition)) {
      throw new TypeError("mission query requires the navigation v3 contract");
    }
    const task = state.taskDefinition;
    const simulation = state.simulationDefinition;
    const mapId = String(state.mapId || "").trim();
    const mapVersion = String(state.mapVersion || "").trim();
    if (!task || typeof task !== "object" || !simulation?.initialPose || !mapId || !mapVersion) {
      throw new Error("navigation mission query requires the frozen task, simulation, map id and map version");
    }
    const checkpoints = Array.isArray(task.checkpoints) ? task.checkpoints : [];
    const targetDelivery = (Array.isArray(task.deliveries) ? task.deliveries : []).find(delivery => (
      delivery?.objectRole === "target" && delivery?.destinationRole === "storage"
        && Array.isArray(delivery.destination)
    ));
    if (!checkpoints.length || !targetDelivery || !Array.isArray(task.goal)) {
      throw new Error("navigation mission query requires composite checkpoints, storage and return definitions");
    }
    const mission = {
      schemaVersion: NAVIGATION_MISSION_SCHEMA_VERSION,
      mapId,
      mapVersion,
      start: navigationAnchorForPoint("start", [simulation.initialPose.x, simulation.initialPose.z], topology, state.rules),
      storage: navigationAnchorForPoint("storage", targetDelivery.destination, topology, state.rules),
      checkpoints: checkpoints.map((checkpoint, index) => {
        if (!checkpoint || typeof checkpoint !== "object" || !Array.isArray(checkpoint.position)) {
          throw new Error(`navigation mission checkpoint ${index + 1} is invalid`);
        }
        return navigationAnchorForPoint(String(checkpoint.id || `checkpoint-${index + 1}`), checkpoint.position,
          topology, state.rules);
      }),
      return: navigationAnchorForPoint("return", task.goal, topology, state.rules)
    };
    if (navigationDefinition.schemaVersion === PREVIOUS_CURRENT_NAVIGATION_DEFINITION_SCHEMA_VERSION
      || navigationDefinition.schemaVersion === NAVIGATION_DEFINITION_SCHEMA_VERSION) {
      const packages = Array.isArray(state.interactionDefinition?.packages)
        ? state.interactionDefinition.packages : [];
      mission.objects = navigationDefinition.objectAnchorDisclosure === "road-anchor"
        ? packages.filter(item => ["target", "distractor", "obstacle"].includes(item?.role)
          && Number.isFinite(Number(item?.x)) && Number.isFinite(Number(item?.z)))
          .map(item => {
            const anchor = navigationAnchorForPoint(item.role, [Number(item.x), Number(item.z)], topology, state.rules);
            return { role: String(item.role), roadId: anchor.roadId, progressCm: anchor.progressCm };
          }).sort((left, right) => navigationTextCompare(left.role, right.role))
        : [];
    }
    return mission;
  }

  function projectTaskState(state, navigationDefinition) {
    if (!navigationSupportsMissionQueries(navigationDefinition)) {
      throw new TypeError("task_state query requires the navigation v3 contract");
    }
    const snapshot = state.taskSnapshot;
    const task = state.taskDefinition;
    const tick = Number(state.tick);
    if (!snapshot || typeof snapshot !== "object" || !task || typeof task !== "object"
      || !Number.isSafeInteger(tick) || tick < 0) {
      throw new Error("task_state query requires a frozen task snapshot and tick");
    }
    const deliveryByRole = new Map((Array.isArray(snapshot.deliveryProgress) ? snapshot.deliveryProgress : [])
      .map(delivery => [delivery?.objectRole, delivery]));
    const target = deliveryByRole.get("target");
    const distractor = deliveryByRole.get("distractor");
    const avoidance = snapshot.avoidanceProgress || {};
    const failedAvoidance = Array.isArray(avoidance.failedObjectIds) && avoidance.failedObjectIds.length > 0;
    const checkpoints = Array.isArray(task.checkpoints) ? task.checkpoints : [];
    const index = Number.isSafeInteger(snapshot.nextCheckpointIndex) ? snapshot.nextCheckpointIndex : 0;
    const next = index >= 0 && index < checkpoints.length ? checkpoints[index] : null;
    const completed = Number(snapshot.completed);
    const total = Number(snapshot.total);
    if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || completed < 0 || total < completed) {
      throw new Error("task_state query received an invalid task snapshot");
    }
    return {
      schemaVersion: TASK_STATE_SCHEMA_VERSION,
      completed,
      total,
      status: snapshot.finished ? "completed" : "running",
      nextCheckpointId: next ? String(next.id) : null,
      targetDelivered: Boolean(target?.finished),
      distractorCleared: Boolean(distractor?.finished),
      avoidanceStatus: failedAvoidance ? "failed" : avoidance.finished ? "completed" : "pending",
      goalReached: Boolean(snapshot.goalReached),
      tick
    };
  }

  function projectReleasePreview(state, navigationDefinition) {
    if (!navigationSupportsReleasePreview(navigationDefinition)) {
      throw new TypeError("release_preview query requires the navigation v4 contract");
    }
    const tick = Number(state.tick);
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new TypeError("release_preview query requires a non-negative tick");
    }
    if (!state.interactionDefinition || !state.simulationDefinition || !state.packageSnapshot) {
      throw new Error("release_preview query requires frozen interaction, simulation and package state");
    }
    const pose = normalizeNavigationPose(state.pose, "release_preview pose");
    const engine = new PackageStateEngine(state.interactionDefinition, state.simulationDefinition);
    engine.restore(state.packageSnapshot);
    const preview = engine.previewRelease({}, pose);
    const delivery = preview.packageId && Array.isArray(state.taskDefinition?.deliveries)
      ? state.taskDefinition.deliveries.find(candidate => (
        Array.isArray(candidate?.requiredPackageIds) && candidate.requiredPackageIds.includes(preview.packageId)
      )) || null
      : null;
    let roadClearanceCm = null;
    let requiredRoadClearanceCm = null;
    let wouldCompleteDelivery = false;
    if (preview.accepted && delivery?.placementRule === "road-edge-clearance") {
      const clearance = roadBoundaryClearance(preview.position, state.taskDefinition?.placementGeometry?.roads,
        delivery.objectRadius).clearance;
      roadClearanceCm = navigationRounded(navigationWorldToCm(clearance, state.rules));
      requiredRoadClearanceCm = navigationRounded(
        navigationWorldToCm(delivery.minimumRoadEdgeClearance, state.rules)
      );
      wouldCompleteDelivery = clearance + EPSILON >= delivery.minimumRoadEdgeClearance;
    } else if (preview.accepted && delivery && Array.isArray(delivery.destination)) {
      wouldCompleteDelivery = Math.hypot(preview.position[0] - delivery.destination[0],
        preview.position[1] - delivery.destination[1]) <= delivery.radius + EPSILON;
    }
    return {
      schemaVersion: RELEASE_PREVIEW_SCHEMA_VERSION,
      holding: preview.objectRole || null,
      releaseAccepted: Boolean(preview.accepted),
      releaseReason: preview.accepted ? "ready" : String(preview.reason || "rejected"),
      wouldCompleteDelivery,
      roadClearanceCm,
      requiredRoadClearanceCm,
      tick
    };
  }

  function projectNavigationQuery(method, state = {}) {
    const normalizedMethod = String(method || "").trim();
    const navigationDefinition = normalizeNavigationDefinition(state.navigationDefinition || NAVIGATION_DEFINITION);
    if (!Object.prototype.hasOwnProperty.call(navigationDefinition.methods, normalizedMethod)) {
      throw new TypeError(`unsupported navigation query: ${normalizedMethod || "missing"}`);
    }
    const rules = state.rules && typeof state.rules === "object" ? state.rules : {};
    if (normalizedMethod === "map_graph") {
      const topology = resolveNavigationTopology(state, rules, navigationDefinition);
      return clone(topology.graph);
    }
    if (normalizedMethod === "mission") {
      const topology = resolveNavigationTopology(state, rules, navigationDefinition);
      return projectNavigationMission({ ...state, rules }, navigationDefinition, topology);
    }
    if (normalizedMethod === "task_state") {
      return projectTaskState(state, navigationDefinition);
    }
    if (normalizedMethod === "release_preview") {
      return projectReleasePreview(state, navigationDefinition);
    }
    const pose = normalizeNavigationPose(state.pose, "navigation pose");
    const initialPose = normalizeNavigationPose(state.initialPose, "navigation initialPose");
    const tick = Number(state.tick);
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new TypeError("navigation tick must be a non-negative safe integer");
    }
    if (normalizedMethod === "odometry") {
      const distance = Number(state.distance || 0);
      if (!Number.isFinite(distance) || distance < 0) {
        throw new TypeError("navigation distance must be a non-negative finite number");
      }
      const dx = pose.x - initialPose.x;
      const dz = pose.z - initialPose.z;
      const initialForward = [-Math.sin(initialPose.heading), -Math.cos(initialPose.heading)];
      const initialRight = [Math.cos(initialPose.heading), -Math.sin(initialPose.heading)];
      return {
        forwardCm: navigationRounded(navigationWorldToCm(
          dx * initialForward[0] + dz * initialForward[1], rules
        )),
        rightCm: navigationRounded(navigationWorldToCm(
          dx * initialRight[0] + dz * initialRight[1], rules
        )),
        headingDeg: navigationRounded(normalizeSignedAngle(pose.heading - initialPose.heading) * 180 / Math.PI),
        distanceCm: navigationRounded(navigationWorldToCm(distance, rules)),
        tick
      };
    }

    const roads = Array.isArray(rules.roads) ? rules.roads : [];
    if (!roads.length) throw new Error("navigation road_state requires a drivable road network");
    const vehicleRadius = Math.max(0, Number(rules.vehicleRadius) || 0);
    const nearest = nearestRoad([pose.x, pose.z], roads, vehicleRadius);
    if (!nearest.road || !Number.isFinite(nearest.distance)) {
      throw new Error("navigation road_state could not resolve the nearest road");
    }
    const matches = (nearest.onRoad ? nearest.onRoadMatches : [nearest])
      .map(match => roadCandidateForHeading(match, pose.heading))
      .sort((left, right) => Math.abs(left.headingError) - Math.abs(right.headingError)
        || left.match.distance - right.match.distance
        || navigationTextCompare(left.match.road?.id || "", right.match.road?.id || ""));
    const selected = matches[0];
    const roadIds = nearest.onRoad
      ? [...new Set(matches.map(candidate => String(candidate.match.road?.id || "")).filter(Boolean))]
      : [];
    const closest = selected.match.point || [pose.x, pose.z];
    const rightNormal = [-selected.tangent[1], selected.tangent[0]];
    const lateralOffset = (pose.x - closest[0]) * rightNormal[0] + (pose.z - closest[1]) * rightNormal[1];
    const centerClearance = Math.max(0, Number(selected.match.clearance) || 0);
    const hasTopology = navigationSupportsRoadTopology(navigationDefinition);
    const v3 = navigationSupportsMissionQueries(navigationDefinition);
    const junction = hasTopology && nearest.onRoad
      ? navigationJunctionProjection(
          resolveNavigationTopology(state, rules, navigationDefinition),
          String(selected.match.road?.id || ""),
          pose,
          navigationDefinition,
          rules
        )
      : { junctionId: null, exits: [] };
    const topology = hasTopology && nearest.onRoad
      ? resolveNavigationTopology(state, rules, navigationDefinition)
      : null;
    const record = topology?.recordsById.get(String(selected.match.road?.id || "")) || null;
    const edge = record ? topology.graph.edges.find(item => item.roadId === record.roadId) : null;
    const roadProjection = record ? navigationRoadProjection(record, pose) : null;
    const node = v3 && topology && record
      ? navigationNodeProjection(topology, record.roadId, pose, navigationDefinition, rules)
      : { nodeId: null, exits: [] };
    const frontClearanceCm = hasTopology
      ? navigationFrontClearance(pose, state.world, state.vehicleRadius ?? vehicleRadius, rules)
      : null;
    return {
      onRoad: Boolean(nearest.onRoad),
      roadId: String(selected.match.road?.id || "") || null,
      roadIds,
      lateralOffsetCm: navigationRounded(navigationWorldToCm(lateralOffset, rules)),
      headingErrorDeg: Number.isFinite(selected.headingError)
        ? navigationRounded(selected.headingError * 180 / Math.PI)
        : null,
      leftClearanceCm: navigationRounded(navigationWorldToCm(centerClearance + lateralOffset, rules)),
      rightClearanceCm: navigationRounded(navigationWorldToCm(centerClearance - lateralOffset, rules)),
      ...(hasTopology ? { frontClearanceCm } : {}),
      atJunction: hasTopology ? Boolean(junction.junctionId) : Boolean(nearest.onRoad && roadIds.length > 1),
      ...(hasTopology ? { junctionId: junction.junctionId, exits: v3 ? node.exits : junction.exits } : {}),
      ...(v3 ? {
        roadProgressCm: roadProjection
          ? navigationRounded(navigationWorldToCm(roadProjection.progress, rules)) : null,
        fromNodeId: edge?.fromNodeId || null,
        toNodeId: edge?.toNodeId || null,
        atNode: Boolean(node.nodeId),
        nodeId: node.nodeId
      } : {}),
      tick
    };
  }

  function makeId(prefix = "run") {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}-${crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function pointInPolygon(point, polygon) {
    if (!Array.isArray(point) || !Array.isArray(polygon) || polygon.length < 3) return false;
    const x = Number(point[0]);
    const z = Number(point[1]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = Number(polygon[i][0]);
      const zi = Number(polygon[i][1]);
      const xj = Number(polygon[j][0]);
      const zj = Number(polygon[j][1]);
      const edge = closestPointOnSegment([x, z], [xi, zi], [xj, zj]);
      if (edge.distance <= EPSILON) return true;
      const intersects = (zi > z) !== (zj > z)
        && x < ((xj - xi) * (z - zi)) / ((zj - zi) || EPSILON) + xi;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function closestPointOnSegment(point, start, end) {
    const px = Number(point[0]);
    const pz = Number(point[1]);
    const ax = Number(start[0]);
    const az = Number(start[1]);
    const bx = Number(end[0]);
    const bz = Number(end[1]);
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared <= EPSILON
      ? 0
      : clamp(((px - ax) * dx + (pz - az) * dz) / lengthSquared, 0, 1);
    const x = ax + dx * t;
    const z = az + dz * t;
    return {
      point: [x, z],
      distance: Math.hypot(px - x, pz - z),
      t,
      tangent: lengthSquared <= EPSILON ? [0, 0] : [dx / Math.sqrt(lengthSquared), dz / Math.sqrt(lengthSquared)]
    };
  }

  function distanceToPolyline(point, points) {
    if (!Array.isArray(points) || points.length < 2) {
      return { distance: Infinity, segmentIndex: -1, point: null, tangent: [0, 0] };
    }
    let nearest = { distance: Infinity, segmentIndex: -1, point: null, tangent: [0, 0] };
    for (let index = 0; index < points.length - 1; index += 1) {
      const candidate = closestPointOnSegment(point, points[index], points[index + 1]);
      if (candidate.distance < nearest.distance) nearest = { ...candidate, segmentIndex: index };
    }
    return nearest;
  }

  function nearestRoad(point, roads, vehicleRadius = 0) {
    const candidates = [];
    for (const road of Array.isArray(roads) ? roads : []) {
      const candidate = distanceToPolyline(point, road.points);
      const width = Math.max(0, Number(road.width) || 0);
      const clearance = width / 2 - Math.max(0, Number(vehicleRadius) || 0);
      const result = {
        road,
        ...candidate,
        clearance,
        onRoad: candidate.distance <= clearance + EPSILON
      };
      candidates.push(result);
    }
    candidates.sort((left, right) => left.distance - right.distance);
    const onRoadMatches = candidates.filter(candidate => candidate.onRoad);
    const nearest = onRoadMatches[0] || candidates[0];
    return nearest
      ? { ...nearest, onRoadMatches }
      : { road: null, distance: Infinity, clearance: 0, onRoad: false, tangent: [0, 0], segmentIndex: -1, onRoadMatches: [] };
  }

  // Uses exactly the same road and circular speed-zone semantics as RuleJudge.
  // It stays internal to the local controller: students opt in to safe following,
  // but continue to choose every route, distance and exit themselves.
  function navigationSpeedLimitAt(point, rules = {}, vehicleRadius = 0) {
    const roads = Array.isArray(rules?.roads) ? rules.roads : [];
    const match = nearestRoad(point, roads, vehicleRadius);
    const limits = [];
    for (const candidate of match.onRoadMatches || []) {
      if (Number.isFinite(Number(candidate.road?.speedLimit))) limits.push(Number(candidate.road.speedLimit));
    }
    for (const zone of Array.isArray(rules?.speedZones) ? rules.speedZones : []) {
      if (zoneContains(zone, point) && Number.isFinite(Number(zone.speedLimit))) {
        limits.push(Number(zone.speedLimit));
      }
    }
    return limits.length ? Math.min(...limits) : Infinity;
  }

  function roadBoundaryClearance(point, roads, objectRadius = 0) {
    const radius = Math.max(0, Number(objectRadius) || 0);
    const candidates = [];
    for (const road of Array.isArray(roads) ? roads : []) {
      const candidate = distanceToPolyline(point, road.points);
      const halfWidth = Math.max(0, Number(road.width) || 0) / 2;
      candidates.push({
        road,
        ...candidate,
        halfWidth,
        objectRadius: radius,
        clearance: candidate.distance - halfWidth - radius
      });
    }
    candidates.sort((left, right) => left.clearance - right.clearance
      || left.distance - right.distance
      || String(left.road?.id || "").localeCompare(String(right.road?.id || "")));
    const nearest = candidates[0];
    return nearest
      ? { ...nearest, outsideRoads: nearest.clearance > EPSILON }
      : {
          road: null,
          distance: Infinity,
          halfWidth: 0,
          objectRadius: radius,
          clearance: Infinity,
          outsideRoads: true,
          point: null,
          tangent: [0, 0],
          segmentIndex: -1
        };
  }

  function orientation(a, b, c) {
    return (Number(b[0]) - Number(a[0])) * (Number(c[1]) - Number(a[1]))
      - (Number(b[1]) - Number(a[1])) * (Number(c[0]) - Number(a[0]));
  }

  function segmentsIntersect(a, b, c, d) {
    const o1 = orientation(a, b, c);
    const o2 = orientation(a, b, d);
    const o3 = orientation(c, d, a);
    const o4 = orientation(c, d, b);
    if (Math.abs(o1) <= EPSILON && Math.abs(o2) <= EPSILON && Math.abs(o3) <= EPSILON && Math.abs(o4) <= EPSILON) {
      const overlap = (a0, a1, b0, b1) => Math.max(Math.min(a0, a1), Math.min(b0, b1)) <= Math.min(Math.max(a0, a1), Math.max(b0, b1)) + EPSILON;
      return overlap(a[0], b[0], c[0], d[0]) && overlap(a[1], b[1], c[1], d[1]);
    }
    return o1 * o2 <= EPSILON && o3 * o4 <= EPSILON;
  }

  function trafficLightState(light, elapsedMs) {
    const phase = light?.phase || {};
    const finitePhase = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const greenMs = Math.max(1, finitePhase(phase.greenMs, 7000));
    const yellowMs = Math.max(0, finitePhase(phase.yellowMs, 2000));
    const redMs = Math.max(1, finitePhase(phase.redMs, 7000));
    const cycle = greenMs + yellowMs + redMs;
    const offset = Number(phase.offsetMs) || 0;
    const position = ((Number(elapsedMs) + offset) % cycle + cycle) % cycle;
    if (position < greenMs) return "green";
    if (position < greenMs + yellowMs) return "yellow";
    return "red";
  }

  function normalizeVector(vector) {
    const x = Number(vector?.[0]) || 0;
    const z = Number(vector?.[1]) || 0;
    const length = Math.hypot(x, z);
    return length <= EPSILON ? [0, 0] : [x / length, z / length];
  }

  function movingAlongDirection(previous, current, direction) {
    const [dx, dz] = normalizeVector(direction);
    return (Number(current.x) - Number(previous.x)) * dx + (Number(current.z) - Number(previous.z)) * dz > EPSILON;
  }

  function zoneContains(zone, sample, margin = 0) {
    const safeMargin = Math.max(0, Number(margin) || 0);
    if (Array.isArray(zone?.polygon)) {
      const point = [sample.x, sample.z];
      if (pointInPolygon(point, zone.polygon)) return true;
      if (safeMargin <= 0) return false;
      return zone.polygon.some((vertex, index) => {
        const next = zone.polygon[(index + 1) % zone.polygon.length];
        return closestPointOnSegment(point, vertex, next).distance <= safeMargin + EPSILON;
      });
    }
    if (Array.isArray(zone?.center)) {
      return Math.hypot(sample.x - zone.center[0], sample.z - zone.center[1]) <= Math.max(0, Number(zone.radius) || 0) + safeMargin;
    }
    return false;
  }

  const DEFAULT_VIOLATION_MESSAGES = {
    off_road: "驶出可行驶道路",
    speeding: "超过当前区域限速",
    wrong_way: "在单向道路逆向行驶",
    red_light: "闯红灯",
    prohibited_zone: "进入禁止通行区域",
    collision: "发生碰撞",
    manual_control: "计时运行中发生人工操作"
  };

  class RuleEngine {
    constructor(config = {}) {
      this.config = config;
      this.activeConditions = new Set();
      this.conditionMetrics = new Map();
      this.lightCrossingStates = new Map();
    }

    reset() {
      this.activeConditions.clear();
      this.conditionMetrics.clear();
      this.lightCrossingStates.clear();
    }

    transitionViolation(type, condition, detail, violations, elapsedMs, severity = 0) {
      const nowMs = Math.max(0, Number(elapsedMs) || 0);
      const metric = this.conditionMetrics.get(type) || {
        episodes: 0,
        accumulatedMs: 0,
        activeSinceMs: null,
        lastObservedMs: nowMs,
        maxSeverity: 0
      };
      if (condition && !this.activeConditions.has(type)) {
        this.activeConditions.add(type);
        metric.episodes += 1;
        metric.activeSinceMs = nowMs;
        violations.push({ type, message: DEFAULT_VIOLATION_MESSAGES[type] || type, ...detail });
      } else if (!condition) {
        if (this.activeConditions.has(type) && metric.activeSinceMs !== null) {
          metric.accumulatedMs += Math.max(0, nowMs - metric.activeSinceMs);
        }
        this.activeConditions.delete(type);
        metric.activeSinceMs = null;
      }
      if (condition) metric.maxSeverity = Math.max(metric.maxSeverity, Math.max(0, Number(severity) || 0));
      metric.lastObservedMs = nowMs;
      this.conditionMetrics.set(type, metric);
    }

    metrics(elapsedMs) {
      const nowMs = Math.max(0, Number(elapsedMs) || 0);
      const result = {};
      this.conditionMetrics.forEach((metric, type) => {
        const activeMs = metric.activeSinceMs === null ? 0 : Math.max(0, nowMs - metric.activeSinceMs);
        result[type] = {
          episodes: metric.episodes,
          durationMs: Math.round(metric.accumulatedMs + activeMs),
          maxSeverity: round(metric.maxSeverity)
        };
      });
      return result;
    }

    evaluate(sample, previous, elapsedMs) {
      const violations = [];
      const nowMs = Math.max(0, Number(elapsedMs) || 0);
      const vehicleRadius = Math.max(0, Number(this.config.vehicleRadius) || 0);
      const roadMatch = nearestRoad([sample.x, sample.z], this.config.roads, vehicleRadius);
      this.transitionViolation("off_road", !roadMatch.onRoad, {
        roadId: roadMatch.road?.id || null,
        distanceFromCenter: round(roadMatch.distance),
        allowedDistance: round(roadMatch.clearance)
      }, violations, nowMs, Math.max(0, roadMatch.distance - roadMatch.clearance));

      const applicableSpeedLimits = [];
      for (const match of roadMatch.onRoadMatches || []) {
        if (Number.isFinite(Number(match.road?.speedLimit))) applicableSpeedLimits.push(Number(match.road.speedLimit));
      }
      for (const zone of this.config.speedZones || []) {
        if (zoneContains(zone, sample) && Number.isFinite(Number(zone.speedLimit))) applicableSpeedLimits.push(Number(zone.speedLimit));
      }
      const speedLimit = applicableSpeedLimits.length ? Math.min(...applicableSpeedLimits) : Infinity;
      if (this.config.speedingEnabled !== false) {
        const speeding = Number(sample.speed) > speedLimit + (Number(this.config.speedTolerance) || 0.03);
        this.transitionViolation("speeding", speeding, {
          roadId: roadMatch.road?.id || null,
          speed: round(sample.speed),
          speedLimit: Number.isFinite(speedLimit) ? round(speedLimit) : null
        }, violations, nowMs, Number.isFinite(speedLimit) ? Math.max(0, Number(sample.speed) - speedLimit) : 0);
      }

      if (this.config.wrongWayEnabled !== false) {
        const tangent = roadMatch.tangent || [0, 0];
        const headingVector = [-Math.sin(Number(sample.heading) || 0), -Math.cos(Number(sample.heading) || 0)];
        const movementVector = previous
          ? normalizeVector([sample.x - previous.x, sample.z - previous.z])
          : [0, 0];
        const hasMovementVector = Math.hypot(movementVector[0], movementVector[1]) > EPSILON;
        const travelVector = hasMovementVector ? movementVector : headingVector;
        const directionDot = tangent[0] * travelVector[0] + tangent[1] * travelVector[1];
        const unambiguousRoad = (roadMatch.onRoadMatches || []).length === 1;
        const wrongWay = Boolean(unambiguousRoad && roadMatch.road?.oneWay && Number(sample.speed) > 0.05 && directionDot < -0.35);
        this.transitionViolation("wrong_way", wrongWay, {
          roadId: roadMatch.road?.id || null,
          directionDot: round(directionDot)
        }, violations, nowMs, Math.max(0, -directionDot));
      }

      if (this.config.prohibitedZonesEnabled !== false) {
        const prohibitedZone = (this.config.prohibitedZones || []).find(zone => zoneContains(zone, sample, vehicleRadius));
        this.transitionViolation("prohibited_zone", Boolean(prohibitedZone), {
          zoneId: prohibitedZone?.id || null
        }, violations, nowMs, prohibitedZone ? 1 : 0);
      }

      for (const light of this.config.redLightEnabled === false ? [] : (this.config.trafficLights || [])) {
        if (!Array.isArray(light.stopLine) || light.stopLine.length !== 2) continue;
        const key = String(light.id || "unknown");
        const direction = normalizeVector(light.direction || [1, 0]);
        if (Math.hypot(direction[0], direction[1]) <= EPSILON) continue;
        const midpoint = [
          (Number(light.stopLine[0][0]) + Number(light.stopLine[1][0])) / 2,
          (Number(light.stopLine[0][1]) + Number(light.stopLine[1][1])) / 2
        ];
        const signedSide = point => (Number(point.x) - midpoint[0]) * direction[0]
          + (Number(point.z) - midpoint[1]) * direction[1];
        const currentSide = signedSide(sample);
        let anchor = this.lightCrossingStates.get(key) || null;
        if (!anchor && previous) {
          anchor = {
            point: [Number(previous.x), Number(previous.z)],
            side: signedSide(previous),
            elapsedMs: Number.isFinite(Number(previous.elapsedMs)) ? Number(previous.elapsedMs) : nowMs,
            lineContactMs: null
          };
        }
        if (currentSide < -EPSILON) {
          this.lightCrossingStates.set(key, {
            point: [Number(sample.x), Number(sample.z)],
            side: currentSide,
            elapsedMs: nowMs,
            lineContactMs: null
          });
          continue;
        }
        if (Math.abs(currentSide) <= EPSILON) {
          if (anchor?.side < -EPSILON) {
            this.lightCrossingStates.set(key, { ...anchor, lineContactMs: nowMs });
          } else {
            this.lightCrossingStates.set(key, {
              point: [Number(sample.x), Number(sample.z)],
              side: 0,
              elapsedMs: nowMs,
              lineContactMs: nowMs
            });
          }
          continue;
        }
        if (anchor?.side < -EPSILON) {
          const currentPoint = [Number(sample.x), Number(sample.z)];
          const crossedFiniteLine = segmentsIntersect(anchor.point, currentPoint, light.stopLine[0], light.stopLine[1]);
          if (crossedFiniteLine) {
            const denominator = currentSide - anchor.side;
            const ratio = denominator > EPSILON ? clamp(-anchor.side / denominator, 0, 1) : 1;
            const crossingMs = Number.isFinite(anchor.lineContactMs)
              ? anchor.lineContactMs
              : anchor.elapsedMs + (nowMs - anchor.elapsedMs) * ratio;
            const state = trafficLightState(light, crossingMs);
            if (state === "red") {
              violations.push({
                type: "red_light",
                message: DEFAULT_VIOLATION_MESSAGES.red_light,
                lightId: light.id,
                state,
                crossingMs: Math.round(crossingMs)
              });
            }
          }
        }
        this.lightCrossingStates.set(key, {
          point: [Number(sample.x), Number(sample.z)],
          side: currentSide,
          elapsedMs: nowMs,
          lineContactMs: null
        });
      }

      return { violations, roadMatch, speedLimit, metrics: this.metrics(nowMs) };
    }
  }

  function finiteTaskPoint(value, label) {
    if (!Array.isArray(value) || value.length < 2) throw new TypeError(`${label} must be a finite [x, z] point`);
    const x = value[0];
    const z = value[1];
    if (typeof x !== "number" || typeof z !== "number" || !Number.isFinite(x) || !Number.isFinite(z)) {
      throw new TypeError(`${label} must be a finite [x, z] point`);
    }
    return [x, z];
  }

  function positiveTaskRadius(value, fallback, label) {
    if (value === undefined || value === null) return fallback;
    const radius = Number(value);
    if (!Number.isFinite(radius) || radius <= 0) throw new TypeError(`${label} must be a positive finite number`);
    return radius;
  }

  function strictPositiveTaskNumber(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${label} must be a positive finite number`);
    }
    if (value > MAX_SIMULATION_COORDINATE) {
      throw new RangeError(`${label} exceeds the supported coordinate range`);
    }
    return value;
  }

  function normalizeRoadPlacementGeometry(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("task v5 placementGeometry must be an object");
    }
    if (!Array.isArray(value.roads) || !value.roads.length) {
      throw new TypeError("task v5 placementGeometry requires roads");
    }
    if (value.roads.length > MAX_NAVIGATION_ROADS) {
      throw new RangeError(`task v5 placementGeometry exceeds the ${MAX_NAVIGATION_ROADS} road limit`);
    }
    const roadIds = new Set();
    let pointCount = 0;
    const roads = value.roads.map((source, roadIndex) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw new TypeError(`task v5 placement road ${roadIndex} must be an object`);
      }
      const id = typeof source.id === "string" ? source.id.trim() : "";
      if (!id || id.length > 128 || roadIds.has(id)) {
        throw new TypeError(`task v5 placement road id must be non-empty and unique: ${id || "empty"}`);
      }
      roadIds.add(id);
      const width = strictPositiveTaskNumber(source.width, `task v5 placement road ${id}.width`);
      if (!Array.isArray(source.points) || source.points.length < 2) {
        throw new TypeError(`task v5 placement road ${id} requires at least two points`);
      }
      pointCount += source.points.length;
      if (pointCount > MAX_NAVIGATION_ROAD_POINTS) {
        throw new RangeError(`task v5 placementGeometry exceeds the ${MAX_NAVIGATION_ROAD_POINTS} point limit`);
      }
      const points = source.points.map((point, pointIndex) => {
        if (!Array.isArray(point) || point.length !== 2) {
          throw new TypeError(`task v5 placement road ${id} point ${pointIndex} must be a finite [x, z] point`);
        }
        const normalizedPoint = finiteTaskPoint(point, `task v5 placement road ${id} point ${pointIndex}`);
        if (normalizedPoint.some(coordinate => Math.abs(coordinate) > MAX_SIMULATION_COORDINATE)) {
          throw new RangeError(`task v5 placement road ${id} point ${pointIndex} exceeds the supported coordinate range`);
        }
        return normalizedPoint;
      });
      const length = points.slice(1).reduce((sum, point, index) => (
        sum + Math.hypot(point[0] - points[index][0], point[1] - points[index][1])
      ), 0);
      if (length <= EPSILON) throw new TypeError(`task v5 placement road ${id} must have positive length`);
      return { id, width, points };
    });
    return { roads };
  }

  function normalizeTaskConfig(config = {}) {
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new TypeError("task config must be an object");
    const supportedTypes = new Set(["checkpoints", "reach", "delivery", "practice", "composite"]);
    const type = String(config.type || "");
    if (!supportedTypes.has(type)) throw new TypeError(`unsupported task type: ${type || "missing"}`);
    const composite = type === "composite";
    const compositeSchemaVersion = composite
      ? String(config.schemaVersion || TASK_SCHEMA_VERSION)
      : LEGACY_TASK_SCHEMA_VERSION;
    if (composite && !COMPOSITE_TASK_SCHEMA_VERSIONS.has(compositeSchemaVersion)) {
      throw new TypeError(`composite task requires ${PREVIOUS_TASK_SCHEMA_VERSION}, ${TASK_SCHEMA_VERSION}, ${OFFROAD_TASK_SCHEMA_VERSION}, or ${ROAD_CLEARANCE_TASK_SCHEMA_VERSION}`);
    }
    const normalized = {
      schemaVersion: composite ? compositeSchemaVersion : LEGACY_TASK_SCHEMA_VERSION,
      id: String(config.id || "task"),
      version: String(config.version || "unversioned"),
      type,
      checkpointRadius: positiveTaskRadius(config.checkpointRadius, 0.78, "checkpointRadius"),
      goalRadius: positiveTaskRadius(config.goalRadius, 0.82, "goalRadius"),
      deliveryRadius: positiveTaskRadius(config.deliveryRadius, 0.95, "deliveryRadius"),
      checkpoints: [],
      goal: null,
      requiredPackageIds: []
    };
    if (config.goal !== undefined && config.goal !== null) normalized.goal = finiteTaskPoint(config.goal, "goal");
    if (type === "checkpoints" || composite) {
      if (!Array.isArray(config.checkpoints) || !config.checkpoints.length) {
        throw new TypeError(`${type} task requires at least one checkpoint`);
      }
      const ids = new Set();
      normalized.checkpoints = config.checkpoints.map((checkpoint, index) => {
        const record = Array.isArray(checkpoint) ? { position: checkpoint } : checkpoint;
        if (!record || typeof record !== "object") throw new TypeError(`checkpoint ${index} is invalid`);
        const id = String(record.id ?? `checkpoint-${index + 1}`).trim();
        if (!id || ids.has(id)) throw new TypeError(`checkpoint id must be unique: ${id || "empty"}`);
        ids.add(id);
        return {
          id,
          label: String(record.label ?? id),
          position: finiteTaskPoint(record.position, `checkpoint ${id}`)
        };
      });
      if (!normalized.goal) throw new TypeError(`${type} task requires a goal`);
    }
    if (type === "reach" && !normalized.goal) throw new TypeError("reach task requires a goal");
    if (type === "delivery") {
      if (!normalized.goal) throw new TypeError("delivery task requires a goal");
      if (!Array.isArray(config.requiredPackageIds) || !config.requiredPackageIds.length) {
        throw new TypeError("delivery task requires package ids");
      }
      const ids = config.requiredPackageIds.map(id => String(id).trim());
      if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new TypeError("package ids must be non-empty and unique");
      normalized.requiredPackageIds = ids;
    }
    if (composite) {
      if (!Array.isArray(config.deliveries) || !config.deliveries.length) {
        throw new TypeError("composite task requires delivery objectives");
      }
      if (config.deliveries.length > MAX_INTERACTION_PACKAGES) {
        throw new RangeError(`composite task exceeds the ${MAX_INTERACTION_PACKAGES} delivery objective limit`);
      }
      const deliveryIds = new Set();
      const packageIds = new Set();
      let packageCount = 0;
      normalized.deliveries = config.deliveries.map((source, index) => {
        if (!source || typeof source !== "object" || Array.isArray(source)) {
          throw new TypeError(`composite delivery ${index} must be an object`);
        }
        const objectRole = String(source.objectRole || "").trim();
        const destinationRoles = compositeSchemaVersion === OFFROAD_TASK_SCHEMA_VERSION
          || compositeSchemaVersion === ROAD_CLEARANCE_TASK_SCHEMA_VERSION
          ? OFFROAD_COMPOSITE_DESTINATION_BY_ROLE
          : LEGACY_COMPOSITE_DESTINATION_BY_ROLE;
        const expectedDestinationRole = destinationRoles[objectRole];
        if (!expectedDestinationRole) {
          throw new TypeError(`composite delivery ${index}.objectRole must be target or distractor`);
        }
        const destinationRole = String(source.destinationRole ?? expectedDestinationRole).trim();
        if (destinationRole !== expectedDestinationRole) {
          throw new TypeError(`composite ${objectRole} delivery destinationRole must be ${expectedDestinationRole}`);
        }
        const id = String(source.id ?? `${objectRole}-to-${destinationRole}-${index + 1}`).trim();
        if (!id || deliveryIds.has(id)) {
          throw new TypeError(`composite delivery id must be non-empty and unique: ${id || "empty"}`);
        }
        deliveryIds.add(id);
        if (!Array.isArray(source.requiredPackageIds) || !source.requiredPackageIds.length) {
          throw new TypeError(`composite delivery ${id} requires package ids`);
        }
        const requiredPackageIds = source.requiredPackageIds.map(value => String(value).trim());
        if (requiredPackageIds.some(value => !value)
          || new Set(requiredPackageIds).size !== requiredPackageIds.length) {
          throw new TypeError(`composite delivery ${id} package ids must be non-empty and unique`);
        }
        requiredPackageIds.forEach(packageId => {
          if (packageIds.has(packageId)) {
            throw new TypeError(`composite package id may belong to only one delivery: ${packageId}`);
          }
          packageIds.add(packageId);
        });
        packageCount += requiredPackageIds.length;
        if (packageCount > MAX_INTERACTION_PACKAGES) {
          throw new RangeError(`composite task exceeds the ${MAX_INTERACTION_PACKAGES} required package limit`);
        }
        const roadClearancePlacement = compositeSchemaVersion === ROAD_CLEARANCE_TASK_SCHEMA_VERSION
          && objectRole === "distractor";
        const delivery = roadClearancePlacement
          ? { id, objectRole, destinationRole, requiredPackageIds }
          : {
              id,
              objectRole,
              destinationRole,
              destination: finiteTaskPoint(source.destination, `composite delivery ${id}.destination`),
              radius: positiveTaskRadius(source.radius, normalized.deliveryRadius,
                `composite delivery ${id}.radius`),
              requiredPackageIds
            };
        if (compositeSchemaVersion === OFFROAD_TASK_SCHEMA_VERSION && objectRole === "distractor") {
          const placementRule = String(source.placementRule ?? "fixed-offroad-zone").trim();
          if (placementRule !== "fixed-offroad-zone") {
            throw new TypeError(`composite delivery ${id}.placementRule must be fixed-offroad-zone`);
          }
          if (source.objectRadius === undefined || source.objectRadius === null) {
            throw new TypeError(`composite delivery ${id}.objectRadius is required`);
          }
          if (source.minimumRoadEdgeClearance === undefined || source.minimumRoadEdgeClearance === null) {
            throw new TypeError(`composite delivery ${id}.minimumRoadEdgeClearance is required`);
          }
          const objectRadius = positiveTaskRadius(source.objectRadius, 0,
            `composite delivery ${id}.objectRadius`);
          const minimumRoadEdgeClearance = positiveTaskRadius(source.minimumRoadEdgeClearance, 0,
            `composite delivery ${id}.minimumRoadEdgeClearance`);
          if (minimumRoadEdgeClearance <= delivery.radius + objectRadius + EPSILON) {
            throw new RangeError(`composite delivery ${id} off-road clearance must exceed its zone radius plus object radius`);
          }
          delivery.placementRule = placementRule;
          delivery.objectRadius = objectRadius;
          delivery.minimumRoadEdgeClearance = minimumRoadEdgeClearance;
        }
        if (roadClearancePlacement) {
          const placementRule = typeof source.placementRule === "string" ? source.placementRule.trim() : "";
          if (placementRule !== "road-edge-clearance") {
            throw new TypeError(`composite delivery ${id}.placementRule must be road-edge-clearance`);
          }
          if (Object.prototype.hasOwnProperty.call(source, "destination")
            || Object.prototype.hasOwnProperty.call(source, "radius")) {
            throw new TypeError(`composite delivery ${id} road-edge-clearance must not define destination or radius`);
          }
          if (source.objectRadius === undefined || source.objectRadius === null) {
            throw new TypeError(`composite delivery ${id}.objectRadius is required`);
          }
          if (source.minimumRoadEdgeClearance === undefined || source.minimumRoadEdgeClearance === null) {
            throw new TypeError(`composite delivery ${id}.minimumRoadEdgeClearance is required`);
          }
          delivery.placementRule = placementRule;
          delivery.objectRadius = strictPositiveTaskNumber(source.objectRadius,
            `composite delivery ${id}.objectRadius`);
          delivery.minimumRoadEdgeClearance = strictPositiveTaskNumber(source.minimumRoadEdgeClearance,
            `composite delivery ${id}.minimumRoadEdgeClearance`);
        } else if (compositeSchemaVersion === ROAD_CLEARANCE_TASK_SCHEMA_VERSION
          && ["placementRule", "objectRadius", "minimumRoadEdgeClearance"]
            .some(field => Object.prototype.hasOwnProperty.call(source, field))) {
          throw new TypeError(`composite ${objectRole} delivery cannot define a road-edge-clearance placement rule`);
        }
        return delivery;
      });
      if (compositeSchemaVersion === ROAD_CLEARANCE_TASK_SCHEMA_VERSION
        && normalized.deliveries.some(delivery => delivery.placementRule === "road-edge-clearance")) {
        normalized.placementGeometry = normalizeRoadPlacementGeometry(config.placementGeometry);
      }
      if (AVOIDANCE_TASK_SCHEMA_VERSIONS.has(compositeSchemaVersion)) normalized.avoidanceObjectIds = [];
      if (config.avoidanceObjectIds !== undefined) {
        if (!AVOIDANCE_TASK_SCHEMA_VERSIONS.has(compositeSchemaVersion)) {
          throw new TypeError(`composite avoidanceObjectIds requires ${TASK_SCHEMA_VERSION}, ${OFFROAD_TASK_SCHEMA_VERSION}, or ${ROAD_CLEARANCE_TASK_SCHEMA_VERSION}`);
        }
        if (!Array.isArray(config.avoidanceObjectIds)) {
          throw new TypeError("composite avoidanceObjectIds must be an array when provided");
        }
        const avoidanceObjectIds = config.avoidanceObjectIds.map(value => String(value).trim());
        if (avoidanceObjectIds.some(value => !value)
          || new Set(avoidanceObjectIds).size !== avoidanceObjectIds.length) {
          throw new TypeError("composite avoidanceObjectIds must be non-empty and unique");
        }
        if (avoidanceObjectIds.length > MAX_INTERACTION_PACKAGES) {
          throw new RangeError(`composite task exceeds the ${MAX_INTERACTION_PACKAGES} avoidance object limit`);
        }
        normalized.avoidanceObjectIds = avoidanceObjectIds;
      }
    }
    return normalized;
  }

  function validateFixedOffroadDeliveryGeometry(delivery, roads) {
    if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
      throw new TypeError("fixed off-road delivery must be an object");
    }
    if (delivery.objectRole !== "distractor"
      || delivery.destinationRole !== "offroad-removal"
      || delivery.placementRule !== "fixed-offroad-zone") {
      throw new TypeError("fixed off-road delivery must bind a distractor to offroad-removal");
    }
    if (!Array.isArray(roads) || !roads.length) {
      throw new TypeError("fixed off-road delivery validation requires roads");
    }
    for (const field of ["radius", "objectRadius", "minimumRoadEdgeClearance"]) {
      if (delivery[field] === undefined || delivery[field] === null) {
        throw new TypeError(`fixed off-road delivery ${field} is required`);
      }
    }
    const destination = finiteTaskPoint(delivery.destination, "fixed off-road delivery destination");
    const zoneRadius = positiveTaskRadius(delivery.radius, 0, "fixed off-road delivery radius");
    const objectRadius = positiveTaskRadius(delivery.objectRadius, 0, "fixed off-road delivery objectRadius");
    const declaredClearance = positiveTaskRadius(delivery.minimumRoadEdgeClearance, 0,
      "fixed off-road delivery minimumRoadEdgeClearance");
    const center = roadBoundaryClearance(destination, roads, 0);
    if (!center.road || !Number.isFinite(center.clearance)) {
      throw new TypeError("fixed off-road delivery roads must contain finite polylines");
    }
    if (center.clearance + EPSILON < declaredClearance) {
      throw new RangeError("fixed off-road destination does not meet its declared road-edge clearance");
    }
    const worstAcceptedPackageClearance = center.clearance - zoneRadius - objectRadius;
    if (worstAcceptedPackageClearance <= EPSILON) {
      throw new RangeError("fixed off-road destination zone can leave the distractor overlapping a road");
    }
    return {
      roadId: center.road.id || null,
      centerRoadEdgeClearance: round(center.clearance, 6),
      worstAcceptedPackageClearance: round(worstAcceptedPackageClearance, 6)
    };
  }

  function validateRoadClearancePlacementRules(taskDefinition, rules = {}) {
    if (taskDefinition?.schemaVersion !== ROAD_CLEARANCE_TASK_SCHEMA_VERSION
      || !taskDefinition?.deliveries?.some(delivery => delivery.placementRule === "road-edge-clearance")) {
      return true;
    }
    const placementGeometry = normalizeRoadPlacementGeometry(taskDefinition.placementGeometry);
    const ruleGeometry = normalizeRoadPlacementGeometry({ roads: rules?.roads });
    if (!exactJsonEqual(placementGeometry, ruleGeometry)) {
      throw new TypeError("task v5 placementGeometry roads must exactly match the competition rule roads");
    }
    return true;
  }

  function segmentCircleEntryT(start, end, center, radius, minimumT = 0) {
    const minT = clamp(minimumT, 0, 1);
    const dx = Number(end[0]) - Number(start[0]);
    const dz = Number(end[1]) - Number(start[1]);
    const sampleX = Number(start[0]) + dx * minT;
    const sampleZ = Number(start[1]) + dz * minT;
    const radiusSquared = radius * radius;
    if ((sampleX - center[0]) ** 2 + (sampleZ - center[1]) ** 2 <= radiusSquared + EPSILON) return minT;
    const a = dx * dx + dz * dz;
    if (a <= EPSILON) return null;
    const offsetX = Number(start[0]) - Number(center[0]);
    const offsetZ = Number(start[1]) - Number(center[1]);
    const b = 2 * (offsetX * dx + offsetZ * dz);
    const c = offsetX * offsetX + offsetZ * offsetZ - radiusSquared;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < -EPSILON) return null;
    const root = Math.sqrt(Math.max(0, discriminant));
    const candidates = [(-b - root) / (2 * a), (-b + root) / (2 * a)]
      .filter(value => value >= minT - EPSILON && value <= 1 + EPSILON)
      .sort((left, right) => left - right);
    return candidates.length ? clamp(candidates[0], minT, 1) : null;
  }

  class TaskEngine {
    constructor(config = {}) {
      this.config = deepFreeze(normalizeTaskConfig(config));
      this.reset();
    }

    reset() {
      this.previous = null;
      this.lastElapsedMs = null;
      this.nextCheckpointIndex = 0;
      this.goalReached = false;
      this.deliveredPackageIds = new Set();
      this.roadClearanceHandledPackageIds = new Set();
      this.failedAvoidanceObjectIds = new Set();
      this.finished = false;
      this.completedAtMs = null;
      this.eventLog = [];
      return this.snapshot();
    }

    totalUnits() {
      if (this.config.type === "checkpoints") return this.config.checkpoints.length + 1;
      if (this.config.type === "delivery") return this.config.requiredPackageIds.length;
      if (this.config.type === "composite") {
        return this.config.checkpoints.length + 1
          + this.config.deliveries.reduce((sum, delivery) => sum + delivery.requiredPackageIds.length, 0)
          + (this.config.avoidanceObjectIds || []).length;
      }
      if (this.config.type === "reach") return 1;
      return 0;
    }

    completedUnits() {
      if (this.config.type === "checkpoints") return this.nextCheckpointIndex + (this.goalReached ? 1 : 0);
      if (this.config.type === "delivery") return this.deliveredPackageIds.size;
      if (this.config.type === "composite") {
        const objectiveCompleted = this.nextCheckpointIndex + (this.goalReached ? 1 : 0) + this.deliveredPackageIds.size;
        const objectiveTotal = this.config.checkpoints.length + 1 + this.requiredPackageIds().length;
        const avoidanceCompleted = objectiveCompleted === objectiveTotal
          ? (this.config.avoidanceObjectIds || []).filter(id => !this.failedAvoidanceObjectIds.has(id)).length
          : 0;
        return objectiveCompleted + avoidanceCompleted;
      }
      if (this.config.type === "reach") return this.goalReached ? 1 : 0;
      return 0;
    }

    requiredPackageIds() {
      if (this.config.type === "delivery") return this.config.requiredPackageIds;
      if (this.config.type === "composite") {
        return this.config.deliveries.flatMap(delivery => delivery.requiredPackageIds);
      }
      return [];
    }

    deliveriesComplete() {
      const requiredIds = this.requiredPackageIds();
      return requiredIds.length > 0 && requiredIds.every(id => this.deliveredPackageIds.has(id));
    }

    noteCollision(colliderId) {
      const avoidanceObjectIds = this.config.type === "composite"
        ? (this.config.avoidanceObjectIds || [])
        : [];
      if (!avoidanceObjectIds.length) return false;
      const normalizedColliderId = String(colliderId || "").trim();
      if (!normalizedColliderId.startsWith("object:")) return false;
      const objectId = normalizedColliderId.slice("object:".length);
      if (!avoidanceObjectIds.includes(objectId)) return false;
      const before = this.failedAvoidanceObjectIds.size;
      this.failedAvoidanceObjectIds.add(objectId);
      return this.failedAvoidanceObjectIds.size !== before;
    }

    taskState() {
      return {
        completed: this.completedUnits(),
        total: this.totalUnits(),
        finished: this.finished
      };
    }

    snapshot() {
      return {
        type: this.config.type,
        ...this.taskState(),
        nextCheckpointIndex: this.nextCheckpointIndex,
        checkpointTotal: this.config.checkpoints.length,
        visitedCheckpointIds: this.config.checkpoints.slice(0, this.nextCheckpointIndex).map(checkpoint => checkpoint.id),
        goalReached: this.goalReached,
        deliveredPackageIds: [...this.deliveredPackageIds],
        ...(this.config.type === "composite" ? {
          avoidanceProgress: {
            requiredObjectIds: [...(this.config.avoidanceObjectIds || [])],
            failedObjectIds: [...this.failedAvoidanceObjectIds].sort(),
            completed: (this.config.avoidanceObjectIds || []).length && this.goalReached
              && this.nextCheckpointIndex === this.config.checkpoints.length
              && this.deliveriesComplete()
              ? (this.config.avoidanceObjectIds || []).filter(id => !this.failedAvoidanceObjectIds.has(id)).length
              : 0,
            total: (this.config.avoidanceObjectIds || []).length,
            finished: !(this.config.avoidanceObjectIds || []).length
              || (this.goalReached && this.nextCheckpointIndex === this.config.checkpoints.length
                && this.deliveriesComplete() && this.failedAvoidanceObjectIds.size === 0)
          },
          deliveryProgress: this.config.deliveries.map(delivery => {
            const deliveredPackageIds = delivery.requiredPackageIds
              .filter(packageId => this.deliveredPackageIds.has(packageId));
            return {
              id: delivery.id,
              objectRole: delivery.objectRole,
              destinationRole: delivery.destinationRole,
              deliveredPackageIds,
              completed: deliveredPackageIds.length,
              total: delivery.requiredPackageIds.length,
              finished: deliveredPackageIds.length === delivery.requiredPackageIds.length
            };
          })
        } : {}),
        completedAtMs: this.completedAtMs,
        status: this.finished ? "completed" : "running"
      };
    }

    definition() {
      return clone(this.config);
    }

    event(type, elapsedMs, detail = {}) {
      const event = {
        type: String(type),
        elapsedMs: round(elapsedMs, 3),
        ...clone(detail)
      };
      this.eventLog.push(event);
      return event;
    }

    elapsedAt(segmentStartMs, elapsedMs, ratio) {
      return segmentStartMs + (elapsedMs - segmentStartMs) * clamp(ratio, 0, 1);
    }

    evaluateDeliveries(current, deliveries, events, includeObjectiveDetail = false) {
      const nextDeliveredPackageIds = new Set();
      for (const delivery of deliveries) {
        for (const packageId of delivery.requiredPackageIds) {
          if (current.holding === packageId) {
            if (delivery.placementRule === "road-edge-clearance") {
              this.roadClearanceHandledPackageIds.add(packageId);
            }
            continue;
          }
          const record = current.packages.find(item => item.id === packageId);
          const delivered = delivery.placementRule === "road-edge-clearance"
            ? this.roadClearanceHandledPackageIds.has(packageId)
              && roadBoundaryClearance(
                  [record.x, record.z],
                  this.config.placementGeometry.roads,
                  delivery.objectRadius
                ).clearance + EPSILON >= delivery.minimumRoadEdgeClearance
            : Math.hypot(record.x - delivery.destination[0], record.z - delivery.destination[1])
              <= delivery.radius + EPSILON;
          if (delivered) nextDeliveredPackageIds.add(packageId);
        }
      }
      for (const delivery of deliveries) {
        for (const packageId of delivery.requiredPackageIds) {
          const wasDelivered = this.deliveredPackageIds.has(packageId);
          const isDelivered = nextDeliveredPackageIds.has(packageId);
          const detail = {
            packageId,
            ...(includeObjectiveDetail ? {
              deliveryId: delivery.id,
              objectRole: delivery.objectRole,
              destinationRole: delivery.destinationRole
            } : {})
          };
          if (isDelivered && !wasDelivered) {
            events.push(this.event("package_delivered", current.elapsedMs, detail));
          } else if (!isDelivered && wasDelivered) {
            events.push(this.event("package_delivery_revoked", current.elapsedMs, detail));
          }
        }
      }
      this.deliveredPackageIds = nextDeliveredPackageIds;
    }

    normalizeObservation(observation = {}, elapsedMs) {
      const x = observation.x;
      const z = observation.z;
      if (typeof x !== "number" || typeof z !== "number" || !Number.isFinite(x) || !Number.isFinite(z)) {
        throw new TypeError("task observation requires finite x and z");
      }
      const candidateElapsed = elapsedMs ?? observation.elapsedMs ?? this.lastElapsedMs ?? 0;
      const resolvedElapsedMs = candidateElapsed;
      if (typeof resolvedElapsedMs !== "number" || !Number.isFinite(resolvedElapsedMs) || resolvedElapsedMs < 0) {
        throw new TypeError("task observation elapsedMs must be finite and non-negative");
      }
      if (this.lastElapsedMs !== null && resolvedElapsedMs + EPSILON < this.lastElapsedMs) {
        throw new RangeError("task observation elapsedMs cannot move backwards");
      }
      const packages = Array.isArray(observation.packages)
        ? observation.packages.map((item, index) => {
            const id = typeof item?.id === "string" ? item.id.trim() : "";
            const packageX = item?.x;
            const packageZ = item?.z;
            if (!id || typeof packageX !== "number" || typeof packageZ !== "number"
              || !Number.isFinite(packageX) || !Number.isFinite(packageZ)) {
              throw new TypeError(`task package ${index} requires an id and finite x/z`);
            }
            return { id, x: packageX, z: packageZ };
          })
        : null;
      if (packages && new Set(packages.map(item => item.id)).size !== packages.length) {
        throw new TypeError("task package ids must be unique");
      }
      if (this.config.type === "delivery" || this.config.type === "composite") {
        if (!packages) throw new TypeError("delivery task observations require a complete packages snapshot");
        const packageIds = new Set(packages.map(item => item.id));
        if (this.requiredPackageIds().some(id => !packageIds.has(id))) {
          throw new TypeError("delivery task observations must contain every required package");
        }
      }
      const holding = observation.holding ?? observation.heldPackageId ?? null;
      if (holding !== null && (typeof holding !== "string" || !holding.trim())) {
        throw new TypeError("task observation holding must be a non-empty package id or null");
      }
      return {
        x,
        z,
        elapsedMs: resolvedElapsedMs,
        holding: holding === null ? null : holding.trim(),
        packages: packages || []
      };
    }

    evaluate(observation = {}, elapsedMs) {
      const current = this.normalizeObservation(observation, elapsedMs);
      if (this.finished) {
        this.previous = current;
        this.lastElapsedMs = current.elapsedMs;
        return { task: this.taskState(), state: this.snapshot(), events: [] };
      }
      const previous = this.previous || current;
      const start = [previous.x, previous.z];
      const end = [current.x, current.z];
      const segmentStartMs = Number(previous.elapsedMs);
      let minimumT = 0;
      const events = [];
      const deliveriesCompleteBefore = this.config.type === "composite" && this.deliveriesComplete();

      if (this.config.type === "checkpoints" || this.config.type === "composite") {
        while (this.nextCheckpointIndex < this.config.checkpoints.length) {
          const checkpoint = this.config.checkpoints[this.nextCheckpointIndex];
          const hitT = segmentCircleEntryT(start, end, checkpoint.position, this.config.checkpointRadius, minimumT);
          if (hitT === null) break;
          const checkpointIndex = this.nextCheckpointIndex;
          this.nextCheckpointIndex += 1;
          minimumT = hitT;
          events.push(this.event("checkpoint", this.elapsedAt(segmentStartMs, current.elapsedMs, hitT), {
            index: checkpointIndex,
            checkpointId: checkpoint.id,
            x: round(checkpoint.position[0], 6),
            z: round(checkpoint.position[1], 6)
          }));
        }
        if (this.config.type === "composite") {
          this.evaluateDeliveries(current, this.config.deliveries, events, true);
        }
        const deliveriesComplete = this.config.type !== "composite" || this.deliveriesComplete();
        if (this.nextCheckpointIndex === this.config.checkpoints.length && deliveriesComplete && !this.goalReached) {
          const deliveryGateT = this.config.type === "composite" && !deliveriesCompleteBefore ? 1 : 0;
          const hitT = segmentCircleEntryT(start, end, this.config.goal, this.config.goalRadius,
            Math.max(minimumT, deliveryGateT));
          if (hitT !== null) {
            this.goalReached = true;
            const reachedAtMs = this.elapsedAt(segmentStartMs, current.elapsedMs, hitT);
            events.push(this.event("goal_reached", reachedAtMs, {
              x: round(this.config.goal[0], 6),
              z: round(this.config.goal[1], 6)
            }));
          }
        }
      } else if (this.config.type === "reach" && !this.goalReached) {
        const hitT = segmentCircleEntryT(start, end, this.config.goal, this.config.goalRadius, 0);
        if (hitT !== null) {
          this.goalReached = true;
          events.push(this.event("goal_reached", this.elapsedAt(segmentStartMs, current.elapsedMs, hitT), {
            x: round(this.config.goal[0], 6),
            z: round(this.config.goal[1], 6)
          }));
        }
      } else if (this.config.type === "delivery") {
        this.evaluateDeliveries(current, [{
          destination: this.config.goal,
          radius: this.config.deliveryRadius,
          requiredPackageIds: this.config.requiredPackageIds
        }], events);
      }

      const total = this.totalUnits();
      if (total > 0 && this.completedUnits() === total) {
        this.finished = true;
        this.completedAtMs = events.length ? events[events.length - 1].elapsedMs : round(current.elapsedMs, 3);
        events.push(this.event("task_completed", this.completedAtMs, { completed: total, total }));
      }
      this.previous = current;
      this.lastElapsedMs = current.elapsedMs;
      return { task: this.taskState(), state: this.snapshot(), events: clone(events) };
    }

    replay(samples = []) {
      if (!Array.isArray(samples)) throw new TypeError("task replay samples must be an array");
      this.reset();
      for (const sample of samples) this.evaluate(sample, sample?.elapsedMs ?? sample?.t);
      return { state: this.snapshot(), events: clone(this.eventLog) };
    }

    static replay(config, samples = []) {
      return new TaskEngine(config).replay(samples);
    }
  }

  function resolveCompetitionTaskConfig(config = {}) {
    const explicit = config.task && typeof config.task === "object" && !Array.isArray(config.task)
      ? config.task
      : null;
    if (explicit?.type) {
      return {
        ...explicit,
        id: explicit.id ?? config.taskId,
        version: explicit.version ?? config.taskVersion ?? config.ruleVersion,
        checkpoints: explicit.checkpoints ?? config.checkpoints,
        goal: explicit.goal ?? config.goal
      };
    }
    if (Array.isArray(config.checkpoints) && config.checkpoints.length && Array.isArray(config.goal)) {
      return {
        id: config.taskId,
        version: config.taskVersion ?? config.ruleVersion,
        type: "checkpoints",
        checkpoints: config.checkpoints,
        goal: config.goal
      };
    }
    return null;
  }

  function rejudgeTask(taskConfig, recordOrSamples = []) {
    let definition = taskConfig;
    let source = recordOrSamples;
    if (arguments.length === 1 && taskConfig && typeof taskConfig === "object"
      && !Array.isArray(taskConfig) && Array.isArray(taskConfig.samples)) {
      source = taskConfig;
      definition = taskConfig.taskDefinition;
    }
    const isRecord = !Array.isArray(source) && source && typeof source === "object";
    const samples = isRecord ? source.samples : source;
    const diagnostics = [];
    let sourceSchemaVersion = null;
    let normalizedDefinition = null;
    try {
      normalizedDefinition = normalizeTaskConfig(definition);
    } catch (error) {
      if (!isRecord) throw error;
      diagnostics.push(`requested task definition is invalid: ${error.message}`);
    }

    if (isRecord) {
      sourceSchemaVersion = String(source.schemaVersion || "unknown");
      if (![SCHEMA_VERSION, DETERMINISTIC_LEGACY_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION].includes(sourceSchemaVersion)) {
        diagnostics.push("record schema is not a supported chenlong.run-record version");
      }
      if (!source.taskDefinition || typeof source.taskDefinition !== "object") {
        diagnostics.push("record is missing its normalized task definition");
      } else {
        try {
          const embeddedDefinition = normalizeTaskConfig(source.taskDefinition);
          if (normalizedDefinition && JSON.stringify(embeddedDefinition) !== JSON.stringify(normalizedDefinition)) {
            diagnostics.push("requested task definition does not match the record");
          }
        } catch (error) {
          diagnostics.push(`record task definition is invalid: ${error.message}`);
        }
      }
      if (!Array.isArray(source.samples)) diagnostics.push("record samples must be an array");
      if (!Array.isArray(source.events)) diagnostics.push("record events must be an array");
      if ([SCHEMA_VERSION, DETERMINISTIC_LEGACY_SCHEMA_VERSION].includes(sourceSchemaVersion)
        && !Array.isArray(source.inputs)) {
        diagnostics.push("deterministic record inputs must be an array");
      }
      const allowedSampleKeys = new Set([
        "seq", "t", "x", "z", "heading", "speed", "steering", "holding", "cameraFrameId", "tick", "simulationTick", "packages"
      ]);
      const timeline = [
        ...([SCHEMA_VERSION, DETERMINISTIC_LEGACY_SCHEMA_VERSION].includes(sourceSchemaVersion)
          && Array.isArray(source.inputs) ? source.inputs : []),
        ...(Array.isArray(source.samples) ? source.samples : []),
        ...(Array.isArray(source.events) ? source.events : [])
      ];
      const sequences = new Set();
      timeline.forEach((item, index) => {
        if (!Number.isSafeInteger(item?.seq) || item.seq <= 0) {
          diagnostics.push(`timeline item ${index} has no valid sequence number`);
        } else if (sequences.has(item.seq)) {
          diagnostics.push(`timeline sequence ${item.seq} is duplicated`);
        } else {
          sequences.add(item.seq);
        }
      });
      let previousT = -Infinity;
      let previousSeq = -Infinity;
      (Array.isArray(source.samples) ? source.samples : []).forEach((sample, index) => {
        const unknownKeys = Object.keys(sample || {}).filter(key => !allowedSampleKeys.has(key));
        if (unknownKeys.length) diagnostics.push(`sample ${index} has unsupported fields: ${unknownKeys.join(", ")}`);
        if (![sample?.t, sample?.x, sample?.z, sample?.heading, sample?.speed, sample?.steering].every(Number.isFinite)) {
          diagnostics.push(`sample ${index} has non-finite telemetry`);
        }
        if (sample?.holding !== null && sample?.holding !== undefined
          && (typeof sample.holding !== "string" || !sample.holding.trim())) {
          diagnostics.push(`sample ${index} has an invalid holding package id`);
        }
        if (Number(sample?.t) < previousT || Number(sample?.seq) <= previousSeq) {
          diagnostics.push(`sample ${index} is not in monotonic time/sequence order`);
        }
        previousT = Number(sample?.t);
        previousSeq = Number(sample?.seq);
      });
    }

    let replay = { state: null, events: [] };
    if (normalizedDefinition && Array.isArray(samples)) {
      try {
        replay = TaskEngine.replay(normalizedDefinition, samples);
      } catch (error) {
        if (!isRecord) throw error;
        diagnostics.push(`task replay failed: ${error.message}`);
      }
    }
    return {
      ...replay,
      authoritative: false,
      replayable: diagnostics.length === 0,
      sourceSchemaVersion,
      diagnostics
    };
  }

  class CompetitionJudge {
    constructor(config = {}) {
      this.config = {
        // Keep the historical default so old records that froze an empty
        // scoringDefinition still replay under their original /60 contract.
        // The current Guangyang challenge passes its explicit /100 weights.
        weights: { task: 25, rules: 15, autonomous: 10, efficiency: 10, ...(config.weights || {}) },
        penalties: {
          off_road: 1.5,
          speeding: 1,
          wrong_way: 2,
          red_light: 3,
          prohibited_zone: 3,
          collision: 1,
          ...(config.penalties || {})
        },
        continuousPenalties: {
          off_road: { perSecond: 0.25 },
          speeding: { perSecond: 0.1 },
          wrong_way: { perSecond: 0.2 },
          prohibited_zone: { perSecond: 0.3 },
          ...(config.continuousPenalties || {})
        },
        efficiency: { targetSeconds: 120, maxSeconds: 600, ...(config.efficiency || {}) },
        autonomous: { penaltyPerIntervention: 10, ...(config.autonomous || {}) }
      };
    }

    score({ task = {}, violations = [], violationMetrics = {}, durationSeconds = 0, manualInterventions = 0 } = {}) {
      const weights = this.config.weights;
      const rawTotal = Number(task.total);
      const rawCompleted = Number(task.completed);
      const taskValid = Number.isInteger(rawTotal) && rawTotal > 0
        && Number.isInteger(rawCompleted) && rawCompleted >= 0 && rawCompleted <= rawTotal;
      const totalTasks = taskValid ? rawTotal : 0;
      const completedTasks = taskValid ? rawCompleted : 0;
      const taskFinished = Boolean(task.finished) && taskValid && completedTasks === totalTasks;
      const completionRatio = taskValid ? completedTasks / totalTasks : 0;
      const taskScore = round(weights.task * clamp(completionRatio, 0, 1), 1);

      const eventDeduction = violations.reduce((sum, violation) => {
        return sum + Math.max(0, Number(this.config.penalties[violation.type]) || 0);
      }, 0);
      const durationDeduction = Object.entries(violationMetrics || {}).reduce((sum, [type, metric]) => {
        const rate = Math.max(0, Number(this.config.continuousPenalties[type]?.perSecond) || 0);
        return sum + Math.max(0, Number(metric?.durationMs) || 0) / 1000 * rate;
      }, 0);
      const ruleDeduction = round(eventDeduction + durationDeduction, 1);
      const ruleScore = taskValid ? round(Math.max(0, weights.rules - ruleDeduction), 1) : 0;

      const interventionPenalty = Math.max(0, Number(this.config.autonomous.penaltyPerIntervention) || 0);
      const autonomousScore = taskValid
        ? round(Math.max(0, weights.autonomous - Math.max(0, Number(manualInterventions) || 0) * interventionPenalty), 1)
        : 0;

      const targetSeconds = Math.max(0, Number(this.config.efficiency.targetSeconds) || 0);
      const maxSeconds = Math.max(targetSeconds + EPSILON, Number(this.config.efficiency.maxSeconds) || 600);
      const safeDurationSeconds = Math.max(0, Number(durationSeconds) || 0);
      let efficiencyScore = 0;
      if (taskFinished) {
        const ratio = safeDurationSeconds <= targetSeconds
          ? 1
          : clamp((maxSeconds - safeDurationSeconds) / (maxSeconds - targetSeconds), 0, 1);
        efficiencyScore = round(weights.efficiency * ratio, 1);
      }

      const score = round(clamp(taskScore + ruleScore + autonomousScore + efficiencyScore, 0,
        weights.task + weights.rules + weights.autonomous + weights.efficiency), 1);
      return {
        score,
        taskScore,
        ruleScore,
        autonomousScore,
        efficiencyScore,
        ruleDeduction,
        eventDeduction: round(eventDeduction, 1),
        durationDeduction: round(durationDeduction, 1),
        durationSeconds: round(safeDurationSeconds, 1),
        completedTasks,
        totalTasks,
        taskValid,
        taskFinished,
        violationMetrics: clone(violationMetrics),
        violations: clone(violations)
      };
    }
  }

  function finiteSimulationNumber(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`${label} must be a finite number`);
    }
    return value;
  }

  function positiveSimulationNumber(value, fallback, label) {
    const resolved = value === undefined || value === null ? fallback : finiteSimulationNumber(value, label);
    if (resolved <= 0) throw new TypeError(`${label} must be greater than zero`);
    return resolved;
  }

  function boundedSimulationNumber(value, label, maximum = MAX_SIMULATION_COORDINATE) {
    const resolved = finiteSimulationNumber(value, label);
    if (Math.abs(resolved) > maximum) throw new RangeError(`${label} exceeds the supported simulation range`);
    return resolved;
  }

  function boundedPositiveSimulationNumber(value, fallback, label, maximum = MAX_SIMULATION_COORDINATE) {
    const resolved = positiveSimulationNumber(value, fallback, label);
    if (resolved > maximum) throw new RangeError(`${label} exceeds the supported simulation range`);
    return resolved;
  }

  function normalizeSimulationHeading(value, label) {
    const heading = boundedSimulationNumber(value, label, 1000000);
    const fullTurn = Math.PI * 2;
    return ((heading + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI;
  }

  function normalizeSimulationPose(value = {}, label = "initialPose") {
    const source = Array.isArray(value)
      ? { x: value[0], z: value[1], heading: value[2] ?? 0 }
      : value;
    if (!source || typeof source !== "object") throw new TypeError(`${label} must be an object or [x, z, heading]`);
    return {
      x: boundedSimulationNumber(source.x, `${label}.x`),
      z: boundedSimulationNumber(source.z, `${label}.z`),
      heading: boundedSimulationNumber(source.heading ?? 0, `${label}.heading`, 1000000)
    };
  }

  function normalizeSimulationWorld(value = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("simulation world must be an object");
    }
    const sourceBounds = value.bounds || { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
    const bounds = {
      minX: boundedSimulationNumber(sourceBounds.minX, "world.bounds.minX"),
      maxX: boundedSimulationNumber(sourceBounds.maxX, "world.bounds.maxX"),
      minZ: boundedSimulationNumber(sourceBounds.minZ, "world.bounds.minZ"),
      maxZ: boundedSimulationNumber(sourceBounds.maxZ, "world.bounds.maxZ")
    };
    if (!(bounds.minX < bounds.maxX) || !(bounds.minZ < bounds.maxZ)) {
      throw new TypeError("simulation world bounds must have positive width and depth");
    }
    if (value.colliders !== undefined && !Array.isArray(value.colliders)) {
      throw new TypeError("simulation world colliders must be an array");
    }
    if (Array.isArray(value.colliders) && value.colliders.length > MAX_SIMULATION_COLLIDERS) {
      throw new RangeError(`simulation world exceeds the ${MAX_SIMULATION_COLLIDERS} collider limit`);
    }
    const ids = new Set();
    const colliders = (value.colliders || []).map((source, index) => {
      if (!source || typeof source !== "object") throw new TypeError(`collider ${index} must be an object`);
      const type = String(source.type || "");
      const id = String(source.id ?? `collider-${index + 1}`).trim();
      if (!id || ids.has(id)) throw new TypeError(`collider id must be non-empty and unique: ${id || "empty"}`);
      ids.add(id);
      const common = {
        id,
        type,
        x: boundedSimulationNumber(source.x ?? source.rect?.x, `collider ${id}.x`),
        z: boundedSimulationNumber(source.z ?? source.rect?.z, `collider ${id}.z`)
      };
      if (type === "circle") {
        return {
          ...common,
          radius: boundedPositiveSimulationNumber(source.radius, null, `collider ${id}.radius`)
        };
      }
      if (type === "rect") {
        return {
          ...common,
          width: boundedPositiveSimulationNumber(source.width ?? source.w ?? source.rect?.width ?? source.rect?.w, null, `collider ${id}.width`),
          depth: boundedPositiveSimulationNumber(source.depth ?? source.h ?? source.rect?.depth ?? source.rect?.h, null, `collider ${id}.depth`)
        };
      }
      throw new TypeError(`unsupported collider type: ${type || "missing"}`);
    });
    return { bounds, colliders };
  }

  function normalizeSimulationDefinition(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("simulation definition must be an object");
    }
    const sourceVehicle = input.vehicle && typeof input.vehicle === "object" ? input.vehicle : {};
    if (input.schemaVersion !== undefined && input.schemaVersion !== SIMULATION_SCHEMA_VERSION) {
      throw new TypeError(`unsupported simulation schema: ${String(input.schemaVersion)}`);
    }
    if (sourceVehicle.version !== undefined && sourceVehicle.version !== VEHICLE_MODEL_VERSION) {
      throw new TypeError(`unsupported vehicle model: ${String(sourceVehicle.version)}`);
    }
    const stepMs = positiveSimulationNumber(input.stepMs, DEFAULT_FIXED_STEP_MS, "simulation stepMs");
    if (stepMs < 1 || stepMs > 1000) throw new RangeError("simulation stepMs must be between 1 and 1000 milliseconds");
    if (!Number.isInteger(stepMs * 1000)) throw new TypeError("simulation stepMs must resolve to whole microseconds");
    const seedValue = input.seed ?? 0;
    if (!Number.isSafeInteger(seedValue) || seedValue < 0 || seedValue > 0xffffffff) {
      throw new TypeError("simulation seed must be an unsigned 32-bit integer");
    }
    const normalized = {
      schemaVersion: SIMULATION_SCHEMA_VERSION,
      stepMs,
      seed: seedValue >>> 0,
      initialPose: normalizeSimulationPose(input.initialPose ?? sourceVehicle.initialPose ?? { x: 0, z: 0, heading: 0 }),
      vehicle: {
        version: String(sourceVehicle.version || VEHICLE_MODEL_VERSION),
        radius: positiveSimulationNumber(sourceVehicle.radius, 0.44, "vehicle.radius"),
        collisionSkin: finiteSimulationNumber(sourceVehicle.collisionSkin ?? 0.005, "vehicle.collisionSkin"),
        maxLinearSpeed: positiveSimulationNumber(sourceVehicle.maxLinearSpeed, 2.5, "vehicle.maxLinearSpeed"),
        maxAngularSpeed: positiveSimulationNumber(sourceVehicle.maxAngularSpeed, 2.8, "vehicle.maxAngularSpeed")
      },
      world: normalizeSimulationWorld(input.world || {})
    };
    if (normalized.vehicle.collisionSkin < 0) throw new TypeError("vehicle.collisionSkin must be non-negative");
    if (normalized.vehicle.radius > MAX_SIMULATION_COORDINATE
      || normalized.vehicle.collisionSkin > MAX_SIMULATION_COORDINATE) {
      throw new RangeError("vehicle dimensions exceed the supported simulation range");
    }
    if (normalized.vehicle.maxLinearSpeed > MAX_SIMULATION_SPEED
      || normalized.vehicle.maxAngularSpeed > MAX_SIMULATION_SPEED) {
      throw new RangeError("vehicle speed exceeds the supported simulation range");
    }
    const bounds = normalized.world.bounds;
    if (bounds.maxX - bounds.minX <= normalized.vehicle.radius * 2
      || bounds.maxZ - bounds.minZ <= normalized.vehicle.radius * 2) {
      throw new RangeError("simulation world is too small for the vehicle radius");
    }
    if (normalized.initialPose.x < bounds.minX + normalized.vehicle.radius - EPSILON
      || normalized.initialPose.x > bounds.maxX - normalized.vehicle.radius + EPSILON
      || normalized.initialPose.z < bounds.minZ + normalized.vehicle.radius - EPSILON
      || normalized.initialPose.z > bounds.maxZ - normalized.vehicle.radius + EPSILON) {
      throw new RangeError("simulation initialPose lies outside the playable bounds");
    }
    return deepFreeze(normalized);
  }

  function normalizeInteractionDefinition(input = {}, simulationDefinition = null) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("interaction definition must be an object");
    }
    const schemaVersion = input.schemaVersion ?? INTERACTION_SCHEMA_VERSION;
    if (schemaVersion !== INTERACTION_SCHEMA_VERSION
      && schemaVersion !== LEGACY_INTERACTION_SCHEMA_VERSION) {
      throw new TypeError(`unsupported interaction schema: ${String(input.schemaVersion)}`);
    }
    const roleAware = schemaVersion === INTERACTION_SCHEMA_VERSION;
    if (input.stackKeyDigits !== undefined && input.stackKeyDigits !== 3) {
      throw new TypeError("interaction stackKeyDigits must be 3");
    }
    const simulation = simulationDefinition
      ? normalizeSimulationDefinition(simulationDefinition)
      : null;
    const sourceBounds = input.bounds || input.worldBounds || simulation?.world?.bounds
      || { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
    const bounds = {
      minX: boundedSimulationNumber(sourceBounds.minX, "interaction bounds.minX"),
      maxX: boundedSimulationNumber(sourceBounds.maxX, "interaction bounds.maxX"),
      minZ: boundedSimulationNumber(sourceBounds.minZ, "interaction bounds.minZ"),
      maxZ: boundedSimulationNumber(sourceBounds.maxZ, "interaction bounds.maxZ")
    };
    if (!(bounds.minX < bounds.maxX) || !(bounds.minZ < bounds.maxZ)) {
      throw new TypeError("interaction bounds must have positive width and depth");
    }
    const packageRadius = boundedPositiveSimulationNumber(
      input.packageRadius,
      0.28,
      "interaction packageRadius"
    );
    if (bounds.maxX - bounds.minX <= packageRadius * 2
      || bounds.maxZ - bounds.minZ <= packageRadius * 2) {
      throw new RangeError("interaction bounds are too small for the package radius");
    }
    const grabSource = input.grab && typeof input.grab === "object" ? input.grab : {};
    const releaseSource = input.release && typeof input.release === "object" ? input.release : {};
    const grab = {
      minForward: finiteSimulationNumber(grabSource.minForward ?? input.minForward ?? 0.38, "interaction grab.minForward"),
      maxForward: positiveSimulationNumber(grabSource.maxForward ?? input.maxForward, 1.35, "interaction grab.maxForward"),
      maxLateral: positiveSimulationNumber(grabSource.maxLateral ?? input.maxLateral, 0.38, "interaction grab.maxLateral"),
      maxDistance: positiveSimulationNumber(grabSource.maxDistance ?? input.maxGrabDistance,
        MAX_SIMULATION_COORDINATE, "interaction grab.maxDistance")
    };
    if (grab.minForward < 0 || grab.minForward > grab.maxForward) {
      throw new TypeError("interaction grab forward range is invalid");
    }
    const release = {
      forwardOffset: finiteSimulationNumber(releaseSource.forwardOffset ?? input.forwardOffset ?? 1.1,
        "interaction release.forwardOffset"),
      lateralOffset: finiteSimulationNumber(releaseSource.lateralOffset ?? input.lateralOffset ?? 0,
        "interaction release.lateralOffset"),
      stackSnapDistance: positiveSimulationNumber(
        releaseSource.stackSnapDistance ?? input.stackSnapDistance,
        0.62,
        "interaction release.stackSnapDistance"
      )
    };
    if (Math.abs(release.forwardOffset) > MAX_SIMULATION_COORDINATE
      || Math.abs(release.lateralOffset) > MAX_SIMULATION_COORDINATE
      || release.stackSnapDistance > MAX_SIMULATION_COORDINATE) {
      throw new RangeError("interaction release geometry exceeds the supported range");
    }
    const sourcePackages = input.packages ?? input.initialPackages ?? [];
    if (!Array.isArray(sourcePackages)) throw new TypeError("interaction packages must be an array");
    if (sourcePackages.length > MAX_INTERACTION_PACKAGES) {
      throw new RangeError(`interaction exceeds the ${MAX_INTERACTION_PACKAGES} package limit`);
    }
    const ids = new Set();
    const implicitLevels = new Map();
    const packages = sourcePackages.map((source, index) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw new TypeError(`interaction package ${index} must be an object`);
      }
      const id = String(source.id || "").trim();
      if (!id || id.length > 128 || ids.has(id)) {
        throw new TypeError(`interaction package id must be non-empty and unique: ${id || "empty"}`);
      }
      ids.add(id);
      const x = boundedSimulationNumber(source.x ?? source.position?.[0], `interaction package ${id}.x`);
      const z = boundedSimulationNumber(source.z ?? source.position?.[1], `interaction package ${id}.z`);
      const radius = roleAware
        ? boundedPositiveSimulationNumber(source.radius, packageRadius, `interaction package ${id}.radius`)
        : packageRadius;
      if (x < bounds.minX + radius - EPSILON || x > bounds.maxX - radius + EPSILON
        || z < bounds.minZ + radius - EPSILON || z > bounds.maxZ - radius + EPSILON) {
        throw new RangeError(`interaction package ${id} lies outside the playable bounds`);
      }
      const stackKey = `${round(x, 3)},${round(z, 3)}`;
      const implicitLevel = implicitLevels.get(stackKey) || 0;
      const stackLevel = source.stackLevel === undefined ? implicitLevel : source.stackLevel;
      if (!Number.isSafeInteger(stackLevel) || stackLevel < 0) {
        throw new TypeError(`interaction package ${id}.stackLevel must be a non-negative safe integer`);
      }
      const role = roleAware ? String(source.role ?? "target").trim() : "target";
      if (!INTERACTION_OBJECT_ROLES.has(role)) {
        throw new TypeError(`interaction package ${id}.role must be target, distractor, or obstacle`);
      }
      if (role === "obstacle" && stackLevel !== 0) {
        throw new TypeError(`interaction obstacle ${id} cannot have a non-zero stackLevel`);
      }
      implicitLevels.set(stackKey, Math.max(implicitLevel, stackLevel + 1));
      return {
        id,
        x: simulationRound(x),
        z: simulationRound(z),
        stackLevel,
        ...(roleAware ? { role, radius: simulationRound(radius) } : {})
      };
    });
    const occupiedLevels = new Set();
    packages.forEach(item => {
      const key = `${round(item.x, 3)},${round(item.z, 3)},${item.stackLevel}`;
      if (occupiedLevels.has(key)) throw new TypeError("interaction packages cannot share the same stack level");
      occupiedLevels.add(key);
    });
    packages.filter(item => (item.role || "target") === "obstacle").forEach(obstacle => {
      if (packages.some(item => item !== obstacle
        && round(item.x, 3) === round(obstacle.x, 3)
        && round(item.z, 3) === round(obstacle.z, 3))) {
        throw new TypeError(`interaction obstacle ${obstacle.id} cannot share a stack position`);
      }
    });
    return deepFreeze({
      schemaVersion,
      packageRadius,
      stackKeyDigits: 3,
      bounds,
      grab,
      release,
      packages
    });
  }

  function taskRequiresInteractionDefinition(taskDefinition) {
    return taskDefinition?.type === "delivery" || taskDefinition?.type === "composite";
  }

  function taskAnalysisGeometry(taskDefinition) {
    if (!taskDefinition || typeof taskDefinition !== "object") return 1;
    const checkpoints = Array.isArray(taskDefinition.checkpoints) ? taskDefinition.checkpoints.length : 0;
    const deliveries = Array.isArray(taskDefinition.deliveries)
      ? taskDefinition.deliveries.reduce((sum, delivery) => (
          sum + (Array.isArray(delivery?.requiredPackageIds) ? delivery.requiredPackageIds.length : 0)
        ), 0)
      : Array.isArray(taskDefinition.requiredPackageIds) ? taskDefinition.requiredPackageIds.length : 0;
    const avoidances = Array.isArray(taskDefinition.avoidanceObjectIds) ? taskDefinition.avoidanceObjectIds.length : 0;
    const clearancePackages = Array.isArray(taskDefinition.deliveries)
      ? taskDefinition.deliveries.reduce((sum, delivery) => (
          delivery?.placementRule === "road-edge-clearance"
            ? sum + (Array.isArray(delivery.requiredPackageIds) ? delivery.requiredPackageIds.length : 0)
            : sum
        ), 0)
      : 0;
    const clearanceRoadSegments = Array.isArray(taskDefinition.placementGeometry?.roads)
      ? taskDefinition.placementGeometry.roads.reduce((sum, road) => (
          sum + Math.max(1, Array.isArray(road?.points) ? road.points.length - 1 : 1)
        ), 0)
      : 0;
    return Math.max(1, checkpoints + deliveries + avoidances + (Array.isArray(taskDefinition.goal) ? 1 : 0)
      + clearancePackages * clearanceRoadSegments);
  }

  function validateDeliveryInteractionDefinition(taskDefinition, interactionDefinition) {
    if (!taskRequiresInteractionDefinition(taskDefinition)) return true;
    const composite = taskDefinition.type === "composite";
    if (!interactionDefinition) {
      throw new TypeError(`${composite ? "composite" : "delivery"} task requires an interaction definition`);
    }
    if (composite && interactionDefinition.schemaVersion !== INTERACTION_SCHEMA_VERSION) {
      throw new TypeError(`composite task requires ${INTERACTION_SCHEMA_VERSION}`);
    }
    const byId = new Map((interactionDefinition.packages || []).map(item => [item.id, item]));
    const bindings = composite
      ? taskDefinition.deliveries.flatMap(delivery => delivery.requiredPackageIds.map(requiredId => ({
          requiredId,
          requiredRole: delivery.objectRole,
          deliveryId: delivery.id
        })))
      : (taskDefinition.requiredPackageIds || []).map(requiredId => ({
          requiredId,
          requiredRole: "target",
          deliveryId: null
        }));
    for (const binding of bindings) {
      const item = byId.get(binding.requiredId);
      if (!item) {
        throw new TypeError(`${composite ? `composite delivery ${binding.deliveryId}` : "delivery target"} ${binding.requiredId} is missing from the interaction definition`);
      }
      if ((item.role || "target") !== binding.requiredRole) {
        throw new TypeError(`${composite ? `composite delivery ${binding.deliveryId}` : "delivery"} required package ${binding.requiredId} must have role ${binding.requiredRole}`);
      }
      if (composite && taskDefinition.schemaVersion === ROAD_CLEARANCE_TASK_SCHEMA_VERSION) {
        const delivery = taskDefinition.deliveries.find(candidate => candidate.id === binding.deliveryId);
        if (delivery?.placementRule === "road-edge-clearance"
          && (typeof item.radius !== "number" || !Number.isFinite(item.radius)
            || Math.abs(item.radius - delivery.objectRadius) > EPSILON)) {
          throw new TypeError(`composite delivery ${binding.deliveryId} objectRadius must match interaction package ${binding.requiredId} radius`);
        }
      }
    }
    if (composite) {
      for (const objectId of taskDefinition.avoidanceObjectIds || []) {
        const item = byId.get(objectId);
        if (!item) {
          throw new TypeError(`composite avoidance object ${objectId} is missing from the interaction definition`);
        }
        if (item.role !== "obstacle") {
          throw new TypeError(`composite avoidance object ${objectId} must have role obstacle`);
        }
      }
    }
    return true;
  }

  class PackageStateEngine {
    constructor(definition = {}, simulationDefinition = null) {
      this.config = normalizeInteractionDefinition(definition, simulationDefinition);
      this.reset();
    }

    definition() {
      return clone(this.config);
    }

    reset() {
      this.packages = this.config.packages.map(item => ({
        ...item,
        role: item.role || "target"
      }));
      this.holding = null;
      return this.snapshot();
    }

    snapshot() {
      return {
        holding: this.holding,
        packages: this.packages
          .map(item => ({
            id: item.id,
            role: item.role,
            x: simulationRound(item.x),
            z: simulationRound(item.z),
            stackLevel: item.stackLevel
          }))
          .sort((left, right) => left.id.localeCompare(right.id))
      };
    }

    restore(snapshot = {}) {
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new TypeError("package state snapshot must be an object");
      }
      const supplied = Array.isArray(snapshot.packages) ? snapshot.packages : null;
      if (!supplied || supplied.length !== this.packages.length) {
        throw new TypeError("package state snapshot has an invalid package list");
      }
      const suppliedById = new Map(supplied.map(item => [String(item?.id || ""), item]));
      if (suppliedById.size !== this.packages.length) {
        throw new TypeError("package state snapshot has duplicate package ids");
      }
      this.packages.forEach(item => {
        const source = suppliedById.get(item.id);
        if (!source || String(source.role || "") !== item.role
          || !Number.isFinite(source.x) || !Number.isFinite(source.z)
          || !Number.isSafeInteger(source.stackLevel) || source.stackLevel < 0) {
          throw new TypeError("package state snapshot does not match the frozen interaction definition");
        }
        item.x = simulationRound(source.x);
        item.z = simulationRound(source.z);
        item.stackLevel = source.stackLevel;
      });
      const holding = snapshot.holding === null ? null : String(snapshot.holding || "").trim();
      if (holding !== null && !this.packages.some(item => item.id === holding)) {
        throw new TypeError("package state snapshot holding id is invalid");
      }
      this.holding = holding;
      return this.snapshot();
    }

    stackKey(item) {
      return `${round(item.x, this.config.stackKeyDigits)},${round(item.z, this.config.stackKeyDigits)}`;
    }

    topPackages() {
      const topByStack = new Map();
      this.packages.forEach(item => {
        if (item.id === this.holding) return;
        const key = this.stackKey(item);
        const current = topByStack.get(key);
        if (!current || item.stackLevel > current.stackLevel
          || (item.stackLevel === current.stackLevel && item.id.localeCompare(current.id) < 0)) {
          topByStack.set(key, item);
        }
      });
      return [...topByStack.values()];
    }

    normalizePose(pose) {
      const source = pose?.pose && typeof pose.pose === "object" ? pose.pose : pose;
      return normalizeSimulationPose(source, "interaction pose");
    }

    measure(item, pose) {
      const forwardX = -Math.sin(pose.heading);
      const forwardZ = -Math.cos(pose.heading);
      const dx = item.x - pose.x;
      const dz = item.z - pose.z;
      const forward = dx * forwardX + dz * forwardZ;
      const lateral = Math.abs(dx * forwardZ - dz * forwardX);
      const distance = Math.hypot(dx, dz);
      let reason = "ok";
      if (forward < this.config.grab.minForward - EPSILON) reason = "behind";
      else if (forward > this.config.grab.maxForward + EPSILON) reason = "far";
      else if (lateral > this.config.grab.maxLateral + EPSILON) reason = "side";
      return { item, forward, lateral, distance, reason, reachable: reason === "ok" };
    }

    outcome(accepted, reason, packageId = null, position = null, stackLevel = null, extra = {}) {
      const objectRole = packageId
        ? this.packages.find(item => item.id === packageId)?.role || null
        : null;
      return {
        accepted: Boolean(accepted),
        reason: String(reason),
        packageId,
        objectRole,
        position: position ? [simulationRound(position[0]), simulationRound(position[1])] : null,
        stackLevel: Number.isSafeInteger(stackLevel) ? stackLevel : null,
        ...clone(extra),
        state: this.snapshot()
      };
    }

    applyGrab(intent = {}, pose = {}) {
      if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
        throw new TypeError("package grab intent must be an object");
      }
      if (this.holding) return this.outcome(false, "holding", this.holding);
      const requestedId = intent.packageId === undefined || intent.packageId === null
        ? null
        : String(intent.packageId).trim();
      if (requestedId !== null && !requestedId) throw new TypeError("package grab packageId must be non-empty");
      const vehiclePose = this.normalizePose(pose);
      const top = this.topPackages();
      if (!top.length) return this.outcome(false, "missing");
      let candidates = top;
      if (requestedId) {
        const requested = this.packages.find(item => item.id === requestedId);
        if (!requested) return this.outcome(false, "missing", requestedId);
        if (!top.some(item => item.id === requestedId)) {
          return this.outcome(false, "not_top", requestedId, [requested.x, requested.z], requested.stackLevel);
        }
        candidates = [requested];
      }
      const measured = candidates.map(item => this.measure(item, vehiclePose))
        .sort((left, right) => left.distance - right.distance || left.item.id.localeCompare(right.item.id));
      const chosen = measured.find(item => item.reachable) || measured[0];
      if (!chosen?.reachable) {
        return this.outcome(false, chosen?.reason || "missing", chosen?.item?.id || requestedId,
          chosen?.item ? [chosen.item.x, chosen.item.z] : null, chosen?.item?.stackLevel ?? null,
          chosen ? { distance: simulationRound(chosen.distance), forward: simulationRound(chosen.forward), lateral: simulationRound(chosen.lateral) } : {});
      }
      if (chosen.item.role === "obstacle") {
        return this.outcome(false, "not_grabbable", chosen.item.id,
          [chosen.item.x, chosen.item.z], chosen.item.stackLevel, {
            distance: simulationRound(chosen.distance),
            forward: simulationRound(chosen.forward),
            lateral: simulationRound(chosen.lateral)
          });
      }
      this.holding = chosen.item.id;
      return this.outcome(true, "grabbed", chosen.item.id, [chosen.item.x, chosen.item.z], chosen.item.stackLevel, {
        distance: simulationRound(chosen.distance),
        forward: simulationRound(chosen.forward),
        lateral: simulationRound(chosen.lateral)
      });
    }

    previewRelease(intent = {}, pose = {}) {
      if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
        throw new TypeError("package release intent must be an object");
      }
      if (!this.holding) return this.outcome(false, "empty");
      const requestedId = intent.packageId === undefined || intent.packageId === null
        ? this.holding
        : String(intent.packageId).trim();
      if (!requestedId) throw new TypeError("package release packageId must be non-empty");
      if (requestedId !== this.holding) return this.outcome(false, "not_holding", requestedId);
      const vehiclePose = this.normalizePose(pose);
      const forwardX = -Math.sin(vehiclePose.heading);
      const forwardZ = -Math.cos(vehiclePose.heading);
      const rightX = -forwardZ;
      const rightZ = forwardX;
      const release = this.config.release;
      const unclampedX = vehiclePose.x + forwardX * release.forwardOffset + rightX * release.lateralOffset;
      const unclampedZ = vehiclePose.z + forwardZ * release.forwardOffset + rightZ * release.lateralOffset;
      const bounds = this.config.bounds;
      const item = this.packages.find(candidate => candidate.id === this.holding);
      const radius = item.radius ?? this.config.packageRadius;
      const boundedX = clamp(unclampedX, bounds.minX + radius, bounds.maxX - radius);
      const boundedZ = clamp(unclampedZ, bounds.minZ + radius, bounds.maxZ - radius);
      const stacks = new Map();
      this.packages.forEach(item => {
        if (item.id === this.holding || item.role === "obstacle") return;
        const key = this.stackKey(item);
        const stack = stacks.get(key) || { x: item.x, z: item.z, topLevel: -1, id: item.id };
        stack.topLevel = Math.max(stack.topLevel, item.stackLevel);
        if (item.id.localeCompare(stack.id) < 0) stack.id = item.id;
        stacks.set(key, stack);
      });
      const nearby = [...stacks.values()]
        .map(stack => ({ ...stack, distance: Math.hypot(stack.x - boundedX, stack.z - boundedZ) }))
        .filter(stack => stack.distance <= release.stackSnapDistance + EPSILON)
        .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))[0] || null;
      const x = nearby ? nearby.x : boundedX;
      const z = nearby ? nearby.z : boundedZ;
      const stackLevel = nearby ? nearby.topLevel + 1 : 0;
      const blockingObstacle = this.packages
        .filter(candidate => candidate.role === "obstacle")
        .map(candidate => ({
          item: candidate,
          distance: Math.hypot(candidate.x - x, candidate.z - z)
        }))
        .filter(candidate => candidate.distance < radius + (candidate.item.radius ?? this.config.packageRadius) - EPSILON)
        .sort((left, right) => left.distance - right.distance || left.item.id.localeCompare(right.item.id))[0] || null;
      if (blockingObstacle) {
        return this.outcome(false, "blocked", this.holding, [x, z], stackLevel, {
          obstacleId: blockingObstacle.item.id
        });
      }
      return this.outcome(true, "released", this.holding, [x, z], stackLevel, {
        snapped: Boolean(nearby),
        clamped: Math.abs(x - unclampedX) > EPSILON || Math.abs(z - unclampedZ) > EPSILON
      });
    }

    applyRelease(intent = {}, pose = {}) {
      const preview = this.previewRelease(intent, pose);
      if (!preview.accepted) return preview;
      const item = this.packages.find(candidate => candidate.id === this.holding);
      item.x = preview.position[0];
      item.z = preview.position[1];
      item.stackLevel = preview.stackLevel;
      const packageId = this.holding;
      this.holding = null;
      return this.outcome(true, "released", packageId, preview.position, preview.stackLevel, {
        snapped: Boolean(preview.snapped),
        clamped: Boolean(preview.clamped)
      });
    }

    apply(kind, intent = {}, pose = {}) {
      const normalizedKind = String(kind || intent.type || intent.kind || "");
      if (normalizedKind === "package_grab" || normalizedKind === "grab") return this.applyGrab(intent, pose);
      if (normalizedKind === "package_release" || normalizedKind === "release") return this.applyRelease(intent, pose);
      throw new TypeError(`unsupported package interaction: ${normalizedKind || "missing"}`);
    }

    colliders() {
      const stacks = new Map();
      this.packages.filter(item => item.id !== this.holding && item.role !== "obstacle").forEach(item => {
        const key = this.stackKey(item);
        const stack = stacks.get(key) || { ...item, radius: item.radius ?? this.config.packageRadius };
        stack.radius = Math.max(stack.radius, item.radius ?? this.config.packageRadius);
        stacks.set(key, stack);
      });
      const packageColliders = [...stacks.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => ({
          id: `package-stack:${key}`,
          source: "package",
          type: "circle",
          x: item.x,
          z: item.z,
          radius: item.radius
        }));
      const obstacleColliders = this.packages
        .filter(item => item.role === "obstacle")
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(item => ({
          id: `object:${item.id}`,
          source: "interaction-obstacle",
          type: "circle",
          x: item.x,
          z: item.z,
          radius: item.radius ?? this.config.packageRadius
        }));
      return [...packageColliders, ...obstacleColliders];
    }
  }

  class SeededRandom {
    constructor(seed = 0) {
      if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
        throw new TypeError("random seed must be an unsigned 32-bit integer");
      }
      this.initialSeed = seed >>> 0;
      this.state = this.initialSeed;
    }

    reset(seed = this.initialSeed) {
      if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
        throw new TypeError("random seed must be an unsigned 32-bit integer");
      }
      this.initialSeed = seed >>> 0;
      this.state = this.initialSeed;
      return this.snapshot();
    }

    next() {
      this.state = (this.state + 0x6D2B79F5) >>> 0;
      let value = this.state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    }

    snapshot() {
      return this.state >>> 0;
    }
  }

  function simulationRayCircleEntry(originX, originZ, dirX, dirZ, centerX, centerZ, radius) {
    const offsetX = originX - centerX;
    const offsetZ = originZ - centerZ;
    const projection = offsetX * dirX + offsetZ * dirZ;
    const distanceTerm = offsetX * offsetX + offsetZ * offsetZ - radius * radius;
    if (distanceTerm < -EPSILON) return 0;
    if (distanceTerm <= EPSILON) return projection < 0 ? 0 : Infinity;
    if (projection >= 0) return Infinity;
    const discriminant = projection * projection - distanceTerm;
    if (discriminant <= EPSILON) return Infinity;
    return Math.max(0, -projection - Math.sqrt(discriminant));
  }

  function simulationRayOpenAabbEntry(originX, originZ, dirX, dirZ, minX, maxX, minZ, maxZ) {
    let near = -Infinity;
    let far = Infinity;
    if (Math.abs(dirX) <= EPSILON) {
      if (originX <= minX + EPSILON || originX >= maxX - EPSILON) return Infinity;
    } else {
      const first = (minX - originX) / dirX;
      const second = (maxX - originX) / dirX;
      near = Math.max(near, Math.min(first, second));
      far = Math.min(far, Math.max(first, second));
    }
    if (Math.abs(dirZ) <= EPSILON) {
      if (originZ <= minZ + EPSILON || originZ >= maxZ - EPSILON) return Infinity;
    } else {
      const first = (minZ - originZ) / dirZ;
      const second = (maxZ - originZ) / dirZ;
      near = Math.max(near, Math.min(first, second));
      far = Math.min(far, Math.max(first, second));
    }
    if (far <= Math.max(near, 0) + EPSILON) return Infinity;
    return Math.max(0, near);
  }

  function simulationRayRoundedRectEntry(originX, originZ, dirX, dirZ, rect, radius) {
    const minX = rect.x - rect.width / 2;
    const maxX = rect.x + rect.width / 2;
    const minZ = rect.z - rect.depth / 2;
    const maxZ = rect.z + rect.depth / 2;
    let nearest = simulationRayOpenAabbEntry(originX, originZ, dirX, dirZ, minX, maxX, minZ - radius, maxZ + radius);
    nearest = Math.min(nearest, simulationRayOpenAabbEntry(originX, originZ, dirX, dirZ, minX - radius, maxX + radius, minZ, maxZ));
    nearest = Math.min(nearest, simulationRayCircleEntry(originX, originZ, dirX, dirZ, minX, minZ, radius));
    nearest = Math.min(nearest, simulationRayCircleEntry(originX, originZ, dirX, dirZ, minX, maxZ, radius));
    nearest = Math.min(nearest, simulationRayCircleEntry(originX, originZ, dirX, dirZ, maxX, minZ, radius));
    return Math.min(nearest, simulationRayCircleEntry(originX, originZ, dirX, dirZ, maxX, maxZ, radius));
  }

  function simulationClearanceHitAlongRay(world, vehicleRadius, originX, originZ, dirX, dirZ) {
    const length = Math.hypot(dirX, dirZ);
    if (length <= EPSILON) return { distance: Infinity, colliderId: null };
    const normalizedX = dirX / length;
    const normalizedZ = dirZ / length;
    const outerBounds = world.bounds;
    const bounds = {
      minX: outerBounds.minX + vehicleRadius,
      maxX: outerBounds.maxX - vehicleRadius,
      minZ: outerBounds.minZ + vehicleRadius,
      maxZ: outerBounds.maxZ - vehicleRadius
    };
    if (originX < bounds.minX - EPSILON || originX > bounds.maxX + EPSILON
      || originZ < bounds.minZ - EPSILON || originZ > bounds.maxZ + EPSILON) {
      return { distance: 0, colliderId: "world-bounds" };
    }
    const edgeX = normalizedX > EPSILON
      ? (bounds.maxX - originX) / normalizedX
      : normalizedX < -EPSILON ? (bounds.minX - originX) / normalizedX : Infinity;
    const edgeZ = normalizedZ > EPSILON
      ? (bounds.maxZ - originZ) / normalizedZ
      : normalizedZ < -EPSILON ? (bounds.minZ - originZ) / normalizedZ : Infinity;
    let nearest = Math.max(0, Math.min(edgeX, edgeZ));
    let colliderId = "world-bounds";
    for (const collider of world.colliders) {
      const candidate = collider.type === "circle"
        ? simulationRayCircleEntry(originX, originZ, normalizedX, normalizedZ,
            collider.x, collider.z, vehicleRadius + collider.radius)
        : simulationRayRoundedRectEntry(originX, originZ, normalizedX, normalizedZ,
            collider, vehicleRadius);
      const resolved = Number.isNaN(candidate) ? 0 : candidate;
      if (resolved < nearest) {
        nearest = resolved;
        colliderId = collider.id;
      }
    }
    return { distance: Math.max(0, nearest), colliderId };
  }

  function simulationRound(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new RangeError("simulation produced a non-finite numeric state");
    }
    const normalized = round(value, 12);
    return Object.is(normalized, -0) ? 0 : normalized;
  }

  class DeterministicSimulator {
    constructor(definition = {}) {
      this.config = normalizeSimulationDefinition(definition);
      this.stepUs = Math.round(this.config.stepMs * 1000);
      this.stepNs = Math.round(this.config.stepMs * 1000000);
      this.randomSource = new SeededRandom(this.config.seed);
      this.world = this.config.world;
      this.advanceRemainderNs = 0;
      this.reset();
    }

    definition() {
      return clone(this.config);
    }

    durationToTicks(durationMs) {
      const duration = finiteSimulationNumber(durationMs, "command durationMs");
      if (duration < 0) throw new RangeError("command durationMs must be non-negative");
      return duration <= EPSILON ? 0 : Math.ceil(duration * 1000 / this.stepUs - EPSILON);
    }

    normalizeCommand(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("simulation command must be an object");
      const kind = String(input.kind || input.type || "");
      if (!new Set(["drive", "turn", "turn_angle", "wait"]).has(kind)) {
        throw new TypeError(`unsupported simulation command: ${kind || "missing"}`);
      }
      let direction = 0;
      if (kind !== "wait") {
        if (input.direction === "left" || input.direction === 1 || input.direction === "+1") direction = 1;
        else if (input.direction === "right" || input.direction === -1 || input.direction === "-1") direction = -1;
        else throw new TypeError(`${kind} direction must be left/right or 1/-1`);
      }
      const defaultAngleDuration = kind === "turn_angle"
        ? Math.ceil(Math.max(
            260,
            positiveSimulationNumber(input.angleDegrees, null, "turn angleDegrees")
              * Math.PI / 180 / this.config.vehicle.maxAngularSpeed * 1000
          ) / this.config.stepMs) * this.config.stepMs
        : 0;
      const durationMs = input.durationMs === undefined
        ? defaultAngleDuration
        : finiteSimulationNumber(input.durationMs, "command durationMs");
      if (durationMs < 0) throw new RangeError("command durationMs must be non-negative");
      const durationTicks = input.durationTicks === undefined
        ? this.durationToTicks(durationMs)
        : input.durationTicks;
      if (!Number.isSafeInteger(durationTicks) || durationTicks < 0) {
        throw new TypeError("command durationTicks must be a non-negative safe integer");
      }
      if (durationTicks > MAX_SIMULATION_COMMAND_TICKS) {
        throw new RangeError(`command durationTicks exceeds the ${MAX_SIMULATION_COMMAND_TICKS} tick safety limit`);
      }
      if (input.durationMs !== undefined && this.durationToTicks(durationMs) !== durationTicks) {
        throw new TypeError("command durationMs and durationTicks must describe the same fixed-step duration");
      }
      const command = { kind, direction, durationMs, durationTicks };
      if (kind === "drive") {
        if (input.speed !== undefined) {
          const speed = finiteSimulationNumber(input.speed, "drive speed");
          if (speed < 0 || speed > this.config.vehicle.maxLinearSpeed + EPSILON) {
            throw new RangeError("drive speed exceeds the vehicle model");
          }
          command.speed = speed;
          command.speedPercent = round(speed / this.config.vehicle.maxLinearSpeed * 100, 6);
        } else {
          const speedPercent = finiteSimulationNumber(input.speedPercent ?? 50, "drive speedPercent");
          if (speedPercent < 10 || speedPercent > 100) throw new RangeError("drive speedPercent must be between 10 and 100");
          command.speedPercent = speedPercent;
          command.speed = this.config.vehicle.maxLinearSpeed * speedPercent / 100;
        }
      }
      if (kind === "turn") command.angularSpeed = this.config.vehicle.maxAngularSpeed;
      if (kind === "turn_angle") {
        const angleDegrees = positiveSimulationNumber(input.angleDegrees, null, "turn angleDegrees");
        if (angleDegrees > 360) throw new RangeError("turn angleDegrees must not exceed 360");
        if (durationTicks === 0) throw new RangeError("turn_angle requires at least one simulation tick");
        command.angleDegrees = angleDegrees;
        command.angleRadians = angleDegrees * Math.PI / 180;
        command.angularSpeed = command.angleRadians / (durationTicks * this.config.stepMs / 1000);
        if (command.angularSpeed > this.config.vehicle.maxAngularSpeed + EPSILON) {
          throw new RangeError("turn_angle angular speed exceeds the vehicle model");
        }
      }
      return command;
    }

    reset(pose = this.config.initialPose) {
      const normalizedPose = normalizeSimulationPose(pose, "simulation pose");
      const bounds = this.world.bounds;
      if (normalizedPose.x < bounds.minX + this.config.vehicle.radius - EPSILON
        || normalizedPose.x > bounds.maxX - this.config.vehicle.radius + EPSILON
        || normalizedPose.z < bounds.minZ + this.config.vehicle.radius - EPSILON
        || normalizedPose.z > bounds.maxZ - this.config.vehicle.radius + EPSILON) {
        throw new RangeError("simulation pose lies outside the playable bounds");
      }
      this.pose = normalizedPose;
      this.tick = 0;
      this.linearSpeed = 0;
      this.angularSpeed = 0;
      this.activeCommand = null;
      this.lastCommandResult = null;
      this.collisions = [];
      this.travelDistance = 0;
      this.advanceRemainderNs = 0;
      this.randomSource.reset(this.config.seed);
      this.path = [this.frameSnapshot({ initial: true })];
      return this.snapshot();
    }

    setWorld(world) {
      const normalized = normalizeSimulationWorld(world);
      const bounds = normalized.bounds;
      if (this.pose.x < bounds.minX + this.config.vehicle.radius - EPSILON
        || this.pose.x > bounds.maxX - this.config.vehicle.radius + EPSILON
        || this.pose.z < bounds.minZ + this.config.vehicle.radius - EPSILON
        || this.pose.z > bounds.maxZ - this.config.vehicle.radius + EPSILON) {
        throw new RangeError("current vehicle pose lies outside the updated simulation world");
      }
      this.world = deepFreeze(normalized);
      return clone(this.world);
    }

    random() {
      return this.randomSource.next();
    }

    hasActiveCommand() {
      return Boolean(this.activeCommand);
    }

    frameSnapshot(extra = {}) {
      return {
        tick: this.tick,
        elapsedMs: simulationRound(this.tick * this.config.stepMs),
        x: simulationRound(this.pose.x),
        z: simulationRound(this.pose.z),
        heading: simulationRound(this.pose.heading),
        linearSpeed: simulationRound(this.linearSpeed),
        angularSpeed: simulationRound(this.angularSpeed),
        collisionCount: this.collisions.length,
        ...extra
      };
    }

    compactSnapshot() {
      return {
        tick: this.tick,
        elapsedMs: simulationRound(this.tick * this.config.stepMs),
        pose: {
          x: simulationRound(this.pose.x),
          z: simulationRound(this.pose.z),
          heading: simulationRound(this.pose.heading)
        },
        linearSpeed: simulationRound(this.linearSpeed),
        angularSpeed: simulationRound(this.angularSpeed),
        activeCommand: this.activeCommand ? clone(this.activeCommand.command) : null,
        collisionCount: this.collisions.length,
        prngState: this.randomSource.snapshot()
      };
    }

    snapshot() {
      return { ...this.compactSnapshot(), collisions: clone(this.collisions) };
    }

    trajectory() {
      return clone(this.path);
    }

    clearanceHitAlongRay(originX, originZ, dirX, dirZ) {
      return simulationClearanceHitAlongRay(
        this.world,
        this.config.vehicle.radius,
        originX,
        originZ,
        dirX,
        dirZ
      );
    }

    clearanceAlongRay(originX, originZ, dirX, dirZ) {
      return this.clearanceHitAlongRay(originX, originZ, dirX, dirZ).distance;
    }

    startCommand(input) {
      if (this.activeCommand) throw new Error("a simulation command is already active");
      this.advanceRemainderNs = 0;
      const command = this.normalizeCommand(input);
      const estimatedWork = command.durationTicks
        * (command.kind === "drive" ? Math.max(1, this.world.colliders.length) : 1);
      if (estimatedWork > MAX_SIMULATION_WORK) {
        throw new RangeError(`simulation command exceeds the ${MAX_SIMULATION_WORK} operation safety limit`);
      }
      const startState = this.compactSnapshot();
      this.activeCommand = {
        command,
        startedTick: this.tick,
        executedTicks: 0,
        startState
      };
      this.linearSpeed = command.kind === "drive" ? command.direction * command.speed : 0;
      this.angularSpeed = command.kind === "turn" || command.kind === "turn_angle"
        ? command.direction * command.angularSpeed
        : 0;
      if (command.durationTicks === 0) this.completeCommand(false);
      return { command: clone(command), startState };
    }

    completeCommand(blocked) {
      const active = this.activeCommand;
      if (!active) return this.lastCommandResult;
      this.linearSpeed = 0;
      this.angularSpeed = 0;
      this.advanceRemainderNs = 0;
      this.lastCommandResult = {
        command: clone(active.command),
        startedTick: active.startedTick,
        endedTick: this.tick,
        executedTicks: active.executedTicks,
        blocked: Boolean(blocked),
        startState: clone(active.startState),
        endState: null
      };
      this.activeCommand = null;
      this.lastCommandResult.endState = this.compactSnapshot();
      return clone(this.lastCommandResult);
    }

    cancelCommand() {
      if (!this.activeCommand) return this.lastCommandResult ? clone(this.lastCommandResult) : null;
      const result = this.completeCommand(false);
      this.path.push(this.frameSnapshot({ cancelled: true, completed: true, blocked: false }));
      return result;
    }

    step() {
      if (!this.activeCommand) {
        return { advanced: false, completed: true, blocked: false, state: this.compactSnapshot() };
      }
      const active = this.activeCommand;
      const command = active.command;
      const dtSeconds = this.config.stepMs / 1000;
      let distance = 0;
      let headingDelta = 0;
      let blocked = false;
      let collisionTargetId = null;
      const executedLinearSpeed = command.kind === "drive" ? command.direction * command.speed : 0;
      const executedAngularSpeed = command.kind === "turn" || command.kind === "turn_angle"
        ? command.direction * command.angularSpeed
        : 0;
      if (command.kind === "drive") {
        const requestedDistance = command.speed * dtSeconds;
        const forwardX = -Math.sin(this.pose.heading) * command.direction;
        const forwardZ = -Math.cos(this.pose.heading) * command.direction;
        const clearanceHit = this.clearanceHitAlongRay(this.pose.x, this.pose.z, forwardX, forwardZ);
        const clearance = clearanceHit.distance;
        collisionTargetId = clearanceHit.colliderId;
        const availableDistance = Math.max(0, clearance - this.config.vehicle.collisionSkin);
        blocked = availableDistance < requestedDistance - EPSILON;
        distance = blocked ? availableDistance : requestedDistance;
        if (distance > EPSILON) {
          this.pose.x = simulationRound(this.pose.x + forwardX * distance);
          this.pose.z = simulationRound(this.pose.z + forwardZ * distance);
          this.travelDistance = simulationRound(this.travelDistance + Math.abs(distance));
        }
      } else if (command.kind === "turn") {
        headingDelta = command.direction * command.angularSpeed * dtSeconds;
        this.pose.heading = simulationRound(normalizeSimulationHeading(this.pose.heading + headingDelta, "simulation heading"));
      } else if (command.kind === "turn_angle") {
        const remainingAngle = command.angleRadians
          - active.executedTicks * command.angleRadians / Math.max(1, command.durationTicks);
        headingDelta = command.direction * Math.min(
          command.angleRadians / Math.max(1, command.durationTicks),
          Math.max(0, remainingAngle)
        );
        this.pose.heading = simulationRound(normalizeSimulationHeading(this.pose.heading + headingDelta, "simulation heading"));
      }
      this.tick += 1;
      active.executedTicks += 1;
      let collision = null;
      if (blocked) {
        collision = {
          tick: this.tick,
          elapsedMs: simulationRound(this.tick * this.config.stepMs),
          colliderId: collisionTargetId || "unknown",
          x: simulationRound(this.pose.x),
          z: simulationRound(this.pose.z)
        };
        this.collisions.push(collision);
      }
      const completed = blocked || active.executedTicks >= command.durationTicks;
      if (completed) this.completeCommand(blocked);
      const frame = this.frameSnapshot({
        linearSpeed: simulationRound(executedLinearSpeed),
        angularSpeed: simulationRound(executedAngularSpeed),
        distance: simulationRound(distance),
        headingDelta: simulationRound(headingDelta),
        collision: collision ? clone(collision) : null,
        blocked,
        completed
      });
      this.path.push(frame);
      if (completed) {
        this.path.push(this.frameSnapshot({ settled: true, completed: true, blocked }));
      }
      return {
        advanced: true,
        ...clone(frame),
        state: this.compactSnapshot(),
        result: completed ? clone(this.lastCommandResult) : null
      };
    }

    runUntilIdle(maxTicks = MAX_SIMULATION_COMMAND_TICKS) {
      if (!Number.isInteger(maxTicks) || maxTicks <= 0) throw new TypeError("maxTicks must be a positive integer");
      const frames = [];
      while (this.activeCommand && frames.length < maxTicks) frames.push(this.step());
      if (this.activeCommand) throw new RangeError("simulation command exceeded the tick safety limit");
      return frames;
    }

    runCommand(command) {
      this.startCommand(command);
      const frames = this.runUntilIdle();
      return { frames, snapshot: this.snapshot(), result: clone(this.lastCommandResult) };
    }

    advance(deltaMs, command = null) {
      const delta = finiteSimulationNumber(deltaMs, "simulation deltaMs");
      if (delta < 0) throw new RangeError("simulation deltaMs must be non-negative");
      if (command) this.startCommand(command);
      if (!this.activeCommand) {
        this.advanceRemainderNs = 0;
        return { steps: [], snapshot: this.snapshot() };
      }
      const deltaNs = Math.round(delta * 1000000);
      if (!Number.isSafeInteger(deltaNs)
        || deltaNs > MAX_SIMULATION_COMMAND_TICKS * this.stepNs) {
        throw new RangeError(`simulation advance exceeds the ${MAX_SIMULATION_COMMAND_TICKS} tick safety limit`);
      }
      this.advanceRemainderNs += deltaNs;
      const steps = [];
      while (this.activeCommand && this.advanceRemainderNs >= this.stepNs) {
        if (steps.length >= MAX_SIMULATION_COMMAND_TICKS) {
          throw new RangeError(`simulation advance exceeds the ${MAX_SIMULATION_COMMAND_TICKS} tick safety limit`);
        }
        this.advanceRemainderNs -= this.stepNs;
        steps.push(this.step());
      }
      return { steps, snapshot: this.snapshot() };
    }
  }

  function navigationRoadProjection(record, pose) {
    const projected = distanceToPolyline([pose.x, pose.z], record.points);
    const segmentIndex = Math.max(0, projected.segmentIndex);
    const segmentLength = record.segmentLengths[segmentIndex] || 0;
    return {
      ...projected,
      progress: record.cumulativeLengths[segmentIndex] + segmentLength * projected.t
    };
  }

  function navigationRoadPointAt(record, progress) {
    const target = clamp(progress, 0, record.length);
    for (let index = 0; index < record.segmentLengths.length; index += 1) {
      const start = record.cumulativeLengths[index];
      const length = record.segmentLengths[index];
      const end = record.cumulativeLengths[index + 1];
      if (length <= EPSILON) continue;
      if (target <= end + EPSILON || index === record.segmentLengths.length - 1) {
        const ratio = clamp((target - start) / length, 0, 1);
        return [
          record.points[index][0] + (record.points[index + 1][0] - record.points[index][0]) * ratio,
          record.points[index][1] + (record.points[index + 1][1] - record.points[index][1]) * ratio
        ];
      }
    }
    return [...record.points[record.points.length - 1]];
  }

  function navigationAppendDistinctPoint(points, point) {
    const normalized = [Number(point[0]), Number(point[1])];
    const previous = points[points.length - 1];
    if (!previous || Math.hypot(previous[0] - normalized[0], previous[1] - normalized[1]) > EPSILON) {
      points.push(normalized);
    }
  }

  function navigationRoadPath(record, fromProgress, toProgress) {
    const start = clamp(fromProgress, 0, record.length);
    const end = clamp(toProgress, 0, record.length);
    const points = [];
    navigationAppendDistinctPoint(points, navigationRoadPointAt(record, start));
    if (end >= start) {
      for (let index = 1; index < record.points.length - 1; index += 1) {
        const progress = record.cumulativeLengths[index];
        if (progress > start + EPSILON && progress < end - EPSILON) {
          navigationAppendDistinctPoint(points, record.points[index]);
        }
      }
    } else {
      for (let index = record.points.length - 2; index >= 1; index -= 1) {
        const progress = record.cumulativeLengths[index];
        if (progress < start - EPSILON && progress > end + EPSILON) {
          navigationAppendDistinctPoint(points, record.points[index]);
        }
      }
    }
    navigationAppendDistinctPoint(points, navigationRoadPointAt(record, end));
    return points;
  }

  function navigationJoinPaths(...paths) {
    const joined = [];
    paths.forEach(path => path.forEach(point => navigationAppendDistinctPoint(joined, point)));
    return joined;
  }

  const navigationActionRunnerStates = new WeakMap();

  class NavigationActionRunner {
    constructor(simulator, options = {}) {
      if (!(simulator instanceof DeterministicSimulator)) {
        throw new TypeError("NavigationActionRunner requires a DeterministicSimulator");
      }
      const rules = options.rules && typeof options.rules === "object" && !Array.isArray(options.rules)
        ? options.rules : {};
      const navigationDefinition = normalizeNavigationDefinition(
        options.navigationDefinition || NAVIGATION_DEFINITION
      );
      if (!navigationSupportsRoadTopology(navigationDefinition)) {
        throw new TypeError("navigation controls require the navigation v2 or v3 sensor contract");
      }
      const controlDefinition = normalizeNavigationControlDefinition(
        options.navigationControlDefinition || NAVIGATION_CONTROL_DEFINITION
      );
      if (controlDefinition.navigationSchemaVersion !== navigationDefinition.schemaVersion) {
        throw new TypeError("navigation control definition does not match the frozen navigation sensor contract");
      }
      const topology = resolveNavigationTopology({ roadTopology: options.roadTopology }, rules,
        navigationDefinition);
      navigationActionRunnerStates.set(this, {
        simulator,
        rules,
        navigationDefinition,
        controlDefinition,
        topology
      });
    }

    roadState() {
      const state = navigationActionRunnerStates.get(this);
      const { simulator, rules, navigationDefinition, topology } = state;
      return projectNavigationQuery("road_state", {
        pose: simulator.pose,
        initialPose: simulator.config.initialPose,
        distance: simulator.travelDistance,
        tick: simulator.tick,
        rules,
        navigationDefinition,
        roadTopology: topology,
        world: simulator.world,
        vehicleRadius: simulator.config.vehicle.radius
      });
    }

    result(accepted, stoppedBy, roadId, startTick, startDistance) {
      const { simulator, controlDefinition, rules } = navigationActionRunnerStates.get(this);
      return normalizeNavigationControlResult({
        accepted,
        stoppedBy,
        roadId,
        distanceCm: navigationRounded(navigationWorldToCm(
          simulator.travelDistance - startDistance,
          rules
        )),
        elapsedTicks: simulator.tick - startTick
      }, controlDefinition);
    }

    runPath(path, allowedRoadIds, speedPercent, startTick, startDistance, completedBy, options = {}) {
      const { simulator, controlDefinition, topology, rules } = navigationActionRunnerStates.get(this);
      const controller = controlDefinition.controller;
      const maxActionTicks = controller.maxActionTicks;
      const maximumDistance = Number.isFinite(options.maximumDistance)
        ? Math.max(0, options.maximumDistance)
        : Infinity;
      const maxTick = Number.isSafeInteger(options.maxTick) && options.maxTick >= simulator.tick
        ? options.maxTick
        : MAX_REPLAY_TICKS;
      const points = navigationJoinPaths(path);
      let waypointIndex = 0;
      const waypointTolerance = 0.001;
      const allowed = new Set(allowedRoadIds);
      const speed = simulator.config.vehicle.maxLinearSpeed * speedPercent / 100;
      const dtSeconds = simulator.config.stepMs / 1000;
      const headingTolerance = controller.headingToleranceDeg * Math.PI / 180;
      const executeOneTick = command => {
        if (simulator.tick >= maxTick) return { stoppedBy: "time_limit", frame: null };
        if (simulator.tick - startTick >= maxActionTicks) {
          return { stoppedBy: "safety_limit", frame: null };
        }
        if (typeof options.beforeStep === "function") options.beforeStep(command);
        simulator.startCommand(command);
        const frame = simulator.step();
        const keepGoing = typeof options.onStep === "function" ? options.onStep(frame) : true;
        if (keepGoing === false) return { stoppedBy: "time_limit", frame };
        if (frame.collision) return { stoppedBy: "collision", frame };
        return { stoppedBy: null, frame };
      };

      while (true) {
        while (waypointIndex < points.length
          && Math.hypot(simulator.pose.x - points[waypointIndex][0],
            simulator.pose.z - points[waypointIndex][1]) <= waypointTolerance + EPSILON) {
          waypointIndex += 1;
        }
        if (waypointIndex >= points.length) return completedBy;
        const travelled = simulator.travelDistance - startDistance;
        if (travelled >= maximumDistance - EPSILON) return "max_distance";
        if (simulator.tick >= maxTick) return "time_limit";
        if (simulator.tick - startTick >= maxActionTicks) return "safety_limit";
        const target = points[waypointIndex];
        const dx = target[0] - simulator.pose.x;
        const dz = target[1] - simulator.pose.z;
        const targetDistance = Math.hypot(dx, dz);
        if (targetDistance <= waypointTolerance + EPSILON) {
          waypointIndex += 1;
          continue;
        }
        const desiredHeading = Math.atan2(-dx, -dz);
        const headingError = normalizeSignedAngle(desiredHeading - simulator.pose.heading);
        if (Math.abs(headingError) > headingTolerance + EPSILON) {
          const maximumTurn = simulator.config.vehicle.maxAngularSpeed * dtSeconds;
          const angle = Math.min(Math.abs(headingError), maximumTurn);
          const stepResult = executeOneTick({
            kind: "turn_angle",
            direction: headingError > 0 ? "left" : "right",
            angleDegrees: angle * 180 / Math.PI,
            durationMs: simulator.config.stepMs,
            durationTicks: 1
          });
          if (stepResult.stoppedBy) return stepResult.stoppedBy;
          continue;
        }

        const remainingDistance = maximumDistance - travelled;
        let requestedDistance = Math.min(speed * dtSeconds, targetDistance, remainingDistance);
        if (requestedDistance <= EPSILON) return "max_distance";
        const forwardX = -Math.sin(simulator.pose.heading);
        const forwardZ = -Math.cos(simulator.pose.heading);
        if (options.obeySpeedLimit === true) {
          // Clamp using both sides of this fixed simulation step.  This prevents
          // a requested high speed from crossing a speed-zone boundary one tick
          // too quickly, while leaving route selection entirely to student code.
          const currentLimit = navigationSpeedLimitAt([simulator.pose.x, simulator.pose.z], rules,
            simulator.config.vehicle.radius);
          const requestedEnd = [
            simulator.pose.x + forwardX * requestedDistance,
            simulator.pose.z + forwardZ * requestedDistance
          ];
          const endLimit = navigationSpeedLimitAt(requestedEnd, rules, simulator.config.vehicle.radius);
          const limit = Math.min(currentLimit, endLimit);
          if (Number.isFinite(limit)) requestedDistance = Math.min(requestedDistance, limit * dtSeconds);
          if (requestedDistance <= EPSILON) return "safety_limit";
        }
        const clearance = simulator.clearanceAlongRay(
          simulator.pose.x, simulator.pose.z, forwardX, forwardZ
        );
        if (clearance + EPSILON < requestedDistance + simulator.config.vehicle.collisionSkin) {
          return "front_clearance";
        }
        const predicted = [
          simulator.pose.x + forwardX * requestedDistance,
          simulator.pose.z + forwardZ * requestedDistance
        ];
        const predictedOnRoad = [...allowed].some(roadId => {
          const record = topology.recordsById.get(roadId);
          if (!record) return false;
          const clearanceLimit = Math.max(0, Number(record.road.width) || 0) / 2
            - simulator.config.vehicle.radius;
          return distanceToPolyline(predicted, record.points).distance <= clearanceLimit + EPSILON;
        });
        if (!predictedOnRoad) return "safety_limit";
        const stepResult = executeOneTick({
          kind: "drive",
          direction: 1,
          speed: requestedDistance / dtSeconds,
          durationMs: simulator.config.stepMs,
          durationTicks: 1
        });
        if (stepResult.stoppedBy) return stepResult.stoppedBy;
      }
    }

    run(method, args = {}, options = {}) {
      const { simulator, controlDefinition, topology, navigationDefinition, rules } = navigationActionRunnerStates.get(this);
      if (simulator.hasActiveCommand()) {
        throw new Error("navigation control requires an idle deterministic simulator");
      }
      const action = normalizeNavigationControlAction(method, args, controlDefinition);
      const startTick = simulator.tick;
      const startDistance = simulator.travelDistance;
      const roadState = this.roadState();
      if (action.method === "follow_road") {
        if (!roadState.onRoad || !roadState.roadId) {
          return this.result(false, "off_road", null, startTick, startDistance);
        }
        const record = topology.recordsById.get(roadState.roadId);
        if (!record) return this.result(false, "off_road", null, startTick, startDistance);
        const projection = navigationRoadProjection(record, simulator.pose);
        const forward = [-Math.sin(simulator.pose.heading), -Math.cos(simulator.pose.heading)];
        const tangentDot = projection.tangent[0] * forward[0] + projection.tangent[1] * forward[1];
        if (record.oneWay && tangentDot < -EPSILON) {
          return this.result(false, "wrong_way", record.roadId, startTick, startDistance);
        }
        const direction = record.oneWay || tangentDot >= 0 ? 1 : -1;
        const edge = topology.graph.edges.find(item => item.roadId === record.roadId);
        const endpointNodeId = direction > 0 ? edge.toNodeId : edge.fromNodeId;
        const endpointNode = topology.nodesById.get(endpointNodeId);
        const junctionAhead = Boolean(endpointNode && endpointNode.roadIds.length >= (
          navigationSupportsMissionQueries(navigationDefinition) ? 2 : 3
        ));
        const junctionRadius = navigationJunctionRadiusWorld(rules, navigationDefinition);
        const shortEdgeNodeArrival = controlDefinition.controller.shortEdgeNodeArrival === true
          && junctionAhead
          // Include a 0.02-world-unit geometry/discretisation guard band
          // (0.25 cm on the 8-units/metre Guangyang maps). The controller
          // advances in 20ms steps, so an almost-touching pair of approach
          // ranges can otherwise still strand a caller at the entry node.
          && record.length <= junctionRadius * 2 + 0.02;
        // A short edge can be entirely covered by the two endpoint approach
        // radii.  Before v7, reaching the far approach boundary was reported
        // as the entry node, so a graph-based program could not select the
        // next legal exit.  In v7 only, complete that short edge to its actual
        // endpoint; longer roads retain the old early-at-junction behaviour.
        const boundaryProgress = shortEdgeNodeArrival
          ? (direction > 0 ? record.length : 0)
          : (direction > 0
            ? record.length - (junctionAhead ? junctionRadius : 0)
            : junctionAhead ? junctionRadius : 0);
        const available = direction > 0
          ? boundaryProgress - projection.progress
          : projection.progress - boundaryProgress;
        if (available <= EPSILON) {
          return this.result(true, junctionAhead ? "junction" : "road_end", record.roadId,
            startTick, startDistance);
        }
        const requested = navigationCmToWorld(action.args.maxCm, rules);
        const pathDistance = Math.min(requested, available);
        const targetProgress = projection.progress + direction * pathDistance;
        const completedBy = available <= requested + EPSILON
          ? junctionAhead ? "junction" : "road_end"
          : "max_distance";
        const path = navigationRoadPath(record, projection.progress, targetProgress);
        const stoppedBy = this.runPath(path, [record.roadId], action.args.speed,
          startTick, startDistance, completedBy, {
            ...options,
            maximumDistance: requested,
            obeySpeedLimit: action.args.obeySpeedLimit === true
          });
        return this.result(true, stoppedBy, record.roadId, startTick, startDistance);
      }

      const supportsEndpointTransitions = navigationSupportsMissionQueries(navigationDefinition);
      const atTransitionNode = supportsEndpointTransitions
        ? Boolean(roadState.atNode && roadState.nodeId)
        : Boolean(roadState.atJunction && roadState.junctionId);
      const transitionNodeId = supportsEndpointTransitions ? roadState.nodeId : roadState.junctionId;
      if (!roadState.onRoad || !atTransitionNode || !transitionNodeId) {
        return this.result(false, "not_at_junction", action.args.roadId, startTick, startDistance);
      }
      const selectedExit = roadState.exits.find(exit => exit.roadId === action.args.roadId);
      if (!selectedExit) {
        return this.result(false, "invalid_exit", action.args.roadId, startTick, startDistance);
      }
      const junction = topology.nodesById.get(transitionNodeId);
      const currentRecord = topology.recordsById.get(roadState.roadId);
      const targetRecord = topology.recordsById.get(action.args.roadId);
      const currentEndpoint = junction?.endpoints.find(endpoint => endpoint.roadId === roadState.roadId);
      const targetEndpoint = junction?.endpoints.find(endpoint => endpoint.roadId === action.args.roadId);
      if (!junction || !currentRecord || !targetRecord || !currentEndpoint || !targetEndpoint) {
        return this.result(false, "invalid_exit", action.args.roadId, startTick, startDistance);
      }
      const currentProjection = navigationRoadProjection(currentRecord, simulator.pose);
      if (currentRecord.oneWay && currentEndpoint.side === "start"
        && currentProjection.progress > 0.001 + EPSILON) {
        return this.result(false, "wrong_way", action.args.roadId, startTick, startDistance);
      }
      const approachProgress = currentEndpoint.side === "start" ? 0 : currentRecord.length;
      const exitDistance = Math.min(targetRecord.length, navigationContractCmToWorld(
        controlDefinition.controller.exitEntryCm,
        rules,
        navigationDefinition
      ));
      const targetProgress = targetEndpoint.side === "start"
        ? exitDistance
        : targetRecord.length - exitDistance;
      const path = navigationJoinPaths(
        navigationRoadPath(currentRecord, currentProjection.progress, approachProgress),
        [junction.point],
        navigationRoadPath(targetRecord,
          targetEndpoint.side === "start" ? 0 : targetRecord.length,
          targetProgress)
      );
      const stoppedBy = this.runPath(path, [currentRecord.roadId, targetRecord.roadId],
        action.args.speed ?? controlDefinition.controller.takeExitSpeed,
        startTick, startDistance, "entered_road", {
          ...options,
          obeySpeedLimit: action.args.obeySpeedLimit === true
        });
      return this.result(true, stoppedBy, targetRecord.roadId, startTick, startDistance);
    }
  }

  function decodeCanonicalBase64(value, label = "base64 payload") {
    if (typeof value !== "string") throw new TypeError(`${label} must be a base64 string`);
    const source = value.startsWith("data:image/png;base64,")
      ? value.slice("data:image/png;base64,".length)
      : value;
    if (!source || source.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(source)) {
      throw new TypeError(`${label} is not canonical base64`);
    }
    let bytes;
    if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
      bytes = Uint8Array.from(Buffer.from(source, "base64"));
      if (Buffer.from(bytes).toString("base64") !== source) throw new TypeError(`${label} is not canonical base64`);
    } else if (typeof atob === "function") {
      let binary;
      try {
        binary = atob(source);
      } catch (_error) {
        throw new TypeError(`${label} is not valid base64`);
      }
      bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      let canonical = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        canonical += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      if (btoa(canonical) !== source) throw new TypeError(`${label} is not canonical base64`);
    } else throw new Error("base64 decoding is unavailable");
    return { source, bytes };
  }

  function sha256Bytes(bytes) {
    const rightRotate = (value, amount) => (value >>> amount) | (value << (32 - amount));
    const maxWord = 2 ** 32;
    const words = [];
    const hash = [];
    const constants = [];
    const composite = {};
    let primeCounter = 0;
    for (let candidate = 2; primeCounter < 64; candidate += 1) {
      if (composite[candidate]) continue;
      for (let multiple = candidate * candidate; multiple < 312; multiple += candidate) composite[multiple] = true;
      if (primeCounter < 8) hash[primeCounter] = (Math.sqrt(candidate) * maxWord) | 0;
      constants[primeCounter] = (Math.cbrt(candidate) * maxWord) | 0;
      primeCounter += 1;
    }
    for (let index = 0; index < bytes.length; index += 1) {
      words[index >> 2] = (words[index >> 2] || 0) | bytes[index] << (24 - (index % 4) * 8);
    }
    const bitLength = bytes.length * 8;
    words[bitLength >> 5] = (words[bitLength >> 5] || 0) | 0x80 << (24 - bitLength % 32);
    words[((bitLength + 64 >> 9) << 4) + 15] = bitLength;
    for (let block = 0; block < words.length; block += 16) {
      const working = hash.slice(0);
      const schedule = [];
      for (let index = 0; index < 64; index += 1) {
        let word = words[block + index] || 0;
        if (index >= 16) {
          const sigma0 = rightRotate(schedule[index - 15], 7) ^ rightRotate(schedule[index - 15], 18)
            ^ (schedule[index - 15] >>> 3);
          const sigma1 = rightRotate(schedule[index - 2], 17) ^ rightRotate(schedule[index - 2], 19)
            ^ (schedule[index - 2] >>> 10);
          word = (sigma0 + schedule[index - 16] + sigma1 + schedule[index - 7]) | 0;
        }
        schedule[index] = word;
        const choice = working[4] & working[5] ^ ~working[4] & working[6];
        const majority = working[0] & working[1] ^ working[0] & working[2] ^ working[1] & working[2];
        const temporary1 = (working[7]
          + (rightRotate(working[4], 6) ^ rightRotate(working[4], 11) ^ rightRotate(working[4], 25))
          + choice + constants[index] + word) | 0;
        const temporary2 = ((rightRotate(working[0], 2) ^ rightRotate(working[0], 13) ^ rightRotate(working[0], 22))
          + majority) | 0;
        working.pop();
        working.unshift((temporary1 + temporary2) | 0);
        working[4] = (working[4] + temporary1) | 0;
      }
      for (let index = 0; index < 8; index += 1) hash[index] = (hash[index] + working[index]) | 0;
    }
    return hash.map(value => (value >>> 0).toString(16).padStart(8, "0")).join("");
  }

  function pngCrc32(bytes, start, end) {
    if (!pngCrc32.table) {
      pngCrc32.table = Array.from({ length: 256 }, (_, value) => {
        let entry = value;
        for (let bit = 0; bit < 8; bit += 1) {
          entry = (entry >>> 1) ^ (entry & 1 ? 0xedb88320 : 0);
        }
        return entry >>> 0;
      });
    }
    let crc = 0xffffffff;
    for (let index = start; index < end; index += 1) {
      crc = pngCrc32.table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function normalizeVisionEvidence(input = {}, defaults = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("vision evidence must be an object");
    }
    if (input.schemaVersion !== undefined && input.schemaVersion !== VISION_EVIDENCE_SCHEMA_VERSION) {
      throw new TypeError(`unsupported vision evidence schema: ${String(input.schemaVersion)}`);
    }
    const evidenceId = String(input.evidenceId ?? defaults.evidenceId ?? "").trim();
    if (!evidenceId || evidenceId.length > 128) throw new TypeError("vision evidenceId must be 1-128 characters");
    const frameId = input.frameId ?? defaults.frameId ?? null;
    if (frameId !== null && !(typeof frameId === "string" || Number.isSafeInteger(frameId))) {
      throw new TypeError("vision frameId must be a string, safe integer, or null");
    }
    if (typeof frameId === "string" && (!frameId.trim() || frameId.length > 128)) {
      throw new TypeError("vision frameId must be 1-128 characters");
    }
    const payload = input.pngBase64 ?? input.payloadBase64 ?? input.payload ?? input.dataUrl;
    const encodedPayload = typeof payload === "string" && payload.startsWith("data:image/png;base64,")
      ? payload.slice("data:image/png;base64,".length)
      : payload;
    if (typeof encodedPayload === "string"
      && encodedPayload.length > Math.ceil(MAX_VISION_FRAME_BYTES / 3) * 4) {
      throw new RangeError(`vision PNG exceeds the ${MAX_VISION_FRAME_BYTES} byte frame limit`);
    }
    const decoded = decodeCanonicalBase64(payload, "vision PNG payload");
    if (decoded.bytes.length > MAX_VISION_FRAME_BYTES) {
      throw new RangeError(`vision PNG exceeds the ${MAX_VISION_FRAME_BYTES} byte frame limit`);
    }
    const sha256 = sha256Bytes(decoded.bytes);
    const providedHash = input.sha256 ?? input.pixelSha256;
    if (providedHash !== undefined && String(providedHash).toLowerCase() !== sha256) {
      throw new TypeError("vision evidence SHA-256 does not match PNG payload");
    }
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (decoded.bytes.length < 33 || signature.some((value, index) => decoded.bytes[index] !== value)) {
      throw new TypeError("vision evidence payload must be a complete PNG");
    }
    const readUint32 = offset => (
      decoded.bytes[offset] * 0x1000000
      + decoded.bytes[offset + 1] * 0x10000
      + decoded.bytes[offset + 2] * 0x100
      + decoded.bytes[offset + 3]
    );
    const width = readUint32(16);
    const height = readUint32(20);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > MAX_VISION_DIMENSION || height > MAX_VISION_DIMENSION) {
      throw new RangeError(`vision PNG dimensions must be between 1 and ${MAX_VISION_DIMENSION}`);
    }
    let offset = 8;
    let chunkCount = 0;
    let ihdrCount = 0;
    let idatCount = 0;
    let sawIend = false;
    while (offset < decoded.bytes.length) {
      chunkCount += 1;
      if (chunkCount > 10000) throw new RangeError("vision PNG exceeds the chunk safety limit");
      if (offset + 12 > decoded.bytes.length) throw new TypeError("vision PNG chunk is truncated");
      const length = readUint32(offset);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      const chunkEnd = dataEnd + 4;
      if (!Number.isSafeInteger(chunkEnd) || chunkEnd > decoded.bytes.length) {
        throw new TypeError("vision PNG chunk length exceeds the payload");
      }
      const type = String.fromCharCode(...decoded.bytes.subarray(offset + 4, offset + 8));
      const expectedCrc = readUint32(dataEnd) >>> 0;
      const actualCrc = pngCrc32(decoded.bytes, offset + 4, dataEnd);
      if (expectedCrc !== actualCrc) throw new TypeError(`vision PNG chunk ${type} has an invalid CRC`);
      if (chunkCount === 1 && (type !== "IHDR" || length !== 13)) {
        throw new TypeError("vision PNG must start with a 13-byte IHDR chunk");
      }
      if (type === "IHDR") {
        ihdrCount += 1;
        if (ihdrCount > 1 || chunkCount !== 1 || length !== 13) {
          throw new TypeError("vision PNG must contain exactly one leading IHDR chunk");
        }
      } else if (type === "IDAT") idatCount += 1;
      else if (type === "IEND") {
        if (length !== 0) throw new TypeError("vision PNG IEND chunk must be empty");
        sawIend = true;
        if (chunkEnd !== decoded.bytes.length) throw new TypeError("vision PNG has trailing data after IEND");
      }
      offset = chunkEnd;
      if (sawIend) break;
    }
    if (ihdrCount !== 1 || idatCount < 1 || !sawIend || offset !== decoded.bytes.length) {
      throw new TypeError("vision evidence payload must be a complete PNG with IDAT and IEND chunks");
    }
    if (input.width !== undefined && input.width !== width) throw new TypeError("vision evidence width does not match PNG IHDR");
    if (input.height !== undefined && input.height !== height) throw new TypeError("vision evidence height does not match PNG IHDR");
    if (input.byteLength !== undefined && input.byteLength !== decoded.bytes.length) {
      throw new TypeError("vision evidence byteLength does not match PNG payload");
    }
    const tick = input.tick ?? defaults.tick ?? null;
    if (tick !== null && (!Number.isSafeInteger(tick) || tick < 0)) {
      throw new TypeError("vision evidence tick must be a non-negative safe integer or null");
    }
    const stateRevision = input.stateRevision ?? defaults.stateRevision ?? 0;
    if (!Number.isSafeInteger(stateRevision) || stateRevision < 0) {
      throw new TypeError("vision evidence stateRevision must be a non-negative safe integer");
    }
    const normalized = {
      schemaVersion: VISION_EVIDENCE_SCHEMA_VERSION,
      evidenceId,
      frameId,
      tick,
      stateRevision,
      mimeType: "image/png",
      width,
      height,
      byteLength: decoded.bytes.length,
      sha256,
      pngBase64: decoded.source
    };
    ["cameraDefinitionHash", "detectorDefinitionHash"].forEach(key => {
      if (input[key] === undefined || input[key] === null) return;
      const value = String(input[key]).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`vision ${key} must be a SHA-256 hex digest`);
      normalized[key] = value;
    });
    return normalized;
  }

  function replayFrameFromSample(sample, index) {
    return {
      tick: Number.isInteger(sample?.tick)
        ? sample.tick
        : Number.isInteger(sample?.simulationTick) ? sample.simulationTick : index,
      elapsedMs: Number(sample?.t) || 0,
      x: Number(sample?.x) || 0,
      z: Number(sample?.z) || 0,
      heading: Number(sample?.heading) || 0,
      linearSpeed: Number(sample?.speed) || 0,
      angularSpeed: Number(sample?.steering) || 0,
      telemetry: true
    };
  }

  class ReplayPlayer {
    constructor(record = {}) {
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new TypeError("replay record must be an object");
      this.diagnostics = [];
      const replayFields = [
        "schemaVersion", "mapId", "mapVersion", "ruleVersion", "runDefinition", "simulationDefinition", "interactionDefinition", "taskDefinition",
        "ruleDefinition", "scoringDefinition", "navigationDefinition", "navigationControlDefinition", "randomSeed",
        "simulationEndTick", "inputs", "visionFrames",
        "samples", "events", "result"
      ];
      const arrayLimits = {
        inputs: MAX_REPLAY_INPUTS,
        visionFrames: MAX_VISION_FRAMES,
        samples: MAX_REPLAY_SAMPLES,
        events: MAX_REPLAY_EVENTS
      };
      try {
        const selected = {};
        replayFields.forEach(key => {
          if (!Object.prototype.hasOwnProperty.call(record, key)) return;
          const value = record[key];
          const limit = arrayLimits[key];
          if (key === "visionFrames" && Array.isArray(value)) {
            if (value.length > MAX_VISION_FRAMES) {
              this.diagnostics.push(`record visionFrames exceeds the ${MAX_VISION_FRAMES} item replay limit`);
            }
            const allowed = [
              "schemaVersion", "evidenceId", "frameId", "tick", "stateRevision", "mimeType", "width", "height",
              "byteLength", "sha256", "pixelSha256", "pngBase64", "payloadBase64", "payload", "dataUrl",
              "cameraDefinitionHash", "detectorDefinitionHash", "seq", "t"
            ];
            const maximumEncodedFrame = Math.ceil(MAX_VISION_FRAME_BYTES / 3) * 4
              + "data:image/png;base64,".length;
            const maximumEncodedRun = Math.ceil(MAX_VISION_TOTAL_BYTES / 3) * 4
              + MAX_VISION_FRAMES * "data:image/png;base64,".length;
            let encodedRunLength = 0;
            selected[key] = value.slice(0, MAX_VISION_FRAMES).map((frame, index) => {
              if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
              const safe = {};
              allowed.forEach(field => {
                if (!Object.prototype.hasOwnProperty.call(frame, field)) return;
                const candidate = frame[field];
                const isPayload = ["pngBase64", "payloadBase64", "payload", "dataUrl"].includes(field);
                if (isPayload && typeof candidate === "string") {
                  encodedRunLength += candidate.length;
                  if (candidate.length > maximumEncodedFrame || encodedRunLength > maximumEncodedRun) {
                    this.diagnostics.push(`vision frame ${index} exceeds the encoded replay budget`);
                    safe[field] = "";
                    return;
                  }
                }
                if (candidate === null || ["string", "number", "boolean"].includes(typeof candidate)) {
                  safe[field] = candidate;
                }
              });
              return safe;
            });
            return;
          }
          if (Number.isInteger(limit) && Array.isArray(value) && value.length > limit) {
            this.diagnostics.push(`record ${key} exceeds the ${limit} item replay limit`);
            selected[key] = value.slice(0, limit);
          } else selected[key] = value;
        });
        this.record = clone(selected);
      } catch (error) {
        this.record = {};
        this.diagnostics.push(`record could not be safely copied: ${error.message}`);
      }
      this.mode = "telemetry";
      this.frames = [];
      this.replayCollisions = [];
      this.cursor = 0;
      this.simulator = null;
      this.mismatches = [];
      this.derivedAnalysis = {
        task: null,
        taskEvents: [],
        objectState: null,
        violations: [],
        violationMetrics: {},
        taskRecomputed: false,
        rulesRecomputed: false,
        externalEventsRecomputed: false,
        externalTerminationRecomputed: false,
        interactionsRecomputed: false,
        manualControlRecomputed: false,
        navigationQueriesRecomputed: true,
        navigationControlsRecomputed: true,
        visionEvidenceVerified: false,
        visionDetectionsRecomputed: false,
        scoreRecomputed: false,
        recomputationComplete: false,
        recomputedResult: null,
        resultMismatches: []
      };
      if (this.record.schemaVersion === SCHEMA_VERSION) {
        this.buildV4Replay();
      } else if (this.record.schemaVersion === DETERMINISTIC_LEGACY_SCHEMA_VERSION) {
        this.buildDeterministicReplay();
      } else this.buildTelemetryReplay();
    }

    buildV4Replay() {
      this.mode = "deterministic";
      const fallbackFrames = () => {
        this.frames = Array.isArray(this.record.samples)
          ? this.record.samples.map(replayFrameFromSample)
          : [];
      };
      const runDefinition = this.record.runDefinition && typeof this.record.runDefinition === "object"
        ? this.record.runDefinition
        : {};
      const hasCanonicalRunDefinition = Boolean(this.record.runDefinition
        && typeof this.record.runDefinition === "object" && !Array.isArray(this.record.runDefinition));
      const hasVisionDefinition = Object.prototype.hasOwnProperty.call(runDefinition, "visionDefinition");
      let visionDefinition = null;
      if (hasVisionDefinition) {
        try {
          visionDefinition = normalizeVisionDefinition(runDefinition.visionDefinition);
        } catch (error) {
          this.diagnostics.push(`vision definition is invalid: ${error.message}`);
        }
      }
      const hasNavigationDefinition = Object.prototype.hasOwnProperty.call(runDefinition, "navigationDefinition");
      let navigationDefinition = null;
      if (hasNavigationDefinition) {
        try {
          navigationDefinition = normalizeNavigationDefinition(runDefinition.navigationDefinition);
        } catch (error) {
          this.diagnostics.push(`navigation definition is invalid: ${error.message}`);
        }
      }
      const hasNavigationControlDefinition = Object.prototype.hasOwnProperty.call(
        runDefinition, "navigationControlDefinition"
      );
      let navigationControlDefinition = null;
      if (hasNavigationControlDefinition) {
        try {
          navigationControlDefinition = normalizeNavigationControlDefinition(
            runDefinition.navigationControlDefinition
          );
          if (!navigationSupportsRoadTopology(navigationDefinition)
            || navigationControlDefinition.navigationSchemaVersion !== navigationDefinition.schemaVersion) {
            throw new TypeError("navigation controls require a matching navigation v2 or v3 sensor contract");
          }
        } catch (error) {
          navigationControlDefinition = null;
          this.diagnostics.push(`navigation control definition is invalid: ${error.message}`);
        }
      }
      const timeLimitTicks = runDefinition.timeLimitTicks;
      const definitionFor = key => runDefinition[key] ?? this.record[key] ?? null;
      const simulationDefinition = definitionFor("simulationDefinition");
      const interactionDefinition = definitionFor("interactionDefinition");
      const taskDefinition = definitionFor("taskDefinition");
      const ruleDefinition = definitionFor("ruleDefinition");
      const scoringDefinition = definitionFor("scoringDefinition");
      ["simulationDefinition", "interactionDefinition", "taskDefinition", "ruleDefinition", "scoringDefinition",
        "navigationDefinition", "navigationControlDefinition"]
        .forEach(key => {
          if (runDefinition[key] !== undefined && this.record[key] !== undefined
            && JSON.stringify(runDefinition[key]) !== JSON.stringify(this.record[key])) {
            this.diagnostics.push(`record ${key} does not match runDefinition`);
          }
        });
      if (!simulationDefinition || typeof simulationDefinition !== "object") {
        this.diagnostics.push("v4 record is missing its simulation definition");
        fallbackFrames();
        return;
      }
      if (simulationDefinition.schemaVersion !== SIMULATION_SCHEMA_VERSION) {
        this.diagnostics.push(`simulation definition must declare ${SIMULATION_SCHEMA_VERSION}`);
      }
      if (simulationDefinition.vehicle?.version !== VEHICLE_MODEL_VERSION) {
        this.diagnostics.push(`simulation definition must declare ${VEHICLE_MODEL_VERSION}`);
      }
      if (!Array.isArray(this.record.inputs)) {
        this.diagnostics.push("v4 record inputs must be an array");
        fallbackFrames();
        return;
      }
      if (!Array.isArray(this.record.samples)) this.diagnostics.push("v4 record samples must be an array");
      if (!Array.isArray(this.record.events)) this.diagnostics.push("v4 record events must be an array");
      if (!Array.isArray(this.record.visionFrames)) this.record.visionFrames = [];
      if (this.record.inputs.length === 0 && (!Array.isArray(this.record.samples) || this.record.samples.length === 0)) {
        this.diagnostics.push("v4 record contains neither control inputs nor telemetry samples");
      }
      try {
        this.simulator = new DeterministicSimulator(simulationDefinition);
      } catch (error) {
        this.diagnostics.push(`simulation definition is invalid: ${error.message}`);
        fallbackFrames();
        return;
      }
      if (Object.prototype.hasOwnProperty.call(this.record, "randomSeed")) {
        const randomSeed = this.record.randomSeed;
        if (!Number.isSafeInteger(randomSeed) || randomSeed < 0 || randomSeed > 0xffffffff
          || randomSeed !== this.simulator.config.seed) {
          this.diagnostics.push("record randomSeed does not match the simulation definition seed");
        }
      }

      let packageEngine = null;
      if (interactionDefinition) {
        try {
          packageEngine = new PackageStateEngine(interactionDefinition, simulationDefinition);
        } catch (error) {
          this.diagnostics.push(`interaction definition is invalid: ${error.message}`);
        }
      }
      const packageInputPresent = this.record.inputs.some(input => input?.type === "package_grab"
        || input?.type === "package_release");
      if (packageInputPresent && !packageEngine) {
        this.diagnostics.push("v4 package inputs require an interaction definition");
      }
      this.derivedAnalysis.interactionsRecomputed = Boolean(packageEngine)
        || (!packageInputPresent && !taskRequiresInteractionDefinition(taskDefinition));
      const navigationInputPresent = this.record.inputs.some(input => input?.type === "navigation_query");
      if (navigationInputPresent && !navigationDefinition) {
        this.derivedAnalysis.navigationQueriesRecomputed = false;
        this.diagnostics.push("v4 navigation queries require a frozen navigation definition");
      }
      const navigationControlInputs = this.record.inputs.filter(input => input?.type === "navigation_control");
      if (navigationControlInputs.length > MAX_NAVIGATION_CONTROLS) {
        this.derivedAnalysis.navigationControlsRecomputed = false;
        this.diagnostics.push(`v4 navigation controls exceed the ${MAX_NAVIGATION_CONTROLS} action limit`);
      }
      if (navigationControlInputs.length && (!navigationDefinition || !navigationControlDefinition)) {
        this.derivedAnalysis.navigationControlsRecomputed = false;
        this.diagnostics.push("v4 navigation controls require frozen navigation sensor and control definitions");
      }
      let replayNavigationTopology = null;
      const navigationTopologyForReplay = () => {
        if (!replayNavigationTopology) {
          replayNavigationTopology = buildNavigationTopology(ruleDefinition || {}, navigationDefinition);
        }
        return replayNavigationTopology;
      };

      const evidenceById = new Map();
      let evidenceBytes = 0;
      let visionEvidenceVerified = true;
      this.record.visionFrames.forEach((frame, index) => {
        try {
          const normalized = normalizeVisionEvidence(frame);
          if (visionDefinition) {
            if (normalized.cameraDefinitionHash !== CAMERA_DEFINITION_HASH) {
              throw new TypeError("vision evidence cameraDefinitionHash does not match the frozen camera definition");
            }
            if (normalized.detectorDefinitionHash !== DETECTOR_DEFINITION_HASH) {
              throw new TypeError("vision evidence detectorDefinitionHash does not match the frozen detector definition");
            }
          }
          if (evidenceById.has(normalized.evidenceId)) throw new TypeError("duplicated evidenceId");
          if (!Number.isSafeInteger(frame.seq) || frame.seq <= 0) {
            throw new TypeError("vision evidence requires a positive global sequence number");
          }
          if (!Number.isSafeInteger(normalized.tick) || normalized.tick < 0
            || typeof frame.t !== "number" || !Number.isFinite(frame.t)
            || Math.abs(frame.t - normalized.tick * this.simulator.config.stepMs) > 0.001 + EPSILON) {
            throw new TypeError("vision evidence time must match its simulation tick");
          }
          evidenceBytes += normalized.byteLength;
          if (evidenceBytes > MAX_VISION_TOTAL_BYTES) {
            throw new RangeError(`vision evidence exceeds the ${MAX_VISION_TOTAL_BYTES} byte run limit`);
          }
          evidenceById.set(normalized.evidenceId, { ...normalized, seq: frame.seq, t: frame.t });
        } catch (error) {
          visionEvidenceVerified = false;
          this.diagnostics.push(`vision frame ${index} is invalid: ${error.message}`);
        }
      });

      const timeline = [
        ...this.record.inputs,
        ...(Array.isArray(this.record.visionFrames) ? this.record.visionFrames : []),
        ...(Array.isArray(this.record.samples) ? this.record.samples : []),
        ...(Array.isArray(this.record.events) ? this.record.events : [])
      ];
      const sequences = new Set();
      timeline.forEach((item, index) => {
        if (!Number.isSafeInteger(item?.seq) || item.seq <= 0) {
          this.diagnostics.push(`timeline item ${index} has no valid sequence number`);
        } else if (sequences.has(item.seq)) {
          this.diagnostics.push(`timeline sequence ${item.seq} is duplicated`);
        } else sequences.add(item.seq);
      });
      const validateLedgerOrder = (records, label, requireMonotonicTime = false) => {
        let priorSequence = -Infinity;
        let priorTime = -Infinity;
        records.forEach((item, index) => {
          if (!Number.isSafeInteger(item?.seq) || item.seq <= priorSequence) {
            this.diagnostics.push(`${label} ${index} is not in monotonic sequence order`);
          }
          if (typeof item?.t !== "number" || !Number.isFinite(item.t) || item.t < 0) {
            this.diagnostics.push(`${label} ${index} has an invalid time`);
          } else if (requireMonotonicTime && item.t + 0.001 < priorTime) {
            this.diagnostics.push(`${label} ${index} is not in monotonic time order`);
          }
          priorSequence = Number(item?.seq);
          priorTime = Number(item?.t);
        });
      };
      validateLedgerOrder(Array.isArray(this.record.visionFrames) ? this.record.visionFrames : [], "vision frame", true);
      validateLedgerOrder(Array.isArray(this.record.events) ? this.record.events : [], "event");

      const staticWorld = {
        bounds: clone(this.simulator.config.world.bounds),
        colliders: this.simulator.config.world.colliders.filter(collider => (
          !String(collider.id).startsWith("package:")
          && !String(collider.id).startsWith("package-stack:")
          && !String(collider.id).startsWith("object:")
        )).map(clone)
      };
      this.simulator.config.world.colliders.forEach(collider => {
        if (String(collider.id).startsWith("package:") || String(collider.id).startsWith("package-stack:")
          || String(collider.id).startsWith("object:")) {
          this.diagnostics.push(`v4 static simulation world contains reserved package collider ${collider.id}`);
        }
      });
      const syncPackageWorld = () => {
        if (!packageEngine) return;
        this.simulator.setWorld({
          bounds: staticWorld.bounds,
          colliders: [...staticWorld.colliders, ...packageEngine.colliders()]
        });
      };
      try {
        syncPackageWorld();
      } catch (error) {
        this.diagnostics.push(`package collision world is invalid: ${error.message}`);
        packageEngine = null;
        this.derivedAnalysis.interactionsRecomputed = false;
      }

      let taskEngine = null;
      let ruleEngine = null;
      let judge = null;
      const estimatedTicks = Number.isSafeInteger(this.record.simulationEndTick)
        ? Math.min(MAX_REPLAY_TICKS, this.record.simulationEndTick) + this.record.inputs.length + 1
        : Math.min(MAX_REPLAY_TICKS, this.record.inputs.reduce((sum, input) => (
            sum + (Number.isSafeInteger(input?.command?.durationTicks)
              ? input.command.durationTicks
              : input?.type === "navigation_control"
                ? navigationControlDefinition?.controller?.maxActionTicks ?? MAX_SIMULATION_COMMAND_TICKS
                : 0) + 1
          ), 1));
      const taskGeometry = taskAnalysisGeometry(taskDefinition);
      const roads = Array.isArray(ruleDefinition?.roads) ? ruleDefinition.roads : [];
      const ruleGeometry = roads.reduce((sum, road) => (
        sum + Math.max(1, Array.isArray(road?.points) ? road.points.length - 1 : 1)
      ), 0) + ["trafficLights", "speedZones", "prohibitedZones"].reduce((sum, key) => (
        sum + (Array.isArray(ruleDefinition?.[key]) ? ruleDefinition[key].length : 0)
      ), 0);
      try {
        if (taskDefinition && estimatedTicks * taskGeometry > MAX_REPLAY_ANALYSIS_WORK) {
          this.diagnostics.push(`task replay exceeds the ${MAX_REPLAY_ANALYSIS_WORK} operation analysis limit`);
        } else if (taskDefinition) {
          taskEngine = new TaskEngine(taskDefinition);
          validateRoadClearancePlacementRules(taskEngine.config, ruleDefinition || {});
        }
      } catch (error) {
        taskEngine = null;
        this.diagnostics.push(`task definition is invalid: ${error.message}`);
      }
      if (taskRequiresInteractionDefinition(taskEngine?.config)) {
        try {
          validateDeliveryInteractionDefinition(taskEngine.config, packageEngine?.config || null);
        } catch (error) {
          this.diagnostics.push(`task and interaction definitions are incompatible: ${error.message}`);
          taskEngine = null;
        }
      }
      try {
        if (ruleDefinition && estimatedTicks * Math.max(1, ruleGeometry) > MAX_REPLAY_ANALYSIS_WORK) {
          this.diagnostics.push(`rule replay exceeds the ${MAX_REPLAY_ANALYSIS_WORK} operation analysis limit`);
        } else if (ruleDefinition) ruleEngine = new RuleEngine(ruleDefinition);
      } catch (error) {
        this.diagnostics.push(`rule definition is invalid: ${error.message}`);
      }
      try {
        judge = new CompetitionJudge(scoringDefinition || {});
      } catch (error) {
        this.diagnostics.push(`scoring definition is invalid: ${error.message}`);
      }

      this.frames = [];
      this.replayCollisions = [];
      let simulatorPathCursor = 0;
      let previousRuleSample = null;
      let lastEvaluationSample = null;
      let taskState = taskEngine?.snapshot() || null;
      const taskEvents = [];
      const violations = [];
      const evaluateFrame = frame => {
        const packageState = packageEngine ? packageEngine.snapshot() : { holding: null, packages: [] };
        frame.holding = packageState.holding;
        frame.packages = clone(packageState.packages);
        const sample = {
          tick: frame.tick,
          elapsedMs: frame.elapsedMs,
          t: frame.elapsedMs,
          x: frame.x,
          z: frame.z,
          heading: frame.heading,
          speed: Math.abs(frame.linearSpeed),
          steering: frame.angularSpeed,
          holding: packageState.holding,
          packages: clone(packageState.packages)
        };
        const beforeTimeLimit = !Number.isSafeInteger(timeLimitTicks) || frame.tick < timeLimitTicks;
        if (taskEngine && beforeTimeLimit && frame.collision) {
          taskEngine.noteCollision(frame.collision.colliderId);
        }
        if (taskEngine && beforeTimeLimit) {
          try {
            const taskResult = taskEngine.evaluate(sample, sample.elapsedMs);
            taskState = taskResult.state;
            taskEvents.push(...taskResult.events);
          } catch (error) {
            this.diagnostics.push(`task replay failed: ${error.message}`);
            taskEngine = null;
          }
        }
        if (ruleEngine && beforeTimeLimit) {
          try {
            const ruleResult = ruleEngine.evaluate(sample, previousRuleSample, sample.elapsedMs);
            violations.push(...ruleResult.violations.map(violation => ({
              ...violation,
              t: sample.elapsedMs,
              tick: frame.tick
            })));
            previousRuleSample = sample;
          } catch (error) {
            this.diagnostics.push(`rule replay failed: ${error.message}`);
            ruleEngine = null;
          }
        }
        if (frame.collision && beforeTimeLimit) {
          violations.push({
            type: "collision",
            t: frame.collision.elapsedMs,
            tick: frame.collision.tick,
            colliderId: frame.collision.colliderId,
            x: frame.collision.x,
            z: frame.collision.z
          });
        }
        lastEvaluationSample = sample;
      };
      const appendSimulatorFrames = (evaluateSettled = true) => {
        while (simulatorPathCursor < this.simulator.path.length) {
          const frame = clone(this.simulator.path[simulatorPathCursor]);
          simulatorPathCursor += 1;
          if (evaluateSettled || !frame.settled) evaluateFrame(frame);
          this.frames.push(frame);
        }
      };
      const appendPhaseFrame = (phase, input, detail = {}) => {
        const frame = this.simulator.frameSnapshot({
          phase,
          inputSeq: input.seq,
          stateRevision: input.stateRevision ?? 0,
          ...clone(detail)
        });
        evaluateFrame(frame);
        this.frames.push(frame);
      };
      appendSimulatorFrames();

      let replayWork = 0;
      const reserveWork = usesColliders => {
        const work = usesColliders ? Math.max(1, this.simulator.world.colliders.length) : 1;
        if (replayWork + work > MAX_SIMULATION_WORK) {
          throw new RangeError(`replay exceeds the ${MAX_SIMULATION_WORK} operation safety limit`);
        }
        replayWork += work;
      };
      const stepOnce = () => {
        if (this.simulator.tick >= MAX_REPLAY_TICKS) {
          throw new RangeError(`replay exceeds the ${MAX_REPLAY_TICKS} tick safety limit`);
        }
        reserveWork(this.simulator.activeCommand?.command?.kind === "drive");
        this.simulator.step();
        appendSimulatorFrames();
      };
      const advanceToTick = targetTick => {
        if (!Number.isSafeInteger(targetTick) || targetTick < this.simulator.tick || targetTick > MAX_REPLAY_TICKS) {
          throw new RangeError(`invalid replay target tick ${targetTick}`);
        }
        while (this.simulator.tick < targetTick) {
          if (!this.simulator.hasActiveCommand()) {
            const waitTicks = targetTick - this.simulator.tick;
            this.simulator.startCommand({
              kind: "wait",
              durationTicks: waitTicks,
              durationMs: waitTicks * this.simulator.config.stepMs
            });
          }
          stepOnce();
        }
      };
      const verifyStartState = (input, index) => {
        if (input.startState === undefined) return;
        const state = input.startState;
        const expected = this.simulator.compactSnapshot();
        if (!state || typeof state !== "object" || Array.isArray(state)) {
          this.diagnostics.push(`input ${index} startState must be an object`);
          return;
        }
        const comparisons = [
          ["tick", expected.tick, state.tick, 0],
          ["pose.x", expected.pose.x, state.pose?.x, 0.0000005],
          ["pose.z", expected.pose.z, state.pose?.z, 0.0000005],
          ["pose.heading", expected.pose.heading, state.pose?.heading, 0.00005]
        ];
        comparisons.forEach(([field, expectedValue, actualValue, tolerance]) => {
          if (typeof actualValue !== "number" || !Number.isFinite(actualValue)
            || Math.abs(expectedValue - actualValue) > tolerance + EPSILON) {
            this.diagnostics.push(`input ${index} startState.${field} does not match deterministic state`);
          }
        });
      };

      let previousSequence = -Infinity;
      let previousTick = -Infinity;
      let manualInterventions = 0;
      let manualControlRecomputed = true;
      let manualFinishReason = null;
      let declaredRunEndReason = null;
      let navigationControlCount = 0;
      let aborted = false;
      const inputCount = Math.min(this.record.inputs.length, MAX_REPLAY_INPUTS);
      for (let index = 0; index < inputCount; index += 1) {
        const input = this.record.inputs[index];
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          this.diagnostics.push(`input ${index} must be an object`);
          continue;
        }
        if (!Number.isSafeInteger(input.seq) || input.seq <= 0 || input.seq <= previousSequence) {
          this.diagnostics.push(`input ${index} has an invalid sequence number`);
        }
        previousSequence = Number(input.seq);
        if (!Number.isSafeInteger(input.tick) || input.tick < 0 || input.tick < previousTick
          || input.tick > MAX_REPLAY_TICKS) {
          this.diagnostics.push(`input ${index} has an invalid start tick`);
          continue;
        }
        previousTick = input.tick;
        if (Number.isSafeInteger(this.record.simulationEndTick)
          && this.record.simulationEndTick >= 0
          && this.record.simulationEndTick <= MAX_REPLAY_TICKS
          && input.tick > this.record.simulationEndTick) {
          this.diagnostics.push(`input ${index} starts after simulationEndTick ${this.record.simulationEndTick}`);
          try {
            advanceToTick(this.record.simulationEndTick);
          } catch (error) {
            this.diagnostics.push(`final replay interval failed: ${error.message}`);
          }
          aborted = true;
          break;
        }
        const expectedTime = input.tick * this.simulator.config.stepMs;
        if (typeof input.t !== "number" || !Number.isFinite(input.t)
          || Math.abs(input.t - expectedTime) > 0.001 + EPSILON) {
          this.diagnostics.push(`input ${index} time does not match simulation tick ${input.tick}`);
        }
        try {
          advanceToTick(input.tick);
          if (Number.isSafeInteger(timeLimitTicks) && input.tick >= timeLimitTicks && input.type !== "run_end") {
            if (this.simulator.hasActiveCommand()) {
              this.simulator.cancelCommand();
              appendSimulatorFrames();
            }
            this.diagnostics.push(`input ${index} occurs at or after the run time limit and was not consumed`);
            break;
          }
          if (input.world !== undefined) this.diagnostics.push(`input ${index} world is forbidden in v4`);
          if (input.type === "control") {
            if (!input.command || typeof input.command !== "object" || Array.isArray(input.command)) {
              throw new TypeError("control input requires a command");
            }
            if (this.simulator.hasActiveCommand()) throw new Error("a previous control command is still active");
            verifyStartState(input, index);
            const command = this.simulator.normalizeCommand(clone(input.command));
            if (this.simulator.tick + command.durationTicks > MAX_REPLAY_TICKS) {
              throw new RangeError(`input ${index} exceeds the ${MAX_REPLAY_TICKS} tick replay limit`);
            }
            this.simulator.startCommand(command);
          } else if (input.type === "package_grab" || input.type === "package_release") {
            if (!packageEngine) throw new Error("package interaction engine is unavailable");
            const allowedInteractionFields = new Set([
              "seq", "t", "tick", "type", "intent", "stateRevision", "source"
            ]);
            const forgedOutcomeFields = Object.keys(input).filter(key => !allowedInteractionFields.has(key));
            const intentIsEmpty = input.intent === undefined
              || (input.intent && typeof input.intent === "object" && !Array.isArray(input.intent)
                && Object.keys(input.intent).length === 0);
            if (!intentIsEmpty || forgedOutcomeFields.length) {
              this.diagnostics.push(`input ${index} contains forbidden claimed package interaction outcome`);
            }
            const outcome = packageEngine.apply(input.type, {}, this.simulator.pose);
            syncPackageWorld();
            appendPhaseFrame(input.type, input, {
              interaction: {
                accepted: outcome.accepted,
                reason: outcome.reason,
                packageId: outcome.packageId,
                objectRole: outcome.objectRole,
                obstacleId: outcome.obstacleId ?? null,
                position: outcome.position,
                stackLevel: outcome.stackLevel
              }
            });
          } else if (input.type === "manual_control") {
            const action = String(input.action || "").trim();
            if (!action) {
              manualControlRecomputed = false;
              throw new TypeError("manual_control input requires an action");
            }
            manualInterventions += 1;
            if (["stop", "stop_button", "reset", "reset_button", "cancel", "emergency_stop", "manual_stop"].includes(action)) {
              if (this.simulator.hasActiveCommand()) {
                this.simulator.cancelCommand();
                appendSimulatorFrames();
              }
              if (["stop", "stop_button", "emergency_stop", "manual_stop"].includes(action)) {
                manualFinishReason = "stopped";
              } else if (["reset", "reset_button"].includes(action)) manualFinishReason = "reset";
            }
            appendPhaseFrame("manual_control", input, { manualAction: action });
          } else if (input.type === "vision_query") {
            const evidence = input.evidenceId ? evidenceById.get(input.evidenceId) : null;
            if (!evidence || !Number.isSafeInteger(evidence.tick)
              || evidence.frameId !== input.frameId || evidence.tick > input.tick
              || (Number.isSafeInteger(evidence.seq) && evidence.seq >= input.seq)) {
              visionEvidenceVerified = false;
              this.diagnostics.push(`input ${index} vision query does not reference prior matching evidence`);
            }
            appendPhaseFrame("vision_query", input, {
              visionMethod: String(input.method || ""),
              evidenceId: input.evidenceId ?? null
            });
          } else if (input.type === "navigation_query") {
            const allowedFields = new Set(["seq", "t", "tick", "type", "method", "result"]);
            if (Object.keys(input).some(key => !allowedFields.has(key))) {
              this.derivedAnalysis.navigationQueriesRecomputed = false;
              this.diagnostics.push(`input ${index} navigation query contains unsupported fields`);
            }
            if (!navigationDefinition) {
              this.derivedAnalysis.navigationQueriesRecomputed = false;
              appendPhaseFrame("navigation_query", input, { navigationMethod: String(input.method || "") });
              continue;
            }
            const expectedResult = projectNavigationQuery(input.method, {
              pose: this.simulator.pose,
              initialPose: this.simulator.config.initialPose,
              distance: this.simulator.travelDistance,
              tick: this.simulator.tick,
              rules: ruleDefinition || {},
              navigationDefinition,
              roadTopology: navigationSupportsRoadTopology(navigationDefinition)
                && ["road_state", "map_graph", "mission"].includes(input.method)
                ? navigationTopologyForReplay()
                : null,
              world: this.simulator.world,
              vehicleRadius: this.simulator.config.vehicle.radius,
              taskDefinition,
              interactionDefinition,
              simulationDefinition,
              taskSnapshot: taskEngine?.snapshot() || null,
              packageSnapshot: packageEngine?.snapshot() || null,
              mapId: this.record.mapId,
              mapVersion: this.record.mapVersion
            });
            if (!exactJsonEqual(input.result, expectedResult)) {
              this.derivedAnalysis.navigationQueriesRecomputed = false;
              const mismatch = {
                inputIndex: index,
                field: "navigation_query.result",
                expected: clone(expectedResult),
                actual: clone(input.result)
              };
              this.mismatches.push(mismatch);
              this.diagnostics.push(`input ${index} navigation query result does not match deterministic state`);
            }
            appendPhaseFrame("navigation_query", input, {
              navigationMethod: String(input.method || ""),
              navigationResult: clone(expectedResult)
            });
          } else if (input.type === "navigation_control") {
            navigationControlCount += 1;
            if (navigationControlCount > MAX_NAVIGATION_CONTROLS) {
              this.derivedAnalysis.navigationControlsRecomputed = false;
              throw new RangeError(`navigation control exceeds the ${MAX_NAVIGATION_CONTROLS} action limit`);
            }
            const allowedFields = new Set(["seq", "t", "tick", "type", "method", "args", "result"]);
            if (Object.keys(input).some(key => !allowedFields.has(key))) {
              this.derivedAnalysis.navigationControlsRecomputed = false;
              this.diagnostics.push(`input ${index} navigation control contains unsupported fields`);
            }
            if (!navigationDefinition || !navigationControlDefinition) {
              this.derivedAnalysis.navigationControlsRecomputed = false;
              throw new Error("navigation control definitions are unavailable");
            }
            if (this.simulator.hasActiveCommand()) {
              throw new Error("a previous control command is still active");
            }
            const runner = new NavigationActionRunner(this.simulator, {
              rules: ruleDefinition || {},
              navigationDefinition,
              navigationControlDefinition,
              roadTopology: navigationTopologyForReplay()
            });
            const declaredEndTick = Number.isSafeInteger(this.record.simulationEndTick)
              ? this.record.simulationEndTick
              : MAX_REPLAY_TICKS;
            const expectedResult = runner.run(input.method, input.args, {
              maxTick: Math.min(
                MAX_REPLAY_TICKS,
                declaredEndTick,
                Number.isSafeInteger(timeLimitTicks) ? timeLimitTicks : MAX_REPLAY_TICKS
              ),
              beforeStep: command => reserveWork(command?.kind === "drive"),
              onStep: () => {
                appendSimulatorFrames(false);
                return !Number.isSafeInteger(timeLimitTicks) || this.simulator.tick < timeLimitTicks;
              }
            });
            try {
              normalizeNavigationControlResult(input.result, navigationControlDefinition);
            } catch (error) {
              this.derivedAnalysis.navigationControlsRecomputed = false;
              this.diagnostics.push(`input ${index} navigation control result is invalid: ${error.message}`);
            }
            if (!exactJsonEqual(input.result, expectedResult)) {
              this.derivedAnalysis.navigationControlsRecomputed = false;
              const mismatch = {
                inputIndex: index,
                field: "navigation_control.result",
                expected: clone(expectedResult),
                actual: clone(input.result)
              };
              this.mismatches.push(mismatch);
              this.diagnostics.push(`input ${index} navigation control result does not match deterministic state`);
            }
          } else if (input.type === "run_end") {
            const reason = String(input.reason || "").trim();
            const allowedFields = new Set(["seq", "t", "tick", "type", "reason", "source"]);
            if (!RUN_END_REASONS.has(reason)) throw new TypeError(`unsupported run end reason: ${reason || "missing"}`);
            if (Object.keys(input).some(key => !allowedFields.has(key))) {
              this.diagnostics.push(`input ${index} run_end contains unsupported fields`);
            }
            if (this.simulator.hasActiveCommand()) {
              this.simulator.cancelCommand();
              appendSimulatorFrames();
            }
            declaredRunEndReason = reason;
            this.derivedAnalysis.externalTerminationRecomputed = true;
            appendPhaseFrame("run_end", input, { runEndReason: reason });
            if (index + 1 < inputCount) this.diagnostics.push("record contains inputs after run_end");
            break;
          } else {
            this.diagnostics.push(`input ${index} has unsupported v4 type: ${String(input.type || "missing")}`);
          }
        } catch (error) {
          this.diagnostics.push(`input ${index} replay failed: ${error.message}`);
          if (this.simulator.hasActiveCommand()) {
            this.simulator.cancelCommand();
            appendSimulatorFrames();
          }
          aborted = true;
          break;
        }
      }
      this.derivedAnalysis.manualControlRecomputed = manualControlRecomputed;
      this.derivedAnalysis.visionEvidenceVerified = visionEvidenceVerified;

      let finalTick = null;
      if (this.record.simulationEndTick !== undefined && this.record.simulationEndTick !== null) {
        if (!Number.isSafeInteger(this.record.simulationEndTick) || this.record.simulationEndTick < 0
          || this.record.simulationEndTick > MAX_REPLAY_TICKS) {
          this.diagnostics.push(`simulationEndTick exceeds the ${MAX_REPLAY_TICKS} tick replay limit`);
        } else finalTick = this.record.simulationEndTick;
      }
      if (timeLimitTicks !== undefined && timeLimitTicks !== null
        && (!Number.isSafeInteger(timeLimitTicks) || timeLimitTicks < 0 || timeLimitTicks > MAX_REPLAY_TICKS)) {
        this.diagnostics.push("runDefinition.timeLimitTicks must be a supported non-negative safe integer");
      }
      if (!aborted) {
        try {
          if (finalTick !== null) {
            if (finalTick < this.simulator.tick) {
              this.diagnostics.push(`simulationEndTick ${finalTick} precedes replay tick ${this.simulator.tick}`);
            } else advanceToTick(finalTick);
            if (this.simulator.hasActiveCommand()) {
              this.simulator.cancelCommand();
              appendSimulatorFrames();
            }
          } else {
            while (this.simulator.hasActiveCommand()) stepOnce();
            finalTick = this.simulator.tick;
          }
        } catch (error) {
          this.diagnostics.push(`final replay interval failed: ${error.message}`);
        }
      }
      finalTick = this.simulator.tick;
      this.replayCollisions = clone(this.simulator.collisions);

      this.derivedAnalysis.task = taskState;
      this.derivedAnalysis.taskEvents = clone(taskEvents);
      this.derivedAnalysis.objectState = packageEngine ? packageEngine.snapshot() : null;
      this.derivedAnalysis.violations = clone(violations);
      this.derivedAnalysis.violationMetrics = ruleEngine
        ? ruleEngine.metrics(lastEvaluationSample?.elapsedMs ?? finalTick * this.simulator.config.stepMs)
        : {};
      this.derivedAnalysis.taskRecomputed = Boolean(taskEngine && taskState);
      this.derivedAnalysis.rulesRecomputed = Boolean(ruleEngine);
      this.derivedAnalysis.externalEventsRecomputed = true;

      const taskForScore = taskEngine?.taskState() || null;
      const definitionsComplete = Boolean(judge && taskForScore && ruleEngine)
        && (!taskRequiresInteractionDefinition(taskDefinition) || Boolean(packageEngine));
      if (definitionsComplete && hasCanonicalRunDefinition) {
        const durationMs = finalTick * this.simulator.config.stepMs;
        const result = judge.score({
          task: taskForScore,
          violations,
          violationMetrics: this.derivedAnalysis.violationMetrics,
          durationSeconds: durationMs / 1000,
          manualInterventions
        });
        const completedAtMs = Number(taskState?.completedAtMs);
        const completedInTime = taskForScore.finished && Number.isFinite(completedAtMs)
          && (!Number.isSafeInteger(timeLimitTicks)
            || completedAtMs < timeLimitTicks * this.simulator.config.stepMs);
        const externalDeclaredReason = declaredRunEndReason
          && !["completed", "timeout"].includes(declaredRunEndReason)
          ? declaredRunEndReason
          : null;
        const derivedReason = completedInTime
          ? "completed"
          : Number.isSafeInteger(timeLimitTicks) && finalTick >= timeLimitTicks
            ? "timeout"
            : externalDeclaredReason || manualFinishReason || "program_finished";
        result.reason = derivedReason;
        result.simulationTick = finalTick;
        if (declaredRunEndReason && declaredRunEndReason !== derivedReason) {
          this.diagnostics.push(`run_end reason ${declaredRunEndReason} does not match derived ${derivedReason}`);
        }
        this.derivedAnalysis.scoreRecomputed = true;
        this.derivedAnalysis.recomputedResult = result;
        const recorded = this.record.result;
        if (recorded && typeof recorded === "object") {
          const fields = [
            "score", "taskScore", "ruleScore", "autonomousScore", "efficiencyScore", "ruleDeduction",
            "eventDeduction", "durationDeduction", "durationSeconds", "completedTasks", "totalTasks",
            "taskValid", "taskFinished", "reason", "simulationTick"
          ];
          fields.forEach(field => {
            if (!Object.prototype.hasOwnProperty.call(recorded, field)) return;
            const expected = result[field];
            const actual = recorded[field];
            const matches = typeof expected === "number" && typeof actual === "number"
              ? Number.isFinite(actual) && Math.abs(expected - actual) <= 0.05 + EPSILON
              : expected === actual;
            if (!matches) {
              const mismatch = { field, expected, actual };
              this.derivedAnalysis.resultMismatches.push(mismatch);
              this.mismatches.push({ result: true, ...mismatch });
              this.diagnostics.push(`recorded result field ${field} does not match recomputed result`);
            }
          });
        }
      }
      const derivedAuditEvents = [];
      taskEvents.forEach(event => derivedAuditEvents.push({
        ...clone(event),
        t: event.elapsedMs,
        type: event.type
      }));
      this.frames.filter(frame => frame.phase === "package_grab" || frame.phase === "package_release")
        .forEach(frame => {
          const interaction = frame.interaction || {};
          derivedAuditEvents.push({
            type: interaction.accepted
              ? frame.phase === "package_grab" ? "package_grabbed" : "package_released"
              : "package_interaction_failed",
            t: frame.elapsedMs,
            interactionType: frame.phase,
            accepted: Boolean(interaction.accepted),
            reason: interaction.reason,
            packageId: interaction.packageId,
            objectRole: interaction.objectRole,
            obstacleId: interaction.obstacleId ?? null,
            position: interaction.position,
            stackLevel: interaction.stackLevel
          });
        });
      this.record.inputs.filter(input => input?.type === "manual_control").forEach(input => {
        derivedAuditEvents.push({ type: "manual_control", t: input.tick * this.simulator.config.stepMs, action: input.action });
      });
      violations.forEach(violation => derivedAuditEvents.push({
        type: "violation",
        t: violation.t ?? violation.elapsedMs,
        violationType: violation.type,
        colliderId: violation.colliderId,
        tick: violation.tick,
        x: violation.x,
        z: violation.z
      }));
      derivedAuditEvents.push({ type: "run_started", t: 0 });
      if (this.derivedAnalysis.recomputedResult) {
        derivedAuditEvents.push({
          type: "run_finished",
          t: finalTick * this.simulator.config.stepMs,
          reason: this.derivedAnalysis.recomputedResult.reason,
          score: this.derivedAnalysis.recomputedResult.score
        });
      }
      const auditedTypes = new Set([
        "run_started", "run_finished", "package_grabbed", "package_released", "package_interaction_failed",
        "manual_control", "violation", "checkpoint", "goal_reached", "package_delivered",
        "package_delivery_revoked", "task_completed"
      ]);
      const legacySampledAuditWindowMs = this.record.ruleVersion === "2026.08-configurable.4"
        ? DEFAULT_SAMPLE_INTERVAL_MS
        : 0.001;
      const sampledDerivedEventTypes = new Set([
        "violation", "checkpoint", "goal_reached", "package_delivered",
        "package_delivery_revoked", "task_completed"
      ]);
      const eventMatches = (recorded, expected) => {
        if (recorded.type !== expected.type) return false;
        if (typeof recorded.t !== "number" || !Number.isFinite(recorded.t)
          || typeof expected.t !== "number" || !Number.isFinite(expected.t)) return false;
        const eventTimeDelta = recorded.t - expected.t;
        const auditWindowMs = COMPOSITE_TASK_SCHEMA_VERSIONS.has(taskDefinition?.schemaVersion)
          ? 0.001
          : legacySampledAuditWindowMs;
        if (sampledDerivedEventTypes.has(recorded.type) && auditWindowMs > 0.001) {
          if (eventTimeDelta < -EPSILON || eventTimeDelta > auditWindowMs + EPSILON) return false;
        } else if (Math.abs(eventTimeDelta) > 0.001 + EPSILON) return false;
        const requiredFields = {
          run_finished: ["reason", "score"],
          package_grabbed: ["interactionType", "accepted", "reason", "packageId", "position", "stackLevel"],
          package_released: ["interactionType", "accepted", "reason", "packageId", "position", "stackLevel"],
          package_interaction_failed: ["interactionType", "accepted", "reason", "packageId", "position", "stackLevel"],
          manual_control: ["action"],
          violation: ["violationType"],
          checkpoint: ["index", "checkpointId"],
          goal_reached: ["x", "z"],
          package_delivered: ["packageId"],
          package_delivery_revoked: ["packageId"],
          task_completed: ["completed", "total"]
        }[recorded.type] || [];
        if (interactionDefinition?.schemaVersion === INTERACTION_SCHEMA_VERSION
          && ["package_grabbed", "package_released", "package_interaction_failed"].includes(recorded.type)) {
          requiredFields.push("objectRole");
        }
        if (interactionDefinition?.schemaVersion === INTERACTION_SCHEMA_VERSION
          && recorded.type === "package_interaction_failed" && recorded.reason === "blocked") {
          requiredFields.push("obstacleId");
        }
        if (COMPOSITE_TASK_SCHEMA_VERSIONS.has(taskDefinition?.schemaVersion)
          && taskDefinition?.type === "composite"
          && ["package_delivered", "package_delivery_revoked"].includes(recorded.type)) {
          requiredFields.push("deliveryId", "objectRole", "destinationRole");
        }
        if (requiredFields.some(field => !Object.prototype.hasOwnProperty.call(recorded, field)
          || !Object.prototype.hasOwnProperty.call(expected, field))) return false;
        const comparableFields = new Set([
          ...requiredFields,
          "packageId", "action", "violationType", "colliderId", "tick", "checkpointId", "index",
          "completed", "total", "reason", "score", "interactionType", "accepted", "position", "stackLevel",
          "objectRole", "obstacleId", "deliveryId", "destinationRole", "x", "z"
        ]);
        const valuesMatch = (left, right) => {
          if (Array.isArray(left) || Array.isArray(right)) {
            return Array.isArray(left) && Array.isArray(right) && left.length === right.length
              && left.every((value, index) => valuesMatch(value, right[index]));
          }
          if (typeof left === "number" || typeof right === "number") {
            return typeof left === "number" && Number.isFinite(left)
              && typeof right === "number" && Number.isFinite(right)
              && Math.abs(left - right) <= 0.000001 + EPSILON;
          }
          return left === right;
        };
        return [...comparableFields].every(field => !Object.prototype.hasOwnProperty.call(recorded, field)
          || valuesMatch(recorded[field], expected[field]));
      };
      const matchedDerivedEvents = new Set();
      (Array.isArray(this.record.events) ? this.record.events : []).forEach((event, index) => {
        if (!auditedTypes.has(event?.type)) return;
        const matchIndex = derivedAuditEvents.findIndex((expected, candidateIndex) => (
          !matchedDerivedEvents.has(candidateIndex) && eventMatches(event, expected)
        ));
        if (matchIndex >= 0) {
          matchedDerivedEvents.add(matchIndex);
          return;
        }
        const mismatch = { eventIndex: index, field: "event", expected: "derived event", actual: clone(event) };
        this.mismatches.push(mismatch);
        this.diagnostics.push(`recorded event ${index} does not match a recomputed event`);
      });
      derivedAuditEvents.forEach((event, index) => {
        if (!auditedTypes.has(event?.type) || matchedDerivedEvents.has(index)) return;
        const mismatch = { derivedEventIndex: index, field: "event", expected: clone(event), actual: "missing recorded event" };
        this.mismatches.push(mismatch);
        this.diagnostics.push(`recomputed event ${index} is missing from the record`);
      });
      const hasVisionQueries = this.record.inputs.some(input => input?.type === "vision_query");
      const naturallyTerminated = ["completed", "timeout"].includes(this.derivedAnalysis.recomputedResult?.reason);
      this.derivedAnalysis.recomputationComplete = this.derivedAnalysis.scoreRecomputed
        && this.derivedAnalysis.interactionsRecomputed
        && this.derivedAnalysis.manualControlRecomputed
        && this.derivedAnalysis.navigationQueriesRecomputed
        && this.derivedAnalysis.navigationControlsRecomputed
        && (naturallyTerminated || this.derivedAnalysis.externalTerminationRecomputed)
        && this.derivedAnalysis.visionEvidenceVerified
        && (!hasVisionQueries || this.derivedAnalysis.visionDetectionsRecomputed);
      this.verifyTelemetrySamples();
    }

    buildTelemetryReplay() {
      this.mode = "telemetry";
      if (!Array.isArray(this.record.samples) || !this.record.samples.length) {
        this.diagnostics.push("record has no telemetry samples to replay");
        this.frames = [];
        return;
      }
      this.frames = this.record.samples.map(replayFrameFromSample);
      this.diagnostics.push("legacy telemetry playback cannot re-execute vehicle controls");
    }

    buildDeterministicReplay() {
      this.mode = "deterministic";
      if (this.record.schemaVersion !== DETERMINISTIC_LEGACY_SCHEMA_VERSION) {
        this.diagnostics.push(`legacy deterministic replay requires ${DETERMINISTIC_LEGACY_SCHEMA_VERSION}`);
      }
      const fallbackFrames = () => {
        this.frames = Array.isArray(this.record.samples)
          ? this.record.samples.map(replayFrameFromSample)
          : [];
      };
      if (!this.record.simulationDefinition || typeof this.record.simulationDefinition !== "object") {
        this.diagnostics.push("v3 record is missing its simulation definition");
        fallbackFrames();
        return;
      }
      if (this.record.simulationDefinition.schemaVersion !== SIMULATION_SCHEMA_VERSION) {
        this.diagnostics.push(`simulation definition must declare ${SIMULATION_SCHEMA_VERSION}`);
      }
      if (this.record.simulationDefinition.vehicle?.version !== VEHICLE_MODEL_VERSION) {
        this.diagnostics.push(`simulation definition must declare ${VEHICLE_MODEL_VERSION}`);
      }
      if (!Array.isArray(this.record.inputs)) {
        this.diagnostics.push("v3 record inputs must be an array");
        fallbackFrames();
        return;
      }
      if (!Array.isArray(this.record.samples)) this.diagnostics.push("v3 record samples must be an array");
      if (!Array.isArray(this.record.events)) this.diagnostics.push("v3 record events must be an array");
      if (this.record.inputs.length === 0 && (!Array.isArray(this.record.samples) || this.record.samples.length === 0)) {
        this.diagnostics.push("v3 record contains neither control inputs nor telemetry samples");
      }
      try {
        this.simulator = new DeterministicSimulator(this.record.simulationDefinition);
      } catch (error) {
        this.diagnostics.push(`simulation definition is invalid: ${error.message}`);
        fallbackFrames();
        return;
      }
      if (Object.prototype.hasOwnProperty.call(this.record, "randomSeed")) {
        const randomSeed = this.record.randomSeed;
        if (!Number.isSafeInteger(randomSeed) || randomSeed < 0 || randomSeed > 0xffffffff
          || randomSeed !== this.simulator.config.seed) {
          this.diagnostics.push("record randomSeed does not match the simulation definition seed");
        }
      }
      const seenSequences = new Set();
      const timeline = [
        ...(Array.isArray(this.record.inputs) ? this.record.inputs : []),
        ...(Array.isArray(this.record.samples) ? this.record.samples : []),
        ...(Array.isArray(this.record.events) ? this.record.events : [])
      ];
      timeline.forEach((item, index) => {
        if (!Number.isSafeInteger(item?.seq) || item.seq <= 0) {
          this.diagnostics.push(`timeline item ${index} has no valid sequence number`);
        } else if (seenSequences.has(item.seq)) {
          this.diagnostics.push(`timeline sequence ${item.seq} is duplicated`);
        } else seenSequences.add(item.seq);
      });
      let previousEventSequence = -Infinity;
      (Array.isArray(this.record.events) ? this.record.events : []).forEach((event, index) => {
        if (typeof event?.t !== "number" || !Number.isFinite(event.t) || event.t < 0) {
          this.diagnostics.push(`event ${index} has an invalid time`);
        }
        if (!Number.isSafeInteger(event?.seq) || event.seq <= previousEventSequence) {
          this.diagnostics.push(`event ${index} is not in monotonic sequence order`);
        }
        previousEventSequence = Number(event?.seq);
      });
      let previousSequence = -Infinity;
      let previousTick = -Infinity;
      const inputRecords = this.record.inputs;
      if (inputRecords.length > MAX_REPLAY_INPUTS) {
        this.diagnostics.push(`record exceeds the ${MAX_REPLAY_INPUTS} input replay limit`);
      }
      let maximumRecordedTick = Infinity;
      if (this.record.simulationEndTick !== null && this.record.simulationEndTick !== undefined) {
        if (!Number.isSafeInteger(this.record.simulationEndTick) || this.record.simulationEndTick < 0) {
          this.diagnostics.push("simulationEndTick must be a non-negative safe integer");
          maximumRecordedTick = 0;
        } else if (this.record.simulationEndTick > MAX_REPLAY_TICKS) {
          this.diagnostics.push(`simulationEndTick exceeds the ${MAX_REPLAY_TICKS} tick replay limit`);
          maximumRecordedTick = 0;
        } else maximumRecordedTick = this.record.simulationEndTick;
      }
      let replayWork = 0;
      const reserveReplayWork = (ticks, usesColliders = false) => {
        const work = Math.max(0, ticks)
          * (usesColliders ? Math.max(1, this.simulator.world.colliders.length) : 1);
        if (!Number.isSafeInteger(work) || replayWork + work > MAX_SIMULATION_WORK) {
          throw new RangeError(`replay exceeds the ${MAX_SIMULATION_WORK} operation safety limit`);
        }
        replayWork += work;
      };
      const verifyInputStartState = (input, index) => {
        if (input.startState === undefined) return;
        if (!input.startState || typeof input.startState !== "object" || Array.isArray(input.startState)) {
          this.diagnostics.push(`input ${index} startState must be an object`);
          return;
        }
        const expected = this.simulator.compactSnapshot();
        const recorded = input.startState;
        const comparisons = [
          ["tick", expected.tick, recorded.tick, 0],
          ["elapsedMs", expected.elapsedMs, recorded.elapsedMs, 0.001],
          ["pose.x", expected.pose.x, recorded.pose?.x, 0.0000005],
          ["pose.z", expected.pose.z, recorded.pose?.z, 0.0000005],
          ["pose.heading", expected.pose.heading, recorded.pose?.heading, 0.00005],
          ["linearSpeed", expected.linearSpeed, recorded.linearSpeed, 0.0000005],
          ["angularSpeed", expected.angularSpeed, recorded.angularSpeed, 0.0000005],
          ["prngState", expected.prngState, recorded.prngState, 0],
          ["collisionCount", expected.collisionCount,
            recorded.collisionCount ?? (Array.isArray(recorded.collisions) ? recorded.collisions.length : undefined), 0]
        ];
        comparisons.forEach(([field, expectedValue, actualValue, tolerance]) => {
          if (typeof actualValue === "number" && Number.isFinite(actualValue)
            && Math.abs(expectedValue - actualValue) <= tolerance + EPSILON) return;
          this.diagnostics.push(`input ${index} startState.${field} does not match deterministic state`);
        });
        if (recorded.activeCommand !== null) {
          this.diagnostics.push(`input ${index} startState.activeCommand must be null`);
        }
      };
      const runWaitToTick = targetTick => {
        const currentTick = this.simulator.tick;
        const waitTicks = targetTick - currentTick;
        if (waitTicks <= 0) return;
        if (!Number.isSafeInteger(targetTick) || targetTick > MAX_REPLAY_TICKS) {
          throw new RangeError(`replay exceeds the ${MAX_REPLAY_TICKS} tick safety limit`);
        }
        reserveReplayWork(waitTicks);
        this.simulator.startCommand({
          kind: "wait",
          durationMs: waitTicks * this.simulator.config.stepMs,
          durationTicks: waitTicks
        });
        while (this.simulator.hasActiveCommand()) {
          if (this.simulator.tick >= MAX_REPLAY_TICKS) {
            throw new RangeError(`replay exceeds the ${MAX_REPLAY_TICKS} tick safety limit`);
          }
          this.simulator.step();
        }
      };
      let aborted = false;
      const replayInputCount = Math.min(inputRecords.length, MAX_REPLAY_INPUTS);
      for (let index = 0; index < replayInputCount; index += 1) {
        const input = inputRecords[index];
        if (!input || input.type !== "control" || !input.command) {
          this.diagnostics.push(`input ${index} is not a control command`);
          continue;
        }
        if (!Number.isSafeInteger(input.seq) || input.seq <= 0 || input.seq <= previousSequence) {
          this.diagnostics.push(`input ${index} has an invalid sequence number`);
        }
        previousSequence = Number(input.seq);
        if (!Number.isSafeInteger(input.tick) || input.tick < 0 || input.tick < previousTick
          || input.tick > MAX_REPLAY_TICKS) {
          this.diagnostics.push(`input ${index} has an invalid start tick`);
          continue;
        }
        previousTick = input.tick;
        const expectedInputTime = input.tick * this.simulator.config.stepMs;
        if (typeof input.t !== "number" || !Number.isFinite(input.t)
          || Math.abs(input.t - expectedInputTime) > 0.001 + EPSILON) {
          this.diagnostics.push(`input ${index} time does not match simulation tick ${input.tick}`);
        }
        try {
          let currentTick = this.simulator.tick;
          if (Number.isFinite(maximumRecordedTick) && input.tick > maximumRecordedTick) {
            this.diagnostics.push(`input ${index} starts after simulationEndTick ${maximumRecordedTick}`);
            runWaitToTick(maximumRecordedTick);
            aborted = true;
            break;
          }
          if (input.tick > currentTick) {
            runWaitToTick(input.tick);
            currentTick = this.simulator.tick;
          } else if (input.tick < currentTick) {
            this.diagnostics.push(`input ${index} starts at tick ${input.tick}, expected at least ${currentTick}`);
            continue;
          }
          verifyInputStartState(input, index);
          if (input.world) {
            reserveReplayWork(Array.isArray(input.world.colliders) ? input.world.colliders.length : 1);
            this.simulator.setWorld(input.world);
          }
          const command = this.simulator.normalizeCommand(clone(input.command));
          const commandEndTick = currentTick + command.durationTicks;
          const executionEndTick = Number.isFinite(maximumRecordedTick)
            ? Math.min(commandEndTick, maximumRecordedTick)
            : commandEndTick;
          if (!Number.isSafeInteger(commandEndTick) || executionEndTick > MAX_REPLAY_TICKS) {
            throw new RangeError(`input ${index} exceeds the ${MAX_REPLAY_TICKS} tick replay limit`);
          }
          reserveReplayWork(executionEndTick - currentTick, command.kind === "drive");
          this.simulator.startCommand(command);
          while (this.simulator.hasActiveCommand()
            && this.simulator.tick < executionEndTick) {
            if (this.simulator.tick >= MAX_REPLAY_TICKS) {
              throw new RangeError(`replay exceeds the ${MAX_REPLAY_TICKS} tick safety limit`);
            }
            this.simulator.step();
          }
          if (this.simulator.hasActiveCommand()) this.simulator.cancelCommand();
          if (Number.isFinite(maximumRecordedTick) && this.simulator.tick >= maximumRecordedTick) break;
        } catch (error) {
          this.diagnostics.push(`input ${index} replay failed: ${error.message}`);
          if (this.simulator.hasActiveCommand()) this.simulator.cancelCommand();
          aborted = true;
          break;
        }
      }
      if (!aborted && Number.isFinite(maximumRecordedTick)
        && this.simulator.tick < maximumRecordedTick) {
        try {
          runWaitToTick(maximumRecordedTick);
        } catch (error) {
          this.diagnostics.push(`final replay interval failed: ${error.message}`);
        }
      }
      this.frames = this.simulator.trajectory();
      this.replayCollisions = clone(this.simulator.collisions);
      this.verifyTelemetrySamples();
      this.buildDerivedAnalysis();
    }

    reconstructedSamples() {
      return this.frames.map(frame => ({
        tick: frame.tick,
        t: frame.elapsedMs,
        elapsedMs: frame.elapsedMs,
        x: frame.x,
        z: frame.z,
        heading: frame.heading,
        speed: Math.abs(frame.linearSpeed),
        steering: frame.angularSpeed,
        holding: frame.holding ?? null,
        ...(Array.isArray(frame.packages) ? { packages: clone(frame.packages) } : {})
      }));
    }

    buildDerivedAnalysis() {
      const samples = this.reconstructedSamples();
      if (taskRequiresInteractionDefinition(this.record.taskDefinition)) {
        this.diagnostics.push(`${this.record.taskDefinition.type} task replay requires deterministic grab and release inputs`);
      } else if (this.record.taskDefinition && samples.length) {
        const targetCount = taskAnalysisGeometry(this.record.taskDefinition);
        if (samples.length * targetCount > MAX_REPLAY_ANALYSIS_WORK) {
          this.diagnostics.push(`task replay exceeds the ${MAX_REPLAY_ANALYSIS_WORK} operation analysis limit`);
        } else {
          try {
            const taskReplay = TaskEngine.replay(this.record.taskDefinition, samples);
            this.derivedAnalysis.task = taskReplay.state;
            this.derivedAnalysis.taskEvents = taskReplay.events;
            this.derivedAnalysis.taskRecomputed = true;
          } catch (error) {
            this.diagnostics.push(`task replay failed: ${error.message}`);
          }
        }
      }
      if (this.record.ruleDefinition && samples.length) {
        const roads = Array.isArray(this.record.ruleDefinition.roads) ? this.record.ruleDefinition.roads : [];
        const roadSegments = roads.reduce((sum, road) => (
          sum + Math.max(1, Array.isArray(road?.points) ? road.points.length - 1 : 1)
        ), 0);
        const otherGeometry = ["trafficLights", "speedZones", "prohibitedZones"].reduce((sum, key) => (
          sum + (Array.isArray(this.record.ruleDefinition[key]) ? this.record.ruleDefinition[key].length : 0)
        ), 0);
        const ruleWork = samples.length * Math.max(1, roadSegments + otherGeometry);
        if (!Number.isSafeInteger(ruleWork) || ruleWork > MAX_REPLAY_ANALYSIS_WORK) {
          this.diagnostics.push(`rule replay exceeds the ${MAX_REPLAY_ANALYSIS_WORK} operation analysis limit`);
        } else {
          try {
            const ruleEngine = new RuleEngine(this.record.ruleDefinition);
            const violations = [];
            let previous = null;
            samples.forEach(sample => {
              const result = ruleEngine.evaluate(sample, previous, sample.elapsedMs);
              violations.push(...result.violations);
              previous = sample;
            });
            const collisionViolations = (this.simulator?.snapshot().collisions || []).map(collision => ({
              type: "collision",
              t: collision.elapsedMs,
              tick: collision.tick,
              colliderId: collision.colliderId,
              x: collision.x,
              z: collision.z
            }));
            this.derivedAnalysis.violations = [...violations, ...collisionViolations];
            this.derivedAnalysis.violationMetrics = ruleEngine.metrics(samples[samples.length - 1].elapsedMs);
            this.derivedAnalysis.rulesRecomputed = true;
          } catch (error) {
            this.diagnostics.push(`rule replay failed: ${error.message}`);
          }
        }
      }
    }

    verifyTelemetrySamples() {
      if (!Array.isArray(this.record.samples)) {
        this.diagnostics.push("record samples must be an array");
        return;
      }
      const framesByTick = new Map();
      this.frames.forEach(frame => {
        if (!framesByTick.has(frame.tick)) framesByTick.set(frame.tick, []);
        framesByTick.get(frame.tick).push(frame);
      });
      const recordedTicks = [];
      const phaseByTick = new Map();
      let previousSampleTick = -Infinity;
      let previousSampleSequence = -Infinity;
      this.record.samples.forEach((sample, index) => {
        const sampleTick = sample?.tick ?? sample?.simulationTick;
        if (!Number.isSafeInteger(sampleTick) || sampleTick < 0) {
          this.diagnostics.push(`sample ${index} has no valid simulation tick`);
          return;
        }
        if (sampleTick < previousSampleTick
          || !Number.isSafeInteger(sample?.seq) || sample.seq <= previousSampleSequence) {
          this.diagnostics.push(`sample ${index} is not in monotonic tick/sequence order`);
        }
        previousSampleTick = sampleTick;
        previousSampleSequence = Number(sample?.seq);
        recordedTicks.push(sampleTick);
        const frames = framesByTick.get(sampleTick) || [];
        if (!frames.length) {
          this.diagnostics.push(`sample ${index} references missing simulation tick ${sampleTick}`);
          return;
        }
        const expectedTime = sampleTick * this.simulator.config.stepMs;
        if (typeof sample.t !== "number" || !Number.isFinite(sample.t)
          || Math.abs(sample.t - expectedTime) > 0.001 + EPSILON) {
          this.mismatches.push({ sampleIndex: index, tick: sampleTick, field: "t", expected: expectedTime, actual: sample.t });
          this.diagnostics.push(`sample ${index} time does not match deterministic tick ${sampleTick}`);
        }
        const comparisonsFor = frame => [
          ["x", frame.x, sample.x, 0.0000005],
          ["z", frame.z, sample.z, 0.0000005],
          ["heading", frame.heading, sample.heading, 0.00005],
          ["speed", Math.abs(frame.linearSpeed), sample.speed, 0.0000005],
          ["steering", frame.angularSpeed, sample.steering, 0.0000005]
        ];
        const canonicalPackages = packages => JSON.stringify((packages || []).map(item => ({
          id: String(item.id),
          role: INTERACTION_OBJECT_ROLES.has(String(item.role || "")) ? String(item.role) : "target",
          x: round(item.x, 6),
          z: round(item.z, 6),
          stackLevel: Number.isSafeInteger(item.stackLevel) ? item.stackLevel : 0
        })).sort((left, right) => left.id.localeCompare(right.id)));
        const stateMatches = frame => {
          if (Object.prototype.hasOwnProperty.call(sample, "holding")
            && (sample.holding ?? null) !== (frame.holding ?? null)) return false;
          if (Array.isArray(sample.packages)
            && canonicalPackages(sample.packages) !== canonicalPackages(frame.packages)) return false;
          return true;
        };
        const comparisonsMatch = (comparisons, frame) => comparisons.every(([, expected, actual, tolerance]) => (
          typeof actual === "number" && Number.isFinite(actual)
            && typeof expected === "number" && Number.isFinite(expected)
            && Math.abs(expected - actual) <= tolerance + EPSILON
        )) && stateMatches(frame);
        const signature = JSON.stringify([
          sample.x, sample.z, sample.heading, sample.speed, sample.steering,
          sample.holding ?? null,
          Array.isArray(sample.packages) ? canonicalPackages(sample.packages) : null
        ]);
        const phase = phaseByTick.get(sampleTick) || { nextIndex: 0, lastIndex: -1, lastSignature: null };
        let matchedIndex = -1;
        for (let frameIndex = phase.nextIndex; frameIndex < frames.length; frameIndex += 1) {
          if (comparisonsMatch(comparisonsFor(frames[frameIndex]), frames[frameIndex])) {
            matchedIndex = frameIndex;
            break;
          }
        }
        const repeatedPhase = matchedIndex < 0 && phase.lastIndex >= 0
          && phase.lastSignature === signature
          && comparisonsMatch(comparisonsFor(frames[phase.lastIndex]), frames[phase.lastIndex]);
        if (matchedIndex >= 0 || repeatedPhase) {
          if (matchedIndex >= 0) {
            phase.nextIndex = matchedIndex + 1;
            phase.lastIndex = matchedIndex;
            phase.lastSignature = signature;
          }
          phaseByTick.set(sampleTick, phase);
          return;
        }
        if (frames.some(frame => comparisonsMatch(comparisonsFor(frame), frame))) {
          this.mismatches.push({ sampleIndex: index, tick: sampleTick, field: "phase", expected: "nondecreasing", actual: "out_of_order" });
          this.diagnostics.push(`sample ${index} reverses deterministic phases within tick ${sampleTick}`);
          return;
        }
        const ranked = frames.slice(Math.min(phase.nextIndex, Math.max(0, frames.length - 1))).map(frame => {
          const comparisons = comparisonsFor(frame);
          return {
            comparisons,
            mismatchCount: comparisons.filter(([, expected, actual, tolerance]) => (
              typeof actual !== "number" || !Number.isFinite(actual)
                || typeof expected !== "number" || !Number.isFinite(expected)
                || Math.abs(expected - actual) > tolerance + EPSILON
            )).length
          };
        }).sort((left, right) => left.mismatchCount - right.mismatchCount);
        (ranked[0]?.comparisons || []).forEach(([field, expected, actual, tolerance]) => {
          if (typeof actual === "number" && Number.isFinite(actual)
            && typeof expected === "number" && Number.isFinite(expected)
            && Math.abs(expected - actual) <= tolerance + EPSILON) return;
          this.mismatches.push({ sampleIndex: index, tick: sampleTick, field, expected, actual });
          this.diagnostics.push(`sample ${index} field ${field} does not match deterministic tick ${sampleTick}`);
        });
        const stateFrame = frames[Math.min(phase.nextIndex, Math.max(0, frames.length - 1))] || frames[0];
        if (stateFrame && Object.prototype.hasOwnProperty.call(sample, "holding")
          && (sample.holding ?? null) !== (stateFrame.holding ?? null)) {
          this.mismatches.push({ sampleIndex: index, tick: sampleTick, field: "holding", expected: stateFrame.holding ?? null, actual: sample.holding ?? null });
          this.diagnostics.push(`sample ${index} field holding does not match deterministic tick ${sampleTick}`);
        }
        if (stateFrame && Array.isArray(sample.packages)
          && canonicalPackages(sample.packages) !== canonicalPackages(stateFrame.packages)) {
          this.mismatches.push({ sampleIndex: index, tick: sampleTick, field: "packages", expected: clone(stateFrame.packages), actual: clone(sample.packages) });
          this.diagnostics.push(`sample ${index} field packages does not match deterministic tick ${sampleTick}`);
        }
      });
      if (Number.isInteger(this.record.simulationEndTick)
        && !recordedTicks.includes(this.record.simulationEndTick)) {
        this.mismatches.push({
          sampleIndex: null,
          tick: this.record.simulationEndTick,
          field: "simulationEndTick",
          expected: this.record.simulationEndTick,
          actual: null
        });
        this.diagnostics.push("record has no final telemetry sample at simulationEndTick");
      }
    }

    trajectory() {
      return clone(this.frames);
    }

    snapshot() {
      const frame = this.frames[this.cursor] || null;
      const pose = frame ? { x: frame.x, z: frame.z, heading: frame.heading } : null;
      const collisionCount = Number.isInteger(frame?.collisionCount)
        ? Math.max(0, Math.min(frame.collisionCount, this.replayCollisions.length))
        : 0;
      const complete = !this.frames.length || this.cursor >= this.frames.length - 1;
      return {
        mode: this.mode,
        index: this.cursor,
        tick: frame?.tick ?? null,
        elapsedMs: frame?.elapsedMs ?? null,
        pose,
        collisionCount,
        latestCollision: collisionCount > 0 ? clone(this.replayCollisions[collisionCount - 1]) : null,
        collisions: complete ? clone(this.replayCollisions.slice(0, collisionCount)) : [],
        complete,
        frame: clone(frame),
        replayable: this.mode === "deterministic" && this.diagnostics.length === 0,
        authoritative: false,
        diagnostics: [...this.diagnostics]
      };
    }

    collisionHistory({ throughCursor = true } = {}) {
      const frame = this.frames[this.cursor] || null;
      const count = throughCursor && Number.isInteger(frame?.collisionCount)
        ? Math.max(0, Math.min(frame.collisionCount, this.replayCollisions.length))
        : this.replayCollisions.length;
      return clone(this.replayCollisions.slice(0, count));
    }

    step() {
      if (this.cursor < this.frames.length - 1) this.cursor += 1;
      return this.snapshot();
    }

    seek(elapsedMs) {
      const target = Number(elapsedMs);
      if (!Number.isFinite(target) || target < 0) throw new TypeError("replay seek elapsedMs must be finite and non-negative");
      let index = 0;
      while (index + 1 < this.frames.length && this.frames[index + 1].elapsedMs <= target) index += 1;
      this.cursor = index;
      return this.snapshot();
    }

    play() {
      if (this.frames.length) this.cursor = this.frames.length - 1;
      return this.snapshot();
    }

    verify() {
      const valid = this.mode === "deterministic" && this.diagnostics.length === 0;
      return {
        ok: valid,
        valid,
        replayable: valid,
        authoritative: false,
        mismatches: clone(this.mismatches),
        diagnostics: [...this.diagnostics]
      };
    }

    result() {
      return {
        recordedResult: clone(this.record.result),
        verification: this.verify(),
        authoritative: false
      };
    }

    analysis() {
      return clone(this.derivedAnalysis);
    }
  }

  class RunRecorder {
    constructor(metadata = {}, options = {}) {
      this.sampleIntervalMs = Math.max(20, Number(options.sampleIntervalMs) || DEFAULT_SAMPLE_INTERVAL_MS);
      this.maxElapsedMs = Number.isFinite(Number(options.maxElapsedMs))
        ? Math.max(0, Number(options.maxElapsedMs))
        : Infinity;
      this.now = typeof options.now === "function" ? options.now : () => Date.now();
      this.robotRuntime = options.robotRuntime ? normalizeRobotRuntimeOptions(options.robotRuntime, {}) : null;
      this.simulationTick = typeof options.simulationTick === "function" ? options.simulationTick : null;
      // Only the explicitly separate robot runtime can override competition
      // evidence budgets. The PNG format/per-image safety checks remain shared.
      this.visionEvidenceLimitBytes = this.robotRuntime
        ? this.robotRuntime.visionEvidenceLimitBytes : MAX_VISION_TOTAL_BYTES;
      this.visionEvidenceFrameLimit = this.robotRuntime
        ? this.robotRuntime.visionEvidenceFrameLimit : MAX_VISION_FRAMES;
      this.navigationQueryLimit = this.robotRuntime ? this.robotRuntime.navigationQueryLimit : MAX_NAVIGATION_QUERIES;
      this.navigationControlLimit = this.robotRuntime ? this.robotRuntime.navigationControlLimit : MAX_NAVIGATION_CONTROLS;
      const sourceRunDefinition = metadata.runDefinition && typeof metadata.runDefinition === "object"
        ? metadata.runDefinition
        : null;
      const simulationDefinitionSource = metadata.simulationDefinition ?? sourceRunDefinition?.simulationDefinition;
      const simulationDefinition = simulationDefinitionSource
        ? normalizeSimulationDefinition(simulationDefinitionSource)
        : null;
      const interactionDefinitionSource = metadata.interactionDefinition ?? sourceRunDefinition?.interactionDefinition;
      const interactionDefinition = interactionDefinitionSource
        ? normalizeInteractionDefinition(interactionDefinitionSource, simulationDefinition)
        : null;
      const taskDefinition = metadata.taskDefinition ?? sourceRunDefinition?.taskDefinition ?? null;
      const ruleDefinition = metadata.ruleDefinition ?? sourceRunDefinition?.ruleDefinition ?? null;
      const scoringDefinition = metadata.scoringDefinition ?? sourceRunDefinition?.scoringDefinition ?? null;
      const navigationDefinitionSource = metadata.navigationDefinition ?? sourceRunDefinition?.navigationDefinition ?? null;
      const navigationDefinition = navigationDefinitionSource
        ? normalizeNavigationDefinition(navigationDefinitionSource)
        : null;
      const navigationControlDefinitionSource = metadata.navigationControlDefinition
        ?? sourceRunDefinition?.navigationControlDefinition ?? null;
      const navigationControlDefinition = navigationControlDefinitionSource
        ? normalizeNavigationControlDefinition(navigationControlDefinitionSource)
        : null;
      const runDefinition = sourceRunDefinition || simulationDefinition || interactionDefinition || taskDefinition
        || navigationDefinition || navigationControlDefinition
        ? {
            ...(sourceRunDefinition ? clone(sourceRunDefinition) : {}),
            simulationDefinition: simulationDefinition ? clone(simulationDefinition) : null,
            interactionDefinition: interactionDefinition ? clone(interactionDefinition) : null,
            taskDefinition: taskDefinition ? clone(taskDefinition) : null,
            ruleDefinition: ruleDefinition ? clone(ruleDefinition) : null,
            scoringDefinition: scoringDefinition ? clone(scoringDefinition) : null,
            navigationDefinition: navigationDefinition ? clone(navigationDefinition) : null,
            ...(navigationControlDefinition
              ? { navigationControlDefinition: clone(navigationControlDefinition) }
              : {})
          }
        : null;
      this.record = {
        schemaVersion: SCHEMA_VERSION,
        runId: metadata.runId || makeId("run"),
        serverSessionId: metadata.serverSessionId ? String(metadata.serverSessionId) : null,
        challengeDigest: metadata.challengeDigest ? String(metadata.challengeDigest) : null,
        teamId: metadata.teamId || "local-user",
        taskId: metadata.taskId || "unknown-task",
        mapId: metadata.mapId || "unknown-map",
        mapVersion: metadata.mapVersion || "unversioned",
        ruleVersion: metadata.ruleVersion || "unversioned",
        runDefinition,
        taskDefinition: taskDefinition ? clone(taskDefinition) : null,
        ruleDefinition: ruleDefinition ? clone(ruleDefinition) : null,
        scoringDefinition: scoringDefinition ? clone(scoringDefinition) : null,
        simulationDefinition: simulationDefinition ? clone(simulationDefinition) : null,
        interactionDefinition: interactionDefinition ? clone(interactionDefinition) : null,
        navigationDefinition: navigationDefinition ? clone(navigationDefinition) : null,
        ...(navigationControlDefinition
          ? { navigationControlDefinition: clone(navigationControlDefinition) }
          : {}),
        randomSeed: simulationDefinition ? simulationDefinition.seed : metadata.randomSeed ?? null,
        sourceCode: String(metadata.sourceCode || ""),
        clientStartedAt: new Date(this.now()).toISOString(),
        clientEndedAt: null,
        samples: [],
        inputs: [],
        visionFrames: [],
        events: [],
        simulationEndTick: null,
        result: null
      };
      this.startedAtMs = this.now();
      this.sequence = 0;
      this.lastRegularSampleAtMs = -Infinity;
      this.visionBytes = 0;
      this.navigationQueryCount = 0;
      this.navigationControlCount = 0;
    }

    elapsedMs() {
      return Math.min(this.maxElapsedMs, Math.max(0, this.now() - this.startedAtMs));
    }

    shouldSample(elapsedMs = this.elapsedMs(), force = false) {
      const resolvedElapsedMs = Math.min(this.maxElapsedMs, Math.max(0, Number(elapsedMs) || 0));
      return Boolean(force) || resolvedElapsedMs - this.lastRegularSampleAtMs >= this.sampleIntervalMs;
    }

    sample(telemetry, force = false, elapsedMsOverride = null) {
      const elapsedMs = elapsedMsOverride === null
        ? this.elapsedMs()
        : Math.min(this.maxElapsedMs, Math.max(0, Number(elapsedMsOverride) || 0));
      if (!this.shouldSample(elapsedMs, force)) return false;
      const regularDue = Number.isFinite(this.lastRegularSampleAtMs)
        && elapsedMs - this.lastRegularSampleAtMs >= this.sampleIntervalMs;
      if (!Number.isFinite(this.lastRegularSampleAtMs)) this.lastRegularSampleAtMs = elapsedMs;
      else if (regularDue) {
        const intervals = Math.max(1, Math.floor((elapsedMs - this.lastRegularSampleAtMs) / this.sampleIntervalMs));
        this.lastRegularSampleAtMs += intervals * this.sampleIntervalMs;
      }
      const record = {
        seq: ++this.sequence,
        t: round(elapsedMs, 3),
        x: round(telemetry.x, 6),
        z: round(telemetry.z, 6),
        heading: round(telemetry.heading, 4),
        speed: round(telemetry.speed, 6),
        steering: round(telemetry.steering, 6),
        holding: telemetry.holding || null,
        cameraFrameId: telemetry.cameraFrameId ?? null
      };
      const simulationTick = telemetry.tick ?? telemetry.simulationTick;
      if (simulationTick !== undefined && simulationTick !== null) {
        if (!Number.isInteger(simulationTick) || simulationTick < 0) {
          throw new TypeError("telemetry tick must be a non-negative integer");
        }
        record.tick = simulationTick;
      }
      if (Array.isArray(telemetry.packages)) {
        record.packages = telemetry.packages.map(item => ({
          id: String(item.id),
          role: INTERACTION_OBJECT_ROLES.has(String(item.role || "")) ? String(item.role) : "target",
          x: round(item.x, 6),
          z: round(item.z, 6),
          ...(Number.isSafeInteger(item.stackLevel) && item.stackLevel >= 0 ? { stackLevel: item.stackLevel } : {})
        }));
      }
      this.record.samples.push(record);
      return true;
    }

    input(command, detail = {}, elapsedMsOverride = null) {
      const elapsedMs = elapsedMsOverride === null
        ? this.elapsedMs()
        : Math.min(this.maxElapsedMs, Math.max(0, Number(elapsedMsOverride) || 0));
      const tick = Number(detail.tick);
      if (!Number.isInteger(tick) || tick < 0) throw new TypeError("simulation input tick must be a non-negative integer");
      if (!command || typeof command !== "object" || Array.isArray(command)) {
        throw new TypeError("simulation input command must be an object");
      }
      const safeDetail = clone(detail);
      delete safeDetail.world;
      const input = {
        ...safeDetail,
        seq: ++this.sequence,
        t: round(elapsedMs, 3),
        tick,
        type: "control",
        command: clone(command)
      };
      this.record.inputs.push(input);
      return clone(input);
    }

    interaction(kind, _intent = {}, detail = {}, elapsedMsOverride = null) {
      const type = String(kind || "");
      if (type !== "package_grab" && type !== "package_release") {
        throw new TypeError("interaction input type must be package_grab or package_release");
      }
      const elapsedMs = elapsedMsOverride === null
        ? this.elapsedMs()
        : Math.min(this.maxElapsedMs, Math.max(0, Number(elapsedMsOverride) || 0));
      const tick = Number(detail.tick);
      if (!Number.isSafeInteger(tick) || tick < 0) throw new TypeError("interaction input tick must be a non-negative safe integer");
      const input = {
        seq: ++this.sequence,
        t: round(elapsedMs, 3),
        tick,
        type,
        intent: {}
      };
      if (detail.source !== undefined) input.source = String(detail.source);
      if (Number.isSafeInteger(detail.stateRevision) && detail.stateRevision >= 0) {
        input.stateRevision = detail.stateRevision;
      }
      this.record.inputs.push(input);
      return clone(input);
    }

    manual(action, detail = {}, elapsedMsOverride = null) {
      const normalizedAction = String(action || "").trim();
      if (!normalizedAction || normalizedAction.length > 128) {
        throw new TypeError("manual input action must be 1-128 characters");
      }
      const elapsedMs = elapsedMsOverride === null
        ? this.elapsedMs()
        : Math.min(this.maxElapsedMs, Math.max(0, Number(elapsedMsOverride) || 0));
      const tick = Number(detail.tick);
      if (!Number.isSafeInteger(tick) || tick < 0) throw new TypeError("manual input tick must be a non-negative safe integer");
      const safeDetail = clone(detail);
      delete safeDetail.tick;
      delete safeDetail.seq;
      delete safeDetail.t;
      delete safeDetail.type;
      const input = {
        seq: ++this.sequence,
        t: round(elapsedMs, 3),
        tick,
        type: "manual_control",
        action: normalizedAction,
        detail: safeDetail
      };
      this.record.inputs.push(input);
      return clone(input);
    }

    runEnd(reason, detail = {}, elapsedMsOverride = null) {
      const normalizedReason = String(reason || "").trim();
      if (!RUN_END_REASONS.has(normalizedReason)) {
        throw new TypeError(`unsupported run end reason: ${normalizedReason || "missing"}`);
      }
      const elapsedMs = elapsedMsOverride === null
        ? this.elapsedMs()
        : Math.min(this.maxElapsedMs, Math.max(0, Number(elapsedMsOverride) || 0));
      const tick = Number(detail.tick);
      if (!Number.isSafeInteger(tick) || tick < 0) throw new TypeError("run_end tick must be a non-negative safe integer");
      const input = {
        seq: ++this.sequence,
        t: round(elapsedMs, 3),
        tick,
        type: "run_end",
        reason: normalizedReason
      };
      if (detail.source !== undefined) input.source = String(detail.source);
      this.record.inputs.push(input);
      return clone(input);
    }

    visionQuery(method, args = [], result = null, frameId = null, detail = {}, elapsedMsOverride = null) {
      const normalizedMethod = String(method || "").trim();
      if (!normalizedMethod || normalizedMethod.length > 128) {
        throw new TypeError("vision query method must be 1-128 characters");
      }
      const elapsedMs = elapsedMsOverride === null
        ? this.elapsedMs()
        : Math.min(this.maxElapsedMs, Math.max(0, Number(elapsedMsOverride) || 0));
      const tick = Number(detail.tick);
      if (!Number.isSafeInteger(tick) || tick < 0) throw new TypeError("vision query tick must be a non-negative safe integer");
      const input = {
        seq: ++this.sequence,
        t: round(elapsedMs, 3),
        tick,
        type: "vision_query",
        method: normalizedMethod,
        args: clone(args),
        result: clone(result),
        frameId,
        evidenceId: detail.evidenceId ?? null
      };
      this.record.inputs.push(input);
      return clone(input);
    }

    navigationQuery(method, result, detail = {}, elapsedMsOverride = null) {
      if (this.navigationQueryLimit !== null && this.navigationQueryCount >= this.navigationQueryLimit) {
        throw new RangeError(`run exceeds the ${this.navigationQueryLimit} navigation query limit`);
      }
      const normalizedMethod = String(method || "").trim();
      const navigationDefinition = normalizeNavigationDefinition(
        this.record.navigationDefinition || this.record.runDefinition?.navigationDefinition || NAVIGATION_DEFINITION
      );
      if (!Object.prototype.hasOwnProperty.call(navigationDefinition.methods, normalizedMethod)) {
        throw new TypeError(`unsupported navigation query: ${normalizedMethod || "missing"}`);
      }
      const tick = Number(detail.tick);
      if (!Number.isSafeInteger(tick) || tick < 0) {
        throw new TypeError("navigation query tick must be a non-negative safe integer");
      }
      const elapsedMs = elapsedMsOverride === null
        ? this.elapsedMs()
        : Math.min(this.maxElapsedMs, Math.max(0, Number(elapsedMsOverride) || 0));
      const input = {
        seq: ++this.sequence,
        t: round(elapsedMs, 3),
        tick,
        type: "navigation_query",
        method: normalizedMethod,
        result: clone(result)
      };
      this.record.inputs.push(input);
      this.navigationQueryCount += 1;
      return clone(input);
    }

    beginNavigationControl(method, args = {}, detail = {}, elapsedMsOverride = null) {
      const definitionSource = this.record.navigationControlDefinition
        || this.record.runDefinition?.navigationControlDefinition;
      if (!definitionSource) throw new Error("run has no frozen navigation control definition");
      const definition = normalizeNavigationControlDefinition(definitionSource);
      if ((this.navigationControlLimit !== null && this.navigationControlCount >= this.navigationControlLimit)
        || (!this.robotRuntime && this.navigationControlCount >= definition.actionLimit)) {
        throw new RangeError(`run exceeds the ${this.navigationControlLimit} navigation control limit`);
      }
      const action = normalizeNavigationControlAction(method, args, definition);
      const tick = Number(detail.tick);
      if (!Number.isSafeInteger(tick) || tick < 0) {
        throw new TypeError("navigation control tick must be a non-negative safe integer");
      }
      const elapsedMs = elapsedMsOverride === null
        ? this.elapsedMs()
        : Math.min(this.maxElapsedMs, Math.max(0, Number(elapsedMsOverride) || 0));
      const input = {
        seq: ++this.sequence,
        t: round(elapsedMs, 3),
        tick,
        type: "navigation_control",
        method: action.method,
        args: clone(action.args),
        result: null
      };
      this.record.inputs.push(input);
      this.navigationControlCount += 1;
      return { seq: input.seq, method: action.method, args: clone(action.args) };
    }

    finishNavigationControl(sequence, result) {
      if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new TypeError("navigation control sequence must be a positive safe integer");
      }
      const input = this.record.inputs.find(candidate => (
        candidate?.type === "navigation_control" && candidate.seq === sequence
      ));
      if (!input) throw new Error("navigation control input is not pending in this run");
      if (input.result !== null) throw new Error("navigation control input is already complete");
      const definitionSource = this.record.navigationControlDefinition
        || this.record.runDefinition?.navigationControlDefinition;
      if (!definitionSource) throw new Error("run has no frozen navigation control definition");
      const definition = normalizeNavigationControlDefinition(definitionSource);
      input.result = normalizeNavigationControlResult(result, definition);
      return clone(input);
    }

    visionEvidence(evidence = {}, elapsedMsOverride = null) {
      if (this.visionEvidenceFrameLimit !== null
        && this.record.visionFrames.length >= this.visionEvidenceFrameLimit) {
        throw new RangeError(`run exceeds the ${this.visionEvidenceFrameLimit} vision frame limit`);
      }
      const normalized = normalizeVisionEvidence(evidence, {
        evidenceId: `vision-${this.record.visionFrames.length + 1}`
      });
      if (this.record.visionFrames.some(frame => frame.evidenceId === normalized.evidenceId)) {
        throw new TypeError(`vision evidenceId is duplicated: ${normalized.evidenceId}`);
      }
      if (this.visionEvidenceLimitBytes !== null
        && this.visionBytes + normalized.byteLength > this.visionEvidenceLimitBytes) {
        throw new RangeError(`run exceeds the ${this.visionEvidenceLimitBytes} byte vision evidence limit`);
      }
      this.visionBytes += normalized.byteLength;
      const elapsedMs = elapsedMsOverride === null
        ? this.elapsedMs()
        : Math.min(this.maxElapsedMs, Math.max(0, Number(elapsedMsOverride) || 0));
      const recorded = {
        ...normalized,
        seq: ++this.sequence,
        t: round(elapsedMs, 3)
      };
      this.record.visionFrames.push(recorded);
      return clone(recorded);
    }

    latestSample() {
      return clone(this.record.samples[this.record.samples.length - 1] || null);
    }

    event(type, detail = {}, elapsedMsOverride = null) {
      const elapsedMs = elapsedMsOverride === null
        ? this.elapsedMs()
        : Math.min(this.maxElapsedMs, Math.max(0, Number(elapsedMsOverride) || 0));
      const event = {
        ...clone(detail),
        ...(this.robotRuntime && this.simulationTick && detail.tick === undefined
          ? {tick: this.simulationTick()} : {}),
        seq: ++this.sequence,
        t: round(elapsedMs, 3),
        type: String(type || "event")
      };
      this.record.events.push(event);
      return event;
    }

    finish(result, options = {}) {
      this.record.clientEndedAt = new Date(this.now()).toISOString();
      const finalTick = options.simulationEndTick ?? result?.simulationTick ?? this.latestSample()?.tick;
      this.record.simulationEndTick = Number.isInteger(finalTick) ? finalTick : null;
      this.record.result = clone(result);
      return this.export();
    }

    export() {
      return clone(this.record);
    }
  }

  function normalizeRobotRuntimeOptions(input, config) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("robotRuntime must be an options object");
    }
    const allowed = ["timeLimitSeconds", "visionEvidenceLimitBytes", "visionEvidenceFrameLimit",
      "navigationQueryLimit", "navigationControlLimit"];
    for (const key of Object.keys(input)) {
      if (!allowed.includes(key)) throw new TypeError(`unsupported robotRuntime option: ${key}`);
    }
    const configuredSeconds = Number(config.timeLimitSeconds);
    const defaults = {
      timeLimitSeconds: Number.isFinite(configuredSeconds) && configuredSeconds > 0 ? configuredSeconds : null,
      visionEvidenceLimitBytes: MAX_VISION_TOTAL_BYTES,
      visionEvidenceFrameLimit: MAX_VISION_FRAMES,
      navigationQueryLimit: null,
      navigationControlLimit: null
    };
    const result = {};
    for (const key of allowed) {
      const value = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : defaults[key];
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value <= 0
        || (key !== "timeLimitSeconds" && !Number.isSafeInteger(value)))) {
        throw new TypeError(`robotRuntime.${key} must be a positive number or null`);
      }
      if (key === "timeLimitSeconds" && value !== null && !Number.isFinite(value * 1000)) {
        throw new TypeError("robotRuntime.timeLimitSeconds is too large");
      }
      result[key] = value;
    }
    return Object.freeze(result);
  }

  class CompetitionSession {
    constructor(config = {}, metadata = {}, options = {}) {
      this.config = config;
      this.robotRuntime = options.robotRuntime === undefined
        ? null : normalizeRobotRuntimeOptions(options.robotRuntime, config);
      this.now = typeof options.now === "function" ? options.now : () => Date.now();
      const simulationDefinitionSource = metadata.simulationDefinition ?? metadata.runDefinition?.simulationDefinition;
      this.simulationDefinition = simulationDefinitionSource
        ? normalizeSimulationDefinition(simulationDefinitionSource)
        : null;
      const interactionDefinitionSource = metadata.interactionDefinition
        ?? metadata.runDefinition?.interactionDefinition
        ?? config.interactionDefinition
        ?? null;
      this.interactionDefinition = interactionDefinitionSource
        ? normalizeInteractionDefinition(interactionDefinitionSource, this.simulationDefinition)
        : null;
      const visionDefinitionSource = metadata.runDefinition
        && Object.prototype.hasOwnProperty.call(metadata.runDefinition, "visionDefinition")
        ? metadata.runDefinition.visionDefinition
        : VISION_DEFINITION;
      this.visionDefinition = visionDefinitionSource
        ? normalizeVisionDefinition(visionDefinitionSource)
        : null;
      const navigationDefinitionSource = metadata.runDefinition
        && Object.prototype.hasOwnProperty.call(metadata.runDefinition, "navigationDefinition")
        ? metadata.runDefinition.navigationDefinition
        : NAVIGATION_DEFINITION;
      this.navigationDefinition = navigationDefinitionSource
        ? normalizeNavigationDefinition(navigationDefinitionSource)
        : null;
      const navigationControlDefinitionSource = metadata.runDefinition
        && Object.prototype.hasOwnProperty.call(metadata.runDefinition, "navigationControlDefinition")
        ? metadata.runDefinition.navigationControlDefinition
        : null;
      this.navigationControlDefinition = navigationControlDefinitionSource
        ? normalizeNavigationControlDefinition(navigationControlDefinitionSource)
        : null;
      if (this.navigationControlDefinition
        && (!navigationSupportsRoadTopology(this.navigationDefinition)
          || this.navigationControlDefinition.navigationSchemaVersion !== this.navigationDefinition.schemaVersion)) {
        throw new TypeError("navigation controls require a matching navigation v2 or v3 sensor contract");
      }
      this.packageStateEngine = this.interactionDefinition
        ? new PackageStateEngine(this.interactionDefinition, this.simulationDefinition)
        : null;
      this.stateRevision = 0;
      this.simulationTick = 0;
      this.simulationElapsedMs = 0;
      const configuredLimitSeconds = Number(this.robotRuntime
        ? this.robotRuntime.timeLimitSeconds : config.timeLimitSeconds);
      this.timeLimitMs = Number.isFinite(configuredLimitSeconds) && configuredLimitSeconds > 0
        ? configuredLimitSeconds * 1000
        : Infinity;
      this.ruleEngine = new RuleEngine(config.rules || {});
      this.judge = new CompetitionJudge(config.scoring || {});
      const taskConfig = resolveCompetitionTaskConfig(config);
      this.taskEngine = taskConfig ? new TaskEngine(taskConfig) : null;
      if (this.taskEngine?.config.type === "composite"
        || (this.taskEngine?.config.type === "delivery" && this.interactionDefinition)) {
        validateDeliveryInteractionDefinition(this.taskEngine.config, this.interactionDefinition);
      }
      validateRoadClearancePlacementRules(this.taskEngine?.config, config.rules || {});
      const timeLimitTicks = this.simulationDefinition && Number.isFinite(this.timeLimitMs)
        ? Math.ceil(this.timeLimitMs / this.simulationDefinition.stepMs)
        : null;
      this.recorder = new RunRecorder({
        ...metadata,
        taskId: config.taskId,
        mapId: config.mapId,
        mapVersion: config.mapVersion,
        ruleVersion: config.ruleVersion,
        taskDefinition: this.taskEngine?.definition() || null,
        ruleDefinition: clone(config.rules || {}),
        scoringDefinition: clone(config.scoring || {}),
        interactionDefinition: this.interactionDefinition,
        runDefinition: {
          ...(metadata.runDefinition && typeof metadata.runDefinition === "object" ? clone(metadata.runDefinition) : {}),
          simulationDefinition: this.simulationDefinition,
          interactionDefinition: this.interactionDefinition,
          taskDefinition: this.taskEngine?.definition() || null,
          ruleDefinition: clone(config.rules || {}),
          scoringDefinition: clone(config.scoring || {}),
          ...(this.visionDefinition ? { visionDefinition: clone(this.visionDefinition) } : {}),
          ...(this.navigationDefinition ? { navigationDefinition: clone(this.navigationDefinition) } : {}),
          ...(this.navigationControlDefinition
            ? { navigationControlDefinition: clone(this.navigationControlDefinition) }
            : {}),
          timeLimitTicks,
          ...(this.robotRuntime ? { robotRuntime: clone(this.robotRuntime) } : {})
        }
      }, {
        now: this.now,
        sampleIntervalMs: options.sampleIntervalMs,
        maxElapsedMs: this.timeLimitMs,
        robotRuntime: this.robotRuntime,
        simulationTick: () => this.simulationTick
      });
      this.startedAtMs = this.now();
      this.previousSample = null;
      this.previousEvaluationSample = null;
      this.lastDeterministicTelemetry = null;
      this.currentDeterministicPose = null;
      this.navigationDistance = 0;
      this.navigationRoadTopology = null;
      this.navigationLastPose = this.simulationDefinition
        ? { ...this.simulationDefinition.initialPose, tick: 0 }
        : null;
      const configuredTaskTotal = Array.isArray(config.checkpoints)
        ? config.checkpoints.length + (Array.isArray(config.goal) ? 1 : 0)
        : Number(config.task?.total);
      this.task = this.taskEngine?.taskState() || {
          completed: 0,
          total: Number.isInteger(configuredTaskTotal) && configuredTaskTotal > 0 ? configuredTaskTotal : 0,
          finished: false
        };
      this.violations = [];
      this.manualInterventions = 0;
      this.status = "running";
      this.finalRecord = null;
      this.recorder.event("run_started", { taskId: config.taskId, mapVersion: config.mapVersion }, 0);
    }

    rawElapsedMs() {
      return Math.max(0, this.now() - this.startedAtMs);
    }

    elapsedMs() {
      const elapsed = this.simulationDefinition ? this.simulationElapsedMs : this.rawElapsedMs();
      return Math.min(this.timeLimitMs, elapsed);
    }

    enforceTimeLimit() {
      if (this.status !== "running" || !Number.isFinite(this.timeLimitMs) || this.elapsedMs() < this.timeLimitMs) return false;
      this.finish("timeout");
      return true;
    }

    updateTask(task = {}) {
      if (this.status !== "running" || this.enforceTimeLimit()) return false;
      if (this.taskEngine) return false;
      const total = Number(task.total);
      const completed = Number(task.completed);
      const valid = Number.isInteger(total) && total > 0
        && Number.isInteger(completed) && completed >= 0 && completed <= total;
      this.task = {
        completed: valid ? completed : 0,
        total: valid ? total : 0,
        finished: Boolean(task.finished) && valid && completed === total
      };
      return valid;
    }

    addViolation(type, detail = {}) {
      if (this.status !== "running" || this.enforceTimeLimit()) return null;
      return this.recordViolation(type, detail, this.elapsedMs());
    }

    recordViolation(type, detail = {}, elapsedMs = this.elapsedMs()) {
      const message = detail.message || DEFAULT_VIOLATION_MESSAGES[type] || type;
      const violation = {
        ...clone(detail),
        t: round(elapsedMs, 3),
        type: String(type || "unknown"),
        message: String(message)
      };
      this.violations.push(violation);
      if (violation.type === "collision") this.taskEngine?.noteCollision(violation.colliderId);
      const { type: violationType, ...eventDetail } = violation;
      this.recorder.event("violation", { violationType, ...eventDetail }, elapsedMs);
      return violation;
    }

    addEvent(type, detail = {}) {
      if (this.status !== "running" || this.enforceTimeLimit()) return null;
      return this.recorder.event(type, detail, this.elapsedMs());
    }

    evaluateTaskObservation(observation, elapsedMs = this.elapsedMs()) {
      if (!this.taskEngine) return null;
      const taskResult = this.taskEngine.evaluate(observation, elapsedMs);
      this.task = taskResult.task;
      taskResult.events.forEach(taskEvent => {
        const { type, ...detail } = taskEvent;
        this.recorder.event(type, detail, taskEvent.elapsedMs);
      });
      return taskResult;
    }

    addSimulationInput(command, detail = {}) {
      if (this.status !== "running" || this.enforceTimeLimit()) return null;
      return this.recorder.input(command, detail, this.elapsedMs());
    }

    addInteractionInput(kind, detail = {}) {
      if (this.status !== "running" || this.enforceTimeLimit()) return null;
      if (!this.packageStateEngine) throw new Error("competition session has no interaction definition");
      const requestedType = String(kind || "");
      const type = requestedType === "grab" ? "package_grab"
        : requestedType === "release" ? "package_release"
          : requestedType;
      if (type !== "package_grab" && type !== "package_release") {
        throw new TypeError("interaction input type must be package_grab or package_release");
      }
      const tick = detail.tick ?? this.simulationTick;
      if (!Number.isSafeInteger(tick) || tick < 0 || tick !== this.simulationTick) {
        throw new TypeError("interaction input tick must equal the current simulation tick");
      }
      const pose = this.currentDeterministicPose || this.previousSample || this.simulationDefinition?.initialPose;
      if (!pose) throw new Error("interaction input requires an observed vehicle pose");
      this.stateRevision += 1;
      this.recorder.interaction(type, {}, {
        tick,
        stateRevision: this.stateRevision,
        source: detail.source
      }, this.elapsedMs());
      const outcome = this.packageStateEngine.apply(type, {}, pose);
      this.recorder.event(outcome.accepted
        ? type === "package_grab" ? "package_grabbed" : "package_released"
        : "package_interaction_failed", {
        interactionType: type,
        accepted: outcome.accepted,
        reason: outcome.reason,
        packageId: outcome.packageId,
        objectRole: outcome.objectRole,
        obstacleId: outcome.obstacleId ?? null,
        position: outcome.position,
        stackLevel: outcome.stackLevel,
        stateRevision: this.stateRevision
      }, this.elapsedMs());
      if (this.taskEngine) {
        const packageState = this.packageStateEngine.snapshot();
        this.evaluateTaskObservation({
          x: pose.x,
          z: pose.z,
          heading: pose.heading,
          speed: this.previousEvaluationSample?.speed ?? 0,
          steering: this.previousEvaluationSample?.steering ?? 0,
          tick,
          holding: packageState.holding,
          packages: packageState.packages,
          elapsedMs: this.elapsedMs()
        }, this.elapsedMs());
      }
      return outcome;
    }

    addManualInput(action, detail = {}) {
      if (this.status !== "running" || this.enforceTimeLimit()) return null;
      const tick = detail.tick ?? this.simulationTick;
      if (!Number.isSafeInteger(tick) || tick < 0 || (this.simulationDefinition && tick !== this.simulationTick)) {
        throw new TypeError("manual input tick must equal the current simulation tick");
      }
      this.manualInterventions += 1;
      this.stateRevision += 1;
      const input = this.recorder.manual(action, {
        ...clone(detail),
        tick,
        stateRevision: this.stateRevision
      }, this.elapsedMs());
      this.recorder.event("manual_control", {
        action: input.action,
        detail: clone(input.detail),
        stateRevision: this.stateRevision
      }, this.elapsedMs());
      return input;
    }

    addVisionEvidence(evidence = {}) {
      if (this.status !== "running" || this.enforceTimeLimit()) return null;
      return this.recorder.visionEvidence({
        ...clone(evidence),
        tick: evidence.tick ?? this.simulationTick,
        stateRevision: evidence.stateRevision ?? this.stateRevision,
        ...(this.visionDefinition ? {
          cameraDefinitionHash: CAMERA_DEFINITION_HASH,
          detectorDefinitionHash: DETECTOR_DEFINITION_HASH
        } : {})
      }, this.elapsedMs());
    }

    addVisionQuery(method, args = [], result = null, frameId = null) {
      if (this.status !== "running" || this.enforceTimeLimit()) return null;
      const evidence = [...this.recorder.record.visionFrames].reverse()
        .find(frame => frame.frameId === frameId) || null;
      return this.recorder.visionQuery(method, args, result, frameId, {
        tick: this.simulationTick,
        evidenceId: evidence?.evidenceId ?? null
      }, this.elapsedMs());
    }

    navigationWorld() {
      const sourceWorld = this.simulationDefinition?.world;
      if (!sourceWorld) return null;
      const staticColliders = sourceWorld.colliders.filter(collider => (
        !String(collider.id).startsWith("package:")
        && !String(collider.id).startsWith("package-stack:")
        && !String(collider.id).startsWith("object:")
      ));
      return {
        bounds: clone(sourceWorld.bounds),
        colliders: [
          ...staticColliders.map(clone),
          ...(this.packageStateEngine ? this.packageStateEngine.colliders() : [])
        ]
      };
    }

    addNavigationQuery(method) {
      if (this.status !== "running" || this.enforceTimeLimit()) return null;
      if (!this.simulationDefinition || !this.navigationDefinition) {
        throw new Error("competition session has no deterministic navigation definition");
      }
      const pose = this.currentDeterministicPose || this.simulationDefinition.initialPose;
      const normalizedMethod = String(method || "").trim();
      if (navigationSupportsRoadTopology(this.navigationDefinition)
        && ["road_state", "map_graph", "mission"].includes(normalizedMethod)
        && !this.navigationRoadTopology) {
        this.navigationRoadTopology = buildNavigationTopology(this.config.rules || {}, this.navigationDefinition);
      }
      const result = projectNavigationQuery(method, {
        pose,
        initialPose: this.simulationDefinition.initialPose,
        distance: this.navigationDistance,
        tick: this.simulationTick,
        rules: this.config.rules || {},
        navigationDefinition: this.navigationDefinition,
        roadTopology: this.navigationRoadTopology,
        world: this.navigationWorld(),
        vehicleRadius: this.simulationDefinition.vehicle.radius,
        taskDefinition: this.taskEngine?.definition() || null,
        interactionDefinition: this.interactionDefinition,
        simulationDefinition: this.simulationDefinition,
        taskSnapshot: this.taskEngine?.snapshot() || null,
        packageSnapshot: this.packageStateEngine?.snapshot() || null,
        mapId: this.config.mapId,
        mapVersion: this.config.mapVersion
      });
      this.recorder.navigationQuery(method, result, { tick: this.simulationTick }, this.elapsedMs());
      return clone(result);
    }

    runNavigationControl(simulator, method, args = {}, options = {}) {
      if (this.status !== "running" || this.enforceTimeLimit()) return null;
      if (!this.simulationDefinition || !this.navigationDefinition || !this.navigationControlDefinition) {
        throw new Error("competition session has no deterministic navigation control definition");
      }
      if (!(simulator instanceof DeterministicSimulator)) {
        throw new TypeError("navigation control requires the session DeterministicSimulator");
      }
      if (!exactJsonEqual(simulator.definition(), this.simulationDefinition)) {
        throw new TypeError("navigation control simulator does not match the frozen simulation definition");
      }
      if (simulator.hasActiveCommand()) {
        throw new Error("navigation control requires an idle deterministic simulator");
      }
      const snapshot = simulator.compactSnapshot();
      if (snapshot.tick !== this.simulationTick) {
        throw new RangeError("navigation control simulator tick does not match the competition session");
      }
      const expectedPose = this.currentDeterministicPose || this.simulationDefinition.initialPose;
      if (Math.abs(snapshot.pose.x - expectedPose.x) > 0.0000005 + EPSILON
        || Math.abs(snapshot.pose.z - expectedPose.z) > 0.0000005 + EPSILON
        || Math.abs(normalizeSignedAngle(snapshot.pose.heading - expectedPose.heading)) > 0.00005 + EPSILON) {
        throw new RangeError("navigation control simulator pose does not match the competition session");
      }
      const action = normalizeNavigationControlAction(method, args, this.navigationControlDefinition);
      if (!this.navigationRoadTopology) {
        this.navigationRoadTopology = buildNavigationTopology(this.config.rules || {}, this.navigationDefinition);
      }
      simulator.setWorld(this.navigationWorld());
      const startedTick = simulator.tick;
      const pending = this.recorder.beginNavigationControl(action.method, action.args,
        { tick: startedTick }, startedTick * this.simulationDefinition.stepMs);
      const runner = new NavigationActionRunner(simulator, {
        rules: this.config.rules || {},
        navigationDefinition: this.navigationDefinition,
        navigationControlDefinition: this.navigationControlDefinition,
        roadTopology: this.navigationRoadTopology
      });
      const timeLimitTicks = this.recorder.record.runDefinition?.timeLimitTicks;
      const observeStep = typeof options?.onStep === "function" ? options.onStep : null;
      const observeJudgement = typeof options?.onJudgement === "function" ? options.onJudgement : null;
      const observedFrames = observeStep ? [] : null;
      const actionTaskEvents = [];
      const actionViolations = [];
      const result = runner.run(action.method, action.args, {
        maxTick: this.robotRuntime
          ? (Number.isSafeInteger(timeLimitTicks) ? timeLimitTicks : Number.MAX_SAFE_INTEGER)
          : (Number.isSafeInteger(timeLimitTicks) ? Math.min(timeLimitTicks, MAX_REPLAY_TICKS) : MAX_REPLAY_TICKS),
        onStep: frame => {
          const sampled = this.sample({
            tick: frame.tick,
            x: frame.x,
            z: frame.z,
            heading: frame.heading,
            speed: Math.abs(frame.linearSpeed),
            steering: frame.angularSpeed
          }, { deferFinish: true });
          actionTaskEvents.push(...clone(sampled?.taskEvents || []));
          actionViolations.push(...clone(sampled?.violations || []));
          if (frame.collision && !sampled?.timedOut) {
            const collisionViolation = this.recordViolation("collision", {
              tick: frame.collision.tick,
              colliderId: frame.collision.colliderId,
              x: frame.collision.x,
              z: frame.collision.z
            }, frame.elapsedMs);
            if (collisionViolation) actionViolations.push(clone(collisionViolation));
          }
          if (observedFrames) observedFrames.push(clone(frame));
          return !sampled?.timedOut;
        }
      });
      this.recorder.finishNavigationControl(pending.seq, result);
      if (Number.isFinite(this.timeLimitMs) && this.elapsedMs() >= this.timeLimitMs) this.finish("timeout");
      else if (!this.robotRuntime && this.taskEngine && this.task.finished) this.finish("completed");
      if (observeStep) observedFrames.forEach(frame => {
        try {
          observeStep(frame);
        } catch (_error) {
          // Rendering observers are non-authoritative and cannot affect the completed action.
        }
      });
      if (observeJudgement) {
        const summary = {
          taskState: this.taskEngine?.snapshot() || null,
          taskEvents: clone(actionTaskEvents),
          violations: clone(actionViolations),
          status: this.status,
          score: this.finalRecord?.result || this.snapshot()
        };
        try {
          observeJudgement(clone(summary));
        } catch (_error) {
          // UI observers receive clones only after the action and cannot affect the authoritative result.
        }
      }
      return clone(result);
    }

    sample(telemetry, options = {}) {
      if (this.status !== "running") {
        return {
          violations: [],
          score: this.finalRecord?.result || this.snapshot(),
          timedOut: this.status === "timeout",
          record: this.finalRecord ? clone(this.finalRecord) : null
        };
      }
      if (this.simulationDefinition) {
        const simulationTick = telemetry?.tick ?? telemetry?.simulationTick;
        if (!Number.isInteger(simulationTick) || simulationTick < 0) {
          throw new TypeError("deterministic competition telemetry requires a non-negative integer tick");
        }
        if (simulationTick < this.simulationTick) {
          throw new RangeError("deterministic competition telemetry tick cannot move backwards");
        }
        this.simulationTick = simulationTick;
        this.simulationElapsedMs = simulationTick * this.simulationDefinition.stepMs;
      }
      if (!this.simulationDefinition && this.enforceTimeLimit()) {
        return {
          violations: [],
          score: this.finalRecord.result,
          timedOut: true,
          record: clone(this.finalRecord)
        };
      }
      const elapsedMs = this.elapsedMs();
      const x = Number(telemetry.x);
      const z = Number(telemetry.z);
      const heading = Number(telemetry.heading ?? 0);
      const speed = Number(telemetry.speed ?? 0);
      const steering = Number(telemetry.steering ?? 0);
      if (![x, z, heading, speed, steering].every(Number.isFinite)) {
        throw new TypeError("competition telemetry values must be finite numbers");
      }
      let packages = Array.isArray(telemetry.packages)
        ? telemetry.packages.map((item, index) => {
            const packageX = Number(item?.x);
            const packageZ = Number(item?.z);
            const packageId = String(item?.id || "").trim();
            if (!packageId || !Number.isFinite(packageX) || !Number.isFinite(packageZ)) {
              throw new TypeError(`competition package ${index} requires an id and finite x/z`);
            }
            const role = item?.role === undefined ? "target" : String(item.role);
            if (!INTERACTION_OBJECT_ROLES.has(role)) {
              throw new TypeError(`competition package ${index} has an invalid role`);
            }
            return { id: packageId, role, x: packageX, z: packageZ };
          }).sort((left, right) => left.id.localeCompare(right.id))
        : null;
      let holding = telemetry.holding ?? null;
      if (this.packageStateEngine) {
        const packageState = this.packageStateEngine.snapshot();
        packages = packageState.packages;
        holding = packageState.holding;
      }
      if (holding !== null && (typeof holding !== "string" || !holding.trim())) {
        throw new TypeError("competition holding must be a non-empty package id or null");
      }
      if (packages && new Set(packages.map(item => item.id)).size !== packages.length) {
        throw new TypeError("competition package ids must be unique");
      }
      if (taskRequiresInteractionDefinition(this.taskEngine?.config)) {
        const requiredIds = this.taskEngine.requiredPackageIds();
        const packageIds = new Set((packages || []).map(item => item.id));
        if (!packages || requiredIds.some(id => !packageIds.has(id))) {
          throw new TypeError(`${this.taskEngine.config.type} competition telemetry must contain every required package`);
        }
      }
      const sampleDraft = {
        x,
        z,
        heading,
        speed: Math.max(0, speed),
        steering,
        holding: holding === null ? null : holding.trim(),
        cameraFrameId: telemetry.cameraFrameId ?? null,
        tick: telemetry.tick ?? telemetry.simulationTick ?? null,
        ...(packages ? { packages } : {}),
        elapsedMs
      };
      if (this.simulationDefinition) {
        const deterministicPose = {
          tick: sampleDraft.tick,
          x: round(sampleDraft.x, 6),
          z: round(sampleDraft.z, 6),
          heading: round(sampleDraft.heading, 4)
        };
        const previousPose = this.lastDeterministicTelemetry;
        if (previousPose && previousPose.tick === deterministicPose.tick
          && (previousPose.x !== deterministicPose.x
            || previousPose.z !== deterministicPose.z
            || previousPose.heading !== deterministicPose.heading)) {
          throw new RangeError("deterministic competition telemetry cannot change pose within the same tick");
        }
        this.lastDeterministicTelemetry = deterministicPose;
        if (this.navigationLastPose && deterministicPose.tick > this.navigationLastPose.tick) {
          this.navigationDistance = navigationRounded(this.navigationDistance + Math.hypot(
            deterministicPose.x - this.navigationLastPose.x,
            deterministicPose.z - this.navigationLastPose.z
          ), 12);
        }
        if (!this.navigationLastPose || deterministicPose.tick >= this.navigationLastPose.tick) {
          this.navigationLastPose = deterministicPose;
        }
        this.currentDeterministicPose = {
          x: sampleDraft.x,
          z: sampleDraft.z,
          heading: sampleDraft.heading
        };
        if (Number.isFinite(this.timeLimitMs) && elapsedMs >= this.timeLimitMs) {
          this.recorder.sample(sampleDraft, true, elapsedMs);
          const terminalSample = this.recorder.latestSample();
          if (terminalSample) this.previousSample = { ...terminalSample, elapsedMs: terminalSample.t };
          if (options.deferFinish) {
            return {
              sampled: true,
              violations: [],
              taskEvents: [],
              task: clone(this.task),
              taskState: this.taskEngine?.snapshot() || null,
              roadMatch: null,
              score: this.snapshot(),
              timedOut: true,
              deferredFinish: true,
              record: null
            };
          }
          const record = this.finish("timeout");
          return {
            sampled: true,
            violations: [],
            taskEvents: [],
            task: clone(this.task),
            taskState: this.taskEngine?.snapshot() || null,
            roadMatch: null,
            score: record.result,
            timedOut: true,
            record
          };
        }
      }
      const packageSignature = packages
        ? JSON.stringify(packages.map(item => [item.id, item.role || "target", round(item.x, 6), round(item.z, 6)]))
        : "";
      const previousPackageSignature = Array.isArray(this.previousSample?.packages)
        ? JSON.stringify(this.previousSample.packages.map(item => [item.id, item.role || "target", item.x, item.z]))
        : "";
      const stateChanged = Boolean(this.previousSample) && (
        round(sampleDraft.x, 6) !== this.previousSample.x
        || round(sampleDraft.z, 6) !== this.previousSample.z
        || round(sampleDraft.heading, 4) !== this.previousSample.heading
        || round(sampleDraft.speed, 6) !== this.previousSample.speed
        || round(sampleDraft.steering, 6) !== this.previousSample.steering
        || sampleDraft.holding !== this.previousSample.holding
        || packageSignature !== previousPackageSignature
      );
      const forceRecord = Boolean(options.forceRecord) || (!this.simulationDefinition && stateChanged);
      const shouldRecord = this.recorder.shouldSample(elapsedMs, forceRecord);
      if (!this.simulationDefinition && !shouldRecord) {
        return {
          sampled: false,
          violations: [],
          taskEvents: [],
          task: clone(this.task),
          roadMatch: null,
          score: this.snapshot()
        };
      }
      let sampled = false;
      if (shouldRecord) {
        this.recorder.sample(sampleDraft, forceRecord, elapsedMs);
        sampled = true;
      }
      const recordedSample = sampled ? this.recorder.latestSample() : null;
      const sample = this.simulationDefinition
        ? {
            ...sampleDraft,
            x: round(sampleDraft.x, 6),
            z: round(sampleDraft.z, 6),
            heading: round(sampleDraft.heading, 4),
            speed: round(sampleDraft.speed, 6),
            steering: round(sampleDraft.steering, 6),
            t: round(elapsedMs, 3),
            elapsedMs: round(elapsedMs, 3),
            ...(packages ? { packages: clone(packages) } : {})
          }
        : { ...recordedSample, elapsedMs: recordedSample.t };
      const ruleResult = this.ruleEngine.evaluate(sample, this.previousEvaluationSample, sample.elapsedMs);
      ruleResult.violations.forEach(violation => this.recordViolation(violation.type, {
        ...violation,
        ...(this.simulationDefinition ? { tick: sample.tick } : {})
      }, sample.elapsedMs));
      const taskResult = this.evaluateTaskObservation(sample, sample.elapsedMs);
      const taskEvents = taskResult?.events || [];
      this.previousEvaluationSample = sample;
      if (sampled) this.previousSample = { ...recordedSample, elapsedMs: recordedSample.t };
      if (!this.robotRuntime && this.taskEngine && this.task.finished && !sampled) {
        this.recorder.sample(sampleDraft, true, elapsedMs);
        const completionSample = this.recorder.latestSample();
        if (completionSample) this.previousSample = { ...completionSample, elapsedMs: completionSample.t };
        sampled = true;
      }
      const completedRecord = !this.robotRuntime && this.taskEngine && this.task.finished && !options.deferFinish
        ? this.finish("completed")
        : null;
      return {
        sampled,
        violations: ruleResult.violations,
        taskEvents: clone(taskEvents),
        task: clone(this.task),
        taskState: taskResult?.state || null,
        roadMatch: ruleResult.roadMatch,
        score: completedRecord?.result || this.snapshot(),
        record: completedRecord
      };
    }

    snapshot() {
      return this.judge.score({
        task: this.task,
        violations: this.violations,
        violationMetrics: this.ruleEngine.metrics(this.elapsedMs()),
        durationSeconds: this.elapsedMs() / 1000,
        manualInterventions: this.manualInterventions
      });
    }

    finish(reason = "finished") {
      if (this.finalRecord) return clone(this.finalRecord);
      const completedAtMs = Number(this.taskEngine?.snapshot().completedAtMs);
      const taskCompletedInTime = Boolean(this.taskEngine && this.task.finished)
        && Number.isFinite(completedAtMs)
        && (!Number.isFinite(this.timeLimitMs) || completedAtMs < this.timeLimitMs);
      const elapsedLimitReached = Number.isFinite(this.timeLimitMs) && this.elapsedMs() >= this.timeLimitMs;
      const finalReason = !this.robotRuntime && taskCompletedInTime
        ? "completed"
        : elapsedLimitReached || reason === "timeout"
          ? "timeout"
          : String(reason || "finished");
      if (!RUN_END_REASONS.has(finalReason)) throw new TypeError(`unsupported run end reason: ${finalReason}`);
      this.status = finalReason;
      const result = this.snapshot();
      result.reason = finalReason;
      const finalSimulationTick = this.simulationDefinition
        ? this.simulationTick
        : this.recorder.latestSample()?.tick;
      if (Number.isInteger(finalSimulationTick)) result.simulationTick = finalSimulationTick;
      if (this.simulationDefinition && Number.isSafeInteger(finalSimulationTick)) {
        const latestSample = this.recorder.latestSample();
        const terminalTelemetry = this.previousEvaluationSample;
        if (latestSample?.tick !== finalSimulationTick
          && terminalTelemetry
          && terminalTelemetry.tick === finalSimulationTick) {
          this.recorder.sample(terminalTelemetry, true, this.elapsedMs());
          const terminalSample = this.recorder.latestSample();
          if (terminalSample) this.previousSample = { ...terminalSample, elapsedMs: terminalSample.t };
        }
        this.recorder.runEnd(finalReason, { tick: finalSimulationTick, source: "competition_session" }, this.elapsedMs());
      }
      this.recorder.event("run_finished", { reason: finalReason, score: result.score }, this.elapsedMs());
      this.finalRecord = this.recorder.finish(result, { simulationEndTick: finalSimulationTick });
      return clone(this.finalRecord);
    }
  }

  const GUANGYANG_SOURCE_IMAGE = {
    path: "./word/广阳岛仿真沙盘地图.png",
    naturalWidth: 1387,
    naturalHeight: 860,
    crop: { x: 26, y: 24, width: 1295, height: 777 },
    physicalWidthMeters: 5,
    physicalHeightMeters: 3,
    unitsPerMeter: 8,
    widthUnits: 40,
    heightUnits: 24,
    bakedVehiclePatch: {
      source: { x: 607, y: 207, width: 80, height: 56 },
      target: { x: 687, y: 207, width: 80, height: 56 }
    }
  };

  function sourcePixelToWorld(pixel, source = GUANGYANG_SOURCE_IMAGE) {
    const crop = source.crop;
    const scaleX = Number(source.widthUnits) / Number(crop.width);
    const scaleZ = Number(source.heightUnits) / Number(crop.height);
    const centerX = Number(crop.x) + Number(crop.width) / 2;
    const centerY = Number(crop.y) + Number(crop.height) / 2;
    return [
      round((Number(pixel[0]) - centerX) * scaleX, 4),
      round((Number(pixel[1]) - centerY) * scaleZ, 4)
    ];
  }

  function sourceRoad(id, width, speedLimit, sourcePoints, extra = {}) {
    return {
      id,
      width,
      speedLimit,
      sourcePoints: sourcePoints.map(point => [...point]),
      points: sourcePoints.map(point => sourcePixelToWorld(point)),
      ...extra
    };
  }

  function sourceLandmark(id, label, sourcePosition, extra = {}) {
    return { id, label, sourcePosition: [...sourcePosition], position: sourcePixelToWorld(sourcePosition), ...extra };
  }

  const GUANGYANG_ISLAND_CONFIG = {
    taskId: "R2-GYI-MVP-01",
    mapId: "guangyang-island",
    mapVersion: "2026.08-source-png-3d.3",
    taskVersion: "2026.08-composite-road-clearance.1",
    ruleVersion: "2026.08-configurable.8",
    displayName: "广阳岛综合任务1",
    timeLimitSeconds: 600,
    world: {
      size: 42,
      width: GUANGYANG_SOURCE_IMAGE.widthUnits,
      depth: GUANGYANG_SOURCE_IMAGE.heightUnits,
      sourceWidthMeters: GUANGYANG_SOURCE_IMAGE.physicalWidthMeters,
      sourceHeightMeters: GUANGYANG_SOURCE_IMAGE.physicalHeightMeters,
      unitsPerMeter: GUANGYANG_SOURCE_IMAGE.unitsPerMeter,
      sourceImage: GUANGYANG_SOURCE_IMAGE
    },
    start: [...sourcePixelToWorld([593, 164]), Math.PI],
    goal: sourcePixelToWorld([593, 164]),
    objectTaskOverlay: {
      schemaVersion: "chenlong.object-task-overlay/v2",
      packageRadius: 0.28,
      objects: [
        {
          id: "guangyang-target-1",
          role: "target",
          label: "红色目标物",
          sourcePosition: [354, 195],
          position: sourcePixelToWorld([354, 195]),
          radius: 0.28
        },
        {
          id: "guangyang-distractor-1",
          role: "distractor",
          label: "蓝色混淆物",
          sourcePosition: [412, 590],
          position: sourcePixelToWorld([412, 590]),
          radius: 0.28
        },
        {
          id: "guangyang-obstacle-1",
          role: "obstacle",
          label: "黄黑障碍物",
          sourcePosition: [319, 480],
          position: sourcePixelToWorld([319, 480]),
          radius: 0.52
        }
      ],
      zones: [
        {
          id: "guangyang-storage-zone",
          role: "storage",
          label: "存放点",
          sourcePosition: [326, 151],
          position: sourcePixelToWorld([326, 151]),
          radius: 0.95
        }
      ]
    },
    task: {
      schemaVersion: ROAD_CLEARANCE_TASK_SCHEMA_VERSION,
      type: "composite",
      checkpointRadius: 1.05,
      goalRadius: 1.05,
      deliveries: [
        {
          id: "delivery-target-storage",
          objectRole: "target",
          destinationRole: "storage",
          destination: sourcePixelToWorld([326, 151]),
          radius: 0.95,
          requiredPackageIds: ["guangyang-target-1"]
        },
        {
          id: "delivery-distractor-offroad-removal",
          objectRole: "distractor",
          destinationRole: "offroad-removal",
          placementRule: "road-edge-clearance",
          objectRadius: 0.28,
          minimumRoadEdgeClearance: 0.2,
          requiredPackageIds: ["guangyang-distractor-1"]
        }
      ],
      avoidanceObjectIds: ["guangyang-obstacle-1"]
    },
    checkpoints: [
      { id: "checkpoint-ds-lake", label: "戴胜湖路口", sourcePosition: [593, 333], position: sourcePixelToWorld([593, 333]) },
      { id: "checkpoint-egret", label: "白鹭湖", sourcePosition: [906, 307], position: sourcePixelToWorld([906, 307]) },
      { id: "checkpoint-rapeseed", label: "油菜花田", sourcePosition: [883, 427], position: sourcePixelToWorld([883, 427]) },
      { id: "checkpoint-camp", label: "神兽营地", sourcePosition: [817, 635], position: sourcePixelToWorld([817, 635]) }
    ],
    obstacles: [],
    roads: [
      sourceRoad("nw-bag", 2.35, 1.25, [[317, 143], [334, 150], [347, 160], [361, 180], [368, 200], [369, 220], [365, 234]]),
      sourceRoad("north-west-main", 2.25, 1.45, [[365, 234], [410, 236], [500, 235], [593, 235]]),
      sourceRoad("northwest-connector", 2.35, 1.25, [[365, 234], [353, 250], [337, 270], [322, 290], [313, 310], [307, 340], [302, 370], [298, 388]]),
      sourceRoad("parking-connector", 2.05, 0.75, [[593, 164], [593, 205], [593, 235]]),
      sourceRoad("north-east-main", 2.25, 1.45, [[593, 235], [690, 235], [747, 235], [820, 235], [870, 235]]),
      sourceRoad("central-north", 2.25, 1.25, [[593, 235], [594, 307], [593, 388]]),
      sourceRoad("bailu-west-arc", 2.35, 1.25, [[870, 235], [874, 250], [883, 270], [896, 290], [906, 307]]),
      sourceRoad("bailu-outer-arc", 2.45, 1.35, [[870, 235], [871, 210], [877, 190], [886, 170], [899, 150], [914, 130], [935, 115], [973, 106], [1027, 106], [1055, 113], [1078, 130], [1088, 155], [1093, 190], [1091, 230], [1083, 250], [1074, 270], [1063, 290], [1057, 307]]),
      sourceRoad("bailu-south", 2.25, 1.25, [[906, 307], [980, 307], [1057, 307]]),
      sourceRoad("bailu-to-middle", 2.3, 1.25, [[906, 307], [902, 327], [892, 337], [882, 347], [874, 357], [869, 367], [865, 388]]),
      sourceRoad("east-north-outer", 2.4, 1.45, [[1057, 307], [1061, 327], [1066, 337], [1076, 357], [1081, 367], [1090, 387], [1095, 397], [1106, 417], [1118, 437]]),
      sourceRoad("west-middle", 2.25, 1.45, [[125, 388], [200, 388], [298, 388]]),
      sourceRoad("middle-west", 2.25, 1.45, [[298, 388], [450, 388], [593, 388]]),
      sourceRoad("middle-east", 2.25, 1.45, [[593, 388], [700, 388], [800, 388], [865, 388]]),
      sourceRoad("oil-west-arc", 2.3, 1.2, [[865, 388], [868, 407], [875, 417], [883, 427], [891, 437], [899, 447], [906, 456]]),
      sourceRoad("oil-south", 2.25, 1.25, [[906, 456], [950, 455], [1010, 453], [1060, 450], [1100, 444], [1118, 437]]),
      sourceRoad("east-inner-south", 2.35, 1.2, [[906, 456], [913, 480], [915, 500], [912, 520], [905, 540], [896, 560], [881, 580], [860, 600], [838, 620], [817, 635]]),
      sourceRoad("east-outer-south", 2.45, 1.4, [[1118, 437], [1141, 450], [1153, 460], [1161, 470], [1168, 490], [1170, 510], [1168, 520], [1163, 530], [1158, 540], [1149, 550], [1139, 560], [1127, 570], [1112, 580], [1097, 590], [1080, 600], [1058, 610], [1020, 616], [995, 620], [984, 635], [979, 655], [974, 675], [954, 690], [947, 695], [828, 695]]),
      sourceRoad("west-south-connector", 2.35, 1.25, [[298, 388], [298, 430], [302, 460], [310, 470], [319, 480], [329, 490], [340, 500], [351, 510], [361, 520], [372, 530], [382, 540], [389, 550], [394, 559]]),
      sourceRoad("huangge-spur", 2.25, 1.1, [[394, 559], [397, 585], [397, 610], [397, 631]]),
      sourceRoad("lower-west", 2.25, 1.3, [[394, 559], [450, 557], [520, 556], [593, 556]]),
      sourceRoad("central-south", 2.25, 1.2, [[593, 388], [594, 470], [593, 556]]),
      sourceRoad("southwest-spur", 2.35, 1.2, [[593, 556], [590, 580], [584, 605], [577, 630], [565, 650], [552, 665], [532, 682], [508, 700], [482, 712], [450, 724], [420, 732], [403, 735]]),
      sourceRoad("lower-east", 2.35, 1.25, [[593, 556], [700, 556], [730, 562], [746, 570], [760, 584], [775, 598], [790, 612], [803, 620], [817, 635]]),
      sourceRoad("camp-connector", 2.3, 1.1, [[817, 635], [822, 650], [830, 670], [831, 682], [828, 695]]),
      sourceRoad("southeast-spur", 2.35, 1.15, [[828, 695], [825, 710], [816, 729], [800, 748], [785, 763]])
    ],
    trafficLights: [],
    speedZones: [
      { id: "south-slow-zone", sourceCenter: [965, 680], center: sourcePixelToWorld([965, 680]), radius: 2.2, speedLimit: 0.8 }
    ],
    prohibitedZones: [],
    landmarks: [
      sourceLandmark("tu'erping", "兔儿坪", [466, 160]),
      sourceLandmark("guangyangying", "广阳营", [716, 146]),
      sourceLandmark("wangjiangge", "望江阁", [1113, 57]),
      sourceLandmark("yanziping", "燕子坪", [1211, 176]),
      sourceLandmark("bailuhu", "白鹭湖", [996, 202], { water: true }),
      sourceLandmark("haisen", "嗨森营地", [1181, 278]),
      sourceLandmark("xidaotou", "西岛头", [176, 327]),
      sourceLandmark("longyandong", "龙岩洞", [459, 328]),
      sourceLandmark("daishenghu", "戴胜湖", [727, 327], { water: true }),
      sourceLandmark("yunquele", "云雀湖", [466, 483], { water: true }),
      sourceLandmark("guangyangdao", "广阳岛", [725, 486]),
      sourceLandmark("youcai", "油菜花田", [992, 392]),
      sourceLandmark("fendai", "粉黛草田", [1031, 525]),
      sourceLandmark("shenshou", "神兽营地", [909, 626]),
      sourceLandmark("gaofeng", "高峰梯田", [686, 674]),
      sourceLandmark("huanggelin", "黄葛林", [426, 650])
    ],
    scoring: {
      weights: { ...GUANGYANG_SCORE_WEIGHTS },
      penalties: { off_road: 2.5, speeding: 0, wrong_way: 0, red_light: 0, prohibited_zone: 0, collision: 1.7 },
      continuousPenalties: {
        off_road: { perSecond: 0.42 },
        speeding: { perSecond: 0 },
        wrong_way: { perSecond: 0 },
        prohibited_zone: { perSecond: 0 }
      },
      efficiency: { targetSeconds: 120, maxSeconds: 600 },
      autonomous: { penaltyPerIntervention: 15 }
    }
  };
  GUANGYANG_ISLAND_CONFIG.task.placementGeometry = {
    roads: GUANGYANG_ISLAND_CONFIG.roads.map(road => ({
      id: road.id,
      width: road.width,
      points: road.points.map(point => [...point])
    }))
  };
  GUANGYANG_ISLAND_CONFIG.rules = {
    unitsPerMeter: GUANGYANG_SOURCE_IMAGE.unitsPerMeter,
    speedingEnabled: false,
    wrongWayEnabled: false,
    redLightEnabled: false,
    prohibitedZonesEnabled: false,
    // Preserve the map's original 1.25 internal-unit node approach geometry,
    // expressed truthfully as physical centimetres for the 8-units/metre map.
    navigationJunctionRadiusCm: 15.6,
    vehicleRadius: 0.44,
    speedTolerance: 0.03,
    roads: GUANGYANG_ISLAND_CONFIG.roads,
    trafficLights: GUANGYANG_ISLAND_CONFIG.trafficLights,
    speedZones: GUANGYANG_ISLAND_CONFIG.speedZones,
    prohibitedZones: GUANGYANG_ISLAND_CONFIG.prohibitedZones
  };
  normalizeRoadPlacementGeometry(GUANGYANG_ISLAND_CONFIG.task.placementGeometry);

  // The public challenges share their road network, scoring model and time
  // limit. Difficulty grows by task scale: more packages, obstacles and
  // ordered checkpoints. Each challenge still owns an independent published
  // layout, so changing one never changes an already-started run or another
  // challenge.
  const GUANGYANG_CHALLENGE_EXTENSION = Object.freeze({
    2: Object.freeze({
      checkpoints: Object.freeze([
        Object.freeze({ id: "checkpoint-central-north", label: "中央北路口", sourcePosition: Object.freeze([593, 235]) }),
        Object.freeze({ id: "checkpoint-central-south", label: "中央南路口", sourcePosition: Object.freeze([593, 556]) })
      ]),
      objects: Object.freeze([
        Object.freeze({ id: "guangyang-target-2", role: "target", label: "红色目标物 2", sourcePosition: Object.freeze([975, 307]), radius: 0.28 }),
        Object.freeze({ id: "guangyang-distractor-2", role: "distractor", label: "蓝色混淆物 2", sourcePosition: Object.freeze([593, 270]), radius: 0.28 }),
        Object.freeze({ id: "guangyang-obstacle-2", role: "obstacle", label: "岩石障碍物 2", sourcePosition: Object.freeze([710, 388]), radius: 0.52 })
      ])
    }),
    3: Object.freeze({
      checkpoints: Object.freeze([
        Object.freeze({ id: "checkpoint-west-middle", label: "西中路口", sourcePosition: Object.freeze([298, 388]) }),
        Object.freeze({ id: "checkpoint-east-outer", label: "东外环路口", sourcePosition: Object.freeze([1118, 437]) })
      ]),
      objects: Object.freeze([
        Object.freeze({ id: "guangyang-target-3", role: "target", label: "红色目标物 3", sourcePosition: Object.freeze([1000, 453]), radius: 0.28 }),
        Object.freeze({ id: "guangyang-distractor-3", role: "distractor", label: "蓝色混淆物 3", sourcePosition: Object.freeze([893, 564]), radius: 0.28 }),
        Object.freeze({ id: "guangyang-obstacle-3", role: "obstacle", label: "岩石障碍物 3", sourcePosition: Object.freeze([1168, 490]), radius: 0.52 })
      ])
    })
  });

  function createGuangyangChallengeConfig({ taskId, taskVersion, displayName, difficulty }) {
    const config = clone(GUANGYANG_ISLAND_CONFIG);
    const additions = Object.keys(GUANGYANG_CHALLENGE_EXTENSION)
      .map(Number)
      .filter(level => level <= difficulty)
      .sort((left, right) => left - right)
      .reduce((result, level) => ({
        checkpoints: [...result.checkpoints, ...GUANGYANG_CHALLENGE_EXTENSION[level].checkpoints],
        objects: [...result.objects, ...GUANGYANG_CHALLENGE_EXTENSION[level].objects]
      }), { checkpoints: [], objects: [] });
    config.taskId = taskId;
    config.taskVersion = taskVersion;
    config.displayName = displayName;
    config.timeLimitSeconds = GUANGYANG_ISLAND_CONFIG.timeLimitSeconds;
    config.difficulty = difficulty;
    config.checkpoints = [
      ...config.checkpoints,
      ...additions.checkpoints.map(item => ({
        ...item,
        sourcePosition: [...item.sourcePosition],
        position: sourcePixelToWorld(item.sourcePosition)
      }))
    ];
    config.objectTaskOverlay.objects = [
      ...config.objectTaskOverlay.objects,
      ...additions.objects.map(item => ({
        ...item,
        sourcePosition: [...item.sourcePosition],
        position: sourcePixelToWorld(item.sourcePosition)
      }))
    ];
    const packageIdsForRole = role => config.objectTaskOverlay.objects
      .filter(item => item.role === role)
      .map(item => item.id);
    config.task.deliveries = config.task.deliveries.map(delivery => ({
      ...delivery,
      requiredPackageIds: packageIdsForRole(delivery.objectRole)
    }));
    config.task.avoidanceObjectIds = packageIdsForRole("obstacle");
    return deepFreeze(config);
  }

  const GUANGYANG_CHALLENGE_CONFIGS = deepFreeze([
    GUANGYANG_ISLAND_CONFIG,
    createGuangyangChallengeConfig({
      taskId: "R2-GYI-MVP-02",
      taskVersion: "2026.08-composite-road-clearance.2",
      displayName: "广阳岛综合任务2",
      difficulty: 2
    }),
    createGuangyangChallengeConfig({
      taskId: "R2-GYI-MVP-03",
      taskVersion: "2026.08-composite-road-clearance.3",
      displayName: "广阳岛综合任务3",
      difficulty: 3
    })
  ]);

  return {
    SCHEMA_VERSION,
    DETERMINISTIC_LEGACY_SCHEMA_VERSION,
    LEGACY_SCHEMA_VERSION,
    SIMULATION_SCHEMA_VERSION,
    VEHICLE_MODEL_VERSION,
    LEGACY_INTERACTION_SCHEMA_VERSION,
    INTERACTION_SCHEMA_VERSION,
    LEGACY_TASK_SCHEMA_VERSION,
    PREVIOUS_TASK_SCHEMA_VERSION,
    TASK_SCHEMA_VERSION,
    OFFROAD_TASK_SCHEMA_VERSION,
    ROAD_CLEARANCE_TASK_SCHEMA_VERSION,
    VISION_EVIDENCE_SCHEMA_VERSION,
    LEGACY_NAVIGATION_DEFINITION_SCHEMA_VERSION,
    PREVIOUS_NAVIGATION_DEFINITION_SCHEMA_VERSION,
    MISSION_NAVIGATION_DEFINITION_SCHEMA_VERSION,
    RELEASE_PREVIEW_NAVIGATION_DEFINITION_SCHEMA_VERSION,
    PREVIOUS_CURRENT_NAVIGATION_DEFINITION_SCHEMA_VERSION,
    NAVIGATION_DEFINITION_SCHEMA_VERSION,
    ROAD_GRAPH_SCHEMA_VERSION,
    LEGACY_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    PREVIOUS_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    RELEASE_PREVIEW_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    PREVIOUS_CURRENT_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    PREVIOUS_SAFE_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    PREVIOUS_EXIT_SAFE_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    PREVIOUS_UNIT_NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    NAVIGATION_CONTROL_DEFINITION_SCHEMA_VERSION,
    NAVIGATION_MISSION_SCHEMA_VERSION,
    TASK_STATE_SCHEMA_VERSION,
    RELEASE_PREVIEW_SCHEMA_VERSION,
    CAMERA_DEFINITION,
    CAMERA_DEFINITION_HASH,
    DETECTOR_DEFINITION,
    DETECTOR_DEFINITION_HASH,
    QUERY_DEFINITION,
    QUERY_DEFINITION_HASH,
    VISION_DEFINITION,
    VISION_DEFINITION_HASH,
    LEGACY_VISION_DEFINITION,
    LEGACY_VISION_DEFINITION_HASH,
    LEGACY_NAVIGATION_DEFINITION,
    PREVIOUS_NAVIGATION_DEFINITION,
    MISSION_NAVIGATION_DEFINITION,
    RELEASE_PREVIEW_NAVIGATION_DEFINITION,
    PREVIOUS_CURRENT_NAVIGATION_DEFINITION,
    PREVIOUS_PUBLIC_NAVIGATION_DEFINITION,
    NAVIGATION_DEFINITION,
    PUBLIC_NAVIGATION_DEFINITION,
    LEGACY_NAVIGATION_CONTROL_DEFINITION,
    PREVIOUS_NAVIGATION_CONTROL_DEFINITION,
    RELEASE_PREVIEW_NAVIGATION_CONTROL_DEFINITION,
    PREVIOUS_CURRENT_NAVIGATION_CONTROL_DEFINITION,
    PREVIOUS_SAFE_NAVIGATION_CONTROL_DEFINITION,
    PREVIOUS_EXIT_SAFE_NAVIGATION_CONTROL_DEFINITION,
    PREVIOUS_UNIT_NAVIGATION_CONTROL_DEFINITION,
    NAVIGATION_CONTROL_DEFINITION,
    COMPETITION_SCORE_MAXIMUM,
    GUANGYANG_SCORE_WEIGHTS,
    DEFAULT_FIXED_STEP_MS,
    DEFAULT_SAMPLE_INTERVAL_MS,
    GUANGYANG_ISLAND_CONFIG,
    GUANGYANG_CHALLENGE_CONFIGS,
    RuleEngine,
    TaskEngine,
    CompetitionJudge,
    SeededRandom,
    DeterministicSimulator,
    NavigationActionRunner,
    PackageStateEngine,
    ReplayPlayer,
    RunRecorder,
    CompetitionSession,
    geometry: {
      pointInPolygon,
      closestPointOnSegment,
      distanceToPolyline,
      nearestRoad,
      roadBoundaryClearance,
      segmentsIntersect,
      sourcePixelToWorld
    },
    trafficLightState,
    normalizeTaskDefinition: normalizeTaskConfig,
    validateFixedOffroadDeliveryGeometry,
    validateRoadClearancePlacementRules,
    normalizeSimulationDefinition,
    normalizeInteractionDefinition,
    normalizeVisionDefinition,
    normalizeVisionEvidence,
    normalizeNavigationDefinition,
    normalizeNavigationControlDefinition,
    normalizeNavigationControlAction,
    projectNavigationQuery,
    createNavigationTopologyContext,
    rejudgeTask,
    createSession(config, metadata, options) {
      return new CompetitionSession(config, metadata, options);
    }
  };
});
