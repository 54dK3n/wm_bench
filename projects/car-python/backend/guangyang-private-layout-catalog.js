"use strict";

// This module is deliberately kept under backend/. The current local simulator still
// sends an interaction definition to a browser, so this boundary is useful for keeping
// future layouts out of static assets, but it is not a claim that an active local
// browser cannot inspect the layout it is currently running.

const crypto = require("node:crypto");
const { canonicalJson } = require("./canonical-json.js");
const {
  GUANGYANG_ISLAND_CONFIG,
  INTERACTION_SCHEMA_VERSION,
  PackageStateEngine,
  geometry,
  normalizeInteractionDefinition,
  projectNavigationQuery
} = require("../competition-core.js");

const PRIVATE_LAYOUT_CATALOG_SCHEMA_VERSION = "chenlong.guangyang-private-layout-catalog/v1";
const PRIVATE_LAYOUT_SCHEMA_VERSION = "chenlong.guangyang-private-layout/v1";
const PRIVATE_ANCHOR_SCHEMA_VERSION = "chenlong.guangyang-private-anchor/v1";
const PRIVATE_LAYOUT_SELECTION_SCHEMA_VERSION = "chenlong.guangyang-private-layout-selection/v1";
const PUBLIC_LAYOUT_PROJECTION_SCHEMA_VERSION = "chenlong.guangyang-layout-slot/v1";
const PRIVATE_LAYOUT_CATALOG_SUMMARY_SCHEMA_VERSION = "chenlong.guangyang-layout-catalog-summary/v1";
// The original six-layout catalog remains the default until every persisted v1
// batch has aged out.  New consumers opt in to v2 through the registry or the
// purpose-specific selectors below; changing the legacy aliases would make an
// old batch recompute a different private sequence during integrity checks.
const GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1_VERSION = "2026.08-private-layouts.1";
const GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION = "2026.08-private-layouts.2";
const GUANGYANG_PRIVATE_LAYOUT_CATALOG_VERSION = GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1_VERSION;
const GUANGYANG_LAYOUT_SELECTION_POLICY_VERSION = "2026.08-purpose-selection.1";
const GUANGYANG_RANKED_LAYOUT_FORM_VERSION = "2026.08-ranked-form.1";

const ROLE_ORDER = Object.freeze(["target", "distractor", "obstacle"]);
const ROLE_SET = new Set(ROLE_ORDER);
const MIN_OBJECT_EDGE_GAP = 1.25;
const GRAB_APPROACH_DISTANCE = 1;
const OBSTACLE_ENDPOINT_MARGIN = 1.5;
const POSITION_EPSILON = 1e-6;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const CATALOG_KEYS = Object.freeze([
  "schemaVersion", "catalogVersion", "layoutSchemaVersion", "anchorSchemaVersion",
  "mapId", "mapVersion", "taskId", "taskVersion", "anchors", "layouts"
]);
const ANCHOR_KEYS = Object.freeze([
  "schemaVersion", "id", "role", "roadId", "sourcePosition", "radius"
]);
const LAYOUT_KEYS = Object.freeze([
  "schemaVersion", "id", "targetAnchorId", "distractorAnchorId", "obstacleAnchorId"
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    const extras = actual.filter(key => !wanted.includes(key));
    const missing = wanted.filter(key => !actual.includes(key));
    const detail = [
      extras.length ? `unsupported: ${extras.join(", ")}` : "",
      missing.length ? `missing: ${missing.join(", ")}` : ""
    ].filter(Boolean).join("; ");
    throw new TypeError(`${label} fields are invalid${detail ? ` (${detail})` : ""}`);
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must match ${ID_PATTERN}`);
  }
  return value;
}

function finitePositive(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number`);
  }
  return value;
}

function sourcePoint(value, label, sourceImage) {
  if (!Array.isArray(value) || value.length !== 2
    || Object.keys(value).some(key => key !== "0" && key !== "1")) {
    throw new TypeError(`${label} must be exactly one [x, y] source-pixel pair`);
  }
  const point = value.map(Number);
  if (!point.every(Number.isFinite)) throw new TypeError(`${label} must contain finite numbers`);
  const crop = sourceImage?.crop;
  if (!crop || ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)) {
    throw new TypeError("Guangyang source-image crop is unavailable");
  }
  if (point[0] < crop.x || point[0] > crop.x + crop.width
    || point[1] < crop.y || point[1] > crop.y + crop.height) {
    throw new RangeError(`${label} lies outside the Guangyang source-image crop`);
  }
  return point;
}

function distance(left, right) {
  return Math.hypot(Number(left[0]) - Number(right[0]), Number(left[1]) - Number(right[1]));
}

function selectionSecret(value) {
  let secret;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) secret = Buffer.from(value);
  else if (typeof value === "string") secret = Buffer.from(value, "utf8");
  else throw new TypeError("layout selection secret must be a string or byte array");
  if (secret.length < 32 || secret.length > 4096) {
    throw new RangeError("layout selection secret must contain between 32 and 4096 bytes");
  }
  return secret;
}

function selectionSeed(value) {
  if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) return `u32:${value}`;
  if (typeof value !== "string") {
    throw new TypeError("layout selection seed must be an unsigned 32-bit integer or string");
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (!value || bytes > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new TypeError("layout selection seed string must contain 1-256 bytes without control characters");
  }
  return `text:${value}`;
}

