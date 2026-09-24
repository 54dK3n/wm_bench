#!/usr/bin/env node
"use strict";

// Server-private acceptance planner for the frozen Guangyang layout catalog.
//
// This is intentionally not a learner example and must never be referenced by a
// browser asset. It uses full map coordinates only to prove that every catalog
// entry has at least one route that can be expressed with the public action
// ranges and independently accepted by the real task/v5, interaction, physics,
// rules, and scoring engines.

const assert = require("node:assert/strict");
const CompetitionCore = require("../competition-core.js");
const {
  GUANGYANG_PRIVATE_LAYOUT_CATALOG,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_REGISTRY,
  GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION,
  GUANGYANG_RANKED_LAYOUT_FORM_V2,
  GUANGYANG_PRACTICE_LAYOUT_POOL_V2,
  createGuangyangInteractionDefinition,
  validateGuangyangLayoutCatalog
} = require("../backend/guangyang-private-layout-catalog.js");

const REPORT_SCHEMA_VERSION = "chenlong.guangyang-private-layout-solvability/v2";
const STEP_MS = 20;
const SPEED_PERCENT = 30;
const SPEED_METERS_PER_SECOND = 0.75;
const DRIVE_STEP_METERS = SPEED_METERS_PER_SECOND * STEP_MS / 1000;
const TWO_PI = Math.PI * 2;
const GRAPH_STEP_METERS = 0.28;
const PATH_SAMPLE_METERS = 0.035;
const ROAD_SAFETY_MARGIN = 0.025;
const COLLISION_SAFETY_MARGIN = 0.025;
const ATTACH_RADIUS_METERS = 1.05;
const GRAB_STANDOFF_METERS = 1;
const POSITION_EPSILON = 1e-7;

const config = CompetitionCore.GUANGYANG_ISLAND_CONFIG;

function distance(left, right) {
  return Math.hypot(Number(left[0]) - Number(right[0]), Number(left[1]) - Number(right[1]));
}

function normalizeHeading(value) {
  const normalized = value % TWO_PI;
  return normalized < 0 ? normalized + TWO_PI : normalized;
}

function signedHeadingDelta(from, to) {
  let delta = normalizeHeading(to) - normalizeHeading(from);
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return delta;
}

function headingToward(from, to) {
  return normalizeHeading(Math.atan2(-(to[0] - from[0]), -(to[1] - from[1])));
}

function pointToSegmentDistance(point, start, end) {
  return CompetitionCore.geometry.closestPointOnSegment(point, start, end).distance;
}

function resolvedTaskDefinition() {
  return CompetitionCore.normalizeTaskDefinition({
    ...config.task,
    id: config.taskId,
    version: config.taskVersion,
    checkpoints: config.checkpoints,
    goal: config.goal
  });
}

function simulationDefinition(colliders) {
  return {
    schemaVersion: CompetitionCore.SIMULATION_SCHEMA_VERSION,
    stepMs: STEP_MS,
    seed: 0,
    initialPose: { x: config.start[0], z: config.start[1], heading: config.start[2] },
    vehicle: {
      version: CompetitionCore.VEHICLE_MODEL_VERSION,
      radius: config.rules.vehicleRadius,
      collisionSkin: 0.005,
      maxLinearSpeed: 2.5,
      maxAngularSpeed: 2.8
    },
    world: {
      bounds: {
        minX: -config.world.width / 2,
        maxX: config.world.width / 2,
        minZ: -config.world.depth / 2,
        maxZ: config.world.depth / 2
      },
      colliders
    }
  };
}

function graphNodeKey(point) {
  return `${Number(point[0]).toFixed(5)},${Number(point[1]).toFixed(5)}`;
}

