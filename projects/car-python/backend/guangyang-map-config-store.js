"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const { canonicalSha256 } = require("./canonical-json.js");
const { PUBLIC_NAVIGATION_DEFINITION } = require("../competition-core.js");

const MAP_CONFIG_SCHEMA_VERSION = "chenlong.guangyang-map-config/v1";
const LEGACY_MAP_LAYOUT_SCHEMA_VERSION = "chenlong.guangyang-map-layout/v1";
const MAP_LAYOUT_SCHEMA_VERSION = "chenlong.guangyang-map-layout/v2";
const MAP_CONFIG_UPDATE_SCHEMA_VERSION = "chenlong.guangyang-map-config-update/v1";
const MAP_CONFIG_STORE_SCHEMA_VERSION = "chenlong.guangyang-map-config-store/v1";
const MAP_CONFIG_BINDING_SCHEMA_VERSION = "chenlong.guangyang-map-config-binding/v1";
const MAP_CONFIG_FILENAME = "published.json";
const MAX_MAP_CONFIG_BYTES = 64 * 1024;
const MAX_MAP_CONFIG_REVISION = Number.MAX_SAFE_INTEGER - 1;
const POSITION_DIGITS = 4;
const POSITION_EPSILON = 1e-9;
const ROAD_CONNECTION_TOLERANCE = 0.02;
const ROAD_POINT_MARGIN = 0.04;
const OBJECT_SEPARATION_MARGIN = 0.2;
const ZONE_SEPARATION_MARGIN = 0.15;

class GuangyangMapConfigStoreError extends Error {
  constructor(statusCode, code, message, headers = {}) {
    super(message);
    this.name = "GuangyangMapConfigStoreError";
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function roundPositionValue(value) {
  const factor = 10 ** POSITION_DIGITS;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normalizePosition(value, field) {
  if (!Array.isArray(value) || value.length !== 2
    || !value.every(item => typeof item === "number" && Number.isFinite(item))) {
    throw new GuangyangMapConfigStoreError(
      422,
      "MAP_CONFIG_INVALID_POSITION",
      `${field} must be an [x, z] pair of finite numbers`
    );
  }
  return value.map(roundPositionValue);
}

function pointDistance(left, right) {
  return Math.hypot(left[0] - right[0], left[1] - right[1]);
}

function pointSegmentDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  const progress = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared))
    : 0;
  const nearest = [start[0] + progress * dx, start[1] + progress * dz];
  return { distance: pointDistance(point, nearest), progress };
}

function normalizeRoads(baseConfig) {
  const roads = Array.isArray(baseConfig?.roads) ? baseConfig.roads : [];
  const normalized = roads.map((road, roadIndex) => {
    const width = Number(road?.width);
    const points = Array.isArray(road?.points)
      ? road.points.map((point, pointIndex) => normalizePosition(point, `roads[${roadIndex}].points[${pointIndex}]`))
      : [];
    if (typeof road?.id !== "string" || !road.id || !Number.isFinite(width) || width <= 0 || points.length < 2) {
      throw new TypeError("base Guangyang road geometry is invalid");
    }
    return { id: road.id, width, points };
  });
  if (!normalized.length) throw new TypeError("base Guangyang road geometry is required");
  return normalized;
}

function nearestRoadPosition(point, roads) {
  let nearest = null;
  roads.forEach((road, roadIndex) => {
    for (let segmentIndex = 1; segmentIndex < road.points.length; segmentIndex += 1) {
      const candidate = pointSegmentDistance(point, road.points[segmentIndex - 1], road.points[segmentIndex]);
      if (!nearest || candidate.distance < nearest.distance) {
        nearest = { ...candidate, road, roadIndex, segmentIndex: segmentIndex - 1 };
      }
    }
  });
  return nearest;
}