function hmacHex(secret, value) {
  return crypto.createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

function roleBindings(config) {
  const overlay = plainRecord(config?.objectTaskOverlay, "Guangyang object task overlay");
  const objects = Array.isArray(overlay.objects) ? overlay.objects : [];
  const bindings = Object.create(null);
  ROLE_ORDER.forEach(role => {
    const matches = objects.filter(item => item?.role === role);
    if (matches.length !== 1) throw new TypeError(`Guangyang overlay must define exactly one ${role}`);
    const item = matches[0];
    bindings[role] = {
      id: identifier(item.id, `Guangyang ${role} object id`),
      radius: finitePositive(Number(item.radius), `Guangyang ${role} radius`)
    };
  });

  const task = plainRecord(config?.task, "Guangyang task");
  const deliveries = Array.isArray(task.deliveries) ? task.deliveries : [];
  for (const role of ["target", "distractor"]) {
    const matches = deliveries.filter(item => item?.objectRole === role);
    if (matches.length !== 1 || !Array.isArray(matches[0].requiredPackageIds)
      || matches[0].requiredPackageIds.length !== 1) {
      throw new TypeError(`Guangyang task must bind exactly one ${role} delivery object`);
    }
    if (matches[0].requiredPackageIds[0] !== bindings[role].id) {
      throw new TypeError(`Guangyang ${role} delivery does not match its interaction object id`);
    }
    const delivery = matches[0];
    if (delivery.placementRule === "road-edge-clearance") {
      if (role !== "distractor") {
        throw new TypeError("only the Guangyang distractor may use road-edge-clearance placement");
      }
      bindings[role].placementRule = "road-edge-clearance";
      bindings[role].minimumRoadEdgeClearance = finitePositive(
        Number(delivery.minimumRoadEdgeClearance),
        "Guangyang distractor minimum road-edge clearance"
      );
    } else {
      bindings[role].destination = [Number(delivery.destination?.[0]), Number(delivery.destination?.[1])];
      bindings[role].destinationRadius = finitePositive(Number(delivery.radius),
        `Guangyang ${role} destination radius`);
      if (!bindings[role].destination.every(Number.isFinite)) {
        throw new TypeError(`Guangyang ${role} destination must be finite`);
      }
    }
  }

  if (!Array.isArray(task.avoidanceObjectIds) || task.avoidanceObjectIds.length !== 1
    || task.avoidanceObjectIds[0] !== bindings.obstacle.id) {
    throw new TypeError("Guangyang task must bind exactly one matching obstacle avoidance object");
  }
  return bindings;
}

function interactionBounds(config) {
  const width = Number(config?.world?.width);
  const depth = Number(config?.world?.depth);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(depth) || depth <= 0) {
    throw new TypeError("Guangyang world bounds are unavailable");
  }
  return { minX: -width / 2, maxX: width / 2, minZ: -depth / 2, maxZ: depth / 2 };
}

function buildRoadGraph(config) {
  return projectNavigationQuery("map_graph", { rules: config.rules });
}

function routeExistsWithoutRoad(graph, blockedRoadId, fromNodeId, toNodeId) {
  const adjacency = new Map();
  const add = (from, to) => {
    const next = adjacency.get(from) || [];
    next.push(to);
    adjacency.set(from, next);
  };
  graph.edges.forEach(edge => {
    if (edge.roadId === blockedRoadId) return;
    add(edge.fromNodeId, edge.toNodeId);
    if (!edge.oneWay) add(edge.toNodeId, edge.fromNodeId);
  });
  const queue = [fromNodeId];
  const visited = new Set(queue);
  while (queue.length) {
    const nodeId = queue.shift();
    if (nodeId === toNodeId) return true;
    (adjacency.get(nodeId) || []).forEach(next => {
      if (visited.has(next)) return;
      visited.add(next);
      queue.push(next);
    });
  }
  return false;
}

function assertObstacleAlternativeRoute(anchor, match, graph, config) {
  const edge = graph.edges.find(item => item.roadId === anchor.roadId);
  if (!edge) throw new TypeError(`anchor ${anchor.id} road is missing from the public topology`);
  const forwardAlternative = routeExistsWithoutRoad(graph, anchor.roadId, edge.fromNodeId, edge.toNodeId);
  const reverseAlternative = edge.oneWay
    ? true
    : routeExistsWithoutRoad(graph, anchor.roadId, edge.toNodeId, edge.fromNodeId);
  if (!forwardAlternative || !reverseAlternative) {
    throw new RangeError(`obstacle anchor ${anchor.id} has no legal alternative route around ${anchor.roadId}`);
  }

  const road = match.road;
  const vehicleRadius = finitePositive(Number(config.rules?.vehicleRadius), "Guangyang vehicle radius");
  const collisionSkin = 0.005;
  const maximumLegalCenterOffset = Math.max(0, Number(road.width) / 2 - vehicleRadius - collisionSkin);
  const farthestCrossSectionSeparation = maximumLegalCenterOffset + match.distance;
  if (farthestCrossSectionSeparation + POSITION_EPSILON
    >= vehicleRadius + collisionSkin + anchor.radius) {
    throw new RangeError(`obstacle anchor ${anchor.id} leaves enough road width to pass without taking an alternative`);
  }

  const first = road.points[0];
  const last = road.points[road.points.length - 1];
  if (Math.min(distance(anchor.position, first), distance(anchor.position, last)) < OBSTACLE_ENDPOINT_MARGIN) {
    throw new RangeError(`obstacle anchor ${anchor.id} is too close to a road endpoint for an auditable detour`);
  }
}

function findGrabApproaches(anchor, match, config) {
  const tangentLength = Math.hypot(match.tangent?.[0] || 0, match.tangent?.[1] || 0);
  if (tangentLength <= POSITION_EPSILON) return [];
  const tangent = [match.tangent[0] / tangentLength, match.tangent[1] / tangentLength];
  const vehicleRadius = Number(config.rules.vehicleRadius);
  const bounds = interactionBounds(config);
  const approaches = [];
  for (const sign of [-1, 1]) {
    const direction = [tangent[0] * sign, tangent[1] * sign];
    const pose = {
      x: anchor.position[0] - direction[0] * GRAB_APPROACH_DISTANCE,
      z: anchor.position[1] - direction[1] * GRAB_APPROACH_DISTANCE,
      heading: Math.atan2(-direction[0], -direction[1])
    };
    const insideBounds = pose.x >= bounds.minX + vehicleRadius
      && pose.x <= bounds.maxX - vehicleRadius
      && pose.z >= bounds.minZ + vehicleRadius
      && pose.z <= bounds.maxZ - vehicleRadius;
    if (!insideBounds) continue;
    const roadMatch = geometry.nearestRoad([pose.x, pose.z], config.roads, vehicleRadius + 0.005);
    if (roadMatch.onRoad) approaches.push(pose);
  }
  return approaches;
}