function buildRoadGraph() {
  const nodes = [];
  const keyToId = new Map();
  const adjacency = new Map();
  const roadSamples = [];

  const nodeId = point => {
    const key = graphNodeKey(point);
    if (keyToId.has(key)) return keyToId.get(key);
    const id = nodes.length;
    nodes.push([Number(point[0]), Number(point[1])]);
    keyToId.set(key, id);
    adjacency.set(id, []);
    return id;
  };
  const connect = (from, to, roadId) => {
    if (from === to) return;
    const cost = distance(nodes[from], nodes[to]);
    adjacency.get(from).push({ to, cost, roadId });
    adjacency.get(to).push({ to: from, cost, roadId });
  };

  config.roads.forEach(road => {
    const samples = [];
    road.points.slice(0, -1).forEach((start, segmentIndex) => {
      const end = road.points[segmentIndex + 1];
      const segmentLength = distance(start, end);
      const pieces = Math.max(1, Math.ceil(segmentLength / GRAPH_STEP_METERS));
      for (let index = 0; index < pieces; index += 1) {
        const ratio = index / pieces;
        const point = [
          start[0] + (end[0] - start[0]) * ratio,
          start[1] + (end[1] - start[1]) * ratio
        ];
        if (!samples.length || distance(samples[samples.length - 1].point, point) > POSITION_EPSILON) {
          samples.push({ point, road, segmentIndex });
        }
      }
    });
    samples.push({
      point: [...road.points[road.points.length - 1]],
      road,
      segmentIndex: road.points.length - 2
    });
    for (let index = 0; index < samples.length - 1; index += 1) {
      connect(nodeId(samples[index].point), nodeId(samples[index + 1].point), road.id);
    }
    roadSamples.push(...samples);
  });

  return { nodes, adjacency, roadSamples };
}

const ROAD_GRAPH = buildRoadGraph();

function withinWorld(point, radius = config.rules.vehicleRadius + ROAD_SAFETY_MARGIN) {
  return point[0] >= -config.world.width / 2 + radius
    && point[0] <= config.world.width / 2 - radius
    && point[1] >= -config.world.depth / 2 + radius
    && point[1] <= config.world.depth / 2 - radius;
}

function pointRoadLegal(point) {
  return withinWorld(point)
    && CompetitionCore.geometry.nearestRoad(
      point,
      config.roads,
      config.rules.vehicleRadius + ROAD_SAFETY_MARGIN
    ).onRoad;
}

function segmentRoadLegal(start, end) {
  const length = distance(start, end);
  const samples = Math.max(1, Math.ceil(length / PATH_SAMPLE_METERS));
  for (let index = 0; index <= samples; index += 1) {
    const ratio = index / samples;
    const point = [
      start[0] + (end[0] - start[0]) * ratio,
      start[1] + (end[1] - start[1]) * ratio
    ];
    if (!pointRoadLegal(point)) return false;
  }
  return true;
}

function segmentCollisionFree(start, end, colliders) {
  const vehicleEnvelope = config.rules.vehicleRadius + 0.005 + COLLISION_SAFETY_MARGIN;
  return colliders.every(collider => {
    if (collider.type !== "circle") throw new TypeError(`unsupported private-route collider: ${collider.type}`);
    const clearance = pointToSegmentDistance([collider.x, collider.z], start, end)
      - vehicleEnvelope - Number(collider.radius);
    return clearance > POSITION_EPSILON;
  });
}

function segmentTraversable(start, end, colliders) {
  return segmentRoadLegal(start, end) && segmentCollisionFree(start, end, colliders);
}

function attachableNodes(point, colliders) {
  return ROAD_GRAPH.nodes
    .map((candidate, id) => ({ id, point: candidate, cost: distance(point, candidate) }))
    .filter(candidate => candidate.cost <= ATTACH_RADIUS_METERS + POSITION_EPSILON
      && segmentTraversable(point, candidate.point, colliders))
    .sort((left, right) => left.cost - right.cost || left.id - right.id)
    .slice(0, 14);
}

