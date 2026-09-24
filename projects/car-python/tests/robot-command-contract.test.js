const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const worker = fs.readFileSync(path.join(root, "python-worker.js"), "utf8");
const planner = fs.readFileSync(path.join(root, "examples", "guangyang_adaptive_planner.py"), "utf8");
const directFullScore = fs.readFileSync(path.join(root, "examples", "guangyang_direct_integer_high_score.py"), "utf8");
const directChallenge2 = fs.readFileSync(path.join(root, "examples", "guangyang_challenge_2_direct_integer_high_score.py"), "utf8");
const directChallenge3 = fs.readFileSync(path.join(root, "examples", "guangyang_challenge_3_direct_integer_high_score.py"), "utf8");
const topologyPlanner = fs.readFileSync(path.join(root, "examples", "guangyang_topology_mission_planner.py"), "utf8");
const browserSmoke = fs.readFileSync(path.join(root, "tools", "browser-e2e.js"), "utf8");
const core = require("../competition-core.js");
const pixelCore = require("../vision-pixel-core.js");

function functionSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing production function ${name}`);
  const remaining = app.slice(start + 1);
  const nextDeclaration = /\n(?:async\s+)?function\s+/.exec(remaining);
  const next = nextDeclaration ? start + 1 + nextDeclaration.index : -1;
  return app.slice(start, next < 0 ? app.length : next);
}

test("Guangyang target and distractor are the same labeled package shape with color-only class styling", () => {
  const assets = functionSource("getPackageAssets");
  const model = functionSource("createPackageModel");
  assert.match(app, /guangyang:\s*\{[\s\S]*?packageVisual:\s*["']box["']/);
  assert.match(assets, /bodyGeometry\s*=\s*new THREE\.BoxGeometry\(PACKAGE_WIDTH,\s*PACKAGE_HEIGHT,\s*PACKAGE_DEPTH\)/);
  assert.match(assets, /targetBoxMaterial:[\s\S]*?["']#ef4444["']/);
  assert.match(assets, /distractorBoxMaterial:[\s\S]*?["']#3b82f6["']/);
  assert.match(assets, /frontTapeGeometry:\s*new THREE\.BoxGeometry\(0\.085,\s*0\.12,\s*0\.014\)/,
    "packing tape must not split the colored face into two detector regions");
  assert.match(model, /category\s*===\s*["']distractor["']\s*\?\s*assets\.distractorBoxMaterial\s*:\s*assets\.targetBoxMaterial/);
  assert.match(model, /new THREE\.Mesh\(assets\.bodyGeometry,\s*bodyMaterial\)/);
  ["topTapeGeometry", "frontTapeGeometry", "labelGeometry", "barcodeGeometry", "edgeGeometry"]
    .forEach(name => assert.match(model, new RegExp(`assets\\.${name}`), `missing shared ${name}`));
  assert.match(model, /attachObjectNameLabel\(group,\s*trainingVisionCategoryLabel\(category\),\s*0\.72\)/);
  assert.match(model, /group\.userData\.objectCategory\s*=\s*category/);
  assert.match(model, /group\.userData\.collisionRadius\s*=\s*Number\(record\.radius\)/);
  assert.match(functionSource("attachObjectNameLabel"), /createTextLabel\(/);
  assert.match(functionSource("createTextLabel"), /hideFromVirtualCamera\s*=\s*true/);

  const classes = new Map(pixelCore.DETECTOR_DEFINITION.classes.map(item => [item.category, item]));
  assert.equal(classes.get("target").physicalWidthMeters, 0.44);
  assert.equal(classes.get("distractor").physicalWidthMeters, 0.44);
  assert.deepEqual(pixelCore.QUERY_DEFINITION.categoryLabels,
    { target: "目标物", obstacle: "障碍物", distractor: "混淆物", "storage-zone": "存放点", "cleanup-zone": "清理点" });

  assert.match(browserSmoke, /near_observations\s*=\s*robot\.observe/,
    "real WebGL smoke must recapture the package after approach");
  assert.match(browserSmoke, /_NEAR_CATEGORY/);
  assert.match(browserSmoke, /nearDistance\s*<\s*initialDistance/,
    "real WebGL smoke must classify both packages at distinct medium/near distances");
});

test("automatic camera approach never exceeds the slowest frozen Guangyang speed limit", () => {
  const context = vm.createContext({});
  vm.runInContext(`${functionSource("approachActionSpeed")}\nglobalThis.approachActionSpeed = approachActionSpeed;`, context);
  const speeds = [
    context.approachActionSpeed({ near: true, distance: 1 }, "forward", 1),
    context.approachActionSpeed({ near: false, distance: 2.2 }, "forward", 1),
    context.approachActionSpeed({ near: false, distance: 5 }, "forward", 1)
  ];
  assert.deepEqual(speeds, [24, 28, 30]);
  assert.ok(speeds.every(speed => speed <= 30));
  const minimumLimit = Math.min(
    ...core.GUANGYANG_ISLAND_CONFIG.roads.map(road => road.speedLimit),
    ...core.GUANGYANG_ISLAND_CONFIG.speedZones.map(zone => zone.speedLimit)
  );
  assert.equal(2.5 * Math.max(...speeds) / 100, minimumLimit);
  assert.match(html, /robot\.approach[\s\S]*实际小步转向和前进/);
});

test("forward and backward accept one centimeter argument and produce an exact fixed-step distance plan", () => {
  const context = vm.createContext({});
  vm.runInContext(`
    const GUANGYANG_WORLD_UNITS_PER_METER = 8;
    let activeMission = null;
    ${functionSource("normalizeDriveDistanceCm")}
    ${functionSource("driveDistancePlan")}
    globalThis.setActiveMission = mission => { activeMission = mission; };
    globalThis.driveDistancePlan = driveDistancePlan;
  `, context);

  const ordinaryMission = {
    environment: "guangyang",
    competition: { enabled: true, config: structuredClone(core.GUANGYANG_ISLAND_CONFIG) }
  };
  const publishedMission = structuredClone(ordinaryMission);
  publishedMission.competition.config.mapVersion = "published-map-regression";
  publishedMission.publishedMapConfig = {
    revision: 7,
    digest: "a".repeat(64),
    mapVersion: "published-map-regression"
  };

  for (const mission of [ordinaryMission, publishedMission]) {
    context.setActiveMission(mission);
    const plan = context.driveDistancePlan(50);
    assert.equal(plan.requestedDistanceCm, 50);
    assert.equal(plan.durationMs, 3200);
    assert.equal(plan.speed, 1.25);
    assert.equal(plan.speedPercent, 50);

    const simulator = new core.DeterministicSimulator({
      schemaVersion: core.SIMULATION_SCHEMA_VERSION,
      stepMs: 20,
      seed: 50,
      initialPose: { x: 0, z: 0, heading: 0 },
      vehicle: {
        version: core.VEHICLE_MODEL_VERSION, radius: 0.44, collisionSkin: 0.005,
        maxLinearSpeed: 2.5, maxAngularSpeed: 2.8
      },
      world: { bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 }, colliders: [] }
    });
    simulator.runCommand({
      kind: "drive", direction: 1, durationMs: plan.durationMs, speed: plan.speed
    });
    const afterForward = simulator.snapshot().pose;
    const travelledWorldUnits = Math.hypot(afterForward.x, afterForward.z);
    assert.equal(travelledWorldUnits, 4,
      "50 cm on an 8-units/metre map must travel exactly 4 world units");
    assert.equal(travelledWorldUnits / core.GUANGYANG_ISLAND_CONFIG.rules.unitsPerMeter * 100, 50);

    simulator.runCommand({
      kind: "drive", direction: -1, durationMs: plan.durationMs, speed: plan.speed
    });
    assert.deepEqual(simulator.snapshot().pose, { x: 0, z: 0, heading: 0 },
      "forward(50) followed by backward(50) must return exactly to the start pose");
    assert.equal(simulator.travelDistance / core.GUANGYANG_ISLAND_CONFIG.rules.unitsPerMeter * 100, 100,
      "odometry must count both 50 cm legs");
  }

  context.setActiveMission(null);
  assert.equal(context.driveDistancePlan(50).durationMs, 3200,
    "the pre-run fallback must retain the Guangyang 5m by 3m scale");
  const minimumPlan = context.driveDistancePlan(0.1);
  assert.equal(minimumPlan.durationMs, 20);
  assert.match(functionSource("moveRobot"),
    /const totalMs = distancePlan\s*\? Number\(distancePlan\.durationMs\)/,
    "centimetre commands must not be stretched by the legacy timed-drive minimum");

  const minimumSimulator = new core.DeterministicSimulator({
    schemaVersion: core.SIMULATION_SCHEMA_VERSION,
    stepMs: 20,
    seed: 1,
    initialPose: { x: 0, z: 0, heading: 0 },
    vehicle: {
      version: core.VEHICLE_MODEL_VERSION, radius: 0.44, collisionSkin: 0.005,
      maxLinearSpeed: 2.5, maxAngularSpeed: 2.8
    },
    world: { bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 }, colliders: [] }
  });
  minimumSimulator.runCommand({
    kind: "drive", direction: -1,
    durationMs: minimumPlan.durationMs, speed: minimumPlan.speed
  });
  const minimumPose = minimumSimulator.snapshot().pose;
  const minimumTravelCm = Math.hypot(minimumPose.x, minimumPose.z)
    / core.GUANGYANG_ISLAND_CONFIG.rules.unitsPerMeter * 100;
  assert.equal(minimumTravelCm, 0.1,
    "the minimum backward request must travel 0.1 cm, not the former 0.4 cm");

  assert.match(worker, /async def forward\(self, distance_cm\):[\s\S]*?js_robot\.forward\(self\._centimeters\(distance_cm\)\)/);
  assert.match(worker, /async def backward\(self, distance_cm\):[\s\S]*?js_robot\.backward\(self\._centimeters\(distance_cm\)\)/);
  assert.doesNotMatch(worker, /async def (?:forward|backward)\(self, distance_cm,/);
});

test("automatic approach reaches the category-safe pickup distance before reporting success", () => {
  const context = vm.createContext({});
  vm.runInContext(`${functionSource("hasReachedApproachDistance")}\nglobalThis.hasReachedApproachDistance = hasReachedApproachDistance;`, context);
  assert.equal(context.hasReachedApproachDistance({
    distance: 1.25,
    minimumApproachDistance: 0.725,
    near: true
  }, 8), false, "a 100 cm search distance must not stop a grabbable object outside pickup range");
  assert.equal(context.hasReachedApproachDistance({
    category: "target",
    distance: 1.02,
    minimumApproachDistance: 0.725,
    near: true
  }, 8), true);
  assert.equal(context.hasReachedApproachDistance({
    distance: 7,
    minimumApproachDistance: null,
    near: false
  }, 8), true, "an obstacle without a category stop distance may use the requested distance");
});

test("the frozen lower-west junction boundary has a one-pulse, re-sensed compatibility recovery", () => {
  const road = core.GUANGYANG_ISLAND_CONFIG.roads.find(item => item.id === "lower-west");
  const [junctionPoint, startPoint] = road.points;
  const dx = junctionPoint[0] - startPoint[0];
  const dz = junctionPoint[1] - startPoint[1];
  const heading = Math.atan2(-dx, -dz);
  const simulator = new core.DeterministicSimulator({
    schemaVersion: "chenlong.simulation/v1",
    stepMs: 20,
    seed: 1,
    initialPose: { x: startPoint[0], z: startPoint[1], heading },
    vehicle: {
      version: "chenlong.vehicle/v1", radius: 0.44, collisionSkin: 0.005,
      maxLinearSpeed: 2.5, maxAngularSpeed: 2.8
    },
    world: { bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 }, colliders: [] }
  });
  const runner = new core.NavigationActionRunner(simulator, {
    rules: core.GUANGYANG_ISLAND_CONFIG.rules,
    navigationDefinition: core.PREVIOUS_CURRENT_NAVIGATION_DEFINITION,
    navigationControlDefinition: core.PREVIOUS_UNIT_NAVIGATION_CONTROL_DEFINITION
  });

  const followed = runner.run("follow_road", { maxCm: 500, speed: 30 });
  assert.equal(followed.stoppedBy, "junction");
  assert.equal(runner.roadState().atJunction, false,
    "this preserves the known frozen v1 replay boundary instead of silently changing core semantics");

  simulator.startCommand({ kind: "drive", direction: 1, durationMs: 80, speedPercent: 10 });
  while (simulator.hasActiveCommand()) simulator.step();
  const recovered = runner.roadState();
  assert.equal(recovered.atJunction, true);
  assert.equal(recovered.junctionId, "node:huangge-spur:start");
  assert.ok(recovered.exits.some(exit => exit.roadId === "huangge-spur"));
  const exited = runner.run("take_exit", { roadId: "huangge-spur" });
  assert.equal(exited.accepted, true);
  assert.equal(exited.stoppedBy, "entered_road");

  assert.match(html, /robot\.forward\(2\)[\s\S]*重新读取\s*<b>road_state\(\)<\/b>/);
  assert.match(html, /不要盲目循环前进/);
  assert.match(planner, /JUNCTION_NUDGE_CM\s*=\s*2/);
});

test("Python auto-await accepts both ordinary and explicitly awaited robot/navigation calls", () => {
  assert.match(app, /new Worker\("\.\/python-worker\.js\?v=\d{8}-\d{3}"\)/);
  assert.match(html, /<script src="\.\/app\.js\?v=\d{8}-\d{3}"><\/script>/,
    "the workbench script must keep an explicit cache version without coupling this contract to its value");
  assert.match(worker, /def visit_Await\(self, node\):/);
  assert.match(worker, /isinstance\(node\.value, ast\.Call\) and self\._should_await\(node\.value\)/);
  assert.match(worker, /isinstance\(node, \(ast\.FunctionDef, ast\.AsyncFunctionDef\)\)/);
  assert.match(worker, /async def follow_road\(self, max_cm=100, speed=40, obey_speed_limit=False\)/);
  assert.match(worker, /self\._boolean\(obey_speed_limit/);
  assert.match(worker, /async def take_exit\(self, road_id, speed=30, obey_speed_limit=False\)/);
  assert.match(worker, /async def approach\(self, target, distance_cm=None, max_steps=60\)/);
  assert.match(html, /运行器会自动等待每条小车指令完成[\s\S]*不需要手写\s*<b>await<\/b>/);
});

test("high-score examples clearly separate fixed driving from perception and planning", () => {
  for (const source of [directFullScore, directChallenge2, directChallenge3]) {
    assert.doesNotMatch(source,
      /robot\.(?:mission|task_state|release_preview|map_graph|road_state|odometry|observe|approach|follow_road|take_exit)\s*\(/);
    assert.match(source, /robot\.grab\(\)[\s\S]*robot\.release\(\)/);
    assert.doesNotMatch(source, /robot\.(?:left_angle|right_angle)\(\d+\.\d+/);
    assert.doesNotMatch(source, /robot\.(?:forward|backward)\([^\n)]*,/,
      "fixed-route driving must use one centimeter argument");
    for (const match of source.matchAll(/robot\.(?:forward|backward)\(([^)]+)\)/g)) {
      assert.match(match[1], /^\d+\.\d$/, "fixed-route driving distance must use one decimal place");
    }
  }
  assert.match(directFullScore, /robot\.forward\(15\.9\)/);

  for (const method of ["mission", "task_state", "release_preview", "map_graph", "road_state",
    "follow_road", "take_exit", "observe", "approach", "grab", "release", "holding"]) {
    assert.match(topologyPlanner, new RegExp(`robot\\.${method}\\s*\\(`), `topology planner misses ${method}`);
  }
  assert.match(topologyPlanner, /def dijkstra\(/);
  assert.doesNotMatch(topologyPlanner, /robot\.(?:forward|backward)\([^\n)]*,/,
    "the topology planner must not disguise a fixed coordinate route as planning");
});
