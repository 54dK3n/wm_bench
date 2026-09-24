const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SCHEMA_VERSION,
  LEGACY_INTERACTION_SCHEMA_VERSION,
  INTERACTION_SCHEMA_VERSION,
  LEGACY_TASK_SCHEMA_VERSION,
  PREVIOUS_TASK_SCHEMA_VERSION,
  TASK_SCHEMA_VERSION,
  OFFROAD_TASK_SCHEMA_VERSION,
  ROAD_CLEARANCE_TASK_SCHEMA_VERSION,
  CompetitionJudge,
  CompetitionSession,
  DeterministicSimulator,
  GUANGYANG_CHALLENGE_CONFIGS,
  GUANGYANG_ISLAND_CONFIG,
  LEGACY_NAVIGATION_DEFINITION,
  PREVIOUS_NAVIGATION_DEFINITION,
  MISSION_NAVIGATION_DEFINITION,
  RELEASE_PREVIEW_NAVIGATION_DEFINITION,
  PREVIOUS_CURRENT_NAVIGATION_DEFINITION,
  NAVIGATION_DEFINITION,
  PUBLIC_NAVIGATION_DEFINITION,
  LEGACY_NAVIGATION_CONTROL_DEFINITION,
  PREVIOUS_NAVIGATION_CONTROL_DEFINITION,
  PREVIOUS_EXIT_SAFE_NAVIGATION_CONTROL_DEFINITION,
  PREVIOUS_UNIT_NAVIGATION_CONTROL_DEFINITION,
  NAVIGATION_CONTROL_DEFINITION,
  NAVIGATION_MISSION_SCHEMA_VERSION,
  TASK_STATE_SCHEMA_VERSION,
  RELEASE_PREVIEW_SCHEMA_VERSION,
  ROAD_GRAPH_SCHEMA_VERSION,
  NavigationActionRunner,
  PackageStateEngine,
  RunRecorder,
  RuleEngine,
  ReplayPlayer,
  TaskEngine,
  geometry,
  normalizeInteractionDefinition,
  normalizeNavigationDefinition,
  normalizeNavigationControlDefinition,
  createNavigationTopologyContext,
  projectNavigationQuery,
  validateFixedOffroadDeliveryGeometry,
  rejudgeTask,
  trafficLightState
} = require("../competition-core.js");

function makeCheckpointTask(overrides = {}) {
  return {
    id: "ordered-route",
    version: "1",
    type: "checkpoints",
    checkpointRadius: 0.25,
    goalRadius: 0.25,
    checkpoints: [
      { id: "checkpoint-a", position: [2, 0] },
      { id: "checkpoint-b", position: [4, 0] }
    ],
    goal: [0, 0],
    ...overrides
  };
}

function makeCompositeTask(overrides = {}) {
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    id: "island-composite",
    version: "2",
    type: "composite",
    checkpointRadius: 0.25,
    goalRadius: 0.25,
    deliveryRadius: 0.3,
    checkpoints: [
      { id: "checkpoint-a", position: [1, 0] },
      { id: "checkpoint-b", position: [2, 0] }
    ],
    goal: [0, 0],
    deliveries: [
      {
        id: "target-storage",
        objectRole: "target",
        destinationRole: "storage",
        destination: [3, 0],
        radius: 0.3,
        requiredPackageIds: ["target-a"]
      },
      {
        id: "distractor-cleanup",
        objectRole: "distractor",
        destinationRole: "cleanup",
        destination: [4, 0],
        radius: 0.3,
        requiredPackageIds: ["decoy-a"]
      }
    ],
    ...overrides
  };
}

function makeRoadClearanceTask(overrides = {}) {
  return {
    ...makeCompositeTask(),
    schemaVersion: ROAD_CLEARANCE_TASK_SCHEMA_VERSION,
    version: "5",
    deliveries: [
      makeCompositeTask().deliveries[0],
      {
        id: "distractor-offroad-removal",
        objectRole: "distractor",
        destinationRole: "offroad-removal",
        placementRule: "road-edge-clearance",
        objectRadius: 0.25,
        minimumRoadEdgeClearance: 0.2,
        requiredPackageIds: ["decoy-a"]
      }
    ],
    placementGeometry: {
      roads: [{ id: "road-a", width: 2, points: [[-5, 0], [5, 0]] }]
    },
    ...overrides
  };
}

function observation(point, t) {
  return { x: point[0], z: point[1], heading: 0, speed: 0, steering: 0, t };
}

function navigationControlSimulation(initialPose = { x: 0, z: 2.5, heading: 0 }, colliders = []) {
  return {
    schemaVersion: "chenlong.simulation/v1",
    stepMs: 20,
    seed: 23,
    initialPose,
    vehicle: {
      version: "chenlong.vehicle/v1",
      radius: 0.2,
      collisionSkin: 0.005,
      maxLinearSpeed: 2,
      maxAngularSpeed: 2.8
    },
    world: { bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 }, colliders }
  };
}

function navigationCrossRules() {
  return {
    vehicleRadius: 0.2,
    roads: [
      { id: "south", width: 1.6, points: [[0, 3], [0, 0]] },
      { id: "north", width: 1.6, points: [[0, 0], [0, -4]] },
      { id: "west", width: 1.6, points: [[0, 0], [-4, 0]] },
      { id: "east", width: 1.6, points: [[0, 0], [4, 0]] },
      { id: "inbound", width: 1.6, oneWay: true, points: [[3, 3], [0, 0]] }
    ]
  };
}

test("Guangyang competition start, goal and checkpoints lie on the drivable network", () => {
  const points = [
    GUANGYANG_ISLAND_CONFIG.start.slice(0, 2),
    GUANGYANG_ISLAND_CONFIG.goal,
    ...GUANGYANG_ISLAND_CONFIG.checkpoints.map(checkpoint => checkpoint.position)
  ];
  points.forEach(point => {
    const match = geometry.nearestRoad(point, GUANGYANG_ISLAND_CONFIG.roads, 0.44);
    assert.equal(match.onRoad, true, `${point.join(",")} should be on a road`);
  });
});

test("navigation sensors expose start-relative odometry and local road geometry without world coordinates", () => {
  const odometry = projectNavigationQuery("odometry", {
    pose: { x: 1, z: -2, heading: Math.PI / 2 },
    initialPose: { x: 0, z: 0, heading: 0 },
    distance: 3,
    tick: 5,
    rules: {},
    navigationDefinition: LEGACY_NAVIGATION_DEFINITION
  });
  assert.deepEqual(odometry, {
    forwardCm: 200,
    rightCm: 100,
    headingDeg: 90,
    distanceCm: 300,
    tick: 5
  });
  assert.equal(Object.prototype.hasOwnProperty.call(odometry, "x"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(odometry, "z"), false);

  const rules = {
    vehicleRadius: 0.2,
    roads: [
      { id: "north-south", width: 2, points: [[0, 2], [0, -2]] },
      { id: "east-west", width: 2, points: [[-2, 0], [2, 0]] }
    ]
  };
  const road = projectNavigationQuery("road_state", {
    pose: { x: 0.25, z: 0, heading: 0 },
    initialPose: { x: 0, z: 0, heading: 0 },
    distance: 0,
    tick: 7,
    rules,
    navigationDefinition: LEGACY_NAVIGATION_DEFINITION
  });
  assert.equal(road.onRoad, true);
  assert.equal(road.roadId, "north-south");
  assert.deepEqual(road.roadIds, ["north-south", "east-west"]);
  assert.equal(road.lateralOffsetCm, 25);
  assert.equal(road.headingErrorDeg, 0);
  assert.equal(road.leftClearanceCm, 105);
  assert.equal(road.rightClearanceCm, 55);
  assert.equal(road.atJunction, true);
  assert.equal(road.tick, 7);
  ["x", "z", "position", "nearestPoint", "segmentIndex", "points"].forEach(field => {
    assert.equal(Object.prototype.hasOwnProperty.call(road, field), false, `${field} must stay private`);
  });

  const offRoad = projectNavigationQuery("road_state", {
    pose: { x: 3, z: 1.5, heading: Math.PI },
    initialPose: { x: 0, z: 0, heading: 0 },
    distance: 0,
    tick: 8,
    rules,
    navigationDefinition: LEGACY_NAVIGATION_DEFINITION
  });
  assert.equal(offRoad.onRoad, false);
  assert.equal(offRoad.roadIds.length, 0);
  assert.equal(offRoad.atJunction, false);
});

test("navigation v2/v3 remain replayable while v4 projects a coordinate-free graph and node exits", () => {
  assert.equal(normalizeNavigationDefinition(LEGACY_NAVIGATION_DEFINITION).schemaVersion, "chenlong.navigation/v1");
  assert.equal(normalizeNavigationDefinition(PREVIOUS_NAVIGATION_DEFINITION).schemaVersion, "chenlong.navigation/v2");
  assert.equal(normalizeNavigationDefinition(MISSION_NAVIGATION_DEFINITION).schemaVersion, "chenlong.navigation/v3");
  assert.equal(normalizeNavigationDefinition(RELEASE_PREVIEW_NAVIGATION_DEFINITION).schemaVersion, "chenlong.navigation/v4");
  assert.equal(normalizeNavigationDefinition(PREVIOUS_CURRENT_NAVIGATION_DEFINITION).schemaVersion,
    "chenlong.navigation/v5");
  assert.equal(normalizeNavigationDefinition(NAVIGATION_DEFINITION).schemaVersion, "chenlong.navigation/v6");
  assert.equal(normalizeNavigationDefinition(PUBLIC_NAVIGATION_DEFINITION).objectAnchorDisclosure, "road-anchor");
  assert.throws(() => normalizeNavigationDefinition({
    ...NAVIGATION_DEFINITION,
    roadTopology: { ...NAVIGATION_DEFINITION.roadTopology, junctionRadiusCm: 999 }
  }), /supported frozen navigation sensor contract/);

  const roads = [
    { id: "south", width: 2, points: [[0, 2], [0, 0]] },
    { id: "north", width: 2, points: [[0, 0], [0, -2]] },
    { id: "west", width: 2, points: [[0, 0], [-2, 0]] },
    { id: "east", width: 2, points: [[0, 0], [2, 0]] },
    { id: "inbound", width: 2, oneWay: true, points: [[2, 2], [0, 0]] }
  ];
  const rules = { vehicleRadius: 0.2, roads };
  const world = {
    bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
    colliders: [{ id: "private-obstacle-id", type: "circle", x: 0, z: -2, radius: 0.3 }]
  };
  const graph = projectNavigationQuery("map_graph", {
    rules,
    navigationDefinition: NAVIGATION_DEFINITION
  });
  assert.equal(graph.schemaVersion, ROAD_GRAPH_SCHEMA_VERSION);
  assert.deepEqual(graph.nodes.find(node => node.nodeId === "node:east:start"), {
    nodeId: "node:east:start",
    roadIds: ["east", "inbound", "north", "south", "west"]
  });
  assert.deepEqual(graph.edges.map(edge => edge.roadId), ["east", "inbound", "north", "south", "west"]);
  assert.deepEqual(graph.edges.find(edge => edge.roadId === "inbound"), {
    roadId: "inbound",
    fromNodeId: "node:inbound:start",
    toNodeId: "node:east:start",
    lengthCm: 282.8,
    oneWay: true
  });
  assert.deepEqual(
    graph,
    projectNavigationQuery("map_graph", {
      rules: { ...rules, roads: [...roads].reverse() },
      navigationDefinition: NAVIGATION_DEFINITION
    }),
    "road and node ordering must not depend on the input road array order"
  );
  assert.doesNotMatch(
    JSON.stringify(graph),
    /"(?:x|z|points|position|target|recommendedRoute)"/,
    "the public graph must not expose world geometry, targets, or a recommended route"
  );

  const roadState = projectNavigationQuery("road_state", {
    pose: { x: 0, z: 0, heading: 0 },
    initialPose: { x: 0, z: 2, heading: 0 },
    distance: 2,
    tick: 10,
    rules,
    world,
    vehicleRadius: 0.2,
    navigationDefinition: NAVIGATION_DEFINITION
  });
  assert.equal(roadState.atJunction, true);
  assert.equal(roadState.junctionId, "node:east:start");
  assert.equal(roadState.atNode, true);
  assert.equal(roadState.nodeId, "node:east:start");
  assert.equal(roadState.fromNodeId, "node:east:start");
  assert.equal(roadState.toNodeId, "node:north:end");
  assert.equal(roadState.roadProgressCm, 0);
  assert.equal(roadState.frontClearanceCm, 150);
  assert.deepEqual(roadState.exits, [
    { roadId: "west", direction: "left", turnDeg: 90 },
    { roadId: "north", direction: "straight", turnDeg: 0 },
    { roadId: "east", direction: "right", turnDeg: -90 },
    { roadId: "south", direction: "back", turnDeg: -180 }
  ]);
  assert.equal(roadState.exits.some(exit => exit.roadId === "inbound"), false,
    "a one-way road ending at the junction is not a legal exit");
  assert.equal(JSON.stringify(roadState).includes("private-obstacle-id"), false);

  const awayFromJunction = projectNavigationQuery("road_state", {
    pose: { x: 0, z: -1.5, heading: 0 },
    initialPose: { x: 0, z: 2, heading: 0 },
    distance: 3.5,
    tick: 11,
    rules,
    world: { bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 }, colliders: [] },
    vehicleRadius: 0.2,
    navigationDefinition: NAVIGATION_DEFINITION
  });
  assert.equal(awayFromJunction.atJunction, false);
  assert.equal(awayFromJunction.junctionId, null);
  assert.equal(awayFromJunction.atNode, true,
    "v3 exposes every road endpoint as a controllable graph node, not only 3-way junctions");
  assert.equal(awayFromJunction.nodeId, "node:north:end");
  assert.deepEqual(awayFromJunction.exits, [
    { roadId: "north", direction: "back", turnDeg: -180 }
  ]);
  assert.equal(awayFromJunction.frontClearanceCm, null, "clearance beyond five metres is intentionally hidden");

  assert.throws(() => projectNavigationQuery("map_graph", {
    rules: { roads: [roads[0], { ...roads[1], id: roads[0].id }] },
    navigationDefinition: NAVIGATION_DEFINITION
  }), /non-empty and unique/);
  assert.throws(() => projectNavigationQuery("map_graph", {
    rules: { roads: [{ id: "loop", points: [[0, 0], [1, 0], [0, 0]] }] },
    navigationDefinition: NAVIGATION_DEFINITION
  }), /self-loop/);
});

test("navigation v3/v4 publish task anchors and verified task progress without world coordinates", () => {
  const config = GUANGYANG_ISLAND_CONFIG;
  const taskDefinition = {
    ...config.task,
    checkpoints: config.checkpoints,
    goal: config.goal
  };
  const simulationDefinition = {
    schemaVersion: "chenlong.simulation/v1",
    stepMs: 20,
    seed: 0,
    initialPose: { x: config.start[0], z: config.start[1], heading: config.start[2] },
    vehicle: { version: "chenlong.vehicle/v1", radius: 0.44, collisionSkin: 0.005, maxLinearSpeed: 2.5, maxAngularSpeed: 2.8 },
    world: { bounds: { minX: -20, maxX: 20, minZ: -12, maxZ: 12 }, colliders: [] }
  };
  const mission = projectNavigationQuery("mission", {
    rules: config.rules,
    navigationDefinition: NAVIGATION_DEFINITION,
    taskDefinition,
    simulationDefinition,
    mapId: config.mapId,
    mapVersion: config.mapVersion
  });
  assert.deepEqual(Object.keys(mission), NAVIGATION_DEFINITION.methods.mission.fields);
  assert.equal(mission.schemaVersion, NAVIGATION_MISSION_SCHEMA_VERSION);
  assert.equal(mission.checkpoints.length, 4);
  for (const anchor of [mission.start, mission.storage, ...mission.checkpoints, mission.return]) {
    assert.deepEqual(Object.keys(anchor), ["id", "roadId", "progressCm"]);
    assert.equal(typeof anchor.roadId, "string");
    assert.ok(Number.isFinite(anchor.progressCm) && anchor.progressCm >= 0);
  }
  assert.doesNotMatch(JSON.stringify(mission), /(?:"x"|"z"|position|target|distractor|obstacle|recommendedRoute)/);

  const initial = projectNavigationQuery("task_state", {
    navigationDefinition: NAVIGATION_DEFINITION,
    taskDefinition,
    taskSnapshot: {
      completed: 0,
      total: 8,
      finished: false,
      nextCheckpointIndex: 0,
      goalReached: false,
      deliveryProgress: [
        { objectRole: "target", finished: false },
        { objectRole: "distractor", finished: false }
      ],
      avoidanceProgress: { finished: false, failedObjectIds: [] }
    },
    tick: 23
  });
  assert.deepEqual(Object.keys(initial), NAVIGATION_DEFINITION.methods.task_state.fields);
  assert.deepEqual(initial, {
    schemaVersion: TASK_STATE_SCHEMA_VERSION,
    completed: 0,
    total: 8,
    status: "running",
    nextCheckpointId: config.checkpoints[0].id,
    targetDelivered: false,
    distractorCleared: false,
    avoidanceStatus: "pending",
    goalReached: false,
    tick: 23
  });
  assert.throws(() => projectNavigationQuery("mission", {
    rules: config.rules,
    navigationDefinition: PREVIOUS_NAVIGATION_DEFINITION,
    taskDefinition,
    simulationDefinition,
    mapId: config.mapId,
    mapVersion: config.mapVersion
  }), /unsupported navigation query/);
});