function normalizeAnchor(source, index, context) {
  plainRecord(source, `private anchor ${index}`);
  assertExactKeys(source, ANCHOR_KEYS, `private anchor ${index}`);
  if (source.schemaVersion !== PRIVATE_ANCHOR_SCHEMA_VERSION) {
    throw new TypeError(`private anchor ${index} uses an unsupported schema`);
  }
  const id = identifier(source.id, `private anchor ${index}.id`);
  const role = String(source.role || "");
  if (!ROLE_SET.has(role)) throw new TypeError(`private anchor ${id}.role is invalid`);
  const roadId = identifier(source.roadId, `private anchor ${id}.roadId`);
  if (!context.roadById.has(roadId)) throw new TypeError(`private anchor ${id} references an unknown road`);
  const radius = finitePositive(source.radius, `private anchor ${id}.radius`);
  if (Math.abs(radius - context.bindings[role].radius) > POSITION_EPSILON) {
    throw new RangeError(`private anchor ${id}.radius must match the canonical ${role} radius`);
  }
  const normalized = {
    schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION,
    id,
    role,
    roadId,
    sourcePosition: sourcePoint(source.sourcePosition, `private anchor ${id}.sourcePosition`, context.sourceImage),
    radius
  };
  return normalized;
}

function deriveAnchor(anchor, context) {
  const position = geometry.sourcePixelToWorld(anchor.sourcePosition, context.sourceImage);
  const derived = { ...anchor, position };
  const bounds = context.bounds;
  if (position[0] < bounds.minX + anchor.radius || position[0] > bounds.maxX - anchor.radius
    || position[1] < bounds.minZ + anchor.radius || position[1] > bounds.maxZ - anchor.radius) {
    throw new RangeError(`private anchor ${anchor.id} lies outside the interaction bounds`);
  }
  const match = geometry.nearestRoad(position, context.config.roads, anchor.radius);
  if (!match.onRoad || match.road?.id !== anchor.roadId) {
    throw new RangeError(`private anchor ${anchor.id} is not fully on its declared road ${anchor.roadId}`);
  }

  const start = context.config.start;
  const initialClearance = distance(position, start)
    - anchor.radius - Number(context.config.rules.vehicleRadius) - 0.005;
  if (initialClearance <= POSITION_EPSILON) {
    throw new RangeError(`private anchor ${anchor.id} overlaps the initial vehicle pose`);
  }

  if (anchor.role === "target" || anchor.role === "distractor") {
    const binding = context.bindings[anchor.role];
    if (binding.placementRule === "road-edge-clearance") {
      const clearance = geometry.roadBoundaryClearance(position, context.config.roads, anchor.radius);
      if (clearance.clearance + POSITION_EPSILON >= binding.minimumRoadEdgeClearance) {
        throw new RangeError(`private anchor ${anchor.id} begins with road-edge removal already complete`);
      }
    } else if (distance(position, binding.destination) <= binding.destinationRadius + POSITION_EPSILON) {
      throw new RangeError(`private anchor ${anchor.id} begins inside its completed destination`);
    }
    derived.approaches = findGrabApproaches(derived, match, context.config);
    if (!derived.approaches.length) {
      throw new RangeError(`private anchor ${anchor.id} has no drivable grab approach`);
    }
  } else {
    assertObstacleAlternativeRoute(derived, match, context.graph, context.config);
    derived.approaches = [];
  }
  return derived;
}

function normalizeLayout(source, index, anchorsById) {
  plainRecord(source, `private layout ${index}`);
  assertExactKeys(source, LAYOUT_KEYS, `private layout ${index}`);
  if (source.schemaVersion !== PRIVATE_LAYOUT_SCHEMA_VERSION) {
    throw new TypeError(`private layout ${index} uses an unsupported schema`);
  }
  const id = identifier(source.id, `private layout ${index}.id`);
  const result = { schemaVersion: PRIVATE_LAYOUT_SCHEMA_VERSION, id };
  ROLE_ORDER.forEach(role => {
    const field = `${role}AnchorId`;
    const anchorId = identifier(source[field], `private layout ${id}.${field}`);
    const anchor = anchorsById.get(anchorId);
    if (!anchor) throw new TypeError(`private layout ${id} references an unknown ${role} anchor`);
    if (anchor.role !== role) {
      throw new TypeError(`private layout ${id} ${role} placement references a ${anchor.role} anchor`);
    }
    result[field] = anchorId;
  });
  return result;
}

function defaultRawInteractionDefinition(config) {
  return {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    packageRadius: Number(config.objectTaskOverlay.packageRadius) || 0.28,
    stackKeyDigits: 3,
    bounds: interactionBounds(config),
    grab: { minForward: 0.38, maxForward: 1.35, maxLateral: 0.38 },
    release: { forwardOffset: 1.1, lateralOffset: 0, stackSnapDistance: 0.62 },
    packages: []
  };
}

function interactionForLayout(layout, derivedAnchorsById, context, baseInteractionDefinition = null) {
  const base = baseInteractionDefinition
    ? normalizeInteractionDefinition(baseInteractionDefinition)
    : normalizeInteractionDefinition(defaultRawInteractionDefinition(context.config));
  const packages = ROLE_ORDER.map(role => {
    const anchor = derivedAnchorsById.get(layout[`${role}AnchorId`]);
    return {
      id: context.bindings[role].id,
      x: anchor.position[0],
      z: anchor.position[1],
      stackLevel: 0,
      role,
      radius: anchor.radius
    };
  });
  return normalizeInteractionDefinition({
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    packageRadius: base.packageRadius,
    stackKeyDigits: 3,
    bounds: base.bounds,
    grab: base.grab,
    release: base.release,
    packages
  });
}

function assertLayoutGeometry(layout, derivedAnchorsById, context) {
  const anchors = ROLE_ORDER.map(role => derivedAnchorsById.get(layout[`${role}AnchorId`]));
  for (let left = 0; left < anchors.length; left += 1) {
    for (let right = left + 1; right < anchors.length; right += 1) {
      const edgeGap = distance(anchors[left].position, anchors[right].position)
        - anchors[left].radius - anchors[right].radius;
      if (edgeGap + POSITION_EPSILON < MIN_OBJECT_EDGE_GAP) {
        throw new RangeError(`private layout ${layout.id} object spacing is below ${MIN_OBJECT_EDGE_GAP}`);
      }
    }
  }

  const interactionDefinition = interactionForLayout(layout, derivedAnchorsById, context);
  for (const role of ["target", "distractor"]) {
    const anchor = derivedAnchorsById.get(layout[`${role}AnchorId`]);
    const collisionFreeApproaches = anchor.approaches.filter(pose => anchors.every(other => {
      if (other === anchor) return true;
      return Math.hypot(pose.x - other.position[0], pose.z - other.position[1])
        > Number(context.config.rules.vehicleRadius) + 0.005 + other.radius + POSITION_EPSILON;
    }));
    const grabbable = collisionFreeApproaches.some(pose => {
      const engine = new PackageStateEngine(interactionDefinition);
      const outcome = engine.applyGrab({ packageId: context.bindings[role].id }, pose);
      return outcome.accepted && outcome.reason === "grabbed" && outcome.objectRole === role;
    });
    if (!grabbable) throw new RangeError(`private layout ${layout.id} ${role} has no collision-free legal grab pose`);
  }
  return interactionDefinition;
}

