const DEFAULT_MAP_SIZE = 12;
const MAZE_MAP_SIZE = 32;
const PRIMARY_GUANGYANG_SCORING = globalThis.PrimaryGuangyangScoring;
if (!PRIMARY_GUANGYANG_SCORING) throw new Error("广阳岛评分规则没有加载，请刷新页面重试");
const PRIMARY_GUANGYANG_MAPS = globalThis.PrimaryGuangyangMaps;
if (!PRIMARY_GUANGYANG_MAPS) throw new Error("广阳岛地图配置没有加载，请刷新页面重试");
const PRIMARY_SCORE_SUMMARIES = globalThis.ChenlongAdminTeamScores;
if (!PRIMARY_SCORE_SUMMARIES) throw new Error("成绩汇总规则没有加载，请刷新页面重试");
const PRIMARY_GUANGYANG_MAP = Object.freeze({
  width: 40,
  depth: 24,
  source: Object.freeze({
    url: "./assets/guangyang-island.png",
    crop: Object.freeze({ x: 26, y: 24, width: 1295, height: 777 }),
    bakedVehiclePatch: Object.freeze({
      source: Object.freeze({ x: 607, y: 207, width: 80, height: 56 }),
      target: Object.freeze({ x: 687, y: 207, width: 80, height: 56 })
    })
  })
});
// 广阳岛底图上的立体摆件全部来自同一张公开底图的像素坐标。它们只负责
// 还原赛场观感，不参与碰撞、计分或积木编程规则。
const PRIMARY_GUANGYANG_RELIEF = Object.freeze({
  treeClusters: Object.freeze([
    [352, 66, 70, 30, 18, "green"], [485, 92, 58, 30, 14, "green"],
    [790, 112, 62, 48, 22, "green"], [1042, 52, 68, 23, 14, "light"],
    [1167, 88, 72, 38, 18, "light"], [1230, 152, 34, 62, 16, "green"],
    [188, 244, 78, 38, 20, "green"], [135, 307, 72, 38, 18, "green"],
    [274, 278, 34, 54, 12, "dark"], [990, 158, 46, 18, 12, "light"],
    [937, 211, 20, 38, 10, "green"], [1049, 210, 20, 38, 10, "light"],
    [995, 252, 48, 16, 12, "light"], [665, 301, 44, 25, 11, "green"],
    [790, 310, 45, 27, 12, "dark"], [730, 350, 72, 15, 12, "green"],
    [402, 303, 38, 23, 9, "green"], [515, 320, 27, 19, 7, "dark"],
    [383, 458, 32, 34, 10, "green"], [526, 476, 26, 34, 9, "light"],
    [455, 520, 56, 16, 11, "green"], [653, 456, 31, 37, 10, "green"],
    [803, 474, 27, 38, 10, "dark"], [735, 535, 58, 18, 13, "light"],
    [274, 548, 31, 64, 15, "green"], [302, 632, 38, 72, 17, "dark"],
    [337, 725, 47, 48, 14, "green"],
    [468, 772, 78, 23, 18, "light"], [905, 764, 76, 24, 17, "light"],
    [1082, 686, 96, 30, 18, "green"], [1186, 592, 38, 60, 13, "dark"],
    [428, 648, 52, 38, 17, "gold"]
  ]),
  buildings: Object.freeze([
    { anchor: [458, 134], size: [82, 25], height: 0.46, roof: "#6f9f92", wall: "#d9e5cf" },
    { anchor: [640, 102], size: [28, 38], height: 0.58 },
    { anchor: [704, 99], size: [62, 30], height: 0.52 },
    { anchor: [669, 158], size: [25, 48], height: 0.68 },
    { anchor: [746, 137], size: [25, 42], height: 0.61 },
    { anchor: [782, 130], size: [32, 28], height: 0.42 },
    { anchor: [1113, 58], size: [42, 42], height: 0.86, style: "pagoda" },
    { anchor: [1210, 176], size: [52, 28], height: 0.36, roof: "#537568" },
    { anchor: [1160, 235], size: [24, 18], height: 0.3, style: "tent" },
    { anchor: [1208, 305], size: [25, 20], height: 0.3, style: "tent" },
    { anchor: [1182, 352], size: [27, 20], height: 0.3, style: "tent" },
    { anchor: [676, 470], size: [28, 28], height: 0.4 },
    { anchor: [720, 465], size: [42, 30], height: 0.5 },
    { anchor: [778, 510], size: [34, 25], height: 0.38 },
    { anchor: [894, 635], size: [26, 22], height: 0.32, style: "tent" },
    { anchor: [930, 647], size: [30, 24], height: 0.36, roof: "#6f9f92" }
  ]),
  lakes: Object.freeze([[998, 214, 96, 60], [738, 325, 132, 45], [475, 482, 112, 43]]),
  fields: Object.freeze([[991, 386, 152, 60, "#f5d65c", 105], [1035, 535, 170, 86, "#eab5c7", 95]]),
  signs: Object.freeze([[592, 109, "P"], [649, 334, "↑"], [846, 309, "↱"], [237, 455, "↰"], [994, 745, "慢"]])
});
const primaryGuangyangImagePromises = new Map();
const PRIMARY_GUANGYANG_TASK_LEVELS = Object.freeze(Object.fromEntries(
  Object.entries(PRIMARY_GUANGYANG_MAPS.TASKS).map(([taskId, task]) => [task.level, Object.freeze({
    ...PRIMARY_GUANGYANG_MAPS.defaultLayout(taskId),
    checkpointLabels: task.checkpointLabels
  })])
));
const primaryPublishedMaps = new Map();
const MAX_PROGRAM_LOOP_ITERATIONS = 100;
const MAX_PROGRAM_PROCEDURE_CALLS = 1000;
const MAX_PROGRAM_PROCEDURE_DEPTH = 50;
const PRIMARY_WORLD_UNITS_PER_METER = 8;
const PRIMARY_CM_PER_WORLD_UNIT = 100 / PRIMARY_WORLD_UNITS_PER_METER;
const PRIMARY_DRIVE_WORLD_UNITS_PER_SECOND = 1.25;
const PRIMARY_DRIVE_CM_PER_SECOND = PRIMARY_DRIVE_WORLD_UNITS_PER_SECOND * PRIMARY_CM_PER_WORLD_UNIT;
const NAVIGATION_SENSOR_METHODS = Object.freeze(["odometry", "road_state", "map_graph", "mission", "task_state", "release_preview"]);
const ROAD_CONTROL_METHODS = Object.freeze(["follow_road", "take_exit"]);
const VISION_METHODS = Object.freeze(["sees", "count", "detect", "near", "centered", "direction", "distance_to", "approach", "observe"]);
const TRACKED_ROBOT_METHODS = new Set([...NAVIGATION_SENSOR_METHODS, ...ROAD_CONTROL_METHODS, ...VISION_METHODS]);
const REAL_ROBOT_UNSUPPORTED_METHODS = Object.freeze([
  ...NAVIGATION_SENSOR_METHODS,
  ...ROAD_CONTROL_METHODS,
  ...VISION_METHODS,
  "frontBlocked", "distance", "onRoad", "holding", "checkpointCount", "taskComplete",
  "checkFrontObstacle", "sensorField", "lastRoadResult"
]);
let primaryNavigationNetwork = null;

function realRobotUnsupportedMethodsInProgram(runtimeCode) {
  const code = String(runtimeCode || "");
  return REAL_ROBOT_UNSUPPORTED_METHODS.filter(method =>
    new RegExp(`\\brobot\\.${method}\\s*\\(`).test(code)
  );
}

function primaryWorldUnitsToCm(value) {
  return Number(value) * PRIMARY_CM_PER_WORLD_UNIT;
}

function primaryCmToWorldUnits(value) {
  return Number(value) / PRIMARY_CM_PER_WORLD_UNIT;
}
const MAZE_LAYOUT = [
  "S□□■□□□■□□□■□□□■",
  "■■□■■□□■■□□■■□□■",
  "□□□□■□□□□□□□■□□□",
  "□■■□■■■■■□■■■■□□",
  "□□□□□□■□□□□□□■□□",
  "■■■■■□■■■■■□■■■□",
  "□□□□□□□□□□■□□□□□",
  "□■■■□■■■■□■■■■■□",
  "□□□□□□□□□□□□□□□□",
  "□■■■■■□■■■■■□■■□",
  "□□□■□□□□□□□□□□■□",
  "■■□■■■■■■■■□■■■□",
  "□□□□□□□□□□□□□□□□",
  "□■■■■■■■□■■■■■□■",
  "□□□□□□□□□□□□□□□□",
  "■■■■■■■■■■■■■■□E"
];
const MAZE_CELL_SIZE = MAZE_MAP_SIZE / MAZE_LAYOUT.length;

const missions = {
  patrol: {
    title: "任务：巡逻送包裹",
    text: "从垃圾回收站出发，绕开障碍，把纸箱包裹送到快递站。",
    environment: "delivery",
    start: [-3, -3, 0],
    obstacles: [[-2, 1], [0, 2], [2, 0], [1, -2]],
    packages: [[-3, -2]],
    goal: [3, 2],
    completion: { type: "delivery", deliveryRadius: 0.95 }
  },
  campus: {
    title: "任务：校园配送",
    text: "从校门取走包裹，穿过花园步道并送到教学楼前的终点。",
    environment: "campus",
    start: [-4.2, 4, -Math.PI / 2],
    obstacles: [[-1.1, 3], [1.1, 1.7], [-1.1, 0.3], [1.1, -1.2], [-1.1, -2.7]],
    packages: [[-3.2, 4]],
    goal: [4.2, -4],
    completion: { type: "delivery", deliveryRadius: 0.95 }
  },
  warehouse: {
    title: "任务：仓库搬运",
    text: "取走货架入口的叠放纸箱，规划路线绕过货架，把货物送到出库区。",
    environment: "warehouse",
    start: [-4.2, 4, -Math.PI / 2],
    obstacles: [[-0.4, -3.7], [3.1, 0.8]],
    walls: [[-2.1, 0.2, 0.28, 4.4], [0.2, 2.1, 3.2, 0.28], [2.2, -1.2, 0.28, 4.1]],
    packages: [[-3.2, 4], [-3.2, 4]],
    goal: [4.2, -4],
    completion: { type: "delivery", deliveryRadius: 0.95 }
  },
  slalom: {
    title: "任务：S 弯绕桩",
    text: "沿蓝色引导路线连续转向，绕过五个路障并抵达计时终点。",
    environment: "training",
    start: [0, 4.6, 0],
    obstacles: [[-0.95, 2.7], [0.95, 1.35], [-0.95, 0], [0.95, -1.35], [-0.95, -2.7]],
    packages: [],
    goal: [0, -4.65],
    completion: { type: "checkpoints", checkpointSource: "guidePath", goalRadius: 0.82, checkpointRadius: 0.78 },
    guidePath: [[0, 4.6], [1.3, 2.7], [-1.3, 1.35], [1.3, 0], [-1.3, -1.35], [1.3, -2.7], [0, -4.65]]
  },
  harbor: {
    title: "任务：港口夜运",
    text: "从装卸区取走成堆包裹，在集装箱通道间穿行并送到绿色泊位。",
    environment: "harbor",
    start: [-4.2, 3.8, -Math.PI / 2],
    obstacles: [[-1.5, 2.5], [1.3, 1.1], [-1.3, -0.5], [1.5, -2.1]],
    packages: [[-3.2, 3.8], [-3.2, 3.8], [-3.2, 3.8]],
    goal: [4.2, -3.8],
    completion: { type: "delivery", deliveryRadius: 0.95 }
  },
  logisticsHub: {
    title: "大型任务：智慧物流中心",
    text: "在 32×32 大型仓库中取走三层货物，沿多条货架通道完成跨区配送。",
    environment: "warehouse",
    mapSize: 32,
    wallHeight: 0.82,
    start: [-14, 14, -Math.PI / 2],
    obstacles: [[-10, -6], [-5, 7], [0, -7], [5, 7], [11, -7]],
    walls: [[-8, 6, 0.5, 16], [-3, -6, 0.5, 16], [3, 6, 0.5, 16], [8, -6, 0.5, 16]],
    packages: [[-12.9, 14], [-12.9, 14], [-12.9, 14]],
    goal: [13, -13],
    completion: { type: "delivery", deliveryRadius: 1.05 },
    guidePath: [[-14, 14], [-14, 12], [-10, 12], [-10, -4], [-5, -4], [-5, 4], [0, 4], [0, -4], [5, -4], [5, 4], [9.5, 4], [9.5, -13], [13, -13]]
  },
  smartCity: {
    title: "大型任务：智慧城市巡检",
    text: "沿城市道路穿越九个街区，绕开临时路障，把巡检物资送到城市另一端。",
    environment: "city",
    mapSize: 32,
    wallHeight: 2.35,
    start: [-14, 14, -Math.PI / 2],
    obstacles: [[-4, 8], [4, 0], [-4, -8]],
    walls: [[-8, 8, 5, 5], [0, 8, 5, 5], [8, 8, 5, 5], [-8, 0, 5, 5], [0, 0, 5, 5], [8, 0, 5, 5], [-8, -8, 5, 5], [0, -8, 5, 5], [8, -8, 5, 5]],
    packages: [[-12.9, 14]],
    goal: [14, -14],
    completion: { type: "delivery", deliveryRadius: 1.05 },
    guidePath: [[-14, 14], [4, 14], [4, 4], [-4, 4], [-4, -4], [4, -4], [4, -14], [14, -14]]
  },
  canyonRescue: {
    title: "大型任务：峡谷救援",
    text: "携带救援物资穿过四道交错峡谷，利用任意角度转向寻找宽阔安全的路线。",
    environment: "canyon",
    mapSize: 32,
    wallHeight: 1.15,
    start: [-14, 14, 0],
    obstacles: [[8, 5], [-9, -1], [9, -7]],
    walls: [[-8, 8, 12, 1.2], [8, 8, 10, 1.2], [-9, 2, 10, 1.2], [6, 2, 16, 1.2], [-6, -4, 16, 1.2], [10, -4, 8, 1.2], [-9, -10, 10, 1.2], [6, -10, 16, 1.2]],
    packages: [[-14, 12.9]],
    goal: [13, -14],
    completion: { type: "delivery", deliveryRadius: 1.05 },
    guidePath: [[-14, 14], [0, 14], [0, 6], [-3, 6], [-3, 0], [4, 0], [4, -6], [-3, -6], [-3, -12], [13, -12], [13, -14]]
  },
  maze: {
    title: "任务：避障迷宫",
    text: "从左上角木板墙入口出发，借助距离传感器穿过导航信标，抵达右下角出口星标。",
    theme: "maze",
    environment: "maze",
    wallHeight: 1.08,
    start: findMazePose("S"),
    obstacles: [],
    packages: [],
    goal: findMazePoint("E"),
    completion: { type: "checkpoints", goalRadius: 0.9, checkpointRadius: 0.78 },
    guidePath: [],
    walls: createMazeWallsFromLayout(MAZE_LAYOUT)
  },
  free: {
    title: "任务：自由练习",
    text: "点击模拟器工具按钮，再点地图格子，就能连续摆放并堆叠包裹。",
    environment: "sandbox",
    obstacles: [[0, 1]],
    packages: [[-2, 0]],
    goal: [2, 0],
    completion: { type: "auto", deliveryRadius: 0.95, goalRadius: 0.82 }
  },
  guangyang1: createPrimaryGuangyangMission(1),
  guangyang2: createPrimaryGuangyangMission(2),
  guangyang3: createPrimaryGuangyangMission(3)
};

function createPrimaryGuangyangMission(level, publishedMap = null) {
  const taskId = `GYI-PRIMARY-0${level}`;
  const taskDefinition = PRIMARY_GUANGYANG_MAPS.TASKS[taskId] || PRIMARY_GUANGYANG_MAPS.TASKS["GYI-PRIMARY-01"];
  const task = publishedMap?.layout
    ? { ...PRIMARY_GUANGYANG_MAPS.normalizeLayout(taskId, publishedMap.layout), checkpointLabels: taskDefinition.checkpointLabels }
    : PRIMARY_GUANGYANG_TASK_LEVELS[level] || PRIMARY_GUANGYANG_TASK_LEVELS[1];
  const start = primaryGuangyangPixelToWorld(593, 164);
  const storage = [...task.storage];
  const checkpoints = task.checkpoints.map(point => [...point]);
  const targets = task.targets.map(point => [...point]);
  const distractors = task.distractors.map(point => [...point]);
  const obstacles = task.obstacles.map(point => [...point]);
  const packages = [
    ...targets.map(([x, z], index) => ({ id: `${taskId}-target-${index + 1}`, role: "target", x, z })),
    ...distractors.map(([x, z], index) => ({ id: `${taskId}-distractor-${index + 1}`, role: "distractor", x, z }))
  ];
  return {
    taskId,
    mapRevision: Number.isInteger(publishedMap?.revision) ? publishedMap.revision : null,
    mapDigest: typeof publishedMap?.digest === "string" ? publishedMap.digest : null,
    title: `广阳岛综合任务${level}`,
    text: `${targets.length} 个目标物、${distractors.length} 个混淆物、${obstacles.length} 个岩石障碍物；按顺序经过 ${checkpoints.length} 个途径点后返回停车区。`,
    environment: "guangyang",
    mapStyle: "basic",
    mapSize: PRIMARY_GUANGYANG_MAP.width,
    start: [start[0], start[1], Math.PI],
    obstacles,
    packages,
    landmarks: { targets, distractors, storage },
    checkpointLabels: [...task.checkpointLabels],
    goal: [...start],
    showGuidePath: false,
    completion: {
      type: "composite",
      checkpointSource: "guidePath",
      goalRadius: 1.05,
      checkpointRadius: 1.05,
      deliveryRadius: 0.95,
      packageRadius: 0.28,
      minimumRoadEdgeClearance: 0.2
    },
    guidePath: [[...start], ...checkpoints, [...start]]
  };
}

function mazeCellCenter(row, col) {
  const half = MAZE_MAP_SIZE / 2;
  return [
    -half + MAZE_CELL_SIZE / 2 + col * MAZE_CELL_SIZE,
    -half + MAZE_CELL_SIZE / 2 + row * MAZE_CELL_SIZE
  ];
}

function findMazePoint(symbol) {
  for (let row = 0; row < MAZE_LAYOUT.length; row++) {
    const col = [...MAZE_LAYOUT[row]].indexOf(symbol);
    if (col >= 0) return mazeCellCenter(row, col);
  }
  return [0, 0];
}

function findMazePose(symbol) {
  const [x, z] = findMazePoint(symbol);
  return [x, z, -Math.PI / 2];
}

function createMazeWallsFromLayout(layout) {
  const walls = [];
  layout.forEach((line, row) => {
    const cells = [...line];
    let col = 0;
    while (col < cells.length) {
      if (cells[col] !== "■") {
        col += 1;
        continue;
      }
      const startCol = col;
      while (col + 1 < cells.length && cells[col + 1] === "■") col += 1;
      const endCol = col;
      const [startX, z] = mazeCellCenter(row, startCol);
      const [endX] = mazeCellCenter(row, endCol);
      walls.push([
        (startX + endX) / 2,
        z,
        (endCol - startCol + 1) * MAZE_CELL_SIZE - MAZE_CELL_SIZE * 0.18,
        MAZE_CELL_SIZE * 0.82
      ]);
      col += 1;
    }
  });
  return walls;
}

function createMazeSolutionPath(layout) {
  const cells = layout.map(line => [...line]);
  let start = null;
  let end = null;
  cells.forEach((row, rowIndex) => row.forEach((cell, colIndex) => {
    if (cell === "S") start = [rowIndex, colIndex];
    if (cell === "E") end = [rowIndex, colIndex];
  }));
  if (!start || !end) return [];

  const queue = [start];
  const previous = new Map([[start.join(","), null]]);
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let index = 0; index < queue.length; index++) {
    const [row, col] = queue[index];
    if (row === end[0] && col === end[1]) break;
    directions.forEach(([rowStep, colStep]) => {
      const nextRow = row + rowStep;
      const nextCol = col + colStep;
      const key = `${nextRow},${nextCol}`;
      if (nextRow < 0 || nextRow >= cells.length || nextCol < 0 || nextCol >= cells[nextRow].length) return;
      if (cells[nextRow][nextCol] === "■" || previous.has(key)) return;
      previous.set(key, [row, col]);
      queue.push([nextRow, nextCol]);
    });
  }
  if (!previous.has(end.join(","))) return [];

  const path = [];
  for (let cursor = end; cursor; cursor = previous.get(cursor.join(","))) path.push(cursor);
  return path.reverse().map(([row, col]) => mazeCellCenter(row, col));
}

let workspace;
let scene;
let camera;
let renderer;
let robotGroup;
let raycaster;
let gridPlane;
let floorMesh;
let floorBaseMesh;
let gridHelper;
let runToken = 0;
let activeRun = null;
let runControlBusy = false;
let realStopHazard = false;
let realStopPromise = null;
let realStopPending = false;
let activeRealCameraBaseUrl = null;
let realCameraGeneration = 0;
let highlightedBlockId = null;
let actionCount = 0;
let programEffectCount = 0;
let runtimeFeedbackToken = 0;
let runtimeFeedbackTimer = 0;
let blockedMoveCount = 0;
let primaryBlockedMoveCount = 0;
let primaryOffRoadEpisodes = 0;
let primaryOffRoadDurationMs = 0;
let primaryOffRoadActive = false;
let lastMoveBlocked = false;
let placeMode = null;
let robotPose = { x: -3, z: -3, heading: 0 };
let obstacleMeshes = [];
let markerMeshes = [];
let missionWallMeshes = [];
let missionWallColliders = [];
let missionDecorationMeshes = [];
let primaryGuangyangReliefRoot = null;
let primaryGuangyangTerrainMesh = null;
let missionBuildGeneration = 0;
let missionCheckpointPositions = [];
let missionAttempt = null;
let missionBaseline = null;
let packageMeshes = [];
let heldPackageId = null;
let heldPackageMesh = null;
let packageAssetCache = null;
let packageIdCounter = 0;
let robotArm = null;
let robotClaw = null;
let robotWheels = [];
let trajectoryLine = null;
let trajectoryHead = null;
let trajectoryPoints = [];
let trajectoryTotalDistance = 0;
let trajectoryPositionAttribute = null;
let cameraMode = "iso";
let orbitYaw = -Math.PI / 4;
let orbitPitch = 0.86;
let orbitDistance = 13.2;
const orbitTarget = new THREE.Vector3();
const followCameraDesired = new THREE.Vector3();
const followLookDesired = new THREE.Vector3();
const followLookCurrent = new THREE.Vector3();
let orbitFollowsRobotTarget = false;
let isOrbitDragging = false;
let lastPointer = { x: 0, y: 0 };
let competitionMeshes = [];
let boundaryMeshes = [];
let boundaryColliders = [];
let competitionWallColliders = [];
let roadLineMeshes = [];
let competitionRoadMeshes = [];
let robotCollisionShapes = [];
let goalPulseEffects = [];
let mazeSignalEffects = [];
let sceneShadowDirty = true;
let lastSceneMotionAt = -Infinity;
let lastRobotTelemetryAt = -Infinity;
let lastRenderAt = -Infinity;
let renderedFramesInWindow = 0;
let renderStatsWindowStartedAt = 0;
let renderedFps = 0;
let shadowUpdateCount = 0;
let rendererWidth = 0;
let rendererHeight = 0;
let rendererPixelRatio = 0;
let scheduledResizeFrame = 0;
const directionVectorScratch = { x: 0, z: -1 };
let activeMission = structuredClone(missions.guangyang1);
let currentMapStyle = "basic";
const ROBOT_RADIUS = 0.44;
const BLOCK_RADIUS = 0.52;
const PACKAGE_RADIUS = 0.28;
const PACKAGE_WIDTH = 0.42;
const PACKAGE_HEIGHT = 0.34;
const PACKAGE_DEPTH = 0.38;
const PACKAGE_BASE_Y = 0.18;
const PACKAGE_STACK_STEP = 0.35;
const PACKAGE_STACK_SNAP_DISTANCE = 0.62;
const MAP_SIZE = DEFAULT_MAP_SIZE;
const MAP_HALF = MAP_SIZE / 2;
const MAP_INNER = MAP_HALF - ROBOT_RADIUS;
const TRAJECTORY_MAX_DISTANCE = 30;
const TRAJECTORY_WIDTH = 0.08;
const TRAJECTORY_POINT_SPACING = 0.07;
const TRAJECTORY_MAX_POINTS = Math.ceil(TRAJECTORY_MAX_DISTANCE / TRAJECTORY_POINT_SPACING) + 2;
const ROBOT_TELEMETRY_INTERVAL_MS = 100;
const ACTIVE_RENDER_FPS = 45;
const IDLE_RENDER_FPS = 24;
const FRONT_BLOCKED_DISTANCE = 0.75;
const SENSOR_DISPLAY_MAX_CM = 500;
const PHYSICS_EPSILON = 1e-9;
const MOVE_COLLISION_SKIN = 0.005;
const MAX_SAVED_OBSTACLES = 500;
const MAX_SAVED_WALLS = 500;
const MAX_SAVED_PACKAGES = 200;
const MAX_SAVED_GUIDE_POINTS = 2000;
const REAL_GRAB_DURATION_MS = 6000;
const REAL_RELEASE_DURATION_MS = 2000;
const REAL_TURN_SECONDS_PER_90 = Object.freeze({ left: 0.5, right: 0.5 });
const COMPETITION_ZONES = [
  { label: "垃圾回收站", x: -2.8, z: 2.4, w: 1.6, h: 1.2, color: "#8bd36f", lx: -3.05, lz: 3.06 },
  { label: "花园", x: -3.35, z: -3.35, w: 1.7, h: 1.1, color: "#9be98f", lx: -3.74, lz: -3.98 },
  { label: "快递站", x: 2.7, z: -2.45, w: 1.5, h: 1.1, color: "#8dd3ff", lx: 2.96, lz: -3.08 },
  { label: "超市", x: 2.25, z: 1.95, w: 1.7, h: 1.25, color: "#b9f0a8", lx: 2.8, lz: 2.67 }
];
const COMPETITION_FIXED_WALLS = [
  { x: -2.75, z: 1.42, w: 1.45, h: 0.06 },
  { x: 2.68, z: -1.52, w: 1.35, h: 0.06 },
  { x: 1.05, z: 2.65, w: 0.06, h: 1.25 }
];

function currentMapSize() {
  const configuredSize = Number(activeMission?.mapSize);
  if (Number.isFinite(configuredSize)) return Math.max(MAP_SIZE, Math.min(40, configuredSize));
  return activeMission?.theme === "maze" ? MAZE_MAP_SIZE : MAP_SIZE;
}

function currentMapWidth() {
  return activeMission?.environment === "guangyang" ? PRIMARY_GUANGYANG_MAP.width : currentMapSize();
}

function currentMapDepth() {
  return activeMission?.environment === "guangyang" ? PRIMARY_GUANGYANG_MAP.depth : currentMapSize();
}

function isLargeMap() {
  return currentMapSize() > MAP_SIZE + 0.1;
}

function currentMapHalf() {
  return currentMapSize() / 2;
}

function currentMapInner() {
  return currentMapHalf() - ROBOT_RADIUS;
}

function createPackageId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  packageIdCounter += 1;
  return `package-${Date.now()}-${packageIdCounter}`;
}

function normalizePackageRecords(source = {}) {
  let rawPackages = [];
  if (Array.isArray(source.packages)) {
    const looksLikeSinglePosition = source.packages.length >= 2
      && !Array.isArray(source.packages[0])
      && typeof source.packages[0] !== "object";
    rawPackages = looksLikeSinglePosition ? [source.packages] : source.packages;
  } else if (Array.isArray(source.package)) {
    rawPackages = [source.package];
  }

  const usedIds = new Set();
  return rawPackages.flatMap(raw => {
    const x = Number(Array.isArray(raw) ? raw[0] : raw?.x);
    const z = Number(Array.isArray(raw) ? raw[1] : raw?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return [];
    let id = !Array.isArray(raw) && raw?.id ? String(raw.id) : createPackageId();
    if (usedIds.has(id)) id = createPackageId();
    usedIds.add(id);
    const role = !Array.isArray(raw) && ["target", "distractor"].includes(raw?.role) ? raw.role : null;
    return [{ id, x, z, ...(role ? { role } : {}) }];
  });
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeMapPoint(value, halfSize, length = 2) {
  if (!Array.isArray(value) || value.length < length) return null;
  const numbers = value.slice(0, length).map(item => Number(item));
  if (!numbers.every(Number.isFinite)) return null;
  if (Math.abs(numbers[0]) > halfSize || Math.abs(numbers[1]) > halfSize) return null;
  return numbers;
}

function normalizeSavedMissionPayload(payload = {}) {
  const defaultMapSize = payload.theme === "maze" ? MAZE_MAP_SIZE : MAP_SIZE;
  const requestedMapSize = finiteNumber(payload.mapSize, defaultMapSize);
  const mapSize = Math.max(MAP_SIZE, Math.min(40, requestedMapSize));
  const halfSize = mapSize / 2;
  let obstacles = Array.isArray(payload.obstacles)
    ? payload.obstacles.slice(0, MAX_SAVED_OBSTACLES).map(point => normalizeMapPoint(point, halfSize)).filter(Boolean)
    : [];
  let walls = Array.isArray(payload.walls)
    ? payload.walls.slice(0, MAX_SAVED_WALLS).flatMap(wall => {
        const center = normalizeMapPoint(wall, halfSize);
        const width = finiteNumber(wall?.[2]);
        const height = finiteNumber(wall?.[3]);
        if (!center || width == null || height == null || width <= 0 || height <= 0) return [];
        return [[center[0], center[1], Math.min(width, mapSize * 2), Math.min(height, mapSize * 2)]];
      })
    : [];
  if (payload.theme === "maze") {
    const protectedRoute = createMazeSolutionPath(MAZE_LAYOUT);
    obstacles = obstacles.filter(([x, z]) => !protectedRoute.some(([routeX, routeZ]) =>
      circleOverlapsCircle(routeX, routeZ, ROBOT_RADIUS + 0.08, x, z, BLOCK_RADIUS)
    ));
    walls = walls.filter(([x, z, w, h]) => !protectedRoute.some(([routeX, routeZ]) =>
      circleHitsRect(routeX, routeZ, ROBOT_RADIUS + 0.08, { x, z, w, h })
    ));
  }
  const limitedPackageSource = Array.isArray(payload.packages)
    ? { ...payload, packages: payload.packages.slice(0, MAX_SAVED_PACKAGES) }
    : payload;
  const packages = normalizePackageRecords(limitedPackageSource).filter(record =>
    Math.abs(record.x) <= halfSize && Math.abs(record.z) <= halfSize
  );
  const startPoint = normalizeMapPoint(payload.start, halfSize, 2);
  const startHeading = finiteNumber(payload.start?.[2], 0);
  const completion = payload.completion && typeof payload.completion === "object"
    ? structuredClone(payload.completion)
    : { type: "auto" };
  return {
    obstacles,
    walls,
    packages,
    goal: normalizeMapPoint(payload.goal, halfSize),
    start: startPoint ? [startPoint[0], startPoint[1], startHeading] : null,
    guidePath: Array.isArray(payload.guidePath)
      ? payload.guidePath.slice(0, MAX_SAVED_GUIDE_POINTS).map(point => normalizeMapPoint(point, halfSize)).filter(Boolean)
      : [],
    mapSize,
    wallHeight: Math.max(0.1, Math.min(6, finiteNumber(payload.wallHeight, payload.theme === "maze" ? 1.08 : 0.82))),
    completion
  };
}

function ensureMissionPackages() {
  activeMission.packages = normalizePackageRecords(activeMission);
  return activeMission.packages;
}

function packageStackKey(x, z) {
  return `${Number(x).toFixed(3)}:${Number(z).toFixed(3)}`;
}

function packageStackLevelForIndex(packages, index) {
  const current = packages[index];
  if (!current) return 0;
  const key = packageStackKey(current.x, current.z);
  let level = 0;
  for (let i = 0; i < index; i++) {
    if (packageStackKey(packages[i].x, packages[i].z) === key) level += 1;
  }
  return level;
}

function isHoldingPackage() {
  return Boolean(heldPackageId && heldPackageMesh);
}

const codeOutput = document.querySelector("#codeOutput");
const codePanel = document.querySelector("#codePanel");
const toggleCodeButton = document.querySelector("#toggleCodeButton");
const appShell = document.querySelector(".app-shell");
const workspaceGrid = document.querySelector(".workspace-grid");
const workspaceSplitter = document.querySelector("#workspaceSplitter");
const centerBlocksButton = document.querySelector("#centerBlocksButton");
const zoomInBlocksButton = document.querySelector("#zoomInBlocksButton");
const zoomOutBlocksButton = document.querySelector("#zoomOutBlocksButton");
const deleteBlocksButton = document.querySelector("#deleteBlocksButton");
const sidePanel = document.querySelector(".side-panel");
const stateSceneSplitter = document.querySelector("#stateSceneSplitter");
const statusText = document.querySelector("#statusText");
const distanceText = document.querySelector("#distanceText");
const simulator = document.querySelector("#simulator");
const runtimeFeedback = document.querySelector("#runtimeFeedback");
const runtimeFeedbackLabel = document.querySelector("#runtimeFeedbackLabel");
const runtimeFeedbackValue = document.querySelector("#runtimeFeedbackValue");
const runButton = document.querySelector("#runButton");
const pauseButton = document.querySelector("#pauseButton");
const stopButton = document.querySelector("#stopButton");
const resetButton = document.querySelector("#resetButton");
const targetSelect = document.querySelector("#targetSelect");
const robotBaseUrlInput = document.querySelector("#robotBaseUrl");
const applyRobotIpButton = document.querySelector("#applyRobotIpButton");
const protocolToggle = document.querySelector("#protocolToggle");
const realCameraStage = document.querySelector("#realCameraStage");
const cameraStream = document.querySelector("#cameraStream");
const cameraStatus = document.querySelector("#cameraStatus");
const retryCameraButton = document.querySelector("#retryCameraButton");
const accountName = document.querySelector("#accountName");
const recordsButton = document.querySelector("#recordsButton");
const teamInviteButton = document.querySelector("#teamInviteButton");
const adminButton = document.querySelector("#adminButton");
const loginButton = document.querySelector("#loginButton");
const logoutButton = document.querySelector("#logoutButton");
const authDialog = document.querySelector("#authDialog");
const authUsername = document.querySelector("#authUsername");
const authDisplayName = document.querySelector("#authDisplayName");
const authPassword = document.querySelector("#authPassword");
const authMessage = document.querySelector("#authMessage");
const registerButton = document.querySelector("#registerButton");
const submitLoginButton = document.querySelector("#submitLoginButton");
const closeAuthButton = document.querySelector("#closeAuthButton");
const recordsDialog = document.querySelector("#recordsDialog");
const recordsSummary = document.querySelector("#recordsSummary");
const recordsList = document.querySelector("#recordsList");
const primaryTaskHighScores = document.querySelector("#primaryTaskHighScores");
const primaryRecordsPageInfo = document.querySelector("#primaryRecordsPageInfo");
const primaryRecordsPrevious = document.querySelector("#primaryRecordsPrevious");
const primaryRecordsNext = document.querySelector("#primaryRecordsNext");
const closeRecordsButton = document.querySelector("#closeRecordsButton");
const primaryTeamDialog = document.querySelector("#primaryTeamDialog");
const primaryTeamDialogText = document.querySelector("#primaryTeamDialogText");
const primaryTeamInviteCode = document.querySelector("#primaryTeamInviteCode");
const primaryTeamCopyStatus = document.querySelector("#primaryTeamCopyStatus");
const copyPrimaryTeamInviteButton = document.querySelector("#copyPrimaryTeamInviteButton");
const closePrimaryTeamDialogButton = document.querySelector("#closePrimaryTeamDialogButton");
let primaryUser = null;
let primaryRunStartedAt = 0;
let primaryRunElapsedMs = 0;
let lastPrimaryScoreClockRenderAt = 0;
let primaryRecordPage = 1;
let primaryRecordCache = [];
const PRIMARY_RECORD_PAGE_SIZE = 20;

function getRobotProtocol() {
  return localStorage.getItem("chenlongRobotProtocol") === "https" ? "https" : "http";
}

function setRobotProtocol(protocol) {
  localStorage.setItem("chenlongRobotProtocol", protocol);
  if (protocolToggle) {
    protocolToggle.querySelectorAll(".protocol-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.protocol === protocol);
    });
  }
}
const scenePanelTitleText = document.querySelector(".scene-title > span");
const mapStyleSelect = document.querySelector("#mapStyleSelect");
const savedMapMenu = document.querySelector("#savedMapMenu");
const savedMapButton = document.querySelector("#savedMapButton");
const savedMapButtonText = document.querySelector("#savedMapButtonText");
const savedMapDropdown = document.querySelector("#savedMapDropdown");
const sceneTools = document.querySelector("#sceneTools");
const toggleSceneTools = document.querySelector("#toggleSceneTools");
const poseText = document.querySelector("#poseText");
const headingText = document.querySelector("#headingText");
const gripperText = document.querySelector("#gripperText");
const frontText = document.querySelector("#frontText");
const actionLog = document.querySelector("#actionLog");
const workspaceSaveStatus = document.querySelector("#workspaceSaveStatus");
const missionCard = document.querySelector(".mission-card");
const missionCardToggle = document.querySelector("#missionCardToggle");
const missionCardBody = document.querySelector("#missionCardBody");
const missionProgressLabel = document.querySelector("#missionProgressLabel");
const missionProgressValue = document.querySelector("#missionProgressValue");
const missionProgressBar = document.querySelector("#missionProgressBar");
const missionProgressHint = document.querySelector("#missionProgressHint");
const primaryScoreHud = document.querySelector("#primaryScoreHud");
const primaryScoreValue = document.querySelector("#primaryScoreValue");
const primaryScoreToggle = document.querySelector("#primaryScoreToggle");
const primaryScoreBody = document.querySelector("#primaryScoreBody");
const primaryScoreRunState = document.querySelector("#primaryScoreRunState");
const primaryScoreTimer = document.querySelector("#primaryScoreTimer");
const primaryScoreHint = document.querySelector("#primaryScoreHint");
const primaryScoreProgress = document.querySelector("#primaryScoreProgress");
const primaryTaskScore = document.querySelector("#primaryTaskScore");
const primaryRuleScore = document.querySelector("#primaryRuleScore");
const primaryAutonomousScore = document.querySelector("#primaryAutonomousScore");
const primaryEfficiencyScore = document.querySelector("#primaryEfficiencyScore");
let resizingWorkspace = false;
let resizingStateScene = false;
let logCounter = 0;
let selectedSavedMapId = "";

function renderMissionInfo() {
  const missionTitle = document.querySelector("#missionTitle");
  const missionText = document.querySelector("#missionText");
  if (missionTitle) missionTitle.textContent = activeMission.title || "任务：自定义地图";
  if (missionText) missionText.textContent = activeMission.text || "使用积木控制小车完成场景目标。";
}

function primaryScoreSnapshot() {
  const checkpointTotal = Math.max(1, missionAttempt?.checkpointPoints?.length || 3);
  const checkpoints = Math.max(0, Math.min(checkpointTotal, Number(missionAttempt?.nextCheckpointIndex) || 0));
  const taskProgress = missionProgressSnapshot();
  const hasStarted = primaryRunStartedAt > 0;
  const elapsedMs = hasStarted
    ? activeRun ? Math.max(0, Date.now() - primaryRunStartedAt) : primaryRunElapsedMs
    : 0;
  const score = PRIMARY_GUANGYANG_SCORING.scoreRun({
    completed: Boolean(missionAttempt?.completed),
    checkpointCount: checkpoints,
    checkpointTotal,
    taskCompleted: taskProgress.completed,
    taskTotal: taskProgress.total,
    collisionCount: primaryBlockedMoveCount,
    offRoadEpisodes: primaryOffRoadEpisodes,
    offRoadDurationMs: primaryOffRoadDurationMs,
    durationMs: elapsedMs
  });
  return {
    hasStarted,
    running: Boolean(activeRun),
    elapsedMs,
    checkpoints,
    checkpointTotal,
    taskCompleted: score.taskCompleted,
    taskTotal: score.taskTotal,
    taskScore: score.task,
    ruleScore: score.rule,
    autonomousScore: score.autonomous,
    efficiencyScore: score.efficiency,
    total: hasStarted ? score.total : null,
    hint: primaryOffRoadActive
      ? `小车已驶出道路，本次已记录 ${primaryOffRoadEpisodes} 次越界`
      : !hasStarted
      ? "运行程序后开始评测"
      : missionAttempt?.completed
      ? "任务完成，成绩已保存"
      : taskProgress.hint
  };
}

function formatPrimaryElapsedTime(milliseconds) {
  const tenths = Math.max(0, Math.floor(Number(milliseconds || 0) / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor(tenths / 10) % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
}

function renderPrimaryScore() {
  if (!primaryScoreHud) return;
  const score = primaryScoreSnapshot();
  if (primaryScoreValue) primaryScoreValue.textContent = score.total === null ? "--" : String(score.total);
  if (primaryScoreRunState) primaryScoreRunState.textContent = score.running
    ? "正在评测"
    : score.hasStarted ? missionAttempt?.completed ? "任务完成" : "本次运行结束" : "等待运行";
  if (primaryScoreTimer) primaryScoreTimer.textContent = formatPrimaryElapsedTime(score.elapsedMs);
  if (primaryScoreHint) primaryScoreHint.textContent = score.hint;
  if (primaryScoreProgress) primaryScoreProgress.textContent = `${score.taskCompleted}/${score.taskTotal}`;
  if (primaryTaskScore) primaryTaskScore.textContent = String(score.taskScore);
  if (primaryRuleScore) primaryRuleScore.textContent = String(score.ruleScore);
  if (primaryAutonomousScore) primaryAutonomousScore.textContent = String(score.autonomousScore);
  if (primaryEfficiencyScore) primaryEfficiencyScore.textContent = String(score.efficiencyScore);
  primaryScoreHud.classList.toggle("is-complete", Boolean(missionAttempt?.completed));
}

function setPrimaryScoreExpanded(expanded, { persist = true } = {}) {
  if (!primaryScoreToggle || !primaryScoreBody) return;
  const isExpanded = Boolean(expanded);
  primaryScoreToggle.setAttribute("aria-expanded", String(isExpanded));
  const label = primaryScoreToggle.querySelector("span");
  if (label) label.textContent = isExpanded ? "收起详情" : "展开详情";
  primaryScoreBody.hidden = !isExpanded;
  primaryScoreBody.inert = !isExpanded;
  if (persist) {
    try { localStorage.setItem("chenlongPrimaryScoreExpanded", isExpanded ? "1" : "0"); } catch {}
  }
}

function initPrimaryScoreToggle() {
  if (!primaryScoreToggle || !primaryScoreBody) return;
  let expanded = false;
  try { expanded = localStorage.getItem("chenlongPrimaryScoreExpanded") === "1"; } catch {}
  setPrimaryScoreExpanded(expanded, { persist: false });
  primaryScoreToggle.addEventListener("click", () => {
    setPrimaryScoreExpanded(primaryScoreToggle.getAttribute("aria-expanded") !== "true");
  });
}

function setMissionCardCollapsed(collapsed, { persist = true } = {}) {
  if (!missionCard || !missionCardToggle || !missionCardBody) return;
  const isCollapsed = Boolean(collapsed);
  const actionLabel = isCollapsed ? "展开当前任务" : "收起当前任务";
  missionCard.classList.toggle("is-collapsed", isCollapsed);
  missionCardToggle.setAttribute("aria-expanded", String(!isCollapsed));
  missionCardToggle.setAttribute("aria-label", actionLabel);
  missionCardToggle.title = actionLabel;
  missionCardBody.setAttribute("aria-hidden", String(isCollapsed));
  missionCardBody.inert = isCollapsed;
  if (persist) {
    try {
      localStorage.setItem("chenlongMissionCardCollapsed", isCollapsed ? "1" : "0");
    } catch {}
  }
}

function initMissionCardToggle() {
  if (!missionCardToggle) return;
  let collapsed = false;
  try {
    collapsed = localStorage.getItem("chenlongMissionCardCollapsed") === "1";
  } catch {}
  setMissionCardCollapsed(collapsed, { persist: false });
  missionCardToggle.addEventListener("click", () => {
    setMissionCardCollapsed(!missionCard.classList.contains("is-collapsed"));
  });
}

function captureMissionBaseline({ preservePackageOrigins = false } = {}) {
  ensureMissionPackages();
  const nextBaseline = structuredClone(activeMission);
  if (preservePackageOrigins && missionBaseline) {
    const originalById = new Map(normalizePackageRecords(missionBaseline).map(record => [record.id, record]));
    nextBaseline.packages = nextBaseline.packages.map(record => {
      const original = originalById.get(record.id);
      return original ? { ...record, x: original.x, z: original.z } : record;
    });
  }
  missionBaseline = nextBaseline;
}

function restoreMissionBaseline() {
  if (!missionBaseline) return false;
  activeMission = structuredClone(missionBaseline);
  activeMission.packages = normalizePackageRecords(activeMission);
  renderMissionInfo();
  return true;
}

function commitMissionEdit() {
  captureMissionBaseline({ preservePackageOrigins: true });
  restoreMissionBaseline();
  missionAttempt = null;
  resetRobot();
  rebuildSceneObjects();
  initializeMissionAttempt();
}

function getMazeCheckpointPositions() {
  const route = createMazeSolutionPath(MAZE_LAYOUT);
  if (route.length < 3) return [];
  return [0.25, 0.52, 0.78].map(progress => {
    const routeIndex = Math.max(1, Math.min(route.length - 2, Math.round((route.length - 1) * progress)));
    return [...route[routeIndex]];
  });
}

function getMissionCheckpointPositions(spec) {
  if ((spec?.checkpointSource === "guidePath" || activeMission.theme !== "maze")
    && Array.isArray(activeMission.guidePath)) {
    return activeMission.guidePath.slice(1, -1).map(point => [...point]);
  }
  return activeMission.theme === "maze" ? getMazeCheckpointPositions() : [];
}

function resolveMissionCompletionSpec() {
  const configured = activeMission.completion && typeof activeMission.completion === "object"
    ? structuredClone(activeMission.completion)
    : { type: "auto" };
  const supportedTypes = new Set(["auto", "delivery", "reach", "checkpoints", "composite", "practice"]);
  let type = supportedTypes.has(configured.type) ? configured.type : "auto";
  if (type === "auto") {
    if (activeMission.theme === "maze" && activeMission.goal) type = "checkpoints";
    else if (ensureMissionPackages().length && activeMission.goal) type = "delivery";
    else if (activeMission.goal) type = "reach";
    else type = "practice";
  }
  return {
    ...configured,
    type,
    goalRadius: Math.max(0.1, Math.min(5, finiteNumber(configured.goalRadius, 0.82))),
    deliveryRadius: Math.max(0.1, Math.min(5, finiteNumber(configured.deliveryRadius, 0.95))),
    checkpointRadius: Math.max(0.1, Math.min(5, finiteNumber(configured.checkpointRadius, 0.78))),
    packageRadius: Math.max(0.1, Math.min(1, finiteNumber(configured.packageRadius, 0.28))),
    minimumRoadEdgeClearance: Math.max(0, Math.min(2, finiteNumber(configured.minimumRoadEdgeClearance, 0.2)))
  };
}

function initializeMissionAttempt() {
  const spec = resolveMissionCompletionSpec();
  const packages = ensureMissionPackages();
  missionAttempt = {
    spec,
    completed: false,
    requiredPackageIds: new Set(packages.map(record => record.id)),
    deliveredPackageIds: new Set(),
    targetPackageIds: new Set(packages.filter(record => record.role === "target").map(record => record.id)),
    distractorPackageIds: new Set(packages.filter(record => record.role === "distractor").map(record => record.id)),
    deliveredTargetIds: new Set(),
    clearedDistractorIds: new Set(),
    handledPackageIds: new Set(),
    requiredObstacleIds: new Set((activeMission.obstacles || []).map((_, index) => `${activeMission.taskId || "mission"}-obstacle-${index + 1}`)),
    failedObstacleIds: new Set(),
    checkpointPoints: ["checkpoints", "composite"].includes(spec.type) ? getMissionCheckpointPositions(spec) : [],
    nextCheckpointIndex: 0,
    goalReached: false,
    lastUiSignature: ""
  };
  evaluateMissionProgress({ allowComplete: true, announce: false });
}

function deliveredTargetPackageIds() {
  const delivered = new Set();
  if (!missionAttempt || !Array.isArray(activeMission.landmarks?.storage)) return delivered;
  const [storageX, storageZ] = activeMission.landmarks.storage;
  ensureMissionPackages().forEach(record => {
    if (!missionAttempt.targetPackageIds.has(record.id) || record.id === heldPackageId) return;
    if (Math.hypot(record.x - storageX, record.z - storageZ) <= missionAttempt.spec.deliveryRadius) delivered.add(record.id);
  });
  return delivered;
}

function clearedDistractorPackageIds() {
  const cleared = new Set();
  if (!missionAttempt) return cleared;
  ensureMissionPackages().forEach(record => {
    if (!missionAttempt.distractorPackageIds.has(record.id) || record.id === heldPackageId
      || !missionAttempt.handledPackageIds.has(record.id)) return;
    const clearance = PRIMARY_GUANGYANG_SCORING.roadEdgeClearance(
      record.x,
      record.z,
      missionAttempt.spec.packageRadius
    );
    if (clearance + 1e-6 >= missionAttempt.spec.minimumRoadEdgeClearance) cleared.add(record.id);
  });
  return cleared;
}

function compositeMissionProgress() {
  if (!missionAttempt) return PRIMARY_GUANGYANG_SCORING.compositeTaskProgress();
  return PRIMARY_GUANGYANG_SCORING.compositeTaskProgress({
    checkpointCount: missionAttempt.nextCheckpointIndex,
    checkpointTotal: missionAttempt.checkpointPoints.length,
    targetDeliveredCount: missionAttempt.deliveredTargetIds.size,
    targetTotal: missionAttempt.targetPackageIds.size,
    distractorClearedCount: missionAttempt.clearedDistractorIds.size,
    distractorTotal: missionAttempt.distractorPackageIds.size,
    failedObstacleCount: missionAttempt.failedObstacleIds.size,
    obstacleTotal: missionAttempt.requiredObstacleIds.size,
    goalReached: missionAttempt.goalReached
  });
}

function deliveredMissionPackageIds() {
  const delivered = new Set();
  if (!missionAttempt || !activeMission.goal) return delivered;
  const [goalX, goalZ] = activeMission.goal;
  const radius = missionAttempt.spec.deliveryRadius;
  ensureMissionPackages().forEach(record => {
    if (!missionAttempt.requiredPackageIds.has(record.id) || record.id === heldPackageId) return;
    if (Math.hypot(record.x - goalX, record.z - goalZ) <= radius) delivered.add(record.id);
  });
  return delivered;
}

function missionProgressSnapshot() {
  if (!missionAttempt) return { completed: 0, total: 0, label: "任务进度", value: "--", hint: "正在准备任务" };
  const { spec } = missionAttempt;
  if (targetSelect?.value === "real") {
    return { completed: 0, total: 0, label: "任务判定", value: "--", hint: "真实小车暂无位置回传，暂不自动判定" };
  }
  if (spec.type === "practice") {
    return { completed: 0, total: 0, label: "练习模式", value: "自由", hint: "当前场景没有强制完成条件" };
  }
  if (spec.type === "delivery") {
    const total = missionAttempt.requiredPackageIds.size;
    const completed = missionAttempt.deliveredPackageIds.size;
    const holding = heldPackageId && missionAttempt.requiredPackageIds.has(heldPackageId);
    const hint = !activeMission.goal
      ? "请先在地图中放置终点"
      : total === 0
        ? "请先在地图中放置包裹"
        : holding
          ? "包裹运输中，把它放到终点区域"
          : completed < total
            ? `还需送达 ${total - completed} 个包裹`
            : "全部包裹已送达";
    return { completed, total, label: "包裹送达", value: `${completed}/${total}`, hint };
  }
  if (spec.type === "composite") {
    const progress = compositeMissionProgress();
    const holdingTarget = heldPackageId && missionAttempt.targetPackageIds.has(heldPackageId);
    const holdingDistractor = heldPackageId && missionAttempt.distractorPackageIds.has(heldPackageId);
    let hint = "完成全部任务目标";
    if (missionAttempt.failedObstacleIds.size) hint = `已碰撞 ${missionAttempt.failedObstacleIds.size} 个障碍物，本次无法获得对应避障分`;
    else if (progress.targetDeliveredCount < progress.targetTotal) hint = holdingTarget
      ? "把红色目标物放入绿色存放点"
      : `还需运送 ${progress.targetTotal - progress.targetDeliveredCount} 个红色目标物`;
    else if (progress.distractorClearedCount < progress.distractorTotal) hint = holdingDistractor
      ? "把蓝色混淆物完整移出道路，离道路边缘至少 2.5 厘米"
      : `还需移走 ${progress.distractorTotal - progress.distractorClearedCount} 个蓝色混淆物`;
    else if (progress.checkpointCount < progress.checkpointTotal) hint = `按顺序前往途径点 ${progress.checkpointCount + 1}`;
    else if (!progress.goalReached) hint = "全部目标已完成，返回起点停车区";
    else if (progress.finished) hint = "目标物、混淆物、途径点、避障和返航均已完成";
    return {
      completed: progress.completed,
      total: progress.total,
      label: "综合任务进度",
      value: `${progress.completed}/${progress.total}`,
      hint,
      progress
    };
  }
  if (spec.type === "checkpoints") {
    const checkpointTotal = missionAttempt.checkpointPoints.length;
    const completed = missionAttempt.nextCheckpointIndex + (missionAttempt.goalReached ? 1 : 0);
    const total = checkpointTotal + 1;
    const hint = missionAttempt.nextCheckpointIndex < checkpointTotal
      ? `前往导航点 ${missionAttempt.nextCheckpointIndex + 1}`
      : missionAttempt.goalReached
        ? "已通过导航点并抵达终点"
        : "导航点已通过，继续前往终点";
    return {
      completed,
      total,
      label: activeMission.theme === "maze" ? "迷宫路线" : "路线进度",
      value: `${missionAttempt.nextCheckpointIndex}/${checkpointTotal} · 终点${missionAttempt.goalReached ? "✓" : "○"}`,
      hint
    };
  }
  const completed = missionAttempt.goalReached ? 1 : 0;
  return {
    completed,
    total: 1,
    label: "抵达终点",
    value: `${completed}/1`,
    hint: completed ? "小车已经抵达终点" : "控制小车进入绿色终点区域"
  };
}

function renderMissionProgress() {
  renderPrimaryScore();
  const snapshot = missionProgressSnapshot();
  const signature = JSON.stringify({ ...snapshot, done: missionAttempt?.completed || false });
  if (missionAttempt && missionAttempt.lastUiSignature === signature) return;
  if (missionAttempt) missionAttempt.lastUiSignature = signature;
  if (missionProgressLabel) missionProgressLabel.textContent = missionAttempt?.completed ? "任务完成" : snapshot.label;
  if (missionProgressValue) missionProgressValue.textContent = missionAttempt?.completed ? "完成" : snapshot.value;
  if (missionProgressHint) missionProgressHint.textContent = missionAttempt?.completed ? "做得好！可以重置任务或选择下一项任务" : snapshot.hint;
  if (missionProgressBar) {
    const percent = missionAttempt?.completed
      ? 100
      : snapshot.total > 0
        ? Math.round(snapshot.completed / snapshot.total * 100)
        : 0;
    missionProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
  missionCard?.classList.toggle("is-complete", Boolean(missionAttempt?.completed));
}

function missionIncompleteHint() {
  return missionProgressSnapshot().hint;
}

function completeMissionAttempt() {
  if (!missionAttempt || missionAttempt.completed) return;
  missionAttempt.completed = true;
  renderMissionProgress();
  setStatus("任务完成");
  addLog(activeRun
    ? "任务完成：所有目标均已达成，程序已自动停止。"
    : "任务完成：当前场景已经满足全部目标。");
  if (activeRun) abortRunContext(activeRun, "mission-complete");
}

function markMissionCheckpointVisited(index) {
  mazeSignalEffects.forEach(signal => {
    if (!signal || signal.index !== index || signal.visited) return;
    signal.visited = true;
    signal.pad.material.color.set("#22c55e");
    signal.pad.material.emissive.set("#16a34a");
    signal.ring.material.color.set("#86efac");
    signal.beam.material.color.set("#4ade80");
    signal.core.material.emissive.set("#4ade80");
  });
}

function evaluateMissionProgress({ allowComplete = true, announce = true } = {}) {
  if (!missionAttempt) return false;
  if (targetSelect?.value === "real") {
    renderMissionProgress();
    return false;
  }
  const { spec } = missionAttempt;
  if (spec.type === "delivery") {
    missionAttempt.deliveredPackageIds = deliveredMissionPackageIds();
  }
  if (spec.type === "composite") {
    missionAttempt.deliveredTargetIds = deliveredTargetPackageIds();
    missionAttempt.clearedDistractorIds = clearedDistractorPackageIds();
  }
  const atGoal = Boolean(activeMission.goal)
    && Math.hypot(robotPose.x - activeMission.goal[0], robotPose.z - activeMission.goal[1]) <= spec.goalRadius;
  if (spec.type === "reach") missionAttempt.goalReached ||= atGoal;
  if (["checkpoints", "composite"].includes(spec.type)) {
    const nextPoint = missionAttempt.checkpointPoints[missionAttempt.nextCheckpointIndex];
    if (nextPoint && Math.hypot(robotPose.x - nextPoint[0], robotPose.z - nextPoint[1]) <= spec.checkpointRadius) {
      const visitedIndex = missionAttempt.nextCheckpointIndex;
      missionAttempt.nextCheckpointIndex += 1;
      markMissionCheckpointVisited(visitedIndex);
      if (announce) addLog(`已通过导航点 ${missionAttempt.nextCheckpointIndex}/${missionAttempt.checkpointPoints.length}。`);
    }
    if (spec.type === "checkpoints" && missionAttempt.nextCheckpointIndex === missionAttempt.checkpointPoints.length) {
      missionAttempt.goalReached ||= atGoal;
    }
    if (spec.type === "composite"
      && missionAttempt.nextCheckpointIndex === missionAttempt.checkpointPoints.length
      && missionAttempt.deliveredTargetIds.size === missionAttempt.targetPackageIds.size
      && missionAttempt.clearedDistractorIds.size === missionAttempt.distractorPackageIds.size) {
      missionAttempt.goalReached ||= atGoal;
    }
  }

  const complete = spec.type === "delivery"
    ? Boolean(activeMission.goal) && missionAttempt.requiredPackageIds.size > 0
      && missionAttempt.deliveredPackageIds.size === missionAttempt.requiredPackageIds.size
    : spec.type === "checkpoints"
      ? missionAttempt.checkpointPoints.length > 0
        && missionAttempt.nextCheckpointIndex === missionAttempt.checkpointPoints.length
        && missionAttempt.goalReached
      : spec.type === "composite"
        ? compositeMissionProgress().finished
      : spec.type === "reach"
        ? missionAttempt.goalReached
        : false;
  renderMissionProgress();
  if (complete && allowComplete) completeMissionAttempt();
  return complete;
}

function defineBlocks() {
  Blockly.JavaScript.addReservedWords("robot");

  Blockly.Blocks.robot_move_cm = {
    init() {
      this.appendDummyInput()
        .appendField("小车")
        .appendField(new Blockly.FieldDropdown([["前进", "forward"], ["后退", "backward"]]), "DIR");
      this.appendValueInput("DISTANCE_CM").setCheck("Number");
      this.appendDummyInput().appendField("厘米");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#1177cc");
      this.setTooltip("让小车按地图实际距离移动；50 表示 50 厘米");
    }
  };

  // 旧版作品把移动量保存为秒。保留该积木定义并使用兼容 API，
  // 但不再放入工具箱，避免旧作品中的“1 秒”被静默解释成“1 厘米”。
  Blockly.Blocks.robot_move = {
    init() {
      this.appendDummyInput()
        .appendField("小车")
        .appendField(new Blockly.FieldDropdown([["前进", "forward"], ["后退", "backward"]]), "DIR");
      this.appendValueInput("SECONDS").setCheck("Number");
      this.appendDummyInput().appendField("秒");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#1177cc");
      this.setTooltip("让小车按当前方向移动指定秒数");
    }
  };

  Blockly.Blocks.robot_turn = {
    init() {
      this.appendDummyInput()
        .appendField("小车原地")
        .appendField(new Blockly.FieldDropdown([["左转", "left"], ["右转", "right"]]), "DIR");
      this.appendValueInput("SECONDS").setCheck("Number");
      this.appendDummyInput().appendField("秒");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#1177cc");
    }
  };

  Blockly.Blocks.robot_turn_left = {
    init() {
      this.appendValueInput("SECONDS").setCheck("Number").appendField("小车左转");
      this.appendDummyInput().appendField("秒");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#1177cc");
      this.setTooltip("小车原地向左转指定秒数");
    }
  };

  Blockly.Blocks.robot_turn_right = {
    init() {
      this.appendValueInput("SECONDS").setCheck("Number").appendField("小车右转");
      this.appendDummyInput().appendField("秒");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#1177cc");
      this.setTooltip("小车原地向右转指定秒数");
    }
  };

  Blockly.Blocks.robot_turn_left_90 = {
    init() {
      this.appendDummyInput().appendField("小车左转 90°");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#1177cc");
      this.setTooltip("小车原地向左精确转 90 度");
    }
  };

  Blockly.Blocks.robot_turn_right_90 = {
    init() {
      this.appendDummyInput().appendField("小车右转 90°");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#1177cc");
      this.setTooltip("小车原地向右精确转 90 度");
    }
  };

  const defineAngleTurnBlock = (type, label, direction) => {
    Blockly.Blocks[type] = {
      init() {
        this.appendDummyInput()
          .appendField(label)
          .appendField(new Blockly.FieldNumber(45, 1, 360, 1), "DEGREES")
          .appendField("°");
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour("#1177cc");
        this.setTooltip(`${label}指定角度；模拟器精确执行，真实小车按标定时间近似执行`);
      }
    };
    Blockly.JavaScript[type] = block => {
      const degrees = Number(block.getFieldValue("DEGREES")) || 45;
      return `await robot.turnAngle("${direction}", ${degrees});\n`;
    };
  };

  defineAngleTurnBlock("robot_turn_left_angle", "小车左转", "left");
  defineAngleTurnBlock("robot_turn_right_angle", "小车右转", "right");

  Blockly.Blocks.robot_wait = {
    init() {
      this.appendValueInput("SECONDS").setCheck("Number").appendField("等待");
      this.appendDummyInput().appendField("秒");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#6a6f7a");
    }
  };

  Blockly.Blocks.robot_gripper = {
    init() {
      this.appendDummyInput()
        .appendField("机械臂")
        .appendField(new Blockly.FieldDropdown([["抓取", "grab"], ["松开", "release"]]), "ACTION");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#d97706");
    }
  };

  Blockly.Blocks.robot_if_obstacle = {
    init() {
      this.appendDummyInput().appendField("如果前方有障碍物");
      this.appendStatementInput("DO").appendField("就");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#8b5cf6");
      this.setTooltip("用距离传感器判断前方是否堵住");
    }
  };

  Blockly.Blocks.robot_sensor_distance = {
    init() {
      this.appendDummyInput().appendField("前方距离 cm");
      this.setOutput(true, "Number");
      this.setColour("#0891b2");
    }
  };

  Blockly.Blocks.robot_sequence = {
    init() {
      this.appendDummyInput().appendField("按顺序执行");
      this.appendStatementInput("DO").appendField("从上到下");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#8b5cf6");
      this.setTooltip("里面的积木会按照从上到下的顺序依次执行");
    }
  };

  const defineRobotBooleanBlock = (type, label, method, tooltip) => {
    Blockly.Blocks[type] = {
      init() {
        this.appendDummyInput().appendField(label);
        this.setOutput(true, "Boolean");
        this.setColour("#0891b2");
        this.setTooltip(tooltip);
      }
    };
    Blockly.JavaScript[type] = () => [`robot.${method}()`, Blockly.JavaScript.ORDER_FUNCTION_CALL];
  };

  defineRobotBooleanBlock("robot_front_blocked", "前方有障碍物？", "checkFrontObstacle", "检测小车正前方是否有障碍物");
  defineRobotBooleanBlock("robot_on_road", "小车在道路上？", "onRoad", "判断小车是否完整位于道路范围内");
  defineRobotBooleanBlock("robot_holding_package", "夹爪拿着包裹？", "holding", "判断夹爪当前是否抓着包裹");
  defineRobotBooleanBlock("robot_task_complete", "任务已经完成？", "taskComplete", "判断当前任务的全部目标是否已经完成");

  Blockly.Blocks.robot_checkpoint_count = {
    init() {
      this.appendDummyInput().appendField("已通过途径点数");
      this.setOutput(true, "Number");
      this.setColour("#0891b2");
      this.setTooltip("返回当前任务已经按顺序通过的途径点数量");
    }
  };

  const navigationSensorBlocks = [
    ["robot_mission", "读取任务信息", "mission", "读取起点、存放点、途径点、返航点和任务物体的道路级锚点，不包含坐标"],
    ["robot_task_state", "读取任务进度", "task_state", "读取任务引擎已经确认的进度"],
    ["robot_release_preview", "预判现在松开", "release_preview", "不实际松开，检查当前释放是否会完成任务"],
    ["robot_odometry", "读取里程计", "odometry", "读取相对本次程序起点的位移、航向和累计里程"],
    ["robot_road_state", "读取当前道路状态", "road_state", "读取道路、进度、节点、出口、余量与前方净空"],
    ["robot_map_graph", "读取公开道路图", "map_graph", "读取不含坐标的道路节点和边"]
  ];
  navigationSensorBlocks.forEach(([type, label, method, tooltip]) => {
    Blockly.Blocks[type] = {
      init() {
        this.appendDummyInput().appendField(label);
        this.setOutput(true, "Object");
        this.setColour("#0f766e");
        this.setTooltip(tooltip);
      }
    };
    Blockly.JavaScript[type] = () => [`robot.${method}()`, Blockly.JavaScript.ORDER_FUNCTION_CALL];
  });

  const defineSensorFieldBlock = (type, label, method, options, outputType) => {
    Blockly.Blocks[type] = {
      init() {
        this.appendDummyInput()
          .appendField(label)
          .appendField(new Blockly.FieldDropdown(options), "FIELD");
        this.setOutput(true, outputType);
        this.setColour("#0f766e");
      }
    };
    Blockly.JavaScript[type] = block => {
      const field = block.getFieldValue("FIELD");
      return [`robot.sensorField("${method}", ${JSON.stringify(field)})`, Blockly.JavaScript.ORDER_FUNCTION_CALL];
    };
  };
  defineSensorFieldBlock("robot_odometry_value", "里程计", "odometry", [
    ["前向位移 cm", "forwardCm"], ["右向位移 cm", "rightCm"],
    ["相对航向 °", "headingDeg"], ["累计里程 cm", "distanceCm"]
  ], "Number");
  defineSensorFieldBlock("robot_road_boolean", "道路判断", "road_state", [
    ["在道路上", "onRoad"], ["位于节点", "atNode"], ["位于路口", "atJunction"]
  ], "Boolean");
  defineSensorFieldBlock("robot_road_number", "道路数值", "road_state", [
    ["道路进度 cm", "roadProgressCm"], ["中心偏移 cm", "lateralOffsetCm"],
    ["航向误差 °", "headingErrorDeg"], ["左侧余量 cm", "leftClearanceCm"],
    ["右侧余量 cm", "rightClearanceCm"], ["前方净空 cm", "frontClearanceCm"]
  ], "Number");
  defineSensorFieldBlock("robot_road_text", "道路文字", "road_state", [
    ["道路编号", "roadId"], ["起点节点", "fromNodeId"], ["终点节点", "toNodeId"],
    ["所在节点", "nodeId"], ["路口编号", "junctionId"]
  ], "String");

  Blockly.Blocks.robot_follow_road = {
    init() {
      this.appendValueInput("MAX_CM").setCheck("Number").appendField("沿当前道路行驶");
      this.appendValueInput("SPEED").setCheck("Number").appendField("cm，速度");
      this.appendValueInput("OBEY").setCheck("Boolean").appendField("自动遵守限速");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#2563eb");
      this.setTooltip("沿当前道路居中行驶，遇节点、路端、障碍或距离上限后停止，不会自动选择出口");
    }
  };
  Blockly.JavaScript.robot_follow_road = block => {
    const maxCm = Blockly.JavaScript.valueToCode(block, "MAX_CM", Blockly.JavaScript.ORDER_NONE) || "100";
    const speed = Blockly.JavaScript.valueToCode(block, "SPEED", Blockly.JavaScript.ORDER_NONE) || "40";
    const obey = Blockly.JavaScript.valueToCode(block, "OBEY", Blockly.JavaScript.ORDER_NONE) || "false";
    return `await robot.follow_road(${maxCm}, ${speed}, ${obey});\n`;
  };

  Blockly.Blocks.robot_take_exit = {
    init() {
      this.appendValueInput("ROAD_ID").setCheck("String").appendField("从路口驶入道路");
      this.appendValueInput("SPEED").setCheck("Number").appendField("速度");
      this.appendValueInput("OBEY").setCheck("Boolean").appendField("自动遵守限速");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#2563eb");
      this.setTooltip("只驶入程序指定的相邻道路，不会替程序选择出口");
    }
  };
  Blockly.JavaScript.robot_take_exit = block => {
    const roadId = Blockly.JavaScript.valueToCode(block, "ROAD_ID", Blockly.JavaScript.ORDER_NONE) || '""';
    const speed = Blockly.JavaScript.valueToCode(block, "SPEED", Blockly.JavaScript.ORDER_NONE) || "30";
    const obey = Blockly.JavaScript.valueToCode(block, "OBEY", Blockly.JavaScript.ORDER_NONE) || "false";
    return `await robot.take_exit(${roadId}, ${speed}, ${obey});\n`;
  };
  Blockly.Blocks.robot_last_road_result = {
    init() {
      this.appendDummyInput().appendField("上次道路动作结果");
      this.setOutput(true, "Object");
      this.setColour("#2563eb");
    }
  };
  Blockly.JavaScript.robot_last_road_result = () => ["robot.lastRoadResult()", Blockly.JavaScript.ORDER_FUNCTION_CALL];
  Blockly.Blocks.robot_last_road_result_value = {
    init() {
      this.appendDummyInput().appendField("上次道路动作").appendField(new Blockly.FieldDropdown([
        ["是否接受", "accepted"], ["停止原因", "stoppedBy"], ["道路编号", "roadId"],
        ["行驶距离 cm", "distanceCm"], ["仿真步数", "elapsedTicks"]
      ]), "FIELD");
      this.setOutput(true);
      this.setColour("#2563eb");
    }
  };
  Blockly.JavaScript.robot_last_road_result_value = block => [
    `robot.dataGet(robot.lastRoadResult(), ${JSON.stringify(block.getFieldValue("FIELD"))})`,
    Blockly.JavaScript.ORDER_FUNCTION_CALL
  ];

  const visionTargets = [["目标物", "目标物"], ["混淆物", "混淆物"], ["障碍物", "障碍物"], ["存放点", "存放点"]];
  const visionTargetsWithAll = [["全部", "全部"], ...visionTargets];
  const defineVisionQueryBlock = (type, label, method, outputType, targets = visionTargets) => {
    Blockly.Blocks[type] = {
      init() {
        this.appendDummyInput().appendField(label).appendField(new Blockly.FieldDropdown(targets), "TARGET");
        this.appendValueInput("CONFIDENCE").setCheck("Number").appendField("最低置信度");
        this.setInputsInline(true);
        this.setOutput(true, outputType);
        this.setColour("#c026d3");
      }
    };
    Blockly.JavaScript[type] = block => {
      const target = JSON.stringify(block.getFieldValue("TARGET"));
      const confidence = Blockly.JavaScript.valueToCode(block, "CONFIDENCE", Blockly.JavaScript.ORDER_NONE) || "0.6";
      return [`robot.${method}(${target}, ${confidence})`, Blockly.JavaScript.ORDER_FUNCTION_CALL];
    };
  };
  defineVisionQueryBlock("robot_vision_sees", "摄像头看见", "sees", "Boolean");
  defineVisionQueryBlock("robot_vision_count", "摄像头识别数量", "count", "Number");
  defineVisionQueryBlock("robot_vision_direction", "目标方位", "direction", "String");
  defineVisionQueryBlock("robot_vision_distance", "目标距离 cm", "distance_to", "Number");
  defineVisionQueryBlock("robot_vision_near", "目标接近夹取范围", "near", "Boolean");
  defineVisionQueryBlock("robot_vision_centered", "目标位于画面中央", "centered", "Boolean");
  defineVisionQueryBlock("robot_vision_observe", "观察场景", "observe", "Array", visionTargetsWithAll);
  defineVisionQueryBlock("robot_vision_detect", "查看原始识别结果", "detect", "Array", visionTargetsWithAll);
  Blockly.Blocks.robot_vision_approach = {
    init() {
      this.appendDummyInput().appendField("自动靠近").appendField(new Blockly.FieldDropdown(visionTargets), "TARGET");
      this.appendValueInput("DISTANCE_CM").setCheck("Number").appendField("停止距离 cm");
      this.appendValueInput("MAX_STEPS").setCheck("Number").appendField("最多控制步数");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#c026d3");
      this.setTooltip("依据摄像头当前可见目标进行有限步转向和靠近，遇障碍会停止");
    }
  };
  Blockly.JavaScript.robot_vision_approach = block => {
    const target = JSON.stringify(block.getFieldValue("TARGET"));
    const distance = Blockly.JavaScript.valueToCode(block, "DISTANCE_CM", Blockly.JavaScript.ORDER_NONE) || "20";
    const steps = Blockly.JavaScript.valueToCode(block, "MAX_STEPS", Blockly.JavaScript.ORDER_NONE) || "60";
    return `await robot.approach(${target}, ${distance}, ${steps});\n`;
  };

  Blockly.Blocks.robot_data_get = {
    init() {
      this.appendValueInput("OBJECT").appendField("读取对象");
      this.appendValueInput("KEY").setCheck("String").appendField("的字段");
      this.setInputsInline(true);
      this.setOutput(true);
      this.setColour("#7c3aed");
      this.setTooltip("按字段名称读取任务、道路、识别结果等对象中的数据");
    }
  };
  Blockly.JavaScript.robot_data_get = block => {
    const object = Blockly.JavaScript.valueToCode(block, "OBJECT", Blockly.JavaScript.ORDER_NONE) || "null";
    const key = Blockly.JavaScript.valueToCode(block, "KEY", Blockly.JavaScript.ORDER_NONE) || '""';
    return [`robot.dataGet(${object}, ${key})`, Blockly.JavaScript.ORDER_FUNCTION_CALL];
  };
  Blockly.Blocks.robot_list_item = {
    init() {
      this.appendValueInput("LIST").appendField("列表");
      this.appendValueInput("INDEX").setCheck("Number").appendField("第");
      this.appendDummyInput().appendField("项（从 1 开始）");
      this.setInputsInline(true);
      this.setOutput(true);
      this.setColour("#7c3aed");
    }
  };
  Blockly.JavaScript.robot_list_item = block => {
    const list = Blockly.JavaScript.valueToCode(block, "LIST", Blockly.JavaScript.ORDER_NONE) || "[]";
    const index = Blockly.JavaScript.valueToCode(block, "INDEX", Blockly.JavaScript.ORDER_NONE) || "1";
    return [`robot.listItem(${list}, ${index})`, Blockly.JavaScript.ORDER_FUNCTION_CALL];
  };
  Blockly.Blocks.robot_data_length = {
    init() {
      this.appendValueInput("VALUE").appendField("数据长度");
      this.setOutput(true, "Number");
      this.setColour("#7c3aed");
    }
  };
  Blockly.JavaScript.robot_data_length = block => {
    const value = Blockly.JavaScript.valueToCode(block, "VALUE", Blockly.JavaScript.ORDER_NONE) || "null";
    return [`robot.dataLength(${value})`, Blockly.JavaScript.ORDER_FUNCTION_CALL];
  };
  Blockly.Blocks.robot_json_text = {
    init() {
      this.appendValueInput("VALUE").appendField("数据转为文字");
      this.setOutput(true, "String");
      this.setColour("#7c3aed");
    }
  };
  Blockly.JavaScript.robot_json_text = block => {
    const value = Blockly.JavaScript.valueToCode(block, "VALUE", Blockly.JavaScript.ORDER_NONE) || "null";
    return [`robot.jsonText(${value})`, Blockly.JavaScript.ORDER_FUNCTION_CALL];
  };

  Blockly.Blocks.robot_forever = {
    init() {
      this.appendDummyInput().appendField("持续巡逻");
      this.appendStatementInput("DO").appendField("执行");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour("#5ba55b");
      this.setTooltip("一直重复执行里面的积木，适合放“遇障转向 + 前进”的巡逻逻辑，点击停止按钮可结束");
    }
  };

  Blockly.JavaScript.robot_move_cm = block => {
    const dir = block.getFieldValue("DIR");
    const distanceCm = Blockly.JavaScript.valueToCode(block, "DISTANCE_CM", Blockly.JavaScript.ORDER_NONE) || "50";
    return `await robot.${dir}(${distanceCm});\n`;
  };

  Blockly.JavaScript.robot_move = block => {
    const dir = block.getFieldValue("DIR");
    const seconds = Blockly.JavaScript.valueToCode(block, "SECONDS", Blockly.JavaScript.ORDER_NONE) || "1";
    const compatibilityMethod = dir === "backward" ? "backwardSeconds" : "forwardSeconds";
    return `await robot.${compatibilityMethod}(${seconds});\n`;
  };

  Blockly.JavaScript.robot_turn = block => {
    const dir = block.getFieldValue("DIR");
    const seconds = Blockly.JavaScript.valueToCode(block, "SECONDS", Blockly.JavaScript.ORDER_NONE) || "0.5";
    return `await robot.turn("${dir}", ${seconds});\n`;
  };

  Blockly.JavaScript.robot_turn_left = block => {
    const seconds = Blockly.JavaScript.valueToCode(block, "SECONDS", Blockly.JavaScript.ORDER_NONE) || "0.5";
    return `await robot.turn("left", ${seconds});\n`;
  };

  Blockly.JavaScript.robot_turn_right = block => {
    const seconds = Blockly.JavaScript.valueToCode(block, "SECONDS", Blockly.JavaScript.ORDER_NONE) || "0.5";
    return `await robot.turn("right", ${seconds});\n`;
  };

  Blockly.JavaScript.robot_turn_left_90 = () => `await robot.turnAngle("left", 90);\n`;

  Blockly.JavaScript.robot_turn_right_90 = () => `await robot.turnAngle("right", 90);\n`;

  Blockly.JavaScript.robot_wait = block => {
    const seconds = Blockly.JavaScript.valueToCode(block, "SECONDS", Blockly.JavaScript.ORDER_NONE) || "0.5";
    return `await robot.wait(${seconds});\n`;
  };

  Blockly.JavaScript.robot_gripper = block => {
    const action = block.getFieldValue("ACTION");
    return `await robot.${action}();\n`;
  };

  Blockly.JavaScript.robot_if_obstacle = block => {
    const branch = Blockly.JavaScript.statementToCode(block, "DO");
    return `if (robot.checkFrontObstacle()) {\n${branch}}\n`;
  };

  Blockly.JavaScript.robot_sensor_distance = () => ["robot.distance()", Blockly.JavaScript.ORDER_FUNCTION_CALL];
  Blockly.JavaScript.robot_checkpoint_count = () => ["robot.checkpointCount()", Blockly.JavaScript.ORDER_FUNCTION_CALL];
  Blockly.JavaScript.robot_sequence = block => {
    const branch = Blockly.JavaScript.statementToCode(block, "DO");
    return branch || `await robot.emptyLoop("顺序执行");\n`;
  };
  Blockly.JavaScript.text_print = block => {
    const value = Blockly.JavaScript.valueToCode(block, "TEXT", Blockly.JavaScript.ORDER_NONE) || '""';
    return `await robot.print(${value});\n`;
  };
  defineAsyncProcedureGenerators();
  Blockly.JavaScript.robot_forever = block => {
    const branch = Blockly.JavaScript.statementToCode(block, "DO");
    const id = block.id.replace(/\W/g, "_");
    return `for (let patrol_${id} = 0; !robot.stopped(); patrol_${id}++) {\n` +
      `  await robot.loopTick("持续巡逻", patrol_${id} + 1);\n` +
      (branch || `  await robot.emptyLoop("持续巡逻");\n`) +
      `  await robot.loopYield();\n` +
      `}\n`;
  };
  defineSafeLoopGenerators();
}

function defineAsyncProcedureGenerators() {
  const getProcedureName = block => {
    const rawName = block.getFieldValue("NAME");
    return Blockly.JavaScript.nameDB_.getName(rawName, Blockly.PROCEDURE_CATEGORY_NAME);
  };
  const getProcedureArgs = block => (block.arguments_ || []).map(name =>
    Blockly.JavaScript.nameDB_.getName(name, Blockly.VARIABLE_CATEGORY_NAME)
  );
  const getCallArgs = block => (block.arguments_ || []).map((_, index) =>
    Blockly.JavaScript.valueToCode(block, `ARG${index}`, Blockly.JavaScript.ORDER_NONE) || "null"
  );
  const getEntryHighlight = block => Blockly.JavaScript.STATEMENT_PREFIX
    ? Blockly.JavaScript.STATEMENT_PREFIX.replace(/%1/g, () => JSON.stringify(block.id))
    : "";
  const wrapProcedureBody = (name, body) => {
    const guardedBody = String(body || "").replace(/^/gm, "  ");
    return `  await robot.procedureEnter(${JSON.stringify(name)});\n` +
      `  try {\n${guardedBody}  } finally {\n` +
      `    robot.procedureExit();\n` +
      `  }\n`;
  };

  Blockly.JavaScript.procedures_defnoreturn = block => {
    const name = getProcedureName(block);
    const args = getProcedureArgs(block);
    const branch = Blockly.JavaScript.statementToCode(block, "STACK");
    const body = `${getEntryHighlight(block)}${branch}`;
    const code = `async function ${name}(${args.join(", ")}) {\n${wrapProcedureBody(name, body)}}\n`;
    Blockly.JavaScript.definitions_[`%${name}`] = code;
    return null;
  };

  Blockly.JavaScript.procedures_defreturn = block => {
    const name = getProcedureName(block);
    const args = getProcedureArgs(block);
    const branch = Blockly.JavaScript.statementToCode(block, "STACK");
    const value = Blockly.JavaScript.valueToCode(block, "RETURN", Blockly.JavaScript.ORDER_NONE);
    const returnLine = value ? `  return ${value};\n` : "";
    const body = `${getEntryHighlight(block)}${branch}${returnLine}`;
    const code = `async function ${name}(${args.join(", ")}) {\n${wrapProcedureBody(name, body)}}\n`;
    Blockly.JavaScript.definitions_[`%${name}`] = code;
    return null;
  };

  Blockly.JavaScript.procedures_callnoreturn = block => {
    const name = getProcedureName(block);
    return `await ${name}(${getCallArgs(block).join(", ")});\n`;
  };

  Blockly.JavaScript.procedures_callreturn = block => {
    const name = getProcedureName(block);
    return [`await ${name}(${getCallArgs(block).join(", ")})`, Blockly.JavaScript.ORDER_FUNCTION_CALL];
  };

  Blockly.JavaScript.procedures_ifreturn = block => {
    const condition = Blockly.JavaScript.valueToCode(block, "CONDITION", Blockly.JavaScript.ORDER_NONE) || "false";
    const value = Blockly.JavaScript.valueToCode(block, "VALUE", Blockly.JavaScript.ORDER_NONE);
    if (value) return `if (${condition}) {\n  return ${value};\n}\n`;
    return block.hasReturnValue_
      ? `if (${condition}) {\n  return null;\n}\n`
      : `if (${condition}) {\n  return;\n}\n`;
  };
}

function defineSafeLoopGenerators() {
  Blockly.JavaScript.controls_repeat_ext = block => {
    const times = Blockly.JavaScript.valueToCode(block, "TIMES", Blockly.JavaScript.ORDER_ASSIGNMENT) || "0";
    const branch = Blockly.JavaScript.statementToCode(block, "DO");
    const id = block.id.replace(/\W/g, "_");
    return `const repeatValue_${id} = Number(${times});\n` +
      `const repeatEnd_${id} = Number.isFinite(repeatValue_${id}) ? Math.max(0, Math.floor(repeatValue_${id})) : 0;\n` +
      `if (!Number.isFinite(repeatValue_${id})) {\n` +
      `  await robot.repeatLimit(repeatValue_${id});\n` +
      `} else if (repeatEnd_${id} > ${MAX_PROGRAM_LOOP_ITERATIONS}) {\n` +
      `  await robot.repeatLimit(repeatEnd_${id});\n` +
      `} else {\n` +
      `  for (let repeat_${id} = 0; repeat_${id} < repeatEnd_${id}; repeat_${id}++) {\n` +
      `    await robot.loopTick("重复", repeat_${id} + 1, repeatEnd_${id});\n` +
      (branch || `    await robot.emptyLoop("重复");\n`) +
      `    if (robot.stopped()) break;\n` +
      `    await robot.loopYield();\n` +
      `  }\n` +
      `  if (!robot.stopped()) await robot.loopDone("重复", repeatEnd_${id});\n` +
      `}\n`;
  };

  Blockly.JavaScript.controls_whileUntil = block => {
    const mode = block.getFieldValue("MODE");
    const argument = Blockly.JavaScript.valueToCode(block, "BOOL", Blockly.JavaScript.ORDER_NONE) || "false";
    const condition = mode === "UNTIL" ? `!(${argument})` : `(${argument})`;
    const branch = Blockly.JavaScript.statementToCode(block, "DO");
    const id = block.id.replace(/\W/g, "_");
    return `for (let guard_${id} = 0; ${condition}; guard_${id}++) {\n` +
      `  if (guard_${id} >= 100) { await robot.loopLimit(); break; }\n` +
      `  await robot.loopTick("${mode === "UNTIL" ? "重复直到" : "当条件成立时重复"}", guard_${id} + 1);\n` +
      (branch || `  await robot.emptyLoop("${mode === "UNTIL" ? "重复直到" : "当条件成立时重复"}");\n`) +
      `  if (robot.stopped()) break;\n` +
      `  await robot.loopYield();\n` +
      `}\n` +
      `if (!robot.stopped()) await robot.loopDone("${mode === "UNTIL" ? "重复直到" : "当条件成立时重复"}");\n`;
  };

  Blockly.JavaScript.controls_for = block => {
    const variable = Blockly.JavaScript.nameDB_.getName(block.getFieldValue("VAR"), Blockly.VARIABLE_CATEGORY_NAME);
    const from = Blockly.JavaScript.valueToCode(block, "FROM", Blockly.JavaScript.ORDER_ASSIGNMENT) || "0";
    const to = Blockly.JavaScript.valueToCode(block, "TO", Blockly.JavaScript.ORDER_ASSIGNMENT) || "0";
    const by = Blockly.JavaScript.valueToCode(block, "BY", Blockly.JavaScript.ORDER_ASSIGNMENT) || "1";
    const branch = Blockly.JavaScript.statementToCode(block, "DO");
    const id = block.id.replace(/\W/g, "_");
    return `const forFrom_${id} = Number(${from});\n` +
      `const forTo_${id} = Number(${to});\n` +
      `const forBy_${id} = Number(${by});\n` +
      `if (![forFrom_${id}, forTo_${id}, forBy_${id}].every(Number.isFinite) || forBy_${id} === 0) {\n` +
      `  await robot.loopInputError("计数循环的起点、终点和步长必须是有限数字，且步长不能为 0");\n` +
      `} else {\n` +
      `  let forGuard_${id} = 0;\n` +
      `  for (${variable} = forFrom_${id}; forBy_${id} > 0 ? ${variable} <= forTo_${id} : ${variable} >= forTo_${id}; ${variable} += forBy_${id}) {\n` +
      `    if (forGuard_${id} >= ${MAX_PROGRAM_LOOP_ITERATIONS}) { await robot.loopLimit(); break; }\n` +
      `    forGuard_${id} += 1;\n` +
      `    await robot.loopTick("计数循环", forGuard_${id});\n` +
      (branch || `    await robot.emptyLoop("计数循环");\n`) +
      `    if (robot.stopped()) break;\n` +
      `    await robot.loopYield();\n` +
      `  }\n` +
      `  if (!robot.stopped()) await robot.loopDone("计数循环", forGuard_${id});\n` +
      `}\n`;
  };

  Blockly.JavaScript.controls_forEach = block => {
    const variable = Blockly.JavaScript.nameDB_.getName(block.getFieldValue("VAR"), Blockly.VARIABLE_CATEGORY_NAME);
    const list = Blockly.JavaScript.valueToCode(block, "LIST", Blockly.JavaScript.ORDER_ASSIGNMENT) || "[]";
    const branch = Blockly.JavaScript.statementToCode(block, "DO");
    const id = block.id.replace(/\W/g, "_");
    return `const forEachList_${id} = robot.requireList(${list});\n` +
      `if (forEachList_${id}.length > ${MAX_PROGRAM_LOOP_ITERATIONS}) await robot.repeatLimit(forEachList_${id}.length);\n` +
      `for (let forEachIndex_${id} = 0; forEachIndex_${id} < forEachList_${id}.length; forEachIndex_${id}++) {\n` +
      `  ${variable} = forEachList_${id}[forEachIndex_${id}];\n` +
      `  await robot.loopTick("遍历列表", forEachIndex_${id} + 1, forEachList_${id}.length);\n` +
      (branch || `  await robot.emptyLoop("遍历列表");\n`) +
      `  if (robot.stopped()) break;\n` +
      `  await robot.loopYield();\n` +
      `}\n` +
      `if (!robot.stopped()) await robot.loopDone("遍历列表", forEachList_${id}.length);\n`;
  };
}

function createRobotLabBlocklyTheme() {
  return Blockly.Theme.defineTheme("chenlongRobotLab", {
    base: Blockly.Themes.Classic,
    componentStyles: {
      workspaceBackgroundColour: "#0e192b",
      toolboxBackgroundColour: "#101e33",
      toolboxForegroundColour: "#c9dbf1",
      flyoutBackgroundColour: "#152641",
      flyoutForegroundColour: "#dcecff",
      flyoutOpacity: 0.97,
      scrollbarColour: "#4d688e",
      scrollbarOpacity: 0.72,
      insertionMarkerColour: "#51e5c4",
      insertionMarkerOpacity: 0.48,
      cursorColour: "#6ee7ff",
      markerColour: "#7dd3fc"
    },
    fontStyle: {
      family: "Arial, Microsoft YaHei, sans-serif",
      weight: "700",
      size: 12
    }
  });
}

const BLOCKLY_WORKSPACE_STORAGE_KEY = "chenlongBlocklyPrimaryWorkspace.v1";
let blocklySaveTimer = null;
let blocklySaveErrorShown = false;
let blocklyRestoreWarning = "";
let restoredBlocklySceneKey = "guangyang1";

function setWorkspaceSaveState(text, state = "saved") {
  if (!workspaceSaveStatus) return;
  workspaceSaveStatus.dataset.state = state;
  const label = workspaceSaveStatus.querySelector("span");
  if (label) label.textContent = text;
}

function saveBlocklyWorkspace() {
  if (!workspace) return false;
  if (blocklySaveTimer) {
    clearTimeout(blocklySaveTimer);
    blocklySaveTimer = null;
  }
  try {
    const payload = {
      schema: 1,
      savedAt: Date.now(),
      sceneKey: document.querySelector("#sceneSelect")?.value || "guangyang1",
      workspace: Blockly.serialization.workspaces.save(workspace)
    };
    localStorage.setItem(BLOCKLY_WORKSPACE_STORAGE_KEY, JSON.stringify(payload));
    blocklySaveErrorShown = false;
    setWorkspaceSaveState("已自动保存", "saved");
    return true;
  } catch (error) {
    setWorkspaceSaveState("自动保存失败", "error");
    if (!blocklySaveErrorShown) {
      blocklySaveErrorShown = true;
      console.warn("Blockly 自动保存失败：", error);
    }
    return false;
  }
}

function scheduleBlocklySave() {
  if (blocklySaveTimer) clearTimeout(blocklySaveTimer);
  setWorkspaceSaveState("正在保存…", "saving");
  blocklySaveTimer = setTimeout(saveBlocklyWorkspace, 380);
}

function restoreBlocklyWorkspace() {
  let raw = null;
  let eventsDisabled = false;
  try {
    raw = localStorage.getItem(BLOCKLY_WORKSPACE_STORAGE_KEY);
    if (!raw) return false;
    const payload = JSON.parse(raw);
    if (payload?.schema !== 1 || !payload.workspace) throw new Error("存档版本不兼容");
    restoredBlocklySceneKey = missions[payload?.sceneKey] ? payload.sceneKey : "guangyang1";
    Blockly.Events.disable();
    eventsDisabled = true;
    try {
      workspace.clear();
      Blockly.serialization.workspaces.load(payload.workspace, workspace);
    } finally {
      if (eventsDisabled) {
        Blockly.Events.enable();
        eventsDisabled = false;
      }
    }
    setWorkspaceSaveState("已恢复上次程序", "restored");
    return true;
  } catch (error) {
    try {
      if (raw) localStorage.setItem(`${BLOCKLY_WORKSPACE_STORAGE_KEY}.invalid`, raw);
      localStorage.removeItem(BLOCKLY_WORKSPACE_STORAGE_KEY);
    } catch {}
    try {
      if (eventsDisabled) Blockly.Events.enable();
      workspace.clear();
    } catch {}
    blocklyRestoreWarning = raw ? "损坏存档已备份，已载入示例" : "无法读取上次存档，已载入示例";
    setWorkspaceSaveState(blocklyRestoreWarning, "error");
    console.warn("Blockly 工作区恢复失败：", error);
    return false;
  }
}

function handleBlocklyChange(event) {
  updateCode(event);
  if (isBlocklyCodeChange(event)) {
    clearProgramStructureWarnings();
    scheduleBlocklySave();
  }
}

function initBlockly() {
  workspace = Blockly.inject("blocklyDiv", {
    toolbox: document.querySelector("#toolbox"),
    trashcan: false,
    scrollbars: true,
    sounds: false,
    renderer: "zelos",
    theme: createRobotLabBlocklyTheme(),
    grid: { spacing: 24, length: 2, colour: "#29415f", snap: false },
    zoom: { controls: false, wheel: true, startScale: 0.9, maxScale: 1.4, minScale: 0.55 }
  });

  const restored = restoreBlocklyWorkspace();
  if (!restored) {
    createStarterProgram();
    const saved = saveBlocklyWorkspace();
    if (blocklyRestoreWarning) {
      setWorkspaceSaveState(saved ? blocklyRestoreWarning : "浏览器存储不可用，示例未自动保存", "error");
    }
  }

  workspace.addChangeListener(handleBlocklyChange);
  updateCode();
}

function createStarterProgram() {
  const first = makeMoveCmBlock("forward", 50);
  first.moveBy(40, 40);
}

function makeMoveCmBlock(dir, distanceCm) {
  const block = workspace.newBlock("robot_move_cm");
  block.setFieldValue(dir, "DIR");
  connectNumber(block, "DISTANCE_CM", distanceCm);
  block.initSvg();
  block.render();
  return block;
}

function makeMoveBlock(dir, seconds) {
  const block = workspace.newBlock("robot_move");
  block.setFieldValue(dir, "DIR");
  connectNumber(block, "SECONDS", seconds);
  block.initSvg();
  block.render();
  return block;
}

function makeTurnBlock(dir, seconds) {
  const block = workspace.newBlock("robot_turn");
  block.setFieldValue(dir, "DIR");
  connectNumber(block, "SECONDS", seconds);
  block.initSvg();
  block.render();
  return block;
}

function connectNumber(block, inputName, value) {
  const number = workspace.newBlock("math_number");
  number.setFieldValue(String(value), "NUM");
  number.initSvg();
  number.render();
  block.getInput(inputName).connection.connect(number.outputConnection);
}

function isBlocklyCodeChange(event) {
  if (!event) return false;
  if (event.isUiEvent) return false;
  const codeEvents = new Set([
    Blockly.Events.BLOCK_CHANGE,
    Blockly.Events.BLOCK_CREATE,
    Blockly.Events.BLOCK_DELETE,
    Blockly.Events.BLOCK_MOVE,
    Blockly.Events.VAR_CREATE,
    Blockly.Events.VAR_DELETE,
    Blockly.Events.VAR_RENAME
  ]);
  return codeEvents.has(event.type);
}

const EXECUTION_HIGHLIGHT_PREFIX =
  "await robot.highlightBlock(%1);\nif (robot.stopped()) return;\n";

const PROGRAM_STRUCTURE_WARNING_ID = "program-structure";
const PROCEDURE_DEFINITION_TYPES = new Set(["procedures_defnoreturn", "procedures_defreturn"]);
const SIDE_EFFECT_VALUE_ROOT_TYPES = new Set(["procedures_callreturn"]);

function clearProgramStructureWarnings() {
  if (!workspace) return;
  workspace.getAllBlocks(false).forEach(block => {
    block.setWarningText?.(null, PROGRAM_STRUCTURE_WARNING_ID);
  });
}

function blockCanRun(block) {
  return Boolean(
    block
      && !block.disabled
      && !block.getInheritedDisabled?.()
      && !block.isInsertionMarker?.()
  );
}

function executableProgramRoots() {
  if (!workspace) return [];
  return workspace.getTopBlocks(true).filter(block =>
    blockCanRun(block)
      && !block.isShadow?.()
      && !PROCEDURE_DEFINITION_TYPES.has(block.type)
      && !(block.outputConnection && !SIDE_EFFECT_VALUE_ROOT_TYPES.has(block.type))
  );
}

function disconnectedValueRoots() {
  if (!workspace) return [];
  return workspace.getTopBlocks(true).filter(block =>
    blockCanRun(block)
      && !block.isShadow?.()
      && !PROCEDURE_DEFINITION_TYPES.has(block.type)
      && block.outputConnection
      && !SIDE_EFFECT_VALUE_ROOT_TYPES.has(block.type)
  );
}

function setProgramStructureWarning(blocks, message) {
  blocks.forEach(block => block?.setWarningText?.(message, PROGRAM_STRUCTURE_WARNING_ID));
}

function inspectProgramStructure() {
  clearProgramStructureWarnings();
  if (!workspace) return { ok: false, message: "Blockly 工作区尚未准备好。" };

  const activeBlocks = workspace.getAllBlocks(false).filter(blockCanRun);
  const valueRoots = disconnectedValueRoots();
  const roots = executableProgramRoots();
  const foreverWithTail = activeBlocks.filter(block => block.type === "robot_forever" && block.getNextBlock?.());

  if (valueRoots.length > 0) {
    const message = valueRoots.length === 1
      ? "这个数值、条件或文本积木没有连接，计算结果会被丢弃。请把它接到条件、数字输入或“输出”积木中。"
      : `有 ${valueRoots.length} 个数值、条件或文本积木没有连接，计算结果会被丢弃。请把它们接到条件、数字输入或“输出”积木中。`;
    setProgramStructureWarning(valueRoots, message);
    return { ok: false, message };
  }

  if (foreverWithTail.length > 0) {
    const message = "“持续巡逻”不会自然结束，它后面连接的积木无法执行。请把这些积木移到巡逻内部或巡逻前面。";
    setProgramStructureWarning(foreverWithTail.flatMap(block => [block, block.getNextBlock()]), message);
    return { ok: false, message };
  }

  if (roots.length > 1) {
    const containsForever = roots.some(root =>
      (root.getDescendants?.(false) || []).some(block => blockCanRun(block) && block.type === "robot_forever")
    );
    const message = containsForever
      ? `检测到 ${roots.length} 组断开的主程序，其中包含“持续巡逻”；巡逻开始后，排在后面的独立积木永远不会执行。请连接成一组主程序。`
      : `检测到 ${roots.length} 组断开的主程序。它们的执行顺序取决于画布位置，请先连接成一组主程序。`;
    setProgramStructureWarning(roots, message);
    return { ok: false, message };
  }

  if (roots.length === 0 && activeBlocks.some(block => PROCEDURE_DEFINITION_TYPES.has(block.type))) {
    const definitions = activeBlocks.filter(block => PROCEDURE_DEFINITION_TYPES.has(block.type));
    const message = "当前只有函数定义，还没有主程序。请从“函数”分类放入调用积木。";
    setProgramStructureWarning(definitions, message);
    return { ok: false, message };
  }

  return { ok: true, roots };
}

function generateBlocklyCode(withExecutionHighlight = false) {
  const generator = Blockly.JavaScript;
  const previousPrefix = generator.STATEMENT_PREFIX;
  try {
    generator.STATEMENT_PREFIX = withExecutionHighlight ? EXECUTION_HIGHLIGHT_PREFIX : null;
    return generator.workspaceToCode(workspace);
  } finally {
    generator.STATEMENT_PREFIX = previousPrefix;
  }
}

function setExecutionHighlight(blockId) {
  if (!workspace) return;

  const nextId = blockId == null ? null : String(blockId);
  const nextBlock = nextId ? workspace.getBlockById(nextId) : null;
  if (nextBlock && highlightedBlockId === nextId) {
    nextBlock.getSvgRoot()?.classList.add("is-executing");
    return;
  }

  if (highlightedBlockId) {
    workspace.getBlockById(highlightedBlockId)?.getSvgRoot()?.classList.remove("is-executing");
  }
  workspace.highlightBlock(null);
  highlightedBlockId = null;

  if (!nextBlock) return;
  workspace.highlightBlock(nextId);
  nextBlock.getSvgRoot()?.classList.add("is-executing");
  highlightedBlockId = nextId;
}

function clearExecutionHighlight() {
  setExecutionHighlight(null);
}

class RunCancelledError extends Error {
  constructor(reason = "stopped") {
    super(reason);
    this.name = "RunCancelledError";
  }
}

function createRunContext(target, robotBaseUrl = null) {
  const controller = new AbortController();
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  return {
    id: ++runToken,
    target,
    phase: "running",
    controller,
    signal: controller.signal,
    robotBaseUrl: target === "real" ? robotBaseUrl : null,
    pauseRequested: false,
    resumePromise: null,
    resume: null,
    dirty: false,
    checkpointCount: 0,
    startedAt: performance.now(),
    startPose: { x: Number(robotPose.x) || 0, z: Number(robotPose.z) || 0, heading: Number(robotPose.heading) || 0 },
    distanceWorld: 0,
    navigationQueryCount: 0,
    roadControlCount: 0,
    visionQueryCount: 0,
    sensorTick: 0,
    procedureCallCount: 0,
    procedureCallDepth: 0,
    executedApiMethods: [],
    executedApiMethodSet: new Set(),
    lastRoadResult: null,
    loopLogState: new Map(),
    emptyLoopWarnings: new Set(),
    reason: null,
    done,
    resolveDone
  };
}

function runContextIsCurrent(context) {
  return Boolean(context && activeRun === context && !context.signal.aborted);
}

function setRealStopHazard(value) {
  realStopHazard = Boolean(value);
  try {
    localStorage.setItem("chenlongRealStopHazard", realStopHazard ? "1" : "0");
  } catch {}
  updateRunControls();
}

function throwIfRunCancelled(context) {
  if (!runContextIsCurrent(context)) throw new RunCancelledError(context?.reason || "stopped");
}

function ensureRunResumeGate(context) {
  if (context.resumePromise) return;
  context.resumePromise = new Promise(resolve => { context.resume = resolve; });
}

function releaseRunResumeGate(context) {
  const resume = context?.resume;
  if (context) {
    context.resumePromise = null;
    context.resume = null;
  }
  resume?.();
}

function updateRunControls() {
  const context = activeRun;
  const pausing = context?.phase === "pausing";
  const paused = context?.phase === "paused";
  const active = Boolean(context);
  const transitioning = runControlBusy || realStopPending
    || ["stopping", "resetting", "completing"].includes(context?.phase);
  const realRunLocked = realStopHazard && targetSelect?.value === "real" && !active;
  if (runButton) {
    runButton.disabled = !primaryUser || transitioning || realRunLocked || (active && !paused);
    runButton.querySelector("span").textContent = paused
      ? context.dirty ? "按新代码运行" : "继续运行"
      : active ? "正在运行" : !primaryUser ? "请先登录" : realRunLocked ? "请先重新停止" : "运行代码";
  }
  if (pauseButton) {
    pauseButton.disabled = transitioning || !active || paused || pausing;
    pauseButton.querySelector("span").textContent = pausing ? "正在暂停" : "暂停";
  }
  if (stopButton) stopButton.disabled = transitioning || (!active && targetSelect?.value !== "real");
  if (resetButton) resetButton.disabled = transitioning;
  if (targetSelect) targetSelect.disabled = transitioning || active;
  if (robotBaseUrlInput) robotBaseUrlInput.disabled = transitioning || active;
  if (applyRobotIpButton) applyRobotIpButton.disabled = transitioning || active;
  protocolToggle?.querySelectorAll("button").forEach(button => {
    button.disabled = transitioning || active;
  });
  const lockSceneEditing = transitioning || active;
  const sceneSelect = document.querySelector("#sceneSelect");
  if (sceneSelect) sceneSelect.disabled = lockSceneEditing;
  if (mapStyleSelect) mapStyleSelect.disabled = lockSceneEditing;
  document.querySelectorAll("[data-place], #clearSceneButton, #savedMapButton").forEach(control => {
    control.disabled = lockSceneEditing;
  });
  document.querySelectorAll("#saveMapButton, #savedMapDropdown button").forEach(control => {
    control.disabled = lockSceneEditing;
  });
  if (lockSceneEditing) closeSavedMapMenu();
}

async function waitForRunCheckpoint(context) {
  throwIfRunCancelled(context);
  if (!context.pauseRequested) return false;
  context.phase = "paused";
  ensureRunResumeGate(context);
  if (context.target === "sim" && robotGroup) updateRobotTelemetry(undefined, true);
  setStatus(context.dirty ? "已暂停；代码已修改" : "已暂停");
  updateRunControls();
  await context.resumePromise;
  throwIfRunCancelled(context);
  return true;
}

function requestRunPause(context, reason = "user") {
  if (!runContextIsCurrent(context) || context.pauseRequested) return false;
  context.pauseRequested = true;
  context.phase = "pausing";
  context.pauseReason = reason;
  ensureRunResumeGate(context);
  setStatus(context.target === "real" ? "将在当前动作后暂停" : "正在暂停");
  updateRunControls();
  return true;
}

function resumeRun(context) {
  if (!runContextIsCurrent(context) || !context.pauseRequested) return false;
  context.pauseRequested = false;
  context.phase = "running";
  releaseRunResumeGate(context);
  setStatus("继续运行");
  updateRunControls();
  return true;
}

function abortRunContext(context, reason = "stopped") {
  if (!context || context.signal.aborted) return;
  context.reason = reason;
  context.phase = reason === "reset" ? "resetting" : reason === "mission-complete" ? "completing" : "stopping";
  context.controller.abort(reason);
  releaseRunResumeGate(context);
  if (activeRun === context) {
    clearExecutionHighlight();
    clearRuntimeFeedback();
  }
  if (context.target === "sim" && robotGroup) updateRobotTelemetry(undefined, true);
  updateRunControls();
}

function sleepForRun(ms, context) {
  throwIfRunCancelled(context);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      context.signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RunCancelledError(context.reason || "stopped"));
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitRunDuration(ms, context, maxSlice = 32, onProgress = null) {
  let elapsed = 0;
  onProgress?.(elapsed, ms);
  while (elapsed < ms) {
    await waitForRunCheckpoint(context);
    const slice = Math.min(maxSlice, ms - elapsed);
    const started = performance.now();
    await sleepForRun(slice, context);
    elapsed += Math.min(slice, performance.now() - started);
    onProgress?.(elapsed, ms);
  }
}

async function highlightExecutionBlock(blockId, context) {
  await waitForRunCheckpoint(context);
  throwIfRunCancelled(context);
  context.checkpointCount += 1;
  if (context.checkpointCount % 24 === 0) await sleepForRun(0, context);
  setExecutionHighlight(blockId);
}

function updateCode(event) {
  const code = generateBlocklyCode(false).trim();
  codeOutput.textContent = code || "// 拖动积木后，这里会显示 JavaScript 代码";
  if (activeRun && isBlocklyCodeChange(event)) {
    if (!activeRun.dirty) {
      addLog(activeRun.phase === "paused" ? "积木已修改：再次运行会按新代码重新开始。" : "积木已修改：当前正在运行的程序不会改变。");
    }
    activeRun.dirty = true;
    if (activeRun.phase === "paused") setStatus("代码已修改");
  }
}

function zoomBlocklyWorkspace(direction) {
  if (!workspace) return;
  if (workspace.zoomCenter) {
    workspace.zoomCenter(direction);
  } else if (workspace.setScale) {
    const nextScale = Math.max(0.55, Math.min(1.4, workspace.scale * (direction > 0 ? 1.2 : 0.83)));
    workspace.setScale(nextScale);
  }
  Blockly.svgResize(workspace);
}

function centerBlocklyWorkspace() {
  if (!workspace) return;
  const selected = Blockly.getSelected && Blockly.getSelected();
  const block = selected && selected.workspace === workspace && selected.id
    ? selected
    : workspace.getTopBlocks(false)[0];
  if (block && workspace.centerOnBlock) {
    workspace.centerOnBlock(block.id);
  } else if (workspace.scrollCenter) {
    workspace.scrollCenter();
  }
}

function deleteBlocklySelection() {
  if (!workspace) return;
  const selected = Blockly.getSelected && Blockly.getSelected();
  if (selected && selected.workspace === workspace && selected.dispose) {
    selected.dispose(true, true);
    updateCode();
    return;
  }
  if (window.confirm("没有选中积木，是否清空工作区？")) {
    workspace.clear();
    updateCode();
  }
}

function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color("#091321");
  scene.fog = new THREE.Fog("#091321", 15, 34);
  camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
  camera.position.set(7.1, 8.6, 8.6);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ canvas: document.querySelector("#simCanvas"), antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const hemi = new THREE.HemisphereLight(0xbfe7ff, 0x26364a, 1.75);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff7e8, 2.15);
  sun.position.set(7, 12, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -18;
  sun.shadow.camera.right = 18;
  sun.shadow.camera.top = 18;
  sun.shadow.camera.bottom = -18;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 42;
  sun.shadow.bias = -0.00035;
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x38bdf8, 0.72);
  rim.position.set(-8, 5, -7);
  scene.add(rim);

  const floorBase = new THREE.Mesh(
    new THREE.BoxGeometry(MAP_SIZE + 0.5, 0.24, MAP_SIZE + 0.5),
    new THREE.MeshStandardMaterial({ color: "#1b2b3d", metalness: 0.12, roughness: 0.78 })
  );
  floorBase.position.y = -0.14;
  floorBase.receiveShadow = true;
  scene.add(floorBase);
  floorBaseMesh = floorBase;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE),
    new THREE.MeshStandardMaterial({ color: "#46576a", metalness: 0.04, roughness: 0.86 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  gridPlane = floor;
  floorMesh = floor;

  const grid = new THREE.GridHelper(MAP_SIZE, MAP_SIZE, "#f6d365", "#8ea0b6");
  scene.add(grid);
  gridHelper = grid;
  addRoadLines();
  buildCompetitionField();
  setMapStyle("basic", false);
  robotGroup = createRobot();
  enableObjectShadows(robotGroup);
  scene.add(robotGroup);
  initTrajectoryLine();

  raycaster = new THREE.Raycaster();
  simulator.addEventListener("click", placeObjectFromClick);
  simulator.addEventListener("pointerdown", startOrbitDrag);
  simulator.addEventListener("pointermove", orbitDrag);
  window.addEventListener("pointerup", endOrbitDrag);
  simulator.addEventListener("wheel", zoomCamera, { passive: false });
  window.addEventListener("resize", () => {
    const current = Number.parseFloat(getComputedStyle(workspaceGrid).getPropertyValue("--right-panel-width")) || 460;
    setRightPanelWidth(current, false);
    const stateHeight = Number.parseFloat(getComputedStyle(sidePanel).getPropertyValue("--state-panel-height")) || 148;
    setStatePanelHeight(stateHeight, false);
  });
  resizeRenderer();
  setCameraMode("iso");
  const sceneSelect = document.querySelector("#sceneSelect");
  const initialSceneKey = restoredBlocklySceneKey || "guangyang1";
  if (sceneSelect) sceneSelect.value = initialSceneKey;
  loadMission(initialSceneKey);
  requestAnimationFrame(animate);
}

function enableObjectShadows(object, cast = true, receive = true) {
  object.traverse(node => {
    if (!node.isMesh) return;
    if (node.geometry && !node.geometry.boundingBox) node.geometry.computeBoundingBox();
    const box = node.geometry?.boundingBox;
    const volume = box
      ? Math.max(0, box.max.x - box.min.x) * Math.max(0, box.max.y - box.min.y) * Math.max(0, box.max.z - box.min.z)
      : 1;
    node.castShadow = cast && volume >= 0.0008;
    node.receiveShadow = receive;
  });
  return object;
}

function addRoadLines() {
  const material = new THREE.MeshBasicMaterial({ color: "#f8fafc" });
  for (let i = -4; i <= 4; i += 2) {
    const lineA = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.012, MAP_SIZE - 0.6), material);
    lineA.position.set(i, 0.014, 0);
    scene.add(lineA);
    roadLineMeshes.push(lineA);
    const lineB = new THREE.Mesh(new THREE.BoxGeometry(MAP_SIZE - 0.6, 0.012, 0.06), material);
    lineB.position.set(0, 0.016, i);
    scene.add(lineB);
    roadLineMeshes.push(lineB);
  }
}

function addCompetitionRoads() {
  const roadMat = new THREE.MeshBasicMaterial({ color: "#3b4652", side: THREE.DoubleSide });
  const laneMat = new THREE.MeshBasicMaterial({ color: "#efd96c", transparent: true, opacity: 0.92 });
  const edgeMat = new THREE.MeshBasicMaterial({ color: "#cbd5e1", transparent: true, opacity: 0.72 });

  const roadWidth = 1.22;
  addFlatRect(0, 0, roadWidth, MAP_SIZE - 1.05, 0.024, roadMat, competitionRoadMeshes);
  addFlatRect(0, 0, MAP_SIZE - 1.05, roadWidth, 0.025, roadMat, competitionRoadMeshes);

  addDashedLine(0, 0, "vertical", MAP_SIZE - 1.7, laneMat);
  addDashedLine(0, 0, "horizontal", MAP_SIZE - 1.7, laneMat);

  [
    [-5.42, 0, 0.06, MAP_SIZE - 1.25], [5.42, 0, 0.06, MAP_SIZE - 1.25],
    [0, -5.42, MAP_SIZE - 1.25, 0.06], [0, 5.42, MAP_SIZE - 1.25, 0.06]
  ].forEach(([x, z, w, h]) => addRaisedRect(x, z, w, h, 0.018, 0.035, edgeMat, competitionRoadMeshes));
}

function addFlatRect(x, z, w, h, y, material, targetList) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, y, z);
  scene.add(mesh);
  targetList.push(mesh);
  return mesh;
}

function addRaisedRect(x, z, w, h, y, height, material, targetList) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, height, h), material);
  mesh.position.set(x, y, z);
  scene.add(mesh);
  targetList.push(mesh);
  return mesh;
}

function addDashedLine(x, z, orientation, length, material) {
  const segmentLength = 0.46;
  const gap = 0.34;
  const count = Math.floor(length / (segmentLength + gap));
  const start = -((count - 1) * (segmentLength + gap)) / 2;
  for (let i = 0; i < count; i++) {
    const offset = start + i * (segmentLength + gap);
    const w = orientation === "vertical" ? 0.045 : segmentLength;
    const h = orientation === "vertical" ? segmentLength : 0.045;
    addRaisedRect(
      orientation === "vertical" ? x : x + offset,
      orientation === "vertical" ? z + offset : z,
      w,
      h,
      0.052,
      0.012,
      material,
      competitionRoadMeshes
    );
  }
}

function buildCompetitionField() {
  buildBoundaryWalls();
  addCompetitionRoads();
  COMPETITION_ZONES.forEach(zone => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(zone.w, zone.h),
      new THREE.MeshBasicMaterial({ color: zone.color, transparent: true, opacity: 0.78, side: THREE.DoubleSide })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(zone.x, 0.066, zone.z);
    scene.add(mesh);
    competitionMeshes.push(mesh);
    competitionMeshes.push(createTextLabel(zone.label, zone.lx, zone.lz, 0.92));
  });

  COMPETITION_FIXED_WALLS.forEach(({ x, z, w, h }) => {
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.42, h),
      new THREE.MeshStandardMaterial({ color: "#344054", roughness: 0.7, transparent: true, opacity: 0.72 })
    );
    wall.position.set(x, 0.22, z);
    enableObjectShadows(wall);
    scene.add(wall);
    competitionMeshes.push(wall);
    competitionWallColliders.push({ x, z, w, h });
  });

  addRecycleStation(-2.8, 2.4);
  addGarden(-3.35, -3.35);
  addExpressStation(2.7, -2.45);
  addSupermarket(2.25, 1.95);
}

function addCompetitionObject(object) {
  enableObjectShadows(object);
  scene.add(object);
  competitionMeshes.push(object);
  return object;
}

function addRecycleStation(x, z) {
  const group = new THREE.Group();
  const beltMat = new THREE.MeshStandardMaterial({ color: "#111827", roughness: 0.52 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: "#cbd5e1", metalness: 0.25, roughness: 0.32 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.08, 0.34), beltMat);
  base.position.set(0, 0.09, 0.3);
  group.add(base);
  const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.06, 16), edgeMat);
  roller.rotation.z = Math.PI / 2;
  roller.position.set(0, 0.15, 0.11);
  group.add(roller);
  ["#ef4444", "#2563eb", "#16a34a", "#94a3b8"].forEach((color, index) => {
    const bin = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.26, 0.24),
      new THREE.MeshStandardMaterial({ color, roughness: 0.48 })
    );
    bin.position.set(-0.36 + index * 0.24, 0.17, -0.14);
    group.add(bin);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.035, 0.26), edgeMat);
    lid.position.set(bin.position.x, 0.32, -0.14);
    group.add(lid);
  });
  group.position.set(x, 0, z);
  addCompetitionObject(group);
}

function addGarden(x, z) {
  const group = new THREE.Group();
  const trunkMat = new THREE.MeshStandardMaterial({ color: "#8b5a2b", roughness: 0.72 });
  const leafMat = new THREE.MeshStandardMaterial({ color: "#22c55e", roughness: 0.6 });
  [[-0.42, -0.18], [0.36, 0.18]].forEach(([tx, tz]) => {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.28, 10), trunkMat);
    trunk.position.set(tx, 0.18, tz);
    group.add(trunk);
    const crown = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), leafMat);
    crown.position.set(tx, 0.4, tz);
    group.add(crown);
  });
  const bench = new THREE.Mesh(
    new THREE.BoxGeometry(0.54, 0.08, 0.14),
    new THREE.MeshStandardMaterial({ color: "#facc15", roughness: 0.55 })
  );
  bench.position.set(0, 0.18, -0.28);
  group.add(bench);
  group.position.set(x, 0, z);
  addCompetitionObject(group);
}

function addExpressStation(x, z) {
  const group = new THREE.Group();
  const shelfMat = new THREE.MeshStandardMaterial({ color: "#ef4444", roughness: 0.45 });
  const boxMat = new THREE.MeshStandardMaterial({ color: "#f59e0b", roughness: 0.54 });
  [0, 1, 2].forEach(level => {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.05, 0.32), shelfMat);
    shelf.position.set(0, 0.12 + level * 0.2, 0);
    group.add(shelf);
    for (let i = 0; i < 3; i++) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.15), boxMat);
      box.position.set(-0.22 + i * 0.22, 0.19 + level * 0.2, 0.02);
      group.add(box);
    }
  });
  group.position.set(x, 0, z);
  addCompetitionObject(group);
}

function addSupermarket(x, z) {
  const group = new THREE.Group();
  const shelfMat = new THREE.MeshStandardMaterial({ color: "#f8fafc", roughness: 0.5 });
  const fruitColors = ["#ef4444", "#facc15", "#22c55e", "#f97316"];
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.44, 0.18), shelfMat);
  shelf.position.set(0, 0.26, 0.1);
  group.add(shelf);
  fruitColors.forEach((color, index) => {
    const fruit = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 14, 10),
      new THREE.MeshStandardMaterial({ color, roughness: 0.48 })
    );
    fruit.position.set(-0.3 + index * 0.2, 0.54, 0.0);
    group.add(fruit);
  });
  const sign = new THREE.Mesh(
    new THREE.BoxGeometry(0.72, 0.18, 0.04),
    new THREE.MeshStandardMaterial({ color: "#fde68a", roughness: 0.4 })
  );
  sign.position.set(0, 0.72, 0.0);
  group.add(sign);
  group.position.set(x, 0, z);
  addCompetitionObject(group);
}

function buildBoundaryWalls() {
  [
    [-MAP_HALF, 0, 0.08, MAP_SIZE],
    [MAP_HALF, 0, 0.08, MAP_SIZE],
    [0, -MAP_HALF, MAP_SIZE, 0.08],
    [0, MAP_HALF, MAP_SIZE, 0.08]
  ].forEach(([x, z, w, h]) => {
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.42, h),
      new THREE.MeshStandardMaterial({ color: "#344054", roughness: 0.7, transparent: true, opacity: 0.72 })
    );
    wall.position.set(x, 0.22, z);
    enableObjectShadows(wall);
    scene.add(wall);
    boundaryMeshes.push(wall);
    boundaryColliders.push({ x, z, w, h });
  });
}

function createTextLabel(text, x, z, y) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(15, 23, 42, 0.78)";
  ctx.roundRect(12, 18, 232, 60, 14);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 30px Microsoft YaHei, Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 49);
  const texture = new THREE.CanvasTexture(canvas);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  label.position.set(x, y + 0.04, z);
  label.scale.set(1.18, 0.44, 1);
  label.renderOrder = 12;
  scene.add(label);
  return label;
}

function getMissionVisualPalette() {
  const palettes = {
    delivery: { background: "#091522", floor: "#46576a", base: "#1b2b3d", accent: "#38bdf8", obstacle: "#53657a" },
    campus: { background: "#0a1b22", floor: "#48605e", base: "#183331", accent: "#34d399", obstacle: "#596f69" },
    warehouse: { background: "#0c1420", floor: "#3f4b5a", base: "#182331", accent: "#f59e0b", obstacle: "#4b607a" },
    training: { background: "#131522", floor: "#4c5262", base: "#202637", accent: "#fb923c", obstacle: "#c45b2d" },
    harbor: { background: "#061823", floor: "#344e5b", base: "#102b36", accent: "#22d3ee", obstacle: "#35698a" },
    city: { background: "#071827", floor: "#3b5264", base: "#14293a", accent: "#22d3ee", obstacle: "#334b63" },
    canyon: { background: "#21140e", floor: "#685342", base: "#2d2119", accent: "#fb923c", obstacle: "#78553d" },
    sandbox: { background: "#0b1727", floor: "#48586a", base: "#1a2b3e", accent: "#a78bfa", obstacle: "#5d6b80" },
    maze: { background: "#080b12", floor: "#263445", base: "#111923", accent: "#f59e0b", obstacle: "#b9814e" },
    guangyang: { background: "#0a2941", floor: "#c9e6f6", base: "#16405a", accent: "#38bdf8", obstacle: "#64748b" }
  };
  return palettes[activeMission?.environment] || palettes.delivery;
}

function updateSceneAtmosphere(competition) {
  const palette = getMissionVisualPalette();
  const background = competition ? "#091522" : palette.background;
  scene.background.set(background);
  if (!scene.fog) scene.fog = new THREE.Fog(background, 15, 34);
  scene.fog.color.set(background);
  scene.fog.near = isLargeMap() ? 31 : 15;
  scene.fog.far = isLargeMap() ? 70 : 32;
}

function setMapStyle(style, refreshObjects = true) {
  simulator?.classList.toggle("is-maze-map", activeMission.theme === "maze");
  const supportsCompetition = !isLargeMap()
    && ["delivery", "sandbox"].includes(activeMission.environment || "delivery");
  const competition = style === "competition" && supportsCompetition;
  const resolvedStyle = competition ? "competition" : "basic";
  currentMapStyle = resolvedStyle;
  if (mapStyleSelect) {
    mapStyleSelect.value = resolvedStyle;
    const competitionOption = mapStyleSelect.querySelector('option[value="competition"]');
    if (competitionOption) competitionOption.disabled = !supportsCompetition;
  }
  const mapScale = currentMapSize() / MAP_SIZE;
  const isGuangyang = activeMission.environment === "guangyang";
  floorMesh.scale.set(mapScale, mapScale, 1);
  floorMesh.visible = !isGuangyang;
  if (floorBaseMesh) floorBaseMesh.scale.set(mapScale, 1, mapScale);
  if (floorBaseMesh) floorBaseMesh.visible = !isGuangyang;
  const palette = getMissionVisualPalette();
  floorMesh.material.color.set(competition ? "#536273" : palette.floor);
  if (floorBaseMesh) floorBaseMesh.material.color.set(competition ? "#1b2c3b" : palette.base);
  updateSceneAtmosphere(competition);
  boundaryMeshes.forEach(mesh => { mesh.visible = !isLargeMap(); });
  if (gridHelper) gridHelper.visible = !competition && !isLargeMap();
  roadLineMeshes.forEach(mesh => { mesh.visible = !competition && !isLargeMap(); });
  competitionRoadMeshes.forEach(mesh => { mesh.visible = competition; });
  competitionMeshes.forEach(mesh => { mesh.visible = competition; });
  if (refreshObjects && robotGroup) rebuildSceneObjects();
  ensureRobotOnFreeCell();
  addLog(activeMission.theme === "maze"
    ? "已切换到迷宫专用场地。"
    : isLargeMap()
      ? `已切换到 ${currentMapSize()}×${currentMapSize()} 大型主题地图。`
    : style === "competition" && !supportsCompetition
      ? "当前任务使用专属主题场地，已保留主题外观。"
      : competition
        ? "已切换到比赛场地地图。"
        : "已切换到基础网格地图。");
}

function getCompetitionReservedRects() {
  return COMPETITION_ZONES
    .map(({ x, z, w, h }) => ({ x, z, w, h }))
    .concat(COMPETITION_FIXED_WALLS);
}

function pointWithinPlayableArea(x, z, radius) {
  return Math.abs(x) <= currentMapInner() - radius && Math.abs(z) <= currentMapInner() - radius;
}

function pointOverlapsCompetitionModel(x, z, radius) {
  if (currentMapStyle !== "competition" || activeMission.theme === "maze") return false;
  return getCompetitionReservedRects().some(rect => circleHitsRect(x, z, radius + 0.12, rect));
}

function pointOverlapsUsedObjects(x, z, radius, usedObjects) {
  return usedObjects.some(item => Math.hypot(item.x - x, item.z - z) < radius + item.radius + 0.18);
}

function pointAvailableForMissionObject(x, z, radius, usedObjects) {
  return pointWithinPlayableArea(x, z, radius)
    && !pointOverlapsCompetitionModel(x, z, radius)
    && !pointOverlapsUsedObjects(x, z, radius, usedObjects);
}

function pointAvailableForRobot(x, z) {
  if (!pointWithinPlayableArea(x, z, ROBOT_RADIUS)) return false;
  if (isBlockedByWalls(x, z)) return false;
  if (packageMeshes.some(mesh => mesh !== heldPackageMesh && Math.hypot(mesh.position.x - x, mesh.position.z - z) < ROBOT_RADIUS + PACKAGE_RADIUS)) return false;
  return !obstacleMeshes.some(mesh => Math.hypot(mesh.position.x - x, mesh.position.z - z) < ROBOT_RADIUS + BLOCK_RADIUS);
}

function findNearestFreeRobotPoint(pos) {
  let best = null;
  const step = 0.5;
  for (let x = -currentMapHalf() + 1; x <= currentMapHalf() - 1; x += step) {
    for (let z = -currentMapHalf() + 1; z <= currentMapHalf() - 1; z += step) {
      if (!pointAvailableForRobot(x, z)) continue;
      const distance = Math.hypot(x - pos.x, z - pos.z);
      if (!best || distance < best.distance) best = { x, z, distance };
    }
  }
  return best;
}

function ensureRobotOnFreeCell() {
  if (!robotGroup || targetSelect?.value === "real") return;
  if (pointAvailableForRobot(robotPose.x, robotPose.z)) return;
  const next = findNearestFreeRobotPoint(robotPose);
  if (!next) return;
  robotPose.x = next.x;
  robotPose.z = next.z;
  blockedMoveCount = 0;
  lastMoveBlocked = false;
  syncRobot();
  resetTrajectory();
  setStatus("已调整小车位置");
  addLog("小车位置和场地模型重叠，已自动移动到最近的空地。");
}

function findNearestFreeMissionPoint(pos, radius, usedObjects) {
  let best = null;
  for (let x = -currentMapHalf() + 1; x <= currentMapHalf() - 1; x += 1) {
    for (let z = -currentMapHalf() + 1; z <= currentMapHalf() - 1; z += 1) {
      if (!pointAvailableForMissionObject(x, z, radius, usedObjects)) continue;
      const distance = Math.hypot(x - pos[0], z - pos[1]);
      if (!best || distance < best.distance) best = { x, z, distance };
    }
  }
  return best ? [best.x, best.z] : null;
}

function sanitizeMissionForCurrentMapStyle() {
  if (currentMapStyle !== "competition" || activeMission.theme === "maze") return false;
  let changed = false;
  const usedObjects = [];
  const cleanObstacles = [];

  activeMission.obstacles.forEach(([rawX, rawZ]) => {
    const x = Number(rawX);
    const z = Number(rawZ);
    if (!pointAvailableForMissionObject(x, z, BLOCK_RADIUS, usedObjects)) {
      changed = true;
      return;
    }
    usedObjects.push({ x, z, radius: BLOCK_RADIUS });
    cleanObstacles.push([x, z]);
  });
  activeMission.obstacles = cleanObstacles;

  const keepOrMoveMarker = (pos, radius) => {
    if (!pos) return null;
    const normalized = [Number(pos[0]), Number(pos[1])];
    if (pointAvailableForMissionObject(normalized[0], normalized[1], radius, usedObjects)) {
      usedObjects.push({ x: normalized[0], z: normalized[1], radius });
      return normalized;
    }
    const moved = findNearestFreeMissionPoint(normalized, radius, usedObjects);
    changed = true;
    if (!moved) return null;
    usedObjects.push({ x: moved[0], z: moved[1], radius });
    return moved;
  };

  const cleanPackages = [];
  ensureMissionPackages().forEach(record => {
    const existingStack = cleanPackages.find(item => Math.hypot(item.x - record.x, item.z - record.z) < 0.05);
    if (existingStack) {
      cleanPackages.push({ ...record, x: existingStack.x, z: existingStack.z });
      return;
    }
    const placed = keepOrMoveMarker([record.x, record.z], PACKAGE_RADIUS);
    if (placed) cleanPackages.push({ ...record, x: placed[0], z: placed[1] });
  });
  activeMission.packages = cleanPackages;
  activeMission.goal = keepOrMoveMarker(activeMission.goal, 0.42);

  if (changed) {
    setStatus("已避开固定场地模型");
    addLog("已自动调整任务物体，避免和比赛场地建筑重叠。");
  }
  return changed;
}

function createRobot() {
  const group = new THREE.Group();
  robotWheels = [];
  const matteBlack = new THREE.MeshStandardMaterial({ color: "#080b10", metalness: 0.45, roughness: 0.36 });
  const plateMat = new THREE.MeshStandardMaterial({ color: "#111827", metalness: 0.55, roughness: 0.28 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: "#d1d5db", metalness: 0.65, roughness: 0.24 });
  const blueMat = new THREE.MeshStandardMaterial({ color: "#1d4ed8", metalness: 0.35, roughness: 0.34 });
  const tireMat = new THREE.MeshStandardMaterial({ color: "#050505", roughness: 0.72 });
  const accentMat = new THREE.MeshStandardMaterial({ color: "#f97316", metalness: 0.2, roughness: 0.4 });
  const lightMat = new THREE.MeshStandardMaterial({ color: "#fff7ad", emissive: "#fff1a6", emissiveIntensity: 1.2 });

  const lowerPlate = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.08, 0.66), plateMat);
  lowerPlate.position.y = 0.18;
  group.add(lowerPlate);

  const upperPlate = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.06, 0.54), matteBlack);
  upperPlate.position.y = 0.39;
  group.add(upperPlate);

  const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.08, 0.05), edgeMat);
  frontBumper.position.set(0, 0.22, -0.38);
  group.add(frontBumper);

  const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.08, 0.05), edgeMat);
  rearBumper.position.set(0, 0.22, 0.38);
  group.add(rearBumper);

  [[-0.38, -0.28], [0.38, -0.28], [-0.38, 0.28], [0.38, 0.28]].forEach(([x, z]) => {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.24, 12), edgeMat);
    post.position.set(x, 0.3, z);
    group.add(post);
  });

  for (let x = -0.24; x <= 0.24; x += 0.12) {
    for (let z = -0.16; z <= 0.16; z += 0.12) {
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.008, 10), new THREE.MeshBasicMaterial({ color: "#020617" }));
      hole.position.set(x, 0.425, z);
      group.add(hole);
    }
  }

  [-0.22, 0.22].forEach(x => {
    const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.035, 0.035), lightMat);
    headlight.position.set(x, 0.28, -0.42);
    group.add(headlight);
  });

  const arm = new THREE.Group();
  const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.1, 24), matteBlack);
  shoulder.position.y = 0.47;
  arm.add(shoulder);

  const shoulderCap = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.08, 20), edgeMat);
  shoulderCap.rotation.x = Math.PI / 2;
  shoulderCap.position.set(0, 0.56, -0.06);
  arm.add(shoulderCap);

  const upperLink = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.58, 0.13), matteBlack);
  upperLink.position.set(0, 0.78, -0.14);
  upperLink.rotation.x = -0.56;
  arm.add(upperLink);

  const elbow = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.18, 20), edgeMat);
  elbow.rotation.z = Math.PI / 2;
  elbow.position.set(0, 1.02, -0.34);
  arm.add(elbow);

  const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.43, 0.12), matteBlack);
  forearm.position.set(0, 1.02, -0.56);
  forearm.rotation.x = -1.1;
  arm.add(forearm);

  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.18, 16), edgeMat);
  wrist.rotation.z = Math.PI / 2;
  wrist.position.set(0, 0.87, -0.77);
  arm.add(wrist);

  const wristConnector = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.095, 0.16), matteBlack);
  wristConnector.position.set(0, 0.88, -0.84);
  arm.add(wristConnector);

  const claw = new THREE.Group();
  const toolStem = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.06, 0.04), matteBlack);
  toolStem.position.set(0, 0, 0.055);
  claw.add(toolStem);
  const mount = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.11, 0.12), accentMat);
  mount.position.set(0, 0, -0.005);
  claw.add(mount);
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.075, 0.045), accentMat);
  palm.position.set(0, 0, -0.075);
  claw.add(palm);
  [-0.06, 0.06].forEach(x => {
    const fingerBase = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.07, 0.055), accentMat);
    fingerBase.position.set(x, 0, -0.12);
    claw.add(fingerBase);
    const fingerTip = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.045, 0.1), accentMat);
    fingerTip.position.set(x + (x < 0 ? -0.012 : 0.012), 0, -0.185);
    fingerTip.rotation.y = x < 0 ? -0.14 : 0.14;
    claw.add(fingerTip);
  });
  claw.position.set(0, 0.88, -0.91);
  arm.add(claw);
  group.add(arm);
  robotArm = arm;
  robotClaw = claw;

  [[-0.46, -0.27], [0.46, -0.27], [-0.46, 0.27], [0.46, 0.27]].forEach(([x, z]) => {
    const wheelGroup = new THREE.Group();
    wheelGroup.position.set(x, 0.16, z);
    wheelGroup.userData.side = x < 0 ? -1 : 1;
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.1, 28), tireMat);
    wheel.rotation.z = Math.PI / 2;
    wheelGroup.add(wheel);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.108, 24), blueMat);
    hub.rotation.z = Math.PI / 2;
    wheelGroup.add(hub);
    for (let i = 0; i < 6; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.006, 0.075), edgeMat);
      spoke.position.set(x < 0 ? -0.057 : 0.057, 0, 0);
      spoke.rotation.x = i * Math.PI / 3;
      wheelGroup.add(spoke);
    }
    robotWheels.push(wheelGroup);
    group.add(wheelGroup);
  });

  return group;
}

async function loadMission(key) {
  let cancellation = null;
  if (activeRun) cancellation = await cancelActiveRun("mission-change", { sendHardwareStop: true });
  if (!missions[key]) return;
  missionAttempt = null;
  activeMission = structuredClone(missions[key]);
  activeMission.packages = normalizePackageRecords(activeMission);
  renderMissionInfo();
  captureMissionBaseline();
  const missionMapStyle = activeMission.mapStyle || "basic";
  if (mapStyleSelect) mapStyleSelect.value = missionMapStyle;
  setMapStyle(missionMapStyle, false);
  resetRobot();
  rebuildSceneObjects();
  setCameraMode(cameraMode === "free" ? "iso" : cameraMode);
  clearActionLog();
  clearRuntimeFeedback();
  addLog("已载入场景，小车在起点等待。");
  initializeMissionAttempt();
  if (!missionAttempt?.completed) setStatus(targetSelect?.value === "real" ? "真实小车任务已载入" : "等待编程");
  if (cancellation?.hardwareStopRequested) {
    addLog(cancellation.hardwareStopSent
      ? "真实小车：切换任务前已发送停止指令，设备未回传确认状态。"
      : "警告：页面已切换任务，但真实小车停止指令发送失败，请现场确认。");
    if (!cancellation.hardwareStopSent) setStatus("任务已切换；小车停止失败");
  }
}

function disposeSceneObject(object) {
  if (!object) return;
  if (object.parent) object.parent.remove(object);
  if (object.userData?.kind === "package") return;
  object.traverse(node => {
    // InstancedMesh owns instanceMatrix / instanceColor GPU buffers in addition
    // to its shared geometry. Three.js releases those buffers on this event.
    if (node.isInstancedMesh) node.dispose();
    if (node.geometry?.dispose) node.geometry.dispose();
    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    materials.forEach(material => {
      Object.values(material).forEach(value => {
        if (value?.isTexture && value.dispose) value.dispose();
      });
      material.dispose?.();
    });
  });
}

function rebuildSceneObjects() {
  const buildGeneration = ++missionBuildGeneration;
  ensureMissionPackages();
  sanitizeMissionForCurrentMapStyle();
  const staleObjects = new Set([...obstacleMeshes, ...markerMeshes, ...missionWallMeshes, ...missionDecorationMeshes]);
  staleObjects.forEach(disposeSceneObject);
  obstacleMeshes = [];
  markerMeshes = [];
  missionWallMeshes = [];
  missionWallColliders = [];
  missionDecorationMeshes = [];
  primaryGuangyangReliefRoot = null;
  primaryGuangyangTerrainMesh = null;
  missionCheckpointPositions = [];
  goalPulseEffects = [];
  mazeSignalEffects = [];
  packageMeshes = [];
  heldPackageId = null;
  heldPackageMesh = null;
  if (robotClaw) robotClaw.scale.x = 1;

  if (activeMission.theme === "maze") {
    buildMazeMission();
  } else {
    // 广阳岛自带完整的道路与地形画面；不叠加通用大地图的方格和围栏。
    if (isLargeMap() && activeMission.environment !== "guangyang") buildLargeMissionBase();
    buildStandardMissionWalls();
  }
  buildMissionEnvironment(buildGeneration);

  activeMission.obstacles.forEach(([x, z], index) => {
    const block = createObstacleModel(x, z, index);
    scene.add(block);
    obstacleMeshes.push(block);
  });

  activeMission.packages.forEach((record, index) => {
    addPackageMarker(record, packageStackLevelForIndex(activeMission.packages, index), index);
  });
  if (activeMission.goal) addMarker(activeMission.goal, "goal", "#22c55e");
  ensureRobotOnFreeCell();
  rebuildRobotCollisionShapes();
  updateRobotTelemetry(undefined, true);
  renderer?.renderLists?.dispose();
  markSceneShadowDirty();
}

function createObstacleModel(x, z, index = 0) {
  const palette = getMissionVisualPalette();
  const group = new THREE.Group();
  if (activeMission.environment === "guangyang") {
    const stoneMats = ["#475569", "#64748b", "#334155"].map(color => new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.02 }));
    [[0, 0.33, 0, 0.42], [-0.23, 0.2, 0.12, 0.25], [0.2, 0.17, -0.16, 0.23]].forEach(([sx, sy, sz, scale], stoneIndex) => {
      const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(scale, 1), stoneMats[stoneIndex]);
      stone.position.set(sx, sy, sz);
      stone.rotation.set(stoneIndex * 0.4, index * 0.65, stoneIndex * 0.25);
      group.add(stone);
    });
    group.position.set(x, 0, z);
    group.userData.kind = "block";
    group.userData.obstacleId = `${activeMission.taskId || "mission"}-obstacle-${index + 1}`;
    return enableObjectShadows(group);
  }
  const bodyMat = new THREE.MeshStandardMaterial({ color: palette.obstacle, metalness: 0.12, roughness: 0.58 });
  const darkMat = new THREE.MeshStandardMaterial({ color: "#1e293b", metalness: 0.3, roughness: 0.42 });
  const warningMat = new THREE.MeshStandardMaterial({ color: "#facc15", emissive: "#7c4a03", emissiveIntensity: 0.18, roughness: 0.46 });

  const base = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.09, 0.82), darkMat);
  base.position.y = 0.055;
  group.add(base);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.56, 0.68), bodyMat);
  body.position.y = 0.37;
  group.add(body);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.08, 0.76), darkMat);
  cap.position.y = 0.69;
  group.add(cap);

  [-1, 1].forEach(side => {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.12, 0.018), warningMat);
    band.position.set(0, 0.4, side * 0.349);
    group.add(band);
  });
  [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]].forEach(([bx, bz]) => {
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.035, 10), warningMat);
    bolt.position.set(bx, 0.745, bz);
    group.add(bolt);
  });

  group.position.set(x, 0, z);
  group.rotation.y = index % 2 ? Math.PI / 2 : 0;
  group.userData.kind = "block";
  group.userData.obstacleId = `${activeMission.taskId || "mission"}-obstacle-${index + 1}`;
  return enableObjectShadows(group);
}

function addMissionDecoration(object, collider = null, castShadow = true) {
  if (castShadow) enableObjectShadows(object);
  scene.add(object);
  missionDecorationMeshes.push(object);
  if (collider) missionWallColliders.push(collider);
  return object;
}

function addFloorDecal(x, z, width, height, color, opacity = 0.5, rotation = 0) {
  const decal = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false })
  );
  decal.rotation.x = -Math.PI / 2;
  decal.rotation.z = rotation;
  decal.position.set(x, 0.058, z);
  decal.renderOrder = 2;
  return addMissionDecoration(decal, null, false);
}

function addFloorDecalInstances(decals, color, opacity = 0.5) {
  if (!decals.length) return null;
  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }),
    decals.length
  );
  const transform = new THREE.Object3D();
  decals.forEach(({ x, z, width, height, rotation = 0 }, index) => {
    transform.position.set(x, 0.059, z);
    transform.rotation.set(-Math.PI / 2, 0, rotation);
    transform.scale.set(width, height, 1);
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.computeBoundingSphere) mesh.computeBoundingSphere();
  mesh.renderOrder = 2;
  return addMissionDecoration(mesh, null, false);
}

function addZoneLabel(text, pos, color) {
  if (!Array.isArray(pos)) return;
  addFloorDecal(pos[0], pos[1], 1.3, 0.95, color, 0.2);
  const label = createTextLabel(text, pos[0], pos[1] + 0.66, 0.1);
  label.scale.set(0.96, 0.35, 1);
  missionDecorationMeshes.push(label);
}

function buildStandardMissionWalls() {
  const walls = Array.isArray(activeMission.walls) ? activeMission.walls : [];
  if (!walls.length) return;
  const palette = getMissionVisualPalette();
  const material = new THREE.MeshStandardMaterial({ color: palette.obstacle, metalness: 0.1, roughness: 0.64 });
  const height = Number(activeMission.wallHeight) || 0.62;
  walls.forEach(([x, z, w, h]) => addMazeWall(x, z, w, h, height, material));
}

function buildLargeMissionBase() {
  const size = currentMapSize();
  const palette = getMissionVisualPalette();
  const largeGrid = new THREE.GridHelper(size, size, palette.accent, "#526477");
  largeGrid.material.transparent = true;
  largeGrid.material.opacity = 0.42;
  largeGrid.position.y = 0.052;
  scene.add(largeGrid);
  missionDecorationMeshes.push(largeGrid);

  const borderMaterial = new THREE.MeshStandardMaterial({
    color: palette.base,
    metalness: 0.18,
    roughness: 0.58
  });
  const border = currentMapHalf() - 0.2;
  const length = size - 0.3;
  [
    [0, -border, length, 0.12],
    [0, border, length, 0.12],
    [-border, 0, 0.12, length],
    [border, 0, 0.12, length]
  ].forEach(([x, z, w, h]) => addMazeWall(x, z, w, h, 0.58, borderMaterial));
}

function addStartMarker() {
  const [x, z, heading] = activeMission.start || [-3, -3, 0];
  const palette = getMissionVisualPalette();
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 0.53, 32),
    new THREE.MeshBasicMaterial({ color: palette.accent, transparent: true, opacity: 0.72, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.062;
  group.add(ring);
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.15, 0.42, 3),
    new THREE.MeshStandardMaterial({ color: palette.accent, emissive: palette.accent, emissiveIntensity: 0.28, roughness: 0.42 })
  );
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.set(0, 0.1, -0.58);
  group.add(arrow);
  group.position.set(x, 0, z);
  group.rotation.y = heading;
  if (activeMission.theme === "maze") group.scale.setScalar(1.22);
  addMissionDecoration(group);
  const label = createTextLabel("起点", x, z + 0.72, 0.1);
  label.scale.set(activeMission.theme === "maze" ? 1.08 : 0.92, activeMission.theme === "maze" ? 0.4 : 0.34, 1);
  missionDecorationMeshes.push(label);
}

function buildMissionEnvironment(buildGeneration = missionBuildGeneration) {
  addStartMarker();
  if (activeMission.theme !== "maze" && activeMission.showGuidePath !== false) buildMazeGuidePath(activeMission.guidePath || []);
  const environment = activeMission.environment || "delivery";
  if (environment === "guangyang") buildGuangyangEnvironment(buildGeneration);
  if (environment === "delivery") buildDeliveryEnvironment();
  if (environment === "campus") buildCampusEnvironment();
  if (environment === "warehouse") buildWarehouseEnvironment();
  if (environment === "training") buildTrainingEnvironment();
  if (environment === "harbor") buildHarborEnvironment();
  if (environment === "city") buildCityEnvironment();
  if (environment === "canyon") buildCanyonEnvironment();
  if (environment === "maze") buildMazeEnvironment();
}

function loadPrimaryGuangyangImage(url) {
  const existing = primaryGuangyangImagePromises.get(url);
  if (existing) return existing;
  const promise = new Promise((resolve, reject) => {
    const loader = new THREE.ImageLoader();
    loader.load(url, resolve, undefined, reject);
  });
  primaryGuangyangImagePromises.set(url, promise);
  promise.catch(() => {
    if (primaryGuangyangImagePromises.get(url) === promise) primaryGuangyangImagePromises.delete(url);
  });
  return promise;
}

function cropPrimaryGuangyangMap(image) {
  const { crop, bakedVehiclePatch } = PRIMARY_GUANGYANG_MAP.source;
  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  const context = canvas.getContext("2d", { alpha: false });
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  if (bakedVehiclePatch?.source && bakedVehiclePatch?.target) {
    context.drawImage(
      image,
      bakedVehiclePatch.source.x, bakedVehiclePatch.source.y,
      bakedVehiclePatch.source.width, bakedVehiclePatch.source.height,
      bakedVehiclePatch.target.x - crop.x, bakedVehiclePatch.target.y - crop.y,
      bakedVehiclePatch.target.width, bakedVehiclePatch.target.height
    );
  }
  return canvas;
}

function createPrimaryGuangyangTerrainMesh(canvas, texture) {
  const width = PRIMARY_GUANGYANG_MAP.width;
  const depth = PRIMARY_GUANGYANG_MAP.depth;
  const segmentsX = 128;
  const segmentsZ = 76;
  const columns = segmentsX + 1;
  const rows = segmentsZ + 1;
  const total = columns * rows;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const sourcePixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const weakWater = new Uint8Array(total);
  const strongWater = new Uint8Array(total);
  const exteriorWater = new Uint8Array(total);
  const terrainBumps = new Float32Array(total);
  const queue = new Int32Array(total);
  let queueStart = 0;
  let queueEnd = 0;
  const sourceOffset = (row, column) => {
    const px = Math.min(canvas.width - 1, Math.max(0, Math.round(column / segmentsX * (canvas.width - 1))));
    const py = Math.min(canvas.height - 1, Math.max(0, Math.round(row / segmentsZ * (canvas.height - 1))));
    return (py * canvas.width + px) * 4;
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      const offset = sourceOffset(row, column);
      const r = sourcePixels[offset];
      const g = sourcePixels[offset + 1];
      const b = sourcePixels[offset + 2];
      const maximum = Math.max(r, g, b, 1);
      const saturation = (maximum - Math.min(r, g, b)) / maximum;
      weakWater[index] = Number(saturation > 0.18 && b > 55 && b > r * 1.06 && b >= g * 0.97);
      strongWater[index] = Number(saturation > 0.28 && b > 68 && b > r * 1.15 && b > g * 1.02);
      terrainBumps[index] = Math.max(0, Math.min(0.026, (g - Math.max(r * 1.02, b * 0.92)) / 90 * 0.026));
      const rim = row <= 2 || row >= segmentsZ - 2 || column <= 2 || column >= segmentsX - 2;
      if (rim && strongWater[index]) {
        exteriorWater[index] = 1;
        queue[queueEnd++] = index;
      }
    }
  }
  while (queueStart < queueEnd) {
    const index = queue[queueStart++];
    const row = Math.floor(index / columns);
    const column = index % columns;
    const neighbors = [
      row > 0 ? index - columns : -1,
      row < segmentsZ ? index + columns : -1,
      column > 0 ? index - 1 : -1,
      column < segmentsX ? index + 1 : -1
    ];
    neighbors.forEach(neighbor => {
      if (neighbor < 0 || exteriorWater[neighbor] || !weakWater[neighbor]) return;
      exteriorWater[neighbor] = 1;
      queue[queueEnd++] = neighbor;
    });
  }
  const heights = new Float32Array(total);
  for (let index = 0; index < total; index += 1) heights[index] = exteriorWater[index] ? 0 : 1;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = new Float32Array(total);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        let sum = heights[index] * 4;
        let weight = 4;
        if (row > 0) { sum += heights[index - columns]; weight += 1; }
        if (row < segmentsZ) { sum += heights[index + columns]; weight += 1; }
        if (column > 0) { sum += heights[index - 1]; weight += 1; }
        if (column < segmentsX) { sum += heights[index + 1]; weight += 1; }
        next[index] = sum / weight;
      }
    }
    heights.set(next);
  }
  const terrainDrop = 0.14;
  const geometry = new THREE.PlaneGeometry(width, depth, segmentsX, segmentsZ);
  const positions = geometry.getAttribute("position");
  for (let index = 0; index < total; index += 1) {
    const smooth = heights[index] * heights[index] * (3 - 2 * heights[index]);
    positions.setZ(index, smooth * terrainDrop + (smooth > 0.82 ? terrainBumps[index] : 0));
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  const terrain = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ map: texture, color: "#ffffff", side: THREE.FrontSide, fog: false, toneMapped: false })
  );
  terrain.name = "primary-guangyang-terrain";
  terrain.rotation.x = -Math.PI / 2;
  terrain.position.y = 0.098 - terrainDrop;
  terrain.renderOrder = 2;
  primaryGuangyangTerrainMesh = addMissionDecoration(terrain, null, false);
  return primaryGuangyangTerrainMesh;
}

function primaryGuangyangPixelToWorld(pixelX, pixelY) {
  const { crop } = PRIMARY_GUANGYANG_MAP.source;
  return [
    (Number(pixelX) - crop.x - crop.width / 2) * PRIMARY_GUANGYANG_MAP.width / crop.width,
    (Number(pixelY) - crop.y - crop.height / 2) * PRIMARY_GUANGYANG_MAP.depth / crop.height
  ];
}

function primaryGuangyangPixelSize(width, height) {
  const { crop } = PRIMARY_GUANGYANG_MAP.source;
  return [
    Number(width) * PRIMARY_GUANGYANG_MAP.width / crop.width,
    Number(height) * PRIMARY_GUANGYANG_MAP.depth / crop.height
  ];
}

function primaryGuangyangRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function createPrimaryGuangyangSignTexture(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 128, 128);
  const warning = text === "慢";
  context.fillStyle = warning ? "#f5c31b" : "#0756c7";
  if (warning) {
    context.beginPath();
    context.moveTo(64, 8); context.lineTo(119, 112); context.lineTo(9, 112); context.closePath();
    context.fill();
    context.lineWidth = 8;
    context.strokeStyle = "#111827";
    context.stroke();
  } else {
    context.beginPath();
    context.arc(64, 64, 55, 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = "#ffffff";
  context.font = text === "P" ? "700 76px Arial" : "700 54px Microsoft YaHei, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, 64, 65);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function primaryGuangyangTreeFootprintIsLand(context, canvas, pixelX, pixelY, scale) {
  if (!context || !canvas) return true;
  const { crop } = PRIMARY_GUANGYANG_MAP.source;
  const centerX = Number(pixelX) - crop.x;
  const centerY = Number(pixelY) - crop.y;
  const radius = Math.max(8, Math.ceil(12 * scale));
  const diagonal = Math.round(radius * 0.7);
  const offsets = [
    [0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius],
    [diagonal, diagonal], [diagonal, -diagonal], [-diagonal, diagonal], [-diagonal, -diagonal]
  ];
  return offsets.every(([offsetX, offsetY]) => {
    const x = Math.round(centerX + offsetX);
    const y = Math.round(centerY + offsetY);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
    const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data;
    if (alpha < 220 || green < 48) return false;
    const greenLand = green >= red + 7 && green >= blue + 5;
    const goldenPlanting = red >= green - 12 && red >= blue + 35 && green >= blue + 28;
    return greenLand || goldenPlanting;
  });
}

function buildPrimaryGuangyangRelief(sourceCanvas = null) {
  const root = new THREE.Group();
  root.name = "primary-guangyang-relief";
  root.userData.kind = "primary-guangyang-relief";
  const baseY = 0.07;

  const waterMaterial = new THREE.MeshStandardMaterial({
    color: "#7fc6d5", transparent: true, opacity: 0.33, roughness: 0.18,
    metalness: 0.06, side: THREE.DoubleSide, depthWrite: false
  });
  PRIMARY_GUANGYANG_RELIEF.lakes.forEach(([pixelX, pixelY, pixelWidth, pixelHeight]) => {
    const [x, z] = primaryGuangyangPixelToWorld(pixelX, pixelY);
    const [width, depth] = primaryGuangyangPixelSize(pixelWidth, pixelHeight);
    const lake = new THREE.Mesh(new THREE.CircleGeometry(1, 36), waterMaterial);
    lake.rotation.x = -Math.PI / 2;
    lake.position.set(x, baseY + 0.003, z);
    lake.scale.set(width / 2, depth / 2, 1);
    root.add(lake);
  });

  const totalTrees = PRIMARY_GUANGYANG_RELIEF.treeClusters.reduce((total, cluster) => total + cluster[4], 0);
  const trunk = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.052, 0.075, 0.4, 7),
    new THREE.MeshStandardMaterial({ color: "#6b4a32", roughness: 0.9 }),
    totalTrees
  );
  const crowns = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.32, 1),
    new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.78 }),
    totalTrees
  );
  const highlight = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.2, 1),
    new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.74 }),
    totalTrees
  );
  const treePalettes = {
    green: ["#386d43", "#5f9e4d", "#78b85b", "#a5d46f"],
    dark: ["#2f623d", "#487f42", "#6ca24c"],
    light: ["#6ca94f", "#8bc45b", "#b6dc78"],
    gold: ["#8d7a35", "#b49a42", "#d4b44f", "#e4c765"]
  };
  const treeTransform = new THREE.Object3D();
  const sourceContext = sourceCanvas?.getContext?.("2d", { willReadFrequently: true }) || null;
  let treeIndex = 0;
  PRIMARY_GUANGYANG_RELIEF.treeClusters.forEach(([centerX, centerY, radiusX, radiusY, count, paletteName], clusterIndex) => {
    const random = primaryGuangyangRandom(20260822 + clusterIndex * 977);
    const palette = treePalettes[paletteName] || treePalettes.green;
    let placed = 0;
    const maximumAttempts = count * 14;
    for (let attempt = 0; placed < count && attempt < maximumAttempts; attempt += 1) {
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random());
      const pixelX = centerX + Math.cos(angle) * radiusX * radius;
      const pixelY = centerY + Math.sin(angle) * radiusY * radius;
      const scale = 0.68 + random() * 0.5;
      if (!primaryGuangyangTreeFootprintIsLand(sourceContext, sourceCanvas, pixelX, pixelY, scale)) continue;
      const [x, z] = primaryGuangyangPixelToWorld(pixelX, pixelY);
      const color = new THREE.Color(palette[Math.floor(random() * palette.length)]);
      treeTransform.position.set(x, baseY + 0.2 * scale, z);
      treeTransform.rotation.set(0, random() * Math.PI * 2, 0);
      treeTransform.scale.set(scale, scale, scale);
      treeTransform.updateMatrix();
      trunk.setMatrixAt(treeIndex, treeTransform.matrix);
      treeTransform.position.y = baseY + 0.58 * scale;
      treeTransform.scale.set(scale, scale * 0.86, scale);
      treeTransform.updateMatrix();
      crowns.setMatrixAt(treeIndex, treeTransform.matrix);
      crowns.setColorAt(treeIndex, color);
      const highlightAngle = treeIndex * 2.3999632297;
      treeTransform.position.set(x + Math.cos(highlightAngle) * 0.08 * scale, baseY + 0.77 * scale, z + Math.sin(highlightAngle) * 0.08 * scale);
      treeTransform.scale.set(scale * 0.68, scale * 0.58, scale * 0.68);
      treeTransform.updateMatrix();
      highlight.setMatrixAt(treeIndex, treeTransform.matrix);
      highlight.setColorAt(treeIndex, color.clone().lerp(new THREE.Color("#dff3b2"), 0.28));
      treeIndex += 1;
      placed += 1;
    }
  });
  [trunk, crowns, highlight].forEach(mesh => {
    mesh.count = treeIndex;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    root.add(mesh);
  });

  PRIMARY_GUANGYANG_RELIEF.buildings.forEach(spec => {
    const [x, z] = primaryGuangyangPixelToWorld(spec.anchor[0], spec.anchor[1]);
    const [width, depth] = primaryGuangyangPixelSize(spec.size[0], spec.size[1]);
    const height = Number(spec.height) || 0.42;
    const building = new THREE.Group();
    if (spec.style === "pagoda") {
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(width * 0.28, width * 0.35, height * 0.35, 8),
        new THREE.MeshStandardMaterial({ color: "#e9d1b9", roughness: 0.78 })
      );
      base.position.y = baseY + height * 0.18;
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(width * 0.52, height * 0.42, 8),
        new THREE.MeshStandardMaterial({ color: "#d99290", roughness: 0.72 })
      );
      roof.position.y = baseY + height * 0.55;
      building.add(base, roof);
    } else if (spec.style === "tent") {
      const tent = new THREE.Mesh(
        new THREE.ConeGeometry(Math.max(width, depth) * 0.5, height, 4),
        new THREE.MeshStandardMaterial({ color: spec.roof || "#e9b0ae", roughness: 0.86 })
      );
      tent.rotation.y = Math.PI / 4;
      tent.scale.z = Math.max(0.55, depth / Math.max(width, 0.01));
      tent.position.y = baseY + height / 2;
      building.add(tent);
    } else {
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(width * 0.88, height * 0.68, depth * 0.88),
        new THREE.MeshStandardMaterial({ color: spec.wall || "#e9d1b9", roughness: 0.82 })
      );
      body.position.y = baseY + height * 0.34;
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(1, height * 0.42, 4),
        new THREE.MeshStandardMaterial({ color: spec.roof || "#e9b0ae", roughness: 0.76 })
      );
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(width * 0.66, 1, depth * 0.66);
      roof.position.y = baseY + height * 0.78;
      building.add(body, roof);
    }
    building.position.set(x, 0, z);
    root.add(building);
  });

  PRIMARY_GUANGYANG_RELIEF.fields.forEach(([pixelX, pixelY, pixelWidth, pixelHeight, color, count], fieldIndex) => {
    const [x, z] = primaryGuangyangPixelToWorld(pixelX, pixelY);
    const [width, depth] = primaryGuangyangPixelSize(pixelWidth, pixelHeight);
    const base = new THREE.Mesh(
      new THREE.CircleGeometry(1, 44),
      new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.2, roughness: 0.84, side: THREE.DoubleSide, depthWrite: false })
    );
    base.rotation.x = -Math.PI / 2;
    base.position.set(x, baseY + 0.006, z);
    base.scale.set(width / 2, depth / 2, 1);
    root.add(base);
    const blossoms = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.04, 0),
      new THREE.MeshStandardMaterial({ color, roughness: 0.74 }),
      count
    );
    const random = primaryGuangyangRandom(42000 + fieldIndex * 211);
    for (let index = 0; index < count; index += 1) {
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random()) * 0.9;
      treeTransform.position.set(x + Math.cos(angle) * width * 0.5 * radius, baseY + 0.075, z + Math.sin(angle) * depth * 0.5 * radius);
      const scale = 0.7 + random() * 0.75;
      treeTransform.rotation.set(0, random() * Math.PI * 2, 0);
      treeTransform.scale.set(scale, scale, scale);
      treeTransform.updateMatrix();
      blossoms.setMatrixAt(index, treeTransform.matrix);
    }
    blossoms.instanceMatrix.needsUpdate = true;
    blossoms.castShadow = false;
    root.add(blossoms);
  });

  const [terraceX, terraceZ] = primaryGuangyangPixelToWorld(692, 686);
  const [terraceWidth, terraceDepth] = primaryGuangyangPixelSize(205, 185);
  ["#d5d99d", "#c8d58a", "#bace78", "#afcb69", "#9fbd62", "#91ad59"].forEach((color, index) => {
    const ratio = 1 - index * 0.115;
    const layerHeight = 0.045 * (index + 1);
    const terrace = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1.04, layerHeight, 42),
      new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.78, roughness: 0.9 })
    );
    terrace.scale.set(terraceWidth * 0.5 * ratio, 1, terraceDepth * 0.5 * ratio);
    terrace.position.set(terraceX + index * 0.05, baseY + layerHeight / 2, terraceZ - index * 0.04);
    root.add(terrace);
  });

  PRIMARY_GUANGYANG_RELIEF.signs.forEach(([pixelX, pixelY, text]) => {
    const [x, z] = primaryGuangyangPixelToWorld(pixelX, pixelY);
    const sign = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.024, 0.03, 0.54, 8),
      new THREE.MeshStandardMaterial({ color: "#3f4752", metalness: 0.45, roughness: 0.46 })
    );
    pole.position.y = baseY + 0.27;
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.42),
      new THREE.MeshBasicMaterial({ map: createPrimaryGuangyangSignTexture(text), transparent: true, side: THREE.DoubleSide })
    );
    panel.position.y = baseY + 0.63;
    sign.add(pole, panel);
    sign.position.set(x, 0, z);
    root.add(sign);
  });

  root.traverse(node => {
    if (!node.isMesh) return;
    node.castShadow = false;
    node.receiveShadow = true;
  });
  primaryGuangyangReliefRoot = addMissionDecoration(root, null, false);
  primaryGuangyangReliefRoot.visible = cameraMode !== "top";
  return primaryGuangyangReliefRoot;
}

function createPrimaryGuangyangPackage(position, color, label) {
  if (!Array.isArray(position)) return;
  const [x, z] = position;
  const group = new THREE.Group();
  const boxMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.56, metalness: 0.06 });
  const tapeMaterial = new THREE.MeshStandardMaterial({ color: "#f5d29b", roughness: 0.78 });
  const labelMaterial = new THREE.MeshStandardMaterial({ color: "#f8fafc", roughness: 0.64 });
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.36, 0.42), boxMaterial);
  box.position.y = 0.25;
  const tape = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.012, 0.43), tapeMaterial);
  tape.position.y = 0.438;
  const shippingLabel = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.012), labelMaterial);
  shippingLabel.position.set(0, 0.25, -0.217);
  group.add(box, tape, shippingLabel);
  group.position.set(x, 0.075, z);
  addMissionDecoration(group, null, false);
  const text = createTextLabel(label, x, z + 0.55, 0.62);
  text.scale.set(0.9, 0.32, 1);
  missionDecorationMeshes.push(text);
}

function createPrimaryGuangyangStorage(position) {
  if (!Array.isArray(position)) return;
  const [x, z] = position;
  const group = new THREE.Group();
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(0.48, 0.48, 0.06, 28),
    new THREE.MeshStandardMaterial({ color: "#16a34a", emissive: "#166534", emissiveIntensity: 0.24, roughness: 0.48 })
  );
  pad.position.y = 0.105;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.39, 0.035, 10, 32),
    new THREE.MeshBasicMaterial({ color: "#bbf7d0", transparent: true, opacity: 0.92 })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.15;
  group.add(pad, ring);
  group.position.set(x, 0, z);
  addMissionDecoration(group, null, false);
  const text = createTextLabel("目标点", x, z + 0.62, 0.34);
  text.scale.set(0.84, 0.3, 1);
  missionDecorationMeshes.push(text);
}

function buildPrimaryGuangyangTaskObjects() {
  const landmarks = activeMission.landmarks || {};
  // 目标物和混淆物由可抓取的任务包裹模型呈现，避免再叠加一套装饰模型。
  createPrimaryGuangyangStorage(landmarks.storage);
}

function buildGuangyangEnvironment(buildGeneration) {
  if (gridHelper) gridHelper.visible = false;
  roadLineMeshes.forEach(mesh => { mesh.visible = false; });
  const expectedMission = activeMission;
  loadPrimaryGuangyangImage(PRIMARY_GUANGYANG_MAP.source.url).then(image => {
    if (missionBuildGeneration !== buildGeneration || activeMission !== expectedMission || expectedMission.environment !== "guangyang") return;
    const canvas = cropPrimaryGuangyangMap(image);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(4, renderer?.capabilities?.getMaxAnisotropy?.() || 1);
    const island = new THREE.Mesh(
      new THREE.PlaneGeometry(PRIMARY_GUANGYANG_MAP.width, PRIMARY_GUANGYANG_MAP.depth),
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })
    );
    island.rotation.x = -Math.PI / 2;
    island.position.y = 0.031;
    island.renderOrder = 1;
    addMissionDecoration(island, null, false);
    try {
      createPrimaryGuangyangTerrainMesh(canvas, texture);
      island.visible = false;
    } catch (error) {
      console.warn("广阳岛地形层生成失败，已回退到平面底图。", error);
    }
    buildPrimaryGuangyangRelief(canvas);
    renderer?.renderLists?.dispose();
  }).catch(() => {
    if (missionBuildGeneration === buildGeneration && activeMission === expectedMission && expectedMission.environment === "guangyang") {
      buildPrimaryGuangyangRelief();
    }
    addLog("广阳岛地图载入失败，已保留闯关路线。");
  });

  // 保留厘米制移动兼容规则，并同步显示完整的岛屿立体环境和任务物品。
  buildPrimaryGuangyangTaskObjects();

  const checkpointColors = ["#22d3ee", "#a78bfa", "#f59e0b", "#ec4899"];
  getMissionCheckpointPositions(resolveMissionCompletionSpec()).forEach((point, index) => {
    const color = checkpointColors[index % checkpointColors.length];
    createMazeCheckpoint(point, index, color);
  });
}

function buildDeliveryEnvironment() {
  const packages = ensureMissionPackages();
  if (packages.length) addZoneLabel("装货区", [packages[0].x, packages[0].z], "#f59e0b");
  if (activeMission.goal) addZoneLabel("卸货区", activeMission.goal, "#22c55e");
  [-1, 0, 1].forEach(offset => addFloorDecal(-4.65 + offset * 0.3, -4.9, 0.16, 1.4, "#f8fafc", 0.5));
}

function createTree(x, z, scale = 1) {
  const group = new THREE.Group();
  const trunkMat = new THREE.MeshStandardMaterial({ color: "#85552d", roughness: 0.82 });
  const leafMats = ["#16a34a", "#22c55e", "#4ade80"].map(color => new THREE.MeshStandardMaterial({ color, roughness: 0.7 }));
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 0.62, 10), trunkMat);
  trunk.position.y = 0.34;
  group.add(trunk);
  [[0, 0.78, 0], [-0.16, 0.7, 0.04], [0.15, 0.72, -0.06]].forEach(([lx, ly, lz], index) => {
    const crown = new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 10), leafMats[index]);
    crown.position.set(lx, ly, lz);
    group.add(crown);
  });
  group.position.set(x, 0, z);
  group.scale.setScalar(scale);
  return addMissionDecoration(group, { x, z, w: 0.55 * scale, h: 0.55 * scale });
}

function buildCampusEnvironment() {
  createTree(-4.75, -4.55, 0.95);
  createTree(4.7, 4.5, 0.9);
  createTree(4.65, -0.2, 0.78);
  for (let i = -3; i <= 3; i++) addFloorDecal(i * 0.28, 3.55, 0.14, 1.55, "#f8fafc", 0.58);
  const packages = ensureMissionPackages();
  if (packages.length) addZoneLabel("校门取件", [packages[0].x, packages[0].z], "#f59e0b");
  if (activeMission.goal) addZoneLabel("教学楼", activeMission.goal, "#34d399");
}

function createWarehouseRack(x, z, length = 6.2) {
  const group = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: "#26384d", metalness: 0.55, roughness: 0.35 });
  const shelfMat = new THREE.MeshStandardMaterial({ color: "#f59e0b", metalness: 0.25, roughness: 0.44 });
  [0.22, 0.68, 1.14].forEach(y => {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.055, length), shelfMat);
    shelf.position.y = y;
    group.add(shelf);
  });
  [-length / 2 + 0.08, 0, length / 2 - 0.08].forEach(rz => {
    [-0.2, 0.2].forEach(rx => {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.055, 1.35, 0.055), frameMat);
      post.position.set(rx, 0.68, rz);
      group.add(post);
    });
  });
  for (let i = -2; i <= 2; i++) {
    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.26, 0.48),
      new THREE.MeshStandardMaterial({ color: i % 2 ? "#3b82f6" : "#64748b", roughness: 0.56 })
    );
    crate.position.set(0, 0.4, i * 0.92);
    group.add(crate);
  }
  group.position.set(x, 0, z);
  return addMissionDecoration(group, { x, z, w: 0.52, h: length });
}

function buildWarehouseEnvironment() {
  if (isLargeMap()) {
    [-9, 0, 9].forEach(z => {
      createWarehouseRack(-15.15, z, 6);
      createWarehouseRack(15.15, z, 6);
    });
    [-12, -6, 0, 6, 12].forEach(x => addFloorDecal(x, 0, 0.08, 30, "#fbbf24", 0.28));
    [-12, -6, 0, 6, 12].forEach(z => addFloorDecal(0, z, 30, 0.055, "#f8fafc", 0.12));
  } else {
    createWarehouseRack(-5.05, 0);
    createWarehouseRack(5.05, 0);
    [-3.6, -1.2, 1.2, 3.6].forEach(x => addFloorDecal(x, 0, 0.07, 10.4, "#fbbf24", 0.32));
  }
  const packages = ensureMissionPackages();
  if (packages.length) addZoneLabel("入库货位", [packages[0].x, packages[0].z], "#f59e0b");
  if (activeMission.goal) addZoneLabel("出库区", activeMission.goal, "#22c55e");
}

function createTrafficCone(x, z) {
  const group = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.035, 0.28),
    new THREE.MeshStandardMaterial({ color: "#1f2937", roughness: 0.68 })
  );
  base.position.y = 0.02;
  group.add(base);
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.12, 0.38, 16),
    new THREE.MeshStandardMaterial({ color: "#f97316", roughness: 0.5 })
  );
  cone.position.y = 0.22;
  group.add(cone);
  const stripe = new THREE.Mesh(
    new THREE.CylinderGeometry(0.075, 0.092, 0.055, 16),
    new THREE.MeshStandardMaterial({ color: "#f8fafc", roughness: 0.55 })
  );
  stripe.position.y = 0.22;
  group.add(stripe);
  group.position.set(x, 0, z);
  return addMissionDecoration(group, { x, z, w: 0.3, h: 0.3 });
}

function buildTrainingEnvironment() {
  [-4.8, 4.8].forEach(x => [-3, -1, 1, 3].forEach(z => createTrafficCone(x, z)));
  for (let i = -4; i <= 4; i++) {
    addFloorDecal(i * 0.24, 4.95, 0.24, 0.34, i % 2 ? "#0f172a" : "#f8fafc", 0.9);
    addFloorDecal(i * 0.24, -4.95, 0.24, 0.34, i % 2 ? "#0f172a" : "#f8fafc", 0.9);
  }
}

function createContainerStack(x, z, width, depth, colors) {
  const group = new THREE.Group();
  colors.forEach((color, level) => {
    const container = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.52, depth),
      new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.48 })
    );
    container.position.y = 0.28 + level * 0.54;
    group.add(container);
    for (let rib = -2; rib <= 2; rib++) {
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(0.025, 0.45, depth + 0.012),
        new THREE.MeshStandardMaterial({ color: "#dbeafe", transparent: true, opacity: 0.34, metalness: 0.5 })
      );
      line.position.set((rib * width) / 6, container.position.y, 0);
      group.add(line);
    }
  });
  group.position.set(x, 0, z);
  return addMissionDecoration(group, { x, z, w: width, h: depth });
}

function buildHarborEnvironment() {
  createContainerStack(-4.85, -0.6, 0.7, 3.1, ["#2563eb", "#0f766e"]);
  createContainerStack(4.85, 0.8, 0.7, 3, ["#dc2626", "#ca8a04", "#2563eb"]);
  [-2.2, 0, 2.2].forEach(x => addFloorDecal(x, 0, 0.055, 10.5, "#67e8f9", 0.26));
  const packages = ensureMissionPackages();
  if (packages.length) addZoneLabel("装卸区", [packages[0].x, packages[0].z], "#f59e0b");
  if (activeMission.goal) addZoneLabel("绿色泊位", activeMission.goal, "#22c55e");
}

function buildStreetLights(lights) {
  const poleMaterial = new THREE.MeshStandardMaterial({ color: "#1e293b", metalness: 0.72, roughness: 0.32 });
  const lightMaterial = new THREE.MeshStandardMaterial({
    color: "#e0f2fe",
    emissive: "#38bdf8",
    emissiveIntensity: 1.2,
    roughness: 0.28
  });
  const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.045, 0.06, 1.55, 10), poleMaterial, lights.length);
  const arms = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.045, 0.045), poleMaterial, lights.length);
  const lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.08, 0.14), lightMaterial, lights.length);
  const transform = new THREE.Object3D();
  lights.forEach(({ x, z, rotation = 0 }, index) => {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    transform.rotation.set(0, rotation, 0);
    transform.scale.set(1, 1, 1);
    transform.position.set(x, 0.78, z);
    transform.updateMatrix();
    poles.setMatrixAt(index, transform.matrix);
    transform.position.set(x + cos * 0.17, 1.51, z - sin * 0.17);
    transform.updateMatrix();
    arms.setMatrixAt(index, transform.matrix);
    transform.position.set(x + cos * 0.36, 1.46, z - sin * 0.36);
    transform.updateMatrix();
    lamps.setMatrixAt(index, transform.matrix);
  });
  [poles, arms, lamps].forEach(mesh => {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.computeBoundingSphere) mesh.computeBoundingSphere();
  });
  const group = new THREE.Group();
  group.add(poles, arms, lamps);
  return addMissionDecoration(group, null, false);
}

function addCityBuildingDetails() {
  const buildings = activeMission.walls || [];
  if (!buildings.length) return;
  const roofMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: "#253e55", metalness: 0.22, roughness: 0.5 }),
    buildings.length
  );
  const glowColors = ["#38bdf8", "#fbbf24", "#a78bfa"];
  const windowGroups = glowColors.map((color, colorIndex) => {
    const count = buildings.filter((_, index) => index % glowColors.length === colorIndex).length;
    return new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.62, roughness: 0.36 }),
      count
    );
  });
  const windowOffsets = [0, 0, 0];
  const transform = new THREE.Object3D();
  buildings.forEach(([x, z, w, h], index) => {
    transform.position.set(x, (Number(activeMission.wallHeight) || 2.35) + 0.12, z);
    transform.rotation.set(0, 0, 0);
    transform.scale.set(Math.max(1, w * 0.38), 0.24, Math.max(1, h * 0.34));
    transform.updateMatrix();
    roofMesh.setMatrixAt(index, transform.matrix);
    const colorIndex = index % glowColors.length;
    transform.position.set(x, 1.18 + (index % 2) * 0.32, z + h / 2 + 0.014);
    transform.scale.set(Math.max(1.2, w * 0.62), 0.46, 0.025);
    transform.updateMatrix();
    windowGroups[colorIndex].setMatrixAt(windowOffsets[colorIndex]++, transform.matrix);
  });
  const group = new THREE.Group();
  [roofMesh, ...windowGroups].forEach(mesh => {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.computeBoundingSphere) mesh.computeBoundingSphere();
    group.add(mesh);
  });
  addMissionDecoration(group, null, false);
}

function appendCrosswalkDecals(decals, x, z) {
  for (let stripe = -3; stripe <= 3; stripe++) {
    decals.push({ x: x + stripe * 0.34, z, width: 0.18, height: 2.6 });
    decals.push({ x, z: z + stripe * 0.34, width: 2.6, height: 0.18 });
  }
}

function buildCityEnvironment() {
  const roadMarks = [];
  [-4, 4].forEach(x => {
    addFloorDecal(x, 0, 3.1, 31, "#172b3c", 0.45);
    for (let z = -14; z <= 14; z += 2) roadMarks.push({ x, z, width: 0.08, height: 0.82 });
  });
  [-4, 4].forEach(z => {
    addFloorDecal(0, z, 31, 3.1, "#172b3c", 0.45);
    for (let x = -14; x <= 14; x += 2) roadMarks.push({ x, z, width: 0.82, height: 0.08 });
  });
  [[-4, -4], [-4, 4], [4, -4], [4, 4]].forEach(([x, z]) => appendCrosswalkDecals(roadMarks, x, z));
  addFloorDecalInstances(roadMarks, "#f8fafc", 0.52);
  const streetLights = [];
  [-12, -4, 4, 12].forEach(value => {
    streetLights.push({ x: value, z: 15.05, rotation: 0 });
    streetLights.push({ x: value, z: -15.05, rotation: Math.PI });
  });
  [-12, -4, 4, 12].forEach(value => {
    streetLights.push({ x: 15.05, z: value, rotation: Math.PI / 2 });
    streetLights.push({ x: -15.05, z: value, rotation: -Math.PI / 2 });
  });
  buildStreetLights(streetLights);
  addCityBuildingDetails();
  const packages = ensureMissionPackages();
  if (packages.length) addZoneLabel("巡检物资", [packages[0].x, packages[0].z], "#f59e0b");
  if (activeMission.goal) addZoneLabel("城市终点", activeMission.goal, "#22c55e");
}

function createRockFormation(x, z, scale = 1, rotation = 0) {
  const group = new THREE.Group();
  const materials = ["#6b4935", "#8a6043", "#a06d47"].map(color => new THREE.MeshStandardMaterial({ color, roughness: 0.9 }));
  [[0, 0.42, 0, 0.5], [-0.38, 0.27, 0.12, 0.34], [0.38, 0.25, -0.1, 0.3]].forEach(([rx, ry, rz, radius], index) => {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(radius, 0), materials[index]);
    rock.position.set(rx, ry, rz);
    rock.scale.set(1, 0.82 + index * 0.08, 0.92);
    group.add(rock);
  });
  group.position.set(x, 0, z);
  group.rotation.y = rotation;
  group.scale.setScalar(scale);
  return addMissionDecoration(group, null, false);
}

function buildCanyonEnvironment() {
  [
    [-15.05, 11, 1.15, 0.2], [-15.05, 3.5, 0.9, 1.1], [-15.05, -6.5, 1.2, 0.5],
    [15.05, 8.5, 1.05, 0.9], [15.05, -1.5, 0.88, 0.3], [15.05, -10, 1.18, 1.4],
    [-8, 15.05, 0.9, 0.2], [8, -15.05, 1.1, 0.8]
  ].forEach(([x, z, scale, rotation]) => createRockFormation(x, z, scale, rotation));
  [-12, -6, 0, 6, 12].forEach(x => addFloorDecal(x, 0, 0.035, 30.5, "#fbbf24", 0.12));
  const packages = ensureMissionPackages();
  if (packages.length) addZoneLabel("救援物资", [packages[0].x, packages[0].z], "#f59e0b");
  if (activeMission.goal) addZoneLabel("救援营地", activeMission.goal, "#22c55e");
}

function createMazeCheckpoint(pos, index, color) {
  const group = new THREE.Group();
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(0.48, 0.48, 0.035, 32),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.34, metalness: 0.24, roughness: 0.42 })
  );
  pad.position.y = 0.05;
  group.add(pad);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.53, 0.035, 10, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.84, depthWrite: false })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.1;
  group.add(ring);
  const configuredRadius = Number(activeMission?.completion?.checkpointRadius);
  const visualRadius = Number.isFinite(configuredRadius) ? Math.max(0.58, configuredRadius) : 0.58;
  const ruleBoundary = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.08, visualRadius - 0.045), visualRadius, 64),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.46, side: THREE.DoubleSide, depthWrite: false })
  );
  ruleBoundary.rotation.x = -Math.PI / 2;
  ruleBoundary.position.y = 0.075;
  ruleBoundary.renderOrder = 6;
  ruleBoundary.userData.visualOnly = true;
  group.add(ruleBoundary);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.3, 1.35, 20, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false })
  );
  beam.position.y = 0.72;
  group.add(beam);
  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.16, 0),
    new THREE.MeshStandardMaterial({ color: "#ffffff", emissive: color, emissiveIntensity: 1.15, metalness: 0.18, roughness: 0.28 })
  );
  core.position.y = 0.4;
  group.add(core);
  group.position.set(pos[0], activeMission.environment === "guangyang" ? 0.09 : 0, pos[1]);
  group.userData.mazeSignal = { index, pad, ring, beam, core, phase: index * 1.7, visited: false };
  mazeSignalEffects.push(group.userData.mazeSignal);
  addMissionDecoration(group, null, false);

  const label = createTextLabel(`导航 ${index + 1}`, pos[0], pos[1] + 0.66, 0.5);
  label.scale.set(1.34, 0.49, 1);
  missionDecorationMeshes.push(label);
}

function buildMazeEnvironment() {
  const checkpoints = getMazeCheckpointPositions();
  if (!checkpoints.length) {
    console.warn("迷宫路线校验失败：入口无法到达出口。");
    return;
  }
  missionCheckpointPositions = checkpoints.map(point => [...point]);
  const colors = ["#fbbf24", "#a78bfa", "#22d3ee"];
  checkpoints.forEach((checkpoint, index) => {
    if (!isBlockedByWalls(checkpoint[0], checkpoint[1])) createMazeCheckpoint(checkpoint, index, colors[index]);
  });
}

function buildMazeWallInstances(walls, height) {
  if (!walls.length) return;
  const panelMaterial = new THREE.MeshStandardMaterial({ color: "#ffffff", metalness: 0.03, roughness: 0.76 });
  const frameMaterial = new THREE.MeshStandardMaterial({ color: "#493226", metalness: 0.12, roughness: 0.66 });
  const railMaterial = new THREE.MeshStandardMaterial({ color: "#e0b475", metalness: 0.05, roughness: 0.62 });
  const foundationMaterial = new THREE.MeshStandardMaterial({ color: "#241d1a", metalness: 0.08, roughness: 0.82 });
  const seamMaterial = new THREE.MeshStandardMaterial({ color: "#684428", metalness: 0.02, roughness: 0.88 });
  const unitBox = () => new THREE.BoxGeometry(1, 1, 1);
  const foundationInstances = new THREE.InstancedMesh(unitBox(), foundationMaterial, walls.length);
  const longPanelInstances = new THREE.InstancedMesh(unitBox(), panelMaterial, walls.length * 2);
  const endPanelInstances = new THREE.InstancedMesh(unitBox(), panelMaterial, walls.length * 2);
  const longRailInstances = new THREE.InstancedMesh(unitBox(), railMaterial, walls.length * 2);
  const endRailInstances = new THREE.InstancedMesh(unitBox(), railMaterial, walls.length * 2);
  const postInstances = new THREE.InstancedMesh(unitBox(), frameMaterial, walls.length * 4);
  const seamTransforms = [];
  const transform = new THREE.Object3D();
  const panelColors = [new THREE.Color("#b87943"), new THREE.Color("#c68d53"), new THREE.Color("#d1a06a")];
  const baseHeight = 0.09;
  const panelThickness = 0.14;

  const setBoxInstance = (mesh, index, x, y, z, width, boxHeight, depth) => {
    transform.position.set(x, y, z);
    transform.rotation.set(0, 0, 0);
    transform.scale.set(width, boxHeight, depth);
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
  };

  walls.forEach(([x, z, w, h], index) => {
    const panelColor = panelColors[index % panelColors.length];
    setBoxInstance(foundationInstances, index, x, baseHeight / 2, z, w, baseHeight, h);
    [-1, 1].forEach((side, sideIndex) => {
      const longIndex = index * 2 + sideIndex;
      setBoxInstance(longPanelInstances, longIndex, x, baseHeight + height / 2, z + side * (h / 2 - panelThickness / 2), Math.max(0.18, w - 0.12), height, panelThickness);
      setBoxInstance(endPanelInstances, longIndex, x + side * (w / 2 - panelThickness / 2), baseHeight + height / 2, z, panelThickness, height, Math.max(0.18, h - 0.12));
      setBoxInstance(longRailInstances, longIndex, x, baseHeight + height + 0.045, z + side * (h / 2 - 0.04), w + 0.04, 0.09, 0.18);
      setBoxInstance(endRailInstances, longIndex, x + side * (w / 2 - 0.04), baseHeight + height + 0.045, z, 0.18, 0.09, h + 0.04);
      longPanelInstances.setColorAt(longIndex, panelColor);
      endPanelInstances.setColorAt(longIndex, panelColor);
    });

    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([xSide, zSide], cornerIndex) => {
      setBoxInstance(
        postInstances,
        index * 4 + cornerIndex,
        x + xSide * (w / 2 - 0.08),
        baseHeight + (height + 0.16) / 2,
        z + zSide * (h / 2 - 0.08),
        0.18,
        height + 0.16,
        0.18
      );
    });

    const longSeamCount = Math.max(1, Math.floor(w / 0.82) - 1);
    for (let seamIndex = 1; seamIndex <= longSeamCount; seamIndex++) {
      const seamX = x - w / 2 + (w * seamIndex) / (longSeamCount + 1);
      [-1, 1].forEach(side => seamTransforms.push({
        x: seamX,
        y: baseHeight + height * 0.52,
        z: z + side * (h / 2 + 0.012),
        w: 0.018,
        h: height * 0.76,
        d: 0.026
      }));
    }
    const endSeamCount = Math.max(1, Math.floor(h / 0.82) - 1);
    for (let seamIndex = 1; seamIndex <= endSeamCount; seamIndex++) {
      const seamZ = z - h / 2 + (h * seamIndex) / (endSeamCount + 1);
      [-1, 1].forEach(side => seamTransforms.push({
        x: x + side * (w / 2 + 0.012),
        y: baseHeight + height * 0.52,
        z: seamZ,
        w: 0.026,
        h: height * 0.76,
        d: 0.018
      }));
    }
  });

  const seamInstances = new THREE.InstancedMesh(unitBox(), seamMaterial, seamTransforms.length);
  seamTransforms.forEach((seam, index) => setBoxInstance(seamInstances, index, seam.x, seam.y, seam.z, seam.w, seam.h, seam.d));
  const meshes = [
    foundationInstances,
    longPanelInstances,
    endPanelInstances,
    longRailInstances,
    endRailInstances,
    postInstances,
    seamInstances
  ];
  meshes.forEach(mesh => {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (mesh.computeBoundingSphere) mesh.computeBoundingSphere();
  });
  const group = new THREE.Group();
  group.add(...meshes);
  group.userData.kind = "maze-walls";
  enableObjectShadows(group);
  foundationInstances.castShadow = false;
  seamInstances.castShadow = false;
  scene.add(group);
  missionWallMeshes.push(group);
  walls.forEach(([x, z, w, h]) => missionWallColliders.push({ x, z, w, h }));
}

function buildMazeMission() {
  const size = currentMapSize();
  const palette = getMissionVisualPalette();
  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(size - 0.25, size - 0.25),
    new THREE.MeshStandardMaterial({ color: palette.floor, metalness: 0.05, roughness: 0.9, side: THREE.DoubleSide })
  );
  base.rotation.x = -Math.PI / 2;
  base.position.y = 0.024;
  base.renderOrder = 1;
  base.receiveShadow = true;
  scene.add(base);
  missionDecorationMeshes.push(base);

  const mazeGrid = new THREE.GridHelper(size, MAZE_LAYOUT.length, palette.accent, "#35506b");
  mazeGrid.material.transparent = true;
  mazeGrid.material.opacity = 0.42;
  mazeGrid.position.y = 0.052;
  scene.add(mazeGrid);
  missionDecorationMeshes.push(mazeGrid);

  const borderMat = new THREE.MeshStandardMaterial({ color: "#5a3d2b", metalness: 0.08, roughness: 0.72 });
  const border = currentMapHalf() - 0.28;
  [
    [0, -border, size - 0.35, 0.1],
    [0, border, size - 0.35, 0.1],
    [-border, 0, 0.1, size - 0.35],
    [border, 0, 0.1, size - 0.35]
  ].forEach(([x, z, w, h]) => addMazeWall(x, z, w, h, 1.08, borderMat));

  addFloorDecalInstances([
    { x: 0, z: -border + 0.12, width: size - 0.9, height: 0.045 },
    { x: 0, z: border - 0.12, width: size - 0.9, height: 0.045 },
    { x: -border + 0.12, z: 0, width: 0.045, height: size - 0.9 },
    { x: border - 0.12, z: 0, width: 0.045, height: size - 0.9 }
  ], palette.accent, 0.58);
  buildMazeWallInstances(activeMission.walls || [], Number(activeMission.wallHeight) || 1.08);
  buildMazeGuidePath(activeMission.guidePath || []);
}

function addMazeWall(x, z, w, h, height = 0.42, material = null) {
  const group = new THREE.Group();
  const wallMat = material || new THREE.MeshStandardMaterial({ color: "#cbd5e1", roughness: 0.62 });
  const trimMat = new THREE.MeshStandardMaterial({ color: "#cbd5e1", roughness: 0.62 });
  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, height, h), wallMat);
  wall.position.y = height / 2;
  group.add(wall);
  if (!material) {
    const trim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.035, h + 0.02), trimMat);
    trim.position.y = height + 0.02;
    group.add(trim);
  }
  group.position.set(x, 0, z);
  group.userData.kind = "maze-wall";
  enableObjectShadows(group);
  scene.add(group);
  missionWallMeshes.push(group);
  missionWallColliders.push({ x, z, w, h });
}

function buildMazeGuidePath(points) {
  if (points.length < 2) return;
  const material = new THREE.MeshBasicMaterial({
    color: "#0ea5e9",
    transparent: true,
    opacity: 0.58,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  for (let i = 1; i < points.length; i++) {
    const [x1, z1] = points[i - 1];
    const [x2, z2] = points[i];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const length = Math.hypot(dx, dz);
    if (length < 0.01) continue;
    const line = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.018, length), material);
    line.position.set((x1 + x2) / 2, 0.07, (z1 + z2) / 2);
    line.rotation.y = Math.atan2(dx, dz);
    line.renderOrder = 5;
    scene.add(line);
    missionDecorationMeshes.push(line);
  }
}

function addMarker(pos, kind, color) {
  if (kind !== "goal") return;
  const group = new THREE.Group();
  const mazeGoal = activeMission.theme === "maze";
  const completionSpec = resolveMissionCompletionSpec();
  const visualGoalRadius = completionSpec.type === "delivery"
    ? completionSpec.deliveryRadius
    : completionSpec.goalRadius;
  const geometry = mazeGoal
    ? createStarGeometry(0.62, 0.29, 0.1)
    : new THREE.CylinderGeometry(0.36, 0.36, 0.06, 28);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.24,
    metalness: 0.12,
    roughness: 0.48
  }));
  if (mazeGoal) {
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.09;
  } else {
    mesh.position.y = 0.04;
  }
  mesh.userData.kind = kind;
  group.add(mesh);

  const pulseRing = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.24, visualGoalRadius * 0.82), visualGoalRadius, 40),
    new THREE.MeshBasicMaterial({ color: "#86efac", transparent: true, opacity: 0.68, side: THREE.DoubleSide, depthWrite: false })
  );
  pulseRing.rotation.x = -Math.PI / 2;
  pulseRing.position.y = 0.075;
  group.add(pulseRing);

  const boundaryRing = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.1, visualGoalRadius - 0.025), visualGoalRadius, 48),
    new THREE.MeshBasicMaterial({ color: "#dcfce7", transparent: true, opacity: 0.92, side: THREE.DoubleSide, depthWrite: false })
  );
  boundaryRing.rotation.x = -Math.PI / 2;
  boundaryRing.position.y = 0.082;
  boundaryRing.renderOrder = 6;
  group.add(boundaryRing);

  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(mazeGoal ? 0.22 : 0.16, mazeGoal ? 0.42 : 0.32, mazeGoal ? 1.9 : 1.45, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: "#4ade80", transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false })
  );
  beacon.position.y = mazeGoal ? 0.98 : 0.76;
  group.add(beacon);
  const glow = new THREE.PointLight(0x4ade80, mazeGoal ? 0.72 : 0.55, mazeGoal ? 4.2 : 3.2, 2);
  glow.position.y = mazeGoal ? 0.72 : 0.55;
  group.add(glow);

  group.position.set(pos[0], 0, pos[1]);
  group.userData.kind = "goal";
  group.userData.goalPulse = { ring: pulseRing, beacon, glow };
  goalPulseEffects.push(group.userData.goalPulse);
  enableObjectShadows(group);
  pulseRing.castShadow = false;
  boundaryRing.castShadow = false;
  beacon.castShadow = false;
  scene.add(group);
  markerMeshes.push(group);

  const label = createTextLabel("终点", pos[0], pos[1] - 0.62, 0.12);
  label.scale.set(mazeGoal ? 1.24 : 1.08, mazeGoal ? 0.46 : 0.4, 1);
  markerMeshes.push(label);
}

function getPackageAssets() {
  if (packageAssetCache) return packageAssetCache;
  const bodyGeometry = new THREE.BoxGeometry(PACKAGE_WIDTH, PACKAGE_HEIGHT, PACKAGE_DEPTH);
  packageAssetCache = {
    bodyGeometry,
    edgeGeometry: new THREE.EdgesGeometry(bodyGeometry),
    topTapeGeometry: new THREE.BoxGeometry(0.085, 0.014, PACKAGE_DEPTH + 0.008),
    frontTapeGeometry: new THREE.BoxGeometry(0.085, PACKAGE_HEIGHT - 0.012, 0.014),
    labelGeometry: new THREE.BoxGeometry(0.17, 0.105, 0.009),
    barcodeGeometry: new THREE.BoxGeometry(0.011, 0.062, 0.006),
    bodyMaterial: new THREE.MeshStandardMaterial({ color: "#c78345", roughness: 0.82, metalness: 0.02 }),
    targetBodyMaterial: new THREE.MeshStandardMaterial({ color: "#dc2626", roughness: 0.76, metalness: 0.03 }),
    distractorBodyMaterial: new THREE.MeshStandardMaterial({ color: "#2563eb", roughness: 0.76, metalness: 0.03 }),
    tapeMaterial: new THREE.MeshStandardMaterial({ color: "#e9bd72", roughness: 0.62 }),
    labelMaterial: new THREE.MeshStandardMaterial({ color: "#f8fafc", roughness: 0.7 }),
    inkMaterial: new THREE.MeshBasicMaterial({ color: "#334155" }),
    edgeMaterial: new THREE.LineBasicMaterial({ color: "#704326", transparent: true, opacity: 0.72 })
  };
  return packageAssetCache;
}

function createPackageModel(record, stackLevel, index) {
  const assets = getPackageAssets();
  const group = new THREE.Group();

  const bodyMaterial = record.role === "target"
    ? assets.targetBodyMaterial
    : record.role === "distractor"
      ? assets.distractorBodyMaterial
      : assets.bodyMaterial;
  const body = new THREE.Mesh(assets.bodyGeometry, bodyMaterial);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const edges = new THREE.LineSegments(assets.edgeGeometry, assets.edgeMaterial);
  group.add(edges);

  const topTape = new THREE.Mesh(assets.topTapeGeometry, assets.tapeMaterial);
  topTape.position.y = PACKAGE_HEIGHT / 2 + 0.006;
  group.add(topTape);

  const frontTape = new THREE.Mesh(assets.frontTapeGeometry, assets.tapeMaterial);
  frontTape.position.z = -PACKAGE_DEPTH / 2 - 0.006;
  group.add(frontTape);

  const label = new THREE.Mesh(assets.labelGeometry, assets.labelMaterial);
  label.position.set(0.105, 0.025, -PACKAGE_DEPTH / 2 - 0.011);
  group.add(label);

  [-0.044, -0.021, 0.004, 0.029, 0.052].forEach((offset, stripeIndex) => {
    const stripe = new THREE.Mesh(assets.barcodeGeometry, assets.inkMaterial);
    stripe.position.set(0.105 + offset, 0.025, -PACKAGE_DEPTH / 2 - 0.019);
    stripe.scale.x = stripeIndex % 2 === 0 ? 1.35 : 0.72;
    group.add(stripe);
  });

  group.position.set(record.x, PACKAGE_BASE_Y + stackLevel * PACKAGE_STACK_STEP, record.z);
  group.userData.kind = "package";
  group.userData.packageId = record.id;
  group.userData.packageRole = record.role || null;
  group.userData.stackLevel = stackLevel;
  group.userData.stackKey = packageStackKey(record.x, record.z);
  group.userData.packageIndex = index;
  if (record.role) {
    const roleLabel = createTextLabel(record.role === "target" ? "目标物" : "混淆物", 0, 0, 0.72);
    scene.remove(roleLabel);
    roleLabel.position.set(0, 0.76, 0);
    roleLabel.scale.set(1.45, 0.55, 1);
    group.add(roleLabel);
  }
  return group;
}

function addPackageMarker(record, stackLevel, index) {
  const packageGroup = createPackageModel(record, stackLevel, index);
  scene.add(packageGroup);
  markerMeshes.push(packageGroup);
  packageMeshes.push(packageGroup);
}

function createStarGeometry(outerRadius, innerRadius, depth) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 1 });
}

function resetRobot() {
  heldPackageId = null;
  heldPackageMesh = null;
  lastMoveBlocked = false;
  blockedMoveCount = 0;
  primaryBlockedMoveCount = 0;
  primaryOffRoadEpisodes = 0;
  primaryOffRoadDurationMs = 0;
  primaryOffRoadActive = false;
  primaryRunStartedAt = 0;
  primaryRunElapsedMs = 0;
  if (robotArm) robotArm.rotation.x = 0;
  if (robotClaw) robotClaw.scale.x = 1;
  const [x, z, heading] = activeMission.start || [-3, -3, 0];
  robotPose = { x, z, heading };
  syncRobot(undefined, { forceTelemetry: true });
  resetTrajectory();
}

function samplePrimaryRoadRule(elapsedMs = 0, { announce = true } = {}) {
  if (activeMission?.environment !== "guangyang" || targetSelect?.value === "real") {
    primaryOffRoadActive = false;
    return true;
  }
  const match = PRIMARY_GUANGYANG_SCORING.roadMatch(robotPose.x, robotPose.z, ROBOT_RADIUS);
  const onRoad = Boolean(match.onRoad);
  if (!onRoad) {
    if (!primaryOffRoadActive) {
      primaryOffRoadEpisodes += 1;
      if (announce) addLog("小车驶出道路：已记录一次越界，规则分开始扣除。");
    }
    primaryOffRoadDurationMs += Math.max(0, Number(elapsedMs) || 0);
  } else if (primaryOffRoadActive && announce) {
    addLog("小车已回到道路，停止累计越界时长。");
  }
  primaryOffRoadActive = !onRoad;
  return onRoad;
}

function syncRobot(measuredDistance = undefined, { forceTelemetry = false } = {}) {
  robotGroup.position.set(robotPose.x, 0, robotPose.z);
  robotGroup.rotation.y = robotPose.heading;
  markSceneShadowDirty();
  updateRobotTelemetry(measuredDistance, forceTelemetry);
}

function updateRobotTelemetry(measuredDistance = undefined, force = false) {
  const now = performance.now();
  if (!force && now - lastRobotTelemetryAt < ROBOT_TELEMETRY_INTERVAL_MS) return;
  lastRobotTelemetryAt = now;
  const real = targetSelect?.value === "real";
  const resolvedDistance = real ? null : measuredDistance ?? frontDistance();
  updateDistance(resolvedDistance);
  updateRobotState(resolvedDistance);
  if (real) return;
  // Delivery state changes only on grab/release. Avoid re-normalizing every
  // package record on movement frames; reach/checkpoint tasks still poll at 10 Hz.
  if (missionAttempt?.spec.type !== "delivery") evaluateMissionProgress();
}

function initTrajectoryLine() {
  const maxSegments = TRAJECTORY_MAX_POINTS - 1;
  const positions = new Float32Array(maxSegments * 4 * 3);
  const indices = new Uint16Array(maxSegments * 6);
  for (let segment = 0; segment < maxSegments; segment++) {
    const vertex = segment * 4;
    const offset = segment * 6;
    indices[offset] = vertex;
    indices[offset + 1] = vertex + 2;
    indices[offset + 2] = vertex + 1;
    indices[offset + 3] = vertex + 2;
    indices[offset + 4] = vertex + 3;
    indices[offset + 5] = vertex + 1;
  }
  const geometry = new THREE.BufferGeometry();
  trajectoryPositionAttribute = new THREE.BufferAttribute(positions, 3);
  trajectoryPositionAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", trajectoryPositionAttribute);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);
  const material = new THREE.MeshBasicMaterial({
    color: "#38bdf8",
    transparent: true,
    opacity: 0.62,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  trajectoryLine = new THREE.Mesh(geometry, material);
  trajectoryLine.frustumCulled = false;
  trajectoryLine.renderOrder = 3;
  scene.add(trajectoryLine);
  trajectoryHead = new THREE.Mesh(
    new THREE.CircleGeometry(TRAJECTORY_WIDTH * 0.72, 24),
    new THREE.MeshBasicMaterial({ color: "#7dd3fc", transparent: true, opacity: 0.76, depthWrite: false })
  );
  trajectoryHead.rotation.x = -Math.PI / 2;
  trajectoryHead.renderOrder = 4;
  scene.add(trajectoryHead);
  resetTrajectory();
}

function resetTrajectory() {
  trajectoryPoints = [{ x: robotPose.x, z: robotPose.z }];
  trajectoryTotalDistance = 0;
  updateTrajectoryLine();
}

function addTrajectoryPoint(x, z) {
  const last = trajectoryPoints[trajectoryPoints.length - 1];
  const segment = last ? Math.hypot(x - last.x, z - last.z) : 0;
  if (last && segment < TRAJECTORY_POINT_SPACING) return;
  trajectoryPoints.push({ x, z });
  trajectoryTotalDistance += segment;
  trimTrajectoryPoints();
  updateTrajectoryLine();
}

function trimTrajectoryPoints() {
  while (trajectoryPoints.length > TRAJECTORY_MAX_POINTS) {
    const first = trajectoryPoints[0];
    const second = trajectoryPoints[1];
    const segment = Math.hypot(second.x - first.x, second.z - first.z);
    trajectoryPoints.shift();
    trajectoryTotalDistance = Math.max(0, trajectoryTotalDistance - segment);
  }

  while (trajectoryTotalDistance > TRAJECTORY_MAX_DISTANCE && trajectoryPoints.length > 1) {
    const first = trajectoryPoints[0];
    const second = trajectoryPoints[1];
    const segment = Math.hypot(second.x - first.x, second.z - first.z);
    const excess = trajectoryTotalDistance - TRAJECTORY_MAX_DISTANCE;
    if (segment <= 0.0001 || excess >= segment) {
      trajectoryPoints.shift();
      trajectoryTotalDistance = Math.max(0, trajectoryTotalDistance - segment);
      continue;
    }
    const t = excess / segment;
    trajectoryPoints[0] = {
      x: first.x + (second.x - first.x) * t,
      z: first.z + (second.z - first.z) * t
    };
    trajectoryTotalDistance = TRAJECTORY_MAX_DISTANCE;
  }
}

function updateTrajectoryLine() {
  if (!trajectoryLine || !trajectoryPositionAttribute) return;
  const positions = trajectoryPositionAttribute.array;
  let segmentCount = 0;
  for (let i = 1; i < trajectoryPoints.length; i++) {
    const prev = trajectoryPoints[i - 1];
    const next = trajectoryPoints[i];
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.0001) continue;
    const sideX = -dz / length * TRAJECTORY_WIDTH / 2;
    const sideZ = dx / length * TRAJECTORY_WIDTH / 2;
    const offset = segmentCount * 12;
    positions[offset] = prev.x + sideX;
    positions[offset + 1] = 0.052;
    positions[offset + 2] = prev.z + sideZ;
    positions[offset + 3] = prev.x - sideX;
    positions[offset + 4] = 0.052;
    positions[offset + 5] = prev.z - sideZ;
    positions[offset + 6] = next.x + sideX;
    positions[offset + 7] = 0.052;
    positions[offset + 8] = next.z + sideZ;
    positions[offset + 9] = next.x - sideX;
    positions[offset + 10] = 0.052;
    positions[offset + 11] = next.z - sideZ;
    segmentCount++;
  }
  trajectoryPositionAttribute.needsUpdate = true;
  trajectoryLine.geometry.setDrawRange(0, segmentCount * 6);
  trajectoryLine.visible = segmentCount > 0;
  if (trajectoryHead) {
    const last = trajectoryPoints[trajectoryPoints.length - 1];
    trajectoryHead.position.set(last.x, 0.058, last.z);
    trajectoryHead.visible = segmentCount > 0;
  }
}

function directionVector() {
  directionVectorScratch.x = -Math.sin(robotPose.heading);
  directionVectorScratch.z = -Math.cos(robotPose.heading);
  return directionVectorScratch;
}

function circleOverlapsCircle(x, z, radius, otherX, otherZ, otherRadius) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius)
    || !Number.isFinite(otherX) || !Number.isFinite(otherZ) || !Number.isFinite(otherRadius)
    || radius < 0 || otherRadius < 0) return true;
  const dx = x - otherX;
  const dz = z - otherZ;
  const combined = radius + otherRadius;
  return dx * dx + dz * dz < combined * combined;
}

function circleHitsRect(x, z, radius, rect) {
  const rectX = Number(rect?.x);
  const rectZ = Number(rect?.z);
  const rectW = Number(rect?.w);
  const rectH = Number(rect?.h);
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius)
    || !Number.isFinite(rectX) || !Number.isFinite(rectZ) || !Number.isFinite(rectW) || !Number.isFinite(rectH)
    || radius < 0) return true;
  const halfW = Math.abs(rectW) / 2;
  const halfH = Math.abs(rectH) / 2;
  const closestX = Math.max(rectX - halfW, Math.min(x, rectX + halfW));
  const closestZ = Math.max(rectZ - halfH, Math.min(z, rectZ + halfH));
  const dx = x - closestX;
  const dz = z - closestZ;
  return dx * dx + dz * dz < radius * radius;
}

function rayCircleEntry(originX, originZ, dirX, dirZ, centerX, centerZ, radius) {
  if (!Number.isFinite(originX) || !Number.isFinite(originZ) || !Number.isFinite(dirX) || !Number.isFinite(dirZ)
    || !Number.isFinite(centerX) || !Number.isFinite(centerZ) || !Number.isFinite(radius) || radius < 0) return 0;
  const offsetX = originX - centerX;
  const offsetZ = originZ - centerZ;
  const projection = offsetX * dirX + offsetZ * dirZ;
  const distanceTerm = offsetX * offsetX + offsetZ * offsetZ - radius * radius;
  if (distanceTerm < -PHYSICS_EPSILON) return 0;
  if (distanceTerm <= PHYSICS_EPSILON) return projection < 0 ? 0 : Infinity;
  if (projection >= 0) return Infinity;
  const discriminant = projection * projection - distanceTerm;
  if (discriminant <= PHYSICS_EPSILON) return Infinity;
  return Math.max(0, -projection - Math.sqrt(discriminant));
}

function rayOpenAabbEntry(originX, originZ, dirX, dirZ, minX, maxX, minZ, maxZ) {
  if (!Number.isFinite(originX) || !Number.isFinite(originZ) || !Number.isFinite(dirX) || !Number.isFinite(dirZ)
    || !Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) return 0;
  let near = -Infinity;
  let far = Infinity;

  if (Math.abs(dirX) <= PHYSICS_EPSILON) {
    if (originX <= minX + PHYSICS_EPSILON || originX >= maxX - PHYSICS_EPSILON) return Infinity;
  } else {
    const first = (minX - originX) / dirX;
    const second = (maxX - originX) / dirX;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
  }
  if (Math.abs(dirZ) <= PHYSICS_EPSILON) {
    if (originZ <= minZ + PHYSICS_EPSILON || originZ >= maxZ - PHYSICS_EPSILON) return Infinity;
  } else {
    const first = (minZ - originZ) / dirZ;
    const second = (maxZ - originZ) / dirZ;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
  }
  if (far <= Math.max(near, 0) + PHYSICS_EPSILON) return Infinity;
  return Math.max(0, near);
}

function rayRoundedRectEntry(originX, originZ, dirX, dirZ, rect, radius) {
  const rectX = Number(rect?.x);
  const rectZ = Number(rect?.z);
  const rectW = Number(rect?.w);
  const rectH = Number(rect?.h);
  if (!Number.isFinite(originX) || !Number.isFinite(originZ) || !Number.isFinite(dirX) || !Number.isFinite(dirZ)
    || !Number.isFinite(rectX) || !Number.isFinite(rectZ) || !Number.isFinite(rectW) || !Number.isFinite(rectH)
    || !Number.isFinite(radius) || radius < 0) return 0;
  const halfW = Math.abs(rectW) / 2;
  const halfH = Math.abs(rectH) / 2;
  const minX = rectX - halfW;
  const maxX = rectX + halfW;
  const minZ = rectZ - halfH;
  const maxZ = rectZ + halfH;
  let nearest = rayOpenAabbEntry(originX, originZ, dirX, dirZ, minX, maxX, minZ - radius, maxZ + radius);
  nearest = Math.min(nearest, rayOpenAabbEntry(originX, originZ, dirX, dirZ, minX - radius, maxX + radius, minZ, maxZ));
  nearest = Math.min(nearest, rayCircleEntry(originX, originZ, dirX, dirZ, minX, minZ, radius));
  nearest = Math.min(nearest, rayCircleEntry(originX, originZ, dirX, dirZ, minX, maxZ, radius));
  nearest = Math.min(nearest, rayCircleEntry(originX, originZ, dirX, dirZ, maxX, minZ, radius));
  return Math.min(nearest, rayCircleEntry(originX, originZ, dirX, dirZ, maxX, maxZ, radius));
}

function playableBoundaryRayDistance(originX, originZ, dirX, dirZ) {
  const inner = currentMapInner();
  if (!Number.isFinite(originX) || !Number.isFinite(originZ) || !Number.isFinite(dirX)
    || !Number.isFinite(dirZ) || !Number.isFinite(inner) || outsidePlayableBounds(originX, originZ)) return 0;
  const edgeX = dirX > PHYSICS_EPSILON
    ? (inner - originX) / dirX
    : dirX < -PHYSICS_EPSILON
      ? (-inner - originX) / dirX
      : Infinity;
  const edgeZ = dirZ > PHYSICS_EPSILON
    ? (inner - originZ) / dirZ
    : dirZ < -PHYSICS_EPSILON
      ? (-inner - originZ) / dirZ
      : Infinity;
  return Math.max(0, Math.min(edgeX, edgeZ));
}

function rebuildRobotCollisionShapes() {
  const shapes = obstacleMeshes.map(mesh => ({
    type: "circle",
    kind: "obstacle",
    obstacleId: mesh.userData.obstacleId || null,
    x: mesh.position.x,
    z: mesh.position.z,
    radius: BLOCK_RADIUS
  }));
  const packageStacks = new Set();
  packageMeshes.forEach(mesh => {
    if (mesh === heldPackageMesh) return;
    const key = mesh.userData.stackKey || packageStackKey(mesh.position.x, mesh.position.z);
    if (packageStacks.has(key)) return;
    packageStacks.add(key);
    shapes.push({ type: "circle", x: mesh.position.x, z: mesh.position.z, radius: PACKAGE_RADIUS });
  });
  getActiveWallColliders().forEach(rect => shapes.push({ type: "rect", rect }));
  robotCollisionShapes = shapes;
}

function forEachRobotCollisionShape(visitor) {
  robotCollisionShapes.forEach(visitor);
}

function collisionShapeOverlapsRobot(shape, x, z) {
  return shape.type === "circle"
    ? circleOverlapsCircle(x, z, ROBOT_RADIUS, shape.x, shape.z, shape.radius)
    : circleHitsRect(x, z, ROBOT_RADIUS, shape.rect);
}

function collisionShapeRayDistance(shape, originX, originZ, dirX, dirZ) {
  return shape.type === "circle"
    ? rayCircleEntry(originX, originZ, dirX, dirZ, shape.x, shape.z, ROBOT_RADIUS + shape.radius)
    : rayRoundedRectEntry(originX, originZ, dirX, dirZ, shape.rect, ROBOT_RADIUS);
}

function robotClearanceInfoAlongRay(originX, originZ, dirX, dirZ) {
  if (!Number.isFinite(originX) || !Number.isFinite(originZ) || !Number.isFinite(dirX) || !Number.isFinite(dirZ)) {
    return { distance: 0, shape: null };
  }
  const length = Math.hypot(dirX, dirZ);
  if (length <= PHYSICS_EPSILON) return { distance: Infinity, shape: null };
  const normalizedX = dirX / length;
  const normalizedZ = dirZ / length;
  let nearest = playableBoundaryRayDistance(originX, originZ, normalizedX, normalizedZ);
  let nearestShape = null;
  for (let index = 0; index < robotCollisionShapes.length; index++) {
    const shape = robotCollisionShapes[index];
    const candidate = collisionShapeRayDistance(shape, originX, originZ, normalizedX, normalizedZ);
    if (Number.isNaN(candidate)) return { distance: 0, shape };
    if (candidate < nearest) {
      nearest = candidate;
      nearestShape = shape;
    }
  }
  return { distance: Math.max(0, nearest), shape: nearestShape };
}

function robotClearanceAlongRay(originX, originZ, dirX, dirZ) {
  return robotClearanceInfoAlongRay(originX, originZ, dirX, dirZ).distance;
}

function frontDistance() {
  const dir = directionVector();
  return robotClearanceAlongRay(robotPose.x, robotPose.z, dir.x, dir.z);
}

function outsidePlayableBounds(x, z) {
  const inner = currentMapInner();
  return !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(inner)
    || Math.abs(x) > inner || Math.abs(z) > inner;
}

function isBlocked(nextX, nextZ) {
  if (outsidePlayableBounds(nextX, nextZ)) return true;
  return robotCollisionShapes.some(shape => collisionShapeOverlapsRobot(shape, nextX, nextZ));
}

function isBlockedByWalls(x, z) {
  return getActiveWallColliders().some(wall => circleHitsRect(x, z, ROBOT_RADIUS, wall));
}

function getActiveWallColliders() {
  if (isLargeMap()) return missionWallColliders;
  const fixed = currentMapStyle === "competition"
    ? boundaryColliders.concat(competitionWallColliders, getCompetitionReservedRects())
    : boundaryColliders;
  return fixed.concat(missionWallColliders);
}

function formatSensorDistance(distance) {
  const centimeters = Math.max(0, primaryWorldUnitsToCm(distance));
  return !Number.isFinite(centimeters) || centimeters > SENSOR_DISPLAY_MAX_CM
    ? `>${SENSOR_DISPLAY_MAX_CM} cm`
    : `${Math.round(centimeters)} cm`;
}

function updateDistance(measuredDistance = null) {
  if (targetSelect?.value === "real") {
    setTextIfChanged(distanceText, "无避障");
    return;
  }
  const distance = measuredDistance ?? frontDistance();
  setTextIfChanged(distanceText, formatSensorDistance(distance));
}

function setTextIfChanged(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function updateRobotState(measuredDistance = null) {
  if (!poseText) return;
  if (targetSelect?.value === "real") {
    setTextIfChanged(poseText, "未回传");
    setTextIfChanged(headingText, "未回传");
    setTextIfChanged(gripperText, "未回传");
    setTextIfChanged(frontText, "无传感器");
    return;
  }
  const distance = measuredDistance ?? frontDistance();
  const xCm = primaryWorldUnitsToCm(robotPose.x);
  const zCm = primaryWorldUnitsToCm(robotPose.z);
  setTextIfChanged(poseText, `${xCm.toFixed(1)}, ${zCm.toFixed(1)} cm`);
  setTextIfChanged(headingText, headingName());
  setTextIfChanged(gripperText, isHoldingPackage() ? "抓着包裹" : "空");
  setTextIfChanged(frontText, lastMoveBlocked
    ? "刚被挡住"
    : distance < FRONT_BLOCKED_DISTANCE
      ? `有障碍 ${formatSensorDistance(distance)}`
      : `通畅 ${formatSensorDistance(distance)}`);
}

function packageDistance() {
  return packageReachInfo().distance;
}

function getTopPackageMeshes() {
  const topByStack = new Map();
  packageMeshes.forEach(mesh => {
    if (mesh === heldPackageMesh) return;
    const key = mesh.userData.stackKey || packageStackKey(mesh.position.x, mesh.position.z);
    const current = topByStack.get(key);
    if (!current || mesh.position.y > current.position.y) topByStack.set(key, mesh);
  });
  return [...topByStack.values()];
}

function measurePackageReach(mesh) {
  const dir = directionVector();
  const dx = mesh.position.x - robotPose.x;
  const dz = mesh.position.z - robotPose.z;
  const forward = dx * dir.x + dz * dir.z;
  const side = Math.abs(dx * dir.z - dz * dir.x);
  const distance = Math.hypot(dx, dz);
  let reason = "ok";
  if (forward < 0.38) reason = "behind";
  else if (forward > 1.35) reason = "far";
  else if (side > 0.38) reason = "side";
  return { mesh, reachable: reason === "ok", distance, forward, side, reason };
}

function packageReachInfo() {
  if (isHoldingPackage()) {
    return { reachable: false, distance: Infinity, forward: -Infinity, side: Infinity, reason: "holding", mesh: null };
  }
  const measured = getTopPackageMeshes().map(measurePackageReach);
  if (!measured.length) {
    return { reachable: false, distance: Infinity, forward: -Infinity, side: Infinity, reason: "missing", mesh: null };
  }
  const reachable = measured.filter(item => item.reachable).sort((a, b) => a.distance - b.distance);
  if (reachable.length) return reachable[0];
  return measured.sort((a, b) => a.distance - b.distance)[0];
}

function attachPackageToRobot() {
  const reach = packageReachInfo();
  if (!reach.reachable || !reach.mesh) return false;
  const packageMesh = reach.mesh;
  scene.remove(packageMesh);
  robotClaw.add(packageMesh);
  packageMesh.position.set(0, 0, -0.25);
  packageMesh.rotation.set(0, 0, 0);
  packageMesh.scale.set(0.78 / Math.max(0.1, robotClaw.scale.x), 0.78, 0.78);
  heldPackageId = packageMesh.userData.packageId;
  heldPackageMesh = packageMesh;
  missionAttempt?.handledPackageIds?.add(heldPackageId);
  rebuildRobotCollisionShapes();
  markSceneShadowDirty();
  return true;
}

function findNearbyPackageStack(x, z, excludeId) {
  const stacks = new Map();
  ensureMissionPackages().forEach(record => {
    if (record.id === excludeId) return;
    const key = packageStackKey(record.x, record.z);
    if (!stacks.has(key)) stacks.set(key, { x: record.x, z: record.z });
  });
  let nearest = null;
  stacks.forEach(stack => {
    const distance = Math.hypot(stack.x - x, stack.z - z);
    if (distance <= PACKAGE_STACK_SNAP_DISTANCE && (!nearest || distance < nearest.distance)) {
      nearest = { ...stack, distance };
    }
  });
  return nearest;
}

function releasePackageFromRobot() {
  if (!isHoldingPackage()) return false;
  const packageMesh = heldPackageMesh;
  const packageId = heldPackageId;
  const worldPos = new THREE.Vector3();
  packageMesh.getWorldPosition(worldPos);
  if (packageMesh.parent) packageMesh.parent.remove(packageMesh);
  scene.add(packageMesh);
  const boundedX = Math.max(-currentMapInner() + PACKAGE_RADIUS, Math.min(currentMapInner() - PACKAGE_RADIUS, worldPos.x));
  const boundedZ = Math.max(-currentMapInner() + PACKAGE_RADIUS, Math.min(currentMapInner() - PACKAGE_RADIUS, worldPos.z));
  const nearbyStack = findNearbyPackageStack(boundedX, boundedZ, packageId);
  const dropX = nearbyStack ? nearbyStack.x : boundedX;
  const dropZ = nearbyStack ? nearbyStack.z : boundedZ;
  const packages = ensureMissionPackages();
  const recordIndex = packages.findIndex(record => record.id === packageId);
  const record = recordIndex >= 0 ? packages.splice(recordIndex, 1)[0] : { id: packageId, x: dropX, z: dropZ };
  record.x = dropX;
  record.z = dropZ;
  const stackLevel = packages.filter(item => packageStackKey(item.x, item.z) === packageStackKey(dropX, dropZ)).length;
  packages.push(record);
  packageMesh.position.set(dropX, PACKAGE_BASE_Y + stackLevel * PACKAGE_STACK_STEP, dropZ);
  packageMesh.rotation.set(0, 0, 0);
  packageMesh.scale.setScalar(1);
  packageMesh.userData.stackLevel = stackLevel;
  packageMesh.userData.stackKey = packageStackKey(dropX, dropZ);
  packageMesh.userData.packageIndex = packages.length - 1;
  heldPackageId = null;
  heldPackageMesh = null;
  rebuildRobotCollisionShapes();
  markSceneShadowDirty();
  return { stackLevel, snapped: Boolean(nearbyStack) };
}

async function animateGripper(closing, context) {
  if (!robotArm || !robotClaw) return;
  if (closing) {
    await animateArmTo(-0.32, 260, context);
    await animateClawTo(0.72, 220, context);
    return;
  }
  await animateClawTo(1, 180, context);
  await animateArmTo(0, 240, context);
}

async function animateArmTo(targetRotation, duration = 260, context) {
  if (!robotArm) return;
  await waitForRunCheckpoint(context);
  const startRotation = robotArm.rotation.x;
  let elapsed = 0;
  let last = performance.now();
  while (elapsed < duration) {
    if (await waitForRunCheckpoint(context)) last = performance.now();
    const now = performance.now();
    elapsed += Math.min(50, now - last);
    last = now;
    const t = Math.min(1, elapsed / duration);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    robotArm.rotation.x = startRotation + (targetRotation - startRotation) * eased;
    markSceneShadowDirty();
    await sleepForRun(16, context);
  }
  throwIfRunCancelled(context);
  robotArm.rotation.x = targetRotation;
  markSceneShadowDirty();
}

async function animateClawTo(targetScale, duration = 180, context) {
  if (!robotClaw) return;
  await waitForRunCheckpoint(context);
  const startScale = robotClaw.scale.x;
  let elapsed = 0;
  let last = performance.now();
  while (elapsed < duration) {
    if (await waitForRunCheckpoint(context)) last = performance.now();
    const now = performance.now();
    elapsed += Math.min(50, now - last);
    last = now;
    const t = Math.min(1, elapsed / duration);
    const eased = 1 - Math.pow(1 - t, 2);
    robotClaw.scale.x = startScale + (targetScale - startScale) * eased;
    markSceneShadowDirty();
    await sleepForRun(16, context);
  }
  throwIfRunCancelled(context);
  robotClaw.scale.x = targetScale;
  markSceneShadowDirty();
}

async function liftArmToCarryPosition(context) {
  await animateArmTo(0, 280, context);
}

function headingName() {
  const turn = ((robotPose.heading % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const names = ["北", "西", "南", "东"];
  return names[Math.round(turn / (Math.PI / 2)) % 4];
}

function clearActionLog() {
  actionLog.innerHTML = "";
  logCounter = 0;
}

function addLog(text) {
  const item = document.createElement("li");
  const index = document.createElement("span");
  index.className = "log-index";
  index.textContent = `#${++logCounter}`;
  const body = document.createElement("span");
  body.className = "log-text";
  body.textContent = text;
  item.append(index, body);
  actionLog.append(item);
  while (actionLog.children.length > 120) actionLog.firstElementChild.remove();
  actionLog.scrollTop = actionLog.scrollHeight;
}

function formatRuntimeDuration(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000;
  return `${Number(seconds.toFixed(seconds < 10 ? 2 : 1))} 秒`;
}

function formatProgramOutput(value) {
  let text;
  try {
    text = value && typeof value === "object" ? JSON.stringify(value) : String(value);
  } catch {
    text = "（无法显示这个值）";
  }
  if (!text) return "（空文本）";
  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}

function clearRuntimeFeedback() {
  runtimeFeedbackToken += 1;
  if (runtimeFeedbackTimer) {
    clearTimeout(runtimeFeedbackTimer);
    runtimeFeedbackTimer = 0;
  }
  if (!runtimeFeedback) return;
  runtimeFeedback.hidden = true;
  runtimeFeedback.dataset.tone = "output";
  runtimeFeedback.setAttribute("aria-live", "polite");
  if (runtimeFeedbackLabel) runtimeFeedbackLabel.textContent = "程序输出";
  if (runtimeFeedbackValue) runtimeFeedbackValue.textContent = "--";
}

function showRuntimeFeedback(label, value, { tone = "output", autoHideMs = 0 } = {}) {
  if (!runtimeFeedback) return;
  if (runtimeFeedbackTimer) {
    clearTimeout(runtimeFeedbackTimer);
    runtimeFeedbackTimer = 0;
  }
  const token = ++runtimeFeedbackToken;
  runtimeFeedback.dataset.tone = tone;
  runtimeFeedback.setAttribute("aria-live", tone === "warning" ? "assertive" : "polite");
  if (runtimeFeedbackLabel) runtimeFeedbackLabel.textContent = label;
  if (runtimeFeedbackValue) runtimeFeedbackValue.textContent = value;
  runtimeFeedback.hidden = false;
  if (autoHideMs > 0) {
    runtimeFeedbackTimer = setTimeout(() => {
      runtimeFeedbackTimer = 0;
      if (token !== runtimeFeedbackToken) return;
      clearRuntimeFeedback();
    }, autoHideMs);
  }
}

function spinDriveWheels(distance) {
  const wheelRadius = 0.15;
  robotWheels.forEach(wheel => {
    wheel.rotation.x -= distance / wheelRadius;
  });
}

function spinTurnWheels(turnSign, amount) {
  robotWheels.forEach(wheel => {
    wheel.rotation.x += turnSign * wheel.userData.side * amount;
  });
}

function normalizeMoveDistanceCm(value) {
  const centimeters = Number(value);
  if (!Number.isFinite(centimeters) || centimeters < 0.1 || centimeters > 500) {
    throw new Error("移动距离必须是 0.1 到 500 厘米");
  }
  return centimeters;
}

async function moveRobotCentimeters(sign, distanceCm, context) {
  const centimeters = normalizeMoveDistanceCm(distanceCm);
  const seconds = primaryCmToWorldUnits(centimeters) / PRIMARY_DRIVE_WORLD_UNITS_PER_SECOND;
  return moveRobot(sign, seconds, context, { requestedDistanceCm: centimeters });
}

async function moveRobot(sign, seconds, context, { requestedDistanceCm = null } = {}) {
  await waitForRunCheckpoint(context);
  actionCount++;
  let moved = false;
  const isDistanceCommand = Number.isFinite(requestedDistanceCm);
  const totalMs = normalizeDurationSeconds(seconds, {
    minimum: isDistanceCommand ? 0.001 : 0.1,
    maximum: isDistanceCommand ? 32 : 30,
    label: "移动"
  }) * 1000;
  const speed = PRIMARY_DRIVE_WORLD_UNITS_PER_SECOND;
  let elapsed = 0;
  let last = performance.now();
  const action = sign > 0 ? "前进" : "后退";
  addLog(isDistanceCommand
    ? `${action} ${Math.round(requestedDistanceCm * 10) / 10} 厘米，方向 ${headingName()}。`
    : `${action} ${Math.round(totalMs / 100) / 10} 秒（旧版作品兼容），方向 ${headingName()}。`);
  while (elapsed < totalMs) {
    if (await waitForRunCheckpoint(context)) last = performance.now();
    const now = performance.now();
    const dt = Math.min(50, Math.max(0, now - last), totalMs - elapsed);
    last = now;
    elapsed += dt;
    const stepDistance = speed * dt / 1000;
    const dir = directionVector();
    const moveDirX = dir.x * sign;
    const moveDirZ = dir.z * sign;
    const clearanceInfo = robotClearanceInfoAlongRay(robotPose.x, robotPose.z, moveDirX, moveDirZ);
    const clearance = clearanceInfo.distance;
    const availableDistance = Math.max(0, clearance - MOVE_COLLISION_SKIN);
    const blocked = availableDistance < stepDistance - PHYSICS_EPSILON;
    const actualDistance = blocked ? availableDistance : stepDistance;
    if (blocked) {
      primaryBlockedMoveCount++;
      if (clearanceInfo.shape?.kind === "obstacle" && clearanceInfo.shape.obstacleId) {
        missionAttempt?.failedObstacleIds?.add(clearanceInfo.shape.obstacleId);
      }
    }
    if (actualDistance > PHYSICS_EPSILON) {
      robotPose.x += moveDirX * actualDistance;
      robotPose.z += moveDirZ * actualDistance;
      context.distanceWorld = Math.max(0, Number(context.distanceWorld) || 0) + actualDistance;
      spinDriveWheels(actualDistance * sign);
      moved = true;
      blockedMoveCount = 0;
      lastMoveBlocked = false;
      syncRobot(sign > 0 ? Math.max(0, clearance - actualDistance) : undefined);
      addTrajectoryPoint(robotPose.x, robotPose.z);
    }
    samplePrimaryRoadRule(dt);
    if (blocked) {
      setStatus("前方受阻，等待下一条积木");
      blockedMoveCount++;
      lastMoveBlocked = true;
      addLog(`${action} 被挡住：当前动作结束，程序继续判断下一条积木。`);
      evaluateMissionProgress({ allowComplete: false, announce: false });
      break;
    }
    await sleepForRun(16, context);
  }
  if (!moved && blockedMoveCount >= 3) {
    requestRunPause(context, "blocked");
    setStatus("巡逻连续受阻，已暂停");
    addLog("连续 3 次前进都被挡住，已暂停。请在持续巡逻里加入“如果前方有障碍物 -> 左转/右转角度”。");
    await waitForRunCheckpoint(context);
  }
  throwIfRunCancelled(context);
  updateRobotTelemetry(undefined, true);
  renderPrimaryScore();
}

async function turnRobot(dir, seconds, context) {
  await waitForRunCheckpoint(context);
  actionCount++;
  blockedMoveCount = 0;
  lastMoveBlocked = false;
  const sign = dir === "left" ? 1 : -1;
  const totalMs = normalizeDurationSeconds(seconds, { minimum: 0.1, maximum: 30, label: "转向" }) * 1000;
  const turnSpeed = 2.8;
  let elapsed = 0;
  let last = performance.now();
  addLog(`${dir === "left" ? "左转" : "右转"} ${Math.round(totalMs / 100) / 10} 秒，用来改变朝向。`);
  while (elapsed < totalMs) {
    if (await waitForRunCheckpoint(context)) last = performance.now();
    const now = performance.now();
    const dt = Math.min(50, Math.max(0, now - last), totalMs - elapsed);
    last = now;
    elapsed += dt;
    const delta = sign * turnSpeed * dt / 1000;
    robotPose.heading += delta;
    spinTurnWheels(sign, Math.abs(delta) * 2.4);
    syncRobot();
    samplePrimaryRoadRule(dt);
    await sleepForRun(16, context);
  }
  throwIfRunCancelled(context);
  addLog(`转向后朝向 ${headingName()}。`);
  updateRobotTelemetry(undefined, true);
}

function normalizeTurnDegrees(value) {
  const degrees = Number(value);
  if (!Number.isFinite(degrees) || degrees < 1 || degrees > 360) {
    throw new Error("转向角度必须是 1 到 360 度");
  }
  return Math.round(degrees);
}

function logLoopIteration(context, name, index, total) {
  if (total) {
    if (index <= 3 || index === total || index % 10 === 0) {
      addLog(`${name}：第 ${index}/${total} 次。`);
    }
    return;
  }
  const now = performance.now();
  const lastLoggedAt = context.loopLogState.get(name) ?? -Infinity;
  if (index <= 3 || now - lastLoggedAt >= 1000) {
    context.loopLogState.set(name, now);
    addLog(`${name}：第 ${index} 次。`);
  }
}

function logEmptyLoopOnce(context, name) {
  if (context.emptyLoopWarnings.has(name)) return;
  context.emptyLoopWarnings.add(name);
  addLog(`${name}里面没有动作积木。`);
}

function normalizeDurationSeconds(value, { minimum = 0, maximum = 60, label = "动作" } = {}) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < minimum || seconds > maximum) {
    throw new Error(`${label}时间必须是 ${minimum} 到 ${maximum} 秒`);
  }
  return seconds;
}

async function waitProgramDuration(seconds, context, logPrefix = "") {
  await waitForRunCheckpoint(context);
  const ms = normalizeDurationSeconds(seconds, { minimum: 0, maximum: 60, label: "等待" }) * 1000;
  const duration = formatRuntimeDuration(ms);
  programEffectCount += 1;
  addLog(`${logPrefix}等待 ${duration}，暂时不发送移动指令。`);
  setStatus(`等待中 · ${duration}`);

  let lastFeedbackValue = "";
  let lastRoadSampleElapsed = 0;
  await waitRunDuration(ms, context, 50, (elapsed, total) => {
    samplePrimaryRoadRule(Math.max(0, elapsed - lastRoadSampleElapsed));
    lastRoadSampleElapsed = elapsed;
    if (!runContextIsCurrent(context) || elapsed >= total) return;
    const remaining = Math.min(total, Math.ceil((total - elapsed) / 100) * 100);
    const feedbackValue = `剩余 ${formatRuntimeDuration(remaining)}`;
    if (feedbackValue === lastFeedbackValue) return;
    lastFeedbackValue = feedbackValue;
    showRuntimeFeedback("等待中", feedbackValue, { tone: "wait" });
  });

  throwIfRunCancelled(context);
  addLog(`${logPrefix}等待完成：${duration}。`);
  setStatus("正在运行");
  showRuntimeFeedback("等待完成", duration, { tone: "success", autoHideMs: 900 });
}

async function turnRobotAngle(dir, degrees, context) {
  await waitForRunCheckpoint(context);
  actionCount++;
  blockedMoveCount = 0;
  lastMoveBlocked = false;
  const sign = dir === "left" ? 1 : -1;
  const safeDegrees = normalizeTurnDegrees(degrees);
  const angle = THREE.MathUtils.degToRad(safeDegrees);
  const startHeading = robotPose.heading;
  const targetHeading = startHeading + sign * angle;
  const totalMs = Math.max(260, Math.min(1200, angle / (Math.PI / 2) * 520));
  let elapsed = 0;
  let last = performance.now();
  addLog(`${dir === "left" ? "左转" : "右转"} ${safeDegrees}°，精确改变朝向。`);
  while (elapsed < totalMs) {
    if (await waitForRunCheckpoint(context)) last = performance.now();
    const now = performance.now();
    const dt = Math.min(50, Math.max(0, now - last), totalMs - elapsed);
    elapsed += dt;
    last = now;
    const t = Math.min(1, elapsed / totalMs);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const deltaHeading = startHeading + (targetHeading - startHeading) * eased - robotPose.heading;
    robotPose.heading = startHeading + (targetHeading - startHeading) * eased;
    spinTurnWheels(sign, Math.abs(deltaHeading) * 2.4);
    syncRobot();
    samplePrimaryRoadRule(dt);
    await sleepForRun(16, context);
  }
  throwIfRunCancelled(context);
  robotPose.heading = targetHeading;
  syncRobot(undefined, { forceTelemetry: true });
  addLog(`转向后朝向 ${headingName()}。`);
}

function getPrimaryNavigationNetwork() {
  if (primaryNavigationNetwork) return primaryNavigationNetwork;
  const core = globalThis.BlocklyNavigationCore;
  if (!core?.createNetwork) throw new Error("导航拓扑模块没有加载，请刷新页面重试");
  primaryNavigationNetwork = core.createNetwork(PRIMARY_GUANGYANG_SCORING.ROADS, {
    worldUnitsPerMeter: PRIMARY_WORLD_UNITS_PER_METER,
    vehicleRadiusWorld: ROBOT_RADIUS,
    nodeRadiusCm: 25
  });
  return primaryNavigationNetwork;
}

function normalizeSignedRadians(value) {
  let angle = Number(value) || 0;
  while (angle < -Math.PI) angle += Math.PI * 2;
  while (angle >= Math.PI) angle -= Math.PI * 2;
  return angle;
}

function roundNavigationValue(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}

function recordExecutedRobotMethod(context, method) {
  if (!TRACKED_ROBOT_METHODS.has(method) || context.executedApiMethodSet.has(method)) return;
  context.executedApiMethodSet.add(method);
  context.executedApiMethods.push(method);
}

function requireGuangyangSimulation(context, method) {
  throwIfRunCancelled(context);
  if (context.target !== "sim" || activeMission?.environment !== "guangyang") {
    throw new Error(`${method} 只支持广阳岛 3D 比赛地图`);
  }
}

function navigationSensorTick(context, method) {
  requireGuangyangSimulation(context, method);
  context.navigationQueryCount += 1;
  if (context.navigationQueryCount > 1000) throw new Error("导航传感查询超过每次运行 1000 次的上限");
  context.sensorTick += 1;
  recordExecutedRobotMethod(context, method);
  return context.sensorTick;
}

function missionAnchor(network, id, point) {
  if (!Array.isArray(point) || point.length < 2) throw new Error(`任务锚点 ${id} 不完整`);
  return network.anchorAt(point[0], point[1], id);
}

function readBlocklyMission(context) {
  const tick = navigationSensorTick(context, "mission");
  const network = getPrimaryNavigationNetwork();
  const baseline = missionBaseline || activeMission;
  const checkpointPoints = Array.isArray(baseline?.guidePath) ? baseline.guidePath.slice(1, -1) : [];
  const packages = normalizePackageRecords(baseline);
  const objectAnchors = [
    ...packages.filter(item => ["target", "distractor"].includes(item.role)).map(item => ({ role: item.role, x: item.x, z: item.z })),
    ...(baseline?.obstacles || []).map(point => ({ role: "obstacle", x: point[0], z: point[1] }))
  ].map(item => {
    const anchor = network.anchorAt(item.x, item.z);
    return { role: item.role, roadId: anchor.roadId, progressCm: anchor.progressCm };
  }).sort((left, right) => left.role.localeCompare(right.role, "en") || left.roadId.localeCompare(right.roadId, "en"));
  return {
    schemaVersion: "chenlong.blockly-navigation-mission/v1",
    mapId: activeMission.taskId,
    mapVersion: `${activeMission.mapRevision || 0}:${activeMission.mapDigest || "unpublished"}`,
    start: missionAnchor(network, "start", baseline.start),
    storage: missionAnchor(network, "storage", baseline.landmarks?.storage),
    checkpoints: checkpointPoints.map((point, index) => missionAnchor(
      network,
      baseline.checkpointLabels?.[index] || `checkpoint-${index + 1}`,
      point
    )),
    return: missionAnchor(network, "return", baseline.goal),
    objects: objectAnchors,
    tick
  };
}

function readBlocklyTaskState(context) {
  const tick = navigationSensorTick(context, "task_state");
  evaluateMissionProgress({ allowComplete: true, announce: false });
  const progress = compositeMissionProgress();
  const nextIndex = Math.max(0, Number(missionAttempt?.nextCheckpointIndex) || 0);
  const nextCheckpointId = nextIndex < (missionAttempt?.checkpointPoints?.length || 0)
    ? activeMission.checkpointLabels?.[nextIndex] || `checkpoint-${nextIndex + 1}`
    : null;
  return {
    schemaVersion: "chenlong.blockly-task-state/v1",
    completed: progress.completed,
    total: progress.total,
    status: missionAttempt?.completed ? "completed" : "running",
    nextCheckpointId,
    targetDelivered: progress.targetDeliveredCount >= progress.targetTotal,
    distractorCleared: progress.distractorClearedCount >= progress.distractorTotal,
    avoidanceStatus: progress.failedObstacleCount > 0
      ? "failed"
      : progress.avoidanceCompleted >= progress.obstacleTotal ? "completed" : "pending",
    goalReached: Boolean(progress.goalReached),
    tick
  };
}

function currentHeldPackageDropPosition() {
  if (!heldPackageMesh) return null;
  const worldPosition = new THREE.Vector3();
  heldPackageMesh.getWorldPosition(worldPosition);
  return [worldPosition.x, worldPosition.z];
}

function readBlocklyReleasePreview(context) {
  const tick = navigationSensorTick(context, "release_preview");
  const role = heldPackageMesh?.userData?.packageRole || null;
  const drop = currentHeldPackageDropPosition();
  if (!role || !drop) {
    return {
      schemaVersion: "chenlong.blockly-release-preview/v1",
      holding: null,
      releaseAccepted: false,
      releaseReason: "not_holding",
      wouldCompleteDelivery: false,
      roadClearanceCm: null,
      requiredRoadClearanceCm: null,
      tick
    };
  }
  let wouldCompleteDelivery = false;
  let roadClearanceCm = null;
  let requiredRoadClearanceCm = null;
  if (role === "target" && Array.isArray(activeMission.landmarks?.storage)) {
    wouldCompleteDelivery = Math.hypot(
      drop[0] - activeMission.landmarks.storage[0],
      drop[1] - activeMission.landmarks.storage[1]
    ) <= missionAttempt.spec.deliveryRadius + PHYSICS_EPSILON;
  } else if (role === "distractor") {
    const clearanceWorld = PRIMARY_GUANGYANG_SCORING.roadEdgeClearance(
      drop[0], drop[1], missionAttempt.spec.packageRadius
    );
    roadClearanceCm = roundNavigationValue(primaryWorldUnitsToCm(clearanceWorld));
    requiredRoadClearanceCm = roundNavigationValue(primaryWorldUnitsToCm(missionAttempt.spec.minimumRoadEdgeClearance));
    wouldCompleteDelivery = clearanceWorld + PHYSICS_EPSILON >= missionAttempt.spec.minimumRoadEdgeClearance;
  }
  return {
    schemaVersion: "chenlong.blockly-release-preview/v1",
    holding: role,
    releaseAccepted: true,
    releaseReason: "ready",
    wouldCompleteDelivery,
    roadClearanceCm,
    requiredRoadClearanceCm,
    tick
  };
}

function readBlocklyOdometry(context) {
  const tick = navigationSensorTick(context, "odometry");
  const dx = robotPose.x - context.startPose.x;
  const dz = robotPose.z - context.startPose.z;
  const forwardX = -Math.sin(context.startPose.heading);
  const forwardZ = -Math.cos(context.startPose.heading);
  const rightX = Math.cos(context.startPose.heading);
  const rightZ = -Math.sin(context.startPose.heading);
  return {
    forwardCm: roundNavigationValue(primaryWorldUnitsToCm(dx * forwardX + dz * forwardZ)),
    rightCm: roundNavigationValue(primaryWorldUnitsToCm(dx * rightX + dz * rightZ)),
    headingDeg: roundNavigationValue(normalizeSignedRadians(robotPose.heading - context.startPose.heading) * 180 / Math.PI),
    distanceCm: roundNavigationValue(primaryWorldUnitsToCm(context.distanceWorld)),
    tick
  };
}

function readBlocklyRoadState(context) {
  const tick = navigationSensorTick(context, "road_state");
  const state = getPrimaryNavigationNetwork().roadState(robotPose, primaryWorldUnitsToCm(frontDistance()));
  return { ...state, tick };
}

function readBlocklyMapGraph(context) {
  navigationSensorTick(context, "map_graph");
  return getPrimaryNavigationNetwork().mapGraph();
}

function readBlocklyNavigationSensor(context, method) {
  if (method === "mission") return readBlocklyMission(context);
  if (method === "task_state") return readBlocklyTaskState(context);
  if (method === "release_preview") return readBlocklyReleasePreview(context);
  if (method === "odometry") return readBlocklyOdometry(context);
  if (method === "road_state") return readBlocklyRoadState(context);
  if (method === "map_graph") return readBlocklyMapGraph(context);
  throw new Error(`未知导航传感接口：${method}`);
}

function normalizeVisionConfidence(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("摄像头最低置信度必须是 0 到 1");
  }
  return confidence;
}

function normalizeVisionTarget(value, { allowAll = false } = {}) {
  const aliases = new Map([
    ["target", "目标物"], ["目标物", "目标物"],
    ["distractor", "混淆物"], ["混淆物", "混淆物"],
    ["obstacle", "障碍物"], ["障碍", "障碍物"], ["障碍物", "障碍物"],
    ["storage", "存放点"], ["storage-zone", "存放点"], ["目标点", "存放点"], ["存放点", "存放点"],
    ["all", "全部"], ["全部", "全部"]
  ]);
  const target = aliases.get(String(value ?? "").trim());
  if (!target || (!allowAll && target === "全部")) throw new Error("摄像头目标必须是目标物、混淆物、障碍物或存放点");
  return target;
}

function visionWorldObjects() {
  const objects = [];
  packageMeshes.forEach((mesh, index) => {
    if (mesh === heldPackageMesh) return;
    const role = mesh.userData.packageRole;
    const categoryLabel = role === "target" ? "目标物" : role === "distractor" ? "混淆物" : null;
    if (!categoryLabel) return;
    objects.push({
      key: mesh.userData.packageId || `${categoryLabel}-${index + 1}`,
      categoryLabel,
      name: `${categoryLabel}${index + 1}`,
      x: mesh.position.x,
      z: mesh.position.z
    });
  });
  obstacleMeshes.forEach((mesh, index) => objects.push({
    key: mesh.userData.obstacleId || `obstacle-${index + 1}`,
    categoryLabel: "障碍物",
    name: `障碍物${index + 1}`,
    x: mesh.position.x,
    z: mesh.position.z
  }));
  if (Array.isArray(activeMission.landmarks?.storage)) {
    objects.push({
      key: "storage",
      categoryLabel: "存放点",
      name: "存放点",
      x: activeMission.landmarks.storage[0],
      z: activeMission.landmarks.storage[1]
    });
  }
  return objects;
}

function visibleVisionObjects(target, minimumConfidence) {
  const wanted = normalizeVisionTarget(target, { allowAll: true });
  const observations = visionWorldObjects().map(object => {
    const dx = object.x - robotPose.x;
    const dz = object.z - robotPose.z;
    const distanceWorld = Math.hypot(dx, dz);
    const distanceCm = primaryWorldUnitsToCm(distanceWorld);
    const targetHeading = Math.atan2(-dx, -dz);
    const angleDeg = normalizeSignedRadians(targetHeading - robotPose.heading) * 180 / Math.PI;
    const confidence = Math.max(0, Math.min(0.99, 0.99 - distanceCm / 1200 - Math.abs(angleDeg) / 420));
    const direction = angleDeg > 10 ? "左" : angleDeg < -10 ? "右" : "中间";
    return {
      object,
      angleDeg,
      direction,
      distanceCm: roundNavigationValue(distanceCm),
      confidence: Math.round(confidence * 100) / 100,
      near: distanceCm <= 22,
      centered: Math.abs(angleDeg) <= 10,
      stable: true
    };
  }).filter(item => (wanted === "全部" || item.object.categoryLabel === wanted)
    && item.distanceCm <= 500
    && Math.abs(item.angleDeg) <= 60
    && item.confidence + 1e-9 >= minimumConfidence)
    .sort((left, right) => left.distanceCm - right.distanceCm || left.object.key.localeCompare(right.object.key, "en"));
  return observations.filter((candidate, index, all) => !all.slice(0, index).some(nearer =>
    Math.abs(nearer.angleDeg - candidate.angleDeg) <= 4
      && nearer.distanceCm + 18 < candidate.distanceCm
  ));
}

function visionObservationSummary(item) {
  const category = item.object.categoryLabel === "目标物" ? "target"
    : item.object.categoryLabel === "混淆物" ? "distractor"
      : item.object.categoryLabel === "障碍物" ? "obstacle" : "storage-zone";
  return {
    category,
    categoryLabel: item.object.categoryLabel,
    name: item.object.name,
    label: item.object.categoryLabel,
    direction: item.direction,
    distanceCm: item.distanceCm,
    confidence: item.confidence,
    // Match the Python public observation contract: “near” means the object is
    // both within pickup range and centred in the camera image.
    near: item.near && item.centered,
    stable: item.stable
  };
}

function queryBlocklyVision(context, method, targetValue, confidenceValue) {
  requireGuangyangSimulation(context, method);
  context.visionQueryCount += 1;
  if (context.visionQueryCount > 1000) throw new Error("摄像头查询超过每次运行 1000 次的上限");
  recordExecutedRobotMethod(context, method);
  const confidence = normalizeVisionConfidence(confidenceValue);
  const allowAll = method === "observe" || method === "detect";
  const target = normalizeVisionTarget(targetValue, { allowAll });
  const matches = visibleVisionObjects(target, confidence);
  const first = matches[0] || null;
  const isStable = item => Boolean(item) && item.stable !== false;
  if (method === "sees") {
    return matches.some(item => isStable(item)
      && item.centered
      // Python treats an obstacle as immediately actionable only when it is
      // inside the 30 cm avoidance clearance, not merely visible far ahead.
      && (target !== "障碍物" || item.distanceCm <= 30));
  }
  if (method === "count") return matches.filter(isStable).length;
  if (method === "near") return matches.some(item => isStable(item) && item.near);
  if (method === "centered") return matches.some(item => isStable(item) && item.centered);
  if (method === "direction") return first?.direction || "未找到";
  if (method === "distance_to") return first?.distanceCm ?? null;
  if (method === "observe") return matches.filter(isStable).map(visionObservationSummary);
  if (method === "detect") return matches.map(item => ({
    "类别": visionObservationSummary(item).category,
    "名称": item.object.name,
    "目标物": item.object.categoryLabel,
    "置信度": item.confidence,
    "距离厘米": item.distanceCm,
    "方位": item.direction,
    "已稳定": item.stable,
    "接近夹取距离": item.near && item.centered
  }));
  throw new Error(`未知摄像头接口：${method}`);
}

async function approachBlocklyVisionTarget(context, targetValue, distanceValue = 20, maxStepsValue = 60) {
  requireGuangyangSimulation(context, "approach");
  recordExecutedRobotMethod(context, "approach");
  actionCount += 1;
  const target = normalizeVisionTarget(targetValue);
  const distanceCm = Number(distanceValue);
  const maxSteps = Number(maxStepsValue);
  if (!Number.isFinite(distanceCm) || distanceCm < 5 || distanceCm > 200) {
    throw new Error("自动靠近停止距离必须是 5 到 200 厘米");
  }
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) {
    throw new Error("自动靠近控制步数必须是 1 到 100 的整数");
  }
  context.visionQueryCount += 1;
  if (context.visionQueryCount > 1000) throw new Error("摄像头查询超过每次运行 1000 次的上限");
  for (let step = 0; step < maxSteps; step += 1) {
    await waitForRunCheckpoint(context);
    const observed = visibleVisionObjects(target, 0.45)[0];
    if (!observed) {
      addLog(`自动靠近已停止：摄像头没有可靠识别到“${target}”。`);
      return false;
    }
    if (observed.distanceCm <= distanceCm && observed.centered) {
      addLog(`自动靠近完成：${target}约 ${observed.distanceCm} cm。`);
      return true;
    }
    if (!observed.centered) {
      const turnDegrees = Math.max(2, Math.min(25, Math.abs(observed.angleDeg)));
      await turnRobotAngle(observed.angleDeg > 0 ? "left" : "right", turnDegrees, context);
      continue;
    }
    const stepCm = Math.max(0.1, Math.min(25, observed.distanceCm - distanceCm));
    const frontClearanceCm = primaryWorldUnitsToCm(frontDistance());
    if (frontClearanceCm < stepCm + 2) {
      addLog(`自动靠近已停止：前方净空只有 ${Math.round(frontClearanceCm)} cm。`);
      return false;
    }
    await moveRobotCentimeters(1, stepCm, context);
  }
  addLog(`自动靠近已停止：在 ${maxSteps} 步内没有到达“${target}”。`);
  return false;
}

function normalizeRoadControlSpeed(value) {
  const speed = Number(value);
  if (!Number.isFinite(speed) || speed < 10 || speed > 100) throw new Error("道路控制速度必须是 10 到 100");
  return speed;
}

function normalizeRoadControlBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label}必须是布尔值`);
  return value;
}

function beginRoadControl(context, method) {
  requireGuangyangSimulation(context, method);
  context.roadControlCount += 1;
  if (context.roadControlCount > 300) throw new Error("道路控制超过每次运行 300 次的上限");
  recordExecutedRobotMethod(context, method);
}

function finishRoadControl(context, accepted, stoppedBy, roadId, distanceWorld, elapsedTicks) {
  const result = Object.freeze({
    accepted: Boolean(accepted),
    stoppedBy: String(stoppedBy),
    roadId: roadId ? String(roadId) : null,
    distanceCm: roundNavigationValue(primaryWorldUnitsToCm(Math.max(0, Number(distanceWorld) || 0))),
    elapsedTicks: Math.max(0, Math.trunc(Number(elapsedTicks) || 0))
  });
  context.lastRoadResult = result;
  addLog(`道路动作：${result.accepted ? "已执行" : "未执行"}，停止原因 ${result.stoppedBy}，行驶 ${result.distanceCm} cm。`);
  updateRobotTelemetry(undefined, true);
  renderPrimaryScore();
  return result;
}

async function driveBlocklyNavigationPath(context, path, speed, maximumCm = Infinity) {
  const maximumWorld = Number.isFinite(maximumCm) ? primaryCmToWorldUnits(Math.max(0, maximumCm)) : Infinity;
  let movedWorld = 0;
  let elapsedTicks = 0;
  let waypointIndex = 0;
  while (waypointIndex < path.length) {
    await waitForRunCheckpoint(context);
    const point = path[waypointIndex];
    const dx = point[0] - robotPose.x;
    const dz = point[1] - robotPose.z;
    const remaining = Math.hypot(dx, dz);
    if (remaining <= 0.015) {
      waypointIndex += 1;
      continue;
    }
    if (movedWorld >= maximumWorld - PHYSICS_EPSILON) {
      return { movedWorld, elapsedTicks, stoppedBy: "max_distance" };
    }
    const targetHeading = Math.atan2(-dx, -dz);
    const headingError = normalizeSignedRadians(targetHeading - robotPose.heading);
    if (Math.abs(headingError) > THREE.MathUtils.degToRad(4)) {
      const turnStep = Math.sign(headingError) * Math.min(Math.abs(headingError), THREE.MathUtils.degToRad(12));
      robotPose.heading += turnStep;
      spinTurnWheels(Math.sign(turnStep), Math.abs(turnStep) * 2.4);
      syncRobot();
      samplePrimaryRoadRule(16);
      elapsedTicks += 1;
      await sleepForRun(Math.max(2, 14 - speed * 0.1), context);
      continue;
    }
    robotPose.heading = targetHeading;
    const stepWorld = Math.min(
      remaining,
      primaryCmToWorldUnits(Math.max(0.8, speed / 22)),
      maximumWorld - movedWorld
    );
    const moveX = dx / remaining;
    const moveZ = dz / remaining;
    const clearanceInfo = robotClearanceInfoAlongRay(robotPose.x, robotPose.z, moveX, moveZ);
    const available = Math.max(0, clearanceInfo.distance - MOVE_COLLISION_SKIN);
    if (available < stepWorld - PHYSICS_EPSILON) {
      if (available > PHYSICS_EPSILON) {
        robotPose.x += moveX * available;
        robotPose.z += moveZ * available;
        movedWorld += available;
        context.distanceWorld += available;
        spinDriveWheels(available);
        addTrajectoryPoint(robotPose.x, robotPose.z);
      }
      primaryBlockedMoveCount += 1;
      if (clearanceInfo.shape?.kind === "obstacle" && clearanceInfo.shape.obstacleId) {
        missionAttempt?.failedObstacleIds?.add(clearanceInfo.shape.obstacleId);
      }
      lastMoveBlocked = true;
      syncRobot(undefined, { forceTelemetry: true });
      evaluateMissionProgress({ allowComplete: false, announce: false });
      return { movedWorld, elapsedTicks: elapsedTicks + 1, stoppedBy: "collision" };
    }
    robotPose.x += moveX * stepWorld;
    robotPose.z += moveZ * stepWorld;
    movedWorld += stepWorld;
    context.distanceWorld += stepWorld;
    spinDriveWheels(stepWorld);
    lastMoveBlocked = false;
    blockedMoveCount = 0;
    syncRobot();
    addTrajectoryPoint(robotPose.x, robotPose.z);
    samplePrimaryRoadRule(16);
    evaluateMissionProgress({ allowComplete: true, announce: false });
    elapsedTicks += 1;
    await sleepForRun(Math.max(2, 14 - speed * 0.1), context);
  }
  return { movedWorld, elapsedTicks, stoppedBy: null };
}

async function followBlocklyRoad(context, maxCmValue = 100, speedValue = 40, obeySpeedLimitValue = false) {
  beginRoadControl(context, "follow_road");
  const maxCm = Number(maxCmValue);
  if (!Number.isFinite(maxCm) || maxCm < 10 || maxCm > 500) throw new Error("沿路行驶距离必须是 10 到 500 厘米");
  const speed = normalizeRoadControlSpeed(speedValue);
  normalizeRoadControlBoolean(obeySpeedLimitValue, "自动遵守限速选项");
  actionCount += 1;
  const network = getPrimaryNavigationNetwork();
  const state = network.roadState(robotPose, primaryWorldUnitsToCm(frontDistance()));
  if (!state.onRoad || !state.roadId) return finishRoadControl(context, false, "off_road", state.roadId, 0, 0);
  const projection = network.project(robotPose.x, robotPose.z, state.roadId);
  const forward = directionVector();
  const record = network.road(state.roadId);
  const naturalDirection = projection.tangentX * forward.x + projection.tangentZ * forward.z >= 0 ? 1 : -1;
  if (record.oneWay && naturalDirection < 0) return finishRoadControl(context, false, "wrong_way", state.roadId, 0, 0);
  const endpointProgress = naturalDirection > 0 ? record.lengthCm : 0;
  const endpointDistanceCm = Math.abs(endpointProgress - projection.progressCm);
  const requestedDistanceCm = Math.min(maxCm, endpointDistanceCm);
  if (requestedDistanceCm <= 0.1) {
    const nodeId = naturalDirection > 0 ? record.toNodeId : record.fromNodeId;
    const node = network.node(nodeId);
    return finishRoadControl(context, true, node.roadIds.length > 1 ? "junction" : "road_end", state.roadId, 0, 0);
  }
  const targetProgress = projection.progressCm + naturalDirection * requestedDistanceCm;
  const path = network.pathAlong(state.roadId, projection.progressCm, targetProgress);
  const driven = await driveBlocklyNavigationPath(context, path, speed, requestedDistanceCm);
  if (driven.stoppedBy) return finishRoadControl(context, true, driven.stoppedBy, state.roadId, driven.movedWorld, driven.elapsedTicks);
  const reachedEndpoint = requestedDistanceCm >= endpointDistanceCm - 0.2;
  let stoppedBy = "max_distance";
  if (reachedEndpoint) {
    const nodeId = naturalDirection > 0 ? record.toNodeId : record.fromNodeId;
    const node = network.node(nodeId);
    stoppedBy = node.roadIds.length > 1 ? "junction" : "road_end";
  }
  return finishRoadControl(context, true, stoppedBy, state.roadId, driven.movedWorld, driven.elapsedTicks);
}

async function takeBlocklyExit(context, roadIdValue, speedValue = 30, obeySpeedLimitValue = false) {
  beginRoadControl(context, "take_exit");
  const roadId = String(roadIdValue ?? "").trim();
  if (!roadId || roadId.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(roadId)) {
    throw new Error("出口道路编号必须是 1 到 128 个可打印字符");
  }
  const speed = normalizeRoadControlSpeed(speedValue);
  normalizeRoadControlBoolean(obeySpeedLimitValue, "出口自动遵守限速选项");
  actionCount += 1;
  const network = getPrimaryNavigationNetwork();
  const state = network.roadState(robotPose, primaryWorldUnitsToCm(frontDistance()));
  if (!state.onRoad || !state.atNode || !state.nodeId) {
    return finishRoadControl(context, false, "not_at_junction", state.roadId, 0, 0);
  }
  if (!state.exits.some(exit => exit.roadId === roadId)) {
    return finishRoadControl(context, false, "invalid_exit", roadId, 0, 0);
  }
  const node = network.node(state.nodeId);
  const endpoint = node.exits.find(candidate => candidate.roadId === roadId);
  if (!endpoint) return finishRoadControl(context, false, "invalid_exit", roadId, 0, 0);
  const road = network.road(roadId);
  const startProgress = endpoint.side === "start" ? 0 : road.lengthCm;
  const enterDistanceCm = Math.min(25, road.lengthCm);
  const targetProgress = endpoint.side === "start" ? enterDistanceCm : road.lengthCm - enterDistanceCm;
  const path = network.pathAlong(roadId, startProgress, targetProgress);
  const driven = await driveBlocklyNavigationPath(context, path, speed, enterDistanceCm);
  if (driven.stoppedBy) return finishRoadControl(context, true, driven.stoppedBy, roadId, driven.movedWorld, driven.elapsedTicks);
  return finishRoadControl(context, true, "entered_road", roadId, driven.movedWorld, driven.elapsedTicks);
}

function makeSimRobotApi(context) {
  return {
    forward: distanceCm => moveRobotCentimeters(1, distanceCm, context),
    backward: distanceCm => moveRobotCentimeters(-1, distanceCm, context),
    forwardSeconds: seconds => moveRobot(1, seconds, context),
    backwardSeconds: seconds => moveRobot(-1, seconds, context),
    turn: (dir, seconds) => turnRobot(dir, seconds, context),
    turnAngle: (dir, degrees) => turnRobotAngle(dir, degrees, context),
    wait: async seconds => {
      blockedMoveCount = 0;
      lastMoveBlocked = false;
      await waitProgramDuration(seconds, context);
    },
    grab: async () => {
      await waitForRunCheckpoint(context);
      actionCount++;
      await animateGripper(true, context);
      if (attachPackageToRobot()) {
        blockedMoveCount = 0;
        lastMoveBlocked = false;
        await liftArmToCarryPosition(context);
        setStatus("已抓取包裹");
        addLog("机械臂抓取成功：纸箱包裹已固定到夹爪上，并抬起机械臂。");
      } else {
        setStatus("未抓到包裹");
        const reach = packageReachInfo();
        if (reach.reason === "holding") {
          addLog("抓取失败：夹爪已经拿着一个包裹，请先松开。");
        } else if (reach.reason === "missing") {
          addLog("抓取失败：场景里没有可抓取的包裹。");
        } else if (reach.reason === "behind") {
          addLog("抓取失败：包裹不在夹爪前方，请让小车正面对准包裹。");
        } else if (reach.reason === "side") {
          addLog(`抓取失败：包裹偏离夹爪中心 ${Math.round(primaryWorldUnitsToCm(reach.side))}cm，需要更对准一些。`);
        } else {
          addLog(`抓取失败：包裹在前方 ${Math.round(primaryWorldUnitsToCm(reach.forward))}cm，需要靠近到夹爪范围内。`);
        }
        await animateGripper(false, context);
      }
      evaluateMissionProgress();
      updateRobotTelemetry(undefined, true);
      await waitRunDuration(500, context);
    },
    release: async () => {
      await waitForRunCheckpoint(context);
      actionCount++;
      if (isHoldingPackage()) await animateArmTo(-0.32, 260, context);
      const releaseResult = releasePackageFromRobot();
      if (releaseResult) {
        blockedMoveCount = 0;
        lastMoveBlocked = false;
        setStatus("已放下包裹");
        addLog(releaseResult.stackLevel > 0
          ? `机械臂已把包裹叠到现有纸箱上，现在是第 ${releaseResult.stackLevel + 1} 层。`
          : "机械臂下降后松开：纸箱包裹已放在小车当前位置附近。");
      } else {
        setStatus("夹爪里没有包裹");
        addLog("松开失败：夹爪里没有包裹。");
      }
      await animateGripper(false, context);
      evaluateMissionProgress();
      updateRobotTelemetry(undefined, true);
      await waitRunDuration(500, context);
    },
    frontBlocked: () => lastMoveBlocked || frontDistance() < FRONT_BLOCKED_DISTANCE,
    distance: () => Math.round(primaryWorldUnitsToCm(frontDistance())),
    onRoad: () => activeMission?.environment !== "guangyang"
      || Boolean(PRIMARY_GUANGYANG_SCORING.roadMatch(robotPose.x, robotPose.z, ROBOT_RADIUS).onRoad),
    holding: () => isHoldingPackage(),
    checkpointCount: () => Math.max(0, Number(missionAttempt?.nextCheckpointIndex) || 0),
    taskComplete: () => Boolean(missionAttempt?.completed),
    mission: () => readBlocklyNavigationSensor(context, "mission"),
    task_state: () => readBlocklyNavigationSensor(context, "task_state"),
    release_preview: () => readBlocklyNavigationSensor(context, "release_preview"),
    odometry: () => readBlocklyNavigationSensor(context, "odometry"),
    road_state: () => readBlocklyNavigationSensor(context, "road_state"),
    map_graph: () => readBlocklyNavigationSensor(context, "map_graph"),
    follow_road: (maxCm, speed, obeySpeedLimit) => followBlocklyRoad(context, maxCm, speed, obeySpeedLimit),
    take_exit: (roadId, speed, obeySpeedLimit) => takeBlocklyExit(context, roadId, speed, obeySpeedLimit),
    lastRoadResult: () => context.lastRoadResult,
    sees: (target, confidence) => queryBlocklyVision(context, "sees", target, confidence),
    count: (target, confidence) => queryBlocklyVision(context, "count", target, confidence),
    detect: (target, confidence) => queryBlocklyVision(context, "detect", target, confidence),
    near: (target, confidence) => queryBlocklyVision(context, "near", target, confidence),
    centered: (target, confidence) => queryBlocklyVision(context, "centered", target, confidence),
    direction: (target, confidence) => queryBlocklyVision(context, "direction", target, confidence),
    distance_to: (target, confidence) => queryBlocklyVision(context, "distance_to", target, confidence),
    observe: (target, confidence) => queryBlocklyVision(context, "observe", target, confidence),
    approach: (target, distanceCm, maxSteps) => approachBlocklyVisionTarget(context, target, distanceCm, maxSteps),
    stopped: () => !runContextIsCurrent(context),
    loopTick: async (name, index, total) => {
      logLoopIteration(context, name, index, total);
      await waitForRunCheckpoint(context);
    },
    loopYield: async () => {
      await waitForRunCheckpoint(context);
      await sleepForRun(16, context);
    },
    emptyLoop: async name => {
      logEmptyLoopOnce(context, name);
      await waitForRunCheckpoint(context);
      await sleepForRun(120, context);
    },
    loopDone: async (name, total) => {
      addLog(total ? `${name}已完成 ${total} 次，所以程序继续往下执行。` : `${name}条件已不成立，循环结束。`);
      await waitForRunCheckpoint(context);
      await sleepForRun(30, context);
    },
    loopLimit: async () => {
      setStatus("循环次数过多，已停止");
      addLog("停止：循环超过 100 次，可能没有退出条件。");
      abortRunContext(context, "loop-limit");
      throw new RunCancelledError("loop-limit");
    }
  };
}

function makeRobotApi(context) {
  const api = context.target === "real" ? makeRealRobotApi(context) : makeSimRobotApi(context);
  const blockedDataKeys = new Set(["__proto__", "prototype", "constructor", "x", "z", "points", "point"]);
  api.dataGet = (value, keyValue) => {
    const key = String(keyValue ?? "").trim();
    if (!key || key.length > 80 || blockedDataKeys.has(key)) {
      throw new Error("字段名称无效，导航数据不开放坐标或内部几何字段");
    }
    if (value === null || value === undefined || typeof value !== "object") return null;
    return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : null;
  };
  api.listItem = (value, indexValue) => {
    if (!Array.isArray(value)) throw new Error("“列表第 N 项”需要连接列表数据");
    const index = Number(indexValue);
    if (!Number.isSafeInteger(index) || index < 1) throw new Error("列表序号必须是从 1 开始的整数");
    return value[index - 1] ?? null;
  };
  api.dataLength = value => {
    if (Array.isArray(value) || typeof value === "string") return value.length;
    if (value && typeof value === "object") return Object.keys(value).length;
    return 0;
  };
  api.requireList = value => {
    if (!Array.isArray(value)) throw new Error("遍历列表需要连接列表数据");
    return value;
  };
  api.jsonText = value => {
    try { return JSON.stringify(value); }
    catch { throw new Error("这个数据不能转换为文字"); }
  };
  api.sensorField = (method, field) => api.dataGet(api[method](), field);
  api.loopInputError = async message => {
    setStatus("循环参数不正确，已停止");
    addLog(`停止：${message}。`);
    abortRunContext(context, "loop-input-error");
    throw new RunCancelledError("loop-input-error");
  };
  api.procedureEnter = async name => {
    await waitForRunCheckpoint(context);
    context.procedureCallCount += 1;
    context.procedureCallDepth += 1;
    const callsExceeded = context.procedureCallCount > MAX_PROGRAM_PROCEDURE_CALLS;
    const depthExceeded = context.procedureCallDepth > MAX_PROGRAM_PROCEDURE_DEPTH;
    if (!callsExceeded && !depthExceeded) return;
    context.procedureCallDepth = Math.max(0, context.procedureCallDepth - 1);
    const reason = callsExceeded
      ? `函数调用超过每次运行 ${MAX_PROGRAM_PROCEDURE_CALLS} 次的上限`
      : `函数递归超过 ${MAX_PROGRAM_PROCEDURE_DEPTH} 层的上限`;
    setStatus("函数调用过多，已停止");
    addLog(`停止：${reason}（${String(name || "未命名函数")}）。`);
    abortRunContext(context, "procedure-limit");
    showRuntimeFeedback("函数调用过多", reason, { tone: "warning" });
    throw new RunCancelledError("procedure-limit");
  };
  api.procedureExit = () => {
    context.procedureCallDepth = Math.max(0, context.procedureCallDepth - 1);
  };
  [...NAVIGATION_SENSOR_METHODS, ...ROAD_CONTROL_METHODS, ...VISION_METHODS].forEach(method => {
    if (typeof api[method] === "function") return;
    api[method] = () => {
      throw new Error(`真实小车暂未接入 ${method}，请切换到 3D 模拟器`);
    };
  });
  if (typeof api.lastRoadResult !== "function") api.lastRoadResult = () => null;
  api.stopped = () => !runContextIsCurrent(context);
  api.highlightBlock = blockId => highlightExecutionBlock(blockId, context);
  api.checkFrontObstacle = () => {
    throwIfRunCancelled(context);
    const blocked = Boolean(api.frontBlocked());
    const distance = context.target === "real" ? null : api.distance();
    const changed = context.lastFrontObstacleResult !== blocked;
    const now = performance.now();
    const shouldLog = changed || !context.lastFrontObstacleLogAt || now - context.lastFrontObstacleLogAt >= 1800;
    context.lastFrontObstacleResult = blocked;
    if (shouldLog) {
      context.lastFrontObstacleLogAt = now;
      addLog(blocked
        ? `判断“前方有障碍物”：成立（前方约 ${distance} cm），执行里面的积木。`
        : context.target === "real"
          ? "判断“前方有障碍物”：真实小车暂无距离数据，按不成立处理。"
          : `判断“前方有障碍物”：不成立（前方约 ${distance} cm），跳过里面的积木。`);
    }
    return blocked;
  };
  api.repeatLimit = async requested => {
    await waitForRunCheckpoint(context);
    const numeric = Number(requested);
    const valid = Number.isFinite(numeric);
    const count = valid ? Math.max(0, Math.floor(numeric)) : null;
    setStatus(valid ? "重复次数过多，已停止" : "重复次数无效，已停止");
    addLog(valid
      ? `停止：“重复 ${count} 次”超过单次程序上限 ${MAX_PROGRAM_LOOP_ITERATIONS} 次，请减小次数。`
      : "停止：重复次数必须是有限数字，不能使用无穷大或无效计算结果。");
    abortRunContext(context, "loop-limit");
    showRuntimeFeedback(
      valid ? "重复次数过多" : "重复次数无效",
      valid ? `设置了 ${count} 次；单次程序上限为 ${MAX_PROGRAM_LOOP_ITERATIONS} 次` : "请检查重复次数中的数学计算",
      { tone: "warning" }
    );
    throw new RunCancelledError("loop-limit");
  };
  api.print = async value => {
    await waitForRunCheckpoint(context);
    programEffectCount += 1;
    const output = formatProgramOutput(value);
    addLog(`输出：${output}`);
    const statusOutput = output.replace(/\s+/g, " ");
    setStatus(`已输出 · ${statusOutput.length > 24 ? `${statusOutput.slice(0, 23)}…` : statusOutput}`);
    showRuntimeFeedback("程序输出", output, { tone: "output" });
  };
  return api;
}

function normalizeRobotBaseUrl() {
  const raw = (robotBaseUrlInput?.value || "192.168.4.1").trim();
  const proto = getRobotProtocol();
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `${proto}://${raw}`;
  return withProtocol.replace(/\/+$/, "");
}

function getValidatedRobotBaseUrl(rawUrl = normalizeRobotBaseUrl()) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("小车地址只支持 HTTP 或 HTTPS");
  }
  if (parsed.username || parsed.password) throw new Error("小车地址不能包含账号或密码");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("小车地址只能填写协议、主机和端口，不能包含路径、参数或片段");
  }
  return parsed.origin;
}

function setRealCameraState(state, message) {
  if (realCameraStage) realCameraStage.dataset.cameraState = state;
  if (cameraStatus) cameraStatus.textContent = message;
  if (retryCameraButton) retryCameraButton.disabled = state === "connecting";
}

async function postRealCameraCommand(baseUrl, command, { keepalive = false } = {}) {
  const controller = keepalive ? null : new AbortController();
  const timeoutId = controller ? setTimeout(() => controller.abort(), 2500) : null;
  try {
    await fetch(`${baseUrl}/api/camera/${command}`, {
      method: "POST",
      mode: "no-cors",
      cache: "no-store",
      keepalive,
      ...(controller ? { signal: controller.signal } : {})
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function stopRealCameraPreview({
  sendClose = true,
  keepalive = false,
  state = "idle",
  message = "摄像头已断开"
} = {}) {
  const baseUrl = activeRealCameraBaseUrl;
  activeRealCameraBaseUrl = null;
  realCameraGeneration += 1;
  if (cameraStream) {
    cameraStream.onload = null;
    cameraStream.onerror = null;
    cameraStream.removeAttribute("src");
  }
  setRealCameraState(state, message);
  if (!sendClose || !baseUrl) return Promise.resolve();
  return postRealCameraCommand(baseUrl, "close", { keepalive }).catch(() => {});
}

function startRealCameraPreview() {
  if (!cameraStream || targetSelect?.value !== "real") return;
  if (document.hidden) {
    setRealCameraState("idle", "页面在后台，摄像头预览已暂停");
    return;
  }

  let baseUrl;
  try {
    baseUrl = getValidatedRobotBaseUrl();
  } catch (error) {
    void stopRealCameraPreview({ state: "error", message: `小车地址无效：${error.message}` });
    return;
  }

  if (activeRealCameraBaseUrl && activeRealCameraBaseUrl !== baseUrl) {
    void stopRealCameraPreview({ message: "正在切换摄像头地址…" });
  }

  const generation = ++realCameraGeneration;
  activeRealCameraBaseUrl = baseUrl;
  setRealCameraState("connecting", `正在连接 ${baseUrl} 的摄像头…`);

  const streamUrl = new URL(`${baseUrl}/api/camera/stream`);
  streamUrl.searchParams.set("fps", "12");
  streamUrl.searchParams.set("t", String(Date.now()));

  cameraStream.onload = () => {
    if (generation !== realCameraGeneration || activeRealCameraBaseUrl !== baseUrl) return;
    setRealCameraState("live", "摄像头已连接（仅实时预览）");
  };
  cameraStream.onerror = () => {
    if (generation !== realCameraGeneration || activeRealCameraBaseUrl !== baseUrl) return;
    activeRealCameraBaseUrl = null;
    realCameraGeneration += 1;
    cameraStream.onload = null;
    cameraStream.onerror = null;
    cameraStream.removeAttribute("src");
    setRealCameraState("error", "摄像头连接失败，请检查小车 Wi-Fi、地址后重试");
    void postRealCameraCommand(baseUrl, "close").catch(() => {});
  };

  void postRealCameraCommand(baseUrl, "open")
    .catch(() => {
      if (generation === realCameraGeneration && activeRealCameraBaseUrl === baseUrl) {
        setRealCameraState("connecting", "打开请求未响应，正在尝试读取摄像头画面…");
      }
    })
    .finally(() => {
      if (generation === realCameraGeneration && activeRealCameraBaseUrl === baseUrl) {
        setRealCameraState("streaming", "摄像头流已打开，正在等待画面…");
        cameraStream.src = streamUrl.toString();
      }
    });
}

async function restartRealCameraPreview() {
  await stopRealCameraPreview({ message: "正在重新连接摄像头…" });
  if (targetSelect?.value === "real" && !document.hidden) startRealCameraPreview();
}

function robotBaseUrlToDisplayValue(url) {
  return String(url || "192.168.4.1").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

async function sendRealRobotAction(action, timeMs = null, context = null) {
  try {
    const baseUrl = context?.robotBaseUrl || getValidatedRobotBaseUrl();
    const url = new URL(`${baseUrl}/api/control`);
    url.searchParams.set("action", action);
    url.searchParams.set("speed", "50");
    url.searchParams.set("_", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    if (timeMs != null) url.searchParams.set("time", String(Math.max(0, Math.round(timeMs))));
    await fetch(url.toString(), { mode: "no-cors", cache: "no-store", signal: context?.signal });
    if (context) throwIfRunCancelled(context);
    return true;
  } catch (error) {
    if (error?.name === "AbortError" || context?.signal.aborted) throw new RunCancelledError(context?.reason || "stopped");
    setRealStopHazard(true);
    setStatus("真实小车连接失败");
    addLog(`真实小车指令发送失败：${error.message}。如果当前页面是 https，请用本地 http 页面控制小车。`);
    if (context) {
      abortRunContext(context, "connection-error");
      throw new RunCancelledError("connection-error");
    }
    updateRunControls();
    return false;
  }
}

async function sendRealRobotStop(baseUrl = null) {
  if (realStopPromise) return realStopPromise;
  realStopPending = true;
  setRealStopHazard(true);
  updateRunControls();
  const requestedBaseUrl = baseUrl;
  realStopPromise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const resolvedBaseUrl = requestedBaseUrl || getValidatedRobotBaseUrl();
      const url = new URL(`${resolvedBaseUrl}/api/control`);
      url.searchParams.set("action", "stop");
      url.searchParams.set("speed", "50");
      url.searchParams.set("time", "0");
      url.searchParams.set("_", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      await fetch(url.toString(), { mode: "no-cors", cache: "no-store", keepalive: true, signal: controller.signal });
      addLog("真实小车：停止指令已发送，设备未回传确认状态。");
      return true;
    } catch (error) {
      addLog(error?.name === "AbortError" ? "真实小车：停止指令发送超时。" : `真实小车：停止指令发送失败：${error.message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  })();
  try {
    return await realStopPromise;
  } finally {
    realStopPending = false;
    realStopPromise = null;
    updateRunControls();
  }
}

async function waitRealActionDuration(ms, context) {
  const started = performance.now();
  while (performance.now() - started < ms) {
    throwIfRunCancelled(context);
    await sleepForRun(40, context);
  }
  if (context.pauseRequested) {
    addLog("真实小车：当前动作已下发，暂停会从下一条积木前生效。");
    await waitForRunCheckpoint(context);
  }
}

async function realMove(action, seconds, label, context) {
  await waitForRunCheckpoint(context);
  actionCount++;
  const ms = normalizeDurationSeconds(seconds, { minimum: 0.1, maximum: 30, label }) * 1000;
  addLog(`真实小车：${label} ${Math.round(ms / 100) / 10} 秒。`);
  const ok = await sendRealRobotAction(action, ms, context);
  if (ok) await waitRealActionDuration(ms, context);
}

async function realMoveCentimeters(action, distanceCm, label, context) {
  const centimeters = normalizeMoveDistanceCm(distanceCm);
  const seconds = centimeters / PRIMARY_DRIVE_CM_PER_SECOND;
  await waitForRunCheckpoint(context);
  actionCount++;
  const ms = seconds * 1000;
  addLog(`真实小车：${label}约 ${Math.round(centimeters * 10) / 10} 厘米（按标定速度换算）。`);
  const ok = await sendRealRobotAction(action, ms, context);
  if (ok) await waitRealActionDuration(ms, context);
}

async function realWait(seconds, context) {
  await waitProgramDuration(seconds, context, "真实小车：");
}

function makeRealRobotApi(context) {
  return {
    forward: distanceCm => realMoveCentimeters("up", distanceCm, "前进", context),
    backward: distanceCm => realMoveCentimeters("down", distanceCm, "后退", context),
    forwardSeconds: seconds => realMove("up", seconds, "前进", context),
    backwardSeconds: seconds => realMove("down", seconds, "后退", context),
    turn: (dir, seconds) => realMove(dir === "left" ? "left" : "right", seconds, dir === "left" ? "左转" : "右转", context),
    turnAngle: (dir, degrees) => {
      const safeDegrees = normalizeTurnDegrees(degrees);
      const secondsPer90 = REAL_TURN_SECONDS_PER_90[dir === "left" ? "left" : "right"];
      const seconds = Math.max(0.2, Math.min(2.2, safeDegrees / 90 * secondsPer90));
      return realMove(dir === "left" ? "left" : "right", seconds, `${dir === "left" ? "左转" : "右转"}约 ${safeDegrees}°`, context);
    },
    wait: seconds => realWait(seconds, context),
    grab: async () => {
      await waitForRunCheckpoint(context);
      actionCount++;
      addLog("真实小车：机械臂抓取，等待 6 秒完成动作。");
      await sendRealRobotAction("grab", null, context);
      await waitRealActionDuration(REAL_GRAB_DURATION_MS, context);
    },
    release: async () => {
      await waitForRunCheckpoint(context);
      actionCount++;
      addLog("真实小车：机械臂松开，等待 2 秒完成动作。");
      await sendRealRobotAction("release", null, context);
      await waitRealActionDuration(REAL_RELEASE_DURATION_MS, context);
    },
    frontBlocked: () => {
      throw new Error("真实小车没有前方传感器，不能使用避障判断；只支持基础动作积木");
    },
    distance: () => {
      throw new Error("真实小车暂未接入前方距离回传，不能使用“前方距离 cm”积木；请切换到 3D 模拟器或接入传感器接口");
    },
    onRoad: () => {
      throw new Error("真实小车暂未接入道路位置回传，不能使用“小车在道路上”积木");
    },
    holding: () => {
      throw new Error("真实小车暂未接入夹爪状态回传，不能使用“夹爪拿着包裹”积木");
    },
    checkpointCount: () => {
      throw new Error("真实小车暂未接入定位回传，不能读取已通过途径点数");
    },
    taskComplete: () => {
      throw new Error("真实小车暂未接入任务位置回传，不能自动判断任务是否完成");
    },
    stopped: () => !runContextIsCurrent(context),
    loopTick: async (name, index, total) => {
      logLoopIteration(context, name, index, total);
      await waitForRunCheckpoint(context);
    },
    loopYield: async () => {
      await waitForRunCheckpoint(context);
      await sleepForRun(16, context);
    },
    emptyLoop: async name => {
      logEmptyLoopOnce(context, name);
      await waitForRunCheckpoint(context);
      await sleepForRun(120, context);
    },
    loopDone: async (name, total) => {
      addLog(total ? `${name}已完成 ${total} 次，所以程序继续往下执行。` : `${name}条件已不成立，循环结束。`);
      await waitForRunCheckpoint(context);
      await sleepForRun(30, context);
    },
    loopLimit: async () => {
      setStatus("循环次数过多，已停止");
      addLog("停止：循环超过 100 次，可能没有退出条件。");
      abortRunContext(context, "loop-limit");
      throw new RunCancelledError("loop-limit");
    }
  };
}

async function cancelActiveRun(reason = "stopped", { sendHardwareStop = true } = {}) {
  const context = activeRun;
  const result = {
    hadRun: Boolean(context),
    hardwareStopRequested: false,
    hardwareStopSent: null
  };
  if (!context) {
    if (sendHardwareStop && targetSelect?.value === "real") {
      result.hardwareStopRequested = true;
      runControlBusy = true;
      updateRunControls();
      try {
        result.hardwareStopSent = await sendRealRobotStop();
        setRealStopHazard(!result.hardwareStopSent);
      } finally {
        runControlBusy = false;
        updateRunControls();
      }
    }
    return result;
  }
  runControlBusy = true;
  updateRunControls();
  try {
    abortRunContext(context, reason);
    await context.done;
    if (sendHardwareStop && context.target === "real") {
      result.hardwareStopRequested = true;
      result.hardwareStopSent = await sendRealRobotStop(context.robotBaseUrl);
      setRealStopHazard(!result.hardwareStopSent);
    }
    if (activeRun === context) activeRun = null;
    return result;
  } finally {
    runControlBusy = false;
    updateRunControls();
  }
}

function pauseActiveRun() {
  if (!activeRun || !requestRunPause(activeRun)) return false;
  addLog(activeRun.target === "real"
    ? "已请求暂停：当前已下发动作完成后，不再执行下一条积木。"
    : "已请求暂停：小车会在当前动画安全点停下，继续时从这里执行。");
  return true;
}

async function runProgram(restartReason = null) {
  if (runControlBusy) return;
  if (activeRun) {
    if (activeRun.phase === "paused") {
      if (activeRun.dirty) {
        const cancellation = await cancelActiveRun("code-changed", { sendHardwareStop: activeRun.target === "real" });
        if (cancellation.hardwareStopRequested && !cancellation.hardwareStopSent) {
          setStatus("旧程序已取消；小车停止失败");
          addLog("未启动新程序：真实小车停止指令发送失败，请现场确认后重试。");
          return;
        }
        setStatus("按新代码运行");
        return runProgram("code-changed");
      }
      if (resumeRun(activeRun)) addLog("继续运行：从暂停的积木动作接着执行。");
    }
    return;
  }
  const structure = inspectProgramStructure();
  if (!structure.ok) {
    clearExecutionHighlight();
    clearActionLog();
    clearRuntimeFeedback();
    setStatus("请先整理主程序");
    addLog(`无法运行：${structure.message}`);
    showRuntimeFeedback("积木连接有问题", structure.message, { tone: "warning" });
    return;
  }
  const plainCode = generateBlocklyCode(false);
  if (!plainCode.trim()) {
    clearExecutionHighlight();
    clearRuntimeFeedback();
    setStatus("请先搭积木");
    return;
  }
  const runtimeCode = generateBlocklyCode(true);
  const target = targetSelect?.value === "real" ? "real" : "sim";
  if (target === "real") {
    const unsupported = realRobotUnsupportedMethodsInProgram(runtimeCode);
    if (unsupported.length) {
      const methodList = unsupported.map(method => `robot.${method}()`).join("、");
      setStatus("实车模式不支持感知积木");
      addLog(`无法运行：真实小车摄像头只供人工预览，不向积木程序提供感知、定位或任务状态回传，请移除 ${methodList}。`);
      showRuntimeFeedback("实车仅支持基础动作", `请移除：${methodList}`, { tone: "warning" });
      return;
    }
  }
  if (target === "sim") {
    try {
      await refreshPublishedPrimaryMaps();
      if (!Number.isInteger(activeMission.mapRevision) || typeof activeMission.mapDigest !== "string") {
        throw new Error("当前任务还没有可用的地图版本");
      }
    } catch (error) {
      setStatus("地图同步失败");
      addLog(`无法开始运行：${error.message}。`);
      return;
    }
  }
  if (target === "real" && realStopHazard) {
    setStatus("请先重新发送停止指令");
    addLog("真实小车上次停止未成功发送。请检查 IP 和网络，点击“停止”成功发送后再运行。");
    return;
  }
  let robotBaseUrl = null;
  if (target === "real") {
    try {
      robotBaseUrl = getValidatedRobotBaseUrl();
    } catch (error) {
      setStatus("真实小车 IP 无效");
      addLog(`无法运行：${error.message}。请检查真实小车 IP 地址。`);
      return;
    }
  }
  if (target === "sim") {
    missionAttempt = null;
    restoreMissionBaseline();
    resetRobot();
    rebuildSceneObjects();
    initializeMissionAttempt();
    samplePrimaryRoadRule(0, { announce: false });
  }
  const context = createRunContext(target, robotBaseUrl);
  primaryRunStartedAt = target === "sim" ? Date.now() : 0;
  primaryRunElapsedMs = 0;
  activeRun = context;
  clearExecutionHighlight();
  updateRunControls();
  actionCount = 0;
  programEffectCount = 0;
  blockedMoveCount = 0;
  primaryBlockedMoveCount = 0;
  lastMoveBlocked = false;
  clearActionLog();
  clearRuntimeFeedback();
  addLog(target === "sim"
    ? restartReason === "code-changed"
      ? "积木已修改：任务、小车和物品已恢复到起点，正按新代码重新运行。"
      : "任务、小车和物品已恢复到起点，开始本次运行。"
    : restartReason === "code-changed"
      ? "暂停后修改了积木：旧程序已完整取消，正按新代码从当前位置运行。"
      : "从真实小车当前位置开始运行程序。");
  setStatus("正在运行");
  if (target === "sim") renderPrimaryScore();
  updateCode();

  try {
    const program = new Function("robot", `"use strict"; return (async () => {\n${runtimeCode}\n})();`);
    await program(makeRobotApi(context));
    throwIfRunCancelled(context);
    if (context.target === "real") {
      setStatus("真实小车程序已执行");
      addLog("真实小车暂无位置回传，任务是否完成需要现场确认。页面不会自动误判成功或失败。");
    } else {
      evaluateMissionProgress();
      if (!missionAttempt || missionAttempt.spec.type === "practice") {
        setStatus("运行完成");
        addLog(actionCount > 0 || programEffectCount > 0
          ? "程序执行完成。"
          : "程序执行完成，但没有执行移动、转向、机械臂、等待或输出：可能是条件判断没有成立。");
      } else if (!missionAttempt.completed) {
        setStatus("程序结束，任务未完成");
        addLog(`程序已经结束，任务还未完成：${missionIncompleteHint()}。`);
      }
    }
  } catch (error) {
    if (!(error instanceof RunCancelledError) && runContextIsCurrent(context)) {
      setStatus("代码出错");
      addLog(`代码出错：${error.message}`);
      showRuntimeFeedback("程序出错", error.message, { tone: "warning" });
      codeOutput.textContent = `${plainCode}\n\n// 错误：${error.message}`;
    }
  } finally {
    if (context.target === "sim" && primaryRunStartedAt > 0) {
      primaryRunElapsedMs = Math.max(0, Date.now() - primaryRunStartedAt);
    }
    if (context.target === "sim" && primaryUser && actionCount > 0
      && !["reset", "stopped", "mission-change", "code-changed"].includes(context.reason)) {
      await archivePrimaryRun(plainCode, primaryRunStartedAt, context).catch(error => {
        addLog(`本次成绩暂未保存：${error.message}`);
      });
    }
    const stopHandledByCancellation = ["stopped", "reset", "mission-change", "code-changed", "page-hidden"].includes(context.reason);
    if (context.target === "real" && !stopHandledByCancellation) {
      const stopSent = await sendRealRobotStop(context.robotBaseUrl);
      setRealStopHazard(!stopSent);
      addLog(stopSent
        ? "真实小车：程序退出时已发送停止指令，设备未回传确认，请现场确认。"
        : "真实小车：程序退出时停止指令发送失败，请立即现场确认小车状态。");
    }
    const isCurrent = activeRun === context;
    context.resolveDone();
    if (isCurrent) {
      activeRun = null;
      clearExecutionHighlight();
      updateRunControls();
      if (context.target === "sim") renderPrimaryScore();
    }
  }
}

function setStatus(text) {
  statusText.textContent = text;
}

function setRunTarget(target) {
  const real = target === "real";
  const wasReal = appShell.classList.contains("is-real-target");
  if (wasReal && !real) {
    void sendRealRobotStop().then(sent => setRealStopHazard(!sent));
    void stopRealCameraPreview();
  }
  appShell.classList.toggle("is-real-target", real);
  localStorage.setItem("chenlongRunTarget", real ? "real" : "sim");
  if (scenePanelTitleText) {
    scenePanelTitleText.innerHTML = real
      ? '<i data-lucide="radio-tower"></i>真实小车基础控制'
      : '<i data-lucide="box"></i>3D 模拟器';
    if (window.lucide) window.lucide.createIcons();
  }
  if (real) {
    startRealCameraPreview();
    setStatus(realStopHazard ? "请先重新发送停止指令" : "真实小车模式");
    addLog("已切换到真实小车：支持摄像头实时预览，以及前进、后退、转向、等待、抓取和松开；画面不提供给积木程序识别，实车也没有定位、传感或任务状态回传。本模式不判定任务、不保存成绩、不参与评分。");
    if (realStopHazard) addLog("安全锁已启用：上次停止没有成功发送，请检查连接并点击“停止”后再运行。");
    if (location.protocol === "https:") {
      addLog("提示：公网 https 页面可能无法直接请求小车 http 接口，实测控制建议用本地 http 页面打开。");
    }
  } else {
    setStatus("3D 模拟模式");
    addLog("已切换到 3D 模拟器。");
  }
  updateRobotTelemetry(undefined, true);
  renderMissionProgress();
  updateRunControls();
  resizeRenderer();
}

function applyRobotIp() {
  try {
    const baseUrl = getValidatedRobotBaseUrl();
    setRobotProtocol(new URL(baseUrl).protocol === "https:" ? "https" : "http");
    const displayIp = robotBaseUrlToDisplayValue(baseUrl);
    robotBaseUrlInput.value = displayIp;
    localStorage.setItem("chenlongRobotBaseUrl", displayIp);
    setStatus(realStopHazard ? "IP 已确认，请重新发送停止" : "IP 已确认");
    addLog(`真实小车 IP 已设置为 ${displayIp}。${realStopHazard ? " 请点击停止，解除安全锁后再运行。" : ""}`);
    if (targetSelect?.value === "real") void restartRealCameraPreview();
  } catch (error) {
    setStatus("真实小车 IP 无效");
    addLog(`IP 设置失败：${error.message}。`);
  }
  updateRunControls();
}

function placeObjectFromClick(event) {
  if (!placeMode || activeRun || runControlBusy) return;
  if (isOrbitDragging) return;
  const rect = simulator.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(gridPlane)[0];
  if (!hit) return;
  const x = Math.round(hit.point.x);
  const z = Math.round(hit.point.z);
  if (Math.abs(x) > currentMapHalf() - 1 || Math.abs(z) > currentMapHalf() - 1) return;

  if (placeMode === "delete") {
    deleteMapObjectAt(x, z);
    return;
  }
  if (activeMission.theme === "maze" && placeMode === "block") {
    addMazeWallAt(x, z);
    return;
  }
  const radius = placeMode === "block" ? BLOCK_RADIUS : placeMode === "package" ? PACKAGE_RADIUS : 0.42;
  if (missionWallColliders.some(wall => circleHitsRect(x, z, radius, wall))) {
    setStatus("墙体或场景模型占用");
    addLog("这里有墙体、货架或固定场景模型，请换一个格子放置。");
    return;
  }
  if (pointOverlapsCompetitionModel(x, z, radius)) {
    setStatus("固定场地模型占用");
    addLog("这里是比赛场地的固定建筑或墙体，请换一个格子放置。");
    return;
  }
  let placedPackageLevel = null;
  if (placeMode === "block") {
    if (activeMission.obstacles.length >= MAX_SAVED_OBSTACLES) {
      setStatus("障碍数量已达上限");
      addLog(`一张地图最多放置 ${MAX_SAVED_OBSTACLES} 个障碍。`);
      return;
    }
    activeMission.obstacles.push([x, z]);
  }
  if (placeMode === "package") {
    const packages = ensureMissionPackages();
    if (packages.length >= MAX_SAVED_PACKAGES) {
      setStatus("包裹数量已达上限");
      addLog(`一张地图最多放置 ${MAX_SAVED_PACKAGES} 个包裹。`);
      return;
    }
    placedPackageLevel = packages.filter(record => packageStackKey(record.x, record.z) === packageStackKey(x, z)).length;
    packages.push({ id: createPackageId(), x, z });
  }
  if (placeMode === "goal") activeMission.goal = [x, z];
  commitMissionEdit();
  if (placeMode === "package" && placedPackageLevel > 0) {
    addLog(`已在 (${x}, ${z}) 继续堆叠包裹，现在是第 ${placedPackageLevel + 1} 层。`);
  } else {
    addLog(`已在 (${x}, ${z}) 放置${placeMode === "block" ? "障碍" : placeMode === "package" ? "包裹" : "终点"}。`);
  }
}

function addMazeWallAt(x, z) {
  if ((activeMission.walls || []).length >= MAX_SAVED_WALLS) {
    setStatus("墙体数量已达上限");
    addLog(`一张地图最多放置 ${MAX_SAVED_WALLS} 段墙体。`);
    return;
  }
  const size = MAZE_CELL_SIZE * 0.92;
  const wall = [x, z, size, size];
  const protectedRoute = createMazeSolutionPath(MAZE_LAYOUT);
  const blocksRoute = protectedRoute.some(([routeX, routeZ]) =>
    circleHitsRect(routeX, routeZ, ROBOT_RADIUS + 0.08, { x, z, w: size, h: size })
  );
  if (blocksRoute) {
    setStatus("这里是迷宫通行路线");
    addLog("不能在迷宫必经通道上放置木板墙，否则导航信标或出口会无法到达。");
    return;
  }
  activeMission.walls = Array.isArray(activeMission.walls) ? activeMission.walls : [];
  activeMission.walls.push(wall);
  commitMissionEdit();
  addLog(`已在 (${x}, ${z}) 放置木板迷宫墙。`);
}

function deleteMapObjectAt(x, z) {
  const before = activeMission.obstacles.length;
  activeMission.obstacles = activeMission.obstacles.filter(([ox, oz]) => Math.hypot(ox - x, oz - z) > 0.55);
  const beforeWalls = Array.isArray(activeMission.walls) ? activeMission.walls.length : 0;
  if (Array.isArray(activeMission.walls)) {
    activeMission.walls = activeMission.walls.filter(([wx, wz, ww, wh]) => !circleHitsRect(x, z, 0.45, { x: wx, z: wz, w: ww, h: wh }));
  }
  const packages = ensureMissionPackages();
  let deletedPackage = null;
  for (let index = packages.length - 1; index >= 0; index--) {
    if (Math.hypot(packages[index].x - x, packages[index].z - z) <= 0.55) {
      deletedPackage = packages.splice(index, 1)[0];
      break;
    }
  }
  if (activeMission.goal && Math.hypot(activeMission.goal[0] - x, activeMission.goal[1] - z) <= 0.55) {
    activeMission.goal = null;
  }
  commitMissionEdit();
  if (deletedPackage) {
    const remaining = packages.filter(record => packageStackKey(record.x, record.z) === packageStackKey(deletedPackage.x, deletedPackage.z)).length;
    addLog(remaining > 0
      ? `已移除 (${x}, ${z}) 包裹堆最上层的一件，还剩 ${remaining} 件。`
      : `已删除 (${x}, ${z}) 附近的包裹。`);
  } else if (activeMission.obstacles.length !== before) {
    addLog(`已删除 (${x}, ${z}) 附近的障碍。`);
  } else if ((activeMission.walls || []).length !== beforeWalls) {
    addLog(`已删除 (${x}, ${z}) 附近的迷宫墙。`);
  } else {
    addLog(`已尝试删除 (${x}, ${z}) 附近物体。`);
  }
}

function createMapPayload(name) {
  const sourceMission = structuredClone(missionBaseline || activeMission);
  const packages = normalizePackageRecords(sourceMission);
  return {
    id: globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `map-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    obstacles: (sourceMission.obstacles || []).map(([x, z]) => [x, z]),
    walls: Array.isArray(sourceMission.walls) ? sourceMission.walls.map(([x, z, w, h]) => [x, z, w, h]) : [],
    packages: packages.map(record => ({ id: record.id, x: record.x, z: record.z, ...(record.role ? { role: record.role } : {}) })),
    package: packages.length ? [packages[0].x, packages[0].z] : null,
    goal: sourceMission.goal ? [...sourceMission.goal] : null,
    theme: sourceMission.theme || null,
    start: Array.isArray(sourceMission.start) ? [...sourceMission.start] : null,
    guidePath: Array.isArray(sourceMission.guidePath) ? sourceMission.guidePath.map(([x, z]) => [x, z]) : [],
    environment: sourceMission.environment || (sourceMission.theme === "maze" ? "maze" : "sandbox"),
    mapSize: finiteNumber(sourceMission.mapSize, sourceMission.theme === "maze" ? MAZE_MAP_SIZE : MAP_SIZE),
    wallHeight: Number(sourceMission.wallHeight) || null,
    completion: sourceMission.completion ? structuredClone(sourceMission.completion) : { type: "auto" },
    title: sourceMission.title,
    text: sourceMission.text,
    mapStyle: currentMapStyle,
    updatedAt: Date.now()
  };
}

function getSavedMaps() {
  try {
    const maps = JSON.parse(localStorage.getItem("chenlongBlocklyMaps") || "[]");
    return Array.isArray(maps) ? maps.filter(map => map && map.id && map.name) : [];
  } catch {
    return [];
  }
}

function setSavedMaps(maps) {
  localStorage.setItem("chenlongBlocklyMaps", JSON.stringify(maps));
}

function migrateLegacyMapSave() {
  const legacy = localStorage.getItem("chenlongBlocklyMap");
  if (!legacy || getSavedMaps().length) return;
  try {
    const payload = JSON.parse(legacy);
    const migratedPackages = normalizePackageRecords(payload);
    const map = {
      ...createMapPayload("旧版保存地图"),
      obstacles: Array.isArray(payload.obstacles) ? payload.obstacles : [],
      walls: Array.isArray(payload.walls) ? payload.walls : [],
      packages: migratedPackages,
      package: migratedPackages.length ? [migratedPackages[0].x, migratedPackages[0].z] : null,
      goal: payload.goal || null,
      theme: payload.theme || null,
      start: payload.start || null,
      guidePath: payload.guidePath || [],
      environment: payload.environment || (payload.theme === "maze" ? "maze" : "sandbox"),
      mapSize: Number(payload.mapSize) || undefined,
      wallHeight: Number(payload.wallHeight) || undefined,
      completion: payload.completion || { type: "auto" },
      title: payload.title || "任务：自定义地图",
      text: payload.text || "从保存的地图继续练习。",
      mapStyle: payload.mapStyle || currentMapStyle
    };
    setSavedMaps([map]);
  } catch {
    localStorage.removeItem("chenlongBlocklyMap");
  }
}

function renderSavedMapSelect(selectedId = selectedSavedMapId) {
  if (!savedMapDropdown || !savedMapButtonText) return;
  const maps = getSavedMaps().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  selectedSavedMapId = maps.some(map => map.id === selectedId) ? selectedId : "";
  const selectedMap = maps.find(map => map.id === selectedSavedMapId);
  savedMapButtonText.textContent = selectedMap ? selectedMap.name : maps.length ? "选择地图" : "暂无存档";
  savedMapDropdown.innerHTML = "";
  if (!maps.length) {
    const empty = document.createElement("div");
    empty.className = "saved-map-empty";
    empty.textContent = "还没有保存地图";
    savedMapDropdown.append(empty);
    return;
  }
  maps.forEach(map => {
    const item = document.createElement("div");
    item.className = "saved-map-option";
    item.classList.toggle("is-active", map.id === selectedSavedMapId);
    item.setAttribute("role", "menuitem");

    const nameButton = document.createElement("button");
    nameButton.type = "button";
    nameButton.className = "saved-map-name";
    const date = map.updatedAt ? new Date(map.updatedAt).toLocaleDateString("zh-CN") : "";
    const nameText = document.createElement("span");
    nameText.textContent = map.name;
    nameButton.append(nameText);
    if (date) {
      const dateText = document.createElement("small");
      dateText.textContent = date;
      nameButton.append(dateText);
    }
    nameButton.title = "载入这张地图";
    nameButton.addEventListener("click", async () => {
      selectedSavedMapId = map.id;
      closeSavedMapMenu();
      await loadSelectedMap();
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "saved-map-delete";
    deleteButton.title = `删除地图“${map.name}”`;
    deleteButton.setAttribute("aria-label", `删除地图 ${map.name}`);
    deleteButton.innerHTML = '<i data-lucide="x"></i>';
    deleteButton.addEventListener("click", event => {
      event.stopPropagation();
      deleteSavedMap(map.id);
    });

    item.append(nameButton, deleteButton);
    savedMapDropdown.append(item);
  });
  if (window.lucide) window.lucide.createIcons();
}

async function applyMapPayload(payload = {}) {
  let cancellation = null;
  if (activeRun) cancellation = await cancelActiveRun("mission-change", { sendHardwareStop: true });
  const normalized = normalizeSavedMissionPayload(payload);
  missionAttempt = null;
  activeMission.obstacles = normalized.obstacles;
  activeMission.walls = normalized.walls;
  activeMission.packages = normalized.packages;
  activeMission.package = null;
  activeMission.goal = normalized.goal;
  activeMission.theme = payload.theme || null;
  activeMission.start = normalized.start;
  activeMission.guidePath = normalized.guidePath;
  activeMission.environment = payload.environment || (activeMission.theme === "maze" ? "maze" : "sandbox");
  activeMission.completion = normalized.completion;
  activeMission.mapSize = normalized.mapSize;
  activeMission.wallHeight = normalized.wallHeight;
  activeMission.title = payload.title || "任务：自定义地图";
  activeMission.text = payload.text || "使用地图编辑器保存的练习场景。";
  renderMissionInfo();
  const savedMapStyle = payload.mapStyle === "competition" ? "competition" : "basic";
  if (mapStyleSelect) {
    mapStyleSelect.value = savedMapStyle;
    setMapStyle(savedMapStyle, false);
  } else {
    setMapStyle(currentMapStyle, false);
  }
  captureMissionBaseline();
  resetRobot();
  rebuildSceneObjects();
  initializeMissionAttempt();
  return cancellation;
}

function saveEditedMap() {
  const maps = getSavedMaps();
  const defaultName = `我的地图 ${maps.length + 1}`;
  const name = window.prompt("给这张地图起个名字", defaultName);
  if (!name || !name.trim()) {
    setStatus("已取消保存");
    return;
  }
  const trimmedName = makeUniqueMapName(name.trim().slice(0, 24), maps);
  const payload = createMapPayload(trimmedName);
  maps.push(payload);
  setSavedMaps(maps);
  renderSavedMapSelect(payload.id);
  setStatus("地图已保存");
  addLog(`地图“${payload.name}”已新增保存。`);
}

function makeUniqueMapName(name, maps) {
  const base = name || `我的地图 ${maps.length + 1}`;
  if (!maps.some(map => map.name === base)) return base;
  let index = 2;
  let nextName = `${base} (${index})`;
  while (maps.some(map => map.name === nextName)) {
    index++;
    nextName = `${base} (${index})`;
  }
  return nextName;
}

async function loadSelectedMap() {
  const maps = getSavedMaps();
  const map = maps.find(item => item.id === selectedSavedMapId);
  if (!map) {
    renderSavedMapSelect();
    return;
  }
  const cancellation = await applyMapPayload(map);
  renderSavedMapSelect(map.id);
  setStatus(cancellation?.hardwareStopRequested && !cancellation.hardwareStopSent
    ? "地图已载入；小车停止失败"
    : missionAttempt?.completed ? "任务完成" : "地图已载入");
  addLog(`已载入地图“${map.name}”。`);
  if (cancellation?.hardwareStopRequested) {
    addLog(cancellation.hardwareStopSent
      ? "真实小车：载入地图前已发送停止指令，设备未回传确认状态。"
      : "警告：地图已载入，但真实小车停止指令发送失败，请现场确认。");
  }
}

function deleteSavedMap(mapId = selectedSavedMapId) {
  const maps = getSavedMaps();
  const map = maps.find(item => item.id === mapId);
  if (!map) {
    setStatus("请选择地图存档");
    addLog("请先选择要删除的地图存档。");
    return;
  }
  if (!window.confirm(`删除地图“${map.name}”？`)) return;
  setSavedMaps(maps.filter(item => item.id !== map.id));
  const nextSelected = selectedSavedMapId === map.id ? "" : selectedSavedMapId;
  renderSavedMapSelect(nextSelected);
  setStatus("地图存档已删除");
  addLog(`已删除地图存档“${map.name}”。`);
}

function toggleSavedMapMenu() {
  if (!savedMapMenu) return;
  savedMapMenu.classList.toggle("is-open");
}

function closeSavedMapMenu() {
  if (!savedMapMenu) return;
  savedMapMenu.classList.remove("is-open");
}

function setCameraMode(mode) {
  cameraMode = mode;
  document.querySelectorAll("[data-view]").forEach(button => {
    button.classList.toggle("is-active", button.dataset.view === mode);
  });
  if (mode === "iso") {
    orbitFollowsRobotTarget = false;
    orbitTarget.set(0, 0, 0);
    fitIsoCameraToMap();
  }
  if (mode === "top") {
    orbitFollowsRobotTarget = false;
    orbitTarget.set(0, 0, 0);
    fitTopCameraToMap();
  }
  if (mode === "follow") {
    updateFollowCamera(true);
  }
  if (primaryGuangyangReliefRoot) primaryGuangyangReliefRoot.visible = mode !== "top";
  resizeRenderer();
}

function fitIsoCameraToMap() {
  if (!camera) return;
  const padding = isLargeMap() ? 0.75 : 0.48;
  const halfWidth = currentMapWidth() / 2 + padding;
  const halfDepth = currentMapDepth() / 2 + padding;
  const direction = new THREE.Vector3(0.56, 0.5, 0.56).normalize();
  const forward = direction.clone().multiplyScalar(-1);
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
  const viewUp = new THREE.Vector3().crossVectors(right, forward).normalize();
  const tanVertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const tanHorizontal = tanVertical * Math.max(0.35, camera.aspect);
  const fill = isLargeMap() ? 1.02 : 0.92;
  let distance = 0;
  [[-halfWidth, -halfDepth], [-halfWidth, halfDepth], [halfWidth, -halfDepth], [halfWidth, halfDepth]].forEach(([x, z]) => {
    const corner = new THREE.Vector3(x, 0, z);
    const nearOffset = corner.dot(direction);
    distance = Math.max(
      distance,
      nearOffset + Math.abs(corner.dot(right)) / (tanHorizontal * fill),
      nearOffset + Math.abs(corner.dot(viewUp)) / (tanVertical * fill)
    );
  });
  camera.position.copy(direction.multiplyScalar(Math.max(distance, isLargeMap() ? 18 : 10)));
  camera.lookAt(0, 0, 0);
}

function fitTopCameraToMap() {
  if (!camera) return;
  const padding = isLargeMap() ? 0.9 : 0.65;
  const paddedHalfWidth = currentMapWidth() / 2 + padding;
  const paddedHalfDepth = currentMapDepth() / 2 + padding;
  const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const verticalDistance = paddedHalfDepth / tanHalfFov;
  const horizontalDistance = paddedHalfWidth / (tanHalfFov * Math.max(0.2, camera.aspect));
  camera.position.set(0, Math.max(verticalDistance, horizontalDistance), 0.01);
  camera.lookAt(0, 0, 0);
}

function updateFollowCamera(immediate = false) {
  const dir = directionVector();
  followCameraDesired.set(robotPose.x - dir.x * 3.5, 4.2, robotPose.z - dir.z * 3.5);
  followLookDesired.set(robotPose.x, 0.25, robotPose.z);
  const smoothing = immediate ? 1 : 0.14;
  camera.position.lerp(followCameraDesired, smoothing);
  if (immediate) followLookCurrent.copy(followLookDesired);
  else followLookCurrent.lerp(followLookDesired, smoothing);
  camera.lookAt(followLookCurrent);
}

function updateFreeCamera() {
  const [minDistance, maxDistance] = getOrbitDistanceBounds();
  orbitDistance = Math.max(minDistance, Math.min(maxDistance, orbitDistance));
  const x = Math.sin(orbitYaw) * Math.cos(orbitPitch) * orbitDistance;
  const y = Math.sin(orbitPitch) * orbitDistance;
  const z = Math.cos(orbitYaw) * Math.cos(orbitPitch) * orbitDistance;
  camera.position.set(orbitTarget.x + x, orbitTarget.y + y, orbitTarget.z + z);
  camera.lookAt(orbitTarget);
}

function getOrbitDistanceBounds() {
  if (orbitFollowsRobotTarget) return [3.2, isLargeMap() ? currentMapSize() * 1.8 : 19];
  return isLargeMap() ? [10, currentMapSize() * 1.8] : [7, 19];
}

function startOrbitDrag(event) {
  if (placeMode) return;
  const wasFollow = cameraMode === "follow";
  if (cameraMode !== "free") {
    orbitFollowsRobotTarget = wasFollow;
    orbitTarget.set(wasFollow ? robotPose.x : 0, wasFollow ? 0.25 : 0, wasFollow ? robotPose.z : 0);
    const offsetX = camera.position.x - orbitTarget.x;
    const offsetY = camera.position.y - orbitTarget.y;
    const offsetZ = camera.position.z - orbitTarget.z;
    orbitDistance = Math.max(0.001, Math.hypot(offsetX, offsetY, offsetZ));
    orbitPitch = Math.asin(Math.max(-1, Math.min(1, offsetY / orbitDistance)));
    orbitYaw = Math.atan2(offsetX, offsetZ);
  }
  cameraMode = "free";
  document.querySelectorAll("[data-view]").forEach(button => button.classList.remove("is-active"));
  isOrbitDragging = false;
  lastPointer = { x: event.clientX, y: event.clientY };
}

function orbitDrag(event) {
  if (placeMode || event.buttons !== 1 || cameraMode !== "free") return;
  const dx = event.clientX - lastPointer.x;
  const dy = event.clientY - lastPointer.y;
  if (Math.abs(dx) + Math.abs(dy) > 2) isOrbitDragging = true;
  orbitYaw -= dx * 0.008;
  orbitPitch = Math.max(0.25, Math.min(1.32, orbitPitch + dy * 0.005));
  lastPointer = { x: event.clientX, y: event.clientY };
  updateFreeCamera();
}

function endOrbitDrag() {
  setTimeout(() => { isOrbitDragging = false; }, 0);
}

function zoomCamera(event) {
  if (cameraMode !== "free") return;
  event.preventDefault();
  const [minDistance, maxDistance] = getOrbitDistanceBounds();
  const speed = isLargeMap() ? 0.035 : 0.01;
  orbitDistance = Math.max(minDistance, Math.min(maxDistance, orbitDistance + event.deltaY * speed));
  updateFreeCamera();
}

function preferredRendererPixelRatio(width, height) {
  const pixelBudget = width * height;
  const maximum = pixelBudget > 900000 ? 1.25 : 1.5;
  return Math.min(window.devicePixelRatio || 1, maximum);
}

function resizeRenderer() {
  if (scheduledResizeFrame) return;
  scheduledResizeFrame = requestAnimationFrame(() => {
    scheduledResizeFrame = 0;
    resizeRendererNow();
  });
}

function resizeRendererNow() {
  if (!renderer || !camera || !simulator) return;
  const rect = simulator.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const pixelRatio = preferredRendererPixelRatio(width, height);
  if (Math.abs(pixelRatio - rendererPixelRatio) > 0.001) {
    renderer.setPixelRatio(pixelRatio);
    rendererPixelRatio = pixelRatio;
  }
  const sizeChanged = width !== rendererWidth || height !== rendererHeight;
  if (sizeChanged) {
    renderer.setSize(width, height, false);
    rendererWidth = width;
    rendererHeight = height;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (cameraMode === "top") fitTopCameraToMap();
  }
  if (workspace) Blockly.svgResize(workspace);
}

function setRightPanelWidth(width, persist = true) {
  const gridRect = workspaceGrid.getBoundingClientRect();
  const minRight = 360;
  const maxRight = Math.max(minRight, gridRect.width - 430);
  const nextWidth = Math.max(minRight, Math.min(maxRight, width));
  workspaceGrid.style.setProperty("--right-panel-width", `${Math.round(nextWidth)}px`);
  if (persist) localStorage.setItem("chenlongRightPanelWidth", String(Math.round(nextWidth)));
  resizeRenderer();
}

function initWorkspaceSplitter() {
  const saved = Number(localStorage.getItem("chenlongRightPanelWidth"));
  if (Number.isFinite(saved) && saved > 0) setRightPanelWidth(saved, false);
  workspaceSplitter.addEventListener("pointerdown", event => {
    resizingWorkspace = true;
    appShell.classList.add("is-resizing");
    workspaceSplitter.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  workspaceSplitter.addEventListener("pointermove", event => {
    if (!resizingWorkspace) return;
    const gridRect = workspaceGrid.getBoundingClientRect();
    setRightPanelWidth(gridRect.right - event.clientX, false);
  });
  const finishResize = event => {
    if (!resizingWorkspace) return;
    resizingWorkspace = false;
    appShell.classList.remove("is-resizing");
    if (workspaceSplitter.hasPointerCapture?.(event.pointerId)) workspaceSplitter.releasePointerCapture(event.pointerId);
    const current = Number.parseFloat(getComputedStyle(workspaceGrid).getPropertyValue("--right-panel-width")) || 520;
    setRightPanelWidth(current, true);
  };
  workspaceSplitter.addEventListener("pointerup", finishResize);
  workspaceSplitter.addEventListener("pointercancel", finishResize);
  workspaceSplitter.addEventListener("lostpointercapture", finishResize);
  workspaceSplitter.addEventListener("dblclick", () => setRightPanelWidth(520));
}

function setStatePanelHeight(height, persist = true) {
  const rect = sidePanel.getBoundingClientRect();
  const minTop = codePanel.classList.contains("is-code-collapsed") ? 79 : 215;
  const minBottom = 260;
  const maxTop = Math.max(minTop, rect.height - minBottom - 8);
  const nextHeight = Math.max(minTop, Math.min(maxTop, height));
  sidePanel.style.setProperty("--state-panel-height", `${Math.round(nextHeight)}px`);
  if (persist) localStorage.setItem("chenlongStatePanelHeight", String(Math.round(nextHeight)));
  resizeRenderer();
}

function initStateSceneSplitter() {
  const saved = Number(localStorage.getItem("chenlongStatePanelHeight"));
  if (Number.isFinite(saved) && saved > 0) {
    const initial = codePanel.classList.contains("is-code-collapsed") && saved >= 100 && saved <= 180 ? 220 : saved;
    setStatePanelHeight(initial, false);
  } else {
    setStatePanelHeight(220, false);
  }
  stateSceneSplitter.addEventListener("pointerdown", event => {
    resizingStateScene = true;
    appShell.classList.add("is-resizing-vertical");
    stateSceneSplitter.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  stateSceneSplitter.addEventListener("pointermove", event => {
    if (!resizingStateScene) return;
    const rect = sidePanel.getBoundingClientRect();
    setStatePanelHeight(event.clientY - rect.top, false);
  });
  const finishResize = event => {
    if (!resizingStateScene) return;
    resizingStateScene = false;
    appShell.classList.remove("is-resizing-vertical");
    if (stateSceneSplitter.hasPointerCapture?.(event.pointerId)) stateSceneSplitter.releasePointerCapture(event.pointerId);
    const current = Number.parseFloat(getComputedStyle(sidePanel).getPropertyValue("--state-panel-height")) || 220;
    setStatePanelHeight(current, true);
  };
  stateSceneSplitter.addEventListener("pointerup", finishResize);
  stateSceneSplitter.addEventListener("pointercancel", finishResize);
  stateSceneSplitter.addEventListener("lostpointercapture", finishResize);
  stateSceneSplitter.addEventListener("dblclick", () => setStatePanelHeight(codePanel.classList.contains("is-code-collapsed") ? 220 : 310));
}

function markSceneShadowDirty() {
  sceneShadowDirty = true;
  lastSceneMotionAt = performance.now();
}

function targetRenderFps() {
  if (document.hidden || targetSelect?.value === "real") return 0;
  const recentlyMoved = performance.now() - lastSceneMotionAt < 250;
  return recentlyMoved || isOrbitDragging || cameraMode === "follow" ? ACTIVE_RENDER_FPS : IDLE_RENDER_FPS;
}

function animate(timestamp = performance.now()) {
  requestAnimationFrame(animate);
  if (activeRun && timestamp - lastPrimaryScoreClockRenderAt >= 100) {
    lastPrimaryScoreClockRenderAt = timestamp;
    renderPrimaryScore();
  }
  const targetFps = targetRenderFps();
  if (targetFps <= 0) {
    lastRenderAt = -Infinity;
    renderedFramesInWindow = 0;
    renderStatsWindowStartedAt = timestamp;
    renderedFps = 0;
    return;
  }
  const interval = 1000 / targetFps;
  const elapsedSinceRender = timestamp - lastRenderAt;
  if (Number.isFinite(lastRenderAt) && elapsedSinceRender < interval) return;
  lastRenderAt = Number.isFinite(lastRenderAt)
    ? timestamp - (elapsedSinceRender % interval)
    : timestamp;

  animateSceneEffects(timestamp * 0.001);
  if (cameraMode === "follow") updateFollowCamera();
  if (sceneShadowDirty) {
    renderer.shadowMap.needsUpdate = true;
    shadowUpdateCount++;
  }
  renderer.render(scene, camera);
  sceneShadowDirty = false;

  if (!renderStatsWindowStartedAt) renderStatsWindowStartedAt = timestamp;
  renderedFramesInWindow++;
  const statsElapsed = timestamp - renderStatsWindowStartedAt;
  if (statsElapsed >= 1000) {
    renderedFps = Math.round(renderedFramesInWindow * 10000 / statsElapsed) / 10;
    renderedFramesInWindow = 0;
    renderStatsWindowStartedAt = timestamp;
  }
}

function animateSceneEffects(time) {
  goalPulseEffects.forEach(pulse => {
    const wave = (Math.sin(time * 2.6) + 1) / 2;
    pulse.ring.scale.setScalar(0.94 + wave * 0.18);
    pulse.ring.material.opacity = 0.42 + wave * 0.38;
    pulse.beacon.material.opacity = 0.055 + wave * 0.065;
    pulse.glow.intensity = 0.38 + wave * 0.34;
  });
  mazeSignalEffects.forEach(signal => {
    const wave = (Math.sin(time * 2.4 + signal.phase) + 1) / 2;
    signal.ring.rotation.z = time * 0.55 + signal.phase;
    signal.ring.material.opacity = 0.56 + wave * 0.34;
    signal.beam.material.opacity = 0.045 + wave * 0.075;
    signal.core.position.y = 0.36 + wave * 0.12;
    signal.core.rotation.y = time * 1.2 + signal.phase;
  });
}

function getRobotLabPerformance() {
  const info = renderer?.info;
  const fpsTarget = targetRenderFps();
  return {
    renderedFps,
    targetFps: fpsTarget,
    webglPaused: fpsTarget === 0,
    shadowUpdates: shadowUpdateCount,
    pixelRatio: rendererPixelRatio,
    viewport: { width: rendererWidth, height: rendererHeight },
    drawingBuffer: {
      width: renderer?.domElement?.width || 0,
      height: renderer?.domElement?.height || 0
    },
    render: {
      calls: fpsTarget > 0 ? info?.render?.calls || 0 : 0,
      triangles: fpsTarget > 0 ? info?.render?.triangles || 0 : 0,
      points: fpsTarget > 0 ? info?.render?.points || 0 : 0
    },
    memory: {
      geometries: info?.memory?.geometries || 0,
      textures: info?.memory?.textures || 0
    },
    sceneObjects: scene?.children?.length || 0,
    collisionShapes: robotCollisionShapes.length,
    trajectoryPoints: trajectoryPoints.length,
    trajectoryDistance: Math.round(trajectoryTotalDistance * 100) / 100,
    trajectoryWorldUnits: Math.round(trajectoryTotalDistance * 100) / 100,
    trajectoryDistanceCm: Math.round(primaryWorldUnitsToCm(trajectoryTotalDistance) * 10) / 10
  };
}

async function primaryRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store"
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || "服务暂时无法处理请求。";
    const error = new Error(message);
    error.code = payload?.error?.code || "REQUEST_FAILED";
    throw error;
  }
  return payload;
}

async function primaryRequestAllRecordPages() {
  const records = [];
  const recordIds = new Set();
  let page = 1;
  while (page <= 10_000) {
    const result = await primaryRequest(`/api/records?page=${page}&pageSize=1000`);
    if (result?.schemaVersion !== "chenlong.blockly-records/v1" || !Array.isArray(result.records)) {
      throw new Error("成绩列表格式不正确，请稍后重试。 ");
    }
    const pagination = result.pagination;
    if (!pagination) return [...records, ...result.records];
    if (pagination.page !== page || pagination.pageSize !== 1000
      || !Number.isInteger(pagination.total) || pagination.total < 0
      || typeof pagination.hasNext !== "boolean") {
      throw new Error("成绩分页信息不正确，请稍后重试。 ");
    }
    result.records.forEach(record => {
      if (typeof record?.id !== "string" || recordIds.has(record.id)) return;
      recordIds.add(record.id);
      records.push(record);
    });
    if (!pagination.hasNext) {
      if (records.length !== pagination.total) throw new Error("成绩分页数量不完整，请刷新后重试。 ");
      return records;
    }
    if (result.records.length === 0) throw new Error("成绩分页意外中断，请刷新后重试。 ");
    page += 1;
  }
  throw new Error("成绩页数超出安全范围。 ");
}

function validatePublishedPrimaryMap(config) {
  const task = PRIMARY_GUANGYANG_MAPS.TASKS[config?.taskId];
  if (!task || !Number.isInteger(config.revision) || config.revision < 0
    || typeof config.digest !== "string" || !/^[a-f0-9]{64}$/.test(config.digest)) {
    throw new Error("地图配置回执不完整，请刷新页面重试。 ");
  }
  return {
    taskId: config.taskId,
    taskName: task.name,
    revision: config.revision,
    digest: config.digest,
    updatedAt: config.updatedAt,
    layout: PRIMARY_GUANGYANG_MAPS.normalizeLayout(config.taskId, config.layout)
  };
}

async function refreshPublishedPrimaryMaps({ reloadCurrent = true } = {}) {
  const result = await primaryRequest("/api/maps");
  if (result?.schemaVersion !== "chenlong.blockly-maps/v1" || !Array.isArray(result.maps) || result.maps.length !== 3) {
    throw new Error("地图列表回执不完整，请刷新页面重试。 ");
  }
  let currentChanged = false;
  result.maps.forEach(rawConfig => {
    const config = validatePublishedPrimaryMap(rawConfig);
    const previous = primaryPublishedMaps.get(config.taskId);
    primaryPublishedMaps.set(config.taskId, config);
    const task = PRIMARY_GUANGYANG_MAPS.TASKS[config.taskId];
    missions[task.key] = createPrimaryGuangyangMission(task.level, config);
    if (activeMission?.taskId === config.taskId && previous?.digest !== config.digest) currentChanged = true;
  });
  if (reloadCurrent && currentChanged) {
    const selectedKey = document.querySelector("#sceneSelect")?.value || "guangyang1";
    await loadMission(selectedKey);
    addLog(`已同步管理员发布的地图修订 ${activeMission.mapRevision}。`);
  }
}

function renderPrimaryAccount() {
  const signedIn = Boolean(primaryUser);
  if (accountName) accountName.textContent = signedIn ? primaryUser.username : "请先登录";
  if (recordsButton) recordsButton.disabled = !signedIn;
  if (teamInviteButton) teamInviteButton.disabled = !signedIn;
  if (teamInviteButton) teamInviteButton.hidden = !signedIn || primaryUser?.role === "admin";
  if (adminButton) adminButton.hidden = primaryUser?.role !== "admin";
  if (loginButton) loginButton.hidden = signedIn;
  if (logoutButton) logoutButton.hidden = !signedIn || primaryUser?.role !== "admin";
  updateRunControls();
}

async function openPrimaryTeamInvite() {
  if (!primaryUser) {
    openAuthDialog("请先登录后查看队伍邀请码。");
    return;
  }
  try {
    const result = await primaryRequest("/api/auth/team-invite");
    if (result?.schemaVersion !== "chenlong.blockly-team-invite/v1"
      || typeof result.teamName !== "string" || !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(result.inviteCode || "")) {
      throw new Error("队伍邀请码回执不完整，请稍后重试。 ");
    }
    if (primaryTeamDialogText) primaryTeamDialogText.textContent = `“${result.teamName}”的邀请码，发给队友即可加入同一队伍。`;
    if (primaryTeamInviteCode) primaryTeamInviteCode.textContent = result.inviteCode;
    if (primaryTeamCopyStatus) primaryTeamCopyStatus.textContent = "";
    if (primaryTeamDialog?.showModal && !primaryTeamDialog.open) primaryTeamDialog.showModal();
  } catch (error) {
    addLog(`无法读取队伍邀请码：${error.message}`);
    setStatus("邀请码暂时无法读取");
  }
}

function setAuthMessage(text, tone = "") {
  if (!authMessage) return;
  authMessage.textContent = text;
  authMessage.dataset.tone = tone;
}

function openAuthDialog(message = "") {
  // 采用独立、居中的登录页，不在编程页叠加账户表单。
  if (window.location.pathname.startsWith("/blockly/")) {
    const parameters = new URLSearchParams({ returnTo: "/blockly/" });
    if (message) parameters.set("message", message);
    window.location.replace(`/login.html?${parameters.toString()}`);
    return;
  }
  const suffix = message ? `?message=${encodeURIComponent(message)}` : "";
  window.location.replace(`./login.html${suffix}`);
}

async function submitPrimaryAuth(mode) {
  const username = authUsername?.value.trim() || "";
  const password = authPassword?.value || "";
  const isRegister = mode === "register";
  const body = isRegister
    ? { username, displayName: authDisplayName?.value.trim() || "", password }
    : { username, password };
  setAuthMessage(isRegister ? "正在注册…" : "正在登录…");
  try {
    const result = await primaryRequest(isRegister ? "/api/auth/register" : "/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body)
    });
    if (result?.schemaVersion !== "chenlong.blockly-auth/v1" || !result.authenticated || !result.user) {
      throw new Error("登录回执不完整，请重试。 ");
    }
    primaryUser = result.user;
    authPassword.value = "";
    authDialog?.close();
    renderPrimaryAccount();
    setStatus("可以开始闯关");
    addLog(`已登录：${primaryUser.username}。每次有效运行只会保存调试记录，需要在“我的成绩”中主动正式提交。`);
  } catch (error) {
    setAuthMessage(error.message, "error");
  }
}

async function initializePrimaryAccount() {
  try {
    const result = await primaryRequest("/api/auth/me");
    if (result?.schemaVersion === "chenlong.blockly-auth/v1" && result.authenticated && result.user) primaryUser = result.user;
  } catch (_error) {
    primaryUser = null;
  }
  if (!primaryUser) {
    openAuthDialog("请登录或注册后再开始闯关。");
    return;
  }
  renderPrimaryAccount();
  try {
    await refreshPublishedPrimaryMaps();
  } catch (error) {
    setStatus("地图暂时无法读取");
    addLog(`地图同步失败：${error.message}`);
  }
}

function formatPrimaryTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : date.toLocaleString("zh-CN", { hour12: false });
}

function clearElement(element) {
  while (element?.firstChild) element.removeChild(element.firstChild);
}

async function showPrimaryProgram(recordId, host) {
  const result = await primaryRequest(`/api/records/${encodeURIComponent(recordId)}`);
  const record = result?.record;
  if (!record || typeof record.programCode !== "string") throw new Error("这条记录的程序内容无法读取。");
  const source = document.createElement("pre");
  source.className = "primary-program-code";
  source.textContent = record.programCode;
  const previous = host.querySelector("pre");
  if (previous) previous.remove();
  else host.append(source);
}

async function submitPrimaryRecord(recordId, button) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "提交中…";
  try {
    const result = await primaryRequest(`/api/records/${encodeURIComponent(recordId)}/submit`, {
      method: "POST",
      body: "{}"
    });
    if (result?.schemaVersion !== "chenlong.blockly-record-submit-receipt/v1"
      || result.record?.id !== recordId || result.record?.recordState !== "submitted") {
      throw new Error("正式提交回执不完整，请刷新后确认。 ");
    }
    addLog(`已正式提交 ${result.record.score}/100 分的记录。`);
    await openPrimaryRecords();
  } catch (error) {
    if (recordsSummary) recordsSummary.textContent = error.message;
    button.disabled = false;
    button.textContent = original;
  }
}

function renderPrimaryRecordPage() {
  clearElement(recordsList);
  const totalPages = Math.max(1, Math.ceil(primaryRecordCache.length / PRIMARY_RECORD_PAGE_SIZE));
  primaryRecordPage = Math.max(1, Math.min(primaryRecordPage, totalPages));
  const start = (primaryRecordPage - 1) * PRIMARY_RECORD_PAGE_SIZE;
  const visibleRecords = primaryRecordCache.slice(start, start + PRIMARY_RECORD_PAGE_SIZE);
  const bestSavedScore = primaryRecordCache
    .filter(record => record.recordState === "saved")
    .reduce((maximum, record) => Math.max(maximum, Number(record.score) || 0), -1);
  if (primaryRecordsPageInfo) {
    primaryRecordsPageInfo.textContent = `第 ${primaryRecordPage}/${totalPages} 页 · 共 ${primaryRecordCache.length} 条`;
  }
  if (primaryRecordsPrevious) primaryRecordsPrevious.disabled = primaryRecordPage <= 1;
  if (primaryRecordsNext) primaryRecordsNext.disabled = primaryRecordPage >= totalPages;

  visibleRecords.forEach(record => {
    const item = document.createElement("article");
    item.className = "primary-record-item";
    const isRecommended = record.recordState === "saved" && Number(record.score) === bestSavedScore;
    if (isRecommended) item.classList.add("is-recommended");
    const heading = document.createElement("strong");
    heading.textContent = `${record.score}/100 分 · ${record.recordState === "submitted" ? "已正式提交" : isRecommended ? "推荐提交" : "未提交"}`;
    const meta = document.createElement("span");
    meta.textContent = `${formatPrimaryTime(record.submittedAt || record.savedAt || record.createdAt)} · 任务进度 ${record.taskCompleted ?? record.checkpointCount}/${record.taskTotal ?? record.checkpointTotal ?? 0}`;
    const actions = document.createElement("div");
    actions.className = "primary-record-actions";
    const viewButton = document.createElement("button");
    viewButton.type = "button";
    viewButton.textContent = "查看程序";
    viewButton.addEventListener("click", async () => {
      viewButton.disabled = true;
      try {
        await showPrimaryProgram(record.id, item);
      } catch (error) {
        if (recordsSummary) recordsSummary.textContent = error.message;
      } finally {
        viewButton.disabled = false;
      }
    });
    actions.append(viewButton);
    if (record.recordState === "saved") {
      const submitButton = document.createElement("button");
      submitButton.type = "button";
      submitButton.className = isRecommended ? "primary" : "";
      submitButton.textContent = isRecommended ? "提交最高分" : "正式提交";
      submitButton.addEventListener("click", () => void submitPrimaryRecord(record.id, submitButton));
      actions.append(submitButton);
    } else {
      const state = document.createElement("small");
      state.className = "primary-record-submitted";
      state.textContent = "已提交";
      actions.append(state);
    }
    item.append(heading, meta, actions);
    recordsList.append(item);
  });
}

async function openPrimaryRecords() {
  if (!primaryUser) {
    openAuthDialog("请先登录，才能查看自己的成绩。");
    return;
  }
  if (recordsDialog?.showModal && !recordsDialog.open) recordsDialog.showModal();
  if (recordsSummary) recordsSummary.textContent = "正在读取成绩…";
  clearElement(recordsList);
  if (primaryTaskHighScores) {
    primaryTaskHighScores.querySelectorAll("strong").forEach(score => { score.textContent = "—"; });
  }
  try {
    const records = await primaryRequestAllRecordPages();
    const savedRecords = records.filter(record => record.recordState === "saved");
    const submittedRecords = records.filter(record => record.recordState === "submitted");
    const submittedScores = PRIMARY_SCORE_SUMMARIES.buildSubmittedTaskScores(
      records,
      ["GYI-PRIMARY-01", "GYI-PRIMARY-02", "GYI-PRIMARY-03"],
      100
    );
    if (primaryTaskHighScores) {
      primaryTaskHighScores.replaceChildren(...Object.values(submittedScores).map((scoreValue, index) => {
        const item = document.createElement("article");
        const label = document.createElement("span");
        const score = document.createElement("strong");
        label.textContent = `任务${index + 1}`;
        score.textContent = scoreValue === null ? "—" : `${scoreValue}/100`;
        item.append(label, score);
        return item;
      }));
    }
    if (recordsSummary) recordsSummary.textContent = records.length
      ? `已保存 ${savedRecords.length} 条调试记录，已正式提交 ${submittedRecords.length} 条。建议只提交分数最高的记录。`
      : "还没有成绩。运行程序只会自动保存，是否正式提交由你决定。";
    primaryRecordCache = records;
    primaryRecordPage = 1;
    renderPrimaryRecordPage();
  } catch (error) {
    primaryRecordCache = [];
    primaryRecordPage = 1;
    renderPrimaryRecordPage();
    if (recordsSummary) recordsSummary.textContent = error.message;
    if (primaryTaskHighScores) {
      primaryTaskHighScores.querySelectorAll("strong").forEach(score => { score.textContent = "—"; });
    }
  }
}

async function archivePrimaryRun(programCode, startedAt, context) {
  if (context?.target !== "sim") return null;
  const completed = Boolean(missionAttempt?.completed);
  const checkpointTotal = Math.max(1, missionAttempt?.checkpointPoints?.length || 3);
  const checkpointCount = Math.max(0, Math.min(checkpointTotal, Number(missionAttempt?.nextCheckpointIndex) || 0));
  const taskProgress = compositeMissionProgress();
  const workspaceXml = JSON.stringify(Blockly.serialization.workspaces.save(workspace));
  const result = await primaryRequest("/api/records", {
    method: "POST",
    body: JSON.stringify({
      taskId: activeMission.taskId || "GYI-PRIMARY-01",
      mapRevision: activeMission.mapRevision,
      mapDigest: activeMission.mapDigest,
      completed,
      checkpointCount,
      targetDeliveredCount: taskProgress.targetDeliveredCount,
      distractorClearedCount: taskProgress.distractorClearedCount,
      failedObstacleCount: taskProgress.failedObstacleCount,
      goalReached: taskProgress.goalReached,
      blockedMoves: Math.min(99, primaryBlockedMoveCount),
      offRoadEpisodes: Math.min(99, primaryOffRoadEpisodes),
      offRoadDurationMs: Math.min(
        Math.max(0, Math.round(Date.now() - startedAt)),
        Math.max(0, Math.round(primaryOffRoadDurationMs))
      ),
      durationMs: Math.min(10 * 60 * 1000, Math.max(0, Math.round(Date.now() - startedAt))),
      programCode,
      workspaceXml,
      executionTrace: Array.isArray(context?.executedApiMethods) ? [...context.executedApiMethods] : []
    })
  });
  const record = result?.record;
  if (result?.schemaVersion !== "chenlong.blockly-record-save-receipt/v1" || !record || !Number.isFinite(record.score)
    || record.recordState !== "saved") {
    throw new Error("成绩保存回执不完整，请稍后在“我的成绩”中确认。 ");
  }
  addLog(`本次调试已保存：${record.score}/100 分。需要时请在“我的成绩”中正式提交。`);
}

window.getRobotLabPerformance = getRobotLabPerformance;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

defineBlocks();
initBlockly();
initScene();
initWorkspaceSplitter();
initStateSceneSplitter();
initMissionCardToggle();
initPrimaryScoreToggle();
migrateLegacyMapSave();
renderSavedMapSelect();
robotBaseUrlInput.value = robotBaseUrlToDisplayValue(localStorage.getItem("chenlongRobotBaseUrl") || robotBaseUrlInput.value);
realStopHazard = localStorage.getItem("chenlongRealStopHazard") === "1";
targetSelect.value = "sim";
setRunTarget("sim");
setRobotProtocol(getRobotProtocol());
updateRunControls();
void initializePrimaryAccount();

runButton.addEventListener("click", runProgram);
toggleCodeButton.addEventListener("click", () => {
  const collapsed = codePanel.classList.toggle("is-code-collapsed");
  toggleCodeButton.querySelector("span").textContent = collapsed ? "展开代码" : "折叠代码";
  const icon = toggleCodeButton.querySelector("svg");
  if (icon) icon.style.transform = collapsed ? "rotate(0deg)" : "rotate(180deg)";
  const current = Number.parseFloat(getComputedStyle(sidePanel).getPropertyValue("--state-panel-height")) || (collapsed ? 148 : 275);
  setStatePanelHeight(current, false);
  setTimeout(resizeRenderer, 190);
});
pauseButton.addEventListener("click", () => {
  if (!pauseActiveRun()) setStatus("当前没有可暂停的程序");
});
stopButton.addEventListener("click", async () => {
  if (!activeRun) {
    if (targetSelect.value === "real") {
      setStatus("正在发送停止指令");
      const cancellation = await cancelActiveRun("stopped", { sendHardwareStop: true });
      setStatus(cancellation.hardwareStopSent ? "停止指令已发送（未确认）" : "停止指令发送失败");
    } else {
      setStatus("当前没有运行程序");
    }
    return;
  }
  const wasReal = activeRun.target === "real";
  setStatus("正在停止程序");
  const cancellation = await cancelActiveRun("stopped", { sendHardwareStop: true });
  if (wasReal) {
    setStatus(cancellation.hardwareStopSent ? "程序已取消；停止未确认" : "程序已取消；小车停止失败");
    addLog(cancellation.hardwareStopSent
      ? "程序已取消；停止指令已发送，但设备没有回传确认，请现场确认小车状态。"
      : "程序已取消；真实小车停止指令发送失败，请立即现场确认小车状态。");
  } else {
    setStatus("程序已停止");
    addLog("程序已停止；模拟小车和任务进度保持当前位置，点击运行可继续尝试。");
  }
});
resetButton.addEventListener("click", async () => {
  if (runControlBusy) return;
  const wasReal = activeRun?.target === "real" || targetSelect.value === "real";
  const cancellation = await cancelActiveRun("reset", { sendHardwareStop: true });
  runControlBusy = true;
  updateRunControls();
  try {
    missionAttempt = null;
    restoreMissionBaseline();
    resetRobot();
    rebuildSceneObjects();
    clearExecutionHighlight();
    clearActionLog();
    clearRuntimeFeedback();
    initializeMissionAttempt();
    if (missionAttempt?.completed && !wasReal) {
      addLog("重置后的初始布局已经满足任务条件。");
    } else if (wasReal) {
      setStatus(cancellation.hardwareStopSent ? "页面已重置；停止未确认" : "页面已重置；小车停止失败");
      addLog(cancellation.hardwareStopSent
        ? "程序和页面状态已重置；停止指令已发送，但设备未回传确认，真实小车位置需现场确认。"
        : "程序和页面状态已重置；真实小车停止指令发送失败，请立即现场确认小车状态。");
    } else {
      setStatus("任务已重置");
      addLog("任务物体和模拟小车均已恢复到初始状态。");
    }
  } finally {
    runControlBusy = false;
    updateRunControls();
  }
});
centerBlocksButton.addEventListener("click", centerBlocklyWorkspace);
zoomInBlocksButton.addEventListener("click", () => zoomBlocklyWorkspace(1));
zoomOutBlocksButton.addEventListener("click", () => zoomBlocklyWorkspace(-1));
deleteBlocksButton.addEventListener("click", deleteBlocklySelection);
targetSelect.addEventListener("change", event => setRunTarget(event.target.value));
document.addEventListener("visibilitychange", () => {
  if (targetSelect?.value !== "real") return;
  if (!document.hidden) {
    startRealCameraPreview();
    return;
  }
  saveBlocklyWorkspace();
  void stopRealCameraPreview({ keepalive: true, message: "页面在后台，摄像头预览已暂停" });
  if (activeRun) {
    void cancelActiveRun("page-hidden", { sendHardwareStop: true });
  } else {
    void sendRealRobotStop().then(sent => setRealStopHazard(!sent));
  }
});
window.addEventListener("pagehide", () => {
  saveBlocklyWorkspace();
  if (targetSelect?.value === "real") {
    const context = activeRun;
    void stopRealCameraPreview({ keepalive: true, message: "页面已关闭，摄像头已释放" });
    if (context) abortRunContext(context, "page-hidden");
    void sendRealRobotStop(context?.robotBaseUrl || null).then(sent => setRealStopHazard(!sent));
  }
});
if (protocolToggle) {
  protocolToggle.addEventListener("click", event => {
    const btn = event.target.closest(".protocol-btn");
    if (!btn) return;
    const protocol = btn.dataset.protocol;
    if (protocol === getRobotProtocol()) return;
    setRobotProtocol(protocol);
    setStatus(`协议已切换为 ${protocol.toUpperCase()}`);
    addLog(`小车请求协议已切换为 ${protocol.toUpperCase()}。`);
    if (targetSelect?.value === "real") void restartRealCameraPreview();
  });
}
applyRobotIpButton.addEventListener("click", applyRobotIp);
retryCameraButton?.addEventListener("click", () => void restartRealCameraPreview());
robotBaseUrlInput.addEventListener("change", applyRobotIp);
robotBaseUrlInput.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    applyRobotIp();
  }
});
document.querySelector("#sceneSelect").addEventListener("change", async event => {
  await loadMission(event.target.value);
  saveBlocklyWorkspace();
});
loginButton?.addEventListener("click", () => openAuthDialog());
logoutButton?.addEventListener("click", async () => {
  try {
    await primaryRequest("/api/auth/logout", { method: "POST" });
  } catch (_error) {}
  primaryUser = null;
  openAuthDialog("已退出登录。");
});
registerButton?.addEventListener("click", () => void submitPrimaryAuth("register"));
submitLoginButton?.addEventListener("click", () => void submitPrimaryAuth("login"));
closeAuthButton?.addEventListener("click", () => authDialog?.close());
recordsButton?.addEventListener("click", () => void openPrimaryRecords());
closeRecordsButton?.addEventListener("click", () => recordsDialog?.close());
primaryRecordsPrevious?.addEventListener("click", () => {
  primaryRecordPage -= 1;
  renderPrimaryRecordPage();
});
primaryRecordsNext?.addEventListener("click", () => {
  primaryRecordPage += 1;
  renderPrimaryRecordPage();
});
teamInviteButton?.addEventListener("click", () => void openPrimaryTeamInvite());
adminButton?.addEventListener("click", () => window.location.assign("./admin.html"));
closePrimaryTeamDialogButton?.addEventListener("click", () => primaryTeamDialog?.close());
copyPrimaryTeamInviteButton?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(primaryTeamInviteCode?.textContent || "");
    if (primaryTeamCopyStatus) primaryTeamCopyStatus.textContent = "邀请码已复制。";
  } catch (_error) {
    if (primaryTeamCopyStatus) primaryTeamCopyStatus.textContent = "无法自动复制，请手动记录邀请码。";
  }
});
toggleSceneTools.addEventListener("click", () => {
  const collapsed = sceneTools.classList.toggle("is-collapsed");
  toggleSceneTools.classList.toggle("is-active", !collapsed);
  resizeRenderer();
});
mapStyleSelect.addEventListener("change", event => setMapStyle(event.target.value));
document.querySelectorAll("[data-view]").forEach(button => {
  button.addEventListener("click", () => setCameraMode(button.dataset.view));
});
document.querySelector("#clearSceneButton").addEventListener("click", () => {
  activeMission.obstacles = [];
  activeMission.walls = [];
  activeMission.packages = [];
  activeMission.package = null;
  activeMission.goal = null;
  commitMissionEdit();
  addLog("场景物体已清空。");
});
document.querySelector("#saveMapButton").addEventListener("click", saveEditedMap);
savedMapButton.addEventListener("click", event => {
  event.stopPropagation();
  toggleSavedMapMenu();
});
document.addEventListener("click", event => {
  if (savedMapMenu && !savedMapMenu.contains(event.target)) closeSavedMapMenu();
});
document.querySelector("#copyButton").addEventListener("click", async () => {
  await navigator.clipboard.writeText(codeOutput.textContent);
  setStatus("代码已复制");
});
document.querySelectorAll("[data-place]").forEach(button => {
  button.addEventListener("click", () => {
    if (placeMode === button.dataset.place) {
      placeMode = null;
      document.querySelectorAll("[data-place]").forEach(item => item.classList.remove("is-active"));
      setStatus("已取消地图编辑");
      return;
    }
    placeMode = button.dataset.place;
    document.querySelectorAll("[data-place]").forEach(item => item.classList.toggle("is-active", item === button));
    setStatus(button.dataset.place === "package"
      ? "包裹：连续点击同一格可堆叠"
      : button.textContent + "：点击地图格子");
  });
});

if (window.lucide) {
  window.lucide.createIcons();
}
