"use strict";

const crypto = require("node:crypto");

const {
  GUANGYANG_CHALLENGE_CONFIGS
} = require("../competition-core.js");
const {
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2,
  createGuangyangInteractionDefinition
} = require("./guangyang-private-layout-catalog.js");
const {
  defaultLayout,
  mapGeometry,
  normalizeLayout
} = require("./guangyang-map-config-store.js");

const MAP_POOL_ADMIN_SCHEMA_VERSION = "chenlong.guangyang-map-pools-admin/v1";
const MAP_POOL_VARIANT_ID_PATTERN = /^map-(0[1-9]|1[0-9]|20)$/;
const MAP_POOL_COUNTS = Object.freeze({
  "R2-GYI-MVP-01": 8,
  "R2-GYI-MVP-02": 10,
  "R2-GYI-MVP-03": 12
});

function clonePoint(point) {
  return point.map(value => Number(Number(value).toFixed(4)));
}

function uniquePoints(points) {
  return [...new Map(points.map(point => {
    const normalized = clonePoint(point);
    return [normalized.join(","), normalized];
  })).values()];
}

function stableOrder(points, seed) {
  return points.map(point => ({
    point,
    key: crypto.createHash("sha256").update(`${seed}|${point.join(",")}`, "utf8").digest("hex")
  })).sort((left, right) => left.key.localeCompare(right.key))
    .map(entry => entry.point);
}

function candidatePositions(configs = GUANGYANG_CHALLENGE_CONFIGS) {
  const catalog = GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2;
  const privateDefinitions = catalog.layouts.map(layout => (
    createGuangyangInteractionDefinition(layout.id, { catalog })
  ));
  const publicRolePositions = role => configs.flatMap(config => (
    config.objectTaskOverlay.objects.filter(item => item.role === role).map(item => item.position)
  ));
  const privateRolePositions = role => privateDefinitions.flatMap(definition => (
    definition.packages.filter(item => item.role === role).map(item => [item.x, item.z])
  ));
  return Object.freeze({
    target: uniquePoints([...publicRolePositions("target"), ...privateRolePositions("target")]),
    distractor: uniquePoints([
      ...publicRolePositions("distractor"), ...privateRolePositions("distractor")
    ]),
    // Public obstacles are deliberately passable on their current road. The
    // private holdout obstacles use a different detour rule and are not mixed
    // into the administrator-editable single-run pool.
    obstacle: uniquePoints(publicRolePositions("obstacle")),
    checkpoint: uniquePoints(configs.flatMap(config => (
      config.checkpoints.map(checkpoint => checkpoint.position)
    )))
  });
}

const MAP_POOL_CANDIDATES = candidatePositions();

function variantId(variantNumber) {
  if (!Number.isSafeInteger(variantNumber) || variantNumber < 1 || variantNumber > 20) {
    throw new RangeError("map variant number must be between 1 and 20");
  }
  return `map-${String(variantNumber).padStart(2, "0")}`;
}

function variantNumber(value) {
  if (typeof value !== "string" || !MAP_POOL_VARIANT_ID_PATTERN.test(value)) {
    throw new TypeError("map variant id is invalid");
  }
  return Number(value.slice(4));
}

function mapPoolCount(taskId) {
  const count = MAP_POOL_COUNTS[taskId];
  if (!count) throw new TypeError("task does not have a registered map pool");
  return count;
}

function buildInitialMapPoolLayouts(config, count = mapPoolCount(config?.taskId)) {
  if (!config || typeof config !== "object") throw new TypeError("Guangyang challenge config is required");
  if (count !== mapPoolCount(config.taskId)) throw new TypeError("map pool size must match the frozen task policy");
  const geometry = mapGeometry(config);
  const first = normalizeLayout(defaultLayout(config), geometry);
  const layouts = [first];
  const digests = new Set([JSON.stringify(first)]);

  for (let index = 2; index <= count; index += 1) {
    let accepted = null;
    for (let attempt = 0; attempt < 20_000 && accepted === null; attempt += 1) {
      const seed = `${config.taskId}|${index}|${attempt}`;
      const candidate = {
        schemaVersion: first.schemaVersion,
        checkpoints: stableOrder(MAP_POOL_CANDIDATES.checkpoint, `${seed}|checkpoint`)
          .slice(0, first.checkpoints.length),
        targets: stableOrder(MAP_POOL_CANDIDATES.target, `${seed}|target`)
          .slice(0, first.targets.length),
        storage: [...first.storage],
        distractors: stableOrder(MAP_POOL_CANDIDATES.distractor, `${seed}|distractor`)
          .slice(0, first.distractors.length),
        obstacles: stableOrder(MAP_POOL_CANDIDATES.obstacle, `${seed}|obstacle`)
          .slice(0, first.obstacles.length)
      };
      try {
        const normalized = normalizeLayout(candidate, geometry);
        const digest = JSON.stringify(normalized);
        if (!digests.has(digest)) {
          digests.add(digest);
          accepted = normalized;
        }
      } catch (_error) {
        // Candidate combinations are intentionally filtered through the same
        // validator used for administrator publications.
      }
    }
    if (accepted === null) throw new Error(`unable to build ${config.taskId} ${variantId(index)}`);
    layouts.push(accepted);
  }
  return Object.freeze(layouts);
}

function assignedVariantId(taskId, teamId) {
  const count = mapPoolCount(taskId);
  if (typeof teamId !== "string" || !/^tea_[a-f0-9]{32}$/.test(teamId)) {
    throw new TypeError("team id is invalid for map assignment");
  }
  const digest = crypto.createHash("sha256")
    .update(`chenlong-map-pool/v1\0${taskId}\0${teamId}`, "utf8")
    .digest();
  return variantId(digest.readUInt32BE(0) % count + 1);
}

module.exports = {
  MAP_POOL_ADMIN_SCHEMA_VERSION,
  MAP_POOL_VARIANT_ID_PATTERN,
  MAP_POOL_COUNTS,
  variantId,
  variantNumber,
  mapPoolCount,
  buildInitialMapPoolLayouts,
  assignedVariantId
};