function reconstructPath(previous, finishId, start, end) {
  const nodeIds = [];
  let cursor = finishId;
  while (cursor !== null && cursor !== undefined) {
    nodeIds.push(cursor);
    cursor = previous.get(cursor);
  }
  nodeIds.reverse();
  return [start, ...nodeIds.map(id => ROAD_GRAPH.nodes[id]), end];
}

function simplifyPath(points, colliders) {
  const compact = [points[0]];
  let anchor = 0;
  while (anchor < points.length - 1) {
    let next = points.length - 1;
    while (next > anchor + 1 && !segmentTraversable(points[anchor], points[next], colliders)) next -= 1;
    assert.ok(next > anchor, "private route simplification made no progress");
    compact.push(points[next]);
    anchor = next;
  }
  return compact.filter((point, index) => index === 0 || distance(point, compact[index - 1]) > 0.004);
}

function findPath(start, end, colliders) {
  assert.equal(pointRoadLegal(start), true, "private route start must be road legal");
  assert.equal(pointRoadLegal(end), true, "private route destination must be road legal");
  if (segmentTraversable(start, end, colliders)) {
    return { points: [start, end], distanceMeters: distance(start, end) };
  }

  const starts = attachableNodes(start, colliders);
  const finishes = attachableNodes(end, colliders);
  if (!starts.length || !finishes.length) return null;
  const finishCosts = new Map(finishes.map(item => [item.id, item.cost]));
  const distances = new Map();
  const previous = new Map();
  const open = [];
  starts.forEach(item => {
    const existing = distances.get(item.id);
    if (existing === undefined || item.cost < existing) {
      distances.set(item.id, item.cost);
      previous.set(item.id, null);
      open.push({ id: item.id, cost: item.cost });
    }
  });
  let winner = null;
  let winnerCost = Infinity;

  while (open.length) {
    open.sort((left, right) => left.cost - right.cost || left.id - right.id);
    const current = open.shift();
    if (current.cost !== distances.get(current.id)) continue;
    if (current.cost >= winnerCost) continue;
    if (finishCosts.has(current.id)) {
      const total = current.cost + finishCosts.get(current.id);
      if (total < winnerCost) {
        winner = current.id;
        winnerCost = total;
      }
    }
    for (const edge of ROAD_GRAPH.adjacency.get(current.id) || []) {
      const from = ROAD_GRAPH.nodes[current.id];
      const to = ROAD_GRAPH.nodes[edge.to];
      if (!segmentCollisionFree(from, to, colliders)) continue;
      const candidateCost = current.cost + edge.cost;
      if (candidateCost + POSITION_EPSILON >= (distances.get(edge.to) ?? Infinity)) continue;
      distances.set(edge.to, candidateCost);
      previous.set(edge.to, current.id);
      open.push({ id: edge.to, cost: candidateCost });
    }
  }
  if (winner === null) return null;
  const raw = reconstructPath(previous, winner, start, end);
  const points = simplifyPath(raw, colliders);
  return {
    points,
    distanceMeters: points.slice(1).reduce((sum, point, index) => sum + distance(points[index], point), 0)
  };
}

function grabApproaches(item) {
  const nearest = CompetitionCore.geometry.nearestRoad([item.x, item.z], config.roads, item.radius);
  const tangentLength = Math.hypot(nearest.tangent[0], nearest.tangent[1]);
  assert.ok(tangentLength > POSITION_EPSILON, `no road tangent for ${item.role}`);
  const tangent = [nearest.tangent[0] / tangentLength, nearest.tangent[1] / tangentLength];
  return [-1, 1].map(sign => ({
    point: [
      item.x - tangent[0] * sign * GRAB_STANDOFF_METERS,
      item.z - tangent[1] * sign * GRAB_STANDOFF_METERS
    ],
    heading: headingToward([
      item.x - tangent[0] * sign * GRAB_STANDOFF_METERS,
      item.z - tangent[1] * sign * GRAB_STANDOFF_METERS
    ], [item.x, item.z])
  })).filter(candidate => pointRoadLegal(candidate.point));
}