test("navigation v4 previews a held package release without exposing a drop coordinate", () => {
  const task = makeRoadClearanceTask();
  const simulationDefinition = navigationControlSimulation({ x: 0, z: 1.2, heading: Math.PI });
  const interactionDefinition = {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    packageRadius: 0.25,
    stackKeyDigits: 3,
    bounds: simulationDefinition.world.bounds,
    grab: { minForward: 0.2, maxForward: 1.2, maxLateral: 0.4 },
    release: { forwardOffset: 0.6, lateralOffset: 0, stackSnapDistance: 0.3 },
    packages: [
      { id: "target-a", x: 1, z: 0, stackLevel: 0, role: "target", radius: 0.25 },
      { id: "decoy-a", x: 2, z: 0, stackLevel: 0, role: "distractor", radius: 0.25 }
    ]
  };
  const preview = projectNavigationQuery("release_preview", {
    pose: simulationDefinition.initialPose,
    tick: 12,
    navigationDefinition: NAVIGATION_DEFINITION,
    taskDefinition: task,
    interactionDefinition,
    simulationDefinition,
    packageSnapshot: {
      holding: "decoy-a",
      packages: [
        { id: "decoy-a", role: "distractor", x: 2, z: 0, stackLevel: 0 },
        { id: "target-a", role: "target", x: 1, z: 0, stackLevel: 0 }
      ]
    }
  });
  assert.deepEqual(Object.keys(preview), NAVIGATION_DEFINITION.methods.release_preview.fields);
  assert.deepEqual(preview, {
    schemaVersion: RELEASE_PREVIEW_SCHEMA_VERSION,
    holding: "distractor",
    releaseAccepted: true,
    releaseReason: "ready",
    wouldCompleteDelivery: true,
    roadClearanceCm: 55,
    requiredRoadClearanceCm: 20,
    tick: 12
  });
  assert.doesNotMatch(JSON.stringify(preview), /(?:"x"|"z"|position|packageId|obstacleId)/);
  assert.throws(() => projectNavigationQuery("release_preview", {
    pose: simulationDefinition.initialPose,
    tick: 12,
    navigationDefinition: MISSION_NAVIGATION_DEFINITION,
    taskDefinition: task,
    interactionDefinition,
    simulationDefinition,
    packageSnapshot: { holding: null, packages: [] }
  }), /unsupported navigation query/);
});

test("only published single-session navigation discloses coordinate-free task road anchors", () => {
  const config = GUANGYANG_ISLAND_CONFIG;
  const taskDefinition = {
    ...config.task,
    checkpoints: config.checkpoints,
    goal: config.goal
  };
  const simulationDefinition = {
    schemaVersion: "chenlong.simulation/v1",
    stepMs: 20,
    seed: 0,
    initialPose: { x: config.start[0], z: config.start[1], heading: config.start[2] },
    vehicle: { version: "chenlong.vehicle/v1", radius: 0.44, collisionSkin: 0.005, maxLinearSpeed: 2.5, maxAngularSpeed: 2.8 },
    world: { bounds: { minX: -20, maxX: 20, minZ: -12, maxZ: 12 }, colliders: [] }
  };
  const interactionDefinition = {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    packageRadius: config.objectTaskOverlay.packageRadius,
    stackKeyDigits: 3,
    bounds: simulationDefinition.world.bounds,
    grab: { minForward: 0.38, maxForward: 1.35, maxLateral: 0.38 },
    release: { forwardOffset: 1.1, lateralOffset: 0, stackSnapDistance: 0.62 },
    packages: config.objectTaskOverlay.objects.map(item => ({
      id: item.id, role: item.role, x: item.position[0], z: item.position[1], stackLevel: 0, radius: item.radius
    }))
  };
  const common = {
    rules: config.rules,
    taskDefinition,
    simulationDefinition,
    interactionDefinition,
    mapId: config.mapId,
    mapVersion: config.mapVersion
  };
  const privateMission = projectNavigationQuery("mission", {
    ...common,
    navigationDefinition: NAVIGATION_DEFINITION
  });
  assert.deepEqual(privateMission.objects, []);
  const publicMission = projectNavigationQuery("mission", {
    ...common,
    navigationDefinition: PUBLIC_NAVIGATION_DEFINITION
  });
  assert.deepEqual(publicMission.objects.map(item => item.role), ["distractor", "obstacle", "target"]);
  publicMission.objects.forEach(anchor => {
    assert.deepEqual(Object.keys(anchor), ["role", "roadId", "progressCm"]);
    assert.equal(typeof anchor.roadId, "string");
    assert.ok(Number.isFinite(anchor.progressCm) && anchor.progressCm >= 0);
  });
  assert.doesNotMatch(JSON.stringify(publicMission.objects), /(?:"x"|"z"|position|packageId|recommendedRoute)/);
});

test("recorded v3/v4 mission and task-state queries replay from the frozen task definition", () => {
  const simulationDefinition = {
    schemaVersion: "chenlong.simulation/v1",
    stepMs: 20,
    seed: 7,
    initialPose: { x: 0.5, z: 0, heading: -Math.PI / 2 },
    vehicle: { version: "chenlong.vehicle/v1", radius: 0.2, collisionSkin: 0.005, maxLinearSpeed: 2, maxAngularSpeed: 2.8 },
    world: { bounds: { minX: -2, maxX: 7, minZ: -2, maxZ: 2 }, colliders: [] }
  };
  const task = makeCompositeTask({
    checkpoints: [{ id: "checkpoint-a", position: [1, 0] }, { id: "checkpoint-b", position: [2, 0] }],
    goal: [0, 0],
    deliveries: [
      { id: "target-storage", objectRole: "target", destinationRole: "storage", destination: [3, 0], radius: 0.3, requiredPackageIds: ["target-a"] },
      { id: "distractor-cleanup", objectRole: "distractor", destinationRole: "cleanup", destination: [4, 0], radius: 0.3, requiredPackageIds: ["decoy-a"] }
    ]
  });
  const interactionDefinition = {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    packageRadius: 0.2,
    stackKeyDigits: 3,
    bounds: simulationDefinition.world.bounds,
    grab: { minForward: 0.2, maxForward: 1.2, maxLateral: 0.4 },
    release: { forwardOffset: 0.6, lateralOffset: 0, stackSnapDistance: 0.3 },
    packages: [
      { id: "target-a", x: 1.5, z: 0, stackLevel: 0, role: "target", radius: 0.2 },
      { id: "decoy-a", x: 2.5, z: 0, stackLevel: 0, role: "distractor", radius: 0.2 }
    ]
  };
  const session = new CompetitionSession({
    taskId: "mission-query-audit",
    mapId: "published-map",
    mapVersion: "revision-2",
    ruleVersion: "1",
    task,
    rules: { vehicleRadius: 0.2, roads: [{ id: "main", width: 1.5, points: [[0, 0], [5, 0]] }] },
    scoring: {}
  }, { simulationDefinition, interactionDefinition });
  session.sample({ tick: 0, x: 0.5, z: 0, heading: -Math.PI / 2, speed: 0, steering: 0 }, { forceRecord: true });
  const mission = session.addNavigationQuery("mission");
  const progress = session.addNavigationQuery("task_state");
  const releasePreview = session.addNavigationQuery("release_preview");
  assert.equal(mission.mapVersion, "revision-2");
  assert.deepEqual(mission.checkpoints.map(item => item.roadId), ["main", "main"]);
  assert.equal(progress.nextCheckpointId, "checkpoint-a");
  assert.deepEqual(releasePreview, {
    schemaVersion: RELEASE_PREVIEW_SCHEMA_VERSION,
    holding: null,
    releaseAccepted: false,
    releaseReason: "empty",
    wouldCompleteDelivery: false,
    roadClearanceCm: null,
    requiredRoadClearanceCm: null,
    tick: 0
  });
  const record = session.finish("program_finished");
  assert.deepEqual(record.inputs.filter(input => input.type === "navigation_query").map(input => input.method),
    ["mission", "task_state", "release_preview"]);
  const replay = new ReplayPlayer(record).verify();
  assert.equal(replay.ok, true, replay.diagnostics.join("\n"));

  const altered = structuredClone(record);
  altered.inputs.find(input => input.method === "mission").result.storage.progressCm += 1;
  assert.equal(new ReplayPlayer(altered).verify().ok, false,
    "a changed public anchor must fail deterministic replay instead of silently changing a route");

  const alteredPreview = structuredClone(record);
  alteredPreview.inputs.find(input => input.method === "release_preview").result.releaseAccepted = true;
  assert.equal(new ReplayPlayer(alteredPreview).verify().ok, false,
    "a changed safety-preview result must fail deterministic replay");
});

test("navigation queries are recorded and rejected when their deterministic result is altered", () => {
  const definition = {
    schemaVersion: "chenlong.simulation/v1",
    stepMs: 20,
    seed: 11,
    initialPose: { x: 0, z: 0, heading: 0 },
    vehicle: {
      version: "chenlong.vehicle/v1",
      radius: 0.2,
      collisionSkin: 0.005,
      maxLinearSpeed: 2,
      maxAngularSpeed: 2.8
    },
    world: { bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5 }, colliders: [] }
  };
  const rules = { vehicleRadius: 0.2, roads: [{ id: "road", width: 2, points: [[0, 2], [0, -4]] }] };
  const session = new CompetitionSession({
    taskId: "navigation-audit",
    mapId: "map",
    mapVersion: "1",
    ruleVersion: "1",
    task: { type: "reach", goal: [4, 4], goalRadius: 0.1 },
    rules,
    scoring: {}
  }, { simulationDefinition: definition });
  const simulator = new DeterministicSimulator(definition);
  const sample = state => session.sample({
    x: state.pose.x,
    z: state.pose.z,
    heading: state.pose.heading,
    speed: Math.abs(state.linearSpeed),
    steering: state.angularSpeed,
    tick: state.tick
  }, { forceRecord: true });
  sample(simulator.snapshot());
  assert.deepEqual(session.addNavigationQuery("odometry"), {
    forwardCm: 0, rightCm: 0, headingDeg: 0, distanceCm: 0, tick: 0
  });
  const started = simulator.startCommand({ kind: "drive", direction: 1, durationMs: 500, speedPercent: 50 });
  session.addSimulationInput(started.command, { tick: 0, startState: started.startState, source: "python" });
  while (simulator.hasActiveCommand()) {
    simulator.step();
    sample(simulator.snapshot());
  }
  const moved = session.addNavigationQuery("odometry");
  assert.equal(moved.forwardCm, 50);
  assert.equal(moved.distanceCm, 50);
  const roadState = session.addNavigationQuery("road_state");
  assert.equal(roadState.roadId, "road");
  assert.deepEqual(roadState.exits, []);
  const mapGraph = session.addNavigationQuery("map_graph");
  assert.equal(mapGraph.schemaVersion, ROAD_GRAPH_SCHEMA_VERSION);
  assert.equal(Object.prototype.hasOwnProperty.call(mapGraph, "tick"), false);
  const record = session.finish("program_finished");
  assert.equal(record.runDefinition.navigationDefinition.schemaVersion, "chenlong.navigation/v6");
  assert.equal(record.inputs.filter(input => input.type === "navigation_query").length, 4);
  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  assert.equal(replay.analysis().navigationQueriesRecomputed, true);

  const altered = structuredClone(record);
  altered.inputs.find(input => input.type === "navigation_query").result.forwardCm = 1;
  const rejected = new ReplayPlayer(altered);
  assert.equal(rejected.verify().ok, false);
  assert.equal(rejected.analysis().navigationQueriesRecomputed, false);
  assert.match(rejected.verify().diagnostics.join("\n"), /navigation query result does not match/);

  const alteredGraph = structuredClone(record);
  alteredGraph.inputs.find(input => input.type === "navigation_query" && input.method === "map_graph")
    .result.edges[0].lengthCm += 1;
  const rejectedGraph = new ReplayPlayer(alteredGraph);
  assert.equal(rejectedGraph.verify().ok, false);
  assert.equal(rejectedGraph.analysis().navigationQueriesRecomputed, false);
  assert.match(rejectedGraph.verify().diagnostics.join("\n"), /navigation query result does not match/);
});

test("navigation v1 records retain their exact road_state shape and replay behavior", () => {
  const simulationDefinition = {
    schemaVersion: "chenlong.simulation/v1",
    stepMs: 20,
    seed: 0,
    initialPose: { x: 0, z: 0, heading: 0 },
    vehicle: {
      version: "chenlong.vehicle/v1",
      radius: 0.2,
      collisionSkin: 0.005,
      maxLinearSpeed: 2,
      maxAngularSpeed: 2.8
    },
    world: { bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5 }, colliders: [] }
  };
  const rules = {
    vehicleRadius: 0.2,
    roads: [
      { id: "vertical", width: 2, points: [[0, 2], [0, -2]] },
      { id: "horizontal", width: 2, points: [[-2, 0], [2, 0]] }
    ]
  };
  const session = new CompetitionSession({
    taskId: "legacy-navigation",
    mapId: "legacy-map",
    mapVersion: "1",
    ruleVersion: "1",
    task: { type: "reach", goal: [4, 4], goalRadius: 0.1 },
    rules,
    scoring: {}
  }, {
    simulationDefinition,
    runDefinition: { navigationDefinition: LEGACY_NAVIGATION_DEFINITION }
  });
  session.sample({ tick: 0, x: 0, z: 0, heading: 0, speed: 0, steering: 0 }, { forceRecord: true });
  const roadState = session.addNavigationQuery("road_state");
  assert.equal(roadState.atJunction, true, "v1 keeps its corridor-overlap junction semantics");
  assert.equal(Object.prototype.hasOwnProperty.call(roadState, "junctionId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(roadState, "exits"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(roadState, "frontClearanceCm"), false);
  assert.throws(() => session.addNavigationQuery("map_graph"), /unsupported navigation query/);
  const record = session.finish("program_finished");
  assert.equal(record.runDefinition.navigationDefinition.schemaVersion, "chenlong.navigation/v1");
  assert.equal(Object.prototype.hasOwnProperty.call(record.runDefinition, "navigationControlDefinition"), false);
  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  assert.equal(replay.analysis().navigationQueriesRecomputed, true);
});

test("navigation front clearance is recomputed from the same-tick interaction world", () => {
  const simulationDefinition = {
    schemaVersion: "chenlong.simulation/v1",
    stepMs: 20,
    seed: 0,
    initialPose: { x: 0, z: 0, heading: 0 },
    vehicle: {
      version: "chenlong.vehicle/v1",
      radius: 0.2,
      collisionSkin: 0.005,
      maxLinearSpeed: 2,
      maxAngularSpeed: 2.8
    },
    world: { bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 }, colliders: [] }
  };
  const interactionDefinition = {
    schemaVersion: "chenlong.package-interaction/v2",
    packageRadius: 0.3,
    stackKeyDigits: 3,
    bounds: simulationDefinition.world.bounds,
    grab: { minForward: 0.38, maxForward: 1.35, maxLateral: 0.38 },
    release: { forwardOffset: 1.1, lateralOffset: 0, stackSnapDistance: 0.62 },
    packages: [{ id: "target-a", x: 0, z: -1, stackLevel: 0, role: "target", radius: 0.3 }]
  };
  const session = new CompetitionSession({
    taskId: "navigation-clearance",
    mapId: "map",
    mapVersion: "1",
    ruleVersion: "1",
    task: { type: "reach", goal: [8, 8], goalRadius: 0.1 },
    rules: { vehicleRadius: 0.2, roads: [{ id: "road", width: 2, points: [[0, 2], [0, -8]] }] },
    scoring: {}
  }, { simulationDefinition, interactionDefinition });
  session.sample({ tick: 0, x: 0, z: 0, heading: 0, speed: 0, steering: 0 }, { forceRecord: true });
  assert.equal(session.addNavigationQuery("road_state").frontClearanceCm, 50);
  assert.equal(session.addInteractionInput("package_grab", { tick: 0 }).accepted, true);
  assert.equal(session.addNavigationQuery("road_state").frontClearanceCm, null,
    "a held object must leave the forward collision world immediately");
  const record = session.finish("program_finished");
  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  assert.equal(replay.analysis().navigationQueriesRecomputed, true);

  const altered = structuredClone(record);
  altered.inputs.find(input => input.type === "navigation_query").result.frontClearanceCm = 51;
  const rejected = new ReplayPlayer(altered);
  assert.equal(rejected.verify().ok, false);
  assert.equal(rejected.analysis().navigationQueriesRecomputed, false);
});