function validationContext(config) {
  const sourceImage = plainRecord(config?.world?.sourceImage, "Guangyang source image");
  const roads = Array.isArray(config?.roads) ? config.roads : [];
  if (!roads.length) throw new TypeError("Guangyang layout validation requires roads");
  return {
    config,
    sourceImage,
    bounds: interactionBounds(config),
    bindings: roleBindings(config),
    graph: buildRoadGraph(config),
    roadById: new Map(roads.map(road => [road.id, road]))
  };
}

function validateGuangyangLayoutCatalog(input, options = {}) {
  const config = options.config || GUANGYANG_ISLAND_CONFIG;
  plainRecord(input, "private layout catalog");
  assertExactKeys(input, CATALOG_KEYS, "private layout catalog");
  if (input.schemaVersion !== PRIVATE_LAYOUT_CATALOG_SCHEMA_VERSION) {
    throw new TypeError("private layout catalog uses an unsupported schema");
  }
  if (input.layoutSchemaVersion !== PRIVATE_LAYOUT_SCHEMA_VERSION
    || input.anchorSchemaVersion !== PRIVATE_ANCHOR_SCHEMA_VERSION) {
    throw new TypeError("private layout catalog declares unsupported member schemas");
  }
  const catalogVersion = identifier(input.catalogVersion, "private layout catalog.catalogVersion");
  for (const field of ["mapId", "mapVersion", "taskId", "taskVersion"]) {
    if (input[field] !== config[field]) {
      throw new TypeError(`private layout catalog ${field} does not match the Guangyang configuration`);
    }
  }
  if (!Array.isArray(input.anchors) || input.anchors.length < ROLE_ORDER.length) {
    throw new TypeError("private layout catalog requires anchors for all three roles");
  }
  if (!Array.isArray(input.layouts) || input.layouts.length < 3) {
    throw new TypeError("private layout catalog requires at least three layouts");
  }

  const context = validationContext(config);
  const anchors = input.anchors.map((source, index) => normalizeAnchor(source, index, context));
  const anchorIds = new Set();
  const anchorPositions = new Set();
  anchors.forEach(anchor => {
    if (anchorIds.has(anchor.id)) throw new TypeError(`private anchor id must be unique: ${anchor.id}`);
    anchorIds.add(anchor.id);
    const positionKey = anchor.sourcePosition.map(value => Number(value).toFixed(6)).join(",");
    if (anchorPositions.has(positionKey)) {
      throw new TypeError(`private anchor source position must be unique: ${positionKey}`);
    }
    anchorPositions.add(positionKey);
  });
  ROLE_ORDER.forEach(role => {
    if (!anchors.some(anchor => anchor.role === role)) {
      throw new TypeError(`private layout catalog has no ${role} anchor`);
    }
  });
  const anchorsById = new Map(anchors.map(anchor => [anchor.id, anchor]));
  const derivedAnchors = anchors.map(anchor => deriveAnchor(anchor, context));
  const derivedAnchorsById = new Map(derivedAnchors.map(anchor => [anchor.id, anchor]));

  const layouts = input.layouts.map((source, index) => normalizeLayout(source, index, anchorsById));
  const layoutIds = new Set();
  const layoutAssignments = new Set();
  const usedAnchorIds = new Set();
  layouts.forEach(layout => {
    if (layoutIds.has(layout.id) || anchorIds.has(layout.id)) {
      throw new TypeError(`private layout id must be globally unique: ${layout.id}`);
    }
    layoutIds.add(layout.id);
    const assignment = ROLE_ORDER.map(role => layout[`${role}AnchorId`]).join("\0");
    if (layoutAssignments.has(assignment)) {
      throw new TypeError(`private layout assignments must be unique: ${layout.id}`);
    }
    layoutAssignments.add(assignment);
    ROLE_ORDER.forEach(role => usedAnchorIds.add(layout[`${role}AnchorId`]));
    assertLayoutGeometry(layout, derivedAnchorsById, context);
  });
  const unusedAnchor = anchors.find(anchor => !usedAnchorIds.has(anchor.id));
  if (unusedAnchor) throw new TypeError(`private anchor is not used by any layout: ${unusedAnchor.id}`);

  return deepFreeze({
    schemaVersion: PRIVATE_LAYOUT_CATALOG_SCHEMA_VERSION,
    catalogVersion,
    layoutSchemaVersion: PRIVATE_LAYOUT_SCHEMA_VERSION,
    anchorSchemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION,
    mapId: config.mapId,
    mapVersion: config.mapVersion,
    taskId: config.taskId,
    taskVersion: config.taskVersion,
    anchors,
    layouts
  });
}