function predictedReleasePoint(posePoint, destination) {
  const dx = destination[0] - posePoint[0];
  const dz = destination[1] - posePoint[1];
  const length = Math.hypot(dx, dz);
  if (length <= POSITION_EPSILON) return null;
  return [
    posePoint[0] + dx / length * 1.1,
    posePoint[1] + dz / length * 1.1
  ];
}

function storageReleaseCandidates(colliders, packageRadius) {
  const delivery = config.task.deliveries.find(item => item.objectRole === "target");
  return ROAD_GRAPH.nodes.map(point => {
    const releasePoint = predictedReleasePoint(point, delivery.destination);
    return releasePoint ? { point, releasePoint, heading: headingToward(point, delivery.destination) } : null;
  }).filter(Boolean).filter(candidate => {
    if (distance(candidate.releasePoint, delivery.destination) > delivery.radius - 0.08) return false;
    if (!withinWorld(candidate.releasePoint, packageRadius)) return false;
    if (!segmentCollisionFree(candidate.point, candidate.point, colliders)) return false;
    return true;
  });
}

function offroadReleaseCandidates(colliders, packageRadius, requiredClearance) {
  const candidates = [];
  ROAD_GRAPH.roadSamples.forEach(sample => {
    const road = sample.road;
    const start = road.points[sample.segmentIndex];
    const end = road.points[sample.segmentIndex + 1];
    const length = distance(start, end);
    if (length <= POSITION_EPSILON) return;
    const tangent = [(end[0] - start[0]) / length, (end[1] - start[1]) / length];
    const normal = [-tangent[1], tangent[0]];
    const lateral = road.width / 2 - config.rules.vehicleRadius - ROAD_SAFETY_MARGIN - 0.01;
    if (lateral <= 0) return;
    for (const sign of [-1, 1]) {
      const outward = [normal[0] * sign, normal[1] * sign];
      const point = [sample.point[0] + outward[0] * lateral, sample.point[1] + outward[1] * lateral];
      const releasePoint = [point[0] + outward[0] * 1.1, point[1] + outward[1] * 1.1];
      if (!pointRoadLegal(point) || !withinWorld(releasePoint, packageRadius)) continue;
      if (!segmentCollisionFree(point, point, colliders)) continue;
      const clearance = CompetitionCore.geometry.roadBoundaryClearance(
        releasePoint,
        config.task.placementGeometry.roads,
        packageRadius
      );
      if (clearance.clearance < requiredClearance + 0.035) continue;
      if (colliders.some(collider => distance(releasePoint, [collider.x, collider.z])
        <= packageRadius + Number(collider.radius) + COLLISION_SAFETY_MARGIN)) continue;
      candidates.push({
        point,
        releasePoint,
        heading: headingToward(point, releasePoint),
        clearance: clearance.clearance
      });
    }
  });
  return candidates;
}

function chooseReachableCandidate(start, candidates, colliders, label, candidateAccept = null) {
  const ranked = [...candidates].sort((left, right) => distance(start, left.point) - distance(start, right.point)
    || left.point[0] - right.point[0]
    || left.point[1] - right.point[1]);
  for (const candidate of ranked) {
    const path = findPath(start, candidate.point, colliders);
    if (!path) continue;
    if (candidateAccept && !candidateAccept(candidate)) continue;
    return { candidate, path };
  }
  assert.fail(`${label} has no reachable legal candidate`);
}