test("navigation controls use a frozen contract and an opaque reusable topology context", () => {
  assert.equal(
    normalizeNavigationControlDefinition(LEGACY_NAVIGATION_CONTROL_DEFINITION).schemaVersion,
    "chenlong.navigation-control/v1"
  );
  assert.equal(
    normalizeNavigationControlDefinition(PREVIOUS_NAVIGATION_CONTROL_DEFINITION).schemaVersion,
    "chenlong.navigation-control/v2"
  );
  assert.equal(
    normalizeNavigationControlDefinition(NAVIGATION_CONTROL_DEFINITION).schemaVersion,
    "chenlong.navigation-control/v8"
  );
  assert.equal(
    normalizeNavigationControlDefinition(PREVIOUS_UNIT_NAVIGATION_CONTROL_DEFINITION).schemaVersion,
    "chenlong.navigation-control/v7"
  );
  assert.equal(
    normalizeNavigationControlDefinition(PREVIOUS_EXIT_SAFE_NAVIGATION_CONTROL_DEFINITION).schemaVersion,
    "chenlong.navigation-control/v6"
  );
  assert.throws(() => normalizeNavigationControlDefinition({
    ...NAVIGATION_CONTROL_DEFINITION,
    actionLimit: 301
  }), /frozen local road control contract/);
  const rules = {
    vehicleRadius: 0.2,
    roads: [{ id: "bend", width: 1.6, points: [[0, 3], [0, 0], [2, 0]] }]
  };
  const topology = createNavigationTopologyContext(rules, NAVIGATION_DEFINITION);
  assert.deepEqual(Object.keys(topology), []);
  assert.equal(JSON.stringify(topology), "{}", "the reusable topology handle must not reveal geometry");
  assert.deepEqual(
    projectNavigationQuery("map_graph", {
      rules,
      navigationDefinition: NAVIGATION_DEFINITION,
      roadTopology: topology
    }),
    projectNavigationQuery("map_graph", { rules, navigationDefinition: NAVIGATION_DEFINITION })
  );

  const simulator = new DeterministicSimulator(navigationControlSimulation());
  const runner = new NavigationActionRunner(simulator, {
    rules,
    navigationDefinition: NAVIGATION_DEFINITION,
    navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION,
    roadTopology: topology
  });
  assert.deepEqual(Object.keys(runner), [], "runner internals must remain opaque to callers");
  assert.equal(runner.topology, undefined);
  assert.throws(() => runner.run("follow_road", { maxCm: 9.9, speed: 50 }), /between 10 and 500/);
  assert.throws(() => runner.run("follow_road", { maxCm: 500.1, speed: 50 }), /between 10 and 500/);
  assert.throws(() => runner.run("follow_road", { maxCm: 10, speed: 9.9 }), /between 10 and 100/);
  assert.throws(() => runner.run("follow_road", { maxCm: 10, speed: 100.1 }), /between 10 and 100/);
  assert.throws(() => runner.run("follow_road", { maxCm: 10, speed: 50, obeySpeedLimit: "yes" }),
    /obeySpeedLimit must be boolean/);
  assert.throws(() => runner.run("take_exit", { roadId: "bend", speed: 9.9, obeySpeedLimit: true }),
    /take_exit speed must be between 10 and 100/);
  assert.throws(() => runner.run("take_exit", { roadId: "bend", speed: 50, obeySpeedLimit: "yes" }),
    /take_exit obeySpeedLimit must be boolean/);
  const result = runner.run("follow_road", { maxCm: 400, speed: 50 });
  assert.deepEqual(result, {
    accepted: true,
    stoppedBy: "max_distance",
    roadId: "bend",
    distanceCm: 400,
    elapsedTicks: result.elapsedTicks
  });
  assert.ok(result.elapsedTicks > 200, "the deterministic controller must include its local bend turn ticks");
  assert.ok(Math.abs(simulator.pose.x - 1.5) < 0.03);
  assert.ok(Math.abs(simulator.pose.z) < 0.03);
  assert.ok(Math.abs(simulator.pose.heading + Math.PI / 2) < 0.03);
  assert.equal(simulator.collisions.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /(?:\"x\"|\"z\"|points|collider|command)/);
});

test("opt-in safe follow clamps the requested road-control speed to frozen limits", () => {
  const rules = {
    vehicleRadius: 0.2,
    roads: [{ id: "slow", width: 1.6, speedLimit: 0.75, points: [[0, 3], [0, -4]] }]
  };
  const simulator = new DeterministicSimulator(navigationControlSimulation({ x: 0, z: 2.5, heading: 0 }));
  const runner = new NavigationActionRunner(simulator, {
    rules,
    navigationDefinition: NAVIGATION_DEFINITION,
    navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
  });
  const result = runner.run("follow_road", { maxCm: 100, speed: 40, obeySpeedLimit: true });
  assert.equal(result.stoppedBy, "max_distance");
  assert.equal(result.distanceCm, 100);
  assert.ok(result.elapsedTicks >= 66 && result.elapsedTicks <= 68,
    "40% requests 1.0m/s but the frozen 0.75m/s road limit must be applied");
  assert.equal(simulator.collisions.length, 0);
});

test("navigation controls have an independent 300-action record budget", () => {
  const recorder = new RunRecorder({
    simulationDefinition: navigationControlSimulation(),
    navigationDefinition: NAVIGATION_DEFINITION,
    navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
  });
  for (let index = 0; index < 300; index += 1) {
    const pending = recorder.beginNavigationControl("take_exit", { roadId: "east" }, { tick: 0 }, 0);
    recorder.finishNavigationControl(pending.seq, {
      accepted: false,
      stoppedBy: "invalid_exit",
      roadId: "east",
      distanceCm: 0,
      elapsedTicks: 0
    });
  }
  assert.throws(() => recorder.beginNavigationControl(
    "take_exit", { roadId: "east" }, { tick: 0 }, 0
  ), /300 navigation control limit/);
  assert.doesNotThrow(() => recorder.navigationQuery("odometry", {
    forwardCm: 0, rightCm: 0, headingDeg: 0, distanceCm: 0, tick: 0
  }, { tick: 0 }, 0), "navigation query and control budgets must remain independent");
});

test("follow_road stops at junctions and before forward obstacles without a collision", () => {
  const junctionSimulator = new DeterministicSimulator(navigationControlSimulation());
  const junctionResult = new NavigationActionRunner(junctionSimulator, {
    rules: navigationCrossRules(),
    navigationDefinition: NAVIGATION_DEFINITION,
    navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
  }).run("follow_road", { maxCm: 500, speed: 100 });
  assert.equal(junctionResult.accepted, true);
  assert.equal(junctionResult.stoppedBy, "junction");
  assert.equal(junctionResult.distanceCm, 125);
  assert.ok(Math.abs(junctionSimulator.pose.z - 1.25) < 0.001);

  const obstacleRules = {
    vehicleRadius: 0.2,
    roads: [{ id: "straight", width: 1.6, points: [[0, 3], [0, -4]] }]
  };
  const obstacleSimulator = new DeterministicSimulator(navigationControlSimulation(
    { x: 0, z: 2.5, heading: 0 },
    [{ id: "hidden-obstacle", type: "circle", x: 0, z: 1.5, radius: 0.2 }]
  ));
  const obstacleResult = new NavigationActionRunner(obstacleSimulator, {
    rules: obstacleRules,
    navigationDefinition: NAVIGATION_DEFINITION,
    navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
  }).run("follow_road", { maxCm: 500, speed: 100 });
  assert.equal(obstacleResult.accepted, true);
  assert.equal(obstacleResult.stoppedBy, "front_clearance");
  assert.ok(obstacleResult.distanceCm > 0 && obstacleResult.distanceCm < 60);
  assert.equal(obstacleSimulator.collisions.length, 0);
  assert.equal(JSON.stringify(obstacleResult).includes("hidden-obstacle"), false);
});

test("take_exit rejects absent and one-way-inbound exits, then enters only the named local road", () => {
  const rules = navigationCrossRules();
  assert.throws(() => new NavigationActionRunner(
    new DeterministicSimulator(navigationControlSimulation()), {
      rules,
      navigationDefinition: NAVIGATION_DEFINITION,
      navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
    }
  ).run("take_exit", { roadId: "east\nforged" }), /printable characters/);
  const awaySimulator = new DeterministicSimulator(navigationControlSimulation());
  const away = new NavigationActionRunner(awaySimulator, {
    rules,
    navigationDefinition: NAVIGATION_DEFINITION,
    navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
  }).run("take_exit", { roadId: "north" });
  assert.deepEqual(away, {
    accepted: false,
    stoppedBy: "invalid_exit",
    roadId: "north",
    distanceCm: 0,
    elapsedTicks: 0
  });

  const leafSimulator = new DeterministicSimulator(navigationControlSimulation({ x: 0, z: 0.5, heading: 0 }));
  const leafRunner = new NavigationActionRunner(leafSimulator, {
    rules: { vehicleRadius: 0.2, roads: [{ id: "leaf", width: 1.6, points: [[0, 3], [0, 0]] }] },
    navigationDefinition: NAVIGATION_DEFINITION,
    navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
  });
  assert.deepEqual(leafRunner.roadState().exits, [{ roadId: "leaf", direction: "back", turnDeg: -180 }]);
  const leafTurn = leafRunner.run("take_exit", { roadId: "leaf" });
  assert.equal(leafTurn.accepted, true, "a two-degree-free leaf still exposes a student-selected U-turn");
  assert.equal(leafTurn.stoppedBy, "entered_road");
  assert.equal(leafTurn.roadId, "leaf");
  assert.ok(leafSimulator.pose.z > 0.24 && leafSimulator.pose.z < 0.27);

  const simulator = new DeterministicSimulator(navigationControlSimulation({ x: 0, z: 0.5, heading: 0 }));
  const runner = new NavigationActionRunner(simulator, {
    rules,
    navigationDefinition: NAVIGATION_DEFINITION,
    navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
  });
  const inbound = runner.run("take_exit", { roadId: "inbound" });
  assert.equal(inbound.accepted, false);
  assert.equal(inbound.stoppedBy, "invalid_exit");
  assert.equal(inbound.distanceCm, 0);
  assert.equal(inbound.elapsedTicks, 0);
  const missing = runner.run("take_exit", { roadId: "missing" });
  assert.equal(missing.accepted, false);
  assert.equal(missing.stoppedBy, "invalid_exit");
  const east = runner.run("take_exit", { roadId: "east" });
  assert.equal(east.accepted, true);
  assert.equal(east.stoppedBy, "entered_road");
  assert.equal(east.roadId, "east");
  assert.ok(Math.abs(east.distanceCm - 75) < 0.2);
  assert.ok(simulator.pose.x > 0.24);
  assert.ok(Math.abs(simulator.pose.z) < 0.01);
  assert.ok(Math.abs(simulator.pose.heading + Math.PI / 2) < 0.03,
    "a right exit must produce the same negative heading convention as road_state.turnDeg");
  assert.equal(simulator.collisions.length, 0);
});

test("direction-aware junction projection keeps short Guangyang connectors traversable", () => {
  const road = GUANGYANG_ISLAND_CONFIG.roads.find(candidate => candidate.id === "camp-connector");
  const [a, b] = road.points;
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const tangent = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  const initialPose = {
    x: a[0] + tangent[0] * 0.25,
    z: a[1] + tangent[1] * 0.25,
    heading: Math.atan2(-tangent[0], -tangent[1])
  };
  const simulator = new DeterministicSimulator({
    ...navigationControlSimulation(initialPose),
    vehicle: {
      version: "chenlong.vehicle/v1",
      radius: 0.44,
      collisionSkin: 0.005,
      maxLinearSpeed: 2,
      maxAngularSpeed: Math.PI
    },
    world: { bounds: { minX: -20, maxX: 20, minZ: -12, maxZ: 12 }, colliders: [] }
  });
  const runner = new NavigationActionRunner(simulator, {
    rules: GUANGYANG_ISLAND_CONFIG.rules,
    navigationDefinition: NAVIGATION_DEFINITION,
    navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
  });
  const followed = runner.run("follow_road", { maxCm: 500, speed: 100 });
  assert.deepEqual(followed, {
    accepted: true,
    stoppedBy: "junction",
    roadId: "camp-connector",
    distanceCm: 21.1,
    elapsedTicks: 55
  });
  const state = runner.roadState();
  assert.equal(state.junctionId, "node:camp-connector:end",
    "overlapping junction radii must prefer the endpoint ahead of the vehicle");
  assert.deepEqual(state.exits.map(exit => exit.roadId).sort(), [
    "camp-connector", "east-outer-south", "southeast-spur"
  ]);
});

test("v8 road following reaches the selected endpoint on an overlapping short edge", () => {
  const rules = {
    vehicleRadius: 0.2,
    roads: [
      { id: "short", width: 1.6, points: [[0, 0], [0, -2.51]] },
      { id: "start-exit", width: 1.6, points: [[0, 0], [2, 0]] },
      { id: "end-exit", width: 1.6, points: [[0, -2.51], [-2, -2.51]] }
    ]
  };
  const options = {
    rules,
    navigationDefinition: NAVIGATION_DEFINITION,
    navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
  };
  const simulator = new DeterministicSimulator(navigationControlSimulation({ x: 0, z: -0.25, heading: 0 }));
  const runner = new NavigationActionRunner(simulator, options);
  const result = runner.run("follow_road", { maxCm: 500, speed: 100, obeySpeedLimit: true });
  assert.equal(result.accepted, true);
  assert.equal(result.stoppedBy, "junction");
  assert.ok(Math.abs(result.distanceCm - 226) < 0.2);
  const state = runner.roadState();
  assert.deepEqual(state.exits.map(exit => exit.roadId).sort(), ["end-exit", "short"]);
  assert.ok(state.nodeId && state.nodeId !== "node:short:start",
    "the endpoint identity must be the far node, not the entry-side node");

  const legacySimulator = new DeterministicSimulator(navigationControlSimulation({ x: 0, z: -0.25, heading: 0 }));
  const legacyResult = new NavigationActionRunner(legacySimulator, {
    ...options,
    navigationDefinition: PREVIOUS_CURRENT_NAVIGATION_DEFINITION,
    navigationControlDefinition: PREVIOUS_EXIT_SAFE_NAVIGATION_CONTROL_DEFINITION
  }).run("follow_road", { maxCm: 500, speed: 100, obeySpeedLimit: true });
  assert.equal(legacyResult.stoppedBy, "junction");
  assert.ok(legacyResult.distanceCm < result.distanceCm - 100,
    "v6 must retain its old junction-approach replay behaviour");
});

test("take_exit never reverses back to a departed one-way start junction", () => {
  const rules = {
    vehicleRadius: 0.2,
    roads: [
      { id: "out", width: 1.6, oneWay: true, points: [[0, 0], [0, -2]] },
      { id: "west", width: 1.6, points: [[0, 0], [-2, 0]] },
      { id: "east", width: 1.6, points: [[0, 0], [2, 0]] }
    ]
  };
  const simulator = new DeterministicSimulator(navigationControlSimulation({ x: 0, z: -0.5, heading: 0 }));
  const runner = new NavigationActionRunner(simulator, {
    rules,
    navigationDefinition: NAVIGATION_DEFINITION,
    navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
  });
  assert.equal(runner.roadState().atJunction, true);
  const result = runner.run("take_exit", { roadId: "west" });
  assert.deepEqual(result, {
    accepted: false,
    stoppedBy: "wrong_way",
    roadId: "west",
    distanceCm: 0,
    elapsedTicks: 0
  });
  assert.deepEqual(simulator.pose, { x: 0, z: -0.5, heading: 0 });

  const inboundRules = {
    vehicleRadius: 0.2,
    roads: [
      { id: "in", width: 1.6, oneWay: true, points: [[0, 2], [0, 0]] },
      { id: "west", width: 1.6, points: [[0, 0], [-2, 0]] },
      { id: "east", width: 1.6, points: [[0, 0], [2, 0]] }
    ]
  };
  const inboundSimulator = new DeterministicSimulator(navigationControlSimulation({ x: 0, z: 0.5, heading: 0 }));
  const inbound = new NavigationActionRunner(inboundSimulator, {
    rules: inboundRules,
    navigationDefinition: NAVIGATION_DEFINITION,
    navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
  }).run("take_exit", { roadId: "west" });
  assert.equal(inbound.accepted, true, "arriving at a one-way end may take a legal adjacent exit");
  assert.equal(inbound.stoppedBy, "entered_road");
  assert.ok(inboundSimulator.pose.x < -0.24);
});

test("a navigation_control is one high-level input and ReplayPlayer independently expands and audits it", () => {
  const simulationDefinition = navigationControlSimulation();
  const rules = navigationCrossRules();
  const config = {
    taskId: "navigation-control-audit",
    mapId: "map",
    mapVersion: "1",
    ruleVersion: "1",
    task: { type: "reach", goal: [8, 8], goalRadius: 0.1 },
    rules,
    scoring: {}
  };
  const runDefinition = {
    simulationDefinition,
    navigationDefinition: NAVIGATION_DEFINITION,
    navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
  };
  const session = new CompetitionSession(config, { simulationDefinition, runDefinition });
  const simulator = new DeterministicSimulator(simulationDefinition);
  session.sample({ tick: 0, x: 0, z: 2.5, heading: 0, speed: 0, steering: 0 }, { forceRecord: true });
  const observedFrames = [];
  const observedJudgements = [];
  const result = session.runNavigationControl(simulator, "follow_road", { maxCm: 50, speed: 50 }, {
    onStep(frame) {
      observedFrames.push(frame);
      frame.x = 999;
      return false;
    },
    onJudgement(summary) {
      observedJudgements.push(summary);
      summary.score.score = 999;
      summary.taskEvents.push({ type: "forged" });
      return false;
    }
  });
  assert.deepEqual(result, {
    accepted: true,
    stoppedBy: "max_distance",
    roadId: "south",
    distanceCm: 50,
    elapsedTicks: 25
  });
  assert.equal(observedFrames.length, 25);
  assert.equal(observedJudgements.length, 1);
  assert.deepEqual(Object.keys(observedJudgements[0]).sort(),
    ["score", "status", "taskEvents", "taskState", "violations"]);
  assert.equal(observedJudgements[0].status, "running");
  assert.notEqual(simulator.pose.x, 999,
    "a rendering observer receives clones and its return value cannot alter the action");
  const record = session.finish("program_finished");
  assert.notEqual(record.result.score, 999,
    "a judgement observer receives a clone and cannot alter the authoritative score");
  assert.equal(record.events.some(event => event.type === "forged"), false);
  const controls = record.inputs.filter(input => input.type === "navigation_control");
  assert.equal(controls.length, 1);
  assert.equal(record.inputs.some(input => input.type === "control"), false,
    "internal steering and drive ticks must not be accepted as client-authored controls");
  assert.deepEqual(Object.keys(controls[0]).sort(), ["args", "method", "result", "seq", "t", "tick", "type"]);
  assert.doesNotMatch(JSON.stringify(controls[0]), /startState|endState|pose|\"x\"|\"z\"|command/);
  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  assert.equal(replay.analysis().navigationControlsRecomputed, true);
  assert.deepEqual(replay.simulator.compactSnapshot(), simulator.compactSnapshot());

  const alteredResult = structuredClone(record);
  alteredResult.inputs.find(input => input.type === "navigation_control").result.distanceCm += 1;
  const rejectedResult = new ReplayPlayer(alteredResult);
  assert.equal(rejectedResult.verify().ok, false);
  assert.equal(rejectedResult.analysis().navigationControlsRecomputed, false);
  assert.match(rejectedResult.verify().diagnostics.join("\n"), /navigation control result does not match/);

  const alteredExit = structuredClone(record);
  const action = alteredExit.inputs.find(input => input.type === "navigation_control");
  action.args.maxCm = 60;
  const rejectedAction = new ReplayPlayer(alteredExit);
  assert.equal(rejectedAction.verify().ok, false);
  assert.match(rejectedAction.verify().diagnostics.join("\n"), /invalid start tick|simulationEndTick|telemetry|result does not match/);

  const forgedState = structuredClone(record);
  forgedState.inputs.find(input => input.type === "navigation_control").startState = { pose: { x: 999, z: 999 } };
  const rejectedState = new ReplayPlayer(forgedState);
  assert.equal(rejectedState.verify().ok, false);
  assert.match(rejectedState.verify().diagnostics.join("\n"), /unsupported fields/);
});

test("a completing navigation control publishes one post-action judgement without changing its fixed result", () => {
  const simulationDefinition = navigationControlSimulation();
  const rules = navigationCrossRules();
  const session = new CompetitionSession({
    taskId: "navigation-control-completion",
    mapId: "map",
    mapVersion: "1",
    ruleVersion: "1",
    task: { type: "reach", goal: [0, 2], goalRadius: 0.06 },
    rules,
    scoring: {}
  }, {
    simulationDefinition,
    runDefinition: {
      simulationDefinition,
      navigationDefinition: NAVIGATION_DEFINITION,
      navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
    }
  });
  const simulator = new DeterministicSimulator(simulationDefinition);
  session.sample({ tick: 0, x: 0, z: 2.5, heading: 0, speed: 0, steering: 0 }, { forceRecord: true });
  let judgement = null;
  const result = session.runNavigationControl(simulator, "follow_road", { maxCm: 50, speed: 50 }, {
    onJudgement(summary) { judgement = summary; }
  });
  assert.equal(result.stoppedBy, "max_distance");
  assert.equal(session.status, "completed");
  assert.equal(judgement?.status, "completed");
  assert.equal(judgement?.taskState?.finished, true);
  assert.equal(judgement?.score?.reason, "completed");
  assert.equal(judgement?.taskEvents?.filter(event => event.type === "task_completed").length, 1);
  const record = session.finalRecord;
  assert.equal(record.inputs.filter(input => input.type === "navigation_control").length, 1);
  assert.equal(record.inputs.some(input => input.type === "control"), false);
  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
});

test("stopping a road control between 100ms sample boundaries seals its terminal tick", () => {
  const simulationDefinition = navigationControlSimulation();
  const session = new CompetitionSession({
    taskId: "navigation-control-terminal-sample",
    mapId: "map",
    mapVersion: "1",
    ruleVersion: "1",
    task: { type: "reach", goal: [0, -2], goalRadius: 0.01 },
    rules: navigationCrossRules(),
    scoring: {}
  }, {
    simulationDefinition,
    runDefinition: {
      simulationDefinition,
      navigationDefinition: NAVIGATION_DEFINITION,
      navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
    }
  });
  const simulator = new DeterministicSimulator(simulationDefinition);
  session.sample({ tick: 0, x: 0, z: 2.5, heading: 0, speed: 0, steering: 0 }, { forceRecord: true });
  const action = session.runNavigationControl(simulator, "follow_road", { maxCm: 46, speed: 50 });
  assert.equal(action.elapsedTicks, 23);

  const record = session.finish("stopped");
  const terminalSamples = record.samples.filter(sample => sample.tick === 23);
  const runEnd = record.inputs.find(input => input.type === "run_end");
  assert.equal(record.simulationEndTick, 23);
  assert.equal(terminalSamples.length, 1);
  assert.ok(terminalSamples[0].seq < runEnd.seq);
  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  assert.deepEqual(replay.analysis().recomputedResult, record.result);
});

test("navigation control stops and records before judging the exact timeout boundary", () => {
  const simulationDefinition = navigationControlSimulation();
  simulationDefinition.vehicle.maxLinearSpeed = 1;
  const rules = { vehicleRadius: 0.2, roads: [{ id: "road", width: 1.6, points: [[0, 3], [0, -3]] }] };
  const session = new CompetitionSession({
    taskId: "navigation-timeout",
    mapId: "map",
    mapVersion: "1",
    ruleVersion: "1",
    timeLimitSeconds: 0.1,
    task: { type: "reach", goal: [0, 2.4], goalRadius: 0.01 },
    rules,
    scoring: {}
  }, {
    simulationDefinition,
    runDefinition: {
      simulationDefinition,
      navigationDefinition: NAVIGATION_DEFINITION,
      navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
    }
  });
  const simulator = new DeterministicSimulator(simulationDefinition);
  session.sample({ tick: 0, x: 0, z: 2.5, heading: 0, speed: 0, steering: 0 }, { forceRecord: true });
  const actionResult = session.runNavigationControl(simulator, "follow_road", { maxCm: 10, speed: 100 });
  assert.deepEqual(actionResult, {
    accepted: true,
    stoppedBy: "time_limit",
    roadId: "road",
    distanceCm: 10,
    elapsedTicks: 5
  });
  assert.equal(session.status, "timeout");
  assert.equal(session.task.finished, false, "a goal first reached at the timeout tick cannot complete the task");
  const record = session.finalRecord;
  const control = record.inputs.find(input => input.type === "navigation_control");
  const terminalSample = record.samples.find(sample => sample.tick === 5);
  const runEnd = record.inputs.find(input => input.type === "run_end");
  assert.ok(control.seq < terminalSample.seq && terminalSample.seq < runEnd.seq,
    "the high-level input, terminal sample, and run_end retain their actual ledger order");
  const replay = new ReplayPlayer(record);
  assert.equal(replay.verify().ok, true, replay.verify().diagnostics.join("\n"));
  assert.deepEqual(replay.analysis().recomputedResult, record.result);
});

test("Guangyang map uses the supplied 5m by 3m PNG coordinate system", () => {
  const source = GUANGYANG_ISLAND_CONFIG.world.sourceImage;
  assert.equal(source.path, "./word/广阳岛仿真沙盘地图.png");
  assert.equal(source.physicalWidthMeters, 5);
  assert.equal(source.physicalHeightMeters, 3);
  assert.equal(source.unitsPerMeter, 8);
  assert.deepEqual(source.bakedVehiclePatch.target, { x: 687, y: 207, width: 80, height: 56 });
  assert.deepEqual(geometry.sourcePixelToWorld([26, 24], source), [-20, -12]);
  assert.deepEqual(geometry.sourcePixelToWorld([1321, 801], source), [20, 12]);
  assert.equal(GUANGYANG_ISLAND_CONFIG.trafficLights.length, 0, "the source image contains no traffic light");
  assert.equal(GUANGYANG_ISLAND_CONFIG.obstacles.length, 0, "do not invent roadworks absent from the source image");
});

test("Guangyang navigation exposes true centimetres while retaining eight simulation units per metre", () => {
  const rules = GUANGYANG_ISLAND_CONFIG.rules;
  assert.equal(rules.unitsPerMeter, 8);
  assert.equal(GUANGYANG_ISLAND_CONFIG.world.width / rules.unitsPerMeter * 100, 500);
  assert.equal(GUANGYANG_ISLAND_CONFIG.world.depth / rules.unitsPerMeter * 100, 300);

  const initialPose = { x: 0, z: 0, heading: 0 };
  assert.deepEqual(projectNavigationQuery("odometry", {
    pose: { x: 8, z: -8, heading: 0 },
    initialPose,
    distance: 16,
    tick: 10,
    rules,
    navigationDefinition: NAVIGATION_DEFINITION
  }), {
    forwardCm: 100,
    rightCm: 100,
    headingDeg: 0,
    distanceCm: 200,
    tick: 10
  });

  const graph = projectNavigationQuery("map_graph", {
    rules,
    navigationDefinition: NAVIGATION_DEFINITION
  });
  const road = GUANGYANG_ISLAND_CONFIG.roads.find(item => item.id === "parking-connector");
  const expectedCm = road.points.slice(1).reduce((sum, point, index) => (
    sum + Math.hypot(point[0] - road.points[index][0], point[1] - road.points[index][1])
  ), 0) * 12.5;
  assert.equal(graph.edges.find(item => item.roadId === road.id).lengthCm,
    Math.round(expectedCm * 10) / 10);
});

test("current Guangyang exit control enters the selected road by physical centimetres", () => {
  const [x, z, heading] = GUANGYANG_ISLAND_CONFIG.start;
  const simulator = new DeterministicSimulator({
    schemaVersion: "chenlong.simulation/v1",
    stepMs: 20,
    seed: 31,
    initialPose: { x, z, heading },
    vehicle: {
      version: "chenlong.vehicle/v1",
      radius: GUANGYANG_ISLAND_CONFIG.rules.vehicleRadius,
      collisionSkin: 0.005,
      maxLinearSpeed: 2.5,
      maxAngularSpeed: 2.8
    },
    world: { bounds: { minX: -30, maxX: 30, minZ: -20, maxZ: 20 }, colliders: [] }
  });
  const runner = new NavigationActionRunner(simulator, {
    rules: GUANGYANG_ISLAND_CONFIG.rules,
    navigationDefinition: NAVIGATION_DEFINITION,
    navigationControlDefinition: NAVIGATION_CONTROL_DEFINITION
  });

  const parking = runner.run("follow_road", { maxCm: 500, speed: 100, obeySpeedLimit: true });
  assert.equal(parking.stoppedBy, "junction");
  assert.equal(runner.roadState().nodeId, "node:central-north:start");
  const entered = runner.run("take_exit", {
    roadId: "central-north", speed: 100, obeySpeedLimit: true
  });
  assert.equal(entered.accepted, true);
  assert.ok(entered.distanceCm >= 24.9,
    "take_exit must use the documented 25 physical centimetres, not 0.25 internal units");
  assert.equal(runner.roadState().roadId, "central-north",
    "road_state must select the road that take_exit just entered");
  const crossed = runner.run("follow_road", { maxCm: 500, speed: 100, obeySpeedLimit: true });
  assert.equal(crossed.stoppedBy, "junction");
  assert.equal(runner.roadState().nodeId, "node:central-north:end");
});

test("Guangyang composite task binds role-correct objects and accepts any safely cleared off-road release", () => {
  const overlay = GUANGYANG_ISLAND_CONFIG.objectTaskOverlay;
  assert.equal(overlay.schemaVersion, "chenlong.object-task-overlay/v2");
  assert.equal(GUANGYANG_ISLAND_CONFIG.task.type, "composite");
  assert.equal(GUANGYANG_ISLAND_CONFIG.task.schemaVersion, ROAD_CLEARANCE_TASK_SCHEMA_VERSION);
  assert.deepEqual(overlay.objects.map(item => item.role), ["target", "distractor", "obstacle"]);
  assert.deepEqual(overlay.zones.map(item => item.role), ["storage"]);

  [...overlay.objects, overlay.zones.find(item => item.role === "storage")].forEach(item => {
    assert.deepEqual(item.position, geometry.sourcePixelToWorld(item.sourcePosition));
    assert.equal(geometry.nearestRoad(item.position, GUANGYANG_ISLAND_CONFIG.roads, 0.44).onRoad, true,
      `${item.id} should stay on the authoritative road network`);
  });

  const byId = new Map(overlay.objects.map(item => [item.id, item]));
  const zoneByRole = new Map(overlay.zones.map(item => [item.role, item]));
  assert.equal(byId.get("guangyang-obstacle-1").radius, 0.52);
  assert.deepEqual(GUANGYANG_ISLAND_CONFIG.task.deliveries.map(item => item.id), [
    "delivery-target-storage",
    "delivery-distractor-offroad-removal"
  ]);
  const targetDelivery = GUANGYANG_ISLAND_CONFIG.task.deliveries
    .find(item => item.objectRole === "target");
  const target = byId.get(targetDelivery.requiredPackageIds[0]);
  assert.equal(target.role, "target");
  assert.deepEqual(targetDelivery.destination, zoneByRole.get("storage").position);
  assert.ok(Math.hypot(target.position[0] - targetDelivery.destination[0], target.position[1] - targetDelivery.destination[1])
    > targetDelivery.radius, `${targetDelivery.id} must not begin completed`);

  const distractorDelivery = GUANGYANG_ISLAND_CONFIG.task.deliveries
    .find(item => item.objectRole === "distractor");
  assert.equal(byId.get(distractorDelivery.requiredPackageIds[0]).role, "distractor");
  assert.equal(distractorDelivery.placementRule, "road-edge-clearance");
  assert.equal(distractorDelivery.objectRadius, overlay.packageRadius);
  assert.equal(Object.prototype.hasOwnProperty.call(distractorDelivery, "destination"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(distractorDelivery, "radius"), false);
  assert.deepEqual(
    GUANGYANG_ISLAND_CONFIG.task.placementGeometry.roads,
    GUANGYANG_ISLAND_CONFIG.roads.map(road => ({ id: road.id, width: road.width, points: road.points }))
  );
  const safeReleasePoints = [[450, 610], [450, 650]].map(point => geometry.sourcePixelToWorld(point));
  safeReleasePoints.forEach(point => {
    const clearance = geometry.roadBoundaryClearance(point, GUANGYANG_ISLAND_CONFIG.roads,
      distractorDelivery.objectRadius);
    assert.ok(clearance.clearance + 1e-9 >= distractorDelivery.minimumRoadEdgeClearance);
  });
  assert.ok(Math.hypot(
    safeReleasePoints[0][0] - safeReleasePoints[1][0],
    safeReleasePoints[0][1] - safeReleasePoints[1][1]
  ) > 1, "two separated off-road positions must satisfy the same placement rule");
});

test("geometry classifies polygon and road corridor points", () => {
  assert.equal(geometry.pointInPolygon([1, 1], [[0, 0], [2, 0], [2, 2], [0, 2]]), true);
  assert.equal(geometry.pointInPolygon([2, 1], [[0, 0], [2, 0], [2, 2], [0, 2]]), true);
  assert.equal(geometry.pointInPolygon([3, 1], [[0, 0], [2, 0], [2, 2], [0, 2]]), false);

  const road = { id: "road-a", width: 2, points: [[0, 0], [10, 0]] };
  assert.equal(geometry.nearestRoad([5, 0.4], [road], 0.2).onRoad, true);
  assert.equal(geometry.nearestRoad([5, 0.9], [road], 0.2).onRoad, false);
  assert.equal(geometry.roadBoundaryClearance([5, 1.3], [road], 0.2).outsideRoads, true);
  assert.ok(Math.abs(geometry.roadBoundaryClearance([5, 1.3], [road], 0.2).clearance - 0.1) < 1e-9);
  assert.equal(geometry.roadBoundaryClearance([5, 1.1], [road], 0.2).outsideRoads, false);
});

test("road matching prefers a containing corridor over a closer non-containing centerline", () => {
  const narrow = { id: "narrow", width: 1, points: [[-2, 0], [2, 0]] };
  const wide = { id: "wide", width: 4, points: [[-2, 1.3], [2, 1.3]] };
  const match = geometry.nearestRoad([0, 0.6], [narrow, wide]);
  assert.equal(match.onRoad, true);
  assert.equal(match.road.id, "wide");
  assert.deepEqual(match.onRoadMatches.map(item => item.road.id), ["wide"]);
});

test("rule engine emits one violation per continuous off-road or speeding episode", () => {
  const engine = new RuleEngine({
    vehicleRadius: 0.2,
    roads: [{ id: "road-a", width: 2, speedLimit: 1, points: [[0, 0], [10, 0]] }]
  });

  let result = engine.evaluate({ x: 5, z: 2, heading: -Math.PI / 2, speed: 0 }, null, 0);
  assert.deepEqual(result.violations.map(item => item.type), ["off_road"]);
  result = engine.evaluate({ x: 5.2, z: 2, heading: -Math.PI / 2, speed: 0 }, null, 100);
  assert.equal(result.violations.length, 0);
  engine.evaluate({ x: 5, z: 0, heading: -Math.PI / 2, speed: 0 }, null, 200);
  result = engine.evaluate({ x: 5, z: 2, heading: -Math.PI / 2, speed: 0 }, null, 300);
  assert.deepEqual(result.violations.map(item => item.type), ["off_road"]);

  result = engine.evaluate({ x: 5, z: 0, heading: -Math.PI / 2, speed: 1.2 }, null, 400);
  assert.deepEqual(result.violations.map(item => item.type), ["speeding"]);
  result = engine.evaluate({ x: 5.1, z: 0, heading: -Math.PI / 2, speed: 1.2 }, null, 500);
  assert.equal(result.violations.length, 0);
});

test("all three current Guangyang tasks only retain off-road and collision rule deductions", () => {
  for (const config of GUANGYANG_CHALLENGE_CONFIGS) {
    assert.equal(config.rules.speedingEnabled, false);
    assert.equal(config.rules.wrongWayEnabled, false);
    assert.equal(config.rules.redLightEnabled, false);
    assert.equal(config.rules.prohibitedZonesEnabled, false);
    for (const type of ["speeding", "wrong_way", "red_light", "prohibited_zone"]) {
      assert.equal(config.scoring.penalties[type], 0);
    }
    for (const type of ["speeding", "wrong_way", "prohibited_zone"]) {
      assert.equal(config.scoring.continuousPenalties[type].perSecond, 0);
    }
    const engine = new RuleEngine({
      vehicleRadius: 0.2,
      speedingEnabled: false,
      wrongWayEnabled: false,
      redLightEnabled: false,
      prohibitedZonesEnabled: false,
      roads: [{ id: "road-a", width: 2, speedLimit: 1, oneWay: true, points: [[0, 0], [10, 0]] }],
      trafficLights: [{
        id: "light-a",
        stopLine: [[2, -1], [2, 1]],
        direction: [-1, 0],
        phase: { greenMs: 0, yellowMs: 0, redMs: 10, offsetMs: 0 }
      }],
      prohibitedZones: [{ id: "zone-a", center: [1.8, 0], radius: 0.5 }]
    });
    const result = engine.evaluate(
      { x: 1.8, z: 0, heading: -Math.PI / 2, speed: 2 },
      { x: 2.2, z: 0, heading: -Math.PI / 2, speed: 2 },
      0
    );
    assert.equal(result.violations.some(item => ["speeding", "wrong_way", "red_light", "prohibited_zone"].includes(item.type)), false);
  }
});

test("red-light crossing is detected only in the configured travel direction", () => {
  const light = {
    id: "light-a",
    stopLine: [[0, -1], [0, 1]],
    direction: [1, 0],
    phase: { greenMs: 10, yellowMs: 1, redMs: 10, offsetMs: 12 }
  };
  assert.equal(trafficLightState(light, 0), "red");
  const engine = new RuleEngine({
    vehicleRadius: 0.1,
    roads: [{ id: "road-a", width: 2, points: [[-2, 0], [2, 0]] }],
    trafficLights: [light]
  });
  const previous = { x: -0.2, z: 0, heading: -Math.PI / 2, speed: 0.5 };
  const current = { x: 0.2, z: 0, heading: -Math.PI / 2, speed: 0.5 };
  assert.equal(engine.evaluate(current, previous, 0).violations.some(item => item.type === "red_light"), true);
  const justPastLine = { x: 0.3, z: 0, heading: -Math.PI / 2, speed: 0.5 };
  assert.equal(engine.evaluate(justPastLine, current, 0).violations.some(item => item.type === "red_light"), false);
  assert.equal(engine.evaluate(previous, current, 0).violations.some(item => item.type === "red_light"), false);
});

test("red-light state uses the interpolated crossing time and does not punish leaving a line after green", () => {
  const light = {
    id: "phase-boundary",
    stopLine: [[0, -1], [0, 1]],
    direction: [1, 0],
    phase: { greenMs: 10, yellowMs: 0, redMs: 10, offsetMs: 0 }
  };
  assert.equal(trafficLightState(light, 10), "red", "yellowMs=0 must remain valid");
  const engine = new RuleEngine({
    vehicleRadius: 0.1,
    roads: [{ id: "road-a", width: 2, points: [[-2, 0], [2, 0]] }],
    trafficLights: [light]
  });
  engine.evaluate({ x: -0.2, z: 0, heading: -Math.PI / 2, speed: 0.5 }, null, 0);
  assert.equal(engine.evaluate({ x: 0, z: 0, heading: -Math.PI / 2, speed: 0.5 }, null, 5).violations.length, 0);
  assert.equal(engine.evaluate({ x: 0.2, z: 0, heading: -Math.PI / 2, speed: 0.5 }, null, 15).violations.some(item => item.type === "red_light"), false);

  const directEngine = new RuleEngine({
    vehicleRadius: 0.1,
    roads: [{ id: "road-a", width: 2, points: [[-2, 0], [2, 0]] }],
    trafficLights: [light]
  });
  directEngine.evaluate({ x: -0.2, z: 0, heading: -Math.PI / 2, speed: 0.5 }, null, 8);
  const direct = directEngine.evaluate({ x: 0.2, z: 0, heading: -Math.PI / 2, speed: 0.5 }, null, 16);
  assert.equal(direct.violations.some(item => item.type === "red_light"), true);
  assert.equal(direct.violations.find(item => item.type === "red_light").crossingMs, 12);
});

test("one-way rule uses actual travel direction, including reverse driving", () => {
  const engine = new RuleEngine({
    vehicleRadius: 0.1,
    roads: [{ id: "one-way", width: 2, oneWay: true, points: [[0, 0], [10, 0]] }]
  });
  const previous = { x: 2, z: 0, heading: -Math.PI / 2, speed: 0.5 };
  const reversing = { x: 1.8, z: 0, heading: -Math.PI / 2, speed: 0.5 };
  assert.equal(engine.evaluate(reversing, previous, 0).violations.some(item => item.type === "wrong_way"), true);
});

test("the formal Guangyang judge uses one explicit 40/25/15/20, 100-point contract", () => {
  assert.deepEqual(GUANGYANG_ISLAND_CONFIG.scoring.weights, {
    task: 40,
    rules: 25,
    autonomous: 15,
    efficiency: 20
  });
  const result = new CompetitionJudge(GUANGYANG_ISLAND_CONFIG.scoring).score({
    task: { completed: 8, total: 8, finished: true },
    durationSeconds: 0,
    manualInterventions: 0
  });
  assert.equal(result.score, 100);
});

test("judge preserves the historical default score caps for records without explicit weights", () => {
  const judge = new CompetitionJudge({
    penalties: { red_light: 3 },
    efficiency: { targetSeconds: 100, maxSeconds: 200 }
  });
  const result = judge.score({
    task: { completed: 4, total: 4, finished: true },
    violations: [{ type: "red_light" }],
    durationSeconds: 150,
    manualInterventions: 0
  });
  assert.equal(result.taskScore, 25);
  assert.equal(result.ruleScore, 12);
  assert.equal(result.autonomousScore, 10);
  assert.equal(result.efficiencyScore, 5);
  assert.equal(result.score, 52);
});

test("judge rejects impossible task states and incomplete runs cannot earn efficiency", () => {
  const judge = new CompetitionJudge();
  const empty = judge.score({ task: { completed: 0, total: 0, finished: true }, durationSeconds: 0 });
  assert.equal(empty.taskValid, false);
  assert.equal(empty.score, 0);

  const incomplete = judge.score({ task: { completed: 3, total: 4, finished: true }, durationSeconds: 1 });
  assert.equal(incomplete.taskFinished, false);
  assert.equal(incomplete.taskScore, 18.8);
  assert.equal(incomplete.efficiencyScore, 0);
});

test("continuous violations keep one log event but accrue larger duration deductions", () => {
  const makeMetrics = durationMs => ({ off_road: { episodes: 1, durationMs, maxSeverity: 1 } });
  const judge = new CompetitionJudge();
  const base = {
    task: { completed: 0, total: 1, finished: false },
    violations: [{ type: "off_road" }],
    durationSeconds: 60
  };
  const short = judge.score({ ...base, violationMetrics: makeMetrics(1000) });
  const long = judge.score({ ...base, violationMetrics: makeMetrics(60000) });
  assert.equal(short.eventDeduction, long.eventDeduction);
  assert.ok(long.durationDeduction > short.durationDeduction);
  assert.ok(long.ruleScore < short.ruleScore);
});

test("competition session keeps a 100ms baseline plus changed-state keyframes", () => {
  let now = 0;
  const session = new CompetitionSession({
    taskId: "task-test",
    mapId: "map-test",
    mapVersion: "1",
    ruleVersion: "1",
    rules: { vehicleRadius: 0.1, roads: [{ id: "road-a", width: 2, points: [[0, 0], [10, 0]] }] },
    scoring: { efficiency: { targetSeconds: 1, maxSeconds: 10 } }
  }, { sourceCode: "robot.forward(1)" }, { now: () => now, sampleIntervalMs: 100 });

  session.updateTask({ completed: 0, total: 1, finished: false });
  session.sample({ x: 0, z: 0, heading: -Math.PI / 2, speed: 0 });
  now = 50;
  session.sample({ x: 0.1, z: 0, heading: -Math.PI / 2, speed: 1 });
  now = 75;
  session.sample({ x: 0.1, z: 0, heading: -Math.PI / 2, speed: 1 });
  now = 100;
  session.sample({ x: 0.2, z: 0, heading: -Math.PI / 2, speed: 1 });
  session.addViolation("collision");
  session.updateTask({ completed: 1, total: 1, finished: true });
  const record = session.finish("completed");

  assert.deepEqual(record.samples.map(sample => sample.t), [0, 50, 100]);
  assert.equal(record.result.taskScore, 25);
  assert.equal(record.result.score <= 60, true);
  assert.equal(record.events.find(event => event.type === "violation")?.violationType, "collision");
  assert.equal(record.events.at(-1).type, "run_finished");
});

test("run-record reserved fields cannot be overridden by caller detail", () => {
  let now = 0;
  const session = new CompetitionSession({
    taskId: "task-test",
    mapId: "map-test",
    checkpoints: [{ position: [1, 0] }],
    goal: [2, 0],
    rules: { vehicleRadius: 0.1, roads: [{ id: "road-a", width: 2, points: [[0, 0], [10, 0]] }] }
  }, {}, { now: () => now });
  const violation = session.addViolation("collision", { type: "red_light", t: -100, message: "碰撞" });
  assert.equal(violation.type, "collision");
  assert.equal(violation.t, 0);
  const event = session.addEvent("checkpoint", { type: "forged", t: -200 });
  assert.equal(event.type, "checkpoint");
  assert.equal(event.t, 0);
  const violationEvent = session.recorder.export().events.find(item => item.type === "violation");
  assert.equal(violationEvent.violationType, "collision");
});

test("CompetitionSession config fields cannot be replaced by recorder metadata", () => {
  const session = new CompetitionSession({
    taskId: "real-task",
    mapId: "real-map",
    mapVersion: "map-1",
    ruleVersion: "rule-1",
    task: { id: "real-task", type: "reach", goal: [10, 0], goalRadius: 0.1 },
    rules: { roads: [] }
  }, {
    taskId: "forged-task",
    mapId: "forged-map",
    mapVersion: "forged-map-version",
    ruleVersion: "forged-rule-version",
    taskDefinition: { type: "reach", goal: [0, 0], goalRadius: 5 }
  }, { now: () => 0 });
  const record = session.recorder.export();

  assert.equal(record.taskId, "real-task");
  assert.equal(record.mapId, "real-map");
  assert.equal(record.mapVersion, "map-1");
  assert.equal(record.ruleVersion, "rule-1");
  assert.deepEqual(record.taskDefinition, session.taskEngine.definition());
});

test("competition session enforces its configured time limit in the core", () => {
  let now = 0;
  const session = new CompetitionSession({
    taskId: "timed-task",
    mapId: "map-test",
    timeLimitSeconds: 1,
    checkpoints: [{ position: [1, 0] }],
    goal: [2, 0],
    rules: { vehicleRadius: 0.1, roads: [{ id: "road-a", width: 2, points: [[0, 0], [10, 0]] }] }
  }, {}, { now: () => now });
  session.updateTask({ completed: 0, total: 2, finished: false });
  session.sample({ x: 0, z: 0, heading: 0, speed: 0 });
  now = 1000;
  const result = session.sample({ x: 1, z: 0, heading: 0, speed: 1 });
  assert.equal(result.timedOut, true);
  assert.equal(session.status, "timeout");
  assert.equal(result.record.result.reason, "timeout");
  assert.equal(result.record.result.durationSeconds, 1);
  assert.equal(result.record.samples.length, 1, "post-deadline telemetry must not be accepted");
});

test("Guangyang composite task requires both role deliveries and all checkpoints before returning", () => {
  const config = GUANGYANG_ISLAND_CONFIG;
  const engine = new TaskEngine({
    ...config.task,
    id: config.taskId,
    version: config.taskVersion,
    checkpoints: config.checkpoints,
    goal: config.goal
  });

  const objectById = new Map(config.objectTaskOverlay.objects.map(item => [item.id, item]));
  const packages = config.objectTaskOverlay.objects.map(item => ({
    id: item.id,
    x: item.position[0],
    z: item.position[1]
  }));
  const sample = (point, t, nextPackages = packages) => ({ ...observation(point, t), packages: nextPackages, holding: null });
  const start = config.start.slice(0, 2);
  let result = engine.evaluate(sample(start, 0), 0);
  assert.deepEqual(result.task, { completed: 0, total: 8, finished: false });
  assert.equal(result.state.goalReached, false, "standing on the shared start-goal must not finish the task");

  const checkpointEvents = [];
  config.checkpoints.forEach((checkpoint, index) => {
    result = engine.evaluate(sample(checkpoint.position, (index + 1) * 100), (index + 1) * 100);
    checkpointEvents.push(...result.events.filter(event => event.type === "checkpoint"));
    assert.equal(result.task.completed, index + 1);
    assert.equal(result.task.finished, false);
  });
  assert.deepEqual(checkpointEvents.map(event => event.checkpointId), config.checkpoints.map(checkpoint => checkpoint.id));
  assert.deepEqual(engine.taskState(), { completed: 4, total: 8, finished: false });

  result = engine.evaluate(sample(config.goal, 500), 500);
  assert.equal(result.state.goalReached, false, "returning before both deliveries must not latch the goal");

  const targetDelivery = config.task.deliveries.find(item => item.objectRole === "target");
  const targetDelivered = packages.map(item => item.id === targetDelivery.requiredPackageIds[0]
    ? { ...item, x: targetDelivery.destination[0], z: targetDelivery.destination[1] }
    : item);
  result = engine.evaluate(sample(targetDelivery.destination, 600, targetDelivered), 600);
  assert.deepEqual(result.events.map(event => event.type), ["package_delivered"]);
  assert.equal(result.task.completed, 5);

  const distractorDelivery = config.task.deliveries.find(item => item.objectRole === "distractor");
  const safeDistractorRelease = geometry.sourcePixelToWorld([450, 650]);
  const allDelivered = targetDelivered.map(item => item.id === distractorDelivery.requiredPackageIds[0]
    ? { ...item, x: safeDistractorRelease[0], z: safeDistractorRelease[1] }
    : item);
  result = engine.evaluate({
    ...sample(safeDistractorRelease, 700, allDelivered),
    holding: distractorDelivery.requiredPackageIds[0]
  }, 700);
  assert.equal(result.state.deliveredPackageIds.includes(distractorDelivery.requiredPackageIds[0]), false);
  result = engine.evaluate(sample(safeDistractorRelease, 710, allDelivered), 710);
  assert.deepEqual(result.events.map(event => event.type), ["package_delivered"]);
  assert.equal(result.task.completed, 6);
  assert.equal(objectById.get(targetDelivery.requiredPackageIds[0]).role, "target");
  assert.equal(objectById.get(distractorDelivery.requiredPackageIds[0]).role, "distractor");

  result = engine.evaluate(sample(config.goal, 800, allDelivered), 800);
  assert.deepEqual(result.events.map(event => event.type), ["goal_reached", "task_completed"]);
  assert.deepEqual(result.task, { completed: 8, total: 8, finished: true });
  assert.deepEqual(result.state.avoidanceProgress, {
    requiredObjectIds: ["guangyang-obstacle-1"],
    failedObjectIds: [],
    completed: 1,
    total: 1,
    finished: true
  });
  assert.equal(result.state.status, "completed");

  const duplicate = engine.evaluate(sample(config.goal, 800, allDelivered), 800);
  assert.deepEqual(duplicate.events, [], "duplicate terminal samples must be idempotent");
  assert.deepEqual(duplicate.task, result.task);
});

test("TaskEngine ignores out-of-order and duplicate checkpoint observations", () => {
  const task = makeCheckpointTask({
    checkpoints: [
      { id: "checkpoint-a", position: [0, 2] },
      { id: "checkpoint-b", position: [2, 0] }
    ]
  });
  const engine = new TaskEngine(task);

  engine.evaluate(observation([0, 0], 0), 0);
  let result = engine.evaluate(observation([2, 0], 100), 100);
  assert.equal(result.task.completed, 0);
  assert.deepEqual(result.events, [], "visiting checkpoint B before A must not advance progress");

  result = engine.evaluate(observation([0, 2], 200), 200);
  assert.equal(result.task.completed, 1);
  assert.deepEqual(result.events.map(event => event.checkpointId), ["checkpoint-a"]);

  assert.deepEqual(engine.evaluate(observation([0, 2], 200), 200).events, []);
  assert.deepEqual(engine.evaluate(observation([0, 2], 225), 225).events, []);
  assert.equal(engine.snapshot().completed, 1, "dwelling inside a visited checkpoint must not count twice");

  result = engine.evaluate(observation([2, 0], 300), 300);
  assert.equal(result.task.completed, 2);
  assert.deepEqual(result.events.map(event => event.checkpointId), ["checkpoint-b"]);
  assert.equal(result.task.finished, false);
});

test("TaskEngine does not latch an early goal visit", () => {
  const task = makeCheckpointTask({
    checkpoints: [
      { id: "checkpoint-a", position: [2, 0] },
      { id: "checkpoint-b", position: [2, 2] }
    ]
  });
  const engine = new TaskEngine(task);

  engine.evaluate(observation(task.goal, 0), 0);
  engine.evaluate(observation(task.checkpoints[0].position, 100), 100);
  let result = engine.evaluate(observation(task.goal, 200), 200);
  assert.equal(result.state.goalReached, false);
  assert.deepEqual(result.task, { completed: 1, total: 3, finished: false });

  result = engine.evaluate(observation(task.checkpoints[1].position, 300), 300);
  assert.deepEqual(result.task, { completed: 2, total: 3, finished: false });
  assert.equal(result.state.goalReached, false, "the vehicle must return after the last checkpoint");

  result = engine.evaluate(observation(task.goal, 400), 400);
  assert.deepEqual(result.task, { completed: 3, total: 3, finished: true });
  assert.deepEqual(result.events.map(event => event.type), ["goal_reached", "task_completed"]);
});

test("TaskEngine detects segment crossings and consumes multiple ordered targets in travel order", () => {
  const task = makeCheckpointTask({ goal: [6, 0] });
  const engine = new TaskEngine(task);
  engine.evaluate(observation([-1, 0], 0), 0);

  const result = engine.evaluate(observation([7, 0], 800), 800);
  assert.deepEqual(result.task, { completed: 3, total: 3, finished: true });
  assert.deepEqual(result.events.map(event => event.type), [
    "checkpoint",
    "checkpoint",
    "goal_reached",
    "task_completed"
  ]);
  assert.deepEqual(result.events.map(event => event.elapsedMs), [275, 475, 675, 675]);
  assert.deepEqual(result.state.visitedCheckpointIds, ["checkpoint-a", "checkpoint-b"]);
  assert.equal(result.state.completedAtMs, 675);
});

test("TaskEngine rejects invalid task definitions and non-monotonic observations", () => {
  const invalidDefinitions = [
    {},
    { type: "checkpoints", checkpoints: [], goal: [0, 0] },
    { type: "checkpoints", checkpoints: [{ id: "a", position: [1, 0] }] },
    { type: "checkpoints", checkpoints: [{ id: "a", position: [1, 0] }], goal: [0, Number.NaN] },
    {
      type: "checkpoints",
      checkpoints: [{ id: "same", position: [1, 0] }, { id: "same", position: [2, 0] }],
      goal: [0, 0]
    },
    { ...makeCheckpointTask(), checkpointRadius: 0 },
    { ...makeCheckpointTask(), goalRadius: Number.POSITIVE_INFINITY }
  ];
  invalidDefinitions.forEach((definition, index) => {
    assert.throws(() => new TaskEngine(definition), TypeError, `invalid task definition ${index} must fail fast`);
  });

  const engine = new TaskEngine(makeCheckpointTask());
  assert.throws(() => engine.evaluate({ x: Number.NaN, z: 0 }, 0), TypeError);
  engine.evaluate({ x: 0, z: 0 }, 100);
  assert.throws(() => engine.evaluate({ x: 1, z: 0 }, 99), RangeError);
});

test("TaskEngine delivery progress follows package position and current holding state", () => {
  const engine = new TaskEngine({
    id: "delivery-task",
    version: "1",
    type: "delivery",
    goal: [0, 0],
    deliveryRadius: 0.5,
    requiredPackageIds: ["box-a", "box-b"]
  });
  const evaluate = (t, holding, packages) => engine.evaluate({ x: 2, z: 2, holding, packages }, t);

  let result = evaluate(0, null, [
    { id: "box-a", x: 0.2, z: 0 },
    { id: "box-b", x: 2, z: 0 }
  ]);
  assert.deepEqual(result.task, { completed: 1, total: 2, finished: false });
  assert.deepEqual(result.events.map(event => event.type), ["package_delivered"]);

  result = evaluate(100, "box-a", [
    { id: "box-a", x: 0.2, z: 0 },
    { id: "box-b", x: 2, z: 0 }
  ]);
  assert.deepEqual(result.task, { completed: 0, total: 2, finished: false });
  assert.deepEqual(result.events.map(event => event.type), ["package_delivery_revoked"]);

  result = evaluate(200, null, [
    { id: "box-a", x: 0.1, z: 0 },
    { id: "box-b", x: 0, z: 0.1 }
  ]);
  assert.deepEqual(result.task, { completed: 2, total: 2, finished: true });
  assert.deepEqual(result.events.map(event => event.type), [
    "package_delivered",
    "package_delivered",
    "task_completed"
  ]);
});

test("TaskEngine rejects incomplete or duplicate delivery package snapshots", () => {
  const definition = {
    id: "strict-delivery",
    type: "delivery",
    goal: [0, 0],
    requiredPackageIds: ["box-a", "box-b"]
  };
  const engine = new TaskEngine(definition);
  assert.throws(() => engine.evaluate({
    x: 0,
    z: 0,
    packages: [{ id: "box-a", x: 0, z: 0 }]
  }, 0), /every required package/);
  assert.throws(() => engine.evaluate({
    x: 0,
    z: 0,
    packages: [
      { id: "box-a", x: 0, z: 0 },
      { id: "box-a", x: 1, z: 0 }
    ]
  }, 0), /unique/);
});

test("TaskEngine delivery ignores extra distractors and obstacles while only targets earn progress", () => {
  const engine = new TaskEngine({
    id: "three-role-delivery",
    type: "delivery",
    goal: [0, 0],
    deliveryRadius: 0.25,
    requiredPackageIds: ["target-a"]
  });
  const objects = [
    { id: "target-a", x: 1, z: 0 },
    { id: "decoy-a", x: 0, z: 0 },
    { id: "barrier-a", x: 0, z: 0.1 }
  ];

  const untouched = engine.evaluate({ x: 0, z: 0, packages: objects, holding: null }, 0);
  assert.equal(untouched.task.completed, 0, "a distractor in the goal must not count as a target");
  const held = engine.evaluate({
    x: 0,
    z: 0,
    packages: objects.map(item => item.id === "target-a" ? { ...item, x: 0, z: 0 } : item),
    holding: "target-a"
  }, 20);
  assert.equal(held.task.completed, 0, "a held target is not delivered");
  const delivered = engine.evaluate({
    x: 0,
    z: 0,
    packages: objects.map(item => item.id === "target-a" ? { ...item, x: 0, z: 0 } : item),
    holding: null
  }, 40);
  assert.equal(delivered.task.finished, true);
  assert.deepEqual(delivered.events.map(event => event.type), ["package_delivered", "task_completed"]);
});

test("task v3 composite combines role-bound deliveries, ordered checkpoints, and a gated return goal", () => {
  assert.equal(LEGACY_TASK_SCHEMA_VERSION, "chenlong.task/v1");
  assert.equal(PREVIOUS_TASK_SCHEMA_VERSION, "chenlong.task/v2");
  assert.equal(TASK_SCHEMA_VERSION, "chenlong.task/v3");
  const legacy = new TaskEngine(makeCheckpointTask()).definition();
  assert.equal(legacy.schemaVersion, LEGACY_TASK_SCHEMA_VERSION);
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, "deliveries"), false,
    "normalizing a legacy task must not change its canonical v1 shape");

  const task = makeCompositeTask({
    checkpoints: [
      { id: "checkpoint-a", position: [0, 1] },
      { id: "checkpoint-b", position: [1, 1] }
    ],
    deliveries: [
      {
        id: "target-storage",
        objectRole: "target",
        destinationRole: "storage",
        destination: [2, 0],
        radius: 0.3,
        requiredPackageIds: ["target-a"]
      },
      {
        id: "distractor-cleanup",
        objectRole: "distractor",
        destinationRole: "cleanup",
        destination: [3, 0],
        radius: 0.3,
        requiredPackageIds: ["decoy-a"]
      }
    ]
  });
  const engine = new TaskEngine(task);
  let packages = [
    { id: "target-a", x: -2, z: 0 },
    { id: "decoy-a", x: -3, z: 0 },
    { id: "barrier-a", x: 0, z: 2 }
  ];
  const evaluate = (point, t, holding = null) => engine.evaluate({
    x: point[0], z: point[1], heading: 0, speed: 0, steering: 0, holding, packages
  }, t);

  let result = evaluate(task.goal, 0);
  assert.deepEqual(result.task, { completed: 0, total: 5, finished: false });
  assert.equal(result.state.goalReached, false);

  result = evaluate([1, 1], 100);
  assert.equal(result.state.nextCheckpointIndex, 0, "checkpoint B cannot be accepted before checkpoint A");
  result = evaluate([0, 1], 200);
  assert.deepEqual(result.events.map(event => event.checkpointId), ["checkpoint-a"]);
  result = evaluate(task.goal, 300);
  assert.equal(result.state.goalReached, false, "an early return cannot be latched");
  result = evaluate([1, 1], 400);
  assert.deepEqual(result.events.map(event => event.checkpointId), ["checkpoint-b"]);
  result = evaluate(task.goal, 500);
  assert.equal(result.state.goalReached, false, "return remains gated until both object roles are placed");

  packages = packages.map(item => item.id === "target-a" ? { ...item, x: 2, z: 0 } : item);
  result = evaluate([2, 0], 600);
  assert.deepEqual(result.events.map(event => [event.type, event.deliveryId, event.objectRole, event.destinationRole]), [
    ["package_delivered", "target-storage", "target", "storage"]
  ]);
  assert.equal(result.state.goalReached, false,
    "a placement completed at the segment endpoint cannot retroactively count an earlier goal crossing");

  packages = packages.map(item => item.id === "decoy-a" ? { ...item, x: 3, z: 0 } : item);
  result = evaluate([3, 0], 700, "decoy-a");
  assert.equal(result.task.completed, 3, "a held distractor is not placed in cleanup");
  result = evaluate([3, 0], 800);
  assert.deepEqual(result.events.map(event => [event.type, event.deliveryId]), [
    ["package_delivered", "distractor-cleanup"]
  ]);
  assert.equal(result.state.goalReached, false);

  result = evaluate(task.goal, 900);
  assert.deepEqual(result.events.map(event => event.type), ["goal_reached", "task_completed"]);
  assert.deepEqual(result.task, { completed: 5, total: 5, finished: true });
  assert.deepEqual(result.state.deliveredPackageIds, ["target-a", "decoy-a"]);
  assert.deepEqual(result.state.deliveryProgress, [
    {
      id: "target-storage", objectRole: "target", destinationRole: "storage",
      deliveredPackageIds: ["target-a"], completed: 1, total: 1, finished: true
    },
    {
      id: "distractor-cleanup", objectRole: "distractor", destinationRole: "cleanup",
      deliveredPackageIds: ["decoy-a"], completed: 1, total: 1, finished: true
    }
  ]);
});

test("task v3 composite makes collision-free obstacle avoidance a deterministic completion unit", () => {
  const task = makeCompositeTask({
    checkpoints: [{ id: "checkpoint-a", position: [1, 0] }],
    deliveries: [{
      id: "target-storage",
      objectRole: "target",
      destinationRole: "storage",
      destination: [2, 0],
      radius: 0.3,
      requiredPackageIds: ["target-a"]
    }],
    avoidanceObjectIds: ["barrier-a"]
  });
  const run = collisionId => {
    const engine = new TaskEngine(task);
    let packages = [{ id: "target-a", x: -2, z: 0 }];
    const evaluate = (point, t) => engine.evaluate({
      x: point[0], z: point[1], holding: null, packages
    }, t);
    assert.deepEqual(evaluate(task.goal, 0).task, { completed: 0, total: 4, finished: false });
    if (collisionId) assert.equal(engine.noteCollision(collisionId), true);
    assert.equal(engine.noteCollision("wall:unrelated"), false);
    evaluate([1, 0], 100);
    packages = [{ id: "target-a", x: 2, z: 0 }];
    evaluate([2, 0], 200);
    return evaluate(task.goal, 300);
  };

  const clean = run(null);
  assert.deepEqual(clean.events.map(event => event.type), ["goal_reached", "task_completed"]);
  assert.deepEqual(clean.task, { completed: 4, total: 4, finished: true });
  assert.deepEqual(clean.state.avoidanceProgress, {
    requiredObjectIds: ["barrier-a"], failedObjectIds: [], completed: 1, total: 1, finished: true
  });

  const collided = run("object:barrier-a");
  assert.deepEqual(collided.events.map(event => event.type), ["goal_reached"]);
  assert.deepEqual(collided.task, { completed: 3, total: 4, finished: false });
  assert.deepEqual(collided.state.avoidanceProgress, {
    requiredObjectIds: ["barrier-a"], failedObjectIds: ["barrier-a"], completed: 0, total: 1, finished: false
  });
});

test("task v2 composite records remain compatible and cannot opt into the v3 avoidance gate", () => {
  const definition = { ...makeCompositeTask(), schemaVersion: PREVIOUS_TASK_SCHEMA_VERSION };
  const normalized = new TaskEngine(definition).definition();
  assert.equal(normalized.schemaVersion, PREVIOUS_TASK_SCHEMA_VERSION);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, "avoidanceObjectIds"), false);
  assert.throws(() => new TaskEngine({
    ...definition,
    avoidanceObjectIds: ["barrier-a"]
  }), /avoidanceObjectIds requires chenlong\.task\/v3/);
});