const RAW_GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1 = {
  schemaVersion: PRIVATE_LAYOUT_CATALOG_SCHEMA_VERSION,
  catalogVersion: GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1_VERSION,
  layoutSchemaVersion: PRIVATE_LAYOUT_SCHEMA_VERSION,
  anchorSchemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION,
  mapId: GUANGYANG_ISLAND_CONFIG.mapId,
  mapVersion: GUANGYANG_ISLAND_CONFIG.mapVersion,
  taskId: GUANGYANG_ISLAND_CONFIG.taskId,
  taskVersion: GUANGYANG_ISLAND_CONFIG.taskVersion,
  anchors: [
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "t-northwest-lane", role: "target", roadId: "north-west-main", sourcePosition: [470, 235], radius: 0.28 },
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "t-bailu-south-lane", role: "target", roadId: "bailu-south", sourcePosition: [975, 307], radius: 0.28 },
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "t-lower-east-lane", role: "target", roadId: "lower-east", sourcePosition: [690, 556], radius: 0.28 },
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "t-east-outer-lane", role: "target", roadId: "east-outer-south", sourcePosition: [1088.5, 595], radius: 0.28 },
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "t-middle-west-lane", role: "target", roadId: "middle-west", sourcePosition: [455, 388], radius: 0.28 },
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "t-oil-south-lane", role: "target", roadId: "oil-south", sourcePosition: [1000, 453.333], radius: 0.28 },

    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "d-northwest-curve", role: "distractor", roadId: "northwest-connector", sourcePosition: [329.5, 280], radius: 0.28 },
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "d-central-north-lane", role: "distractor", roadId: "central-north", sourcePosition: [593.5, 310], radius: 0.28 },
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "d-east-inner-curve", role: "distractor", roadId: "east-inner-south", sourcePosition: [893, 564], radius: 0.28 },
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "d-west-south-curve", role: "distractor", roadId: "west-south-connector", sourcePosition: [355, 514], radius: 0.28 },
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "d-central-south-lane", role: "distractor", roadId: "central-south", sourcePosition: [593.5, 475], radius: 0.28 },
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "d-bailu-outer-arc", role: "distractor", roadId: "bailu-outer-arc", sourcePosition: [968, 107.2], radius: 0.28 },

    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "o-north-east-block", role: "obstacle", roadId: "north-east-main", sourcePosition: [755, 235], radius: 0.52 },
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "o-middle-east-block", role: "obstacle", roadId: "middle-east", sourcePosition: [710, 388], radius: 0.52 },
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "o-lower-west-block", role: "obstacle", roadId: "lower-west", sourcePosition: [525, 556], radius: 0.52 },
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "o-east-inner-block", role: "obstacle", roadId: "east-inner-south", sourcePosition: [884, 576], radius: 0.52 },
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "o-west-south-block", role: "obstacle", roadId: "west-south-connector", sourcePosition: [345, 505], radius: 0.52 },
    { schemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION, id: "o-bailu-outer-block", role: "obstacle", roadId: "bailu-outer-arc", sourcePosition: [1020, 106], radius: 0.52 }
  ],
  layouts: [
    { schemaVersion: PRIVATE_LAYOUT_SCHEMA_VERSION, id: "gyi-layout-a1", targetAnchorId: "t-northwest-lane", distractorAnchorId: "d-east-inner-curve", obstacleAnchorId: "o-middle-east-block" },
    { schemaVersion: PRIVATE_LAYOUT_SCHEMA_VERSION, id: "gyi-layout-b2", targetAnchorId: "t-bailu-south-lane", distractorAnchorId: "d-west-south-curve", obstacleAnchorId: "o-north-east-block" },
    { schemaVersion: PRIVATE_LAYOUT_SCHEMA_VERSION, id: "gyi-layout-c3", targetAnchorId: "t-lower-east-lane", distractorAnchorId: "d-northwest-curve", obstacleAnchorId: "o-bailu-outer-block" },
    { schemaVersion: PRIVATE_LAYOUT_SCHEMA_VERSION, id: "gyi-layout-d4", targetAnchorId: "t-east-outer-lane", distractorAnchorId: "d-central-north-lane", obstacleAnchorId: "o-lower-west-block" },
    { schemaVersion: PRIVATE_LAYOUT_SCHEMA_VERSION, id: "gyi-layout-e5", targetAnchorId: "t-middle-west-lane", distractorAnchorId: "d-bailu-outer-arc", obstacleAnchorId: "o-east-inner-block" },
    { schemaVersion: PRIVATE_LAYOUT_SCHEMA_VERSION, id: "gyi-layout-f6", targetAnchorId: "t-oil-south-lane", distractorAnchorId: "d-central-south-lane", obstacleAnchorId: "o-west-south-block" }
  ]
};

// Frozen v2 assignment manifest.  These rows are an explicit allowlist, not a
// runtime random generator.  They are the 198 members accepted from the full
// 6 x 6 x 6 anchor product by the same strict catalog validator.  The omitted
// 18 assignments are exactly (d3,o4), (d4,o5), and (d6,o6), for every target;
// each omitted pair violates MIN_OBJECT_EDGE_GAP.
const V2_LAYOUT_ASSIGNMENT_MANIFEST = Object.freeze([
  // target anchor 1
  "t1d1o1", "t1d1o2", "t1d1o3", "t1d1o4", "t1d1o5", "t1d1o6",
  "t1d2o1", "t1d2o2", "t1d2o3", "t1d2o4", "t1d2o5", "t1d2o6",
  "t1d3o1", "t1d3o2", "t1d3o3", "t1d3o5", "t1d3o6", "t1d4o1",
  "t1d4o2", "t1d4o3", "t1d4o4", "t1d4o6", "t1d5o1", "t1d5o2",
  "t1d5o3", "t1d5o4", "t1d5o5", "t1d5o6", "t1d6o1", "t1d6o2",
  "t1d6o3", "t1d6o4", "t1d6o5",
  // target anchor 2
  "t2d1o1", "t2d1o2", "t2d1o3", "t2d1o4", "t2d1o5", "t2d1o6",
  "t2d2o1", "t2d2o2", "t2d2o3", "t2d2o4", "t2d2o5", "t2d2o6",
  "t2d3o1", "t2d3o2", "t2d3o3", "t2d3o5", "t2d3o6", "t2d4o1",
  "t2d4o2", "t2d4o3", "t2d4o4", "t2d4o6", "t2d5o1", "t2d5o2",
  "t2d5o3", "t2d5o4", "t2d5o5", "t2d5o6", "t2d6o1", "t2d6o2",
  "t2d6o3", "t2d6o4", "t2d6o5",
  // target anchor 3
  "t3d1o1", "t3d1o2", "t3d1o3", "t3d1o4", "t3d1o5", "t3d1o6",
  "t3d2o1", "t3d2o2", "t3d2o3", "t3d2o4", "t3d2o5", "t3d2o6",
  "t3d3o1", "t3d3o2", "t3d3o3", "t3d3o5", "t3d3o6", "t3d4o1",
  "t3d4o2", "t3d4o3", "t3d4o4", "t3d4o6", "t3d5o1", "t3d5o2",
  "t3d5o3", "t3d5o4", "t3d5o5", "t3d5o6", "t3d6o1", "t3d6o2",
  "t3d6o3", "t3d6o4", "t3d6o5",
  // target anchor 4
  "t4d1o1", "t4d1o2", "t4d1o3", "t4d1o4", "t4d1o5", "t4d1o6",
  "t4d2o1", "t4d2o2", "t4d2o3", "t4d2o4", "t4d2o5", "t4d2o6",
  "t4d3o1", "t4d3o2", "t4d3o3", "t4d3o5", "t4d3o6", "t4d4o1",
  "t4d4o2", "t4d4o3", "t4d4o4", "t4d4o6", "t4d5o1", "t4d5o2",
  "t4d5o3", "t4d5o4", "t4d5o5", "t4d5o6", "t4d6o1", "t4d6o2",
  "t4d6o3", "t4d6o4", "t4d6o5",
  // target anchor 5
  "t5d1o1", "t5d1o2", "t5d1o3", "t5d1o4", "t5d1o5", "t5d1o6",
  "t5d2o1", "t5d2o2", "t5d2o3", "t5d2o4", "t5d2o5", "t5d2o6",
  "t5d3o1", "t5d3o2", "t5d3o3", "t5d3o5", "t5d3o6", "t5d4o1",
  "t5d4o2", "t5d4o3", "t5d4o4", "t5d4o6", "t5d5o1", "t5d5o2",
  "t5d5o3", "t5d5o4", "t5d5o5", "t5d5o6", "t5d6o1", "t5d6o2",
  "t5d6o3", "t5d6o4", "t5d6o5",
  // target anchor 6
  "t6d1o1", "t6d1o2", "t6d1o3", "t6d1o4", "t6d1o5", "t6d1o6",
  "t6d2o1", "t6d2o2", "t6d2o3", "t6d2o4", "t6d2o5", "t6d2o6",
  "t6d3o1", "t6d3o2", "t6d3o3", "t6d3o5", "t6d3o6", "t6d4o1",
  "t6d4o2", "t6d4o3", "t6d4o4", "t6d4o6", "t6d5o1", "t6d5o2",
  "t6d5o3", "t6d5o4", "t6d5o5", "t6d5o6", "t6d6o1", "t6d6o2",
  "t6d6o3", "t6d6o4", "t6d6o5"
]);