function runPrivateLayoutRoute(layoutOrId, options = {}) {
  const layoutId = typeof layoutOrId === "string" ? layoutOrId : layoutOrId?.id;
  assert.equal(typeof layoutId, "string", "private layout route requires a layout id");
  const interactionDefinition = createGuangyangInteractionDefinition(layoutId, {
    catalog: options.catalog || GUANGYANG_PRIVATE_LAYOUT_CATALOG
  });
  const taskDefinition = resolvedTaskDefinition();
  assert.equal(taskDefinition.schemaVersion, CompetitionCore.ROAD_CLEARANCE_TASK_SCHEMA_VERSION);
  CompetitionCore.validateRoadClearancePlacementRules(taskDefinition, config.rules);

  const packages = new CompetitionCore.PackageStateEngine(interactionDefinition);
  const simulator = new CompetitionCore.DeterministicSimulator(simulationDefinition(packages.colliders()));
  const task = new CompetitionCore.TaskEngine(taskDefinition);
  const rules = new CompetitionCore.RuleEngine(config.rules);
  const actions = [];
  const taskEvents = [];
  const ruleViolations = [];
  let previousRuleSample = null;

  const evaluateTask = elapsedMs => {
    const pose = simulator.snapshot().pose;
    const state = packages.snapshot();
    const result = task.evaluate({
      x: pose.x,
      z: pose.z,
      elapsedMs,
      holding: state.holding,
      packages: state.packages
    }, elapsedMs);
    taskEvents.push(...result.events);
    return result;
  };

  const observeFrame = frame => {
    const sample = {
      x: frame.x,
      z: frame.z,
      heading: frame.heading,
      speed: Math.abs(frame.linearSpeed),
      elapsedMs: frame.elapsedMs
    };
    const result = rules.evaluate(sample, previousRuleSample, frame.elapsedMs);
    ruleViolations.push(...result.violations.map(item => ({ ...item, elapsedMs: frame.elapsedMs })));
    previousRuleSample = sample;
    if (frame.collision) {
      task.noteCollision(frame.collision.colliderId);
      ruleViolations.push({
        type: "collision",
        elapsedMs: frame.collision.elapsedMs,
        tick: frame.collision.tick,
        colliderId: frame.collision.colliderId
      });
    }
    evaluateTask(frame.elapsedMs);
  };

  const runCommand = (command, action) => {
    simulator.setWorld(simulationDefinition(packages.colliders()).world);
    const result = simulator.runCommand(command);
    result.frames.forEach(observeFrame);
    assert.equal(result.result.blocked, false, `${action?.label || "internal animation"} was blocked`);
    if (action) actions.push({ ...action, endPose: { ...result.snapshot.pose } });
  };

  const turnToward = (point, label) => {
    const pose = simulator.snapshot().pose;
    const desired = headingToward([pose.x, pose.z], point);
    const delta = signedHeadingDelta(pose.heading, desired);
    const degrees = Math.abs(delta) * 180 / Math.PI;
    if (degrees < 1) return;
    const durationMs = Math.ceil(Math.max(260, Math.abs(delta) / 2.8 * 1000) / STEP_MS) * STEP_MS;
    const direction = delta > 0 ? "left" : "right";
    runCommand({
      kind: "turn_angle",
      direction,
      angleDegrees: degrees,
      durationMs
    }, {
      type: direction === "left" ? "left_angle" : "right_angle",
      degrees,
      label
    });
  };

  const driveTo = (point, label) => {
    turnToward(point, `${label} / 对准`);
    const pose = simulator.snapshot().pose;
    const meters = distance([pose.x, pose.z], point);
    if (meters <= DRIVE_STEP_METERS / 2) return;
    const durationTicks = Math.max(1, Math.round(meters / DRIVE_STEP_METERS));
    const durationMs = durationTicks * STEP_MS;
    runCommand({
      kind: "drive",
      direction: 1,
      durationMs,
      durationTicks,
      speedPercent: SPEED_PERCENT
    }, {
      type: "forward",
      seconds: durationMs / 1000,
      speedPercent: SPEED_PERCENT,
      label
    });
  };

  const drivePath = (path, label) => {
    path.points.slice(1).forEach((point, index) => driveTo(point, `${label} ${index + 1}`));
  };

  const currentPoint = () => {
    const pose = simulator.snapshot().pose;
    return [pose.x, pose.z];
  };

  const interact = (kind, packageId, label) => {
    const beforeMs = kind === "grab" ? 480 : 260;
    const afterMs = kind === "grab" ? 280 : 420;
    runCommand({ kind: "wait", durationMs: beforeMs }, null);
    const pose = simulator.snapshot().pose;
    // The public robot.grab()/release() methods do not accept a hidden package
    // id. An empty intent proves that the visible no-argument call selects the
    // intended object from this pose.
    const outcome = packages.apply(kind, {}, pose);
    assert.equal(outcome.accepted, true, `${label}: ${outcome.reason}`);
    assert.equal(outcome.packageId, packageId, `${label}: unexpected package`);
    actions.push({ type: kind, packageId, label, pose: { ...pose }, outcome });
    evaluateTask(simulator.snapshot().elapsedMs);
    runCommand({ kind: "wait", durationMs: afterMs }, null);
    return outcome;
  };

  const navigateToInteraction = (item, label) => {
    const colliders = packages.colliders();
    const selected = chooseReachableCandidate(
      currentPoint(),
      grabApproaches(item),
      colliders,
      `${label} grab approach`
    );
    drivePath(selected.path, `${label}抓取路线`);
    turnToward([item.x, item.z], `${label}抓取朝向`);
  };

  evaluateTask(0);

  const target = interactionDefinition.packages.find(item => item.role === "target");
  const distractor = interactionDefinition.packages.find(item => item.role === "distractor");
  const obstacle = interactionDefinition.packages.find(item => item.role === "obstacle");
  assert.ok(target && distractor && obstacle, "private layout must contain all three roles");

  navigateToInteraction(target, "目标物");
  interact("grab", target.id, "抓取目标物");

  {
    const colliders = packages.colliders();
    const selected = chooseReachableCandidate(
      currentPoint(),
      storageReleaseCandidates(colliders, target.radius),
      colliders,
      "target storage release",
      candidate => {
        const releasedCollider = {
          id: "hypothetical-target-release",
          type: "circle",
          x: candidate.releasePoint[0],
          z: candidate.releasePoint[1],
          radius: target.radius
        };
        return Boolean(findPath(candidate.point, config.start, [...colliders, releasedCollider]));
      }
    );
    drivePath(selected.path, "目标物入库路线");
    turnToward(selected.candidate.releasePoint, "目标物入库朝向");
    const outcome = interact("release", target.id, "目标物放入存放点");
    const delivery = taskDefinition.deliveries.find(item => item.objectRole === "target");
    assert.ok(distance(outcome.position, delivery.destination) <= delivery.radius + POSITION_EPSILON,
      "target release must be inside storage");
  }

  navigateToInteraction(distractor, "混淆物");
  interact("grab", distractor.id, "抓取混淆物");

  let offroadRemoval;
  {
    const colliders = packages.colliders();
    const delivery = taskDefinition.deliveries.find(item => item.objectRole === "distractor");
    const selected = chooseReachableCandidate(
      currentPoint(),
      offroadReleaseCandidates(colliders, distractor.radius, delivery.minimumRoadEdgeClearance),
      colliders,
      "distractor off-road release"
    );
    drivePath(selected.path, "混淆物移出道路路线");
    turnToward(selected.candidate.releasePoint, "混淆物道路外朝向");
    const releasePose = { ...simulator.snapshot().pose };
    assert.equal(CompetitionCore.geometry.nearestRoad(
      [releasePose.x, releasePose.z],
      config.roads,
      config.rules.vehicleRadius
    ).onRoad, true, "vehicle must stay fully on road during distractor release");
    const outcome = interact("release", distractor.id, "混淆物移出道路");
    const clearance = CompetitionCore.geometry.roadBoundaryClearance(
      outcome.position,
      taskDefinition.placementGeometry.roads,
      distractor.radius
    );
    assert.ok(clearance.clearance + POSITION_EPSILON >= delivery.minimumRoadEdgeClearance,
      "distractor body must clear every road edge");
    offroadRemoval = { releasePose, packagePosition: outcome.position, clearance };
  }

  config.checkpoints.forEach((checkpoint, index) => {
    const path = findPath(currentPoint(), checkpoint.position, packages.colliders());
    assert.ok(path, `checkpoint ${index + 1} has no legal route`);
    drivePath(path, `检查点${index + 1}路线`);
  });

  {
    const path = findPath(currentPoint(), config.goal, packages.colliders());
    assert.ok(path, "return goal has no legal route");
    drivePath(path, "返航路线");
  }

  const taskState = task.snapshot();
  const packageState = packages.snapshot();
  const simulationState = simulator.snapshot();
  const finalPose = simulationState.pose;
  const obstacleCollisions = simulationState.collisions.filter(item => (
    item.colliderId === `object:${obstacle.id}`
  ));

  assert.equal(taskState.completed, 8, "all eight task units must complete");
  assert.equal(taskState.total, 8);
  assert.equal(taskState.finished, true, "task must finish");
  assert.equal(taskState.goalReached, true, "return goal must complete");
  assert.deepEqual(taskState.visitedCheckpointIds, config.checkpoints.map(item => item.id));
  assert.deepEqual([...taskState.deliveredPackageIds].sort(), [target.id, distractor.id].sort());
  assert.equal(taskState.avoidanceProgress.completed, 1);
  assert.deepEqual(taskState.avoidanceProgress.failedObjectIds, []);
  assert.equal(obstacleCollisions.length, 0, "specified obstacle must have zero collisions");
  assert.equal(simulationState.collisionCount, 0, "reference route must have zero collisions");
  assert.deepEqual(ruleViolations, [],
    "reference route must have zero off-road, speeding, wrong-way, prohibited-zone, red-light, or collision violations");
  assert.ok(distance([finalPose.x, finalPose.z], config.goal) <= taskDefinition.goalRadius);

  actions.forEach(action => {
    if (action.type === "forward") {
      assert.ok(action.seconds > 0 && action.seconds <= 500, "forward duration must fit the public API");
      assert.ok(action.speedPercent >= 10 && action.speedPercent <= 100, "forward speed must fit the public API");
    } else if (action.type === "left_angle" || action.type === "right_angle") {
      assert.ok(action.degrees >= 1 && action.degrees <= 360, "turn angle must fit the public API");
    } else {
      assert.ok(action.type === "grab" || action.type === "release", `unsupported public action ${action.type}`);
    }
  });

  const durationSeconds = simulationState.elapsedMs / 1000;
  assert.ok(durationSeconds < config.scoring.efficiency.maxSeconds,
    "reference route must finish inside the 600 second limit");
  const ruleMetrics = rules.metrics(simulationState.elapsedMs);
  const score = new CompetitionCore.CompetitionJudge(config.scoring).score({
    task: taskState,
    violations: ruleViolations,
    violationMetrics: ruleMetrics,
    durationSeconds,
    manualInterventions: 0
  });

  return {
    layoutId,
    taskDefinition,
    interactionDefinition,
    taskState,
    packageState,
    finalPose,
    actions,
    taskEvents,
    ruleViolations,
    ruleMetrics,
    collisions: simulationState.collisions,
    durationSeconds,
    distanceMeters: actions.filter(action => action.type === "forward")
      .reduce((sum, action) => sum + action.seconds * SPEED_METERS_PER_SECOND, 0),
    score,
    offroadRemoval
  };
}