test("task v4 gives distractor removal an explicit fixed off-road destination without changing v2/v3 records", () => {
  const legacyV3 = new TaskEngine(makeCompositeTask()).definition();
  assert.equal(legacyV3.schemaVersion, TASK_SCHEMA_VERSION);
  assert.equal(legacyV3.deliveries[1].destinationRole, "cleanup");
  assert.equal(Object.prototype.hasOwnProperty.call(legacyV3.deliveries[1], "placementRule"), false);

  const v4 = {
    ...makeCompositeTask(),
    schemaVersion: OFFROAD_TASK_SCHEMA_VERSION,
    deliveries: [
      makeCompositeTask().deliveries[0],
      {
        ...makeCompositeTask().deliveries[1],
        id: "distractor-offroad-removal",
        destinationRole: "offroad-removal",
        destination: [4, 1.6],
        radius: 0.2,
        placementRule: "fixed-offroad-zone",
        objectRadius: 0.28,
        minimumRoadEdgeClearance: 0.5
      }
    ]
  };
  const normalized = new TaskEngine(v4).definition();
  assert.equal(normalized.schemaVersion, OFFROAD_TASK_SCHEMA_VERSION);
  assert.deepEqual(normalized.deliveries[1], v4.deliveries[1]);
  assert.equal(JSON.stringify(normalized.deliveries[1]), JSON.stringify(v4.deliveries[1]),
    "v4 canonical delivery bytes and field order remain unchanged");
  assert.deepEqual(normalized.avoidanceObjectIds, []);
  assert.equal(validateFixedOffroadDeliveryGeometry(v4.deliveries[1], [
    { id: "road-a", width: 1, points: [[0, 0], [8, 0]] }
  ]).roadId, "road-a");

  assert.throws(() => new TaskEngine({
    ...v4,
    deliveries: [{ ...v4.deliveries[0] }, { ...v4.deliveries[1], destinationRole: "cleanup" }]
  }), /distractor delivery destinationRole must be offroad-removal/);
  assert.throws(() => new TaskEngine({
    ...v4,
    deliveries: [{ ...v4.deliveries[0] }, {
      ...v4.deliveries[1], minimumRoadEdgeClearance: 0.48
    }]
  }), /off-road clearance must exceed its zone radius plus object radius/);
  assert.throws(() => new TaskEngine({
    ...v4,
    deliveries: [{ ...v4.deliveries[0] }, {
      ...v4.deliveries[1], objectRadius: undefined
    }]
  }), /objectRadius is required/);
});