const V2_ANCHOR_IDS_BY_ROLE = deepFreeze({
  target: [
    "t-northwest-lane", "t-bailu-south-lane", "t-lower-east-lane",
    "t-east-outer-lane", "t-middle-west-lane", "t-oil-south-lane"
  ],
  distractor: [
    "d-northwest-curve", "d-central-north-lane", "d-east-inner-curve",
    "d-west-south-curve", "d-central-south-lane", "d-bailu-outer-arc"
  ],
  obstacle: [
    "o-north-east-block", "o-middle-east-block", "o-lower-west-block",
    "o-east-inner-block", "o-west-south-block", "o-bailu-outer-block"
  ]
});

function layoutFromV2Assignment(assignment) {
  const match = /^t([1-6])d([1-6])o([1-6])$/.exec(assignment);
  if (!match) throw new TypeError(`invalid frozen v2 layout assignment: ${assignment}`);
  const targetIndex = Number(match[1]) - 1;
  const distractorIndex = Number(match[2]) - 1;
  const obstacleIndex = Number(match[3]) - 1;
  return {
    schemaVersion: PRIVATE_LAYOUT_SCHEMA_VERSION,
    id: `gyi-v2-${assignment}`,
    targetAnchorId: V2_ANCHOR_IDS_BY_ROLE.target[targetIndex],
    distractorAnchorId: V2_ANCHOR_IDS_BY_ROLE.distractor[distractorIndex],
    obstacleAnchorId: V2_ANCHOR_IDS_BY_ROLE.obstacle[obstacleIndex]
  };
}

const RAW_GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2 = {
  schemaVersion: PRIVATE_LAYOUT_CATALOG_SCHEMA_VERSION,
  catalogVersion: GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION,
  layoutSchemaVersion: PRIVATE_LAYOUT_SCHEMA_VERSION,
  anchorSchemaVersion: PRIVATE_ANCHOR_SCHEMA_VERSION,
  mapId: GUANGYANG_ISLAND_CONFIG.mapId,
  mapVersion: GUANGYANG_ISLAND_CONFIG.mapVersion,
  taskId: GUANGYANG_ISLAND_CONFIG.taskId,
  taskVersion: GUANGYANG_ISLAND_CONFIG.taskVersion,
  anchors: RAW_GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1.anchors,
  layouts: V2_LAYOUT_ASSIGNMENT_MANIFEST.map(layoutFromV2Assignment)
};

const GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1 = validateGuangyangLayoutCatalog(
  RAW_GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1
);
const GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2 = validateGuangyangLayoutCatalog(
  RAW_GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2
);
const GUANGYANG_PRIVATE_LAYOUT_CATALOG = GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1;

const GUANGYANG_PRIVATE_LAYOUT_CATALOG_REGISTRY = deepFreeze({
  [GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1_VERSION]: GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1,
  [GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION]: GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2
});

const GUANGYANG_RANKED_LAYOUT_FORM_V2 = Object.freeze([
  "gyi-v2-t5d1o3",
  "gyi-v2-t2d5o2",
  "gyi-v2-t1d6o4",
  "gyi-v2-t3d3o5",
  "gyi-v2-t4d4o1"
]);
const rankedLayoutIdSet = new Set(GUANGYANG_RANKED_LAYOUT_FORM_V2);
const GUANGYANG_PRACTICE_LAYOUT_POOL_V2 = Object.freeze(
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2.layouts
    .map(layout => layout.id)
    .filter(layoutId => !rankedLayoutIdSet.has(layoutId))
);

if (rankedLayoutIdSet.size !== 5
  || GUANGYANG_RANKED_LAYOUT_FORM_V2.some(layoutId => (
    !GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2.layouts.some(layout => layout.id === layoutId)
  ))
  || GUANGYANG_PRACTICE_LAYOUT_POOL_V2.length !== 193) {
  throw new Error("frozen Guangyang v2 ranked/practice partition is invalid");
}

const catalogContextCache = new WeakMap();

function getGuangyangPrivateLayoutCatalog(catalogVersion) {
  const version = identifier(catalogVersion, "private layout catalog version");
  const catalog = GUANGYANG_PRIVATE_LAYOUT_CATALOG_REGISTRY[version];
  if (!catalog) throw new TypeError(`unknown private Guangyang catalog version: ${version}`);
  return catalog;
}

function isRegisteredCatalog(catalog) {
  return Boolean(catalog && GUANGYANG_PRIVATE_LAYOUT_CATALOG_REGISTRY[catalog.catalogVersion] === catalog);
}