function roadsTouch(left, right) {
  const endpoints = road => [road.points[0], road.points[road.points.length - 1]];
  return endpoints(left).some(leftPoint => endpoints(right).some(
    rightPoint => pointDistance(leftPoint, rightPoint) <= ROAD_CONNECTION_TOLERANCE
  ));
}

function connectedRoadIndexes(roads, startIndex) {
  const reached = new Set([startIndex]);
  const pending = [startIndex];
  while (pending.length) {
    const current = pending.shift();
    roads.forEach((road, index) => {
      if (reached.has(index) || !roadsTouch(roads[current], road)) return;
      reached.add(index);
      pending.push(index);
    });
  }
  return reached;
}

function assertInsideBounds(point, radius, field, bounds) {
  if (point[0] < bounds.minX + radius - POSITION_EPSILON
    || point[0] > bounds.maxX - radius + POSITION_EPSILON
    || point[1] < bounds.minZ + radius - POSITION_EPSILON
    || point[1] > bounds.maxZ - radius + POSITION_EPSILON) {
    throw new GuangyangMapConfigStoreError(
      422,
      "MAP_CONFIG_OUT_OF_BOUNDS",
      `${field} must remain inside the Guangyang map boundary`
    );
  }
}

function assertRoadReachable(point, radius, field, geometry, { storage = false } = {}) {
  const nearest = nearestRoadPosition(point, geometry.roads);
  const maximumDistance = storage
    ? nearest.road.width / 2 + geometry.storageRadius
    : nearest.road.width / 2 - radius - ROAD_POINT_MARGIN;
  if (!nearest || maximumDistance < 0 || nearest.distance > maximumDistance + POSITION_EPSILON) {
    throw new GuangyangMapConfigStoreError(
      422,
      "MAP_CONFIG_NOT_ROAD_REACHABLE",
      `${field} must be placed on, or within delivery reach of, a connected road`
    );
  }
  if (!geometry.connectedRoads.has(nearest.roadIndex)) {
    throw new GuangyangMapConfigStoreError(
      422,
      "MAP_CONFIG_DISCONNECTED",
      `${field} is not reachable from the parking start through the road network`
    );
  }
  return nearest;
}

function assertSeparated(left, right, minimum, code = "MAP_CONFIG_OBJECTS_OVERLAP") {
  if (pointDistance(left.position, right.position) + POSITION_EPSILON < minimum) {
    throw new GuangyangMapConfigStoreError(
      422,
      code,
      `${left.label} and ${right.label} are too close to support deterministic scoring`
    );
  }
}

function defaultLayout(baseConfig) {
  const objects = Array.isArray(baseConfig?.objectTaskOverlay?.objects)
    ? baseConfig.objectTaskOverlay.objects : [];
  const zones = Array.isArray(baseConfig?.objectTaskOverlay?.zones)
    ? baseConfig.objectTaskOverlay.zones : [];
  const byRole = role => [...objects, ...zones].filter(item => item?.role === role);
  const checkpoints = Array.isArray(baseConfig?.checkpoints) ? baseConfig.checkpoints : [];
  const targets = byRole("target");
  const storages = byRole("storage");
  const distractors = byRole("distractor");
  const obstacles = byRole("obstacle");
  if (!checkpoints.length || !targets.length || storages.length !== 1
    || !distractors.length || !obstacles.length) {
    throw new TypeError("base Guangyang map does not contain the required configurable objects");
  }
  return {
    schemaVersion: MAP_LAYOUT_SCHEMA_VERSION,
    checkpoints: checkpoints.map((checkpoint, index) => (
      normalizePosition(checkpoint.position, `checkpoints[${index}]`)
    )),
    targets: targets.map((item, index) => normalizePosition(item.position, `targets[${index}]`)),
    storage: normalizePosition(storages[0].position, "storage"),
    distractors: distractors.map((item, index) => normalizePosition(item.position, `distractors[${index}]`)),
    obstacles: obstacles.map((item, index) => normalizePosition(item.position, `obstacles[${index}]`))
  };
}