test("task v5 completes a released distractor at any position whose full disk clears every road edge", () => {
  assert.equal(ROAD_CLEARANCE_TASK_SCHEMA_VERSION, "chenlong.task/v5");
  const task = makeRoadClearanceTask();
  const engine = new TaskEngine(task);
  const definition = engine.definition();
  const removal = definition.deliveries[1];
  assert.deepEqual(removal, {
    id: "distractor-offroad-removal",
    objectRole: "distractor",
    destinationRole: "offroad-removal",
    requiredPackageIds: ["decoy-a"],
    placementRule: "road-edge-clearance",
    objectRadius: 0.25,
    minimumRoadEdgeClearance: 0.2
  });
  assert.equal(Object.isFrozen(engine.config.placementGeometry), true);
  assert.equal(Object.isFrozen(engine.config.placementGeometry.roads[0].points[0]), true);

  let packages = [{ id: "target-a", x: -3, z: 0 }, { id: "decoy-a", x: 0, z: 0 }];
  const evaluate = (t, holding = null) => engine.evaluate({
    x: 0, z: 3, heading: 0, speed: 0, steering: 0, holding, packages
  }, t);
  assert.equal(evaluate(0).state.deliveredPackageIds.includes("decoy-a"), false);

  packages = packages.map(item => item.id === "decoy-a" ? { ...item, x: -3, z: 1.45 } : item);
  assert.equal(evaluate(50).state.deliveredPackageIds.includes("decoy-a"), false,
    "an object merely appearing off-road is not a completed grab-and-release action");
  assert.equal(evaluate(100, "decoy-a").state.deliveredPackageIds.includes("decoy-a"), false,
    "an object still held by the robot is not released");
  let result = evaluate(200);
  assert.deepEqual(result.events.map(event => event.type), ["package_delivered"]);
  assert.equal(result.state.deliveredPackageIds.includes("decoy-a"), true,
    "the exact disk-edge clearance boundary is accepted");

  packages = packages.map(item => item.id === "decoy-a" ? { ...item, x: 3, z: 1.44 } : item);
  result = evaluate(300);
  assert.deepEqual(result.events.map(event => event.type), ["package_delivery_revoked"]);
  assert.equal(result.state.deliveredPackageIds.includes("decoy-a"), false);

  packages = packages.map(item => item.id === "decoy-a" ? { ...item, x: 3, z: -1.6 } : item);
  result = evaluate(400);
  assert.deepEqual(result.events.map(event => event.type), ["package_delivered"]);
  assert.equal(result.state.deliveredPackageIds.includes("decoy-a"), true,
    "a separated location on the other side of the road is equally valid");
});