function catalogContext(catalog, config) {
  let cacheByConfig = catalogContextCache.get(catalog);
  if (cacheByConfig?.has(config)) return cacheByConfig.get(config);
  const normalized = isRegisteredCatalog(catalog)
    ? catalog
    : validateGuangyangLayoutCatalog(catalog, { config });
  const context = validationContext(config);
  const derivedAnchors = normalized.anchors.map(anchor => deriveAnchor(anchor, context));
  const compiled = {
    catalog: normalized,
    context,
    anchorsById: new Map(derivedAnchors.map(anchor => [anchor.id, anchor])),
    layoutsById: new Map(normalized.layouts.map(layout => [layout.id, layout]))
  };
  cacheByConfig ||= new WeakMap();
  cacheByConfig.set(config, compiled);
  catalogContextCache.set(catalog, cacheByConfig);
  return compiled;
}

function resolvePrivateLayout(layoutOrSelection, compiled) {
  let layoutId = layoutOrSelection;
  if (layoutOrSelection && typeof layoutOrSelection === "object" && !Array.isArray(layoutOrSelection)) {
    if (layoutOrSelection.schemaVersion !== PRIVATE_LAYOUT_SELECTION_SCHEMA_VERSION
      || layoutOrSelection.catalogVersion !== compiled.catalog.catalogVersion
      || layoutOrSelection.mapId !== compiled.catalog.mapId
      || layoutOrSelection.mapVersion !== compiled.catalog.mapVersion) {
      throw new TypeError("private layout selection does not match this catalog");
    }
    layoutId = layoutOrSelection.layoutId;
  }
  if (typeof layoutId !== "string") throw new TypeError("private layout reference must be a layout id or selection");
  const layout = compiled.layoutsById.get(layoutId);
  if (!layout) throw new TypeError(`unknown private Guangyang layout: ${layoutId}`);
  return layout;
}

function createGuangyangInteractionDefinition(layoutOrSelection, options = {}) {
  const config = options.config || GUANGYANG_ISLAND_CONFIG;
  const selectedCatalog = options.catalog
    || (layoutOrSelection && typeof layoutOrSelection === "object"
      && GUANGYANG_PRIVATE_LAYOUT_CATALOG_REGISTRY[layoutOrSelection.catalogVersion])
    || GUANGYANG_PRIVATE_LAYOUT_CATALOG;
  const compiled = catalogContext(selectedCatalog, config);
  const layout = resolvePrivateLayout(layoutOrSelection, compiled);
  return interactionForLayout(layout, compiled.anchorsById, compiled.context,
    options.baseInteractionDefinition || null);
}

function selectGuangyangLayoutSequence(options = {}) {
  plainRecord(options, "layout selection options");
  const config = options.config || GUANGYANG_ISLAND_CONFIG;
  const compiled = catalogContext(options.catalog || GUANGYANG_PRIVATE_LAYOUT_CATALOG, config);
  const secret = selectionSecret(options.secret);
  const seed = selectionSeed(options.seed);
  const count = options.count === undefined ? compiled.catalog.layouts.length : options.count;
  if (!Number.isSafeInteger(count) || count < 1 || count > compiled.catalog.layouts.length) {
    throw new RangeError(`layout selection count must be between 1 and ${compiled.catalog.layouts.length}`);
  }
  const seedDigest = crypto.createHash("sha256").update(seed, "utf8").digest("hex");
  const scored = compiled.catalog.layouts.map(layout => ({
    layout,
    score: hmacHex(secret, [
      PRIVATE_LAYOUT_SELECTION_SCHEMA_VERSION,
      "order",
      compiled.catalog.catalogVersion,
      seed,
      layout.id
    ].join("\0"))
  })).sort((left, right) => left.score.localeCompare(right.score)
    || left.layout.id.localeCompare(right.layout.id));

  return deepFreeze(scored.slice(0, count).map(({ layout }, sequenceOffset) => {
    const slotIndex = sequenceOffset + 1;
    const interactionDefinition = interactionForLayout(layout, compiled.anchorsById, compiled.context);
    const anchorIds = Object.fromEntries(ROLE_ORDER.map(role => [role, layout[`${role}AnchorId`]]));
    const commitmentPayload = {
      schemaVersion: PRIVATE_LAYOUT_SELECTION_SCHEMA_VERSION,
      catalogVersion: compiled.catalog.catalogVersion,
      mapId: compiled.catalog.mapId,
      mapVersion: compiled.catalog.mapVersion,
      seedDigest,
      slotIndex,
      sequenceLength: count,
      layoutId: layout.id,
      anchorIds,
      interactionDefinition
    };
    return {
      ...commitmentPayload,
      layoutCommitment: hmacHex(secret, canonicalJson(commitmentPayload))
    };
  }));
}