function mapGeometry(baseConfig) {
  const width = Number(baseConfig?.world?.width);
  const depth = Number(baseConfig?.world?.depth);
  const start = normalizePosition(baseConfig?.start?.slice(0, 2), "start");
  const goal = normalizePosition(baseConfig?.goal, "goal");
  const overlay = baseConfig?.objectTaskOverlay || {};
  const objectByRole = role => (overlay.objects || []).filter(item => item?.role === role);
  const zoneByRole = role => (overlay.zones || []).find(item => item?.role === role);
  const targets = objectByRole("target");
  const distractors = objectByRole("distractor");
  const obstacles = objectByRole("obstacle");
  const targetRadius = Number(targets[0]?.radius ?? overlay.packageRadius);
  const distractorRadius = Number(distractors[0]?.radius ?? overlay.packageRadius);
  const obstacleRadius = Number(obstacles[0]?.radius);
  const storageRadius = Number(zoneByRole("storage")?.radius);
  const checkpointRadius = Number(baseConfig?.task?.checkpointRadius);
  const vehicleRadius = 0.44;
  if (![width, depth, targetRadius, distractorRadius, obstacleRadius, storageRadius, checkpointRadius]
    .every(value => Number.isFinite(value) && value > 0)) {
    throw new TypeError("base Guangyang geometry is invalid");
  }
  const roads = normalizeRoads(baseConfig);
  const startRoad = nearestRoadPosition(start, roads);
  if (!startRoad) throw new TypeError("base Guangyang parking start is not connected to a road");
  return {
    bounds: { minX: -width / 2, maxX: width / 2, minZ: -depth / 2, maxZ: depth / 2 },
    roads,
    connectedRoads: connectedRoadIndexes(roads, startRoad.roadIndex),
    start,
    goal,
    targetRadius,
    distractorRadius,
    obstacleRadius,
    storageRadius,
    checkpointRadius,
    vehicleRadius,
    checkpointCount: Array.isArray(baseConfig?.checkpoints) ? baseConfig.checkpoints.length : 0,
    targetCount: targets.length,
    distractorCount: distractors.length,
    obstacleCount: obstacles.length
  };
}