test("task v5 road-clearance definitions reject ambiguous geometry, placement fields, and object radii", () => {
  const task = makeRoadClearanceTask();
  const withRemoval = patch => ({
    ...task,
    deliveries: [task.deliveries[0], { ...task.deliveries[1], ...patch }]
  });
  assert.throws(() => new TaskEngine({ ...task, placementGeometry: undefined }),
    /placementGeometry must be an object/);
  assert.throws(() => new TaskEngine(withRemoval({ placementRule: "fixed-offroad-zone" })),
    /placementRule must be road-edge-clearance/);
  assert.throws(() => new TaskEngine(withRemoval({ destination: [0, 2] })),
    /must not define destination or radius/);
  assert.throws(() => new TaskEngine(withRemoval({ radius: 0.3 })),
    /must not define destination or radius/);
  for (const field of ["objectRadius", "minimumRoadEdgeClearance"]) {
    assert.throws(() => new TaskEngine(withRemoval({ [field]: undefined })), new RegExp(`${field} is required`));
    assert.throws(() => new TaskEngine(withRemoval({ [field]: "0.2" })),
      new RegExp(`${field} must be a positive finite number`));
  }
  assert.throws(() => new TaskEngine({
    ...task,
    placementGeometry: { roads: [{ id: "road-a", width: "2", points: [[-5, 0], [5, 0]] }] }
  }), /road road-a\.width must be a positive finite number/);
  assert.throws(() => new TaskEngine({
    ...task,
    placementGeometry: { roads: [
      { id: "duplicate", width: 2, points: [[-5, 0], [5, 0]] },
      { id: "duplicate", width: 2, points: [[0, -5], [0, 5]] }
    ] }
  }), /road id must be non-empty and unique/);
  assert.throws(() => new TaskEngine({
    ...task,
    deliveries: [{
      ...task.deliveries[0],
      placementRule: "road-edge-clearance",
      objectRadius: 0.25,
      minimumRoadEdgeClearance: 0.2
    }, task.deliveries[1]]
  }), /target delivery cannot define a road-edge-clearance placement rule/);
});