function selectGuangyangLayoutSequenceForPurpose(options = {}) {
  plainRecord(options, "purpose layout selection options");
  const purpose = String(options.purpose || "");
  if (purpose !== "practice" && purpose !== "ranked") {
    throw new TypeError("layout selection purpose must be practice or ranked");
  }
  const config = options.config || GUANGYANG_ISLAND_CONFIG;
  const catalog = options.catalog || GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2;
  if (catalog !== GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2 || config !== GUANGYANG_ISLAND_CONFIG) {
    throw new TypeError("purpose layout selection requires the registered Guangyang v2 catalog and map");
  }
  const compiled = catalogContext(catalog, config);
  if (compiled.catalog.catalogVersion !== GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION) {
    throw new TypeError("purpose layout selection requires the Guangyang v2 catalog");
  }
  const poolIds = purpose === "ranked"
    ? GUANGYANG_RANKED_LAYOUT_FORM_V2
    : GUANGYANG_PRACTICE_LAYOUT_POOL_V2;
  const count = options.count === undefined ? 5 : options.count;
  if (!Number.isSafeInteger(count) || count < 1 || count > poolIds.length) {
    throw new RangeError(`purpose layout selection count must be between 1 and ${poolIds.length}`);
  }
  if (purpose === "ranked" && count !== GUANGYANG_RANKED_LAYOUT_FORM_V2.length) {
    throw new RangeError(`ranked layout selection count must be exactly ${GUANGYANG_RANKED_LAYOUT_FORM_V2.length}`);
  }

  const secret = selectionSecret(options.secret);
  const seed = selectionSeed(options.seed);
  const seedDigest = crypto.createHash("sha256").update(seed, "utf8").digest("hex");
  const rankedFormVersion = purpose === "ranked" ? GUANGYANG_RANKED_LAYOUT_FORM_VERSION : null;
  const scored = poolIds.map(layoutId => {
    const layout = compiled.layoutsById.get(layoutId);
    if (!layout) throw new TypeError(`purpose pool references an unknown v2 layout: ${layoutId}`);
    return {
      layout,
      score: hmacHex(secret, [
        PRIVATE_LAYOUT_SELECTION_SCHEMA_VERSION,
        GUANGYANG_LAYOUT_SELECTION_POLICY_VERSION,
        "purpose-order",
        purpose,
        rankedFormVersion || "practice-pool",
        compiled.catalog.catalogVersion,
        seed,
        layout.id
      ].join("\0"))
    };
  }).sort((left, right) => left.score.localeCompare(right.score)
    || left.layout.id.localeCompare(right.layout.id));

  return deepFreeze(scored.slice(0, count).map(({ layout }, sequenceOffset) => {
    const slotIndex = sequenceOffset + 1;
    const interactionDefinition = interactionForLayout(layout, compiled.anchorsById, compiled.context);
    const anchorIds = Object.fromEntries(ROLE_ORDER.map(role => [role, layout[`${role}AnchorId`]]));
    const commitmentPayload = {
      schemaVersion: PRIVATE_LAYOUT_SELECTION_SCHEMA_VERSION,
      selectionPolicyVersion: GUANGYANG_LAYOUT_SELECTION_POLICY_VERSION,
      selectionPurpose: purpose,
      rankedFormVersion,
      catalogVersion: compiled.catalog.catalogVersion,
      mapId: compiled.catalog.mapId,
      mapVersion: compiled.catalog.mapVersion,
      seedDigest,
      slotIndex,
      sequenceLength: count,
      layoutId: layout.id,
      anchorIds,
      interactionDefinition
    };
    return {
      ...commitmentPayload,
      layoutCommitment: hmacHex(secret, canonicalJson(commitmentPayload))
    };
  }));
}

function selectRankedGuangyangLayoutSequence(options = {}) {
  return selectGuangyangLayoutSequenceForPurpose({ ...options, purpose: "ranked" });
}

function selectPracticeGuangyangLayoutSequence(options = {}) {
  return selectGuangyangLayoutSequenceForPurpose({ ...options, purpose: "practice" });
}

function projectPublicLayoutSelection(selection) {
  plainRecord(selection, "private layout selection");
  if (selection.schemaVersion !== PRIVATE_LAYOUT_SELECTION_SCHEMA_VERSION) {
    throw new TypeError("private layout selection uses an unsupported schema");
  }
  if (typeof selection.catalogVersion !== "string" || !ID_PATTERN.test(selection.catalogVersion)) {
    throw new TypeError("private layout selection catalogVersion is invalid");
  }
  for (const field of ["mapId", "mapVersion"]) {
    if (typeof selection[field] !== "string" || !ID_PATTERN.test(selection[field])) {
      throw new TypeError(`private layout selection ${field} is invalid`);
    }
  }
  if (!Number.isSafeInteger(selection.slotIndex) || selection.slotIndex < 1
    || !Number.isSafeInteger(selection.sequenceLength) || selection.sequenceLength < 1
    || selection.slotIndex > selection.sequenceLength) {
    throw new TypeError("private layout selection slot is invalid");
  }
  if (!SHA256_PATTERN.test(selection.layoutCommitment || "")) {
    throw new TypeError("private layout selection commitment is invalid");
  }
  return deepFreeze({
    schemaVersion: PUBLIC_LAYOUT_PROJECTION_SCHEMA_VERSION,
    catalogVersion: selection.catalogVersion,
    mapId: selection.mapId,
    mapVersion: selection.mapVersion,
    slotIndex: selection.slotIndex,
    sequenceLength: selection.sequenceLength,
    layoutCommitment: selection.layoutCommitment
  });
}

function privateLayoutCatalogSummary(catalog = GUANGYANG_PRIVATE_LAYOUT_CATALOG) {
  const normalized = isRegisteredCatalog(catalog)
    ? catalog
    : validateGuangyangLayoutCatalog(catalog);
  const anchorsByRole = Object.fromEntries(ROLE_ORDER.map(role => [
    role,
    normalized.anchors.filter(anchor => anchor.role === role).length
  ]));
  return deepFreeze({
    schemaVersion: PRIVATE_LAYOUT_CATALOG_SUMMARY_SCHEMA_VERSION,
    catalogVersion: normalized.catalogVersion,
    mapId: normalized.mapId,
    mapVersion: normalized.mapVersion,
    taskId: normalized.taskId,
    taskVersion: normalized.taskVersion,
    anchorCount: normalized.anchors.length,
    layoutCount: normalized.layouts.length,
    anchorsByRole
  });
}

module.exports = {
  PRIVATE_LAYOUT_CATALOG_SCHEMA_VERSION,
  PRIVATE_LAYOUT_SCHEMA_VERSION,
  PRIVATE_ANCHOR_SCHEMA_VERSION,
  PRIVATE_LAYOUT_SELECTION_SCHEMA_VERSION,
  PUBLIC_LAYOUT_PROJECTION_SCHEMA_VERSION,
  PRIVATE_LAYOUT_CATALOG_SUMMARY_SCHEMA_VERSION,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1_VERSION,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_VERSION,
  GUANGYANG_LAYOUT_SELECTION_POLICY_VERSION,
  GUANGYANG_RANKED_LAYOUT_FORM_VERSION,
  MIN_OBJECT_EDGE_GAP,
  GRAB_APPROACH_DISTANCE,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V1,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_REGISTRY,
  GUANGYANG_RANKED_LAYOUT_FORM_V2,
  GUANGYANG_PRACTICE_LAYOUT_POOL_V2,
  getGuangyangPrivateLayoutCatalog,
  validateGuangyangLayoutCatalog,
  createGuangyangInteractionDefinition,
  selectGuangyangLayoutSequence,
  selectGuangyangLayoutSequenceForPurpose,
  selectRankedGuangyangLayoutSequence,
  selectPracticeGuangyangLayoutSequence,
  projectPublicLayoutSelection,
  privateLayoutCatalogSummary
};