function normalizeLayout(value, geometry) {
  if (!hasExactKeys(value, [
    "schemaVersion", "checkpoints", "targets", "storage", "distractors", "obstacles"
  ]) || value.schemaVersion !== MAP_LAYOUT_SCHEMA_VERSION) {
    throw new GuangyangMapConfigStoreError(
      422,
      "MAP_CONFIG_INVALID_LAYOUT",
      "map layout must use the exact supported schema"
    );
  }
  if (!Array.isArray(value.checkpoints) || value.checkpoints.length !== geometry.checkpointCount
    || !Array.isArray(value.targets) || value.targets.length !== geometry.targetCount
    || !Array.isArray(value.distractors) || value.distractors.length !== geometry.distractorCount
    || !Array.isArray(value.obstacles) || value.obstacles.length !== geometry.obstacleCount) {
    throw new GuangyangMapConfigStoreError(
      422,
      "MAP_CONFIG_INVALID_CHECKPOINTS",
      "map layout must contain the challenge's exact object and checkpoint counts"
    );
  }
  const layout = {
    schemaVersion: MAP_LAYOUT_SCHEMA_VERSION,
    checkpoints: value.checkpoints.map((point, index) => normalizePosition(point, `checkpoints[${index}]`)),
    targets: value.targets.map((point, index) => normalizePosition(point, `targets[${index}]`)),
    storage: normalizePosition(value.storage, "storage"),
    distractors: value.distractors.map((point, index) => normalizePosition(point, `distractors[${index}]`)),
    obstacles: value.obstacles.map((point, index) => normalizePosition(point, `obstacles[${index}]`))
  };

  const positions = [
    ...layout.checkpoints.map((position, index) => ({
      label: `checkpoint ${index + 1}`,
      position,
      radius: geometry.checkpointRadius,
      kind: "checkpoint"
    })),
    ...layout.targets.map((position, index) => ({ label: `target ${index + 1}`, position, radius: geometry.targetRadius, kind: "target" })),
    { label: "storage", position: layout.storage, radius: geometry.storageRadius, kind: "storage" },
    ...layout.distractors.map((position, index) => ({ label: `distractor ${index + 1}`, position, radius: geometry.distractorRadius, kind: "distractor" })),
    ...layout.obstacles.map((position, index) => ({ label: `obstacle ${index + 1}`, position, radius: geometry.obstacleRadius, kind: "obstacle" }))
  ];
  positions.forEach(item => assertInsideBounds(item.position, item.radius, item.label, geometry.bounds));
  layout.checkpoints.forEach((point, index) => {
    assertRoadReachable(point, geometry.vehicleRadius, `checkpoint ${index + 1}`, geometry);
  });
  layout.targets.forEach((point, index) => assertRoadReachable(point, geometry.targetRadius, `target ${index + 1}`, geometry));
  layout.distractors.forEach((point, index) => assertRoadReachable(point, geometry.distractorRadius, `distractor ${index + 1}`, geometry));
  const obstacleRoads = layout.obstacles.map((point, index) => (
    assertRoadReachable(point, geometry.obstacleRadius, `obstacle ${index + 1}`, geometry)
  ));
  assertRoadReachable(layout.storage, 0, "storage", geometry, { storage: true });

  // A vehicle-center path must remain beside the obstacle somewhere inside the
  // configured road corridor. This rejects a road-spanning obstacle while
  // preserving the original map's intended close bypass.
  obstacleRoads.forEach(obstacleRoad => {
    if (obstacleRoad.road.width / 2 + obstacleRoad.distance + POSITION_EPSILON
      < geometry.obstacleRadius + geometry.vehicleRadius + ROAD_POINT_MARGIN) {
      throw new GuangyangMapConfigStoreError(
        422,
        "MAP_CONFIG_OBSTACLE_BLOCKS_ROAD",
        "obstacle blocks the road and leaves no deterministic bypass"
      );
    }
  });

  const scoredObjects = positions.filter(item => item.kind !== "checkpoint");
  for (let leftIndex = 0; leftIndex < scoredObjects.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < scoredObjects.length; rightIndex += 1) {
      const left = scoredObjects[leftIndex];
      const right = scoredObjects[rightIndex];
      const margin = left.kind === "storage" || right.kind === "storage"
        ? ZONE_SEPARATION_MARGIN : OBJECT_SEPARATION_MARGIN;
      assertSeparated(left, right, left.radius + right.radius + margin);
    }
  }
  for (let leftIndex = 0; leftIndex < layout.checkpoints.length; leftIndex += 1) {
    const checkpoint = positions[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < layout.checkpoints.length; rightIndex += 1) {
      assertSeparated(
        checkpoint,
        positions[rightIndex],
        geometry.checkpointRadius * 2 + ROAD_POINT_MARGIN,
        "MAP_CONFIG_CHECKPOINTS_OVERLAP"
      );
    }
    scoredObjects.forEach(object => {
      const minimum = object.kind === "obstacle"
        ? geometry.checkpointRadius + object.radius + ROAD_POINT_MARGIN
        : object.radius + geometry.vehicleRadius + ROAD_POINT_MARGIN;
      assertSeparated(checkpoint, object, minimum);
    });
  }
  const terminals = [{ label: "parking start", position: geometry.start, radius: geometry.vehicleRadius }];
  if (pointDistance(geometry.start, geometry.goal) > POSITION_EPSILON) {
    terminals.push({ label: "return goal", position: geometry.goal, radius: geometry.vehicleRadius });
  }
  terminals.forEach(terminal => {
    layout.checkpoints.forEach((position, index) => {
      assertSeparated(
        terminal,
        { label: `checkpoint ${index + 1}`, position },
        geometry.vehicleRadius + geometry.checkpointRadius + ROAD_POINT_MARGIN,
        "MAP_CONFIG_CHECKPOINTS_OVERLAP"
      );
    });
    scoredObjects.forEach(object => {
      assertSeparated(terminal, object, terminal.radius + object.radius + ROAD_POINT_MARGIN);
    });
  });
  return deepFreeze(layout);
}