test("task v5 binds every road-clearance object radius and distractor role to interaction v2", () => {
  const task = makeRoadClearanceTask();
  const interaction = (role = "distractor", radius = 0.25) => ({
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    packageRadius: 0.25,
    bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
    packages: [
      { id: "target-a", role: "target", radius: 0.25, x: -3, z: 0 },
      { id: "decoy-a", role, radius, x: 0, z: 0 }
    ]
  });
  const makeSession = (definition, roads = task.placementGeometry.roads) => new CompetitionSession({
    taskId: task.id,
    task,
    rules: { vehicleRadius: 0.2, roads }
  }, { interactionDefinition: definition }, { now: () => 0 });
  assert.doesNotThrow(() => makeSession(interaction()));
  assert.throws(() => makeSession(interaction("target")), /decoy-a must have role distractor/);
  assert.throws(() => makeSession(interaction("distractor", 0.3)),
    /objectRadius must match interaction package decoy-a radius/);
  assert.throws(() => makeSession(interaction(), [
    { ...task.placementGeometry.roads[0], width: 1.8 }
  ]), /placementGeometry roads must exactly match the competition rule roads/);
});

test("task v5 live evaluation, replay, and rejudging derive road clearance from frozen geometry, not events", () => {
  const task = makeRoadClearanceTask();
  const samples = [
    { ...observation([0, 3], 0), holding: null, packages: [
      { id: "target-a", x: -3, z: 0 }, { id: "decoy-a", x: 0, z: 0 }
    ] },
    { ...observation([0, 3], 100), holding: "decoy-a", packages: [
      { id: "target-a", x: -3, z: 0 }, { id: "decoy-a", x: 0, z: 1.6 }
    ] },
    { ...observation([0, 3], 200), holding: null, packages: [
      { id: "target-a", x: -3, z: 0 }, { id: "decoy-a", x: 0, z: 1.45 }
    ] }
  ];
  const online = new TaskEngine(task);
  const onlineEvents = samples.flatMap(sample => online.evaluate(sample, sample.t).events);
  const replay = TaskEngine.replay(task, samples);
  assert.deepEqual(replay.state, online.snapshot());
  assert.deepEqual(replay.events, onlineEvents);

  const record = {
    schemaVersion: SCHEMA_VERSION,
    taskDefinition: new TaskEngine(task).definition(),
    inputs: [],
    samples: samples.map((sample, index) => ({ ...sample, seq: index + 1 })),
    events: [{
      seq: samples.length + 1,
      t: 0,
      type: "package_delivered",
      packageId: "decoy-a",
      deliveryId: "forged-client-event"
    }],
    result: { taskFinished: true, completedTasks: 99 }
  };
  const rejudged = rejudgeTask(task, record);
  assert.equal(rejudged.replayable, true);
  assert.deepEqual(rejudged.state, replay.state);
  assert.deepEqual(rejudged.events, replay.events);
  assert.deepEqual(rejudged.events.map(event => event.elapsedMs), [200]);
});

test("task v3 composite validates destination rules and interaction object roles", () => {
  const definition = makeCompositeTask();
  assert.equal(new TaskEngine(definition).definition().schemaVersion, TASK_SCHEMA_VERSION);
  assert.throws(() => new TaskEngine({ ...definition, schemaVersion: LEGACY_TASK_SCHEMA_VERSION }),
    /requires chenlong\.task\/v2, chenlong\.task\/v3, chenlong\.task\/v4, or chenlong\.task\/v5/);
  assert.throws(() => new TaskEngine({
    ...definition,
    deliveries: [{ ...definition.deliveries[0], objectRole: "obstacle" }]
  }), /objectRole must be target or distractor/);
  assert.throws(() => new TaskEngine({
    ...definition,
    deliveries: [{ ...definition.deliveries[0], destinationRole: "cleanup" }]
  }), /target delivery destinationRole must be storage/);
  assert.throws(() => new TaskEngine({
    ...definition,
    deliveries: [definition.deliveries[0], {
      ...definition.deliveries[1],
      requiredPackageIds: ["target-a"]
    }]
  }), /may belong to only one delivery/);

  const interactionDefinition = {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    bounds: { minX: -5, maxX: 5, minZ: -3, maxZ: 3 },
    packages: [
      { id: "target-a", role: "target", x: 0.8, z: 0 },
      { id: "decoy-a", role: "distractor", x: -0.8, z: 0 },
      { id: "barrier-a", role: "obstacle", radius: 0.52, x: 0, z: 1 }
    ]
  };
  const makeSession = (interaction, taskDefinition = definition) => new CompetitionSession({
    taskId: taskDefinition.id,
    task: taskDefinition,
    rules: { roads: [{ id: "route", width: 8, points: [[-5, 0], [5, 0]] }] },
    scoring: { efficiency: { targetSeconds: 10, maxSeconds: 20 } },
    interactionDefinition: interaction
  });
  const session = makeSession(interactionDefinition);
  const record = session.finish("program_finished");
  assert.deepEqual(record.runDefinition.taskDefinition.deliveries, new TaskEngine(definition).definition().deliveries);
  assert.deepEqual(record.runDefinition.interactionDefinition.packages, [
    { id: "target-a", x: 0.8, z: 0, stackLevel: 0, role: "target", radius: 0.28 },
    { id: "decoy-a", x: -0.8, z: 0, stackLevel: 0, role: "distractor", radius: 0.28 },
    { id: "barrier-a", x: 0, z: 1, stackLevel: 0, role: "obstacle", radius: 0.52 }
  ]);
  assert.deepEqual(record.runDefinition.ruleDefinition.roads,
    [{ id: "route", width: 8, points: [[-5, 0], [5, 0]] }]);

  assert.throws(() => makeSession({
    ...interactionDefinition,
    packages: interactionDefinition.packages.map(item => item.id === "decoy-a" ? { ...item, role: "target" } : item)
  }), /decoy-a must have role distractor/);
  assert.throws(() => makeSession({
    ...interactionDefinition,
    packages: interactionDefinition.packages.filter(item => item.id !== "target-a")
  }), /target-a is missing/);
  assert.throws(() => makeSession({
    ...interactionDefinition,
    schemaVersion: LEGACY_INTERACTION_SCHEMA_VERSION,
    packages: interactionDefinition.packages.map(({ role: _role, ...item }) => item)
  }), /requires chenlong\.package-interaction\/v2/);
  const avoidanceTask = { ...definition, avoidanceObjectIds: ["barrier-a"] };
  assert.doesNotThrow(() => makeSession(interactionDefinition, avoidanceTask));
  assert.throws(() => makeSession({
    ...interactionDefinition,
    packages: interactionDefinition.packages.map(item => item.id === "barrier-a" ? { ...item, role: "target" } : item)
  }, avoidanceTask), /barrier-a must have role obstacle/);
  assert.throws(() => makeSession({
    ...interactionDefinition,
    packages: interactionDefinition.packages.filter(item => item.id !== "barrier-a")
  }, avoidanceTask), /avoidance object barrier-a is missing/);
});

test("PackageStateEngine grabs only a reachable top package and releases deterministically", () => {
  const definition = {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    bounds: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 },
    packageRadius: 0.2,
    grab: { minForward: 0.1, maxForward: 1.2, maxLateral: 0.25, maxDistance: 1.2 },
    release: { forwardOffset: 1, lateralOffset: 0, stackSnapDistance: 0.25 },
    packages: [
      { id: "stack-bottom", x: 0.8, z: 0, stackLevel: 0 },
      { id: "stack-top", x: 0.8, z: 0, stackLevel: 1 },
      { id: "behind", x: -0.4, z: 0, stackLevel: 0 }
    ]
  };
  const normalized = normalizeInteractionDefinition(definition);
  assert.equal(normalized.schemaVersion, INTERACTION_SCHEMA_VERSION);
  const engine = new PackageStateEngine(normalized);
  const pose = { x: 0, z: 0, heading: -Math.PI / 2 };

  const blockedBottom = engine.applyGrab({ packageId: "stack-bottom" }, pose);
  assert.equal(blockedBottom.accepted, false);
  assert.equal(blockedBottom.reason, "not_top");

  const grabbed = engine.applyGrab({}, pose);
  assert.equal(grabbed.accepted, true);
  assert.equal(grabbed.packageId, "stack-top");
  assert.equal(engine.applyGrab({}, pose).reason, "holding");

  const released = engine.applyRelease({}, pose);
  assert.deepEqual(
    { accepted: released.accepted, packageId: released.packageId, position: released.position,
      stackLevel: released.stackLevel, snapped: released.snapped },
    { accepted: true, packageId: "stack-top", position: [0.8, 0], stackLevel: 1, snapped: true }
  );
  assert.deepEqual(new PackageStateEngine(normalized).applyGrab({}, pose), grabbed,
    "the same definition and pose must choose the same top package");

  const unreachable = new PackageStateEngine({
    ...definition,
    packages: [{ id: "only-behind", x: -0.4, z: 0 }]
  }).applyGrab({}, pose);
  assert.equal(unreachable.accepted, false);
  assert.equal(unreachable.reason, "behind");

  const boundaryEngine = new PackageStateEngine({
    ...definition,
    release: { ...definition.release, stackSnapDistance: 0.1 },
    packages: [{ id: "edge-box", x: 0.8, z: 0 }]
  });
  assert.equal(boundaryEngine.applyGrab({}, pose).accepted, true);
  const boundaryRelease = boundaryEngine.applyRelease({}, { x: 1.9, z: 0, heading: -Math.PI / 2 });
  assert.deepEqual(boundaryRelease.position, [1.8, 0]);
  assert.equal(boundaryRelease.stackLevel, 0);
  assert.equal(boundaryRelease.snapped, false);
  assert.equal(boundaryRelease.clamped, true);
});

test("interaction v2 gives targets, distractors, and non-grabbable obstacles deterministic roles", () => {
  const definition = normalizeInteractionDefinition({
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    bounds: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 },
    packageRadius: 0.2,
    grab: { minForward: 0.1, maxForward: 1.2, maxLateral: 0.3, maxDistance: 1.2 },
    release: { forwardOffset: 1, lateralOffset: 0, stackSnapDistance: 0.1 },
    packages: [
      { id: "barrier", role: "obstacle", radius: 0.52, x: 0.52, z: 0 },
      { id: "target", role: "target", x: 0.7, z: 0 },
      { id: "decoy", role: "distractor", x: 0.9, z: 0.2 }
    ]
  });
  const pose = { x: 0, z: 0, heading: -Math.PI / 2 };
  const engine = new PackageStateEngine(definition);

  const blocked = engine.applyGrab({}, pose);
  assert.deepEqual(
    { accepted: blocked.accepted, reason: blocked.reason, packageId: blocked.packageId, objectRole: blocked.objectRole },
    { accepted: false, reason: "not_grabbable", packageId: "barrier", objectRole: "obstacle" }
  );
  assert.equal(engine.snapshot().holding, null);
  assert.equal(engine.definition().packages.find(item => item.id === "target").radius, 0.2,
    "v2 movable objects inherit the global package radius");
  assert.deepEqual(
    engine.colliders().find(collider => collider.id === "object:barrier"),
    { id: "object:barrier", source: "interaction-obstacle", type: "circle", x: 0.52, z: 0, radius: 0.52 }
  );

  const target = engine.applyGrab({ packageId: "target" }, pose);
  assert.equal(target.accepted, true);
  assert.equal(target.objectRole, "target");
  assert.equal(engine.colliders().some(collider => collider.id === "object:barrier"), true,
    "holding another object must never remove the obstacle collider");
  assert.equal(engine.applyRelease({}, pose).objectRole, "target");

  const distractorEngine = new PackageStateEngine(definition);
  const distractor = distractorEngine.applyGrab({ packageId: "decoy" }, pose);
  assert.equal(distractor.accepted, true);
  assert.equal(distractor.objectRole, "distractor");
  assert.deepEqual(
    distractor.state.packages.map(item => [item.id, item.role]),
    [["barrier", "obstacle"], ["decoy", "distractor"], ["target", "target"]]
  );

  assert.throws(() => normalizeInteractionDefinition({
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    packages: [{ id: "bad", role: "movable", x: 0, z: 0 }]
  }), /role must be target, distractor, or obstacle/);
  assert.throws(() => normalizeInteractionDefinition({
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    packages: [{ id: "bad", role: "obstacle", x: 0, z: 0, stackLevel: 1 }]
  }), /obstacle.*stackLevel/);
  assert.throws(() => normalizeInteractionDefinition({
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    packages: [{ id: "bad", role: "target", radius: 0, x: 0, z: 0 }]
  }), /package bad\.radius must be greater than zero/);
  assert.throws(() => normalizeInteractionDefinition({
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    bounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1 },
    packages: [{ id: "bad", role: "obstacle", radius: 1.1, x: 0, z: 0 }]
  }), /lies outside the playable bounds/);
});