function validateAllPrivateLayoutRoutes(catalog = GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2) {
  const normalized = GUANGYANG_PRIVATE_LAYOUT_CATALOG_REGISTRY[catalog?.catalogVersion] === catalog
    ? catalog
    : validateGuangyangLayoutCatalog(catalog);
  const results = normalized.layouts.map(layout => runPrivateLayoutRoute(layout.id, { catalog: normalized }));
  const durations = results.map(result => result.durationSeconds);
  const scores = results.map(result => result.score.score);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: "ok",
    catalogVersion: normalized.catalogVersion,
    layoutCount: results.length,
    completedUnitsPerLayout: "8/8",
    maximumDurationSeconds: Math.max(...durations),
    minimumScore: Math.min(...scores),
    zeroCollisionLayouts: results.filter(result => result.collisions.length === 0).length,
    zeroViolationLayouts: results.filter(result => result.ruleViolations.length === 0).length,
    results
  };
}

function quantile(values, percentile) {
  assert.ok(Array.isArray(values) && values.length > 0, "quantile requires values");
  const sorted = [...values].sort((left, right) => left - right);
  const offset = (sorted.length - 1) * percentile;
  const lower = Math.floor(offset);
  const upper = Math.ceil(offset);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (offset - lower);
}

function distribution(values, digits) {
  const rounded = value => Number(value.toFixed(digits));
  return {
    min: rounded(quantile(values, 0)),
    p10: rounded(quantile(values, 0.1)),
    p25: rounded(quantile(values, 0.25)),
    p50: rounded(quantile(values, 0.5)),
    p75: rounded(quantile(values, 0.75)),
    p90: rounded(quantile(values, 0.9)),
    max: rounded(quantile(values, 1))
  };
}