function upgradeLegacyLayout(value, geometry) {
  if (!hasExactKeys(value, [
    "schemaVersion", "checkpoints", "target", "storage", "distractor", "obstacle"
  ]) || value.schemaVersion !== LEGACY_MAP_LAYOUT_SCHEMA_VERSION) return null;
  const upgraded = {
    schemaVersion: MAP_LAYOUT_SCHEMA_VERSION,
    checkpoints: value.checkpoints,
    targets: [value.target],
    storage: value.storage,
    distractors: [value.distractor],
    obstacles: [value.obstacle]
  };
  return normalizeLayout(upgraded, geometry);
}

function publishedMapVersion(baseMapVersion, revision, digest) {
  return revision === 0
    ? baseMapVersion
    : `${baseMapVersion}@map-r${revision}-${digest.slice(0, 12)}`;
}

function buildRunDefinition(baseRunDefinition, layout) {
  const runDefinition = clone(baseRunDefinition);
  // Ordinary published-map sessions intentionally disclose only route anchors
  // for the three task objects.  Private batch/ranked definitions never pass
  // through this builder and therefore retain the non-disclosing contract.
  runDefinition.navigationDefinition = clone(PUBLIC_NAVIGATION_DEFINITION);
  const positionsByRole = {
    target: layout.targets,
    distractor: layout.distractors,
    obstacle: layout.obstacles
  };
  const roleIndexes = { target: 0, distractor: 0, obstacle: 0 };
  runDefinition.interactionDefinition.packages = runDefinition.interactionDefinition.packages.map(item => {
    const positions = positionsByRole[item.role];
    const position = Array.isArray(positions) ? positions[roleIndexes[item.role]++] : null;
    return position ? { ...item, x: position[0], z: position[1] } : item;
  });
  runDefinition.taskDefinition.checkpoints = runDefinition.taskDefinition.checkpoints.map((checkpoint, index) => ({
    ...checkpoint,
    position: [...layout.checkpoints[index]]
  }));
  runDefinition.taskDefinition.deliveries = runDefinition.taskDefinition.deliveries.map(delivery => (
    delivery.objectRole === "target" && delivery.destinationRole === "storage"
      ? { ...delivery, destination: [...layout.storage] }
      : delivery
  ));
  return deepFreeze(runDefinition);
}

function buildSnapshot(baseConfig, baseChallenge, layout, revision, updatedAt) {
  const digest = canonicalSha256(layout);
  const mapVersion = publishedMapVersion(baseChallenge.mapVersion, revision, digest);
  const runDefinition = buildRunDefinition(baseChallenge.runDefinition, layout);
  const challenge = deepFreeze({ ...baseChallenge, mapVersion, runDefinition });
  return deepFreeze({
    revision,
    updatedAt,
    digest,
    mapVersion,
    layout,
    runDefinition,
    challenge,
    binding: {
      schemaVersion: MAP_CONFIG_BINDING_SCHEMA_VERSION,
      revision,
      digest,
      mapVersion
    }
  });
}

function publicMapConfig(snapshot, baseChallenge) {
  return {
    schemaVersion: MAP_CONFIG_SCHEMA_VERSION,
    authoritative: false,
    mapId: baseChallenge.mapId,
    baseMapVersion: baseChallenge.mapVersion,
    mapVersion: snapshot.mapVersion,
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
    digest: snapshot.digest,
    layout: clone(snapshot.layout)
  };
}

function validIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function readStoredFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_MAP_CONFIG_BYTES) {
    throw new GuangyangMapConfigStoreError(
      500,
      "MAP_CONFIG_CORRUPTED",
      "published map configuration is not a safe regular file"
    );
  }
  const buffer = fs.readFileSync(filePath);
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (_error) {
    throw new GuangyangMapConfigStoreError(
      500,
      "MAP_CONFIG_CORRUPTED",
      "published map configuration is not valid UTF-8"
    );
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch (_error) {
    throw new GuangyangMapConfigStoreError(
      500,
      "MAP_CONFIG_CORRUPTED",
      "published map configuration is not valid JSON"
    );
  }
  return value;
}

async function atomicWrite(filePath, buffer) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, filePath);
    try {
      const directoryHandle = await fs.promises.open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (_error) {
      // Directory fsync is not supported by every Windows filesystem.
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

class GuangyangMapConfigStore {
  constructor({ rootDir, baseConfig, baseChallenge, initialLayout = null, now = Date.now } = {}) {
    if (typeof rootDir !== "string" || !rootDir) throw new TypeError("map config rootDir is required");
    if (!baseConfig || typeof baseConfig !== "object" || !baseChallenge?.runDefinition) {
      throw new TypeError("base Guangyang configuration and challenge are required");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.rootDir = path.resolve(rootDir);
    this.filePath = path.join(this.rootDir, MAP_CONFIG_FILENAME);
    this.baseConfig = baseConfig;
    this.baseChallenge = baseChallenge;
    this.now = now;
    this.geometry = mapGeometry(baseConfig);
    this.defaultLayout = normalizeLayout(
      initialLayout === null ? defaultLayout(baseConfig) : initialLayout,
      this.geometry
    );
    this.current = buildSnapshot(baseConfig, baseChallenge, this.defaultLayout, 0, null);
    this.mutationTail = Promise.resolve();
    this.initialize();
    this.ready = Promise.resolve();
  }

  initialize() {
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    const rootStat = fs.lstatSync(this.rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new GuangyangMapConfigStoreError(
        500,
        "MAP_CONFIG_CORRUPTED",
        "map configuration directory is unsafe"
      );
    }
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (entry.isFile() && /^\.published\.json\.[a-f0-9-]+\.tmp$/.test(entry.name)) {
        fs.unlinkSync(path.join(this.rootDir, entry.name));
      }
    }
    const stored = readStoredFile(this.filePath);
    if (stored === null) return;
    if (!hasExactKeys(stored, ["schemaVersion", "revision", "updatedAt", "digest", "layout"])
      || stored.schemaVersion !== MAP_CONFIG_STORE_SCHEMA_VERSION
      || !Number.isSafeInteger(stored.revision)
      || stored.revision < 1
      || stored.revision > MAX_MAP_CONFIG_REVISION
      || !validIsoTimestamp(stored.updatedAt)
      || typeof stored.digest !== "string"
      || !/^[a-f0-9]{64}$/.test(stored.digest)) {
      throw new GuangyangMapConfigStoreError(
        500,
        "MAP_CONFIG_CORRUPTED",
        "published map configuration metadata is invalid"
      );
    }
    let layout;
    try {
      const legacyLayout = upgradeLegacyLayout(stored.layout, this.geometry);
      if (legacyLayout) {
        if (canonicalSha256(stored.layout) !== stored.digest) {
          throw new GuangyangMapConfigStoreError(
            500,
            "MAP_CONFIG_CORRUPTED",
            "published legacy map configuration digest does not match"
          );
        }
        layout = legacyLayout;
      } else {
        layout = normalizeLayout(stored.layout, this.geometry);
      }
    } catch (error) {
      if (error instanceof GuangyangMapConfigStoreError) {
        throw new GuangyangMapConfigStoreError(
          500,
          "MAP_CONFIG_CORRUPTED",
          `published map configuration is invalid: ${error.message}`
        );
      }
      throw error;
    }
    if (!upgradeLegacyLayout(stored.layout, this.geometry) && canonicalSha256(layout) !== stored.digest) {
      throw new GuangyangMapConfigStoreError(
        500,
        "MAP_CONFIG_CORRUPTED",
        "published map configuration digest does not match"
      );
    }
    this.current = buildSnapshot(
      this.baseConfig,
      this.baseChallenge,
      layout,
      stored.revision,
      stored.updatedAt
    );
  }

  async withMutationLock(operation) {
    const previous = this.mutationTail;
    let release;
    this.mutationTail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async snapshot() {
    await this.ready;
    return this.current;
  }

  async publicConfig() {
    return publicMapConfig(await this.snapshot(), this.baseChallenge);
  }

  async update(value) {
    await this.ready;
    if (!hasExactKeys(value, ["schemaVersion", "baseRevision", "layout"])
      || value.schemaVersion !== MAP_CONFIG_UPDATE_SCHEMA_VERSION
      || !Number.isSafeInteger(value.baseRevision)
      || value.baseRevision < 0
      || value.baseRevision > MAX_MAP_CONFIG_REVISION) {
      throw new GuangyangMapConfigStoreError(
        422,
        "MAP_CONFIG_INVALID_UPDATE",
        "map configuration update must use the exact supported schema and a valid baseRevision"
      );
    }
    const layout = normalizeLayout(value.layout, this.geometry);
    return this.withMutationLock(async () => {
      if (value.baseRevision !== this.current.revision) {
        throw new GuangyangMapConfigStoreError(
          409,
          "MAP_CONFIG_REVISION_CONFLICT",
          "published map configuration changed; refresh before saving again"
        );
      }
      const digest = canonicalSha256(layout);
      if (digest === this.current.digest) return publicMapConfig(this.current, this.baseChallenge);
      if (this.current.revision >= MAX_MAP_CONFIG_REVISION) {
        throw new GuangyangMapConfigStoreError(
          507,
          "MAP_CONFIG_REVISION_EXHAUSTED",
          "published map configuration revision limit is exhausted"
        );
      }
      const now = Number(this.now());
      if (!Number.isFinite(now)) throw new TypeError("now() must return a finite timestamp");
      const updatedAt = new Date(now).toISOString();
      const revision = this.current.revision + 1;
      const stored = {
        schemaVersion: MAP_CONFIG_STORE_SCHEMA_VERSION,
        revision,
        updatedAt,
        digest,
        layout
      };
      const buffer = Buffer.from(`${JSON.stringify(stored, null, 2)}\n`);
      if (buffer.length > MAX_MAP_CONFIG_BYTES) {
        throw new GuangyangMapConfigStoreError(
          413,
          "MAP_CONFIG_TOO_LARGE",
          "published map configuration is too large"
        );
      }
      await atomicWrite(this.filePath, buffer);
      this.current = buildSnapshot(
        this.baseConfig,
        this.baseChallenge,
        layout,
        revision,
        updatedAt
      );
      return publicMapConfig(this.current, this.baseChallenge);
    });
  }
}

module.exports = {
  MAP_CONFIG_SCHEMA_VERSION,
  MAP_LAYOUT_SCHEMA_VERSION,
  MAP_CONFIG_UPDATE_SCHEMA_VERSION,
  MAP_CONFIG_STORE_SCHEMA_VERSION,
  MAP_CONFIG_BINDING_SCHEMA_VERSION,
  MAP_CONFIG_FILENAME,
  MAX_MAP_CONFIG_BYTES,
  GuangyangMapConfigStoreError,
  GuangyangMapConfigStore,
  defaultLayout,
  mapGeometry,
  normalizeLayout,
  buildRunDefinition,
  publicMapConfig
};