test("PackageStateEngine rejects releases overlapping a per-object obstacle without mutating state", () => {
  const engine = new PackageStateEngine({
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    bounds: { minX: -3, maxX: 3, minZ: -2, maxZ: 2 },
    packageRadius: 0.28,
    grab: { minForward: 0.1, maxForward: 1.2, maxLateral: 0.3, maxDistance: 1.2 },
    release: { forwardOffset: 1, lateralOffset: 0, stackSnapDistance: 0.1 },
    packages: [
      { id: "target", role: "target", x: 0.5, z: 0 },
      { id: "barrier", role: "obstacle", radius: 0.52, x: 1.5, z: 0 }
    ]
  });
  const facingEast = { x: 0, z: 0, heading: -Math.PI / 2 };
  assert.equal(engine.applyGrab({ packageId: "target" }, facingEast).accepted, true);
  const before = engine.snapshot();
  const blocked = engine.applyRelease({}, facingEast);
  assert.deepEqual(
    { accepted: blocked.accepted, reason: blocked.reason, packageId: blocked.packageId,
      objectRole: blocked.objectRole, obstacleId: blocked.obstacleId, position: blocked.position },
    { accepted: false, reason: "blocked", packageId: "target", objectRole: "target",
      obstacleId: "barrier", position: [1, 0] }
  );
  assert.deepEqual(engine.snapshot(), before, "a blocked release must preserve the held object and every position");
  assert.equal(engine.applyRelease({}, { x: 0, z: 0, heading: Math.PI / 2 }).accepted, true,
    "the same held object can be released after moving away from the obstacle");
});

test("legacy interaction v1 remains grabbable and maps outcomes to the target role", () => {
  const definition = normalizeInteractionDefinition({
    schemaVersion: LEGACY_INTERACTION_SCHEMA_VERSION,
    bounds: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 },
    packages: [{ id: "legacy-box", x: 0.8, z: 0 }]
  });
  assert.equal(definition.schemaVersion, LEGACY_INTERACTION_SCHEMA_VERSION);
  assert.equal(Object.prototype.hasOwnProperty.call(definition.packages[0], "role"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(definition.packages[0], "radius"), false,
    "legacy interaction definitions retain their original canonical package shape");
  const outcome = new PackageStateEngine(definition).applyGrab({}, { x: 0, z: 0, heading: -Math.PI / 2 });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.objectRole, "target");
});

test("delivery definitions may only require v2 target objects", () => {
  const interactionDefinition = {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    packages: [
      { id: "target-a", role: "target", x: 0.8, z: 0 },
      { id: "decoy-a", role: "distractor", x: -0.8, z: 0 }
    ]
  };
  const makeSession = requiredPackageIds => new CompetitionSession({
    taskId: "role-bound-delivery",
    task: { type: "delivery", goal: [1, 0], requiredPackageIds },
    rules: { roads: [] },
    interactionDefinition
  });
  assert.doesNotThrow(() => makeSession(["target-a"]));
  assert.throws(() => makeSession(["decoy-a"]), /must have role target/);
  assert.throws(() => makeSession(["missing"]), /missing from the interaction definition/);
});

test("package interaction definitions enforce their fixed package budget", () => {
  assert.throws(() => normalizeInteractionDefinition({
    bounds: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 },
    packages: Array.from({ length: 1001 }, (_, index) => ({ id: `box-${index}`, x: 0, z: 0 }))
  }), /1000 package limit/);
});

test("TaskEngine replay and record rejudging equal online evaluation", () => {
  const task = makeCheckpointTask({
    checkpoints: [
      { id: "checkpoint-a", position: [2, 0] },
      { id: "checkpoint-b", position: [2, 2] }
    ]
  });
  const samples = [
    observation([0, 0], 0),
    observation([2, 0], 100),
    observation([0, 0], 200),
    observation([2, 2], 300),
    observation([0, 0], 400)
  ];
  const online = new TaskEngine(task);
  const onlineEvents = [];
  samples.forEach(sample => {
    onlineEvents.push(...online.evaluate(sample, sample.t).events);
  });

  const instanceReplay = new TaskEngine(task).replay(samples);
  const staticReplay = TaskEngine.replay(task, samples);
  assert.deepEqual(instanceReplay.state, online.snapshot());
  assert.deepEqual(instanceReplay.events, onlineEvents);
  assert.deepEqual(staticReplay, instanceReplay);

  const validRecord = {
    schemaVersion: SCHEMA_VERSION,
    taskDefinition: new TaskEngine(task).definition(),
    inputs: [],
    samples: samples.map((sample, index) => ({ ...sample, seq: index + 1 })),
    events: [{ seq: samples.length + 1, type: "task_completed", t: 400, completed: 999 }],
    result: { taskFinished: false, score: 0 }
  };
  const rejudged = rejudgeTask(task, validRecord);
  assert.equal(rejudged.authoritative, false, "a client record is never an authoritative competition result");
  assert.equal(rejudged.replayable, true);
  assert.deepEqual(rejudged.state, online.snapshot(), "client events and result must not influence rejudging");
  assert.deepEqual(rejudged.events, onlineEvents);
  assert.deepEqual(rejudgeTask(validRecord).state, online.snapshot(), "the embedded task definition supports one-argument replay");

  const duplicatedGlobalSequence = rejudgeTask(task, {
    ...validRecord,
    inputs: [{
      seq: 1,
      t: 0,
      tick: 0,
      type: "control",
      command: { kind: "wait", durationMs: 0, durationTicks: 0 }
    }]
  });
  assert.equal(duplicatedGlobalSequence.replayable, false);
  assert.match(duplicatedGlobalSequence.diagnostics.join("\n"), /sequence 1 is duplicated/);

  const mismatched = rejudgeTask({ ...task, goal: [10, 10] }, validRecord);
  assert.equal(mismatched.replayable, false);
  assert.match(mismatched.diagnostics.join("\n"), /does not match/);
  const missingSequence = rejudgeTask(task, {
    schemaVersion: SCHEMA_VERSION,
    taskDefinition: validRecord.taskDefinition,
    samples,
    events: []
  });
  assert.equal(missingSequence.replayable, false);
  assert.match(missingSequence.diagnostics.join("\n"), /sequence number/);

  const legacy = rejudgeTask(task, { schemaVersion: "chenlong.run-record/v1", samples });
  assert.equal(legacy.authoritative, false);
  assert.equal(legacy.replayable, false);
  assert.ok(legacy.diagnostics.length > 0);
});

test("rejudgeTask returns diagnostics instead of throwing for damaged records", () => {
  const taskDefinition = new TaskEngine({ type: "reach", goal: [0, 0], goalRadius: 1 }).definition();
  const invalidSample = rejudgeTask({
    schemaVersion: SCHEMA_VERSION,
    taskDefinition,
    samples: [{ seq: 1, t: 0, x: Number.NaN, z: 0, heading: 0, speed: 0, steering: 0 }],
    events: []
  });
  assert.equal(invalidSample.replayable, false);
  assert.equal(invalidSample.state, null);
  assert.match(invalidSample.diagnostics.join("\n"), /non-finite telemetry|task replay failed/);

  const missingDefinition = rejudgeTask({
    schemaVersion: SCHEMA_VERSION,
    samples: [{ seq: 1, t: 0, x: 0, z: 0, heading: 0, speed: 0, steering: 0 }],
    events: []
  });
  assert.equal(missingDefinition.replayable, false);
  assert.equal(missingDefinition.state, null);
  assert.match(missingDefinition.diagnostics.join("\n"), /missing|invalid/);
});

test("TaskEngine freezes its normalized definition for the whole session", () => {
  let now = 0;
  const session = new CompetitionSession({
    taskId: "immutable-task",
    task: { type: "reach", goal: [10, 0], goalRadius: 0.1 },
    rules: { vehicleRadius: 0.1, roads: [{ id: "road-a", width: 4, points: [[0, 0], [10, 0]] }] }
  }, {}, { now: () => now });

  assert.equal(Object.isFrozen(session.taskEngine.config), true);
  assert.equal(Object.isFrozen(session.taskEngine.config.goal), true);
  assert.equal(Reflect.set(session.taskEngine.config.goal, 0, 0), false);
  const live = session.sample({ x: 0, z: 0, heading: 0, speed: 0, steering: 0 });
  assert.equal(live.task.finished, false);
  now = 100;
  const record = session.finish("program_finished");
  const replay = rejudgeTask(record);
  assert.equal(replay.replayable, true);
  assert.deepEqual(replay.state, session.taskEngine.snapshot());
});

test("CompetitionSession judges the exact canonical telemetry written to v2", () => {
  let now = 0;
  const session = new CompetitionSession({
    taskId: "canonical-boundary",
    task: { type: "reach", goal: [0, 0], goalRadius: 1 },
    rules: { vehicleRadius: 0.1, roads: [{ id: "road-a", width: 4, points: [[-2, 0], [2, 0]] }] }
  }, {}, { now: () => now, sampleIntervalMs: 100 });
  const live = session.sample({ x: 1.0000004, z: 0, heading: 0, speed: 0, steering: 0 });
  const record = live.record;
  const replay = rejudgeTask(record);

  assert.equal(record.samples[0].x, 1);
  assert.deepEqual(replay.state, session.taskEngine.snapshot());
  assert.equal(replay.replayable, true);

  now = 0;
  const timed = new CompetitionSession({
    taskId: "canonical-time",
    task: { type: "reach", goal: [0, 0], goalRadius: 0.5 },
    rules: { vehicleRadius: 0.1, roads: [{ id: "road-a", width: 4, points: [[0, 0], [2, 0]] }] }
  }, {}, { now: () => now, sampleIntervalMs: 100 });
  timed.sample({ x: 2, z: 0, heading: 0, speed: 0, steering: 0 });
  now = 100.4;
  const completed = timed.sample({ x: 0, z: 0, heading: 0, speed: 0, steering: 0 });
  const timedReplay = rejudgeTask(completed.record);
  assert.equal(completed.taskState.completedAtMs, 75.3);
  assert.deepEqual(timedReplay.state, timed.taskEngine.snapshot());
});

test("CompetitionSession records changed path vertices instead of judging a discarded chord", () => {
  let now = 0;
  const session = new CompetitionSession({
    taskId: "curved-path",
    task: { type: "reach", goal: [0, 0], goalRadius: 0.02 },
    rules: { vehicleRadius: 0.01, roads: [{ id: "road-a", width: 2, points: [[-1, 0], [1, 0]] }] }
  }, {}, { now: () => now, sampleIntervalMs: 100 });
  const sample = point => session.sample({ x: point[0], z: point[1], heading: 0, speed: 2.3, steering: 0 });
  sample([-0.08, 0]);
  now = 50;
  sample([0, 0.08]);
  now = 100;
  const result = sample([0.08, 0]);

  assert.equal(result.task.finished, false);
  assert.deepEqual(session.recorder.export().samples.map(item => item.t), [0, 50, 100]);
});

test("CompetitionSession rejects non-numeric task points before normalization", () => {
  [Number.NaN, Number.POSITIVE_INFINITY, null, "", false].forEach(value => {
    assert.throws(() => new CompetitionSession({
      taskId: "invalid-point",
      task: { type: "reach", goal: [value, 0], goalRadius: 1 },
      rules: { roads: [] }
    }), TypeError);
  });
});

test("CompetitionSession derives ordered task progress from accepted telemetry", () => {
  let now = 0;
  const task = makeCheckpointTask({ goal: [6, 0] });
  const session = new CompetitionSession({
    taskId: "automatic-task",
    task,
    mapId: "map-test",
    mapVersion: "1",
    ruleVersion: "1",
    rules: { vehicleRadius: 0.1, roads: [{ id: "road-a", width: 4, points: [[-1, 0], [7, 0]] }] }
  }, {}, { now: () => now, sampleIntervalMs: 100 });

  assert.equal(session.updateTask({ completed: 3, total: 3, finished: true }), false);
  assert.deepEqual(session.task, { completed: 0, total: 3, finished: false });
  session.sample(observation([0, 0], 0));
  now = 100;
  assert.equal(session.sample(observation([2, 0], now)).task.completed, 1);
  now = 200;
  assert.equal(session.sample(observation([4, 0], now)).task.completed, 2);
  now = 300;
  const completed = session.sample(observation([6, 0], now));
  assert.deepEqual(completed.task, { completed: 3, total: 3, finished: true });
  assert.deepEqual(completed.taskEvents.map(event => event.type), ["goal_reached", "task_completed"]);

  const record = session.finish("completed");
  assert.equal(record.result.taskFinished, true);
  assert.equal(record.result.taskScore, 25);
  assert.deepEqual(record.events.filter(event => event.type === "checkpoint").map(event => event.checkpointId), [
    "checkpoint-a",
    "checkpoint-b"
  ]);
  assert.deepEqual(
    record.events.filter(event => ["checkpoint", "goal_reached", "task_completed"].includes(event.type)).map(event => event.t),
    [87.5, 187.5, 287.5, 287.5],
    "recorded task events use the interpolated crossing time from the accepted sample segment"
  );
  assert.equal(record.events.some(event => event.type === "task_completed"), true);
  assert.equal(record.taskDefinition.type, "checkpoints");
});

test("CompetitionSession records enough package state to rejudge a delivery task", () => {
  let now = 0;
  const session = new CompetitionSession({
    taskId: "delivery-session",
    task: {
      id: "delivery-session",
      version: "1",
      type: "delivery",
      goal: [0, 0],
      deliveryRadius: 0.5,
      requiredPackageIds: ["box-a", "box-b"]
    },
    rules: { vehicleRadius: 0.1, roads: [{ id: "road-a", width: 8, points: [[-2, 0], [2, 0]] }] }
  }, {}, { now: () => now, sampleIntervalMs: 100 });
  const telemetry = packages => ({ x: 0, z: 0, heading: 0, speed: 0, steering: 0, packages });

  session.sample(telemetry([
    { id: "box-a", x: 0.1, z: 0 },
    { id: "box-b", x: 2, z: 0 }
  ]));
  now = 100;
  session.sample({
    ...telemetry([
      { id: "box-a", x: 0.1, z: 0 },
      { id: "box-b", x: 2, z: 0 }
    ]),
    holding: "box-a"
  });
  now = 200;
  session.sample(telemetry([
    { id: "box-a", x: 0.1, z: 0 },
    { id: "box-b", x: 0, z: 0.1 }
  ]));

  const record = session.finish("completed");
  const replay = rejudgeTask(record.taskDefinition, record);
  assert.deepEqual(replay.state, session.taskEngine.snapshot());
  assert.equal(replay.state.finished, true);
  assert.equal(record.samples.every(sample => Array.isArray(sample.packages)), true);
});

test("forced telemetry samples do not shift the regular 100ms cadence", () => {
  let now = 0;
  const recorder = new RunRecorder({}, { now: () => now, sampleIntervalMs: 100 });
  const telemetry = { x: 0, z: 0, heading: 0, speed: 0, steering: 0 };

  assert.equal(recorder.sample(telemetry), true);
  now = 50;
  assert.equal(recorder.sample(telemetry, true), true);
  now = 99;
  assert.equal(recorder.sample(telemetry), false);
  now = 100;
  assert.equal(recorder.sample(telemetry), true);
  now = 150;
  assert.equal(recorder.sample(telemetry, true), true);
  now = 199;
  assert.equal(recorder.sample(telemetry), false);
  now = 200;
  assert.equal(recorder.sample(telemetry), true);

  assert.deepEqual(recorder.export().samples.map(sample => sample.t), [0, 50, 100, 150, 200]);
});

test("CompetitionSession accepts completion before but not at the timeout boundary", () => {
  const makeSession = clock => new CompetitionSession({
    taskId: "deadline-task",
    timeLimitSeconds: 1,
    task: makeCheckpointTask({
      checkpoints: [{ id: "checkpoint-a", position: [1, 0] }],
      goal: [2, 0]
    }),
    rules: { vehicleRadius: 0.1, roads: [{ id: "road-a", width: 4, points: [[-1, 0], [3, 0]] }] }
  }, {}, { now: clock, sampleIntervalMs: 100 });

  let beforeNow = 0;
  const before = makeSession(() => beforeNow);
  before.sample(observation([0, 0], 0));
  beforeNow = 999;
  const accepted = before.sample(observation([2, 0], beforeNow));
  assert.equal(accepted.task.finished, true);
  beforeNow = 1000;
  assert.equal(before.finish("completed").result.reason, "completed");

  let boundaryNow = 0;
  const boundary = makeSession(() => boundaryNow);
  boundary.sample(observation([0, 0], 0));
  boundaryNow = 1000;
  const rejected = boundary.sample(observation([2, 0], boundaryNow));
  assert.equal(rejected.timedOut, true);
  assert.equal(rejected.record.result.taskFinished, false);
  assert.equal(rejected.record.events.some(event => event.type === "task_completed"), false);
  assert.equal(rejected.record.samples.length, 1);
});