function publicReport(validation) {
  const durationValues = validation.results.map(result => result.durationSeconds);
  const scoreValues = validation.results.map(result => result.score.score);
  const distanceValues = validation.results.map(result => result.distanceMeters);
  const actionValues = validation.results.map(result => result.actions.length);
  const catalogLayoutIds = new Set(validation.results.map(result => result.layoutId));
  const rankedSet = new Set(GUANGYANG_RANKED_LAYOUT_FORM_V2);
  const poolsDisjoint = GUANGYANG_PRACTICE_LAYOUT_POOL_V2.every(id => !rankedSet.has(id));
  const exactV2Partition = validation.catalogVersion === GUANGYANG_PRIVATE_LAYOUT_CATALOG_V2_VERSION
    && validation.layoutCount === 198
    && rankedSet.size === 5
    && GUANGYANG_PRACTICE_LAYOUT_POOL_V2.length === 193
    && [...rankedSet, ...GUANGYANG_PRACTICE_LAYOUT_POOL_V2]
      .every(id => catalogLayoutIds.has(id));
  return {
    schemaVersion: validation.schemaVersion,
    status: validation.status,
    catalogVersion: validation.catalogVersion,
    layoutCount: validation.layoutCount,
    enumeratedAnchorAssignments: 216,
    strictRejectedAssignments: 18,
    rankedFormLayoutCount: rankedSet.size,
    practicePoolLayoutCount: GUANGYANG_PRACTICE_LAYOUT_POOL_V2.length,
    completedUnitsPerLayout: validation.completedUnitsPerLayout,
    maximumDurationSeconds: Number(validation.maximumDurationSeconds.toFixed(2)),
    minimumScore: Number(validation.minimumScore.toFixed(1)),
    zeroCollisionLayouts: validation.zeroCollisionLayouts,
    zeroViolationLayouts: validation.zeroViolationLayouts,
    distributions: {
      durationSeconds: distribution(durationValues, 3),
      score: distribution(scoreValues, 3),
      distanceMeters: distribution(distanceValues, 3),
      actionCount: distribution(actionValues, 3)
    },
    checks: {
      frozenExpandedCatalog: exactV2Partition,
      rankedPracticeDisjoint: poolsDisjoint,
      realTaskV5: true,
      realInteractionAndRules: true,
      publicActionRanges: true,
      orderedCheckpointsAndReturn: true,
      targetStored: true,
      distractorBeyondEveryRoadEdge: true,
      specifiedObstacleAvoided: true,
      underCompetitionTimeLimit: true
    },
    privacy: "Reference routes and coordinates remain in a server-private validation tool."
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(publicReport(validateAllPrivateLayoutRoutes()), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  REPORT_SCHEMA_VERSION,
  runPrivateLayoutRoute,
  validateAllPrivateLayoutRoutes,
  publicReport
};
